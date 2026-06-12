# Integration Test Tier — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (design); agy divergent pass complete (brainstorm phase). Spec-phase agy pass pending.
- **Subproject:** Exhaustive integration tests for the corelib monorepo.
- **Review record:** `ANTIGRAVITY-TO-CLAUDE.md` → "2026-06-12 — Integration-test tier (divergent design pass)".

## 1. Context & Goal

corelib is a pnpm-workspace monorepo: `ts-core` (base: FFI, logging, resilient HTTP, config, database)
is consumed by `ts-markets` (Nasdaq/Yahoo/Alpaca data feeds) and `ts-cloud` (Cloudflare Workers / edge),
with a private Rust core exposed via `corelib-rust.node` (N-API).

The existing test suite is **co-located unit tests that mock the internal package boundary**
(`vi.mock("@ckir/corelib", …)` throughout `ts-markets`/`ts-cloud`). That verifies units in isolation but
never exercises the real composition.

**Goal:** an *exhaustive* integration tier that exercises the **real, unmocked composition** across three
seams — cross-package wiring, external services, and the Rust FFI bridge — controlling only the outermost
edges (network, time, randomness). "Exhaustive" is made **measurable** via an explicit per-seam coverage
checklist plus a validator that fails when a declared seam lacks a fixture.

## 2. Non-Goals (out of scope for v1)

- **Cross-runtime parity** (Bun/Deno) — explicitly excluded.
- **Artifact/`dist` black-box smoke layer** — deferred (see §12, `ROADMAP.md`).
- **Deterministic Rust-native streaming** (Alpaca/Yahoo FFI sockets) — covered in the live tier only for
  v1; the loopback harness is deferred (§12).
- **Replacing or modifying the existing unit tests.**

## 3. Locked Decisions

| Decision | Choice |
|---|---|
| Seams | cross-package · external (REST, recorded contracts + opt-in live) · Rust FFI |
| Organization | separate tier, per-package trees, own command, new CI stage |
| Foundation | white-box against **TypeScript source** via workspace `paths` aliases; no internal `vi.mock` |
| Fork F1 (one tree vs per-package) | **per-package** (runtime isolation; agy + Claude agree) |
| Fork F2 (commit fixtures vs out-of-band) | **commit, scrubbed, + nightly live** (agy + Claude agree) |
| Streaming seam | **live-tier only** for v1; loopback deferred (Claude rec, user-approved) |

## 4. Architecture

### 4.1 Per-package topology, runtime-matched

A single root Vitest config cannot span the three runtimes the packages require (Node-with-native-addon
vs. the `@cloudflare/vitest-pool-workers` `workerd` sandbox vs. happy-dom). Therefore each package owns
its integration config, matched to its runtime:

| Package | Config | Environment | Integration scope |
|---|---|---|---|
| `ts-core` | `ts-core/vitest.integration.config.ts` | raw **node** | FFI-scalar boundary; HTTP (`RequestUnlimited`); database (real SQLite); config; cron |
| `ts-markets` | `ts-markets/vitest.integration.config.ts` | **node** (not happy-dom, to load FFI) | cross-package → `ts-core`; external REST feeds |
| `ts-cloud` (node project) | `ts-cloud/vitest.integration.config.ts` | **node** | Hono router + DB composition via `app.request` + real SQLite; cross-package → `ts-markets`+`ts-core` |
| `ts-cloud` (worker project) | `ts-cloud/vitest.integration.worker.config.ts` | `workers-pool` | edge/proxy behavior only (no filesystem DB; FFI is `null` on Cloudflare) |

> **Note (ts-markets env):** integration tests that touch the FFI or Node-only APIs must run under
> `node`, not the unit suite's happy-dom. Browser-DOM-dependent paths, if any, stay in the unit suite.

### 4.2 Root driver

Root `package.json` scripts (added alongside the existing `*-all`):

- `test:integration` — `pnpm -r test:integration` (replay mode; each package runs its integration config).
- `test:integration:record` — sets `INTEGRATION_RECORD=1`.
- `test:integration:live` — sets `INTEGRATION_LIVE=1`.

Each package gets a `test:integration` script pointing at its integration config(s). `ts-cloud` runs both
its node and worker projects.

### 4.3 Shared harness

A shared, dependency-light harness lives at repo root `tests/integration/_harness/` and is imported by
each package's integration setup (resolved via a workspace path alias, e.g. `@itest/harness`). It must not
pull package-specific runtime assumptions; the worker project imports only the REST-replay pieces.

