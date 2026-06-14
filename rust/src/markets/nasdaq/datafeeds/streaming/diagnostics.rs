//! Diagnostics: env-gated native-thread flood hook to VALIDATE TSFN inbound delivery under
//! GC reentrancy (the top audit residual). Production no-op unless CORELIB_DIAG_FLOOD=1.
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// Floods `on_event` with `count` synthetic JSON-string events from a dedicated native thread.
/// Mirrors the real `on_market_event` interface (`ThreadsafeFunction<String>`, error-first
/// delivery → JS sees `(null, jsonString)`). Gated behind `CORELIB_DIAG_FLOOD=1` so the symbol
/// is always exported (stable index.d.ts) but does nothing in production.
#[napi]
pub fn napi_trigger_diagnostic_flood(
    count: u32,
    on_event: ThreadsafeFunction<String>,
) -> napi::Result<()> {
    if std::env::var("CORELIB_DIAG_FLOOD").unwrap_or_default() != "1" {
        return Ok(()); // production no-op
    }
    std::thread::spawn(move || {
        // Blocking delivery guarantees backpressure so no events are dropped. The call result is
        // intentionally ignored: on teardown the TSFN may be Closing/InvalidArg, and we must never
        // unwrap/panic on those non-Ok statuses.
        for i in 0..count {
            let ev = format!("{{\"seq\":{i}}}"); // synthetic event as a JSON string
            let _ = on_event.call(Ok(ev), ThreadsafeFunctionCallMode::Blocking);
        }
    });
    Ok(())
}
