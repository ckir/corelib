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
   - **Streaming Engine Epic — CONSOLIDATED (2026-06-15; agy `CONSOLIDATE-BUT-KEEP-SPEC-ADD-COMPANION`).**
     The streaming leftovers are now ONE Epic, sequenced **Phase A → (Finnhub-resume, Yahoo-log) → interop closure**:
     - **Phase A (module boundary) — ✅ DONE (2026-06-15):** napi-free engine/adapter boundary in-place —
       the 5 wire types are `cfg_attr(feature="napi")`-gated (A1 `2127b6e1`), a `compile_error!` guards
       `--no-default-features`, and `rust/tests/streaming_boundary_lint.rs` enforces the napi-free engine
       source set (A2 `d7b145cb`). Pure-Rust tokio loopback delivery tests prove frame→CoreEvent for
       Alpaca (A3 `ffcc8c1`), Finnhub (A4 `f5073c9`), Yahoo (A5 `611d1f0`) — engine EXONERATED, no Node.
       Rust suite 99 green, clippy `-D warnings` clean, `index.d.ts` unchanged. Spec
       `docs/superpowers/specs/2026-06-15-phase-a-streaming-engine-module-boundary-design.md`; plan
       `docs/superpowers/plans/2026-06-15-phase-a-streaming-engine-module-boundary.md` (6 tasks, subagent-driven).
     - **Phase B — ✅ DONE (2026-06-15):** Finnhub reconnect-resume (redb fresh-read like Alpaca/Yahoo;
       `f9800eea`), Yahoo undecodable-frame length-only debug-log (`fc0256f`), and the **Node↔Rust interop
       closure** — a deterministic integration test (`5e73ca0a`, `ts-markets/tests/integration/alpaca-loopback-delivery…`)
       drives the real `AlpacaStreaming` addon against the Node `ws` loopback and asserts a frame round-trips
       Node ws→Rust→TSFN→`on_pricing`. **GREEN on BOTH release and debug** — the Epic-5
       `probe-harness-loopback-no-delivery` (`RECEIVED=0`) is NOT reproducible and is CLOSED. Finding:
       `docs/superpowers/findings/2026-06-15-b3-interop-characterization.md`. Plan
       `docs/superpowers/plans/2026-06-15-streaming-engine-epic-phase-b.md`.
     - **✅ STREAMING ENGINE EPIC CLOSED (2026-06-15):** boundary enforced (Phase A) + cross-runtime delivery
       proven & gating CI (Phase B). The interop test gates the standard integration tier (no `INTEGRATION_LIVE`);
       final CI-matrix confirmation lands on the next pipeline run / merge.
     - **Crate lift** (`corelib-streaming`, napi-free) — the ONLY remaining deferred item; revives when finstream
       is prioritized. Phase A's in-place boundary makes it a mechanical lift.
   - *Deferred (Phase 2a plan-pass, agy):* **Finnhub reconnect-resume of in-session subscriptions.** Finnhub
     resumes from the `symbols` snapshot passed at `start()`, so dynamic subscribes added mid-session are lost
     on reconnect (pre-existing Phase 1 behavior — not a 2a regression). Apply the same redb-fresh-read pattern
     `AlpacaDriver` uses (driver holds the host `Arc<Database>` handle, reads persisted subs each `connect_once`)
     to `FinnhubDriver`. Revive when Finnhub reconnect-durability matters. **→ folded into Streaming Engine Epic Phase B.**
   - *Deferred (Phase 2b convergent review, agy 🟢):* **Debug-log undecodable Yahoo frames.** The new
     `YahooDriver` silently skips frames `parse_yahoo_message` can't decode (consistent with how
     Alpaca/Finnhub behave on the shared engine; the old bespoke Yahoo streamer trace-logged them).
     Add a debug-level fallback log in the driver pump when the mapper returns `None` for plain text.
     Revive when diagnosing a Yahoo wire-protocol change. **→ folded into Streaming Engine Epic Phase B.**
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
5. **(b-2) Capstone global audit** — ✅ **DONE (2026-06-15)** — full correctness / architecture /
   edge-case review over the complete, tested, instrumented monorepo. Gated-hybrid, 5 clusters, 9
   findings; 2 hard-gate criticals fixed inline (unbounded streaming TSFN → bounded 1024; prod axios
   SSRF/credential-leak → vestigial dep pruned). See `docs/superpowers/audits/2026-06-15-epic5-capstone-findings.md`.

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
  suggestion, 2026-06-12.)* **→ folded into Streaming Engine Epic Phase B — this IS the cross-runtime
  interop closure. The endpoint-override prerequisite is now SATISFIED: all 3 drivers expose `base_url`.**

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
- ✅ **Tighten the rust lint gate — DONE (Epic 5, 2026-06-15).** The rust gate now runs
  `cargo clippy --all-targets -- -D warnings` (lefthook `format-lint` + CI); the crate is warning-clean.

