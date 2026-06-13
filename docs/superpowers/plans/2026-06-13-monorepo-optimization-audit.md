# Monorepo Optimization Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the boundary-first, bootstrap-first audit from `docs/superpowers/specs/2026-06-13-monorepo-optimization-audit-design.md`, producing a prioritized findings backlog plus durable `/probes/` harnesses — **shipping no production fixes**.

**Architecture:** Two sequenced phases. **Phase A** stands up the audit infrastructure (`/probes/` scaffold, shared scratchpad, static-sweep tooling, loopback harness) and runs the static + Z-Boot + Z-Facade lenses. **Phase B** runs the Z-FFI + Z-Engine concurrency lenses (driven by the loopback harness + CI-offloaded heavy runs) and synthesizes the deduplicated backlog. Findings accumulate in a gitignored `.agent/audit_scratchpad.json`; the final ranked backlog is committed to `docs/superpowers/audits/`.

**Tech Stack:** pnpm workspaces, Vitest, dependency-cruiser (already a devDep), Node `node:net`/`ws` for the loopback harness, Rust (standalone `probes/rust/` crate + `loom`), `gh` CLI for CI offload, biome (the gate). No production source is modified.

---

## Conventions (read once before any task)

### Scratchpad (the shared register)

All findings are appended **immediately on discovery** to `.agent/audit_scratchpad.json` (already gitignored via `.agent/`). It is a JSON object `{ "findings": [ <record>, ... ] }`. Each record follows spec §7:

```jsonc
{
  "id": "boot-configmanager-init-race-01",   // <zone>-<symbol>-<lens>-NN, stable slug
  "zone": "phase0|boot|ffi|engine|facade",
  "lenses": ["races"],                         // subset of races|perf|arch|edge
  "severity": "critical|high|medium|low",      // impact × likelihood, rubric below
  "confidence": "confirmed-by-probe|confirmed-by-reading|suspected",
  "os_sensitivity": "windows-only|linux-only|cross-os",
  "testability": "A|B|C|D",                    // A unit · B loom · C stress-harness · D non-det-e2e
  "evidence": "ts-core/src/configs/ConfigManager.ts:42 — <what + repro/frequency>",
  "affected_surfaces": [],                      // higher zones touched by a lower-zone root fault
  "probe": null,                                // path under /probes/ iff confidence==confirmed-by-probe
  "fix_sketch": "one paragraph remediation direction — NOT implemented this cycle",
  "fix_cycle": null                             // filled at synthesis
}
```

**Severity rubric (impact × likelihood):**

| Impact \ Likelihood | Rare | Plausible | Common |
|---|---|---|---|
| **Corruption / deadlock / data-loss** | high | critical | critical |
| **Wrong result / dropped event** | medium | high | critical |
| **Perf regression / resource leak** | low | medium | high |
| **Cosmetic / conformance-only** | low | low | medium |

**Probe-requirement rule (spec §2, §7):** author a durable probe **only** for `confirmed-by-probe`. `confirmed-by-reading` and `suspected` carry `probe: null` — never write a harness to "prove" what code reading already establishes.

### Commands

- Append a finding: `node probes/tools/scratchpad.mjs add '<json-record>'`
- List findings: `node probes/tools/scratchpad.mjs list`
- Run JS probes: `pnpm exec vitest run -c probes/vitest.config.ts`
- Run Rust probes: `cargo test --manifest-path probes/rust/Cargo.toml`
- The repo gate (unchanged, respect as-is): pre-commit runs `pnpm format-all && pnpm lint-all`. Do **not** add `--no-verify`.

### Hard rules

- **No production source edits.** If making a probe build/link would require touching `ts-*/src` or `rust/src`, **STOP** and record the need as a finding instead (`SHAPE/STATE` divergence → escalate).
- **agy-first at each phase boundary** (after Task A7 and B5): divergent relay to `ANTIGRAVITY-TO-CLAUDE.md`, present both views, user decides.
- Commit after each task. Trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure (new/modified)

