# Provider Port — Phase 2b (Yahoo dual-mode migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Yahoo (protobuf-decoded) streamer onto the shared `WebsocketStreamerHost` + `ProviderDriver` engine as the third dual-mode provider — emitting BOTH the byte-identical raw `JsPricingData` (all 33 proto fields) AND unified finstream-superset `MarketEvent`s.

**Architecture:** Mirror the Phase 2a Alpaca migration. First generalize the engine carrier from `uni: Option<MarketEvent>` to `uni: Vec<MarketEvent>` (Yahoo emits 0/1/2 uni events per raw message), migrating the two existing providers in lockstep. Then add a pure `parse_yahoo_message` mapper + `YahooDriver` (no auth, single-channel, bare-key resume from redb), rewrite the `YahooStreaming` facade as a thin host delegate, rewrite the CLI bin, add the TS `"market"` event, and regenerate bindings.

**Tech Stack:** Rust (napi-rs v3, tokio, tokio-tungstenite, redb 4.1, prost 0.14, base64, chrono+serde, serde_json), TypeScript (vitest, EventEmitter), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-06-13-provider-port-phase2b-design.md`

---

## Conventions for implementer subagents (READ FIRST — applies to EVERY task)

These are mandatory. They exist because financial-streaming/FFI wire formats are contracts.

1. **Step 0 — state verification.** Before writing, read the target file(s) and confirm the "Context"/"Current state" quoted in your task matches reality. If it does not match, STOP and report `STATE_MISMATCH: <what differs>` instead of writing.
2. **SHAPE_DIVERGENCE rule.** If you find yourself changing the shape, type, or encoding of any field in pasted code — *even just to make it compile* — STOP and report `SHAPE_DIVERGENCE: [original] → [yours] because <reason>`. "It compiles" is NOT justification. (Ground truth: in Phase 2a a subagent silently emitted epoch-millis instead of RFC3339 because both compiled — that is exactly what this rule catches.)
3. **Annotate the oracle.** The pinning test named in each task is the source of truth for behavior. If a value seems wrong, the test wins — surface the conflict, don't "fix" the test to match your code.
4. **Enum/match arms are complete here.** Where this plan shows a `match` over an enum, all arms are present. Do not collapse arms to `_ =>` or invent arms.
5. **Exact cargo commands.** Use them verbatim. Repo gate is deliberately **warn-only** — use plain `cargo clippy` (NOT `-D warnings`). Bins require `--features clap`. `cargo test` default features already include `finnhub`. All commands run from `rust/` unless stated.
6. **Tests are already written in this plan.** Implement until they pass — this is not open-ended TDD; the assertions are fixed.

**Per-message invariant (D1):** exactly one `CoreEvent::Pricing` is emitted per decoded wire message, so `on_pricing` fires exactly once per message; the `uni` Vec carries 0, 1, or 2 unified events for that same message.

---

## File Structure

**Modified (cross-cutting carrier — Task 1):**
- `rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs` — `uni: Vec<MarketEvent>`; add `RawPricing::Yahoo(JsPricingData)`.
- `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs` — `parse_alpaca_obj` returns `Vec`; pump send.
- `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs` — facade pump iterates.
- `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs` — `uni: vec![ev]`.
- `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs` — facade pump iterates.

**Modified (schema widening — Task 2):**
- `rust/src/markets/nasdaq/datafeeds/streaming/core/schema.rs` — widen `YahooTradeExtras`/`YahooQuoteExtras`; add `YahooOptionExtras` + `quote_type_label`.

**Created (Yahoo driver — Tasks 3–4):**
- `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs` — pure `parse_yahoo_message` + `YahooDriver`.

**Modified (facade/bin/exports — Tasks 5–6):**
- `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs` — rewritten thin facade (keeps `LogRecord`/`EventRecord`/`YahooConfig`).
- `rust/src/bin/yahoo_streamer.rs` — rewritten host+driver bin.
- `rust/src/lib.rs` — module decl + re-export updates.

**Modified (TS + bindings — Task 7):**
- `ts-markets/src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts` — 4th callback → `"market"` event.
- `rust/index.d.ts`, `rust/index.js` — regenerated.

**Reused UNTOUCHED:** `rust/.../yahoo/yahoo_streaming_proto_handler.rs` (`PricingData`, `JsPricingData`, `From`, `QuoteType`, `MarketHours`, `decode_yahoo_message`), `core/host.rs`, `core/supervisor.rs`, `core/driver.rs`, `core/reconnect.rs`.

---

## Task 1: Carrier generalization — `uni: Option<MarketEvent>` → `Vec<MarketEvent>`

This is one atomic cross-cutting change. It migrates the two existing providers in lockstep and re-verifies them as a regression gate. Commit ONLY when the full default-feature suite is green.

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs`
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs`
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs`
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs`
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs`

**Context (verify in Step 0):** `core/types.rs` currently declares `RawPricing { Alpaca, Finnhub }` (no Yahoo) and `CoreEvent::Pricing { raw: RawPricing, uni: Option<MarketEvent> }`. `JsPricingData` lives in `yahoo/yahoo_streaming_proto_handler.rs` with `#[napi(object)]`.

- [ ] **Step 1: Add the `RawPricing::Yahoo` variant + import, and change `uni` to `Vec`.**

In `core/types.rs`, add this import near the top (after the existing `use crate::...schema::{MarketEvent, ProviderStatus};` line):

```rust
use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::JsPricingData;
```

Change the `RawPricing` enum to add the Yahoo variant (keep the existing `#[allow(dead_code)]`):

```rust
/// Lossless raw pricing payload carried on the engine channel (one variant per provider).
#[allow(dead_code)] // not every variant is produced in every build configuration
pub enum RawPricing {
    Alpaca(AlpacaPricingData),
    Finnhub(FinnhubPricingData),
    Yahoo(JsPricingData),
}
```

Change `CoreEvent::Pricing.uni` from `Option<MarketEvent>` to `Vec<MarketEvent>`:

```rust
/// The shared engine channel item: a lifecycle status, or a pricing tick with the raw
/// payload plus zero or more unified MarketEvents (empty ⇒ raw-only, e.g. Alpaca bars / Yahoo heartbeats).
#[allow(dead_code)]
#[allow(clippy::large_enum_variant)] // ProviderStatus carries string fields; boxing deferred
pub enum CoreEvent {
    Status(ProviderStatus),
    Pricing {
        raw: RawPricing,
        uni: Vec<MarketEvent>,
    },
}
```

- [ ] **Step 2: Update the `core/types.rs` unit test to the Vec shape.**

In the `#[cfg(test)] mod tests` block, change the construction and assertion (the `uni: None` → `uni: vec![]`, and `assert!(uni.is_none())` → `assert!(uni.is_empty())`):

```rust
        let ev = CoreEvent::Pricing {
            raw: RawPricing::Alpaca(raw.clone()),
            uni: vec![],
        };
        match ev {
            CoreEvent::Pricing {
                raw: RawPricing::Alpaca(p),
                uni,
            } => {
                assert_eq!(p.symbol, "AAPL");
                assert!(uni.is_empty());
            }
            _ => panic!(),
        }
```

- [ ] **Step 3: Migrate Alpaca `parse_alpaca_obj` to return `Vec`.**

In `alpaca/alpaca_driver.rs`, change the function signature and the three return sites. The signature becomes:

```rust
pub fn parse_alpaca_obj(
    o: &serde_json::Value,
    source: &str,
) -> Option<(AlpacaPricingData, Vec<MarketEvent>)> {
```

- In the `"q"` arm, change the final `Some((raw, Some(uni)))` to `Some((raw, vec![uni]))`.
- In the `"t"` arm, change the final `Some((raw, Some(uni)))` to `Some((raw, vec![uni]))`.
- In the `"b"` arm, change `Some((raw, None)) // bars raw-only` to `Some((raw, vec![])) // bars raw-only`.

- [ ] **Step 4: Update the Alpaca `connect_once` send site and `parse_tests`.**

