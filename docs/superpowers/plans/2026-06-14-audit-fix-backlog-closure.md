# Audit Fix-Backlog Closure (Epic 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 5 remaining actionable monorepo-audit findings — raw-error log serialization, stray gcp console calls, a market-status HTTP-200-on-error swallow, edge-fragile `node:` imports, and the 6.29 MB Cloudflare worker bundle.

**Architecture:** Three sequential, decoupled phases. Phase 1 (observability) and Phase 2 (facade HTTP) are mechanical/low-risk TS edits. Phase 3 (edge) is the co-dependent pair — the worker bundle can only switch platform once `ts-core`'s `node:` imports are stripped from the edge bundle (a `__EDGE_RUNTIME__` build-define + dead-code-elimination), and the change is validated by booting the **built** `dist/cloudflare/worker.js` under wrangler.

**Tech Stack:** TypeScript (vitest, biome), `serialize-error`, Hono (ts-cloud), tsup/esbuild, Cloudflare `nodejs_compat`/wrangler `unstable_dev`.

**Spec:** `docs/superpowers/specs/2026-06-14-audit-fix-backlog-closure-design.md`. Forks settled there (neutral platform, full sweep, sync-node guard). **agy plan-review fixes folded** (static-import edge crash, false edge-boot oracle, externalize completeness).

**Verify commands (pinned — avoid the global tsc shim):**
- TS typecheck: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p <pkg>/tsconfig.json` (exit 0)
- TS tests: `cd <pkg> && pnpm exec vitest run <path>`
- Build: `pnpm build-all` (tsup). NEVER a bare emitting `tsc` (no `--noEmit`) — it pollutes `src/` with `.js`.
- Edge boot probe (after the Task-5 fix): `node probes/_harness/edge-boot.mjs` (boots the BUILT `dist/cloudflare/worker.js`).

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `ts-core/src/database/{sqlite/sqlite-db,postgres/postgres-db}.ts`, `ts-cloud/src/{core/router,database/SqlCloud}.ts`, `ts-markets/src/nasdaq/{groups/Top100,datafeeds/polling/nasdaq/NasdaqPolling}.ts` | wrap raw `error:` log args with `serializeError` | 1 |
| `ts-core/src/loggers/implementations/gcp.ts` | remove 3 progress `console.log`; keep 1 bootstrap-fallback `console.error` | 2 |
| `ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts` (+ test) | fatal path returns HTTP 500, not 200 | 3 |
| `ts-core/src/configs/ConfigUtils.ts`, `ts-core/src/core/index.ts`, `ts-core/src/utils/{SysInfo,index}.ts`, `ts-core/src/types/edge-runtime.d.ts` (NEW) | strip `node:crypto`/`node:module` static imports from the edge bundle via async/`__EDGE_RUNTIME__`-guarded dynamic import | 4 |
| `probes/_harness/edge-boot.mjs` | boot the BUILT `dist/cloudflare/worker.js` (real oracle), not the TS source | 5 |
| `ts-cloud/tsup.config.ts` | Cloudflare worker entry → `platform:"neutral"` + `define __EDGE_RUNTIME__` + externalize `node:*` & server deps | 6 |

---

## Task 1: error-serialization sweep (finding `phase0-logger-raw-error-sqlite-01`)

**Why:** raw `Error` objects passed to the structured logger as `{ error: e }` serialize to `{}` in JSON (message/stack are non-enumerable; `cause` chains dropped). Wrapping with `serializeError(e)` preserves them — mirroring the existing precedent at `ts-core/src/database/core/errors.ts:13` and `core/transaction-context.ts:36`.

**Files & confirmed sites** (all are `logger…error("…", { error: <X> })`):
- Modify: `ts-core/src/database/sqlite/sqlite-db.ts` (lines ~49 `error: e`, ~114 `error: e`, ~125 `error: rollbackErr`)
- Modify: `ts-core/src/database/postgres/postgres-db.ts` (~50, ~115, ~126 `error: rollbackErr`)
- Modify: `ts-cloud/src/core/router.ts` (router-level error handler)
- Modify: `ts-cloud/src/database/SqlCloud.ts` (~68 `{ error }`)
- Modify: `ts-markets/src/nasdaq/groups/Top100.ts` (group-refresh error log)
- Modify: `ts-markets/src/nasdaq/datafeeds/polling/nasdaq/NasdaqPolling.ts` (~156 `{ error: result.reason }`)
- Test: `ts-core/src/database/sqlite/sqlite-db.serialize.test.ts` (NEW)

- [ ] **Step 0 (state-verify + full sweep):** confirm the sites above, then catch any the audit missed:
  Run: `rg -n "error:\s*(e|err|error|rollbackErr|result\.reason)\b" ts-core/src ts-cloud/src ts-markets/src`
  and `rg -n "\{\s*error\s*\}" ts-core/src ts-cloud/src ts-markets/src`
  Treat EVERY logger call passing a raw caught error (not already `serializeError(...)`) as in-scope. If a site differs from the list, report it but fix it (same pattern).

- [ ] **Step 1: Write the rationale test.** Create `ts-core/src/database/sqlite/sqlite-db.serialize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serializeError } from "serialize-error";

