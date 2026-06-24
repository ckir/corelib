# Epic 4 — Hot-path & FFI Trace / Flight-Recording Instrumentation — Design Spec

**Date:** 2026-06-14
**Epic:** 4 (roadmap subproject **(a)**; follows Epics 1–3 and the (b-1)/(d)/(c) subprojects, all done)
**Status:** design — production changes IN scope this cycle
**Owner files:** `ts-core/src/{retrieve,database,core,configs}/**`, `ts-markets/src/nasdaq/{datafeeds/polling,groups}/**`, `ts-cloud/src/{core,markets,database}/**`, `rust/src/streaming/**` + the `#[napi]` boundary
**Decisions folded:** Approach 1 (`tracing` crate + ring-buffer Layer; direct §12 on TS) — user-approved. Breadth = **hot-paths + FFI focus** (user + agy). agy divergent pass (`AGY-EPIC4-SCOPE.md`) folded: the Rust ring-buffer flight recorder is agy's design; broad TS-legacy sweep and Phase-A engine extraction are explicitly **NOT** pulled into this epic.

---

## Goal

Make `LOG_LEVEL=trace` produce a record from which an AI agent can **reconstruct the decision chain of the high-value hot paths without reading source** (AGENTS.md §12). Two tracks:

1. **TS hot paths** — apply §12 `debug`/`trace` instrumentation directly to the modules an agent actually needs when debugging (DB ops, FFI load/calls, the retry loop, config boot, the polling loop, request routing).
2. **Rust FFI/streaming hot path** — add a **bounded in-memory ring-buffer flight recorder** (zero I/O under nominal load; dumps the last *N* events on panic / FFI error / explicit signal), since stream-to-stdout tracing across a synchronous NAPI bridge under a market-data flood is a perf hazard.

Leaf / low-value modules are out of scope. This stays on roadmap order — it precedes the (b-2) capstone audit so that audit reviews an instrumented codebase.

## Current state (the gap this closes)

- §12 contract — level semantics: **trace** = per-item hot-loop (per attempt/row/tick, with item identity + computed values); **debug** = per-cycle decisions/state-transitions/summaries (open & close a handler, old→new transitions, no-op decisions); **info** = significant lifecycle events (never downgrade to debug). Strict `(msg, extras?)` signature; structured `extras` over string interpolation for numeric data.
- Coverage gap: only **5 / 66** TS source files emit `trace`/`debug` today (28 have a child logger but no trace instrumentation); the Rust core has **0 / 29** files using any tracing/log facade. The new streaming providers self-instrumented; legacy did not.

## Scope

### In scope — TS hot paths
- **ts-core/src/retrieve/RequestUnlimited.ts** — the retry loop (the canonical §12 example: per-attempt trace).
- **ts-core/src/database/sqlite/sqlite-db.ts**, **postgres/postgres-db.ts** (+ `transaction-context`, drivers) — per-query/per-op, transaction state transitions.
- **ts-core/src/core/index.ts** — FFI load-path resolution (`loadFFI`/`getRequire`) and FFI call sites.
- **ts-core/src/configs/ConfigManager.ts** (+ `ConfigUtils.ts`) — the `initialize()` single-flight boot / `clearAndFill` commit / seeded-default decision chain at **`debug`** (a one-time boot surface, not a per-item loop → high *debug value*, not high frequency; **kept over agy's strip recommendation** because boot races were Epic 1's hardening target and are a prime debug surface). **`decryptConfig` logs decisions/shape ONLY — never secret values or decrypted payloads** (see redaction rule).
- **ts-markets/src/nasdaq/datafeeds/polling/nasdaq/NasdaqPolling.ts** — the poll cycle + per-symbol fetch.
- **ts-markets/src/nasdaq/groups/Top100.ts** — group refresh.
- **ts-cloud/src/core/router.ts** — request dispatch/route selection.
- **ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts**, **database/SqlCloud.ts** — request handlers (entry/exit + error path).

