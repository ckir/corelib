# Streaming Engine Epic — Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Streaming Engine Epic's non-boundary work — Finnhub reconnect-resume (B1), Yahoo undecodable-frame logging (B2), and the Node↔Rust cross-runtime interop closure (B3) that Phase A's pure-Rust loopback deliberately does not cover.

**Architecture:** B1 gives `FinnhubDriver` the redb-fresh-read pattern Alpaca/Yahoo already use (driver holds the host `Arc<Database>` handle, reads persisted subs on every `connect_once`). B2 adds a structurally-redacted (length-only) debug log for frames the Yahoo mapper rejects, with an automated tracing-capture oracle. B3 writes a **deterministic, asserting** Node-`ws`-loopback test driving the real `AlpacaStreaming` addon and — if it reproduces the Epic-5 `RECEIVED=0` gap — root-causes it (Phase A having exonerated the Rust engine isolates the fault to the napi/Node boundary).

**Tech Stack:** Rust (`tokio`, `redb`, `tracing`/`tracing-subscriber`), napi 3.x, TypeScript + vitest, the existing `ws`-based `AlpacaLoopbackServer` (`probes/_harness/alpaca-loopback.mjs`). Rust gate: `cd rust && cargo test -- --test-threads=1`; `cargo clippy --all-targets -- -D warnings`.

**Prerequisite:** Phase A merged (for fault-isolation leverage in B3; B1/B2 do not depend on it and may start anytime).

---

## Source of Truth

- Spec: `docs/superpowers/specs/2026-06-15-streaming-engine-epic-phase-b-design.md`
- B1 pattern oracle: `alpaca_driver.rs` (db/table fields + `load_subscriptions`) and `alpaca_streamer.rs:164-186` (driver built with `db: g.host.db_handle(), table: g.host.table_name()`).
- B3 harness: `probes/_harness/alpaca-loopback.mjs` (`AlpacaLoopbackServer`); the TS wrapper `ts-markets/src/.../alpaca/AlpacaStreaming.ts` (EventEmitter; `init({ baseUrl, keyId, secretKey, dbPath })`; emits `"pricing"`).

## File Map

| File | Change |
|---|---|
| `rust/.../streaming/finnhub/finnhub_driver.rs` | B1: add `db`/`table` fields + `load_subscriptions()`; `connect_once` seeds from redb; tests. |
| `rust/.../streaming/finnhub/finnhub_streamer.rs` | B1: build `FinnhubDriver` with `db: g.host.db_handle(), table: g.host.table_name()`. |
| `rust/.../streaming/yahoo/yahoo_driver.rs` | B2: `note_undecodable` helper + `else` branch in pump; tracing-capture test. |
| `probes/js/alpaca-loopback-delivery.probe.test.ts` | B3: new deterministic asserting loopback delivery test. |
| `docs/superpowers/findings/2026-06-15-b3-interop-characterization.md` | B3: investigation finding (created in Task 4). |
| `ROADMAP.md` | Task 6: mark B1/B2 done; Epic closed-or-open-pending-B3. |

---

### Task 1 (B1a): `FinnhubDriver` reads subscriptions fresh from redb

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs:79-83` (struct), `:101-113` (connect_once body)
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Verify state (Step 0).** Confirm `pub struct FinnhubDriver { pub token: String, pub name: String, pub base_url: Option<String> }` (no `db`), and `connect_once` currently does `let mut current: Vec<String> = symbols.to_vec();`. Confirm `YahooDriver::load_subscriptions` (bare-key redb read) exists as the pattern to mirror. If different, STOP and report `STATE_MISMATCH`.

- [ ] **Step 2: Write the failing test.** Add to the `#[cfg(test)] mod tests` in `finnhub_driver.rs`:

```rust
    #[test]
    fn load_subscriptions_reads_bare_keys_and_unsubscribe_drops() {
        use std::sync::Arc;
        let path = std::env::temp_dir().join(format!(
            "test_finnhub_subs_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = Arc::new(redb::Database::create(path).unwrap());
        let t: redb::TableDefinition<&str, bool> =
            redb::TableDefinition::new("finnhub_subscriptions");
        // seed A + B
        {
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.insert("AAPL", true).unwrap();
                tab.insert("MSFT", true).unwrap();
            }
            w.commit().unwrap();
        }
        let d = FinnhubDriver {
            token: "tok".into(),
            name: "finnhub_main".into(),
            base_url: None,
            db: Arc::clone(&db),
            table: "finnhub_subscriptions",
        };
        let mut subs = d.load_subscriptions();
        subs.sort();
        assert_eq!(subs, vec!["AAPL".to_string(), "MSFT".to_string()]);
        // unsubscribe MSFT (committed) must NOT resurrect on the next read
        {
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.remove("MSFT").unwrap();
            }
            w.commit().unwrap();
        }
        assert_eq!(d.load_subscriptions(), vec!["AAPL".to_string()]);
    }
```

