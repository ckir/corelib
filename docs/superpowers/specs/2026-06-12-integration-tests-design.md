# Integration Test Tier — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved; agy divergent passes complete (brainstorm + spec). Refreshed 2026-06-13 for the
  final provider set (§5.4 = all three dual-mode streamers), then a third agy **refreshed-spec review**
  (verdict **PLAN-READY**) folded in: streaming execution guard, live credentials, structural `market`
  shape check, anti-flake symbols, and the `live-streaming` coverage-matrix seam. **PLAN-READY.**
- **Subproject:** Exhaustive integration tests for the corelib monorepo.
- **Review record:** `ANTIGRAVITY-TO-CLAUDE.md` → "2026-06-12 — Integration-test tier (divergent design pass)".

## 1. Context & Goal

corelib is a pnpm-workspace monorepo: `ts-core` (base: FFI, logging, resilient HTTP, config, database)
is consumed by `ts-markets` (Nasdaq/Yahoo/Alpaca/Finnhub data feeds) and `ts-cloud` (Cloudflare Workers / edge),
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
- **Deterministic Rust-native streaming** (Alpaca/Finnhub/Yahoo FFI sockets) — covered in the live tier
  only for v1; the loopback harness is deferred (§12).
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
each package's integration setup via an `@itest/*` alias. It must not pull package-specific runtime
assumptions; the worker project imports only the REST-replay pieces.

**Alias isolation (do NOT add `@itest/*` to `tsconfig.base.json`).** Putting the alias in the base config
exposes it to every `src/` file, and since `@itest` is not marked external in `tsup.config.ts`, an
accidental import would compile test-only code (and `msw`/`workerd` deps) into `dist/`. Instead: define
`@itest/*` in a dedicated `tsconfig.integration.json` (extends base, `include: ["tests/integration"]`) and
in each package's `vitest.integration.config.ts` `resolve.alias`. Production `tsconfig`/`tsup` never see
the alias. *(agy spec-pass 🟡.)*

### 4.4 Prerequisite source change — `ConfigManager.initialize(args?)`

`ConfigManager.initialize()` (`ts-core/src/configs/ConfigManager.ts:160`) reads `process.argv.slice(2)`
(`:165`) and parses it with commander, binding `-C, --config <path>` (`:169`). Under Vitest, the runner's
own `--config vitest.integration.config.ts` is hijacked — ConfigManager treats the `.ts` path as a config
file and crashes. Any cross-package test exercising real `ConfigManager` hits this.

**Required (blocker) change:** widen the signature to `initialize(args?: string[])` using
`args ?? process.argv.slice(2)`; the harness calls `initialize([])` to bypass commander's argv scan.
Backward-compatible (optional param). This is a prerequisite implementation task, sequenced before the
cross-package suite. *(agy spec-pass 🔴 [VERIFIED].)*

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

Through the real `corelib-rust.node`: `isFfiAvailable()`, `getVersion()` — asserted **equal to
`ts-core/package.json`'s `version`** (loaded at test time), which doubles as a monorepo crate↔package
sync check (both are `0.1.17` today; the assert catches drift on release runs) — `logAndDouble()`
(asserts the Rust-computed result, not the JS fallback throw), and `Core`. Guarded
by `describe.skipIf(!isFfiAvailable())` — but a skip prints a **loud yellow diagnostic** naming the
missing platform/binary so coverage holes are never silent.

### 5.4 streaming (live-tier only, v1)

All three providers — `AlpacaStreaming`, `FinnhubStreaming`, `YahooStreaming` — drive their sockets
through `coreFFI.*Streaming` (the shared Rust `WebsocketStreamerHost` + `tokio-tungstenite` engine).
Each is **dual-mode** (Phase 2a/2b): it emits the byte-identical raw payload (`pricing` event) AND the
unified finstream-superset `MarketEvent` JSON (`market` event), plus lifecycle status events
(`connected` / `disconnected` / `reconnecting` / `error`). MSW (JS-layer) **cannot** intercept native
sockets, so all three are excluded from the deterministic replay tier.

**Execution guard (mandatory).** Every streaming suite is wrapped in
`describe.skipIf(!process.env.INTEGRATION_LIVE)` so it NEVER opens a native socket during the default
offline replay run (which would hang/crash the FFI). They run only under `INTEGRATION_LIVE=1`. *(agy
refreshed-spec pass 🟡.)*

**Live credentials.** Alpaca requires `APCA_API_KEY_ID` + `APCA_API_SECRET_KEY`; Finnhub requires
`FINNHUB_API_KEY`; Yahoo is tokenless. A streaming live test whose required credentials are absent skips
with the same loud diagnostic as §5.3 — never a silent pass. *(agy refreshed-spec pass 🟡.)*

