# Provider Port — Phase 2a Design Spec (Alpaca dual-mode migration)

- **Date:** 2026-06-12
- **Status:** Design approved (forks locked). agy brainstorm + dual-mode + subscription-scope divergent passes + spec-phase pass complete (ITERATE folded). **Pending user review.**
- **Subproject:** (d) Port finstream providers — **Phase 2a of 3** (Phase 2 split into 2a Alpaca / 2b Yahoo).
- **Review record:** `ANTIGRAVITY-TO-CLAUDE.md` → "(d) Phase 2 — migrate Alpaca/Yahoo…", "(d) Phase 2 — DUAL-MODE emission…", "(d) Phase 2a — Alpaca subscription-mirror scope…".
- **Roadmap:** `ROADMAP.md` → subproject (d), Phase 2 (after Phase 1 ✅ `4bc0b24`).
- **Predecessor spec:** `docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md` (the shared engine this builds on).

## 1. Context & Goal

Phase 1 (merged `4bc0b24`) stood up the shared streaming engine — `ProviderDriver::connect_once` (single
attempt → `AttemptOutcome`), a supervisor that owns the reconnect loop, `ReconnectPolicy`, and a
**non-generic** `WebsocketStreamerHost` that owns redb + supervisor/monitor/pump tasks + `Drop` — and
shipped **Finnhub** on it. `AlpacaStreaming` and `YahooStreaming` still run their **bespoke**
`*StreamingCore<C>` loops (duplicated reconnect/silence/ping/redb), untouched by Phase 1.

**Product intent (user, verbatim):** *"mirror each provider (user can set all parameters accepted by a
provider) — we add the websocket management, the persistence layer (redb) and a unified format for easy
switching between providers."* Each streamer is a **faithful mirror** of its provider's native streaming
API; corelib adds WS management + redb persistence + a **unified "uni" format** whose sole purpose is
**portability/easy switching** between providers.