- [ ] **Step 3: Run it — verify it FAILS to compile** (no `db`/`table` fields, no `load_subscriptions`).

Run: `cd rust && cargo test --lib load_subscriptions_reads_bare_keys_and_unsubscribe_drops -- --test-threads=1`
Expected: FAIL (compile error: unknown fields `db`/`table`, no method `load_subscriptions`).

- [ ] **Step 4: Add the fields + `load_subscriptions`.** Add imports at the top of `finnhub_driver.rs` (after the existing `use` block near line 68):

```rust
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::sync::Arc;
```

Change the struct (lines 79-83) to:

```rust
pub struct FinnhubDriver {
    pub token: String,
    pub name: String,
    pub base_url: Option<String>,
    pub db: Arc<Database>,   // shared host redb handle (host.db_handle())
    pub table: &'static str, // host.table_name() — "finnhub_subscriptions"
}
```

Add this method in an `impl FinnhubDriver` block (place it just above `impl ProviderDriver for FinnhubDriver`):

```rust
impl FinnhubDriver {
    /// Read the FULL persisted bare-key subscription set from redb. Called on every (re)connect
    /// so dynamic mid-session subscribes survive reconnects (single source of truth = redb).
    pub fn load_subscriptions(&self) -> Vec<String> {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        let mut out = Vec::new();
        if let Ok(rtx) = self.db.begin_read() {
            if let Ok(t) = rtx.open_table(table) {
                if let Ok(iter) = t.iter() {
                    for item in iter.flatten() {
                        out.push(item.0.value().to_string());
                    }
                }
            }
        }
        out
    }
}
```

- [ ] **Step 5: Seed `connect_once` from redb instead of the snapshot.** In `connect_once`, change the initial subscription source. Replace:

```rust
            let mut current: Vec<String> = symbols.to_vec();
```

with:

```rust
            let _ = symbols; // resume is read fresh from redb each attempt (reconnect-safe)
            let mut current: Vec<String> = self.load_subscriptions();
```

(The `for s in &current { … subscribe … }` loop below is unchanged; it now subscribes the fresh persisted set. The live `sub_rx` dedup against `current` is unchanged.)

- [ ] **Step 6: Run the test — PASS.**

Run: `cd rust && cargo test --lib load_subscriptions_reads_bare_keys_and_unsubscribe_drops -- --test-threads=1`
Expected: PASS.