## 5. Seam Coverage

### 5.1 cross-package (real wiring, no internal mocks)

Exercise the genuine consumer→provider bindings:

- `ts-markets → ts-core`: `logger` child loggers, `ConfigManager`, `endPoint`/`endPoints`
  (`RequestUnlimited`), `getMode`, `getTempDir`, `coreFFI`.
- `ts-cloud → ts-markets + ts-core`: `createDatabase`/`SqlCloud` (real SQLite in the **node** project),
  `Historical`, `MarketStatus`, `getSymbolsTop100`, `getNasdaqHeaders`, `endPoint`, `logger`.

Real temp directories via `getTempDir`; real in-memory/temp-file SQLite via `createDatabase`. Database
composition for `ts-cloud` is tested through the Hono router (`app.request`) in the node project, **not**
the worker sandbox (no filesystem there).

### 5.2 external (REST/ky via MSW replay)

End-to-end through `RequestUnlimited.endPoint`/`endPoints` (ky) and `RequestProxied`, plus `ts-cloud`'s
transparent-proxy contract (`RequestUnlimitedCloud`, `*Cloud` market endpoints). Providers: **Nasdaq**
(`ApiNasdaqUnlimited`, `ApiNasdaqQuotes`, `MarketStatus`, `MarketSymbols`, `AssetClass`,
`groups/Top100`), **Yahoo historical** (`Historical`/`YahooHistoricalProvider`), **CNN Fear & Greed**
(`CnnFearAndGreed`), **Alpaca REST**. MSW intercepts ky at the JS network layer; all responses come from
recorded fixtures in replay mode.

### 5.3 ffi-scalar (real native boundary)

Through the real `corelib-rust.node`: `isFfiAvailable()`, `getVersion()` (asserts it matches the crate
version, not the JS fallback), `logAndDouble()` (asserts the Rust-computed result), and `Core`. Guarded
by `describe.skipIf(!isFfiAvailable())` — but a skip prints a **loud yellow diagnostic** naming the
missing platform/binary so coverage holes are never silent.

### 5.4 streaming (live-tier only, v1)

`AlpacaStreaming`/`YahooStreaming` drive their sockets through `coreFFI.AlpacaStreaming` /
`coreFFI.YahooStreaming` (Rust `tokio-tungstenite`). MSW (JS-layer) **cannot** intercept native sockets,
so these are excluded from the deterministic replay tier and covered only under `INTEGRATION_LIVE=1`
with loose shape assertions and a hard per-socket timeout (§7). The deterministic loopback harness is
deferred (§12).

## 6. Contract Record/Replay Harness

One test body runs three ways, selected by env var:

| Mode | Env | Behavior |
|---|---|---|
| Replay (default, CI) | — | MSW serves only from committed fixtures; an unmatched request **fails** the test (no silent real calls). |
| Record | `INTEGRATION_RECORD=1` | Unmatched requests pass through to the real API; the response is **scrubbed** then written to its fixture. |
| Live | `INTEGRATION_LIVE=1` | MSW disabled; tests hit real APIs with loose shape/status assertions (drift safety-net; nightly/manual). |

### 6.1 Secret scrubbing (mandatory, blocks fixture writes)

Before **any** fixture is serialized in record mode, the harness runs a sanitization pass replacing the
values of sensitive headers/fields with `<REDACTED>`. Minimum denylist (case-insensitive):
`authorization`, `cookie`, `set-cookie`, `apca-api-key-id`, `apca-api-secret-key`, `x-api-key`,
`x-amz-security-token`, and any header matching `/key|secret|token|auth|session/i`. Query-string secrets
(e.g. `?apikey=`) are redacted likewise. A fixture that still contains an unredacted denylisted value
fails the validator (§8).

### 6.2 Fixture format & location

Committed under `tests/integration/_contracts/<service>/<name>.json`:

```jsonc
{ "request": { "method": "GET", "url": "https://api.nasdaq.com/...", "headers": { /* scrubbed */ } },
  "response": { "status": 200, "headers": { /* scrubbed */ }, "body": { /* … */ } },
  "recordedAt": "2026-06-12T..." }
```

Fixtures are deterministic, offline, and reviewed in PRs.

## 7. Determinism Rules

- Every streaming/socket test (live tier) sets a hard timeout (≤ `1000ms` connect, bounded total) and
  closes the socket in teardown — no open handles leaking into CI.