**Phase 2a goal:** migrate **Alpaca** onto the shared engine, deleting its bespoke loop, and make it the
first **dual-mode** streamer — emitting both the byte-identical **raw** payload (today's behavior) and the
new **unified** event — while widening its subscription surface to a true (pricing-channel) mirror.
**Yahoo** (protobuf + 33-field) is **Phase 2b**, a separate spec.

## 2. Non-Goals (Phase 2a)

- **Migrating Yahoo** — Phase 2b.
- **Alpaca admin channels** (`statuses`, `lulds`, `corrections`, `cancelErrors`) — deferred (S1-a). Only
  the **pricing** channels (`trades`, `quotes`, `bars`) are mirrored now.
- **A `MarketEvent::Bar` variant** — bars stay **raw-only** (no unified representation). corelib's uni
  *does* add `TradeExtras::Alpaca` (a documented superset of finstream, §5.3) so Alpaca **trades** are
  portable; **bars** remain the only S1-a channel without a uni mapping.
- **A multiplexed external gateway** — Phase 3, optional.
- **Changing the existing raw flat payload (`AlpacaPricingData`) or the 3-callback / `subscribe(symbols)`
  byte-compat contract** — all additions are additive.

## 3. Locked decisions (forks → provenance)

All resolved via the agy-first protocol (agy + Claude recommendations, user choice). Full reasoning in
`ANTIGRAVITY-TO-CLAUDE.md`.

| Fork | Decision | Decider |
|---|---|---|
| **C — sequencing** | Split **2a Alpaca**, then 2b Yahoo. | both rec; user |
| **B — ping/silence** | Live inside each driver's `connect_once` select! loop; silence → `AttemptOutcome::ConnectedThenDropped`. | both rec |
| **D — cleanup** | Delete old `AlpacaStreamingCore<C>` / `AlpacaCallbacks`; rewrite `bin/alpaca_streamer.rs` onto the host. | both rec |
| **A / 1 — channel payload** | `CoreEvent { Status(ProviderStatus), Pricing { raw: RawPricing, uni: Option<MarketEvent> } }`; driver builds both at decode. | both rec |
| **(Claude refinement)** | Raw payload structs defined **once** in a neutral `core` module (keeping their `#[napi(object)]` derive); **no** duplicated mirror structs. | Claude (vs agy's mirror) |
| **2 — FFI surface for uni** | Optional **4th callback** `on_market_event(json: String)`; preserves 3-callback byte-compat; TS emits **`"market"`**. | both rec |
| **3 — Finnhub retrofit** | **Yes** — wire Finnhub's `on_market_event` in the foundation task for 3-provider parity. | both rec |
| **4 — task structure** | A **2a-0 foundation** task: adopt finstream `types.rs` into `core/schema.rs` + `CoreEvent` + `host.delete_subscriptions_table()`, `#[allow(dead_code)]` until wired. | both rec |
| **S1 — Alpaca subs depth** | **S1-a:** `trades` + `quotes` + `bars` only, per-symbol selectable, additive. (Not full 9-channel surface.) | user (agy rec'd S1-b) |
| **S2 — uni for non-finstream channels** | **S2-a + Alpaca-trade extension:** non-representable channels (bars) stay raw-only, BUT add `TradeExtras::Alpaca` so Alpaca **trades** are uni-portable — corelib uni is a documented **superset** of finstream (§5.3). | user (adopting agy spec-pass nit) |

## 4. Architecture

### 4.0 Phase 2a-0 — shared foundation (do first)

Compile-checked type/host groundwork both the Alpaca migration and (later) Yahoo build on. No driver
behavior changes here.

1. **Expand `core/schema.rs` from finstream** (port `crates/core/src/types.rs`, + the §5.3 superset): add the
   `MarketEvent::Quote { source, data: Quote }` variant, the `Quote` struct, `QuoteExtras { Alpaca, Yahoo }`,
   `TradeExtras::Yahoo`, and the per-provider extras structs (`AlpacaQuoteExtras`, `YahooTradeExtras`,
   `YahooQuoteExtras`; `FinnhubTradeExtras` already exists), plus the **flattening `Serialize`** impls
   (nest extras under a provider-named key; `type:"trade"|"quote"`; `Status` flattens its tagged fields).
   `ProviderKind`/`ProviderStatus` already match finstream. Yahoo-only items get `#[allow(dead_code)]`
   until 2b. **corelib superset:** also add `TradeExtras::Alpaca(AlpacaTradeExtras)` — *not* present in
   finstream — so Alpaca trades are uni-portable (§5.3).
2. **Introduce `CoreEvent`** (new, in `core/types.rs`) — see §4.1.
3. **`WebsocketStreamerHost` changes** (§4.6): channel becomes `mpsc::Sender<CoreEvent>`; `start`'s pump
   becomes `FnMut(CoreEvent)`; add `pub fn delete_subscriptions_table(&self) -> Result<(), String>` for
   `clean()`.
4. **Finnhub retrofit** (§4.7): Finnhub already emits `MarketEvent::Trade`; route it through `CoreEvent`
   and wire the optional `on_market_event`.

Because the channel type changes, **Finnhub's driver + facade are necessarily touched** in this task
(they currently send/pump `MarketEvent`); migrating them to `CoreEvent` is part of the foundation, and the
Finnhub retrofit (Fork 3) folds in here for free.

### 4.1 `CoreEvent` channel + `RawPricing`

The shared channel carries `CoreEvent`. The host is **non-generic** and shared, so the payload enumerates
providers; the per-provider facade pump matches its own arm.

```rust
// core/types.rs — pure-Rust + napi(object) raw payloads live here (single definition; Claude refinement)
pub enum CoreEvent {
    Status(ProviderStatus),
    Pricing {
        raw: RawPricing,            // lossless, byte-identical to the legacy typed payload
        uni: Option<MarketEvent>,   // None ⇒ raw-only: bars (no Bar variant); quotes+trades map to Some (§5.3)
    },
}

pub enum RawPricing {
    Alpaca(AlpacaPricingData),
    Finnhub(FinnhubPricingData),
    // Yahoo(Box<JsPricingData>) added in 2b — Box: 33-field payload, keep the enum small
}
```

The **driver** decodes a frame once and emits `CoreEvent::Pricing { raw, uni }` — building `raw` (the flat
typed payload) and, when the channel has a unified representation, the matching `uni`
`MarketEvent` (quotes + trades; `None` for bars). `AlpacaPricingData` (and `FinnhubPricingData`) **move into `core/types.rs`** keeping their
`#[napi(object)]` derive — a single source of truth that both `core` and the facade reference (no mirror
struct, no `From` boilerplate, no layering inversion since they live in `core`). Re-export from `lib.rs`
under the existing names so the public FFI surface is unchanged.

**Channel-migration completeness (agy spec-pass 🔴 — every `MarketEvent` send site on the engine channel
must become `CoreEvent`):**
- `ProviderDriver::connect_once`'s `tx: &mpsc::Sender<MarketEvent>` param → `&mpsc::Sender<CoreEvent>`;
  drivers now emit `CoreEvent::Status(..)` (was `MarketEvent::Status`) and `CoreEvent::Pricing { .. }`.
- `host.rs` panic monitor (currently `host.rs:~L107-L118`, sends `MarketEvent::Status{Error}` on supervisor
  panic) → emit `CoreEvent::Status(ProviderStatus::Error { .. })`.
- `supervisor.rs` `run_supervisor` itself **does not send on `tx`** (verified — it only calls `connect_once`
  and reads `AttemptOutcome`), so its body is type-agnostic; only its `tx`/`Sender` generic param threads
  through as `CoreEvent`. The Finnhub driver + facade pump (Phase 1) are migrated to `CoreEvent` in the
  same 2a-0 foundation task (they are the only existing `MarketEvent` users).
- `CoreEvent::Status` carries `ProviderStatus` (source is the facade's own instance — the status→
  `EventRecord` pump mapping needs only the status), keeping `MarketEvent` itself close to finstream (plus
  the documented `TradeExtras::Alpaca` superset, §5.3).

### 4.2 AlpacaDriver

`rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs` (new) — `impl ProviderDriver`,
`connect_once` does **one** attempt (supervisor owns the loop). It replicates the bespoke `ws_loop`
behavior exactly, now emitting `CoreEvent`:

- **Connect + auth handshake** (from the existing `ws_loop`): connect → expect `{"T":"success","msg":"connected"}`
  → send `{"action":"auth",...}` → expect `{"T":"success","msg":"authenticated"}`. On an auth **error**
  frame (`{"T":"error",...}`) return **`AttemptOutcome::Fatal(msg)`** (stops the supervisor — auth is not
  retryable). On other handshake failures return `NeverConnected`.
- **On authenticated:** emit `CoreEvent::Status(ProviderStatus::Connected { provider: Alpaca })` (the
  supervisor's backoff-reset signal), then send the initial channel subscription (from the resumed redb
  channel→symbols map, §4.4) as `{"action":"subscribe","trades":[…],"quotes":[…],"bars":[…]}`.
- **select! loop** (driver-owned, like Finnhub): `stop_rx` → `Stopped`; `sub_rx` (carries channel-tagged
  symbol updates, §4.4) → send incremental subscribe; `ws.next()` → parse; **`ping_timer`** (30 s) → send
  `Ping`; **`silence_timer`** (`silence_seconds`) → `ConnectedThenDropped` (reset-backoff reconnect).
  `sub_rx` closed (`None`) → `Stopped` (no busy-spin).
- **Frame parsing** (`t:"q"|"t"|"b"`): build `AlpacaPricingData` (`message_type` `"quote"|"trade"|"bar"`,
  string `timestamp`) for **`raw`**; build **`uni`** per §5.3 (quotes → `Some(MarketEvent::Quote)`;
  trades → `Some(MarketEvent::Trade)`; bars → `None`). Emit `CoreEvent::Pricing { raw, uni }`.
  `subscription`/`error`/unknown frames → log via the status/log path.

The `sub_rx` payload is **channel-aware** — `Vec<(Channel, Vec<String>)>` or an equivalent tagged type —
not a bare `Vec<String>`, so a live `subscribe({ trades: [...] })` reaches the socket on the right channel.
This widens the shared `sub_rx` element type; Finnhub/Yahoo use the single-channel case.

### 4.3 AlpacaStreaming facade (dual-mode)

`alpaca_streamer.rs` is rewritten to a **thin delegate** over `WebsocketStreamerHost` (mirrors
`FinnhubStreaming`), holding `Arc<Mutex<AlpacaInner { host, config, started }>>` + the TSFNs. Changes vs
Phase 1 Finnhub facade:

- **Constructor gains an optional 4th callback:** `new(on_log, on_pricing, on_event, on_market_event?)`.
  `on_market_event: Option<ThreadsafeFunction<String>>` keeps the existing 3-arg call byte-compatible.
- **Pump closure** (given to `host.start`): matches `CoreEvent` →
  - `Pricing { raw: RawPricing::Alpaca(p), uni }` → `on_pricing.call(p)`; and if `on_market_event` is set
    **and** `uni` is `Some(ev)` → `on_market_event.call(serde_json::to_string(&ev))`.
  - `Status(s)` → map to `EventRecord` → `on_event` (same status mapping as Finnhub).
- **`subscribe`** takes a single `AlpacaSubscribeOpts` struct (§4.5) and routes each present channel to the
  host's `subscribe_channel`. The `string[] | opts` overload is resolved **in the TS wrapper** (§6), which
  coerces a bare array to `{ quotes: [...] }` before crossing FFI — so the Rust side never needs
  `napi::Either` and the JS-array-is-an-object discrimination ambiguity is avoided entirely (agy
  spec-pass 🟡). **`clean`** calls `host.delete_subscriptions_table()` then stops; `init/start/stop/
  unsubscribe` delegate as in Finnhub. `AlpacaConfig` keeps its masked `Debug`; `db_path` stays a
  **documented legacy no-op** (per-instance redb path is host-owned).

### 4.4 redb persistence — composite channel:symbol keys

Keep `TableDefinition<&str, bool>` (no schema migration). **Multi-channel** Alpaca stores
**`"<channel>:<symbol>"`** keys (`"quotes:AAPL"`, `"trades:MSFT"`, `"bars:TSLA"`). **Single-channel**
providers (Finnhub, later Yahoo) **keep storing bare symbols** (`"AAPL"`) exactly as today — *the host's
existing `Vec<String>` API and the existing `"finnhub_subscriptions"` data are untouched.*

**Do NOT change the type of the existing `get_persisted_subscriptions`/`subscribe`/`unsubscribe`** — that
would break the merged Finnhub facade (agy spec-pass 🔴, verified: Finnhub relies on `Vec<String>`).
Instead **add** channel-aware helpers to the host, leaving the old ones as-is:

```rust
// reads raw keys, splits on the first ':'; a colon-less key falls back to `default_channel`.
pub fn get_persisted_subscriptions_for_channel(&self, target_channel: &str, default_channel: &str) -> Vec<String>
pub fn subscribe_channel(&self, channel: &str, symbols: Vec<String>)      // writes "channel:symbol"
pub fn unsubscribe_channel(&self, channel: &str, symbols: Vec<String>)    // removes precise keys
```

Per-provider **default channel** for colon-less keys: **Alpaca → `"quotes"`** (back-compat for any
pre-2a Alpaca DB), **Finnhub → `"trades"`**, **Yahoo → `"quotes"`** (2b). Alpaca's facade calls the
`*_channel` helpers; Finnhub/Yahoo keep calling the bare-symbol API. Removing `AAPL` from `quotes` leaves
`trades:AAPL` intact (per-channel precision). The driver's channel-tagged `sub_rx` (§4.2) carries the same
`(channel, symbols)` shape so a live `subscribe({ trades: [...] })` reaches the socket on the right
channel; single-channel drivers use a fixed channel and ignore the tag.

### 4.5 Subscription FFI surface (S1-a)

```rust
#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct AlpacaSubscribeOpts {
    pub trades: Option<Vec<String>>,
    pub quotes: Option<Vec<String>>,
    pub bars:   Option<Vec<String>>,
}

#[napi]
pub async fn subscribe(&self, opts: AlpacaSubscribeOpts) -> Result<()> {
    // for each Some(channel) → host.subscribe_channel(channel, symbols)
}
```

Only `trades`/`quotes`/`bars` (S1-a). The Rust FFI takes the single struct (no `napi::Either`); the
**TS wrapper** owns the `string[] | AlpacaSubscribeOpts` overload and coerces a bare array to
`{ quotes }` (§6). `unsubscribe` takes the same `AlpacaSubscribeOpts` shape.

### 4.6 Host changes

- Channel type `MarketEvent` → `CoreEvent`; `start<D,P>` pump `FnMut(MarketEvent)` → `FnMut(CoreEvent)`
  (and all engine `Status` send sites, §4.1).
- `sub_tx`/`sub_rx` element type widens to the channel-tagged subscription shape (a small
  `{ channel, symbols }` type; single-channel drivers use a fixed channel). This touches the
  `ProviderDriver::connect_once` signature shared by Finnhub — mechanical, done in 2a-0.
- **Additive** channel-aware persistence helpers (`get_persisted_subscriptions_for_channel`,
  `subscribe_channel`, `unsubscribe_channel`); the existing bare-`Vec<String>` API is **left intact** so
  Finnhub keeps compiling (§4.4).
- New `pub fn delete_subscriptions_table(&self) -> Result<(), String>` (transactional `delete_table` +
  commit) for `clean()`.
- `Drop` (abort monitor + pump, signal stop) and per-instance redb path are unchanged.

### 4.7 Deletions & retrofit

- **Delete** `AlpacaStreamingCore<C>`, `AlpacaCallbacks`, `NapiCallbacks`, `Inner`, `WsLoopResult` from
  `alpaca_streamer.rs` (subsumed by host + driver).
- **Rewrite `rust/src/bin/alpaca_streamer.rs`** to build an `AlpacaDriver` + `WebsocketStreamerHost` and
  pump with a stdout closure (`CoreEvent::Pricing { raw, .. }` → `println!` JSON; `Status` → `eprintln!`)
  — the native path survives via the host's generic closure pump, no `Callbacks` trait needed.
- **Finnhub retrofit:** migrate `FinnhubDriver`/`FinnhubStreaming` to `CoreEvent`, add the optional
  `on_market_event` 4th callback, emit `uni = Some(MarketEvent::Trade)` for trades (Finnhub is trade-only;
  `FinnhubTradeExtras` exists in finstream uni → fully portable).

## 5. Unified-format adoption details

### 5.1 Source

finstream `crates/core/src/types.rs` (read-verified). Port into `core/schema.rs`:
`MarketEvent{Trade,Quote,Status}`, `Trade`, `Quote`, `TradeExtras{Finnhub,Yahoo}`,
`QuoteExtras{Alpaca,Yahoo}`, the extras structs, and the custom flattening `Serialize` impls — **plus one
documented superset addition**: `TradeExtras::Alpaca(AlpacaTradeExtras)` (§5.3), which finstream lacks.

### 5.2 Alpaca quote → unified `Quote`

`MarketEvent::Quote { source: <instance name>, data: Quote {`
`  ticker: S, timestamp: parse(t)→DateTime<Utc>, price: (bid+ask)/2.0,`
`  extras: QuoteExtras::Alpaca(AlpacaQuoteExtras{ bid: bp, ask: ap, bid_size: bs, ask_size: as_,`
`     bid_exchange, ask_exchange, conditions, tape }), raw: Some(<frame json>) } }`.

### 5.3 Alpaca trade → unified `Trade` (corelib superset) + bars raw-only

finstream's `TradeExtras` has only `Finnhub` and `Yahoo` (it models Alpaca purely as quotes), so to make
Alpaca **trades** portable on the `"market"` stream we **add a corelib-only variant**
`TradeExtras::Alpaca(AlpacaTradeExtras)` — a **documented superset** of finstream (user decision, adopting
agy's spec-pass nit). Mapping:

`MarketEvent::Trade { source: <instance name>, data: Trade {`
`  ticker: S, timestamp: parse(t)→DateTime<Utc>, price: p,`
`  extras: TradeExtras::Alpaca(AlpacaTradeExtras{ size: s, exchange, conditions, tape, id }),`
`  raw: Some(<frame json>) } }`.

```rust
#[derive(Debug, Clone, Serialize)]
pub struct AlpacaTradeExtras {
    pub size: f64,
    #[serde(skip_serializing_if = "Option::is_none")] pub exchange: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]    pub conditions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub tape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub id: Option<i64>,
}
```

**Net for the three S1-a channels:** **quotes → `MarketEvent::Quote`** and **trades → `MarketEvent::Trade`**
are both uni-portable (dual-emit on `"pricing"` + `"market"`); **bars are raw-only** (`"pricing"` only —
finstream has no `Bar` variant and we are **not** adding one in 2a, §11).

**Divergence note (low cost):** uni is serialize-only (Rust→JSON→JS consumers), so the superset never
breaks a Rust `Deserialize` round-trip; the only cost is conceptual drift from finstream. If finstream
later adds its own Alpaca-trade extras, re-sync the field shape. Keeping the `"alpaca"`-keyed extras object
shape close to finstream's `AlpacaQuoteExtras` style eases that.

## 6. TypeScript surface

`AlpacaStreaming.ts`:
- Constructor passes a **4th callback** to the FFI class: `(_err, json) => this.emit("market", JSON.parse(json))`.
- `subscribe(input: string[] | { trades?: string[]; quotes?: string[]; bars?: string[] })` — **the overload
  is resolved here**: `Array.isArray(input)` → call FFI `subscribe({ quotes: input })`; otherwise pass the
  object straight through. So bare `string[]` stays = quotes (byte-compat) and the FFI receives a single
  `AlpacaSubscribeOpts` (no `napi::Either`; §4.5).
- `unsubscribe` mirrors the overload; `clean/init/start/stop` unchanged.
- New emitted event documented: **`"market"`** (unified event); `"pricing"` (raw) unchanged.
- `AlpacaStreaming.test.ts` updated for the new event + overload; existing `pricing`/lifecycle assertions
  must still pass (byte-compat).

## 7. b-1 hardening preserved (acceptance criteria)

The migrated Alpaca path **MUST** retain every b-1 fix — they are already satisfied by the shared engine
(host `Drop` aborts both tasks; supervisor resets `attempt=0` on `ConnectedThenDropped`; masked
`AlpacaConfig` `Debug`; supervisor panic monitor → `on_event("error")`; per-instance redb path; jittered
`ReconnectPolicy`). The migration is a **regression risk** against these, so each is re-asserted in tests
(§8).

## 8. Testing

- **Rust unit:** `AlpacaDriver` frame parsing (q/t/b → correct `RawPricing::Alpaca` + correct `uni`
  Some/None per §5.3) against recorded Alpaca frames; auth-error frame → `AttemptOutcome::Fatal`;
  composite-key redb resume (legacy colon-less key → `quotes`; per-channel unsubscribe precision);
  `delete_subscriptions_table`. Reuse the existing redb per-instance isolation test.
- **Unified mapping:** Alpaca quote → `MarketEvent::Quote` (mid price, nested `alpaca` extras, `type:"quote"`)
  and Alpaca trade → `MarketEvent::Trade` (`TradeExtras::Alpaca`, nested `alpaca` extras, `type:"trade"`);
  bar → `uni = None`.
- **Finnhub regression:** existing Finnhub mapper/driver tests still green after the `CoreEvent` migration;
  add a Finnhub `uni = Some(Trade)` assertion.
- **TS:** `AlpacaStreaming.test.ts` — `"market"` event parses + emits; `subscribe` overload (both arms);
  `"pricing"` + lifecycle unchanged.
- **Gates:** `cargo build`/`cargo clippy --workspace`/`cargo test --workspace` green (run explicitly — the
  local fast gate excludes cargo); `pnpm verify:full` (ts-markets/ts-core/ts-cloud) green.
- Integration coverage stays the responsibility of subproject (c); 2a only preserves the per-provider FFI
  shape (c) expects.

## 9. Build / features

- No new Cargo feature flags (Alpaca is not feature-gated today; the `finnhub` feature is unaffected).
  Consider an `alpaca` feature only if symmetry with `finnhub` is later wanted — **not** in 2a.
- No new runtime deps (`serde_json` already present; no `napi::Either` needed — §4.5). `.node` gains the
  optional `on_market_event` ctor arg + `AlpacaSubscribeOpts`; regenerate `index.d.ts`/`index.js`.

## 10. Risks & prerequisites

| Item | Disposition |
|---|---|
| **Byte-compat regression** (raw payload, 3-callback ctor, `subscribe(symbols)`) | All additions additive; covered by retained TS/Rust tests (§8). |
| **CoreEvent migration touches merged Finnhub** | Intentional (Fork 3/§4.0); Finnhub tests re-run green; retrofit folds in. |
| **Channel-aware persistence/`sub_rx`** affects Finnhub | Existing bare-`Vec<String>` host API left intact (additive `*_channel` helpers); Finnhub keeps bare-symbol storage + default channel `"trades"`; `connect_once`'s `sub_rx` tag change is mechanical (Finnhub ignores the tag). |
| **Alpaca bars not portable in uni** (§5.3) | Bars are raw-only (no `MarketEvent::Bar`); quotes + trades are portable via the `TradeExtras::Alpaca` superset. Documented finstream divergence; serialize-only so no round-trip break. |
| **Timestamp parse** (Alpaca RFC3339 string → `DateTime<Utc>` for uni) | Parse for `uni`; `raw` keeps the original string verbatim (byte-compat). |
| **b-1 regressions** | Re-asserted as acceptance tests (§7/§8). |

## 11. Deferred (→ ROADMAP / later phases)

- **Phase 2b:** Yahoo migration (prost + base64 + 33-field `JsPricingData` raw; `Box<JsPricingData>` in
  `RawPricing`; `YahooTradeExtras`/`YahooQuoteExtras` uni).
- **Alpaca admin channels** (`statuses`, `lulds`, `corrections`, `cancelErrors`, `updatedBars`,
  `dailyBars`) — the rest of the full mirror (agy's S1-b); revive when a consumer needs them.
- **Bar (and other) variants in uni** (S2-b) — only if portable bars become a product need. (Alpaca
  **trades** are now portable via the `TradeExtras::Alpaca` superset, §5.3 — no longer deferred.)

## 12. agy review provenance

Three divergent passes + one spec-phase pass (records in `ANTIGRAVITY-TO-CLAUDE.md`): the Phase 2 migration
pass (Forks A–E: schema/ping/sequencing/cleanup/landmines), the dual-mode pass (Forks 1–4: channel payload,
FFI surface, Finnhub retrofit, task structure), the Alpaca subscription-scope pass (S1/S2), and the
spec-phase pass on this document. Claude refined Fork 1 (single-definition raw structs vs agy's duplicated
mirrors) and corrected agy on the live CLI bins (real, not deletable no-ops — they are rewritten onto the
host). User chose S1-a (vs agy's S1-b); on S2, the user **adopted agy's spec-pass nit** — add
`TradeExtras::Alpaca` so Alpaca trades are uni-portable (corelib uni = documented superset of finstream;
§5.3) — so only bars remain raw-only.

**Spec-phase pass (ITERATE → folded):** two 🔴 verified and fixed above — (1) the `CoreEvent` migration was
incomplete (the `host.rs` panic monitor + `connect_once` `tx` still typed `MarketEvent`) → §4.1 now lists
every send site; (2) widening the shared `get_persisted_subscriptions` return type would break merged
Finnhub → §4.4 keeps the bare-`Vec<String>` API intact and **adds** channel-aware helpers, single-channel
providers keep bare-symbol storage. One 🟡 folded: drop `napi::Either`, resolve the `string[] | opts`
overload in the TS wrapper (§4.5/§6). One 🟡 (optional 4th `on_market_event` ctor arg) was already in the
design (§4.3). agy's 🟢 nit to add `TradeExtras::Alpaca` so Alpaca trades are uni-portable was surfaced to
the user at the spec-review gate and **adopted** (§5.3) — corelib uni becomes a documented superset of
finstream. agy's "self-healing redb migration" creative idea is deferred (the read-time default already
gives back-compat; YAGNI).
