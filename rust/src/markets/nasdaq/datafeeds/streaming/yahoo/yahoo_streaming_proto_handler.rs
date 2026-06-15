// =============================================
// FILE: rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streaming_proto_handler.rs
// PURPOSE: Yahoo Finance Protobuf message handler.
// DESCRIPTION: This module provides specialized logic for decoding and
// processing binary pricing data from Yahoo Finance websockets. It includes
// the protobuf definition, conversion logic to N-API compatible objects,
// and session-specific metadata extraction.
// =============================================

use prost::Message;
use serde::{Deserialize, Serialize};

/// The main Protobuf message structure for Yahoo Finance pricing data.
///
/// This struct is automatically decoded from the Base64-encoded binary payload
/// received via the Yahoo Finance websocket.
#[derive(Clone, PartialEq, Message)]
pub struct PricingData {
    /// The unique identifier (symbol) for the security.
    #[prost(string, tag = "1")]
    pub id: String,
    /// The last sale price.
    #[prost(float, tag = "2")]
    pub price: f32,
    /// The timestamp of the quote (Unix milliseconds).
    #[prost(int64, tag = "3")]
    pub time: i64,
    /// The currency of the quote (e.g., 'USD').
    #[prost(string, tag = "4")]
    pub currency: String,
    /// The exchange where the security is traded.
    #[prost(string, tag = "5")]
    pub exchange: String,
    /// The type of quote (see `QuoteType`).
    #[prost(int32, tag = "6")]
    pub quote_type: i32,
    /// The market session (Pre, Regular, Post).
    #[prost(int32, tag = "7")]
    pub market_hours: i32,
    /// The percentage change from the previous close.
    #[prost(float, tag = "8")]
    pub change_percent: f32,
    /// The total trading volume for the day.
    #[prost(int64, tag = "9")]
    pub day_volume: i64,
    /// The highest price traded during the day.
    #[prost(float, tag = "10")]
    pub day_high: f32,
    /// The lowest price traded during the day.
    #[prost(float, tag = "11")]
    pub day_low: f32,
    /// The numeric change from the previous close.
    #[prost(float, tag = "12")]
    pub change: f32,
    /// The short name of the security.
    #[prost(string, tag = "13")]
    pub short_name: String,
    /// The expiration date (for options/futures).
    #[prost(int64, tag = "14")]
    pub expire_date: i64,
    /// The opening price for the day.
    #[prost(float, tag = "15")]
    pub open_price: f32,
    /// The closing price from the previous session.
    #[prost(float, tag = "16")]
    pub previous_close: f32,
    /// The strike price (for options).
    #[prost(float, tag = "17")]
    pub strike_price: f32,
    /// The symbol of the underlying security (for derivatives).
    #[prost(string, tag = "18")]
    pub underlying_symbol: String,
    /// The current open interest (for options).
    #[prost(int64, tag = "19")]
    pub open_interest: i64,
    /// The option type (Call/Put).
    #[prost(int32, tag = "20")]
    pub option_type: i32,
    /// Indicates if it's a mini option.
    #[prost(int64, tag = "21")]
    pub mini_option: i64,
    /// The size of the last trade.
    #[prost(int64, tag = "22")]
    pub last_size: i64,
    /// The current bid price.
    #[prost(float, tag = "23")]
    pub bid_price: f32,
    /// The current bid size.
    #[prost(int64, tag = "24")]
    pub bid_size: i64,
    /// The current ask price.
    #[prost(float, tag = "25")]
    pub ask_price: f32,
    /// The current ask size.
    #[prost(int64, tag = "26")]
    pub ask_size: i64,
    /// Precision hint for formatting the price.
    #[prost(int64, tag = "27")]
    pub price_hint: i64,
    /// Trading volume over the last 24 hours.
    #[prost(int64, tag = "28")]
    pub vol_24hr: i64,
    /// Total volume across all currencies (for crypto).
    #[prost(int64, tag = "29")]
    pub vol_all_currencies: i64,
    /// The source currency (for crypto/forex).
    #[prost(string, tag = "30")]
    pub from_currency: String,
    /// The last market where the security traded.
    #[prost(string, tag = "31")]
    pub last_market: String,
    /// The current circulating supply (for crypto).
    #[prost(double, tag = "32")]
    pub circulating_supply: f64,
    /// The total market capitalization.
    #[prost(double, tag = "33")]
    pub market_cap: f64,
}

