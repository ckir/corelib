# Input & Environmental Safety Hardening — Design Spec

**Date:** 2026-06-14
**Epic:** 2 (second fix cycle following the 2026-06-13 monorepo optimization audit; follows [[Epic 1]] boot-hardening)
**Status:** design — production changes IN scope this cycle
**Owner files:** `rust/src/markets/nasdaq/datafeeds/streaming/**`, `ts-core/src/retrieve/RequestUnlimited.ts`, `probes/**`

---

## 1. Purpose & scope

Consolidate the next cluster of audit findings (`docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md`)
into one cohesive cycle. These share the **same failure class Epic 1 killed**: *unvalidated input or
environmental conflict turning into a fatal, uncatchable process-level abort or a denial-of-service
loop.* The cluster spans the **Rust↔JS FFI seam** as a single availability front, so it is treated as
one epic (agy advisory 2026-06-14, user-approved at full 6-task scope).

**Findings / tasks in scope:**

| task | finding(s) | one-line |
|------|-----------|----------|
| 1. redb `?`-propagation | `engine-redb-open-expect-abort-01` (medium) | `host.rs:57` `.expect("Failed to open redb")` aborts the Node process on a shared-path collision |
| 2. TS-side FFI exception capture | (pairs with 1) | drivers must surface the propagated redb-open failure as a catchable JS error |
| 3. cross-process redb probe | carry-forward (validation) | validate Task 1 under a real 2-process race (Win mandatory vs Linux advisory locks) |
| 4. finnhub `base_url` override | `engine-finnhub-no-endpoint-override-01` (low) | `FinnhubConfig` has no endpoint override unlike Alpaca/Yahoo; blocks loopback testing |
| 5. http-retry clamp + jitter | `boot-RequestUnlimited-retry-limit-unbounded-03` (med) + `…backoff-no-jitter-04` (low) | config-derived `retry.limit` unbounded; no jitter ⇒ thundering-herd |
| 6. TSFN GC-reentrancy validation | TSFN inbound-delivery residual (top carry-forward) | reconnect/GC probes were green but `DELIVERED=0` — callback execution under GC was never actually tested |

**Out of scope (later epics / deferred):** `ts-core-node-imports-edge-compat` + `worker-bundle-size-and-platform`
are **hard-coupled** (changing the CF worker tsup target to `"browser"` requires ts-core to first
encapsulate the `node:*` imports) → a future **Epic 3**. `error-serialization-log-gaps` is a mechanical
observability sweep → rides with the **(a) trace retro-instrumentation** subproject. No streaming-engine
refactor; no custom cross-process Rust lock manager (Task 3 is validation-only).

---

## 2. Converged design decisions (agy-first divergent pass folded — `ANTIGRAVITY-TO-CLAUDE.md` 2026-06-14)

Per the AGENTS.md agy-first mandate, the design forks were taken to agy divergent before converging.
agy **overrode two of Claude's initial leans** — both folded here:

- **Fork A → A1 (catchable error, no auto-fallback).** On a redb-open collision (reachable only when the
  path is env-overridden to a shared one), the host surfaces a catchable error and lets the JS caller
  decide. Auto-fallback to a random path (A2) would *silently defeat the explicit shared-path override*
  and accumulate untracked files; bounded retry (A3) risks an indefinite startup stall against a held
  lock. Lock semantics: **Windows = mandatory/exclusive** (concurrent open fails instantly with an OS
  error); **Linux = advisory flock** (redb processes observe each other).
- **Fork B → B3 (pure-Rust error at the host; map to `napi::Error` only at the `#[napi]` boundary).**
  **agy override of Claude's B1.** The standalone CLI bins `rust/src/bin/alpaca_streamer.rs` and
  `yahoo_streamer.rs` call `WebsocketStreamerHost::new` and **compile without the `napi` feature** —
  returning `napi::Error` from `new` would break their build. So `new` returns `Result<Self, HostError>`
  (a pure-Rust enum, B4 refinement); the `#[napi]` provider facades `.map_err(napi::Error::from_reason)`.
