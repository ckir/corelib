//! Engine channel payload + single-definition raw FFI pricing structs.
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, ProviderStatus};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

/// A unified representation of Alpaca pricing data, consolidating Trades, Quotes, and Bars.
#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlpacaPricingData {
    /// The ticker symbol of the instrument (e.g., "AAPL").
    pub symbol: String,
    /// The type of data received ("quote", "trade", "bar").
    pub message_type: String,
    /// The primary price (last trade price, close price for bars, or bid price for quotes).
    pub price: f64,
    /// The current bid price (applicable for quotes).
    pub bid_price: f64,
    /// The current ask price (applicable for quotes).
    pub ask_price: f64,
    /// The volume associated with the event.
    pub volume: f64,
    /// The timestamp provided by the Alpaca exchange.
    pub timestamp: String,
}

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

/// Lossless raw pricing payload carried on the engine channel (one variant per provider).
#[allow(dead_code)] // Yahoo variant added in Phase 2b; Alpaca produced from Task 7 on
pub enum RawPricing {
    Alpaca(AlpacaPricingData),
    Finnhub(FinnhubPricingData),
}

/// The shared engine channel item: a lifecycle status, or a pricing tick with the raw
/// payload plus an optional unified MarketEvent (None ⇒ raw-only, e.g. Alpaca bars).
#[allow(dead_code)]
#[allow(clippy::large_enum_variant)] // ProviderStatus carries string fields; boxing deferred to Phase 2b
pub enum CoreEvent {
    Status(ProviderStatus),
    Pricing {
        raw: RawPricing,
        uni: Option<MarketEvent>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn core_event_constructs_and_raw_payload_serializes_identically() {
        let raw = AlpacaPricingData {
            symbol: "AAPL".into(),
            message_type: "quote".into(),
            price: 1.0,
            bid_price: 1.0,
            ask_price: 2.0,
            volume: 3.0,
            timestamp: "t".into(),
        };
        let ev = CoreEvent::Pricing {
            raw: RawPricing::Alpaca(raw.clone()),
            uni: None,
        };
        match ev {
            CoreEvent::Pricing {
                raw: RawPricing::Alpaca(p),
                uni,
            } => {
                assert_eq!(p.symbol, "AAPL");
                assert!(uni.is_none());
            }
            _ => panic!(),
        }
        // byte-identity of the moved payload shape:
        let v = serde_json::to_value(&raw).unwrap();
        assert_eq!(v["symbol"], "AAPL");
        assert_eq!(v["ask_price"], 2.0);
    }
}
