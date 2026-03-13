use napi_derive::napi;
use prost::Message;
use serde::{Deserialize, Serialize};

/// The primary data structure for Yahoo Finance real-time quotes.
///
/// This struct corresponds to the `PricingData` message in the `.proto` definition.
/// It contains price, volume, and metadata for a specific financial instrument.
#[derive(Clone, PartialEq, Message, Serialize, Deserialize)]
pub struct PricingData {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(float, tag = "2")]
    pub price: f32,
    #[prost(sint64, tag = "3")]
    pub time: i64,
    #[prost(string, tag = "4")]
    pub currency: String,
    #[prost(string, tag = "5")]
    pub exchange: String,
    #[prost(enumeration = "QuoteType", tag = "6")]
    pub quote_type: i32,
    #[prost(enumeration = "MarketHoursType", tag = "7")]
    pub market_hours: i32,
    #[prost(float, tag = "8")]
    pub change_percent: f32,
    #[prost(sint64, tag = "9")]
    pub day_volume: i64,
    #[prost(float, tag = "10")]
    pub day_high: f32,
    #[prost(float, tag = "11")]
    pub day_low: f32,
    #[prost(float, tag = "12")]
    pub change: f32,
    #[prost(string, tag = "13")]
    pub short_name: String,
    #[prost(sint64, tag = "14")]
    pub expire_date: i64,
    #[prost(float, tag = "15")]
    pub open_price: f32,
    #[prost(float, tag = "16")]
    pub previous_close: f32,
    #[prost(float, tag = "17")]
    pub strike_price: f32,
    #[prost(string, tag = "18")]
    pub underlying_symbol: String,
    #[prost(sint64, tag = "19")]
    pub open_interest: i64,
    #[prost(enumeration = "OptionType", tag = "20")]
    pub option_type: i32,
}

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct JsPricingData {
    pub id: String,
    pub price: f64,
    pub time: i64,
    pub currency: String,
    pub exchange: String,
    pub quote_type: i32,
    pub market_hours: i32,
    pub change_percent: f64,
    pub day_volume: i64,
    pub day_high: f64,
    pub day_low: f64,
    pub change: f64,
    pub short_name: String,
    pub expire_date: i64,
    pub open_price: f64,
    pub previous_close: f64,
    pub strike_price: f64,
    pub underlying_symbol: String,
    pub open_interest: i64,
    pub option_type: i32,
}

impl From<PricingData> for JsPricingData {
    fn from(p: PricingData) -> Self {
        Self {
            id: p.id,
            price: p.price as f64,
            time: p.time,
            currency: p.currency,
            exchange: p.exchange,
            quote_type: p.quote_type,
            market_hours: p.market_hours,
            change_percent: p.change_percent as f64,
            day_volume: p.day_volume,
            day_high: p.day_high as f64,
            day_low: p.day_low as f64,
            change: p.change as f64,
            short_name: p.short_name,
            expire_date: p.expire_date,
            open_price: p.open_price as f64,
            previous_close: p.previous_close as f64,
            strike_price: p.strike_price as f64,
            underlying_symbol: p.underlying_symbol,
            open_interest: p.open_interest,
            option_type: p.option_type,
        }
    }
}

/// Categorizes the type of financial instrument providing the data.
#[napi]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum QuoteType {
    None = 0,
    Altsymbol = 5,
    Heartbeat = 7,
    Equity = 8,
    Index = 9,
    Mutualfund = 11,
    Moneymarket = 12,
    Option = 13,
    Currency = 14,
    Warrant = 15,
    Bond = 17,
    Future = 18,
    Etf = 20,
    Commodity = 23,
    Ecnquote = 28,
    Cryptocurrency = 41,
    Indicator = 42,
    Industry = 1000,
}

/// Represents the specific trading session of the quote.
#[napi]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum MarketHoursType {
    PreMarket = 0,
    RegularMarket = 1,
    PostMarket = 2,
    ExtendedHoursMarket = 3,
}

/// Distinguishes between Call and Put options.
#[napi]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum OptionType {
    Call = 0,
    Put = 1,
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    #[test]
    fn test_pricing_data_serialization_cycle() {
        let original = PricingData {
            id: "AAPL".to_string(),
            price: 150.50,
            time: 1698400000000,
            currency: "USD".to_string(),
            exchange: "NMS".to_string(),
            quote_type: QuoteType::Equity as i32,
            market_hours: MarketHoursType::RegularMarket as i32,
            change_percent: 1.5,
            day_volume: 50000000,
            day_high: 151.0,
            day_low: 149.0,
            change: 2.25,
            short_name: "Apple Inc.".to_string(),
            expire_date: 0,
            open_price: 150.0,
            previous_close: 148.0,
            strike_price: 0.0,
            underlying_symbol: "".to_string(),
            open_interest: 0,
            option_type: OptionType::Call as i32,
        };

        // // Encode to bytes
        let mut buf = Vec::new();
        original.encode(&mut buf).unwrap();

        // // Decode back to struct
        let decoded = PricingData::decode(&buf[..]).unwrap();

        assert_eq!(original.id, decoded.id);
        assert_eq!(original.price, decoded.price);
        assert_eq!(original.quote_type, decoded.quote_type);
    }

    #[test]
    fn test_enum_conversions() {
        assert_eq!(QuoteType::Equity as i32, 8);
        assert_eq!(MarketHoursType::RegularMarket as i32, 1);
        assert_eq!(OptionType::Call as i32, 0);
    }
}
