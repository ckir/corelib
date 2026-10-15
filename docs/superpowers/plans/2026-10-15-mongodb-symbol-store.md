# MongoDB Symbol Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `MarketSymbols` keep the Nasdaq symbol directory in SQLite, Turso or MongoDB, chosen per deployment by a config setting.

**Architecture:** Extract a small `SymbolStore` interface; `SqlSymbolStore` wraps today's SQL unchanged, `MongoSymbolStore` is new (generation-numbered documents plus one atomic forward-only flip, no transactions). `MarketSymbols` keeps freshness, retry, parsing and the new circuit breaker; a factory picks the store.

**Tech Stack:** TypeScript (strict, ESM), Vitest 4, Biome, `mongodb` driver ^7.7.0 (measured working, Node 24), tsup, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-15-mongodb-symbol-store-design.md` (approved 2026-10-15). Read it first; this plan only records what the spec leaves open.

## Global Constraints

- Config keys (defaults in `ts-core/src/configs/ConfigManager.json` under `markets.nasdaq.symbols`): `store` = `"sqlite"` (also `"turso"`, `"mongodb"`), `breaker` = `30000` (ms), `turso.urlEnv` = `"CORELIB_TURSO_URL"`, `turso.tokenEnv` = `"CORELIB_TURSO_TOKEN"`, `mongodb.uriEnv` = `"MONGODB_URI"`, `mongodb.database` = `"corelib"`, `mongodb.collection` = `"nasdaq_symbols"`. Env overrides map `CORELIB_A_B_C` to `a.b.c` in lower case, so only single-word keys (`store`, `breaker`, `mongodb.database`, `mongodb.collection`) can be set that way; the `*Env` keys are file/CLI only.
- Constructor argument beats config. Database name: explicit option, then URI path (parsed by us; `client.db()` falls back to `test`), then `mongodb.database`.
- Mongo refresh protocol, generation cache of at most 5 s, pool `maxPoolSize: 2` and `serverSelectionTimeoutMS`/`connectTimeoutMS` 5000 on Lambda (`detectRuntime() === "aws-lambda"`), driver defaults elsewhere; `ts` stays a plain number; symbols stored upper-case; no `active` field in Mongo.
- Test env: `CORELIB_TEST_MONGODB_URI` (connection string) and `CORELIB_REQUIRE_MONGODB=1` (missing URI fails instead of skipping). Never infer from `CI`.
- Tooling (measured on this machine): run `./node_modules/.bin/<tool>` directly, not through `pnpm -s`; `NO_COLOR=1` for vitest, no `--colors`; Biome is `ts-core/node_modules/.bin/biome` run from the repo root; `mongod` 8.0.34 runs natively but the `mongo:8` image will not start on kernel 6.19+.
- Logger calls follow `(msg, extras)` with errors passed through `serializeError` (AGENTS.md section 1). New files start with the repo's `// FILE / PURPOSE` header. Do not edit tests to match code; the spec and the existing tests are the oracle.
- Commits: the steps below name them, but commit only after the user authorises commits for this plan. Trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never bypass hooks, never push without being asked.

## Review Focus

Inputs the spec implies and no obvious test covers; each has a test in the named task.
1. Symbols that look like query syntax (`"A.*"`, `"$ne"`, `""`, whitespace) must return `null`, never match other rows or throw (Task 1 contract, runs on both stores).
2. A refresh whose rows contain a duplicate symbol: SQL upserts (last wins), Mongo rejects; either way `MarketSymbols` never sends duplicates and a rejected refresh leaves the old set intact (Task 1 contract uses a per-store poison row; Task 5).
3. `mongodb://host`, `mongodb://host/`, `mongodb://host/?x=1`, `mongodb+srv://` and multi-host URIs must not land in database `test` (Task 5 `resolveDatabaseName`).
4. Two stores sharing one connection string: closing one must not break the other, closing both must close the client (Task 5).
5. A fresh empty database initialised by two stores at once (index creation and the `meta` upsert race) must end with one consistent state (Task 5).

---

### Task 1: SymbolStore interface, SqlSymbolStore and the shared contract suite

