use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// Dump the in-memory flight-recorder ring to JS, one entry per call.
/// Gated behind CORELIB_FLIGHT_LOG=1 (production no-op), mirroring
/// napi_trigger_diagnostic_flood. Draining is lock-free.
#[napi]
pub fn napi_dump_flight_log(on_entry: ThreadsafeFunction<String>) -> napi::Result<()> {
	if std::env::var("CORELIB_FLIGHT_LOG").unwrap_or_default() != "1" {
		return Ok(()); // gated no-op
	}
	for line in crate::observability::ring_buffer::drain_to_lines() {
		let _ = on_entry.call(Ok(line), ThreadsafeFunctionCallMode::NonBlocking);
	}
	Ok(())
}