- [ ] **Step 7: Clippy.** `cd rust && cargo clippy --all-targets -- -D warnings` → clean. (The driver_tests/loopback test in `finnhub_driver.rs` that construct `FinnhubDriver` literally — e.g. Phase A's loopback test — will FAIL to compile now that fields were added; this task and Phase A's Task 4 must agree. If Phase A already merged, update its Finnhub loopback test's `FinnhubDriver { … }` literal to include `db: <tmp_db>, table: "finnhub_subscriptions"`. If a compile error surfaces there, fix that literal as part of this step.)

- [ ] **Step 8: Commit.**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs
git commit -m "feat(streaming): FinnhubDriver reads subscriptions fresh from redb (reconnect-resume)"
```

---

### Task 2 (B1b): wire the Finnhub facade to hand the driver the redb handle

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs:256-260` (driver construction in `start`)

- [ ] **Step 1: Verify state (Step 0).** Confirm `FinnhubStreaming::start` builds `let driver = FinnhubDriver { token: g.token.clone(), name: g.name.clone(), base_url: g.base_url.clone() };` and that `g.host` exposes `db_handle()` and `table_name()` (used identically in `alpaca_streamer.rs:184-185`). If different, STOP and report `STATE_MISMATCH`.

- [ ] **Step 2: Add the redb handle to the driver construction.** Replace the `let driver = FinnhubDriver { … };` block (lines 256-260) with:

```rust
        let driver = FinnhubDriver {
            token: g.token.clone(),
            name: g.name.clone(),
            base_url: g.base_url.clone(),
            db: g.host.db_handle(), // driver reads persisted subs from redb on every (re)connect
            table: g.host.table_name(),
        };
```

- [ ] **Step 3: Build + full Rust gate.**

Run: `cd rust && cargo test -- --test-threads=1`
Expected: PASS (the facade compiles; the existing Finnhub mapper/driver tests and the new B1a test stay green). The `symbols` passed to `g.host.start(driver, symbols, …)` is now redundant (the driver reads redb) but harmless — leave it.

- [ ] **Step 4: Clippy + commit.**

Run: `cd rust && cargo clippy --all-targets -- -D warnings`

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs
git commit -m "feat(streaming): pass host redb handle to FinnhubDriver (enables reconnect-resume)"
```

---

### Task 3 (B2): Yahoo undecodable-frame debug log (length-only) + tracing-capture oracle

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs` (add helper + `else` branch in the pump; add test)

- [ ] **Step 1: Verify state (Step 0).** Confirm the Yahoo pump (in `connect_once`) reads `Some(Ok(Message::Text(t)))` and does `if let Some((raw, uni)) = parse_yahoo_message(&t, &self.name) { … }` with **no** `else`. Confirm `tracing-subscriber` (0.3) is a dependency (it is: `Cargo.toml` line ~38). If different, STOP and report `STATE_MISMATCH`.

- [ ] **Step 2: Write the failing test.** Add a `#[cfg(test)] mod undecodable_log_tests` to `yahoo_driver.rs`:

```rust
#[cfg(test)]
mod undecodable_log_tests {
    use super::note_undecodable;
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    #[derive(Clone)]
    struct VecWriter(Arc<Mutex<Vec<u8>>>);
    impl Write for VecWriter {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> MakeWriter<'a> for VecWriter {
        type Writer = VecWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn undecodable_logs_length_only_message() {
        let sink = Arc::new(Mutex::new(Vec::<u8>::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(VecWriter(Arc::clone(&sink)))
            .with_max_level(tracing::Level::DEBUG)
            .without_time()
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            note_undecodable("yahoo", 42);
        });
        let out = String::from_utf8(sink.lock().unwrap().clone()).unwrap();
        assert!(out.contains("bytes=42"), "log must carry the byte length: {out}");
        assert!(
            out.contains("undecodable frame skipped"),
            "log must carry the message: {out}"
        );
        // Redaction is STRUCTURAL: note_undecodable takes only `usize`, so it cannot
        // log frame contents. This test pins the message + length shape.
    }
}
```

- [ ] **Step 3: Run it — verify it FAILS** (no `note_undecodable`).

Run: `cd rust && cargo test --lib undecodable_logs_length_only_message -- --test-threads=1`
Expected: FAIL (compile error: cannot find `note_undecodable`).

- [ ] **Step 4: Add the helper + the `else` branch.** Add this free function near the top of `yahoo_driver.rs` (after the `use` imports, before `parse_yahoo_message`):

```rust
/// Length-only debug note for frames the mapper rejects. Takes ONLY the byte count —
/// it is structurally impossible to leak the (base64-protobuf) frame contents.
pub(crate) fn note_undecodable(provider: &str, bytes: usize) {
    tracing::debug!(target: "corelib_rust::stream", provider, bytes, "undecodable frame skipped");
}
```

In the pump's text-message arm, add the `else` branch:

```rust
                        Some(Ok(Message::Text(t))) => {
                            silence.reset();
                            if let Some((raw, uni)) = parse_yahoo_message(&t, &self.name) {
                                let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Yahoo(raw), uni }).await;
                            } else {
                                note_undecodable("yahoo", t.len());
                            }
                        }
```

- [ ] **Step 5: Run the test — PASS.**

Run: `cd rust && cargo test --lib undecodable_logs_length_only_message -- --test-threads=1`
Expected: PASS.

- [ ] **Step 6: Clippy + commit.**

Run: `cd rust && cargo clippy --all-targets -- -D warnings`

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs
git commit -m "feat(streaming): debug-log undecodable Yahoo frames (length-only, redacted)"
```

---

### Task 4 (B3): deterministic Node↔Rust loopback delivery test + characterization

**Files:**
- Create: `probes/js/alpaca-loopback-delivery.probe.test.ts`
- Create (in Step 4 if needed): `docs/superpowers/findings/2026-06-15-b3-interop-characterization.md`

**Context:** this is the load-bearing Epic item. The test is BOTH the deliverable and the characterization tool: write it, run it against the **release** addon, and the result tells you whether root-cause work is needed.

- [ ] **Step 1: Verify state (Step 0) + the config mapping.** Confirm `probes/_harness/alpaca-loopback.mjs` exports `AlpacaLoopbackServer` with `listen()`, `url`, `streamingCount`, `streamTradeAll(sym, price)`, `close()`. Confirm the TS `AlpacaStreaming` wrapper (`ts-markets/src/.../AlpacaStreaming.ts`) is an `EventEmitter`, takes no constructor args, exposes `init({ baseUrl, keyId, secretKey, dbPath })`, `subscribe(string[])`, `start()`, `stop()`, and emits `"pricing"`. Confirm napi maps the Rust `base_url` field to JS `baseUrl` (napi-rs default snake→camel; the wrapper already threads `baseUrl`). If the `baseUrl` override does NOT reach Rust, STOP and report — fixing it is part of B3 (else the test would hit production Alpaca).

- [ ] **Step 2: Write the deterministic test.** Create `probes/js/alpaca-loopback-delivery.probe.test.ts`:

```ts
// =============================================
// B3: Node<->Rust cross-runtime loopback DELIVERY closure (Streaming Engine Epic).
// Drives the REAL AlpacaStreaming addon against the Node `ws` AlpacaLoopbackServer and
// ASSERTS a frame round-trips: Node ws -> Rust driver -> TSFN -> on_pricing ("pricing" event).
// Unlike transport-backpressure.probe.test.ts (non-asserting measurement), this GATES.
// Closes the Epic-5 finding `probe-harness-loopback-no-delivery`.
// Dummy credentials only; never reads APCA_* env (cannot hit production).
// =============================================
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error - JS harness, no types
import { AlpacaLoopbackServer } from "../_harness/alpaca-loopback.mjs";
import { AlpacaStreaming } from "@ckir/corelib-markets";

const __dirname = dirname(fileURLToPath(import.meta.url));
void resolve; // (kept for parity with sibling probes)

let server: InstanceType<typeof AlpacaLoopbackServer> | undefined;
let stream: AlpacaStreaming | undefined;

afterEach(async () => {
	try {
		stream?.stop();
	} catch {
		/* ignore */
	}
	try {
		await server?.close();
	} catch {
		/* ignore */
	}
	stream = undefined;
	server = undefined;
});

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((res, rej) => {
		const t0 = Date.now();
		const tick = () => {
			if (pred()) return res();
			if (Date.now() - t0 > timeoutMs) return rej(new Error("waitFor timeout"));
			setTimeout(tick, 25);
		};
		tick();
	});
}

