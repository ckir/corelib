use crate::markets::nasdaq::datafeeds::streaming::core::driver::{
    AttemptOutcome, ProviderDriver, SubRequest,
};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
    AlpacaQuoteExtras, AlpacaTradeExtras, MarketEvent, ProviderKind, ProviderStatus, Quote,
    QuoteExtras, Trade, TradeExtras,
};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{
    AlpacaPricingData, CoreEvent, RawPricing,
};
use chrono::{DateTime, Utc};
use futures::future::{BoxFuture, FutureExt};
use futures_util::{SinkExt, StreamExt};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_ALPACA_WS_URL: &str = "wss://stream.data.alpaca.markets/v2/iex";
const PING_INTERVAL: u64 = 30;
const ALPACA_CHANNELS: [&str; 3] = ["trades", "quotes", "bars"];

fn f(o: &serde_json::Value, k: &str) -> f64 {
    o.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0)
}
fn s(o: &serde_json::Value, k: &str) -> String {
    o.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
}
fn opt_s(o: &serde_json::Value, k: &str) -> Option<String> {
    o.get(k).and_then(|v| v.as_str()).map(str::to_owned)
}
fn conds(o: &serde_json::Value) -> Vec<String> {
    o.get("c")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}
fn parse_ts(o: &serde_json::Value) -> DateTime<Utc> {
    o.get("t")
        .and_then(|v| v.as_str())
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
}

/// Decode one Alpaca data object into (raw payload, optional unified event). `None` for non-pricing.
pub fn parse_alpaca_obj(
    o: &serde_json::Value,
    source: &str,
) -> Option<(AlpacaPricingData, Vec<MarketEvent>)> {
    let ticker = s(o, "S");
    let ts_str = s(o, "t");
    match o.get("T").and_then(|t| t.as_str()).unwrap_or("") {
        "q" => {
            let (bid, ask) = (f(o, "bp"), f(o, "ap"));
            let raw = AlpacaPricingData {
                symbol: ticker.clone(),
                message_type: "quote".into(),
                price: bid,
                bid_price: bid,
                ask_price: ask,
                volume: f(o, "bs"),
                timestamp: ts_str,
            };
            let uni = MarketEvent::Quote {
                source: source.into(),
                data: Quote {
                    ticker,
                    timestamp: parse_ts(o),
                    price: (bid + ask) / 2.0,
                    extras: QuoteExtras::Alpaca(AlpacaQuoteExtras {
                        bid,
                        ask,
                        bid_size: f(o, "bs"),
                        ask_size: f(o, "as"),
                        bid_exchange: opt_s(o, "bx"),
                        ask_exchange: opt_s(o, "ax"),
                        conditions: conds(o),
                        tape: opt_s(o, "z"),
                    }),
                    raw: Some(o.to_string()),
                },
            };
            Some((raw, vec![uni]))
        }
        "t" => {
            let price = f(o, "p");
            let raw = AlpacaPricingData {
                symbol: ticker.clone(),
                message_type: "trade".into(),
                price,
                bid_price: 0.0,
                ask_price: 0.0,
                volume: f(o, "s"),
                timestamp: ts_str,
            };
            let uni = MarketEvent::Trade {
                source: source.into(),
                data: Trade {
                    ticker,
                    timestamp: parse_ts(o),
                    price,
                    extras: TradeExtras::Alpaca(AlpacaTradeExtras {
                        size: f(o, "s"),
                        exchange: opt_s(o, "x"),
                        conditions: conds(o),
                        tape: opt_s(o, "z"),
                        id: o.get("i").and_then(|v| v.as_i64()),
                    }),
                    raw: Some(o.to_string()),
                },
            };
            Some((raw, vec![uni]))
        }
        "b" => {
            let raw = AlpacaPricingData {
                symbol: ticker,
                message_type: "bar".into(),
                price: f(o, "c"),
                bid_price: 0.0,
                ask_price: 0.0,
                volume: f(o, "v"),
                timestamp: ts_str,
            };
            Some((raw, vec![])) // bars raw-only
        }
        _ => None,
    }
}

/// One Alpaca real-time stream connection. The supervisor owns the reconnect loop; this driver
/// performs a single attempt (connect → auth → subscribe → pump) and resolves with an outcome.
///
/// The redb DB (shared `Arc<Database>` handle from the host) is the **single source of truth** for
/// subscriptions: `connect_once` reads the full persisted set fresh on every (re)connect, so resume
/// survives both process restarts and mid-session reconnects.
pub struct AlpacaDriver {
    pub name: String,
    pub base_url: Option<String>,
    pub key_id: String,
    pub secret_key: String,
    pub silence_seconds: u32,
    pub db: Arc<Database>,   // shared host redb handle (host.db_handle())
    pub table: &'static str, // host.table_name() — "alpaca_subscriptions"
}

