// =============================================
// FILE: rust/src/markets/nasdaq/api_nasdaq_marketstatus.rs
// PURPOSE: Public API for fetching Nasdaq market status.
// DESCRIPTION: This module provides a high-level interface for fetching the
// real-time market status and schedule information from Nasdaq.
// =============================================

use crate::markets::nasdaq::api_nasdaq_unlimited::nasdaq_end_point;
use crate::retrieve::unlimited::ApiResponse;
use serde_json::Value;

/// Fetches the current Nasdaq market status information.
///
/// This function performs an asynchronous request to the official Nasdaq API
/// endpoint (`/api/market-info`). It automatically injects the necessary spoofed
/// headers and validates the application-level `rCode` via the resilient 
/// `nasdaq_end_point` utility.
///
/// # Returns
/// A `Result` containing the parsed `serde_json::Value` of the status `data` payload
/// on success, or an error message string on failure.
pub async fn get_status() -> Result<Value, String> {
    // Forward the request to the extended version using the default Nasdaq base URL
    get_status_ext("https://api.nasdaq.com").await
}

/// Internal implementation of status fetching that allows overriding the base URL for testing.
///
/// # Arguments
/// * `base_url` - The base URL for the API request.
///
/// # Returns
/// A `Result` containing the parsed `serde_json::Value` of the `data` payload or an error string.
async fn get_status_ext(base_url: &str) -> Result<Value, String> {
    // Construct the full Nasdaq API endpoint URL
    let url = format!("{}/api/market-info", base_url);

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
    async fn test_get_status_success() {
        // Start a mock server to simulate the Nasdaq API
        let server = MockServer::start().await;

        // Define the expected JSON payload
        let expected_data = json!({
            "marketIndicator": "Market Open",
            "mrktStatus": "Open",
            "isBusinessDay": true,
            "nextTradeDate": "Mar 10, 2026"
        });

        // Configure the mock endpoint to return a valid 200 response with rCode 200
        Mock::given(method("GET"))
            .and(path("/api/market-info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": expected_data,
                "status": { "rCode": 200, "bCodeMessage": null, "developerMessage": null }
            })))
            .mount(&server)
            .await;

        // Execute the internal function against the mock server
        let res = get_status_ext(&server.uri()).await;

        // Verify the response is successful
        assert!(res.is_ok(), "Failed to fetch status: {:?}", res);
        
        // Verify the payload matches expectations
        let data = res.unwrap();
        assert_eq!(data["mrktStatus"], "Open");
        assert_eq!(data["isBusinessDay"], true);
    }

    #[tokio::test]
    async fn test_get_status_logic_error() {
        // Start a mock server to simulate the Nasdaq API
        let server = MockServer::start().await;

        // Configure the mock endpoint to return a 200 OK but with a logical error (rCode 400)
        Mock::given(method("GET"))
            .and(path("/api/market-info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": { 
                    "rCode": 400, 
                    "developerMessage": "Bad Request", 
                    "bCodeMessage": [{"code": 1001, "errorMessage": "Invalid parameters"}] 
                },
                "data": null
            })))
            .mount(&server)
            .await;

        // Execute the internal function against the mock server
        let res = get_status_ext(&server.uri()).await;

        // Verify the response is an error
        assert!(res.is_err());
        
        // Verify the error message contains details of the logic failure
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("Nasdaq API returned non-200 rCode"));
        assert!(err_msg.contains("400"));
    }

    #[tokio::test]
    async fn test_get_status_transport_error() {
        // Start a mock server to simulate the Nasdaq API
        let server = MockServer::start().await;

        // Configure the mock endpoint to simulate a transport failure (500 Internal Server Error)
        Mock::given(method("GET"))
            .and(path("/api/market-info"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        // Execute the internal function against the mock server
        let res = get_status_ext(&server.uri()).await;

        // Verify the response is an error
        assert!(res.is_err());
        
        // Verify the error message indicates a transport/HTTP error
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("HTTP Error 500"));
    }
}