**Files:**
- Create: `ts-markets/src/nasdaq/symbolStore.ts`, `ts-markets/src/nasdaq/sqlSymbolStore.ts`, `ts-markets/src/nasdaq/symbolStore.contract.ts`, `ts-markets/src/nasdaq/sqlSymbolStore.test.ts`
- Modify: `ts-markets/src/index.ts` (export the interface and error type next to `MarketSymbols`, line 82)

**Interfaces:**
- Produces (`symbolStore.ts`):
  ```ts
  import type { MarketSymbolRow } from "./MarketSymbols";
  export interface SymbolStore {
    init(): Promise<void>;
    find(symbol: string): Promise<MarketSymbolRow | null>;
    lastRefreshTs(): Promise<number | null>;
    count(): Promise<number>;
    replaceAll(rows: MarketSymbolRow[], refreshTs: number): Promise<void>;
    close(): Promise<void>;
  }
  export class SymbolStoreUnavailableError extends Error {
    constructor(message: string, options?: { cause?: unknown });
  }
  ```
- Produces (`sqlSymbolStore.ts`): `class SqlSymbolStore implements SymbolStore` with `static fromDatabase(db: Database): SqlSymbolStore` (never disconnects it) and `static fromConfig(config: SqlStoreConfig): SqlSymbolStore` (creates the database in `init()` via `createDatabase`, disconnects on `close()`); `type SqlStoreConfig = { dialect: "sqlite"; url: string; mode: "stateful" | "stateless"; authToken?: string }` (the shape `MarketSymbols` builds today, `MarketSymbols.ts:102-107`).
- Produces (`symbolStore.contract.ts`): `symbolStoreContract(label: string, make: () => Promise<{ store: SymbolStore; poison: (good: MarketSymbolRow[]) => MarketSymbolRow[]; cleanup: () => Promise<void> }>): void` registering the contract tests below with Vitest. `poison` returns rows that make `replaceAll` fail on that backend.

- [ ] **Step 1: Write the contract suite and the SQL test file.** `sqlSymbolStore.test.ts` calls `symbolStoreContract("SqlSymbolStore (in-memory SQLite)", ...)` with a real `createDatabase({dialect:"sqlite", url:":memory:", mode:"stateful"})`; its `make` pre-creates `nasdaq_symbols` with the production columns plus `CHECK (symbol <> 'POISON')` (as `MarketSymbols.refresh-failure.test.ts:60-63` does) and `poison` appends a row with symbol `POISON`. Contract tests (names are the checklist):
  - `empty store: count 0, lastRefreshTs null, find null`
  - `round trip: replaceAll then find("aapl") returns {symbol:"AAPL", active:true, ts: number}; lastRefreshTs equals refreshTs; count equals rows.length`
  - `a second replaceAll replaces the set: old symbols gone, new present, count equals new length`
  - `a failing replaceAll (poison rows) rejects and leaves symbols, count and lastRefreshTs unchanged`
  - `replaceAll([]) rejects and leaves the set unchanged`
  - `hostile symbols "A.*", "$ne", "", " AAPL " return null without throwing`
  - `12000 rows round trip, count is 12000, under 30 s`
  - `init is idempotent and safe to call twice concurrently`
