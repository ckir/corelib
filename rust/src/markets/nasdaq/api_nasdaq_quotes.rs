// =============================================
// FILE: rust/src/markets/nasdaq/api_nasdaq_quotes.rs
// PURPOSE: Public API for fetching Nasdaq quotes.
// DESCRIPTION: This module provides a high-level interface for fetching real-time 
// and end-of-day quotes from Nasdaq. It handles symbol parsing, asset class 
// mapping, and concurrent bulk fetching with a configurable concurrency limit.
// =============================================

use crate::markets::nasdaq::api_nasdaq_unlimited::nasdaq_end_point;
use crate::retrieve::unlimited::ApiResponse;
use futures::future::join_all;
use serde_json::Value;
use std::str::FromStr;

/// Defines the asset classes recognized by the Nasdaq API.
///
/// This enum mirrors the exact categories specified in the TypeScript `AssetClass` 
/// definition, differentiating between real-time and delayed/end-of-day assets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetClass {
    /// Real-time Stock quotes.
    Stocks,
    /// Real-time ETF quotes.
    Etf,
    /// Real-time Currency quotes.
    Currencies,
    /// Real-time Cryptocurrency quotes.
    Crypto,
    /// End-of-day Mutual Fund quotes.
    MutualFunds,
    /// End-of-day Index quotes.
    Index,
    /// End-of-day Fixed Income (Bonds) quotes.
    FixedIncome,
}

impl FromStr for AssetClass {
    type Err = String;

    /// Parses a string slice into an `AssetClass` enum variant.
    /// 
    /// The input string is converted to lowercase before matching to ensure 
    /// case-insensitive parsing, aligning with the TypeScript implementation.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "stocks" => Ok(AssetClass::Stocks),
            "etf" => Ok(AssetClass::Etf),
            "currencies" => Ok(AssetClass::Currencies),
            "crypto" => Ok(AssetClass::Crypto),
            "mutualfunds" => Ok(AssetClass::MutualFunds),
            "index" => Ok(AssetClass::Index),
            "fixedincome" => Ok(AssetClass::FixedIncome),
            _ => Err(format!("Unknown AssetClass: {}", s)),
        }
    }
}

impl std::fmt::Display for AssetClass {
    /// Formats the `AssetClass` into the exact string required by Nasdaq API URL parameters.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            AssetClass::Stocks => "stocks",
            AssetClass::Etf => "etf",
            AssetClass::Currencies => "currencies",
            AssetClass::Crypto => "crypto",
            AssetClass::MutualFunds => "mutualfunds",
            AssetClass::Index => "index",
            AssetClass::FixedIncome => "fixedincome",
        };
        // Write the normalized string to the formatter
        write!(f, "{}", s)
    }
}

/// Parses an input string in the format `"SYMBOL::assetclass"` into its components.
///
/// # Arguments
/// * `input` - The formatted string to parse (e.g., `"AAPL::stocks"`).
///
/// # Returns
/// A `Result` containing a tuple of the uppercase symbol and parsed `AssetClass`.
fn parse_symbol_input(input: &str) -> Result<(String, AssetClass), String> {
    // Split the input string into exactly two parts using the "::" delimiter
    let parts: Vec<&str> = input.split("::").collect();
    if parts.len() != 2 {
        return Err(format!(
            "Invalid format for '{}'. Expected 'SYMBOL::assetclass'",
            input
        ));
    }

    // Extract the symbol and convert it to uppercase for API compatibility
    let symbol = parts[0].to_uppercase();
    // Parse the second part into the AssetClass enum
    let class = AssetClass::from_str(parts[1])?;

    Ok((symbol, class))
}

/// Fetches quote information for a single Nasdaq symbol using the official API.
///
/// # Arguments
/// * `symbol_input` - The symbol and asset class formatted as `"SYMBOL::assetclass"` (e.g., `"MSFT::stocks"`).
///
/// # Returns
/// A `Result` containing the parsed `serde_json::Value` of the quote's `data` payload.
pub async fn nasdaq_quote(symbol_input: &str) -> Result<Value, String> {
    // Forward the request to the extended version using the default Nasdaq base URL
    nasdaq_quote_ext(symbol_input, "https://api.nasdaq.com").await
}

/// Internal implementation of quote fetching that allows overriding the base URL for testing.
async fn nasdaq_quote_ext(symbol_input: &str, base_url: &str) -> Result<Value, String> {
    // Parse the input string into actionable components
    let (symbol, class) = parse_symbol_input(symbol_input)?;

    // Construct the full Nasdaq API endpoint URL with the required query parameters
    let url = format!(
        "{}/api/quote/{}/info?assetclass={}",
        base_url, symbol, class
    );

    // Execute the request using the highly resilient `api_nasdaq_unlimited` module
    let response = nasdaq_end_point::<Value>(&url, None).await;

    // Evaluate the response and map the discriminated union to a standard Result
    match response {
        ApiResponse::Success { value } => {
            // Extract the "data" field from the response body if it exists, otherwise return the full body
            let data = value.body.get("data").cloned().unwrap_or(value.body);
            Ok(data)
        }
        // Map the structured error reason to a string for the caller
        ApiResponse::Error { reason } => Err(reason.to_string()),
    }
}

/// Fetches quote information for multiple Nasdaq symbols in parallel with concurrency control.
///
/// # Arguments
/// * `symbols` - A slice of symbol strings formatted as `"SYMBOL::assetclass"`.
/// * `concurrency_limit` - The maximum number of simultaneous network requests. Set to 0 for the default (5).
///
/// # Returns
/// A `Vec` of `Result` objects, where each element corresponds to the input symbol at the same index.
pub async fn nasdaq_quotes(symbols: &[&str], concurrency_limit: usize) -> Vec<Result<Value, String>> {
    // Forward the bulk request to the extended version using the default Nasdaq base URL
    nasdaq_quotes_ext(symbols, concurrency_limit, "https://api.nasdaq.com").await
}

