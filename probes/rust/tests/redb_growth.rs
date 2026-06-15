// Gated to non-loom builds — links `corelib-rust` (tokio-net deps don't compile under --cfg loom).
#![cfg(not(loom))]
//! Cluster 3 — redb growth probe (Epic 5, Phase 3, Task 3.3, down-weighted).
//!
//! TARGET: `core/host.rs` `subscribe_channel` / `unsubscribe_channel` (redb persist/delete).
//!
//! INVARIANT: subscribe/unsubscribe churn must NOT grow the redb file unboundedly. redb is a
//! copy-on-write B-tree that reuses free pages within the file, so churning a small subscription
//! table (insert then delete the same composite keys) should keep the file bounded after the initial
//! page allocations — not grow linearly with the number of churn cycles.
//!
//! Expected: `PROBE_CLEAN` (low-churn store). A linear/unbounded file growth would be `PROBE_CONFIRMED`.

use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;

#[test]
fn redb_growth_bounded() {
    let path = unique_db_path("redb_growth", "PROBE_DB");
    let host = WebsocketStreamerHost::new(
        path.clone(),
        "alpaca_subscriptions",
        "probe".into(),
        ProviderKind::Alpaca,
    )
    .expect("host new");

    // Allocate the table + take the post-first-write size as the baseline (excludes one-time table
    // creation pages, so the delta isolates churn-driven growth).
    host.subscribe_channel("trades", vec!["AAPL".into()]);
    let size_baseline = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    const ITERS: usize = 2000;
    for i in 0..ITERS {
        let sym = format!("SYM{}", i % 50); // small working set, churned repeatedly
        host.subscribe_channel("trades", vec![sym.clone()]);
        host.unsubscribe_channel("trades", vec![sym]);
    }

    let size_final = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let growth_mb = size_final.saturating_sub(size_baseline) as f64 / (1024.0 * 1024.0);

    if growth_mb > 5.0 {
        println!("PROBE_CONFIRMED redb-growth growth_mb={growth_mb:.3} final_bytes={size_final} iters={ITERS}");
    } else {
        println!("PROBE_CLEAN redb-growth growth_mb={growth_mb:.3} final_bytes={size_final} iters={ITERS}");
    }

    // Hard assertion: 2000 churn cycles of a 50-symbol working set must not grow the file unboundedly.
    assert!(
        growth_mb < 50.0,
        "redb file grew {growth_mb:.3} MB over {ITERS} churn cycles — free pages not reused (unbounded growth)"
    );
}
