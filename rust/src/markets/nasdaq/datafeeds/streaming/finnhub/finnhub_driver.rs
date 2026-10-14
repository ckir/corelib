//! FinnhubDriver: one WebSocket connection attempt + trade parsing.
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
    FinnhubTradeExtras, MarketEvent, Trade, TradeExtras,
};
use chrono::{TimeZone, Utc};

/// Parse one Finnhub WS text frame into zero or more Trade events.
/// Finnhub trade frame: {"type":"trade","data":[{"s":sym,"p":price,"v":vol,"t":ms,"c":[..]}]}
pub fn parse_finnhub_frame(text: &str, source: &str) -> Vec<MarketEvent> {
    let obj: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            // REDACTION: length only — a genuinely undecodable (non-JSON) frame. Valid-but-non-trade
            // frames fall through below without logging (they are normal, not errors).
            tracing::debug!(target: "corelib_rust::stream", provider = source, bytes = text.len(), "frame parse failed");
            return vec![];
        }
    };
    if obj["type"].as_str() != Some("trade") {
        return vec![];
    }
    let data = match obj["data"].as_array() {
        Some(a) => a,
        None => return vec![],
    };
    let mut out = Vec::new();
    for item in data {
        let ticker = match item["s"].as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let price = match item["p"].as_f64() {
            Some(p) => p,
            None => continue,
        };
        let volume = item["v"].as_f64().unwrap_or(0.0);
        let time_ms = item["t"].as_i64().unwrap_or(0);
        let timestamp = Utc
            .timestamp_millis_opt(time_ms)
            .single()
            .unwrap_or_else(Utc::now);
        let conditions = item["c"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        out.push(MarketEvent::Trade {
            source: source.to_string(),
            data: Trade {
                ticker,
                timestamp,
                price,
                extras: TradeExtras::Finnhub(FinnhubTradeExtras { volume, conditions }),
                raw: Some(item.to_string()),
            },
        });
    }
    out
}

use crate::markets::nasdaq::datafeeds::streaming::core::driver::{
    AttemptOutcome, ProviderDriver, SubRequest,
};
use crate::markets::nasdaq::datafeeds::streaming::core::handshake::{
    connect_with_stop, percent_encode_component, validate_ws_endpoint, HandshakeError,
    HANDSHAKE_TIMEOUT,
};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use crate::markets::nasdaq::datafeeds::streaming::finnhub::finnhub_streamer::market_event_to_finnhub_pricing;
use futures_util::future::{BoxFuture, FutureExt};
use futures_util::{SinkExt, StreamExt};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Silence threshold (no text/pong frame) and ping cadence; same values as the Alpaca/Yahoo
/// drivers (silence default 60s, `PING_INTERVAL` 30s). Finnhub has no configurable silence field.
const SILENCE_SECONDS: u64 = 60;
const PING_INTERVAL: u64 = 30;

const FINNHUB_WS: &str = "wss://ws.finnhub.io";

/// Build the Finnhub websocket connect URL. Uses `base_url` when provided, else the default endpoint.
/// Scheme/query formatting is byte-identical to the legacy hardcoded form when `base_url` is None.
fn finnhub_ws_url(base_url: Option<&str>, token: &str) -> String {
    let base = base_url.unwrap_or(FINNHUB_WS);
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}token={}", percent_encode_component(token))
}

pub struct FinnhubDriver {
    pub token: String,
    pub name: String,
    pub base_url: Option<String>,
    pub db: Arc<Database>,   // shared host redb handle (host.db_handle())
    pub table: &'static str, // host.table_name() — "finnhub_subscriptions"
}

impl FinnhubDriver {
    /// Read the FULL persisted bare-key subscription set from redb. Called on every (re)connect
    /// so dynamic mid-session subscribes survive reconnects (single source of truth = redb).
    pub fn load_subscriptions(&self) -> Vec<String> {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        let mut out = Vec::new();
        if let Ok(rtx) = self.db.begin_read() {
            if let Ok(t) = rtx.open_table(table) {
                if let Ok(iter) = t.iter() {
                    for item in iter.flatten() {
                        out.push(item.0.value().to_string());
                    }
                }
            }
        }
        out
    }
}

