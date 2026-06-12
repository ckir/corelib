# Provider Port — Phase 1 Design Spec (finstream → corelib)

- **Date:** 2026-06-12
- **Status:** Approved (design); agy brainstorm-phase pass complete. Spec-phase agy pass pending.
- **Subproject:** (d) Port finstream providers — **Phase 1 of 3** (scope S2.5).
- **Review record:** `ANTIGRAVITY-TO-CLAUDE.md` → "(d) Provider port scope (divergent)".
- **Roadmap:** `ROADMAP.md` → subproject (d), after (b-1 ✅).

## 1. Context & Goal

corelib streams market data through **bespoke per-provider** Rust structs (`AlpacaStreaming`,
`YahooStreaming`), each duplicating its own reconnection, silence detection, and redb persistence. There
is **no Finnhub** and **no shared abstraction**. The sibling repo `finstream`
(`C:/Users/user/Development/Rust/finstream`) has a clean `ProviderDriver` trait, a unified source-tagged
`MarketEvent` schema, a configurable `ReconnectPolicy`, and an existing `FinnhubDriver`.

**Scope decision (S2.5, agy + user):** adopt finstream's trait + schema + reconnect engine **internally**,
but keep corelib's **per-provider N-API/TS facades unchanged** so existing `ts-markets` consumers and the
approved integration-test spec (`2026-06-12-integration-tests-design.md`, which names
`coreFFI.AlpacaStreaming`/`YahooStreaming`) are not broken, and **redb subscription persistence is kept**.

**Phase 1 goal:** stand up the shared engine and ship **Finnhub** as the pilot provider behind a new
`FinnhubStreaming` facade that matches the existing per-provider shape — with **zero change** to existing
Alpaca/Yahoo code or consumers.

## 2. Non-Goals (Phase 1)

