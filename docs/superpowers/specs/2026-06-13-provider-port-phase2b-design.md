# Provider Port — Phase 2b (Yahoo dual-mode migration) Design

**Status:** Approved for planning (2026-06-13).
**Predecessor:** Phase 2a (Alpaca dual-mode) — merged to `main`. This phase reuses that engine.
**Spec author cadence:** carrier-shape fork + uni-superset fork both went through an agy divergent pass
(recorded in `ANTIGRAVITY-TO-CLAUDE.md` → "(d) Phase 2b — divergent (carrier shape)" and
"(d) Phase 2b — divergent (uni superset fields)"); both folded below.

## 1. Goal & scope

Migrate the existing **Yahoo Finance** (protobuf-decoded) streamer onto the shared
`WebsocketStreamerHost` + `ProviderDriver` engine as the third **dual-mode** provider — emitting BOTH
the byte-identical raw `JsPricingData` (all 33 proto fields, unchanged) AND unified
(finstream-**superset**) `MarketEvent`s. This mirrors the Alpaca migration, minus auth (Yahoo is
unauthenticated) and minus channels (Yahoo is single-channel). It is the last provider migration
before the Phase 3 gateway.

**In scope:** the carrier generalization (`uni: Vec<MarketEvent>`), `RawPricing::Yahoo`, the Yahoo
uni superset schema widening, `YahooDriver`, the rewritten `YahooStreaming` facade, the CLI bin, the
TS `"market"` event, and regenerated bindings.

**Out of scope:** Phase 3 gateway; the deferred `FinnhubDriver` reconnect-resume follow-up.

## 2. Locked decisions

| # | Fork | Decision | Source |
|---|------|----------|--------|
| D1 | Dual-mode carrier shape (Yahoo emits 0/1/2 uni events per raw message) | **Generalize** `CoreEvent::Pricing.uni: Option<MarketEvent>` → `Vec<MarketEvent>`. Alpaca/Finnhub wrap as `vec![ev]` (bars → `vec![]`); pumps iterate. One `CoreEvent::Pricing` per wire message ⇒ `on_pricing` fires exactly once. | agy + Claude concur (Option A) |
| D2 | Subscription model | **Single-channel** like Finnhub: reuse the host bare-key `subscribe(Vec<String>)` / `get_persisted_subscriptions` path. No trades/quotes/bars channels. | agy F2 + Claude |
| D3 | Heartbeats (`quote_type == 7`) | **Keep raw, empty uni.** `on_pricing` fires for every decoded message (byte-identical raw back-compat); heartbeats produce `uni: vec![]` (price/bid/ask are 0 anyway). Silence timer resets on any frame. | Claude (user-approved; agy preferred full-drop) |
| D4 | Uni richness | **Widen to a corelib superset** of finstream (precedent: `TradeExtras::Alpaca`). Field list in §3.3. Raw is lossless regardless. | user-approved; field list agy + Claude concur |
| D5 | Overall approach | **Mirror Phase 2a** structurally; reuse `yahoo_streaming_proto_handler.rs` (PricingData/JsPricingData/decode/QuoteType/MarketHours) untouched. | Claude (vs from-scratch redesign — rejected) |
| D6 | `quote_type` representation in uni | **Lowercase string label** via `quote_type_label()` over the existing `QuoteType` enum (e.g. `"equity"`, `"etf"`, `"cryptocurrency"`, `"option"`). | agy + Claude |

## 3. Foundation

### 3.1 Carrier generalization (cross-cutting — first task, like 2a Task 3)
`rust/.../core/types.rs`:
```rust
pub enum CoreEvent {
    Status(ProviderStatus),
    Pricing { raw: RawPricing, uni: Vec<MarketEvent> },
}
pub enum RawPricing {
    Alpaca(AlpacaPricingData),
    Finnhub(FinnhubPricingData),
    Yahoo(JsPricingData),   // NEW
}
```
One atomic commit migrates the two existing consumers in lockstep and re-verifies them:
- **Alpaca** `parse_alpaca_obj`: `Some(uni)` → `vec![uni]`; bars → `vec![]`. Facade pump:
  `if let (Some(cb), Some(u)) = …` → `if let Some(cb) = on_market.as_ref() { for u in uni { … } }`.
- **Finnhub** driver: `uni: Some(trade_ev)` → `uni: vec![trade_ev]`. Facade pump: same `for u in uni`.
- Both providers’ full test suites must stay green (regression gate).

`JsPricingData` is imported into `RawPricing` from the existing proto handler module (single
definition; no move needed — it already lives in `yahoo_streaming_proto_handler.rs` with `#[napi(object)]`).

### 3.2 No schema *expansion* needed for the base types
`MarketEvent::Quote`, `Quote`, `QuoteExtras::Yahoo`, `TradeExtras::Yahoo`, `YahooTradeExtras`,
`YahooQuoteExtras` already exist (Phase 2a Task 1). Phase 2b only **widens** the two Yahoo extras and
adds `YahooOptionExtras` + the `quote_type_label` helper.

