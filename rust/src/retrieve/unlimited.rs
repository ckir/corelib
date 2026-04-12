// =============================================
// FILE: rust/src/retrieve/unlimited.rs
// PURPOSE: High-resilience HTTP request utility.
// DESCRIPTION: This module provides high-level functions for making resilient 
// HTTP requests, mirroring the `RequestUnlimited.ts` logic. It supports automatic 
// retries, timeouts, and standardized response serialization.
// =============================================

use std::collections::HashMap;
use std::time::Duration;

use futures::future::join_all;
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::retrieve::ky;

/// Standardized structure for serialized HTTP responses.
/// 
/// Mirrors the `SerializedResponse<T>` interface from TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SerializedResponse<T> {
    /// True if the HTTP status code is 2xx.
    pub ok: bool,
    /// The numeric HTTP status code.
    pub status: u16,
    /// The status text or reason phrase returned by the server.
    pub status_text: String,
    /// A map of response headers.
    pub headers: HashMap<String, String>,
    /// The final URL reached after redirects.
    pub url: String,
    /// The successfully parsed response body of type `T`.
    pub body: T,
}

/// Discriminated union for API results, providing a consistent success/error structure.
/// 
/// It maps exactly to `{"status": "success", "value": ...}` or `{"status": "error", "reason": ...}` 
/// for seamless serialization between Rust and TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ApiResponse<T> {
    /// Represents a successful HTTP request with a 2xx status code and successfully parsed body.
    Success { 
        /// The serialized response wrapper containing the parsed body and metadata.
        value: SerializedResponse<T> 
    },
    /// Represents a failure, either at the network level, HTTP level (non-2xx), or parsing level.
    Error { 
        /// Detailed reason for the error, structured as a JSON value for cross-language compatibility.
        reason: Value 
    },
}

/// Request configuration options for high-resilience fetching.
/// 
/// Defines overrides for standard HTTP parameters and the underlying `ky` retry logic.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// The HTTP method to use (Defaults to GET).
    pub method: Option<Method>,
    /// A map of custom HTTP headers to include in the request.
    pub headers: Option<HashMap<String, String>>,
    /// A JSON value to be sent as the request body (for POST/PUT/PATCH).
    pub json: Option<Value>,
    /// An optional timeout duration for the entire request.
    pub timeout: Option<Duration>,
    /// The maximum number of retry attempts allowed for this request.
    pub retry_limit: Option<u32>,
}

/// Makes an HTTP request to a single URL with built-in resilience features.
///
/// This function uses the underlying `ky` implementation to automatically handle 
/// retries and timeouts based on the provided options or defaults.
/// 
/// # Arguments
/// * `url` - The target URL to fetch.
/// * `options` - Optional configuration overrides (method, headers, body, retries).
/// 
/// # Returns
/// An `ApiResponse<T>` containing either the `SerializedResponse` on success 
/// or a JSON-structured error reason on failure.
pub async fn end_point<T: DeserializeOwned>(
    url: &str,
    options: Option<RequestOptions>,
) -> ApiResponse<T> {
    // Extract options or use defaults
    let opts = options.unwrap_or_default();
    let method = opts.method.unwrap_or(Method::GET);

    // Initialize the appropriate ky builder based on the specified HTTP method
    let mut builder = match method {
        Method::POST => ky::post(url),
        Method::PUT => ky::put(url),
        Method::PATCH => ky::patch(url),
        Method::DELETE => ky::delete(url),
        _ => ky::get(url),
    };

    // Apply custom headers if provided
    if let Some(headers) = opts.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }

    // Attach the JSON payload if present
    if let Some(json_body) = opts.json {
        builder = builder.json(&json_body);
    }

    // Override the default timeout if specified
    if let Some(t) = opts.timeout {
        builder = builder.timeout(t);
    }

    // Override the default retry limit if specified
    if let Some(r) = opts.retry_limit {
        builder = builder.retry(r);
    }

    // Execute the request via the ky client
    let result = builder.send().await;

    match result {
        Ok(ky_res) => {
            // Successfully received a response (2xx). Extract properties before consuming the body.
            let inner_res = ky_res.into_inner();
            let status = inner_res.status();
            let ok = status.is_success();
            let status_code = status.as_u16();
            let status_text = status.canonical_reason().unwrap_or("").to_string();
            let res_url = inner_res.url().to_string();
            
            // Map headers into a standard HashMap
            let mut headers = HashMap::new();
            for (k, v) in inner_res.headers() {
                headers.insert(
                    k.as_str().to_string(),
                    v.to_str().unwrap_or("").to_string(),
                );
            }

            // Attempt to deserialize the response body as the requested type T
            match inner_res.json::<T>().await {
                Ok(body) => ApiResponse::Success {
                    value: SerializedResponse {
                        ok,
                        status: status_code,
                        status_text,
                        headers,
                        url: res_url,
                        body,
                    },
                },
                Err(e) => ApiResponse::Error {
                    // Body was not valid JSON or didn't match the expected schema
                    reason: serde_json::json!({
                        "message": "Failed to parse response body",
                        "error": e.to_string(),
                        "status": status_code,
                    }),
                },
            }
        }
        Err(e) => {
            // The request failed at the HTTP level (non-2xx) or transport level.
            // Map the ky::KyError into a consistent JSON reason.
            let reason = match e {
                ky::KyError::Http { status, url } => {
                    serde_json::json!({
                        "message": format!("HTTP Error {}", status),
                        "status": status.as_u16(),
                        "url": url,
                    })
                }
                ky::KyError::Request(req_err) => {
                    serde_json::json!({
                        "message": "Transport Error",
                        "error": req_err.to_string(),
                    })
                }
                ky::KyError::Serialization(ser_err) => {
                    serde_json::json!({
                        "message": "Serialization Error",
                        "error": ser_err.to_string(),
                    })
                }
            };
            
            ApiResponse::Error { reason }
        }
    }
}

