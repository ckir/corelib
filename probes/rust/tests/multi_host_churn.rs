// Gated to non-loom builds — links `corelib-rust` (tokio-net deps don't compile under --cfg loom).
#![cfg(not(loom))]
//! Cluster 2 — Multi-host churn probe (Epic 5, Phase 2, Task 2.4).
//!
//! TARGET: `core/host.rs` lifecycle (`new` → `start` → `Drop`) + `unique_db_path` redb isolation.
//!
//! INVARIANT: rapidly creating, starting (against a dead port → reconnect churn), and dropping
//! ~1000 `WebsocketStreamerHost` instances must NOT cascade redb locks (each instance gets a unique
//! redb path → no `DatabaseAlreadyOpen` process-abort), exhaust OS file/socket handles, or grow
//! resources unboundedly. Completing the full loop without panic/abort/OOM is the bound: 1000 hosts
//! with leaked redb files or fds would abort or exhaust handles long before the end.
//!
//! PARTIAL-FAILURE NOTE: the plan's "one driver Fatal while another streams" variant needs live
//! frame delivery, which the loopback harness cannot exercise (finding `probe-harness-loopback-no-delivery`).
//! This probe therefore validates the independent-instance churn + redb isolation (the resource side of
//! partial-failure: one failing host must not affect another's creation/teardown); the streaming-side
//! partial-failure is deferred to a delivery-capable environment.
//!
//! DESIGN: 120s watchdog (1000 iterations of redb-file create + tokio spawn/abort is I/O-heavy);
//! `PROBE_CLEAN multi-host-churn iterations=1000` on clean completion.

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
        std::thread::sleep(Duration::from_secs(120));
        eprintln!("PROBE_CONFIRMED multi-host-churn reason=watchdog-timeout");
        std::process::abort();
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multi_host_churn() {
    install_watchdog();
    let events = Arc::new(AtomicU64::new(0));
    const ITERS: usize = 1000;

    for i in 0..ITERS {
        let mut host = WebsocketStreamerHost::new(
            unique_db_path("churn_probe", "PROBE_DB"),
            "alpaca_subscriptions",
            "probe".into(),
            ProviderKind::Alpaca,
        )
        .unwrap_or_else(|e| panic!("host new failed at iter {i}: {e:?}")); // a redb-lock cascade surfaces here

        let driver = AlpacaDriver {
            name: "probe".into(),
            base_url: Some("ws://127.0.0.1:1".into()), // connect always refused → reconnect churn
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

        // Brief: let the supervisor spawn + attempt the (failing) connect, then drop mid-churn.
        tokio::time::sleep(Duration::from_millis(3)).await;
        drop(host);
    }

    // Reaching here means 1000 independent host lifecycles completed with no redb-lock cascade,
    // no handle exhaustion, and no deadlock/OOM.
    println!(
        "PROBE_CLEAN multi-host-churn iterations={ITERS} status_events={}",
        events.load(Ordering::Relaxed)
    );
}