### In scope — Rust
- The streaming/FFI hot path: `WebsocketStreamerHost` connect/reconnect/pump loops, driver `subscribe`/`unsubscribe`/`load_subscriptions`, `MarketEvent` mapping, and TSFN delivery; plus the `#[napi]` boundary. (Exact file list is **state-verified in the plan** — `rust/src/streaming/**`.)

### Out of scope (deferred — do NOT do this cycle)
- Broad §12 sweep of leaf/low-value TS modules (utils leaves, types, logger impls, browser stub) — the not-chosen breadth option.
- **Phase A** (`corelib-streaming` napi-free extraction) — agy lobbied to pull it forward; user kept it deferred. Tracing is added to the streaming path *in place*.
- Carry-forward perf probes (FFI backpressure / long-run mem-leak).
- (b-2) capstone audit (next epic).

## Design

### A. TS hot-path instrumentation (direct §12)
Use each module's child logger (`logger.child({ section })`); add one where missing. Apply the §12 rules per module. Representative trace points (illustrative, not exhaustive — the plan enumerates per file):

- **RequestUnlimited:** `debug` request start `{ urls: N }` / finish `{ ok, retries }`; `trace` per attempt `{ url, attempt, status, elapsedMs, delayMs, willRetry }`; `trace` no-op `skipped-retry (below limit)`; `debug` clamp decisions (old→clamped).
- **sqlite/postgres-db:** `debug` query start `{ op, sqlShape }` / finish `{ rows, elapsedMs }`; `trace` per-row/per-op; `debug` tx state transitions `begin→commit|rollback`.
- **core/index `loadFFI`:** `debug` resolution `{ runtime, chosenPath, found }`; `trace` each candidate path tried; `debug` fallback decision (no-op when `runtime==="cloudflare"`, traced).
- **ConfigManager:** `debug` `initialize` start/finish + single-flight `{ inFlight }`; `debug` `clearAndFill` commit; `trace` seeded-default returns (no-op-before-init); `debug` `decryptConfig` path.
- **NasdaqPolling:** `debug` poll cycle entry/exit `{ symbols, ok, failed }`; `trace` per-symbol `{ symbol, status }`; existing error site keeps `serializeError`.
- **router / cloud handlers:** `debug` dispatch `{ method, path, route }`; `trace` sub-router selection; entry/exit + error on handlers.

### B. Rust ring-buffer flight recorder (agy's design)
- Adopt the **`tracing`** crate as the logging facade across the streaming/FFI hot path (corelib-rust has no logging dep today — greenfield).
- A custom **bounded in-memory ring-buffer `Layer`** (capacity *N*, default ~8–10k events). **Lock-free / poison-free from the start** (agy spec-review): use `crossbeam::ArrayQueue` (bounded, pre-allocated, MPMC) — or `parking_lot::Mutex` if a single-writer design proves sufficient — **never `std::sync::Mutex`**: a thread panicking while holding it poisons the lock, so the panic-hook dump's `.lock()` would double-panic → abort → *lost flight data*, defeating the recorder's entire purpose. Store **structured events** (enum + fields + timestamp), NOT pre-formatted strings — format lazily at dump time to avoid per-trace heap churn/fragmentation on a long-running feed. **Zero file/stdout I/O under nominal operation** — events live in memory.
- **Dump triggers** (flush the last *N* events to stderr in machine-parseable form): (i) a panic hook, (ii) a `HostError` at the FFI boundary, (iii) an env-gated explicit signal (a `#[napi]` diagnostic fn / env var, mirroring the existing `napi_trigger_diagnostic_flood` precedent). The dump path is panic-safe **and poison-free** (lock-free queue, or `parking_lot`/`.into_inner()` recovery) so a dump triggered *by* a panic never double-panics.
- **Bridge discipline (anti trace-storm / backpressure):** per-message/per-tick events are **trace → ring buffer only** (never pushed across the TSFN). Per-cycle `debug` (connect/reconnect/subscribe, counts) and `info` lifecycle events **bridge to the JS `StrictLogger`** via the existing TSFN, so JS-side `LOG_LEVEL=trace` sees the Rust hot-path *decisions* without flooding the bridge with per-tick frames. Levels mirror §12.

