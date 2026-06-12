//! Unified, source-tagged market event schema (internal; mapped to flat FFI payloads by facades).
use chrono::{DateTime, Utc};

/// The kind of provider a driver handles.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Alpaca,
    Finnhub,
    Yahoo,
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            ProviderKind::Alpaca => "alpaca",
            ProviderKind::Finnhub => "finnhub",
            ProviderKind::Yahoo => "yahoo",
        };
        f.write_str(s)
    }
}

/// Finnhub-specific trade metadata.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone, serde::Serialize)]
pub struct FinnhubTradeExtras {
    pub volume: f64,
    pub conditions: Vec<String>,
}

/// Provider-specific trade metadata (extended per provider in later phases).
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub enum TradeExtras {
    Finnhub(FinnhubTradeExtras),
    Yahoo(YahooTradeExtras),
    Alpaca(AlpacaTradeExtras), // corelib superset (not in finstream) — makes Alpaca trades uni-portable
}

/// Provider-specific quote metadata.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum QuoteExtras {
    Alpaca(AlpacaQuoteExtras),
    Yahoo(YahooQuoteExtras),
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlpacaTradeExtras {
    pub size: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub exchange: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]    pub conditions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub id: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlpacaQuoteExtras {
    pub bid: f64,
    pub ask: f64,
    pub bid_size: f64,
    pub ask_size: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub bid_exchange: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub ask_exchange: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]    pub conditions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tape: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct YahooTradeExtras {
    pub exchange: String,
    pub currency: String,
    pub market_hours: i32,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change_pct: f64,
    #[serde(skip_serializing_if = "is_zero_i64")] pub volume: i64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub open: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub day_high: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub day_low: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub prev_close: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub market_cap: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub bid: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub ask: f64,
    #[serde(skip_serializing_if = "is_zero_i64")] pub bid_size: i64,
    #[serde(skip_serializing_if = "is_zero_i64")] pub ask_size: i64,
    #[serde(skip_serializing_if = "String::is_empty")] pub short_name: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct YahooQuoteExtras {
    pub bid: f64,
    pub ask: f64,
    pub bid_size: i64,
    pub ask_size: i64,
    pub exchange: String,
    pub currency: String,
    pub market_hours: i32,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change_pct: f64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Quote {
    pub ticker: String,
    pub timestamp: DateTime<Utc>,
    pub price: f64,
    pub extras: QuoteExtras,
    pub raw: Option<String>,
}

fn is_zero_f64(v: &f64) -> bool { *v == 0.0 }
fn is_zero_i64(v: &i64) -> bool { *v == 0 }

/// A normalized trade.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub struct Trade {
    pub ticker: String,
    pub timestamp: DateTime<Utc>,
    pub price: f64,
    pub extras: TradeExtras,
    pub raw: Option<String>,
}

/// Connectivity/health state of a driver.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProviderStatus {
    Connected {
        provider: ProviderKind,
    },
    Disconnected {
        provider: ProviderKind,
        reason: String,
    },
    Reconnecting {
        provider: ProviderKind,
        attempt: u32,
        delay_ms: u64,
    },
    Error {
        provider: ProviderKind,
        message: String,
    },
}

/// A normalized, source-tagged event emitted by a driver.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub enum MarketEvent {
    Trade {
        source: String,
        data: Trade,
    },
    Quote {
        source: String,
        data: Quote,
    },
    Status {
        source: String,
        status: ProviderStatus,
    },
}

impl serde::Serialize for MarketEvent {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            MarketEvent::Trade { source, data } => {
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("source", source)?;
                m.serialize_entry("type", "trade")?;
                m.serialize_entry("ticker", &data.ticker)?;
                m.serialize_entry("timestamp", &data.timestamp.timestamp_millis())?;
                m.serialize_entry("price", &data.price)?;
                if let Some(raw) = &data.raw { m.serialize_entry("raw", raw)?; }
                match &data.extras {
                    TradeExtras::Finnhub(v) => m.serialize_entry("finnhub", v)?,
                    TradeExtras::Yahoo(v)   => m.serialize_entry("yahoo", v)?,
                    TradeExtras::Alpaca(v)  => m.serialize_entry("alpaca", v)?,
                }
                m.end()
            }
            MarketEvent::Quote { source, data } => {
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("source", source)?;
                m.serialize_entry("type", "quote")?;
                m.serialize_entry("ticker", &data.ticker)?;
                m.serialize_entry("timestamp", &data.timestamp.timestamp_millis())?;
                m.serialize_entry("price", &data.price)?;
                if let Some(raw) = &data.raw { m.serialize_entry("raw", raw)?; }
                match &data.extras {
                    QuoteExtras::Alpaca(v) => m.serialize_entry("alpaca", v)?,
                    QuoteExtras::Yahoo(v)  => m.serialize_entry("yahoo", v)?,
                }
                m.end()
            }
            MarketEvent::Status { source, status } => {
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("source", source)?;
                let val = serde_json::to_value(status).map_err(serde::ser::Error::custom)?;
                if let serde_json::Value::Object(obj) = val {
                    for (k, v) in obj { m.serialize_entry(&k, &v)?; }
                }
                m.end()
            }
        }
    }
}

#[cfg(test)]
mod schema_expansion_tests {
    use super::*;
    use chrono::TimeZone;

    fn ts() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc.timestamp_millis_opt(1_700_000_000_000).single().unwrap()
    }

    #[test]
    fn alpaca_quote_event_serializes_flat_with_nested_extras() {
        let ev = MarketEvent::Quote {
            source: "alpaca_main".into(),
            data: Quote {
                ticker: "AAPL".into(),
                timestamp: ts(),
                price: 191.5,
                extras: QuoteExtras::Alpaca(AlpacaQuoteExtras {
                    bid: 191.0, ask: 192.0, bid_size: 1.0, ask_size: 2.0,
                    bid_exchange: None, ask_exchange: None, conditions: vec![], tape: None,
                }),
                raw: None,
            },
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["source"], "alpaca_main");
        assert_eq!(v["type"], "quote");
        assert_eq!(v["ticker"], "AAPL");
        assert_eq!(v["price"], 191.5);
        assert_eq!(v["alpaca"]["bid"], 191.0);
        assert_eq!(v["alpaca"]["ask"], 192.0);
    }

    #[test]
    fn alpaca_trade_event_serializes_with_alpaca_extras() {
        let ev = MarketEvent::Trade {
            source: "alpaca_main".into(),
            data: Trade {
                ticker: "MSFT".into(),
                timestamp: ts(),
                price: 420.0,
                extras: TradeExtras::Alpaca(AlpacaTradeExtras {
                    size: 50.0, exchange: Some("V".into()), conditions: vec!["@".into()],
                    tape: Some("C".into()), id: Some(7),
                }),
                raw: None,
            },
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["ticker"], "MSFT");
        assert_eq!(v["alpaca"]["size"], 50.0);
        assert_eq!(v["alpaca"]["conditions"][0], "@");
    }
}
