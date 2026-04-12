// =============================================
// FILE: rust/src/markets/nasdaq/api_nasdaq_unlimited.rs
// PURPOSE: High-resilience Nasdaq API wrapper.
// Injects necessary static headers (Standard or Charting) for Nasdaq endpoints.
// Validates Nasdaq's internal application `rCode`.
// Delegates underlying fetching and error handling to the `unlimited` retrieve module.
// =============================================

use crate::retrieve::unlimited::{end_point, ApiResponse, RequestOptions};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;

/// The Chrome version string used to spoof the user agent for Nasdaq requests.
const CHROME_VERSION: &str = "145";

/// Generates the static spoof headers required for Nasdaq API requests.
/// 
/// Determines whether to use "Standard" or "Charting" headers based on the URL.
/// 
/// # Arguments
/// * `url` - The target Nasdaq URL string.
/// 
/// # Returns
/// A `HashMap` containing the necessary HTTP headers.
pub fn get_nasdaq_headers(url: &str) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    let is_charting = url.contains("charting");

    // Pre-format the dynamic SEC and User-Agent strings
    let sec_ch_ua = format!(
        "\"Google Chrome\";v=\"{CHROME_VERSION}\", \"Not-A.Brand\";v=\"8\", \"Chromium\";v=\"{CHROME_VERSION}\""
    );
    let user_agent = format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36"
    );

    if is_charting {
        // Charting-specific headers
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
        // Standard endpoint headers
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

/// Makes a single resilient request to a Nasdaq API endpoint.
/// 
/// Injects the requisite Nasdaq headers dynamically based on the target URL.
/// Validates that the application-level `rCode` is 200 (if present in the response payload).
/// User-provided headers in `RequestOptions` will override the generated defaults.
/// 
/// # Arguments
/// * `url` - The target URL to fetch.
/// * `options` - Optional configuration overrides (retries, timeouts, custom headers).
/// 
/// # Returns
/// An `ApiResponse<T>` containing either the generic parsed response body or an error.
pub async fn nasdaq_end_point<T: DeserializeOwned + Serialize>(
    url: &str,
    options: Option<RequestOptions>,
) -> ApiResponse<T> {
    let mut opts = options.unwrap_or_default();
    let mut headers = get_nasdaq_headers(url);

    // Apply any explicit header overrides provided by the caller
    if let Some(user_headers) = opts.headers {
        for (k, v) in user_headers {
            // Enforce lowercase keys to match behavior in `retrieve/unlimited.rs` and TS
            headers.insert(k.to_lowercase(), v);
        }
    }

    opts.headers = Some(headers);

    // Delegate execution to the core retrieve module
    let response = end_point::<T>(url, Some(opts)).await;

    // Validate the Nasdaq-specific application-level rCode if present
    match response {
        ApiResponse::Success { value } => {
            // Serialize body temporarily to inspect the generic structure safely
            if let Ok(body_val) = serde_json::to_value(&value.body) {
                let r_code = body_val.pointer("/status/rCode").and_then(|v| v.as_i64());

                if let Some(code) = r_code {
                    if code != 200 {
                        // Transform HTTP 200 success into an application Error state
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
            
            // If rCode is 200 or doesn't exist, return the intact successful response
            ApiResponse::Success { value }
        }
        ApiResponse::Error { reason } => ApiResponse::Error { reason },
    }
}

/// Makes parallel resilient requests to multiple Nasdaq API endpoints.
/// 
/// Correctly determines the required headers independently for each URL 
/// before executing the requests concurrently, and checks internal rCodes.
/// 
/// # Arguments
/// * `urls` - A slice of target URLs.
/// * `options` - Shared configuration overrides applied to all requests.
/// 
/// # Returns
/// A vector of `ApiResponse<T>` objects corresponding to the input order.
pub async fn nasdaq_end_points<T: DeserializeOwned + Serialize>(
    urls: &[&str],
    options: Option<RequestOptions>,
) -> Vec<ApiResponse<T>> {
    let opts = options.unwrap_or_default();

    // Map each URL into an asynchronous task using the single endpoint executor
    let futures = urls.iter().map(|&url| {
        let cloned_opts = opts.clone();
        async move { nasdaq_end_point::<T>(url, Some(cloned_opts)).await }
    });

    // Execute all pending futures simultaneously
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
            .and(header("referer", "https://charting.nasdaq.com/dynamic/chart.html"))
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
        
        let body_1 = MockResponse { symbol: "1".to_string(), price: 1.0, status: None };
        let body_2 = MockResponse { symbol: "2".to_string(), price: 2.0, status: None };

        Mock::given(method("GET")).and(path("/1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body_1)).mount(&server).await;

        Mock::given(method("GET")).and(path("/2/charting"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body_2)).mount(&server).await;

        let url1 = format!("{}/1", server.uri());
        let url2 = format!("{}/2/charting", server.uri());
        let urls = vec![url1.as_str(), url2.as_str()];

        let results = nasdaq_end_points::<MockResponse>(&urls, None).await;

        assert_eq!(results.len(), 2);
        match &results[0] { ApiResponse::Success { value } => assert_eq!(value.body, body_1), _ => panic!() }
        match &results[1] { ApiResponse::Success { value } => assert_eq!(value.body, body_2), _ => panic!() }
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
        let options = RequestOptions { retry_limit: Some(0), ..Default::default() };
        let res = nasdaq_end_point::<MockResponse>(&url, Some(options)).await;

        match res {
            ApiResponse::Error { reason } => assert_eq!(reason["status"], 500),
            _ => panic!("Expected Error for HTTP 500"),
        }
    }
}