/// An N-API compatible object representing pricing data.
///
/// This struct mirrors `PricingData` but uses `f64` for all floating-point numbers
/// to ensure precision when passed to JavaScript.
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(Clone, Serialize, Deserialize)]
pub struct JsPricingData {
    /// The unique identifier (symbol) for the security.
    pub id: String,
    /// The last sale price.
    pub price: f64,
    /// The timestamp of the quote (Unix milliseconds).
    pub time: i64,
    /// The currency of the quote (e.g., 'USD').
    pub currency: String,
    /// The exchange where the security is traded.
    pub exchange: String,
    /// The type of quote (see `QuoteType`).
    pub quote_type: i32,
    /// The market session (Pre, Regular, Post).
    pub market_hours: i32,
    /// The percentage change from the previous close.
    pub change_percent: f64,
    /// The total trading volume for the day.
    pub day_volume: i64,
    /// The highest price traded during the day.
    pub day_high: f64,
    /// The lowest price traded during the day.
    pub day_low: f64,
    /// The numeric change from the previous close.
    pub change: f64,
    /// The short name of the security.
    pub short_name: String,
    /// The expiration date (for options/futures).
    pub expire_date: i64,
    /// The opening price for the day.
    pub open_price: f64,
    /// The closing price from the previous session.
    pub previous_close: f64,
    /// The strike price (for options).
    pub strike_price: f64,
    /// The symbol of the underlying security (for derivatives).
    pub underlying_symbol: String,
    /// The current open interest (for options).
    pub open_interest: i64,
    /// The option type (Call/Put).
    pub option_type: i32,
    /// Indicates if it's a mini option.
    pub mini_option: i64,
    /// The size of the last trade.
    pub last_size: i64,
    /// The current bid price.
    pub bid_price: f64,
    /// The current bid size.
    pub bid_size: i64,
    /// The current ask price.
    pub ask_price: f64,
    /// The current ask size.
    pub ask_size: i64,
    /// Precision hint for formatting the price.
    pub price_hint: i64,
    /// Trading volume over the last 24 hours.
    pub vol_24hr: i64,
    /// Total volume across all currencies (for crypto).
    pub vol_all_currencies: i64,
    /// The source currency (for crypto/forex).
    pub from_currency: String,
    /// The last market where the security traded.
    pub last_market: String,
    /// The current circulating supply (for crypto).
    pub circulating_supply: f64,
    /// The total market capitalization.
    pub market_cap: f64,
}

impl From<PricingData> for JsPricingData {
    /// Converts a native `PricingData` struct into a `JsPricingData` object.
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
            mini_option: p.mini_option,
            last_size: p.last_size,
            bid_price: p.bid_price as f64,
            bid_size: p.bid_size,
            ask_price: p.ask_price as f64,
            ask_size: p.ask_size,
            price_hint: p.price_hint,
            vol_24hr: p.vol_24hr,
            vol_all_currencies: p.vol_all_currencies,
            from_currency: p.from_currency,
            last_market: p.last_market,
            circulating_supply: p.circulating_supply,
            market_cap: p.market_cap,
        }
    }
}

/// Categorizes the type of financial instrument providing the data.
#[cfg_attr(feature = "napi", napi_derive::napi)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum QuoteType {
    /// No specific type defined.
    None = 0,
    /// Alternative symbol representation.
    Altsymbol = 5,
    /// Internal heartbeat signal to keep the connection alive.
    Heartbeat = 7,
    /// Common stock or equity security.
    Equity = 8,
    /// Market index (e.g., S&P 500).
    Index = 9,
    /// Mutual fund.
    Mutualfund = 11,
    /// Money market fund.
    Moneymarket = 12,
    /// Options contract.
    Option = 13,
    /// Foreign exchange currency pair.
    Currency = 14,
    /// Trading warrant.
    Warrant = 15,
    /// Fixed income bond.
    Bond = 17,
    /// Futures contract.
    Future = 18,
    /// Exchange Traded Fund.
    Etf = 20,
    /// Commodity (gold, oil, etc.).
    Commodity = 23,
    /// ECN specific quote.
    Ecnquote = 28,
    /// Digital cryptocurrency.
    Cryptocurrency = 41,
    /// Economic or market indicator.
    Indicator = 42,
    /// Industry-specific index or data.
    Industry = 1000,
}

/// Represents the specific trading session of the quote.
#[cfg_attr(feature = "napi", napi_derive::napi)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum MarketHours {
    /// Regular trading session.
    Regular = 0,
    /// Pre-market trading session.
    PreMarket = 1,
    /// After-hours (Post-market) trading session.
    PostMarket = 2,
    /// Extended trading hours.
    ExtendedHours = 3,
}

/// Decodes a Base64-encoded binary payload into a native `PricingData` struct.
///
/// # Arguments
/// * `encoded` - The Base64 string received from the websocket.
///
/// # Returns
/// A `Result` containing the decoded `PricingData` or a decoding error.
pub fn decode_yahoo_message(encoded: &str) -> Result<PricingData, String> {
    use base64::{engine::general_purpose, Engine as _};

    let decoded = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    PricingData::decode(&decoded[..]).map_err(|e| format!("Protobuf decode error: {}", e))
}
