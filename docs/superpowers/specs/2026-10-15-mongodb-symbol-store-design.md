# MongoDB symbol-directory store — design

Date: 2026-10-15. Status: draft for the owner's approval. Package: `ts-markets` (with packaging changes in `ts-cloud` and CI).

## Intent and why

The Nasdaq symbol directory (about 12,000 rows from `nasdaqlisted.txt` and `otherlisted.txt`) is kept by `MarketSymbols`
(`ts-markets/src/nasdaq/MarketSymbols.ts`) in a SQLite database. The owner wants that data in **MongoDB**, shared across
machines and usable from AWS Lambda, and wants to keep **Turso** and **SQLite** available. The owner picks the storage
per deployment with a configuration setting.

Today `MarketSymbols` only uses Turso when the caller passes `{ dbUrl, dbToken }` or a `libsql://` string; with no
argument it writes a SQLite file in the temp directory (`MarketSymbols.ts:144-150`). The `CORELIB_TURSO_URL` and
`CORELIB_TURSO_TOKEN` variables are read only by the `ts-cloud` SQL endpoint (`ts-cloud/src/core/router.ts:65-68`), not by
`MarketSymbols`. So on Lambda the symbol store is currently a per-container temp file. This design fixes that for all
three backends: the config setting, not code, decides where the symbols live.

## Goals

1. A `markets.nasdaq.symbols.store` setting selects `"sqlite"` (default, today's behaviour), `"turso"` or `"mongodb"`.
2. A MongoDB store that works on Node and AWS Lambda (and Cloud Run, which is also Node).
3. The refresh keeps today's guarantee: the old symbol set stays visible until the new set is completely written, and
   a failed refresh leaves the old set untouched (pinned today by `MarketSymbols.refresh-failure.test.ts`).
4. Tests run against a **real MongoDB**: a throwaway `mongod` locally, a service container in CI.
5. Existing callers and tests keep working: `new MarketSymbols()`, `new MarketSymbols(path)`,
   `new MarketSymbols({ dbUrl, dbToken })` and `new MarketSymbols(databaseInstance)` behave as before.

## Non-goals

- Streaming data and any other table or collection. Only the symbol directory moves.
- A general MongoDB layer next to `createDatabase`. This is a store for one data set behind a small interface.
- MongoDB on Cloudflare Workers. The Worker stays on Turso; the official driver needs raw TCP.
- Migrating existing rows. Switching backend starts empty and fills from the first Nasdaq refresh.
- A distributed refresh lease (the owner decided against it for v1; see "Concurrent refreshes").

## Anti-goals (a failure even if it technically works)

- A refresh that can leave readers seeing a mixed or partial symbol set.
- Credentials in checked-in JSON or in logs (connection strings must be redacted when logged).
- MongoDB driver types appearing in the public exports of `@ckirg/corelib-markets`, or the driver being loaded on
  Workers or at import time for users who never select MongoDB.
- Changing the SQLite and Turso behaviour or the SQL statements they run today.

## Constraints

- `MarketSymbols.ts` is 866 lines and mixes freshness logic, download and retry, parsing and SQL. Storage must be
  separated out; do not add a MongoDB branch into the SQL code.
- The existing refresh safety nets stay in `MarketSymbols`, not in the stores: the `minRows` guard
  (`:552-562`), retry and circuit breaker (`:650-751`), the New York "refreshed today" rule (`:520-526`), background
  refresh and the hourly freshness check (`:466-501`).
- Keep the repo's gates: strict TypeScript, Biome, Vitest, the browser-bundle check
  (`scripts/check-browser-bundle.mjs`), cargo and TS CI. Tests that write to a store use real databases, not mocks of
  `db.query` (mocked `db.query` hid a real defect before; see the comment at the top of
  `MarketSymbols.refresh-failure.test.ts`).
- `ts-cloud`'s AWS bundle is a single `handler.mjs` built with `noExternal: [/.*/]` and `function.zip` contains no
  `node_modules` (`ts-cloud/tsup.config.ts`, `scripts/package-lambda.sh`).

## Decisions (the owner's, as decided)

- Symbol directory only, behind a small interface; MongoDB, Turso and SQLite all stay.
- Chosen by a configuration setting per deployment.
- MongoDB on Node and Lambda only; the Worker stays on Turso.
- Switching backend starts empty; no migration.
- Real MongoDB in tests (local and CI service container).
- No refresh lease in v1; the agreed concurrency design below was negotiated with the agy reviewer and accepted by the
  owner's instruction to settle on one agreed option.

## The design

### Store interface

A `SymbolStore` in `ts-markets/src/nasdaq/` (suggested file `symbolStore.ts`). It is persistence only; no timezone,
retry or parsing logic.

```ts
export interface SymbolStore {
  init(): Promise<void>;                              // create table/indexes/collection; idempotent
  find(symbol: string): Promise<MarketSymbolRow | null>; // active row; the store upper-cases `symbol` itself (idempotent)
  lastRefreshTs(): Promise<number | null>;            // ms epoch of the newest refresh, null if never populated
  count(): Promise<number>;                           // rows held (SQL: COUNT(*) as today, MongoDB: documents of the current generation); 0 when empty
  replaceAll(rows: MarketSymbolRow[], refreshTs: number): Promise<void>; // atomic swap; throws on failure or when `rows` is empty, old set stays visible
  close(): Promise<void>;
}
```

- `SqlSymbolStore` wraps a `Database` and runs today's SQL unchanged (table `nasdaq_symbols`, the `active` column,
  the single transaction with batched upserts). It takes `isDbOwner` so an injected `Database` is not disconnected.
