//! FinnhubStreaming N-API facade, flat payload, and MarketEvent→flat mapper.
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, Trade, TradeExtras};

/// Flat per-provider pricing payload sent to JS `on_pricing` (mirrors AlpacaPricingData shape;
/// Finnhub timestamps are numeric epoch ms, so `timestamp` is f64).
#[napi(object)]
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct FinnhubPricingData {
    pub symbol: String,
    pub message_type: String,
    pub price: f64,
    pub volume: f64,
    pub timestamp: f64,
    pub conditions: Option<Vec<String>>,
}

/// Map a MarketEvent::Trade to the flat FinnhubPricingData. Returns None for non-pricing events.
pub fn market_event_to_finnhub_pricing(ev: &MarketEvent) -> Option<FinnhubPricingData> {
    match ev {
        MarketEvent::Trade { data: Trade { ticker, timestamp, price, extras, .. }, .. } => {
            let (volume, conditions) = match extras {
                TradeExtras::Finnhub(x) => (x.volume, x.conditions.clone()),
            };
            Some(FinnhubPricingData {
                symbol: ticker.clone(),
                message_type: "trade".to_string(),
                price: *price,
                volume,
                timestamp: timestamp.timestamp_millis() as f64,
                conditions: if conditions.is_empty() { None } else { Some(conditions) },
            })
        }
        MarketEvent::Status { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::{FinnhubTradeExtras, ProviderKind, ProviderStatus};
    use chrono::TimeZone;

    #[test]
    fn maps_trade_to_flat_payload() {
        let ev = MarketEvent::Trade {
            source: "finnhub_main".into(),
            data: Trade {
                ticker: "AAPL".into(),
                timestamp: chrono::Utc.timestamp_millis_opt(1_700_000_000_000).single().unwrap(),
                price: 191.5,
                extras: TradeExtras::Finnhub(FinnhubTradeExtras { volume: 100.0, conditions: vec!["@".into()] }),
                raw: None,
            },
        };
        let p = market_event_to_finnhub_pricing(&ev).unwrap();
        assert_eq!(p, FinnhubPricingData {
            symbol: "AAPL".into(), message_type: "trade".into(), price: 191.5, volume: 100.0,
            timestamp: 1_700_000_000_000.0, conditions: Some(vec!["@".into()]),
        });
    }
    #[test]
    fn status_events_are_not_pricing() {
        let ev = MarketEvent::Status { source: "finnhub_main".into(), status: ProviderStatus::Connected { provider: ProviderKind::Finnhub } };
        assert!(market_event_to_finnhub_pricing(&ev).is_none());
    }
}