### 3.3 Uni superset widening (`core/schema.rs`)
Additive fields (baseline finstream fields unchanged). New fields follow the existing
`skip_serializing_if` zero/empty pattern so equity events stay compact; `quote_type` is always emitted
(it is the instrument discriminator); `market_hours` keeps NO skip (`0` = Regular is meaningful).

```rust
// YahooTradeExtras  (baseline 16 + additions)
    #[serde(skip_serializing_if = "is_zero_i64")] pub last_size: i64,            // tag 22 — per-trade size (finstream gap)
    pub quote_type: String,                                                       // tag 6 via quote_type_label()
    // crypto group (BTC-USD etc. are primary Yahoo streaming assets)
    #[serde(skip_serializing_if = "is_zero_i64")] pub vol_24hr: i64,             // tag 28
    #[serde(skip_serializing_if = "is_zero_i64")] pub vol_all_currencies: i64,   // tag 29
    #[serde(skip_serializing_if = "is_zero_f64")] pub circulating_supply: f64,   // tag 32
    #[serde(skip_serializing_if = "String::is_empty")] pub from_currency: String,// tag 30
    #[serde(skip_serializing_if = "Option::is_none")] pub options: Option<YahooOptionExtras>,

// YahooQuoteExtras  (baseline 9 + additions)
    pub quote_type: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub options: Option<YahooOptionExtras>,

// NEW
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct YahooOptionExtras {                                                    // populated only for option instruments
    #[serde(skip_serializing_if = "is_zero_f64")] pub strike_price: f64,         // tag 17
    pub option_type: i32,                                                         // tag 20 (Call/Put); kept i32 (YAGNI to stringify)
    #[serde(skip_serializing_if = "is_zero_i64")] pub open_interest: i64,        // tag 19
    #[serde(skip_serializing_if = "String::is_empty")] pub underlying_symbol: String, // tag 18
    #[serde(skip_serializing_if = "is_zero_i64")] pub expire_date: i64,          // tag 14
    #[serde(skip_serializing_if = "is_zero_i64")] pub mini_option: i64,          // tag 21
}

/// Map a Yahoo `quote_type` i32 to a portable lowercase label (via the QuoteType enum).
/// Unknown values fall back to the numeric string.
pub fn quote_type_label(qt: i32) -> String { /* "equity","etf","cryptocurrency","option",… */ }
```
The unified `MarketEvent`'s flattening `Serialize` already nests these under the `"yahoo"` key
(no serializer change). Timestamps remain RFC3339 strings (chrono `serde`).

**Still raw-only (by design):** `price_hint` (display-only) and `last_market`. Everything else is
either in a uni extras field or in the nested `options`. The raw `JsPricingData` carries all 33
regardless, so nothing is ever lost.

## 4. `YahooDriver` (`yahoo/yahoo_driver.rs`, new)

### 4.1 Pure mapper (fully unit-testable, no socket)
```rust
pub fn parse_yahoo_message(text: &str, source: &str) -> Option<(JsPricingData, Vec<MarketEvent>)>;
```
- Parse the envelope `{"message":"<base64>"}`; base64-decode; `PricingData::decode`. On any decode
  failure → `None` (skip frame).
- Build `raw = JsPricingData::from(pricing)` (the existing `From` impl — all 33 fields).
- Build the uni vec (mirrors finstream, ordered **Trade then Quote**):
  - push `MarketEvent::Trade` if `price > 0.0` (extras = the widened `YahooTradeExtras`, incl.
    `options: Some(_)` iff `quote_type == option(13)`).
  - push `MarketEvent::Quote` if `bid > 0.0 || ask > 0.0` (mid = `(bid+ask)/2`; widened
    `YahooQuoteExtras`).
  - **Heartbeats** (`quote_type == 7`) and any all-zero-price message ⇒ uni vec is empty; raw is
    still returned (D3).
- Return `Some((raw, uni))`. The raw is **always** present (so `on_pricing` always fires), even when
  uni is empty.

### 4.2 `connect_once` (single attempt, no auth)
```rust
pub struct YahooDriver { pub name: String, pub base_url: Option<String>,
    pub silence_seconds: u32, pub db: Arc<Database>, pub table: &'static str }
```
- `validate()` → always `Ok` (no credentials).
- Connect (default `wss://streamer.finance.yahoo.com/?version=2` — the current streamer's `WS_URL` —
  or `base_url`). No auth handshake → **no `Fatal` path**; a failed connect → `NeverConnected`.
