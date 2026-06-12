# Provider Port — Phase 2a (Alpaca dual-mode migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Alpaca onto the shared streaming engine as the first **dual-mode** provider — emitting both the byte-identical raw payload and a unified (finstream-superset) `MarketEvent` — while widening its subscription surface to trades/quotes/bars.

**Architecture:** A `CoreEvent { Status, Pricing { raw, uni } }` channel replaces the engine's `MarketEvent` channel; drivers decode once and build both representations. A non-generic `WebsocketStreamerHost` owns redb + supervisor/monitor/pump + `Drop`. Alpaca becomes a thin facade + an `AlpacaDriver` whose `connect_once` does one attempt (auth→`Fatal`, ping + silence in its `select!`). Finnhub (Phase 1) is migrated to `CoreEvent` and retrofitted with the unified callback in the same foundation.

**Tech Stack:** Rust (napi-rs v3, tokio, tokio-tungstenite, redb 4.1, serde/serde_json, chrono, futures 0.3), TypeScript (vitest, EventEmitter).

**Spec:** `docs/superpowers/specs/2026-06-12-provider-port-phase2a-design.md` (read it; this plan implements it).

**Conventions for every task:**
- Rust tests/builds run from the `rust/` directory. Default features include `finnhub`. CLI bins need the `clap` feature.
  - Unit tests: `cargo test` (add `-- <name>` to target one).
  - Lint: `cargo clippy`. Bins compile: `cargo build --features clap`.
- TS tests run from repo root: `pnpm --filter @ckir/corelib-markets test:run`.
- Never bypass lefthook. Commits end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- Each task ends green (`cargo test` + `cargo clippy` clean) before the next starts.

