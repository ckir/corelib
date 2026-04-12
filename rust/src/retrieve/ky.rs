// =============================================
// FILE: rust/src/retrieve/ky.rs
// PURPOSE: Lightweight HTTP client mimicking the `ky` API.
// DESCRIPTION: This module provides a high-level, ergonomic wrapper around
// `reqwest` that mimics the `ky` API. It includes automatic retries with
// exponential backoff and support for the `Retry-After` header.
// =============================================

use chrono::Utc;
use reqwest::{Client, IntoUrl, Method, RequestBuilder, StatusCode};
use serde::{de::DeserializeOwned, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use thiserror::Error;

/// Custom error type for the `ky` client.
#[derive(Debug, Error)]
pub enum KyError {
    /// Represents an HTTP error where the status code is not 2xx.
    #[error("HTTP Error {status} when accessing {url}")]
    Http {
        /// The HTTP status code returned by the server.
        status: StatusCode,
        /// The URL that was being accessed.
        url: String,
    },
    /// Represents a networking or request configuration error from `reqwest`.
    #[error("Network/Request Error: {0}")]
    Request(#[from] reqwest::Error),
    /// Represents a failure to serialize or deserialize the JSON payload.
    #[error("Serialization Error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// A global, lazily-initialized `reqwest` client used by shorthand functions.
static GLOBAL_CLIENT: OnceLock<Client> = OnceLock::new();

/// Returns a reference to the global `reqwest` client, initializing it if necessary.
fn get_default_client() -> &'static Client {
    // Return the existing client or create a new one if it's the first call
    GLOBAL_CLIENT.get_or_init(Client::new)
}

/// Configuration options for retry logic, mirroring the `ky` 2.0.0 defaults.
#[derive(Clone, Debug)]
pub struct RetryOptions {
    /// The maximum number of retry attempts.
    pub limit: u32,
    /// The list of HTTP methods that are allowed to be retried.
    pub methods: Vec<Method>,
    /// The list of HTTP status codes that should trigger a retry.
    pub status_codes: Vec<StatusCode>,
    /// The list of HTTP status codes that should specifically check the `Retry-After` header.
    pub after_status_codes: Vec<StatusCode>,
    /// An optional cap for the duration suggested by the `Retry-After` header.
    pub max_retry_after: Option<Duration>,
    /// An optional cap for the exponential backoff delay.
    pub backoff_limit: Option<Duration>,
}

impl Default for RetryOptions {
    /// Provides the default retry configuration used by `ky`.
    fn default() -> Self {
        Self {
            limit: 2, // Retry up to 2 times
            methods: vec![
                Method::GET,
                Method::PUT,
                Method::HEAD,
                Method::DELETE,
                Method::OPTIONS,
                Method::TRACE,
            ],
            status_codes: vec![
                StatusCode::REQUEST_TIMEOUT,       // 408
                StatusCode::PAYLOAD_TOO_LARGE,     // 413
                StatusCode::TOO_MANY_REQUESTS,     // 429
                StatusCode::INTERNAL_SERVER_ERROR, // 500
                StatusCode::BAD_GATEWAY,           // 502
                StatusCode::SERVICE_UNAVAILABLE,   // 503
                StatusCode::GATEWAY_TIMEOUT,       // 504
            ],
            after_status_codes: vec![
                StatusCode::PAYLOAD_TOO_LARGE,   // 413
                StatusCode::TOO_MANY_REQUESTS,   // 429
                StatusCode::SERVICE_UNAVAILABLE, // 503
            ],
            max_retry_after: None, // No limit on Retry-After duration by default
            backoff_limit: None,   // No limit on exponential backoff delay by default
        }
    }
}

/// The main `ky`-like client instance.
///
/// It encapsulates a `reqwest::Client` and a set of `RetryOptions`.
#[derive(Clone, Debug)]
pub struct Ky {
    /// The underlying `reqwest` client used to perform requests.
    client: Client,
    /// The retry configuration for this instance.
    retry_options: RetryOptions,
}

impl Default for Ky {
    /// Creates a new `Ky` instance with the default global client and retry options.
    fn default() -> Self {
        Self {
            client: get_default_client().clone(),
            retry_options: RetryOptions::default(),
        }
    }
}

impl Ky {
    /// Creates a new `Ky` instance with default settings.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a new `Ky` instance from an existing `reqwest::Client`.
    ///
    /// # Arguments
    /// * `client` - The `reqwest` client to wrap.
    pub fn with_client(client: Client) -> Self {
        Self {
            client,
            retry_options: RetryOptions::default(),
        }
    }

    /// Sets the maximum number of retry attempts for this client instance.
    ///
    /// # Arguments
    /// * `limit` - The new retry limit.
    pub fn retry(mut self, limit: u32) -> Self {
        self.retry_options.limit = limit;
        self
    }

    /// Overrides the entire retry configuration for this client instance.
    ///
    /// # Arguments
    /// * `options` - The new `RetryOptions` to apply.
    pub fn retry_options(mut self, options: RetryOptions) -> Self {
        self.retry_options = options;
        self
    }

    /// Initiates a GET request to the specified URL.
    pub fn get<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::GET, url)
    }

    /// Initiates a POST request to the specified URL.
    pub fn post<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::POST, url)
    }

    /// Initiates a PUT request to the specified URL.
    pub fn put<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::PUT, url)
    }

    /// Initiates a PATCH request to the specified URL.
    pub fn patch<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::PATCH, url)
    }

    /// Initiates a DELETE request to the specified URL.
    pub fn delete<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::DELETE, url)
    }

    /// Internal helper to create a `KyRequestBuilder` for a given method and URL.
    fn request<U: IntoUrl>(&self, method: Method, url: U) -> KyRequestBuilder {
        KyRequestBuilder {
            // Start the reqwest request builder
            builder: self.client.request(method.clone(), url),
            method,
            retry_options: self.retry_options.clone(),
        }
    }
}