impl ProviderDriver for FinnhubDriver {
    fn validate(&self) -> Result<(), String> {
        if self.token.is_empty() {
            return Err("FINNHUB_API_KEY / token is required".into());
        }
        // The token travels in the URL query: never send it over plaintext to a remote host.
        match self.base_url.as_deref() {
            Some(u) => validate_ws_endpoint(u),
            None => Ok(()),
        }
    }

    fn connect_once<'a>(
        &'a self,
        symbols: &'a [String],
        tx: &'a mpsc::Sender<CoreEvent>,
        sub_rx: &'a mut mpsc::Receiver<SubRequest>,
        stop_rx: &'a mut mpsc::Receiver<()>,
    ) -> BoxFuture<'a, AttemptOutcome> {
        async move {
            let url = finnhub_ws_url(self.base_url.as_deref(), &self.token);
            let mut ws = match connect_with_stop(&url, stop_rx, HANDSHAKE_TIMEOUT).await {
                // REDACTION: tungstenite transport error (client-side); the token lives in the
                // URL query and is never logged (only the failure category + transport error).
                Err(HandshakeError::Stopped) => return AttemptOutcome::Stopped,
                Err(HandshakeError::Timeout) => {
                    tracing::warn!(target: "corelib_rust::stream", provider = "finnhub", "ws connect timed out");
                    return AttemptOutcome::NeverConnected;
                }
                Err(HandshakeError::Failed(e)) => {
                    tracing::warn!(target: "corelib_rust::stream", provider = "finnhub", error = %e, "ws connect failed");
                    return AttemptOutcome::NeverConnected;
                }
                Ok(ws) => ws,
            };
            // signal the supervisor to reset backoff
            let _ = tx.send(CoreEvent::Status(ProviderStatus::Connected { provider: ProviderKind::Finnhub })).await;
            tracing::debug!(target: "corelib_rust::stream", provider = "finnhub", "connected");
            let _ = symbols; // resume is read fresh from redb each attempt (reconnect-safe)
            let mut current: Vec<String> = self.load_subscriptions();
            tracing::debug!(target: "corelib_rust::stream", provider = "finnhub", symbols = current.len(), "subscribe");
            for s in &current {
                let m = serde_json::json!({ "type": "subscribe", "symbol": s }).to_string();
                if ws.send(Message::Text(m.into())).await.is_err() { return AttemptOutcome::ConnectedThenDropped; }
            }
            let mut silence = tokio::time::interval(tokio::time::Duration::from_secs(SILENCE_SECONDS));
            let mut ping = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL));
            let _ = silence.tick().await;
            let _ = ping.tick().await;
            loop {
                tokio::select! {
                    _ = stop_rx.recv() => return AttemptOutcome::Stopped,
                    _ = ping.tick() => { let _ = ws.send(Message::Ping(vec![].into())).await; }
                    _ = silence.tick() => return AttemptOutcome::ConnectedThenDropped,
                    upd = sub_rx.recv() => {
                        match upd {
                            // Finnhub is single-channel: ignore `channel`, subscribe each new symbol.
                            Some(SubRequest { symbols: syms, .. }) => {
                                tracing::trace!(target: "corelib_rust::stream", symbols = syms.len(), "sub request");
                                for s in &syms { if !current.contains(s) {
                                    let m = serde_json::json!({ "type": "subscribe", "symbol": s }).to_string();
                                    let _ = ws.send(Message::Text(m.into())).await; current.push(s.clone());
                                }}
                            }
                            // sub_tx dropped → channel closed; recv() would return None forever and
                            // busy-spin the select. End the attempt cleanly. (agy convergent 🟡)
                            None => return AttemptOutcome::Stopped,
                        }
                    }
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            silence.reset();
                            // dual-mode: each trade carries the raw FinnhubPricingData + the unified MarketEvent.
                            for ev in parse_finnhub_frame(&t, &self.name) {
                                if let Some(raw) = market_event_to_finnhub_pricing(&ev) {
                                    let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Finnhub(raw), uni: vec![ev] }).await;
                                }
                            }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        // a Pong proves the peer is alive even when no trades are flowing
                        Some(Ok(Message::Pong(_))) => silence.reset(),
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => return AttemptOutcome::ConnectedThenDropped,
                    }
                }
            }
        }.boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::TradeExtras;
    #[test]
    fn parses_trade_batch() {
        let frame = r#"{"type":"trade","data":[{"s":"AAPL","p":191.5,"v":100,"t":1700000000000,"c":["@"]},{"s":"MSFT","p":420.0,"v":50,"t":1700000000001,"c":[]}]}"#;
        let evs = parse_finnhub_frame(frame, "finnhub_main");
        assert_eq!(evs.len(), 2);
        match &evs[0] {
            MarketEvent::Trade { data, .. } => {
                assert_eq!(data.ticker, "AAPL");
                assert_eq!(data.price, 191.5);
                match &data.extras {
                    TradeExtras::Finnhub(x) => {
                        assert_eq!(x.volume, 100.0);
                        assert_eq!(x.conditions, vec!["@".to_string()]);
                    }
                    _ => panic!("expected Finnhub extras"),
                }
            }
            _ => panic!(),
        }
    }
    #[test]
    fn ignores_ping_and_unknown() {
        assert!(parse_finnhub_frame(r#"{"type":"ping"}"#, "s").is_empty());
        assert!(parse_finnhub_frame("not json", "s").is_empty());
    }
    #[test]
    fn finnhub_base_url_default_and_override() {
        assert_eq!(finnhub_ws_url(None, "TOK"), "wss://ws.finnhub.io?token=TOK");
        assert_eq!(
            finnhub_ws_url(Some("ws://127.0.0.1:9001"), "TOK"),
            "ws://127.0.0.1:9001?token=TOK"
        );
    }

    #[test]
    fn finnhub_token_is_percent_encoded_and_query_merged() {
        assert_eq!(
            finnhub_ws_url(Some("ws://127.0.0.1:1"), "a&b#c d"),
            "ws://127.0.0.1:1?token=a%26b%23c%20d"
        );
        assert_eq!(
            finnhub_ws_url(Some("ws://127.0.0.1:1/p?x=1"), "T"),
            "ws://127.0.0.1:1/p?x=1&token=T"
        );
    }

    #[test]
    fn finnhub_validate_rejects_plaintext_remote() {
        let d = |u: Option<&str>| FinnhubDriver {
            token: "T".into(),
            name: "f".into(),
            base_url: u.map(String::from),
            db: Arc::new(
                redb::Database::builder()
                    .create_with_backend(redb::backends::InMemoryBackend::new())
                    .unwrap(),
            ),
            table: "finnhub_subscriptions",
        };
        assert!(d(Some("ws://example.com")).validate().is_err());
        assert!(d(Some("ws://127.0.0.1:9")).validate().is_ok());
        assert!(d(None).validate().is_ok());
    }

    #[test]
    fn load_subscriptions_reads_bare_keys_and_unsubscribe_drops() {
        use std::sync::Arc;
        let path = std::env::temp_dir().join(format!(
            "test_finnhub_subs_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = Arc::new(redb::Database::create(path).unwrap());
        let t: redb::TableDefinition<&str, bool> =
            redb::TableDefinition::new("finnhub_subscriptions");
        // seed A + B
        {
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.insert("AAPL", true).unwrap();
                tab.insert("MSFT", true).unwrap();
            }
            w.commit().unwrap();
        }
        let d = FinnhubDriver {
            token: "tok".into(),
            name: "finnhub_main".into(),
            base_url: None,
            db: Arc::clone(&db),
            table: "finnhub_subscriptions",
        };
        let mut subs = d.load_subscriptions();
        subs.sort();
        assert_eq!(subs, vec!["AAPL".to_string(), "MSFT".to_string()]);
        // unsubscribe MSFT (committed) must NOT resurrect on the next read
        {
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.remove("MSFT").unwrap();
            }
            w.commit().unwrap();
        }
        assert_eq!(d.load_subscriptions(), vec!["AAPL".to_string()]);
    }
}

#[cfg(test)]
mod loopback_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::driver::SubRequest;
    use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn text(s: &str) -> Message {
        Message::Text(s.to_string().into())
    }

    /// Minimal Finnhub WS server: (read one subscribe) → one trade frame. No auth, no handshake.
    async fn serve_finnhub(listener: TcpListener) {
        if let Ok((stream, _)) = listener.accept().await {
            let mut ws = accept_async(stream).await.expect("ws accept");
            let _ = ws.next().await; // subscribe frame from driver
            ws.send(text(
                r#"{"type":"trade","data":[{"s":"AAPL","p":191.5,"v":100,"t":1700000000000,"c":["@"]}]}"#,
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    #[tokio::test]
    async fn pure_rust_loopback_delivers_finnhub_trade() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_finnhub(listener));

        let _db_path = std::env::temp_dir().join(format!(
            "test_finnhub_loop_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = std::sync::Arc::new(redb::Database::create(_db_path).unwrap());
        {
            let t: redb::TableDefinition<&str, bool> =
                redb::TableDefinition::new("finnhub_subscriptions");
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.insert("AAPL", true).unwrap();
            }
            w.commit().unwrap();
        }

        let driver = FinnhubDriver {
            token: "tok".into(),
            name: "finnhub_main".into(),
            base_url: Some(format!("ws://127.0.0.1:{port}/")),
            db: std::sync::Arc::clone(&db),
            table: "finnhub_subscriptions",
        };
        let (tx, mut rx) = mpsc::channel::<CoreEvent>(64);
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(8);
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let syms = vec!["AAPL".to_string()];

        let connect = driver.connect_once(&syms, &tx, &mut sub_rx, &mut stop_rx);
        tokio::pin!(connect);

        let got = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = &mut connect => return None,
                    ev = rx.recv() => match ev {
                        Some(CoreEvent::Pricing { raw: RawPricing::Finnhub(p), .. }) => return Some(p),
                        Some(_) => continue, // skip Status(Connected)
                        None => return None,
                    },
                }
            }
        })
        .await
        .expect("timed out waiting for pricing");

        let p = got.expect("driver ended before delivering a pricing event");
        assert_eq!(p.symbol, "AAPL");
        assert_eq!(p.price, 191.5);
    }
}

