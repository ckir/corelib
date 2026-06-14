# Audit Fix-Backlog Closure (Epic 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 5 remaining actionable monorepo-audit findings — raw-error log serialization, stray gcp console calls, a market-status HTTP-200-on-error swallow, edge-fragile `node:` imports, and the 6.29 MB Cloudflare worker bundle.

**Architecture:** Three sequential, decoupled phases. Phase 1 (observability) and Phase 2 (facade HTTP) are mechanical/low-risk TS edits. Phase 3 (edge) is the co-dependent pair — the worker bundle can only switch platform once `ts-core`'s `node:` imports are made edge-safe — validated by the `edge-boot.mjs` boot probe, not a unit test.

**Tech Stack:** TypeScript (vitest, biome), `serialize-error`, Hono (ts-cloud), tsup/esbuild, Cloudflare `nodejs_compat`.

**Spec:** `docs/superpowers/specs/2026-06-14-audit-fix-backlog-closure-design.md`. Forks settled there (neutral platform, full sweep, sync-node guard).

**Verify commands (pinned — avoid the global tsc shim):**
- TS typecheck: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p <pkg>/tsconfig.json` (exit 0)
- TS tests: `cd <pkg> && pnpm exec vitest run <path>`
- Build: `pnpm build-all` (tsup). NEVER a bare emitting `tsc` (no `--noEmit`) — it pollutes `src/` with `.js`.
- Edge boot probe: `node probes/_harness/edge-boot.mjs` (or the documented wrangler invocation in that file's header).

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `ts-core/src/database/sqlite/sqlite-db.ts`, `.../postgres/postgres-db.ts` | wrap raw `error:` log args with `serializeError` (3 sites each) | 1 |
| `ts-cloud/src/core/router.ts`, `ts-cloud/src/database/SqlCloud.ts` | same, ts-cloud sites | 1 |
| `ts-markets/src/nasdaq/groups/Top100.ts`, `.../datafeeds/polling/nasdaq/NasdaqPolling.ts` | same, ts-markets sites | 1 |
| `ts-core/src/loggers/implementations/gcp.ts` | remove 3 progress `console.log`; keep 1 bootstrap-fallback `console.error` | 2 |
| `ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts` (+ its test) | fatal path returns HTTP 500, not 200 | 3 |
| `ts-core/src/configs/ConfigUtils.ts` | `node:crypto` static import → `await import` in async `decryptConfig` | 4 |
| `ts-cloud/tsup.config.ts` | Cloudflare worker entry → `platform:"neutral"` + externalize `node:*` & server deps | 5 |

---

## Task 1: error-serialization sweep (finding `phase0-logger-raw-error-sqlite-01`)

**Why:** raw `Error` objects passed to the structured logger as `{ error: e }` serialize to `{}` in JSON (message/stack are non-enumerable; `cause` chains dropped). Wrapping with `serializeError(e)` preserves them — mirroring the existing precedent at `ts-core/src/database/core/errors.ts:13` and `core/transaction-context.ts:36`.

**Files & confirmed sites** (all are `logger…error("…", { error: <X> })`):
- Create: none.
- Modify: `ts-core/src/database/sqlite/sqlite-db.ts` (lines ~49 `error: e`, ~114 `error: e`, ~125 `error: rollbackErr`)
- Modify: `ts-core/src/database/postgres/postgres-db.ts` (~50, ~115, ~126 `error: rollbackErr`)
- Modify: `ts-cloud/src/core/router.ts` (router-level error handler)
- Modify: `ts-cloud/src/database/SqlCloud.ts` (~68 `{ error }`)
- Modify: `ts-markets/src/nasdaq/groups/Top100.ts` (group-refresh error log)
- Modify: `ts-markets/src/nasdaq/datafeeds/polling/nasdaq/NasdaqPolling.ts` (~156 `{ error: result.reason }`)
- Test: `ts-core/src/database/sqlite/sqlite-db.serialize.test.ts` (NEW, see Step 1)

- [ ] **Step 0 (state-verify + full sweep):** Confirm the sites above, then catch any the audit missed:
  Run: `rg -n "error:\s*(e|err|error|rollbackErr|result\.reason)\b" ts-core/src ts-cloud/src ts-markets/src`
  and `rg -n "\{\s*error\s*\}" ts-core/src ts-cloud/src ts-markets/src`
  Treat EVERY logger call that passes a raw caught error (not already `serializeError(...)`) as in-scope. If a site differs from the list, report it but fix it (same pattern).

- [ ] **Step 1: Write a failing test** proving the serialized shape (use sqlite-db as the representative; it exercises the helper precedent). Create `ts-core/src/database/sqlite/sqlite-db.serialize.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { serializeError } from "serialize-error";