## Audit findings (2026-06-13)

> Each cluster becomes its own spec→plan→cycle; no fixes were made in the audit cycle.
> Full ranked backlog: `docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md`

Clusters ordered by max severity (high → medium → low):

> **✅ Epic 1 (ConfigManager / boot-hardening) — RESOLVED 2026-06-13.** The two
> boot clusters below plus `detectRuntime-uncached` (7 findings: -01, -02, -05,
> -06, -07, -08, -09) are fixed on branch `worktree-epic1-boot-hardening`:
> commander dropped for a hand-rolled argv parser (+ `isSafeKey` guard), atomic
> in-place config mutation (stable `globalThis.sysconfig` identity), single-flight
> `initialize()` with failure eviction, mutator mutex + dual-write, constructor-
> seeded defaults, and a readiness API (`isInitialized`/`whenReady`). Spec:
> `docs/superpowers/specs/2026-06-13-configmanager-boot-hardening-design.md`.

### High severity

- ✅ **configmanager-cli-argv-hazards** · max: high · owner: `boot-ConfigManager-cli-override-process-exit-07` · probe: `probes/js/configmanager-init-race.probe.test.ts` (flipped to fixed-contract oracle) · **RESOLVED (Epic 1)** — commander removed; hand-rolled parser cannot `process.exit`; `process.argv` guarded (-07, -08).

- ✅ **configmanager-concurrency-races** · max: high · owner: `boot-ConfigManager-initialize-races-01` · probe: none · **RESOLVED (Epic 1)** — single-flight `initialize()` + failure eviction, mutator mutex, atomic `clearAndFill` commit, and constructor-seeded defaults close all 4 race findings (-01 concurrent-init, -02 partial-init window, -05 external-config concurrency, -09 sysconfig reference severance).

### Medium severity

- ✅ **redb-double-open-process-abort** · max: medium · owner: `engine-redb-open-expect-abort-01` · probe: `probes/rust/tests/redb_concurrent.rs::q3_shared_path_double_open_errors` · **RESOLVED (Epic 2)** — `WebsocketStreamerHost::new` now returns `Result<Self, HostError>` (`Database::create(..).map_err(HostError::DbOpen)?`); 8 call sites updated (CLI bins `?`, napi facades → catchable `napi::Error`, test helpers `.expect`); q3 probe flipped to assert `Err`, not panic.

- ✅ **error-serialization-log-gaps** · max: medium · owner: `phase0-logger-raw-error-sqlite-01` · probe: none · **RESOLVED (Epic 3)** — `serializeError(...)` wraps every raw-error logger site (sqlite-db ×3, postgres-db ×3, SqlCloud, NasdaqPolling); router/Top100 already passed `.message` strings (out of scope). A rationale test pins the `Error`→`{}` bug; NasdaqPolling oracle updated to the serialized shape.

- ✅ **http-retry-config-hazards** · max: medium · owner: `boot-RequestUnlimited-retry-limit-unbounded-03` · probe: `ts-core/src/retrieve/RequestUnlimited.retry.test.ts` · **RESOLVED (Epic 2)** — `clampNumber` bounds `retrieve.timeout`/`retry.limit`/`retry.backoffLimit` to named ceilings (`MAX_*`) with safe fallbacks on non-finite/poisoned values; Full-Jitter `delay` added to break thundering-herd retry storms (-03, -04).

