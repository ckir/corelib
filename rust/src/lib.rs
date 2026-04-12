// =============================================
// FILE: rust/src/lib.rs
// PURPOSE: Core Rust FFI entry point + public modules
// DESCRIPTION: This file defines the main entry point for the N-API FFI bridge
// and re-exports all public Rust modules (retrieve, markets, utils) for internal
// and external usage.
// =============================================

/// Public utils module (mirrors TS `utils` section).
/// Contains internal helpers for future FFI functions (cron, etc.).
pub mod utils;

/// Public retrieve module (contains the `ky` HTTP client).
pub mod retrieve;

/// Re-export the ergonomic `ky` HTTP client.
pub use retrieve::ky;
/// Re-export the high-resilience `proxied` HTTP client.
pub use retrieve::proxied;
/// Re-export the high-resilience `unlimited` request utility.
pub use retrieve::unlimited;

use napi_derive::napi;

/// Logs a message in Rust and returns the input value doubled.
/// Used by the TS FFI bridge (`logAndDouble`).
///
/// # Arguments
/// * `msg` - The message to log to stdout.
/// * `value` - The integer value to double.
///
/// # Returns
/// The input `value` multiplied by 2.
#[napi]
pub fn log_and_double(msg: String, value: i32) -> i32 {
    // Print the message to the console with a prefix
    println!("[Rust FFI] {}", msg);
    // Return the doubled value
    value * 2
}

/// Returns the Cargo package version as a string.
/// Used by the TS FFI bridge (`getVersion`).
///
/// # Returns
/// The version string from `Cargo.toml`.
#[napi]
pub fn get_version() -> String {
    // Fetch the version from the environment variables set by Cargo at compile time
    env!("CARGO_PKG_VERSION").to_string()
}

/// Public markets module containing Nasdaq and Yahoo data feed logic.
pub mod markets {
    /// Nasdaq-specific API wrappers and data structures.
    pub mod nasdaq {
        /// High-level API for fetching Nasdaq quotes.
        pub mod api_nasdaq_quotes;
        /// Resilient Nasdaq API base wrapper with spoofed headers.
        pub mod api_nasdaq_unlimited;
        /// Data feed implementations (streaming/polling).
        pub mod datafeeds {
            /// Streaming data feed implementations.
            pub mod streaming {
                /// Yahoo-specific streaming implementation.
                pub mod yahoo {
                    /// Main Yahoo price streamer logic.
                    pub mod yahoo_streamer;
                    /// Protobuf handler for Yahoo Finance websocket messages.
                    pub mod yahoo_streaming_proto_handler;
                    /// Re-export Yahoo streaming components for convenience.
                    pub use yahoo_streamer::{
                        EventRecord, LogRecord, RustCallbacks, YahooConfig, YahooStreaming,
                        YahooStreamingCore,
                    };
                }
            }
        }
    }
}

/// Re-export Nasdaq quote fetching functions.
pub use markets::nasdaq::api_nasdaq_quotes::{nasdaq_quote, nasdaq_quotes, AssetClass};

/// Re-export Nasdaq base API functions.
pub use markets::nasdaq::api_nasdaq_unlimited::{
    get_nasdaq_headers, nasdaq_end_point, nasdaq_end_points,
};

/// Re-export Yahoo streaming components.
pub use markets::nasdaq::datafeeds::streaming::yahoo::{
    EventRecord, LogRecord, RustCallbacks, YahooConfig, YahooStreaming, YahooStreamingCore,
};
