// =============================================
// FILE: rust/src/retrieve/proxied.rs
// PURPOSE: High-resilience proxied HTTP client mirroring RequestProxied.ts.
// DESCRIPTION: This module provides a load-balanced HTTP client that rotates
// through a list of proxy servers. It handles automatic fallback to alternative
// proxies upon failure and permanently removes consistently failing proxies.
// =============================================

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use reqwest::Url;
use serde::de::DeserializeOwned;

use crate::retrieve::unlimited::{self, ApiResponse, RequestOptions};

/// Internal state for the proxied client, managing active proxies and rotation.
///
/// Wrapped in a Mutex to allow safe concurrent mutation of rotation indices
/// and failure tracking across multiple Tokio tasks.
#[derive(Debug)]
struct ProxyState {
    /// List of currently active proxy base URLs.
    active_proxies: Vec<String>,
    /// Tracks the number of consecutive failures for each proxy URL.
    failure_streaks: HashMap<String, u32>,
    /// The current index used for round-robin proxy rotation.
    current_index: usize,
}

/// A proxied HTTP client with automatic rotation, fallback, and load-balancing.
///
/// It mirrors the exact public API and resilience logic of the TypeScript `RequestProxied` class.
/// It delegates the actual network fetching, retries, and response serialization
/// to the `unlimited` retrieve module.
#[derive(Debug, Clone)]
pub struct RequestProxied {
    /// Shared thread-safe state of the proxy list and rotation logic.
    state: Arc<Mutex<ProxyState>>,
}

impl RequestProxied {
    /// Creates a new `RequestProxied` instance.
    ///
    /// # Arguments
    /// * `proxies` - A vector of proxy base URLs (e.g., `["https://proxy1.com", "https://proxy2.com"]`).
    ///
    /// # Errors
    /// Returns `Err` if the provided `proxies` vector is empty.
    pub fn new(proxies: Vec<String>) -> Result<Self, String> {
        // Enforce that at least one proxy is provided
        if proxies.is_empty() {
            return Err("RequestProxied: at least one proxy URL is required".to_string());
        }

        Ok(Self {
            state: Arc::new(Mutex::new(ProxyState {
                active_proxies: proxies,
                failure_streaks: HashMap::new(),
                current_index: 0,
            })),
        })
    }

    /// Error response for an unusable (user-supplied) proxy base URL or suffix.
    fn invalid_proxy_response<T>(reason: &str) -> ApiResponse<T> {
        ApiResponse::Error {
            reason: serde_json::json!({ "message": format!("Invalid proxy URL: {reason}") }),
        }
    }

    /// Pick the next proxy from the shared round-robin rotation (None when none are left).
    fn next_proxy(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        if state.active_proxies.is_empty() {
            return None;
        }
        let idx = state.current_index % state.active_proxies.len();
        let proxy_base = state.active_proxies[idx].clone();
        state.current_index = (state.current_index + 1) % state.active_proxies.len();
        Some(proxy_base)
    }

    /// Builds the final proxy URL by appending the target URL as a query parameter.
    ///
    /// This function uses `reqwest::Url` to guarantee correct query string encoding
    /// and handling of the original target URL.
    ///
    /// # Arguments
    /// * `proxy_base` - The base URL of the proxy server.
    /// * `suffix` - An optional path segment to append to the proxy base.
    /// * `target_url` - The original URL that should be fetched via the proxy.
    ///
    /// # Errors
    /// Returns `Err` (never panics) when the proxy base or suffix is not a valid URL part.
    fn build_proxy_url(proxy_base: &str, suffix: &str, target_url: &str) -> Result<String, String> {
        // Ensure the base URL ends with a slash so the suffix is joined correctly
        let base_with_slash = if proxy_base.ends_with('/') {
            proxy_base.to_string()
        } else {
            format!("{}/", proxy_base)
        };

        // Parse the base URL into a Url object
        let mut url_obj =
            Url::parse(&base_with_slash).map_err(|e| format!("bad proxy base: {e}"))?;

        // Join the suffix if it's not empty
        if !suffix.is_empty() {
            url_obj = url_obj
                .join(suffix)
                .map_err(|e| format!("bad proxy suffix: {e}"))?;
        }

        // Append the encoded target URL as the 'url' query parameter
        url_obj.query_pairs_mut().append_pair("url", target_url);
        // Return the final serialized URL string
        Ok(url_obj.to_string())
    }