- **Fork C → named-const clamps + Full Jitter, localized in `RequestUnlimited.ts`.** Full Jitter gives
  the minimum thundering-herd contention; clamp lives at config-read (no schema import into the edge
  runtime).
- **Fork D → D2 (always-compiled, env-gated no-op), NOT a cargo feature.** **agy override of an unstated
  Claude lean.** A `#[cfg(feature="diagnostics")]` gate would conditionally drop the symbol from the
  generated `index.d.ts`, breaking TS typecheck in prod CI that references it. An env guard
  (`CORELIB_DIAG_FLOOD=1`) keeps the napi typings static and the production path a zero-overhead no-op.
- **Fork E → E1 Task 3 is a pure validation probe (no custom Rust locking); E2 finnhub `base_url?:
  Option<String>` mirrors Alpaca/Yahoo.**
- **Fork F → sequence 4 & 5 → 1 & 2 → 3 → 6.** Tasks 4/5 are isolated and unblock loopback testing;
  3 validates 1/2; 6 last. agy implementation catch: **Task 6's vitest run requires
  `execArgv: ["--expose-gc"]`** or `global.gc()` is undefined and throws.

---

## 3. Task 1 — redb `?`-propagation (fixes `-01`; forks A1, B3)

**Root cause:** `host.rs:57` — `Arc::new(Database::create(&db_path).expect("Failed to open redb"))`.
A library calling `.expect()` on env/caller-derived input aborts the host process uncatchably.

**Design:**

1. **Pure-Rust error type** in the core module (no napi import — keeps CLI bins compiling):
   ```rust
   #[derive(Debug)]
   pub enum HostError {
       DbOpen(redb::DatabaseError),
   }
   impl std::fmt::Display for HostError { /* "failed to open redb at <path>: <source>" */ }
   impl std::error::Error for HostError { /* source() → the redb error */ }
   ```
   (Single variant now; the enum exists so future fallible host steps extend it without re-touching signatures.)

2. **`WebsocketStreamerHost::new` → `Result<Self, HostError>`:**
   ```rust
   pub fn new(db_path: PathBuf, table: &'static str, source: String, provider: ProviderKind)
       -> Result<Self, HostError> {
       let db = Arc::new(Database::create(&db_path).map_err(HostError::DbOpen)?);
       Ok(Self { db, table, source, provider, sub_tx: None, stop_tx: None, monitor_task: None, pump_task: None })
   }
   ```

3. **Update every call site** (8 found via `rg "WebsocketStreamerHost::new"`):
   - **CLI bins** `rust/src/bin/{alpaca,yahoo}_streamer.rs` — `main` returns `Result<…>`; propagate with `?`
     (or `eprintln!` + `std::process::exit(1)` with a clean message). NO napi here.
   - **`#[napi]` provider facades** (`alpaca/finnhub/yahoo *_streamer.rs`) — bridge to a catchable JS
     exception: `WebsocketStreamerHost::new(...).map_err(|e| napi::Error::from_reason(e.to_string()))?`.
     The napi constructor/factory must itself return `napi::Result<…>` so the throw is synchronous at JS
     construction.
   - **internal `host.rs:278`** caller — propagate the `Result` to its caller (no `.unwrap()`/`.expect()`).

**Oracle (flip the existing probe):** `probes/rust/tests/redb_concurrent.rs::q3_shared_path_double_open_panics`
currently asserts the panic/abort. Flip it to assert the fixed contract: the second
`WebsocketStreamerHost::new(shared_path, …)` returns `Err(HostError::DbOpen(_))` — **no panic/abort**
(rename the test accordingly, e.g. `q3_shared_path_double_open_errors`).

---

## 4. Task 2 — TS-side FFI exception capture (fork B)