- `MongoSymbolStore` is new (below).
- `MarketSymbols` calls the store instead of `db.query`. `needsRefresh()` becomes `lastRefreshTs()` plus the existing
  New York date comparison; `hasExistingData()` becomes `count() > 0`; `searchDb()` becomes `find()`.
- The constructor still accepts `string | { dbUrl, dbToken } | Database`. It now also accepts a `SymbolStore`
  (used by tests and advanced callers). A string starting with `mongodb://` or `mongodb+srv://` selects the MongoDB
  store.

### Selecting the backend

Precedence: **a constructor argument always wins** over configuration. With no argument, `ConfigManager` key
`markets.nasdaq.symbols.store` decides:

| value | behaviour |
|---|---|
| `"sqlite"` (default) | `${getTempDir()}/NasdaqSymbols.sqlite`, as today |
| `"turso"` | libsql URL and token from the environment variables named by `markets.nasdaq.symbols.turso.urlEnv` / `tokenEnv` (defaults `CORELIB_TURSO_URL`, `CORELIB_TURSO_TOKEN`) |
| `"mongodb"` | connection string from the environment variable named by `markets.nasdaq.symbols.mongodb.uriEnv` (default `MONGODB_URI`) |

Further keys: `markets.nasdaq.symbols.mongodb.database` (default `corelib`) and `...mongodb.collection`
(default `nasdaq_symbols`). Add the keys with defaults to `ts-core/src/configs/ConfigManager.json`. Credentials are
read from the environment only, never stored in config. An unknown `store` value, or `mongodb`/`turso` with the named
environment variable missing, throws a clear error at store creation (not a silent fall back to SQLite).

### MongoDB store: data model

One collection holds symbol documents and one metadata document.

- Symbol document: `{ symbol, type, class, name, ts, gen }`. `symbol` is stored upper-case. `ts` is a **plain number**
  (milliseconds), never a BSON `Date`, so `DateTime.fromMillis(ts)` keeps working. Every stored symbol is active;
  there is no `active` field (inactive rows exist only in SQL as a swap mechanism). `find` returns a `MarketSymbolRow`
  with `active: true`.
- Metadata document: `{ _id: "meta", nextGen, currentGen, lastRefreshTs }`.
- Indexes created in `init()`: unique `{ symbol: 1, gen: 1 }` and `{ gen: 1 }`.

### MongoDB store: refresh without transactions

Multi-document transactions need a replica set, which a plain local or CI `mongod` does not have. The swap therefore
uses a generation number and one atomic single-document flip. `replaceAll(rows, refreshTs)` does (`refreshTs` is the `now` that `performRefresh` stamps on every row, `MarketSymbols.ts:577-581`; `SqlSymbolStore` ignores it because the rows already carry it; `MarketSymbols` never passes an empty array because its `minRows` guard runs first, `:552-562`, and both stores reject one anyway):

