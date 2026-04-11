use chrono::Utc;
use reqwest::{Client, IntoUrl, Method, RequestBuilder, StatusCode};
use serde::{de::DeserializeOwned, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use thiserror::Error;

/// Custom Error type using `thiserror`
#[derive(Debug, Error)]
pub enum KyError {
    /// HTTP error with status and url
    #[error("HTTP Error {status} when accessing {url}")]
    Http {
        /// HTTP status code
        status: StatusCode,
        /// URL accessed
        url: String,
    },
    /// Reqwest network/request error
    #[error("Network/Request Error: {0}")]
    Request(#[from] reqwest::Error),
    /// Serde JSON serialization/deserialization error
    #[error("Serialization Error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// A global, lazily-initialized client for the shorthand functions
static GLOBAL_CLIENT: OnceLock<Client> = OnceLock::new();

fn get_default_client() -> &'static Client {
    GLOBAL_CLIENT.get_or_init(Client::new)
}

/// Configuration options for retry logic mirroring `ky` 2.0.0 defaults
#[derive(Clone, Debug)]
pub struct RetryOptions {
    /// Maximum number of retries
    pub limit: u32,
    /// HTTP methods that are allowed to be retried
    pub methods: Vec<Method>,
    /// HTTP status codes that trigger a retry
    pub status_codes: Vec<StatusCode>,
    /// HTTP status codes that respect the `Retry-After` header
    pub after_status_codes: Vec<StatusCode>,
    /// Maximum duration to wait between retries
    pub max_retry_after: Option<Duration>,
    /// Cap the backoff exponential delay to this duration
    pub backoff_limit: Option<Duration>,
}

impl Default for RetryOptions {
    fn default() -> Self {
        Self {
            limit: 2,
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
            max_retry_after: None, // Infinity equivalent
            backoff_limit: None,   // Infinity equivalent
        }
    }
}

/// The main Ky instance.
/// Can be used to create clients with default settings (like `ky.extend()`).
#[derive(Clone, Debug)]
pub struct Ky {
    client: Client,
    retry_options: RetryOptions,
}

impl Default for Ky {
    fn default() -> Self {
        Self {
            client: get_default_client().clone(),
            retry_options: RetryOptions::default(),
        }
    }
}

impl Ky {
    /// Creates a new Ky instance with default settings
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a new Ky instance from an existing reqwest Client
    pub fn with_client(client: Client) -> Self {
        Self {
            client,
            retry_options: RetryOptions::default(),
        }
    }

    /// Sets the maximum retry limit
    pub fn retry(mut self, limit: u32) -> Self {
        self.retry_options.limit = limit;
        self
    }

    /// Overrides the retry options completely
    pub fn retry_options(mut self, options: RetryOptions) -> Self {
        self.retry_options = options;
        self
    }

    /// Start a GET request
    pub fn get<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::GET, url)
    }

    /// Start a POST request
    pub fn post<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::POST, url)
    }

    /// Start a PUT request
    pub fn put<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::PUT, url)
    }

    /// Start a PATCH request
    pub fn patch<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::PATCH, url)
    }

    /// Start a DELETE request
    pub fn delete<U: IntoUrl>(&self, url: U) -> KyRequestBuilder {
        self.request(Method::DELETE, url)
    }

    fn request<U: IntoUrl>(&self, method: Method, url: U) -> KyRequestBuilder {
        KyRequestBuilder {
            builder: self.client.request(method.clone(), url),
            method,
            retry_options: self.retry_options.clone(),
        }
    }
}

/// Shorthand global functions (mimicking `ky.get()`, `ky.post()`)
pub fn get<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().get(url)
}
/// Shorthand global functions
pub fn post<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().post(url)
}
/// Shorthand global functions
pub fn put<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().put(url)
}
/// Shorthand global functions
pub fn patch<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().patch(url)
}
/// Shorthand global functions
pub fn delete<U: IntoUrl>(url: U) -> KyRequestBuilder {
    Ky::default().delete(url)
}

/// Wrapper around `reqwest::RequestBuilder` to provide `ky`-like chainable methods
pub struct KyRequestBuilder {
    builder: RequestBuilder,
    method: Method,
    retry_options: RetryOptions,
}

impl KyRequestBuilder {
    /// Send JSON body
    pub fn json<T: Serialize + ?Sized>(mut self, json: &T) -> Self {
        self.builder = self.builder.json(json);
        self
    }

    /// Add a generic header
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

    /// Set a bearer token
    pub fn bearer_auth<T: std::fmt::Display>(mut self, token: T) -> Self {
        self.builder = self.builder.bearer_auth(token);
        self
    }

