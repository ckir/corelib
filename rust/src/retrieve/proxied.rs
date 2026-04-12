// =============================================
// FILE: rust/src/retrieve/proxied.rs
// PURPOSE: High-resilience proxied HTTP client mirroring RequestProxied.ts.
// DESCRIPTION: This module provides a load-balanced HTTP client that rotates
// through a list of proxy servers. It handles automatic fallback to alternative
// proxies upon failure and permanently removes consistently failing proxies.
// =============================================

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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
    /// # Panics
    /// Panics if the provided `proxies` vector is empty.
    pub fn new(proxies: Vec<String>) -> Self {
        // Enforce that at least one proxy is provided
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

    /// Builds the final proxy URL by appending the target URL as a query parameter.
    ///
    /// This function uses `reqwest::Url` to guarantee correct query string encoding
    /// and handling of the original target URL.
    ///
    /// # Arguments
    /// * `proxy_base` - The base URL of the proxy server.
    /// * `suffix` - An optional path segment to append to the proxy base.
    /// * `target_url` - The original URL that should be fetched via the proxy.
    fn build_proxy_url(proxy_base: &str, suffix: &str, target_url: &str) -> String {
        // Ensure the base URL ends with a slash so the suffix is joined correctly
        let base_with_slash = if proxy_base.ends_with('/') {
            proxy_base.to_string()
        } else {
            format!("{}/", proxy_base)
        };

        // Parse the base URL into a Url object
        let mut url_obj = Url::parse(&base_with_slash).expect("Invalid proxy base URL");

        // Join the suffix if it's not empty
        if !suffix.is_empty() {
            url_obj = url_obj.join(suffix).expect("Invalid proxy suffix");
        }

        // Append the encoded target URL as the 'url' query parameter
        url_obj.query_pairs_mut().append_pair("url", target_url);
        // Return the final serialized URL string
        url_obj.to_string()
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
            if state.active_proxies.is_empty() {
                state.current_index = 0;
            } else if state.current_index >= state.active_proxies.len() {
                state.current_index = 0;
            }

            // Log the removal to stderr
            eprintln!(
                "[RequestProxied] Proxy removed (3 consecutive failures): {}",
                proxy_base
            );
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
                eprintln!("[RequestProxied] No active proxies left");
                return ApiResponse::Error {
                    reason: serde_json::json!({ "message": "No active proxies left" }),
                };
            }
            // We will attempt at most once per active proxy
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

                // Select the proxy URL using the current rotation index
                let idx = state.current_index % state.active_proxies.len();
                proxy_base = state.active_proxies[idx].clone();

                // Advance the rotation index for the next request
                state.current_index = (state.current_index + 1) % state.active_proxies.len();
            }

            // Construct the proxied URL
            let proxy_url = Self::build_proxy_url(&proxy_base, suffix, url);
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
        eprintln!("[RequestProxied] All proxies failed for url: {}", url);
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

        // Distribute the URLs across the available proxies
        let proxy_urls: Vec<String> = urls
            .iter()
            .enumerate()
            .map(|(i, target)| {
                // Pick a proxy based on the loop index for static load balancing
                let proxy_base = &active_proxies[i % active_proxies.len()];
                Self::build_proxy_url(proxy_base, suffix, target)
            })
            .collect();

        // Convert the String vector into a vector of &str for the unlimited module API
        let proxy_urls_refs: Vec<&str> = proxy_urls.iter().map(|s| s.as_str()).collect();

        // Delegate concurrent execution to the unlimited module
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

        let proxied = RequestProxied::new(vec![server1.uri(), server2.uri(), server3.uri()]);

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
        ]);

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

        let proxied = RequestProxied::new(vec![server_fail.uri(), server_success.uri()]);

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

        let proxied = RequestProxied::new(vec![server1.uri(), server2.uri()]);

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

        let proxied = RequestProxied::new(vec![server1.uri(), server2.uri()]);

        let urls = vec!["https://t1.com", "https://t2.com", "https://t3.com"];

        let results = proxied.end_points::<TestBody>(&urls, "", None).await;
        assert_eq!(results.len(), 3);

        let reqs1 = server1.received_requests().await.unwrap();
        let reqs2 = server2.received_requests().await.unwrap();

        // 3 total urls across 2 proxies -> server1 gets 2 requests, server2 gets 1
        assert_eq!(reqs1.len(), 2);
        assert_eq!(reqs2.len(), 1);

        // Verify correct ?url payload mapped
        assert_eq!(
            reqs1[0]
                .url
                .query_pairs()
                .find(|(k, _)| k == "url")
                .unwrap()
                .1,
            "https://t1.com"
        );
        assert_eq!(
            reqs2[0]
                .url
                .query_pairs()
                .find(|(k, _)| k == "url")
                .unwrap()
                .1,
            "https://t2.com"
        );
        assert_eq!(
            reqs1[1]
                .url
                .query_pairs()
                .find(|(k, _)| k == "url")
                .unwrap()
                .1,
            "https://t3.com"
        );
    }

    #[tokio::test]
    async fn test_edge_case_no_active_proxies_left() {
        let proxied = RequestProxied::new(vec!["http://dummy".to_string()]);

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
}
