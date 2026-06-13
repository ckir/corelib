# corelib — Roadmap

Durable backlog of deferred ideas and follow-ups. Per `AGENTS.md` → "Working with Antigravity (agy)",
deferred Antigravity suggestions and YAGNI'd scope land here (or in a spec's "Deferred" section) rather
than being lost. One bullet per item: what, why deferred, and the trigger that should revive it.

## Active roadmap (sequenced)

Decided 2026-06-12 (user + Claude + agy divergent pass — see `ANTIGRAVITY-TO-CLAUDE.md` "Roadmap
sequencing of 4 subprojects"). Five subprojects, each its own spec → plan → implementation cycle:

1. **(b-1) Baseline FFI audit** — ✅ **DONE** (2026-06-12, commit `06c7404`). agy audit found 3 blockers
   + 3 should-fixes in the Alpaca/Yahoo streamers; all remediated: Drop-based GC teardown, backoff reset
   on healthy-drop, per-instance redb path (concurrent feeds), masked-secret Debug, panic→JS propagation,
   reconnect jitter. Audit record in `ANTIGRAVITY-TO-CLAUDE.md`. *Deferred to (d):* moving the sync
   `Database::create` out of the constructor into async `init()` (folds into the StreamingProvider refactor).
2. **(d) Port finstream providers** — bring Alpaca / Finnhub / Yahoo from `finstream`
   (`C:/Users/user/Development/Rust/finstream`, Rust + napi) into corelib's Rust core + FFI under a
   unified `Trade`/`Quote`/`Status` schema (adds **Finnhub**). New code self-instruments per AGENTS.md §12.
   - **Phase 1 (Finnhub pilot) — COMPLETE** (merged to `main` 2026-06-12, commit `4bc0b24`): shared
     `ProviderDriver`/`MarketEvent`/`ReconnectPolicy` engine + `WebsocketStreamerHost` +
     `FinnhubStreaming`; b-1 hardening checklist satisfied (Drop both tasks, backoff reset on
     healthy-drop, per-instance redb, masked-secret Debug, panic→JS propagation, jitter).
   - **Phase 2 (migrate Alpaca / Yahoo)** — port existing Alpaca and Yahoo streamers onto the shared
     `WebsocketStreamerHost` engine; unify `subscribe`/`unsubscribe`/`stop` semantics.
     - **Phase 2a (Alpaca) — COMPLETE** (2026-06-13, branch `feat/alpaca-provider-phase2a`): Alpaca
       migrated onto the shared host as the first **dual-mode** provider — emits the byte-identical
       raw `AlpacaPricingData` AND a unified (finstream-superset, RFC3339-timestamp) `MarketEvent`
       via an optional 4th `on_market_event` callback. Engine channel migrated to `CoreEvent`/
       `SubRequest`; Finnhub retrofitted dual-mode in the same change. Subscription surface widened to
       trades/quotes/bars with channel-aware redb persistence (the single source of truth for
       resume — `AlpacaDriver.load_subscriptions()` reads it fresh on every connect, reconnect-safe);
       bars are raw-only. b-1 hardening inherited via the shared host. agy convergent review PASS.
     - **Phase 2b (Yahoo) — COMPLETE** (2026-06-13, merged to `main` commit `cecbfb0`, branch
       `feat/yahoo-provider-phase2b`): Yahoo (proto-decoded) streamer migrated onto the shared
       dual-mode engine — emits the byte-identical raw `JsPricingData` (all 33 proto fields) AND a
       unified finstream-superset `MarketEvent` via the optional 4th `on_market_event` callback.
       Carrier generalized to `CoreEvent::Pricing.uni: Vec<MarketEvent>` (Yahoo emits 0/1/2 uni
       events per raw message; Alpaca/Finnhub migrated in lockstep). Pure `parse_yahoo_message`
       mapper + no-auth single-channel `YahooDriver` (bare-key redb resume, read fresh each connect);
       facade + CLI bin rewritten as thin host delegates; `YahooTradeExtras`/`YahooQuoteExtras`
       widened + `YahooOptionExtras` + `quote_type_label()`. Heartbeats (`quote_type==7`) → raw +
       empty uni. agy plan-phase PROCEED + convergent final SHIP-WITH-NITS. **All three providers
       (Alpaca/Finnhub/Yahoo) are now dual-mode on the shared engine.**

   - **Phase 3 (gateway) — REDIRECTED to the finstream consolidation; DEFERRED** (2026-06-13):
     brainstorming concluded that a streaming gateway/server is an *app*, not a library feature, so it
     does NOT belong inside corelib. Instead the unified gateway + REST will live in the **finstream**
     app, built on a shared **napi-free `corelib-streaming`** engine crate extracted from `corelib-rust`.
     finstream is a real product but **not now**; the full plan is recorded in
     `C:/Users/user/Development/Rust/finstream/ROADMAP.md` ("finstream on corelib") and the agy
     advisories in `ANTIGRAVITY-TO-CLAUDE.md` (shape-reconsidered + consolidation). corelib-side
     prerequisite when revived: **Phase A — extract `corelib-streaming` (napi-free engine), `corelib-rust`
     becomes a thin `#[napi]` adapter** (valuable to corelib on its own merits — a testable, cleanly
     layered engine; mind the dual-mode raw-payload `#[napi(object)]` seam).
   - *Deferred (Phase 2a plan-pass, agy):* **Finnhub reconnect-resume of in-session subscriptions.** Finnhub
     resumes from the `symbols` snapshot passed at `start()`, so dynamic subscribes added mid-session are lost
     on reconnect (pre-existing Phase 1 behavior — not a 2a regression). Apply the same redb-fresh-read pattern
     `AlpacaDriver` uses (driver holds the host `Arc<Database>` handle, reads persisted subs each `connect_once`)
     to `FinnhubDriver`. Revive when Finnhub reconnect-durability matters.
   - *Deferred (Phase 2b convergent review, agy 🟢):* **Debug-log undecodable Yahoo frames.** The new
     `YahooDriver` silently skips frames `parse_yahoo_message` can't decode (consistent with how
     Alpaca/Finnhub behave on the shared engine; the old bespoke Yahoo streamer trace-logged them).
     Add a debug-level fallback log in the driver pump when the mapper returns `None` for plain text.
     Revive when diagnosing a Yahoo wire-protocol change.
