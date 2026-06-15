// Gated to non-loom builds — it links `corelib-rust`, whose tokio-net deps cannot
// compile under the global `--cfg loom` flag (see Cargo.toml).
#![cfg(not(loom))]
//! Cluster 2 — Lifecycle / Shutdown probe (Epic 5, Phase 2, Task 2.3).
//!
//! TARGET: `rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs` — `Drop` impl
//! (stop_tx.try_send + monitor_task.abort + pump_task.abort).
//!
//! INVARIANT: creating a `WebsocketStreamerHost`, starting it with a driver whose TCP
//! connect ALWAYS fails (port 1 → connection refused, so the supervisor is churning in
//! its connect→fail→reconnect-sleep→retry loop), and immediately dropping the host must
//! NEVER deadlock, segfault, or leak a thread — regardless of where the supervisor is in
//! that loop at drop time. Crash/hang is a binary hard-gate critical (spec).
//!
//! DESIGN:
//!   - 30s hard watchdog thread: if the process hasn't exited by then, the loop is hung
//!     → print `PROBE_CONFIRMED shutdown-exit reason=watchdog-timeout` + `process::abort()`.
//!   - 50 iterations: create host → start (against the dead port) → 20ms (let the
//!     supervisor attempt+fail+enter the reconnect sleep) → drop → 5ms yield.
//!   - Clean completion prints `PROBE_CLEAN shutdown-exit iterations=50`. The Epic-4 Drop
//!     is well-designed, so CLEAN is expected; a hang/segfault would be the durable repro.

use corelib_rust::markets::nasdaq::datafeeds::streaming::alpaca::alpaca_driver::AlpacaDriver;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn install_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(30));
        // If we are still alive after 30s, an iteration's create/start/drop deadlocked.
        eprintln!("PROBE_CONFIRMED shutdown-exit reason=watchdog-timeout");
        std::process::abort();
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_exit_under_load() {
    install_watchdog();
    let events = Arc::new(AtomicU64::new(0));
    const ITERS: usize = 50;

    for _ in 0..ITERS {
        let mut host = WebsocketStreamerHost::new(
            unique_db_path("shutdown_probe", "PROBE_DB"),
            "alpaca_subscriptions",
            "probe".into(),
            ProviderKind::Alpaca,
        )
        .expect("host new");

        let driver = AlpacaDriver {
            name: "probe".into(),
            base_url: Some("ws://127.0.0.1:1".into()), // port 1 → connect always refused
            key_id: "k".into(),
            secret_key: "s".into(),
            silence_seconds: 60,
            db: host.db_handle(),
            table: host.table_name(),
        };

        let ev = Arc::clone(&events);
        host.start(driver, Vec::new(), ReconnectPolicy::default(), move |_e| {
            ev.fetch_add(1, Ordering::Relaxed);
        });

        // Let the supervisor attempt the (failing) connect and enter its reconnect sleep,
        // so the drop lands mid-churn.
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(host); // Drop: stop_tx.try_send + monitor.abort + pump.abort
        tokio::time::sleep(Duration::from_millis(5)).await; // yield so aborted tasks unwind
    }

    // Reaching here means every create/start/drop completed without deadlock or segfault.
    println!(
        "PROBE_CLEAN shutdown-exit iterations={ITERS} status_events={}",
        events.load(Ordering::Relaxed)
    );
}
