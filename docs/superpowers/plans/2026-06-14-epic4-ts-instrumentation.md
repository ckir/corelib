# Epic 4 — TS Hot-Path Trace Instrumentation (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Instrument corelib's TS hot paths with AGENTS.md §12 `debug`/`trace` logging so `LOG_LEVEL=trace` yields a reconstructable decision chain, on top of a central test-logger mock so the new calls don't break existing suites.

**Architecture:** `StrictLogger` already exposes `trace`/`debug`/`child` with the strict `(msg, extras?)` signature (verified). Each module logs via its child logger (or the injected/context logger for DB & cloud). A new `createMockLogger()` test helper (all 6 levels + `child`→self) replaces ad-hoc mocks in the ~10 affected test files. Plan B (Rust ring-buffer flight recorder) is separate.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, the `@ckir/corelib` `StrictLogger`. Spec: `docs/superpowers/specs/2026-06-14-epic4-hotpath-trace-instrumentation-design.md`.

**Verify commands (pinned — avoid the global tsc shim):**
- Typecheck: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p <pkg>/tsconfig.json` (exit 0)
- Tests: from the package dir, `pnpm exec vitest run <relative-path>`
- NEVER run a bare emitting `tsc` (no `--noEmit`).

**§12 rules (apply throughout):** hot-path handler opens+closes with a `debug` summary; per-item iteration emits a `trace` line with item identity + computed values; state transitions logged at `debug` (old→new); no-op decisions still `trace`d; structured `extras` over string interpolation for numeric data; never add `info` for per-cycle data. **Redaction (hard rule):** never log secret values, decrypted payloads, auth tokens, or full SQL params — log shapes/counts/decisions only.

---

## Task 0: Central `createMockLogger()` test helper

**Files:**
- Create: `ts-core/src/test-utils/logger-mock.ts`
- Create: `ts-core/src/test-utils/logger-mock.test.ts`

- [ ] **Step 0 (state-verify):** confirm `ts-core/src/test-utils/` does NOT already exist (recon: it does not). If it exists with a different `createMockLogger`, STOP and report `STATE_MISMATCH`.

- [ ] **Step 1: Write the helper.** Create `ts-core/src/test-utils/logger-mock.ts`:

```ts
import { type Mock, vi } from "vitest";
import type { StrictLogger } from "../loggers/common";

export type MockLogger = {
	trace: Mock; debug: Mock; info: Mock; warn: Mock; error: Mock; fatal: Mock;
	child: Mock; setTelemetry: Mock; silent: Mock; flush: Mock;
	bindings: Mock; level: string; levelVal: number;
};

/**
 * A complete StrictLogger mock for tests. All six levels are vi.fn()s and
 * `child()` returns the SAME mock, so trace/debug calls added by §12
 * instrumentation never throw "x is not a function". Use everywhere a test
 * mocks `@ckir/corelib`'s logger (see AGENTS.md §11/§12).
 */
export function createMockLogger(): MockLogger {
	const mock = {
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
		error: vi.fn(), fatal: vi.fn(),
		child: vi.fn(() => mock),
		setTelemetry: vi.fn(), silent: vi.fn(), flush: vi.fn(),
		bindings: vi.fn(() => ({})), level: "trace", levelVal: 10,
	} as MockLogger;
	return mock;
}

/** Assert the StrictLogger type is satisfied at compile time (no runtime cost). */
export const _typecheck: StrictLogger = createMockLogger() as unknown as StrictLogger;
```

- [ ] **Step 2: Write the test.** Create `ts-core/src/test-utils/logger-mock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMockLogger } from "./logger-mock";

