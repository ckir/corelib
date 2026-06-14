// Gated to non-loom builds — it links `corelib-rust`, whose tokio-net deps cannot
// compile under the global `--cfg loom` flag (see Cargo.toml).
#![cfg(not(loom))]
//! B3 Z-Engine concurrent-redb stress probe (pure-Rust vehicle).
//!
//! VEHICLE CHOICE: pure Rust against the `corelib-rust` rlib. The redb open /
//! persist / load logic lives on `WebsocketStreamerHost` as `pub` items that do
//! NOT require a napi `Env` or JS TSFNs to construct (`new` only opens redb;
//! `start()` is the only method that needs tokio drivers/TSFNs, and we never
//! call it). So we drive the REAL code path directly. This exercises more real
//! code than a JS child would, with no native-addon build needed.
//!
//! Target: rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs
//!   - host.rs:20  unique_db_path  (Q1: default-collision question)
//!   - host.rs    Database::create(..).map_err(HostError::DbOpen)?  (Q3: fallible open, no abort)
//!   - host.rs:72  get_persisted_subscriptions (load)
//!   - host.rs:132 subscribe (persist + push)  (Q2: concurrent persist/load)
//!
//! Budget: <20s total. Prints `PROBE_CONFIRMED <detail>` on any violated
//! invariant (an oracle hit).

use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, HostError, WebsocketStreamerHost,
};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

fn mk_host(path: std::path::PathBuf) -> WebsocketStreamerHost {
    WebsocketStreamerHost::new(path, "probe_subscriptions", "probe".into(), ProviderKind::Alpaca)
        .expect("probe host open")
}

// ---------------------------------------------------------------------------
// Q1: does the DEFAULT unique_db_path prevent same-path collision between
// concurrent hosts? Concurrently generate many default paths and assert all
// distinct. (pid is constant within a process, so this stresses the seq+nanos
// disambiguation that must carry uniqueness for same-process concurrency.)
// ---------------------------------------------------------------------------
#[test]
fn q1_default_unique_db_path_never_collides() {
    let t0 = Instant::now();
    const THREADS: usize = 16;
    const PER: usize = 2000;
    let mut handles = Vec::new();
    for _ in 0..THREADS {
        handles.push(std::thread::spawn(|| {
            let mut v = Vec::with_capacity(PER);
            for _ in 0..PER {
                v.push(unique_db_path("ALPACA", "ALPACA_DB_UNSET_PROBE"));
            }
            v
        }));
    }
    let mut all: Vec<std::path::PathBuf> = Vec::new();
    for h in handles {
        all.extend(h.join().unwrap());
    }
    let total = all.len();
    let uniq: HashSet<_> = all.iter().collect();
    let collisions = total - uniq.len();
    if collisions > 0 {
        println!(
            "PROBE_CONFIRMED q1 default unique_db_path COLLIDES: {collisions} dup(s) out of {total}"
        );
    } else {
        println!(
            "q1 CLEAN: {total} concurrent default paths, 0 collisions (seq atomic + pid + nanos)"
        );
    }
    assert_eq!(collisions, 0, "default unique_db_path collided");
    eprintln!("[q1] {:?}", t0.elapsed());
}