describe("error log serialization contract", () => {
  it("serializeError preserves message + name that bare JSON.stringify drops", () => {
    const e = new Error("boom");
    (e as Error & { cause?: unknown }).cause = new Error("root");
    expect(JSON.stringify(e)).toBe("{}"); // a bare Error stringifies to "{}" — the bug
    const s = serializeError(e) as Record<string, unknown>;
    expect(s.message).toBe("boom");
    expect(s.name).toBe("Error");
    expect(JSON.stringify(s)).toContain("boom");
  });
});
```

- [ ] **Step 2: Run it (PASS — pins the rationale).**
  Run: `cd ts-core && pnpm exec vitest run src/database/sqlite/sqlite-db.serialize.test.ts` → PASS.

- [ ] **Step 3: Apply the sweep.** In EACH file ensure `import { serializeError } from "serialize-error";` exists at the top (add it where missing — `sqlite-db.ts` and `postgres-db.ts` do NOT import it yet). Then wrap each raw error arg: `error: e,` → `error: serializeError(e),`; `error: rollbackErr,` → `error: serializeError(rollbackErr),`; `{ error }` → `{ error: serializeError(error) }`; `error: result.reason,` → `error: serializeError(result.reason),`.

  SHAPE-DIVERGENCE STOP: change ONLY the error argument — not the message, the log level, or sibling fields. Skip any site already using `serializeError`.

- [ ] **Step 4: Verify suites + typecheck (3 packages).**
  Run: `cd ts-core && pnpm exec vitest run src/database` → PASS
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` → exit 0
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-cloud/tsconfig.json` → exit 0
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-markets/tsconfig.json` → exit 0

- [ ] **Step 5: Commit**
```bash
git add ts-core/src/database ts-cloud/src ts-markets/src/nasdaq
git commit -m "fix(epic3): serializeError on all raw-error logger sites (audit phase0-logger-raw-error)"
```

---

## Task 2: gcp logger stray console calls (finding `phase0-logger-gcp-console-01`)

**Files:** Modify `ts-core/src/loggers/implementations/gcp.ts`.

> Step 0 (state-verify): confirm `createGcpLogger()` has 3 progress `console.log` (lines ~8, ~31, ~33) and one `console.error` in `catch (err)` (~36) that then falls back to a basic pino logger.

- [ ] **Step 1: Remove the 3 progress `console.log` lines** (~8 `"Initializing GCP specific logger..."`, ~31 `"Config created successfully"`, ~33 `"Pino instance created"`). Delete them entirely.

- [ ] **Step 2: Keep the catch `console.error` (~36) as the single justified bootstrap fallback**, documented inline. Replace the line with:
```ts
		// Bootstrap fallback: the structured logger itself failed to init, so console
		// is the only available sink. We then degrade to a basic pino logger (below).
		console.error("[GCP-LOGGER] Failed to initialize GCP logger:", err);
```