describe("createMockLogger", () => {
	it("exposes all six levels as callable mocks", () => {
		const l = createMockLogger();
		for (const m of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
			expect(typeof l[m]).toBe("function");
			l[m]("msg", { a: 1 });
			expect(l[m]).toHaveBeenCalledWith("msg", { a: 1 });
		}
	});
	it("child() returns a logger with the same level methods (self)", () => {
		const l = createMockLogger();
		const c = l.child({ section: "X" });
		expect(c).toBe(l);
		c.trace("t");
		expect(l.trace).toHaveBeenCalledWith("t");
	});
});
```

- [ ] **Step 3: Run — PASS.** `cd ts-core && pnpm exec vitest run src/test-utils/logger-mock.test.ts` → PASS.
- [ ] **Step 4: Typecheck.** `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**
```bash
git add ts-core/src/test-utils
git commit -m "test(epic4): central createMockLogger() helper (all 6 levels + child→self)"
```

---

## Task 1: Instrument `RequestUnlimited` (retry loop)

**Files:**
- Modify: `ts-core/src/retrieve/RequestUnlimited.ts` (child `requestUnlimitedLogger` exists, line 17)
- Modify: `ts-core/src/retrieve/RequestUnlimited.retry.test.ts` (adopt `createMockLogger`)

- [ ] **Step 0 (state-verify):** confirm `endPoint()` (~line 115), `fullJitterDelay()` (~line 44), the `shouldRetry` predicate (~line 67), `endPoints()` (~line 225), and the existing `trace("Retrying API call", { retryCount })` (~line 85). If signatures differ, report `STATE_MISMATCH` but instrument the equivalent sites.

- [ ] **Step 1: Add the §12 calls.** Using `requestUnlimitedLogger`:
  - `endPoint()` entry (top of the function body): `requestUnlimitedLogger.debug("endPoint: request", { url, timeout, retryLimit, backoffLimit });`
  - `endPoint()` success (just before returning the parsed body): `requestUnlimitedLogger.debug("endPoint: ok", { url, status });`
  - `fullJitterDelay()` (before returning the computed delay): `requestUnlimitedLogger.trace("retry delay computed", { attempt, base, cap, delayMs });`
  - `shouldRetry` predicate — both branches:
    - retryable: `requestUnlimitedLogger.trace("retry decision", { status, willRetry: true });`
    - non-retryable / below-limit no-op: `requestUnlimitedLogger.trace("retry decision: skip", { status, willRetry: false });`
  - `endPoints()` (batch) entry: `requestUnlimitedLogger.debug("endPoints: batch", { count: urls.length });` and after settling: `requestUnlimitedLogger.debug("endPoints: done", { ok, failed });`
  - SHAPE-DIVERGENCE STOP: add only log calls; do not change retry/backoff logic, return types, or the existing warn/error lines.

- [ ] **Step 2: Adopt the mock + assert.** In `RequestUnlimited.retry.test.ts`, replace the inline logger mock with the helper and add assertions. Ensure the `vi.mock("@ckir/corelib")` returns a logger built from `createMockLogger` (capture it via `vi.hoisted`):

```ts
// `vi.mock` is HOISTED above imports, so the factory CANNOT reference the
// imported helper (ReferenceError). Build the mock INSIDE vi.hoisted() with the
// same shape as createMockLogger (self-returning child — see Task 0 rationale):
const { mockLogger } = vi.hoisted(() => {
	const m: Record<string, ReturnType<typeof vi.fn>> & { child?: unknown } = {
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
	};
	m.child = vi.fn(() => m);
	return { mockLogger: m };
});
vi.mock("@ckir/corelib", async (orig) => ({ ...(await (orig() as Promise<object>)), default: mockLogger, logger: mockLogger }));
```
(Only `vi.mock` factories hit the hoisting trap. Direct-construction tests — those that PASS a logger in, e.g. the DB and cloud-handler tests — just `import { createMockLogger }` normally. — agy plan-review.) Add to an existing retry test:
```ts
expect(mockLogger.debug).toHaveBeenCalledWith("endPoint: request", expect.objectContaining({ url: expect.any(String) }));
expect(mockLogger.trace).toHaveBeenCalledWith("retry decision", expect.objectContaining({ willRetry: expect.any(Boolean) }));
```

