//! YahooDriver: pure proto-decode mapper + one WebSocket connection attempt.
//! Dual-mode: every decoded message yields the byte-identical raw `JsPricingData`
//! (so `on_pricing` always fires) plus 0/1/2 unified `MarketEvent`s.
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
    quote_type_label, MarketEvent, Quote, QuoteExtras, Trade, TradeExtras, YahooOptionExtras,
    YahooQuoteExtras, YahooTradeExtras,
};
use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::{
    decode_yahoo_message, JsPricingData,
};
use chrono::{DateTime, TimeZone, Utc};

/// QuoteType discriminator for option instruments (proto enum `QuoteType::Option`).
const QUOTE_TYPE_OPTION: i32 = 13;

fn ts_from_millis(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
}

/// Build the option extras iff this is an option instrument.
fn option_extras(raw: &JsPricingData) -> Option<YahooOptionExtras> {
    if raw.quote_type == QUOTE_TYPE_OPTION {
        Some(YahooOptionExtras {
            strike_price: raw.strike_price,
            option_type: raw.option_type,
            open_interest: raw.open_interest,
            underlying_symbol: raw.underlying_symbol.clone(),
            expire_date: raw.expire_date,
            mini_option: raw.mini_option,
        })
    } else {
        None
    }
}

fn trade_extras(raw: &JsPricingData) -> YahooTradeExtras {
    YahooTradeExtras {
        exchange: raw.exchange.clone(),
        currency: raw.currency.clone(),
        market_hours: raw.market_hours,
        change: raw.change,
        change_pct: raw.change_percent,
        volume: raw.day_volume,
        open: raw.open_price,
        day_high: raw.day_high,
        day_low: raw.day_low,
        prev_close: raw.previous_close,
        market_cap: raw.market_cap,
        bid: raw.bid_price,
        ask: raw.ask_price,
        bid_size: raw.bid_size,
        ask_size: raw.ask_size,
        short_name: raw.short_name.clone(),
        last_size: raw.last_size,
        quote_type: quote_type_label(raw.quote_type),
        vol_24hr: raw.vol_24hr,
        vol_all_currencies: raw.vol_all_currencies,
        circulating_supply: raw.circulating_supply,
        from_currency: raw.from_currency.clone(),
        options: option_extras(raw),
    }
}

fn quote_extras(raw: &JsPricingData) -> YahooQuoteExtras {
    YahooQuoteExtras {
        bid: raw.bid_price,
        ask: raw.ask_price,
        bid_size: raw.bid_size,
        ask_size: raw.ask_size,
        exchange: raw.exchange.clone(),
        currency: raw.currency.clone(),
        market_hours: raw.market_hours,
        change: raw.change,
        change_pct: raw.change_percent,
        quote_type: quote_type_label(raw.quote_type),
        options: option_extras(raw),
    }
}

/// Decode one Yahoo WS text frame into the raw payload + zero/one/two unified events.
/// Returns `None` only when the frame is not a decodable pricing envelope (skip frame).
/// The raw `JsPricingData` is ALWAYS present when `Some` (so `on_pricing` always fires),
/// even when the uni vec is empty (heartbeats / all-zero-price messages).
pub fn parse_yahoo_message(text: &str, source: &str) -> Option<(JsPricingData, Vec<MarketEvent>)> {
    let obj: serde_json::Value = serde_json::from_str(text).ok()?;
    let b64 = obj.get("message").and_then(|m| m.as_str())?;
    let pricing = decode_yahoo_message(b64).ok()?;
    let raw = JsPricingData::from(pricing);

    let ticker = raw.id.clone();
    let timestamp = ts_from_millis(raw.time);
    let mut uni: Vec<MarketEvent> = Vec::new();

    // Trade then Quote (finstream order).
    if raw.price > 0.0 {
        uni.push(MarketEvent::Trade {
            source: source.to_string(),
            data: Trade {
                ticker: ticker.clone(),
                timestamp,
                price: raw.price,
                extras: TradeExtras::Yahoo(trade_extras(&raw)),
                raw: None,
            },
        });
    }
    if raw.bid_price > 0.0 || raw.ask_price > 0.0 {
        uni.push(MarketEvent::Quote {
            source: source.to_string(),
            data: Quote {
                ticker,
                timestamp,
                price: (raw.bid_price + raw.ask_price) / 2.0,
                extras: QuoteExtras::Yahoo(quote_extras(&raw)),
                raw: None,
            },
        });
    }
    Some((raw, uni))
}

