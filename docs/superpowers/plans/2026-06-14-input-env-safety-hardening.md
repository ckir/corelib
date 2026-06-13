# Input & Environmental Safety Hardening (Epic 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the "poisoned input / environmental conflict → uncatchable process-abort or DoS" class of defects across the Rust↔JS FFI seam (audit findings -01, -03, -04 + finnhub endpoint override + the TSFN inbound-delivery residual).

**Architecture:** redb-open failures and config-derived retry values are made *fallible-and-bounded* instead of aborting/unbounded. The Rust host stays FFI-agnostic (a pure-Rust `HostError`), converted to a catchable `napi::Error` only at the `#[napi]` boundary so the standalone CLI bins keep compiling. The TSFN inbound-delivery race is finally validated with an env-gated native-thread flood hook under `global.gc()`.

**Tech Stack:** Rust (redb 4.1, napi-rs, tokio), TypeScript (ky, vitest), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-06-14-input-env-safety-hardening-design.md`. Forks settled there (A1/B3/C/D2/E1/F) with agy spec-review fixes folded.

**Sequence (spec fork F):** gate fix → finnhub base_url (4) + retry clamp (5) → redb propagation (1) + TS capture (2) → cross-process probe (3) → TSFN GC (6).

**Verify commands (pinned — avoid the global tsc shim):**
- TS typecheck: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p <pkg>/tsconfig.json` (exit 0)
- TS tests: `cd <pkg> && pnpm exec vitest run <path>`
- Rust: `cargo test --manifest-path rust/Cargo.toml <name>` ; `cargo check --manifest-path rust/Cargo.toml --bins`
- NEVER run a bare emitting `tsc` (no `--noEmit`) or `pnpm build` casually — it pollutes `src/` with `.js`.

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `.github/workflows/pipeline.yml` | add `cargo check --bins` to the per-push pre-flight gate | 1 |
| `rust/src/.../streaming/finnhub/{finnhub_streamer.rs,finnhub_driver.rs}` (+ config) | `base_url: Option<String>` + URL formatting | 2 |
| `ts-markets/.../streaming/finnhub/FinnhubStreaming.ts` | TS `baseUrl?` type + `init()` mapping | 2 |
| `ts-core/src/retrieve/RequestUnlimited.ts` | clamp helper + named ceilings + Full-Jitter `delay` | 3 |
| `ts-core/src/retrieve/RequestUnlimited.retry.test.ts` | clamp matrix + jitter bounds (NEW) | 3 |
| `rust/src/.../streaming/core/host.rs` | `HostError` enum + `new -> Result<Self, HostError>` | 4 |
| `rust/src/bin/{alpaca,yahoo}_streamer.rs` + 3 `#[napi]` provider facades | call-site `?` / `map_err(napi::Error)` | 4 |
| `probes/rust/tests/redb_concurrent.rs` | flip q3: assert `Err`, not panic | 4 |
| `ts-markets/.../streaming/{alpaca,yahoo,finnhub}/*Streaming.ts` (+ tests) | catchable construction error | 5 |
| `probes/.../redb-cross-process.*` (NEW) | 2-process collision validation | 6 |
| `rust/src/.../streaming/diagnostics.rs` (NEW) + napi export | env-gated `napi_trigger_diagnostic_flood` | 7 |
| TSFN GC validation suite (NEW) + its vitest config `execArgv:["--expose-gc"]` | `DELIVERED===count`, no deadlock | 7 |

---

## Task 1: CI gate — compile the standalone Rust CLI bins per push (agy Fix 1)

**Why first:** Task 4 changes `WebsocketStreamerHost::new`'s signature; the CLI bins (`rust/src/bin/*_streamer.rs`) are only compiled in the tag-gated `build-rust` job today, so a break would pass PR CI undetected. Land the gate first.

> **agy plan-review Fix 1:** the Stage-1 `validate` job has **no Rust toolchain** — adding `cargo check` there fails / triggers a 3-5 min cold compile that blows the ~1-min pre-flight budget. Put the check in the **Stage-2 `test` matrix job**, which already installs the Rust toolchain (cached) and has a "Build Rust FFI" step.

**Files:**
- Modify: `.github/workflows/pipeline.yml` (the `test` matrix job, ~lines 55-95 — NOT `validate`)