3. **(c) Integration / e2e tests — COMPLETE** (2026-06-13, merged to `main` commit `71ec1dd`, branch
   `feat/integration-test-tier`): exhaustive CI-only integration tier from
   `docs/superpowers/specs/2026-06-12-integration-tests-design.md` (PLAN-READY after 3 agy passes;
   plan `docs/superpowers/plans/2026-06-13-integration-test-tier.md`, 16 tasks). Three seams
   (cross-package unmocked · external REST via MSW record/replay with secret scrubbing · Rust FFI-scalar)
   + a coverage matrix/validator that makes "exhaustive" statically enforceable; per-package
   runtime-matched vitest configs (node + `workers-pool`); live-tier streaming suites
   (skip unless `INTEGRATION_LIVE=1`); `ConfigManager.initialize(args?)` prerequisite; CI integration job +
   nightly live workflow. Gates green: unit ts-core 120/ts-markets 130/ts-cloud 34; integration replay
   green; validator green. agy plan-phase review (EXECUTE-WITH-FIXES) folded before execution.
   - *Deferred follow-ups:* Yahoo `Historical` success fixture (epoch-timestamp URL — `TODO` in the
     external-rest suite); `tsconfig.integration.json` `typeRoots`/`paths` hoisting workaround (functional,
     non-gate — clean up by hoisting `@types/node`/`vitest` to root devDeps); the dist/`.tgz` black-box
     smoke layer and deterministic streaming loopback harness remain deferred per the spec §12.
4. **(a) Trace / flight-recording retro-instrumentation** — apply AGENTS.md §12 to legacy modules so
   `LOG_LEVEL=trace` lets an AI agent debug from logs alone. Done *after* (c) so the integration suite is
   the safety net for this large sweeping refactor (user-approved placement).
5. **(b-2) Capstone global audit** — full correctness / architecture / edge-case review over the
   complete, tested, instrumented monorepo.

*Rationale for the order:* (d) before (c) avoids testing a soon-to-change provider surface; (a) after (c)
gives the risky logging sweep a test net; (b) split into a thin baseline (b-1) + capstone (b-2) rather
than one global audit.

