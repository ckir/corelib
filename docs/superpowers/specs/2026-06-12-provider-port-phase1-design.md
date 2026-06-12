# Provider Port — Phase 1 Design Spec (finstream → corelib)

- **Date:** 2026-06-12
- **Status:** Approved (design); agy brainstorm + spec-phase divergent passes complete. Pending user review.
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

1. **GC teardown** — `Drop` (on the host) signals stop + aborts **both** the supervisor/monitor task
   **and** the mpsc→TSFN pump task, so a JS-dropped instance leaks no task/socket/TSFN. (Leaving the pump
   alive holds a strong TSFN ref and prevents clean Node exit — agy spec-pass 🔴.)
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
- **`driver.rs`** — the `ProviderDriver` trait. **corelib's trait differs from finstream's:** the driver
  performs a **single connection attempt**, not its own reconnect loop (the supervisor owns the loop — see
  below). Shape:
  ```rust
  trait ProviderDriver: Send + 'static {
      fn kind(&self) -> ProviderKind;
      fn name(&self) -> &str;
      fn validate(&self) -> Result<(), FinStreamError> { Ok(()) }
      // one connection attempt; returns when the socket drops or a fatal/stop occurs.
      async fn connect_once(
          &self,
          symbols: &[String],
          tx: &mpsc::Sender<MarketEvent>,    // normalized events out (incl. Status::Connected)
          sub_rx: &mut mpsc::Receiver<Vec<String>>, // dynamic subscribe/unsubscribe while live
          stop_rx: &mut mpsc::Receiver<()>,  // graceful stop
      ) -> AttemptOutcome;                    // Connected-then-dropped | NeverConnected | Fatal | Stopped
  }
  ```
  This mirrors corelib's existing hardened `run_loop`/`ws_loop` split (the bespoke `ws_loop` already is a
  single-attempt unit returning `WsLoopResult`). `sub_rx` closes the b-1/dynamic-subscription gap — a
  `subscribe()` after `start()` reaches the live socket, not just redb. *(agy spec-pass 🔴 ×2.)*
- **`reconnect.rs`** — `ReconnectPolicy` ported from finstream (`initial_delay`/`max_delay`/`jitter`/
  `max_retries`/`max_duration`, `next_delay(attempt)`), jitter via `std` nanos (§7).
- **`supervisor.rs`** — **owns the reconnect loop.** It calls `driver.connect_once(...)`; on return it
  inspects `AttemptOutcome` (and/or observes a `MarketEvent::Status::Connected` on `tx`) to **reset
  `attempt = 0` on a healthy connect**, grows `attempt` only on `NeverConnected`, breaks on `Fatal`/
  `Stopped`, sleeps `policy.next_delay(attempt)`, and re-invokes the driver. It also runs the panic
  monitor (`JoinHandle::is_panic` → `on_event("error")`). This is the single place for backoff/state/
  teardown — no dual scheduler. *(agy spec-pass 🔴 [Structural].)*
- **`host.rs`** — a generic **`WebsocketStreamerHost<D: ProviderDriver>`** that owns ALL the FFI
  coordination so each per-provider FFI class is a thin delegate: the per-instance **redb** file +
  configurable table name, the supervisor task, the **mpsc→TSFN pump task**, the dynamic-sub channel, the
  stop channel, and `Drop` (aborts **both** supervisor and pump). Constructed with the driver, the redb
  table name (e.g. `"finnhub_subscriptions"`), and the three TSFNs. *(agy creative — makes Phase 2 a thin
  wrap of Alpaca/Yahoo drivers.)*

This module is internal (not a new public FFI surface in Phase 1). `napi-derive` cannot put generics on
FFI structs, so the per-provider `#[napi]` classes stay separate but each wraps a
`WebsocketStreamerHost<D>`.

### 4.2 FinnhubDriver

`rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs` — adapted from finstream
`providers/finnhub.rs` implementing corelib's `connect_once` contract (§4.1): one `connect_async`, emit
`MarketEvent::Status::Connected` on success (the supervisor's reset signal), apply pending `sub_rx`
updates + initial `subscribe` via `{"type":"subscribe","symbol":<sym>}`, parse `{"type":"trade","data":[…]}`
frames into `MarketEvent::Trade { source, data: Trade { extras: FinnhubTradeExtras } }`, and return an
`AttemptOutcome` when the socket drops/stops. **finstream's internal reconnect loop is dropped** — the
supervisor owns looping (§4.1), so the driver only does a single attempt.

### 4.3 FinnhubStreaming N-API facade

`rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs` — a `#[napi]` class whose
**public shape mirrors `AlpacaStreaming`** (`new`, async `init(config)`, `start`, `stop`,
`subscribe(symbols)`, `unsubscribe(symbols)`, `on_pricing`/`on_event`/`on_log` TSFNs) but is a **thin
delegate** to `WebsocketStreamerHost<FinnhubDriver>` (§4.1 `host.rs`). It:

- Constructs the host with a `FinnhubDriver`, redb table name `"finnhub_subscriptions"`, and a
  per-instance redb path (`FINNHUB_DB` env override; default unique `finnhub_streaming_{pid}_{seq}_{nanos}.redb`).
- Supplies the **event-flattening mapper (§4.4)** the host's pump applies: `MarketEvent::Trade/Quote` →
  flat `FinnhubPricingData` → typed `on_pricing`; `MarketEvent::Status` → `on_event`; logs → `on_log`.
- Delegates `start/stop/subscribe/unsubscribe` to the host (which routes `subscribe` to both redb and the
  live `sub_rx`).
- `FinnhubConfig` carries the API token (env fallback `FINNHUB_API_KEY`) with a masked `Debug` per §3.3.

The host owns teardown: its `Drop` aborts **both** the supervisor task and the mpsc→TSFN pump task and
signals `stop` (§3.1, §3.4), so the facade itself needs no bespoke lifecycle code.

### 4.4 Event-flattening mapper (FFI boundary contract)

A pure function `market_event_to_finnhub_pricing(&MarketEvent) -> Option<FinnhubPricingData>` (plus the
status path) defines the Rust→JS contract. The flat struct is **pinned** (Finnhub streams a numeric epoch,
not an RFC3339 string — so `timestamp` is `f64`, unlike Alpaca's string):

```rust
#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FinnhubPricingData {
    pub symbol: String,
    pub message_type: String,        // "trade"
    pub price: f64,
    pub volume: f64,
    pub timestamp: f64,              // numeric epoch ms (f64 for napi compat)
    pub conditions: Option<Vec<String>>, // Finnhub trade-condition codes
}
```

The mapper lives in the facade (provided to the host's pump), NOT the driver, so drivers stay
provider-pure and only the facade knows the legacy flat shape. Non-pricing events (`Status`) route to
`on_event`; logs route to `on_log`. **Callback types:** `EventRecord`/`LogRecord` are reused from the
crate root (`crate::{EventRecord, LogRecord}`) to keep event/logger contracts aligned; the pricing
payload (`FinnhubPricingData`) and its `FinnhubCallbacks`/TSFN bundle are provider-specific. *(agy
spec-pass 🟡/🟢.)*

## 5. TypeScript surface

`ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts` — a wrapper mirroring
`AlpacaStreaming.ts`/`YahooStreaming.ts`: constructs the FFI class via `coreFFI.FinnhubStreaming`, exposes
`init/start/stop/subscribe/unsubscribe`, and forwards `on_pricing`/`on_event`/`on_log`. Uses a child
logger per AGENTS.md §1/§6 (`logger.child({ section: "FinnhubStreaming" })`). Exported from the streaming
index and the package `index.ts`. Self-instruments debug/trace per AGENTS.md §12.

## 6. Build, features, packaging

- **Cargo feature `finnhub`** gates the driver (consistent with finstream's `#[cfg(feature="finnhub")]`).
  corelib's `rust/Cargo.toml` currently has **no `[features]` block** — Phase 1 adds one, with `finnhub`
  in `default` so the `.node` includes the class without extra flags *(agy spec-pass 🟡)*:
  ```toml
  [features]
  default = ["finnhub"]
  finnhub = []
  ```
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

**Brainstorm-phase pass** selected **S2.5** over Claude's S2: S2 would have flattened the FFI to a single
stream, breaking `ts-markets` consumers and invalidating the (c) integration spec (§5.4 names the
per-provider classes) and regressing redb persistence. S2.5 keeps per-provider facades + redb, adopts the
trait/schema/engine internally, and phases the work.

**Spec-phase pass** raised three 🔴 (folded above): the `spawn` snapshot missed dynamic subscriptions →
`connect_once` now takes `sub_rx` (§4.1); the mpsc→TSFN pump task would leak → `Drop` aborts both tasks
(§3.1, §4.3); driver-vs-supervisor reconnect ambiguity → supervisor owns the loop, driver does one attempt
and reports `Status::Connected` (§4.1) — mirroring corelib's existing `run_loop`/`ws_loop`. Plus 🟡s:
the missing Cargo `[features]` block (§6) and the pinned `FinnhubPricingData` with numeric `f64` timestamp
(§4.4). Adopted agy's `WebsocketStreamerHost<D>` so each FFI class is a thin delegate and Phase 2 becomes
a thin wrap of the Alpaca/Yahoo drivers. Full record in `ANTIGRAVITY-TO-CLAUDE.md`.