In `connect_once`, the loop body already destructures `if let Some((raw, uni)) = parse_alpaca_obj(o, &self.name)` and sends `CoreEvent::Pricing { raw: RawPricing::Alpaca(raw), uni }`. `uni` is now a `Vec` — no change to that line is needed (the field name still binds). Leave it as-is.

In `mod parse_tests`, update the three assertions that did `uni.unwrap()` / `uni.is_none()`:

```rust
    // quote_builds_raw_and_unified:
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "quote");
        assert_eq!(raw.bid_price, 191.0);
        assert_eq!(raw.ask_price, 192.0);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "quote");
        assert_eq!(v["price"], 191.5); // mid
        assert_eq!(v["alpaca"]["bid"], 191.0);
```

```rust
    // trade_builds_raw_and_unified_trade:
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "trade");
        assert_eq!(raw.price, 420.0);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["alpaca"]["size"], 50.0);
```

```rust
    // bar_builds_raw_only:
        let (raw, uni) = parse_alpaca_obj(&obj, "alpaca_main").unwrap();
        assert_eq!(raw.message_type, "bar");
        assert_eq!(raw.price, 250.0);
        assert!(uni.is_empty()); // bars are raw-only
```

- [ ] **Step 5: Update the Alpaca facade pump to iterate.**

In `alpaca/alpaca_streamer.rs`, the pump arm currently is:

```rust
                CoreEvent::Pricing {
                    raw: RawPricing::Alpaca(p),
                    uni,
                } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let (Some(cb), Some(u)) = (on_market.as_ref(), uni) {
                        if let Ok(j) = serde_json::to_string(&u) {
                            let _ = cb.call(Ok(j), ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                }
```

Replace the `if let (Some(cb), Some(u)) = ...` block with iteration:

```rust
                CoreEvent::Pricing {
                    raw: RawPricing::Alpaca(p),
                    uni,
                } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let Some(cb) = on_market.as_ref() {
                        for u in &uni {
                            if let Ok(j) = serde_json::to_string(u) {
                                let _ = cb.call(Ok(j), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }
                }
```

- [ ] **Step 6: Migrate Finnhub driver send site to `vec![ev]`.**

In `finnhub/finnhub_driver.rs`, inside `connect_once` the text arm currently is:

```rust
                            for ev in parse_finnhub_frame(&t, &self.name) {
                                if let Some(raw) = market_event_to_finnhub_pricing(&ev) {
                                    let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Finnhub(raw), uni: Some(ev) }).await;
                                }
                            }
```

Change `uni: Some(ev)` to `uni: vec![ev]`:

```rust
                            for ev in parse_finnhub_frame(&t, &self.name) {
                                if let Some(raw) = market_event_to_finnhub_pricing(&ev) {
                                    let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Finnhub(raw), uni: vec![ev] }).await;
                                }
                            }
```

(Each Finnhub trade item is its own wire-level pricing tick, so one `CoreEvent::Pricing` per trade with a single-element `uni` — `on_pricing` still fires once per trade, unchanged.)

- [ ] **Step 7: Update the Finnhub facade pump to iterate.**

In `finnhub/finnhub_streamer.rs`, the pump arm currently is:

```rust
                CoreEvent::Pricing {
                    raw: RawPricing::Finnhub(p),
                    uni,
                } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let (Some(cb), Some(u)) = (on_market_event.as_ref(), uni) {
                        if let Ok(j) = serde_json::to_string(&u) {
                            let _ = cb.call(Ok(j), ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                }
```

Replace with iteration:

```rust
                CoreEvent::Pricing {
                    raw: RawPricing::Finnhub(p),
                    uni,
                } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let Some(cb) = on_market_event.as_ref() {
                        for u in &uni {
                            if let Ok(j) = serde_json::to_string(u) {
                                let _ = cb.call(Ok(j), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }
                }
```

- [ ] **Step 8: Verify the full default-feature suite is green (regression gate).**

Run: `cargo test`
Expected: PASS — all existing Alpaca + Finnhub + core tests pass (default features include `finnhub`). No test count regression vs the pre-change run.

Run: `cargo clippy`
Expected: no new warnings introduced by this change.

- [ ] **Step 9: Commit.**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs \
        rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs \
        rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs \
        rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs \
        rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs
git commit -m "$(cat <<'EOF'
refactor(streaming): generalize CoreEvent uni to Vec<MarketEvent> + add RawPricing::Yahoo

Phase 2b carrier generalization. Yahoo emits 0/1/2 unified events per raw
message; Alpaca/Finnhub migrated in lockstep (wrap as vec![ev]; bars -> vec![]).
One CoreEvent::Pricing per wire message, so on_pricing still fires once.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Schema widening — Yahoo uni superset

Widen the two Yahoo extras structs, add `YahooOptionExtras`, and add the `quote_type_label` helper. Pure data + one pure function; no engine wiring.

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/schema.rs`

**Context (verify in Step 0):** `core/schema.rs` already defines `YahooTradeExtras` (16 fields ending at `short_name`), `YahooQuoteExtras` (9 fields ending at `change_pct`), the `is_zero_f64`/`is_zero_i64` helpers, and `TradeExtras::Yahoo`/`QuoteExtras::Yahoo` variants wired into the flattening `Serialize` (nesting under the `"yahoo"` key). The QuoteType numeric codes are defined in `yahoo/yahoo_streaming_proto_handler.rs` (None=0, Altsymbol=5, Heartbeat=7, Equity=8, Index=9, Mutualfund=11, Moneymarket=12, Option=13, Currency=14, Warrant=15, Bond=17, Future=18, Etf=20, Commodity=23, Ecnquote=28, Cryptocurrency=41, Indicator=42, Industry=1000).

- [ ] **Step 1: Write the failing tests** (append to the existing `#[cfg(test)] mod schema_expansion_tests` block in `core/schema.rs`):

