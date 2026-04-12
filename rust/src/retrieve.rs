// =============================================
// FILE: rust/src/retrieve.rs
// PURPOSE: Retrieve module index / barrel file
// DESCRIPTION: This file acts as a barrel for the `retrieve` section,
// re-exporting the `ky` HTTP client, the `unlimited` high-resilience utility,
// and the `proxied` load-balanced client.
// =============================================

/// A Rust HTTP client that mimics the `ky` API for ergonomics.
pub mod ky;

/// High-resilience HTTP request utility for single or multiple endpoints.
pub mod unlimited;

/// High-resilience proxied HTTP client with automatic rotation and fallback.
pub mod proxied;

// Re-export the public API so users can write:
// use corelib_rust::retrieve::ky;

/// Shorthand function for a DELETE request.
pub use ky::delete;
/// Shorthand function for a GET request.
pub use ky::get;
/// Shorthand function for a PATCH request.
pub use ky::patch;
/// Shorthand function for a POST request.
pub use ky::post;
/// Shorthand function for a PUT request.
pub use ky::put;
/// The main `Ky` instance used for making requests.
pub use ky::Ky;
/// Error type for `ky` requests.
pub use ky::KyError;
/// Chainable builder for `ky` requests.
pub use ky::KyRequestBuilder;
/// Wrapper around `reqwest::Response` with extra helpers.
pub use ky::KyResponse;

// Re-export the public API so users can write:
// use corelib_rust::retrieve::unlimited;

/// High-level function to make a single resilient request.
pub use unlimited::end_point;
/// High-level function to make multiple parallel resilient requests.
pub use unlimited::end_points;
/// Standard result wrapper for `unlimited` requests.
pub use unlimited::ApiResponse;
/// Configuration for resilient requests.
pub use unlimited::RequestOptions;
/// Serialized representation of an HTTP response.
pub use unlimited::SerializedResponse;

// Re-export the public API so users can write:
// use corelib_rust::retrieve::proxied;

/// The proxied HTTP client with load balancing.
pub use proxied::RequestProxied;