## Testing

- **Artifact / `dist` black-box smoke layer for integration tests** — build all packages and import each
  via its published `exports` map (the deferred "Approach C"). *Why deferred:* white-box-against-source
  (the chosen v1) catches the bulk of integration risk; YAGNI until a packaging bug bites. *Revive when:*
  an ESM/CJS, `exports`-map, or bundling regression escapes to a consumer. *(agy 🟡, 2026-06-12 divergent
  pass — see `ANTIGRAVITY-TO-CLAUDE.md`.)*
- **Loopback mock server for Rust-native streaming** — a zero-dep Node `net`/`http`/`ws` loopback bound
  to the test lifecycle, with the Rust Alpaca/Yahoo streamers pointed at `localhost:<port>` to replay
  recorded frames deterministically. *Why deferred:* MSW cannot intercept FFI-driven sockets, so v1
  covers streaming in the opt-in live tier only. *Revive when:* deterministic streaming coverage is
  needed in CI; first verify the Rust streamer accepts an endpoint override. *(agy highest-conviction
  suggestion, 2026-06-12.)*

## Tooling / dev-workflow

- **CI-offload + AI auto-fix workflow — SHIPPED** (2026-06-13, merged to `main` `303dcfa`, CI-fix `bcf6b86`;
  spec `docs/superpowers/specs/2026-06-13-ci-offload-autofix-design.md`, plan
  `docs/superpowers/plans/2026-06-13-ci-offload-autofix.md`, agy plan-phase EXECUTE-WITH-FIXES folded).
  **Part A (corelib):** a ~1-min `validate` pre-flight (lint + typecheck-all + `pnpm build-all` + offline
  replay integration) now gates the 9-cell matrix via `needs:`; `lefthook.yml` lightened to biome
  format+lint (pre-push dropped). First push (`303dcfa`, 117 commits to origin) went red on the ts-cloud
  workers-pool integration test (`@ckir/corelib` unresolvable with no `dist/`) — fixed by adding
  `pnpm build-all` to the pre-flight (`bcf6b86`); full pipeline then green (pre-flight + 9 matrix cells +
  3-OS integration + docs deploy). **Part B (global, NOT in this repo):** `~/.claude/skills/watch-ci/`
  (`watch-ci.mjs` worker + `/watch-ci` launcher skill + `toast.ps1`) — zero-dep Node worker that watches
  `gh` runs and drives a bounded N=3 `claude -p` auto-fix loop in an isolated worktree with deterministic
  rails (concurrency/SHA guard, path denylist, no force-push, secret-scrub, escalate→toast +
  `CI-FAILURE-REPORT.md`); helper unit tests 5/5, dry-run clean. A planner bug in `scrubLog` (regex order
  leaked `Bearer` tokens) was caught via the SHAPE_DIVERGENCE rule and fixed.
  - *Deferred (Task 7 Steps 2–4):* the worker's destructive auto-fix/escalation **e2e** (inject a red,
    watch fix+push / N=3 escalate). Deferred per user — the happy path is green and the worker logic is
    unit-tested; **validate the loop supervised on the first genuine `main` CI failure** rather than
    deliberately reddening the now-green public `main`.
  - *Port in flight:* the same Part A is being ported to **MarketMonitor** (its 4-cell matrix with the
    ~18-min Linux corelib-Rust compile + Playwright e2e is a bigger pre-flight win); agy divergent brief
    queued in `MarketMonitor/CLAUDE-TO-ANTIGRAVITY.md` (2026-06-13). Part B is already global — no port.