describe("error log serialization contract", () => {
  it("serializeError preserves message + name that bare JSON.stringify drops", () => {
    const e = new Error("boom");
    (e as Error & { cause?: unknown }).cause = new Error("root");
    // A bare Error stringifies to "{}" — the bug this sweep fixes.
    expect(JSON.stringify(e)).toBe("{}");
    // serializeError lifts the non-enumerable props into a plain object.
    const s = serializeError(e) as Record<string, unknown>;
    expect(s.message).toBe("boom");
    expect(s.name).toBe("Error");
    expect(JSON.stringify(s)).toContain("boom");
  });
});
```

- [ ] **Step 2: Run it — it should PASS already** (it asserts the library contract, documenting why the sweep is needed):
  Run: `cd ts-core && pnpm exec vitest run src/database/sqlite/sqlite-db.serialize.test.ts`
  Expected: PASS (this test pins the rationale; the real verification is the existing suites staying green after the edits).

- [ ] **Step 3: Apply the sweep.** In EACH file: ensure `import { serializeError } from "serialize-error";` exists at the top (add it if missing — `sqlite-db.ts` and `postgres-db.ts` do NOT currently import it; `transaction-context.ts`/`errors.ts` show the exact import line to copy). Then replace each raw error arg:
  - `error: e,` → `error: serializeError(e),`
  - `error: rollbackErr,` → `error: serializeError(rollbackErr),`
  - `{ error }` (shorthand, e.g. SqlCloud) → `{ error: serializeError(error) }`
  - `error: result.reason,` → `error: serializeError(result.reason),`
  Change ONLY the error argument — leave the message string and any sibling fields untouched.

  SHAPE-DIVERGENCE STOP: do not alter the log message, the log level, or other structured fields; the only change is wrapping the error value in `serializeError(...)`. If a site already uses `serializeError`, leave it.

- [ ] **Step 4: Verify** existing suites + typecheck across the 3 packages:
  Run: `cd ts-core && pnpm exec vitest run src/database` (PASS)
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` (exit 0)
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-cloud/tsconfig.json` (exit 0)
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-markets/tsconfig.json` (exit 0)

- [ ] **Step 5: Commit**

```bash
git add ts-core/src/database ts-cloud/src ts-markets/src/nasdaq
git commit -m "fix(epic3): serializeError on all raw-error logger sites (audit phase0-logger-raw-error)"
```

---

## Task 2: gcp logger stray console calls (finding `phase0-logger-gcp-console-01`)

**Files:**
- Modify: `ts-core/src/loggers/implementations/gcp.ts`

> Step 0 (state-verify): confirm `createGcpLogger()` has 3 progress `console.log` (lines ~8, ~31, ~33) and one `console.error` in the `catch (err)` block (line ~36) that then falls back to a basic pino logger.

- [ ] **Step 1: Remove the 3 progress `console.log` calls** (lines ~8 `"Initializing GCP specific logger..."`, ~31 `"Config created successfully"`, ~33 `"Pino instance created"`). Delete those lines entirely.

- [ ] **Step 2: Keep the catch `console.error` (line ~36) as the single justified bootstrap fallback**, and document it inline. `createGcpLogger()` constructs the logger, so it cannot log its own init failure through `StrictLogger`; console is the only signal, and the function already degrades gracefully to a basic pino logger. Replace the line with:

```ts
		// Bootstrap fallback: the structured logger itself failed to init, so console
		// is the only available sink. We then degrade to a basic pino logger (below).
		console.error("[GCP-LOGGER] Failed to initialize GCP logger:", err);
```

- [ ] **Step 3: Typecheck**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json`
  Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add ts-core/src/loggers/implementations/gcp.ts
git commit -m "fix(epic3): drop 3 progress console.log in createGcpLogger; keep documented bootstrap-fallback console.error"
```

---

## Task 3: market-status HTTP-error swallow (finding `facade-market-status-error-status-swallowed-01`)

**Files:**
- Modify: `ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts` (the fatal-path return, ~line 54)
- Modify (oracle): `ts-cloud/src/markets/nasdaq/MarketStatusCloud.test.ts` (the fatal-path status assertion, ~line 101)

