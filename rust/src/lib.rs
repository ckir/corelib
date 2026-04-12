// =============================================
// FILE: rust/src/lib.rs
// PURPOSE: Core Rust FFI entry point + public modules
// All original FFI functions and N-API exports are unchanged.
// =============================================

/// Public utils module (mirrors TS `utils` section).
/// Contains internal helpers for future FFI functions (cron, etc.).
pub mod utils;

/// Public retrieve module (contains the `ky` HTTP client).
pub mod retrieve;
pub use retrieve::ky;
pub use retrieve::unlimited;
pub use retrieve::proxied;

use napi_derive::napi;

/// Logs a message in Rust and returns the input value doubled.
/// Used by the TS FFI bridge (`logAndDouble`).
#[napi]
pub fn log_and_double(msg: String, value: i32) -> i32 {
    println!("[Rust FFI] {}", msg);
    value * 2
}

/// Returns the Cargo package version as a string.
/// Used by the TS FFI bridge (`getVersion`).
#[napi]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub mod markets {
    pub mod nasdaq {
        pub mod api_nasdaq_unlimited;
        pub mod datafeeds {
            pub mod streaming {
                pub mod yahoo {
                    pub mod yahoo_streamer;
                    pub mod yahoo_streaming_proto_handler;
                    pub use yahoo_streamer::{
                        EventRecord, LogRecord, RustCallbacks, YahooConfig, YahooStreaming,
                        YahooStreamingCore,
                    };
                }
            }
        }
    }
}

pub use markets::nasdaq::api_nasdaq_unlimited::{
    get_nasdaq_headers, nasdaq_end_point, nasdaq_end_points,
};

pub use markets::nasdaq::datafeeds::streaming::yahoo::{
    EventRecord, LogRecord, RustCallbacks, YahooConfig, YahooStreaming, YahooStreamingCore,
};