- **Tighten the rust lint gate** — `lint-all` currently runs `cargo clippy` (warn-only via the rust
  package's `lint` script). *Revive when:* the crate is warning-clean and ready for
  `cargo clippy -- -D warnings` in the fast loop.

## Audit findings (2026-06-13)

> Each cluster becomes its own spec→plan→cycle; no fixes were made in the audit cycle.
> Full ranked backlog: `docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md`

Clusters ordered by max severity (high → medium → low):

### High severity

- **configmanager-cli-argv-hazards** · max: high · owner: `boot-ConfigManager-cli-override-process-exit-07` · probe: `probes/js/configmanager-init-race.probe.test.ts` · _`initialize()` calls `process.exit(1)` on any unknown CLI flag under commander@15; documented dynamic-override feature is non-functional and DoS-able_

- **configmanager-concurrency-races** · max: high · owner: `boot-ConfigManager-initialize-races-01` · probe: none · _`initialize()` has no concurrent-call guard; two concurrent callers interleave `loadDefaults()` + `this._config` reassignments, producing non-deterministic config; 3 related race findings (partial-init window, external-config concurrency, sysconfig reference severance)_

### Medium severity

- **redb-double-open-process-abort** · max: medium · owner: `engine-redb-open-expect-abort-01` · probe: `probes/rust/tests/redb_concurrent.rs::q3_shared_path_double_open_panics` · _`host.rs:57` `.expect("Failed to open redb")` panics and aborts the Node process when two streamers share a redb path via env override; replace with `?`-propagation so it surfaces as a catchable JS error_

- **error-serialization-log-gaps** · max: medium · owner: `phase0-logger-raw-error-sqlite-01` · probe: none · _raw `error: e` passed to structured logger across sqlite-db, postgres-db, router, and Top100; non-enumerable Error properties and cause chains are silently dropped in JSON logs; replace with `serializeError(e)` across 4 sites_

- **http-retry-config-hazards** · max: medium · owner: `boot-RequestUnlimited-retry-limit-unbounded-03` · probe: none · _config-derived `retry.limit` passes to ky with no upper-bound clamp; a poisoned/malformed config value yields unbounded retries; also: no jitter causes thundering-herd retry storms_

- **ts-core-node-imports-edge-compat** · max: medium · owner: `phase0-ts-core-node-module-SysInfo-01` · probe: `probes/_harness/edge-boot.mjs` · _4 unconditional `node:module`/`node:crypto` static imports in ts-core; currently masked by `nodejs_compat` + tsup specifier rewrite; conformance/fragility issue across 6 related findings including tsup `platform:"node"` for the CF worker_

- **market-status-http-error-swallow** · max: medium · owner: `facade-market-status-error-status-swallowed-01` · probe: none · _`MarketStatusCloud` catch block returns HTTP 200 on fatal error; callers cannot distinguish success from failure by status code_

- **worker-bundle-size-and-platform** · max: medium · owner: `facade-worker-bundle-size-perf-01` · probe: none · _Cloudflare worker bundle is 6.29 MB / gzip 901 KiB; includes unreachable server deps (@google-cloud/\*, @libsql/client, pino-pretty) due to `noExternal:[/.*/]` + `platform:"node"`_

### Low severity

- **detectRuntime-uncached** · max: low · owner: `boot-detectRuntime-uncached-06` · probe: none · _`detectRuntime()` recomputes full env-probe ladder on every call; memoize to a module-level constant_

- **gcp-logger-stray-console-calls** · max: low · owner: `phase0-logger-gcp-console-01` · probe: none · _4 `console.log/error` calls in `createGcpLogger()` bypass the structured `StrictLogger` interface_

- **finnhub-no-endpoint-override** · max: low · owner: `engine-finnhub-no-endpoint-override-01` · probe: none · _FinnhubConfig has no `base_url` override unlike yahoo/alpaca; prevents loopback test injection; forces recorded-frame replay in probes_

- **ffi-reentrancy-reconnect-gc** · max: low · owner: `ffi-reentrancy-reconnect-gc-deadlock-01` · probe: none · _suspected TSFN re-entrancy/callback-after-teardown under GC; probe exercised call-churn but never drove `DELIVERED>0`, so the inbound Rust→JS delivery race path is unvalidated_

- **redb-concurrent-persist-load-robust** · max: low · owner: `engine-redb-concurrent-persist-load-robust-01` · probe: `probes/rust/tests/redb_concurrent.rs::q2_concurrent_persist_and_load_is_consistent` · _positive result / no defect; MVCC redb is consistent under 8 concurrent writers + 6 readers; probe kept as regression guard_

- **engine-reconnect-teardown-loom** · max: low · owner: `engine-reconnect-teardown-loom-01` · probe: none · _loom model of reconnect/teardown confirmed no deadlock, no send-after-close panic across all interleavings; probe at `probes/rust/tests/reconnect_teardown_loom.rs` is a durable regression guard_