**Suggested executor per task** (per the repo's bottom-up capability gating): Tasks **3, 7, 8** are cross-cutting/correctness-sensitive (engine type migration; driver `connect_once`; facade rewrite) — run on the main thread or a carefully-verified Sonnet. Tasks **1, 2, 4, 5, 6, 9, 10** are well-specified/mechanical — Sonnet subagents. Error-cost is high (financial streaming FFI): verify every Rust task with `cargo test` + `cargo clippy`.

---

## File Structure

**New files:**
- `rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs` — `CoreEvent`, `RawPricing`, and the moved raw FFI payload structs (`AlpacaPricingData`, `FinnhubPricingData`) — single definitions, `#[napi(object)]`, pure-Rust-usable.
- `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs` — `AlpacaDriver` (`impl ProviderDriver`) + pure frame-parse functions.

**Modified files:**
- `core/schema.rs` — add `Quote`, `MarketEvent::Quote`, `QuoteExtras`, `TradeExtras::{Yahoo,Alpaca}`, extras structs, flattening `Serialize`.
- `core/driver.rs` — trait `connect_once` `tx`/`sub_rx` types → `CoreEvent`/`SubRequest`; add `SubRequest`.
- `core/supervisor.rs` — thread the new channel types.
- `core/host.rs` — channel/pump → `CoreEvent`; monitor panic → `CoreEvent::Status`; add `delete_subscriptions_table` + channel-aware persistence helpers.
- `core/mod.rs` — `pub mod types;`.
- `finnhub/finnhub_driver.rs` — emit `CoreEvent`; `SubRequest`.
- `finnhub/finnhub_streamer.rs` — pump `FnMut(CoreEvent)`; optional 4th `on_market_event`; `uni = Some(Trade)`; `FinnhubPricingData` moves to `core/types.rs` (re-export).
- `alpaca/alpaca_streamer.rs` — rewritten thin facade; delete `AlpacaStreamingCore`/`AlpacaCallbacks`/`NapiCallbacks`/`Inner`/`WsLoopResult`; `AlpacaPricingData` moves to `core/types.rs` (re-export).
- `rust/src/bin/alpaca_streamer.rs` — rewritten onto host + driver.
- `rust/src/lib.rs` — module decls + re-exports (names unchanged).
- `ts-markets/.../alpaca/AlpacaStreaming.ts` + `.test.ts` — `"market"` event + `subscribe` overload.
- `ts-markets/.../finnhub/FinnhubStreaming.ts` — `"market"` event.
- `rust/index.d.ts`, `rust/index.js` — regenerated bindings.

---

## Task 1: Unified schema expansion (finstream + Alpaca superset)

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/schema.rs`

Port finstream's `Quote`/`QuoteExtras`/Yahoo extras and add the corelib `TradeExtras::Alpaca` superset, with the flattening `Serialize`. Additive only — nothing wires it yet, so mark new dead code `#[allow(dead_code)]`.

- [ ] **Step 1: Write the failing tests** — append to `core/schema.rs`:

```rust
#[cfg(test)]
mod schema_expansion_tests {
    use super::*;
    use chrono::TimeZone;

    fn ts() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc.timestamp_millis_opt(1_700_000_000_000).single().unwrap()
    }

    #[test]
    fn alpaca_quote_event_serializes_flat_with_nested_extras() {
        let ev = MarketEvent::Quote {
            source: "alpaca_main".into(),
            data: Quote {
                ticker: "AAPL".into(),
                timestamp: ts(),
                price: 191.5,
                extras: QuoteExtras::Alpaca(AlpacaQuoteExtras {
                    bid: 191.0, ask: 192.0, bid_size: 1.0, ask_size: 2.0,
                    bid_exchange: None, ask_exchange: None, conditions: vec![], tape: None,
                }),
                raw: None,
            },
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["source"], "alpaca_main");
        assert_eq!(v["type"], "quote");
        assert_eq!(v["ticker"], "AAPL");
        assert_eq!(v["price"], 191.5);
        assert_eq!(v["alpaca"]["bid"], 191.0);
        assert_eq!(v["alpaca"]["ask"], 192.0);
    }

    #[test]
    fn alpaca_trade_event_serializes_with_alpaca_extras() {
        let ev = MarketEvent::Trade {
            source: "alpaca_main".into(),
            data: Trade {
                ticker: "MSFT".into(),
                timestamp: ts(),
                price: 420.0,
                extras: TradeExtras::Alpaca(AlpacaTradeExtras {
                    size: 50.0, exchange: Some("V".into()), conditions: vec!["@".into()],
                    tape: Some("C".into()), id: Some(7),
                }),
                raw: None,
            },
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["ticker"], "MSFT");
        assert_eq!(v["alpaca"]["size"], 50.0);
        assert_eq!(v["alpaca"]["conditions"][0], "@");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust && cargo test schema_expansion_tests`
Expected: FAIL — `Quote`, `QuoteExtras`, `AlpacaQuoteExtras`, `AlpacaTradeExtras` not found; `MarketEvent` has no `Quote` variant; `TradeExtras` has no `Alpaca`.

- [ ] **Step 3: Implement the schema additions** — in `core/schema.rs`:

3a. Add the `Quote` variant to `MarketEvent` (keep the existing `Trade`/`Status`):

```rust
    Quote {
        source: String,
        data: Quote,
    },
```

3b. Extend `TradeExtras` and add `QuoteExtras` + the extras structs (place near the existing `FinnhubTradeExtras`):

```rust
/// Provider-specific trade metadata.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum TradeExtras {
    Finnhub(FinnhubTradeExtras),
    Yahoo(YahooTradeExtras),
    Alpaca(AlpacaTradeExtras), // corelib superset (not in finstream) — makes Alpaca trades uni-portable
}

/// Provider-specific quote metadata.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum QuoteExtras {
    Alpaca(AlpacaQuoteExtras),
    Yahoo(YahooQuoteExtras),
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlpacaTradeExtras {
    pub size: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub exchange: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]    pub conditions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub id: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlpacaQuoteExtras {
    pub bid: f64,
    pub ask: f64,
    pub bid_size: f64,
    pub ask_size: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub bid_exchange: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub ask_exchange: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]    pub conditions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tape: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct YahooTradeExtras {
    pub exchange: String,
    pub currency: String,
    pub market_hours: i32,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change_pct: f64,
    #[serde(skip_serializing_if = "is_zero_i64")] pub volume: i64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub open: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub day_high: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub day_low: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub prev_close: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub market_cap: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub bid: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub ask: f64,
    #[serde(skip_serializing_if = "is_zero_i64")] pub bid_size: i64,
    #[serde(skip_serializing_if = "is_zero_i64")] pub ask_size: i64,
    #[serde(skip_serializing_if = "String::is_empty")] pub short_name: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct YahooQuoteExtras {
    pub bid: f64,
    pub ask: f64,
    pub bid_size: i64,
    pub ask_size: i64,
    pub exchange: String,
    pub currency: String,
    pub market_hours: i32,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change: f64,
    #[serde(skip_serializing_if = "is_zero_f64")] pub change_pct: f64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Quote {
    pub ticker: String,
    pub timestamp: DateTime<Utc>,
    pub price: f64,
    pub extras: QuoteExtras,
    pub raw: Option<String>,
}

fn is_zero_f64(v: &f64) -> bool { *v == 0.0 }
fn is_zero_i64(v: &i64) -> bool { *v == 0 }
```

3c. Replace the `#[derive(...)]` on `MarketEvent` with a hand-written flattening `Serialize` (the existing enum derives nothing serde today; add the impl). Add `use serde::ser::SerializeMap;` import at the top as needed:

```rust
impl serde::Serialize for MarketEvent {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            MarketEvent::Trade { source, data } => {
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("source", source)?;
                m.serialize_entry("type", "trade")?;
                m.serialize_entry("ticker", &data.ticker)?;
                m.serialize_entry("timestamp", &data.timestamp)?;
                m.serialize_entry("price", &data.price)?;
                if let Some(raw) = &data.raw { m.serialize_entry("raw", raw)?; }
                match &data.extras {
                    TradeExtras::Finnhub(v) => m.serialize_entry("finnhub", v)?,
                    TradeExtras::Yahoo(v)   => m.serialize_entry("yahoo", v)?,
                    TradeExtras::Alpaca(v)  => m.serialize_entry("alpaca", v)?,
                }
                m.end()
            }
            MarketEvent::Quote { source, data } => {
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("source", source)?;
                m.serialize_entry("type", "quote")?;
                m.serialize_entry("ticker", &data.ticker)?;
                m.serialize_entry("timestamp", &data.timestamp)?;
                m.serialize_entry("price", &data.price)?;
                if let Some(raw) = &data.raw { m.serialize_entry("raw", raw)?; }
                match &data.extras {
                    QuoteExtras::Alpaca(v) => m.serialize_entry("alpaca", v)?,
                    QuoteExtras::Yahoo(v)  => m.serialize_entry("yahoo", v)?,
                }
                m.end()
            }
            MarketEvent::Status { source, status } => {
                let mut m = s.serialize_map(None)?;
                m.serialize_entry("source", source)?;
                let val = serde_json::to_value(status).map_err(serde::ser::Error::custom)?;
                if let serde_json::Value::Object(obj) = val {
                    for (k, v) in obj { m.serialize_entry(&k, &v)?; }
                }
                m.end()
            }
        }
    }
}
```

3d. `ProviderStatus` needs `Serialize` with finstream's tagged shape. Replace its derive/attrs:

```rust
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProviderStatus { /* existing variants unchanged */ }
```

And `ProviderKind` needs `Serialize` (lowercase) for nested use:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind { Alpaca, Finnhub, Yahoo }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test schema_expansion_tests && cargo test && cargo clippy`
Expected: PASS; whole suite still green; no clippy warnings.

- [ ] **Step 5: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/core/schema.rs
git commit -m "feat(streaming): expand unified schema (Quote + Alpaca/Yahoo extras + superset TradeExtras::Alpaca)"
```

---

## Task 2: `CoreEvent`/`RawPricing` + move raw payload structs into `core/types.rs`

**Files:**
- Create: `rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs`
- Modify: `core/mod.rs`, `alpaca/alpaca_streamer.rs` (remove `AlpacaPricingData` def), `finnhub/finnhub_streamer.rs` (remove `FinnhubPricingData` def), `rust/src/lib.rs` (re-exports).

Single-definition the raw payloads in `core/types.rs` and add the `CoreEvent` channel enum. Pure move (no field changes) so FFI binding names stay identical.

- [ ] **Step 1: Write the failing test** — append to the new `core/types.rs` (created in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn core_event_constructs_and_raw_payload_serializes_identically() {
        let raw = AlpacaPricingData {
            symbol: "AAPL".into(), message_type: "quote".into(), price: 1.0,
            bid_price: 1.0, ask_price: 2.0, volume: 3.0, timestamp: "t".into(),
        };
        let ev = CoreEvent::Pricing { raw: RawPricing::Alpaca(raw.clone()), uni: None };
        match ev { CoreEvent::Pricing { raw: RawPricing::Alpaca(p), uni } => {
            assert_eq!(p.symbol, "AAPL"); assert!(uni.is_none());
        }, _ => panic!() }
        // byte-identity of the moved payload shape:
        let v = serde_json::to_value(&raw).unwrap();
        assert_eq!(v["symbol"], "AAPL");
        assert_eq!(v["ask_price"], 2.0);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust && cargo test --lib types::tests`
Expected: FAIL — module `types` does not exist.

- [ ] **Step 3: Create `core/types.rs`** with the moved structs + `CoreEvent`/`RawPricing`. Copy `AlpacaPricingData` verbatim from `alpaca_streamer.rs` (the `#[napi(object)]` struct with `symbol/message_type/price/bid_price/ask_price/volume/timestamp:String` and its doc comments) and `FinnhubPricingData` verbatim from `finnhub_streamer.rs` (`symbol/message_type/price/volume/timestamp:f64/conditions`). Then:

```rust
//! Engine channel payload + single-definition raw FFI pricing structs.
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, ProviderStatus};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ... (moved) #[napi(object)] pub struct AlpacaPricingData { ... }
// ... (moved) #[napi(object)] pub struct FinnhubPricingData { ... }

/// Lossless raw pricing payload carried on the engine channel (one variant per provider).
#[allow(dead_code)] // Yahoo variant added in Phase 2b; Alpaca produced from Task 7 on
pub enum RawPricing {
    Alpaca(AlpacaPricingData),
    Finnhub(FinnhubPricingData),
}

/// The shared engine channel item: a lifecycle status, or a pricing tick with the raw
/// payload plus an optional unified MarketEvent (None ⇒ raw-only, e.g. Alpaca bars).
#[allow(dead_code)]
pub enum CoreEvent {
    Status(ProviderStatus),
    Pricing { raw: RawPricing, uni: Option<MarketEvent> },
}
```

- [ ] **Step 4: Move the definitions** (remove the originals; re-export so names are unchanged):
  - In `alpaca_streamer.rs`: delete the `AlpacaPricingData` struct definition; add near the top
    `pub use crate::markets::nasdaq::datafeeds::streaming::core::types::AlpacaPricingData;`.
  - In `finnhub_streamer.rs`: delete the `FinnhubPricingData` struct definition; add
    `pub use crate::markets::nasdaq::datafeeds::streaming::core::types::FinnhubPricingData;`. (The mapper `market_event_to_finnhub_pricing` keeps working against the re-export.)
  - In `core/mod.rs`: add `pub mod types;`.
  - In `lib.rs`: the existing `pub use ...alpaca::{... AlpacaPricingData ...}` and
    `...finnhub_streamer::{... FinnhubPricingData ...}` re-exports still resolve (they point at the module re-exports) — **leave the public re-export names unchanged**.

- [ ] **Step 5: Run to verify pass**

Run: `cd rust && cargo test && cargo clippy`
Expected: PASS; existing Finnhub/Alpaca tests still green; the `AlpacaPricingData`/`FinnhubPricingData` napi objects are registered exactly once.

- [ ] **Step 6: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/core/ rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs
git commit -m "feat(streaming): add CoreEvent/RawPricing; single-define raw payloads in core/types"
```

---

## Task 3: Engine channel migration to `CoreEvent` + `SubRequest`, with Finnhub retrofit

**Files:**
- Modify: `core/driver.rs`, `core/supervisor.rs`, `core/host.rs`, `finnhub/finnhub_driver.rs`, `finnhub/finnhub_streamer.rs`.

> **Cross-cutting type change — run on the main thread or a carefully verified Sonnet.** One atomic commit: the engine channel becomes `CoreEvent` and the live-subscription channel element becomes `SubRequest`, so the trait, supervisor, host, and the only existing consumer (Finnhub) all change together. The acceptance test is that Finnhub still works **and** emits the new unified callback.

- [ ] **Step 1: Write the failing test** — add to `finnhub/finnhub_driver.rs` tests (the parser already builds `MarketEvent::Trade`; assert the driver now emits `CoreEvent`). Add a mapper-level test in `finnhub_streamer.rs`:

```rust
// in finnhub_streamer.rs tests
#[test]
fn finnhub_trade_maps_to_unified_market_event_trade() {
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, Trade, TradeExtras, FinnhubTradeExtras};
    let ev = MarketEvent::Trade {
        source: "finnhub_main".into(),
        data: Trade {
            ticker: "AAPL".into(),
            timestamp: chrono::Utc.timestamp_millis_opt(1_700_000_000_000).single().unwrap(),
            price: 191.5,
            extras: TradeExtras::Finnhub(FinnhubTradeExtras { volume: 100.0, conditions: vec!["@".into()] }),
            raw: None,
        },
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["type"], "trade");
    assert_eq!(v["finnhub"]["volume"], 100.0);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust && cargo test finnhub_trade_maps_to_unified`
Expected: FAIL (compile error referencing not-yet-imported items) — confirms the test targets the new behavior.

- [ ] **Step 3: Add `SubRequest` and change the driver trait** — in `core/driver.rs`:

```rust
use crate::markets::nasdaq::datafeeds::streaming::core::types::CoreEvent;

/// A live subscription update routed to a driver: a channel name + the symbols.
/// Single-channel providers use a fixed channel and ignore the tag.
#[derive(Debug, Clone)]
pub struct SubRequest {
    pub channel: String,
    pub symbols: Vec<String>,
}
```

Change `connect_once`'s params: `tx: &'a mpsc::Sender<MarketEvent>` → `tx: &'a mpsc::Sender<CoreEvent>`, and `sub_rx: &'a mut mpsc::Receiver<Vec<String>>` → `sub_rx: &'a mut mpsc::Receiver<SubRequest>`. Update the `use` of `MarketEvent` accordingly (the trait no longer needs it directly).

- [ ] **Step 4: Thread the types through `supervisor.rs`** — change the generic channel types on `run_supervisor`:
  `tx: mpsc::Sender<MarketEvent>` → `mpsc::Sender<CoreEvent>`; `sub_rx: mpsc::Receiver<Vec<String>>` → `mpsc::Receiver<SubRequest>`. The body is otherwise unchanged (it never sends on `tx`; it only forwards to `connect_once` and reads `AttemptOutcome`). Update `use` imports.

- [ ] **Step 5: Migrate `host.rs`:**
  - Channel: `mpsc::channel::<MarketEvent>(1024)` → `mpsc::channel::<CoreEvent>(1024)`; `sub_tx/sub_rx` element `Vec<String>` → `SubRequest`.
  - `start<D, P>` bound `P: FnMut(MarketEvent)` → `P: FnMut(CoreEvent)`.
  - Monitor panic sender (≈ host.rs L107-118): replace `MarketEvent::Status { source, status: ProviderStatus::Error {..} }` with `CoreEvent::Status(ProviderStatus::Error { provider, message: "supervisor task panicked; stream is dead".into() })`.
  - `subscribe()` currently sends `Vec<String>` on `sub_tx`; change to send `SubRequest { channel: <default>, symbols }`. Keep the existing `subscribe(&self, symbols: Vec<String>)` signature working for single-channel callers by sending a fixed default channel (parameterize in Task 4).

- [ ] **Step 6: Migrate `finnhub_driver.rs`:**
  - `connect_once` signature picks up `tx: &mpsc::Sender<CoreEvent>` and `sub_rx: &mut mpsc::Receiver<SubRequest>`.
  - The `Status::Connected` send becomes `tx.send(CoreEvent::Status(ProviderStatus::Connected { provider: ProviderKind::Finnhub })).await`.
  - The trade send: for each parsed `MarketEvent::Trade`, build the raw payload and the uni, then send `CoreEvent::Pricing { raw: RawPricing::Finnhub(map_to_finnhub_pricing(&trade_ev)), uni: Some(trade_ev) }`. Reuse `market_event_to_finnhub_pricing` (now returning the moved type) for `raw`.
  - The `sub_rx` branch: `Some(SubRequest { symbols, .. }) => { /* subscribe each new symbol as today */ }` (Finnhub ignores `channel`); `None => return AttemptOutcome::Stopped`.

- [ ] **Step 7: Migrate `finnhub_streamer.rs` pump + add the 4th callback:**
  - Constructor gains `on_market_event: Option<ThreadsafeFunction<String>>` as a 4th arg; store it as `Arc<...>` (wrap the `Option`).
  - Pump closure becomes `move |ev: CoreEvent| { match ev {
      CoreEvent::Pricing { raw: RawPricing::Finnhub(p), uni } => {
          let _ = on_pricing.call(Ok(p), NonBlocking);
          if let (Some(cb), Some(u)) = (on_market_event.as_ref(), uni) {
              if let Ok(j) = serde_json::to_string(&u) { let _ = cb.call(Ok(j), NonBlocking); }
          }
      }
      CoreEvent::Status(s) => { /* existing status→EventRecord mapping, now matching on ProviderStatus */ }
      _ => {}
  } }`.
  - The status mapping previously matched `MarketEvent::Status { status, .. }`; it now matches `CoreEvent::Status(status)` directly.

- [ ] **Step 8: Run to verify pass**

Run: `cd rust && cargo test && cargo clippy`
Expected: PASS — all existing Finnhub tests + the new unified-mapping test green; no clippy warnings. (If the Finnhub TS constructor passes only 3 args, that still works because the 4th is `Option`.)

- [ ] **Step 9: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/core/ rust/src/markets/nasdaq/datafeeds/streaming/finnhub/
git commit -m "feat(streaming): migrate engine channel to CoreEvent + SubRequest; retrofit Finnhub dual-mode"
```

---

## Task 4: Host persistence helpers (channel-aware + table delete)

**Files:**
- Modify: `core/host.rs`

Additive helpers Alpaca needs; the existing bare-`Vec<String>` API stays so Finnhub is untouched.

- [ ] **Step 1: Write the failing tests** — append to `core/host.rs`:

```rust
#[cfg(test)]
mod host_persistence_tests {
    use super::*;
    fn fresh() -> WebsocketStreamerHost {
        WebsocketStreamerHost::new(unique_db_path("test_host", "TEST_HOST_DB_UNSET"),
            "test_subscriptions", "test".into(), ProviderKind::Alpaca)
    }
    #[tokio::test]
    async fn channel_keys_roundtrip_and_unsubscribe_is_precise() {
        let h = fresh();
        h.subscribe_channel("quotes", vec!["AAPL".into(), "MSFT".into()]);
        h.subscribe_channel("trades", vec!["AAPL".into()]);
        let mut q = h.get_persisted_subscriptions_for_channel("quotes", "quotes");
        q.sort();
        assert_eq!(q, vec!["AAPL".to_string(), "MSFT".to_string()]);
        assert_eq!(h.get_persisted_subscriptions_for_channel("trades", "quotes"), vec!["AAPL".to_string()]);
        h.unsubscribe_channel("quotes", vec!["AAPL".into()]);
        assert_eq!(h.get_persisted_subscriptions_for_channel("quotes", "quotes"), vec!["MSFT".to_string()]);
        // trades:AAPL untouched
        assert_eq!(h.get_persisted_subscriptions_for_channel("trades", "quotes"), vec!["AAPL".to_string()]);
    }
    #[tokio::test]
    async fn colonless_legacy_key_defaults_to_channel() {
        let h = fresh();
        // simulate a legacy bare-symbol record via the existing API
        h.subscribe(vec!["TSLA".into()]).await; // writes "TSLA" (bare) through the legacy path? see note
        let got = h.get_persisted_subscriptions_for_channel("quotes", "quotes");
        assert!(got.contains(&"TSLA".to_string()));
    }
    #[tokio::test]
    async fn delete_subscriptions_table_clears_all() {
        let h = fresh();
        h.subscribe_channel("quotes", vec!["AAPL".into()]);
        h.delete_subscriptions_table().unwrap();
        assert!(h.get_persisted_subscriptions_for_channel("quotes", "quotes").is_empty());
    }
}
```

> Note: the legacy `subscribe(Vec<String>)` writes bare symbol keys today. Keep that behavior for single-channel providers; `subscribe_channel` writes composite `channel:symbol` keys.

- [ ] **Step 2: Run to verify failure**

Run: `cd rust && cargo test host_persistence_tests`
Expected: FAIL — `subscribe_channel`/`get_persisted_subscriptions_for_channel`/`unsubscribe_channel`/`delete_subscriptions_table` not found.

- [ ] **Step 3: Implement the helpers** — in `impl WebsocketStreamerHost`:

```rust
/// Write `channel:symbol` composite keys (multi-channel providers).
pub fn subscribe_channel(&self, channel: &str, symbols: Vec<String>) {
    let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
    if let Ok(wtx) = self.db.begin_write() {
        if let Ok(mut t) = wtx.open_table(table) {
            for s in &symbols { let _ = t.insert(format!("{channel}:{s}").as_str(), true); }
        }
        let _ = wtx.commit();
    }
}

/// Remove precise `channel:symbol` keys.
pub fn unsubscribe_channel(&self, channel: &str, symbols: Vec<String>) {
    let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
    if let Ok(wtx) = self.db.begin_write() {
        if let Ok(mut t) = wtx.open_table(table) {
            for s in &symbols { let _ = t.remove(format!("{channel}:{s}").as_str()); }
        }
        let _ = wtx.commit();
    }
}

/// Read symbols for `target_channel`; a colon-less (legacy bare) key is treated as `default_channel`.
pub fn get_persisted_subscriptions_for_channel(&self, target_channel: &str, default_channel: &str) -> Vec<String> {
    let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
    let mut out = Vec::new();
    if let Ok(rtx) = self.db.begin_read() {
        if let Ok(t) = rtx.open_table(table) {
            let Ok(iter) = t.iter() else { return out };
            for item in iter {
                let Ok(entry) = item else { continue };
                let key = entry.0.value().to_string();
                let (ch, sym) = key.split_once(':').unwrap_or((default_channel, key.as_str()));
                if ch == target_channel { out.push(sym.to_string()); }
            }
        }
    }
    out
}

/// Drop the entire subscriptions table (for `clean()`).
pub fn delete_subscriptions_table(&self) -> Result<(), String> {
    let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
    let wtx = self.db.begin_write().map_err(|e| e.to_string())?;
    let _ = wtx.delete_table(table);
    wtx.commit().map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test host_persistence_tests && cargo test && cargo clippy`
Expected: PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs
git commit -m "feat(streaming): channel-aware redb helpers + delete_subscriptions_table on host"
```

---

## Task 5: Finnhub TS unified `"market"` event

**Files:**
- Modify: `ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts`

Wire the new optional 4th callback so Finnhub TS consumers can get the unified stream too (3-provider parity).

- [ ] **Step 1: Write the failing test** — add to (or create) `FinnhubStreaming.test.ts` a unit asserting a `"market"` listener fires when the 4th FFI callback is invoked. Use the existing test's FFI-mock pattern (mirror `AlpacaStreaming.test.ts`). Minimal shape:

```ts
it("emits 'market' when the unified callback fires", async () => {
  // arrange a fake coreFFI.FinnhubStreaming whose constructor captures the 4th cb
  // act: invoke the captured 4th cb with JSON.stringify({ type: "trade", ticker: "AAPL" })
  // assert: the "market" event fired with the parsed object
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ckir/corelib-markets test:run`
Expected: FAIL — no `"market"` emission (only 3 callbacks wired).

- [ ] **Step 3: Implement** — in `FinnhubStreaming.ts`, pass a 4th constructor arg to the FFI class:

```ts
this.rust = new RustFinnhub(
  (_e: any, r: any) => this.emit("log", r),
  (_e: any, d: any) => this.emit("pricing", d),
  (_e: any, ev: any) => { if (ev) this.emit(ev.type, ev.data ?? null); },
  (_e: any, json: string) => { try { this.emit("market", JSON.parse(json)); } catch {} },
);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ckir/corelib-markets test:run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ts-markets/src/nasdaq/datafeeds/streaming/finnhub/
git commit -m "feat(markets): FinnhubStreaming emits unified 'market' event"
```

---

## Task 6: AlpacaDriver frame parsing (pure functions)

**Files:**
- Create: `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs`
- Modify: `alpaca/mod.rs`-equivalent decl in `lib.rs` (add `pub mod alpaca_driver;`).

Pure decode functions, fully unit-testable without a socket. They produce `(AlpacaPricingData /*raw*/, Option<MarketEvent> /*uni*/)`.

- [ ] **Step 1: Write the failing tests** — in `alpaca_driver.rs`:

```rust
#[cfg(test)]
mod parse_tests {
    use super::*;
    #[test]
    fn quote_builds_raw_and_unified() {
        let obj: serde_json::Value = serde_json::from_str(
            r#"{"T":"q","S":"AAPL","bp":191.0,"ap":192.0,"bs":1,"as":2,"bx":"V","ax":"V","c":["R"],"z":"C","t":"2024-01-02T15:00:00Z"}"#).unwrap();
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "quote");
        assert_eq!(raw.bid_price, 191.0);
        assert_eq!(raw.ask_price, 192.0);
        let v = serde_json::to_value(&uni.unwrap()).unwrap();
        assert_eq!(v["type"], "quote");
        assert_eq!(v["price"], 191.5); // mid
        assert_eq!(v["alpaca"]["bid"], 191.0);
    }
    #[test]
    fn trade_builds_raw_and_unified_trade() {
        let obj: serde_json::Value = serde_json::from_str(
            r#"{"T":"t","S":"MSFT","p":420.0,"s":50,"x":"V","c":["@"],"z":"C","i":7,"t":"2024-01-02T15:00:00Z"}"#).unwrap();
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "trade");
        assert_eq!(raw.price, 420.0);
        let v = serde_json::to_value(&uni.unwrap()).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["alpaca"]["size"], 50.0);
    }
    #[test]
    fn bar_builds_raw_only() {
        let obj: serde_json::Value = serde_json::from_str(
            r#"{"T":"b","S":"TSLA","c":250.0,"v":1000,"t":"2024-01-02T15:00:00Z"}"#).unwrap();
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "bar");
        assert_eq!(raw.price, 250.0);
        assert!(uni.is_none()); // bars are raw-only
    }
    #[test]
    fn non_pricing_returns_none() {
        let obj: serde_json::Value = serde_json::from_str(r#"{"T":"subscription"}"#).unwrap();
        assert!(parse_alpaca_obj(&obj, "s").is_none());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust && cargo test parse_tests`
Expected: FAIL — module/`parse_alpaca_obj` missing.

- [ ] **Step 3: Implement the parser** — in `alpaca_driver.rs`:

```rust
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
    AlpacaQuoteExtras, AlpacaTradeExtras, MarketEvent, Quote, QuoteExtras, Trade, TradeExtras,
};
use crate::markets::nasdaq::datafeeds::streaming::core::types::AlpacaPricingData;
use chrono::{DateTime, Utc};

fn f(o: &serde_json::Value, k: &str) -> f64 { o.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0) }
fn s(o: &serde_json::Value, k: &str) -> String { o.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string() }
fn opt_s(o: &serde_json::Value, k: &str) -> Option<String> { o.get(k).and_then(|v| v.as_str()).map(str::to_owned) }
fn conds(o: &serde_json::Value) -> Vec<String> {
    o.get("c").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}
fn parse_ts(o: &serde_json::Value) -> DateTime<Utc> {
    o.get("t").and_then(|v| v.as_str()).and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|dt| dt.with_timezone(&Utc)).unwrap_or_else(Utc::now)
}

/// Decode one Alpaca data object into (raw payload, optional unified event). `None` for non-pricing.
pub fn parse_alpaca_obj(o: &serde_json::Value, source: &str) -> Option<(AlpacaPricingData, Option<MarketEvent>)> {
    let ticker = s(o, "S");
    let ts_str = s(o, "t");
    match o.get("T").and_then(|t| t.as_str()).unwrap_or("") {
        "q" => {
            let (bid, ask) = (f(o, "bp"), f(o, "ap"));
            let raw = AlpacaPricingData { symbol: ticker.clone(), message_type: "quote".into(),
                price: bid, bid_price: bid, ask_price: ask, volume: f(o, "bs"), timestamp: ts_str };
            let uni = MarketEvent::Quote { source: source.into(), data: Quote {
                ticker, timestamp: parse_ts(o), price: (bid + ask) / 2.0,
                extras: QuoteExtras::Alpaca(AlpacaQuoteExtras { bid, ask, bid_size: f(o, "bs"),
                    ask_size: f(o, "as"), bid_exchange: opt_s(o, "bx"), ask_exchange: opt_s(o, "ax"),
                    conditions: conds(o), tape: opt_s(o, "z") }),
                raw: Some(o.to_string()) } };
            Some((raw, Some(uni)))
        }
        "t" => {
            let price = f(o, "p");
            let raw = AlpacaPricingData { symbol: ticker.clone(), message_type: "trade".into(),
                price, bid_price: 0.0, ask_price: 0.0, volume: f(o, "s"), timestamp: ts_str };
            let uni = MarketEvent::Trade { source: source.into(), data: Trade {
                ticker, timestamp: parse_ts(o), price,
                extras: TradeExtras::Alpaca(AlpacaTradeExtras { size: f(o, "s"), exchange: opt_s(o, "x"),
                    conditions: conds(o), tape: opt_s(o, "z"), id: o.get("i").and_then(|v| v.as_i64()) }),
                raw: Some(o.to_string()) } };
            Some((raw, Some(uni)))
        }
        "b" => {
            let raw = AlpacaPricingData { symbol: ticker, message_type: "bar".into(),
                price: f(o, "c"), bid_price: 0.0, ask_price: 0.0, volume: f(o, "v"), timestamp: ts_str };
            Some((raw, None)) // bars raw-only
        }
        _ => None,
    }
}
```

Register the module in `lib.rs` under the `alpaca` module: add `pub mod alpaca_driver;`.

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test parse_tests && cargo clippy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs rust/src/lib.rs
git commit -m "feat(streaming): AlpacaDriver frame parsers (q/t/b → raw + unified)"
```

---

## Task 7: AlpacaDriver `connect_once` (auth, ping, silence, channel subscribe)

**Files:**
- Modify: `alpaca/alpaca_driver.rs`

> **Correctness-sensitive (auth + reconnect semantics) — main thread or carefully verified Sonnet.** Port the existing `ws_loop` handshake/`select!` from `alpaca_streamer.rs` onto the single-attempt `connect_once` contract, emitting `CoreEvent`.

- [ ] **Step 1: Write the failing test** — assert the driver type implements the trait and validates config:

```rust
#[cfg(test)]
mod driver_tests {
    use super::*;
    #[test]
    fn validate_requires_credentials() {
        let d = AlpacaDriver { name: "alpaca_main".into(), base_url: None, key_id: String::new(),
            secret_key: String::new(), silence_seconds: 60 };
        assert!(d.validate().is_err());
        let d2 = AlpacaDriver { name: "alpaca_main".into(), base_url: None, key_id: "k".into(),
            secret_key: "s".into(), silence_seconds: 60 };
        assert!(d2.validate().is_ok());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust && cargo test driver_tests`
Expected: FAIL — `AlpacaDriver` not defined.

- [ ] **Step 3: Implement `AlpacaDriver` + `connect_once`** — append to `alpaca_driver.rs`. Port the handshake and `select!` from the existing `ws_loop` (`alpaca_streamer.rs` L355-657), adapting to emit `CoreEvent` and consume `SubRequest`:

```rust
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{AttemptOutcome, ProviderDriver, SubRequest};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use futures::future::{BoxFuture, FutureExt};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_ALPACA_WS_URL: &str = "wss://stream.data.alpaca.markets/v2/iex";
const PING_INTERVAL: u64 = 30;
const ALPACA_CHANNELS: [&str; 3] = ["trades", "quotes", "bars"];

pub struct AlpacaDriver {
    pub name: String,
    pub base_url: Option<String>,
    pub key_id: String,
    pub secret_key: String,
    pub silence_seconds: u32,
}

impl AlpacaDriver {
    /// Build the consolidated subscribe payload from the resumed redb channel map.
    fn initial_subscribe_json(&self, by_channel: &[(String, Vec<String>)]) -> Option<String> {
        let mut map = serde_json::Map::new();
        map.insert("action".into(), serde_json::json!("subscribe"));
        let mut any = false;
        for (ch, syms) in by_channel {
            if !syms.is_empty() { map.insert(ch.clone(), serde_json::json!(syms)); any = true; }
        }
        any.then(|| serde_json::Value::Object(map).to_string())
    }
}

impl ProviderDriver for AlpacaDriver {
    fn validate(&self) -> Result<(), String> {
        if self.key_id.is_empty() || self.secret_key.is_empty() {
            Err("APCA_API_KEY_ID / APCA_API_SECRET_KEY required".into())
        } else { Ok(()) }
    }

    fn connect_once<'a>(
        &'a self,
        symbols: &'a [String], // unused: Alpaca resumes per-channel via the host (see facade Task 8)
        tx: &'a mpsc::Sender<CoreEvent>,
        sub_rx: &'a mut mpsc::Receiver<SubRequest>,
        stop_rx: &'a mut mpsc::Receiver<()>,
    ) -> BoxFuture<'a, AttemptOutcome> {
        async move {
            let _ = symbols; // resume handled via initial SubRequests pushed by the facade
            let url = self.base_url.clone().unwrap_or_else(|| DEFAULT_ALPACA_WS_URL.to_string());
            let (mut ws, _) = match connect_async(&url).await {
                Ok(v) => v, Err(_) => return AttemptOutcome::NeverConnected,
            };
            // {"T":"success","msg":"connected"}
            if let Some(Ok(Message::Text(m))) = ws.next().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&m) {
                    let ok = v.as_array().and_then(|a| a.first())
                        .map(|f| f["T"] == "success" && f["msg"] == "connected").unwrap_or(false);
                    if !ok { return AttemptOutcome::NeverConnected; }
                }
            } else { return AttemptOutcome::NeverConnected; }
            // auth
            let auth = serde_json::json!({"action":"auth","key":self.key_id,"secret":self.secret_key}).to_string();
            if ws.send(Message::Text(auth.into())).await.is_err() { return AttemptOutcome::NeverConnected; }
            if let Some(Ok(Message::Text(m))) = ws.next().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&m) {
                    if let Some(f) = v.as_array().and_then(|a| a.first()) {
                        if f["T"] == "error" {
                            let msg = f["msg"].as_str().unwrap_or("auth error").to_string();
                            let _ = tx.send(CoreEvent::Status(ProviderStatus::Error {
                                provider: ProviderKind::Alpaca, message: msg.clone() })).await;
                            return AttemptOutcome::Fatal(msg);
                        }
                        let ok = f["T"] == "success" && f["msg"] == "authenticated";
                        if !ok { return AttemptOutcome::NeverConnected; }
                    }
                }
            } else { return AttemptOutcome::NeverConnected; }

            let _ = tx.send(CoreEvent::Status(ProviderStatus::Connected { provider: ProviderKind::Alpaca })).await;

            // initial subscribe: drain any SubRequests the facade pre-queued (resume) + group by channel
            let mut by_channel: Vec<(String, Vec<String>)> =
                ALPACA_CHANNELS.iter().map(|c| (c.to_string(), Vec::new())).collect();
            while let Ok(req) = sub_rx.try_recv() {
                if let Some(slot) = by_channel.iter_mut().find(|(c, _)| *c == req.channel) {
                    for s in req.symbols { if !slot.1.contains(&s) { slot.1.push(s); } }
                }
            }
            if let Some(payload) = self.initial_subscribe_json(&by_channel) {
                if ws.send(Message::Text(payload.into())).await.is_err() { return AttemptOutcome::ConnectedThenDropped; }
            }

            let mut silence = tokio::time::interval(tokio::time::Duration::from_secs(self.silence_seconds.max(1) as u64));
            let mut ping = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL));
            let _ = silence.tick().await; let _ = ping.tick().await;

            loop {
                tokio::select! {
                    _ = stop_rx.recv() => return AttemptOutcome::Stopped,
                    req = sub_rx.recv() => {
                        match req {
                            Some(r) => {
                                let payload = serde_json::json!({"action":"subscribe", r.channel: r.symbols}).to_string();
                                let _ = ws.send(Message::Text(payload.into())).await;
                            }
                            None => return AttemptOutcome::Stopped,
                        }
                    }
                    _ = ping.tick() => { let _ = ws.send(Message::Ping(vec![].into())).await; }
                    _ = silence.tick() => return AttemptOutcome::ConnectedThenDropped,
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            silence.reset();
                            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&t) {
                                for o in &items {
                                    if let Some((raw, uni)) = parse_alpaca_obj(o, &self.name) {
                                        let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Alpaca(raw), uni }).await;
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => return AttemptOutcome::ConnectedThenDropped,
                    }
                }
            }
        }.boxed()
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test driver_tests && cargo test && cargo clippy`
Expected: PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs
git commit -m "feat(streaming): AlpacaDriver connect_once (auth→Fatal, ping, silence, channel subscribe)"
```

---

## Task 8: Rewrite the `AlpacaStreaming` facade (dual-mode, thin delegate)

**Files:**
- Modify: `alpaca/alpaca_streamer.rs` (delete `AlpacaStreamingCore`/`AlpacaCallbacks`/`NapiCallbacks`/`Inner`/`WsLoopResult`; rewrite the `#[napi]` facade to delegate to the host; keep `AlpacaConfig` with masked `Debug`).

> **Correctness-sensitive FFI rewrite — main thread or carefully verified Sonnet.** Mirror `FinnhubStreaming` (Phase 1) structurally; add the dual-mode pump + `AlpacaSubscribeOpts`.

- [ ] **Step 1: Write the failing test** — append to `alpaca_streamer.rs` tests:

```rust
#[cfg(test)]
mod facade_tests {
    use super::*;
    #[tokio::test]
    async fn subscribe_persists_per_channel_and_resumes() {
        std::env::set_var("ALPACA_DB", std::env::temp_dir()
            .join(format!("test_alpaca_facade_{}_{}.redb", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()))
            .to_string_lossy().to_string());
        // Build the host the same way the facade does and assert channel persistence/resume.
        let host = crate::markets::nasdaq::datafeeds::streaming::core::host::WebsocketStreamerHost::new(
            crate::markets::nasdaq::datafeeds::streaming::core::host::unique_db_path("alpaca_streaming", "ALPACA_DB"),
            "alpaca_subscriptions", "alpaca".into(),
            crate::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind::Alpaca);
        host.subscribe_channel("trades", vec!["AAPL".into()]);
        assert_eq!(host.get_persisted_subscriptions_for_channel("trades", "quotes"), vec!["AAPL".to_string()]);
        std::env::remove_var("ALPACA_DB");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust && cargo test facade_tests`
Expected: FAIL until the file compiles with the rewritten facade (old `Inner`/`AlpacaStreamingCore` references removed).

- [ ] **Step 3: Rewrite the facade.** Replace everything except `AlpacaConfig` (keep it + its masked `Debug`) and the re-export of `AlpacaPricingData`. Model on `finnhub_streamer.rs`:

```rust
use crate::markets::nasdaq::datafeeds::streaming::core::host::{unique_db_path, WebsocketStreamerHost};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use crate::markets::nasdaq::datafeeds::streaming::alpaca::alpaca_driver::AlpacaDriver;
use crate::{EventRecord, LogRecord};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;
use tokio::sync::Mutex;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct AlpacaSubscribeOpts {
    pub trades: Option<Vec<String>>,
    pub quotes: Option<Vec<String>>,
    pub bars: Option<Vec<String>>,
}

struct AlpacaInner { host: WebsocketStreamerHost, config: AlpacaConfig, started: bool }

#[napi]
pub struct AlpacaStreaming {
    inner: Arc<Mutex<AlpacaInner>>,
    on_log: Arc<ThreadsafeFunction<LogRecord>>,
    on_pricing: Arc<ThreadsafeFunction<AlpacaPricingData>>,
    on_event: Arc<ThreadsafeFunction<EventRecord>>,
    on_market_event: Option<Arc<ThreadsafeFunction<String>>>,
}

#[napi]
impl AlpacaStreaming {
    #[napi(constructor)]
    pub fn new(
        on_log: ThreadsafeFunction<LogRecord>,
        on_pricing: ThreadsafeFunction<AlpacaPricingData>,
        on_event: ThreadsafeFunction<EventRecord>,
        on_market_event: Option<ThreadsafeFunction<String>>,
    ) -> Self {
        let host = WebsocketStreamerHost::new(
            unique_db_path("alpaca_streaming", "ALPACA_DB"),
            "alpaca_subscriptions", "alpaca".into(), ProviderKind::Alpaca);
        Self {
            inner: Arc::new(Mutex::new(AlpacaInner { host, config: AlpacaConfig::default_empty(), started: false })),
            on_log: Arc::new(on_log), on_pricing: Arc::new(on_pricing), on_event: Arc::new(on_event),
            on_market_event: on_market_event.map(Arc::new),
        }
    }

    #[napi]
    pub async fn init(&self, config: AlpacaConfig) -> Result<()> {
        self.inner.lock().await.config = config; Ok(())
    }

    #[napi]
    pub async fn start(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        if g.started { return Ok(()); }
        let driver = AlpacaDriver {
            name: "alpaca".into(),
            base_url: g.config.base_url.clone().or_else(|| std::env::var("APCA_API_BASE_URL").ok()),
            key_id: g.config.key_id.clone().or_else(|| std::env::var("APCA_API_KEY_ID").ok()).unwrap_or_default(),
            secret_key: g.config.secret_key.clone().or_else(|| std::env::var("APCA_API_SECRET_KEY").ok()).unwrap_or_default(),
            silence_seconds: g.config.silence_seconds.unwrap_or(60),
        };
        // resume persisted subscriptions per channel by pre-queuing SubRequests via the live sub_tx
        for ch in ["trades", "quotes", "bars"] {
            let syms = g.host.get_persisted_subscriptions_for_channel(ch, "quotes");
            if !syms.is_empty() { g.host.subscribe_channel_live(ch, syms); }
        }
        let on_pricing = Arc::clone(&self.on_pricing);
        let on_event = Arc::clone(&self.on_event);
        let on_market = self.on_market_event.clone();
        g.host.start(driver, Vec::new(), ReconnectPolicy { jitter: true, ..Default::default() },
            move |ev: CoreEvent| match ev {
                CoreEvent::Pricing { raw: RawPricing::Alpaca(p), uni } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let (Some(cb), Some(u)) = (on_market.as_ref(), uni) {
                        if let Ok(j) = serde_json::to_string(&u) {
                            let _ = cb.call(Ok(j), ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                }
                CoreEvent::Status(status) => {
                    let (t, d) = match status {
                        ProviderStatus::Connected { .. } => ("connected".to_string(), None),
                        ProviderStatus::Disconnected { reason, .. } => ("disconnected".to_string(), Some(reason)),
                        ProviderStatus::Reconnecting { attempt, delay_ms, .. } =>
                            ("reconnecting".to_string(), Some(format!("attempt {attempt}, {delay_ms}ms"))),
                        ProviderStatus::Error { message, .. } => ("error".to_string(), Some(message)),
                    };
                    let _ = on_event.call(Ok(EventRecord { r#type: t, data: d }), ThreadsafeFunctionCallMode::NonBlocking);
                }
                _ => {}
            });
        let _ = self.on_log.call(Ok(LogRecord { level: "debug".into(), msg: "alpaca start".into(), extras: None }),
            ThreadsafeFunctionCallMode::NonBlocking);
        g.started = true; Ok(())
    }

    #[napi]
    pub async fn subscribe(&self, opts: AlpacaSubscribeOpts) -> Result<()> {
        let g = self.inner.lock().await;
        for (ch, syms) in [("trades", opts.trades), ("quotes", opts.quotes), ("bars", opts.bars)] {
            if let Some(s) = syms { if !s.is_empty() { g.host.subscribe_channel(ch, s.clone()); g.host.subscribe_channel_live(ch, s); } }
        }
        Ok(())
    }

    #[napi]
    pub async fn unsubscribe(&self, opts: AlpacaSubscribeOpts) -> Result<()> {
        let g = self.inner.lock().await;
        for (ch, syms) in [("trades", opts.trades), ("quotes", opts.quotes), ("bars", opts.bars)] {
            if let Some(s) = syms { g.host.unsubscribe_channel(ch, s); }
        }
        Ok(())
    }

    #[napi]
    pub async fn clean(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        let _ = g.host.delete_subscriptions_table();
        if let Some(tx) = g.host.stop_tx.take() { let _ = tx.try_send(()); }
        g.started = false; Ok(())
    }

    #[napi]
    pub async fn stop(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        if let Some(tx) = g.host.stop_tx.take() { let _ = tx.try_send(()); }
        g.started = false; Ok(())
    }
}
```

Add two host conveniences used above: a `subscribe_channel_live(&self, channel, symbols)` that sends a `SubRequest { channel, symbols }` on `sub_tx` if present (so a running stream gets it); and a `AlpacaConfig::default_empty()` associated fn (all `None`). Keep `AlpacaConfig`'s masked `Debug`. Document `db_path` as a legacy no-op in its doc comment.

> If `start` borrows `g.host` mutably for `.start()` while also reading persisted subs, split the borrows: read the resume lists first into locals, then call `g.host.start(...)`.

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test && cargo clippy`
Expected: PASS; the old `test_db_initialization_and_clean`/`test_subscribe_unsubscribe`/`test_alpaca_pricing_data_deserialization` tests that referenced `AlpacaStreamingCore` are removed or rewritten against the host (rewrite them to use `WebsocketStreamerHost` + `subscribe_channel`, matching `facade_tests`).

- [ ] **Step 5: Commit**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs
git commit -m "feat(streaming): rewrite AlpacaStreaming as dual-mode host delegate; delete bespoke core"
```

---

## Task 9: Rewrite the Alpaca CLI bin onto the host

**Files:**
- Modify: `rust/src/bin/alpaca_streamer.rs`

The bin uses the deleted `AlpacaStreamingCore`/`AlpacaCallbacks`. Rewrite it to drive `AlpacaDriver` + `WebsocketStreamerHost` with a stdout closure pump.

- [ ] **Step 1: Implement the rewrite** (no unit test; this is a binary — the test is that it compiles and the closure pumps). Replace the `StdOutCallbacks`/`AlpacaStreamingCore` usage:

```rust
use corelib_rust::markets::nasdaq::datafeeds::streaming::alpaca::alpaca_driver::AlpacaDriver;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{unique_db_path, WebsocketStreamerHost};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};

// in main(): build driver from CLI args + env, build host, optionally clean,
// pre-queue subscriptions, then host.start(driver, vec![], ReconnectPolicy::default(), |ev| match ev {
//   CoreEvent::Pricing { raw: RawPricing::Alpaca(p), .. } => { if let Ok(j) = serde_json::to_string(&p) { println!("{j}"); } }
//   CoreEvent::Status(s) => eprintln!("[EVENT] {s:?}"),
//   _ => {}
// });
// then block on tokio::signal::ctrl_c() to keep the process alive.
```

Provide the full `main` body mirroring the existing arg parsing (`Args` with `symbols/key/secret/silence/clean/db`), mapping `--db` to `ALPACA_DB` env and `--clean` to `host.delete_subscriptions_table()`, and `--symbols` to `host.subscribe_channel("quotes", ...)` for back-compat.

- [ ] **Step 2: Run to verify it compiles**

Run: `cd rust && cargo build --features clap`
Expected: SUCCESS (the `alpaca_streamer` bin builds; it requires the `clap` feature).

- [ ] **Step 3: Commit**

```bash
git add rust/src/bin/alpaca_streamer.rs
git commit -m "refactor(bin): drive alpaca_streamer CLI via shared host + AlpacaDriver"
```

---

## Task 10: TS wrapper `"market"` event + `subscribe` overload + bindings regen

**Files:**
- Modify: `ts-markets/.../alpaca/AlpacaStreaming.ts`, `AlpacaStreaming.test.ts`
- Regenerate: `rust/index.d.ts`, `rust/index.js`

- [ ] **Step 1: Write the failing tests** — in `AlpacaStreaming.test.ts`, add:
  - a test that a `"market"` listener fires when the FFI 4th callback is invoked with a JSON string (mirror Task 5's approach);
  - a test that `subscribe(["AAPL"])` forwards `{ quotes: ["AAPL"] }` to the FFI, and `subscribe({ trades: ["MSFT"] })` forwards it unchanged (assert against the FFI mock's recorded args).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ckir/corelib-markets test:run`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `AlpacaStreaming.ts`:
  - Pass a 4th constructor callback: `(_e, json) => { try { this.emit("market", JSON.parse(json)); } catch {} }`.
  - Replace `subscribe`/`unsubscribe`:

```ts
subscribe(input: string[] | { trades?: string[]; quotes?: string[]; bars?: string[] }) {
  const opts = Array.isArray(input) ? { quotes: input } : input;
  this.rust.subscribe(opts);
}
unsubscribe(input: string[] | { trades?: string[]; quotes?: string[]; bars?: string[] }) {
  const opts = Array.isArray(input) ? { quotes: input } : input;
  this.rust.unsubscribe(opts);
}
```
  - Update the trailing "Events emitted" comment to include `market`.

- [ ] **Step 4: Regenerate bindings + run all gates**

Run:
```
cd rust && cargo build --release   # regenerates index.d.ts / index.js for the new ctor arg + AlpacaSubscribeOpts
cd .. && pnpm --filter @ckir/corelib-markets test:run
```
Expected: PASS; `rust/index.d.ts` now shows `AlpacaSubscribeOpts` and the optional 4th constructor arg.

- [ ] **Step 5: Commit**

```bash
git add ts-markets/src/nasdaq/datafeeds/streaming/alpaca/ rust/index.d.ts rust/index.js
git commit -m "feat(markets): AlpacaStreaming 'market' event + subscribe overload; regen bindings"
```

---

## Task 11: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Rust gates**

Run: `cd rust && cargo test && cargo clippy && cargo build --features clap`
Expected: all green; bins compile.

- [ ] **Step 2: Monorepo gates**

Run (repo root): `pnpm verify:full`
Expected: `build-all` + `test-all:run` green across ts-core/ts-markets/ts-cloud.

- [ ] **Step 3: b-1 acceptance re-check** — confirm by inspection that the migrated Alpaca path inherits all six b-1 fixes from the shared engine (host `Drop` aborts monitor+pump; supervisor resets `attempt=0` on `ConnectedThenDropped`; `AlpacaConfig` masked `Debug`; panic monitor → `on_event("error")`; per-instance redb path; jittered `ReconnectPolicy`). No code change expected; note any gap as a follow-up task.

- [ ] **Step 4: Final commit (if bindings/docs changed)** then proceed to `superpowers:finishing-a-development-branch`.

---

## Self-review notes (author)

- **Spec coverage:** §4.0 → Tasks 1–5; §4.1 → Task 2; §4.2 → Tasks 6–7; §4.3/§4.5 → Task 8; §4.4 → Task 4; §4.6 → Tasks 3–4; §4.7 → Tasks 3, 8, 9; §5 → Tasks 1, 6; §6 → Tasks 5, 10; §7 → Task 11; §8 → per-task tests. All covered.
- **Type consistency:** `CoreEvent`/`RawPricing` (Task 2) used identically in Tasks 3/7/8/9; `SubRequest` (Task 3) used in 7/8; `parse_alpaca_obj` (Task 6) used in 7; `AlpacaSubscribeOpts` (Task 8) used in 10; host helpers (`subscribe_channel`/`get_persisted_subscriptions_for_channel`/`unsubscribe_channel`/`delete_subscriptions_table`/`subscribe_channel_live`) defined Tasks 4/8 and used in 8/9.
- **Open implementation detail for the executor:** `subscribe_channel_live` (host) is introduced in Task 8 — if the engine migration (Task 3) is done first, add it there instead; either way it sends a `SubRequest` on `sub_tx`. Flagged so it is not missed.
