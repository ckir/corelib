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
        Err(_) => return vec![],
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
}

use crate::markets::nasdaq::datafeeds::streaming::core::driver::{AttemptOutcome, ProviderDriver};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use futures::future::{BoxFuture, FutureExt};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const FINNHUB_WS: &str = "wss://ws.finnhub.io";

pub struct FinnhubDriver {
    pub token: String,
    pub name: String,
}

impl ProviderDriver for FinnhubDriver {
    fn validate(&self) -> Result<(), String> {
        if self.token.is_empty() {
            Err("FINNHUB_API_KEY / token is required".into())
        } else {
            Ok(())
        }
    }

    fn connect_once<'a>(
        &'a self,
        symbols: &'a [String],
        tx: &'a mpsc::Sender<MarketEvent>,
        sub_rx: &'a mut mpsc::Receiver<Vec<String>>,
        stop_rx: &'a mut mpsc::Receiver<()>,
    ) -> BoxFuture<'a, AttemptOutcome> {
        async move {
            let url = format!("{FINNHUB_WS}?token={}", self.token);
            let (mut ws, _) = match connect_async(&url).await {
                Ok(v) => v,
                Err(_) => return AttemptOutcome::NeverConnected,
            };
            // signal the supervisor to reset backoff
            let _ = tx.send(MarketEvent::Status { source: self.name.clone(), status: ProviderStatus::Connected { provider: ProviderKind::Finnhub } }).await;
            let mut current: Vec<String> = symbols.to_vec();
            for s in &current {
                let m = serde_json::json!({ "type": "subscribe", "symbol": s }).to_string();
                if ws.send(Message::Text(m.into())).await.is_err() { return AttemptOutcome::ConnectedThenDropped; }
            }
            loop {
                tokio::select! {
                    _ = stop_rx.recv() => return AttemptOutcome::Stopped,
                    upd = sub_rx.recv() => {
                        match upd {
                            Some(syms) => {
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
                        Some(Ok(Message::Text(t))) => { for ev in parse_finnhub_frame(&t, &self.name) { let _ = tx.send(ev).await; } }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => return AttemptOutcome::ConnectedThenDropped,
                    }
                }
            }
        }.boxed()
    }
}