impl AlpacaDriver {
    /// Build the consolidated subscribe payload from a channel map.
    fn initial_subscribe_json(&self, by_channel: &[(String, Vec<String>)]) -> Option<String> {
        let mut map = serde_json::Map::new();
        map.insert("action".into(), serde_json::json!("subscribe"));
        let mut any = false;
        for (ch, syms) in by_channel {
            if !syms.is_empty() {
                map.insert(ch.clone(), serde_json::json!(syms));
                any = true;
            }
        }
        any.then(|| serde_json::Value::Object(map).to_string())
    }

    /// Read the FULL persisted subscription set from redb, grouped by Alpaca channel.
    /// A colon-less (legacy) key defaults to the "quotes" channel. Called on every (re)connect.
    fn load_subscriptions(&self) -> Vec<(String, Vec<String>)> {
        let mut by_channel: Vec<(String, Vec<String>)> = ALPACA_CHANNELS
            .iter()
            .map(|c| (c.to_string(), Vec::new()))
            .collect();
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        if let Ok(rtx) = self.db.begin_read() {
            if let Ok(t) = rtx.open_table(table) {
                if let Ok(iter) = t.iter() {
                    for item in iter.flatten() {
                        let key = item.0.value().to_string();
                        let (ch, sym) = key.split_once(':').unwrap_or(("quotes", key.as_str()));
                        if let Some(slot) = by_channel.iter_mut().find(|(c, _)| c == ch) {
                            let sym = sym.to_string();
                            if !slot.1.contains(&sym) {
                                slot.1.push(sym);
                            }
                        }
                    }
                }
            }
        }
        by_channel
    }
}

impl ProviderDriver for AlpacaDriver {
    fn validate(&self) -> Result<(), String> {
        if self.key_id.is_empty() || self.secret_key.is_empty() {
            Err("APCA_API_KEY_ID / APCA_API_SECRET_KEY required".into())
        } else {
            Ok(())
        }
    }

    fn connect_once<'a>(
        &'a self,
        symbols: &'a [String], // unused: Alpaca resumes from redb (load_subscriptions), not this snapshot
        tx: &'a mpsc::Sender<CoreEvent>,
        sub_rx: &'a mut mpsc::Receiver<SubRequest>,
        stop_rx: &'a mut mpsc::Receiver<()>,
    ) -> BoxFuture<'a, AttemptOutcome> {
        async move {
            let _ = symbols; // resume is read fresh from redb each attempt (reconnect-safe)
            let url = self
                .base_url
                .clone()
                .unwrap_or_else(|| DEFAULT_ALPACA_WS_URL.to_string());
            let (mut ws, _) = match connect_async(&url).await {
                Ok(v) => v,
                Err(_) => return AttemptOutcome::NeverConnected,
            };
            // {"T":"success","msg":"connected"}
            if let Some(Ok(Message::Text(m))) = ws.next().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&m) {
                    let ok = v
                        .as_array()
                        .and_then(|a| a.first())
                        .map(|f| f["T"] == "success" && f["msg"] == "connected")
                        .unwrap_or(false);
                    if !ok {
                        return AttemptOutcome::NeverConnected;
                    }
                }
            } else {
                return AttemptOutcome::NeverConnected;
            }
            // auth
            let auth = serde_json::json!({"action":"auth","key":self.key_id,"secret":self.secret_key})
                .to_string();
            if ws.send(Message::Text(auth.into())).await.is_err() {
                return AttemptOutcome::NeverConnected;
            }
            if let Some(Ok(Message::Text(m))) = ws.next().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&m) {
                    if let Some(f) = v.as_array().and_then(|a| a.first()) {
                        if f["T"] == "error" {
                            let msg = f["msg"].as_str().unwrap_or("auth error").to_string();
                            let _ = tx
                                .send(CoreEvent::Status(ProviderStatus::Error {
                                    provider: ProviderKind::Alpaca,
                                    message: msg.clone(),
                                }))
                                .await;
                            return AttemptOutcome::Fatal(msg);
                        }
                        let ok = f["T"] == "success" && f["msg"] == "authenticated";
                        if !ok {
                            return AttemptOutcome::NeverConnected;
                        }
                    }
                }
            } else {
                return AttemptOutcome::NeverConnected;
            }

            let _ = tx
                .send(CoreEvent::Status(ProviderStatus::Connected {
                    provider: ProviderKind::Alpaca,
                }))
                .await;

            // initial subscribe: read the FULL persisted set from redb (reconnect-safe single source of truth)
            let by_channel = self.load_subscriptions();
            if let Some(payload) = self.initial_subscribe_json(&by_channel) {
                if ws.send(Message::Text(payload.into())).await.is_err() {
                    return AttemptOutcome::ConnectedThenDropped;
                }
            }

            let mut silence = tokio::time::interval(tokio::time::Duration::from_secs(
                self.silence_seconds.max(1) as u64,
            ));
            let mut ping = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL));
            let _ = silence.tick().await;
            let _ = ping.tick().await;

            loop {
                tokio::select! {
                    _ = stop_rx.recv() => return AttemptOutcome::Stopped,
                    req = sub_rx.recv() => {
                        match req {
                            Some(r) => {
                                let payload = serde_json::json!({"action":"subscribe", r.channel: r.symbols}).to_string();
                                let _ = ws.send(Message::Text(payload.into())).await;
                            }
                            None => return AttemptOutcome::Stopped,
                        }
                    }
                    _ = ping.tick() => { let _ = ws.send(Message::Ping(vec![].into())).await; }
                    _ = silence.tick() => return AttemptOutcome::ConnectedThenDropped,
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            silence.reset();
                            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&t) {
                                for o in &items {
                                    if let Some((raw, uni)) = parse_alpaca_obj(o, &self.name) {
                                        let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Alpaca(raw), uni }).await;
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => return AttemptOutcome::ConnectedThenDropped,
                    }
                }
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod parse_tests {
    use super::*;
    #[test]
    fn quote_builds_raw_and_unified() {
        let obj: serde_json::Value = serde_json::from_str(
            r#"{"T":"q","S":"AAPL","bp":191.0,"ap":192.0,"bs":1,"as":2,"bx":"V","ax":"V","c":["R"],"z":"C","t":"2024-01-02T15:00:00Z"}"#).unwrap();
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "quote");
        assert_eq!(raw.bid_price, 191.0);
        assert_eq!(raw.ask_price, 192.0);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "quote");
        assert_eq!(v["price"], 191.5); // mid
        assert_eq!(v["alpaca"]["bid"], 191.0);
    }
    #[test]
    fn trade_builds_raw_and_unified_trade() {
        let obj: serde_json::Value = serde_json::from_str(
            r#"{"T":"t","S":"MSFT","p":420.0,"s":50,"x":"V","c":["@"],"z":"C","i":7,"t":"2024-01-02T15:00:00Z"}"#).unwrap();
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "trade");
        assert_eq!(raw.price, 420.0);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["alpaca"]["size"], 50.0);
    }
    #[test]
    fn bar_builds_raw_only() {
        let obj: serde_json::Value = serde_json::from_str(
            r#"{"T":"b","S":"TSLA","c":250.0,"v":1000,"t":"2024-01-02T15:00:00Z"}"#,
        )
        .unwrap();
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "bar");
        assert_eq!(raw.price, 250.0);
        assert!(uni.is_empty()); // bars are raw-only
    }
    #[test]
    fn non_pricing_returns_none() {
        let obj: serde_json::Value = serde_json::from_str(r#"{"T":"subscription"}"#).unwrap();
        assert!(parse_alpaca_obj(&obj, "s").is_none());
    }
}

