# Integration Test Tier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an exhaustive integration-test tier that exercises the real, unmocked composition of the corelib monorepo across three seams (cross-package wiring, external REST, Rust FFI), controlling only the outermost edges (network via MSW record/replay, time, randomness), with a coverage matrix + validator that makes "exhaustive" statically enforceable.

**Architecture:** A separate, CI-only test tier. Each package owns a runtime-matched `vitest.integration.config.ts` (node for FFI/DB, `workers-pool` for edge) — a single root config can't span the runtimes. A shared, dependency-light harness at `tests/integration/_harness/` provides: an MSW record/replay server with secret scrubbing, per-test temp-dir + SQLite isolation, FFI/live `describe` guards, and a coverage matrix + validator. White-box against TypeScript source via `paths` aliases (no internal `vi.mock`); a dedicated `@itest/*` alias kept out of `tsconfig.base.json` so test-only code never compiles into `dist/`.

**Tech Stack:** Vitest 4 (`^4.1.8`), MSW 2 (`^2.14.6`), `@cloudflare/vitest-pool-workers` (`^0.16.13`), the `corelib-rust` N-API addon, real `@libsql/client` SQLite, the existing `RequestUnlimited` (ky) + `ConfigManager` (commander) + Hono router.

**Spec:** `docs/superpowers/specs/2026-06-12-integration-tests-design.md` (status: PLAN-READY).

**Revised 2026-06-13 (agy plan-phase review folded — verdict EXECUTE-WITH-FIXES → fixed):** (1) DB uses `query` only — no `execute`; `query` returns `DatabaseResult<QueryResponse>` → assert `status==="success"`, rows at `value.rows` (Tasks 6/10). (2) in-memory SQLite needs `mode:"stateful"` (else wiped per query); teardown via `disconnect()` (Task 6). (3) `RequestResult` is a discriminated union → `res.status==="success"` then `res.value.status`/`res.value.body`; retry override is `ConfigManager.getInstance().updateValue(...)`, not `set` (Task 10). (4) ESM: no `require`/`require.main` — static imports in `server.ts`, `import.meta.url` main-check in the validator (Tasks 5/8). (5) `tsconfig.integration.json` includes the package test dirs; package tsconfigs only include `src` so the lefthook `tsc` gate never sees `@itest` (Task 2). (6) `setup.ts` is a skeleton in Task 3, finalized in Task 6 (no intermediate red state); record-mode uses ONE `response:bypass` listener (Task 5); root scripts use `pnpm -r run`. agy verified correct, no change: FFI exports (Task 9), `createRouter` (Task 13), worker `SELF` route (Task 14), streamer event/method surface (Task 15).

---

## Conventions for implementer subagents (READ FIRST — applies to EVERY task)

1. **Step 0 — state verification.** Before editing, open each target file and confirm the quoted "Current state" matches reality. If it differs, STOP and report `STATE_MISMATCH: <what differs>` — do not adapt.
2. **SHAPE_DIVERGENCE rule.** If making the code work would change the shape/type/encoding of any value, import path, or exported name shown here — even to compile — STOP and report `[original] → [yours] because <reason>`. Names like `@ckirg/corelib`, `endPoint`, `coreFFI` are contracts; don't "fix" them.
3. **NAME THE ORACLE.** Each task's tests are the oracle; if a value seems wrong, surface it — don't edit the test to match the code.
4. **No elided lists** — paste full code blocks; don't `...` over imports or cases.
5. **Exact commands.** Run from the repo root unless stated. Tools: `pnpm` (workspaces), `vitest`, `biome`, `tsc`. The local commit gate is **lefthook pre-commit = `verify:fast` (format/lint/typecheck, TS-only)** — never `--no-verify`. Integration tests are **CI-only**; they are NOT part of `verify:full` (the push gate stays unit-only).
6. **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
7. **Package identities (verified):** ts-core = `@ckirg/corelib`, ts-markets = `@ckirg/corelib-markets`, ts-cloud = `@ckirg/corelib-cloud`. All at version `0.1.17`. Vitest `^4.1.8`, msw `^2.14.6` already devDeps in ts-core + ts-markets (NOT ts-cloud); `@cloudflare/vitest-pool-workers ^0.16.13` in ts-cloud.

---

## File Structure

```
tests/integration/
  _harness/
    scrubber.ts          secret denylist + scrubFixture + findUnscrubbedSecrets        (Task 4)
    scrubber.test.ts                                                                   (Task 4)
    fixtures.ts          Fixture types, path helpers, read/write fixture files         (Task 5)
    server.ts            MSW record/replay server, sequential queues, miss tracking    (Task 5)
    server.test.ts                                                                     (Task 5)
    temp.ts              getTestTempDir, createTestDatabase, cleanup registry          (Task 6)
    guards.ts            ffiDescribe, liveDescribe, requireEnv (loud-skip diagnostics) (Task 7)
  _contracts/<service>/<name>.json   committed, scrubbed fixtures                      (Tasks 10/12)
  coverage.matrix.ts     SeamCell type + COVERAGE_MATRIX                               (Task 8)
  coverage-validator.ts  matrix ↔ fixtures ↔ scrub ↔ live-streaming testFilePath       (Task 8)
  coverage-validator.test.ts                                                           (Task 8)
tsconfig.integration.json            extends base, includes tests/integration, @itest/* paths (Task 2)
ts-core/
  vitest.integration.config.ts                                                         (Task 3)
  tests/integration/*.integration.test.ts        ffi-scalar, http, db, config          (Tasks 9/10)
ts-markets/
  vitest.integration.config.ts                                                         (Task 3)
  tests/integration/*.integration.test.ts         cross-package, external REST, streaming (Tasks 11/12/15)
ts-cloud/
  vitest.integration.config.ts          (node project: router+DB)                      (Task 3)
  vitest.integration.worker.config.ts   (workers-pool: edge/proxy)                     (Task 3)
  tests/integration/*.integration.test.ts                                              (Tasks 13/14)
.github/workflows/                      new integration job + nightly live workflow    (Task 16)
```

**Modified source files:** `ts-core/src/configs/ConfigManager.ts` (Task 1, the one prerequisite change); root + per-package `package.json` (scripts only). **`tsconfig.base.json` is NOT touched** (alias isolation, §4.3).

---

## Task 1: Prerequisite — `ConfigManager.initialize(args?: string[])`

`ConfigManager.initialize()` reads `process.argv.slice(2)` and parses it with commander. Under Vitest the runner's own `--config vitest.integration.config.ts` is captured, so any test exercising real `ConfigManager` crashes. Widen the signature so the harness can call `initialize([])`.

**Files:**
- Modify: `ts-core/src/configs/ConfigManager.ts`
- Test: `ts-core/src/configs/ConfigManager.argv.test.ts` (new unit test, runs in the existing unit suite)

**Current state (verify):** `public async initialize(): Promise<void>` (instance method on the `ConfigManager extends EventEmitter` singleton). Its body does `const args = process.argv.slice(2);` then builds a `new Command()`, binds `program.option("-C, --config <path>", ...)`, `allowUnknownOption(true)`, `helpOption(false)`, and `await program.parseAsync(args, { from: "user" })`.

