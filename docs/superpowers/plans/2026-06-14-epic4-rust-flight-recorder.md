# Epic 4 — Rust Ring-Buffer Flight Recorder (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give corelib-rust's streaming/FFI hot path a lock-free, zero-I/O-nominal **in-memory ring-buffer flight recorder** (via `tracing`) that dumps the last *N* structured events on panic / env-gated signal — so an AI agent can reconstruct a crash without flooding the TSFN bridge.

**Architecture:** A global `crossbeam_queue::ArrayQueue<FlightEvent>` (lock-free, `force_push` = overwrite-oldest ring). A custom `tracing::Layer` converts every `tracing` event into a `FlightEvent` and pushes it into the ring (structured fields, formatted lazily at dump). The streaming hot path is instrumented with `tracing::trace!`/`debug!` (per-event in the host pump = the single chokepoint; connect/reconnect/subscribe at debug). Dump triggers: a `std::panic` hook (stderr, lock-free → no poisoning) and an env-gated `#[napi] napi_dump_flight_log` (mirrors `diagnostics.rs`). JS already receives lifecycle via the existing `on_event`/`on_log` TSFNs — we do NOT add a new per-event bridge (that's the trace-storm agy warned about). Independent of Plan A (TS).

**Tech Stack:** Rust 2021, `napi` 3.x (cdylib+rlib), `tokio`, **new deps:** `tracing`, `tracing-subscriber` (env-filter), `crossbeam-queue`. Spec: `docs/superpowers/specs/2026-06-14-epic4-hotpath-trace-instrumentation-design.md`.

**Verify commands:**
- Build: `pnpm build-all` (napi build) — NEVER hand-run a bare emitting tsc.
- Rust tests: `cd rust && cargo test` (pure `#[test]`/`#[tokio::test]`).
- Lint: `pnpm lint-all` (runs `cargo clippy` for the rust crate).

**Key paths (from recon — state-verify in Step 0s):**
- Streaming: `rust/src/markets/nasdaq/datafeeds/streaming/` → `core/host.rs` (pump chokepoint ~L145), `core/supervisor.rs` (`run_supervisor`), `core/reconnect.rs` (`ReconnectPolicy`), `core/driver.rs` (`ProviderDriver`), the per-driver `connect_once`, `diagnostics.rs` (env-gated `#[napi]` precedent), `HostError` (`core/host.rs` ~L50).
- New module: `rust/src/observability/{mod.rs,ring_buffer.rs,layer.rs,napi_dump.rs}`, registered in `rust/src/lib.rs`.

---

## Task 1: Add deps + `observability` module skeleton

**Files:**
- Modify: `rust/Cargo.toml` (`[dependencies]`)
- Create: `rust/src/observability/mod.rs`
- Modify: `rust/src/lib.rs` (register module)

- [ ] **Step 0 (state-verify):** confirm `rust/Cargo.toml` has NO `tracing`/`crossbeam`/`parking_lot` (recon: none), edition 2021, crate-type `["cdylib","rlib"]`; and `rust/src/lib.rs` has top-level `pub mod …` declarations (e.g. `pub mod markets;`). If present already, STOP `STATE_MISMATCH`.

- [ ] **Step 1: Add deps** to `rust/Cargo.toml` `[dependencies]`:
```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
crossbeam-queue = "0.3"
```

- [ ] **Step 2: Create `rust/src/observability/mod.rs`:**
```rust
//! In-memory ring-buffer flight recorder for the streaming/FFI hot path.
//! Lock-free (crossbeam ArrayQueue), zero I/O under nominal operation;
//! dumps the last N structured events on panic or an env-gated napi signal.
pub mod layer;
pub mod napi_dump;
pub mod ring_buffer;

pub use layer::init_flight_recorder;
```

- [ ] **Step 3: Register in `rust/src/lib.rs`** — add the module AND init at module-load (agy plan-review: capture boot/DbOpen errors before any host starts, and avoid re-init races):
```rust
pub mod observability;

#[napi::module_init]
fn __corelib_init_flight_recorder() {
	crate::observability::init_flight_recorder();
}
```
(SHAPE-DIVERGENCE STOP: confirm napi 3.x exposes `#[napi::module_init]`; if not, fall back to calling `init_flight_recorder()` at the top of `WebsocketStreamerHost::start()` and report `[expected #[napi::module_init]] -> [actual]`.)

- [ ] **Step 4: Build.** `pnpm build-all` → success (deps resolve, empty module compiles). If `crossbeam-queue`/`tracing` versions need a minor bump to compile on this toolchain, adjust and report.
- [ ] **Step 5: Commit**
```bash
git add rust/Cargo.toml rust/Cargo.lock rust/src/observability/mod.rs rust/src/lib.rs
git commit -m "feat(epic4): add tracing/crossbeam deps + observability module skeleton"
```

---

## Task 2: Ring buffer (`ring_buffer.rs`)

**Files:**
- Create: `rust/src/observability/ring_buffer.rs`

- [ ] **Step 1: Write the ring.** `rust/src/observability/ring_buffer.rs`:
```rust
use crossbeam_queue::ArrayQueue;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// One captured tracing event, stored structured (formatted lazily at dump).
#[derive(Clone, Debug)]
pub struct FlightEvent {
	pub ts_ms: u128,
	pub level: &'static str,
	pub target: &'static str,
	pub message: String,
	/// Pre-collected `key=value ` pairs (kept short; never secrets).
	pub fields: String,
}

const CAPACITY: usize = 8192;
static RING: OnceLock<ArrayQueue<FlightEvent>> = OnceLock::new();

pub fn ring() -> &'static ArrayQueue<FlightEvent> {
	RING.get_or_init(|| ArrayQueue::new(CAPACITY))
}

/// Lock-free record. `force_push` overwrites the oldest entry when full
/// (ring semantics) and never blocks or poisons.
pub fn record(ev: FlightEvent) {
	ring().force_push(ev);
}

pub fn now_ms() -> u128 {
	SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Drain the ring oldest→newest into formatted lines (for dump). Empties the ring.
pub fn drain_to_lines() -> Vec<String> {
	let r = ring();
	let mut out = Vec::with_capacity(r.len());
	while let Some(ev) = r.pop() {
		out.push(format!("{} [{}] {} {}{}", ev.ts_ms, ev.level, ev.target, ev.message,
			if ev.fields.is_empty() { String::new() } else { format!(" {}", ev.fields.trim_end()) }));
	}
	out
}

/// Test-only: empty the ring so ordered/parallel tests don't pollute each other.
#[cfg(test)]
pub fn reset_for_test() {
	while ring().pop().is_some() {}
}
```
(SHAPE-DIVERGENCE STOP: if this `crossbeam-queue` version lacks `force_push`, use `if ring().push(ev).is_err() { let _ = ring().pop(); let _ = ring().push(ev_clone); }` — report the version.)

- [ ] **Step 2: Test.** Append to `ring_buffer.rs`:
```rust
#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn force_push_overwrites_oldest_and_drains_in_order() {
		// fill past capacity; oldest should be evicted
		for i in 0..(CAPACITY as u128 + 5) {
			record(FlightEvent { ts_ms: i, level: "TRACE", target: "t".into(), message: format!("m{i}"), fields: String::new() });
		}
		let lines = drain_to_lines();
		assert_eq!(lines.len(), CAPACITY);
		assert!(lines[0].contains("m5"));            // first 5 evicted
		assert!(lines.last().unwrap().contains(&format!("m{}", CAPACITY + 4)));
		assert!(drain_to_lines().is_empty());        // drained
	}
}
```
- [ ] **Step 3: Run — PASS.** `cd rust && cargo test observability::ring_buffer` → PASS.
- [ ] **Step 4: Commit**
```bash
git add rust/src/observability/ring_buffer.rs
git commit -m "feat(epic4): lock-free ring buffer (crossbeam ArrayQueue, structured FlightEvent)"
```

---

## Task 3: tracing Layer + init + panic-dump hook (`layer.rs`)

**Files:**
- Create: `rust/src/observability/layer.rs`

- [ ] **Step 1: Write the Layer + init.** `rust/src/observability/layer.rs`:
```rust
use super::ring_buffer::{now_ms, record, FlightEvent};
use std::fmt::Write as _;
use std::sync::Once;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

struct FieldCollector { message: String, fields: String }
impl Visit for FieldCollector {
	fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
		if field.name() == "message" {
			let _ = write!(self.message, "{value:?}");
		} else {
			let _ = write!(self.fields, "{}={:?} ", field.name(), value);
		}
	}
}

fn level_str(l: &Level) -> &'static str {
	match *l {
		Level::TRACE => "TRACE", Level::DEBUG => "DEBUG", Level::INFO => "INFO",
		Level::WARN => "WARN", Level::ERROR => "ERROR",
	}
}

/// tracing Layer that captures every event into the lock-free ring buffer.
pub struct FlightLayer;
impl<S: Subscriber> Layer<S> for FlightLayer {
	fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
		let meta = event.metadata();
		let mut c = FieldCollector { message: String::new(), fields: String::new() };
		event.record(&mut c);
		record(FlightEvent {
			ts_ms: now_ms(),
			level: level_str(meta.level()),
			target: meta.target(), // &'static str — no allocation
			message: c.message,
			fields: c.fields,
		});
	}
}

static INIT: Once = Once::new();

/// Idempotent: installs the FlightLayer subscriber (+ EnvFilter) and a panic
/// hook that dumps the ring to stderr. Safe to call on every host start.
pub fn init_flight_recorder() {
	INIT.call_once(|| {
		// Default keeps the per-TICK firehose OFF (it lives under the distinct
		// `corelib_rust::stream::tick` target — see Task 5) so the ring isn't washed
		// out in ~1.6s under load; connect/reconnect/subscribe/error stay at debug
		// in the ring. Opt into ticks with CORELIB_LOG="corelib_rust::stream::tick=trace".
		// (agy plan-review: buffer-washout fix.)
		let filter = EnvFilter::try_from_env("CORELIB_LOG")
			.unwrap_or_else(|_| EnvFilter::new("corelib_rust=debug,corelib_rust::stream::tick=off"));
		// try_init: don't panic if a global subscriber already exists (tests/host re-entry).
		let _ = tracing_subscriber::registry().with(filter).with(FlightLayer).try_init();
		install_panic_dump_hook();
	});
}

fn install_panic_dump_hook() {
	let prev = std::panic::take_hook();
	std::panic::set_hook(Box::new(move |info| {
		// Pop per-event straight to stderr (no Vec/batch built during unwind →
		// minimal alloc, can't OOM-double-panic). ArrayQueue can't poison → safe.
		use std::io::Write as _;
		let mut err = std::io::stderr().lock();
		let _ = writeln!(err, "--- corelib flight-log dump (panic) ---");
		let r = super::ring_buffer::ring();
		while let Some(ev) = r.pop() {
			let _ = writeln!(err, "[flight] {} [{}] {} {} {}", ev.ts_ms, ev.level, ev.target, ev.message, ev.fields);
		}
		let _ = err.flush();
		prev(info);
	}));
}
```
(SHAPE-DIVERGENCE STOP: `tracing-subscriber` API — `registry().with(...).try_init()` and `EnvFilter::try_from_env` are version-sensitive; if the exact method names differ on the resolved version, adapt to the equivalent and report `[expected] -> [actual]`. Do NOT change the FlightEvent contract.)

- [ ] **Step 2: Test.** Append:
```rust
#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn emitted_trace_event_lands_in_ring() {
		init_flight_recorder();
		tracing::trace!(target: "corelib_rust::flighttest", symbol = "AAPL", "pump event");
		let lines = super::super::ring_buffer::drain_to_lines();
		assert!(lines.iter().any(|l| l.contains("flighttest") && l.contains("pump event") && l.contains("symbol")));
	}
}
```
- [ ] **Step 3: Run — PASS.** `cd rust && cargo test observability::layer` → PASS.
- [ ] **Step 4: Commit**
```bash
git add rust/src/observability/layer.rs
git commit -m "feat(epic4): tracing FlightLayer → ring + init + panic-dump hook"
```

---

## Task 4: env-gated napi dump (`napi_dump.rs`)

**Files:**
- Create: `rust/src/observability/napi_dump.rs`

- [ ] **Step 0 (state-verify):** open `diagnostics.rs` and confirm the `#[napi] pub fn napi_trigger_diagnostic_flood(count: u32, on_event: ThreadsafeFunction<String>) -> napi::Result<()>` shape + the `ThreadsafeFunctionCallMode` import path. Mirror EXACTLY (same `ThreadsafeFunction<String>` generic + `.call(Ok(s), mode)`).

- [ ] **Step 1: Write the dump export.** `rust/src/observability/napi_dump.rs`:
```rust
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// Dump the in-memory flight-recorder ring to JS, one entry per call.
/// Gated behind CORELIB_FLIGHT_LOG=1 (production no-op), mirroring
/// napi_trigger_diagnostic_flood. Draining is lock-free.
#[napi]
pub fn napi_dump_flight_log(on_entry: ThreadsafeFunction<String>) -> napi::Result<()> {
	if std::env::var("CORELIB_FLIGHT_LOG").unwrap_or_default() != "1" {
		return Ok(()); // gated no-op
	}
	for line in crate::observability::ring_buffer::drain_to_lines() {
		let _ = on_entry.call(Ok(line), ThreadsafeFunctionCallMode::NonBlocking);
	}
	Ok(())
}
```
(SHAPE-DIVERGENCE STOP: match `diagnostics.rs`'s exact `ThreadsafeFunction<String>` type params and call mode from Step 0 — napi 3.x generics differ across minor versions. The `#[napi]` fn is auto-exported via `lib.rs`; no manual re-export needed if `diagnostics.rs` isn't manually re-exported either — verify.)

- [ ] **Step 2: Build + regenerate bindings.** `pnpm build-all` → success; confirm `napi_dump_flight_log` appears in the generated `index.d.ts` (same place `napiTriggerDiagnosticFlood` lives).
- [ ] **Step 3: Commit**
```bash
git add rust/src/observability/napi_dump.rs rust/index.* rust/*.node 2>/dev/null; git add -A rust
git commit -m "feat(epic4): env-gated napi_dump_flight_log (mirrors diagnostics flood)"
```

---

## Task 5: Instrument the streaming hot path

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs` (pump chokepoint + init)
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/supervisor.rs` (connect/reconnect)
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/reconnect.rs` (backoff)
- Modify: the per-driver `connect_once` (subscribe/unsubscribe) — `yahoo/alpaca/finnhub` drivers

- [ ] **Step 0 (state-verify):** confirm `host.rs` `start(...)` (~L109) spawns the pump `while let Some(ev) = rx.recv().await { on_event_pump(ev); }` (~L145); `run_supervisor` in `supervisor.rs`; `ReconnectPolicy` backoff in `reconnect.rs`; driver `connect_once` `sub_rx.recv()` handling. Report `STATE_MISMATCH` if shapes differ.

- [ ] **Step 1: Instrument the pump chokepoint** (`host.rs`). Init now happens at module load (Task 1 `#[napi::module_init]`) — do NOT also init here. In the pump task, add a per-event trace BEFORE `on_event_pump(ev)`, on the **distinct `::tick` target** (OFF by default → no buffer washout; opt-in via `CORELIB_LOG`):
```rust
while let Some(ev) = rx.recv().await {
	tracing::trace!(target: "corelib_rust::stream::tick", kind = core_event_kind(&ev), "pump event");
	on_event_pump(ev);
}
```
Add a tiny helper near the pump (or in `types.rs`) so we trace the *kind* not the payload (no PII):
```rust
fn core_event_kind(ev: &CoreEvent) -> &'static str {
	match ev { CoreEvent::Pricing { .. } => "pricing", CoreEvent::Status(_) => "status" }
}
```
(Use the actual `CoreEvent` variants from Step 0. REDACTION: trace the kind only — never the raw pricing payload.)

- [ ] **Step 2: connect/reconnect at debug** (`supervisor.rs` + `reconnect.rs`): at each connect attempt and reconnect, `tracing::debug!(target: "corelib_rust::stream", attempt, "connect");` and on backoff `tracing::debug!(target: "corelib_rust::stream", delay_ms, attempt, "reconnect backoff");` (use the policy's computed delay var). On `AttemptOutcome` → `tracing::debug!(outcome = ?o, "attempt done");`.

- [ ] **Step 3: subscribe/unsubscribe trace** in each driver `connect_once` `sub_rx.recv()` arm: `tracing::trace!(target: "corelib_rust::stream", ?req, "sub request");` (req is symbols/channel — symbols are not secret; OK).
  - SHAPE-DIVERGENCE STOP: add only `tracing::` macros + the `core_event_kind` helper + the one `init_flight_recorder()` call. Do NOT change channel sizes, the pump signature, reconnect math, or driver logic.

- [ ] **Step 4: Hermetic instrumentation test** (agy plan-review: do NOT spin a full `WebsocketStreamerHost` + redb — lock collisions + flakiness). In a `#[cfg(test)] mod` in `host.rs`, test the instrumentation primitives directly — `core_event_kind` on each variant + emit the SAME macros the pump/supervisor use + assert via the ring:
```rust
#[cfg(test)]
mod flight_tests {
	use crate::observability::ring_buffer::{drain_to_lines, reset_for_test};
	#[test]
	fn core_event_kind_maps_variants() {
		// assert super::core_event_kind(&CoreEvent::Pricing{..}) == "pricing"
		// and (&CoreEvent::Status(..)) == "status"  (build minimal variants)
	}
	#[test]
	fn lifecycle_debug_is_captured_in_ring() {
		reset_for_test();
		crate::observability::init_flight_recorder();
		tracing::debug!(target: "corelib_rust::stream", attempt = 1u32, "connect");
		let lines = drain_to_lines();
		assert!(lines.iter().any(|l| l.contains("connect") && l.contains("attempt")));
	}
}
```
Run single-threaded to avoid global-ring pollution: `cd rust && cargo test flight_tests -- --test-threads=1`.
(SHAPE-DIVERGENCE STOP: assert on the REAL instrumentation macros (don't fake log lines); do NOT construct a full host here.)

- [ ] **Step 5: Run — PASS.** `cd rust && cargo test streaming:: observability::` → PASS.
- [ ] **Step 6: Commit**
```bash
git add rust/src/markets/nasdaq/datafeeds/streaming rust/src/observability
git commit -m "feat(epic4): trace streaming pump (kind only) + debug connect/reconnect/subscribe"
```

---

## Task 6: Panic-dump test + full gate

**Files:**
- Modify: `rust/src/observability/layer.rs` (add a panic-dump test)

- [ ] **Step 1: Panic-dump test (ISOLATED integration test).** The panic hook is process-global, so test it in its OWN test binary (agy plan-review) — keeps the global hook out of the unit-test process. Create `rust/tests/flight_panic.rs`:
```rust
// Own process: asserts the panic hook dumps the ring to stderr and the process
// SURVIVES a worker-thread panic with no double-panic/abort.
#[test]
fn panic_hook_dumps_and_survives() {
	corelib_rust::observability::init_flight_recorder();
	tracing::error!(target: "corelib_rust::stream", "pre-panic marker");
	let h = std::thread::spawn(|| panic!("boom"));
	assert!(h.join().is_err());                                   // thread panicked
	let _ = corelib_rust::observability::ring_buffer::drain_to_lines(); // alive + drainable
}
```
(SHAPE-DIVERGENCE STOP: needs `corelib_rust` + `tracing` reachable from `tests/` — the crate is `rlib`+`cdylib`, so `corelib_rust::…` resolves; add `tracing` to `[dev-dependencies]` if the integration test can't see it. Key invariant = "no double-panic/abort + ring drainable after," NOT exact stderr capture.)

- [ ] **Step 2: FULL GATE:**
  - `cd rust && cargo test` → all PASS
  - `pnpm build-all` → success (incl. napi binding regen with `napi_dump_flight_log`)
  - `pnpm lint-all` → 0 fixes (incl. `cargo clippy`)
  - Smoke: a tiny Node script that imports the built binding, runs a streamer briefly, then calls `napiDumpFlightLog(cb)` with `CORELIB_FLIGHT_LOG=1` and prints entries (manual eyeball — confirms a reconstructable record).

- [ ] **Step 3: Commit**
```bash
git add rust/src/observability/layer.rs
git commit -m "test(epic4): panic-dump survives without double-panic; flight recorder gate green"
```

---

## Finalization (after all tasks)
- [ ] Full gate green (above).
- [ ] **agy convergent review** of the Rust diff (per cadence) — especially the lock-free/poison-free claims and the no-new-bridge decision.
- [ ] superpowers:finishing-a-development-branch (this can merge with Plan A or as its own branch).

## Notes / risks
- **No new per-event TSFN bridge** (agy spec-review): per-event data goes to the RING only; JS keeps receiving lifecycle via the existing `on_event`/`on_log` TSFNs (unchanged). This is the trace-storm/backpressure mitigation — do not add a per-event JS push.
- **Three dump triggers (spec):** (i) panic hook — T3; (iii) env-gated `napi_dump_flight_log` — T4. (ii) "HostError at the FFI boundary" is realized **from JS, not Rust-side**: the JS error handler calls `napiDumpFlightLog(cb)` (env-gated) when an FFI call rejects — no Rust-side coupling of the dump into `HostError`→`napi::Error` mapping needed. The supervisor-panic monitor (`host.rs` ~L132) is already covered by the global panic hook.
- **Version-sensitivity:** `tracing-subscriber` init API and napi `ThreadsafeFunction` generics vary by minor version — every code block has a SHAPE-DIVERGENCE STOP; `cargo build`/`cargo test` are the oracle. Resolve against the actual resolved versions; do not change the `FlightEvent` contract or the ring's lock-free property.
- **Poison-free:** the ring is `crossbeam ArrayQueue` (lock-free) precisely so the panic-hook dump can't double-panic on a poisoned `std::sync::Mutex` (agy spec-review). Never reintroduce a `std::sync::Mutex` around the ring.
- **Redaction:** trace the event *kind* and symbols, never raw pricing payloads or credentials.

**agy plan-review (`AGY-EPIC4-PLANB-REVIEW.md`) disposition:**
- ✅ Folded — **buffer-washout fix:** per-tick pump trace moved to a distinct `corelib_rust::stream::tick` target, **OFF by default** (EnvFilter `corelib_rust=debug,corelib_rust::stream::tick=off`), so the ring holds connect/reconnect/subscribe/error history instead of being washed out in ~1.6s under load (capacity 8192 kept — adequate once ticks are off by default).
- ✅ Folded — **init at `#[napi::module_init]`** (lib.rs) not host `start()`: captures boot/DbOpen errors + avoids re-init races.
- ✅ Folded — **panic hook pops straight to stderr** (no `drain_to_lines` Vec built during unwind → minimal alloc, abort-safe), chains prev hook.
- ✅ Folded — **narrow/hermetic tests:** no full-host+redb simulation (lock collisions/flakiness); assert real macros via the ring; `reset_for_test()` + single-threaded run to avoid global-ring pollution; **panic test isolated in `rust/tests/flight_panic.rs`** (own process, keeps the global hook out of unit runs).
- ✅ Folded — `FlightEvent.target: &'static str` (tracing targets are `&'static`) to drop a per-event allocation; evicted `force_push` value dropped on the caller is acceptable since per-tick is off by default (no hot-loop eviction churn).
- ❌ Rejected/deferred (scope creep): channel **queue-latency** + pre-pump **socket-buffer** instrumentation, and a background **GC thread** for evicted entries — out of scope for the recorder MVP; revisit with the carry-forward perf probes. Capacity stays 8192 (washout solved by the off-by-default tick target, not a bigger buffer).
