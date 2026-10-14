# Corelib Architecture

Monorepo of isomorphic TypeScript packages plus a native Rust core. All TS code runs on
**Node.js, Bun, and Deno** (plus edge: Cloudflare Workers, AWS Lambda, GCP Cloud Run, browsers).

## 1. Package map

```
ts-core (@ckirg/corelib)            base: FFI bridge, logging, resilient HTTP, config, DB
  ^                         ^
  |                         |
ts-markets                  |         market data (Nasdaq/Yahoo/Alpaca/Finnhub)
(@ckirg/corelib-markets)    |
  ^                         |
  |                         |
ts-cloud (@ckirg/corelib-cloud)     edge proxy routers (Hono) on Workers/Lambda/Cloud Run

rust (corelib-rust, cdylib)  <-->  ts-core via N-API (corelib-rust.node)
```

Dependency rules: `ts-cloud` → `ts-core` + `ts-markets`; `ts-markets` → `ts-core` only;
nothing depends on `ts-cloud`. TS packages consume each other via `workspace:*`
(`pnpm-workspace.yaml`). All packages are `"type": "module"`, bundled with `tsup`.

## 2. Runtime matrix

`ts-core/src/utils/runtime.ts` — `detectRuntime(): node | bun | deno | cloudflare | aws-lambda |
gcp-cloudrun` (honors `RUNTIME=` override). Runtime selection drives:

- **Loggers** (`ts-core/src/loggers/`): top-level-await dynamic loader picks
  `implementations/{node,bun,deno,cloudflare,lambda,gcp}.ts` and sets `globalThis.logger`.
- **FFI** (`ts-core/src/core/index.ts:55-141`): `loadFFI()` probes `corelib-rust.node` candidate
  paths via `createRequire`; returns `null` (FFI disabled) on miss — always `null` on Cloudflare.
  Singleton cached on `globalThis`.
- **Edge builds**: `types/edge-runtime.ts` declares `__EDGE_RUNTIME__` to gate Node-only imports;
  `ts-core/src/browser.ts` exports the edge-safe subset (logger types + browser logger + `nextCid`).

## 3. ts-core modules

| Directory | Owns |
|---|---|
| `src/configs/` | `ConfigManager` event-driven lifecycle for `globalThis.sysconfig`; priority CLI > env > files > defaults (deepmerge leaf-overwrite, prototype-pollution guard); AES-256-CBC `.enc` decrypt via `CORELIB_AES_PASSWORD` |
| `src/core/` | FFI bridge: `coreFFI`, `isFfiAvailable()`, `logAndDouble(msg, value)`, `getVersion()`, `Core`; `ffi-types.ts` mirrors the Rust N-API surface |
| `src/loggers/` | `StrictLogger` / `LogMethod` contract `(msg: string, extras?: object)`; child bindings; cycle-safe auto-serialization of `Error` in extras (`common/normalize-extras.ts`); per-runtime pino adapters |
| `src/retrieve/` | `RequestUnlimited.ts`: `ky` wrapper `endPoint<T>` / `endPoints<T>` → `RequestResult<T>` discriminated union, full-jitter retry (429/5xx), clamped timeouts, URL redaction, `cid` tracing. `RequestProxied.ts`: same API over a rotating proxy pool (round-robin, 3-strike eviction). `RequestResponseSerialize.ts`: `SerializedResponse<T>` normalization |
| `src/database/` | Dialect-agnostic `Database / Driver / Result / TransactionContext` interfaces (`core/`); `PostgresDb` (`postgres` lib) and `SqliteDb` (`@libsql/client`) impls; opt-in `defaultRedactor` (JWT/hex/b64 masking) |
| `src/utils/` | Isomorphic env/fs helpers, `SysInfo` telemetry, `cron.ts` (`croner`), `flight-recorder.ts` (`nextCid()` + `FlightRecorderExtras` for TRACE pairing) |

## 4. Cross-cutting conventions

- **Strict logger API**: `(msg: string, extras?: object)`. Scalars may interpolate into `msg`;
  structured objects go into `extras` as named keys. Never `console.*` in app code.
- **Child loggers**: every module uses `logger.child({ section })`.
- **Levels**: `trace` = per-item hot-path, `debug` = per-operation summaries/state transitions,
  `info` = significant lifecycle events only.
- **Correlation**: `nextCid()` stamps requests; log `loadFFI`/retry/proxy decisions at
  `trace`/`debug` so `LOG_LEVEL=trace` reconstructs the decision chain.
- **Redaction**: secrets are masked at the boundary (`safeUrl`, `defaultRedactor`), never ad hoc.

## 5. ts-markets — market data logic (no transport code)

- **Nasdaq REST** (`src/nasdaq/ApiNasdaqUnlimited.ts`): `endPoint` + `getNasdaqHeaders()` spoof
  injection, headers/chrome version from `ConfigManager`; `ApiNasdaqQuotes.ts` fans out with
  `concurrencyLimit=5`, direct or via `RequestProxied`. Symbols/asset classes (`MarketSymbols`,
  `Top100`), `MarketStatus`, `MarketMonitor`, `CnnFearAndGreed`.
- **Polling/history** (`datafeeds/polling/`): `Historical` injects a `corelibFetchAdapter`
  (`RequestInit` → `endPoint`) into `yahoo-finance2`; `YahooHistoricalProvider` maps to
  `HistoricalQuote[]`. `NasdaqPolling` bridges to cloud proxy URLs.