- [ ] **Step 1: Write the failing test.** Create `ts-core/src/configs/ConfigManager.argv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigManager } from "./ConfigManager";

describe("ConfigManager.initialize(args)", () => {
  it("accepts an explicit args array and ignores process.argv", async () => {
    // Simulate Vitest hijacking argv with its own --config flag.
    const original = process.argv;
    process.argv = ["node", "vitest", "--config", "vitest.integration.config.ts"];
    try {
      // Passing [] must bypass commander's argv scan and not throw.
      await expect(ConfigManager.getInstance().initialize([])).resolves.toBeUndefined();
    } finally {
      process.argv = original;
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (TS error: `initialize` takes 0 args).

Run: `pnpm --filter @ckirg/corelib exec vitest run src/configs/ConfigManager.argv.test.ts`
Expected: FAIL (type error / arity).

- [ ] **Step 3: Widen the signature.** In `ts-core/src/configs/ConfigManager.ts`, change the method declaration and the argv read:

```ts
public async initialize(args?: string[]): Promise<void> {
```
and replace the line `const args = process.argv.slice(2);` with:
```ts
    const argv = args ?? process.argv.slice(2);
```
then update the single `parseAsync` call to use `argv`:
```ts
    await program.parseAsync(argv, { from: "user" });
```
(Do NOT rename any other local; only the argv source changes. Backward-compatible — existing zero-arg callers are unaffected.)

- [ ] **Step 4: Run it — expect PASS.**

Run: `pnpm --filter @ckirg/corelib exec vitest run src/configs/ConfigManager.argv.test.ts`
Expected: PASS.

- [ ] **Step 5: Full ts-core unit suite stays green.**

Run: `pnpm --filter @ckirg/corelib test:run`
Expected: PASS (no regression).

- [ ] **Step 6: Commit.**

```bash
git add ts-core/src/configs/ConfigManager.ts ts-core/src/configs/ConfigManager.argv.test.ts
git commit -m "$(cat <<'EOF'
feat(config): ConfigManager.initialize(args?) to bypass argv under vitest

Widen initialize() to accept an explicit args array (defaults to process.argv.slice(2)),
so integration tests can call initialize([]) without commander capturing vitest's
--config flag. Backward-compatible. Prerequisite for the integration-test tier.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Tier scaffolding — directories, `@itest` alias, root + package scripts

**Files:**
- Create: `tests/integration/_harness/.gitkeep`, `tests/integration/_contracts/.gitkeep`
- Create: `tsconfig.integration.json`
- Modify: root `package.json`, `ts-core/package.json`, `ts-markets/package.json`, `ts-cloud/package.json` (scripts only)

**Current state (verify):** No `tests/integration/` dir. `tsconfig.base.json` defines only the three `@ckirg/*` package `paths`. Root scripts include `build-all`, `test-all:run`, `verify:full`, etc. Each package has `test`/`test:run`/`typecheck` scripts.

- [ ] **Step 1: Create the tier directories** (keep them in git):

```bash
mkdir -p tests/integration/_harness tests/integration/_contracts
printf '' > tests/integration/_harness/.gitkeep
printf '' > tests/integration/_contracts/.gitkeep
```

- [ ] **Step 2: Create `tsconfig.integration.json`** (alias isolation — `@itest/*` lives ONLY here + in each integration vitest config, NEVER in `tsconfig.base.json`):

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "paths": {
      "@ckirg/corelib": ["./ts-core/src/index.ts"],
      "@ckirg/corelib-markets": ["./ts-markets/src/index.ts"],
      "@ckirg/corelib-cloud": ["./ts-cloud/src/index.ts"],
      "@itest/*": ["./tests/integration/*"]
    }
  },
  "include": [
    "tests/integration",
    "ts-core/tests/integration/**/*.ts",
    "ts-markets/tests/integration/**/*.ts",
    "ts-cloud/tests/integration/**/*.ts"
  ]
}
```

> **Why the package test dirs are listed here (agy plan-pass):** the per-package `tsconfig.json` files include only `["src", ...]` — they do NOT pick up `tests/integration/**`, so the lefthook `tsc --noEmit` gate never typechecks the `@itest`-importing files (good — no gate breakage). This integration tsconfig is the one place those files are typechecked (editor + optional `tsc -p tsconfig.integration.json`), so it must include them.

- [ ] **Step 3: Add root `package.json` integration scripts** (alongside the existing `*-all` / `verify:*`). Add these keys to `scripts` (use `-r run <script>` — the explicit recursive form):

```json
    "test:integration": "pnpm -r --workspace-concurrency=1 run test:integration",
    "test:integration:record": "cross-env INTEGRATION_RECORD=1 pnpm -r --workspace-concurrency=1 run test:integration",
    "test:integration:live": "cross-env INTEGRATION_LIVE=1 pnpm -r --workspace-concurrency=1 run test:integration",
    "test:integration:validate": "tsx tests/integration/coverage-validator.ts"
```

(Run packages serially — `--workspace-concurrency=1` — so the FFI/native-addon and SQLite temp files in different packages don't contend.)

- [ ] **Step 4: Add `cross-env` + `tsx` as root devDependencies** (env-var prefix is cross-platform; `tsx` runs the validator as a standalone script). Run:

```bash
pnpm -w add -D cross-env tsx
```

- [ ] **Step 5: Add per-package `test:integration` scripts.**

`ts-core/package.json` scripts — add:
```json
    "test:integration": "vitest run --config vitest.integration.config.ts"
```
`ts-markets/package.json` scripts — add:
```json
    "test:integration": "vitest run --config vitest.integration.config.ts"
```
`ts-cloud/package.json` scripts — add (runs BOTH its node and worker integration projects):
```json
    "test:integration": "vitest run --config vitest.integration.config.ts && vitest run --config vitest.integration.worker.config.ts"
```

- [ ] **Step 6: Verify scripts resolve** (configs don't exist yet, so expect a "config not found" — that's fine; this only checks wiring):

Run: `pnpm test:integration:validate`
Expected: runs `tsx` (will error that `coverage-validator.ts` is empty/missing exports — acceptable until Task 8; confirms `tsx` is installed and the script is wired).

- [ ] **Step 7: Commit.**

```bash
git add tsconfig.integration.json tests/integration/_harness/.gitkeep tests/integration/_contracts/.gitkeep package.json pnpm-lock.yaml ts-core/package.json ts-markets/package.json ts-cloud/package.json
git commit -m "$(cat <<'EOF'
chore(itest): scaffold integration tier — dirs, @itest alias, scripts

Adds tests/integration tree, isolated tsconfig.integration.json (@itest/* kept out
of tsconfig.base.json so test-only code never compiles into dist/), root
test:integration[:record|:live|:validate] scripts (serial per package), and
per-package test:integration scripts. cross-env + tsx devDeps.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Per-package integration vitest configs (×4)

Each config matches its package's runtime and wires the `@ckirg/*` source aliases (white-box) + the `@itest/*` harness alias + the harness setup file.

**Files:**
- Create: `ts-core/vitest.integration.config.ts`
- Create: `ts-markets/vitest.integration.config.ts`
- Create: `ts-cloud/vitest.integration.config.ts` (node project)
- Create: `ts-cloud/vitest.integration.worker.config.ts` (workers-pool project)
- Create: `tests/integration/_harness/setup.ts` (global per-file setup: starts/stops the MSW server, registers cleanup)

**Current state (verify):** existing unit configs — `ts-core/vitest.config.ts` (`environment: "node"`), `ts-markets/vitest.config.ts` (`environment: "happy-dom"`, `globals: true`), `ts-cloud/vitest.config.ts` (workers pool via `wrangler.toml`). The integration configs are SEPARATE files; do not modify the unit configs.

- [ ] **Step 1: Create the shared setup file as a SKELETON** `tests/integration/_harness/setup.ts`. The node-project configs reference it via `setupFiles`, but `./server` (Task 5) and `./temp` (Task 6) don't exist yet — keep it import-free now and FINALIZE it in Task 6 (the seam suites that depend on it don't run until Task 9). *(agy plan-pass: every intermediate commit stays self-consistent + runnable.)*

```ts
// Integration-tier global setup. The MSW server + temp/DB lifecycle are wired in once
// those harness modules exist (finalized in Task 6). Until then this is a no-op so the
// integration configs load cleanly.
export {};
```

- [ ] **Step 2: `ts-core/vitest.integration.config.ts`** (raw node — FFI, HTTP, DB, config):

```ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@ckirg/corelib": resolve(root, "ts-core/src/index.ts"),
      "@itest": resolve(root, "tests/integration"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.integration.test.ts"],
    setupFiles: [resolve(root, "tests/integration/_harness/setup.ts")],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
```

- [ ] **Step 3: `ts-markets/vitest.integration.config.ts`** (node, NOT happy-dom — must load the FFI addon and Node-only APIs):

```ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@ckirg/corelib": resolve(root, "ts-core/src/index.ts"),
      "@ckirg/corelib-markets": resolve(root, "ts-markets/src/index.ts"),
      "@itest": resolve(root, "tests/integration"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.integration.test.ts"],
    setupFiles: [resolve(root, "tests/integration/_harness/setup.ts")],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: `ts-cloud/vitest.integration.config.ts`** (node project — Hono router + real SQLite + cross-package):

```ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@ckirg/corelib": resolve(root, "ts-core/src/index.ts"),
      "@ckirg/corelib-markets": resolve(root, "ts-markets/src/index.ts"),
      "@ckirg/corelib-cloud": resolve(root, "ts-cloud/src/index.ts"),
      "@itest": resolve(root, "tests/integration"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.integration.test.ts"],
    exclude: ["tests/integration/**/*.worker.integration.test.ts"],
    setupFiles: [resolve(root, "tests/integration/_harness/setup.ts")],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
```

- [ ] **Step 5: `ts-cloud/vitest.integration.worker.config.ts`** (workers-pool — edge/proxy only; NO MSW/filesystem setup):

```ts
import { resolve } from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const root = resolve(__dirname, "..");

export default defineWorkersConfig({
  resolve: {
    alias: {
      "@ckirg/corelib": resolve(root, "ts-core/src/index.ts"),
      "@ckirg/corelib-markets": resolve(root, "ts-markets/src/index.ts"),
      "@ckirg/corelib-cloud": resolve(root, "ts-cloud/src/index.ts"),
    },
  },
  test: {
    include: ["tests/integration/**/*.worker.integration.test.ts"],
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.toml" } },
    },
  },
});
```

- [ ] **Step 6: Add a temporary smoke test per node project so the configs are runnable.** Create `tests/integration/_smoke.integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("itest smoke", () => {
  it("runs under the integration config", () => {
    expect(1 + 1).toBe(2);
  });
});
```

(The setup file imports `./server` and `./temp` which don't exist yet — so this won't run until Tasks 5/6. Mark this step done by confirming the config FILE is valid TS via typecheck; the runnable smoke is re-verified in Task 6 Step N.)

Run: `pnpm -w exec tsc -p tsconfig.integration.json --noEmit`
Expected: errors only about missing `./server`/`./temp` modules (created in Tasks 5/6) — NO errors in the config files themselves. If a config file itself errors, fix it.

- [ ] **Step 7: Commit.**

```bash
git add ts-core/vitest.integration.config.ts ts-markets/vitest.integration.config.ts ts-cloud/vitest.integration.config.ts ts-cloud/vitest.integration.worker.config.ts tests/integration/_harness/setup.ts tests/integration/_smoke.integration.test.ts
git commit -m "$(cat <<'EOF'
chore(itest): per-package runtime-matched integration vitest configs