```rust
    #[test]
    fn quote_type_label_maps_known_and_unknown() {
        assert_eq!(quote_type_label(8), "equity");
        assert_eq!(quote_type_label(20), "etf");
        assert_eq!(quote_type_label(41), "cryptocurrency");
        assert_eq!(quote_type_label(13), "option");
        assert_eq!(quote_type_label(7), "heartbeat");
        assert_eq!(quote_type_label(9999), "9999"); // unknown falls back to numeric string
    }

    #[test]
    fn yahoo_equity_trade_extras_omit_crypto_and_option_fields() {
        let x = YahooTradeExtras {
            exchange: "NMS".into(),
            currency: "USD".into(),
            market_hours: 0,
            change: 0.0,
            change_pct: 0.0,
            volume: 0,
            open: 0.0,
            day_high: 0.0,
            day_low: 0.0,
            prev_close: 0.0,
            market_cap: 0.0,
            bid: 0.0,
            ask: 0.0,
            bid_size: 0,
            ask_size: 0,
            short_name: String::new(),
            last_size: 0,
            quote_type: quote_type_label(8),
            vol_24hr: 0,
            vol_all_currencies: 0,
            circulating_supply: 0.0,
            from_currency: String::new(),
            options: None,
        };
        let v = serde_json::to_value(&x).unwrap();
        assert_eq!(v["quote_type"], "equity"); // always present (discriminator)
        assert_eq!(v["market_hours"], 0); // never skipped (0 = Regular is meaningful)
        assert!(v.get("vol_24hr").is_none()); // zero crypto field skipped
        assert!(v.get("circulating_supply").is_none());
        assert!(v.get("from_currency").is_none());
        assert!(v.get("options").is_none()); // None skipped
        assert!(v.get("last_size").is_none()); // zero skipped
    }

    #[test]
    fn yahoo_crypto_trade_extras_include_crypto_fields() {
        let x = YahooTradeExtras {
            exchange: "CCC".into(),
            currency: "USD".into(),
            market_hours: 0,
            change: 0.0,
            change_pct: 0.0,
            volume: 0,
            open: 0.0,
            day_high: 0.0,
            day_low: 0.0,
            prev_close: 0.0,
            market_cap: 0.0,
            bid: 0.0,
            ask: 0.0,
            bid_size: 0,
            ask_size: 0,
            short_name: String::new(),
            last_size: 0,
            quote_type: quote_type_label(41),
            vol_24hr: 123,
            vol_all_currencies: 456,
            circulating_supply: 19.5,
            from_currency: "BTC".into(),
            options: None,
        };
        let v = serde_json::to_value(&x).unwrap();
        assert_eq!(v["quote_type"], "cryptocurrency");
        assert_eq!(v["vol_24hr"], 123);
        assert_eq!(v["vol_all_currencies"], 456);
        assert_eq!(v["circulating_supply"], 19.5);
        assert_eq!(v["from_currency"], "BTC");
    }

    #[test]
    fn yahoo_option_trade_extras_nest_options() {
        let x = YahooTradeExtras {
            exchange: "OPR".into(),
            currency: "USD".into(),
            market_hours: 0,
            change: 0.0,
            change_pct: 0.0,
            volume: 0,
            open: 0.0,
            day_high: 0.0,
            day_low: 0.0,
            prev_close: 0.0,
            market_cap: 0.0,
            bid: 0.0,
            ask: 0.0,
            bid_size: 0,
            ask_size: 0,
            short_name: String::new(),
            last_size: 0,
            quote_type: quote_type_label(13),
            vol_24hr: 0,
            vol_all_currencies: 0,
            circulating_supply: 0.0,
            from_currency: String::new(),
            options: Some(YahooOptionExtras {
                strike_price: 100.0,
                option_type: 1,
                open_interest: 50,
                underlying_symbol: "AAPL".into(),
                expire_date: 1_700_000_000,
                mini_option: 0,
            }),
        };
        let v = serde_json::to_value(&x).unwrap();
        assert_eq!(v["quote_type"], "option");
        assert_eq!(v["options"]["strike_price"], 100.0);
        assert_eq!(v["options"]["underlying_symbol"], "AAPL");
        assert_eq!(v["options"]["open_interest"], 50);
        assert!(v["options"].get("mini_option").is_none()); // zero skipped
    }
```

- [ ] **Step 2: Run the tests to verify they fail (compile error — fields/types/fn missing).**

Run: `cargo test -p corelib-rust quote_type_label_maps_known_and_unknown`
Expected: FAIL to compile (`YahooOptionExtras` / `quote_type_label` / new fields not found).

- [ ] **Step 3: Add `YahooOptionExtras` + `quote_type_label`** (in `core/schema.rs`, place near the other Yahoo extras structs, before `YahooTradeExtras`):

```rust
/// Yahoo option-instrument metadata (populated only when `quote_type == 13`).
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct YahooOptionExtras {
    #[serde(skip_serializing_if = "is_zero_f64")]
    pub strike_price: f64, // proto tag 17
    pub option_type: i32, // proto tag 20 (Call/Put); kept i32 (YAGNI to stringify)
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub open_interest: i64, // proto tag 19
    #[serde(skip_serializing_if = "String::is_empty")]
    pub underlying_symbol: String, // proto tag 18
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub expire_date: i64, // proto tag 14
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub mini_option: i64, // proto tag 21
}

/// Map a Yahoo `quote_type` i32 to a portable lowercase label. Unknown values fall back to the
/// numeric string. Numeric codes are the authority defined by `QuoteType` in
/// `yahoo/yahoo_streaming_proto_handler.rs`; keep these arms in sync with that enum.
pub fn quote_type_label(qt: i32) -> String {
    match qt {
        0 => "none",
        5 => "altsymbol",
        7 => "heartbeat",
        8 => "equity",
        9 => "index",
        11 => "mutualfund",
        12 => "moneymarket",
        13 => "option",
        14 => "currency",
        15 => "warrant",
        17 => "bond",
        18 => "future",
        20 => "etf",
        23 => "commodity",
        28 => "ecnquote",
        41 => "cryptocurrency",
        42 => "indicator",
        1000 => "industry",
        other => return other.to_string(),
    }
    .to_string()
}
```

- [ ] **Step 4: Widen `YahooTradeExtras`** — add the new fields AFTER the existing `short_name` field (keep all existing fields exactly as-is):

```rust
    #[serde(skip_serializing_if = "String::is_empty")]
    pub short_name: String,
    // ── Phase 2b additions ──
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub last_size: i64, // proto tag 22 — per-trade size (finstream gap)
    pub quote_type: String, // proto tag 6 via quote_type_label(); always emitted (discriminator)
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub vol_24hr: i64, // proto tag 28
    #[serde(skip_serializing_if = "is_zero_i64")]
    pub vol_all_currencies: i64, // proto tag 29
    #[serde(skip_serializing_if = "is_zero_f64")]
    pub circulating_supply: f64, // proto tag 32
    #[serde(skip_serializing_if = "String::is_empty")]
    pub from_currency: String, // proto tag 30
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<YahooOptionExtras>,
```

- [ ] **Step 5: Widen `YahooQuoteExtras`** — add the new fields AFTER the existing `change_pct` field:

```rust
    #[serde(skip_serializing_if = "is_zero_f64")]
    pub change_pct: f64,
    // ── Phase 2b additions ──
    pub quote_type: String, // always emitted (discriminator)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<YahooOptionExtras>,
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `cargo test -p corelib-rust schema_expansion_tests`
Expected: PASS (all schema_expansion_tests including the 4 new ones).

Run: `cargo clippy`
Expected: no new warnings.

- [ ] **Step 7: Commit.**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/core/schema.rs
git commit -m "$(cat <<'EOF'
feat(streaming): widen Yahoo uni extras to finstream superset + quote_type_label

Adds last_size/quote_type/crypto group/nested options to YahooTradeExtras,
quote_type/options to YahooQuoteExtras, new YahooOptionExtras, and the
quote_type_label() helper. Skip-zero/empty keeps equity events compact;
quote_type always emitted as the instrument discriminator.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `parse_yahoo_message` pure mapper

Create the new Yahoo driver module with the fully unit-testable pure mapper (no socket).

**Files:**
- Create: `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs`
- Modify: `rust/src/lib.rs` (add `pub mod yahoo_driver;` under the `yahoo` module — see Step 1)

**Context (verify in Step 0):** `JsPricingData`/`PricingData`/`QuoteType`/`decode_yahoo_message` live in `yahoo/yahoo_streaming_proto_handler.rs`. `PricingData` derives prost `Message` (so it has `Default` + `encode`). The schema items from Task 2 (`YahooTradeExtras`, `YahooQuoteExtras`, `YahooOptionExtras`, `quote_type_label`) exist. The envelope format is `{"type":"pricing","message":"<base64-protobuf>"}`. `MarketEvent::Trade`/`Quote` use `chrono::DateTime<Utc>` timestamps (RFC3339 on the wire). Yahoo `time` is epoch **milliseconds**.

- [ ] **Step 1: Register the module in `lib.rs`.** In the `pub mod yahoo { ... }` block, add the module declaration alongside the existing ones:

```rust
                pub mod yahoo {
                    /// Pure Yahoo proto-decode mapper + YahooDriver (shared engine).
                    pub mod yahoo_driver;
                    /// Main Yahoo price streamer logic.
                    pub mod yahoo_streamer;
                    /// Protobuf handler for Yahoo Finance websocket messages.
                    pub mod yahoo_streaming_proto_handler;
                    /// Re-export Yahoo streaming components for convenience.
                    pub use yahoo_streamer::{
                        EventRecord, LogRecord, RustCallbacks, YahooConfig, YahooStreaming,
                        YahooStreamingCore,
                    };
                }