- Emit `CoreEvent::Status(Connected { provider: Yahoo })`.
- Initial subscribe: a driver-side `load_subscriptions(&self) -> Vec<String>` reads the full persisted
  **bare-key** set fresh from `self.db`/`self.table` on every connect (the same scan the host's
  `get_persisted_subscriptions` does, but driver-side via the shared `Arc<Database>` handle), then
  send `{"subscribe":[syms]}`. Reconnect-safe (redb is the single source of truth, read each connect).
- `select!`: `stop_rx` → `Stopped`; `sub_rx` (`SubRequest`, channel ignored) → send
  `{"subscribe":[new]}`; ping tick → WS ping; silence tick → `ConnectedThenDropped`; `ws.next()`:
  on text, reset silence, `parse_yahoo_message` → `tx.send(CoreEvent::Pricing{ raw: RawPricing::Yahoo(raw), uni })`.
  Stream end/err → `ConnectedThenDropped`.

> Note: Yahoo subscriptions are persisted as **bare symbol keys** (single-channel). The driver reads
> them via a fresh redb scan each connect, exactly like the Finnhub resume pattern but using the
> host's bare-key table. (No colon-prefixed composite keys.)

## 5. `YahooStreaming` facade (`yahoo/yahoo_streamer.rs`, rewritten)

Thin delegate over `WebsocketStreamerHost` + `YahooDriver`, mirroring `FinnhubStreaming`
(single-channel). Delete the bespoke `AlpacaStreamingCore`-equivalent core/`ws_loop`/callbacks.
- Constructor `(on_log, on_pricing, on_event, on_market_event?)` — optional 4th unified callback.
- `init(YahooConfig)` (keep masked Debug if config carries secrets; Yahoo has none, but keep the
  config struct shape and `base_url`/`silence_seconds`/`db_path` no-op for parity).
- `start()` builds `YahooDriver` with `host.db_handle()`/`table_name()`, `jitter` policy.
- Pump: `CoreEvent::Pricing{ raw: RawPricing::Yahoo(p), uni }` ⇒ `on_pricing(p)` **once**, then
  `for u in uni { if let Some(cb) = on_market { cb(serde_json::to_string(&u)) } }`;
  `CoreEvent::Status(s)` ⇒ map to `EventRecord` (connected/disconnected/reconnecting/error).
- `subscribe(Vec<String>)` / `unsubscribe(Vec<String>)` — bare list, via host `subscribe`/`unsubscribe`
  (+ live `SubRequest`). `clean()`/`stop()` as in Finnhub/Alpaca.
- `lib.rs`: remove the deleted core's re-exports (if any); keep `JsPricingData`, `YahooStreaming`.

## 6. CLI bin (`bin/yahoo_streamer.rs`, rewritten)
Drive `YahooDriver` + `WebsocketStreamerHost` with a stdout closure pump (raw `JsPricingData` → JSON
line; `Status` → stderr), preserving the existing `--symbols/--silence/--clean/--db` arg surface;
`--symbols` seeds the single bare-key set; host `Drop` shuts down on Ctrl+C.

## 7. TS wrapper (`YahooStreaming.ts`)
Add the 4th constructor callback → `this.emit("market", JSON.parse(json))`. **No subscribe overload**
(single-channel: `subscribe(symbols: string[])` stays). Update the events comment to include `market`.
Regenerate `rust/index.d.ts` / `rust/index.js`.

## 8. Testing
- **Pure `parse_yahoo_message`** (no socket): trade-only (`price>0,bid=ask=0`), quote-only
  (`price=0,bid>0`), both (`price>0,bid>0` → `vec![trade, quote]` order), heartbeat (`quote_type==7`
  → raw present, `uni==[]`), crypto (`vol_24hr`/`circulating_supply` populated, `from_currency` set),
  option (`quote_type==13` → `options: Some`), bad base64 / bad envelope → `None`.
- **Carrier regression**: full Alpaca + Finnhub suites re-run green after the `Vec` change.
- **Schema**: `quote_type_label` mapping; a widened-extras serialization test (equity event omits
  crypto/option fields; option event nests `options`).
- **Facade + TS**: `"market"` event fires per uni event; raw `on_pricing` fires once per message.
- **Gates**: `cargo test` + `cargo clippy --features clap` + `cargo build --features clap`;
  `pnpm verify:full`.

## 9. b-1 hardening
Inherited via the shared host (Drop aborts monitor+pump; backoff reset on `ConnectedThenDropped`;
panic→error event; per-instance redb; jitter). Yahoo has no credentials, so masked-Debug is N/A
(config kept for parity).

## 10. Deferred / records
- agy passes for this phase recorded in `ANTIGRAVITY-TO-CLAUDE.md`: carrier-shape divergent,
  uni-superset divergent.
- Unchanged deferral: `FinnhubDriver` reconnect-resume of in-session subscriptions (ROADMAP).
- After Phase 2b: all three providers are dual-mode on the shared engine → Phase 3 (gateway) is unblocked.