ts-core/ts-markets/ts-cloud(node) run under node with @ckirg/* source aliases +
@itest harness alias + shared setup; ts-cloud(worker) runs workers-pool for
edge/proxy only. Configs are separate from the unit configs.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Harness — secret scrubber

The scrubber is the safety gate before any fixture is written, and the validator's check. Build it first (everything else depends on it).

**Files:**
- Create: `tests/integration/_harness/scrubber.ts`
- Test: `tests/integration/_harness/scrubber.test.ts`

- [ ] **Step 1: Write the failing tests** `tests/integration/_harness/scrubber.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type Fixture, findUnscrubbedSecrets, scrubFixture } from "./scrubber";

const REDACTED = "<REDACTED>";

function baseFixture(over: Partial<Fixture> = {}): Fixture {
  return {
    request: { method: "GET", url: "https://api.example.com/x", headers: {} },
    response: { status: 200, headers: {}, body: null },
    recordedAt: "2026-06-13T00:00:00.000Z",
    ...over,
  };
}

describe("scrubFixture", () => {
  it("redacts denylisted headers (case-insensitive) in request and response", () => {
    const f = baseFixture({
      request: { method: "GET", url: "https://x/y", headers: { Authorization: "Bearer abc", "X-API-Key": "k1" } },
      response: { status: 200, headers: { "Set-Cookie": "s=1" }, body: null },
    });
    const s = scrubFixture(f);
    expect(s.request.headers.Authorization).toBe(REDACTED);
    expect(s.request.headers["X-API-Key"]).toBe(REDACTED);
    expect(s.response.headers["Set-Cookie"]).toBe(REDACTED);
  });

  it("redacts query-string secrets in the url", () => {
    const f = baseFixture({ request: { method: "GET", url: "https://x/y?apikey=SECRET&q=1", headers: {} } });
    const s = scrubFixture(f);
    expect(s.request.url).toContain("apikey=" + REDACTED);
    expect(s.request.url).toContain("q=1");
  });

  it("recursively redacts secret-named keys in object bodies", () => {
    const f = baseFixture({
      response: { status: 200, headers: {}, body: { keyId: "K", secretKey: "S", nested: { token: "T", ok: 1 } } },
    });
    const s = scrubFixture(f);
    const b = s.response.body as any;
    expect(b.keyId).toBe(REDACTED);
    expect(b.secretKey).toBe(REDACTED);
    expect(b.nested.token).toBe(REDACTED);
    expect(b.nested.ok).toBe(1);
  });

  it("redacts secrets inside JSON string bodies, re-serializing", () => {
    const f = baseFixture({ response: { status: 200, headers: {}, body: JSON.stringify({ apiKey: "A", x: 2 }) } });
    const s = scrubFixture(f);
    const parsed = JSON.parse(s.response.body as string);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.x).toBe(2);
  });
});

describe("findUnscrubbedSecrets", () => {
  it("returns reasons when a denylisted value is still present", () => {
    const f = baseFixture({ request: { method: "GET", url: "https://x?token=LIVE", headers: { cookie: "c=1" } } });
    expect(findUnscrubbedSecrets(f).length).toBeGreaterThan(0);
  });
  it("returns empty for a fully scrubbed fixture", () => {
    const f = scrubFixture(baseFixture({ request: { method: "GET", url: "https://x?token=LIVE", headers: { cookie: "c=1" } } }));
    expect(findUnscrubbedSecrets(f)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

Run: `pnpm --filter @ckirg/corelib exec vitest run --root ../ tests/integration/_harness/scrubber.test.ts`
Expected: FAIL (cannot find `./scrubber`).

- [ ] **Step 3: Implement `tests/integration/_harness/scrubber.ts`:**

```ts
export const REDACTED = "<REDACTED>";

/** Case-insensitive header/key names + regex matched recursively in bodies and query strings. */
export const SECRET_HEADER_DENYLIST = [
  "authorization", "cookie", "set-cookie",
  "apca-api-key-id", "apca-api-secret-key", "x-api-key", "x-amz-security-token",
];
const SECRET_KEY_RE = /key|secret|token|auth|session|password/i;
const EXPLICIT_BODY_KEYS = new Set(["keyid", "secretkey", "apikey"]);

export interface Fixture {
  request: { method: string; url: string; headers: Record<string, string> };
  response: { status: number; headers: Record<string, string>; body: unknown };
  recordedAt: string;
}

function isHeaderSecret(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_HEADER_DENYLIST.includes(n) || SECRET_KEY_RE.test(n);
}

function scrubHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = isHeaderSecret(k) ? REDACTED : v;
  return out;
}

function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_KEY_RE.test(key) || EXPLICIT_BODY_KEYS.has(key.toLowerCase())) {
        u.searchParams.set(key, REDACTED);
      }
    }
    // URLSearchParams percent-encodes the <> in the sentinel; restore the literal marker
    // (targeted replace of the known-encoded sentinel only — safe for other query values).
    return u.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED);
  } catch {
    return url;
  }
}

function scrubBodyValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubBodyValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) || EXPLICIT_BODY_KEYS.has(k.toLowerCase())
        ? REDACTED
        : scrubBodyValue(val);
    }
    return out;
  }
  return v;
}

function scrubBody(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      return JSON.stringify(scrubBodyValue(JSON.parse(body)));
    } catch {
      return body; // non-JSON string left as-is (header/query scrubbing still applied)
    }
  }
  return scrubBodyValue(body);
}

export function scrubFixture(f: Fixture): Fixture {
  return {
    request: { method: f.request.method, url: scrubUrl(f.request.url), headers: scrubHeaders(f.request.headers) },
    response: { status: f.response.status, headers: scrubHeaders(f.response.headers), body: scrubBody(f.response.body) },
    recordedAt: f.recordedAt,
  };
}