    /// Records a successful request for a proxy, resetting its failure streak.
    ///
    /// # Arguments
    /// * `proxy_base` - The base URL of the proxy that succeeded.
    fn track_success(&self, proxy_base: &str) {
        let mut state = self.state.lock().unwrap();
        // Reset the streak to 0 upon success
        state.failure_streaks.insert(proxy_base.to_string(), 0);
    }

    /// Records a failure for a proxy and removes it if it fails too many times consecutively.
    ///
    /// After 3 consecutive failures, the proxy is permanently removed from the active list
    /// for this specific instance of `RequestProxied`.
    ///
    /// # Arguments
    /// * `proxy_base` - The base URL of the proxy that failed.
    fn track_failure(&self, proxy_base: &str) {
        let mut state = self.state.lock().unwrap();

        // Increment the failure streak for this proxy
        let streak = state
            .failure_streaks
            .entry(proxy_base.to_string())
            .or_insert(0);
        *streak += 1;

        // Check if the threshold for removal has been reached
        if *streak >= 3 {
            // Remove the proxy from the active list
            state.active_proxies.retain(|p| p != proxy_base);
            // Clear the failure streak data for the removed proxy
            state.failure_streaks.remove(proxy_base);

            // Adjust the current index to prevent out-of-bounds access
            if state.active_proxies.is_empty() || state.current_index >= state.active_proxies.len()
            {
                state.current_index = 0;
            }
        }
    }

    /// Makes a single proxied HTTP request with automatic rotation and fallback.
    ///
    /// If the first proxy fails, it will automatically attempt the request using the
    /// next available proxy until all proxies in the active list have been exhausted.
    ///
    /// # Arguments
    /// * `url` - The original target URL.
    /// * `suffix` - An optional path to append to the proxy base (e.g., `/api/v1`).
    /// * `options` - Standard request options passed through to the underlying fetcher.
    ///
    /// # Returns
    /// An `ApiResponse<T>` from the first successful proxy or an error if all failed.
    pub async fn end_point<T: DeserializeOwned>(
        &self,
        url: &str,
        suffix: &str,
        options: Option<RequestOptions>,
    ) -> ApiResponse<T> {
        let max_attempts;
        {
            let state = self.state.lock().unwrap();
            // Return immediately if no proxies are left
            if state.active_proxies.is_empty() {
                return ApiResponse::Error {
                    reason: serde_json::json!({ "message": "No active proxies left" }),
                };
            }
            // We will attempt at most once per active proxy
            max_attempts = state.active_proxies.len();
        }

        let mut attempts = 0;

        while attempts < max_attempts {
            let Some(proxy_base) = self.next_proxy() else {
                break;
            };

            // Construct the proxied URL; a malformed proxy counts as a failure of that proxy
            let proxy_url = match Self::build_proxy_url(&proxy_base, suffix, url) {
                Ok(u) => u,
                Err(_) => {
                    self.track_failure(&proxy_base);
                    attempts += 1;
                    continue; // surfaced via the final "All proxies failed" response
                }
            };
            // Execute the request via the unlimited module
            let result = unlimited::end_point::<T>(&proxy_url, options.clone()).await;

            match result {
                ApiResponse::Success { .. } => {
                    // Request succeeded, track it and return the result
                    self.track_success(&proxy_base);
                    return result;
                }
                ApiResponse::Error { .. } => {
                    // Request failed via this proxy, track the failure and try the next one
                    self.track_failure(&proxy_base);
                    attempts += 1;
                }
            }
        }

        // Exhausted all proxies without success
        ApiResponse::Error {
            reason: serde_json::json!({ "message": "All proxies failed" }),
        }
    }