use crate::markets::nasdaq::datafeeds::streaming::core::driver::{
    AttemptOutcome, ProviderDriver, SubRequest,
};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use futures::future::{BoxFuture, FutureExt};
use futures_util::{SinkExt, StreamExt};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_YAHOO_WS_URL: &str = "wss://streamer.finance.yahoo.com/?version=2";
const PING_INTERVAL: u64 = 30;

/// One Yahoo real-time stream connection. The supervisor owns the reconnect loop; this driver
/// performs a single attempt (connect → subscribe → pump). Yahoo is unauthenticated and
/// single-channel; the redb DB (shared `Arc<Database>` from the host) is the single source of
/// truth for subscriptions, read fresh (bare keys) on every (re)connect.
pub struct YahooDriver {
    pub name: String,
    pub base_url: Option<String>,
    pub silence_seconds: u32,
    pub db: Arc<Database>,
    pub table: &'static str,
}

impl YahooDriver {
    /// Read the FULL persisted bare-key subscription set from redb. Called on every (re)connect.
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

impl ProviderDriver for YahooDriver {
    fn validate(&self) -> Result<(), String> {
        Ok(()) // Yahoo is unauthenticated
    }

    fn connect_once<'a>(
        &'a self,
        symbols: &'a [String], // unused: Yahoo resumes from redb (load_subscriptions), not this snapshot
        tx: &'a mpsc::Sender<CoreEvent>,
        sub_rx: &'a mut mpsc::Receiver<SubRequest>,
        stop_rx: &'a mut mpsc::Receiver<()>,
    ) -> BoxFuture<'a, AttemptOutcome> {
        async move {
            let _ = symbols; // resume is read fresh from redb each attempt (reconnect-safe)
            let url = self
                .base_url
                .clone()
                .unwrap_or_else(|| DEFAULT_YAHOO_WS_URL.to_string());
            let (mut ws, _) = match connect_async(&url).await {
                Ok(v) => v,
                Err(_) => return AttemptOutcome::NeverConnected,
            };
            let _ = tx
                .send(CoreEvent::Status(ProviderStatus::Connected {
                    provider: ProviderKind::Yahoo,
                }))
                .await;

            // initial subscribe: full persisted bare-key set (single-channel)
            let subs = self.load_subscriptions();
            if !subs.is_empty() {
                let payload = serde_json::json!({ "subscribe": subs }).to_string();
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
                            // single-channel: ignore the channel tag, subscribe the bare symbols
                            Some(SubRequest { symbols: syms, .. }) => {
                                tracing::trace!(target: "corelib_rust::stream", symbols = syms.len(), "sub request");
                                if !syms.is_empty() {
                                    let payload = serde_json::json!({ "subscribe": syms }).to_string();
                                    let _ = ws.send(Message::Text(payload.into())).await;
                                }
                            }
                            None => return AttemptOutcome::Stopped,
                        }
                    }
                    _ = ping.tick() => { let _ = ws.send(Message::Ping(vec![].into())).await; }
                    _ = silence.tick() => return AttemptOutcome::ConnectedThenDropped,
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            silence.reset();
                            if let Some((raw, uni)) = parse_yahoo_message(&t, &self.name) {
                                let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Yahoo(raw), uni }).await;
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
mod mapper_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::PricingData;
    use base64::{engine::general_purpose, Engine as _};
    use prost::Message;

    /// Wrap a PricingData in the Yahoo `{"type":"pricing","message":"<b64>"}` envelope.
    fn envelope(p: &PricingData) -> String {
        let mut buf = Vec::new();
        p.encode(&mut buf).unwrap();
        let b64 = general_purpose::STANDARD.encode(&buf);
        serde_json::json!({ "type": "pricing", "message": b64 }).to_string()
    }

    #[test]
    fn trade_only_when_price_positive_no_quote() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 191.5,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (raw, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(raw.id, "AAPL");
        assert_eq!(uni.len(), 1);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["price"], 191.5);
        assert_eq!(v["yahoo"]["quote_type"], "equity");
    }

    #[test]
    fn quote_only_when_bid_positive_no_trade() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 0.0,
            bid_price: 10.0,
            ask_price: 11.0,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(uni.len(), 1);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "quote");
        assert_eq!(v["price"], 10.5); // mid
    }

    #[test]
    fn both_trade_and_quote_in_order() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 191.5,
            bid_price: 10.0,
            ask_price: 11.0,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(uni.len(), 2);
        assert_eq!(serde_json::to_value(&uni[0]).unwrap()["type"], "trade");
        assert_eq!(serde_json::to_value(&uni[1]).unwrap()["type"], "quote");
    }

    #[test]
    fn heartbeat_yields_raw_but_empty_uni() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 0.0,
            bid_price: 0.0,
            ask_price: 0.0,
            time: 1_700_000_000_000,
            quote_type: 7, // Heartbeat
            ..Default::default()
        };
        let (raw, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(raw.quote_type, 7);
        assert!(uni.is_empty());
    }

    #[test]
    fn crypto_trade_carries_crypto_fields() {
        let p = PricingData {
            id: "BTC-USD".into(),
            price: 50_000.0,
            time: 1_700_000_000_000,
            quote_type: 41, // Cryptocurrency
            vol_24hr: 123,
            circulating_supply: 19.5,
            from_currency: "BTC".into(),
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["yahoo"]["quote_type"], "cryptocurrency");
        assert_eq!(v["yahoo"]["vol_24hr"], 123);
        assert_eq!(v["yahoo"]["circulating_supply"], 19.5);
        assert_eq!(v["yahoo"]["from_currency"], "BTC");
    }

    #[test]
    fn option_trade_nests_options() {
        let p = PricingData {
            id: "AAPL240119C00100000".into(),
            price: 1.5,
            time: 1_700_000_000_000,
            quote_type: 13, // Option
            strike_price: 100.0,
            option_type: 1,
            open_interest: 50,
            underlying_symbol: "AAPL".into(),
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["yahoo"]["quote_type"], "option");
        assert_eq!(v["yahoo"]["options"]["strike_price"], 100.0);
        assert_eq!(v["yahoo"]["options"]["underlying_symbol"], "AAPL");
    }

    #[test]
    fn timestamp_is_rfc3339_string() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 191.5,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["timestamp"], "2023-11-14T22:13:20Z");
    }

    #[test]
    fn bad_envelope_and_bad_base64_return_none() {
        assert!(parse_yahoo_message(r#"{"type":"pricing"}"#, "yahoo").is_none());
        assert!(
            parse_yahoo_message(r#"{"type":"pricing","message":"!!!not-b64"}"#, "yahoo").is_none()
        );
        assert!(parse_yahoo_message("not json", "yahoo").is_none());
    }
}

#[cfg(test)]
mod driver_tests {
    use super::*;
    use std::sync::Arc;

    fn tmp_db() -> Arc<redb::Database> {
        let path = std::env::temp_dir().join(format!(
            "test_yahoo_drv_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(redb::Database::create(path).unwrap())
    }

    #[test]
    fn validate_is_always_ok_no_credentials() {
        let d = YahooDriver {
            name: "yahoo".into(),
            base_url: None,
            silence_seconds: 60,
            db: tmp_db(),
            table: "yahoo_subscriptions",
        };
        assert!(d.validate().is_ok());
    }

    #[test]
    fn load_subscriptions_reads_bare_keys() {
        let db = tmp_db();
        {
            let t: redb::TableDefinition<&str, bool> =
                redb::TableDefinition::new("yahoo_subscriptions");
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.insert("AAPL", true).unwrap();
                tab.insert("BTC-USD", true).unwrap();
            }
            w.commit().unwrap();
        }
        let d = YahooDriver {
            name: "yahoo".into(),
            base_url: None,
            silence_seconds: 60,
            db,
            table: "yahoo_subscriptions",
        };
        let mut subs = d.load_subscriptions();
        subs.sort();
        assert_eq!(subs, vec!["AAPL".to_string(), "BTC-USD".to_string()]);
    }
}