- **Migrating Alpaca/Yahoo** onto the trait — that is **Phase 2** (their facades stay bespoke for now).
- **A unified/multiplexed external stream or gateway** — **Phase 3**, optional/YAGNI.
- **Parquet or any new market-data capture sink** — explicitly out (user: keep redb as-is).
- **Multi-account / source-tagged egress / aggregated feed** (finstream's higher layers) — not in S2.5.
- Changing the existing flat per-provider JS payload contract (consumers keep getting flat data).

## 3. The b-1 Hardening Checklist (engine acceptance criteria)

The shared engine and the `FinnhubStreaming` facade **MUST** satisfy every item that subproject b-1 fixed
in the bespoke streamers (commit `06c7404`), audited explicitly:

1. **GC teardown** — `impl Drop` on the N-API facade signals stop + aborts the supervisor/monitor so a
   JS-dropped instance leaks no task/socket/TSFN.
2. **Backoff reset on healthy connect** — the reconnect attempt counter resets to 0 once a connection
   authenticates/receives data, so a later blip never inherits a long sticky delay. (finstream's
   `ReconnectPolicy::next_delay(attempt)` is attempt-based → reset = set `attempt = 0` on success;
   verify the ported run-loop does this.)
3. **Masked secrets** — any config carrying credentials uses a hand-written `Debug` that redacts
   key/secret fields (no derived `Debug`).
4. **Panic → JS** — a panic in the supervisor task is surfaced via `on_event("error")` (monitor on the
   `JoinHandle`), never a silent dead stream.
5. **Per-instance redb path** — the subscription DB filename is unique per instance (pid+seq+nanos) so
   concurrent instances never hit redb's exclusive-file lock.
6. **Jitter** — reconnect delays are jittered (ReconnectPolicy provides 0.5–1.0×).

## 4. Architecture

### 4.1 New shared module

`rust/src/markets/nasdaq/datafeeds/streaming/core/` (new), containing:

- **`schema.rs`** — the unified `MarketEvent` { `Trade`/`Quote`/`Status`, source-tagged } enum plus
  `Trade`, `Quote`, `ProviderStatus`, `ProviderKind`, and the provider-`extras` types. Ported from
  finstream `types.rs`, trimmed to what Phase 1 needs (Finnhub trade extras + the common fields).
- **`driver.rs`** — the `ProviderDriver` trait: `kind()`, `name()`, `validate()`,
  `spawn(symbols, tx: mpsc::Sender<MarketEvent>, policy: ReconnectPolicy) -> JoinHandle<()>`.
- **`reconnect.rs`** — `ReconnectPolicy` ported from finstream (`initial_delay`/`max_delay`/`jitter`/
  `max_retries`/`max_duration`, `next_delay(attempt)`), with the b-1 success-reset semantics enforced by
  the supervisor.
- **`supervisor.rs`** — the shared run-loop host that drives a `ProviderDriver`, applies the §3 checklist
  (attempt reset on healthy connect, panic monitor, graceful stop channel), and forwards `MarketEvent`s
  to the facade's mapper.

This module is internal (not a new public FFI surface in Phase 1).

### 4.2 FinnhubDriver

`rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs` — port of finstream
`providers/finnhub.rs` implementing `ProviderDriver`: `connect_async`, subscribe via
`{"type":"subscribe","symbol":<sym>}`, parse `{"type":"trade","data":[…]}` frames into
`MarketEvent::Trade { source, data: Trade { extras: FinnhubTradeExtras } }`, and emit
`MarketEvent::Status` on connect/reconnect/error.

### 4.3 FinnhubStreaming N-API facade

`rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs` — a `#[napi]` class whose
**public shape mirrors `AlpacaStreaming`**: `new(callbacks)`, async `init(config)`, `start()`, `stop()`,
`subscribe(symbols)`, `unsubscribe(symbols)`, with `on_pricing` / `on_event` / `on_log` threadsafe
functions. Responsibilities:

- Owns a **per-instance redb** file (`FINNHUB_DB` env override; default unique `finnhub_streaming_{pid}_{seq}_{nanos}.redb`) and loads/stores the active subscription set for resume-on-restart (mirrors the hardened Alpaca pattern).
- Spawns a `FinnhubDriver` through the shared `supervisor`, receiving `MarketEvent`s on an mpsc channel.
- **Event-flattening mapper (§4.4)** — converts each internal `MarketEvent` to the flat
  `FinnhubPricingData` payload before calling `on_pricing`, and `MarketEvent::Status` → `on_event`.
- `impl Drop` per §3.1; `FinnhubConfig` with masked `Debug` per §3.3.

### 4.4 Event-flattening mapper (FFI boundary contract)

A pure function `market_event_to_finnhub_pricing(MarketEvent) -> Option<FinnhubPricingData>` (and the
status path) defines the Rust→JS contract. `FinnhubPricingData` is a `#[napi(object)]` flat struct in the
existing style of `AlpacaPricingData` (`symbol`, `message_type`, `price`, `volume`, `timestamp`, plus a
typed `raw`/extras field as needed). The mapper lives in the facade, NOT the driver, so drivers stay
provider-pure and only the facade knows the legacy flat shape. Non-pricing events (`Status`) route to
`on_event`; logs route to `on_log`.

## 5. TypeScript surface

`ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts` — a wrapper mirroring
`AlpacaStreaming.ts`/`YahooStreaming.ts`: constructs the FFI class via `coreFFI.FinnhubStreaming`, exposes
`init/start/stop/subscribe/unsubscribe`, and forwards `on_pricing`/`on_event`/`on_log`. Uses a child
logger per AGENTS.md §1/§6 (`logger.child({ section: "FinnhubStreaming" })`). Exported from the streaming
index and the package `index.ts`. Self-instruments debug/trace per AGENTS.md §12.

## 6. Build, features, packaging

- **Cargo feature `finnhub`** gates the driver (consistent with finstream's `#[cfg(feature="finnhub")]`),
  enabled in corelib's default build so the `.node` includes it.
- The shared `core/` module compiles unconditionally (it is provider-agnostic).
- Release pipeline (AGENTS.md §4): the `.node` gains the `FinnhubStreaming` class; no new CLI bin is
  required in Phase 1 (the existing alpaca/yahoo streamer bins are untouched).
- `get_version()`/FFI scalar surface unchanged.

## 7. Dependency decisions

- **`rand`** — finstream's `ReconnectPolicy` jitter uses `rand::thread_rng()`. corelib's b-1 jitter used
  `std` `SystemTime` nanos to avoid a dependency. **Decision:** keep the engine dependency-light — port
  `ReconnectPolicy` but implement its jitter with the same `std`-nanos approach already used in b-1, so
  no `rand` crate is added. (Re-evaluate only if higher-quality randomness is ever required.)
- No other new runtime deps; `redb`, `tokio`, `tokio-tungstenite`, `serde` are already present.

## 8. Testing (Phase 1)

- **Rust unit tests** for: `ReconnectPolicy::next_delay` (exponential growth, cap, jitter bounds, reset),
  the `MarketEvent → FinnhubPricingData` mapper (each event variant), and `FinnhubDriver` message parsing
  against recorded Finnhub frames.
- **redb per-instance isolation** test (two concurrent `FinnhubStreaming::new()` do not collide), mirroring
  the existing Alpaca/Yahoo test pattern that uniquifies the db filename.
- `cargo build` / `cargo clippy --workspace` / `cargo test --workspace` green (the local gate excludes
  cargo, so run these explicitly; CI covers the multi-OS rust build per AGENTS.md §4).
- Integration coverage for `FinnhubStreaming` is added by subproject (c) — Phase 1 only ensures the FFI
  class exists in the per-provider shape (c) expects, so (c) needs no rework.

## 9. Risks & Prerequisites

| Item | Disposition |
|---|---|
| **Symbology** — does Finnhub's symbol format match corelib's Nasdaq tickers? | Finnhub uses plain equity tickers (e.g. `AAPL`) for US equities; confirmed-compatible for the Nasdaq universe. Crypto/forex prefixes (`BINANCE:…`) are out of scope. Verify against corelib's symbol source during implementation. |
| **Event-mapper fidelity** — flattening `MarketEvent` to the legacy flat payload | Contract defined in §4.4; covered by mapper unit tests (§8). |
| **b-1 regression** — porting must not lose the b-1 fixes | Enforced by the §3 checklist as engine acceptance criteria. |
| **finstream reconnect reset** — confirm finstream resets `attempt` on success | The supervisor (§4.1) owns the reset; do not rely on finstream's loop — enforce in corelib's supervisor. |
| Finnhub API key handling | `FinnhubConfig` carries the token (env fallback `FINNHUB_API_KEY`); masked `Debug` per §3.3; never logged plaintext. |

## 10. Deferred (→ ROADMAP / later phases)

- **Phase 2:** migrate `AlpacaStreaming`/`YahooStreaming` internals onto `ProviderDriver` behind their
  unchanged facades (retire the duplicated reconnection/redb code).
- **Phase 3:** optional unified/multiplexed stream gateway + (if needed) multi-account/source-tagged
  egress.
- A unified *external* (JS-visible) `MarketEvent` stream — only if a product need appears.

## 11. agy Review Provenance

Brainstorm-phase divergent pass selected **S2.5** over Claude's S2: S2 would have flattened the FFI to a
single stream, breaking `ts-markets` consumers and invalidating the (c) integration spec (§5.4 names the
per-provider classes) and regressing redb persistence. S2.5 keeps per-provider facades + redb, adopts the
trait/schema/engine internally, and phases the work. Full record in `ANTIGRAVITY-TO-CLAUDE.md`. The
Spec-phase divergent pass runs against this document before the implementation plan.