- [ ] **Step 2: Run to see it fail.** `cd ts-markets && NO_COLOR=1 ./node_modules/.bin/vitest run src/nasdaq/sqlSymbolStore.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `symbolStore.ts` and `SqlSymbolStore`.** Move today's SQL verbatim: table/index DDL from `MarketSymbols.ts:436-449`, the lookup `:385-388`, `MAX(ts)` `:511-513`, `COUNT(*)` `:761-763`, and the transaction body `:583-638` (same statements, batch size 150, same rollback-on-first-error). `status: "error"` results become thrown `Error`s with `cause`; the refresh failure message stays `"Symbol refresh failed; the transaction was rolled back"` (`:641-646`). `find` upper-cases its input. `replaceAll` rejects an empty array before touching the database; it ignores `refreshTs` (rows already carry `ts`). `lastRefreshTs()` maps a `NULL` max to `null`. Call made here, not in the spec: `SqlSymbolStore` throws only ordinary errors in v1 (`db.query` reports failures as `status: "error"` with no connection-class marker), so a Turso outage is not routed to the breaker; flag this in the handoff.
- [ ] **Step 4: Run to verify.** Same command — Expected: `Tests  8 passed`. Then add the two exports to `index.ts`.
- [ ] **Step 5: Mutant check.** Temporarily delete the `CHECK`-poison handling by making `replaceAll` swallow the first batch error; confirm `a failing replaceAll ... unchanged` is the test that goes red; revert.
- [ ] **Step 6: Commit** — `feat(ts-markets): SymbolStore interface and SqlSymbolStore with a shared contract suite`.

### Task 2: MarketSymbols delegates storage to a SymbolStore (SQL behaviour unchanged)

**Files:**
- Modify: `ts-markets/src/nasdaq/MarketSymbols.ts` (constructor `:128-170`, `searchDb :381-400`, `ensureInitialized`/`initialize :412-464`, `needsRefresh :508-527`, `performRefresh :535-648`, `hasExistingData :758-769`, `close :232-243`)
- Test: existing `MarketSymbols.test.ts`, `MarketSymbols.refresh-failure.test.ts` (unchanged), new `ts-markets/src/nasdaq/MarketSymbols.store.test.ts`

**Interfaces:**
- Consumes: Task 1 `SymbolStore`, `SqlSymbolStore.fromDatabase/fromConfig`.
- Produces: `MarketSymbols` constructor first argument widened to `string | { dbUrl: string; dbToken: string } | Database | SymbolStore | undefined` (detect a store by `typeof arg.replaceAll === "function"`); a private `store` resolved lazily in `ensureInitialized` (the constructor stays synchronous and does no I/O and must not read `ConfigManager`, to avoid its premature-read warning); `backgroundRefresh` keeps its name (the refresh-failure test reads it).

- [ ] **Step 1: Write `MarketSymbols.store.test.ts`** with a hand-written in-memory fake `SymbolStore` (a `Map`): `uses an injected SymbolStore and never calls its close()`, `refresh() replaces through store.replaceAll with rows stamped with one ts`, `searchDb reads through store.find`, `a thrown store.find is logged and get() falls through to the Nasdaq API`, `a thrown lastRefreshTs counts as needs-refresh and a thrown count as no existing data` (today's semantics, `:515` and `:765-768`).
- [ ] **Step 2: Run to fail**, then **Step 3: refactor.** Replace each `db.query` use with the store call; `needsRefresh()` = `lastRefreshTs()` then the existing New York date comparison (`:520-526`); `hasExistingData()` = `count() > 0`; `performRefresh` passes `(rowsArray, now)` to `replaceAll`; the constructor wraps an injected `Database` with `SqlSymbolStore.fromDatabase`, string/`{dbUrl,dbToken}`/default with `SqlSymbolStore.fromConfig` (same url rules as `:144-168`). The `minRows` guard, retry loop and parsers are not touched, and `performRefresh` keeps its `needsRefresh()` check immediately before the download (`:536`): with a shared store it is what lets one instance skip a refresh another just finished.
- [ ] **Step 4: Verify the oracle.** `NO_COLOR=1 ./node_modules/.bin/vitest run src/nasdaq` from `ts-markets` — Expected: all files pass, including the heavily mocked `MarketSymbols.test.ts` and the refresh-failure test with no edits to either (`git diff --stat` shows neither file changed).
- [ ] **Step 5: Typecheck and lint.** `./node_modules/.bin/tsc --noEmit` in `ts-markets`; `ts-core/node_modules/.bin/biome check ts-markets` from the repo root. Expected: no errors.
- [ ] **Step 6: Commit** — `refactor(ts-markets): MarketSymbols stores symbols through SymbolStore`.

### Task 3: Circuit breaker for an unreachable store

**Files:** Modify `ts-markets/src/nasdaq/MarketSymbols.ts`; modify `ts-core/src/configs/ConfigManager.json` (add `markets.nasdaq.symbols.breaker: 30000`); test `MarketSymbols.store.test.ts`.

**Interfaces:** Consumes `SymbolStoreUnavailableError`. Produces private `MarketSymbols` state `breakerOpenUntil: number` and helper `private storeCall<T>(fn: () => Promise<T>): Promise<T>` that throws `SymbolStoreUnavailableError` immediately while open and opens the breaker (now + `ConfigManager.get("markets.nasdaq.symbols.breaker")`, default 30000) when `fn` throws that error.

- [ ] **Step 1: Tests** (fake store whose methods throw `SymbolStoreUnavailableError`, fake timers): `find during an outage returns null without calling the store while the breaker is open`; `the breaker closes after the period and a success keeps it closed`; `lastRefreshTs/count failures with the breaker open trigger no download (endPoints and basic-ftp mocks not called)`; `ensureInitialized fails fast while open and does not reach performRefresh`; `an ordinary Error keeps today's semantics and does not open the breaker`; `get() never throws a store error`.
- [ ] **Step 2: Run to fail; Step 3: implement.** Route every store call in `MarketSymbols` through `storeCall`; check the breaker before any freshness evaluation (`initialize()` at `:453-458`).
- [ ] **Step 4: Run** `NO_COLOR=1 ./node_modules/.bin/vitest run src/nasdaq/MarketSymbols` — Expected: pass. **Mutant:** make `storeCall` never open the breaker; the `returns null without calling the store` test must be the one that fails; revert.
- [ ] **Step 5: Commit** — `feat(ts-markets): circuit breaker for an unavailable symbol store`.

