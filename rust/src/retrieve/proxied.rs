// =============================================
// FILE: rust/src/retrieve/proxied.rs
// PURPOSE: High-resilience proxied HTTP client mirroring RequestProxied.ts.
// =============================================

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use reqwest::Url;
use serde::de::DeserializeOwned;

use crate::retrieve::unlimited::{self, ApiResponse, RequestOptions};

/// Internal state for the proxied client.
/// 
/// Wrapped in a Mutex to allow safe mutation of rotation indices 
/// and failure tracking across concurrent Tokio tasks.
#[derive(Debug)]
struct ProxyState {
    /// List of currently active proxy base URLs
    active_proxies: Vec<String>,
    /// Tracks consecutive failures for each proxy
    failure_streaks: HashMap<String, u32>,
    /// The current index for round-robin rotation
    current_index: usize,
}

/// Proxied HTTP client with automatic rotation, fallback, and load-balancing.
/// 
/// Mirrors the exact public API and resilience logic of `RequestProxied.ts`.
/// Delegates actual fetching, retries, and serialization to `RequestUnlimited`.
#[derive(Debug, Clone)]
pub struct RequestProxied {
    state: Arc<Mutex<ProxyState>>,
}

impl RequestProxied {
    /// Creates a new RequestProxied instance.
    /// 
    /// # Arguments
    /// * `proxies` - Array of proxy base URLs (e.g. `["https://proxy1...", "https://proxy2..."]`).
    /// 
    /// # Panics
    /// Panics if the provided `proxies` vector is empty.
    pub fn new(proxies: Vec<String>) -> Self {
        if proxies.is_empty() {
            panic!("RequestProxied: at least one proxy URL is required");
        }

        Self {
            state: Arc::new(Mutex::new(ProxyState {
                active_proxies: proxies,
                failure_streaks: HashMap::new(),
                current_index: 0,
            })),
        }
    }

    /// Builds the final proxy URL using the reqwest::Url constructor.
    /// Guarantees correct query string handling and URL encoding of the original target.
    fn build_proxy_url(proxy_base: &str, suffix: &str, target_url: &str) -> String {
        // Ensure base ends with / so suffix path is appended correctly
        let base_with_slash = if proxy_base.ends_with('/') {
            proxy_base.to_string()
        } else {
            format!("{}/", proxy_base)
        };

        // Parse base URL
        let mut url_obj = Url::parse(&base_with_slash).expect("Invalid proxy base URL");

        // Apply suffix if provided
        if !suffix.is_empty() {
            url_obj = url_obj.join(suffix).expect("Invalid proxy suffix");
        }

        // Append the encoded target URL
        url_obj.query_pairs_mut().append_pair("url", target_url);
        url_obj.to_string()
    }

    /// Records a successful request for a proxy (resets failure streak).
    fn track_success(&self, proxy_base: &str) {
        let mut state = self.state.lock().unwrap();
        state.failure_streaks.insert(proxy_base.to_string(), 0);
    }

    /// Records a failure for a proxy.
    /// After 3 consecutive failures, the proxy is permanently removed from the active list.
    fn track_failure(&self, proxy_base: &str) {
        let mut state = self.state.lock().unwrap();
        
        let streak = state.failure_streaks.entry(proxy_base.to_string()).or_insert(0);
        *streak += 1;

        if *streak >= 3 {
            // Remove permanently for this instance
            state.active_proxies.retain(|p| p != proxy_base);
            state.failure_streaks.remove(proxy_base);

            // Prevent index out of bounds
            if state.active_proxies.is_empty() {
                state.current_index = 0;
            } else if state.current_index >= state.active_proxies.len() {
                state.current_index = 0;
            }

            eprintln!("[RequestProxied] Proxy removed (3 consecutive failures): {}", proxy_base);
        }
    }

    /// Makes a single proxied HTTP request with full fallback.
    /// 
    /// Automatically rotates proxies on every attempt and falls back to the next proxy
    /// if the current one fails, until all active proxies have been exhausted.
    /// 
    /// # Arguments
    /// * `url` - Original target URL.
    /// * `suffix` - Optional path to append to the proxy base (default empty).
    /// * `options` - Options passed through to RequestUnlimited.
    pub async fn end_point<T: DeserializeOwned>(
        &self,
        url: &str,
        suffix: &str,
        options: Option<RequestOptions>,
    ) -> ApiResponse<T> {
        let max_attempts;
        {
            let state = self.state.lock().unwrap();
            if state.active_proxies.is_empty() {
                eprintln!("[RequestProxied] No active proxies left");
                return ApiResponse::Error {
                    reason: serde_json::json!({ "message": "No active proxies left" }),
                };
            }
            max_attempts = state.active_proxies.len();
        }

        let mut attempts = 0;

        while attempts < max_attempts {
            let proxy_base;
            {
                let mut state = self.state.lock().unwrap();
                if state.active_proxies.is_empty() {
                    break;
                }
                
                // Select proxy via round-robin
                let idx = state.current_index % state.active_proxies.len();
                proxy_base = state.active_proxies[idx].clone();
                
                // Advance rotation on EVERY attempt
                state.current_index = (state.current_index + 1) % state.active_proxies.len();
            }

            let proxy_url = Self::build_proxy_url(&proxy_base, suffix, url);
            let result = unlimited::end_point::<T>(&proxy_url, options.clone()).await;

            match result {
                ApiResponse::Success { .. } => {
                    self.track_success(&proxy_base);
                    return result;
                }
                ApiResponse::Error { .. } => {
                    // Track failure and attempt next proxy
                    self.track_failure(&proxy_base);
                    attempts += 1;
                }
            }
        }

        // All proxies failed
        eprintln!("[RequestProxied] All proxies failed for url: {}", url);
        ApiResponse::Error {
            reason: serde_json::json!({ "message": "All proxies failed" }),
        }
    }

