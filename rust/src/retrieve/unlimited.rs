// =============================================
// FILE: rust/src/retrieve/unlimited.rs
// PURPOSE: High-resilience HTTP request utility.
// Mirrors ts-core/src/retrieve/RequestUnlimited.ts
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
    /// True if the HTTP status code is 2xx
    pub ok: bool,
    /// HTTP status code
    pub status: u16,
    /// HTTP status text/reason
    pub status_text: String,
    /// HTTP headers
    pub headers: HashMap<String, String>,
    /// The final URL after any redirects
    pub url: String,
    /// The parsed response body
    pub body: T,
}

/// Discriminated union for API results, mapping exactly to `{"status": "success", "value": ...}` 
/// or `{"status": "error", "reason": ...}` for Serde serialization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ApiResponse<T> {
    /// Represents a successful HTTP request with a 2xx status code and successfully parsed body.
    Success { 
        /// The serialized response wrapper containing the parsed body
        value: SerializedResponse<T> 
    },
    /// Represents a failure, either at the network level, HTTP level (non-2xx), or parsing level.
    Error { 
        /// Detailed reason for the error, structured as a JSON value
        reason: Value 
    },
}

/// Request options to configure individual requests.
/// 
/// Defines overrides for method, headers, payload, and ky resilience features.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// HTTP Method (Defaults to GET)
    pub method: Option<Method>,
    /// Custom HTTP headers
    pub headers: Option<HashMap<String, String>>,
    /// JSON payload for POST/PUT/PATCH requests
    pub json: Option<Value>,
    /// Request timeout
    pub timeout: Option<Duration>,
    /// Maximum number of retry attempts
    pub retry_limit: Option<u32>,
}

/// Makes an HTTP request to a single URL with resilience features.
///
/// Uses the underlying `ky` implementation to automatically handle retries and timeouts.
/// 
/// # Arguments
/// * `url` - The target URL to fetch.
/// * `options` - Optional configuration overrides (method, headers, body, retries).
/// 
/// # Returns
/// An `ApiResponse` containing either the `SerializedResponse` or an error reason.
pub async fn end_point<T: DeserializeOwned>(
    url: &str,
    options: Option<RequestOptions>,
) -> ApiResponse<T> {
    let opts = options.unwrap_or_default();
    let method = opts.method.unwrap_or(Method::GET);

    // Initialize the appropriate ky builder based on the method
    let mut builder = match method {
        Method::POST => ky::post(url),
        Method::PUT => ky::put(url),
        Method::PATCH => ky::patch(url),
        Method::DELETE => ky::delete(url),
        _ => ky::get(url),
    };

    // Apply headers
    if let Some(headers) = opts.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }

    // Apply JSON body
    if let Some(json_body) = opts.json {
        builder = builder.json(&json_body);
    }

    // Apply timeout override
    if let Some(t) = opts.timeout {
        builder = builder.timeout(t);
    }

    // Apply retry limit override
    if let Some(r) = opts.retry_limit {
        builder = builder.retry(r);
    }

    // Execute the request via ky
    let result = builder.send().await;

    match result {
        Ok(ky_res) => {
            // Extract properties before consuming the response body
            let inner_res = ky_res.into_inner();
            let status = inner_res.status();
            let ok = status.is_success();
            let status_code = status.as_u16();
            let status_text = status.canonical_reason().unwrap_or("").to_string();
            let res_url = inner_res.url().to_string();
            
            let mut headers = HashMap::new();
            for (k, v) in inner_res.headers() {
                headers.insert(
                    k.as_str().to_string(),
                    v.to_str().unwrap_or("").to_string(),
                );
            }

            // Attempt to parse the body as T
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
                    reason: serde_json::json!({
                        "message": "Failed to parse response body",
                        "error": e.to_string(),
                        "status": status_code,
                    }),
                },
            }
        }
        Err(e) => {
            // Handle request or HTTP level errors
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

/// Makes parallel HTTP requests to multiple URLs.
/// 
/// Executes all requests simultaneously using `futures::future::join_all`.
/// 
/// # Arguments
/// * `urls` - A slice of target URLs.
/// * `options` - Shared configuration overrides applied to all requests.
/// 
/// # Returns
/// A vector of `ApiResponse` objects corresponding to the input order.
pub async fn end_points<T: DeserializeOwned>(
    urls: &[&str],
    options: Option<RequestOptions>,
) -> Vec<ApiResponse<T>> {
    let opts = options.unwrap_or_default();
    
    // Map each URL to a future calling end_point
    let futures = urls.iter().map(|&url| {
        // Clone options for each future
        let cloned_opts = opts.clone();
        async move {
            end_point::<T>(url, Some(cloned_opts)).await
        }
    });

    // Execute all futures concurrently
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