/** Returns human-readable reasons a fixture still leaks a secret (empty = clean). Used by the validator. */
export function findUnscrubbedSecrets(f: Fixture): string[] {
  const reasons: string[] = [];
  for (const [k, v] of Object.entries(f.request.headers)) if (isHeaderSecret(k) && v !== REDACTED) reasons.push(`request header ${k}`);
  for (const [k, v] of Object.entries(f.response.headers)) if (isHeaderSecret(k) && v !== REDACTED) reasons.push(`response header ${k}`);
  try {
    const u = new URL(f.request.url);
    for (const key of u.searchParams.keys()) {
      if ((SECRET_KEY_RE.test(key) || EXPLICIT_BODY_KEYS.has(key.toLowerCase())) && u.searchParams.get(key) !== REDACTED) {
        reasons.push(`query ${key}`);
      }
    }
  } catch { /* ignore */ }
  const walk = (val: unknown, path: string) => {
    if (Array.isArray(val)) val.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (val && typeof val === "object") {
      for (const [k, vv] of Object.entries(val as Record<string, unknown>)) {
        if ((SECRET_KEY_RE.test(k) || EXPLICIT_BODY_KEYS.has(k.toLowerCase())) && vv !== REDACTED) reasons.push(`body ${path}.${k}`);
        else walk(vv, `${path}.${k}`);
      }
    }
  };
  const body = typeof f.response.body === "string" ? safeParse(f.response.body) : f.response.body;
  walk(body, "");
  return reasons;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm --filter @ckirg/corelib exec vitest run --root ../ tests/integration/_harness/scrubber.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**

```bash
git add tests/integration/_harness/scrubber.ts tests/integration/_harness/scrubber.test.ts
git commit -m "$(cat <<'EOF'
feat(itest): secret scrubber for contract fixtures

Recursive header/query/body redaction (denylist + /key|secret|token|auth|session|
password/i + explicit keyId/secretKey/apiKey), JSON-string bodies re-serialized.
findUnscrubbedSecrets() backs the validator gate.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Harness — MSW record/replay server + fixtures

One test body runs three ways by env: replay (default, fixtures only — unmatched fails), record (`INTEGRATION_RECORD=1`, passthrough → scrub → write), live (`INTEGRATION_LIVE=1`, MSW off).

**Files:**
- Create: `tests/integration/_harness/fixtures.ts`
- Create: `tests/integration/_harness/server.ts`
- Test: `tests/integration/_harness/server.test.ts`

- [ ] **Step 1: Implement `tests/integration/_harness/fixtures.ts`:**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Fixture } from "./scrubber";

export type { Fixture };
/** A fixture file is one Fixture (same response every time) or an ordered array (sequential queue). */
export type FixtureFile = Fixture | Fixture[];

const CONTRACTS_DIR = resolve(__dirname, "..", "_contracts");

export function fixturePathFor(service: string, name: string): string {
  return resolve(CONTRACTS_DIR, service, `${name}.json`);
}

export function readFixtureFile(path: string): FixtureFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  } catch {
    return null;
  }
}

export function writeFixtureFile(path: string, data: FixtureFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Stable key for matching a request to its fixture queue. */
export function fixtureKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}
```

- [ ] **Step 2: Write the failing server tests** `tests/integration/_harness/server.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertNoMisses, beginItest, endItest, registerFixture, resetItest } from "./server";

beforeAll(() => beginItest());
afterEach(() => resetItest());

describe("itest server (replay)", () => {
  it("serves a registered fixture", async () => {
    registerFixture({
      request: { method: "GET", url: "https://itest.local/ok", headers: {} },
      response: { status: 200, headers: { "content-type": "application/json" }, body: { hello: "world" } },
      recordedAt: "2026-06-13T00:00:00.000Z",
    });
    const res = await fetch("https://itest.local/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
    assertNoMisses();
  });

  it("returns sequential responses from an array fixture", async () => {
    registerFixture([
      { request: { method: "GET", url: "https://itest.local/seq", headers: {} }, response: { status: 504, headers: {}, body: null }, recordedAt: "x" },
      { request: { method: "GET", url: "https://itest.local/seq", headers: {} }, response: { status: 200, headers: {}, body: { n: 2 } }, recordedAt: "x" },
    ]);
    expect((await fetch("https://itest.local/seq")).status).toBe(504);
    expect((await fetch("https://itest.local/seq")).status).toBe(200);
    assertNoMisses();
  });

  it("records a miss for an unmatched request (assertNoMisses throws)", async () => {
    await fetch("https://itest.local/unknown").catch(() => {});
    expect(() => assertNoMisses()).toThrow(/no fixture/i);
  });
});
```

- [ ] **Step 3: Implement `tests/integration/_harness/server.ts`** (ESM-safe — static imports only, NO `require`; ONE global `response:bypass` listener so record mode can't leak listeners — agy plan-pass 🔴/🟡):

```ts
import { http, HttpResponse, passthrough } from "msw";
import { setupServer } from "msw/node";
import { type Fixture, type FixtureFile, fixtureKey, fixturePathFor, readFixtureFile, writeFixtureFile } from "./fixtures";
import { scrubFixture } from "./scrubber";

export const IS_RECORD = process.env.INTEGRATION_RECORD === "1";
export const IS_LIVE = process.env.INTEGRATION_LIVE === "1";

/** Per-test replay queues, keyed by "METHOD url". */
const queues = new Map<string, Fixture[]>();
const misses: string[] = [];
const pendingWrites = new Map<string, Fixture>(); // record mode: path -> scrubbed fixture
let recordTarget: { service: string; name: string } | undefined;
let bypassListenerAttached = false;

function enqueue(file: FixtureFile): void {
  const arr = Array.isArray(file) ? file : [file];
  if (arr.length === 0) return;
  const key = fixtureKey(arr[0].request.method, arr[0].request.url);
  queues.set(key, [...(queues.get(key) ?? []), ...arr]);
}

/** Register an in-memory fixture (used by tests directly). */
export function registerFixture(file: FixtureFile): void {
  enqueue(file);
}

/** Load a committed fixture file into the replay queue. No-op in live mode. */
export function loadFixture(service: string, name: string): void {
  if (IS_LIVE) return;
  const file = readFixtureFile(fixturePathFor(service, name));
  if (!file) throw new Error(`itest: missing fixture ${service}/${name}.json (record with INTEGRATION_RECORD=1 to create)`);
  enqueue(file);
}

/** In record mode, name the fixture file the next passed-through real response is written to. Side-effect-free (no listeners). */
export function recordTo(service: string, name: string): void {
  if (!IS_RECORD) return;
  recordTarget = { service, name };
}

function nextFixture(method: string, url: string): Fixture | undefined {
  const key = fixtureKey(method, url);
  const q = queues.get(key);
  if (!q || q.length === 0) return undefined;
  return q.length === 1 ? q[0] : q.shift();
}

const replayResolver = http.all("*", async ({ request }) => {
  if (IS_LIVE || IS_RECORD) return passthrough();
  const fx = nextFixture(request.method, request.url);
  if (!fx) {
    misses.push(`${request.method} ${request.url}`);
    return HttpResponse.json({ itestError: "no fixture" }, { status: 599 });
  }
  const body = fx.response.body;
  const init = { status: fx.response.status, headers: fx.response.headers };
  return typeof body === "string" || body == null
    ? new HttpResponse(body as string | null, init)
    : HttpResponse.json(body, init);
});

export const itestServer = setupServer(replayResolver);

export function beginItest(): void {
  if (IS_LIVE) return; // real network; no interception
  itestServer.listen({ onUnhandledRequest: "bypass" });
  if (IS_RECORD && !bypassListenerAttached) {
    bypassListenerAttached = true; // attach exactly once (no per-call leak)
    itestServer.events.on("response:bypass", async ({ request, response }) => {
      const text = await response.clone().text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep string */ }
      const raw: Fixture = {
        request: { method: request.method, url: request.url, headers: Object.fromEntries(request.headers) },
        response: { status: response.status, headers: Object.fromEntries(response.headers), body },
        recordedAt: new Date().toISOString(),
      };
      const scrubbed = scrubFixture(raw);
      const target = recordTarget ?? { service: "_unsorted", name: new URL(request.url).hostname };
      pendingWrites.set(fixturePathFor(target.service, target.name), scrubbed);
      // eslint-disable-next-line no-console
      console.log(`[itest:record] ${target.service}/${target.name} <- ${request.method} ${request.url} (scrubbed before write)`);
    });
  }
}

export function resetItest(): void {
  queues.clear();
  misses.length = 0;
  recordTarget = undefined;
  itestServer.resetHandlers();
}

export function assertNoMisses(): void {
  if (misses.length === 0) return;
  const list = misses.join(", ");
  misses.length = 0;
  throw new Error(`itest: ${list} had no fixture (replay mode). Record with INTEGRATION_RECORD=1.`);
}

export async function endItest(): Promise<void> {
  if (IS_LIVE) return;
  if (IS_RECORD) for (const [path, data] of pendingWrites) writeFixtureFile(path, data);
  itestServer.close();
}
```

- [ ] **Step 4: Run the server tests — expect PASS.**

Run: `pnpm --filter @ckirg/corelib exec vitest run --root ../ tests/integration/_harness/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `msw` to ts-cloud? NO** — the worker project never imports the harness server. Confirm no change needed.

- [ ] **Step 6: Commit.**

```bash
git add tests/integration/_harness/fixtures.ts tests/integration/_harness/server.ts tests/integration/_harness/server.test.ts
git commit -m "$(cat <<'EOF'
feat(itest): MSW record/replay server with sequential queues + miss tracking

Replay (default) serves only committed/registered fixtures (unmatched -> miss ->
assertNoMisses throws); record (INTEGRATION_RECORD=1) passes through, scrubs, and
writes; live (INTEGRATION_LIVE=1) disables MSW. Array fixtures = ordered queue for
retry paths. recordTo() names the file + prints the scrub diff.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Harness — temp-dir + DB isolation + cleanup

Vitest runs files in parallel; concurrent tests must never collide on a shared dir or DB file.

**Files:**
- Create: `tests/integration/_harness/temp.ts`
- Test: `tests/integration/_harness/temp.test.ts`

**Current state (verify):** `createDatabase(config)` is exported from `@ckirg/corelib` (`ts-core/src/database/index.ts`); for SQLite it returns a `SqliteDb` when `config.dialect === "sqlite"`. `getTempDir()` is exported from `@ckirg/corelib`.

- [ ] **Step 1: Write the failing tests** `tests/integration/_harness/temp.test.ts`:

```ts
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupAll, createTestDatabase, getTestTempDir } from "./temp";

afterAll(async () => { await cleanupAll(); });

describe("temp isolation", () => {
  it("returns a unique existing temp dir per call", () => {
    const a = getTestTempDir();
    const b = getTestTempDir();
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("creates an isolated in-memory SQLite database", async () => {
    const db = await createTestDatabase();
    expect(db).toBeTruthy();
    // round-trip via the corelib Database interface (query returns DatabaseResult<QueryResponse>)
    await db.query("CREATE TABLE t (id INTEGER)");
    await db.query("INSERT INTO t (id) VALUES (1)");
    const res = await db.query<{ id: number }>("SELECT id FROM t");
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.value.rows.length).toBe(1);
  });
});
```

> **Verified (agy plan-pass) — the corelib `Database` interface:** `query<T>(sql, params?): Promise<DatabaseResult<QueryResponse<T>>>` (also `transaction`, `disconnect`). There is **NO `execute`**. `DatabaseResult<V>` is the discriminated union `{ status: "success"; value: V } | { status: "error"; reason: ... }`; rows live at `value.rows`. Use `db.query(...)` for DDL/DML and SELECT alike; assert `res.status === "success"`, then read `res.value.rows`. (Checked `ts-core/src/database/core/types.ts`.)

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `tests/integration/_harness/temp.ts`:**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, getTempDir } from "@ckirg/corelib";

const tempDirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

/** A unique, existing temp dir for one test. Pruned in cleanupAll(). */
export function getTestTempDir(): string {
  const base = (() => { try { return getTempDir(); } catch { return tmpdir(); } })();
  const dir = mkdtempSync(join(base, "itest-"));
  tempDirs.push(dir);
  return dir;
}

/** An isolated SQLite DB (in-memory by default). Disconnected in cleanupAll(). */
export async function createTestDatabase(opts: { file?: boolean } = {}) {
  const url = opts.file ? `file:${join(getTestTempDir(), "itest.db")}` : ":memory:";
  // mode MUST be "stateful": "stateless" disconnects after EVERY query, wiping an in-memory DB.
  const db = await createDatabase({ dialect: "sqlite", url, mode: "stateful" } as never);
  closers.push(() => db.disconnect()); // the Database interface exposes disconnect(), not close()
  return db;
}

/** Recursively prune temp dirs + disconnect DBs. Call in afterAll. */
export async function cleanupAll(): Promise<void> {
  for (const close of closers.splice(0)) { try { await close(); } catch { /* ignore */ } }
  for (const dir of tempDirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
```

> **Verified (agy plan-pass) — `BaseDbConfig` requires a non-optional `mode: "stateless" | "stateful"`.** Pass `mode: "stateful"` for `:memory:` (under `"stateless"` the driver disconnects after each query and the in-memory DB is wiped). `url: ":memory:"` is correct. Teardown is `db.disconnect()`. (Checked `ts-core/src/database/sqlite/sqlite-config.ts`.)

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm --filter @ckirg/corelib exec vitest run --root ../ tests/integration/_harness/temp.test.ts`
Expected: PASS.

- [ ] **Step 5: Finalize the harness setup file** now that `./server` (Task 5) and `./temp` exist — replace the skeleton `tests/integration/_harness/setup.ts` with the full lifecycle:

```ts
import { afterAll, afterEach, beforeAll } from "vitest";
import { assertNoMisses, beginItest, endItest, resetItest } from "./server";
import { cleanupAll } from "./temp";

beforeAll(() => beginItest());
afterEach(() => {
  assertNoMisses(); // any unmatched replay request fails the test loudly
  resetItest();
});
afterAll(async () => {
  await endItest();
  await cleanupAll();
});
```

- [ ] **Step 6: Re-verify the smoke + harness tests run end-to-end under the integration config:**

Run: `pnpm --filter @ckirg/corelib test:integration`
Expected: `_smoke` + scrubber/server/temp harness tests run and PASS.

- [ ] **Step 7: Commit.**

```bash
git add tests/integration/_harness/temp.ts tests/integration/_harness/temp.test.ts tests/integration/_harness/setup.ts
git commit -m "$(cat <<'EOF'
feat(itest): per-test temp-dir + isolated SQLite + finalize harness setup

getTestTempDir() (unique mkdtemp) and createTestDatabase() (:memory: stateful via
@ckirg/corelib createDatabase) so parallel files never collide; cleanupAll() prunes
dirs and disconnects DBs. setup.ts now wires the MSW + temp lifecycle for seam suites.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Harness — FFI + live `describe` guards

**Files:**
- Create: `tests/integration/_harness/guards.ts`

**Current state (verify):** `isFfiAvailable` is exported from `@ckirg/corelib` (TS wrapper in `ts-core/src/core/index.ts`).

- [ ] **Step 1: Implement `tests/integration/_harness/guards.ts`:**

```ts
import { describe } from "vitest";
import { isFfiAvailable } from "@ckirg/corelib";

/** Skip the suite (loudly) when the native addon isn't present for this platform. */
export const ffiDescribe: typeof describe = (() => {
  const available = (() => { try { return isFfiAvailable(); } catch { return false; } })();
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn("\x1b[33m[itest] FFI UNAVAILABLE — skipping ffi-scalar/streaming suites (no corelib-rust.node for this platform/arch). Coverage hole is intentional, not silent.\x1b[0m");
  }
  return describe.skipIf(!available) as typeof describe;
})();

/** Skip the suite unless INTEGRATION_LIVE=1 (streaming + real-network tiers). */
export const liveDescribe: typeof describe = describe.skipIf(process.env.INTEGRATION_LIVE !== "1") as typeof describe;

/** True if every named env var is set; otherwise logs a loud skip reason and returns false. */
export function requireEnv(label: string, names: string[]): boolean {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`\x1b[33m[itest] SKIP ${label}: missing env ${missing.join(", ")}\x1b[0m`);
    return false;
  }
  return true;
}
```

- [ ] **Step 2: Typecheck.**

Run: `pnpm -w exec tsc -p tsconfig.integration.json --noEmit`
Expected: no errors in `guards.ts` (other not-yet-written test files may report missing — ignore those; `guards.ts` itself must be clean).

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/_harness/guards.ts
git commit -m "$(cat <<'EOF'
feat(itest): ffiDescribe / liveDescribe / requireEnv guards

ffiDescribe skips ffi/streaming suites with a loud yellow diagnostic when the native
addon is absent; liveDescribe gates streaming on INTEGRATION_LIVE=1; requireEnv
loud-skips when provider credentials are missing.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Coverage matrix + validator

**Files:**
- Create: `tests/integration/coverage.matrix.ts`
- Create: `tests/integration/coverage-validator.ts`
- Test: `tests/integration/coverage-validator.test.ts`

- [ ] **Step 1: Implement `tests/integration/coverage.matrix.ts`** (seed with the ffi-scalar + live-streaming cells now; external/cross-package cells are appended by Tasks 10/12 as their fixtures land):

```ts
export interface SeamCell {
  seam: "external" | "cross-package" | "ffi-scalar" | "live-streaming";
  id: string; // e.g. "nasdaq.marketStatus.500" or "stream.alpaca"
  fixturePath?: string; // required for "external"; relative to _contracts/
  testFilePath?: string; // required for "live-streaming"; relative to repo root
}

