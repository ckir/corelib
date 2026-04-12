// =============================================
// FILE: rust/src/markets/nasdaq/api_nasdaq_unlimited.rs
// PURPOSE: High-resilience Nasdaq API wrapper.
// DESCRIPTION: This module provides specialized wrappers for the Nasdaq API.
// It automatically injects required spoofed headers (Standard or Charting)
// and validates the application-level `rCode` within the response JSON.
// =============================================

use crate::retrieve::unlimited::{end_point, ApiResponse, RequestOptions};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;

/// The version string for Chrome used to spoof the User-Agent for Nasdaq requests.
const CHROME_VERSION: &str = "145";

/// Generates the static spoof headers required for authentic Nasdaq API requests.
///
/// This function determines whether to use "Standard" headers (for `www.nasdaq.com`)
/// or "Charting" headers (for `charting.nasdaq.com`) based on the URL content.
///
/// # Arguments
/// * `url` - The target Nasdaq URL string.
///
/// # Returns
/// A `HashMap` containing the necessary HTTP header keys and values.
pub fn get_nasdaq_headers(url: &str) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    // Check if the URL is for the charting domain
    let is_charting = url.contains("charting");

    // Pre-format the dynamic SEC-CH-UA and User-Agent strings with the fixed Chrome version
    let sec_ch_ua = format!(
        "\"Google Chrome\";v=\"{CHROME_VERSION}\", \"Not-A.Brand\";v=\"8\", \"Chromium\";v=\"{CHROME_VERSION}\""
    );
    let user_agent = format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36"
    );

    if is_charting {
        // Apply headers required by the charting.nasdaq.com endpoints
        headers.insert("accept".to_string(), "*/*".to_string());
        headers.insert("accept-language".to_string(), "en-US,en;q=0.9".to_string());
        headers.insert("cache-control".to_string(), "no-cache".to_string());
        headers.insert("pragma".to_string(), "no-cache".to_string());
        headers.insert("priority".to_string(), "u=1, i".to_string());
        headers.insert("sec-ch-ua".to_string(), sec_ch_ua);
        headers.insert("sec-ch-ua-mobile".to_string(), "?0".to_string());
        headers.insert("sec-ch-ua-platform".to_string(), "\"Windows\"".to_string());
        headers.insert("sec-fetch-dest".to_string(), "empty".to_string());
        headers.insert("sec-fetch-mode".to_string(), "cors".to_string());
        headers.insert("sec-fetch-site".to_string(), "same-origin".to_string());
        headers.insert(
            "referer".to_string(),
            "https://charting.nasdaq.com/dynamic/chart.html".to_string(),
        );
        headers.insert("user-agent".to_string(), user_agent);
    } else {
        // Apply headers required by the standard api.nasdaq.com endpoints
        headers.insert(
            "accept".to_string(),
            "application/json, text/plain, */*".to_string(),
        );
        headers.insert("accept-language".to_string(), "en-US,en;q=0.9".to_string());
        headers.insert("origin".to_string(), "https://www.nasdaq.com".to_string());
        headers.insert("referer".to_string(), "https://www.nasdaq.com/".to_string());
        headers.insert("sec-ch-ua".to_string(), sec_ch_ua);
        headers.insert("sec-ch-ua-mobile".to_string(), "?0".to_string());
        headers.insert("sec-ch-ua-platform".to_string(), "\"Windows\"".to_string());
        headers.insert("user-agent".to_string(), user_agent);
    }

    headers
}