- [ ] **Step 1: Add a `cargo check` step to the `test` job**, immediately AFTER the existing "Build Rust FFI" step (~line 84-90). Insert:

```yaml
      - name: Compile check Rust bins + tests
        run: cargo check --manifest-path rust/Cargo.toml --bins --tests
```
(`--bins --tests` compiles the standalone `*_streamer` bins AND the `#[cfg(test)]` helpers so Task 4's call-site changes are fully verified per push, reusing the already-installed/cached toolchain.)

- [ ] **Step 2: Verify the workflow is valid YAML & the step is reachable**

Run: `node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/pipeline.yml','utf8'));console.log('yaml ok')"` (or `rtk yq . .github/workflows/pipeline.yml >/dev/null && echo ok`)
Expected: `yaml ok`

- [ ] **Step 3: Sanity-run the same command locally** (must pass on the CURRENT tree before any Rust change)

Run: `cargo check --manifest-path rust/Cargo.toml --bins --tests`
Expected: `Finished` (exit 0). If it fails on the unchanged tree, STOP and report — the gate must be green before Task 4.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pipeline.yml
git commit -m "ci(epic2): cargo check --bins+tests in the test job (verify CLI bins per push)"
```

---

## Task 2: Finnhub `base_url` override (finding engine-finnhub-no-endpoint-override-01)

**Files:**
- Modify (Rust): `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs` (the `#[napi(object)] FinnhubConfig`), `finnhub_driver.rs` (URL build)
- Modify (TS): `ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts` (the `FinnhubConfig` interface + `init()`)

> Step 0 (state-verify): open the two Rust files, find the `FinnhubConfig` struct and the place the driver builds the websocket URL (the hardcoded `wss://ws.finnhub.io/...` endpoint). Confirm Alpaca/Yahoo expose an analogous override to mirror (`rg "base_url" rust/src/.../alpaca rust/src/.../yahoo`).

- [ ] **Step 1 (Rust): add the field.** In `FinnhubConfig` add `pub base_url: Option<String>,`. Extract the current hardcoded endpoint to `const FINNHUB_DEFAULT_WS_URL: &str = "wss://ws.finnhub.io";` (use the actual current literal).

- [ ] **Step 2 (Rust): thread `base_url` through to the driver (agy Fix).** `FinnhubDriver` does not see `FinnhubConfig` — so: add `pub base_url: Option<String>` to `FinnhubDriver`, store it on `FinnhubInner` in `init()` (from `config.base_url`), and pass it when constructing `FinnhubDriver`. Then where the driver builds the connect URL, use `self.base_url.as_deref().unwrap_or(FINNHUB_DEFAULT_WS_URL)` and append the existing `?token=...` path. Keep scheme/query formatting byte-identical when `base_url` is None.

- [ ] **Step 3 (Rust): write/extend a unit test** (colocate in the finnhub module under `#[cfg(test)]`): assert the built URL uses `base_url` when `Some("ws://127.0.0.1:9001")` and the default when `None`.

- [ ] **Step 4: run the Rust test**

Run: `cargo test --manifest-path rust/Cargo.toml finnhub_base_url`
Expected: PASS.

- [ ] **Step 5 (TS): mirror the type.** In `FinnhubStreaming.ts`, add `baseUrl?: string;` to the `FinnhubConfig` interface, and in `init()` map it into the FFI payload object passed to the napi streamer (e.g. `base_url: config.baseUrl`). Match the existing snake_case/camelCase convention used for the other fields.

- [ ] **Step 6 (TS): typecheck**

Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-markets/tsconfig.json`
Expected: `No errors found`.

- [ ] **Step 7: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/finnhub ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts
git commit -m "feat(epic2): finnhub base_url override (Rust + TS) for loopback testing"
```

---

## Task 3: http-retry clamp + Full Jitter (findings -03, -04)

**Files:**
- Modify: `ts-core/src/retrieve/RequestUnlimited.ts` (config-read at lines 109-130)
- Create: `ts-core/src/retrieve/RequestUnlimited.retry.test.ts`

- [ ] **Step 1: Write the failing tests** (`RequestUnlimited.retry.test.ts`). Import the helpers you're about to export (`clampNumber`, `fullJitterDelay`, and the `MAX_*` consts):

```ts
import { describe, expect, it } from "vitest";
import { clampNumber, fullJitterDelay, MAX_RETRY_LIMIT, MAX_BACKOFF_LIMIT_MS } from "./RequestUnlimited";

describe("clampNumber", () => {
  it("falls back on non-finite / non-number / negative", () => {
    expect(clampNumber(Number.NaN, 0, 10, 5)).toBe(5);
    expect(clampNumber(Number.POSITIVE_INFINITY, 0, 10, 5)).toBe(5);
    expect(clampNumber(-3, 0, 10, 5)).toBe(0);         // clamped to min
    expect(clampNumber("9" as unknown as number, 0, 10, 5)).toBe(5); // non-number → fallback
  });
  it("clamps to the ceiling and passes through valid values", () => {
    expect(clampNumber(999, 0, MAX_RETRY_LIMIT, 5)).toBe(MAX_RETRY_LIMIT);
    expect(clampNumber(7, 0, MAX_RETRY_LIMIT, 5)).toBe(7);
  });
});

describe("fullJitterDelay", () => {
  it("stays within [0, min(backoffLimit, base)] and never exceeds the ceiling", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      for (let i = 0; i < 50; i++) {
        const d = fullJitterDelay(attempt, MAX_BACKOFF_LIMIT_MS);
        const base = Math.min(MAX_BACKOFF_LIMIT_MS, 300 * 2 ** (attempt - 1));
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(base);
        expect(d).toBeLessThanOrEqual(MAX_BACKOFF_LIMIT_MS);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ts-core && pnpm exec vitest run src/retrieve/RequestUnlimited.retry.test.ts`
Expected: FAIL (`clampNumber`/`fullJitterDelay` not exported).

- [ ] **Step 3: Implement the helpers + ceilings** at the top of `RequestUnlimited.ts` (after imports):

```ts
export const MAX_RETRY_LIMIT = 10;
export const MAX_TIMEOUT_MS = 120000;
export const MAX_BACKOFF_LIMIT_MS = 60000;

/** Map any non-finite/non-number/out-of-range input to a safe value in [min,max]. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Full-Jitter backoff: uniform in [0, min(backoffLimit, 300*2^(attempt-1))]. */
export function fullJitterDelay(attempt: number, backoffLimit: number): number {
  const base = Math.min(backoffLimit, 300 * 2 ** (attempt - 1));
  return Math.round(Math.random() * base);
}
```

- [ ] **Step 4: Apply clamps + jitter at the config-read** (replace lines 110-129's three reads and the retry options object):

```ts
  const cfgTimeout = clampNumber(ConfigManager.get("retrieve.timeout"), 0, MAX_TIMEOUT_MS, 50000);
  const cfgRetryLimit = clampNumber(ConfigManager.get("retrieve.retry.limit"), 0, MAX_RETRY_LIMIT, 5);
  const cfgBackoffLimit = clampNumber(ConfigManager.get("retrieve.retry.backoffLimit"), 0, MAX_BACKOFF_LIMIT_MS, 3000);
  const defaultRetry = DEFAULT_REQUEST_OPTIONS.retry as Record<string, unknown>;
```
and in the merged `retry` object add the jitter delay alongside `limit`/`backoffLimit`:
```ts
      retry: {
        ...defaultRetry,
        limit: cfgRetryLimit,
        backoffLimit: cfgBackoffLimit,
        delay: (attempt: number) => fullJitterDelay(attempt, cfgBackoffLimit),
      },
```
(Do NOT touch the `shouldRetry`/`beforeRetry` hooks — they are unaffected.)

- [ ] **Step 5: Run tests + the existing RequestUnlimited suite**

Run: `cd ts-core && pnpm exec vitest run src/retrieve`
Expected: PASS (new retry test + existing `RequestUnlimited.test.ts` green — the default behavior with sane config is unchanged).

- [ ] **Step 6: Typecheck + commit**

Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` → `No errors found`
```bash
git add ts-core/src/retrieve/RequestUnlimited.ts ts-core/src/retrieve/RequestUnlimited.retry.test.ts
git commit -m "feat(epic2): clamp retrieve.retry.* + full-jitter backoff (boot -03,-04)"
```

---

## Task 4: redb `?`-propagation (finding -01; forks A1, B3)

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs` (add `HostError`, `new -> Result`)
- Modify call sites: `rust/src/bin/{alpaca,yahoo}_streamer.rs`; the 3 `#[napi]` provider facades (`alpaca/finnhub/yahoo *_streamer.rs`); internal/test helpers (`host.rs:278`, `alpaca:308`, `yahoo:252`)
- Modify (flip oracle): `probes/rust/tests/redb_concurrent.rs` (the `q3_shared_path_double_open_*` test)

> Step 0: `rg "WebsocketStreamerHost::new"` → confirm exactly 8 sites (2 CLI bins, 3 napi facades, 3 test helpers per spec §3). Open `host.rs:51-68`.

- [ ] **Step 1: Flip the probe FIRST (the failing oracle).** In `probes/rust/tests/redb_concurrent.rs`, the q3 test currently asserts the double-open **panics/aborts** (likely via `std::panic::catch_unwind` or `#[should_panic]`). Rewrite it to assert the FIXED contract: opening a second `WebsocketStreamerHost::new(shared_path, ...)` while the first is held returns **`Err(HostError::DbOpen(_))`** (no panic). Rename `q3_shared_path_double_open_panics` → `q3_shared_path_double_open_errors`. (You may need `use` of the host + `HostError`.)

- [ ] **Step 2: Run the probe to verify it FAILS** (against the un-fixed code)

Run: `cargo test --manifest-path probes/rust/Cargo.toml q3_shared_path_double_open_errors`
Expected: FAIL to compile / assert (because `new` still returns `Self` and aborts). This is the red oracle.

- [ ] **Step 3: Add `HostError` + make `new` fallible** in `host.rs`:

```rust
#[derive(Debug)]
pub enum HostError {
    DbOpen(redb::DatabaseError),
}
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { HostError::DbOpen(e) => write!(f, "failed to open redb: {e}") }
    }
}
impl std::error::Error for HostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self { HostError::DbOpen(e) => Some(e) }
    }
}
```
Change `pub fn new(...) -> Self` → `-> Result<Self, HostError>`; body:
```rust
let db = Arc::new(Database::create(&db_path).map_err(HostError::DbOpen)?);
Ok(Self { db, table, source, provider, sub_tx: None, stop_tx: None, monitor_task: None, pump_task: None })
```

- [ ] **Step 4: Fix the 8 call sites.**
  - CLI bins (`bin/{alpaca,yahoo}_streamer.rs`): their `main` **already returns `Result<(), Box<dyn std::error::Error>>`** (agy-confirmed) — just propagate with `new(...)?` (no `exit(1)` boilerplate needed). **No napi here.**
  - napi facades (`alpaca/finnhub/yahoo *_streamer.rs` constructors): make the `#[napi(constructor)]` (or factory) return `napi::Result<Self>` and bridge: `let host = WebsocketStreamerHost::new(...).map_err(|e| napi::Error::from_reason(e.to_string()))?;`
  - test helpers (`host.rs:278`, `alpaca:308`, `yahoo:252` — all `#[cfg(test)]`): `WebsocketStreamerHost::new(...).expect("test host")`.

- [ ] **Step 5: Run the probe + Rust suite + bins check**

Run: `cargo test --manifest-path probes/rust/Cargo.toml q3_shared_path_double_open_errors` → PASS (now `Err`, no abort)
Run: `cargo test --manifest-path rust/Cargo.toml` → PASS (existing Rust tests green)
Run: `cargo check --manifest-path rust/Cargo.toml --bins --tests` → `Finished` (the gate from Task 1; proves CLI bins compile)

- [ ] **Step 6: Commit**

```bash
git add rust/src probes/rust/tests/redb_concurrent.rs
git commit -m "feat(epic2): redb open is fallible (HostError) instead of process abort (boot -01)"
```

---

## Task 5: TS-side FFI exception capture (fork B)

**Files:**
- Modify: `ts-markets/src/nasdaq/datafeeds/streaming/{alpaca,yahoo,finnhub}/{Alpaca,Yahoo,Finnhub}Streaming.ts`
- Test: a colocated `*Streaming.ffi-error.test.ts` (or extend existing `*Streaming.test.ts`)

> Context: each facade constructor does `this.rust = new RustXxx(...callbacks)`. After Task 4 the napi constructor throws synchronously on a redb-open failure, so the error already propagates out of `new AlpacaStreaming()`. This task ensures the facade does NOT swallow it, adds a clear message, and documents the readiness ordering.

- [ ] **Step 1: Write the failing test** (mock the native module so its constructor throws):

```ts
import { describe, expect, it, vi } from "vitest";
// agy Fix: the facade reads the native class as `const RustAlpaca = (coreFFI as any)?.AlpacaStreaming`,
// NOT a top-level export — so the mock MUST nest it under `coreFFI` (and keep getMode defined).
vi.mock("@ckir/corelib", () => ({
  coreFFI: {
    AlpacaStreaming: class {
      constructor() { throw new Error("failed to open redb: DatabaseAlreadyOpen"); }
    },
  },
  getMode: () => "production",
}));
// import the FACADE after the mock
import { AlpacaStreaming } from "./AlpacaStreaming";

describe("AlpacaStreaming construction error", () => {
  it("propagates a catchable error and does not exit the process", () => {
    expect(() => new AlpacaStreaming()).toThrow(/redb|open/i);
  });
});
```
(Verify the exact native-binding accessor in the facade's `Streaming.ts` header — `coreFFI?.AlpacaStreaming` — and mirror it in the mock for each provider.)

- [ ] **Step 2: Run to verify it fails or passes-trivially**, then make the facade behavior explicit. In each facade constructor wrap the native construction so the cause is preserved with context (do not catch-and-swallow):

```ts
    try {
      this.rust = new RustAlpaca(/* ...existing 4 callbacks... */);
    } catch (e) {
      throw new Error(`AlpacaStreaming: native init failed (${(e as Error).message})`, { cause: e });
    }
```
Add a doc comment above the class noting: *callers should `await ConfigManager.getInstance().whenReady()` before constructing, so config-derived db paths are resolved; construction throws synchronously on FFI/redb failure — wrap `new` in try/catch.*

- [ ] **Step 3: Run the new test + existing facade suites**

Run: `cd ts-markets && pnpm exec vitest run src/nasdaq/datafeeds/streaming`
Expected: PASS (new error tests + existing `*Streaming.test.ts` green — the happy-path mocks are unaffected).

- [ ] **Step 4: Typecheck + commit**

Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-markets/tsconfig.json` → `No errors found`
```bash
git add ts-markets/src/nasdaq/datafeeds/streaming
git commit -m "feat(epic2): facades surface FFI/redb init failure as catchable JS error"
```

---

## Task 6: cross-process redb collision probe (fork E1; validation-only)

**Files:**
- Create: `probes/rust/tests/redb_cross_process.rs` (or a node harness under `probes/js/`) — choose Rust for direct host access.

> No production change. Validates Task 4 under a real 2-process race.

- [ ] **Step 1: Write the probe.** Spawn a child process (e.g. `std::process::Command` re-invoking the test binary with an arg, or a tiny helper bin) that opens `WebsocketStreamerHost::new(SHARED_PATH, ...)` and **holds** it (sleep). In the parent, after the child has the lock, call `WebsocketStreamerHost::new(SHARED_PATH, ...)` and assert it returns **`Err`** (Windows) or behaves per advisory locks (Linux) — the invariant is **no process abort + a surfaced error/Result**. Use a unique temp `SHARED_PATH` per run.

- [ ] **Step 2: Teardown.** Ensure the child is killed and the temp redb file(s) are removed on completion (agy review §7) — wrap in a guard / `Drop`.

- [ ] **Step 3: Run the probe**

Run: `cargo test --manifest-path probes/rust/Cargo.toml redb_cross_process -- --nocapture`
Expected: PASS on this OS (document the per-OS assertion branch).

- [ ] **Step 4: Commit**

```bash
git add probes/rust/tests/redb_cross_process.rs probes/rust/Cargo.toml
git commit -m "test(epic2): cross-process redb collision probe validates fallible open"
```

---

## Task 7: TSFN GC-reentrancy stress validation (top residual; fork D2)

**Files:**
- Create: `rust/src/markets/nasdaq/datafeeds/streaming/diagnostics.rs` (+ `mod diagnostics;` + napi re-export)
- Create: the validation suite (integration tier) + ensure its vitest config sets `execArgv: ["--expose-gc"]`

- [ ] **Step 1: Implement the env-gated `#[napi]` flood hook** in `diagnostics.rs`:

```rust
// agy Fix: napi here is built WITHOUT the serde-json feature, so ThreadsafeFunction<serde_json::Value>
// will NOT compile. Use ThreadsafeFunction<String> and pass serialized JSON strings (mirrors the
// existing `on_market_event` interface). Error-first delivery → JS sees (null, jsonString).
#[napi]
pub fn napi_trigger_diagnostic_flood(
    count: u32,
    on_event: ThreadsafeFunction<String>,
) -> napi::Result<()> {
    if std::env::var("CORELIB_DIAG_FLOOD").unwrap_or_default() != "1" {
        return Ok(()); // production no-op; symbol stays in index.d.ts
    }
    std::thread::spawn(move || {
        for i in 0..count {
            let ev = format!("{{\"seq\":{i}}}"); // synthetic event as a JSON string
            // handle non-Ok statuses gracefully — never unwrap/panic (Status::Closing/InvalidArg on teardown)
            let _ = on_event.call(Ok(ev), ThreadsafeFunctionCallMode::Blocking);
        }
    });
    Ok(())
}
```
(Match the exact `ThreadsafeFunction<String>` import/alias the streaming crate already uses for `on_market_event`. Do NOT `unwrap` the `call` result.)

Also **register the module** — in `rust/src/lib.rs`, inside the inline `mod streaming { … }` block (~line 70), add:
```rust
pub mod diagnostics;
```
(without this the new file is never compiled — agy Fix).

- [ ] **Step 2: Build the FFI (Rust napi) and confirm the symbol is exported**

> agy Fix: `pnpm --filter @ckir/corelib build` does NOT compile the Rust napi. Build the native addon and copy it:

Run: `cd rust && pnpm run build:local && cp corelib-rust.node ../ts-core/corelib-rust.node`
then `rg "napiTriggerDiagnosticFlood|napi_trigger_diagnostic_flood" rust/index.d.ts ts-core/*.d.ts 2>/dev/null`
Expected: the function appears in the generated napi `.d.ts` (static export; gating is runtime).

- [ ] **Step 3: Ensure `--expose-gc` for the suite.** In the integration vitest config that will run this suite (e.g. `ts-markets/vitest.integration.config.ts`), set `test.poolOptions.forks.execArgv: ["--expose-gc"]` (or the equivalent for the pool in use). Verify other suites are unaffected.

- [ ] **Step 4: Write the validation test** (integration tier):

```ts
import { describe, expect, it } from "vitest";

describe("TSFN delivery under GC stress", () => {
  it("delivers every flooded event with no deadlock under global.gc()", async () => {
    if (!globalThis.gc) { console.warn("skip: run with --expose-gc"); return; } // agy Fix 3
    process.env.CORELIB_DIAG_FLOOD = "1";
    const { napiTriggerDiagnosticFlood } = await import("@ckir/corelib"); // adjust export name
    const COUNT = 5000;
    let delivered = 0;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("deadlock: flood did not complete")), 15000);
      const gcLoop = setInterval(() => globalThis.gc!(), 1);
      napiTriggerDiagnosticFlood(COUNT, (_err: unknown, _ev: unknown) => {
        if (++delivered >= COUNT) { clearInterval(gcLoop); clearTimeout(t); resolve(); }
      });
    });
    expect(delivered).toBe(COUNT);
  });
});
```

- [ ] **Step 5: Run with GC exposed**

Run: `cd ts-markets && pnpm exec vitest run --config vitest.integration.config.ts <suite-path>`
Expected: PASS — `delivered === COUNT`, no timeout. (Run twice to rule out flakiness.)

- [ ] **Step 6: Commit**

```bash
git add rust/src ts-markets/vitest.integration.config.ts <suite-path>
git commit -m "test(epic2): TSFN GC-reentrancy flood validates DELIVERED>0 deadlock-free (residual)"
```

---

## Finalization (after all tasks)

- [ ] Run the full gate: `cargo check --manifest-path rust/Cargo.toml --bins --tests`, `cargo test --manifest-path rust/Cargo.toml`, `pnpm build-all` (tsup DTS incl. the new napi symbol), `pnpm test-all:run`, the probe suites.
- [ ] Mark the cluster resolved in `ROADMAP.md` (redb-double-open, http-retry, finnhub-endpoint, TSFN residual) and flip the spec Status to IMPLEMENTED.
- [ ] convergent agy review (full critical review + one bounded generative question) before merge, per the cadence.
- [ ] superpowers:finishing-a-development-branch.