### Task 4: Real-MongoDB test harness

**Files:**
- Create: `scripts/mongod-test.sh`, `ts-markets/src/test-utils/mongo.ts`
- Modify: `ts-markets/package.json` (dependency `mongodb@^7.7.0` via `pnpm --filter ./ts-markets add mongodb@^7.7.0`), `.claude/recommended-tools.json` (add `{name:"mongod", ...in_path:"mongod"}` and `{name:"mongosh", why:"Readiness probe used by scripts/mongod-test.sh", install:"https://www.mongodb.com/docs/mongodb-shell/install/", in_path:"mongosh"}`, each with a `why` naming the ts-markets store tests and an `install` URL)

**Interfaces:**
- `scripts/mongod-test.sh start|stop|env`: `start` launches `mongod` on `127.0.0.1:${MONGOD_TEST_PORT:-27099}` with a temp `--dbpath` under `${TMPDIR:-/tmp}/corelib-mongod`, waits (bounded, 30 s) until it answers, prints `export CORELIB_TEST_MONGODB_URI=mongodb://127.0.0.1:27099`; `stop` shuts it down and removes the directory; `env` prints the export line. Never touches the system `mongod` service.
- `test-utils/mongo.ts` produces: `mongoTestUri(): string | undefined`; `mongoGate(env: Record<string, string | undefined>): { kind: "run"; uri: string } | { kind: "skip"; message: string } | { kind: "fail"; message: string }` (pure; `fail` when `CORELIB_REQUIRE_MONGODB` is `"1"` and the URI is missing); `describeMongo(name: string, fn: (uri: string) => void): void` — a thin wrapper that applies `mongoGate(process.env)`: `describe` with the URI, `describe.skip` plus a console message, or one failing test named `CORELIB_REQUIRE_MONGODB=1 but CORELIB_TEST_MONGODB_URI is not set`; `uniqueDatabaseName(file: string): string` (file plus random suffix, valid Mongo name).

- [ ] **Step 1: Write `test-utils/mongo.test.ts`** testing only the pure `mongoGate` (never calls `describeMongo`, whose `fail` outcome would fail the real run): unset → `skip`; set → `run` with the URI; switch `"1"` with no URI → `fail`; switch `"1"` with a URI → `run`; any other switch value or an empty URI string → `skip`/`fail` accordingly (an empty URI counts as missing) and **Step 2: run to fail.**
- [ ] **Step 3: Implement** both files; `chmod +x` is not needed (invoke with `bash scripts/mongod-test.sh`).
- [ ] **Step 4: Verify the script for real:** `bash scripts/mongod-test.sh start`, then `mongosh --quiet --port 27099 --eval 'db.runCommand({ping:1}).ok'` prints `1`, then `bash scripts/mongod-test.sh stop` and `pgrep -a mongod` shows no test instance. Expected: as stated.
- [ ] **Step 5: Run** `NO_COLOR=1 ./node_modules/.bin/vitest run src/test-utils` — Expected: pass. **Commit** — `test(ts-markets): real-MongoDB test harness (helper, script, driver dependency)`.

### Task 5: MongoSymbolStore

**Files:** Create `ts-markets/src/nasdaq/mongoSymbolStore.ts`, `ts-markets/src/nasdaq/mongoSymbolStore.test.ts`.

