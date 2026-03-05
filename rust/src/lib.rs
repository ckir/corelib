// =============================================
// FILE: rust/src/lib.rs
// PURPOSE: Your requested FFI example
// Accepts parameters from TS, logs a message, returns a value (doubled)
// Logger callback can be added later via ThreadsafeFunction
// =============================================

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn log_and_double(msg: String, value: i32) -> i32 {
    println!("[Rust FFI] {}", msg);
    value * 2
}

#[napi]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
