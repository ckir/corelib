use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
    AlpacaQuoteExtras, AlpacaTradeExtras, MarketEvent, Quote, QuoteExtras, Trade, TradeExtras,
};
use crate::markets::nasdaq::datafeeds::streaming::core::types::AlpacaPricingData;
use chrono::{DateTime, Utc};

fn f(o: &serde_json::Value, k: &str) -> f64 {
    o.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0)
}
fn s(o: &serde_json::Value, k: &str) -> String {
    o.get(k)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
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
) -> Option<(AlpacaPricingData, Option<MarketEvent>)> {
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
            Some((raw, Some(uni)))
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
            Some((raw, Some(uni)))
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
            Some((raw, None)) // bars raw-only
        }
        _ => None,
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
        let v = serde_json::to_value(&uni.unwrap()).unwrap();
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
        let v = serde_json::to_value(&uni.unwrap()).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["alpaca"]["size"], 50.0);
    }
    #[test]
    fn bar_builds_raw_only() {
        let obj: serde_json::Value = serde_json::from_str(
            r#"{"T":"b","S":"TSLA","c":250.0,"v":1000,"t":"2024-01-02T15:00:00Z"}"#).unwrap();
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "bar");
        assert_eq!(raw.price, 250.0);
        assert!(uni.is_none()); // bars are raw-only
    }
    #[test]
    fn non_pricing_returns_none() {
        let obj: serde_json::Value = serde_json::from_str(r#"{"T":"subscription"}"#).unwrap();
        assert!(parse_alpaca_obj(&obj, "s").is_none());
    }
}