The TS facade classes that wrap the napi streamers must treat construction as fallible and surface a
clean, catchable error to consumers. The facades are
`ts-markets/src/nasdaq/datafeeds/streaming/{alpaca,yahoo,finnhub}/{Alpaca,Yahoo,Finnhub}Streaming.ts`
(TS classes extending `EventEmitter` that hold the underlying `#[napi]` streamer). The construction of
the napi streamer inside each facade is the catch point.

- Wrap napi construction so the propagated `napi::Error` (from Task 1) bubbles as a standard catchable JS
  error (no swallow, no `process.exit`).
- **TS capture stays independent of `ConfigManager`** (decoupled runtime boundary), but **consumer
  services should `await ConfigManager.getInstance().whenReady()` before FFI construction** (Epic-1
  readiness API) so config-derived db paths are resolved first. Document this ordering at the call site.

**Oracle:** a colocated/integration test that forces a redb-open failure (shared-path env override, or a
prototype-spy/mock) and asserts the JS construction **throws a catchable error** and the process does NOT
exit.

---

## 5. Task 3 — cross-process redb collision probe (fork E1; validation-only)

A new probe under `probes/` (rust integration or a node harness) that spawns **two OS processes** opening
the **same** redb path (via the env override), with process A holding it while process B opens. Asserts
process B observes a **graceful, non-aborting failure** (the Task-1 catchable error / OS lock error),
never a crash cascade. Must account for **Windows mandatory vs Linux advisory** lock behavior (the
assertion is "no process abort + a surfaced error", tolerant of the per-OS error shape). **No production
change** — this validates Task 1 under the real multi-process race the in-process probe couldn't reach.

---

## 6. Task 4 — finnhub `base_url` override (fixes `engine-finnhub-no-endpoint-override-01`; fork E2)

Trivial additive, mirroring Alpaca/Yahoo:

- `FinnhubConfig` (rust) gains `base_url: Option<String>`.
- `FinnhubDriver` formats the websocket URL from `base_url` when present, else the existing hardcoded
  default endpoint (extract the default to a named const). Preserve scheme handling (`wss://…?token=`).
- Unblocks pointing Finnhub at a `localhost:<port>` loopback for deterministic streaming tests on the
  shared engine.

**Oracle:** a unit/probe assertion that `base_url` overrides the endpoint and the default is used when
absent (byte-identical to today when unset).

---

## 7. Task 5 — http-retry clamp + Full Jitter (fixes `-03`, `-04`; fork C)

**Current (`RequestUnlimited.ts:111-128`):** reads `retrieve.timeout` (??50000), `retrieve.retry.limit`
(??5), `retrieve.retry.backoffLimit` (??3000) straight from config into ky options; **no clamp, no
jitter**. A poisoned config value (negative, `NaN`, huge, non-number) flows directly to ky.

**Design (localized in `RequestUnlimited.ts`):**

1. **Named-const ceilings:** `const MAX_RETRY_LIMIT = 10; const MAX_TIMEOUT_MS = 120000; const
   MAX_BACKOFF_LIMIT_MS = 60000;`
2. **A `clampNumber(value, min, max, fallback)` helper** that maps any non-finite / non-number / negative
   input to the fallback, then clamps to `[min, max]`. Apply to the three config reads so the values
   handed to ky are always sane:
   - `limit = clampNumber(cfgRetryLimit, 0, MAX_RETRY_LIMIT, 5)`
   - `timeout = clampNumber(cfgTimeout, 0, MAX_TIMEOUT_MS, 50000)`
   - `backoffLimit = clampNumber(cfgBackoffLimit, 0, MAX_BACKOFF_LIMIT_MS, 3000)`
3. **Full Jitter** via a custom ky `delay`:
   ```ts
   delay: (attempt) =>
     Math.round(Math.random() * Math.min(backoffLimit, 300 * 2 ** (attempt - 1)))
   ```
   (uniform in `[0, min(backoffLimit, base)]` — minimum herd contention; honors the clamped backoffLimit).