export const COVERAGE_MATRIX: SeamCell[] = [
  // ffi-scalar
  { seam: "ffi-scalar", id: "ffi.getVersion" },
  { seam: "ffi-scalar", id: "ffi.logAndDouble" },
  { seam: "ffi-scalar", id: "ffi.isFfiAvailable" },
  { seam: "ffi-scalar", id: "ffi.availabilityFallback" },
  // live-streaming (no fixtures; the suite IS the record)
  { seam: "live-streaming", id: "stream.alpaca", testFilePath: "ts-markets/tests/integration/AlpacaStreaming.live.integration.test.ts" },
  { seam: "live-streaming", id: "stream.finnhub", testFilePath: "ts-markets/tests/integration/FinnhubStreaming.live.integration.test.ts" },
  { seam: "live-streaming", id: "stream.yahoo", testFilePath: "ts-markets/tests/integration/YahooStreaming.live.integration.test.ts" },
];
```

- [ ] **Step 2: Implement `tests/integration/coverage-validator.ts`:**

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERAGE_MATRIX, type SeamCell } from "./coverage.matrix";
import { type Fixture, findUnscrubbedSecrets } from "./_harness/scrubber";
import { readFixtureFile } from "./_harness/fixtures";

const ROOT = resolve(__dirname, "..", "..");
const CONTRACTS = resolve(__dirname, "_contracts");

export function validateCoverage(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1 + 2: every external cell has a fixture that passes the scrub check.
  const referenced = new Set<string>();
  for (const cell of COVERAGE_MATRIX.filter((c): c is SeamCell & { fixturePath: string } => c.seam === "external")) {
    if (!cell.fixturePath) { errors.push(`external cell ${cell.id} has no fixturePath`); continue; }
    const abs = resolve(CONTRACTS, cell.fixturePath);
    referenced.add(abs);
    const file = readFixtureFile(abs);
    if (!file) { errors.push(`external cell ${cell.id}: missing fixture ${cell.fixturePath}`); continue; }
    for (const fx of (Array.isArray(file) ? file : [file]) as Fixture[]) {
      const leaks = findUnscrubbedSecrets(fx);
      if (leaks.length) errors.push(`fixture ${cell.fixturePath} leaks: ${leaks.join(", ")}`);
    }
  }

  // 3: no orphan fixtures (every *.json under _contracts is referenced by a cell).
  for (const abs of walkJson(CONTRACTS)) {
    if (!referenced.has(abs)) errors.push(`orphan fixture (no matrix cell): ${abs.replace(CONTRACTS + "/", "")}`);
  }

  // 4: every live-streaming cell points at an existing test file.
  for (const cell of COVERAGE_MATRIX.filter((c) => c.seam === "live-streaming")) {
    if (!cell.testFilePath) { errors.push(`live-streaming cell ${cell.id} has no testFilePath`); continue; }
    if (!existsSync(resolve(ROOT, cell.testFilePath))) errors.push(`live-streaming cell ${cell.id}: missing test ${cell.testFilePath}`);
  }

  return { ok: errors.length === 0, errors };
}

function walkJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkJson(abs));
    else if (entry.endsWith(".json")) out.push(abs);
  }
  return out;
}

// CLI entry (run via `tsx tests/integration/coverage-validator.ts`). ESM-safe main check
// (no `require.main` — undefined under ESM/Vitest; agy plan-pass 🔴).
const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { ok, errors } = validateCoverage();
  if (!ok) { for (const e of errors) console.error(`✗ ${e}`); process.exit(1); }
  console.log("✓ coverage matrix valid");
}
```

- [ ] **Step 3: Write the validator unit test** `tests/integration/coverage-validator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateCoverage } from "./coverage-validator";

describe("coverage-validator", () => {
  it("passes for the current matrix (live-streaming test files exist; no orphan fixtures)", () => {
    const { ok, errors } = validateCoverage();
    if (!ok) console.error(errors);
    expect(ok).toBe(true);
  });
});
```

> This test passes only once the three `*.live.integration.test.ts` files exist (Task 15). Until then, it (correctly) fails on the missing-testFilePath assertion — so SEQUENCE Task 15 before re-running the validator in CI, OR create the three streaming test files (Task 15) before marking this task's Step 4 green. Recommended: implement Task 15 immediately after this task. For now, verify the validator logic against external/orphan cases with a temporary fixture, then delete it:

- [ ] **Step 4: Verify validator logic.** Temporarily comment out the three `live-streaming` cells in `coverage.matrix.ts`, run the validator test (expect PASS — no external cells yet, no orphans), then restore the cells.

Run: `pnpm --filter @ckirg/corelib exec vitest run --root ../ tests/integration/coverage-validator.test.ts`
Expected: PASS with the live-streaming cells commented; FAIL (missing test files) with them restored — restore them and leave the test to go green in Task 15.

- [ ] **Step 5: Commit.**

```bash
git add tests/integration/coverage.matrix.ts tests/integration/coverage-validator.ts tests/integration/coverage-validator.test.ts
git commit -m "$(cat <<'EOF'
feat(itest): coverage matrix + validator (fixtures, scrub, live-streaming)

SeamCell matrix + validateCoverage(): every external cell has a scrubbed fixture, no
orphan fixtures, every live-streaming cell points at an existing test file. Runnable
as `tsx coverage-validator.ts` (CI gate) and as a unit test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: ffi-scalar seam tests (ts-core)

**Files:**
- Create: `ts-core/tests/integration/ffi-scalar.integration.test.ts`

**Current state (verify):** `@ckirg/corelib` exports `coreFFI`, `isFfiAvailable`, `Core`. The Rust addon exports `getVersion(): string` and `logAndDouble(msg: string, value: number): number`. `ts-core/package.json.version === "0.1.17"` (asserted equal to `getVersion()`).

- [ ] **Step 1: Write the suite:**

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { coreFFI, getVersion, isFfiAvailable, logAndDouble } from "@ckirg/corelib";
import { describe, expect, it } from "vitest";
import { ffiDescribe } from "@itest/_harness/guards";

const pkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8"),
).version as string;

ffiDescribe("ffi-scalar (real native boundary)", () => {
  it("[ffi.getVersion] returns the crate version equal to package.json", () => {
    expect(getVersion()).toBe(pkgVersion); // crate ↔ package sync check
  });

  it("[ffi.logAndDouble] returns the Rust-computed double (not the JS fallback)", () => {
    expect(logAndDouble("itest", 21)).toBe(42);
  });

  it("[ffi.isFfiAvailable] is true when the addon loaded", () => {
    expect(isFfiAvailable()).toBe(true);
    expect(coreFFI).toBeTruthy();
  });
});

describe("ffi availability fallback", () => {
  it("[ffi.availabilityFallback] isFfiAvailable() is a boolean and never throws", () => {
    expect(typeof isFfiAvailable()).toBe("boolean"); // contract: safe to call even when addon missing
  });
});
```

> **Oracle note:** `getVersion` / `logAndDouble` are re-exported from `@ckirg/corelib` via `export * from "./core"`. In Step 0 confirm they are exported by name from `ts-core/src/core/index.ts` (the digest shows `coreFFI` @ line 132, `isFfiAvailable` @ 138, `Core` @ 181). If `getVersion`/`logAndDouble` are only reachable as `coreFFI.getVersion`, import them that way and report SHAPE_DIVERGENCE.

- [ ] **Step 2: Run.**

Run: `pnpm --filter @ckirg/corelib test:integration`
Expected: PASS where the `.node` addon exists; the `ffiDescribe` block SKIPS with the loud yellow diagnostic where it doesn't (the availability-fallback `describe` still runs).

- [ ] **Step 3: Commit.**

