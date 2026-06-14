//! Test-only roundtrip-token latency accounting for the Epic 5 audit load generator.
//!
//! LOCK-FREE, ZERO-ALLOC. The load generator (`napi_load_generator`) calls `mark_sent(seq)` as it
//! emits tick `seq`; JS calls `napi_latency_ack(seq)` immediately on receipt; elapsed micros are
//! computed Rust-side against the SAME `Instant` epoch and pushed into a lock-free `ArrayQueue<u64>`.
//! NEVER subtract Node's clock from Rust's. `seq` is a monotonic u64 indexing a fixed atomic-slot
//! array (power-of-two mask = modulo); SLOTS far exceeds in-flight count so collisions are negligible
//! for statistical latency.
//!
//! TEST-ONLY: this accounting must NEVER be wired onto the real production streaming pump. It exists
//! solely to measure the synthetic load generator.
use crossbeam_queue::ArrayQueue;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

const SLOTS: usize = 1 << 20; // 1,048,576
static EPOCH: OnceLock<Instant> = OnceLock::new();
static SENT_US: OnceLock<Box<[AtomicU64]>> = OnceLock::new(); // per-slot send time, micros-since-EPOCH (0 = empty)
static SAMPLES: OnceLock<ArrayQueue<u64>> = OnceLock::new(); // elapsed micros

fn epoch() -> &'static Instant {
    EPOCH.get_or_init(Instant::now)
}
fn sent_us() -> &'static [AtomicU64] {
    SENT_US.get_or_init(|| (0..SLOTS).map(|_| AtomicU64::new(0)).collect())
}
fn samples() -> &'static ArrayQueue<u64> {
    SAMPLES.get_or_init(|| ArrayQueue::new(65536))
}

pub fn mark_sent(seq: u64) {
    let us = epoch().elapsed().as_micros() as u64;
    sent_us()[(seq as usize) & (SLOTS - 1)].store(us.max(1), Ordering::Relaxed); // never store 0 (= empty sentinel)
}

/// JS calls this immediately on receipt of tick `seq`. All timing is Rust-side vs the SAME EPOCH `Instant`.
#[napi]
pub fn napi_latency_ack(seq: i64) {
    let now = epoch().elapsed().as_micros() as u64;
    let start = sent_us()[(seq as usize) & (SLOTS - 1)].swap(0, Ordering::Relaxed);
    if start != 0 {
        let _ = samples().force_push(now.saturating_sub(start));
    }
}

/// Drain samples to JS for percentile computation (env-gated, like the flight dump).
#[napi]
pub fn napi_latency_drain(on_sample: ThreadsafeFunction<f64>) -> napi::Result<()> {
    if std::env::var("CORELIB_LOADGEN").unwrap_or_default() != "1" {
        return Ok(());
    }
    while let Some(us) = samples().pop() {
        let _ = on_sample.call(Ok(us as f64), ThreadsafeFunctionCallMode::NonBlocking);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_ack_roundtrip_records_a_sample() {
        // pick a seq unlikely to collide with other tests
        let seq = 123_456_u64;
        mark_sent(seq);
        napi_latency_ack(seq as i64);
        // a sample must now be drainable; pop it directly (drain is env-gated)
        assert!(samples().pop().is_some(), "ack after mark_sent must record a sample");
    }

    #[test]
    fn ack_without_mark_records_nothing() {
        let seq = 987_654_u64;
        // ensure slot empty
        sent_us()[(seq as usize) & (SLOTS - 1)].store(0, Ordering::Relaxed);
        let before = samples().len();
        napi_latency_ack(seq as i64);
        assert_eq!(samples().len(), before, "ack without mark_sent must not record");
    }
}