**Interfaces:**
- Consumes: Task 1 contract and error type, Task 4 helpers.
- Produces:
  ```ts
  export interface MongoSymbolStoreOptions {
    uri: string;
    database?: string;            // explicit override (tests)
    defaultDatabase?: string;     // config default, used when neither override nor URI path names one
    collection?: string;          // default "nasdaq_symbols"
    onBeforeFlip?: () => Promise<void>; // test-only seam, awaited between the inserts and the flip
  }
  export class MongoSymbolStore implements SymbolStore { constructor(options: MongoSymbolStoreOptions); }
  export function resolveDatabaseName(uri: string, explicit: string | undefined, fallback: string): string;
  export function __clientRegistrySize(): number; // test seam
  ```
  Behaviour is fixed by the spec's "MongoDB store" sections: documents `{symbol, type, class, name, ts, gen}`, metadata `{_id:"meta", nextGen, currentGen, lastRefreshTs}`, indexes unique `{symbol:1, gen:1}` and `{gen:1}`, the five-step `replaceAll`, `find` via cached `currentGen` (5 s, one re-read and retry on a miss), reference-counted client registry keyed by URI whose entries hold the in-flight `Promise<MongoClient>` (so concurrent `init()` calls on one URI share one client), driver loaded with one shared dynamic `import("mongodb")`, connection-class errors (server selection, connect timeout, network, auth at connect) mapped to `SymbolStoreUnavailableError`, backend/host logging with no credentials.

- [ ] **Step 1: Write the tests** (all inside `describeMongo`, each file using `uniqueDatabaseName` and dropping the database in `afterAll`):
  - `symbolStoreContract("MongoSymbolStore", ...)` with `poison` = a duplicate-symbol row (unique-index failure).
  - `resolveDatabaseName` table (no server needed, always runs): `mongodb://h` → fallback; `mongodb://h/` → fallback; `mongodb://h/?x=1` → fallback; `mongodb://h/real` → `real`; `mongodb+srv://u:p@c.example/real?x=1` → `real`; `mongodb://h1:1,h2:2/real` → `real`; explicit wins over the URI path.
  - `overlapping refreshes: writer A paused at onBeforeFlip, writer B completes, then A resumes → currentGen is B's, readers saw only complete sets, A's rows are deleted`
  - `a refresh that dies before the flip leaves the old set visible and the orphan rows are pruned by the next successful refresh`
  - `prune keeps the previous generation and never deletes the meta document or a newer generation`
  - `find on a store whose cached generation was pruned still returns the symbol (one re-read)`
  - `two stores on one URI: closing one leaves the other working; closing both drops __clientRegistrySize() to 0`
  - `two stores calling init() concurrently on one URI construct exactly one MongoClient (registry size 1, one connect)`
  - `two stores initialising a fresh database at once end with one meta document and both indexes`
  - `an unreachable server (127.0.0.1:1, 500 ms selection timeout) rejects with SymbolStoreUnavailableError and no part of the URI password appears in message, cause or serialized error`
  - `ts is stored and returned as a number`
- [ ] **Step 2: Run to fail** (start the throwaway server first: `eval "$(bash scripts/mongod-test.sh start)"` then `cd ts-markets && NO_COLOR=1 ./node_modules/.bin/vitest run src/nasdaq/mongoSymbolStore.test.ts`) — Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Choose the insert batch size (suggest 1000, unordered), the pool options by `detectRuntime()` as in Global Constraints, and parse the URI path with the driver's connection-string parser or a multi-host-safe equivalent.
- [ ] **Step 4: Run to pass** — Expected: all contract and Mongo tests pass; `resolveDatabaseName` tests also pass with `CORELIB_TEST_MONGODB_URI` unset.
- [ ] **Step 5: Mutants (each must turn a specific test red, then revert):** drop the `currentGen: {$lt: myGen}` guard from the flip → the overlapping-refresh test; make `find` skip the re-read → the pruned-cache test; make `close()` ignore the reference count → the shared-client test; make the prune filter delete `meta` → the prune test.
- [ ] **Step 6: Stop the server** (`bash scripts/mongod-test.sh stop`) and **commit** — `feat(ts-markets): MongoSymbolStore with generation-based atomic refresh`.

### Task 6: Backend selection, config keys and logging