**Assertions (loose, drift safety-net).** Each test sets a hard per-socket timeout (§7) and asserts, at
minimum, that a `connected` status event fires within the connect timeout (the hard gate). When a data
frame arrives, the `pricing` payload and the parsed `market` object are shape-checked: `market` must
carry the unified core fields (`type` ∈ {`trade`,`quote`}, `ticker`, `timestamp`, `price`) plus the
provider-keyed extras object (`alpaca` / `finnhub` / `yahoo`). Full generated-schema validation of the
unified event is out of scope for v1. *(agy refreshed-spec pass 🟡, scoped to a structural check.)*

**Symbol choice (anti-flake).** Use ultra-liquid symbols so a frame arrives inside the short window:
equities `AAPL` / `MSFT` for Alpaca/Finnhub (U.S. hours) and a 24/7 instrument (`BTC-USD` via Yahoo) so
at least one streamer produces frames off-hours. Per §7 no test asserts market open/close state — the
data-frame shape check is best-effort/timeout-bounded; the `connected` assertion is the hard gate.
*(agy refreshed-spec pass 🟡.)*

The deterministic loopback harness is deferred (§12).

## 6. Contract Record/Replay Harness

One test body runs three ways, selected by env var:

| Mode | Env | Behavior |
|---|---|---|
| Replay (default, CI) | — | MSW serves only from committed fixtures; an unmatched request **fails** the test (no silent real calls). |
| Record | `INTEGRATION_RECORD=1` | Unmatched requests pass through to the real API; the response is **scrubbed** then written to its fixture. |
| Live | `INTEGRATION_LIVE=1` | MSW disabled; tests hit real APIs with loose shape/status assertions (drift safety-net; nightly/manual). |

### 6.1 Retries & sequential responses

`RequestUnlimited` retries (up to 5, backoff to ~3000ms), so the harness cannot use naive one-to-one
URL→fixture mapping for failure paths. Two requirements:
- **Sequential response queues.** A fixture may be an *ordered array* of responses for a URL+method;
  the replay player returns the next entry per request, so a `timeout → retry → 200` path is expressible
  (`[504, 504, 200]`). Single-object fixtures remain shorthand for "same response every time".
- **Bounded retries in failure tests.** Failure/timeout tests override the retry limit to a small value
  (e.g. `limit: 1`) via `ConfigManager`/`DEFAULT_REQUEST_OPTIONS` injection so a CI thread never stalls
  on full backoff. Success-path tests keep production retry settings. *(agy spec-pass 🟡.)*

### 6.2 Secret scrubbing (mandatory, blocks fixture writes)

Before **any** fixture is serialized in record mode, the harness runs a sanitization pass replacing the
values of sensitive headers/fields with `<REDACTED>`. Minimum denylist (case-insensitive):
`authorization`, `cookie`, `set-cookie`, `apca-api-key-id`, `apca-api-secret-key`, `x-api-key`,
`x-amz-security-token`, and any header matching `/key|secret|token|auth|session/i`. Query-string secrets
(e.g. `?apikey=`) are redacted likewise.

**Bodies too (not just headers).** Some providers carry credentials in request/response **bodies**
(e.g. Alpaca `keyId`/`secretKey` in JSON payloads). The scrubber deserializes string bodies and
**recursively** redacts any object key matching `/key|secret|token|auth|session|password/i` (and the
explicit `keyId`/`secretKey`/`apiKey` names), then re-serializes. *(agy spec-pass 🟡.)*

**Record-mode dry-run diff.** In `INTEGRATION_RECORD=1`, before writing, the recorder prints a unified
diff of raw → scrubbed to the console so the developer sees exactly what was redacted before committing.
*(agy creative.)* A fixture that still contains an unredacted denylisted value (header, query, or body)
fails the validator (§8).

### 6.3 Fixture format & location

Committed under `tests/integration/_contracts/<service>/<name>.json`:

```jsonc
{ "request": { "method": "GET", "url": "https://api.nasdaq.com/...", "headers": { /* scrubbed */ } },
  "response": { "status": 200, "headers": { /* scrubbed */ }, "body": { /* … */ } },
  "recordedAt": "2026-06-12T..." }
```

Fixtures are deterministic, offline, and reviewed in PRs.

## 7. Determinism & Isolation

- Every streaming/socket test (live tier) sets a hard timeout (≤ `1000ms` connect, bounded total) and
  closes the socket in teardown — no open handles leaking into CI.
- Time/cron tests (`croner`, Rust `cron`) use fake timers / manual tick injection — never wait on the
  wall clock. Where a module reads the clock, the integration test injects a fixed instant.