it("[b3.alpaca] a frame round-trips Node ws -> Rust -> on_pricing", async () => {
	server = new AlpacaLoopbackServer();
	await server.listen();

	stream = new AlpacaStreaming();
	const pricing = new Promise<any>((res) => stream!.once("pricing", res));

	// dummy creds ONLY; temp db; baseUrl points at the loopback (never production).
	const dbPath = `${tmpdir()}/b3_alpaca_${process.pid}_${Date.now()}.redb`;
	await stream.init({
		baseUrl: server.url,
		keyId: "dummy-key",
		secretKey: "dummy-secret",
		dbPath,
	});
	stream.subscribe(["AAPL"]); // persisted to redb -> driver subscribes on connect
	await stream.start();

	// Once the driver has authed + subscribed, the server marks it streaming-ready.
	await waitFor(() => server!.streamingCount > 0, 10_000);
	server.streamTradeAll("AAPL", 191.5);

	const data = (await Promise.race([
		pricing,
		new Promise((_r, rej) => setTimeout(() => rej(new Error("no pricing in 10s")), 10_000)),
	])) as { symbol: string; message_type: string; price: number };

	expect(data.symbol).toBe("AAPL");
	expect(data.message_type).toBe("trade");
	expect(data.price).toBe(191.5);
}, 30_000);