```

(The `pub use` line is updated later in Task 6; leave it for now so the crate keeps compiling.)

- [ ] **Step 2: Write the new file with the mapper + failing tests.** Create `yahoo/yahoo_driver.rs`:

```rust
//! YahooDriver: pure proto-decode mapper + one WebSocket connection attempt.
//! Dual-mode: every decoded message yields the byte-identical raw `JsPricingData`
//! (so `on_pricing` always fires) plus 0/1/2 unified `MarketEvent`s.
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
    quote_type_label, MarketEvent, Quote, QuoteExtras, Trade, TradeExtras, YahooOptionExtras,
    YahooQuoteExtras, YahooTradeExtras,
};
use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::{
    decode_yahoo_message, JsPricingData,
};
use chrono::{DateTime, TimeZone, Utc};

/// QuoteType discriminator for option instruments (proto enum `QuoteType::Option`).
const QUOTE_TYPE_OPTION: i32 = 13;

fn ts_from_millis(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).single().unwrap_or_else(Utc::now)
}

/// Build the option extras iff this is an option instrument.
fn option_extras(raw: &JsPricingData) -> Option<YahooOptionExtras> {
    if raw.quote_type == QUOTE_TYPE_OPTION {
        Some(YahooOptionExtras {
            strike_price: raw.strike_price,
            option_type: raw.option_type,
            open_interest: raw.open_interest,
            underlying_symbol: raw.underlying_symbol.clone(),
            expire_date: raw.expire_date,
            mini_option: raw.mini_option,
        })
    } else {
        None
    }
}

fn trade_extras(raw: &JsPricingData) -> YahooTradeExtras {
    YahooTradeExtras {
        exchange: raw.exchange.clone(),
        currency: raw.currency.clone(),
        market_hours: raw.market_hours,
        change: raw.change,
        change_pct: raw.change_percent,
        volume: raw.day_volume,
        open: raw.open_price,
        day_high: raw.day_high,
        day_low: raw.day_low,
        prev_close: raw.previous_close,
        market_cap: raw.market_cap,
        bid: raw.bid_price,
        ask: raw.ask_price,
        bid_size: raw.bid_size,
        ask_size: raw.ask_size,
        short_name: raw.short_name.clone(),
        last_size: raw.last_size,
        quote_type: quote_type_label(raw.quote_type),
        vol_24hr: raw.vol_24hr,
        vol_all_currencies: raw.vol_all_currencies,
        circulating_supply: raw.circulating_supply,
        from_currency: raw.from_currency.clone(),
        options: option_extras(raw),
    }
}

fn quote_extras(raw: &JsPricingData) -> YahooQuoteExtras {
    YahooQuoteExtras {
        bid: raw.bid_price,
        ask: raw.ask_price,
        bid_size: raw.bid_size,
        ask_size: raw.ask_size,
        exchange: raw.exchange.clone(),
        currency: raw.currency.clone(),
        market_hours: raw.market_hours,
        change: raw.change,
        change_pct: raw.change_percent,
        quote_type: quote_type_label(raw.quote_type),
        options: option_extras(raw),
    }
}

/// Decode one Yahoo WS text frame into the raw payload + zero/one/two unified events.
/// Returns `None` only when the frame is not a decodable pricing envelope (skip frame).
/// The raw `JsPricingData` is ALWAYS present when `Some` (so `on_pricing` always fires),
/// even when the uni vec is empty (heartbeats / all-zero-price messages — D3).
pub fn parse_yahoo_message(text: &str, source: &str) -> Option<(JsPricingData, Vec<MarketEvent>)> {
    let obj: serde_json::Value = serde_json::from_str(text).ok()?;
    let b64 = obj.get("message").and_then(|m| m.as_str())?;
    let pricing = decode_yahoo_message(b64).ok()?;
    let raw = JsPricingData::from(pricing);

    let ticker = raw.id.clone();
    let timestamp = ts_from_millis(raw.time);
    let mut uni: Vec<MarketEvent> = Vec::new();

    // Trade then Quote (finstream order).
    if raw.price > 0.0 {
        uni.push(MarketEvent::Trade {
            source: source.to_string(),
            data: Trade {
                ticker: ticker.clone(),
                timestamp,
                price: raw.price,
                extras: TradeExtras::Yahoo(trade_extras(&raw)),
                raw: None,
            },
        });
    }
    if raw.bid_price > 0.0 || raw.ask_price > 0.0 {
        uni.push(MarketEvent::Quote {
            source: source.to_string(),
            data: Quote {
                ticker,
                timestamp,
                price: (raw.bid_price + raw.ask_price) / 2.0,
                extras: QuoteExtras::Yahoo(quote_extras(&raw)),
                raw: None,
            },
        });
    }
    Some((raw, uni))
}