**Files:** Create `ts-markets/src/nasdaq/symbolStoreFactory.ts`, `ts-markets/src/nasdaq/symbolStoreFactory.test.ts`; modify `ts-core/src/configs/ConfigManager.json` (the keys in Global Constraints), `ts-markets/src/nasdaq/MarketSymbols.ts` (resolve the store in `ensureInitialized` through the factory).

**Interfaces:** Produces `createSymbolStore(arg: string | { dbUrl: string; dbToken: string } | Database | SymbolStore | undefined): SymbolStore` — a store instance passes through; a `Database` → `SqlSymbolStore.fromDatabase`; a string starting `mongodb://` or `mongodb+srv://` → `MongoSymbolStore` (no connection yet); other strings and `{dbUrl,dbToken}` → SQL as today; `undefined` → by `markets.nasdaq.symbols.store`, passing `markets.nasdaq.symbols.mongodb.database` and `.collection` to `MongoSymbolStore` as `defaultDatabase` and `collection`. Reads credentials with `getEnv` from `@ckirg/corelib`. Errors name the setting or variable: unknown store value; `mongodb`/`turso` selected but the named variable is empty; `mongodb` on `detectRuntime() === "cloudflare"`. At creation logs `marketSymbolsLogger.info("Symbol store selected", { backend, host })` (host only).

- [ ] **Step 1: Tests** (mock `getEnv`, `detectRuntime`, `ConfigManager.get`): each `store` value picks the right class; constructor argument beats config; `mongodb://` string picks Mongo; missing `MONGODB_URI` message contains `MONGODB_URI` and `markets.nasdaq.symbols.store`; unknown value message lists the three valid values; `mongodb` on cloudflare throws; the info log carries `host` and never the password; `new MarketSymbols()` with default config still builds the SQLite temp-file store (`${getTempDir()}/NasdaqSymbols.sqlite`, `MarketSymbols.ts:144-150`).
- [ ] **Step 2: Run to fail; Step 3: implement; Step 4: run** `NO_COLOR=1 ./node_modules/.bin/vitest run src/nasdaq` from `ts-markets` and `./node_modules/.bin/vitest run src/configs` from `ts-core` — Expected: pass (no existing config test lists keys exhaustively; if one fails on the new keys, update that expectation, which is a contract change, and say so).
- [ ] **Step 5: Commit** — `feat(ts-markets): choose the symbol store by config (sqlite, turso, mongodb)`.

### Task 7: Packaging for Lambda, Cloud Run and the Worker

**Files:** Modify `ts-cloud/tsup.config.ts` (Cloudflare `external` list, next to `"basic-ftp"` at `:43`), `ts-cloud/wrangler.toml` (alias block, `:19`), `ts-cloud/README.md` (alias list, `:188`), `scripts/package-lambda.sh` (smoke test `:43-65`).