    /// Set a timeout for this specific request
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.builder = self.builder.timeout(timeout);
        self
    }

    /// Sets the maximum retry limit for this request
    pub fn retry(mut self, limit: u32) -> Self {
        self.retry_options.limit = limit;
        self
    }

    /// Sets the retry options for this request
    pub fn retry_options(mut self, options: RetryOptions) -> Self {
        self.retry_options = options;
        self
    }

    /// Executes the request. Automatically throws an error on non-2xx responses and handles retries.
    pub async fn send(self) -> Result<KyResponse, KyError> {
        let mut attempt_count = 1;
        let mut current_builder = self.builder;

        loop {
            // Must try to clone the builder to enable retrying.
            // If it returns None, retries are impossible (e.g., streaming body).
            let builder_clone = current_builder.try_clone();

            let res = if let Some(ref b) = builder_clone {
                b.try_clone().unwrap().send().await
            } else {
                current_builder.send().await // Can't clone, consume it completely
            };

            match res {
                Ok(response) => {
                    let status = response.status();

                    if status.is_success() {
                        return Ok(KyResponse { res: response });
                    }

                    // Handle retries on eligible HTTP errors
                    if builder_clone.is_some()
                        && attempt_count <= self.retry_options.limit
                        && self.retry_options.methods.contains(&self.method)
                        && self.retry_options.status_codes.contains(&status)
                    {
                        let mut delay_duration =
                            Self::calculate_delay(attempt_count, self.retry_options.backoff_limit);

                        // Parse Retry-After header
                        if self.retry_options.after_status_codes.contains(&status) {
                            if let Some(retry_after) =
                                response.headers().get(reqwest::header::RETRY_AFTER)
                            {
                                if let Ok(retry_after_str) = retry_after.to_str() {
                                    if let Ok(seconds) = retry_after_str.parse::<u64>() {
                                        delay_duration = Duration::from_secs(seconds);
                                    } else if let Ok(date) =
                                        chrono::DateTime::parse_from_rfc2822(retry_after_str)
                                    {
                                        let now = Utc::now();
                                        if date.with_timezone(&Utc) > now {
                                            delay_duration = (date.with_timezone(&Utc) - now)
                                                .to_std()
                                                .unwrap_or(Duration::ZERO);
                                        } else {
                                            delay_duration = Duration::ZERO;
                                        }
                                    }

                                    if let Some(max) = self.retry_options.max_retry_after {
                                        delay_duration = std::cmp::min(delay_duration, max);
                                    }
                                }
                            }
                        }

                        tokio::time::sleep(delay_duration).await;
                        attempt_count += 1;
                        current_builder = builder_clone.unwrap();
                        continue;
                    }

                    return Err(KyError::Http {
                        status,
                        url: response.url().to_string(),
                    });
                }
                Err(e) => {
                    // Handle retries on eligible network/connection errors
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
                    return Err(KyError::Request(e));
                }
            }
        }
    }

    /// Exponential backoff delay calculation mimicking ky's defaults
    fn calculate_delay(attempt_count: u32, backoff_limit: Option<Duration>) -> Duration {
        // 0.3 * (2 ** (attemptCount - 1)) * 1000
        let delay_ms = 300.0 * (2.0_f64.powi((attempt_count as i32) - 1));
        let delay = Duration::from_millis(delay_ms as u64);
        if let Some(limit) = backoff_limit {
            std::cmp::min(delay, limit)
        } else {
            delay
        }
    }
}

/// Wrapper around `reqwest::Response` to provide ergonomic parsers
#[derive(Debug)]
pub struct KyResponse {
    res: reqwest::Response,
}

impl KyResponse {
    /// Parse the response body as JSON
    pub async fn json<T: DeserializeOwned>(self) -> Result<T, KyError> {
        Ok(self.res.json::<T>().await?)
    }

    /// Parse the response body as Text
    pub async fn text(self) -> Result<String, KyError> {
        Ok(self.res.text().await?)
    }

    /// Get the raw bytes of the response
    pub async fn bytes(self) -> Result<bytes::Bytes, KyError> {
        Ok(self.res.bytes().await?)
    }

    /// Access the underlying `reqwest::Response` if you need headers, status code, etc.
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

    /// Test standard GET request and JSON parsing
    #[tokio::test]
    async fn test_get_json_success() {
        let server = MockServer::start().await;
        let expected_body = TestData {
            message: "hello".to_string(),
            code: 200,
        };

        Mock::given(method("GET"))
            .and(path("/test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&expected_body))
            .mount(&server)
            .await;

        let res: TestData = get(format!("{}/test", server.uri()))
            .send()
            .await
            .expect("Request failed")
            .json()
            .await
            .expect("JSON parsing failed");

        assert_eq!(res, expected_body);
    }

    /// Test that ky throws an error on non-2xx status codes (404)
    #[tokio::test]
    async fn test_http_error_behavior() {
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let result = get(server.uri()).send().await;

        match result {
            Err(KyError::Http { status, .. }) => assert_eq!(status, 404),
            _ => panic!("Expected an HTTP 404 error, got {:?}", result),
        }
    }

    /// Test POST with a JSON body and custom headers
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

    /// Test Bearer token shorthand
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

    /// Test parsing response as raw text
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

    /// Test using a custom instance of Ky with default client settings
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

    /// Test that ky natively retries failures out-of-the-box (ky defaults to 2 limit)
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

    /// Test behavior when failing request reaches its maximum retry threshold limits
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

    /// Verify `.retry(0)` bypasses all automated retry handling functionality
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
