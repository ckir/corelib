// =============================================
// FILE: rust/src/retrieve/unlimited.rs
// PURPOSE: High-resilience HTTP request utility.
// DESCRIPTION: This module provides high-level functions for making resilient
// HTTP requests, mirroring the `RequestUnlimited.ts` logic. It supports automatic
// retries, timeouts, and standardized response serialization.
// =============================================

use std::collections::HashMap;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::retrieve::ky;

/// Maximum number of requests `end_points` keeps in flight at once.
pub const END_POINTS_CONCURRENCY: usize = 16;

/// Maximum response body size read by `end_point` (10 MiB).
pub const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

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
        value: SerializedResponse<T>,
    },
    /// Represents a failure, either at the network level, HTTP level (non-2xx), or parsing level.
    Error {
        /// Detailed reason for the error, structured as a JSON value for cross-language compatibility.
        reason: Value,
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
    let allow_empty_body = matches!(method, Method::HEAD | Method::OPTIONS);
    let mut builder = match method {
        Method::GET => ky::get(url),
        Method::HEAD => ky::head(url),
        Method::OPTIONS => ky::options(url),
        Method::POST => ky::post(url),
        Method::PUT => ky::put(url),
        Method::PATCH => ky::patch(url),
        Method::DELETE => ky::delete(url),
        other => {
            return ApiResponse::Error {
                reason: serde_json::json!({
                    "message": "Unsupported HTTP method",
                    "method": other.as_str(),
                }),
            };
        }
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
            let mut inner_res = ky_res.into_inner();
            let status = inner_res.status();
            let ok = status.is_success();
            let status_code = status.as_u16();
            let status_text = status.canonical_reason().unwrap_or("").to_string();
            let res_url = inner_res.url().to_string();

            // Map headers into a standard HashMap
            let mut headers = HashMap::new();
            for (k, v) in inner_res.headers() {
                headers.insert(k.as_str().to_string(), v.to_str().unwrap_or("").to_string());
            }

            // Read the body with a hard size cap (declared length first, then while streaming).
            let too_large = |declared: Option<u64>| ApiResponse::Error {
                reason: serde_json::json!({
                    "message": "Response body too large",
                    "limit": MAX_BODY_BYTES,
                    "declared": declared,
                    "status": status_code,
                }),
            };
            if let Some(len) = inner_res.content_length() {
                if len > MAX_BODY_BYTES as u64 {
                    return too_large(Some(len));
                }
            }
            let mut bytes: Vec<u8> = Vec::new();
            loop {
                match inner_res.chunk().await {
                    Ok(Some(chunk)) => {
                        if bytes.len() + chunk.len() > MAX_BODY_BYTES {
                            return too_large(None);
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(e) => {
                        return ApiResponse::Error {
                            reason: serde_json::json!({
                                "message": "Failed to read response body",
                                "error": e.to_string(),
                                "status": status_code,
                            }),
                        };
                    }
                }
            }
            // HEAD/OPTIONS responses and 204/205 statuses have no body: deserialize `null` (works for `Value`/`Option<_>`).
            if (allow_empty_body || matches!(status_code, 204 | 205)) && bytes.is_empty() {
                bytes = b"null".to_vec();
            }

            // Attempt to deserialize the response body as the requested type T
            match serde_json::from_slice::<T>(&bytes) {
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
/// At most `END_POINTS_CONCURRENCY` (16) requests are in flight at once (`buffered`).
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
        async move { end_point::<T>(url, Some(cloned_opts)).await }
    });

    // Run with bounded concurrency; `buffered` yields results in input order.
    stream::iter(futures)
        .buffered(END_POINTS_CONCURRENCY)
        .collect()
        .await
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

        let body_1 = TestBody {
            message: "First".to_string(),
            code: 1,
        };
        let body_2 = TestBody {
            message: "Second".to_string(),
            code: 2,
        };

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

    #[tokio::test]
    async fn head_and_options_are_sent_as_such() {
        for (m, name) in [(Method::HEAD, "HEAD"), (Method::OPTIONS, "OPTIONS")] {
            let server = MockServer::start().await;
            Mock::given(method(name))
                .respond_with(ResponseTemplate::new(200))
                .mount(&server)
                .await;
            let opts = RequestOptions {
                method: Some(m),
                ..Default::default()
            };
            let res = end_point::<Value>(&server.uri(), Some(opts)).await;
            let reqs = server.received_requests().await.unwrap();
            assert_eq!(reqs.len(), 1);
            assert_eq!(reqs[0].method.as_str(), name);
            assert!(
                matches!(res, ApiResponse::Success { .. }),
                "{name}: {res:?}"
            );
        }
    }

    #[tokio::test]
    async fn unknown_method_is_an_error_and_sends_nothing() {
        let server = MockServer::start().await;
        let opts = RequestOptions {
            method: Some(Method::from_bytes(b"TRACE").unwrap()),
            ..Default::default()
        };
        let res = end_point::<Value>(&server.uri(), Some(opts)).await;
        match res {
            ApiResponse::Error { reason } => {
                assert_eq!(reason["message"], "Unsupported HTTP method");
                assert_eq!(reason["method"], "TRACE");
            }
            other => panic!("expected Error, got {other:?}"),
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn oversized_body_is_an_error() {
        let server = MockServer::start().await;
        let big = format!("\"{}\"", "a".repeat(MAX_BODY_BYTES + 1));
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_string(big),
            )
            .mount(&server)
            .await;
        match end_point::<Value>(&server.uri(), None).await {
            ApiResponse::Error { reason } => {
                assert_eq!(reason["message"], "Response body too large");
            }
            ApiResponse::Success { .. } => panic!("expected Error, got Success"),
        }
    }

    #[tokio::test]
    async fn body_at_the_limit_is_accepted() {
        let server = MockServer::start().await;
        // `"` + payload + `"` == MAX_BODY_BYTES exactly.
        let ok = format!("\"{}\"", "a".repeat(MAX_BODY_BYTES - 2));
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(ok))
            .mount(&server)
            .await;
        let res = end_point::<Value>(&server.uri(), None).await;
        assert!(matches!(res, ApiResponse::Success { .. }));
    }

    #[tokio::test]
    async fn end_points_bounds_concurrency_and_preserves_order() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cur = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let (c2, m2) = (cur.clone(), max.clone());
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let (c, m) = (c2.clone(), m2.clone());
                tokio::spawn(async move {
                    let n = c.fetch_add(1, Ordering::SeqCst) + 1;
                    m.fetch_max(n, Ordering::SeqCst);
                    let mut buf = [0u8; 2048];
                    let k = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..k]).to_string();
                    let id: u32 = req
                        .split("/r")
                        .nth(1)
                        .and_then(|r| r.split(' ').next())
                        .and_then(|r| r.parse().ok())
                        .unwrap_or(9999);
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    let body = id.to_string();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    c.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        let urls: Vec<String> = (0..40).map(|i| format!("http://{addr}/r{i}")).collect();
        let refs: Vec<&str> = urls.iter().map(|s| s.as_str()).collect();
        let out = end_points::<u32>(&refs, None).await;
        assert_eq!(out.len(), 40);
        for (i, r) in out.iter().enumerate() {
            match r {
                ApiResponse::Success { value } => assert_eq!(value.body, i as u32),
                other => panic!("{i}: {other:?}"),
            }
        }
        let peak = max.load(Ordering::SeqCst);
        assert!(peak <= END_POINTS_CONCURRENCY, "peak {peak}");
        assert!(peak >= 2, "expected real concurrency, peak {peak}");
    }

    #[tokio::test]
    async fn empty_204_response_to_delete_is_success() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/item"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let opts = RequestOptions {
            method: Some(Method::DELETE),
            retry_limit: Some(0),
            ..Default::default()
        };
        let res =
            end_point::<serde_json::Value>(&format!("{}/item", server.uri()), Some(opts)).await;
        match res {
            ApiResponse::Success { value } => {
                assert_eq!(value.status, 204);
                assert!(value.body.is_null());
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn empty_200_response_to_get_is_still_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let opts = RequestOptions {
            retry_limit: Some(0),
            ..Default::default()
        };
        let res = end_point::<serde_json::Value>(&server.uri(), Some(opts)).await;
        assert!(matches!(res, ApiResponse::Error { .. }), "{res:?}");
    }
}