**New (all under the single new top-level `/probes/` + audit doc + CI workflow):**
- `probes/README.md` — what /probes is, how to run, isolation guarantees.
- `probes/.gitignore` — `**/target`, `node_modules`.
- `probes/vitest.config.ts` — dedicated JS-probe runner (root configs never reach here).
- `probes/tools/scratchpad.mjs` — append/list/validate findings in `.agent/audit_scratchpad.json`.
- `probes/tools/scratchpad.test.mjs` — unit tests for the helper.
- `probes/tools/ci-offload.mjs` — `gh workflow run` trigger + poll + parse + reclaim (Phase B).
- `probes/_harness/loopback-server.mjs` — in-process TCP/WS mock server.
- `probes/_harness/loopback-server.test.ts` — harness self-test.
- `probes/rust/Cargo.toml` + `probes/rust/src/lib.rs` — standalone probe crate (path-dep on `corelib-rust`, `loom` feature).
- `probes/rust/tests/*.rs` — Rust/loom concurrency probes (Phase B).
- `probes/js/*.probe.test.ts` — JS probes (Z-Boot races, FFI re-entrancy driver).
- `.dependency-cruiser.cjs` — layering + isomorphic-import-denylist rules (Phase 0).
- `.github/workflows/heavy-probes.yml` — `workflow_dispatch` heavy-run offload.
- `docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md` — the final ranked backlog (Task B5).

**Modified:** `.gitignore` (add probe artifacts), `ROADMAP.md` (seed clusters, Task B5). **No `ts-*/` or `rust/` source is modified.**

---

# PHASE A — Static & Isomorphic Foundation

### Task A0: Verify streamer endpoint-override (the mandated first task)

**Files:** Inspect only — `rust/src/markets/nasdaq/datafeeds/streaming/{alpaca,yahoo,finnhub}/*_driver.rs` + `*_streamer.rs`.

- [ ] **Step 1: Confirm the override exists**

Run: `rg -n "base_url|DEFAULT_.*_WS_URL|test injection" rust/src/markets/nasdaq/datafeeds/streaming`
Expected: each provider exposes `pub base_url: Option<String>` and a `DEFAULT_*_WS_URL` const the driver overrides with it (yahoo notes "retained for … test injection"). This means the loopback harness (A6) can point streamers at `ws://localhost:<port>` via `base_url` with **no production change**.

- [ ] **Step 2: Record the outcome (decision, not a fix)**

If confirmed (expected): note in the Task A6 harness README that providers are pointed via `base_url`. Proceed.
If **NOT** confirmed for any provider: append a finding `engine-<provider>-no-endpoint-override-01` (lens: edge/arch, testability D) and set that provider's FFI/engine probes to **recorded-frame replay** fallback (spec §9.2). Do **not** add an override to production source.

> **A0 OUTCOME (2026-06-13):** Partially confirmed.
> - **yahoo** (`yahoo_driver.rs:145`/`:184`) and **alpaca** (`alpaca_driver.rs:143`/`:213`) expose `pub base_url: Option<String>` overriding `DEFAULT_*_WS_URL` → **live loopback** (A6) applies.
> - **finnhub** does NOT: `finnhub_driver.rs:125` hardcodes `format!("{FINNHUB_WS}?token={}", …)` and `FinnhubConfig` (`finnhub_streamer.rs:133`) exposes only `token`/`name`. Finding `engine-finnhub-no-endpoint-override-01` logged (severity low, confirmed-by-reading). **Finnhub FFI/engine probes (B2/B3) must use recorded-frame replay (spec §9.2), not live loopback.** No production override added.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-13-monorepo-optimization-audit.md
git commit -m "audit(A0): confirm streamer base_url endpoint-override; harness uses live loopback"
```

---

### Task A1: `/probes/` scaffold + isolation proof

**Files:**
- Create: `probes/README.md`, `probes/.gitignore`, `probes/vitest.config.ts`, `probes/rust/Cargo.toml`, `probes/rust/src/lib.rs`, `probes/rust/tests/smoke.rs`, `probes/js/smoke.probe.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the JS isolation-proof probe (failing — config absent)**

