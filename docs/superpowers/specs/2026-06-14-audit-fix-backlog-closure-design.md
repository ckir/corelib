# Audit Fix-Backlog Closure — Design Spec

**Date:** 2026-06-14
**Epic:** 3 (third fix cycle from the 2026-06-13 monorepo optimization audit; follows Epic 1 boot-hardening and Epic 2 input/env-safety)
**Status:** design — production changes IN scope this cycle
**Owner files:** `ts-core/src/{loggers,database,utils,configs,core}/**`, `ts-cloud/src/{markets,core,platform}/**`, `ts-markets/src/nasdaq/groups/Top100.ts`, `ts-cloud/tsup.config.ts`

---

## Goal

Close the **5 remaining actionable audit findings** so the monorepo audit's "fix" phase is complete, leaving only the perf-probe vectors (FFI backpressure, marshaling leak) for a later, dedicated perf cycle.

## Architecture

One fix-cycle epic, decomposed into **3 sequential, decoupled phases** (single spec; executed subagent-driven with a two-stage review per task, exactly like Epic 2). Phases are ordered by risk — observability (mechanical) → facade HTTP (one-line + test) → edge/bundle (the co-dependent, medium-risk pair). Each phase produces independently-testable, independently-committable changes.

**Tech stack:** TypeScript (vitest, biome), tsup (esbuild) for the Cloudflare/AWS/CloudRun bundles, `serialize-error`, Hono (ts-cloud router), Cloudflare `nodejs_compat`.

**Sequence:** Phase 1 → Phase 2 → Phase 3 (the edge findings are co-dependent and land last, together).

---

## Phase 1 — Observability integrity *(low risk, mechanical)*

### 1a. error-serialization-log-gaps (`phase0-logger-raw-error-sqlite-01`, medium)

**Problem:** caught errors are logged as `{ error: e }` — passing the raw `Error` object to the structured logger. JSON serialization drops non-enumerable `Error` properties (`message`, `stack`) and `cause` chains, so production logs lose the actual failure detail.

