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

fn loadgen_enabled() -> bool {
    std::env::var("CORELIB_LOADGEN").unwrap_or_default() == "1"
}

/// Parametric in-process synthetic load generator (Epic 5 audit instrument). Emits synthetic JSON
/// ticks straight from a native thread → TSFN (no socket), supporting steady and bursty modes.
/// Gated behind `CORELIB_LOADGEN=1` so the symbol is always exported but does nothing in production.
/// TEST-ONLY: this must never be wired onto the real streaming pump.
#[napi]
pub fn napi_load_generator(
    rate_per_sec: u32,
    duration_ms: u32,
    bursty: bool, // false = steady; true = recurrent spike→idle→gc-window cycles
    on_event: ThreadsafeFunction<String>,
) -> napi::Result<()> {
    if !loadgen_enabled() {
        return Ok(()); // production no-op
    }
    std::thread::spawn(move || {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(duration_ms as u64);
        let mut seq: u64 = 0;
        while std::time::Instant::now() < deadline {
            if bursty {
                // spike: emit one second's worth fast, then idle 200ms to let the loop drain + GC
                for _ in 0..rate_per_sec {
                    seq += 1;
                    crate::observability::latency::mark_sent(seq);
                    let _ = on_event.call(
                        Ok(synthetic_tick(seq)),
                        ThreadsafeFunctionCallMode::Blocking,
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            } else {
                // steady: pace to rate_per_sec
                let per = std::time::Duration::from_micros(1_000_000 / rate_per_sec.max(1) as u64);
                seq += 1;
                crate::observability::latency::mark_sent(seq);
                let _ = on_event.call(
                    Ok(synthetic_tick(seq)),
                    ThreadsafeFunctionCallMode::Blocking,
                );
                std::thread::sleep(per);
            }
        }
    });
    Ok(())
}

fn synthetic_tick(seq: u64) -> String {
    // shaped like a real pricing payload but carrying a sequence id for loss/latency accounting
    format!("{{\"seq\":{seq},\"symbol\":\"TEST\",\"price\":1.0,\"ts\":0}}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_generator_gated() {
        // SAFETY: single-threaded test; we set then clear the gate var.
        std::env::remove_var("CORELIB_LOADGEN");
        assert!(
            !loadgen_enabled(),
            "must be disabled when CORELIB_LOADGEN unset"
        );
        std::env::set_var("CORELIB_LOADGEN", "1");
        assert!(loadgen_enabled(), "must be enabled when CORELIB_LOADGEN=1");
        std::env::remove_var("CORELIB_LOADGEN");
    }
}
