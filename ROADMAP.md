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

   - **Phase 3 (gateway) — UNBLOCKED** (2026-06-13): all provider migrations complete, so the
     unified streaming gateway / fan-out layer across all providers can begin (next spec → plan →
     implementation cycle).
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