- [ ] **Step 3: Typecheck**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` → exit 0

- [ ] **Step 4: Commit**
```bash
git add ts-core/src/loggers/implementations/gcp.ts
git commit -m "fix(epic3): drop 3 progress console.log in createGcpLogger; keep documented bootstrap-fallback"
```

---

## Task 3: market-status HTTP-error swallow (finding `facade-market-status-error-status-swallowed-01`)

**Files:** Modify `ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts` (~line 54) + `ts-cloud/src/markets/nasdaq/MarketStatusCloud.test.ts` (~line 101).

> Step 0: confirm success path `return c.json(result, 200);` (~42) and catch fatal path `return c.json(fatalResult, 200);` (~54). The error is ALREADY logged via `serializeError(error)` (~46) — change ONLY the status code.

- [ ] **Step 1: Flip the test oracle FIRST.** In `MarketStatusCloud.test.ts`, the fatal/exception scenario asserts the swallowed 200 (agy confirmed ~lines 101–102: `expect(res.status).toBe(200);`). Change that to `expect(res.status).toBe(500);`. Leave success-scenario assertions at 200.

- [ ] **Step 2: Run — FAIL** (code still returns 200):
  Run: `cd ts-cloud && pnpm exec vitest run src/markets/nasdaq/MarketStatusCloud.test.ts` → FAIL (got 200, expected 500).

- [ ] **Step 3: Fix the code.** Change the fatal return to `return c.json(fatalResult, 500);`. Leave `fatalResult` and the success path unchanged.

- [ ] **Step 4: Run — PASS**
  Run: `cd ts-cloud && pnpm exec vitest run src/markets/nasdaq/MarketStatusCloud.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-cloud/tsconfig.json` → exit 0
```bash
git add ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts ts-cloud/src/markets/nasdaq/MarketStatusCloud.test.ts
git commit -m "fix(epic3): MarketStatusCloud returns HTTP 500 (not 200) on fatal error"
```

---

## Task 4: strip `node:` static imports from the edge bundle (finding `phase0-ts-core-node-module-SysInfo-01`; part 1 of the co-dependent pair)

**Why (agy plan-review correction):** ES-module **static** imports resolve at module-LOAD time, BEFORE any runtime/call guard runs. Cloudflare's `nodejs_compat` does NOT provide `node:module` (it provides `node:events`/`node:stream` etc. but not the ESM require shim), so a static `import { createRequire } from "node:module"` left in `worker.js` makes workerd throw `No such module 'node:module'` and crash at startup — call-guards do not help. We must keep `node:module`/`node:crypto` out of the **edge** bundle entirely. Use a build-time `__EDGE_RUNTIME__` define (set only on the worker build, Task 6) so esbuild dead-code-eliminates the dynamic import for edge while Node/Bun keep full behavior.

**Files:**
- Create: `ts-core/src/types/edge-runtime.d.ts` (ambient `__EDGE_RUNTIME__` global)
- Modify: `ts-core/src/configs/ConfigUtils.ts`, `ts-core/src/core/index.ts`, `ts-core/src/utils/SysInfo.ts`, `ts-core/src/utils/index.ts`

- [ ] **Step 0 (state-verify):** confirm `ConfigUtils.ts:6` = `import crypto from "node:crypto";` (used at `crypto.createDecipheriv` in async `decryptConfig`); and `core/index.ts:8`, `SysInfo.ts:11`, `utils/index.ts:10` each = `import { createRequire } from "node:module";` feeding a `getRequire()` that does `_require = createRequire(import.meta.url)` inside an `if (import.meta?.url)` guard with a throwing-stub fallback. If a structure differs, STOP and report `STATE_MISMATCH`.

- [ ] **Step 1: Declare the build-time global.** Create `ts-core/src/types/edge-runtime.d.ts`:
```ts
// Build-time constant: `true` only in the Cloudflare worker bundle (tsup `define`),
// `undefined` everywhere else. Gates Node-only dynamic imports for dead-code elimination.
declare const __EDGE_RUNTIME__: boolean | undefined;
```

- [ ] **Step 2: ConfigUtils.ts — lazy-load crypto in the async function.** Remove the top-level `import crypto from "node:crypto";` (line 6). Inside `decryptConfig` (already `async`), after `const { getEnv } = await import("../utils");` add:
```ts
	const crypto = (await import("node:crypto")).default;
```
(Default-import binding preserved — do NOT switch to `* as crypto`.)

- [ ] **Step 3: core/index.ts / SysInfo.ts / utils/index.ts — replace the static `node:module` import with a `__EDGE_RUNTIME__`-guarded top-level dynamic import.** In EACH of the three files, delete `import { createRequire } from "node:module";` and add near the top (this codebase already uses top-level await, e.g. `core/index.ts`'s `coreFFI = await loadFFI()`):
```ts
let _createRequire: ((id: string) => unknown) | undefined;
if (typeof __EDGE_RUNTIME__ === "undefined" || !__EDGE_RUNTIME__) {
	_createRequire = (await import("node:module")).createRequire;
}
```
Then update each `getRequire()` so it uses `_createRequire` and tolerates it being `undefined` (edge). Change the existing guarded call:
```ts
	if (typeof import.meta !== "undefined" && import.meta.url) {
		try { _require = createRequire(import.meta.url); } catch (_e) {}
	}
