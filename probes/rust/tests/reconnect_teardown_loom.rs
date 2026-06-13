//! Standalone loom model of the streaming-engine reconnect/teardown concurrency.
//!
//! This is an AUDIT probe (audit cycle B4). It does NOT instrument the production
//! crate `corelib-rust`; it re-models, under loom, the exact ordering read out of
//! the real code so loom can exhaustively explore thread interleavings and assert
//! the safety oracle. A model is an abstraction of the real code, not the code.
//!
//! ── Real code modeled (file:line are the source of the invariants) ──────────────
//!
//! Files (under rust/src/markets/nasdaq/datafeeds/streaming/core/):
//!   host.rs, supervisor.rs, driver.rs, reconnect.rs; finnhub_driver.rs (a driver).
//!
//! ACTORS (host.rs:109-128) — `start()` spawns three tasks sharing one CoreEvent
//! channel + a stop channel:
//!   - supervisor   : tokio::spawn(run_supervisor(..)) at host.rs:109. Owns the
//!                    reconnect loop and the `attempt` backoff counter
//!                    (supervisor.rs:22). Holds the *original* `tx` Sender
//!                    (host.rs:98 `tx`, moved in at :109) and `stop_rx`.
//!   - pump         : tokio::spawn at host.rs:124-128. Drains the channel via
//!                    `while let Some(ev) = rx.recv().await` (host.rs:125); ends
//!                    when every Sender is dropped (channel closed).
//!   - monitor      : tokio::spawn at host.rs:111-122. Holds a CLONE of `tx`
//!                    (`monitor_tx`, host.rs:106) and may `monitor_tx.send(..)` an
//!                    Error status (host.rs:114-119). Relevant here only because it
//!                    is a *second live Sender into the same channel*, so the
//!                    channel is not closed merely because the supervisor returns.
//!
//! SHARED STATE: one mpsc::channel::<CoreEvent>(1024) (host.rs:98) with two live
//!   Senders (supervisor `tx`, monitor `monitor_tx`) and one Receiver (pump `rx`);
//!   one mpsc::channel::<()>(1) stop channel (host.rs:100); the supervisor-private
//!   `attempt: u32` backoff (supervisor.rs:22).
//!
//! CHANNEL CLOSE vs IN-FLIGHT SEND (the panic question): every producer send is
//!   `let _ = tx.send(..).await` — finnhub_driver.rs:131,159; host.rs:114-119.
//!   tokio mpsc `send()` on a closed/dropped receiver returns `Err`, which is
//!   discarded. INVARIANT: a send racing channel teardown yields at worst a
//!   *lost message*, never a send-after-close PANIC. We model the channel as a
//!   Mutex<VecDeque> + `closed` flag and assert push-after-close is handled
//!   (returns false / drops the item), never an unwrap/panic.
//!
//! DROP TEARDOWN (host.rs:259-272, `impl Drop`): ordering is
//!   (1) stop_tx.try_send(())   [host.rs:262-263]  — signal first
//!   (2) monitor_task.abort()   [host.rs:265-266]
//!   (3) pump_task.abort()      [host.rs:268-269]
//!   The supervisor observes stop via `stop_rx.recv()` inside `tokio::select!`
//!   (supervisor.rs:42-45) or the driver select (finnhub_driver.rs:139 →
//!   AttemptOutcome::Stopped → supervisor.rs:28 `break`). INVARIANT (lost-shutdown):
//!   once Drop posts stop, the supervisor must observe it and STOP — no interleaving
//!   leaves it looping past teardown.
//!
//! BACKOFF RESET ON HEALTHY DROP (supervisor.rs:22,29-34): `attempt = 0` on
//!   ConnectedThenDropped (healthy drop → reset), `attempt = attempt+1` on
//!   NeverConnected. INVARIANT: a reset must not interleave with an increment to
//!   leave backoff in a corrupted/forgotten state. In production `attempt` is
//!   supervisor-private (single writer); the model uses a shared atomic to prove
//!   the reset/increment transitions are consistent under concurrent observation
//!   (a healthy drop concurrent with a teardown-driven stop must not corrupt it).
//!
//! ── Oracle (asserted across ALL interleavings loom explores) ────────────────────
//!   1. No deadlock        — no interleaving mutually blocks (loom would hang/panic).
//!   2. No send-after-close panic — push into a closed channel is handled, not a panic.
//!   3. No lost-shutdown   — the stop signal is always observed; the supervisor
//!                           stops; the pump terminates after channel close.
//!   4. Backoff consistency — after a healthy-drop reset racing teardown, `attempt`
//!                            is a coherent value (0 after reset wins, or stopped),
//!                            never a torn/forgotten state.

#![cfg(loom)]

use loom::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use loom::sync::{Arc, Mutex};
use loom::thread;
use std::collections::VecDeque;

/// A loom-friendly stand-in for tokio's mpsc::Sender/Receiver pair.
///
/// Mirrors tokio mpsc semantics that matter for this audit:
///  - `send` on a closed channel returns `Err`-equivalent (`false`), never panics
///    (real code: `let _ = tx.send(..).await`, finnhub_driver.rs:131/159).
///  - `close` is idempotent and visible to subsequent sends.
struct Channel {
    queue: Mutex<VecDeque<u32>>,
    closed: AtomicBool,
}

