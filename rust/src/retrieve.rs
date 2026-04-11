// =============================================
// FILE: rust/src/retrieve.rs
// PURPOSE: Retrieve module index / barrel file
// Re-exports everything from the retrieve section.
// =============================================

/// A Rust HTTP client that mimics the `ky` API for ergonomics.
pub mod ky;

// Re-export the public API so users can write:
// use corelib_rust::retrieve::ky;
pub use ky::{delete, get, patch, post, put, Ky, KyError, KyRequestBuilder, KyResponse};