### C. Verification ("reconstructable from logs alone")
- **Golden-trace tests:** ≥1 TS hot path (RequestUnlimited retry under `LOG_LEVEL=trace`) asserts the captured log lines contain the full decision chain (`attempt`/`status`/`delayMs`/outcome). A Rust test triggers a dump (panic/error/signal) and asserts the ring buffer flushed the last *N* events with the connect→subscribe→event→error chain.
- **Trace-completeness check** per instrumented hot path: open+close `debug` present and ≥1 per-item `trace` on a populated path.

### Testing & mocks (§11 — cross-cutting, do NOT skip)
- The logger-child mocks need `trace`/`debug` `vi.fn()` (§11) or the new calls throw at runtime. **Do NOT manually sweep dozens of inline mocks** (brittle, merge-conflict-prone — agy spec-review). Instead introduce a **central `createMockLogger()` test helper** (all levels + `child()` returning itself) and migrate the inline `vi.mock("@ckirg/corelib")` logger stubs onto it, so any future level addition is a one-line change. (The plan state-verifies the current mock shape before migrating.)
- Rust: ring-buffer unit tests (bounded growth, wrap-around) + dump-trigger test.

### Error handling / non-functional
- Instrumentation is **behavior-preserving**: trace/debug calls sit behind the logger's level gate (≈0 cost at default level — the DB/throughput concern applies only under `LOG_LEVEL=trace`, a deliberate debug mode); the ring buffer is bounded (no unbounded memory); the dump path is guarded and never alters control flow. No public API or wire-format change.
- **Secret / PII redaction (hard rule, agy spec-review):** never log secret values, decrypted config payloads, auth tokens, or full SQL parameters. Log **shapes, redaction-aware key names (per SysInfo), row counts, and decisions** — not values. Applies especially to `decryptConfig` and the DB adapters — `trace` must not leak credentials/PII.

## Phasing (single epic — ordered tasks)
0. **Test infra:** central `createMockLogger()` helper + migrate inline logger mocks onto it (de-risks every TS task; agy spec-review).
1. **ts-core hot paths** (retrieve/DB/FFI/config) + ts-core trace-completeness test.
2. **ts-markets + ts-cloud hot paths** (polling/groups/router/handlers).
3. **Rust**: `tracing` facade + lock-free ring-buffer `Layer` + poison-safe dump triggers + bridge discipline + ring-buffer/dump tests.
4. **Verification & gate**: golden-trace tests both sides; full gate.

*Sequencing note:* the TS and Rust tracks are **largely independent** — the Rust internal tracing/ring-buffer does NOT change the TS calling contract, so agy's "TS-re-sweep after Rust" risk doesn't apply; TS-first preserves the user's roadmap test-net rationale, and the Rust track may run in parallel. Phase 0 (mock centralization) goes first regardless.

## Finalization gate
3× `tsc --noEmit`; `vitest run` ts-core/ts-cloud/ts-markets (with updated mocks); `cargo test` (ring buffer + dump); `pnpm build-all`; `pnpm lint-all` (0 fixes); a `LOG_LEVEL=trace` smoke on one hot path showing a reconstructable record; **agy convergent review**; superpowers:finishing-a-development-branch.

## agy collaboration (cadence)
Divergent pass **done** (`AGY-EPIC4-SCOPE.md` — ring buffer + narrow breadth folded). **Spec-review done + folded** (`AGY-EPIC4-SPEC-REVIEW.md`): lock-free/poison-free ring buffer (no `std::sync::Mutex`), structured-not-string events, secret/PII redaction rule, central `createMockLogger()` over a 66-file sweep, Phase-0 mock-infra + independence note. Pushed back on agy's "strip ConfigManager" (kept as a debug-value boot surface, with redaction). Next → **agy plan-review**, then **convergent** before merge.
