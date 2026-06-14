//! In-memory ring-buffer flight recorder for the streaming/FFI hot path.
//! Lock-free (crossbeam ArrayQueue), zero I/O under nominal operation;
//! dumps the last N structured events on panic or an env-gated napi signal.
pub mod layer;
pub mod napi_dump;
pub mod ring_buffer;

pub use layer::init_flight_recorder;