- Time/cron tests (`croner`, Rust `cron`) use fake timers / manual tick injection — never wait on the
  wall clock. Where a module reads the clock, the integration test injects a fixed instant.
- No test depends on market open/close state; market-phase logic is driven by fixture/clock injection.

## 8. Coverage Matrix & Validator

"Exhaustive" is defined by an explicit, committed checklist (`tests/integration/coverage.matrix.ts`)
enumerating, per seam:

- **external:** each provider × { success, 404, 500, timeout→retry, malformed-body }.
- **cross-package:** each real consumer→provider binding listed in §5.1.
- **ffi-scalar:** each exported native function + the availability-fallback path.

A `coverage-validator` script (run in CI and via `test:integration` setup) asserts:
1. every external matrix cell has a corresponding `_contracts/**` fixture;
2. every fixture passes the secret-scrub check;
3. no orphan fixtures (fixture without a matrix entry).
Failure is a hard error → exhaustiveness is statically measurable, not a vibe.

## 9. Directory Layout

```
tests/integration/
  _harness/                msw server, record/replay, scrubber, temp-dir + db helpers, ffi guard
  _contracts/<service>/    committed, scrubbed fixtures
  coverage.matrix.ts       declared seams/cases
  coverage-validator.ts    enforces matrix ↔ fixtures ↔ scrub
ts-core/
  vitest.integration.config.ts
  tests/integration/*.integration.test.ts          (ffi-scalar, http, db, config, cron)
ts-markets/
  vitest.integration.config.ts
  tests/integration/*.integration.test.ts          (cross-package, external REST)
ts-cloud/
  vitest.integration.config.ts                     (node project: router+DB)
  vitest.integration.worker.config.ts              (workers-pool: edge/proxy)
  tests/integration/*.integration.test.ts
```

(Harness path alias `@itest/*` added to `tsconfig.base.json` `paths` and each integration config's
`resolve.alias`.)

## 10. CI Wiring

A new `integration` job in `pipeline.yml`, after `build`, on the Ubuntu/macOS/Windows matrix, running
`pnpm test:integration` (replay) + `coverage-validator`. The FFI-scalar tests run where the prebuilt
`.node` exists; elsewhere they skip with the loud diagnostic (recorded as a CI annotation). The **live**
tier is a separate nightly/manual workflow (`INTEGRATION_LIVE=1`) that, on drift, opens a PR refreshing
fixtures. The local `pre-push` `verify:full` gate stays unit-only (integration is CI-only) to keep the
push gate fast.

## 11. Error Handling & Conventions

- All harness logging uses a `ts-core` child logger (`logger.child({ section: "itest:<area>" })`) per
  AGENTS.md §1/§6; errors serialized via `serializeError`.
- Tests assert on serialized error shapes from `RequestUnlimited` (consistent error serialization is a
  core contract, AGENTS.md §1).
- Transparent-proxy assertions follow AGENTS.md §1: single-URL → body+status passthrough; bulk → array
  of `RequestResult`.

## 12. Risks & Deferred

| Item | Status | Trigger to revive |
|---|---|---|
| Source-alias tests miss bundling/ESM-CJS/`exports`-map bugs (agy 🟡) | **Deferred** — dist/`.tgz` smoke layer in `ROADMAP.md` | a packaging bug escapes to a consumer |
| Deterministic Rust-streaming coverage | **Deferred** — loopback harness in `ROADMAP.md`; live-tier covers it meanwhile | CI needs deterministic streaming; verify Rust streamer accepts endpoint override first |
| Fixture rot / provider drift | **Mitigated** — nightly live tier + validator | — |
| Secret leakage into committed fixtures | **Mitigated** — mandatory scrubber + validator gate | — |
| Worker-sandbox filesystem/FFI limits | **Mitigated** — DB/FFI tested in node project; worker project = edge/proxy only | — |

## 13. agy Review Provenance

Brainstorm-phase divergent pass (2026-06-12) raised three 🔴 blockers — single-root runtime conflict,
MSW-cannot-intercept-FFI-sockets, worker-sandbox DB limits — all verified true and resolved above; two
🟡 (secret leakage, source-vs-dist) folded/deferred; creative ideas adopted (coverage validator, loud
FFI diagnostic). Forks F1/F2 resolved with agy. Full record in `ANTIGRAVITY-TO-CLAUDE.md`. The
Spec-phase divergent pass (gap/ambiguity pressure-test) runs against this document before the
implementation plan.