- No test depends on market open/close state; market-phase logic is driven by fixture/clock injection.
- **Parallel isolation (Vitest runs files in parallel).** The harness exposes `getTestTempDir()` (a
  randomized, per-test temp dir) and `createTestDatabase()` (an isolated SQLite instance — `:memory:` or
  a unique temp file) so concurrent tests never collide on a shared dir or DB file. A global teardown
  registers cleanup hooks that recursively prune temp dirs and close DB connections. *(agy creative.)*

## 8. Coverage Matrix & Validator

"Exhaustive" is defined by an explicit, committed checklist (`tests/integration/coverage.matrix.ts`)
enumerating, per seam:

- **external:** each provider × { success, 404, 500, timeout→retry, malformed-body }.
- **cross-package:** each real consumer→provider binding listed in §5.1.
- **ffi-scalar:** each exported native function + the availability-fallback path.
- **live-streaming:** each of the three streamers (`alpaca` / `finnhub` / `yahoo`) — `testFilePath`
  required, `fixturePath` omitted (no offline fixture; the live suite is the coverage record). This keeps
  the streaming seam *visible* to the validator even though it has no replay fixture. *(agy refreshed-spec
  pass 🟡.)*

Each entry is a typed `SeamCell` so the mapping is unambiguous for static analysis:

```ts
interface SeamCell {
  seam: "external" | "cross-package" | "ffi-scalar" | "live-streaming";
  id: string;                 // e.g. "nasdaq.marketStatus.500" or "stream.alpaca"
  fixturePath?: string;       // required for "external"; relative to _contracts/ (omit for non-HTTP seams)
  testFilePath?: string;      // required for "live-streaming": the live suite covering this streamer
}
```

A `coverage-validator` script (run in CI and via `test:integration` setup) asserts:
1. every external matrix cell has a corresponding `_contracts/**` fixture;
2. every fixture passes the secret-scrub check;
3. no orphan fixtures (fixture without a matrix entry);
4. every `live-streaming` cell has an existing `testFilePath` (the live suite is present even though it
   has no fixture).
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

Plus a root `tsconfig.integration.json` (extends base, includes `tests/integration/`, defines the
`@itest/*` paths) — **not** in `tsconfig.base.json` (see §4.3). Each integration config also sets the
`@itest/*` `resolve.alias`.

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
| Deterministic Rust-streaming coverage | **Deferred** — loopback harness in `ROADMAP.md`; live-tier covers it meanwhile | CI needs deterministic streaming; verify all three native streaming drivers accept a socket endpoint override first |
| Fixture rot / provider drift | **Mitigated** — nightly live tier + validator | — |
| Secret leakage into committed fixtures | **Mitigated** — mandatory scrubber + validator gate | — |
| Worker-sandbox filesystem/FFI limits | **Mitigated** — DB/FFI tested in node project; worker project = edge/proxy only | — |

## 13. agy Review Provenance

**Brainstorm-phase pass** raised three 🔴 blockers — single-root runtime conflict,
MSW-cannot-intercept-FFI-sockets, worker-sandbox DB limits — all verified and resolved above; two 🟡
(secret leakage, source-vs-dist) folded/deferred; creative ideas adopted (coverage validator, loud FFI
diagnostic). Forks F1/F2 resolved with agy.

**Spec-phase pass** raised one 🔴 (ConfigManager commander/argv clash with Vitest → §4.4 prerequisite
change, independently verified) plus 🟡s folded above: `@itest` alias pollution (§4.3/§9), retry/sequential
fixtures (§6.1), body scrubbing + record dry-run (§6.2), version-vs-package.json assert (§5.3), `SeamCell`
mapping (§8), and parallel temp/DB isolation (§7). agy's verdict: "[Verified Clean] with adjustments —
exceptionally cohesive and highly implementable." Full record in `ANTIGRAVITY-TO-CLAUDE.md`.

**Refreshed-spec pass (2026-06-13)** over the §5.4 final-provider-set update: verdict **PLAN-READY**, no
blockers. Folded five 🟡s — streaming execution guard (`describe.skipIf(!INTEGRATION_LIVE)`, §5.4), live
credentials per provider (§5.4), structural `market`-event shape check (§5.4), anti-flake liquid symbols
(§5.4), and the `live-streaming` coverage-matrix seam + validator assertion #4 (§8) — and two 🟢 staleness
nits (§1 provider list, §12 wording). Two agy specifics were corrected against ground truth: status events
are `connected/disconnected/reconnecting/error` (no `silence-reconnect` on the shared host — that was a
stale wrapper comment), and the Finnhub env var is `FINNHUB_API_KEY` (not `FINNHUB_TOKEN`). Record in
`ANTIGRAVITY-TO-CLAUDE.md` → "(c) Integration-test tier — refreshed-spec review (2026-06-13)".