`probes/js/smoke.probe.test.ts`:
```ts
import { expect, test } from "vitest";
test("probes run under their own config", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 2: Verify the root gate does NOT sweep it**

Run: `pnpm -r test:run`
Expected: PASS, and the output shows **no** `smoke.probe.test.ts` (per-package vitest is rooted in each package dir; root `/probes` is outside their scope). If it appears, stop and add `'**/probes/**'` to each package `vitest.config.ts` `exclude`.

- [ ] **Step 3: Create the dedicated probe vitest config**

`probes/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    root: __dirname,
    include: ["**/*.probe.test.ts", "_harness/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Run probes via their own config — verify PASS**

Run: `pnpm exec vitest run -c probes/vitest.config.ts`
Expected: PASS, 1 test (`smoke.probe.test.ts`).

- [ ] **Step 5: Create the standalone Rust probe crate**

`probes/rust/Cargo.toml`:
```toml
[package]
name = "corelib-probes"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
corelib-rust = { path = "../../rust" }
tokio = { version = "1.52.3", features = ["full"] }

[target.'cfg(loom)'.dependencies]
loom = "0.7"

[features]
loom = []
```

`probes/rust/src/lib.rs`:
```rust
//! corelib-probes — standalone audit probe crate. NOT part of any workspace.
//! Depends on corelib-rust by path (rlib target); links without the Node host.
```

`probes/rust/tests/smoke.rs`:
```rust
#[test]
fn probe_crate_links_against_corelib_rust() {
    // Compiles iff the path-dep rlib links cleanly (no Node host required).
    assert_eq!(2 + 2, 4);
}
```

- [ ] **Step 6: Verify Rust isolation both directions**

Run: `cd rust && cargo test` — Expected: PASS, and **no** `corelib-probes` tests run (probe crate is not in `rust/`'s build).
Run: `cargo test --manifest-path probes/rust/Cargo.toml` — Expected: PASS, `probe_crate_links_against_corelib_rust`.

- [ ] **Step 7: Ignore probe build artifacts + write README**

Append to `.gitignore`:
```
# /probes build artifacts (the probe SOURCES are durable + tracked)
probes/**/target
probes/**/node_modules
```

`probes/README.md` — document: purpose (durable audit harnesses per spec §9), how to run (the two commands above), isolation guarantees (standalone crate, dedicated vitest config), and that probes assert **behavioral outcomes** (spec §3.1), never structure.

- [ ] **Step 8: Commit**

```bash
git add probes/ .gitignore
git commit -m "audit(A1): scaffold durable /probes (standalone rust crate + dedicated vitest), prove isolation"
```

---

### Task A2: Audit scratchpad helper

**Files:**
- Create: `probes/tools/scratchpad.mjs`, `probes/tools/scratchpad.test.mjs`

- [ ] **Step 1: Write failing tests**

`probes/tools/scratchpad.test.mjs`:
```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFinding, loadFindings, validateFinding } from "./scratchpad.mjs";

const REQUIRED = ["id","zone","lenses","severity","confidence","os_sensitivity","testability","evidence","fix_sketch"];

test("validateFinding rejects a record missing a required field", () => {
  const bad = { id: "x" };
  assert.throws(() => validateFinding(bad), /missing/i);
});

test("validateFinding enforces probe-requirement rule", () => {
  const base = { id:"e-1", zone:"engine", lenses:["races"], severity:"high",
    confidence:"confirmed-by-probe", os_sensitivity:"cross-os", testability:"C",
    evidence:"x:1", fix_sketch:"y", probe:null };
  assert.throws(() => validateFinding(base), /confirmed-by-probe requires probe/i);
  base.probe = "probes/rust/tests/foo.rs";
  assert.doesNotThrow(() => validateFinding(base));
});

test("addFinding persists and loadFindings returns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  const path = join(dir, "audit_scratchpad.json");
  const rec = { id:"boot-1", zone:"boot", lenses:["races"], severity:"medium",
    confidence:"confirmed-by-reading", os_sensitivity:"cross-os", testability:"A",
    evidence:"ConfigManager.ts:42", fix_sketch:"serialize init", probe:null };
  addFinding(rec, path);
  const all = loadFindings(path);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "boot-1");
  rmSync(dir, { recursive: true, force: true });
});

void REQUIRED;
```

- [ ] **Step 2: Run — verify FAIL**

Run: `node --test probes/tools/scratchpad.test.mjs`
Expected: FAIL ("Cannot find module './scratchpad.mjs'").

- [ ] **Step 3: Implement the helper**

`probes/tools/scratchpad.mjs`:
```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = ".agent/audit_scratchpad.json";
const ZONES = ["phase0","boot","ffi","engine","facade"];
const SEV = ["critical","high","medium","low"];
const CONF = ["confirmed-by-probe","confirmed-by-reading","suspected"];
const OS = ["windows-only","linux-only","cross-os"];
const TEST = ["A","B","C","D"];
const REQUIRED = ["id","zone","lenses","severity","confidence","os_sensitivity","testability","evidence","fix_sketch"];

export function validateFinding(rec) {
  for (const f of REQUIRED) if (rec[f] === undefined || rec[f] === null || rec[f] === "")
    throw new Error(`finding missing required field: ${f}`);
  if (!ZONES.includes(rec.zone)) throw new Error(`bad zone: ${rec.zone}`);
  if (!SEV.includes(rec.severity)) throw new Error(`bad severity: ${rec.severity}`);
  if (!CONF.includes(rec.confidence)) throw new Error(`bad confidence: ${rec.confidence}`);
  if (!OS.includes(rec.os_sensitivity)) throw new Error(`bad os_sensitivity: ${rec.os_sensitivity}`);
  if (!TEST.includes(rec.testability)) throw new Error(`bad testability: ${rec.testability}`);
  if (!Array.isArray(rec.lenses) || rec.lenses.length === 0) throw new Error("lenses must be a non-empty array");
  if (rec.confidence === "confirmed-by-probe" && !rec.probe)
    throw new Error("confirmed-by-probe requires probe path");
  return true;
}

export function loadFindings(path = DEFAULT_PATH) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).findings ?? [];
}

export function addFinding(rec, path = DEFAULT_PATH) {
  validateFinding(rec);
  const findings = loadFindings(path);
  if (findings.some((f) => f.id === rec.id)) throw new Error(`duplicate id: ${rec.id}`);
  findings.push(rec);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ findings }, null, 2)}\n`);
  return rec;
}