1. Take a generation: `findOneAndUpdate({_id:"meta"}, {$inc:{nextGen:1}, $setOnInsert:{currentGen:0, lastRefreshTs:0}}, {upsert:true, returnDocument:"after"})`; `myGen = nextGen`.
2. Insert all rows tagged `gen: myGen` (unordered batched `insertMany`; batch size is the builder's call).
3. Flip forward only: `updateOne({_id:"meta", currentGen:{$lt: myGen}}, {$set:{currentGen: myGen, lastRefreshTs: refreshTs}})`.
   If it matches nothing, a newer refresh already won: delete this refresh's rows (`deleteMany({gen: myGen})`, errors
   logged and swallowed) and return successfully.
4. Prune: `deleteMany({_id:{$ne:"meta"}, gen:{$type:"number", $lt: currentGen - 1}})` (the previous generation is kept
   for in-flight reads). Prune errors are logged, not thrown; the next refresh prunes again.
5. If any insert in step 2 fails, `currentGen` has not moved, so readers still see the old set; best-effort delete of
   this generation's rows, then throw (so `MarketSymbols` treats the refresh as failed, as it does for SQL).

`find(symbol)` reads `currentGen` and then the document `{symbol, gen: currentGen}`. An in-process cache of
`currentGen` is allowed with a time-to-live of at most 5 s measured on the wall clock, and a `find` that misses while using a
cached generation must re-read `currentGen` once and retry before reporting a miss (pruning keeps only the current and
previous generation, so a long-lived stale cache would otherwise miss every symbol).
`lastRefreshTs()` reads it from the metadata document (null when `currentGen` is 0 or the document is missing).
The metadata `lastRefreshTs` is the **row `ts` value** that `replaceAll` was given (the single `now` that `performRefresh`
stamps on every row, `MarketSymbols.ts:577-581`), not the time of the flip, so it means the same as SQL's `MAX(ts)`
and the New York "refreshed today" comparison cannot disagree between backends at midnight.
`count()` counts documents with `gen: currentGen` (the metadata document is never counted).

Verified by measurement on `mongod` 8.0.34: a stale flip matches 0 documents; a unique `{symbol, gen}` index builds
with the metadata document present; the prune filter `gen < n` does not match the metadata document (the extra
`$ne:"meta"` and `$type` guards are defence in depth).

### Concurrent refreshes (no lease)

Several instances may all see "stale" at the first call after New York midnight. The generation counter gives each its
own number, the forward-only flip lets the newest win, and pruning never touches a newer in-progress generation, so
overlapping refreshes are safe. To cut duplicate work, rely on the check `performRefresh` already makes before it
downloads (`MarketSymbols.ts:536`, `needsRefresh()`): with a shared store it now sees a refresh done by another
instance, which a per-container SQLite file never could. Keep that check immediately before the download. The accepted residue: simultaneous cold starts can each
download once. A crash at any point only leaves unreachable rows; because pruning keeps the previous generation, they are removed within the next two successful refreshes (measured by the Task 5 test).

### Connection handling

`mongodb` is loaded with a dynamic `import()` inside `MongoSymbolStore` (one shared import promise, as
`symbolFiles.ts` does for `basic-ftp`). On Lambda (`detectRuntime() === "aws-lambda"`) use a small pool
(`maxPoolSize` 1–2) and short timeouts (`serverSelectionTimeoutMS` and `connectTimeoutMS` about 5000), and reuse the
client across warm invocations (module-scoped). Elsewhere use driver defaults unless config says otherwise.
The `MongoClient` is shared through a module-level registry keyed by connection string with a reference count: each
store takes a reference at `init()` and releases it in `close()`; the client is closed when the last reference is
released, so `ApiNasdaqQuotes.close()` and test teardown (`afterEach(() => ms.close())`) leave no sockets or heartbeat
timers behind, and a warm Lambda invocation that never closes keeps reusing one client. An injected `SymbolStore` is never
closed by `MarketSymbols` (as an injected `Database` is not, `MarketSymbols.ts:237-239`). At initialisation log the selected backend and, for MongoDB or
Turso, the host (never the credentials or the full URI) at info level, so an operator can see which store a deployment
actually uses. Connection strings are redacted when logged.

