# Antigravity → Claude — Review & Design Record

This is the **durable, committed** record of Antigravity's review and design-partner findings for the
corelib monorepo. Antigravity writes one dated section per handoff here (and **never edits source**).
The bridge (`delegate_to_antigravity`) merges sections back on this tracked file; the manual relay
appends to it directly. See `AGENTS.md` → "Working with Antigravity (agy)".

<!-- New sections are appended below, newest last. Format: "## YYYY-MM-DD — <topic>". -->

## 2026-06-12 — Integration-test tier (divergent design pass)

### 1. Critical Review

This review analyzes the exhaustive integration test tier proposed for the corelib monorepo. Severity is calibrated to a pre-implementation design phase, where a **Blocker** indicates an architectural flaw that would force a costly rewrite if coded as-is.

#### 🔴 Blocker — Environment and Runtime Conflict in a Single Global Config
*   **Design Area**: Single root config [vitest.integration.config.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e0edda05/vitest.integration.config.ts)
*   **Verification**: [VERIFIED]
*   **Issue**: Running all integration tests under a single root config is architecturally incompatible.
    *   `ts-core` and its FFI tests require a standard **Node.js** environment to dynamically load native binaries (`corelib-rust.node`) using `createRequire` ([ts-core/src/core/index.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e0edda05/ts-core/src/core/index.ts#L8-L42)).
    *   `ts-cloud` tests must run in the specialized Cloudflare Worker pool ([@cloudflare/vitest-pool-workers](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e0edda05/ts-cloud/vitest.config.ts#L5-L7)) which boots a specialized `workerd` V8 isolate sandbox. Under this sandbox, raw Node-native Dynamic loading of `.node` addons is completely unsupported.
    *   `ts-markets` environment defaults to `happy-dom` ([ts-markets/vitest.config.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e0edda05/ts-markets/vitest.config.ts#L5)).
    *   Combining these into a single execution config would either crash the FFI initialization, mock out necessary worker globals, or force a compromise where tests run outside their true target runtime.
*   **Concrete Fix**: Adopt **F1: PER-PACKAGE tests/integration/ trees**. Configure a localized integration config in each package (e.g., `ts-cloud/vitest.integration.config.ts` extending the local wrangler-pool configuration; `ts-core/vitest.integration.config.ts` running in raw Node). These can still be cleanly executed from the repository root via monorepo filtering (e.g., `pnpm --filter "./ts-*" test:integration`).

#### 🔴 Blocker — MSW Cannot Intercept FFI / Native Network Traffic
*   **Design Area**: MSW record/replay harness ([tests/integration/_harness/](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e0edda05/tests/integration/_harness/))
*   **Verification**: [VERIFIED]
*   **Issue**: The design relies on MSW's `setupServer` to record and replay external interactions for FFI-based components (like `AlpacaStreaming` utilizing `coreFFI` native streams). MSW intercepts HTTP and WebSockets at the Node.js V8 JS layer (by monkeypatching global hooks such as `fetch` and `http.ClientRequest`). However, the Rust FFI binary compiles to raw assembly and drives its own network system calls via native crates (e.g., socket APIs, TCP client implementations). These native calls block and transmit completely outside the JS runtime's network hooks, bypassing MSW entirely. Recording or replaying FFI streams via MSW will result in silent misses and real-world connection attempts, rendering the integration tier non-deterministic.
*   **Concrete Fix**: During integration testing, run a custom **local mock loopback server** in JavaScript (Node lifecycle-bound, e.g., using `ws` and a minimal HTTP listener). Configure the FFI initialization payload ([AlpacaStreaming.ts:L58-L60](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e0edda05/ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts#L58-L60)) with a custom target boundary (e.g., `baseUrl: "http://localhost:<freePort>"`) to force the native Rust runtime to hook into our local loopback server, which serves mock frames from our recorded fixtures.

#### 🔴 Blocker — Cloudflare Workers Local Database and File Sandbox Incompatibility
*   **Design Area**: SQLite tests with `createDatabase` against real SQLite files in temp directories
*   **Verification**: [VERIFIED]
*   **Issue**: The design plans to test database routers under `ts-cloud` against real local SQLite databases inside the `getTempDir` environment. However, when run under the `@cloudflare/vitest-pool-workers` environment, the V8 sandboxed worker does not allow arbitrary filesystem writes. Traditional SQLite file drivers ([@libsql/client](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e0edda05/ts-core/src/database/sqlite/sqlite-driver.ts#L37-L38)) using standard filesystem paths (like `file:local.db`) will fail or crash immediately upon initialization inside Cloudflare's runtime due to sandboxed import limits and the absence of native filesystem access.
*   **Concrete Fix**: Shift SqlCloud/database integration coverage into Node-compatible test projects. Because Hono routers are platform-agnostic, you can safely test the endpoint's database composition inside standard Node (using `app.request` inside a Node vitest thread) where write-access to real SQLite databases is clean. Limit the edge-worker test boundaries to remote network proxies, or stub DB interactions with in-memory SQLite mocks mimicking Cloudflare D1.

#### 🟡 Should-Fix — Secrets Leakage in Recorded Fixtures
*   **Design Area**: Record fixtures under `_contracts/`
*   **Verification**: [VERIFIED]
*   **Issue**: Running `INTEGRATION_RECORD=1` against production endpoints like Alpaca, Nasdaq, or Yahoo will serialise raw request/response objects directly into committed JSON files. This will immediately leak highly sensitive API keys (e.g., Alpaca `APCA-API-KEY-ID`, `APCA-API-SECRET-KEY`), session credentials, authorization headers, and cookie headers.
*   **Concrete Fix**: The record/replay handler in `_harness/` must run a strict sanitization pass on the captured contract responses before they are serialized to disk. Create an array of sensitive header names and replace their matching values with `<REDACTED>` placeholder strings.

#### 🟡 Should-Fix — "White-Box Against Source" Bypasses Real Bundling Issues
*   **Design Area**: Source routing via `tsconfig` path aliases
*   **Verification**: [THEORETICAL]
*   **Issue**: While mapping `@ckir/*` directly to TypeScript source files is convenient and fast, it completely bypasses the compilation boundaries. If there are ESM/CJS interop issues, invalid `.js` import extensions, bundling bugs inside `tsup.config`, or missing peer dependencies, the integration tests will pass on source files but crash when the distributed package is actually loaded by a consumer.
*   **Concrete Fix**: The integration tests should run directly against the built `.tgz` packages or local workspace distributions in `dist/`, rather than using tsconfig source paths. Enforce that integration tests are preceded by a complete `build-all` operation.

#### 🟢 Nit — Non-Determinism in Streaming (WS) and Time/Cron Tests
*   **Design Area**: High-frequency streaming feeds and timers
*   **Verification**: [THEORETICAL]
*   **Issue**: Websocket streaming tests can easily hang or timeout in CI if network connectivity drifts or connections are left open. Cron tests that rely on real-time ticking make the test suite slow and brittle.
*   **Concrete Fix**: Expose a hard, tight timeout (e.g., `1000ms`) on every streaming websocket test. For Cron tasks, parameterize or subclass the time provider to allow fake timer injection or manual tick-execution instead of letting integration tests block waiting for physical clocks.

---

### 2. Creative Improvements

*   **A Unified Node.js Mock Loopback Server**: Instead of maintaining separate REST MSW listeners and custom socket stubs, implement a simple Node loopback server (using standard Node `net` and `http` APIs) that can boot dynamically on a free port. Both REST requests (`ky`) and FFI Websocket clients can point to this loopback using custom environment variables (e.g. `NASDAQ_API_URL=http://localhost:<port>`). This solves the FFI MSW interception issue, maintains zero-dependencies inside Cloudflare sandboxes, and unifies mocking under a single, highly performant contract-replay engine.
*   **Statical Permutation Validator**: To ensure your integration suite is truly "exhaustive" without becoming brittle, write a small structural schema validator script. This script compares our committed contracts matrix (success, 500, retry, 404) against a master JSON schema file of expected seams. If any API endpoint or FFI method lacks a corresponding record fixture in git, the validation script warns or fails, making exhaustiveness statically measurable.
*   **FFI Platform Graceful Degradation in Local Dev**: In local development, developers on unsupported configurations or without built binaries might face failure. The test runner should use `isFfiAvailable()` to skip native tests, but print a clear yellow diagnostic listing the missing platforms to prevent silent test skips that hide critical regressions.

---

### 3. Open Forks Analysis & Recommendations

#### F1: ONE root tests/integration/ tree vs PER-PACKAGE tests/integration/ trees
*   **Recommendation**: **PER-PACKAGE tests/integration/ trees** (e.g., `ts-core/tests/integration/`, `ts-cloud/tests/integration/`, etc.) but driven from a unified root command.
*   **Reasoning**: A single global tree forces a "lowest common denominator" configuration. It pollutes `tsconfig` configurations, causes type-pollution errors, and crashes due to runtime isolation conflicts (Sandboxed Workers vs raw FFI-compatible Node). Segmenting the design per-package keeps test configuration directly tied to each package's runtime environment (Wrangler vs Node), ensuring high safety and clean workspace resolutions.

#### F2: COMMIT recorded contract fixtures to the repo vs generate/cache them out-of-band
*   **Recommendation**: **COMMIT recorded contract fixtures to the repo** (incorporating strict pre-commit schema and secret checks).
*   **Reasoning**: Committing fixtures guarantees 100% offline-determinism, enabling immediate PR runs and eliminating complex external cache-provider dependencies in CI pipelines. However, this must be paired with an automated nightly workflow triggering `INTEGRATION_LIVE=1` to run the active live tier. This catches schema/domain drifts from original providers and updates the files, avoiding the problem of stale mocked pass patterns.

---

### 4. Highest Conviction Suggestion

**Implement a localized Loopback Mock Server bound to the Node integration lifecycle.**

By deploying a tiny, zero-dependency Node.js loopback broker during integration setup, we resolve MSW's inability to intercept compiled FFI Rust network calls, bypass filesystem boundaries in sandboxed environments, and enjoy a unified REST-and-Websocket contract-replay framework that holds dev-to-test parity across TypeScript and Rust.

---

## 2026-06-12 — Integration-test tier (spec-phase divergent pass)

### 1. Critical Review

This review performs a spec-phase pressure-test on the committed Integration Test Tier Design Spec, hunting for underspecified mechanics, gaps, ambiguity, and missing requirements that would derail the implementation plan or force mid-build rework.

#### 🔴 Blocker — Commander CLI Parsing Clashes with Vitest CLI Args
*   **Design Area**: [ConfigManager.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-4023a505/ts-core/src/configs/ConfigManager.ts#L160-L190), §4.2 Root driver, §4.3 Shared harness
*   **Verification**: [VERIFIED]
*   **Issue**: `ConfigManager.initialize()` uses commander to parse `process.argv` looking for `-C` or `--config` to load external on-demand configurations. However, Vitest executes tests with CLI arguments that include its own configuration paths, such as `--config vitest.integration.config.ts`. If an integration test or the shared harness calls `ConfigManager.initialize()` during setup, `ConfigManager` will intercept Vitest's typescript config path, treat it as a JSON config file path, attempt to fetch/parse it as JSON, and crash the process.
*   **Concrete Fix**: Modify `ConfigManager.initialize()` to accept an optional argument: `public async initialize(args?: string[]): Promise<void>` and use `args ?? process.argv.slice(2)` for commander parsing. The integration test setup/harness can then safely invoke `await ConfigManager.getInstance().initialize([])`, bypassing commander's search of `process.argv` and avoiding the CLI flag collision entirely.

#### 🟡 Should-Fix — TS Path-Alias Pollution Risk in Production Bundles
*   **Design Area**: [tsup.config.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-4023a505/ts-core/tsup.config.ts#L1-L25), [tsconfig.base.json](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-4023a505/tsconfig.base.json), §4.3 Shared Harness, §9 Directory Layout
*   **Verification**: [VERIFIED]
*   **Issue**: Adding `@itest/*` path mappings to `tsconfig.base.json` exposes them to all files inside `src/`. If a developer accidentally imports an integration helper (e.g. via IDE auto-complete) in production code, `tsup` will compile and build the test harness code directly into the production bundle at `dist/` (since `@itest` is not declared external in `tsup.config.ts`). This leads to severe bundle bloat, leaking test code, or build failures due to test-only Node imports like `msw` or `workerd` runtimes.
*   **Concrete Fix**: Remove `@itest/*` from `tsconfig.base.json` and package-level `tsconfig.json` files. Create a separate `tsconfig.integration.json` extending the base config, which includes `tests/integration/` and defines the `@itest/*` path mappings. In the vitest configs, map `@itest/*` directly inside `resolve.alias` to isolate it strictly to test execution.

#### 🟡 Should-Fix — State-Dependent and Sequential Mocking in Replay Mode
*   **Design Area**: [RequestUnlimited.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-4023a505/ts-core/src/retrieve/RequestUnlimited.ts#L41-L54), §6 Replay Contract Harness, §6.2 Fixture Format
*   **Verification**: [VERIFIED]
*   **Issue**: Resilient HTTP calls via `RequestUnlimited` utilize retry logic (up to 5 retries with backoff limits). Standard MSW intercepts requests with one-to-one static mapping. If a test verifies "timeout -> retry -> success", a static fixture returned by URL/method will always return the same result (fail/success) for every retry attempt. Additionally, if an endpoint fails, the test will retry 5 times with backoffs up to 3000ms, stalling the Vitest thread.
*   **Concrete Fix**: (1) The mock record/replay player in `_harness/` must support stateful, sequential response queues (where requests to the same URL return the next response in an array of fixtures) to test retry flows. (2) Integration tests should configure a lower retry limit (e.g. `limit: 1`) via `ConfigManager` overrides during failure/timeout tests to prevent CI threads from stalling.

#### 🟡 Should-Fix — Credentials Leakage in Request & Response Bodies
*   **Design Area**: [AlpacaStreaming.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-4023a505/ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts#L58-L76), §6.1 Secret Scrubbing
*   **Verification**: [VERIFIED]
*   **Issue**: §6.1 specifies scrubbing headers and query parameter values. However, some providers (like Alpaca streaming/REST or other brokers) can transit API keys or tokens in request bodies (e.g. POST payload JSON) or response bodies. Storing these bodies verbatim under `_contracts/` will leak sensitive credentials directly into git.
*   **Concrete Fix**: Extend §6.1 to require scrubbing of request and response **bodies**. The record handler should deserialize stringified bodies, recursively redact keys matching the denylist patterns (e.g., `keyId`, `secretKey`, `token`), and serialize the scrubbed payload back.

#### 🟢 Nit — Version Invariant Divergence Safeguard
*   **Design Area**: §5.3 FFI Version Assertion, [lib.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-4023a505/rust/src/lib.rs#L52-L55)
*   **Verification**: [VERIFIED]
*   **Issue**: The spec requires that FFI-scalar tests assert `getVersion()` matches the "crate/package version" deterministically. While `Cargo.toml` and `ts-core/package.json` are currently matched at `0.1.17`, there is no automatic system ensuring they stay in sync, which could flag false positives on release runs.
*   **Concrete Fix**: Within the test assertion, load `ts-core/package.json` and compare `getVersion()` directly to that JSON's compiled `.version` string, asserting monorepo build synchronization explicitly.

#### 🟢 Nit — Ambiguity In Seam Matrix-To-Fixture Mapping
*   **Design Area**: §8 Coverage Matrix & Validator
*   **Verification**: [THEORETICAL]
*   **Issue**: How the `coverage.matrix.ts` maps matrix cells to file paths has no explicit schema, making it potentially ambiguous for `coverage-validator.ts`.
*   **Concrete Fix**: Define `SeamCell` interface in `tests/integration/coverage.matrix.ts` with explicit `fixturePath` pointing to `_contracts/**/*.json`, allowing static analysis to confidently map and orphan-scan.

---

### 2. Creative Improvements

*   **Dry-Run Verification of Contract Redaction**: In `INTEGRATION_RECORD` mode, the recorder should perform a dry-run comparison. It logs a unified diff of the raw vs scrubbed response object directly to the developer console. This gives the developer instant visual feedback on what secrets were identified and redacted before committing any contract fixtures.
*   **Test-Suite Temp Directory and Database Context Isolation**: Since Vitest executes tests in parallel, shared resource files can lead to read/write collisions on SQLite databases. The shared harness `_harness/` should expose helpers:
    1. `getTestTempDir()`: retrieves a randomized isolated temp directory;
    2. `createTestDatabase()`: spawns isolated sqlite instances;
    3. Global teardown registering cleanup hooks to recursively prune temp directories and close db connections, maintaining flawless open-handle hygiene.

---

### 3. Final Recommendation

**[Verified Clean] with Blocker and Should-Fix adjustments.** The specification is exceptionally cohesive, well-researched, and highly implementable. 

Our single highest-conviction suggestion is to **augment the ConfigManager API to accept explicit arguments** to prevent CLI option clashes under Vitest, and to **strictify the secret scrubber to intercept JSON bodies**.