- **Streaming** (`datafeeds/streaming/`): thin `EventEmitter` wrappers over Rust FFI classes
  `coreFFI.{Yahoo,Alpaca,Finnhub}Streaming` (0-arg ctor throws synchronously without FFI);
  `StreamHealthTracker` monitors liveness. Callbacks cross the boundary via N-API
  `ThreadsafeFunction`, so the Node event loop never blocks.

## 6. ts-cloud — transparent edge proxy (Hono)

`src/core/router.ts`: `createRouter(logger)` mounts `/api/v1/{ky, markets/nasdaq…,
markets/nasdaq/status, markets/nasdaq/historical, sql, tests}` plus `/health`; per-request
`rid=nextCid()`.

- **Single-URL**: `POST / {url, options}` → `endPoint(url, …)` → success returns the target
  **body and status directly** (`c.json(result.value.body, result.value.status)`); errors return
  the `RequestResult` envelope with the reason's status. `GET /?url=` variant for `RequestProxied`.
- **Bulk**: `POST / {url, options}[]` → `Promise.all(…endPoint)` → `c.json(RequestResult[], 200)`.
- MarketStatus/SQL are single-shot only (no bulk).
- **Backends**: `markets/nasdaq/*` delegates to `ts-markets`; `sql` runs
  `createDatabase({dialect: sqlite, mode: stateless})` against Turso (`CORELIB_TURSO_URL/TOKEN`
  bindings); `ky` re-exposes `ts-core` `RequestUnlimited`.
- **Platforms**: Cloudflare Worker (`platform/cloudflare/worker.ts`, `nodejs_compat`, Node-only
  deps aliased to `server-dep-stub.mjs`), AWS Lambda (`platform/aws/handler.ts`),
  Cloud Run (`platform/cloudrun/server.ts` on `:3000`, own `Dockerfile`).

## 7. Rust core (`rust/`, `corelib-rust v0.3.0`, edition 2021)

- `[lib] crate-type = [cdylib, rlib]`; N-API via `napi 3.9` + `napi-derive`, `napi-build` setup
  in `build.rs`. Feature seam: `default = [finnhub, napi]` with a `compile_error!` tripwire
  (`src/lib.rs:19-24`) if `--no-default-features`.
- **FFI surface** (only `#[napi]` items reach TS): `logAndDouble(String, i32) → i32`,
  `getVersion() → String`, flight-log/latency/diagnostic probes (`napiDumpFlightLog`,
  `napiLatencyAck/Drain`, `napiTriggerDiagnosticFlood`, `napiLoadGenerator` — no-ops unless
  their `CORELIB_*` env gates are set), and `YahooStreaming` / `AlpacaStreaming` /
  `FinnhubStreaming` classes (`new(callbacks)` → `init(config)` → `start()` →
  `subscribe/unsubscribe` → `stop()/clean()`).
- **Pure-Rust internals** (not directly callable from TS): `retrieve::{ky, unlimited, proxied}`,
  Nasdaq quote/status/header helpers, WS drivers, reconnect/schema core, `include_exclude_cron`.
- **CLI bins** (`--features clap`): `yahoo_streamer`, `alpaca_streamer` (JSON-lines stdout),
  `nasdaq_polling` (NDJSON daemon; not shipped in releases).
- **`.node` propagation**: never committed (`Clean.ps1` deletes it). Local dev builds with
  `napi build --release` and copies to `ts-core/corelib-rust.node`. CI builds it in Docker and
  `docker cp`s it into `ts-core/` before tests. Consumers get it via `ts-core` postinstall,
  which downloads `corelib-rust-<target>.node` from the GitHub Release. `ts-cloud` postbuild
  copies it into `dist/aws` and `dist/cloudrun`.

## 8. CI/CD (`pipeline.yml`, staged)

1. **Validate**: Biome (`pnpm lint-all`) → typecheck → TS build → offline integration replay.
2. **Test**: Vitest + MSW on Ubuntu/macOS/Windows (TS packages built first for workspace resolution).
3. **Deploy Docs** (push to `main` only): TypeDoc + `cargo doc` → unified `docs-root` → `gh-pages`
   (requires `main` in the `github-pages` environment's allowed deployment branches).
4. **Release** (`v*` tags): packs 3 TS `.tgz`s + 4 FFI `.node` binaries + 8 streamer CLIs,
   then publishes `@ckirg/*` to npm from the release tarballs.

Dependabot uses a **single root npm scope** (plus cargo, github-actions, docker): pnpm
workspaces share one root `pnpm-lock.yaml`, so per-package npm scopes produce lockfile-desynced
PRs that fail CI's frozen install. Breaking majors (`msw`, `deepmerge-ts`) arrive via the root
`major` group for manual review.

## 9. Testing

Vitest everywhere; MSW for network mocks. Unit tests co-locate with sources
(`src/**/*.test.ts`, one per module); FFI-touching tests skip when no `.node` is present.
Full suite enforced by lefthook: pre-commit `verify:fast` (format → lint → typecheck),
pre-push `verify:full` (build → tests). During iteration run targeted checks only
(`vitest` on touched files, `tsc --noEmit` per package).