### Packaging

- `ts-markets/package.json`: add `mongodb` as a dependency (the same way `basic-ftp` is).
- `ts-cloud/tsup.config.ts`: **bundle** `mongodb` into the AWS and Cloud Run handlers (they have no `node_modules`);
  add it to the Cloudflare `external` list. If esbuild warns about the driver's optional native extras
  (`snappy`, `kerberos`, `@mongodb-js/zstd`, `aws4`, etc.), mark exactly those external for the Node bundles.
- `ts-cloud/wrangler.toml`: alias `mongodb` to `src/platform/cloudflare/server-dep-stub.mjs`; add the line to the
  README alias list too.
- `scripts/package-lambda.sh`'s smoke test must additionally prove the bundled driver loads in the Lambda image.
- Do not export MongoDB types from `ts-markets/src/index.ts`; keep them behind `import type` inside the store. Do export
  the `SymbolStore` interface and `SymbolStoreUnavailableError` so callers can pass their own store to `MarketSymbols`.
- Check that `scripts/check-browser-bundle.mjs` and the package-entry check still pass.
- `mongodb` becomes an installed dependency of `@ckirg/corelib-markets` for every consumer (the same way `basic-ftp`
  is), even though it is only loaded when selected. Making it an optional peer instead is possible but means users
  install it themselves; this document picks the plain dependency (author's call, see the last section).

### Testing

- `SqlSymbolStore`: the existing `MarketSymbols` tests, including `MarketSymbols.refresh-failure.test.ts` (real
  in-memory SQLite), must pass unchanged in meaning. Add store-level tests for the interface contract run against both
  stores (same suite, two implementations): find is case-insensitive on input, `replaceAll` is all-or-nothing,
  `count`/`lastRefreshTs` on an empty store, `close`.
- Test isolation: Vitest runs test files in parallel and every file shares the one `mongod`, so each test file builds its
  store with its own uniquely named database (explicit `database` option, name includes the file and a random suffix) and
  drops that database in teardown, including when a test fails. No test depends on the default `corelib` database.
- `MongoSymbolStore` against a real `mongod`:
  - round trip; `ts` stays a number; symbol lookup is case-insensitive on input;
  - a failing insert (for example a unique-index violation from a duplicate symbol in one batch) leaves the previous
    set fully visible and `lastRefreshTs` unchanged;
  - two overlapping refreshes: the newest flips, the older deletes its own rows, readers never see a mixed set;
  - a refresh interrupted before the flip leaves old data visible and the orphan rows are pruned by the next refresh;
  - the prune never removes the metadata document or a newer generation;
  - switching backend starts empty (`count()` 0, `lastRefreshTs()` null) and the first refresh populates it.
- A failed connection (unreachable host, bad SRV name, malformed URI) produces errors whose message and serialized form
  contain no part of the password in the URI (measured today with `mongodb` 7.7.0; this test guards driver upgrades).
- `MarketSymbols` with a `MongoSymbolStore`: the stale-data-served-while-refreshing and "refreshed today, skip
  download" behaviours work as with SQL.
- Local runs start a throwaway `mongod` on a spare port and temp directory (the installed `mongod` 8.0.34 runs
  natively; the `mongo:8` Docker image refuses to start on Linux kernel 6.19+, which this development machine has).
  The tests need the connection string from an environment variable (suggested `CORELIB_TEST_MONGODB_URI`) and **skip
  with a visible message** when it is absent so a plain `pnpm test` still passes. On the CI Linux leg the skip must not be possible: that leg sets an explicit
  switch `CORELIB_REQUIRE_MONGODB=1` (never inferred from `CI`, which GitHub Actions sets on every runner including the
  matrix legs), and when the switch is set and the connection variable is missing the Mongo suites **fail** instead of skipping, so a mis-wired service
  container cannot produce a green run with no MongoDB coverage. Provide a helper
  script to start and stop the throwaway instance, and declare `mongod` in `.claude/recommended-tools.json`.
- CI: the `test` job in `.github/workflows/pipeline.yml` is one matrix job over `ubuntu-latest`, `macos-latest` and
  `windows-latest` (`:99-107`), and service containers exist only on Linux runners and cannot be switched per matrix leg,
  so a `services:` block would fail the macOS and Windows legs. Steps *can* be switched per leg, so the Linux leg gets
  an ordinary step (`if: matrix.os == 'ubuntu-latest'`) that starts a pinned MongoDB (a pinned `mongod` binary, or
  `docker run` of a pinned image), waits until it answers, and exports `CORELIB_TEST_MONGODB_URI` and
  `CORELIB_REQUIRE_MONGODB=1` to the later steps of that leg. This keeps the existing Linux steps unchanged, in
  particular `Coverage thresholds (Linux only)` (`pnpm test-all:coverage`, `pipeline.yml:162-166`): `ts-markets` enforces
  coverage floors of 89/79/90/90 over every `src/**/*.ts` (`ts-markets/vitest.config.ts:8-17`), so the Mongo suites must
  run inside that step or `MongoSymbolStore.ts` would count as uncovered. The macOS and Windows legs leave both variables
  unset and the Mongo suites skip with a visible message. On the Linux leg `CORELIB_REQUIRE_MONGODB=1` makes a missing
  connection variable fail the run. Pin the MongoDB version and prove it starts on the runner: MongoDB 8 refuses to
  start on Linux kernel 6.19 or newer (SERVER-121912), so the version must be started on the current `ubuntu-latest`
  runner and re-checked when the runner image moves to a newer kernel. Developers who run `pnpm test:coverage` locally
  need the throwaway `mongod` script running, or the floors will fail locally for the same reason.

### Documentation

README of `ts-markets` (backend setting, environment variables, Lambda notes including that a Lambda outside a VPC has no
fixed IP address, so a MongoDB Atlas deployment must allow Lambda's traffic through its network access list, private
networking or an allow-all rule chosen by the operator), `ts-cloud` README (deploy section: set
`MONGODB_URI` and `markets.nasdaq.symbols.store`), the `ConfigManager.json` keys, and a CHANGELOG/ROADMAP entry.

## Behaviour when the store misbehaves, and lifecycle (calls made after review)

- **Two error classes, handled differently.** Stores throw a `SymbolStoreUnavailableError` for connection-class failures
  (server selection or connect timeout, network reset, auth failure at connect); anything else is an ordinary error.
  - *Ordinary errors keep today's semantics for every backend:* a failing `find` is logged and treated as "not in the
    store" so lookup falls through to the Nasdaq API (as `searchDb` does, `MarketSymbols.ts:393-398`); a failing
    `lastRefreshTs()` counts as "needs refresh" (`:515`) and a failing `count()` as "no existing data" (`:765-768`); a
    store that cannot be initialised throws from `refresh()` and from the first lookup, as SQL does.
  - *`SymbolStoreUnavailableError` overrides the line above.* It opens a **circuit breaker** in `MarketSymbols` for a short,
    configurable period (default 30 s). While it is open: `find` skips the store without waiting and falls through to the
    Nasdaq API; `lastRefreshTs()`/`count()` are not called, so **no download is triggered** (an unreachable store is not
    an empty or stale one); `ensureInitialized()` fails fast with the same error instead of retrying the connection;
    `refresh()` throws it. The breaker closes on the next successful call after the period. The check for the breaker
    comes before any freshness evaluation (`initialize()` at `:453-458` must not reach `performRefresh()` while it is open).
    Without it every lookup during an outage waits out the driver's server-selection timeout (about 5 s on Lambda).
    What `get()` callers observe (a result or `null`, never a thrown store error) does not change.
- **Initialisation stays lazy.** The constructor remains synchronous and does no I/O. `MarketSymbols` calls
  `store.init()` from `ensureInitialized()` for every store, including an injected `Database` (wrapped) or an injected
  `SymbolStore`; `init()` is idempotent.
- **Worker and non-Node runtimes.** Configuration-based selection reads credentials through ts-core's runtime-aware
  `getEnv`. The Worker keeps passing explicit constructor arguments (which win over config), so nothing changes there;
  MongoDB selection is rejected with a clear error on the Cloudflare runtime.
- **Existing tests.** `MarketSymbols.test.ts` (38 references to a mocked `db.query`/`Database`) and the refresh-failure test
  keep passing because `SqlSymbolStore` issues the same `db.query` calls and the same transaction; the refresh-failure
  test also reads the private `backgroundRefresh` field, so that field must stay. Tests that assert on MongoDB use the real
  `mongod`. No test is rewritten to match code.
- **MongoDB database name**, in order of precedence: an explicit `database` option passed to the `MongoSymbolStore`
  constructor (used by tests), then the database named in the URI path when there is one, then
  `markets.nasdaq.symbols.mongodb.database` (default `corelib`). Detect "there is one" by parsing the URI path yourself:
  with no path, `client.db()` silently returns the database `test` (measured with `mongodb` 7.7.0 for `mongodb://host`,
  `mongodb://host/` and `mongodb://host/?x=1`), which must never be used. Use a parser that handles multi-host
  replica-set URIs (the driver's own connection-string parser).

## Left to the builder

File and function naming beyond what is suggested above; insert batch size; whether to cache `currentGen` in process
(at most 5 s, see above); exact `mongodb` driver major version (use a current release that supports Node 24); which optional
native extras actually need to be marked external; the pinned MongoDB version and whether the Linux CI step uses a binary or `docker run`; how to share the
contract-test suite between the two stores.

## Open for the owner's attention

Calls made in this document by the author, not the owner: the config key names and the environment-variable
indirection (`uriEnv`, `urlEnv`, `tokenEnv`) and defaults; selecting Turso for the symbol store from
`CORELIB_TURSO_URL`/`CORELIB_TURSO_TOKEN` (the same variables the SQL endpoint uses); MongoDB database and collection
defaults and the URI-path-then-config rule for the database name; the error semantics, lazy `init()` and Worker rules in the section above; no `active` field in MongoDB; `mongodb` as a plain dependency rather than an optional peer; skipping Mongo tests when `CORELIB_TEST_MONGODB_URI` is unset.

## Stand-downs

Recorded by the adversarial panel review of 2026-10-15 (five rounds with the agy peer, plus a solo pass; seats: the ten
palette seats that apply plus three bespoke ones, CI and Release Engineer, Test Harness Engineer and Public API and
Release Compatibility Engineer; Activation Auditor was dropped in the solo pass because nothing in the document is an
auto-discovered component, and seated from round 2).

- `REJECTED: driver errors leak the connection password` - with `mongodb` 7.7.0 an unreachable host, a bad SRV name and a
  malformed URI produced errors with no part of the password in the message or the serialized error; a regression test
  is specified instead.
- `DISCARDED-BELOW-FLOOR: insertMany batch size unspecified on small Lambda memory` - unreachable as a defect because
  "insert batch size" is listed under "Left to the builder" and the insert is chunked by design (step 2 of the refresh).
- `DISCARDED-BELOW-FLOOR: missing maxIdleTimeMS for frozen Lambda sockets` - the driver reconnects on error and the circuit
  breaker bounds the wait ("Two error classes, handled differently").
- `DISCARDED-BELOW-FLOOR: other CI jobs need needs: wiring for a Mongo job` - moot: there is no separate Mongo job; the
  Mongo suites run in the existing Linux leg ("CI:" bullet under "Testing").
- `DISCARDED-BELOW-FLOOR: exact file naming for Mongo suites` - left to the builder; the Linux leg runs the whole
  `ts-markets` suite, so no filter is needed.
- `DISCARDED-BELOW-FLOOR: readiness timeout and cleanup step for the CI MongoDB` - the hosted runner VM is destroyed after
  the job; a bounded wait is an implementation detail of the step the builder writes.
- `DISCARDED-BELOW-FLOOR: metadata in a separate collection` - the document fully specifies one collection with
  `_id: "meta"`; either layout satisfies the stated behaviour.
- `UNVERIFIED-ACCEPTED` none. Claims that rest on GitHub Actions documented behaviour and could not be measured here:
  service containers are Linux-only and `CI=true` is set on every runner; the design does not depend on either being
  wrong.