#[cfg(test)]
mod mapper_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::PricingData;
    use base64::{engine::general_purpose, Engine as _};
    use prost::Message;

    /// Wrap a PricingData in the Yahoo `{"type":"pricing","message":"<b64>"}` envelope.
    fn envelope(p: &PricingData) -> String {
        let mut buf = Vec::new();
        p.encode(&mut buf).unwrap();
        let b64 = general_purpose::STANDARD.encode(&buf);
        serde_json::json!({ "type": "pricing", "message": b64 }).to_string()
    }

    #[test]
    fn trade_only_when_price_positive_no_quote() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 191.5,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (raw, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(raw.id, "AAPL");
        assert_eq!(uni.len(), 1);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["price"], 191.5);
        assert_eq!(v["yahoo"]["quote_type"], "equity");
    }

    #[test]
    fn quote_only_when_bid_positive_no_trade() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 0.0,
            bid_price: 10.0,
            ask_price: 11.0,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(uni.len(), 1);
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["type"], "quote");
        assert_eq!(v["price"], 10.5); // mid
    }

    #[test]
    fn both_trade_and_quote_in_order() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 191.5,
            bid_price: 10.0,
            ask_price: 11.0,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(uni.len(), 2);
        assert_eq!(serde_json::to_value(&uni[0]).unwrap()["type"], "trade");
        assert_eq!(serde_json::to_value(&uni[1]).unwrap()["type"], "quote");
    }

    #[test]
    fn heartbeat_yields_raw_but_empty_uni() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 0.0,
            bid_price: 0.0,
            ask_price: 0.0,
            time: 1_700_000_000_000,
            quote_type: 7, // Heartbeat
            ..Default::default()
        };
        let (raw, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        assert_eq!(raw.quote_type, 7); // raw still present (on_pricing fires)
        assert!(uni.is_empty());
    }

    #[test]
    fn crypto_trade_carries_crypto_fields() {
        let p = PricingData {
            id: "BTC-USD".into(),
            price: 50_000.0,
            time: 1_700_000_000_000,
            quote_type: 41, // Cryptocurrency
            vol_24hr: 123,
            circulating_supply: 19.5,
            from_currency: "BTC".into(),
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["yahoo"]["quote_type"], "cryptocurrency");
        assert_eq!(v["yahoo"]["vol_24hr"], 123);
        assert_eq!(v["yahoo"]["circulating_supply"], 19.5);
        assert_eq!(v["yahoo"]["from_currency"], "BTC");
    }

    #[test]
    fn option_trade_nests_options() {
        let p = PricingData {
            id: "AAPL240119C00100000".into(),
            price: 1.5,
            time: 1_700_000_000_000,
            quote_type: 13, // Option
            strike_price: 100.0,
            option_type: 1,
            open_interest: 50,
            underlying_symbol: "AAPL".into(),
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["yahoo"]["quote_type"], "option");
        assert_eq!(v["yahoo"]["options"]["strike_price"], 100.0);
        assert_eq!(v["yahoo"]["options"]["underlying_symbol"], "AAPL");
    }

    #[test]
    fn timestamp_is_rfc3339_string() {
        let p = PricingData {
            id: "AAPL".into(),
            price: 191.5,
            time: 1_700_000_000_000,
            quote_type: 8,
            ..Default::default()
        };
        let (_, uni) = parse_yahoo_message(&envelope(&p), "yahoo").unwrap();
        let v = serde_json::to_value(&uni[0]).unwrap();
        assert_eq!(v["timestamp"], "2023-11-14T22:13:20Z");
    }

    #[test]
    fn bad_envelope_and_bad_base64_return_none() {
        assert!(parse_yahoo_message(r#"{"type":"pricing"}"#, "yahoo").is_none()); // no message field
        assert!(parse_yahoo_message(r#"{"type":"pricing","message":"!!!not-b64"}"#, "yahoo").is_none());
        assert!(parse_yahoo_message("not json", "yahoo").is_none());
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass.**

Run: `cargo test -p corelib-rust mapper_tests`
Expected: PASS (all 8 mapper tests).

Run: `cargo clippy`
Expected: no new warnings.

- [ ] **Step 4: Commit.**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs rust/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(yahoo): pure parse_yahoo_message mapper (raw JsPricingData + uni Vec)

Decodes the Yahoo proto envelope into the byte-identical raw payload plus
0/1/2 unified MarketEvents (Trade if price>0, Quote if bid|ask>0, ordered
trade-then-quote). Heartbeats/all-zero-price yield raw + empty uni (D3).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `YahooDriver` — `connect_once` (single attempt, no auth, single-channel)

Add the `ProviderDriver` impl to `yahoo_driver.rs`.

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs`

**Context (verify in Step 0):** The `ProviderDriver` trait (`core/driver.rs`) requires `validate(&self) -> Result<(), String>` and `connect_once<'a>(&'a self, symbols: &'a [String], tx: &'a mpsc::Sender<CoreEvent>, sub_rx: &'a mut mpsc::Receiver<SubRequest>, stop_rx: &'a mut mpsc::Receiver<()>) -> BoxFuture<'a, AttemptOutcome>`. `AttemptOutcome` variants: `ConnectedThenDropped`, `NeverConnected`, `Fatal(String)`, `Stopped`. `SubRequest { channel: String, symbols: Vec<String> }`. Mirror the `AlpacaDriver` connect/select structure (`alpaca/alpaca_driver.rs`) but: no `success/connected` handshake, no auth (so **no `Fatal` path**), single-channel bare-key subscribe `{"subscribe":[syms]}`, and `load_subscriptions` reads bare keys (no `channel:` split). The redb table-value type is `bool` (`TableDefinition<&str, bool>`).

- [ ] **Step 1: Write the failing driver tests** (append a new `#[cfg(test)] mod driver_tests` to `yahoo_driver.rs`):

```rust
#[cfg(test)]
mod driver_tests {
    use super::*;
    use std::sync::Arc;

    fn tmp_db() -> Arc<redb::Database> {
        let path = std::env::temp_dir().join(format!(
            "test_yahoo_drv_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(redb::Database::create(path).unwrap())
    }

    #[test]
    fn validate_is_always_ok_no_credentials() {
        let d = YahooDriver {
            name: "yahoo".into(),
            base_url: None,
            silence_seconds: 60,
            db: tmp_db(),
            table: "yahoo_subscriptions",
        };
        assert!(d.validate().is_ok());
    }

    #[test]
    fn load_subscriptions_reads_bare_keys() {
        let db = tmp_db();
        {
            let t: redb::TableDefinition<&str, bool> =
                redb::TableDefinition::new("yahoo_subscriptions");
            let w = db.begin_write().unwrap();
            {
                let mut tab = w.open_table(t).unwrap();
                tab.insert("AAPL", true).unwrap();
                tab.insert("BTC-USD", true).unwrap();
            }
            w.commit().unwrap();
        }
        let d = YahooDriver {
            name: "yahoo".into(),
            base_url: None,
            silence_seconds: 60,
            db,
            table: "yahoo_subscriptions",
        };
        let mut subs = d.load_subscriptions();
        subs.sort();
        assert_eq!(subs, vec!["AAPL".to_string(), "BTC-USD".to_string()]);
    }
}
```

- [ ] **Step 2: Run to verify they fail** (`YahooDriver` not defined yet).

Run: `cargo test -p corelib-rust driver_tests`
Expected: FAIL to compile (`YahooDriver` not found).

- [ ] **Step 3: Implement `YahooDriver` + `connect_once`.** Append to `yahoo_driver.rs` (after the `parse_yahoo_message` fn, before the test modules):

```rust
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{
    AttemptOutcome, ProviderDriver, SubRequest,
};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use futures::future::{BoxFuture, FutureExt};
use futures_util::{SinkExt, StreamExt};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_YAHOO_WS_URL: &str = "wss://streamer.finance.yahoo.com/?version=2";
const PING_INTERVAL: u64 = 30;

/// One Yahoo real-time stream connection. The supervisor owns the reconnect loop; this driver
/// performs a single attempt (connect → subscribe → pump). Yahoo is unauthenticated and
/// single-channel; the redb DB (shared `Arc<Database>` from the host) is the single source of
/// truth for subscriptions, read fresh (bare keys) on every (re)connect.
pub struct YahooDriver {
    pub name: String,
    pub base_url: Option<String>,
    pub silence_seconds: u32,
    pub db: Arc<Database>,
    pub table: &'static str,
}

impl YahooDriver {
    /// Read the FULL persisted bare-key subscription set from redb. Called on every (re)connect.
    pub fn load_subscriptions(&self) -> Vec<String> {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        let mut out = Vec::new();
        if let Ok(rtx) = self.db.begin_read() {
            if let Ok(t) = rtx.open_table(table) {
                if let Ok(iter) = t.iter() {
                    for item in iter.flatten() {
                        out.push(item.0.value().to_string());
                    }
                }
            }
        }
        out
    }
}

impl ProviderDriver for YahooDriver {
    fn validate(&self) -> Result<(), String> {
        Ok(()) // Yahoo is unauthenticated
    }

    fn connect_once<'a>(
        &'a self,
        symbols: &'a [String], // unused: Yahoo resumes from redb (load_subscriptions), not this snapshot
        tx: &'a mpsc::Sender<CoreEvent>,
        sub_rx: &'a mut mpsc::Receiver<SubRequest>,
        stop_rx: &'a mut mpsc::Receiver<()>,
    ) -> BoxFuture<'a, AttemptOutcome> {
        async move {
            let _ = symbols; // resume is read fresh from redb each attempt (reconnect-safe)
            let url = self
                .base_url
                .clone()
                .unwrap_or_else(|| DEFAULT_YAHOO_WS_URL.to_string());
            let (mut ws, _) = match connect_async(&url).await {
                Ok(v) => v,
                Err(_) => return AttemptOutcome::NeverConnected,
            };
            let _ = tx
                .send(CoreEvent::Status(ProviderStatus::Connected {
                    provider: ProviderKind::Yahoo,
                }))
                .await;

            // initial subscribe: full persisted bare-key set (single-channel)
            let subs = self.load_subscriptions();
            if !subs.is_empty() {
                let payload = serde_json::json!({ "subscribe": subs }).to_string();
                if ws.send(Message::Text(payload.into())).await.is_err() {
                    return AttemptOutcome::ConnectedThenDropped;
                }
            }

            let mut silence = tokio::time::interval(tokio::time::Duration::from_secs(
                self.silence_seconds.max(1) as u64,
            ));
            let mut ping = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL));
            let _ = silence.tick().await;
            let _ = ping.tick().await;

            loop {
                tokio::select! {
                    _ = stop_rx.recv() => return AttemptOutcome::Stopped,
                    req = sub_rx.recv() => {
                        match req {
                            // single-channel: ignore the channel tag, subscribe the bare symbols
                            Some(SubRequest { symbols: syms, .. }) => {
                                if !syms.is_empty() {
                                    let payload = serde_json::json!({ "subscribe": syms }).to_string();
                                    let _ = ws.send(Message::Text(payload.into())).await;
                                }
                            }
                            None => return AttemptOutcome::Stopped,
                        }
                    }
                    _ = ping.tick() => { let _ = ws.send(Message::Ping(vec![].into())).await; }
                    _ = silence.tick() => return AttemptOutcome::ConnectedThenDropped,
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            silence.reset();
                            if let Some((raw, uni)) = parse_yahoo_message(&t, &self.name) {
                                let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Yahoo(raw), uni }).await;
                            }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => return AttemptOutcome::ConnectedThenDropped,
                    }
                }
            }
        }
        .boxed()
    }
}
```

- [ ] **Step 4: Run the driver tests + full suite.**

Run: `cargo test -p corelib-rust driver_tests`
Expected: PASS (`validate_is_always_ok_no_credentials`, `load_subscriptions_reads_bare_keys`).

Run: `cargo test`
Expected: PASS (whole default-feature suite still green).

Run: `cargo clippy`
Expected: no new warnings.

- [ ] **Step 5: Commit.**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs
git commit -m "$(cat <<'EOF'
feat(yahoo): YahooDriver connect_once (no auth, single-channel, redb resume)

Single connection attempt on the shared ProviderDriver contract: connect →
emit Connected → subscribe full persisted bare-key set → pump. No auth means
no Fatal path; failed connect -> NeverConnected. Reads redb fresh each connect.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite the `YahooStreaming` facade as a thin host delegate

Replace the bespoke `YahooStreamingCore`/`ws_loop`/callbacks machinery with a `WebsocketStreamerHost` + `YahooDriver` delegate, mirroring `FinnhubStreaming` (single-channel) and `AlpacaStreaming` (dual-mode pump). **Preserve `LogRecord` and `EventRecord`** (other facades import them via `use crate::{EventRecord, LogRecord}`).

**Files:**
- Modify (rewrite): `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs`

**Context (verify in Step 0):** `LogRecord`/`EventRecord` are `#[napi(object)]` structs currently defined in `yahoo_streamer.rs` and re-exported at crate root; `alpaca_streamer.rs` and `finnhub_streamer.rs` do `use crate::{EventRecord, LogRecord};` — so these two struct definitions MUST remain in the rewritten file with identical shape. `JsPricingData` is the `on_pricing` payload type (from the proto handler). The host API: `WebsocketStreamerHost::new(unique_db_path(prefix, env), table, source, ProviderKind)`, `host.db_handle()`, `host.table_name()`, `host.get_persisted_subscriptions()`, `host.subscribe(Vec<String>)`, `host.unsubscribe(Vec<String>)`, `host.start(driver, Vec::new(), ReconnectPolicy{...}, pump)`, `host.stop_tx.take()`. `YahooConfig` currently has `db_path: Option<String>` + `silence_seconds: Option<u32>`.

- [ ] **Step 1: Replace the entire file contents** of `yahoo/yahoo_streamer.rs` with:

```rust
// =============================================
// FILE: rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs
// PURPOSE: Thin N-API facade for the Yahoo Finance real-time data stream.
// DESCRIPTION: Delegates all websocket/reconnect/persistence work to the shared
// `WebsocketStreamerHost` + `YahooDriver`. Dual-mode: emits the byte-identical raw
// `JsPricingData` via `on_pricing` AND the unified (finstream-superset) `MarketEvent`
// as JSON via the optional `on_market_event` callback. Single-channel (bare-symbol)
// subscriptions persisted in redb (the single source of truth for resume).
// =============================================

use crate::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_driver::YahooDriver;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

pub use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::JsPricingData;

/// Configuration parameters for the Yahoo price streamer. Yahoo has no credentials; `db_path`
/// and `base_url` are retained for API/back-compat and test injection.
#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct YahooConfig {
    /// Legacy no-op: the redb path is derived per-instance by the host (or via the `YAHOO_DB`
    /// env override). Retained for back-compat; ignored.
    pub db_path: Option<String>,
    /// Threshold in seconds for silence detection before triggering a reconnect (default 60).
    pub silence_seconds: Option<u32>,
    /// Optional override for the WebSocket URL (defaults to the Yahoo v2 streamer).
    pub base_url: Option<String>,
}

/// Represents a single log entry formatted for the Corelib StrictLogger.
#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct LogRecord {
    /// The log level (e.g., "info", "error", "trace").
    pub level: String,
    /// The primary log message.
    pub msg: String,
    /// Optional structured data serialized as a JSON string.
    pub extras: Option<String>,
}

/// Represents a lifecycle event emitted by the streamer.
#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct EventRecord {
    /// The type of event (e.g., "connected", "disconnected", "reconnecting", "error").
    pub r#type: String,
    /// Optional metadata or error message associated with the event.
    pub data: Option<String>,
}

/// Interior mutable state for `YahooStreaming`.
struct YahooInner {
    host: WebsocketStreamerHost,
    config: YahooConfig,
    started: bool,
}

impl YahooConfig {
    fn default_empty() -> Self {
        Self {
            db_path: None,
            silence_seconds: None,
            base_url: None,
        }
    }
}

/// N-API facade for Yahoo real-time streaming (dual-mode: raw + unified).
///
/// `ThreadsafeFunction` is not `Clone`; each is wrapped in `Arc` so the pump closure can hold a
/// cheap reference-counted copy. `on_market_event` is optional (absent ⇒ raw-only consumers).
#[napi]
pub struct YahooStreaming {
    inner: Arc<Mutex<YahooInner>>,
    on_log: Arc<ThreadsafeFunction<LogRecord>>,
    on_pricing: Arc<ThreadsafeFunction<JsPricingData>>,
    on_event: Arc<ThreadsafeFunction<EventRecord>>,
    on_market_event: Option<Arc<ThreadsafeFunction<String>>>,
}

#[napi]
impl YahooStreaming {
    /// Constructs a new `YahooStreaming` with the JS callback functions.
    /// Order: (on_log, on_pricing, on_event, [on_market_event]). `on_market_event` is optional —
    /// pass it to also receive the unified `"market"` stream.
    #[napi(constructor)]
    pub fn new(
        on_log: ThreadsafeFunction<LogRecord>,
        on_pricing: ThreadsafeFunction<JsPricingData>,
        on_event: ThreadsafeFunction<EventRecord>,
        on_market_event: Option<ThreadsafeFunction<String>>,
    ) -> Self {
        let host = WebsocketStreamerHost::new(
            unique_db_path("yahoo_streaming", "YAHOO_DB"),
            "yahoo_subscriptions",
            "yahoo".into(),
            ProviderKind::Yahoo,
        );
        Self {
            inner: Arc::new(Mutex::new(YahooInner {
                host,
                config: YahooConfig::default_empty(),
                started: false,
            })),
            on_log: Arc::new(on_log),
            on_pricing: Arc::new(on_pricing),
            on_event: Arc::new(on_event),
            on_market_event: on_market_event.map(Arc::new),
        }
    }

    /// Set config (silence threshold / optional base_url override).
    #[napi]
    pub async fn init(&self, config: YahooConfig) -> Result<()> {
        self.inner.lock().await.config = config;
        Ok(())
    }

    /// Start streaming; the driver resumes persisted subscriptions (redb) on every (re)connect.
    #[napi]
    pub async fn start(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        if g.started {
            return Ok(());
        }
        let driver = YahooDriver {
            name: "yahoo".into(),
            base_url: g.config.base_url.clone(),
            silence_seconds: g.config.silence_seconds.unwrap_or(60),
            db: g.host.db_handle(),
            table: g.host.table_name(),
        };
        let on_pricing = Arc::clone(&self.on_pricing);
        let on_event = Arc::clone(&self.on_event);
        let on_market = self.on_market_event.clone();
        g.host.start(
            driver,
            Vec::new(),
            ReconnectPolicy {
                jitter: true,
                ..Default::default()
            },
            move |ev: CoreEvent| match ev {
                CoreEvent::Pricing {
                    raw: RawPricing::Yahoo(p),
                    uni,
                } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let Some(cb) = on_market.as_ref() {
                        for u in &uni {
                            if let Ok(j) = serde_json::to_string(u) {
                                let _ = cb.call(Ok(j), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }
                }
                CoreEvent::Status(status) => {
                    let (t, d) = match status {
                        ProviderStatus::Connected { .. } => ("connected".to_string(), None),
                        ProviderStatus::Disconnected { reason, .. } => {
                            ("disconnected".to_string(), Some(reason))
                        }
                        ProviderStatus::Reconnecting {
                            attempt, delay_ms, ..
                        } => (
                            "reconnecting".to_string(),
                            Some(format!("attempt {attempt}, {delay_ms}ms")),
                        ),
                        ProviderStatus::Error { message, .. } => {
                            ("error".to_string(), Some(message))
                        }
                    };
                    let _ = on_event.call(
                        Ok(EventRecord { r#type: t, data: d }),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
                // RawPricing::Alpaca / ::Finnhub never reach the Yahoo pump.
                _ => {}
            },
        );
        let _ = self.on_log.call(
            Ok(LogRecord {
                level: "debug".into(),
                msg: "yahoo start".into(),
                extras: None,
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        g.started = true;
        Ok(())
    }

    /// Subscribe to additional symbols (bare list; persisted to redb + sent live to the driver).
    #[napi]
    pub async fn subscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.inner.lock().await.host.subscribe(symbols).await;
        Ok(())
    }

    /// Remove `symbols` from the persisted set (so they don't resume on restart).
    #[napi]
    pub async fn unsubscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.inner.lock().await.host.unsubscribe(symbols).await;
        Ok(())
    }

    /// Clears all persisted subscriptions and stops the stream.
    #[napi]
    pub async fn clean(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        let _ = g.host.delete_subscriptions_table();
        if let Some(tx) = g.host.stop_tx.take() {
            let _ = tx.try_send(());
        }
        g.started = false;
        Ok(())
    }

    /// Gracefully stops the streaming supervisor (keeps persisted subscriptions for resume).
    #[napi]
    pub async fn stop(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        if let Some(tx) = g.host.stop_tx.take() {
            let _ = tx.try_send(());
        }
        g.started = false;
        Ok(())
    }
}

#[cfg(test)]
mod facade_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::host::{
        unique_db_path, WebsocketStreamerHost,
    };
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;

    fn fresh_host() -> WebsocketStreamerHost {
        WebsocketStreamerHost::new(
            unique_db_path("yahoo_streaming", "YAHOO_DB_TEST_UNSET"),
            "yahoo_subscriptions",
            "yahoo".into(),
            ProviderKind::Yahoo,
        )
    }

    #[tokio::test]
    async fn subscribe_persists_bare_keys_and_resumes() {
        let host = fresh_host();
        host.subscribe(vec!["AAPL".into(), "BTC-USD".into()]).await;
        let mut got = host.get_persisted_subscriptions();
        got.sort();
        assert_eq!(got, vec!["AAPL".to_string(), "BTC-USD".to_string()]);
    }

    #[tokio::test]
    async fn unsubscribe_removes_persisted_key() {
        let host = fresh_host();
        host.subscribe(vec!["AAPL".into(), "MSFT".into()]).await;
        host.unsubscribe(vec!["AAPL".into()]).await;
        assert_eq!(
            host.get_persisted_subscriptions(),
            vec!["MSFT".to_string()]
        );
    }
}
```

- [ ] **Step 2: Run the facade tests + full suite.**

Run: `cargo test -p corelib-rust facade_tests`
Expected: PASS (`subscribe_persists_bare_keys_and_resumes`, `unsubscribe_removes_persisted_key`) — note other facades also define a `facade_tests` module; this command runs all of them, all must pass.

Run: `cargo test`
Expected: PASS (whole default-feature suite green; the old `test_load_subscriptions_empty` / `test_decode_pricing_message` Yahoo tests are intentionally removed with the bespoke core).

Run: `cargo clippy`
Expected: no new warnings.

- [ ] **Step 3: Commit.**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs
git commit -m "$(cat <<'EOF'
feat(yahoo): rewrite YahooStreaming as thin WebsocketStreamerHost delegate

Dual-mode facade mirroring Alpaca/Finnhub: raw JsPricingData via on_pricing +
optional unified MarketEvent JSON via on_market_event ("market"). Single-channel
bare-symbol subscribe/unsubscribe through the host. Drops the bespoke
YahooStreamingCore/ws_loop/RustCallbacks machinery. Keeps LogRecord/EventRecord.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rewrite the CLI bin + update `lib.rs` exports

The bin moves off the deleted `YahooStreamingCore`/`RustCallbacks` onto the host+driver (mirroring `bin/alpaca_streamer.rs`). `lib.rs` re-exports drop the deleted symbols.

**Files:**
- Modify (rewrite): `rust/src/bin/yahoo_streamer.rs`
- Modify: `rust/src/lib.rs`

**Context (verify in Step 0):** The current bin imports `corelib_rust::{RustCallbacks, YahooConfig, YahooStreamingCore}` — all gone after Task 5 except `YahooConfig`. `lib.rs` re-exports (two sites: the inner `pub use yahoo_streamer::{...}` set in Task 3 Step 1, and the crate-root `pub use markets::...::yahoo::{...}`) list `EventRecord, LogRecord, RustCallbacks, YahooConfig, YahooStreaming, YahooStreamingCore`. `bin/alpaca_streamer.rs` is the structural template (host + driver + stdout pump + Ctrl-C → host Drop). The Yahoo bin arg surface is `--symbols/--silence/--clean/--db/--noPersist`.

- [ ] **Step 1: Update both `lib.rs` re-export sites** to drop `RustCallbacks` and `YahooStreamingCore`.

Inner `pub use` (inside `pub mod yahoo { ... }`):

```rust
                    /// Re-export Yahoo streaming components for convenience.
                    pub use yahoo_streamer::{EventRecord, LogRecord, YahooConfig, YahooStreaming};
```

Crate-root re-export:

```rust
/// Re-export Yahoo streaming components.
pub use markets::nasdaq::datafeeds::streaming::yahoo::{
    EventRecord, LogRecord, YahooConfig, YahooStreaming,
};
```

- [ ] **Step 2: Replace the entire `bin/yahoo_streamer.rs`** with the host+driver version:

```rust
// =============================================
// FILE: rust/src/bin/yahoo_streamer.rs
// PURPOSE: CLI entry point for the Yahoo Finance price streamer.
// DESCRIPTION: Drives a YahooDriver on the shared WebsocketStreamerHost. Outputs
// raw decoded pricing data as JSON lines to stdout; lifecycle status to stderr.
// =============================================

use clap::Parser;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use corelib_rust::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_driver::YahooDriver;
use std::io::{self, Write};

/// Command-line arguments for the Yahoo streamer CLI.
#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Comma-separated list of symbols to subscribe to (e.g., "AAPL,MSFT,TSLA").
    #[arg(short, long)]
    symbols: Option<String>,
    /// Threshold in seconds for silence detection before reconnecting.
    #[arg(long, default_value = "60")]
    silence: u32,
    /// If set, clears all existing persistent subscriptions before starting.
    #[arg(long)]
    clean: bool,
    /// Optional path to the persistence database (maps to the YAHOO_DB env override).
    #[arg(long)]
    db: Option<String>,
    /// If set, skips stable persistence (uses an ephemeral per-run db file).
    #[arg(long = "noPersist")]
    no_persist: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Resolve the redb path the host will use (via the YAHOO_DB override read by unique_db_path).
    if let Some(db) = &args.db {
        std::env::set_var("YAHOO_DB", db);
    } else if !args.no_persist {
        let mut p = std::env::temp_dir();
        p.push("yahoo_streamer.db");
        std::env::set_var("YAHOO_DB", p.to_string_lossy().to_string());
    }

    let symbols: Vec<String> = args
        .symbols
        .clone()
        .map(|s| {
            s.split(',')
                .map(|item| item.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect()
        })
        .unwrap_or_default();

    eprintln!("Initializing Yahoo Streamer binary...");

    let mut host = WebsocketStreamerHost::new(
        unique_db_path("yahoo_streaming", "YAHOO_DB"),
        "yahoo_subscriptions",
        "yahoo".into(),
        ProviderKind::Yahoo,
    );

    if args.clean {
        eprintln!("Cleaning subscriptions...");
        let _ = host.delete_subscriptions_table();
        if args.symbols.is_none() {
            eprintln!("Done.");
            return Ok(());
        }
    }

    // Pre-seed persisted subscriptions (the driver resumes these from redb on connect).
    if !symbols.is_empty() {
        host.subscribe(symbols.clone()).await;
    }

    let driver = YahooDriver {
        name: "yahoo".into(),
        base_url: None,
        silence_seconds: args.silence,
        db: host.db_handle(),
        table: host.table_name(),
    };

    host.start(
        driver,
        Vec::new(),
        ReconnectPolicy {
            jitter: true,
            ..Default::default()
        },
        |ev: CoreEvent| match ev {
            CoreEvent::Pricing {
                raw: RawPricing::Yahoo(p),
                ..
            } => {
                if let Ok(json) = serde_json::to_string(&p) {
                    println!("{json}");
                    let _ = io::stdout().flush();
                }
            }
            CoreEvent::Status(s) => eprintln!("[EVENT] {s:?}"),
            _ => {}
        },
    );

    if symbols.is_empty() {
        eprintln!(
            "Warning: No symbols provided. Streamer is running but idle. Use --symbols=AAPL,MSFT"
        );
    }
    eprintln!("Streaming started. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await.unwrap();
    eprintln!("Stopping...");
    // `host` drops here → supervisor stops (stop_tx) and monitor/pump tasks abort.
    Ok(())
}
```

- [ ] **Step 3: Verify the lib, tests, clippy, and all three bins build.**

Run: `cargo test`
Expected: PASS (default-feature suite green).

Run: `cargo clippy --features clap`
Expected: no new warnings (this lints the bins too).

Run: `cargo build --features clap`
Expected: builds `alpaca_streamer`, `nasdaq_polling`, `yahoo_streamer` with no errors.

- [ ] **Step 4: Commit.**

```bash
git add rust/src/bin/yahoo_streamer.rs rust/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(yahoo): port CLI bin to WebsocketStreamerHost + YahooDriver

Bin drives YahooDriver on the shared host (stdout JSON pump, Ctrl-C → host Drop),
matching the Alpaca bin. Drops RustCallbacks/YahooStreamingCore re-exports from lib.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: TS `"market"` event + regenerate bindings

Add the optional 4th callback to the TS wrapper (mirroring `AlpacaStreaming.ts`) and regenerate the FFI bindings so the new constructor arity + `YahooConfig.base_url` are reflected.

**Files:**
- Modify: `ts-markets/src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts`
- Regenerate: `rust/index.d.ts`, `rust/index.js`

**Context (verify in Step 0):** `AlpacaStreaming.ts` is the template — it passes a 4th `(_err, json) => this.emit("market", JSON.parse(json))` callback and documents the `market` event. `YahooStreaming.ts` currently passes only 3 callbacks and keeps a plain `subscribe(symbols: string[])` (NO subscribe overload — Yahoo is single-channel, D2/§7).

- [ ] **Step 1: Add the 4th callback + market event to `YahooStreaming.ts`.** Change the `this.rust = new RustYahoo(...)` constructor call to add the 4th arg (insert after the `on_event` arrow, before the closing `)`):

```typescript
		this.rust = new RustYahoo(
			(_err: any, record: any) => this.emit("log", record),
			(_err: any, data: any) => this.emit("pricing", data),
			(_err: any, event: any) => {
				if (event) {
					this.emit(event.type, event.data ?? null);
				}
			},
			(_err: any, json: string) => {
				try {
					this.emit("market", JSON.parse(json));
				} catch {}
			},
		);
```

Update the trailing events comment block to include `market`:

```typescript
// Events emitted:
// - pricing (JsPricingData)
// - log ({level, msg, extras?})
// - market (unified MarketEvent JSON, parsed object)
// - connected, disconnected, reconnecting, error
```

(Leave `init`, `subscribe(symbols: string[])`, `unsubscribe`, `start`, `clean`, `stop` unchanged — single-channel, no overload.)

- [ ] **Step 2: Regenerate the native bindings.**

Run (from `rust/`): `pnpm run build:local`
Expected: regenerates `rust/index.d.ts` + `rust/index.js`; the `YahooStreaming` constructor type now shows the optional 4th `onMarketEvent` callback and `YahooConfig` gains `baseUrl?`.

- [ ] **Step 3: Confirm the regenerated `index.d.ts` reflects the new surface.**

Run: `git diff --stat rust/index.d.ts rust/index.js`
Expected: both files changed. Inspect `rust/index.d.ts` to confirm `YahooStreaming`'s constructor lists 4 args (the 4th optional) and `RustCallbacks`/`YahooStreamingCore` are gone.

- [ ] **Step 4: Typecheck + test the TS workspace.**

Run (from repo root): `pnpm --filter @ckirg/corelib-markets typecheck`
Expected: PASS.

Run (from repo root): `pnpm --filter @ckirg/corelib-markets test:run`
Expected: PASS (existing ts-markets suite; no Yahoo regression).

- [ ] **Step 5: Commit.**

```bash
git add ts-markets/src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts rust/index.d.ts rust/index.js
git commit -m "$(cat <<'EOF'
feat(yahoo): emit unified "market" event in TS wrapper + regenerate bindings

Adds the optional 4th on_market_event callback (parsed MarketEvent) mirroring
AlpacaStreaming. Single-channel subscribe(string[]) unchanged. Regenerates
index.d.ts/index.js for the new constructor arity and YahooConfig.base_url.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full-gate verification + final review

No new code — confirm every gate is green across the whole repo before finishing the branch.

**Files:** none (verification only)

- [ ] **Step 1: Rust gates.**

Run (from `rust/`): `cargo test`
Expected: PASS — Alpaca + Finnhub + core + new Yahoo mapper/driver/facade tests all green.

Run (from `rust/`): `cargo clippy --features clap`
Expected: no new warnings.

Run (from `rust/`): `cargo build --features clap`
Expected: all three bins build.

- [ ] **Step 2: Full TS gate.**

Run (from repo root): `pnpm verify:full`
Expected: PASS — format/lint/typecheck/build/test across ts-core, ts-markets, ts-cloud (no regression).

- [ ] **Step 3: Final review pass.** Dispatch the final code-quality reviewer over the whole branch diff (`git diff main...HEAD`), then proceed to `superpowers:finishing-a-development-branch`.

---

## Self-Review (planner checklist — completed)

- **Spec coverage:** D1 carrier→Task 1; D2 single-channel→Tasks 4–5; D3 heartbeat raw+empty-uni→Task 3 (`heartbeat_yields_raw_but_empty_uni`); D4 superset widening→Task 2; D5 mirror 2a + reuse proto handler→Tasks 3–6; D6 `quote_type_label`→Task 2. `RawPricing::Yahoo`→Task 1. `parse_yahoo_message`→Task 3. `YahooDriver`→Task 4. Facade→Task 5. Bin→Task 6. TS `market` + bindings→Task 7. Testing §8→every task + Task 8.
- **Type consistency:** `YahooTradeExtras`/`YahooQuoteExtras` field names used in Task 3 (`trade_extras`/`quote_extras`) match the Task 2 widening exactly; `YahooOptionExtras` field set identical across Tasks 2 & 3; `quote_type_label` signature `(i32) -> String` consistent; `parse_yahoo_message` return type `Option<(JsPricingData, Vec<MarketEvent>)>` consistent across Tasks 3–4; `uni: Vec<MarketEvent>` carrier consistent across Tasks 1, 4, 5.
- **Placeholders:** none — all code blocks complete, all enum/match arms full, all commands exact.
- **Known coupling flagged:** `LogRecord`/`EventRecord` must survive the Task 5 rewrite (other facades import them); both `lib.rs` re-export sites updated in Task 6.