/// Shorthand function for initiating a GET request using the default client.
pub fn get<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().get(url)
}
/// Shorthand function for initiating a POST request using the default client.
pub fn post<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().post(url)
}
/// Shorthand function for initiating a PUT request using the default client.
pub fn put<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().put(url)
}
/// Shorthand function for initiating a PATCH request using the default client.
pub fn patch<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().patch(url)
}
/// Shorthand function for initiating a DELETE request using the default client.
pub fn delete<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().delete(url)
}

/// A chainable request builder that mimics `ky`'s API.
pub struct KyRequestBuilder {
    /// The underlying `reqwest::RequestBuilder`.
    builder: RequestBuilder,
    /// The HTTP method for the current request.
    method: Method,
    /// The retry configuration for this specific request.
    retry_options: RetryOptions,
}

impl KyRequestBuilder {
    /// Attaches a JSON body to the request.
    ///
    /// # Arguments
    /// * `json` - The serializable object to be sent as JSON.
    pub fn json<T: Serialize + ?Sized>(mut self, json: &T) -> Self {
        self.builder = self.builder.json(json);
        self
    }

    /// Adds a custom header to the request.
    pub fn header<K, V>(mut self, key: K, value: V) -> Self
    where
        reqwest::header::HeaderName: TryFrom<K>,
        <reqwest::header::HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        reqwest::header::HeaderValue: TryFrom<V>,
        <reqwest::header::HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        self.builder = self.builder.header(key, value);
        self
    }

    /// Sets the `Authorization: Bearer <token>` header.
    pub fn bearer_auth<T: std::fmt::Display>(mut self, token: T) -> Self {
        self.builder = self.builder.bearer_auth(token);
        self
    }

    /// Sets a timeout for this specific request.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.builder = self.builder.timeout(timeout);
        self
    }

    /// Sets the maximum retry limit for this specific request.
    pub fn retry(mut self, limit: u32) -> Self {
        self.retry_options.limit = limit;
        self
    }

    /// Overrides the retry options for this specific request.
    pub fn retry_options(mut self, options: RetryOptions) -> Self {
        self.retry_options = options;
        self
    }

    /// Executes the request, handling non-2xx status codes and automatic retries.
    ///
    /// # Returns
    /// A `Result` containing the `KyResponse` on success, or a `KyError` on failure.
    pub async fn send(self) -> Result<KyResponse, KyError> {
        // Track the current retry attempt
        let mut attempt_count = 1;
        let mut current_builder = self.builder;

        loop {
            // Attempt to clone the builder to allow for retries.
            // If try_clone returns None, it usually means the request body is a stream and cannot be retried.
            let builder_clone = current_builder.try_clone();

            // Execute the request
            let res = if let Some(ref b) = builder_clone {
                // Use a second clone for the actual send to keep builder_clone for future retries
                b.try_clone().unwrap().send().await
            } else {
                // If it can't be cloned, consume it completely in this first attempt
                current_builder.send().await
            };

            match res {
                Ok(response) => {
                    let status = response.status();

                    // If it's a 2xx success, return immediately
                    if status.is_success() {
                        return Ok(KyResponse { res: response });
                    }

                    // Check if we should retry based on the HTTP status code
                    if builder_clone.is_some()
                        && attempt_count <= self.retry_options.limit
                        && self.retry_options.methods.contains(&self.method)
                        && self.retry_options.status_codes.contains(&status)
                    {
                        // Calculate the initial exponential backoff delay
                        let mut delay_duration =
                            Self::calculate_delay(attempt_count, self.retry_options.backoff_limit);

                        // If the status code is eligible, check for the Retry-After header
                        if self.retry_options.after_status_codes.contains(&status) {
                            if let Some(retry_after) =
                                response.headers().get(reqwest::header::RETRY_AFTER)
                            {
                                if let Ok(retry_after_str) = retry_after.to_str() {
                                    // Handle Retry-After as seconds
                                    if let Ok(seconds) = retry_after_str.parse::<u64>() {
                                        delay_duration = Duration::from_secs(seconds);
                                    } else if let Ok(date) =
                                        chrono::DateTime::parse_from_rfc2822(retry_after_str)
                                    {
                                        // Handle Retry-After as an RFC 2822 date
                                        let now = Utc::now();
                                        if date.with_timezone(&Utc) > now {
                                            delay_duration = (date.with_timezone(&Utc) - now)
                                                .to_std()
                                                .unwrap_or(Duration::ZERO);
                                        } else {
                                            delay_duration = Duration::ZERO;
                                        }
                                    }

                                    // Apply the optional max_retry_after cap
                                    if let Some(max) = self.retry_options.max_retry_after {
                                        delay_duration = std::cmp::min(delay_duration, max);
                                    }
                                }
                            }
                        }

                        // Wait for the calculated delay before retrying
                        tokio::time::sleep(delay_duration).await;
                        attempt_count += 1;
                        // Use the preserved clone for the next iteration
                        current_builder = builder_clone.unwrap();
                        continue;
                    }

                    // If not retriable or limit reached, return the HTTP error
                    return Err(KyError::Http {
                        status,
                        url: response.url().to_string(),
                    });
                }
                Err(e) => {
                    // Check if we should retry based on network-level errors (connect or timeout)
                    if builder_clone.is_some()
                        && attempt_count <= self.retry_options.limit
                        && self.retry_options.methods.contains(&self.method)
                        && (e.is_connect() || e.is_timeout())
                    {
                        let delay_duration =
                            Self::calculate_delay(attempt_count, self.retry_options.backoff_limit);
                        tokio::time::sleep(delay_duration).await;
                        attempt_count += 1;
                        current_builder = builder_clone.unwrap();
                        continue;
                    }
                    // Return the network error
                    return Err(KyError::Request(e));
                }
            }
        }
    }

    /// Calculates the exponential backoff delay based on the attempt count.
    fn calculate_delay(attempt_count: u32, backoff_limit: Option<Duration>) -> Duration {
        // formula: 0.3 * (2 ** (attemptCount - 1)) * 1000ms
        let delay_ms = 300.0 * (2.0_f64.powi((attempt_count as i32) - 1));
        let delay = Duration::from_millis(delay_ms as u64);
        // Apply the optional cap
        if let Some(limit) = backoff_limit {
            std::cmp::min(delay, limit)
        } else {
            delay
        }
    }
}