    /// Makes parallel proxied requests with explicit round-robin load balancing.
    /// 
    /// Each original URL is assigned to a proxy via round-robin.
    /// The constructed proxy URLs are then passed to RequestUnlimited::end_points.
    /// 
    /// # Arguments
    /// * `urls` - Slice of original target URLs.
    /// * `suffix` - Optional suffix applied to every proxy (default empty).
    /// * `options` - Options applied to all requests.
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

        if active_proxies.is_empty() || urls.is_empty() {
            return urls
                .iter()
                .map(|_| ApiResponse::Error {
                    reason: serde_json::json!({ "message": "No active proxies left" }),
                })
                .collect();
        }

        // Explicit round-robin distribution
        let proxy_urls: Vec<String> = urls
            .iter()
            .enumerate()
            .map(|(i, target)| {
                let proxy_base = &active_proxies[i % active_proxies.len()];
                Self::build_proxy_url(proxy_base, suffix, target)
            })
            .collect();

        // Convert to slice of string slices for unlimited::end_points
        let proxy_urls_refs: Vec<&str> = proxy_urls.iter().map(|s| s.as_str()).collect();

        // Delegate parallelism and retries to RequestUnlimited
        unlimited::end_points::<T>(&proxy_urls_refs, options).await
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
    #[should_panic(expected = "at least one proxy URL is required")]
    fn test_constructor_throws_on_empty() {
        RequestProxied::new(vec![]);
    }

    #[test]
    fn test_build_proxy_url() {
        let url = RequestProxied::build_proxy_url(
            "https://proxy.example.com",
            "/api/markets/nasdaq",
            "https://api.nasdaq.com/api/market-info?symbol=AAPL",
        );

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

        let body = TestBody { message: "ok".to_string() };

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server1).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server2).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&body))
            .mount(&server3).await;

        let proxied = RequestProxied::new(vec![
            server1.uri(),
            server2.uri(),
            server3.uri(),
        ]);

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
            .mount(&server_fail1).await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server_fail2).await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody { message: "ok".to_string() }))
            .mount(&server_success).await;

        let proxied = RequestProxied::new(vec![
            server_fail1.uri(),
            server_fail2.uri(),
            server_success.uri(),
        ]);

        let result = proxied.end_point::<TestBody>("https://target.com", "", Some(fast_fail_options())).await;

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
            .mount(&server_fail).await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody { message: "ok".to_string() }))
            .mount(&server_success).await;

        let proxied = RequestProxied::new(vec![
            server_fail.uri(),
            server_success.uri(),
        ]);

        // Attempt enough times to guarantee 3 failures on server_fail
        for _ in 0..5 {
            let _ = proxied.end_point::<TestBody>("https://target.com", "", Some(fast_fail_options())).await;
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
            .mount(&server1).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server2).await;

        let proxied = RequestProxied::new(vec![server1.uri(), server2.uri()]);

        let result = proxied.end_point::<TestBody>("https://t.com", "", Some(fast_fail_options())).await;

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
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody { message: "ok".to_string() }))
            .mount(&server1).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(TestBody { message: "ok".to_string() }))
            .mount(&server2).await;

        let proxied = RequestProxied::new(vec![server1.uri(), server2.uri()]);

        let urls = vec![
            "https://t1.com",
            "https://t2.com",
            "https://t3.com",
        ];

        let results = proxied.end_points::<TestBody>(&urls, "", None).await;
        assert_eq!(results.len(), 3);

        let reqs1 = server1.received_requests().await.unwrap();
        let reqs2 = server2.received_requests().await.unwrap();

        // 3 total urls across 2 proxies -> server1 gets 2 requests, server2 gets 1
        assert_eq!(reqs1.len(), 2);
        assert_eq!(reqs2.len(), 1);

        // Verify correct ?url payload mapped
        assert_eq!(reqs1[0].url.query_pairs().find(|(k, _)| k == "url").unwrap().1, "https://t1.com");
        assert_eq!(reqs2[0].url.query_pairs().find(|(k, _)| k == "url").unwrap().1, "https://t2.com");
        assert_eq!(reqs1[1].url.query_pairs().find(|(k, _)| k == "url").unwrap().1, "https://t3.com");
    }

    #[tokio::test]
    async fn test_edge_case_no_active_proxies_left() {
        let proxied = RequestProxied::new(vec!["http://dummy".to_string()]);
        
        // Manually empty active proxies
        {
            let mut state = proxied.state.lock().unwrap();
            state.active_proxies.clear();
        }

        let result = proxied.end_point::<TestBody>("https://target.com", "", None).await;

        match result {
            ApiResponse::Error { reason } => assert_eq!(reason["message"], "No active proxies left"),
            _ => panic!("Expected immediate fail if no proxies exist"),
        }
    }
}