> Step 0: confirm the success path is `return c.json(result, 200);` (~line 42) and the catch fatal path is `return c.json(fatalResult, 200);` (~line 54). The error is ALREADY logged via `serializeError(error)` (line ~46) — do NOT change the log, only the status code.

- [ ] **Step 1: Flip the test oracle FIRST.** In `MarketStatusCloud.test.ts`, find the fatal/exception scenario asserting the swallowed 200 (agy confirmed it at ~lines 101–102: `expect(res.status).toBe(200);` for the error case). Change that assertion to `expect(res.status).toBe(500);`. Leave the success-scenario assertions at 200.

- [ ] **Step 2: Run the test — it should FAIL** (code still returns 200):
  Run: `cd ts-cloud && pnpm exec vitest run src/markets/nasdaq/MarketStatusCloud.test.ts`
  Expected: FAIL on the error-scenario assertion (got 200, expected 500).

- [ ] **Step 3: Fix the code.** In `MarketStatusCloud.ts` change the fatal return:
```ts
		return c.json(fatalResult, 500);
```
Leave the `fatalResult` body and the success-path `c.json(result, 200)` unchanged.

- [ ] **Step 4: Run the test — PASS**
  Run: `cd ts-cloud && pnpm exec vitest run src/markets/nasdaq/MarketStatusCloud.test.ts`
  Expected: PASS (error → 500, success → 200).

- [ ] **Step 5: Typecheck + commit**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-cloud/tsconfig.json` → exit 0
```bash
git add ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts ts-cloud/src/markets/nasdaq/MarketStatusCloud.test.ts
git commit -m "fix(epic3): MarketStatusCloud returns HTTP 500 (not 200) on fatal error"
```

---

## Task 4: edge-safe `node:` imports — source (finding `phase0-ts-core-node-module-SysInfo-01`, part 1 of the co-dependent pair)

**PLAN-vs-SPEC NOTE (agy plan-review please confirm):** state-verification revealed the THREE `createRequire` sites (`core/index.ts:8/20`, `SysInfo.ts:11/17`, `utils/index.ts:10/23`) are **already call-guarded** (each wraps `createRequire(import.meta.url)` in `if (import.meta?.url)` + try/catch with a throwing-stub fallback). So they need **no source change** — their edge-safety is delivered by Task 5's `node:*` externalization (the static import resolves to `nodejs_compat` at runtime, calls already no-op under edge). The ONLY genuine static-import strip is `ConfigUtils.ts`'s `node:crypto` (its `crypto.*` calls are NOT guarded), and `decryptConfig` is already `async` so `await import` is clean.

**Files:**
- Modify: `ts-core/src/configs/ConfigUtils.ts` (line 6 static import → `await import` inside `decryptConfig`)
- Verify-only (no edit expected): `ts-core/src/core/index.ts`, `ts-core/src/utils/SysInfo.ts`, `ts-core/src/utils/index.ts`

- [ ] **Step 0 (state-verify the guards):** Open `core/index.ts:20-40`, `SysInfo.ts:17-45`, `utils/index.ts:23-45` and confirm each `createRequire(import.meta.url)` call sits behind `if (typeof import.meta !== "undefined" && import.meta.url)` with a fallback. If ANY is unguarded, STOP and report `STATE_MISMATCH: <file> createRequire call is unguarded` (it would then need a `detectRuntime()` guard — escalate to the controller).

- [ ] **Step 1: ConfigUtils.ts — relocate the crypto import.** Remove the top-level `import crypto from "node:crypto";` (line 6). Inside `decryptConfig` (already `async`), after the existing `const { getEnv } = await import("../utils");` (line ~15), add:
```ts
	const crypto = (await import("node:crypto")).default;
```
The rest of `decryptConfig` (which uses `crypto.createDecipheriv(...)`) is unchanged.

  SHAPE-DIVERGENCE STOP: `node:crypto`'s default export is the crypto module; `(await import("node:crypto")).default` must match the prior `import crypto from "node:crypto"` default-import binding. Do NOT switch to a namespace import (`* as crypto`) — that changes the binding shape.

- [ ] **Step 2: Verify nothing else statically imports `node:` in ts-core production** (excluding tests, and the edge-safe `node:events`/`node:stream` which are OUT OF SCOPE per the spec):
  Run: `rg -n 'from "node:(module|crypto)"' ts-core/src --glob '!**/*.test.ts'`
  Expected: only the three `node:module` createRequire sites remain (left in place, externalized by Task 5); NO `node:crypto` static import remains.

- [ ] **Step 3: Typecheck + ts-core tests**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-core/tsconfig.json` → exit 0
  Run: `cd ts-core && pnpm exec vitest run src/configs` → PASS (decrypt path still works under Node)