/// Makes a single resilient request to a Nasdaq API endpoint with automatic header injection.
///
/// This function dynamically determines the correct headers for the target URL,
/// executes the request via the `unlimited` module, and then performs a deep validation
/// of the Nasdaq-specific `status.rCode` field in the JSON response.
///
/// User-provided headers in `RequestOptions` will override any generated defaults.
///
/// # Arguments
/// * `url` - The target Nasdaq URL to fetch.
/// * `options` - Optional overrides for retries, timeouts, and headers.
///
/// # Returns
/// An `ApiResponse<T>` containing either the Generic parsed response body or an error state.
pub async fn nasdaq_end_point<T: DeserializeOwned + Serialize>(
    url: &str,
    options: Option<RequestOptions>,
) -> ApiResponse<T> {
    let mut opts = options.unwrap_or_default();
    // Generate the baseline Nasdaq headers for this URL
    let mut headers = get_nasdaq_headers(url);

    // Merge user-defined headers, allowing them to override the defaults
    if let Some(user_headers) = opts.headers {
        for (k, v) in user_headers {
            // Keys are forced to lowercase to match standard HTTP behavior and the TS implementation
            headers.insert(k.to_lowercase(), v);
        }
    }

    // Update the options with the final header map
    opts.headers = Some(headers);

    // Execute the request using the core resilient retrieve logic
    let response = end_point::<T>(url, Some(opts)).await;

    // Perform application-level validation on the received data
    match response {
        ApiResponse::Success { value } => {
            // Serialize the body to a JSON Value to inspect internal fields without knowing the full type T
            if let Ok(body_val) = serde_json::to_value(&value.body) {
                // Nasdaq standardizes success/failure in an 'rCode' field deep in the JSON
                let r_code = body_val.pointer("/status/rCode").and_then(|v| v.as_i64());

                if let Some(code) = r_code {
                    // An rCode of 200 is the only acceptable success state
                    if code != 200 {
                        // Return an Error state with the details provided by Nasdaq's API
                        return ApiResponse::Error {
                            reason: serde_json::json!({
                                "error": "Nasdaq API returned non-200 rCode",
                                "rCode": code,
                                "bCodeMessage": body_val.pointer("/status/bCodeMessage"),
                                "developerMessage": body_val.pointer("/status/developerMessage")
                            }),
                        };
                    }
                }
            }

            // Return the original Success if no validation errors were found
            ApiResponse::Success { value }
        }
        // Passthrough errors from the underlying fetcher
        ApiResponse::Error { reason } => ApiResponse::Error { reason },
    }
}

/// Makes multiple parallel resilient requests to multiple Nasdaq API endpoints.
///
/// This function maps each URL to a `nasdaq_end_point` call, ensuring that the
/// correct headers and validation logic are applied to each request independently.
/// All requests are executed concurrently.
///
/// # Arguments
/// * `urls` - A slice of target Nasdaq URLs.
/// * `options` - Shared configuration overrides applied to every request in the batch.
///
/// # Returns
/// A vector of `ApiResponse<T>` objects.
pub async fn nasdaq_end_points<T: DeserializeOwned + Serialize>(
    urls: &[&str],
    options: Option<RequestOptions>,
) -> Vec<ApiResponse<T>> {
    let opts = options.unwrap_or_default();

    // Map each URL into an asynchronous task
    let futures = urls.iter().map(|&url| {
        // Clone the options for each task
        let cloned_opts = opts.clone();
        async move { nasdaq_end_point::<T>(url, Some(cloned_opts)).await }
    });

    // Execute all futures concurrently and wait for all to complete
    futures::future::join_all(futures).await
}