```
to:
```ts
	if (_createRequire && typeof import.meta !== "undefined" && import.meta.url) {
		try { _require = _createRequire(import.meta.url); } catch (_e) {}
	}
```
(`core/index.ts`'s variant uses a single `if (isNodeLike && import.meta?.url)` — add `_createRequire &&` to that condition and call `_createRequire(...)`.) The existing `globalThis.require` / throwing-stub fallbacks stay, so under edge (where `_createRequire` is DCE'd to `undefined`) `getRequire()` cleanly falls through.

  SHAPE-DIVERGENCE STOP: the `_createRequire(import.meta.url)` call must return the same `require` function the old `createRequire(import.meta.url)` did under Node/Bun; do not change `getRequire()`'s synchronous signature or its return type. If a file's `getRequire` is exported and consumed synchronously, the top-level `await import` (module-level) still resolves before any consumer runs — preserve the sync function.

- [ ] **Step 4: Verify no `node:module`/`node:crypto` STATIC import remains in ts-core production:**
  Run: `rg -n 'import .* from "node:(module|crypto)"' ts-core/src --glob '!**/*.test.ts'`
  Expected: NO matches (all three `createRequire` sites + ConfigUtils now use dynamic import). `node:events`/`node:stream` are out of scope (edge-safe via nodejs_compat) — leave them.

- [ ] **Step 5: Typecheck + ts-core tests (Node behavior unchanged).**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` → exit 0 (the ambient `__EDGE_RUNTIME__` decl makes the guard typecheck)
  Run: `cd ts-core && pnpm exec vitest run src/configs src/utils src/core` → PASS (under Node `__EDGE_RUNTIME__` is undefined → `_createRequire` loads normally; decrypt + FFI + telemetry paths behave identically)

- [ ] **Step 6: Commit**
```bash
git add ts-core/src/types/edge-runtime.d.ts ts-core/src/configs/ConfigUtils.ts ts-core/src/core/index.ts ts-core/src/utils/SysInfo.ts ts-core/src/utils/index.ts
git commit -m "fix(epic3): dynamic-import node:crypto/node:module behind __EDGE_RUNTIME__ so edge bundle drops them (boot-safe)"
```

---

## Task 5: make the edge-boot probe a REAL oracle (prerequisite for Task 6)

**Why (agy plan-review correction):** `probes/_harness/edge-boot.mjs` currently calls `unstable_dev("src/platform/cloudflare/worker.ts", …)` — pointing wrangler at the TS **source**, so wrangler recompiles on the fly and **bypasses** the tsup `dist/cloudflare/worker.js`. It would pass even if Task 6's bundle is broken. Point it at the **built** asset so it validates the real deployable bundle.

**Files:** Modify `probes/_harness/edge-boot.mjs` (~line 107, the `unstable_dev(...)` entry path).

- [ ] **Step 0 (state-verify):** open `probes/_harness/edge-boot.mjs` and confirm it calls `unstable_dev("src/platform/cloudflare/worker.ts", { config: wranglerConfig })` (~line 107). Note the exact entry string + options.

- [ ] **Step 1: Ensure the build exists first**, then point the probe at the built bundle. Change the entry path from the source to the built asset (path relative to the probe's resolution — use the repo-root-relative `ts-cloud/dist/cloudflare/worker.js`, adjusting to however the file resolves paths; check the file's existing path handling):
```js
  worker = await unstable_dev("ts-cloud/dist/cloudflare/worker.js", { config: wranglerConfig });
```
Add a guard near the top of the boot routine: if the built file is missing, fail loudly with a message telling the runner to `pnpm build-all` first (so a stale/missing build is an obvious error, not a silent source-recompile).

  SHAPE-DIVERGENCE STOP: keep `unstable_dev`'s options object (`{ config: wranglerConfig }`) intact; only the entry path changes. If the probe already resolves paths from a specific base dir, honor it (the goal: the file actually loaded is the tsup output, not `worker.ts`).