- [ ] **Step 4: Commit**
```bash
git add ts-core/src/configs/ConfigUtils.ts
git commit -m "fix(epic3): lazy-load node:crypto in async decryptConfig (edge-safe; createRequire sites already guarded)"
```

---

## Task 5: Cloudflare worker bundle thinning (finding `facade-worker-bundle-size-perf-01`, part 2 — validates the edge pair)

**Files:**
- Modify: `ts-cloud/tsup.config.ts` (the FIRST entry only — `worker: src/platform/cloudflare/worker.ts`; the `handler`/`server` entries stay `platform:"node"` and MUST NOT change)

> Step 0 (state-verify): confirm `ts-cloud/tsup.config.ts` is an array of 3 configs; entry[0] is the Cloudflare `worker` with `noExternal: [/.*/]`, `platform: "node"`, `minify: true`, `outDir: "dist/cloudflare"`. Record the CURRENT built size: `pnpm build-all` then `ls -la ts-cloud/dist/cloudflare/worker.js` (expect ~6 MB).

- [ ] **Step 1: Switch the Cloudflare worker entry to a thin, edge-correct build.** In entry[0] ONLY:
  - change `platform: "node"` → `platform: "neutral"` (NOT `"browser"` — that resolves `@ckir/corelib` to its logging-only `browser.js` stub and breaks `createDatabase`/`endPoint` imports).
  - replace `noExternal: [/.*/]` with an `external` list for the server-only/runtime-provided deps:
```ts
			external: [
				/^node:/,
				"@google-cloud/pino-logging-gcp-config",
				"@libsql/client",
				"pino-pretty",
			],
```
  Keep `format`, `target`, `shims`, `minify`, `clean`, `outDir` as-is. (`/^node:/` externalizes all `node:` builtins — satisfied at runtime by `nodejs_compat`, which is already enabled in `wrangler` config.)

  SHAPE-DIVERGENCE STOP: do NOT touch entry[1] (`handler`, AWS) or entry[2] (`server`, CloudRun) — they legitimately bundle for Node. If switching to `"neutral"` surfaces additional unresolved server-only packages at build time, ADD them to the `external` list (report each one added) — do not revert to `platform:"node"`.

- [ ] **Step 2: Build + measure the bundle**
  Run: `pnpm build-all`
  Expected: build succeeds. Then `ls -la ts-cloud/dist/cloudflare/worker.js` — size should drop from ~6 MB toward the ~150 KB order. Report the before/after sizes. (If still multi-MB, inspect with `node -e "..."`/esbuild metafile to find the remaining bundled heavy dep and add it to `external`.)

- [ ] **Step 3: Edge boot probe (the Phase-3 oracle)** — prove the thinned worker still boots under `nodejs_compat`:
  Run: `node probes/_harness/edge-boot.mjs` (follow that file's header for the exact wrangler/runtime invocation if it differs)
  Expected: 0 edge failures — the worker imports + boots with `node:*`/server deps externalized. If it fails because a genuinely-needed symbol was externalized, move that dep OUT of `external` (report it).

- [ ] **Step 4: Full typecheck (ts-cloud) + confirm AWS/CloudRun bundles unaffected**
  Run: `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p ts-cloud/tsconfig.json` → exit 0
  Confirm `dist/aws/handler.mjs` + `dist/cloudrun/server.js` still built (Step 2's `build-all` covers them).

- [ ] **Step 5: Commit**
```bash
git add ts-cloud/tsup.config.ts
git commit -m "perf(epic3): thin CF worker bundle via platform:neutral + externalize node:*/server deps (6.29MB->~150KB)"
```

---

## Finalization (after all tasks)

- [ ] Run the full gate: `node …/tsc --noEmit` per package; `cd ts-core && pnpm exec vitest run`; `cd ts-cloud && pnpm exec vitest run`; `cd ts-markets && pnpm exec vitest run`; `pnpm build-all`; `node probes/_harness/edge-boot.mjs`; `pnpm lint-all` (0 fixes).
- [ ] Mark the 5 findings RESOLVED in `ROADMAP.md` (error-serialization, gcp-console, market-status-swallow, node-imports-edge-compat, worker-bundle-size) and flip the spec Status to IMPLEMENTED.
- [ ] convergent agy review (full critical review + one bounded generative question) before merge, per the cadence.
- [ ] superpowers:finishing-a-development-branch.
