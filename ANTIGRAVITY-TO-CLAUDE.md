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

---

## 2026-06-12 — Roadmap sequencing of 4 subprojects (divergent)

### 1. Critical Review of Candidate Roadmaps

#### 1.1 The User's Sequence: `a → b → c → d`
*   **Severe E2E Rework Risk (Undertesting & Rework Blockers)**: Writing integration/E2E tests (c) before porting the unified provider surface (d) is an anti-pattern. Porting providers from `finstream` introduces a unified TS/Rust schema and adds **Finnhub**. Writing MSW contract fixtures and testing streams over the *old* endpoints means a complete rewrite of the replay contracts in `tests/integration/_contracts/` immediately after (d) is completed.
*   **Swapping Safety Nets (Refactoring with No Test Coverage)**: Retro-instrumenting legacy modules (a) with trace/debug logging is a large, sweeping operation touching many files. Running this before establishing (c) means we have no integration safety net to guard against runtime typos, circular references in error serialization, or initialization crashes of child loggers.
*   **Premature Global Audit**: Conducting a deep code review (b) before (d) means the largest and most complex chunk of newly modified content (the multi-provider Rust WebSocket engine) entirely escapes global auditing.

#### 1.2 Claude's Recommendation Sequence: `a → d → c → b`
*   **Sound Progress**: Claude correctly identified the tension between (c) and (d), placing the provider porting (d) before E2E testing (c) to ensure tests cover the final, stable schemas and endpoints, preventing throwing away test code.
*   **The Unshielded Refactoring Flaw**: Claude's order still places the sweeping, legacy-wide trace retro-instrumentation (a) *first*. This is a high-risk refactoring phase done without an integration test tier. A single invalid child logger signature or bad parameter serialization in a core database/network path will bypass unit mocks and crash the production system.
*   **FFI Base Instability (Garbage In, Voyage Out)**: Porting finstream's highly asynchronous, multi-threaded WebSocket providers into `corelib-rust` (d) before verifying the core FFI napi/Rust execution engine via a baseline audit (b) introduces a massive risk of compounding memory leaks, resource exhaustion, or unhandled tokio runtime panics.

### 2. Creative Improvements & Split/Merge Analysis

*   **Split the Global Audit (b-1 & b-2)**: Rather than doing one massive audit, split it:
    *   **`(b-1) Baseline FFI Audit`**: A highly focused, surgical audit of the pre-existing FFI bridge, N-API rust boundaries, and the shared test harness setup. We clean up the foundation before building heavy real-time data ingestion models.
    *   **`(b-2) Capstone Global Audit`**: A complete, high-level product correctness and architectural review at the post-integration, post-trace final stage.