/// Makes parallel HTTP requests to multiple URLs concurrently.
/// 
/// All requests are executed simultaneously using `futures::future::join_all`. 
/// The order of results in the returned vector matches the order of input URLs.
/// 
/// # Arguments
/// * `urls` - A slice of target URLs to fetch.
/// * `options` - Shared configuration overrides applied to every request in the batch.
/// 
/// # Returns
/// A vector of `ApiResponse<T>` objects.
pub async fn end_points<T: DeserializeOwned>(
    urls: &[&str],
    options: Option<RequestOptions>,
) -> Vec<ApiResponse<T>> {
    let opts = options.unwrap_or_default();
    
    // Create an iterator of futures, each calling end_point for a specific URL
    let futures = urls.iter().map(|&url| {
        // Clone the shared options for each individual task
        let cloned_opts = opts.clone();
        async move {
            end_point::<T>(url, Some(cloned_opts)).await
        }
    });

    // Execute all futures concurrently and await their completion
    join_all(futures).await
}

// =============================================
// EXHAUSTIVE TESTS
// =============================================

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Method;
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct TestBody {
        message: String,
        code: i32,
    }

    #[tokio::test]
    async fn test_end_point_success() {
        let server = MockServer::start().await;
        let expected_body = TestBody {
            message: "Hello World".to_string(),
            code: 200,
        };

        Mock::given(method("GET"))
            .and(path("/success"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&expected_body))
            .mount(&server)
            .await;

        let url = format!("{}/success", server.uri());
        let res = end_point::<TestBody>(&url, None).await;

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
    async fn test_end_point_http_error() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/not-found"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let url = format!("{}/not-found", server.uri());
        
        // Disable retries for fast failure
        let options = RequestOptions {
            retry_limit: Some(0),
            ..Default::default()
        };

        let res = end_point::<TestBody>(&url, Some(options)).await;

        match res {
            ApiResponse::Error { reason } => {
                assert_eq!(reason["status"], 404);
                assert_eq!(reason["message"], "HTTP Error 404 Not Found");
                assert_eq!(reason["url"], url);
            }
            _ => panic!("Expected Error, got {:?}", res),
        }
    }

    #[tokio::test]
    async fn test_end_point_post_with_body_and_headers() {
        let server = MockServer::start().await;
        let payload = json!({ "target": "execute" });
        let expected_response = TestBody {
            message: "Created".to_string(),
            code: 201,
        };

        Mock::given(method("POST"))
            .and(path("/create"))
            .and(header("x-custom-auth", "secret-token"))
            .and(body_json(&payload))
            .respond_with(ResponseTemplate::new(201).set_body_json(&expected_response))
            .mount(&server)
            .await;

        let url = format!("{}/create", server.uri());
        let mut headers = HashMap::new();
        headers.insert("x-custom-auth".to_string(), "secret-token".to_string());

        let options = RequestOptions {
            method: Some(Method::POST),
            headers: Some(headers),
            json: Some(payload),
            ..Default::default()
        };

        let res = end_point::<TestBody>(&url, Some(options)).await;

        match res {
            ApiResponse::Success { value } => {
                assert_eq!(value.status, 201);
                assert_eq!(value.body, expected_response);
            }
            _ => panic!("Expected Success, got {:?}", res),
        }
    }

    #[tokio::test]
    async fn test_end_points_parallel_execution() {
        let server = MockServer::start().await;
        
        let body_1 = TestBody { message: "First".to_string(), code: 1 };
        let body_2 = TestBody { message: "Second".to_string(), code: 2 };

        Mock::given(method("GET"))
            .and(path("/1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body_1))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body_2))
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/error"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let url1 = format!("{}/1", server.uri());
        let url2 = format!("{}/2", server.uri());
        let url3 = format!("{}/error", server.uri());

        let urls = vec![url1.as_str(), url2.as_str(), url3.as_str()];
        
        let options = RequestOptions {
            retry_limit: Some(0),
            ..Default::default()
        };

        let results = end_points::<TestBody>(&urls, Some(options)).await;

        assert_eq!(results.len(), 3);

        // Check first success
        match &results[0] {
            ApiResponse::Success { value } => assert_eq!(value.body, body_1),
            _ => panic!("Expected Success for url1"),
        }

        // Check second success
        match &results[1] {
            ApiResponse::Success { value } => assert_eq!(value.body, body_2),
            _ => panic!("Expected Success for url2"),
        }

        // Check error
        match &results[2] {
            ApiResponse::Error { reason } => assert_eq!(reason["status"], 500),
            _ => panic!("Expected Error for url3"),
        }
    }

    #[tokio::test]
    async fn test_end_point_malformed_json_fallback() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/bad-json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{ bad json ]"))
            .mount(&server)
            .await;

        let url = format!("{}/bad-json", server.uri());
        let res = end_point::<TestBody>(&url, None).await;

        match res {
            ApiResponse::Error { reason } => {
                assert_eq!(reason["status"], 200);
                assert_eq!(reason["message"], "Failed to parse response body");
            }
            _ => panic!("Expected parsing Error, got {:?}", res),
        }
    }
}