// =============================================
// EXHAUSTIVE TESTS
// =============================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct MockResponse {
        symbol: String,
        price: f64,
        status: Option<MockStatus>, // Optional to test both wrapped and unwrapped JSON
    }

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct MockStatus {
        #[serde(rename = "rCode")]
        r_code: i64,
    }

    #[tokio::test]
    async fn test_get_nasdaq_headers_standard() {
        let headers = get_nasdaq_headers("https://api.nasdaq.com/api/quote/AAPL/info");

        assert_eq!(headers.get("origin").unwrap(), "https://www.nasdaq.com");
        assert_eq!(headers.get("referer").unwrap(), "https://www.nasdaq.com/");
        assert_eq!(headers.get("sec-ch-ua-platform").unwrap(), "\"Windows\"");
        assert!(headers.get("user-agent").unwrap().contains("Chrome/145"));
        assert!(headers.get("accept").unwrap().contains("application/json"));
    }

    #[tokio::test]
    async fn test_get_nasdaq_headers_charting() {
        let headers = get_nasdaq_headers("https://charting.nasdaq.com/data");

        assert_eq!(headers.get("accept").unwrap(), "*/*");
        assert_eq!(headers.get("cache-control").unwrap(), "no-cache");
        assert_eq!(headers.get("sec-fetch-mode").unwrap(), "cors");
        assert_eq!(
            headers.get("referer").unwrap(),
            "https://charting.nasdaq.com/dynamic/chart.html"
        );
        assert!(!headers.contains_key("origin")); // Origin is not set for charting
    }

    #[tokio::test]
    async fn test_nasdaq_end_point_success() {
        let server = MockServer::start().await;

        let expected_body = MockResponse {
            symbol: "AAPL".to_string(),
            price: 150.0,
            status: Some(MockStatus { r_code: 200 }), // Valid rCode
        };

        // Ensure the server receives the automatically injected Nasdaq standard headers
        Mock::given(method("GET"))
            .and(path("/api/quote/AAPL/info"))
            .and(header("origin", "https://www.nasdaq.com"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&expected_body))
            .mount(&server)
            .await;

        let url = format!("{}/api/quote/AAPL/info", server.uri());
        let res = nasdaq_end_point::<MockResponse>(&url, None).await;

        match res {
            ApiResponse::Success { value } => {
                assert!(value.ok);
                assert_eq!(value.status, 200);
                assert_eq!(value.body, expected_body);
            }
            _ => panic!("Expected Success, got {:?}", res),
        }
    }

    #[tokio::test]
    async fn test_nasdaq_end_point_rcode_error() {
        let server = MockServer::start().await;

        // HTTP 200 OK, but application logic failed (rCode != 200)
        let error_body = serde_json::json!({
            "data": null,
            "status": {
                "rCode": 400,
                "bCodeMessage": [{ "code": 1001, "errorMessage": "Invalid symbol" }],
                "developerMessage": null
            }
        });

        Mock::given(method("GET"))
            .and(path("/api/error"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&error_body))
            .mount(&server)
            .await;

        let url = format!("{}/api/error", server.uri());
        // Request raw Value to ensure generic parsing catches the deep error
        let res = nasdaq_end_point::<serde_json::Value>(&url, None).await;

        match res {
            ApiResponse::Error { reason } => {
                assert_eq!(reason["rCode"], 400);
                assert_eq!(reason["error"], "Nasdaq API returned non-200 rCode");
                assert!(reason["bCodeMessage"].is_array()); // Verifies deep detail extraction
            }
            _ => panic!("Expected Application Error for rCode != 200"),
        }
    }

    #[tokio::test]
    async fn test_nasdaq_end_point_charting_success() {
        let server = MockServer::start().await;

        // Charting data often omits the `status.rCode` wrapper entirely
        let expected_body = MockResponse {
            symbol: "CHART".to_string(),
            price: 0.0,
            status: None,
        };

        Mock::given(method("GET"))
            .and(path("/charting/data"))
            .and(header(
                "referer",
                "https://charting.nasdaq.com/dynamic/chart.html",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(&expected_body))
            .mount(&server)
            .await;

        let url = format!("{}/charting/data", server.uri());
        let res = nasdaq_end_point::<MockResponse>(&url, None).await;

        match res {
            ApiResponse::Success { value } => {
                assert_eq!(value.status, 200);
                assert_eq!(value.body, expected_body); // Passes validation safely
            }
            _ => panic!("Expected Success, got {:?}", res),
        }
    }

    #[tokio::test]
    async fn test_nasdaq_end_point_header_override() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/override"))
            .and(header("user-agent", "Custom Agent")) // Checks for our override
            .respond_with(ResponseTemplate::new(200).set_body_json(MockResponse {
                symbol: "OVR".to_string(),
                price: 1.0,
                status: None,
            }))
            .mount(&server)
            .await;

        let url = format!("{}/override", server.uri());

        let mut custom_headers = HashMap::new();
        custom_headers.insert("User-Agent".to_string(), "Custom Agent".to_string());

        let options = RequestOptions {
            headers: Some(custom_headers),
            ..Default::default()
        };

        let res = nasdaq_end_point::<MockResponse>(&url, Some(options)).await;

        match res {
            ApiResponse::Success { value } => {
                assert_eq!(value.status, 200);
                assert_eq!(value.body.symbol, "OVR");
            }
            _ => panic!("Expected Success with overridden headers"),
        }
    }

    #[tokio::test]
    async fn test_nasdaq_end_points_parallel_dispatch() {
        let server = MockServer::start().await;

        let body_1 = MockResponse {
            symbol: "1".to_string(),
            price: 1.0,
            status: None,
        };
        let body_2 = MockResponse {
            symbol: "2".to_string(),
            price: 2.0,
            status: None,
        };

        Mock::given(method("GET"))
            .and(path("/1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body_1))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/2/charting"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body_2))
            .mount(&server)
            .await;

        let url1 = format!("{}/1", server.uri());
        let url2 = format!("{}/2/charting", server.uri());
        let urls = vec![url1.as_str(), url2.as_str()];

        let results = nasdaq_end_points::<MockResponse>(&urls, None).await;

        assert_eq!(results.len(), 2);
        match &results[0] {
            ApiResponse::Success { value } => assert_eq!(value.body, body_1),
            _ => panic!(),
        }
        match &results[1] {
            ApiResponse::Success { value } => assert_eq!(value.body, body_2),
            _ => panic!(),
        }
    }

    #[tokio::test]
    async fn test_nasdaq_end_point_transport_error() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/error"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let url = format!("{}/error", server.uri());
        let options = RequestOptions {
            retry_limit: Some(0),
            ..Default::default()
        };
        let res = nasdaq_end_point::<MockResponse>(&url, Some(options)).await;

        match res {
            ApiResponse::Error { reason } => assert_eq!(reason["status"], 500),
            _ => panic!("Expected Error for HTTP 500"),
        }
    }
}