void __dirname;
```

- [ ] **Step 3: Build the RELEASE addon + run the test.**

Run: `cd rust && pnpm exec napi build --release && cp corelib-rust.node ../ts-core/corelib-rust.node` then build the TS packages the probe imports (`pnpm build-all` or at least `@ckir/corelib` + `@ckir/corelib-markets`), then run the probe with its vitest project: `pnpm vitest run probes/js/alpaca-loopback-delivery.probe.test.ts`.
Expected (PASS path): the test is GREEN — the engine delivers across the napi/Node boundary on release. If GREEN, skip Step 4; go to Step 5.

- [ ] **Step 4: If RED — characterize + root-cause (REQUIRED; do not caveat).** Only if Step 3 fails (`no pricing` / `streamingCount` never > 0):
  1. Re-run against a **debug** addon (`pnpm exec napi build` without `--release`) and on the other OS available; record `streamingCount`-reached and pricing-received for each profile.
  2. Write `docs/superpowers/findings/2026-06-15-b3-interop-characterization.md` recording the matrix (release/debug × OS, STREAM_READY-equivalent, delivered y/n) and the leading hypothesis.
  3. Because Phase A exonerated the Rust engine (pure-Rust loopback delivers), investigate the napi/Node boundary in order: supervisor reconnect/timer scheduling under napi `tokio_rt` (the probe's recorded hypothesis: tokio timer driver not advancing after the first connect on the Windows debug build); `ThreadsafeFunction` NonBlocking delivery timing; the Node-`ws` ↔ tokio-tungstenite handshake. **Time-box the FIX effort** (suggest ~1 working day of investigation before escalating to the human). Acceptable resolutions: **(i) fix it**, or **(ii) positively identify a benign, documented profile-specific artifact** — NOT "observe RED and add a caveat."
  4. Apply the fix; re-run Step 3 until the **release** test is GREEN.

- [ ] **Step 5: Ensure the test gates CI (no `INTEGRATION_LIVE` bypass).** Confirm `probes/js/*.probe.test.ts` runs in a CI-gating vitest project (the same one as `transport-backpressure.probe.test.ts`). If that project is not part of the CI gate, wire this probe into the integration job so a RED delivery fails CI. The Epic closes ONLY when this is green on the standard CI matrix.

- [ ] **Step 6: Commit.**

```bash
git add probes/js/alpaca-loopback-delivery.probe.test.ts docs/superpowers/findings/2026-06-15-b3-interop-characterization.md 2>/dev/null
git commit -m "test(streaming): deterministic Node<->Rust loopback delivery (B3 interop closure)"
```

---

### Task 5: ROADMAP + Epic status

**Files:**
- Modify: `ROADMAP.md` (the Streaming Engine Epic block)

- [ ] **Step 1: Update the Epic status.** In `ROADMAP.md`, under the Streaming Engine Epic block, mark **B1** and **B2** done, and mark **B3** + the Epic as **closed** if Task 4's release test is green on CI, otherwise **open-pending-B3** with a pointer to the characterization finding. Note that only the `corelib-streaming` crate lift remains deferred (finstream prereq).

- [ ] **Step 2: Full gate + commit.**

Run: `cd rust && cargo test -- --test-threads=1 && cargo clippy --all-targets -- -D warnings`
Expected: green.

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): Streaming Engine Epic B1/B2 done; B3 status recorded"
```

---

## Milestone offload dispatch

After Task 4 (B3), dispatch `dev-offload.yml` for the full matrix — the cross-OS, release-build interop is exactly what the remote matrix proves (and where a Windows-vs-Linux delivery difference would surface).

## Self-Review

**1. Spec coverage:**
- §4 B1 (redb fields + `load_subscriptions` + fresh-read + facade wiring + unsubscribe-no-resurrection) → Tasks 1, 2 (incl. the resurrection assertion in Task 1 Step 2). ✓
- §5 B2 (length-only log + automated tracing-capture oracle) → Task 3. ✓
- §6 B3 (Step 0 mapping guard + dummy keys; characterize; root-cause required not caveated; deterministic standard-CI test; no `INTEGRATION_LIVE` bypass) → Task 4 Steps 1-5. ✓
- §10 success / ROADMAP → Task 5. ✓

**2. Placeholder scan:** Code tasks (1,2,3,4-test) contain complete code + exact commands. Task 4 Step 4 (root-cause) is an *investigation* with concrete sub-steps + a decision gate — that is the nature of closing an unknown interop bug, not a placeholder (the deliverable code, the test, is fully specified). ✓

**3. Type consistency:** `FinnhubDriver { token, name, base_url, db: Arc<Database>, table: &'static str }` matches the Alpaca/Yahoo pattern; `g.host.db_handle()` / `g.host.table_name()` match `alpaca_streamer.rs:184-185`. `note_undecodable(&str, usize)` matches its call site. The B3 test uses the real `AlpacaStreaming` wrapper API (`init({baseUrl,keyId,secretKey,dbPath})`, `subscribe(string[])`, `"pricing"` event) and the real `AlpacaLoopbackServer` surface (`listen`/`url`/`streamingCount`/`streamTradeAll`/`close`). ✓

**Executor notes:**
- Run the Rust gate single-threaded (`--test-threads=1`) — global flight-recorder ring.
- Temp `.redb` files in B1's test follow the existing `*_driver.rs` `driver_tests` convention (left in temp dir; consistent with the codebase — not new debt).
- B1 Task 1 Step 7: if Phase A's Finnhub loopback test already merged, its `FinnhubDriver { … }` literal must gain `db`/`table` fields — fix it in the same commit if the compiler flags it.