/// A wrapper around `reqwest::Response` that provides ergonomic parsers.
#[derive(Debug)]
pub struct KyResponse {
    /// The underlying `reqwest` response.
    pub(crate) res: reqwest::Response,
}

impl KyResponse {
    /// Consumes the response and parses the body as JSON.
    pub async fn json<T: DeserializeOwned>(self) -> Result<T, KyError> {
        // Delegate to reqwest's JSON parser
        Ok(self.res.json::<T>().await?)
    }

    /// Consumes the response and returns the body as a `String`.
    pub async fn text(self) -> Result<String, KyError> {
        // Delegate to reqwest's text parser
        Ok(self.res.text().await?)
    }

    /// Consumes the response and returns the body as raw `Bytes`.
    pub async fn bytes(self) -> Result<bytes::Bytes, KyError> {
        // Delegate to reqwest's bytes parser
        Ok(self.res.bytes().await?)
    }

    /// Consumes the `KyResponse` and returns the underlying `reqwest::Response`.
    ///
    /// This is useful if you need to access raw headers or other low-level details.
    pub fn into_inner(self) -> reqwest::Response {
        self.res
    }
}

#[cfg(test)]
mod tests {
    use super::*; // Directly map all items in the module
    use serde::{Deserialize, Serialize};
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct TestData {
        message: String,
        code: i32,
    }