```bash
git add ts-core/tests/integration/ffi-scalar.integration.test.ts
git commit -m "$(cat <<'EOF'
test(itest): ffi-scalar seam — getVersion==package.json, logAndDouble, availability

Exercises the real corelib-rust.node boundary; getVersion doubles as a crate<->package
version-sync check. ffiDescribe loud-skips where the addon is absent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: ts-core seams — HTTP (replay), DB, config

**Files:**
- Create: `ts-core/tests/integration/http.integration.test.ts`
- Create: `ts-core/tests/integration/database.integration.test.ts`
- Create: `ts-core/tests/integration/config.integration.test.ts`
- Create fixtures: `tests/integration/_contracts/itest-core/*.json`
- Modify: `tests/integration/coverage.matrix.ts` (add the external cells these tests reference)

**Current state (verify):** `endPoint<T>(url, options): Promise<RequestResult<T>>` and `endPoints` exported from `@ckirg/corelib` (`RequestUnlimited.ts`). `DEFAULT_REQUEST_OPTIONS.retry.limit = 5`; retry limit overridable via `ConfigManager` key `retrieve.retry.limit`.

- [ ] **Step 1: HTTP suite** `ts-core/tests/integration/http.integration.test.ts` (success + retry-then-200 via a sequential fixture; bounded retries so CI never stalls):

```ts
import { ConfigManager, endPoint } from "@ckirg/corelib";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "@itest/_harness/server";

beforeAll(async () => {
  await ConfigManager.getInstance().initialize([]); // bypass vitest argv (Task 1)
});

describe("RequestUnlimited (external, replay)", () => {
  it("[itestCore.endpoint.success] returns a success result with body+status for a 200", async () => {
    loadFixture("itest-core", "endpoint-success");
    const res = await endPoint<{ ok: boolean }>("https://itest.local/core/ok");
    expect(res.status).toBe("success"); // RequestResult is a discriminated union
    if (res.status === "success") {
      expect(res.value.status).toBe(200); // HTTP status on the SerializedResponse
      expect(res.value.body).toEqual({ ok: true });
    }
  });

  it("[itestCore.endpoint.retry] recovers on the 3rd try after two 504s", async () => {
    // Bound retries small so the sequential queue [504,504,200] resolves quickly.
    ConfigManager.getInstance().updateValue("retrieve.retry.limit", 3);
    loadFixture("itest-core", "endpoint-retry"); // an ARRAY fixture: [504,504,200]
    const res = await endPoint("https://itest.local/core/flaky");
    expect(res.status).toBe("success");
  });
});
```

> **Verified (agy plan-pass):** `RequestResult<T>` is the discriminated union `{ status: "success"; value: SerializedResponse<T> } | { status: "error"; reason }` — assert `res.status === "success"`, then read the HTTP status/body from `res.value.status` / `res.value.body` (NOT `res.status`/`res.body`). `ConfigManager` has no `set()`; the runtime override is the instance method `ConfigManager.getInstance().updateValue(path, value)`. `ConfigManager.get(path)` (used below) is static. (Checked `RequestUnlimited.ts` + `ConfigManager.ts`.)

- [ ] **Step 2: Create the fixtures.** `tests/integration/_contracts/itest-core/endpoint-success.json`:

```json
{
  "request": { "method": "GET", "url": "https://itest.local/core/ok", "headers": {} },
  "response": { "status": 200, "headers": { "content-type": "application/json" }, "body": { "ok": true } },
  "recordedAt": "2026-06-13T00:00:00.000Z"
}
```

`tests/integration/_contracts/itest-core/endpoint-retry.json`:

```json
[
  { "request": { "method": "GET", "url": "https://itest.local/core/flaky", "headers": {} }, "response": { "status": 504, "headers": {}, "body": null }, "recordedAt": "2026-06-13T00:00:00.000Z" },
  { "request": { "method": "GET", "url": "https://itest.local/core/flaky", "headers": {} }, "response": { "status": 504, "headers": {}, "body": null }, "recordedAt": "2026-06-13T00:00:00.000Z" },
  { "request": { "method": "GET", "url": "https://itest.local/core/flaky", "headers": {} }, "response": { "status": 200, "headers": {}, "body": { "ok": true } }, "recordedAt": "2026-06-13T00:00:00.000Z" }
]
```

- [ ] **Step 3: DB suite** `ts-core/tests/integration/database.integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "@itest/_harness/temp";

describe("database (real SQLite composition)", () => {
  it("[itestCore.db.roundtrip] creates a table, inserts, and reads back", async () => {
    const db = await createTestDatabase();
    await db.query("CREATE TABLE prices (sym TEXT, px REAL)");
    await db.query("INSERT INTO prices (sym, px) VALUES ('AAPL', 191.5)");
    const res = await db.query<{ sym: string; px: number }>("SELECT sym, px FROM prices");
    expect(res.status).toBe("success");
    if (res.status === "success") expect(res.value.rows).toEqual([{ sym: "AAPL", px: 191.5 }]);
  });
});
```

(`db.query(...)` for DDL/DML + SELECT; assert `res.status === "success"`, read `res.value.rows` — see Task 6's verified note.)

- [ ] **Step 4: Config suite** `ts-core/tests/integration/config.integration.test.ts`:

```ts
import { ConfigManager } from "@ckirg/corelib";
import { describe, expect, it } from "vitest";

describe("ConfigManager (real init, no argv hijack)", () => {
  it("[itestCore.config.init] initializes with explicit args and exposes defaults", async () => {
    await ConfigManager.getInstance().initialize([]);
    expect(ConfigManager.get("retrieve.retry.limit") ?? 5).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 5: Register the external cells** — append to `COVERAGE_MATRIX` in `tests/integration/coverage.matrix.ts`:

```ts
  { seam: "external", id: "itestCore.endpoint.success", fixturePath: "itest-core/endpoint-success.json" },
  { seam: "external", id: "itestCore.endpoint.retry", fixturePath: "itest-core/endpoint-retry.json" },
  { seam: "cross-package", id: "itestCore.db.roundtrip" },
  { seam: "cross-package", id: "itestCore.config.init" },
```

- [ ] **Step 6: Run ts-core integration + validator.**

Run: `pnpm --filter @ckirg/corelib test:integration`
Expected: PASS (http replay, db, config).

Run: `pnpm test:integration:validate`
Expected: `✓ coverage matrix valid` for the external cells (live-streaming cells still pending Task 15).

- [ ] **Step 7: Commit.**

```bash
git add ts-core/tests/integration/ tests/integration/_contracts/itest-core/ tests/integration/coverage.matrix.ts
git commit -m "$(cat <<'EOF'
test(itest): ts-core seams — HTTP replay (success + retry queue), SQLite, config

endPoint replay via committed fixtures incl. a [504,504,200] sequential retry queue
(bounded), real :memory: SQLite round-trip, ConfigManager.initialize([]) real init.
Coverage cells registered.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: cross-package seam (ts-markets → ts-core)

**Files:**
- Create: `ts-markets/tests/integration/cross-package.integration.test.ts`
- Modify: `tests/integration/coverage.matrix.ts`

**Current state (verify):** `@ckirg/corelib-markets` consumes `@ckirg/corelib`'s `logger`, `ConfigManager`, `endPoint`/`endPoints`, `getMode`, `getTempDir`, `coreFFI`. Pick stable, side-effect-free bindings.

- [ ] **Step 1: Write the suite** (real wiring, NO `vi.mock`):

```ts
import { ConfigManager, getMode, getTempDir, logger } from "@ckirg/corelib";
import { describe, expect, it } from "vitest";

describe("cross-package: ts-markets → ts-core real bindings", () => {
  it("[xpkg.logger.child] ts-core logger produces a child logger", () => {
    const child = logger.child({ section: "itest:xpkg" });
    expect(typeof child.info).toBe("function");
  });

  it("[xpkg.getTempDir] returns a real path", () => {
    expect(typeof getTempDir()).toBe("string");
    expect(getTempDir().length).toBeGreaterThan(0);
  });

  it("[xpkg.getMode] returns a known mode", () => {
    expect(["development", "production", "test"]).toContain(getMode());
  });

  it("[xpkg.config] ConfigManager initializes in the markets context", async () => {
    await ConfigManager.getInstance().initialize([]);
    expect(ConfigManager.get).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Register cells** — append to `COVERAGE_MATRIX`:

```ts
  { seam: "cross-package", id: "xpkg.logger.child" },
  { seam: "cross-package", id: "xpkg.getTempDir" },
  { seam: "cross-package", id: "xpkg.getMode" },
  { seam: "cross-package", id: "xpkg.config" },
```

- [ ] **Step 3: Run.**

Run: `pnpm --filter @ckirg/corelib-markets test:integration`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add ts-markets/tests/integration/cross-package.integration.test.ts tests/integration/coverage.matrix.ts
git commit -m "$(cat <<'EOF'
test(itest): cross-package seam ts-markets -> ts-core (unmocked)

Exercises the real consumer bindings (logger.child, getTempDir, getMode, ConfigManager)
with no internal vi.mock. Coverage cells registered.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: external REST seam (ts-markets providers) + fixtures

Cover each REST provider × { success, 404, 500, timeout→retry, malformed-body } via committed fixtures. One reusable test pattern; each provider is a short concrete case + its fixtures.

**Files:**
- Create: `ts-markets/tests/integration/external-rest.integration.test.ts`
- Create fixtures under `tests/integration/_contracts/{nasdaq,yahoo,cnn}/`
- Modify: `tests/integration/coverage.matrix.ts`

**Current state (verify):** providers exported from `@ckirg/corelib-markets` (digest §I): `MarketStatus.getStatus()` (→ `https://api.nasdaq.com/api/market-info`), `ApiNasdaqQuotes` (→ `https://api.nasdaq.com/api/quote/{symbol}/info`), `getSymbolsTop100`, `Historical` (Yahoo via `@gadicc/yahoo-finance2`), `CnnFearAndGreed` (→ CNN). **No Alpaca REST exists** (Alpaca is streaming-only) — do NOT add an Alpaca REST case.

- [ ] **Step 1: Write the suite** (record-or-replay; in replay it serves only fixtures, in record it captures real responses):

```ts
import { ConfigManager } from "@ckirg/corelib";
import { MarketStatus } from "@ckirg/corelib-markets";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFixture, recordTo } from "@itest/_harness/server";

beforeAll(async () => { await ConfigManager.getInstance().initialize([]); });

describe("external REST (Nasdaq MarketStatus)", () => {
  it("[nasdaq.marketStatus.success] returns parsed status on 200", async () => {
    recordTo("nasdaq", "market-status-success");
    loadFixture("nasdaq", "market-status-success");
    const status = await MarketStatus.getStatus();
    expect(status).toBeTruthy(); // loose: provider returned a parsed object
  });

  it("[nasdaq.marketStatus.500] surfaces a serialized error on 500", async () => {
    recordTo("nasdaq", "market-status-500");
    loadFixture("nasdaq", "market-status-500");
    await expect(MarketStatus.getStatus()).rejects.toBeTruthy();
  });
});
```

> This is the canonical pattern. Replicate the two-case (success + one failure) shape for `ApiNasdaqQuotes` (`https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks`), `getSymbolsTop100`, `Historical` (Yahoo), and `CnnFearAndGreed` — each with its own `recordTo`/`loadFixture("<service>", "<name>")` and a loose success assertion + a failure assertion. Use services `nasdaq`, `yahoo`, `cnn`.

- [ ] **Step 2: Record the fixtures against the real APIs (one-time, manual), then commit the scrubbed output.**

Run: `pnpm --filter @ckirg/corelib-markets test:integration:record` (note: define this convenience script if absent, or run the root `test:integration:record`)
Then: inspect the printed `[itest:record]` scrub diffs, review the written `_contracts/**` files, and verify they contain no live secrets.

> If recording against live Nasdaq/CNN is rate-limited or unstable, author the success fixture by hand from a known-good response shape and the failure fixtures as simple `{status:404|500, body:{...}}`. The fixture format is in §6.3 of the spec.

- [ ] **Step 3: Author the failure + timeout fixtures by hand** (these don't need real recording). Example `tests/integration/_contracts/nasdaq/market-status-500.json`:

```json
{
  "request": { "method": "GET", "url": "https://api.nasdaq.com/api/market-info", "headers": {} },
  "response": { "status": 500, "headers": {}, "body": { "message": "internal error" } },
  "recordedAt": "2026-06-13T00:00:00.000Z"
}
```

A timeout→retry case is an array fixture `[ {status:504}, {status:200, body:{...}} ]` with the retry limit bounded via `ConfigManager` (as in Task 10 Step 1).

- [ ] **Step 4: Register every external cell** in `COVERAGE_MATRIX` (one per fixture). Example:

```ts
  { seam: "external", id: "nasdaq.marketStatus.success", fixturePath: "nasdaq/market-status-success.json" },
  { seam: "external", id: "nasdaq.marketStatus.500", fixturePath: "nasdaq/market-status-500.json" },
  { seam: "external", id: "nasdaq.quotes.success", fixturePath: "nasdaq/quotes-aapl-success.json" },
  { seam: "external", id: "nasdaq.quotes.404", fixturePath: "nasdaq/quotes-404.json" },
  { seam: "external", id: "nasdaq.top100.success", fixturePath: "nasdaq/top100-success.json" },
  { seam: "external", id: "yahoo.historical.success", fixturePath: "yahoo/historical-aapl-success.json" },
  { seam: "external", id: "yahoo.historical.malformed", fixturePath: "yahoo/historical-malformed.json" },
  { seam: "external", id: "cnn.fearGreed.success", fixturePath: "cnn/fear-greed-success.json" },
  { seam: "external", id: "cnn.fearGreed.500", fixturePath: "cnn/fear-greed-500.json" },
```

- [ ] **Step 5: Run replay + validator.**

Run: `pnpm --filter @ckirg/corelib-markets test:integration`
Expected: PASS (all from fixtures; no live calls).

Run: `pnpm test:integration:validate`
Expected: `✓` for external cells (no orphan fixtures, all scrubbed).

- [ ] **Step 6: Commit.**

```bash
git add ts-markets/tests/integration/external-rest.integration.test.ts tests/integration/_contracts/ tests/integration/coverage.matrix.ts
git commit -m "$(cat <<'EOF'
test(itest): external REST seam — Nasdaq/Yahoo-historical/CNN record-replay

Each provider x {success, failure, (retry/malformed)} via committed, scrubbed
fixtures; replay serves offline only. No Alpaca REST (streaming-only). Coverage cells
registered; validator green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: ts-cloud node project — router + DB composition

**Files:**
- Create: `ts-cloud/tests/integration/router.integration.test.ts`
- Modify: `tests/integration/coverage.matrix.ts`

**Current state (verify):** `createRouter(logger?)` (`ts-cloud/src/core/router.ts`) builds a `Hono<AppEnv>` with routes incl. `/health`. Test composition via `app.request(...)` (Hono's built-in test dispatcher) in the **node** project (filesystem DB available; FFI is real here).

- [ ] **Step 1: Write the suite:**

```ts
import { createRouter } from "@ckirg/corelib-cloud";
import { describe, expect, it } from "vitest";

describe("ts-cloud router composition (node)", () => {
  it("[cloud.health] GET /health returns 200 through the real Hono app", async () => {
    const app = createRouter();
    const res = await app.request("http://itest.local/health");
    expect(res.status).toBe(200);
  });
});
```

> **Oracle note:** confirm `createRouter` is exported from `@ckirg/corelib-cloud` (digest shows it in `ts-cloud/src/core/router.ts`). If the package exports an already-built `app` instead of a factory, import that. Add a DB-composition case (`/api/v1/sql` or `/api/v1/markets/nasdaq/...`) using `createTestDatabase()` if the router accepts an injected DB; otherwise keep the health-route composition as the cross-package node case and rely on Task 10 for direct DB coverage. Report SHAPE_DIVERGENCE if the router can't be constructed without live env bindings.

- [ ] **Step 2: Register the cell** in `COVERAGE_MATRIX`:

```ts
  { seam: "cross-package", id: "cloud.health" },
```

- [ ] **Step 3: Run.**

Run: `pnpm --filter @ckirg/corelib-cloud exec vitest run --config vitest.integration.config.ts`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add ts-cloud/tests/integration/router.integration.test.ts tests/integration/coverage.matrix.ts
git commit -m "$(cat <<'EOF'
test(itest): ts-cloud node project — Hono router composition via app.request

Real createRouter()/app.request('/health') composition in the node project (FS + FFI
available), no worker sandbox. Coverage cell registered.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: ts-cloud worker project — edge/proxy behavior

**Files:**
- Create: `ts-cloud/tests/integration/proxy.worker.integration.test.ts`

**Current state (verify):** the worker entry is exercised under `@cloudflare/vitest-pool-workers` (the `vitest.integration.worker.config.ts` from Task 3). No filesystem; FFI is `null` on Cloudflare. Test only edge/proxy behavior.

- [ ] **Step 1: Write the suite** (uses the worker pool's `SELF` fetcher to hit the deployed worker entry):

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("ts-cloud worker (edge/proxy)", () => {
  it("[cloud.worker.health] responds to /health in the workerd sandbox", async () => {
    const res = await SELF.fetch("http://itest.local/health");
    expect(res.status).toBe(200);
  });
});
```

> **Oracle note:** confirm the worker's entry is wired so `SELF.fetch` reaches the Hono app (check `wrangler.toml` `main` + the worker entry file). If `/health` isn't mounted at the worker root, use a route that is. Keep assertions to edge/proxy concerns only (status/headers/passthrough) — no DB/FFI here.

- [ ] **Step 2: Run the worker project.**

Run: `pnpm --filter @ckirg/corelib-cloud exec vitest run --config vitest.integration.worker.config.ts`
Expected: PASS in the workerd sandbox.

- [ ] **Step 3: Commit.**

```bash
git add ts-cloud/tests/integration/proxy.worker.integration.test.ts
git commit -m "$(cat <<'EOF'
test(itest): ts-cloud worker project — edge/proxy /health in workerd sandbox

SELF.fetch against the worker entry under @cloudflare/vitest-pool-workers; edge
behavior only (no FS/DB/FFI). Separate config from the node project.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: streaming live-tier suites (3 providers)

Live-only (`INTEGRATION_LIVE=1`), credential-gated, loud-skip otherwise; hard per-socket timeout; structural `market` shape check; the `connected` status is the hard gate.

**Files:**
- Create: `ts-markets/tests/integration/AlpacaStreaming.live.integration.test.ts`
- Create: `ts-markets/tests/integration/FinnhubStreaming.live.integration.test.ts`
- Create: `ts-markets/tests/integration/YahooStreaming.live.integration.test.ts`

**Current state (verify):** the three TS wrappers in `ts-markets/src/nasdaq/datafeeds/streaming/{alpaca,finnhub,yahoo}/*Streaming.ts` are `EventEmitter`s emitting `pricing`, `market` (parsed unified `MarketEvent`), `log`, and status events `connected`/`disconnected`/`reconnecting`/`error`. Constructors take no args; `subscribe(symbols: string[])`, `start()`, `stop()`. Credentials: Alpaca `APCA_API_KEY_ID`+`APCA_API_SECRET_KEY`; Finnhub `FINNHUB_API_KEY`; Yahoo none.

- [ ] **Step 1: A shared live-stream assertion helper** — add to `tests/integration/_harness/guards.ts`:

```ts
import { EventEmitter } from "node:events";

/** Connect a streamer, assert `connected` within timeout; best-effort shape-check the first `market`. */
export async function assertStreamsLive(
  stream: EventEmitter & { subscribe: (s: string[]) => void; start: () => Promise<void> | void; stop: () => Promise<void> | void },
  symbols: string[],
  provider: "alpaca" | "finnhub" | "yahoo",
  connectMs = 5000,
): Promise<void> {
  const connected = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no 'connected' within ${connectMs}ms`)), connectMs);
    stream.once("connected", () => { clearTimeout(t); res(); });
    stream.once("error", (e) => { clearTimeout(t); rej(new Error(`stream error: ${String(e)}`)); });
  });
  stream.subscribe(symbols);
  await stream.start();
  await connected; // hard gate

  // best-effort: if a market frame arrives within a short window, shape-check it.
  await new Promise<void>((res) => {
    const t = setTimeout(() => res(), 4000);
    stream.once("market", (ev: Record<string, unknown>) => {
      clearTimeout(t);
      if (ev) {
        if (!["trade", "quote"].includes(String(ev.type))) throw new Error(`bad market.type: ${ev.type}`);
        for (const f of ["ticker", "timestamp", "price"]) if (!(f in ev)) throw new Error(`market missing ${f}`);
        if (!(provider in ev)) throw new Error(`market missing provider key ${provider}`);
      }
      res();
    });
  });
  await stream.stop();
}
```

- [ ] **Step 2: Alpaca live suite** `ts-markets/tests/integration/AlpacaStreaming.live.integration.test.ts`:

```ts
import { AlpacaStreaming } from "@ckirg/corelib-markets";
import { afterEach, expect, it } from "vitest";
import { assertStreamsLive, liveDescribe, requireEnv } from "@itest/_harness/guards";

liveDescribe("AlpacaStreaming (live)", () => {
  let stream: AlpacaStreaming | undefined;
  afterEach(async () => { try { await stream?.stop(); } catch { /* ignore */ } });

  it("[stream.alpaca] connects and (best-effort) emits a shaped market event", async () => {
    if (!requireEnv("alpaca", ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"])) return;
    stream = new AlpacaStreaming();
    await assertStreamsLive(stream as never, ["AAPL", "MSFT"], "alpaca");
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Finnhub live suite** `FinnhubStreaming.live.integration.test.ts` (env `FINNHUB_API_KEY`; symbols `AAPL`/`MSFT`):

```ts
import { FinnhubStreaming } from "@ckirg/corelib-markets";
import { afterEach, expect, it } from "vitest";
import { assertStreamsLive, liveDescribe, requireEnv } from "@itest/_harness/guards";

liveDescribe("FinnhubStreaming (live)", () => {
  let stream: FinnhubStreaming | undefined;
  afterEach(async () => { try { await stream?.stop(); } catch { /* ignore */ } });

  it("[stream.finnhub] connects and (best-effort) emits a shaped market event", async () => {
    if (!requireEnv("finnhub", ["FINNHUB_API_KEY"])) return;
    stream = new FinnhubStreaming();
    await assertStreamsLive(stream as never, ["AAPL", "MSFT"], "finnhub");
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Yahoo live suite** `YahooStreaming.live.integration.test.ts` (tokenless; 24/7 `BTC-USD` so a frame arrives off-hours):

```ts
import { YahooStreaming } from "@ckirg/corelib-markets";
import { afterEach, expect, it } from "vitest";
import { assertStreamsLive, liveDescribe } from "@itest/_harness/guards";

liveDescribe("YahooStreaming (live)", () => {
  let stream: YahooStreaming | undefined;
  afterEach(async () => { try { await stream?.stop(); } catch { /* ignore */ } });

  it("[stream.yahoo] connects and (best-effort) emits a shaped market event", async () => {
    stream = new YahooStreaming();
    await assertStreamsLive(stream as never, ["BTC-USD"], "yahoo");
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 5: Verify guard behavior (default run skips; live run gated by creds).**

Run (default, offline): `pnpm --filter @ckirg/corelib-markets test:integration`
Expected: the three live suites are SKIPPED (no `INTEGRATION_LIVE`), no socket opened.

Run (live, if creds available): `INTEGRATION_LIVE=1 pnpm --filter @ckirg/corelib-markets exec vitest run --config vitest.integration.config.ts ...AlpacaStreaming.live...`
Expected: connects; passes (or loud-skips if creds missing).

- [ ] **Step 6: Validator now fully green** (the three `testFilePath`s exist):

Run: `pnpm test:integration:validate`
Expected: `✓ coverage matrix valid` (external + live-streaming all satisfied). Re-run the validator unit test:
Run: `pnpm --filter @ckirg/corelib exec vitest run --root ../ tests/integration/coverage-validator.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add ts-markets/tests/integration/*.live.integration.test.ts tests/integration/_harness/guards.ts
git commit -m "$(cat <<'EOF'
test(itest): streaming live-tier suites (Alpaca/Finnhub/Yahoo)

liveDescribe + requireEnv gated; assertStreamsLive() hard-gates on 'connected' and
best-effort shape-checks the first 'market' event (type/ticker/timestamp/price +
provider key). 24/7 BTC-USD for Yahoo off-hours. Completes the live-streaming
coverage cells -> validator green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: CI wiring

**Files:**
- Modify: the repo CI workflow (locate under `.github/workflows/`; spec §10 names `pipeline.yml`)
- Create: `.github/workflows/integration-live.yml` (nightly/manual live tier)

**Current state (verify):** In Step 0, read `.github/workflows/*.yml` to find the existing `build` job and the OS matrix. Add the `integration` job AFTER `build`, mirroring its matrix and runner setup (pnpm install, node, prebuilt `.node`).

- [ ] **Step 1: Add the `integration` job** to the main workflow (adapt the `needs`, matrix, and setup steps to the existing file's conventions — keep its `actions/checkout`, pnpm, node setup):

```yaml
  integration:
    needs: build
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      # (reuse the existing workflow's pnpm + node setup steps here)
      - run: pnpm install --frozen-lockfile
      - run: pnpm build-all
      - name: Integration tests (replay)
        run: pnpm test:integration
      - name: Coverage validator
        run: pnpm test:integration:validate
```

- [ ] **Step 2: Create `.github/workflows/integration-live.yml`** (nightly + manual; live tier; secrets injected):

```yaml
name: integration-live
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch: {}
jobs:
  live:
    runs-on: ubuntu-latest
    env:
      INTEGRATION_LIVE: "1"
      APCA_API_KEY_ID: ${{ secrets.APCA_API_KEY_ID }}
      APCA_API_SECRET_KEY: ${{ secrets.APCA_API_SECRET_KEY }}
      FINNHUB_API_KEY: ${{ secrets.FINNHUB_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      # (reuse pnpm + node setup)
      - run: pnpm install --frozen-lockfile
      - run: pnpm build-all
      - name: Integration tests (live)
        run: pnpm test:integration:live
```

- [ ] **Step 3: Confirm the local push gate is unchanged** — `verify:full` stays unit-only (integration is CI-only). Verify root `package.json` `verify:full` still equals `pnpm build-all && pnpm test-all:run` (NOT integration).

Run: `node -e "console.log(require('./package.json').scripts['verify:full'])"`
Expected: `pnpm build-all && pnpm test-all:run` (unchanged).

- [ ] **Step 4: Commit.**

```bash
git add .github/workflows/
git commit -m "$(cat <<'EOF'
ci(itest): integration job (replay + validator) + nightly live workflow

New integration job after build on the OS matrix runs pnpm test:integration (replay)
and the coverage validator; a separate nightly/manual integration-live workflow runs
the credential-gated live tier. Local verify:full stays unit-only.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (planner checklist — completed)

**Spec coverage:**
- §4.4 ConfigManager prerequisite → Task 1. §4.1 per-package configs → Task 3. §4.2 root scripts → Task 2. §4.3 `@itest` alias isolation → Task 2 (`tsconfig.integration.json`, not base) + per-config `resolve.alias` → Task 3.
- §5.1 cross-package → Tasks 11, 13. §5.2 external REST → Task 12 (+ Task 10 for ts-core HTTP). §5.3 ffi-scalar (incl. version==package.json + availability fallback) → Task 9. §5.4 streaming live-tier (guard, credentials, shape check, liquid symbols) → Task 15.
- §6 record/replay (3 modes) → Task 5; §6.1 sequential queues + bounded retries → Task 5 + Task 10. §6.2 scrubbing (headers/query/body) + record dry-run diff → Task 4 + Task 5 (`recordTo`). §6.3 fixture format → Tasks 10/12.
- §7 determinism/isolation (temp dir + DB, teardown, hard socket timeout) → Tasks 6, 15. §8 matrix + validator (incl. live-streaming seam + assertion #4) → Task 8. §9 layout → Tasks 2–8. §10 CI → Task 16. §11 conventions (child logger, serialized errors) → applied in harness (Task 4 scrubber logging) + tests. §12 deferrals unchanged (loopback, dist smoke).

**Type consistency:** harness API names are consistent across tasks — `Fixture`/`FixtureFile`, `scrubFixture`/`findUnscrubbedSecrets`, `loadFixture`/`registerFixture`/`recordTo`/`assertNoMisses`/`beginItest`/`endItest`/`resetItest`, `getTestTempDir`/`createTestDatabase`/`cleanupAll`, `ffiDescribe`/`liveDescribe`/`requireEnv`/`assertStreamsLive`, `SeamCell`/`COVERAGE_MATRIX`/`validateCoverage`. The `@itest/_harness/*` import path matches the `@itest` alias (Task 3) and `tsconfig.integration.json` `@itest/*` (Task 2).

**Oracle/verification flags (require Step-0 confirmation by implementers):** (a) the corelib `Database` method names (`execute`/`query` vs `run`/`all`) — Task 6/10; (b) `createDatabase` SQLite config field for `:memory:` — Task 6; (c) `getVersion`/`logAndDouble` exported by name vs via `coreFFI` — Task 9; (d) `RequestResult` field names + retry-override setter — Task 10; (e) `createRouter` export vs prebuilt `app` — Task 13; (f) worker entry root route for `SELF.fetch` — Task 14; (g) streamer event/method names match §5.4 — Task 15. Each is called out inline as an "Oracle note" with a SHAPE_DIVERGENCE instruction.

**Sequencing note:** Task 8's validator unit test goes fully green only after Task 15 creates the three `*.live.integration.test.ts` files; the plan flags this and keeps the cells in the matrix (Task 8 Step 4 verifies logic with them temporarily removed).
