//! Cross-process redb collision probe (fork E1 — VALIDATION ONLY, no production change).
//! Validates Task 4's fallible `WebsocketStreamerHost::new`: a SECOND process opening a redb
//! path already held by a FIRST process must NOT abort — it returns a `Result`. We also REPORT
//! whether redb surfaced `Err(DbOpen)` (OS lock) or permitted a concurrent `Ok` (no cross-proc lock).
#![cfg(not(loom))]

use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{
    HostError, WebsocketStreamerHost,
};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const HOLD_ENV: &str = "REDB_XPROC_HOLD_PATH";
const TABLE: &str = "xproc_subscriptions";
const TEST_NAME: &str = "redb_cross_process_double_open_no_abort";

fn open_host(path: PathBuf) -> Result<WebsocketStreamerHost, HostError> {
    WebsocketStreamerHost::new(path, TABLE, "xproc".into(), ProviderKind::Alpaca)
}

/// RAII teardown: kill the child holder + remove the temp redb file even if an assert panics.
struct Teardown {
    child: Child,
    path: PathBuf,
}
impl Drop for Teardown {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for _ in 0..40 {
            if !self.path.exists() || std::fs::remove_file(&self.path).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[test]
fn redb_cross_process_double_open_no_abort() {
    // ---- CHILD MODE: when the holder env var is set, open+HOLD the file, then idle. ----
    if let Ok(p) = std::env::var(HOLD_ENV) {
        let _held = open_host(PathBuf::from(p)).expect("child: first cross-process open should succeed");
        println!("CHILD_READY");
        let _ = std::io::stdout().flush();
        // Hold for 30s — comfortably LONGER than the parent's 10s readiness deadline so the
        // child is guaranteed to still hold the lock whenever the parent opens, even on a slow
        // runner. No runtime cost: the parent kills us via Teardown the instant it has asserted.
        std::thread::sleep(Duration::from_secs(30));
        std::process::exit(0);
    }

    // ---- PARENT MODE ----
    // Deterministic shared path BOTH processes open. NOT `unique_db_path` (that differs per
    // process by design); unique per parent-pid so concurrent CI runs don't collide.
    let shared = std::env::temp_dir().join(format!("redb_xproc_{}.redb", std::process::id()));
    let _ = std::fs::remove_file(&shared);

    let mut child = Command::new(std::env::current_exe().expect("current_exe"))
        .args(["--exact", TEST_NAME, "--nocapture"])
        .env(HOLD_ENV, &shared)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child holder");

    // Wait for the child to signal it holds the redb file open.
    let stdout = child.stdout.take().expect("child stdout piped");
    let mut reader = BufReader::new(stdout);
    let mut ready = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut line = String::new();
    while Instant::now() < deadline {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line.contains("CHILD_READY") => {
                ready = true;
                break;
            }
            Ok(_) => continue,
            Err(_) => break,
        }
    }

    // Install teardown BEFORE asserting so the child is always reaped + temp file removed.
    let _teardown = Teardown { child, path: shared.clone() };
    assert!(ready, "child never signaled CHILD_READY (could not hold redb open)");

    // KEY: the second open on the cross-process-held path RETURNS — no process abort.
    let res = open_host(shared.clone());
    match &res {
        Err(HostError::DbOpen(e)) => {
            println!("PROBE_CONFIRMED xproc: cross-process second open returned Err(DbOpen), no abort: {e}");
        }
        Ok(_) => {
            println!("PROBE_NOTE xproc: redb PERMITTED a concurrent cross-process open (no OS-level lock); no abort — Task-4 fallibility still holds");
        }
    }
    // Universal invariant (all OSes): we got a Result back (no panic/abort). Reaching this line
    // already proves it; the shape-assert guards against future HostError variants.
    assert!(
        matches!(res, Ok(_) | Err(HostError::DbOpen(_))),
        "cross-process open did not return a recognized Result shape"
    );

    // Windows tightening: empirically confirmed (2026-06-14) that redb takes an OS-level
    // cross-process file lock on Windows ("Database already open. Cannot acquire lock.").
    // Hard-assert so a future redb version cannot silently regress to a permissive open.
    #[cfg(windows)]
    assert!(
        matches!(res, Err(HostError::DbOpen(_))),
        "Windows: cross-process double-open must surface Err(DbOpen) — redb holds an OS-level lock"
    );
}