- ✅ **ts-core-node-imports-edge-compat** · max: medium · owner: `phase0-ts-core-node-module-SysInfo-01` · probe: `probes/_harness/edge-boot.mjs` · **RESOLVED (Epic 3)** — `node:crypto`/`node:module` moved to `__EDGE_RUNTIME__`-guarded dynamic imports (DCE'd from the edge bundle via tsup `define`); `__EDGE_RUNTIME__` declared as an import-graph-travelling module global. edge-boot probe rewired to boot the BUILT `dist/cloudflare/worker.js` and now reports BOOTS_CLEAN.

- ✅ **market-status-http-error-swallow** · max: medium · owner: `facade-market-status-error-status-swallowed-01` · probe: none · **RESOLVED (Epic 3)** — `MarketStatusCloud` fatal path now returns HTTP 500 (was 200); test oracle flipped first (200→500) then code. Success path stays 200.

- ✅ **worker-bundle-size-and-platform** · max: medium · owner: `facade-worker-bundle-size-perf-01` · probe: `probes/_harness/edge-boot.mjs` · **RESOLVED (Epic 3)** — CF worker entry switched to `platform:"neutral"` + `__EDGE_RUNTIME__` define + externalized node builtins & server-only deps (pino stack, postgres, @libsql/client) reachable only via dead dynamic imports; wrangler `[alias]` resolves them to an edge stub. worker.js 6.29 MB → 611 KB raw / 901 KiB → ~133 KB gzip; edge-boot BOOTS_CLEAN. AWS/CloudRun entries unchanged.

### Low severity

- ✅ **detectRuntime-uncached** · max: low · owner: `boot-detectRuntime-uncached-06` · probe: none · **RESOLVED (Epic 1)** — `detectRuntime()` memoized to a module-level cache (`computeRuntime()` extracted; `__resetRuntimeCache()` test hook) (-06).

- ✅ **gcp-logger-stray-console-calls** · max: low · owner: `phase0-logger-gcp-console-01` · probe: none · **RESOLVED (Epic 3)** — 3 progress `console.log` calls removed from `createGcpLogger()`; the single `catch` `console.error` kept as the documented bootstrap fallback (the structured logger itself failed to init, so console is the only available sink).

- ✅ **finnhub-no-endpoint-override** · max: low · owner: `engine-finnhub-no-endpoint-override-01` · probe: none · **RESOLVED (Epic 2)** — `FinnhubConfig`/`FinnhubDriver` gain a `base_url: Option<String>` threaded through to the connect URL (default endpoint preserved byte-identical); TS `FinnhubConfig.baseUrl?` mapped to the FFI `base_url` payload key. Enables loopback test injection.

- ✅ **ffi-reentrancy-reconnect-gc** · max: low · owner: `ffi-reentrancy-reconnect-gc-deadlock-01` · probe: `ts-markets/tests/integration/TsfnGcFlood.integration.test.ts` · **RESOLVED (Epic 2)** — env-gated `napi_trigger_diagnostic_flood` floods a `ThreadsafeFunction<String>` from a native thread while JS hammers `global.gc()`; validated `DELIVERED===5000`, deadlock-free. The inbound Rust→JS delivery-under-GC path is now proven robust.

- **redb-concurrent-persist-load-robust** · max: low · owner: `engine-redb-concurrent-persist-load-robust-01` · probe: `probes/rust/tests/redb_concurrent.rs::q2_concurrent_persist_and_load_is_consistent` · _positive result / no defect; MVCC redb is consistent under 8 concurrent writers + 6 readers; probe kept as regression guard_

- **engine-reconnect-teardown-loom** · max: low · owner: `engine-reconnect-teardown-loom-01` · probe: none · _loom model of reconnect/teardown confirmed no deadlock, no send-after-close panic across all interleavings; probe at `probes/rust/tests/reconnect_teardown_loom.rs` is a durable regression guard_

### Carry-forward: unprobed vectors & residuals (future cycles)

- ✅ **TSFN inbound-delivery-under-GC race (TOP residual)** — races/edge · **VALIDATED & CLOSED (Epic 2)** — implemented exactly the recommended fix-cycle task: env-gated `napi_trigger_diagnostic_flood` (`rust/.../streaming/diagnostics.rs`) floods a `ThreadsafeFunction<String>` from a native thread (Blocking delivery) while JS hammers `global.gc()` at 1ms; the integration suite (`TsfnGcFlood.integration.test.ts`, `--expose-gc`) proves `DELIVERED===5000` with no deadlock. The §8 N-API callback-deadlock vector is robust.

- ✅ **Cross-process redb file-lock collision** — races/edge · **VALIDATED & CLOSED (Epic 2)** — `probes/rust/tests/redb_cross_process.rs` spawns a 2nd process opening a redb path held by the 1st; empirically confirmed redb takes an OS-level cross-process lock on Windows → the 2nd open returns `Err(HostError::DbOpen)` ("Database already open. Cannot acquire lock."), **no abort cascade** (a `#[cfg(windows)]` assert guards against regression; the universal no-abort invariant holds on all OSes). Validates `engine-redb-open-expect-abort-01`'s fix under a real multi-process race.

- **FFI backpressure / event-loop starvation under market-data flood** — perf · 🟡 **partially addressed (Epic 5)**: the streaming TSFN is now bounded (`max_queue_size=1024`, NonBlocking drop-on-overflow), removing the unbounded-buffer OOM risk under a burst. **Residual (unprobed):** the latency-degradation / drop-rate profile under sustained peak load, and whether the Rust client applies TCP backpressure. *Revive when:* a production burst shows drops or latency spikes.

- ✅ **Long-running marshaling memory-leak profile — RESOLVED (Epic 5 soak, 2026-06-15): NOT a leak.** A soak run showed an allocator high-water plateau (RSS stabilizes; V8 heap flat) — the per-tick allocation churn does not accumulate. No multi-hour harness needed. *Revive only if* a future RSS-growth report contradicts the plateau.