- [ ] **Step 2: Sanity-run against the CURRENT (pre-Task-6) build** to confirm the probe still works pointed at the built asset:
  Run: `pnpm build-all` then `node probes/_harness/edge-boot.mjs`
  Expected: it loads `dist/cloudflare/worker.js`. (The current 6 MB `platform:"node"` bundle may or may not boot clean under workerd — RECORD the result; if it already fails to boot, that's the pre-existing fragility this epic fixes, and Task 6 must turn it GREEN.)

- [ ] **Step 3: Commit**
```bash
git add probes/_harness/edge-boot.mjs
git commit -m "test(epic3): edge-boot probe boots the BUILT dist/cloudflare/worker.js (real oracle, not source recompile)"
```

---

## Task 6: Cloudflare worker bundle thinning (finding `facade-worker-bundle-size-perf-01`; part 2 — validated by the Task-5 oracle)

**Files:** Modify `ts-cloud/tsup.config.ts` — the FIRST entry only (`worker: src/platform/cloudflare/worker.ts`, `outDir: "dist/cloudflare"`). The `handler` (AWS) and `server` (CloudRun) entries stay `platform:"node"` and MUST NOT change.

> Step 0 (state-verify): confirm entry[0] has `noExternal: [/.*/]`, `platform: "node"`, `minify: true`, `outDir: "dist/cloudflare"`. Record the current built size: `ls -la ts-cloud/dist/cloudflare/worker.js` (expect ~6 MB).

- [ ] **Step 1: Switch the Cloudflare worker entry to a thin, edge-correct build.** In entry[0] ONLY:
  - `platform: "node"` → `platform: "neutral"` (NOT `"browser"` — that resolves `@ckir/corelib` to its logging-only `browser.js` stub and breaks `createDatabase`/`endPoint`).
  - replace `noExternal: [/.*/]` with the externals (agy-completed list — server-only/runtime-provided deps reachable from `@ckir/corelib`):
```ts
			external: [
				/^node:/,
				"@google-cloud/pino-logging-gcp-config",
				"@libsql/client",
				"pino-pretty",
				"pino-lambda",
				"pino-socket",
				"postgres",
			],
```
  - add the build-time define that lets Task-4's guards dead-code-eliminate the Node-only dynamic imports:
```ts
			define: { __EDGE_RUNTIME__: "true" },
```
  Keep `format`/`target`/`shims`/`minify`/`clean`/`outDir` as-is. `/^node:/` externalizes `node:*` (genuinely-used ones like `node:events`/`node:stream` are satisfied at load-time by `nodejs_compat`; `node:module`/`node:crypto` are now DCE'd out by the define so they are never referenced).

  SHAPE-DIVERGENCE STOP: do NOT touch entry[1]/entry[2]. If `"neutral"` surfaces additional unresolved server-only packages at build time, ADD each to `external` (report it) — do not revert to `platform:"node"`.

- [ ] **Step 2: Build + measure.**
  Run: `pnpm build-all`
  Then: `ls -la ts-cloud/dist/cloudflare/worker.js` — size should drop from ~6 MB toward the ~150 KB order. Report before/after. (If still multi-MB, generate an esbuild metafile / inspect to find the remaining heavy dep and add it to `external`.)

- [ ] **Step 3: Edge-boot the BUILT bundle (the Phase-3 oracle, now real after Task 5):**
  Run: `node probes/_harness/edge-boot.mjs`
  Expected: 0 edge failures — `dist/cloudflare/worker.js` imports + boots under workerd/`nodejs_compat` with `node:module`/`node:crypto` absent and server deps externalized. If a genuinely-needed symbol was externalized and boot fails on it, move that dep OUT of `external` (report it).

- [ ] **Step 4: Typecheck + confirm AWS/CloudRun unaffected.**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-cloud/tsconfig.json` → exit 0
  Confirm `dist/aws/handler.mjs` + `dist/cloudrun/server.js` still built by Step 2.

- [ ] **Step 5: Commit**
```bash
git add ts-cloud/tsup.config.ts
git commit -m "perf(epic3): thin CF worker bundle via platform:neutral + __EDGE_RUNTIME__ define + externalize node:*/server deps (6.29MB->~150KB)"
```

---

## Finalization (after all tasks)

- [ ] Full gate: `node …/tsc --noEmit` per package; `cd ts-core && pnpm exec vitest run`; `cd ts-cloud && pnpm exec vitest run`; `cd ts-markets && pnpm exec vitest run`; `pnpm build-all`; `node probes/_harness/edge-boot.mjs` (0 failures, thinned bundle); `pnpm lint-all` (0 fixes).
- [ ] Mark the 5 findings RESOLVED in `ROADMAP.md` (error-serialization, gcp-console, market-status-swallow, node-imports-edge-compat, worker-bundle-size) and flip the spec Status to IMPLEMENTED.
- [ ] convergent agy review (full critical review + one bounded generative question) before merge, per the cadence.
- [ ] superpowers:finishing-a-development-branch.