#[cfg(test)]
mod resurrection_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::driver::SubRequest;
    use crate::markets::nasdaq::datafeeds::streaming::core::types::CoreEvent;
    use futures_util::StreamExt;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    /// Collects the `symbol` of every Finnhub `{"type":"subscribe","symbol":..}` frame.
    async fn serve_collect(listener: TcpListener, collected: Arc<Mutex<Vec<String>>>) {
        if let Ok((stream, _)) = listener.accept().await {
            let mut ws = accept_async(stream).await.unwrap();
            let deadline = tokio::time::sleep(Duration::from_millis(800));
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => break,
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                if v["type"] == "subscribe" {
                                    if let Some(s) = v["symbol"].as_str() {
                                        collected.lock().unwrap().push(s.to_string());
                                    }
                                }
                            }
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => break,
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn reconnect_after_unsubscribe_does_not_resurrect() {
        let path = std::env::temp_dir().join(format!(
            "test_finnhub_resurrect_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = Arc::new(redb::Database::create(path).unwrap());
        let tbl: redb::TableDefinition<&str, bool> =
            redb::TableDefinition::new("finnhub_subscriptions");
        // seed A + B, then unsubscribe B (committed delete) BEFORE the (re)connect.
        {
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(tbl).unwrap();
                tab.insert("AAPL", true).unwrap();
                tab.insert("MSFT", true).unwrap();
            }
            w.commit().unwrap();
        }
        {
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(tbl).unwrap();
                tab.remove("MSFT").unwrap();
            }
            w.commit().unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let collected = Arc::new(Mutex::new(Vec::<String>::new()));
        tokio::spawn(serve_collect(listener, Arc::clone(&collected)));

        let driver = FinnhubDriver {
            token: "tok".into(),
            name: "finnhub_main".into(),
            base_url: Some(format!("ws://127.0.0.1:{port}/")),
            db: Arc::clone(&db),
            table: "finnhub_subscriptions",
        };
        let (tx, _rx) = mpsc::channel::<CoreEvent>(64); // keep _rx alive so sends don't fail
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(8);
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let connect = driver.connect_once(&[] as &[String], &tx, &mut sub_rx, &mut stop_rx);
        tokio::pin!(connect);
        // let it connect + send its initial subscribe, then stop the attempt.
        tokio::select! {
            _ = &mut connect => {}
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                let _ = stop_tx.try_send(());
                let _ = (&mut connect).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let got = collected.lock().unwrap().clone();
        assert!(
            got.contains(&"AAPL".to_string()),
            "must resubscribe the survivor: {got:?}"
        );
        assert!(
            !got.contains(&"MSFT".to_string()),
            "must NOT resurrect the unsubscribed symbol: {got:?}"
        );
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    fn driver(port: u16) -> FinnhubDriver {
        let path = std::env::temp_dir().join(format!(
            "test_finnhub_hard_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        FinnhubDriver {
            token: "tok".into(),
            name: "finnhub_main".into(),
            base_url: Some(format!("ws://127.0.0.1:{port}/")),
            db: Arc::new(redb::Database::create(path).unwrap()),
            table: "finnhub_subscriptions",
        }
    }

    #[tokio::test(start_paused = true)]
    async fn black_holed_connect_returns_never_connected_after_handshake_timeout() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let d = driver(l.local_addr().unwrap().port());
        let (tx, _rx) = mpsc::channel::<CoreEvent>(16);
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(1);
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let start = tokio::time::Instant::now();
        let out = d.connect_once(&[], &tx, &mut sub_rx, &mut stop_rx).await;
        assert_eq!(out, AttemptOutcome::NeverConnected);
        assert!(start.elapsed() >= HANDSHAKE_TIMEOUT && start.elapsed() < HANDSHAKE_TIMEOUT * 2);
        drop(l);
    }

    #[tokio::test]
    async fn black_holed_connect_returns_promptly_on_stop() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let d = driver(l.local_addr().unwrap().port());
        let (tx, _rx) = mpsc::channel::<CoreEvent>(16);
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(1);
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = stop_tx.send(()).await;
        });
        let t = std::time::Instant::now();
        let out = d.connect_once(&[], &tx, &mut sub_rx, &mut stop_rx).await;
        assert_eq!(out, AttemptOutcome::Stopped);
        assert!(t.elapsed() < Duration::from_secs(5));
        drop(l);
    }

    /// Half-open: the ws upgrade succeeds, then the peer goes completely silent (no pong, no data).
    #[tokio::test(start_paused = true)]
    async fn silent_half_open_connection_is_dropped_by_watchdog() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let _ws = accept_async(s).await.unwrap();
            tokio::time::sleep(Duration::from_secs(36000)).await;
        });
        let d = driver(port);
        let (tx, mut rx) = mpsc::channel::<CoreEvent>(16);
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(1);
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let start = tokio::time::Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(600),
            d.connect_once(&[], &tx, &mut sub_rx, &mut stop_rx),
        )
        .await
        .expect("watchdog never fired");
        assert_eq!(out, AttemptOutcome::ConnectedThenDropped);
        assert!(start.elapsed() >= Duration::from_secs(SILENCE_SECONDS));
        assert!(matches!(
            rx.try_recv(),
            Ok(CoreEvent::Status(ProviderStatus::Connected { .. }))
        ));
    }
}