- [ ] **Step 3: Run — PASS.** `cd ts-core && pnpm exec vitest run src/retrieve/RequestUnlimited.retry.test.ts` → PASS.
- [ ] **Step 4: Typecheck ts-core** → exit 0 (pinned tsc).
- [ ] **Step 5: Commit**
```bash
git add ts-core/src/retrieve/RequestUnlimited.ts ts-core/src/retrieve/RequestUnlimited.retry.test.ts
git commit -m "feat(epic4): §12 trace/debug on RequestUnlimited retry loop"
```

---

## Task 2: Instrument SQLite + Postgres DB (query + transaction)

**Files:**
- Modify: `ts-core/src/database/sqlite/sqlite-db.ts` (logger via `this.config.logger`, no module child)
- Modify: `ts-core/src/database/postgres/postgres-db.ts` (structurally identical)
- Modify: their `*.test.ts` (adopt `createMockLogger`; pass it as `config.logger`)

- [ ] **Step 0 (state-verify):** confirm both classes use `this.config.logger?.<level>(...)` (no `.child`), `query()` (~line 26), `transaction()` (~line 70 with begin/commit/rollback + `isNested`). Report `STATE_MISMATCH` if the injected-logger shape differs.

- [ ] **Step 1: Add §12 calls in BOTH files** (use `this.config.logger?.` exactly as the existing error lines do — optional chaining):
  - `query()` entry: `this.config.logger?.debug("query: exec", { sql, hasParams: params != null, nested: this.txDriver != null });` (use the file's actual param/driver names from Step 0 — `sql` is already in scope at the error sites).
  - `query()` success exit: `this.config.logger?.debug("query: ok", { rows: result?.length ?? 0 });` (use the actual result shape; if rowcount unavailable, log `{ ok: true }`).
  - `transaction()` entry: `this.config.logger?.debug("tx: begin", { isNested });`
  - `transaction()` commit path: `this.config.logger?.debug("tx: commit", { isNested });`
  - rollback path (next to the existing rollback warn): keep the warn; add nothing duplicate.
  - REDACTION: log `sql` (the statement shape) but NEVER `params` values — only `hasParams`. SHAPE-DIVERGENCE STOP: log calls only; no change to query/tx control flow.

- [ ] **Step 2: Tests.** In `sqlite-db.test.ts` and `postgres-db.test.ts`, build the injected logger via `createMockLogger()` and assert:
```ts
import { createMockLogger } from "../../test-utils/logger-mock";
const logger = createMockLogger();
// ...construct the Db with config including { logger } ...
// after a query:
expect(logger.debug).toHaveBeenCalledWith("query: exec", expect.objectContaining({ sql: expect.any(String) }));
// assert params VALUES never appear:
expect(logger.debug).not.toHaveBeenCalledWith("query: exec", expect.objectContaining({ params: expect.anything() }));
```

- [ ] **Step 3: Run — PASS.** `cd ts-core && pnpm exec vitest run src/database` → PASS.
- [ ] **Step 4: Typecheck ts-core** → exit 0.
- [ ] **Step 5: Commit**
```bash
git add ts-core/src/database
git commit -m "feat(epic4): §12 debug on sqlite/postgres query+transaction (sql shape only, no params)"
```

---

## Task 3: Instrument FFI load (`core/index.ts`)

**Files:**
- Modify: `ts-core/src/core/index.ts` (child `coreLogger`, line 18)
- Modify: `ts-core/src/core/*.test.ts` (adopt helper if it mocks the logger)

- [ ] **Step 0 (state-verify):** confirm `loadFFI()` (~line 53), the cloudflare early-return (~line 56), the `pathsToTry` population (~lines 78–104), the `find(existsSync)` resolution (~line 114), and `getRequire()` (~line 25). Report `STATE_MISMATCH` if changed.

- [ ] **Step 1: Add §12 calls** via `coreLogger`:
  - `loadFFI()` entry: `coreLogger.debug("loadFFI: start", { runtime });`
  - cloudflare bail-out: `coreLogger.debug("loadFFI: skipped (edge runtime)", { runtime });` before `return null`.
  - per candidate path (inside or right after building `pathsToTry`): `coreLogger.trace("loadFFI: candidate", { path });` for each (a small loop over `pathsToTry`, or trace the array: `coreLogger.trace("loadFFI: candidates", { paths: pathsToTry });`).
  - after resolution: `coreLogger.debug("loadFFI: resolved", { found: libPath != null, libPath });` (libPath is a path, not a secret — safe).
  - SHAPE-DIVERGENCE STOP: log calls only; do not alter the dynamic-import/DCE logic from Epic 3.

- [ ] **Step 2: Test.** If a `core/*.test.ts` mocks the logger, migrate to `createMockLogger`; add `expect(logger.debug).toHaveBeenCalledWith("loadFFI: start", expect.objectContaining({ runtime: expect.any(String) }))`. If FFI load isn't unit-tested, add a minimal test that imports the module under Node and asserts `coreLogger.debug` fired for `loadFFI: start` (using the mocked logger).
- [ ] **Step 3: Run — PASS.** `cd ts-core && pnpm exec vitest run src/core` → PASS.
- [ ] **Step 4: Typecheck ts-core** → exit 0.
- [ ] **Step 5: Commit**
```bash
git add ts-core/src/core
git commit -m "feat(epic4): §12 debug/trace on FFI load-path resolution"
```

---

## Task 4: Instrument ConfigManager boot (+ decrypt redaction)

**Files:**
- Modify: `ts-core/src/configs/ConfigManager.ts` (static child `_logger`, line 131)
- Modify: `ts-core/src/configs/ConfigManager.test.ts` (adopt helper)
- (ConfigUtils.decryptConfig has no logger — log from the ConfigManager call site, NOT inside ConfigUtils.)

- [ ] **Step 0 (state-verify):** confirm `runInitSequence()`/`initialize()` (~line 247), `processHierarchy()` (~line 480), `fetchExternalConfig()` (~line 414) calling `decryptConfig(content)` (~line 433), `applyEnvOverrides()` (~line 536), `applyCliOverrides()` (~line 555). Report `STATE_MISMATCH` otherwise.

- [ ] **Step 1: Add §12 calls** via `ConfigManager._logger` (all `debug`, this is a one-time boot path — NOT per-item trace except the override loops):
  - init start: `ConfigManager._logger.debug("initialize: start");`
  - after argv/configPath detection: `ConfigManager._logger.debug("initialize: resolved", { appName, platform, mode });` (use the actual resolved vars from `processHierarchy`).
  - after `clearAndFill` commit: `ConfigManager._logger.debug("initialize: committed", { keys: Object.keys(this._config ?? {}).length });` (count only — never values).
  - `fetchExternalConfig`: `ConfigManager._logger.debug("external config", { source });` (http|file — the source TYPE, not the URL/content).
  - decrypt call site (line ~433, around `await decryptConfig(content)`): wrap with `ConfigManager._logger.debug("decrypting .enc config");` before and `ConfigManager._logger.debug("decryption ok");` after. **NEVER log `content`, the password, or the decrypted object.**
  - `applyEnvOverrides`: per matched key → `ConfigManager._logger.trace("env override", { key });` (key NAME only — values may be secret).
  - `applyCliOverrides`: per applied key → `ConfigManager._logger.trace("cli override", { key });` (name only; the existing prototype-pollution warn stays).
  - SHAPE-DIVERGENCE STOP: log calls only; do not touch the single-flight/clearAndFill/override logic from Epic 1.

- [ ] **Step 2: Test.** Migrate `ConfigManager.test.ts`'s logger mock to `createMockLogger`; assert `expect(logger.debug).toHaveBeenCalledWith("initialize: start")` and a redaction guard: `expect(logger.trace).not.toHaveBeenCalledWith("env override", expect.objectContaining({ value: expect.anything() }))`.
- [ ] **Step 3: Run — PASS.** `cd ts-core && pnpm exec vitest run src/configs` → PASS.
- [ ] **Step 4: Typecheck ts-core** → exit 0.
- [ ] **Step 5: Commit**
```bash
git add ts-core/src/configs
git commit -m "feat(epic4): §12 debug on ConfigManager boot; decrypt logs decisions only (no secrets)"
```

---

## Task 5: Instrument ts-markets (NasdaqPolling + Top100)

**Files:**
- Modify: `ts-markets/src/nasdaq/datafeeds/polling/nasdaq/NasdaqPolling.ts` (child `nasdaqPollingLogger`, line 6)
- Modify: `ts-markets/src/nasdaq/groups/Top100.ts` (child `top100Logger`, line 9)
- Modify: `NasdaqPolling.test.ts`, `Top100.test.ts` (adopt helper — note both currently lack `trace` on the child mock)

- [ ] **Step 0 (state-verify):** confirm `NasdaqPolling.poll()` (~line 135) with the per-result loop (~148–159) and `poll-complete` emit (~167); `Top100.getSymbolsTop100()` (~line 74) cache-hit (~76) + in-flight collapse (~81) + populate (~118). Report `STATE_MISMATCH` otherwise.

- [ ] **Step 1: Add §12 calls.**
  - NasdaqPolling `poll()` entry: `nasdaqPollingLogger.debug("poll: cycle", { symbols: this.subscriptions.size });`
  - per result in the loop: `nasdaqPollingLogger.trace("poll: result", { symbol, status: result.status });` (use the loop's actual symbol/result vars).
  - exit / poll-complete: `nasdaqPollingLogger.debug("poll: done", { ok: validResults.length, failed });` (compute `failed = results.length - validResults.length`).
  - Top100 cache hit: `top100Logger.debug("top100: cache hit", { count: cached.length });`
  - in-flight collapse: `top100Logger.debug("top100: join in-flight");`
  - fetch start: `top100Logger.debug("top100: fetch", { url });`
  - populate success: `top100Logger.debug("top100: populated", { count: symbols.length });`
  - SHAPE-DIVERGENCE STOP: log calls only.

- [ ] **Step 2: Tests.** Migrate both test files' logger mock to `createMockLogger` (this also fixes their missing `trace`). Assert e.g. `expect(mockLogger.debug).toHaveBeenCalledWith("poll: cycle", expect.objectContaining({ symbols: expect.any(Number) }))`.
- [ ] **Step 3: Run — PASS.** `cd ts-markets && pnpm exec vitest run src/nasdaq/datafeeds/polling/nasdaq/NasdaqPolling.test.ts src/nasdaq/groups/Top100.test.ts` → PASS.
- [ ] **Step 4: Typecheck ts-markets** → `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-markets/tsconfig.json` exit 0.
- [ ] **Step 5: Commit**
```bash
git add ts-markets/src/nasdaq
git commit -m "feat(epic4): §12 debug/trace on NasdaqPolling cycle + Top100 cache/fetch"
```

---

## Task 6: Instrument ts-cloud (router + MarketStatusCloud + SqlCloud)

**Files:**
- Modify: `ts-cloud/src/core/router.ts` (logger param `logger?`)
- Modify: `ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts` (context logger, child section set in middleware)
- Modify: `ts-cloud/src/database/SqlCloud.ts` (context logger)
- Modify: the corresponding `*.test.ts` (adopt helper / `createMockLogger`)

- [ ] **Step 0 (state-verify):** confirm `createRouter(logger?)` middleware (~line 29), the dev-bindings debug (~45), the 404 handler (~154); `MarketStatusCloud` GET handler (~39) + error (~45); `SqlCloud` POST handler (~33) + validation branches (~36–51) + error (~69). Report `STATE_MISMATCH` otherwise.

- [ ] **Step 1: Add §12 calls** (use `logger?.` / `c.get("logger")?.` exactly as the existing lines do):
  - router middleware (per request): `logger?.debug("router: request", { method: c.req.method, path: c.req.path });`
  - router 404 handler: `logger?.debug("router: 404", { method: c.req.method, path: c.req.path });`
  - MarketStatusCloud GET entry: `logger?.debug("market-status: request");` and success exit: `logger?.debug("market-status: ok", { status: result.status });` (the fatal path already returns 500 + error log from Epic 3).
  - SqlCloud POST entry: `logger?.debug("sql: request", { hasSql: body?.sql != null, hasParams: body?.params != null });` (NEVER log the sql text/params — booleans only); validation reject: `logger?.debug("sql: rejected", { reason });`; success exit: `logger?.debug("sql: ok", { status: result?.status });`.
  - SHAPE-DIVERGENCE STOP: log calls only; do not change the 500-status behavior or `serializeError` from Epic 3.

- [ ] **Step 2: Tests.** Adopt `createMockLogger` in the affected test files (e.g. `MarketStatusCloud.test.ts` uses a local `mockLogger` — replace with `createMockLogger()`). Assert `expect(mockLogger.debug).toHaveBeenCalledWith("market-status: ok", expect.objectContaining({ status: expect.any(String) }))`. Keep the existing 200/500 status assertions intact.
- [ ] **Step 3: Run — PASS.** `cd ts-cloud && pnpm exec vitest run src` → PASS (8 files).
- [ ] **Step 4: Typecheck ts-cloud** → exit 0.
- [ ] **Step 5: Commit**
```bash
git add ts-cloud/src
git commit -m "feat(epic4): §12 debug on cloud router + market-status + sql handlers (no sql/params logged)"
```

---

## Task 7: Golden-trace test + finalization gate

**Files:**
- Create: `ts-core/src/retrieve/RequestUnlimited.trace.test.ts` (golden-trace: the retry decision chain is reconstructable)

- [ ] **Step 1: Write the golden-trace test.** Capture the sequence of `debug`/`trace` calls during a retried request and assert the chain is complete:

```ts
import { describe, expect, it, vi } from "vitest";
import { createMockLogger } from "../test-utils/logger-mock";

// Mock @ckir/corelib's logger with the helper so endPoint() logs land on it.
const { mockLogger } = vi.hoisted(() => ({ mockLogger: undefined as any }));
vi.mock("@ckir/corelib", async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	const { createMockLogger } = await import("../test-utils/logger-mock");
	const l = createMockLogger();
	(globalThis as any).__m = l;
	return { ...real, default: l, logger: l };
});

describe("RequestUnlimited trace completeness", () => {
	it("a retried request logs the full decision chain at trace/debug", async () => {
		// Arrange a request that fails once then succeeds (MSW or a stubbed fetch),
		// run endPoint(), then assert:
		const l = (globalThis as any).__m as ReturnType<typeof createMockLogger>;
		const msgs = [...l.debug.mock.calls, ...l.trace.mock.calls].map((c) => c[0]);
		expect(msgs).toContain("endPoint: request");           // open
		expect(msgs).toContain("retry delay computed");        // per-attempt trace
		expect(msgs.some((m) => m === "endPoint: ok")).toBe(true); // close
	});
});
```
(Wire the actual fail-then-succeed fetch using the suite's existing MSW/fetch-stub pattern from `RequestUnlimited.retry.test.ts`. SHAPE-DIVERGENCE STOP: if the mock-wiring shape differs, mirror the retry test's existing approach.)

- [ ] **Step 2: Run — PASS.** `cd ts-core && pnpm exec vitest run src/retrieve/RequestUnlimited.trace.test.ts` → PASS.

- [ ] **Step 3: FULL GATE.** Run and confirm all green:
  - `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` → 0
  - same for `ts-cloud` and `ts-markets` → 0
  - `cd ts-core && pnpm exec vitest run` → PASS
  - `cd ts-cloud && pnpm exec vitest run` → PASS
  - `cd ts-markets && pnpm exec vitest run` → PASS
  - `pnpm lint-all` → 0 fixes
  - `pnpm build-all` → success
  - Smoke: `LOG_LEVEL=trace` run of one path shows the reconstructable record (manual eyeball or the golden test above).

- [ ] **Step 4: Commit**
```bash
git add ts-core/src/retrieve/RequestUnlimited.trace.test.ts
git commit -m "test(epic4): golden-trace test — RequestUnlimited retry chain reconstructable from logs"
```

---

## Finalization (after all tasks)

- [ ] Full gate green (above).
- [ ] **agy convergent review** of the TS-instrumentation diff (per cadence) before merge.
- [ ] superpowers:finishing-a-development-branch.
- [ ] Then proceed to **Plan B** (Rust ring-buffer flight recorder) — separate plan.

## Notes / risks

**Cross-cutting rules (apply in every task — folded from agy plan-review):**
- **Run the FULL package suite after each task, not just the touched test** — e.g. `cd ts-core && pnpm exec vitest run` (whole package), not only the new file. This catches *transitive* mock breakage: a test that mocks the logger source an instrumented module actually uses and exercises that path will throw if its mock lacks `trace`/`debug`. If any file breaks, migrate it to `createMockLogger`. (Don't rely on guessing "which ~10 files" — let the suite tell you.)
- **Logger-source nuance:** ts-core modules import the logger via the internal `../loggers` (so a `vi.mock("@ckir/corelib")` does NOT affect them — they use the real logger, which has trace/debug); ts-markets/ts-cloud modules import `{ logger }` from `@ckir/corelib` (so their mocks DO apply). Migrate the mocks that actually apply + whatever the full-suite run flags.
- **Hot-loop allocation guard:** for per-item `trace` inside a hot loop (e.g. NasdaqPolling per-symbol; any per-row DB trace), hoist the logger and guard so the `extras` object isn't allocated when the logger is absent:
  ```ts
  const log = this.config.logger; // or the module's logger
  if (log) log.trace("poll: result", { symbol, status });
  ```
  Per-cycle `debug` (once per query/cycle) may keep plain `logger?.debug(...)` — allocation there is negligible.
- **`vi.mock` factory pattern:** always build the mock inside `vi.hoisted()` (self-returning `child`); never reference the imported helper inside a `vi.mock` factory.
- **`this.config.logger?` / `logger?` optional chaining:** preserve it where present — these loggers can be undefined.
- **No `info` added** for per-cycle data; existing `info` lifecycle lines stay.

**agy plan-review (`AGY-EPIC4-PLAN-REVIEW.md`) disposition:**
- ✅ Folded: vi.mock-hoisting fix (T1/T7); full-suite-per-task gate (mock-scope safety); hot-loop allocation guard.
- ❌ Rejected: agy's "child() must return a NEW isolated mock." Our modules create their child at import; with a **self-returning** child mock the child's calls land on the root mock the test already holds (so `mockLogger.debug` is assertable). A recursive/new-child mock would return an instance the test can't reach → it would BREAK our assertion pattern. **Task 0 keeps `child` → self by design.**
- ⏸️ Held: ConfigManager stays instrumented (Task 4) at `debug` + redacted name-only `trace` (override keys are per-item-at-boot, the correct §12 trace level) — consistent with the approved spec; not "boot info/warn only."
- ⏭️ Deferred (out of Epic 4 scope, candidates for the capstone/Epic 5): cross-module **correlation-ID propagation** (the `section` binding gives partial context; full request-ID is a separate design) and **TS-side log throttling** (`trace` is opt-in via `LOG_LEVEL=trace`, level-gated to ≈0 cost at default; the Rust ring buffer (Plan B) handles the high-velocity streaming volume — a TS throttle would undermine "reconstruct from logs").