**Scope: a full SWEEP of raw-error logger sites** (not just the 4 the audit named — agy's spec-review sweep found more of the same class; fix them all). Confirmed sites (logger called with `{ error: e }`/`{ error: error }`/`{ error: rollbackErr }`/`{ error: result.reason }`):
- `ts-core/src/database/sqlite/sqlite-db.ts` — catch-block error logs (~lines 49, 114, **and the rollback catch ~125 `error: rollbackErr`**).
- `ts-core/src/database/postgres/postgres-db.ts` — (~lines 50, 115, **and rollback ~126**).
- `ts-cloud/src/core/router.ts` — router-level error handler.
- `ts-markets/src/nasdaq/groups/Top100.ts` — group-refresh error log.
- `ts-cloud/src/database/SqlCloud.ts` (~line 68) — `logger?.error("SQL Sub-Router Error", { error })` (agy-found).
- `ts-markets/src/nasdaq/datafeeds/polling/nasdaq/NasdaqPolling.ts` (~line 156) — `{ error: result.reason }` (agy-found).

The implementer's Step-0 should `rg "{ error" ts-core/src ts-cloud/src ts-markets/src` to catch any remaining raw-error sites; fix every one.

**Fix:** wrap with `serializeError(e)` from the `serialize-error` package — `{ error: serializeError(e) }`. This **mirrors the existing precedent** at `ts-core/src/database/core/errors.ts:13` (`logger.error(message, { error: serialized })`), so we are aligning the stragglers to the established pattern, not inventing one. Each file imports `serializeError` if not already present.

**Test:** assert that a logged error payload is a serialized plain object preserving `message` (and `name`), not a bare `Error`. Reuse/extend the existing db-layer logger tests where present; otherwise a focused unit test mocking the logger and asserting the serialized shape.

### 1b. gcp-logger-stray-console-calls (`phase0-logger-gcp-console-01`, low)

**Problem:** `createGcpLogger()` in `ts-core/src/loggers/implementations/gcp.ts` makes 4 `console.*` calls (lines ~8, 31, 33 = progress `console.log`; line ~36 = init-failure `console.error`) that bypass the `StrictLogger` interface.

**Design decision (the one nuance here):** `createGcpLogger()` *constructs* the logger, so it cannot log through the very logger it is building (chicken-and-egg). Therefore:
- The **3 progress `console.log` calls** (init/"config created"/"pino created") are developer noise → **remove** them.
- The **1 init-failure `console.error`** is genuine signal during a bootstrap failure where no structured logger exists yet. Keep a **single** bootstrap-fallback `console.error` (the only justified console use — the logger subsystem itself failed to initialize), and ensure the failure also **propagates** (throw/return-null per the existing contract) so callers fall back to a working logger. Net: 3 removed, 1 retained-and-justified (documented inline as a bootstrap fallback).

---

## Phase 2 — Facade HTTP correctness *(low risk)*

### market-status-http-error-swallow (`facade-market-status-error-status-swallowed-01`, medium)

**Problem:** `ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts` already serializes the error in its log (`error: serializeError(error)`), but its catch block returns the fatal-error body with **HTTP 200** (`return c.json(fatalResult, 200);`, ~line 54). Callers/monitors cannot distinguish a catastrophic failure from success by status code.

**Fix:** return **HTTP 500** on the fatal path — `return c.json(fatalResult, 500);`. The success path (`c.json(result, 200)`) is unchanged. The `fatalResult` body shape is preserved (only the status integer changes), so JSON consumers are unaffected; status-code consumers now see the failure.

**Test:** update `MarketStatusCloud`'s test expectation for the fatal/exception path from 200 → 500 (the existing test asserts the swallowed 200 — it is the oracle that must flip). Confirm the success-path test stays 200.

---

## Phase 3 — Edge compliance + bundle thinning *(medium risk — co-dependent pair, ships together)*

These two findings are **technically co-dependent**: switching the Cloudflare worker bundle to `platform:"browser"` while `ts-core` still has **static** top-level `node:` imports makes esbuild fail to resolve them at build time. So the node-import refactor (3a) is a prerequisite for the bundle change (3b); they land in the same phase.

### 3a. ts-core-node-imports-edge-compat (`phase0-ts-core-node-module-SysInfo-01`, medium)

**Problem:** 4 unconditional static `node:` imports in `ts-core` production source, today masked only by Cloudflare `nodejs_compat` + tsup's specifier rewrite:
- `ts-core/src/configs/ConfigUtils.ts:6` — `import crypto from "node:crypto"`.
- `ts-core/src/core/index.ts:8` — `import { createRequire } from "node:module"`.
- `ts-core/src/utils/SysInfo.ts:11` — `import { createRequire } from "node:module"`.
- `ts-core/src/utils/index.ts:10` — `import { createRequire } from "node:module"`.

**Fix — async-relocate the two async sites; externalize-and-guard the two sync sites (agy spec-review 1.2):**
- **`ConfigUtils.ts`:** `decryptConfig` is already `async` → replace the static import with `const crypto = (await import("node:crypto")).default` (matching the current default-import usage) inside the async function. Static top-level import removed.
- **`core/index.ts`:** `createRequire` exists only to support the **async** `loadFFI()` → move it to `const { createRequire } = await import("node:module")` inside `loadFFI()`'s async context. Static top-level import removed.
- **`SysInfo.ts` / `utils/index.ts` (synchronous — `await import` impossible, and `globalThis.require` is `undefined` under Node/Bun ESM so it is NOT a valid fallback):** KEEP the static `import { createRequire } from "node:module"` (it stays valid because Phase 3b externalizes `node:*`, so under edge it resolves to the `nodejs_compat` builtin and is NOT bundled), but **guard the `createRequire()` *call site*** with `detectRuntime()` (Epic-1's memoized detector) so the edge runtime never *executes* node-only resolution — telemetry/path resolution returns an edge-safe value instead. (Optional hardening: a build-time `define: { __EDGE_RUNTIME__: "true" }` on the worker entry enables esbuild dead-code-elimination of the node:module branch entirely — adopt if the externalized import still bloats the edge bundle.)

**Out of scope (edge-safe, do NOT touch):** `node:events` (`ConfigManager.ts`), `node:stream` (`loggers/implementations/{node,bun,deno}.ts`) — these are provided by `nodejs_compat` and the platform-specific loggers are tree-shaken per runtime (the CF worker uses the cloudflare logger, not `node.ts`). The audit finding scoped specifically to `node:module`/`node:crypto`; leave the others.

**Constraint (contract):** no production code path may change the **synchronous** signature of `getSysInfo`/the path resolvers, and the FFI-load behavior under Node/Bun must remain identical. The edge-boot probe is the oracle.

### 3b. worker-bundle-size-and-platform (`facade-worker-bundle-size-perf-01`, medium)

**Problem:** the Cloudflare worker bundle is **6.29 MB** (gzip 901 KiB). `ts-cloud/tsup.config.ts`'s first entry (`worker: src/platform/cloudflare/worker.ts`) uses `platform:"node"` + `noExternal:[/.*/]`, so esbuild bundles heavy **server-only** transitive deps reachable from `ts-core` (`@google-cloud/*`, `@libsql/client`, `pino-pretty`) that the edge worker never executes.

**Fix:** for the **Cloudflare worker entry ONLY** (the AWS-`handler` and CloudRun-`server` entries legitimately stay `platform:"node"` and must NOT be touched):
- Use **`platform:"neutral"`** — NOT `"browser"`. (agy spec-review 1.1: `ts-core/package.json` declares `"browser": "./dist/browser.js"`, and `browser.ts` only re-exports logging interfaces; under `platform:"browser"` esbuild resolves `@ckir/corelib` to that stub and `createDatabase`/`endPoint` — which `ts-cloud` imports — go unresolved → build fails. `"neutral"` resolves the full default ESM entry `dist/index.js` while still allowing dependency pruning.)
- Mark the server-only/Node-DB packages and `node:*` builtins as **`external`** (`@google-cloud/*`, `@libsql/client`, `pino-pretty`, `node:*`, and any other server-only deps the build surfaces) so they are not bundled; `node:*` is satisfied at runtime by `nodejs_compat` (already enabled).
- Target: **~150 KB** (from 6.29 MB).

**Verification (the oracle for Phase 3):** `pnpm build-all` succeeds; the Cloudflare `dist/cloudflare/worker.js` size drops to roughly the ~150 KB order; the `probes/_harness/edge-boot.mjs` boot probe passes (0 edge failures) under the thinned bundle — proving the worker still boots under `nodejs_compat` with the deps externalized.

---

## Forks settled in this spec

- **Phase-1 gcp console:** remove 3 progress logs; retain ONE justified bootstrap-fallback `console.error` for logger-init failure (+ propagate). (Not a blanket "remove all 4".)
- **Phase-2 status code:** fatal path → **500** (body unchanged).
- **Phase-3 ordering:** node-import refactor (3a) precedes bundle change (3b) in the same phase — co-dependent.
- **Phase-3 platform:** `platform:"neutral"` (NOT `"browser"` — avoids the `@ckir/corelib` browser-stub export clash) for the **Cloudflare worker entry only**; externalize server-only deps + `node:*`; AWS/CloudRun entries untouched.
- **Phase-3 node usage:** `await import` in the already-async `decryptConfig`/`loadFFI`; for the SYNC `SysInfo`/`utils` paths keep the static `node:module` import (externalized in the edge build → resolved via `nodejs_compat`, not bundled) but guard the `createRequire()` *call* with `detectRuntime()` (since `globalThis.require` is `undefined` under Node/Bun ESM). Optional `__EDGE_RUNTIME__` build-define for full dead-code-elimination.
- **Phase-1 scope:** error-serialization is a full SWEEP of raw-error logger sites (incl. agy-found `SqlCloud.ts`, `NasdaqPolling.ts`, and the db rollback catches), not just the 4 the audit named.

## Testing strategy

- **Per task:** TDD where a behavior oracle exists (Phase 2 status flip, Phase 1 serialized-shape); state-verify + mechanical edit + existing-suite-green where the change is mechanical (Phase 1 serialization, gcp console removal).
- **Phase 3** is validated by the **build + edge-boot probe** (not a unit test) — a thinned, edge-booting bundle is the success criterion. Plus `tsc --noEmit` per touched package and the full `pnpm test-all:run` at finalization.
- **Pinned commands** (avoid the global tsc shim): TS typecheck via `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p <pkg>/tsconfig.json`; tests via `pnpm exec vitest run <path>`; never a bare emitting `tsc`/`pnpm build` casually.

## Out of scope (deferred — both agy + Claude agree)

The perf-probe vectors — **FFI backpressure / event-loop starvation under flood** and the **long-running marshaling memory-leak profile** — are a distinct *audit/probe* cycle (heavy load harnesses, V8 heap profiling, mock socket injectors) and are deferred to a dedicated perf sprint, not bundled into this fix cycle.