// ---------------------------------------------------------------------------
// Q2: concurrency safety of persist (subscribe) + load (get_persisted_subscriptions)
// against the SAME host's redb (shared Arc<Database>). redb is MVCC: many
// concurrent readers + serialized writers. We hammer concurrent writers and
// readers and assert: no panic, no partial/corrupt read, no lost subscription.
// ---------------------------------------------------------------------------
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn q2_concurrent_persist_and_load_is_consistent() {
    let t0 = Instant::now();
    let path = unique_db_path("ALPACA_Q2", "ALPACA_DB_UNSET_PROBE");
    let host = Arc::new(mk_host(path.clone()));

    const WRITERS: usize = 8;
    const PER_WRITER: usize = 64;

    // Each writer owns a disjoint key namespace so the FINAL expected set is
    // deterministic regardless of interleaving.
    let mut writer_tasks = Vec::new();
    for w in 0..WRITERS {
        let h = Arc::clone(&host);
        writer_tasks.push(tokio::spawn(async move {
            for i in 0..PER_WRITER {
                h.subscribe(vec![format!("W{w}_S{i}")]).await;
            }
        }));
    }

    // Concurrent readers running WHILE writers commit: must never panic and must
    // only ever observe a coherent (committed) prefix — never a torn key.
    let mut reader_tasks = Vec::new();
    for _ in 0..6 {
        let h = Arc::clone(&host);
        reader_tasks.push(tokio::spawn(async move {
            let mut max_seen = 0usize;
            for _ in 0..200 {
                let subs = h.get_persisted_subscriptions();
                // Every key must be well-formed "W<d>_S<d>" — a torn/partial read
                // would surface as a malformed or duplicated key.
                let mut local = HashSet::new();
                for s in &subs {
                    assert!(
                        s.starts_with('W') && s.contains("_S"),
                        "torn/corrupt key observed: {s:?}"
                    );
                    assert!(local.insert(s.clone()), "duplicate key in single read: {s:?}");
                }
                max_seen = max_seen.max(subs.len());
                tokio::task::yield_now().await;
            }
            max_seen
        }));
    }

    for t in writer_tasks {
        t.await.expect("writer task panicked");
    }
    for t in reader_tasks {
        t.await.expect("reader task panicked");
    }

    // Final consistency: ALL keys present exactly once, none lost, none dup'd.
    let final_subs = host.get_persisted_subscriptions();
    let final_set: HashSet<_> = final_subs.iter().cloned().collect();
    let expected: HashSet<String> = (0..WRITERS)
        .flat_map(|w| (0..PER_WRITER).map(move |i| format!("W{w}_S{i}")))
        .collect();

    let lost: Vec<_> = expected.difference(&final_set).cloned().collect();
    let dup_count = final_subs.len() - final_set.len();
    let unexpected: Vec<_> = final_set.difference(&expected).cloned().collect();

    let mut violated = false;
    if !lost.is_empty() {
        println!(
            "PROBE_CONFIRMED q2 LOST subscriptions: {} missing (e.g. {:?})",
            lost.len(),
            &lost[..lost.len().min(3)]
        );
        violated = true;
    }
    if dup_count > 0 {
        println!("PROBE_CONFIRMED q2 DUPLICATED subscriptions: {dup_count} dup(s)");
        violated = true;
    }
    if !unexpected.is_empty() {
        println!("PROBE_CONFIRMED q2 CORRUPT/unexpected keys: {unexpected:?}");
        violated = true;
    }
    if !violated {
        println!(
            "q2 CLEAN: {} writers x {} keys persisted+loaded under concurrency; \
             0 lost / 0 dup / 0 corrupt; final={} expected={}",
            WRITERS,
            PER_WRITER,
            final_set.len(),
            expected.len()
        );
    }
    assert!(lost.is_empty(), "lost subscriptions under concurrency");
    assert_eq!(dup_count, 0, "duplicate subscriptions");
    assert!(unexpected.is_empty(), "corrupt/unexpected keys");
    eprintln!("[q2] {:?}", t0.elapsed());
}

// ---------------------------------------------------------------------------
// Q3: deterministically reproduce the host.rs:57 panic by forcing TWO opens on
// ONE redb path in-process (the env-shared-path scenario). The second
// Database::create on a still-open path returns redb DatabaseAlreadyOpen, which
// `Database::create` now returns `Err(DatabaseError)` which is propagated as
// `Err(HostError::DbOpen(_))` — no panic/abort.
// ---------------------------------------------------------------------------
#[test]
fn q3_shared_path_double_open_errors() {
    let t0 = Instant::now();
    let path = unique_db_path("ALPACA_Q3", "ALPACA_DB_UNSET_PROBE");

    // First open succeeds and is HELD (mirrors a live host holding the env-shared file).
    let _first = mk_host(path.clone());

    // Second open on the SAME still-open path must now return Err (no panic/abort).
    let res = WebsocketStreamerHost::new(
        path.clone(),
        "probe_subscriptions",
        "probe".into(),
        ProviderKind::Alpaca,
    );
    assert!(
        matches!(res, Err(HostError::DbOpen(_))),
        "expected Err(HostError::DbOpen) on shared-path double-open (no abort)"
    );
    println!("PROBE_CONFIRMED q3 shared-path double-open returns Err(DbOpen), no abort");
    eprintln!("[q3] {:?}", t0.elapsed());
}