/// Internal implementation of bulk quote fetching that allows overriding the base URL for testing.
async fn nasdaq_quotes_ext(
    symbols: &[&str],
    concurrency_limit: usize,
    base_url: &str,
) -> Vec<Result<Value, String>> {
    // Use the provided limit or fall back to 5 if 0 is specified
    let limit = if concurrency_limit == 0 {
        5
    } else {
        concurrency_limit
    };

    let mut results = Vec::with_capacity(symbols.len());

    // Process the list of symbols in chunks to respect the concurrency limit
    for chunk in symbols.chunks(limit) {
        // Create an iterator of futures, each fetching a single quote
        let futures = chunk.iter().map(|&s| nasdaq_quote_ext(s, base_url));
        
        // Execute all futures in the current chunk concurrently
        let chunk_results = join_all(futures).await;
        
        // Append the results of the current batch to the final vector
        results.extend(chunk_results);
    }

    results
}

// =============================================
// EXHAUSTIVE INTEGRATION TESTS
// =============================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn test_parse_symbol_input_valid() {
        // Test parsing of a standard real-time stock
        let (sym, class) = parse_symbol_input("MSFT::stocks").unwrap();
        assert_eq!(sym, "MSFT");
        assert_eq!(class, AssetClass::Stocks);

        // Test parsing of an ETF with mixed casing
        let (sym, class) = parse_symbol_input("qQq::EtF").unwrap();
        assert_eq!(sym, "QQQ");
        assert_eq!(class, AssetClass::Etf);

        // Test parsing of a non-real-time index
        let (sym, class) = parse_symbol_input("NDX::index").unwrap();
        assert_eq!(sym, "NDX");
        assert_eq!(class, AssetClass::Index);
    }

    #[tokio::test]
    async fn test_parse_symbol_input_invalid() {
        // Test missing delimiter
        let res = parse_symbol_input("AAPL");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Invalid format"));

        // Test invalid asset class
        let res = parse_symbol_input("AAPL::bonds");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Unknown AssetClass"));
    }

    #[tokio::test]
    async fn test_nasdaq_quote_success() {
        let server = MockServer::start().await;
        let symbol = "AAPL";
        let expected_data = json!({
            "symbol": symbol,
            "companyName": "Apple Inc.",
            "primaryData": {
                "lastSalePrice": "$150.00"
            }
        });

        Mock::given(method("GET"))
            .and(path(format!("/api/quote/{}/info", symbol)))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": expected_data,
                "status": { "rCode": 200 }
            })))
            .mount(&server)
            .await;

        let res = nasdaq_quote_ext("AAPL::stocks", &server.uri()).await;
        
        assert!(res.is_ok(), "Failed to fetch quote: {:?}", res);
        let data = res.unwrap();
        assert_eq!(data["symbol"], symbol);
        assert_eq!(data["companyName"], "Apple Inc.");
    }

    #[tokio::test]
    async fn test_nasdaq_quote_invalid_symbol() {
        let server = MockServer::start().await;
        let symbol = "INVALID";

        Mock::given(method("GET"))
            .and(path(format!("/api/quote/{}/info", symbol)))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": { "rCode": 400, "developerMessage": "Symbol not found" }
            })))
            .mount(&server)
            .await;

        let res = nasdaq_quote_ext("INVALID::stocks", &server.uri()).await;
        
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Symbol not found"));
    }

    #[tokio::test]
    async fn test_nasdaq_quotes_bulk() {
        let server = MockServer::start().await;
        
        let symbols = vec!["MSFT", "QQQ", "TSLA"];
        for sym in &symbols {
            Mock::given(method("GET"))
                .and(path(format!("/api/quote/{}/info", sym)))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "data": { "symbol": sym },
                    "status": { "rCode": 200 }
                })))
                .mount(&server)
                .await;
        }

        let input = vec!["MSFT::stocks", "QQQ::etf", "TSLA::stocks"];
        let results = nasdaq_quotes_ext(&input, 2, &server.uri()).await;

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].as_ref().unwrap()["symbol"], "MSFT");
        assert_eq!(results[1].as_ref().unwrap()["symbol"], "QQQ");
        assert_eq!(results[2].as_ref().unwrap()["symbol"], "TSLA");
    }

    #[tokio::test]
    async fn test_nasdaq_quotes_bulk_with_errors() {
        let server = MockServer::start().await;
        
        // NVDA Success
        Mock::given(method("GET"))
            .and(path("/api/quote/NVDA/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "symbol": "NVDA" },
                "status": { "rCode": 200 }
            })))
            .mount(&server)
            .await;

        // BADTICKER Error
        Mock::given(method("GET"))
            .and(path("/api/quote/BADTICKER/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": { "rCode": 404 }
            })))
            .mount(&server)
            .await;

        // AMD Success
        Mock::given(method("GET"))
            .and(path("/api/quote/AMD/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "symbol": "AMD" },
                "status": { "rCode": 200 }
            })))
            .mount(&server)
            .await;

        let input = vec!["NVDA::stocks", "BADTICKER::stocks", "AMD::stocks"];
        let results = nasdaq_quotes_ext(&input, 5, &server.uri()).await;

        assert_eq!(results.len(), 3);
        assert!(results[0].is_ok());
        assert!(results[1].is_err());
        assert!(results[2].is_ok());
    }
}