    /// Makes multiple parallel proxied requests with round-robin load balancing.
    ///
    /// Assigns each target URL to a proxy from the active list in a round-robin fashion
    /// before executing all requests concurrently.
    ///
    /// # Arguments
    /// * `urls` - A slice of target URLs.
    /// * `suffix` - An optional suffix applied to every proxy URL in this batch.
    /// * `options` - Shared request options applied to every individual request.
    ///
    /// # Returns
    /// A vector of `ApiResponse<T>` objects corresponding to the input URLs.
    pub async fn end_points<T: DeserializeOwned>(
        &self,
        urls: &[&str],
        suffix: &str,
        options: Option<RequestOptions>,
    ) -> Vec<ApiResponse<T>> {
        let active_proxies;
        {
            let state = self.state.lock().unwrap();
            active_proxies = state.active_proxies.clone();
        }

        // Return errors for all URLs if no proxies are available or no URLs provided
        if active_proxies.is_empty() || urls.is_empty() {
            return urls
                .iter()
                .map(|_| ApiResponse::Error {
                    reason: serde_json::json!({ "message": "No active proxies left" }),
                })
                .collect();
        }

        // Assign each URL a proxy from the shared rotation, then run them with bounded concurrency.
        // Each outcome is recorded against the proxy that served it (same success/failure
        // classification as `end_point`), so failing proxies are ejected by batch use too.
        let jobs: Vec<(Option<String>, Result<String, String>)> = urls
            .iter()
            .map(|target| match self.next_proxy() {
                Some(proxy_base) => {
                    let built = Self::build_proxy_url(&proxy_base, suffix, target);
                    (Some(proxy_base), built)
                }
                None => (None, Err("no active proxies".to_string())),
            })
            .collect();

        let futures = jobs.into_iter().map(|(proxy_base, built)| {
            let opts = options.clone();
            async move {
                match built {
                    Ok(proxy_url) => (
                        proxy_base,
                        unlimited::end_point::<T>(&proxy_url, opts).await,
                    ),
                    Err(reason) => (proxy_base, Self::invalid_proxy_response::<T>(&reason)),
                }
            }
        });

        // Same bound as `unlimited::end_points`; `buffered` yields results in input order.
        futures_util::stream::iter(futures)
            .buffered(unlimited::END_POINTS_CONCURRENCY)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|(proxy_base, result)| {
                if let Some(proxy_base) = proxy_base {
                    match result {
                        ApiResponse::Success { .. } => self.track_success(&proxy_base),
                        ApiResponse::Error { .. } => self.track_failure(&proxy_base),
                    }
                }
                result
            })
            .collect()
    }
}