// CLI: node scratchpad.mjs add '<json>' | list
if (process.argv[1]?.endsWith("scratchpad.mjs")) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "add") { const r = addFinding(JSON.parse(arg)); console.log(`added ${r.id}`); }
  else if (cmd === "list") { console.log(JSON.stringify(loadFindings(), null, 2)); }
  else { console.error("usage: scratchpad.mjs add '<json>' | list"); process.exit(1); }
}
```

- [ ] **Step 4: Run — verify PASS**

Run: `node --test probes/tools/scratchpad.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add probes/tools/scratchpad.mjs probes/tools/scratchpad.test.mjs
git commit -m "audit(A2): scratchpad helper (schema-validated append/list) with probe-requirement rule"
```

---

### Task A3: Phase 0 static sweep (layering + isomorphic denylist + logger contract)

**Files:**
- Create: `.dependency-cruiser.cjs`, `probes/tools/logger-contract-sweep.mjs`
- Inspect: all `ts-*/src/**`

- [ ] **Step 1: Author the dependency-cruiser ruleset**

`.dependency-cruiser.cjs`:
```js
/** Audit Phase-0 rules. dependency-cruiser is already a devDep. */
module.exports = {
  forbidden: [
    {
      name: "markets-cloud-depend-only-on-core",
      comment: "ts-markets/ts-cloud may import ts-core, never each other or back-channels (AGENTS.md §1).",
      severity: "error",
      from: { path: "^ts-(markets|cloud)/src" },
      to: { path: "^ts-(markets|cloud)/src", pathNot: "^ts-core/src" },
    },
    {
      name: "ts-core-no-node-builtins",
      comment: "ts-core is multi-runtime-first; no hard Node-only built-in imports (spec §4.1).",
      severity: "error",
      from: { path: "^ts-core/src", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"], path: "^(node:)?(fs|path|module|child_process|os|net|tls|crypto|worker_threads)$" },
    },
  ],
  options: { doNotFollow: { path: "node_modules" }, tsPreCompilationDeps: true },
};
```

- [ ] **Step 2: Run the layering + isomorphic sweep**

Run: `pnpm exec depcruise --config .dependency-cruiser.cjs ts-core/src ts-markets/src ts-cloud/src`
Expected: a list of `error` violations (or none). **Each violation is a finding.** Note: a `node:*` import that is *runtime-guarded* (inside a `detectRuntime()`/`typeof` branch — see `ts-core/src/utils/runtime.ts`) is a **false positive** → verify by reading before logging.

- [ ] **Step 3: Log Phase-0 findings**

For each true violation, append a `phase0-*` finding (lens: arch; confidence: confirmed-by-reading; testability: A; os_sensitivity: `cross-os`, or `linux-only`/edge if it breaks only edge). Example:
```bash
node probes/tools/scratchpad.mjs add '{"id":"phase0-tscore-node-fs-01","zone":"phase0","lenses":["arch"],"severity":"high","confidence":"confirmed-by-reading","os_sensitivity":"linux-only","testability":"A","evidence":"ts-core/src/<file>.ts:NN — top-level `import \"node:fs\"` reachable from edge entry; not runtime-guarded","fix_sketch":"move behind detectRuntime() guard or a node-only impl module","probe":null}'
```

- [ ] **Step 4: Logger-contract sweep**

`probes/tools/logger-contract-sweep.mjs` — ripgrep-driven scan reporting (a) `console.\.(log|warn|error|info|debug)` in `ts-*/src` non-test files, (b) `extras` objects passing a raw `error:` not wrapped by `serializeError(` (heuristic: `error:\s*(e|err|error)\b` without `serializeError`). Print `file:line` hits.
```js
import { execFileSync } from "node:child_process";
const rg = (pat, glob) => { try { return execFileSync("rg", ["-n", pat, "--glob", glob, "ts-core/src","ts-markets/src","ts-cloud/src"], {encoding:"utf8"}); } catch { return ""; } };
const consoles = rg("console\\.(log|warn|error|info|debug)\\(", "!*.test.ts");
const rawErr = rg("error:\\s*(e|err|error)\\b", "!*.test.ts");
console.log("=== console.* in app code ===\n" + consoles);
console.log("=== suspected raw Error in extras (verify serializeError) ===\n" + rawErr);
```
Run: `node probes/tools/logger-contract-sweep.mjs` — log each confirmed violation as a `phase0-logger-*` finding (read to rule out false positives first).

- [ ] **Step 5: Commit**

```bash
git add .dependency-cruiser.cjs probes/tools/logger-contract-sweep.mjs
git commit -m "audit(A3): Phase-0 static sweep (depcruise layering+isomorphic denylist, logger contract); findings logged"
```

---

### Task A4: Z-Boot audit (ts-core singletons / runtime)

**Files:** Inspect — `ts-core/src/configs/ConfigManager.ts`, `ts-core/src/loggers/**`, `ts-core/src/retrieve/RequestUnlimited.ts`, `ts-core/src/utils/runtime.ts`. Possible probe: `probes/js/configmanager-init-race.probe.test.ts`.

- [ ] **Step 1: Read for shared-state / ordering hazards**

Inspect each file against the **races** + **runtime-isomorphism** + **perf** lenses. Specifically:
- `ConfigManager`: is it a module-level singleton? Does `initialize(args?)` guard against concurrent/double init? What happens if two callers `initialize()` with different args, or read config before init? (ordering race / poisoned-args-down-FFI per spec §5.)
- loggers: per-runtime module state — any lazy global mutated without guard?
- `RequestUnlimited`: retry/backoff/abort — unbounded retry? shared `AbortController` reuse? backoff without jitter?
- runtime detection: cached once or re-evaluated? any Node-only path reachable under edge?

- [ ] **Step 2: Log reading-level findings**

Append `boot-*` findings for each hazard (confidence: confirmed-by-reading, testability A/B). Example dedup note: if a ConfigManager race also corrupts FFI args, this is owned by `boot` with `affected_surfaces:["ffi"]` (lowest-boundary-owns is for cross-boundary *root* faults that originate lower; an init race originates in boot).

- [ ] **Step 3: (If a race is plausible) write a behavioral probe**

Only if you can elicit a behavioral outcome. `probes/js/configmanager-init-race.probe.test.ts` — fire N concurrent `ConfigManager.initialize()` with conflicting args via `Promise.all`, assert the post-condition the code claims to guarantee (e.g. config is internally consistent / last-writer-wins is deterministic). Behavioral oracle, budget per §3.1 (≤20k iters or ≤20s). If it reproduces a wrong outcome → upgrade that finding to `confirmed-by-probe`, set `probe` path.

- [ ] **Step 4: Verify the probe + run it**

Run: `pnpm exec vitest run -c probes/vitest.config.ts`
Expected: the probe runs; record observed frequency in the finding `evidence`. Budget-exhausted-without-repro ⇒ leave finding `suspected` (spec §3.1).

- [ ] **Step 5: Commit**

```bash
git add probes/ .agent/audit_scratchpad.json 2>/dev/null; git add probes/
git commit -m "audit(A4): Z-Boot findings (ConfigManager/loggers/RequestUnlimited/runtime)"
```
*(Note: `.agent/` is gitignored — the scratchpad is a working artifact, not committed; only probe sources are.)*

---

### Task A5: Z-Facade audit (ts-markets / ts-cloud)

**Files:** Inspect — `ts-cloud/src/platform/{cloudflare/worker.ts,aws/handler.ts,cloudrun/server.ts}`, `ts-cloud/src/core/router.ts`, `ts-cloud/src/retrieve/RequestUnlimitedCloud.ts`, `ts-markets/src/nasdaq/**` facades.

- [ ] **Step 1: Conformance + perf + isomorphism reading**

- Layering: do facades import only `ts-core` (cross-check A3 output)?
- Transparent-proxy (AGENTS.md §1): does the edge proxy return single-URL body/status directly, arrays of `RequestResult` for bulk? Any deviation = finding.
- Edge cold-start / bundle: measure the cloudflare bundle. Run `cd ts-cloud && pnpm exec wrangler deploy --dry-run --outdir /tmp/cf-bundle 2>&1 | rg -i "size|upload"` (dry-run only — no deploy). Record bundle size; flag oversized deps reachable from the worker entry.
- Isomorphic execution: does the bundled `ts-core` pull any A3-flagged Node-only import into the edge build?

- [ ] **Step 2: Log `facade-*` findings** (confidence: confirmed-by-reading; perf items testability C if they need a bench).

- [ ] **Step 3: Commit**

```bash
git add probes/
git commit -m "audit(A5): Z-Facade findings (layering/transparent-proxy/edge bundle/isomorphism)"
```

---

### Task A6: Loopback harness `_harness/`

**Files:**
- Create: `probes/_harness/loopback-server.mjs`, `probes/_harness/loopback-server.test.ts`

- [ ] **Step 1: Write the harness self-test (failing)**

`probes/_harness/loopback-server.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { LoopbackServer } from "./loopback-server.mjs";

let server: LoopbackServer;
beforeAll(async () => { server = new LoopbackServer(); await server.listen(); });
afterAll(async () => { await server.close(); });

test("client connects, receives a queued frame, and observes forced disconnect", async () => {
  server.queueFrame(JSON.stringify({ T: "t", S: "AAPL", p: 1 }));
  const ws = new WebSocket(server.url);
  const first = await new Promise<string>((res) => ws.on("message", (d) => res(d.toString())));
  expect(JSON.parse(first).S).toBe("AAPL");
  server.forceDisconnectAll();           // deterministic disconnect for reconnect probes
  const closed = await new Promise<number>((res) => ws.on("close", (c) => res(c)));
  expect(closed).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `pnpm exec vitest run -c probes/vitest.config.ts probes/_harness/loopback-server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the loopback server**

`probes/_harness/loopback-server.mjs` — a `ws`-based in-process server exposing the control surface the FFI/engine probes need: `listen()`, `url` (`ws://127.0.0.1:<port>`), `queueFrame(s)` (sent on connect), `sendToAll(s)`, `forceDisconnectAll()` (deterministic mid-stream drop), `blockFor(ms)` (stall the server to simulate slow peer), `close()`. Uses `ws` (already transitively present via deps; if not, add to `probes/` only) and `node:http`. Keep it small and synchronous-controllable.

- [ ] **Step 4: Run — verify PASS**

Run: `pnpm exec vitest run -c probes/vitest.config.ts probes/_harness/loopback-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add probes/_harness/
git commit -m "audit(A6): in-process TCP/WS loopback harness (queue/disconnect/block control) for FFI probes"
```

---

### Task A7: Phase A checkpoint — partial dedup + agy relay

- [ ] **Step 1: Run the dedup sweep over Phase-A findings** (deterministic ownership rule, spec §6) — see Task B5 Step 1 for the algorithm; run it now over the partial scratchpad to catch early cross-zone duplicates and surface gaps.

- [ ] **Step 2: agy-first phase-boundary relay**

Delegate to agy a divergent review of the Phase-A findings + the harness/scratchpad infra: gaps, false positives, anything Phase B should target. Present agy's + Claude's views to the user; user decides before Phase B.

- [ ] **Step 3: Commit (any infra fixes from the relay)**

```bash
git commit -am "audit(A7): Phase-A checkpoint — partial dedup + agy relay folded" --allow-empty
```

---

# PHASE B — Concurrency & Native FFI

### Task B1: CI heavy-probe offload (`heavy-probes.yml` + `ci-offload.mjs`)

**Files:**
- Create: `.github/workflows/heavy-probes.yml`, `probes/tools/ci-offload.mjs`

- [ ] **Step 1: Author the heavy-probe workflow**

`.github/workflows/heavy-probes.yml`:
```yaml
name: Heavy Probes
on:
  workflow_dispatch:
    inputs:
      probe:  { description: "probe id (cargo test name or probe path)", required: true }
      commit: { description: "commit SHA to check out", required: true }
jobs:
  run-probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { ref: "${{ inputs.commit }}" }
      - uses: dtolnay/rust-toolchain@stable
      - uses: pnpm/action-setup@v5
        with: { version: 11.5.2 }
      - uses: actions/setup-node@v6
        with: { node-version: 24, cache: 'pnpm' }
      - run: pnpm install
      - name: Run probe (prints a machine-parseable RESULT line)
        run: |
          echo "PROBE_START ${{ inputs.probe }}"
          cargo test --manifest-path probes/rust/Cargo.toml "${{ inputs.probe }}" -- --nocapture 2>&1 | tee probe.out || true
          echo "RESULT probe=${{ inputs.probe }} outcome=$(grep -q 'PROBE_CONFIRMED' probe.out && echo confirmed || echo not-reproduced)"
```
Each Rust probe must print `PROBE_CONFIRMED <freq>` on reproduction (and nothing on budget-exhaustion) so the `RESULT` line is deterministic.

- [ ] **Step 2: Author the local trigger/reclaim client**

`probes/tools/ci-offload.mjs` — implements spec §9.3: (1) write stub finding `confidence:"suspected"` annotated `pending-ci`; (2) `gh workflow run heavy-probes.yml -f probe=<id> -f commit=<sha>`; (3) poll `gh run list --workflow heavy-probes.yml` for the new run, `gh run watch <id> --exit-status`; (4) `gh run view <id> --log` → parse the `RESULT … outcome=` line → if `confirmed`, promote the scratchpad finding to `confirmed-by-probe` (set `probe` + run id in evidence), else leave `suspected`. No human steps.

- [ ] **Step 3: Smoke-test the client wiring (dry, no real run)**

Run: `node probes/tools/ci-offload.mjs --print-cmd engine-redb-stress-01 $(git rev-parse HEAD)`
Expected: prints the exact `gh workflow run …` it *would* execute (a `--print-cmd` dry mode), and the stub finding shape. (Real triggering happens in B3/B4.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/heavy-probes.yml probes/tools/ci-offload.mjs
git commit -m "audit(B1): CI heavy-probe offload workflow + headless gh trigger/reclaim client (spec §9.3)"
```

---

### Task B2: Z-FFI re-entrancy / callback-deadlock probe (the blindspot, spec §8)

**Files:**
- Create: `probes/js/ffi-reentrancy-gc.probe.test.ts`
- Inspect: `rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs` (`start`/`subscribe_channel*`/callbacks), provider `*_streamer.rs` (`#[napi(constructor)] new` + `start` + the `on_*` callbacks).

- [ ] **Step 1: Read the FFI callback path**

Map how Rust delivers events to JS (threadsafe_function?), and whether any JS→Rust call is synchronous while Rust awaits a JS callback ack. Note the exact entry points the probe must drive (e.g. `new AlpacaStreaming(...)`, `.start()`, the raw + `on_market_event` callbacks).

- [ ] **Step 2: Write the behavioral probe** (drives real FFI via the loopback harness)

`probes/js/ffi-reentrancy-gc.probe.test.ts` — point a streamer at the A6 loopback `base_url`, then: subscribe/unsubscribe in a tight loop while `forceDisconnectAll()` fires reconnects **and** `global.gc()` runs (vitest with `--expose-gc`), all inside the §3.1 envelope (≤20s). **Behavioral oracle:** every queued frame is delivered to the JS callback and the process makes forward progress (a watchdog timer asserts no hang) — no deadlock, no dropped/duplicated event. On hang/drop → `PROBE_CONFIRMED`.

- [ ] **Step 3: Run locally (bounded)**

Run: `node --expose-gc node_modules/vitest/vitest.mjs run -c probes/vitest.config.ts probes/js/ffi-reentrancy-gc.probe.test.ts`
Expected: PASS (no fault) → finding `suspected`; or watchdog trips → finding `confirmed-by-probe`. Record observed frequency.

- [ ] **Step 4: Offload the heavy/long variant to CI if local is inconclusive**

Run: `node probes/tools/ci-offload.mjs ffi-reentrancy-gc $(git rev-parse HEAD)` → reclaim outcome into the finding.

- [ ] **Step 5: Log + commit**

Append `ffi-reentrancy-deadlock-01` (owner zone `ffi`; affected_surfaces may include `boot`/`facade`). Commit:
```bash
git add probes/js/ffi-reentrancy-gc.probe.test.ts
git commit -m "audit(B2): Z-FFI re-entrancy/callback-deadlock probe (reconnect-under-GC); finding logged"
```

---

### Task B3: Z-Engine concurrent-redb stress probe

**Files:**
- Create: `probes/rust/tests/redb_concurrent.rs`
- Inspect: `core/host.rs` (the `Arc<Database>` + `load_subscriptions`/persist path), provider drivers' redb usage.

- [ ] **Step 1: Read the redb access pattern** — who writes/reads concurrently (subscribe vs reconnect-resume reading "fresh each connect"), any unguarded shared handle.

- [ ] **Step 2: Write the stress probe** (`probes/rust/tests/redb_concurrent.rs`) — spawn concurrent tasks that subscribe/persist and reconnect/load against the host's redb path, §3.1 budget. **Behavioral oracle:** no panic, no corrupted/partial read, no lost subscription. Print `PROBE_CONFIRMED <freq>` on a violated invariant.

- [ ] **Step 3: Run**

Run: `cargo test --manifest-path probes/rust/Cargo.toml redb_concurrent -- --nocapture`
Expected: PASS (invariant holds) → `suspected`/`confirmed-by-reading`; or printed `PROBE_CONFIRMED` → `confirmed-by-probe`. Tag `os_sensitivity` deliberately (redb file-handle semantics differ Windows vs Linux — run the CI offload to compare).

- [ ] **Step 4: Offload cross-OS run + reclaim**

Run: `node probes/tools/ci-offload.mjs redb_concurrent $(git rev-parse HEAD)` → if Linux differs from local Windows, set `os_sensitivity` accordingly.

- [ ] **Step 5: Log + commit**

```bash
git add probes/rust/tests/redb_concurrent.rs
git commit -m "audit(B3): Z-Engine concurrent-redb stress probe; cross-OS reclaim; finding logged"
```

---

### Task B4: Z-Engine tokio-channel / teardown-Drop loom models

**Files:**
- Create: `probes/rust/tests/reconnect_teardown_loom.rs`
- Inspect: `core/supervisor.rs`, `core/reconnect.rs`, `core/driver.rs` (task spawn/Drop teardown, channel close ordering).

- [ ] **Step 1: Read the teardown/reconnect concurrency** — the two spawned tasks, Drop-based GC teardown, backoff-reset-on-healthy-drop, channel close vs in-flight send.

- [ ] **Step 2: Write a standalone loom model** (NOT instrumenting corelib-rust, per spec §9.1) — re-model the lock/channel/teardown ordering in `probes/rust/tests/reconnect_teardown_loom.rs` under `#[cfg(loom)]` using `loom::sync`/`loom::thread`. **Behavioral oracle:** no interleaving deadlocks, no send-after-close panic, no lost-shutdown. If the real fault can't be modeled without touching `corelib-rust`, **stop** and log a `suspected` finding (testability B) noting in-situ instrumentation is needed — defer to a fix cycle.

- [ ] **Step 3: Run the loom model**

Run: `RUSTFLAGS="--cfg loom" cargo test --manifest-path probes/rust/Cargo.toml --features loom reconnect_teardown_loom -- --nocapture`
Expected: loom explores interleavings; a found violation prints the offending interleaving → `confirmed-by-probe` (record the interleaving in `evidence`). Clean exploration → `confirmed-by-reading`/`suspected`.

- [ ] **Step 4: Log + commit**

```bash
git add probes/rust/tests/reconnect_teardown_loom.rs
git commit -m "audit(B4): Z-Engine reconnect/teardown loom model (standalone); finding logged"
```

---

### Task B5: Synthesis — correlate, dedup, rank → backlog + ROADMAP

**Files:**
- Create: `probes/tools/synthesize.mjs`, `docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Implement the dedup/rank tool** (spec §6 ownership rule)

`probes/tools/synthesize.mjs` — load the scratchpad; (1) **cluster** by symbol-identity (parse the `evidence` `file:symbol`); (2) for clustered records spanning zones, keep the one owned by the **lowest boundary zone** (`engine < ffi < boot < facade`), fold the others' zones into `affected_surfaces`; (3) **rank** by `severity` (critical→low), tie-break by confidence (probe > reading > suspected); (4) emit a markdown table + the full records to the audits doc.
Run: `node probes/tools/synthesize.mjs > docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md`

- [ ] **Step 2: Hand-verify the dedup** — read the generated doc; confirm no root fault appears twice and each owner zone is the lowest in its chain. Fix clustering edge-cases in the tool if needed; re-run.

- [ ] **Step 3: Seed ROADMAP.md** — add the top finding-clusters as future fix cycles under a new "## Audit findings (2026-06-13)" section, each: what · severity · pointer to the finding id + its probe. Each becomes its own spec→plan→cycle (no fixes now).

- [ ] **Step 4: agy convergent final review** (phase-boundary relay) — agy reviews the ranked backlog for missed correlations / mis-ranked severity; fold; user decides.

- [ ] **Step 5: Commit**

```bash
git add probes/tools/synthesize.mjs docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md ROADMAP.md
git commit -m "audit(B5): synthesize ranked findings backlog; seed ROADMAP fix-cycles"
```

---

## Self-Review (run after the plan, before execution)

- **Spec coverage:** Phase 0 → A3; Z-Boot → A4; Z-FFI → B2; Z-Engine → B3/B4; Z-Facade → A5; scratchpad+dedup → A2/A7/B5; `/probes` isolation → A1; loopback harness → A6; CI offload → B1; stopping-rule → embedded in A4/B2/B3/B4 oracles; schema incl. os_sensitivity/testability → A2; durable-probe scope cap → A2 validator + each probe task. All spec §3–§10 requirements map to a task. ✓
- **No production fixes:** every task inspects or adds under `probes/`/`docs/`/`.github/`; A0 and B4 explicitly convert "would need a production change" into a finding. ✓
- **Type consistency:** finding record shape identical in Conventions, A2 validator, and B5 synthesizer (`id/zone/lenses/severity/confidence/os_sensitivity/testability/evidence/affected_surfaces/probe/fix_sketch/fix_cycle`). Zone ordering `engine<ffi<boot<facade` used identically in §6 dedup and B5. ✓