**Oracle:** colocated `RequestUnlimited.*.test.ts` — clamp matrix (negative/NaN/Infinity/over-ceiling/non-number
→ clamped-or-fallback), and a jitter bound test (sampled `delay(attempt)` ∈ `[0, min(backoffLimit, base)]`,
monotonic ceiling growth, never exceeds `MAX_BACKOFF_LIMIT_MS`).

---

## 8. Task 6 — TSFN GC-reentrancy stress validation (top residual; fork D2)

**Why:** the reconnect-under-GC probes were green but recorded `DELIVERED = 0` — callback *execution*
under active GC was never proven, leaving a suspected V8/N-API native-thread deadlock vector unvalidated.

**Design:**

1. **A test-only `#[napi]` flood hook** (e.g. `napi_trigger_diagnostic_flood(count, on_event)` in a
   streaming `diagnostics` module). It spawns a **native background thread** that pushes `count` synthetic
   `MarketEvent`s through a ThreadsafeFunction to the JS callback (no network/protocol).
2. **Env-gated no-op (fork D2):** at the top of the hook,
   `if std::env::var("CORELIB_DIAG_FLOOD").unwrap_or_default() != "1" { return Ok(()) }` — always
   compiled (symbol stays in `index.d.ts`), zero-overhead inert in production.
3. **Validation test** (integration tier): set `CORELIB_DIAG_FLOOD=1`, register a JS callback that counts
   `DELIVERED`, run the flood while `global.gc()` churns in a tight loop, and assert **`DELIVERED ===
   count`** (or at minimum `> 0`) with **no deadlock/timeout**. The vitest config for this suite MUST set
   **`execArgv: ["--expose-gc"]`** (else `global.gc` is undefined and throws in CI).

**Oracle:** the test itself — green proves deadlock-free, GC-safe TSFN delivery (`DELIVERED > 0`),
retiring the residual.

---

## 9. Sequencing & error-handling summary

**Order (fork F):** Task 4 + Task 5 (isolated, unblock loopback) → Task 1 + Task 2 (FFI exception seam) →
Task 3 (validates 1/2) → Task 6 (TSFN GC).

| Failure | Behavior |
|---------|----------|
| redb open collision (shared-path override) | pure-Rust `Err(HostError::DbOpen)` → `napi::Error` at the seam → catchable JS throw; **no process abort** |
| CLI bin redb open failure | propagated via `?`/clean exit message (no napi) |
| Poisoned `retrieve.*` config value | clamped to `[0, MAX_*]` or fallback; never reaches ky raw |
| Retry storm | Full-Jitter `delay` spreads attempts; `limit ≤ MAX_RETRY_LIMIT` |
| Diagnostic flood in production | env-gated no-op (`CORELIB_DIAG_FLOOD≠1`) |

---

## 10. Affected files

- **Rust core:** `…/streaming/core/host.rs` (`HostError`, `new → Result`, internal caller), the 3 provider
  `#[napi]` facades (`alpaca/finnhub/yahoo *_streamer.rs` — `map_err` to `napi::Error`), `rust/src/bin/{alpaca,yahoo}_streamer.rs`
  (CLI Result handling), finnhub config/driver (`base_url`), a streaming `diagnostics` module (flood hook).
- **TS:** `ts-core/src/retrieve/RequestUnlimited.ts` (clamp + jitter) + colocated tests; the facades
  `ts-markets/src/nasdaq/datafeeds/streaming/{alpaca,yahoo,finnhub}/*Streaming.ts` (Task 2 catch point) + tests.
- **Probes/tests:** flip `probes/rust/tests/redb_concurrent.rs::q3_…`; new cross-process probe (Task 3);
  TSFN GC validation suite + its `--expose-gc` vitest config.
- **Docs:** ROADMAP.md (mark the cluster resolved on completion); this spec.

No public TS API removed. The `ignoreDeprecations "6.0"` + lefthook gate respected as-is. Verify with the
full gate (`pnpm build-all` incl. Rust + tsup DTS, `pnpm test-all:run`, the probe suites) — Rust changes
mean `cargo build`/`cargo test` are now part of the gate, not just TS.