    /// Test standard GET request and JSON parsing.
    #[tokio::test]
    async fn test_get_json_success() {
        // Start a mock server
        let server = MockServer::start().await;
        let expected_body = TestData {
            message: "hello".to_string(),
            code: 200,
        };

        // Setup the mock expectations
        Mock::given(method("GET"))
            .and(path("/test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&expected_body))
            .mount(&server)
            .await;

        // Perform the request
        let res: TestData = get(format!("{}/test", server.uri()))
            .send()
            .await
            .expect("Request failed")
            .json()
            .await
            .expect("JSON parsing failed");

        // Verify the result
        assert_eq!(res, expected_body);
    }

    /// Test that ky throws an error on non-2xx status codes (404).
    #[tokio::test]
    async fn test_http_error_behavior() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let result = get(server.uri()).send().await;

        match result {
            // Verify that we correctly identified the 404 error
            Err(KyError::Http { status, .. }) => assert_eq!(status, 404),
            _ => panic!("Expected an HTTP 404 error, got {:?}", result),
        }
    }

    /// Test POST with a JSON body and custom headers.
    #[tokio::test]
    async fn test_post_with_headers_and_body() {
        let server = MockServer::start().await;
        let body = TestData {
            message: "post".to_string(),
            code: 123,
        };

        Mock::given(method("POST"))
            .and(header("X-Custom-Auth", "secret"))
            .and(body_json(&body))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let response = post(server.uri())
            .header("X-Custom-Auth", "secret")
            .json(&body)
            .send()
            .await;

        assert!(response.is_ok(), "POST request should succeed");
    }

    /// Test Bearer token shorthand.
    #[tokio::test]
    async fn test_bearer_auth() {
        let server = MockServer::start().await;

        Mock::given(header("Authorization", "Bearer my-token"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let res = get(server.uri()).bearer_auth("my-token").send().await;

        assert!(res.is_ok());
    }

    /// Test parsing response as raw text.
    #[tokio::test]
    async fn test_text_parsing() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("plain text"))
            .mount(&server)
            .await;

        let text = get(server.uri())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();

        assert_eq!(text, "plain text");
    }

    /// Test using a custom instance of Ky with default client settings.
    #[tokio::test]
    async fn test_custom_ky_instance() {
        let server = MockServer::start().await;

        // Mock a 200 OK
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let custom_ky = Ky::new();
        let res = custom_ky.get(server.uri()).send().await;

        assert!(res.is_ok());
    }

    /// Test that ky natively retries failures out-of-the-box (ky defaults to 2 limit).
    #[tokio::test]
    async fn test_retry_on_500() {
        let server = MockServer::start().await;

        // Catch the successful fallback call after the retries
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("success"))
            .mount(&server)
            .await;

        // Fails with 500 up to two times before successfully completing the response
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(2)
            .mount(&server)
            .await;

        let text = get(server.uri())
            .send()
            .await
            .expect("Request failed despite retry attempts")
            .text()
            .await
            .unwrap();

        assert_eq!(text, "success");
    }

    /// Test behavior when failing request reaches its maximum retry threshold limits.
    #[tokio::test]
    async fn test_retry_limit_exceeded() {
        let server = MockServer::start().await;

        // Respond with 500 four times. Because default limit is 2, it should fail after 3 requests (1 initial + 2 retries)
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(4)
            .mount(&server)
            .await;

        let result = get(server.uri()).send().await;

        match result {
            Err(KyError::Http { status, .. }) => assert_eq!(status, 500),
            _ => panic!(
                "Expected an HTTP 500 error after retries limit exceeded, got {:?}",
                result
            ),
        }
    }

    /// Verify `.retry(0)` bypasses all automated retry handling functionality.
    #[tokio::test]
    async fn test_disable_retries() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(2)
            .mount(&server)
            .await;

        let result = get(server.uri()).retry(0).send().await;

        match result {
            Err(KyError::Http { status, .. }) => assert_eq!(status, 500),
            _ => panic!("Expected an HTTP 500 error, got {:?}", result),
        }
    }
}
