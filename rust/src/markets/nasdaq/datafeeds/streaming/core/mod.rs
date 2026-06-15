//! Shared trait-backed streaming engine used by all providers.
//!
//! ENGINE/ADAPTER BOUNDARY (Phase A): the files in this module + the three
//! `*_driver.rs` + `yahoo_streaming_proto_handler.rs` are the napi-free engine. They
//! must contain no direct `napi` use — the only permitted napi mention is the
//! `#[cfg_attr(feature = "napi", …)]` derive on the wire payload types. This is enforced
//! by `rust/tests/streaming_boundary_lint.rs`. The `*_streamer.rs` facades + `diagnostics.rs`
//! are the napi adapter. The future `corelib-streaming` crate lift moves this engine set out
//! verbatim (it already builds napi-free with `--no-default-features`).
pub mod driver;
pub mod host;
pub mod reconnect;
pub mod schema;
pub mod supervisor;
pub mod types;
