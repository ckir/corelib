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
   - **Phase 1 (Finnhub pilot) — COMPLETE** (branch `feat/finnhub-provider-phase1`): shared
     `ProviderDriver`/`MarketEvent`/`ReconnectPolicy` engine + `WebsocketStreamerHost` +
     `FinnhubStreaming`; b-1 hardening checklist satisfied (Drop both tasks, backoff reset on
     healthy-drop, per-instance redb, masked-secret Debug, panic→JS propagation, jitter).
   - **Phase 2 (migrate Alpaca / Yahoo)** — port existing Alpaca and Yahoo streamers onto the shared
     `WebsocketStreamerHost` engine; unify `subscribe`/`unsubscribe`/`stop` semantics.
   - **Phase 3 (gateway)** — unified streaming gateway / fan-out layer across all providers.
3. **(c) Integration / e2e tests** — implement the spec'd tier
   (`docs/superpowers/specs/2026-06-12-integration-tests-design.md`) over the **final** provider set, so
   no contract rework. *(Sequencing d-before-c resolves that spec's "new providers" Deferred risk.)*
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

- **Tighten the rust lint gate** — `lint-all` currently runs `cargo clippy` (warn-only via the rust
  package's `lint` script). *Revive when:* the crate is warning-clean and ready for
  `cargo clippy -- -D warnings` in the fast loop.