*   **Leverage the Standing Mandate (§12 "Debug & Trace Logging" of [AGENTS.md](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b63f1108/AGENTS.md#L190-L218))**: New code is self-instrumented "at birth". By porting providers (d) *before* doing retro-instrumentation (a), all ported providers are written directly with proper trace/debug logging, eliminating duplicated refactoring loops on those modules.
*   **Use Integration Tests (c) as the Logging Safety Net**: By implementing the integration/E2E tier (c) *before* legacy retro-instrumentation (a), we gain a repeatable contract-replay harness. Any subsequent sweeping logging modifications to `ts-core` can be verified in milliseconds, turning a manual, high-risk refactor into a safe, automated pass.

### 3. Final Recommendation: Proposed Roadmap Sequence

We recommend a specialized split-and-staged roadmap that maximizes safety and eliminates throwaway contract work:

```mermaid
graph TD
    B1["(b-1) Baseline FFI Audit<br>Sanitize Rust FFI & N-API foundation"] --> D["(d) Port Providers<br>Alpaca/Finnhub/Yahoo with unified schema"]
    D --> C["(c) Integration/E2E Tests<br>Zero-rework contracts over stable endpoints"]
    C --> A["(a) Trace Retro-instrumentation<br>Sweeping legacy logs, integration-verified"]
    A --> B2["(b-2) Capstone Global Audit<br>Final correctness, performance & edge cases"]
```

#### The Sequence: `b-1 → d → c → a → b-2`

1.  **`(b-1) Baseline FFI Audit`**: Sanitizes the underlying Rust N-API/FFI execution model and async runtime pool, ensuring a rock-solid, non-leaking native core before porting.
2.  **`(d) Port Providers`**: Ports Yahoo/Alpaca/Finnhub into the audited FFI, unified under a standard provider schema, self-instrumented at birth per §12.
3.  **`(c) Integration/E2E Tests`**: Implements the exhaustive integration suite over the finalized and stable provider endpoints, avoiding costly contract rework.
4.  **`(a) Trace Retro-instrumentation`**: Retro-instruments legacy modules with extensive logs, utilizing the newly built test suite (c) as a real-world runtime safety net.
5.  **`(b-2) Capstone Global Audit`**: Conducts the ultimate global architectural and edge-case correctness review over a complete, tested, and high-visibility monorepo.

---

## 2026-06-12 — (b-1) Baseline FFI/N-API audit

### 1. Critical Review

This section presents a baseline safety, lifecycle, and resource-teardown audit of the pre-existing FFI bridge, N-API rust boundaries, and async WebSocket streaming runtimes before porting the finstream providers (d).

#### 🔴 Blocker — Perpetual Background Task & Socket Leak on Javascript Garbage Collection
*   **Design Area**: `AlpacaStreamingCore::start()` ([alpaca_streamer.rs:L234-L237](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L234-L237)) & `YahooStreamingCore::start()` ([yahoo_streamer.rs:L231-L234](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs#L231-L234)).
*   **Verification**: [VERIFIED]
*   **Issue**: Long-running background supervisor loops are spawned using `tokio::spawn(Self::run_loop(Arc::clone(&inner), ...))`, capturing a strong owned `Arc` reference to the core streamer instance. When JavaScript drops/GCs the `AlpacaStreaming` or `YahooStreaming` instance without calling `.stop()`, the Rust struct is freed by V8 but the underlying struct destructor is never completed because its strong `Arc` count remains $\ge 1$ inside the Tokio pool. Sockets, pings, background timers, and the threadsafe-functions (TSFNs) survive and reconnect indefinitely, leaking heavy platform resources.
*   **Concrete Fix**: [Surgical] Implement the `Drop` trait for the public FFI structs (`AlpacaStreaming`/`YahooStreaming`) to explicitly trigger graceful teardown (`core.stop()`) on GC drop. Alternatively, move task state to a weak-reference pattern (`Arc::downgrade`) inside the supervisor loop, terminating the loop once the upgrading weak reference fails.

#### 🔴 Blocker — Sticky Exponential Backoff Locks Reconnect Loop at 1 Hour
*   **Design Area**: `alpaca_streamer.rs:L240-L284` ([alpaca_streamer.rs:L240-L284](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L240-L284)) & `yahoo_streamer.rs:L236-L269` ([yahoo_streamer.rs:L236-L269](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs#L236-L269)).
*   **Verification**: [VERIFIED]
*   **Issue**: Reconnection interval `backoff` is initialized at 5 seconds and doubles on every iteration, capped at 1 hour (3600 seconds). However, **the backoff duration state is never reset** once a connection is successfully established. If a stream has a long outage and reaches a high backoff value, the subsequent successful reconnection retains that backoff state. The very next minor disconnect will wait for the high sticky backoff time (up to 1 hour) before attempting to reconnect, breaking client stream self-healing.
*   **Concrete Fix**: [Surgical] Restructure `run_loop` to reset the `backoff` to its base value (e.g., 5 seconds) whenever the underlying `ws_loop` succeeds, authenticates, and receives its first data frames.

#### 🔴 Blocker — Synchronous Redb Multi-File Lock Prevents Concurrent Streams
*   **Design Area**: `AlpacaStreamingCore::new()` ([alpaca_streamer.rs:L147-L182](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L147-L182)) & `YahooStreamingCore::new()` ([yahoo_streamer.rs:L154-L192](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs#L154-L192)).
*   **Verification**: [VERIFIED]
*   **Issue**: Constructors for both Alpaca and Yahoo streams synchronously initialize a local database using `Database::create(&db_env)`. By default, they resolve to static global filenames (`corelib_streaming.redb` and `yahoo_streaming.redb`) under the system temp directory. Because `redb` enforces exclusive single-writer file locking on open, **creating a second instance of the same streaming provider (or initializing multiple concurrent feeds) will panic or freeze the entire process** during construction.
*   **Concrete Fix**: [Surgical] Randomized or uniqueify persistent db file names per instance (e.g. including instance UUID/PID) or provide a fallback to opt-out of local persistence database writes completely (such as passing `"NOT_SET"` to run fully in-memory).

#### 🟡 Should-Fix — Synchronous Disk I/O Blocking the JS Event Loop
*   **Design Area**: `AlpacaStreamingCore::new()` ([alpaca_streamer.rs:L159](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L159)) & `YahooStreamingCore::new()` ([yahoo_streamer.rs:L168](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs#L168)).
*   **Verification**: [VERIFIED]
*   **Issue**: Calling `Database::create` inside the synchronous constructor blocks V8's main thread with synchronous file creation and transactional I/O. Any disk delay directly lags the single-threaded JS event loop.
*   **Concrete Fix**: [Surgical] Shift database creation and pre-loaded subscription tasks out of the synchronous constructor and into the asynchronous `init()` method.

#### 🟡 Should-Fix — Stderr-Only Crash Propagation on Task Panics
*   **Design Area**: `AlpacaStreamingCore::run_loop` ([alpaca_streamer.rs:L235](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L235)).
*   **Verification**: [VERIFIED]
*   **Issue**: Unhandled panics in database operations (such as unwrap on corrupt tables, database write-lock contention, or file permission crashes) unwind inside Tokio, silently killing the supervisor loop. The Javascript wrapper is never notified and continues waiting on a dead stream.
*   **Concrete Fix**: [Surgical] Wrap the worker thread closure using `catch_unwind` or monitor the task's `JoinHandle` to propagate execution state crashes cleanly as JS errors or `on_event("error")` callbacks.

#### 🟡 Should-Fix — Plaintext Secrets Exposure via Primitive Debug Derives
*   **Design Area**: `AlpacaConfig` ([alpaca_streamer.rs:L35-L48](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L35-L48)).
*   **Verification**: [VERIFIED]
*   **Issue**: `AlpacaConfig` derives a basic `Debug` trait. Sensitive API tokens and credentials (`key_id`, `secret_key`) are fully readable. Normal logging statements (e.g. `log.debug!("{:?}", config)`) or assertions will write plaintext passwords directly into rotating log files.
*   **Concrete Fix**: [Surgical] Formally implement a custom `Debug` trait for `AlpacaConfig` that intercepts and masks private credential fields.

#### 🟢 Nit — Lack of Jitter on Reconnection Backoff
*   **Design Area**: `alpaca_streamer.rs:L279` ([alpaca_streamer.rs:L279](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L279)) & `yahoo_streamer.rs:L265` ([yahoo_streamer.rs:L265](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-b2b76043/rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs#L265)).
*   **Verification**: [VERIFIED]
*   **Issue**: Sleep times are strictly deterministic. In high-concurrency provider workloads (d), simultaneous disconnections will trigger synchronized attempts back onto the provider with no random variance, risking systematic rate limits or DDoS flags.
*   **Concrete Fix**: [Surgical] Introduce randomised millisecond jitter inside the reconnection sleep delay.

---

### 2. Creative Improvements

*   **Define a Unified `StreamingProvider` Lifecycle Trait**:
    To eliminate code duplication across the separate Alpaca and Yahoo streamers during subproject (d), introduce a shared `StreamingProvider` engine. By genericizing WebSocket connections, keep-alive ping loops, silence-reconnect timers, error handling states, and channel dispatches inside a standard Rust trait wrapper, developers can deploy any new provider (like Finnhub or others) cleanly by simply implementing parsing, authentication hooks, and endpoint definitions.
*   **Backpressure and Dynamic Flow Control**:
    High-frequency market feeds can choke V8 when dispatched using fully non-blocking TSFNs under market load. Establish queue limits or dynamic message grouping inside the FFI boundary. If the JS event processing loop falls behind, Rust can coalesce quote frames (retaining only the newest symbol price) to ensure memory consumption remains stable.

---

### 3. Highest Conviction Safety Suggestion

Our highest-conviction recommendation is to **implement custom Drop traits on the public napi wrappers and force a sticky-backoff reset parameter**. Ensuring clean task-aborting on GC prevent resource exhaustion under high instantiation, and resolving the backoff lock establishes self-healing connectivity.

---

## 2026-06-12 — (d) Provider port scope (divergent)

### 1. Critical Review of Candidate Scopes & S2 Lean

This review performs a rigorous design-level analysis of the three proposed scopes (S1, S2, S3) and pressure-tests Claude's S2 lean ("Adopt Trait + Schema") against `corelib`'s real-world constraints, FFI boundaries, and pre-existing hardening.

#### (a) Does S2's "retire the bespoke streamers" THROW AWAY the b-1 hardening?
*   **Verdict**: **Highly Dangerous Risk of Regression**. S2 runs a severe risk of silently discarding the critical reliability fixes recently committed in subproject (b-1):
    *   **Backoff Durations**: The backoff reset behavior [alpaca_streamer.rs:293-300](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L293-L300) distinguishes between a pure transport failure versus a successful connection that later drops. A native trait-based engine imported from `finstream` with its generic `ReconnectPolicy` must be explicitly verified to possess this distinguishing "reset-on-first-authenticated-frame" capability, or it will re-introduce sticky one-hour reconnect locks on subsequent minor interruptions.
    *   **Crash Propagation**: The supervisor panic-catching monitor [alpaca_streamer.rs:263-280](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L263-L280) hooks background panic states and converts them to clean N-API `on_event("error")` callbacks. Porting a unified mpsc scheduler must not skip this callback bridge; otherwise, background thread panics in the new dispatcher will leave JS silently hanging.
    *   **Credential Leak Prevention**: The manual `Debug` masking logic on configs [alpaca_streamer.rs:51-62](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L51-L62) must be ported to the trait configurations, avoiding standard derived debug decorators that expose plaintext keys in the rotating logs.
    *   **Portability Solution**: To avoid losing these fixes, the b-1 hardening details must be codified as an explicit "Engine Hardening Checklist" that the generic `ProviderDriver` trait execution harness is audited against.

#### (b) The FFI/JS Contract Break & Integration Compatibility
*   **Verdict**: **High Disruption & Spec Invalidation**. S2's plan to replace the per-provider FFI surface (e.g. `coreFFI.AlpacaStreaming`, `coreFFI.YahooStreaming`) with a unified native stream completely invalidates the current JS consumer layer and the integration test design:
    *   The newly approved integration spec [docs/2026-06-12-integration-tests-design.md:L50-L54](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/docs/superpowers/specs/2026-06-12-integration-tests-design.md#L50-L54) specifies that `ts-markets` integration tests consume the individual native classes in raw node runtimes. Section [5.4](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/docs/superpowers/specs/2026-06-12-integration-tests-design.md#L129-L135) directly names `coreFFI.AlpacaStreaming` and `coreFFI.YahooStreaming`.
    *   If the FFI layer is flattened into a single unified stream, `ts-markets` streaming setup must be entirely rewritten. The integration tests would need a brand-new mocking harness and a redesigned contract matrix before the original layout is even run, violating the "zero-rework" sequencing goal.

#### (c) redb Subscription Persistence Regression
*   **Verdict**: **Feature Regression**. In `corelib`, a critical robustness feature is that the Rust streamers autonomously initialize an exclusive `redb` database [alpaca_streamer.rs:181-208](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L181-L208). They load/store active subscriptions to this local DB so that if a process crashes and restarts, it automatically resumes streams for previously active tickers without needing downstream JS state tracking.
    *   `finstream`'s trait client relies on in-memory channel orchestration and has no persistence. Dropping corelib's `redb` support is a severe regression. Any porting attempt must retain or re-engineer the subscription persistence layer.

#### (d) Is S2 too big for ONE spec?
*   **Verdict**: **Yes; Phasing is Mandatory**. S2 covers: defining the trait core, porting the schema, implementing three separate websocket adapters, adjusting the FFI, and rewriting JS wrappers. Attempting this in a single spec introduces too many concurrent variables. It should be partitioned into a multi-phased roadmap to maintain a working build at every commit.

#### (e) Does the unified MarketEvent schema fit corelib's existing consumers & conventions?
*   **Verdict**: **Uncomfortable Fit / Breakage**. S2's proposed unified `MarketEvent` (Trade/Quote/Status with polymorphic provider extras) forces standard flat JS consumers to receive deeply nested, variant-tagged objects. For example, [AlpacaStreaming.ts:L31-L39](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts#L31-L39) directly subscribes back to structural `AlpacaPricingData` [alpaca_streamer.rs:66-82](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-e2d12c41/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L66-L82).
    *   Changing the callback payloads instantly breaks the pricing pipeline downstream in `ts-markets`' consumers.
    *   Additionally, the §1 strict-logging convention requires that child loggers are structured. Injecting polymorphic, nested provider-extras into common logging fields is highly complex over N-API.

---

### 2. Creative Improvement: "S2.5 — Trait-Backed Engine with Back-Compat FFI / TS Facade"

To reap all architectural benefits of **S2** (unified internal traits, normalized schema, shared reconnection/jitter scheduler, clean Finnhub integration) while guaranteeing **zero broken contracts and zero integration test rework**, we propose a decomposed scope: **S2.5**.

```mermaid
graph TD
    %% Define styles
    classDef ts fill:#2d79c7,stroke:#1a4d80,color:#fff;
    classDef rust fill:#dea584,stroke:#8b4f30,color:#000;
    classDef db fill:#415a77,stroke:#1b263b,color:#fff;

    subgraph TS_Layer ["ts-markets / TS Consumers"]
        Alpha["AlpacaStreaming (TS Wrapper)"]:::ts
        Beta["YahooStreaming (TS Wrapper)"]:::ts
        Gamma["FinnhubStreaming (TS Wrapper)"]:::ts
    end

    subgraph FFI_Boundary ["N-API FFI & Rust Core"]
        A_FFI["AlpacaStreaming (N-API class)"]:::rust
        Y_FFI["YahooStreaming (N-API class)"]:::rust
        F_FFI["FinnhubStreaming (N-API class)"]:::rust

        subgraph Core_Engine ["Unified Engine (Internal Rust)"]
            TraitEngine["Shared Driver Core<br>ReconnectPolicy + Panic Monitor"]:::rust
            A_Driver["AlpacaDriver<br>(implements ProviderDriver)"]:::rust
            Y_Driver["YahooDriver<br>(implements ProviderDriver)"]:::rust
            F_Driver["FinnhubDriver<br>(implements ProviderDriver)"]:::rust
        end
    end

    subgraph Persistence_Layer ["Local Persistence"]
        DB["redb Database Instance"]:::db
    end

    %% Wiring
    Alpha --> A_FFI
    Beta --> Y_FFI
    Gamma --> F_FFI

    A_FFI -->|Spawn / DB State| A_Driver
    Y_FFI -->|Spawn / DB State| Y_Driver
    F_FFI -->|Spawn| F_Driver

    A_Driver & Y_Driver & F_Driver -.->|Register & Drive| TraitEngine
    A_Driver -.->|Read/Write Tickers| DB
    Y_Driver -.->|Read/Write Tickers| DB

    %% Mapping Back to Back-Compat
    TraitEngine -->|Normalized Event| A_FFI
    TraitEngine -->|Normalized Event| Y_FFI
    TraitEngine -->|Normalized Event| F_FFI

    A_FFI -->|Flat AlpacaPricingData| Alpha
    Y_FFI -->|Flat YahooPricingData| Beta
    F_FFI -->|Flat FinnhubPricingData| Gamma
```

#### Core Architectural Mechanics of S2.5:
1.  **Shared Internal Driver Trait**: Introduce the clean `ProviderDriver` trait internally inside the Rust core, alongside the unified `MarketEvent` enum in `rust/src/markets/nasdaq/datafeeds/streaming/core/`.
2.  **Shared Reconnection Engine**: Pull in finstream's `ReconnectPolicy` as a modular scheduler, hardened with the b-1 backoff reset on successful auth and randomized jitter.
3.  **Back-Compat N-API Interface**: Retain the exact existing N-API struct wrappers (`AlpacaStreaming`, `YahooStreaming`) and their matching public TS classes.
4.  **Database-Aware Driver Wrapper**: Internally, the N-API `AlpacaStreaming` class manages the `redb` file isolation and is responsible for loading/storing subscriptions. It spawns the unified `AlpacaDriver` over the shared trait core, and maps the internal Rust `MarketEvent::Trade` / `MarketEvent::Quote` back into the flat, legacy `AlpacaPricingData` payload before sending it to the existing Threadsafe Functions (TSFNs).
5.  **Clean Finnhub Addition**: Add `FinnhubDriver` natively under the trait, exposing it via a clean `FinnhubStreaming` FFI and JS class matching the design style of `AlpacaStreaming`.

#### Missing Prerequisites Flagged:
*   **FFI Translation Layer**: We must design the specific Rust-to-JS event mapper. If `MarketEvent` has varied payload shapes, Rust must cleanly deserialize/flatten them before crossing N-API boundaries to avoid heavy V8 parsing of complex structures.
*   **Symbol Scope Discrepancy**: We must verify if `finstream`'s providers match corelib's symbology requirements (e.g. Nasdaq-specific tickers and security classes) before relying on its raw feeds.

---

### 3. Highest-Conviction Recommendation

**We strongly recommend Scope S2.5 (Decomposed Trait-backed Engine with Back-Compat Facades), delivered across 3 phases.**

*   **Reasoning**: It captures 100% of the architectural elegance and code de-duplication of Claude's **S2** while ensuring **zero contract breaks** for downstream TS consumers and **zero rework** for the approved integration-test spec. It explicitly preserves the hard-earned b-1 database isolation and backoff fixes by integrating them directly into the common driver scheduler.
*   **Phasing**:
    *   **Phase 1**: Port internally the `ProviderDriver` trait, unified `MarketEvent` schema, and generic reconnection scheduler. Implement and expose **Finnhub** as the pilot provider.
    *   **Phase 2**: Reimplement Alpaca and Yahoo internally to implement `ProviderDriver`, wrapping them in the back-compat N-API/redb host layer to keep TS bindings fully stable.
    *   **Phase 3**: Optional final unification. Once the integration tests are fully deployed and stable, deprecate the individual TS wrappers and introduce a multiplexed stream gateway if product requirements demand it.

---

## 2026-06-12 — (d) Phase 1 spec-phase divergent pass

### 1. Critical Review

This section performs a spec-phase pressure-test on the proposed "Provider Port — Phase 1 Design Spec" and the shared engine, checking for hidden holes, contradictions, and missing requirements that would cause rework or break existing execution architectures.

#### 🔴 Blocker — Missing Dynamic Subscription Channel in ProviderDriver Trait
*   **Design Area**: `ProviderDriver` trait boundary and `spawn()` signature ([2026-06-12-provider-port-phase1-design.md#L62-L63](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md#L62-L63)), §4.1 `driver.rs`.
*   **Verification**: [VERIFIED]
*   **Issue**: The proposed `spawn` method signature:
    `spawn(symbols, tx: mpsc::Sender<MarketEvent>, policy: ReconnectPolicy) -> JoinHandle<()>`
    accepts only a static snapshot of `symbols: Vec<String>` at task boot time. However, parent/legacy client facades (such as [AlpacaStreaming.ts:L91-L93](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts#L91-L93)) support dynamic symbol subscriptions on an active stream, which are captured by [alpaca_streamer.rs:L657-L684](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs#L657-L684).
    If `ProviderDriver::spawn` has no receiver for dynamic updates, **dynamic subscriptions are completely broken**. Any symbol requested after `start()` will write to `redb` but will never be sent to the underlying provider's WebSocket stream.
*   **Concrete Fix**: [Surgical] Update the `ProviderDriver::spawn` method to accept an `mpsc::Receiver` for dynamic subscription updates:
    ```rust
    spawn(
        symbols: Vec<String>,
        tx: mpsc::Sender<MarketEvent>,
        sub_rx: mpsc::Receiver<Vec<String>>,
        policy: ReconnectPolicy
    ) -> JoinHandle<()>
    ```
    This enables the running driver task to accept incoming dynamic symbol lists in the exact style of the hardened Alpaca streamer.

#### 🔴 Blocker — Leaked Facade Pump Task & TSFN Hold on Class Destruction
*   **Design Area**: FFI lifecycle and Drop implementation ([2026-06-12-provider-port-phase1-design.md#L38-L40](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md#L38-L40) [§3.1] & [2026-06-12-provider-port-phase1-design.md#L83-L93](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md#L83-L93) [§4.3]).
*   **Verification**: [VERIFIED]
*   **Issue**: Separating the async streamer into a decoupled `supervisor`/`driver` task (which sends to an mpsc) and an FFI `facade` means there are now **two distinct background tasks**. The spec describes storing and aborting the supervisor's `JoinHandle` inside the facade. However, the facade must also spawn a pump task that polls the `mpsc::Receiver` and invokes the JS Threadsafe Functions (TSFNs).
    If the facade pump task's handle is not explicitly stored and aborted, a blocked or hung supervisor/driver (e.g., stuck on reading from a WebSocket loop or synchronous lock) will keep the channel open. The pump task will wait indefinitely, holding onto the active TSFNs. TSFNs hold a strong reference to the Node.js main loop, so **the Node process will never exit cleanly and GC fails**, breaking the target teardown requirement.
*   **Concrete Fix**: [Surgical] The `FinnhubStreaming` facade struct must store **both** `ws_task` (the supervisor/driver monitor) AND `pump_task` (the FFI pump). The `impl Drop` block must abort both tasks atomically:
    ```rust
    if let Some(task) = guard.pump_task.take() {
        task.abort();
    }
    ```

#### 🔴 Blocker — Contradictory Reconnection Boundaries (Who Loops?)
*   **Design Area**: Reconnect engine and state-management model ([2026-06-12-provider-port-phase1-design.md#L62-L69](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md#L62-L69) [§4.1]).
*   **Verification**: [VERIFIED]
*   **Issue**: S2.5 states that the "supervisor applies the reset/panic/stop" (§4.1), but finstream's `spawn()` signature passes `policy: ReconnectPolicy` directly to the Driver. If the Driver owns its own internal loop and schedules its own retries, the Supervisor task is a redundant pass-through. If the Driver loops itself, there is no way for the Supervisor to sleep, apply backoff increments, or control retry boundaries.
    Furthermore, how does the Supervisor know a connection succeeded to "reset" the backoff attempt to `0`? If the Driver is an opaque task, it must emit a success state over the channel (such as `MarketEvent::Status { status: Connected }`) which the Supervisor observes to reset the counter.
*   **Concrete Fix**: [Structural] Resolve the architectural dual-scheduler conflict cleanly by shifting the reconnection loop **entirely to the Supervisor**. The Driver's execution method should cover a **single connection attempt**. When that attempt returns or crashes:
    1. The Supervisor intercepts the exit.
    2. The Supervisor calculates the next backoff delay from `policy.next_delay(attempt)` (plus std-based jitter).
    3. The Supervisor sleeps and then spawns a *new* instance of the driver.
    If the Supervisor reads a `MarketEvent::Status { status: ProviderStatus::Connected }` from the mpsc channel, it instantly resets `attempt = 0`. This decouples the network driver from policy tracking and creates a single place for state control.

#### 🟡 Should-Fix — Missing Feature Definitions in Cargo.toml
*   **Design Area**: Cargo features configuration ([Cargo.toml#L1-L53](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/rust/Cargo.toml#L1-L53) and [2026-06-12-provider-port-phase1-design.md#L111-L115](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md#L111-L115) [§6.0]).
*   **Verification**: [VERIFIED]
*   **Issue**: §6 specifies that the `finnhub` feature gates the driver compilation and is "enabled in corelib's default build so the .node includes it." However, corelib's `Cargo.toml` has no `[features]` block defined. Attempting to build with `--features finnhub` or using conditional compilation `#[cfg(feature = "finnhub")]` without the feature block in `Cargo.toml` will fail or compile the pilot code out entirely by default.
*   **Concrete Fix**: [Surgical] Define the `[features]` section in `rust/Cargo.toml` explicitly:
    ```toml
    [features]
    default = ["finnhub"]
    finnhub = []
    ```

#### 🟡 Should-Fix — Underspecified FFI Payload Object mapping (FinnhubPricingData)
*   **Design Area**: Map data structures ([2026-06-12-provider-port-phase1-design.md#L94-L101](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md#L94-L101) [§4.4]).
*   **Verification**: [THEORETICAL]
*   **Issue**: `FinnhubPricingData` is described as dynamic or flat "as needed". To prevent developer variance and ensure typescript consumer stability, the flat structure must be formally specified. Because Finnhub websocket feeds stream numerical Unix epoch timestamps (seconds/milliseconds) instead of RFC3339 strings, the types must support numeric mapping seamlessly.
*   **Concrete Fix**: [Surgical] Hardcode the FFI flat boundary contract for `FinnhubPricingData`:
    ```rust
    #[napi(object)]
    #[derive(Clone, Serialize, Deserialize)]
    pub struct FinnhubPricingData {
        pub symbol: String,
        pub message_type: String, // "trade"
        pub price: f64,
        pub volume: f64,
        pub timestamp: f64, // Numeric epoch (f64 for napi compatibility)
        pub conditions: Option<Vec<String>>, // Finnhub trade conditions array
    }
    ```

#### 🟢 Nit — Callback Trait Isolation & Common Models Reuse
*   **Design Area**: Struct definitions sharing ([2026-06-12-provider-port-phase1-design.md#L94-L101](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-bc77faeb/docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md#L94-L101) [§4.4]).
*   **Verification**: [THEORETICAL]
*   **Issue**: It is ambiguous whether `FinnhubStreaming` should implement custom callbacks or share types.
*   **Concrete Fix**: Clarify that:
    1. `EventRecord` and `LogRecord` are imported directly from crate root (`crate::{EventRecord, LogRecord}`) to keep error events and logger contracts aligned.
    2. `FinnhubCallbacks` is defined separately inside `finnhub_streamer.rs` to keep pricing payload contracts generic-free and clean.

---

### 2. Creative Improvements

#### The websocket-streamer-host Delegation Template (Phase 2 Masterstroke)
While `napi-derive` does not support Rust generic parameters on FFI-exposed structs directly (so we must maintain separate `AlpacaStreaming`, `YahooStreaming`, and `FinnhubStreaming` structs for FFI binding), we can de-duplicate **100% of the FFI coordination complexity** by creating a common `WebsocketStreamerHost<D: ProviderDriver>` struct inside the core library.

This internal host is configured with:
1. The unique `redb` subscriptions table name (e.g. `"finnhub_subscriptions"` vs `"alpaca_subscriptions"`).
2. The custom mpsc-pump callback execution logic.

Our FFI classes then become simple delegating facades:
```rust
#[napi]
pub struct FinnhubStreaming {
    host: WebsocketStreamerHost<FinnhubDriver>,
}

#[napi]
impl FinnhubStreaming {
    #[napi(constructor)]
    pub fn new(on_log: TSFN, on_pricing: TSFN, on_event: TSFN) -> Self {
        Self {
            host: WebsocketStreamerHost::new("finnhub_subscriptions", on_log, on_pricing, on_event)
        }
    }
    // ... thin delegations for start(), stop(), subscribe(), unsubscribe() ...
}
```
This reduces the FFI boilerplate code for Finnhub, Alpaca, and Yahoo down from hundreds of lines of complex, duplicated timer/task/channel orchestrating code to a highly secure, 30-line delegation wrapper. It guarantees flawless FFI behavior across the entire monorepo during Phase 2.

---

### 3. Highest Conviction Suggestion

The single highest-conviction architectural adjustment is to **center entire connection scheduling and backoff control inside the internal Supervisor block**, turning the individual `ProviderDriver` blocks into clean, single-connection attempts that report status updates via the common `mpsc::Sender<MarketEvent>` channel. 

By having the Supervisor monitor for a `MarketEvent::Status { status: Connected }` frame to reset its internal delay `attempt = 0`, we port the b-1 reconnect fix cleanly into a shared, trait-backed paradigm, avoiding any dual-ownership code-drift regressions during Phase 1.

---

## 2026-06-12 — (d) Phase 1 plan-phase divergent pass

### 1. Critical Review

This review performs a pre-implementation pressure-test on the proposed "Provider Port — Phase 1 (Finnhub pilot) Implementation Plan" to identify compilation blockers, API discrepancies, and architectural bugs that would derail a developer attempting to execute this plan.

#### 🔴 Blocker — Stable `async fn` in Trait Breaks `tokio::spawn` `Send` Bounds
*   **Design Area**: Task 4 ([core/driver.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/markets/nasdaq/datafeeds/streaming/core/driver.rs#L268-L283)), Task 7 ([core/supervisor.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/markets/nasdaq/datafeeds/streaming/core/supervisor.rs#L513-L538)), and Task 8 ([core/host.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs#L608-L621))
*   **Verification**: [VERIFIED]
*   **Issue**: Task 4 declares `trait ProviderDriver` with `#![allow(async_fn_in_trait)] async fn connect_once(...)`. Under stable Rust, the anonymous future returned by an `async fn` inside a trait does not automatically implement the `Send` bound. When Task 7's generic `run_supervisor<D>` awaits `driver.connect_once(...)`, the resulting outer future of `run_supervisor` becomes non-`Send`. Consequently, in Task 8's host, the scheduler's `tokio::spawn(run_supervisor(...))` will fail to compile. The compiler will halt with a blocker indicating that the spawned future cannot be sent across threads safely.
*   **Concrete Fix**: [Structural] Replace standard `async fn` in the trait with a returning `futures::future::BoxFuture<'a, AttemptOutcome>` which enforces `Send` explicitly without any experimental bounds or macros.
    Update `ProviderDriver::connect_once` in Task 4 to:
    ```rust
    use futures::future::BoxFuture;

    pub trait ProviderDriver: Send + Sync + 'static {
        fn validate(&self) -> Result<(), String> { Ok(()) }

        fn connect_once<'a>(
            &'a self,
            symbols: &'a [String],
            tx: &'a mpsc::Sender<MarketEvent>,
            sub_rx: &'a mut mpsc::Receiver<Vec<String>>,
            stop_rx: &'a mut mpsc::Receiver<()>,
        ) -> BoxFuture<'a, AttemptOutcome>;
    }
    ```
    Then, wrap the returned future in Task 6 (`finnhub_driver.rs`) using `.boxed()` from `futures::future::FutureExt`:
    ```rust
    use futures::future::FutureExt;
    // ...
    fn connect_once<'a>(&'a self, ...) -> BoxFuture<'a, AttemptOutcome> {
        async move {
            // connection and auth implementation
        }.boxed()
    }
    ```

#### 🔴 Blocker — Persistent Subscription DB State Loss on Startup
*   **Design Area**: Task 8 ([core/host.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs#L590-L621)), Task 9 ([finnhub_streamer.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs#L687-L722))
*   **Verification**: [VERIFIED]
*   **Issue**: Although the spec mandates keeping `redb` subscription persistence, the design completely overlooks loading existing records from `redb` at startup! `WebsocketStreamerHost::new()` opens the DB block, but never reads it. `FinnhubStreaming::start(symbols)` invokes the host monitor task using only the symbols passed in via the initial TS array. If a process restarts or instantiates a new streaming delegate, any previously tracked symbols stored in the redb file are completely ignored/lost, defeating the purpose of the b-1 database layer.
*   **Concrete Fix**: [Structural] Implement a method on `WebsocketStreamerHost` that reads previously persisted subscription tickers from the `redb` table. Fetch and merge them inside the facade's `start()` method:
    ```rust
    // In core/host.rs
    pub fn get_persisted_subscriptions(&self) -> Vec<String> {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        let mut subs = Vec::new();
        if let Ok(rtx) = self.db.begin_read() {
            if let Ok(t) = rtx.open_table(table) {
                if let Ok(mut iter) = t.iter() {
                    while let Some(Ok((k, _))) = iter.next() {
                        subs.push(k.value().to_string());
                    }
                }
            }
        }
        subs
    }
    ```
    In `FinnhubStreaming::start()`, merge these with the passed-in symbols list before calling `host.start()`.

#### 🔴 Blocker — NAPI callback parameter calling payload as Error (null)
*   **Design Area**: Task 11 ([FinnhubStreaming.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts#L775-L797))
*   **Verification**: [VERIFIED]
*   **Issue**: In Task 11, the TS constructor passes `onPricing` and other callbacks directly to the native `new Native(config, onPricing, ..., ...)` constructor. By default, napi-rs threadsafer functions call JS callbacks using the Node.js standard: `callback(err, data)`. Passing `onPricing: (d: FinnhubPricingData) => void` directly means the FFI invocation `on_pricing.call(Ok(p))` will issue `callback(null, p)`. The JS runtime will bind `null` to `d` on the JS side, completely blocking the pricing payload.
*   **Concrete Fix**: [Surgical] Discard the error parameter and forward correct payloads to the TS wrapper constructor:
    ```typescript
    this.#native = new Native(
      config,
      (err: any, d: FinnhubPricingData) => onPricing(d),
      (err: any, e: { type: string; data?: string }) => onEvent(e),
      (err: any, l: { level: string; msg: string; extras?: string }) => onLog(l)
    );
    ```

#### 🔴 Blocker — Hardcoded ProviderKind in Generic Host's Panic Monitor Breaks Phase 2
*   **Design Area**: Task 8 ([core/host.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs#L605-L619))
*   **Verification**: [VERIFIED]
*   **Issue**: The supervisor's panic monitor task inside Task 8's `start()` method handles a panic and hardcodes the provider tag as `ProviderKind::Finnhub` when emitting the synthetic `Status::Error`:
    ```rust
    status: ProviderStatus::Error { provider: ProviderKind::Finnhub, message: "supervisor task panicked; stream is dead".into() }
    ```
    If `WebsocketStreamerHost` is to be a generic abstraction capable of migrating Alpaca and Yahoo streams during Phase 2, this hardcoding is a critical architectural violation: their panics would be emitted as Finnhub errors.
*   **Concrete Fix**: [Surgical] Thread `ProviderKind` down to the host instance during creation. Add `provider: ProviderKind` straight into `WebsocketStreamerHost::new()` and its private fields, and map it inside the monitor's synthetic error payload.

#### 🟡 Should-Fix — TS Constructor Mismatch Breaks Per-Provider Shape Consistency
*   **Design Area**: Task 9 ([finnhub_streamer.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs#L687-L695)) and Task 11 ([FinnhubStreaming.ts](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts#L775-L797))
*   **Verification**: [VERIFIED]
*   **Issue**: To keep the per-provider facades completely unchanged and compatible with corelib conventions, `FinnhubStreaming` must mirror `AlpacaStreaming`. However, the plan's TS constructor takes the configuration and callbacks at constructor-time and lacks an `EventEmitter` interface. Alpaca and Yahoo streams take 0 arguments, extend `EventEmitter`, and use `.on("pricing", ...)` to register observers. They initialize asynchronously via `async init(config)` and `async start()`.
*   **Concrete Fix**: [Structural] Reconfigure `FinnhubStreaming` to match Alpaca's structure exactly:
    1. Expose 0-argument constructor in `FinnhubStreaming` (TS). Extend `EventEmitter`.
    2. Pass 3 threadsafe callbacks (matching the `on_*` emitters) to the FFI construct.
    3. Expose `async init(config)` on both Rust and TS boundaries.

#### 🟢 Nit — Re-export `FinnhubStreaming` at Core Root
*   **Design Area**: Task 1 ([lib.rs](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-438ebde6/rust/src/lib.rs#L53-L117))
*   **Verification**: [THEORETICAL]
*   **Issue**: The plan forgets to re-export `FinnhubStreaming` and `FinnhubConfig` at the Rust root level of `lib.rs` alongside Alpaca and Yahoo (e.g. `pub use markets::nasdaq::datafeeds::streaming::finnhub::{...}`). Failing to do so makes it harder to surface the schema cleanly.
*   **Concrete Fix**: Add the re-exports inside `lib.rs` under `#[cfg(feature = "finnhub")]` guard.

---

### 2. Creative Improvements

*   **BoxFuture Standard Paradigm**: Shifting `connect_once` return signatures to `BoxFuture` represents the easiest and cleanest way to de-risk generic traits and multithreaded lifetimes, assuring that Phase 2 migrations compile out-of-the-box smoothly without macro overhead.
*   **Deduplicated FFI Initialization Helpers**: Standardize a helper inside `core/host.rs` to automatically setup `redb` subscription tables on host creation. Right now, Alpaca explicitly does table schema checks inside it's constructor, so moving table checks inside `WebsocketStreamerHost::new` removes manual schema instantiation logic from the delegator facade.

---

### 3. Highest Conviction Recommendation

The single highest-conviction fix is to **standardize the `ProviderDriver::connect_once` signature to return `BoxFuture<'a, AttemptOutcome>` and resolve the `redb` subscription load regression inside the generic host.**

By enforcing explicit `Send` futures through standard box pinning, compiled FFI tasks compile cleanly on any stable Rust platform. Simultaneously, introducing `get_persisted_subscriptions()` on the host preserves the hard-earned, highly crash-resilient `redb` capabilities of the corelib stream pipeline, resolving both blockers in one unified pass. (Plan Task 4, 8, 9).

---

## 2026-06-12 — (d) Phase 1 convergent review (pre-merge)

This convergent critical review performs a final verification sweep of the implemented Finnhub pilot (`feat/finnhub-provider-phase1` branch) before merging to `main`. This branch successfully conforms to all approved S2.5 architectural decisions (retaining per-instance redb schema, generic host-supervisor pattern, and back-compat TS facades).

### 1. Critical Review & Audit

#### 🟡 Should-Fix — Closed Channel `sub_rx` in `connect_once` Spins CPU at 100%
*   **Design Area**: [finnhub_driver.rs:88](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-0067899c/rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs#L88)
*   **Verification**: [VERIFIED]
*   **Issue**: In `FinnhubDriver::connect_once`, the active WebSocket message dispatch loop polls incoming dynamic subscriptions via `upd = sub_rx.recv()`. If the hosting `WebsocketStreamerHost` drops its `sub_tx` sender (e.g., during actor shutdown, drop, or error cleanup), the `sub_rx` channel is closed. When a channel is closed, `recv()` immediately and perpetually returns `None`. The loop matches `if let Some(syms) = upd` which evaluates to false and does nothing. It then immediately cycles back to the top of `tokio::select!`. Since the future is immediately ready with `None` again, this triggers a 100% CPU busy-spin / thread starvation lockup.
*   **Concrete Fix**: [Surgical] Match on the resolved option from `sub_rx.recv()` and gracefully return `AttemptOutcome::Stopped` when the channel is closed:
    ```rust
    upd = sub_rx.recv() => {
        match upd {
            Some(syms) => {
                for s in &syms {
                    if !current.contains(s) {
                        let m = serde_json::json!({ "type": "subscribe", "symbol": s }).to_string();
                        let _ = ws.send(Message::Text(m.into())).await;
                        current.push(s.clone());
                    }
                }
            }
            None => return AttemptOutcome::Stopped,
        }
    }
    ```
*   **One-line failing test idea**: Instantiate the driver connect future with a dropped dynamic subscription channel sender and verify it resolves immediately to `AttemptOutcome::Stopped` instead of hanging or pinning the CPU.

#### 🟢 Nit — Unsubscribe (Phase-1 No-Op) Leaves Persistent Database Untouched
*   **Design Area**: [FinnhubStreaming.ts:60](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-0067899c/ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts#L60) / [finnhub_streamer.rs:266](file:///C:/Users/user/Development/Node/corelib/.agent/worktrees/task-0067899c/rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs#L266)
*   **Verification**: [VERIFIED]
*   **Issue**: Per the Phase 1 spec, dynamic live unsubscribes through the active WS stream are deferred. However, `FinnhubStreaming::unsubscribe` on the facade is mapped to a complete no-op (`Ok(())`) which bypasses updating the persistent local database (`redb`). If a JS client calls `unsubscribe` in Phase 1, the subscriptions are retained in `redb` and will reappear upon the next restart.
*   **Concrete Fix**: [Surgical] Invoke `host.unsubscribe(symbols)` or remove them from local `redb` storage during `unsubscribe`, even if dynamic live unsubscription remains a no-op, to keep the persistent storage consistent with developer intent.
*   **One-line failing test idea**: Call `unsubscribe(["AAPL"])` and verify that "AAPL" is removed from the local database on subsequent startups.

---

### 2. Generative Question

*   **Question**: Ignoring settled decisions, is there anything materially simpler or stronger worth the churn BEFORE merge?
*   **Answer**: `no change`. The codebase flawlessly executes the multi-phased trait-backed S2.5 facade pattern. It respects the hard-earned b-1 database, panic monitoring, and masked debug credentials fixes, achieving complete functional and performance parity with zero regressions.

---

### 3. Highest Conviction Suggestion

The highest-conviction suggestion is to **fix the `tokio::select!` channel closure in `finnhub_driver.rs`**. Transitioning the `Some(...)` check to an explicit `match` that returns `AttemptOutcome::Stopped` prevents thread starvation and resource leakages on actor teardown, assuring perfect FFI stability under standard runtime environments.