#[cfg(test)]
mod driver_tests {
    use super::*;
    use std::sync::Arc;

    fn tmp_db() -> Arc<redb::Database> {
        let path = std::env::temp_dir().join(format!(
            "test_alpaca_drv_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(redb::Database::create(path).unwrap())
    }

    #[test]
    fn validate_requires_credentials() {
        let db = tmp_db();
        let d = AlpacaDriver {
            name: "alpaca_main".into(),
            base_url: None,
            key_id: String::new(),
            secret_key: String::new(),
            silence_seconds: 60,
            db: Arc::clone(&db),
            table: "alpaca_subscriptions",
        };
        assert!(d.validate().is_err());
        let d2 = AlpacaDriver {
            name: "alpaca_main".into(),
            base_url: None,
            key_id: "k".into(),
            secret_key: "s".into(),
            silence_seconds: 60,
            db,
            table: "alpaca_subscriptions",
        };
        assert!(d2.validate().is_ok());
    }

    #[test]
    fn load_subscriptions_groups_by_channel_with_legacy_default() {
        let db = tmp_db();
        // seed composite + legacy keys
        {
            let t: redb::TableDefinition<&str, bool> =
                redb::TableDefinition::new("alpaca_subscriptions");
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.insert("trades:MSFT", true).unwrap();
                tab.insert("quotes:AAPL", true).unwrap();
                tab.insert("TSLA", true).unwrap();
            } // legacy bare → quotes
            w.commit().unwrap();
        }
        let d = AlpacaDriver {
            name: "a".into(),
            base_url: None,
            key_id: "k".into(),
            secret_key: "s".into(),
            silence_seconds: 60,
            db,
            table: "alpaca_subscriptions",
        };
        let map = d.load_subscriptions();
        let quotes = &map.iter().find(|(c, _)| c == "quotes").unwrap().1;
        assert!(quotes.contains(&"AAPL".to_string()) && quotes.contains(&"TSLA".to_string()));
        assert_eq!(
            map.iter().find(|(c, _)| c == "trades").unwrap().1,
            vec!["MSFT".to_string()]
        );
    }
}