// =============================================
// EXHAUSTIVE TESTS
// =============================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct TestBody {
        message: String,
    }

    /// Helper to grab a fast fail options block
    fn fast_fail_options() -> RequestOptions {
        RequestOptions {
            retry_limit: Some(0),
            timeout: Some(std::time::Duration::from_millis(500)),
            ..Default::default()
        }
    }

    #[test]
    fn test_constructor_errs_on_empty() {
        let err = RequestProxied::new(vec![]).unwrap_err();
        assert!(err.contains("at least one proxy URL is required"));
    }

    #[tokio::test]
    async fn test_invalid_proxy_url_does_not_panic() {
        let proxied = RequestProxied::new(vec!["not a url".to_string()]).unwrap();
        match proxied
            .end_point::<TestBody>("https://t.com", "", None)
            .await
        {
            ApiResponse::Error { reason } => assert_eq!(reason["message"], "All proxies failed"),
            _ => panic!("expected error response"),
        }
        let results = proxied
            .end_points::<TestBody>(&["https://t.com"], "", None)
            .await;
        match &results[0] {
            ApiResponse::Error { reason } => assert!(reason["message"]
                .as_str()
                .unwrap()
                .starts_with("Invalid proxy URL")),
            _ => panic!("expected error response"),
        }
        assert!(RequestProxied::build_proxy_url("not a url", "", "https://t.com").is_err());
    }

    #[tokio::test]
    async fn test_end_points_ejects_always_failing_proxy() {
        let server_fail = MockServer::start().await;
        let server_ok = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server_fail)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody {
                message: "ok".to_string(),
            }))
            .mount(&server_ok)
            .await;

        let proxied = RequestProxied::new(vec![server_fail.uri(), server_ok.uri()]).unwrap();
        // 6 urls round-robin => 3 requests hit the failing proxy => removed after the batch.
        let urls = [
            "https://a",
            "https://b",
            "https://c",
            "https://d",
            "https://e",
            "https://f",
        ];
        let results = proxied
            .end_points::<TestBody>(&urls, "", Some(fast_fail_options()))
            .await;
        assert_eq!(results.len(), 6);
        let state = proxied.state.lock().unwrap();
        assert_eq!(state.active_proxies, vec![server_ok.uri()]);
    }

    #[test]
    fn test_build_proxy_url() {
        let url = RequestProxied::build_proxy_url(
            "https://proxy.example.com",
            "/api/markets/nasdaq",
            "https://api.nasdaq.com/api/market-info?symbol=AAPL",
        )
        .unwrap();

        assert_eq!(
            url,
            "https://proxy.example.com/api/markets/nasdaq?url=https%3A%2F%2Fapi.nasdaq.com%2Fapi%2Fmarket-info%3Fsymbol%3DAAPL"
        );
    }

    #[tokio::test]
    async fn test_end_point_rotates_on_every_attempt() {
        let server1 = MockServer::start().await;
        let server2 = MockServer::start().await;
        let server3 = MockServer::start().await;

        let body = TestBody {
            message: "ok".to_string(),
        };

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server1)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server2)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server3)
            .await;

        let proxied =
            RequestProxied::new(vec![server1.uri(), server2.uri(), server3.uri()]).unwrap();

        let target = "https://target.com";

        // Call 1 -> hits server1
        let _ = proxied.end_point::<TestBody>(target, "", None).await;
        // Call 2 -> hits server2
        let _ = proxied.end_point::<TestBody>(target, "", None).await;
        // Call 3 -> hits server3
        let _ = proxied.end_point::<TestBody>(target, "", None).await;

        let reqs1 = server1.received_requests().await.unwrap();
        let reqs2 = server2.received_requests().await.unwrap();
        let reqs3 = server3.received_requests().await.unwrap();

        assert_eq!(reqs1.len(), 1);
        assert_eq!(reqs2.len(), 1);
        assert_eq!(reqs3.len(), 1);
    }

    #[tokio::test]
    async fn test_end_point_falls_back_on_failure() {
        let server_fail1 = MockServer::start().await;
        let server_fail2 = MockServer::start().await;
        let server_success = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server_fail1)
            .await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server_fail2)
            .await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody {
                message: "ok".to_string(),
            }))
            .mount(&server_success)
            .await;

        let proxied = RequestProxied::new(vec![
            server_fail1.uri(),
            server_fail2.uri(),
            server_success.uri(),
        ])
        .unwrap();

        let result = proxied
            .end_point::<TestBody>("https://target.com", "", Some(fast_fail_options()))
            .await;

        match result {
            ApiResponse::Success { value } => assert_eq!(value.body.message, "ok"),
            _ => panic!("Expected successful fallback to the 3rd proxy"),
        }

        assert!(!server_fail1.received_requests().await.unwrap().is_empty());
        assert!(!server_fail2.received_requests().await.unwrap().is_empty());
        assert_eq!(server_success.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_end_point_removes_proxy_after_3_consecutive_failures() {
        let server_fail = MockServer::start().await;
        let server_success = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server_fail)
            .await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody {
                message: "ok".to_string(),
            }))
            .mount(&server_success)
            .await;

        let proxied = RequestProxied::new(vec![server_fail.uri(), server_success.uri()]).unwrap();

        // Attempt enough times to guarantee 3 failures on server_fail
        for _ in 0..5 {
            let _ = proxied
                .end_point::<TestBody>("https://target.com", "", Some(fast_fail_options()))
                .await;
        }

        let state = proxied.state.lock().unwrap();
        // Server_fail should be permanently removed
        assert_eq!(state.active_proxies.len(), 1);
        assert_eq!(state.active_proxies[0], server_success.uri());
    }

    #[tokio::test]
    async fn test_end_point_returns_error_when_all_proxies_fail() {
        let server1 = MockServer::start().await;
        let server2 = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server1)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server2)
            .await;

        let proxied = RequestProxied::new(vec![server1.uri(), server2.uri()]).unwrap();

        let result = proxied
            .end_point::<TestBody>("https://t.com", "", Some(fast_fail_options()))
            .await;

        match result {
            ApiResponse::Error { reason } => assert_eq!(reason["message"], "All proxies failed"),
            _ => panic!("Expected an error response indicating all proxies failed"),
        }
    }

    #[tokio::test]
    async fn test_end_points_distributes_round_robin() {
        let server1 = MockServer::start().await;
        let server2 = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody {
                message: "ok".to_string(),
            }))
            .mount(&server1)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody {
                message: "ok".to_string(),
            }))
            .mount(&server2)
            .await;

        let proxied = RequestProxied::new(vec![server1.uri(), server2.uri()]).unwrap();

        let urls = vec!["https://t1.com", "https://t2.com", "https://t3.com"];

        let results = proxied.end_points::<TestBody>(&urls, "", None).await;
        assert_eq!(results.len(), 3);

        let reqs1 = server1.received_requests().await.unwrap();
        let reqs2 = server2.received_requests().await.unwrap();

        // 3 total urls across 2 proxies -> server1 gets 2 requests, server2 gets 1
        assert_eq!(reqs1.len(), 2);
        assert_eq!(reqs2.len(), 1);

        // Verify correct ?url payload mapped
        let mut urls1: Vec<String> = reqs1
            .iter()
            .map(|r| {
                r.url
                    .query_pairs()
                    .find(|(k, _)| k == "url")
                    .unwrap()
                    .1
                    .to_string()
            })
            .collect();
        urls1.sort();

        assert_eq!(urls1[0], "https://t1.com");
        assert_eq!(urls1[1], "https://t3.com");

        assert_eq!(
            reqs2[0]
                .url
                .query_pairs()
                .find(|(k, _)| k == "url")
                .unwrap()
                .1,
            "https://t2.com"
        );
    }

    #[tokio::test]
    async fn test_edge_case_no_active_proxies_left() {
        let proxied = RequestProxied::new(vec!["http://dummy".to_string()]).unwrap();

        // Manually empty active proxies
        {
            let mut state = proxied.state.lock().unwrap();
            state.active_proxies.clear();
        }

        let result = proxied
            .end_point::<TestBody>("https://target.com", "", None)
            .await;

        match result {
            ApiResponse::Error { reason } => {
                assert_eq!(reason["message"], "No active proxies left")
            }
            _ => panic!("Expected immediate fail if no proxies exist"),
        }
    }

    #[tokio::test]
    async fn end_points_bounds_concurrency_through_the_proxy() {
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
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let resp = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 1\r\nconnection: close\r\n\r\n1";
                    let _ = sock.write_all(resp.as_bytes()).await;
                    c.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        let proxied = RequestProxied::new(vec![format!("http://{addr}")]).unwrap();
        let urls: Vec<String> = (0..40).map(|i| format!("https://t{i}.com")).collect();
        let refs: Vec<&str> = urls.iter().map(|s| s.as_str()).collect();
        let out = proxied.end_points::<u32>(&refs, "", None).await;
        assert_eq!(out.len(), 40);
        assert!(out.iter().all(|r| matches!(r, ApiResponse::Success { .. })));
        let peak = max.load(Ordering::SeqCst);
        assert!(peak <= unlimited::END_POINTS_CONCURRENCY, "peak {peak}");
        assert!(peak >= 2, "expected real concurrency, peak {peak}");
    }
}