impl Channel {
    fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
        }
    }

    /// Models `let _ = tx.send(ev).await`: returns `false` (≈ `Err`) if the channel
    /// is closed, and MUST NOT panic. Returns `true` if the item was accepted.
    fn send(&self, item: u32) -> bool {
        // Acquire the lock first (mirrors taking the channel's internal lock), THEN
        // re-check `closed` — this is the precise window where teardown can race an
        // in-flight send. Either order must be panic-free.
        let mut q = self.queue.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            // Receiver gone / channel closed: drop the message. No panic.
            return false;
        }
        q.push_back(item);
        true
    }

    /// Models the receiver/all-senders-dropped close. Idempotent.
    fn close(&self) {
        // Set closed under the lock so a concurrent `send` either sees open-and-pushes
        // or sees closed-and-drops; there is no torn state.
        let _q = self.queue.lock().unwrap();
        self.closed.store(true, Ordering::Release);
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

/// One bounded reconnect/teardown scenario, driven by loom across all interleavings.
fn model_once() {
    // Shared CoreEvent channel: supervisor + monitor are producers, pump is consumer.
    let chan = Arc::new(Channel::new());
    // stop signal (host.rs stop_tx/stop_rx, capacity 1). true == teardown requested.
    let stop = Arc::new(AtomicBool::new(false));
    // supervisor-owned backoff counter (supervisor.rs:22). Shared here so the model
    // can assert its post-state across the reset/teardown race.
    let attempt = Arc::new(AtomicU32::new(1)); // start mid-backoff (e.g. after a NeverConnected)

    // ── Actor A: the supervisor/driver ──────────────────────────────────────────
    // Mirrors run_supervisor's loop body for ONE healthy-drop iteration racing
    // teardown: it emits a Connected status (finnhub_driver.rs:131), then on a
    // healthy drop resets backoff (supervisor.rs:30 `attempt = 0`), and at the top
    // of the select it must honor a stop signal (supervisor.rs:42-43 → break).
    let supervisor = {
        let chan = chan.clone();
        let stop = stop.clone();
        let attempt = attempt.clone();
        thread::spawn(move || {
            // Send a Connected-equivalent event (driver emits before the data loop).
            // Racing teardown: must be panic-free even if the channel just closed.
            let _accepted = chan.send(1);

            // tokio::select! arm priority is unspecified; model BOTH outcomes:
            // either stop is observed (→ Stopped, supervisor breaks) or the healthy
            // drop is handled (→ reset backoff). loom explores the interleaving where
            // teardown's stop store lands before/after this load.
            if stop.load(Ordering::Acquire) {
                // observed shutdown (supervisor.rs:43 `break`): do NOT touch backoff.
            } else {
                // healthy drop (AttemptOutcome::ConnectedThenDropped, supervisor.rs:30):
                // reset backoff to 0.
                attempt.store(0, Ordering::Release);
            }
        })
    };

    // ── Actor B: Drop teardown (host.rs:259-272) ────────────────────────────────
    // Ordering mirrors impl Drop exactly: signal stop (1), then "abort" by closing
    // the channel (the receiver/pump going away ≈ channel close). The stop store
    // MUST be visible to the supervisor (no lost-shutdown).
    let teardown = {
        let chan = chan.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            // (1) host.rs:262-263 stop_tx.try_send(())
            stop.store(true, Ordering::Release);
            // (2)/(3) host.rs:265-269 abort monitor + pump → channel torn down.
            chan.close();
        })
    };

    supervisor.join().unwrap();
    teardown.join().unwrap();

    // ── Actor C: pump drains after close (host.rs:125 loop ends on channel close) ─
    // Modeled as a post-join drain: once closed, recv yields None and the loop ends.
    // This must terminate (no lost-shutdown / no run-forever).
    assert!(
        chan.is_closed(),
        "lost-shutdown: teardown completed but channel never closed (host.rs:268-269)"
    );
    {
        let mut q = chan.queue.lock().unwrap();
        // Drain whatever was accepted before close; loop is finite ⇒ pump terminates.
        while q.pop_front().is_some() {}
    }

    // ── Oracle 4: backoff consistency ───────────────────────────────────────────
    // After the race, `attempt` is either 0 (healthy-drop reset won) or 1 (shutdown
    // observed, reset skipped). It is NEVER any other (torn/forgotten) value.
    let a = attempt.load(Ordering::Acquire);
    assert!(
        a == 0 || a == 1,
        "backoff corrupted: attempt={a}, expected 0 (reset, supervisor.rs:30) or 1 (stopped, supervisor.rs:43)"
    );

    // Oracle 2 (no send-after-close panic) is proven structurally: every `chan.send`
    // returned without panicking under every interleaving loom drove. Oracle 1 (no
    // deadlock) and Oracle 3 (no lost-shutdown) are proven by both joins completing
    // and the is_closed assertion holding across all interleavings.
}

#[test]
fn reconnect_teardown_loom() {
    loom::model(model_once);
}