- [ ] **Step 1: Add `"mongodb"` to the Cloudflare `external` list and the alias `"mongodb" = "./src/platform/cloudflare/server-dep-stub.mjs"` to `wrangler.toml` and the README block** (the stub's header comment may name `mongodb` in its list).
- [ ] **Step 2: Build and inspect.** `pnpm --filter ./ts-core build && pnpm --filter ./ts-markets build && pnpm --filter ./ts-cloud build`. Expected: succeeds. Run `grep -l "MongoServerSelectionError" ts-cloud/dist/aws/* ts-cloud/dist/cloudrun/*` — Expected: a chunk in each (the driver is bundled, `noExternal: [/.*/]`); `grep -c mongodb ts-cloud/dist/cloudflare/worker.js` shows only the bare specifier, no driver code. If esbuild warns about unresolved optional extras (`snappy`, `kerberos`, `@mongodb-js/zstd`, `aws4`, `mongodb-client-encryption`), add exactly those names to `external` for the AWS and Cloud Run entries only, and rebuild.
- [ ] **Step 3: Extend the smoke test.** In `package-lambda.sh` after the `/health` check, find the bundled chunk containing `MongoServerSelectionError` and `import()` it inside the Lambda image, failing if evaluation throws (proves the driver and its optional-dependency handling load on AL2023). No `ts-cloud` route constructs `MarketSymbols` today, so a route-level probe is not possible; the static plus load check is the proof.
- [ ] **Step 4: Run** `bash scripts/package-lambda.sh` (needs docker via `/usr/bin/sg docker -c`; first run is slow) — Expected: `smoke ok` lines for `/health` and the driver, and a built `ts-cloud/dist/function.zip`. Then pack the three packages into a scratch directory (`pnpm --filter ./ts-core --filter ./ts-markets --filter ./ts-cloud pack --pack-destination <scratch>`) and run `node scripts/check-package-entries.mjs <scratch>/*.tgz` — Expected: three `ok ... entry points present` lines (run with no arguments the script checks nothing and exits 0, so never run it bare) — and `pnpm check:browser-bundle` — Expected: passes. Report the zip size change.
- [ ] **Step 5: Commit** — `build(ts-cloud): bundle mongodb for Node targets, alias it out of the Worker`.

### Task 8: CI, docs and roadmap

**Files:** Modify `.github/workflows/pipeline.yml` (new Linux-only steps before `Run all tests`, `:~150`), `ts-markets/README.md` (§7, line 234), `ts-cloud/README.md` (deploy section), `ROADMAP.md`.

- [ ] **Step 1: CI steps.** Add, before `Run all tests`, one step with `if: matrix.os == 'ubuntu-latest'` that starts a pinned MongoDB (`docker run -d --name mongo-test -p 27017:27017 mongo:8.0.34`, matching the locally measured 8.0.34; if the tag does not exist or will not start on the runner, fall back to downloading a pinned `mongod` tarball), waits at most 60 s for `docker exec mongo-test mongosh --quiet --eval 'db.runCommand({ping:1}).ok'` to print `1` (the host runner does not provide `mongosh`; run it inside the container), and appends `CORELIB_TEST_MONGODB_URI=mongodb://127.0.0.1:27017` and `CORELIB_REQUIRE_MONGODB=1` to `$GITHUB_ENV`. No other leg sets either variable. Do not add `services:`.
- [ ] **Step 2: Docs.** `ts-markets/README.md` §7: the `store` setting, how to set it (`CORELIB_MARKETS_NASDAQ_SYMBOLS_STORE=mongodb` plus `MONGODB_URI`; the `*Env` keys need a config file or CLI), Turso variables, the starts-empty rule, MongoDB on Atlas from Lambda (no fixed IP, so the network access list must allow it), Worker stays on Turso. `ts-cloud/README.md`: one deploy note with the same variables. `ROADMAP.md`: a Testing/Storage entry noting there is no CHANGELOG file in this repo.
- [ ] **Step 3: Verify locally.** `bash scripts/mongod-test.sh start`, then from the repo root `eval "$(bash scripts/mongod-test.sh env)" && pnpm test-all:coverage` — Expected: pass with the floors in `ts-markets/vitest.config.ts:8-17` met with the Mongo suites running; then stop the server. Run `./node_modules/.bin/vitest run` with the variable unset in `ts-markets` — Expected: pass, Mongo suites skipped with a message.
- [ ] **Step 4: Commit** — `ci(ts-markets): run the real-MongoDB suites on the Linux leg; document the store setting`.
- [ ] **Step 5: Remote proof (once, after the user authorises a push).** Push and read the `Test (ubuntu-latest)` job: the MongoDB start step is green, the Mongo suites ran (not skipped), the coverage step passed; macOS and Windows legs passed with the suites skipped. If the image will not start on the runner, apply the tarball fallback and re-run once. Do not poll in a loop.

### Task 9: Whole-branch verification

- [ ] **Step 1:** From the repo root with the throwaway server up and `CORELIB_TEST_MONGODB_URI` set: Biome (`ts-core/node_modules/.bin/biome check ts-markets ts-cloud scripts`), `tsc --noEmit` in `ts-core`, `ts-markets` and `ts-cloud`, `pnpm test-all:run`, `pnpm build-all`. Expected: all green; `git status` shows only the files named in this plan.
- [ ] **Step 2:** Re-measure the spec's claims that this plan relied on: the unreachable-host error text has no password (Task 5 test), a stale flip matches 0 documents (Task 5 test), `client.db()` is `test` for a path-less URI (covered by `resolveDatabaseName`).
- [ ] **Step 3:** Run the AGY-CAPSTONE review on the committed range (rounds until green, verify each finding and its suggested fix by measurement; green is human-adjudicated), then AGY-TEST-AUDIT. Do not declare the plan complete before the capstone.
