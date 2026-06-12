# Provider Port — Phase 1 (Finnhub pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared trait-backed streaming engine to corelib's Rust core and ship **Finnhub** as the pilot provider behind a new `FinnhubStreaming` N-API/TS facade that matches the existing per-provider shape — with zero change to Alpaca/Yahoo or their consumers.

**Architecture:** A new internal `core/` module holds a `ProviderDriver` (single `connect_once` attempt) trait, a unified `MarketEvent` schema, a `ReconnectPolicy`, a `supervisor` that owns the reconnect loop (resets backoff on `Status::Connected`), and a generic `WebsocketStreamerHost<D>` that owns all FFI coordination (redb, supervisor task, mpsc→TSFN pump, dynamic-sub channel, `Drop`). `FinnhubDriver` implements the trait; `FinnhubStreaming` is a thin `#[napi]` delegate to `WebsocketStreamerHost<FinnhubDriver>` that flattens `MarketEvent` → `FinnhubPricingData`.

**Tech Stack:** Rust (napi-rs v3, tokio, tokio-tungstenite, redb, serde, chrono), TypeScript (ts-markets wrapper), Vitest, cargo.

**Spec:** `docs/superpowers/specs/2026-06-12-provider-port-phase1-design.md`. **Hardening checklist:** spec §3.

---

## File Structure

Base dir: `rust/src/markets/nasdaq/datafeeds/streaming/`

- Create `core/mod.rs` — declares the core submodules.
- Create `core/schema.rs` — `MarketEvent`, `Trade`, `ProviderStatus`, `ProviderKind`, `TradeExtras`, `FinnhubTradeExtras`.
- Create `core/reconnect.rs` — `ReconnectPolicy` + `next_delay` (std-nanos jitter).
- Create `core/driver.rs` — `ProviderDriver` trait + `AttemptOutcome`.
- Create `core/supervisor.rs` — `run_supervisor(...)` reconnect loop + panic monitor.
- Create `core/host.rs` — `WebsocketStreamerHost<D>` (redb, tasks, pump, Drop).
- Create `finnhub/mod.rs` — declares finnhub submodules.
- Create `finnhub/finnhub_driver.rs` — `FinnhubDriver` (`connect_once`) + message parse.
- Create `finnhub/finnhub_streamer.rs` — `FinnhubStreaming` `#[napi]` facade, `FinnhubConfig`, `FinnhubPricingData`, `FinnhubCallbacks`, the `MarketEvent`→flat mapper.
- Modify `rust/src/lib.rs` — wire the new `core` + `finnhub` modules into the `streaming` module tree.
- Modify `rust/Cargo.toml` — add `[features]` block.
- Create `ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts` — TS wrapper.
- Modify ts-markets streaming index + `ts-markets/src/index.ts` — export `FinnhubStreaming`.

**Reused (do not redefine):** `crate::{EventRecord, LogRecord}` (currently defined in `yahoo_streamer.rs`, re-exported at crate root; `LogRecord{level,msg,extras:Option<String>}`, `EventRecord{r#type,data:Option<String>}`).

**Convention reference (mirror, do not modify):** `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs` — the b-1-hardened streamer (Drop, per-instance redb, masked Debug, panic monitor, backoff reset). `ts-markets/.../alpaca/AlpacaStreaming.ts` — the TS wrapper shape.

---

## Task 1: Cargo features + module scaffolding

**Files:**
- Modify: `rust/Cargo.toml`
- Modify: `rust/src/lib.rs`
- Create: `rust/src/markets/nasdaq/datafeeds/streaming/core/mod.rs`

- [ ] **Step 1: Add the `[features]` block to `rust/Cargo.toml`** (after the `[dependencies]` section)

```toml
[features]
default = ["finnhub"]
finnhub = []
```

- [ ] **Step 2: Declare the new modules in `lib.rs`**

In `rust/src/lib.rs`, inside `pub mod markets { pub mod nasdaq { pub mod datafeeds { pub mod streaming {`, add alongside the existing `alpaca`/`yahoo` declarations:

```rust
/// Shared trait-backed streaming engine (driver trait, schema, reconnect, supervisor, host).
pub mod core;
/// Finnhub streaming provider (pilot for the shared engine).
#[cfg(feature = "finnhub")]
pub mod finnhub {
    /// FinnhubDriver implementing the shared ProviderDriver contract.
    pub mod finnhub_driver;
    /// FinnhubStreaming N-API facade + flat payload + mapper.
    pub mod finnhub_streamer;
}
```

- [ ] **Step 3: Create `core/mod.rs`**

```rust
//! Shared trait-backed streaming engine used by all providers.
pub mod driver;
pub mod host;
pub mod reconnect;
pub mod schema;
pub mod supervisor;
```

- [ ] **Step 4: Verify it compiles** (modules are empty stubs — create empty files for `schema.rs`, `reconnect.rs`, `driver.rs`, `supervisor.rs`, `host.rs`, `finnhub/finnhub_driver.rs`, `finnhub/finnhub_streamer.rs` with `//! stub` so the tree resolves)

Run: `cd rust && cargo build`
Expected: builds (empty modules are valid).

- [ ] **Step 5: Commit**

```bash
git add rust/Cargo.toml rust/src/lib.rs rust/src/markets/nasdaq/datafeeds/streaming/core rust/src/markets/nasdaq/datafeeds/streaming/finnhub
git commit -m "chore(rust): scaffold shared streaming core + finnhub modules + features"
```

---

## Task 2: Unified schema (`core/schema.rs`)

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/schema.rs`

- [ ] **Step 1: Write the schema** (internal types — not `#[napi]`; the facade maps these to the flat FFI payload)

```rust
//! Unified, source-tagged market event schema (internal; mapped to flat FFI payloads by facades).
use chrono::{DateTime, Utc};

/// The kind of provider a driver handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind { Alpaca, Finnhub, Yahoo }

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self { ProviderKind::Alpaca => "alpaca", ProviderKind::Finnhub => "finnhub", ProviderKind::Yahoo => "yahoo" };
        f.write_str(s)
    }
}

/// Finnhub-specific trade metadata.
#[derive(Debug, Clone)]
pub struct FinnhubTradeExtras { pub volume: f64, pub conditions: Vec<String> }

/// Provider-specific trade metadata (extended per provider in later phases).
#[derive(Debug, Clone)]
pub enum TradeExtras { Finnhub(FinnhubTradeExtras) }

/// A normalized trade.
#[derive(Debug, Clone)]
pub struct Trade {
    pub ticker: String,
    pub timestamp: DateTime<Utc>,
    pub price: f64,
    pub extras: TradeExtras,
    pub raw: Option<String>,
}

/// Connectivity/health state of a driver.
#[derive(Debug, Clone)]
pub enum ProviderStatus {
    Connected { provider: ProviderKind },
    Disconnected { provider: ProviderKind, reason: String },
    Reconnecting { provider: ProviderKind, attempt: u32, delay_ms: u64 },
    Error { provider: ProviderKind, message: String },
}

/// A normalized, source-tagged event emitted by a driver.
#[derive(Debug, Clone)]
pub enum MarketEvent {
    Trade { source: String, data: Trade },
    Status { source: String, status: ProviderStatus },
}
```

- [ ] **Step 2: Verify** — `cd rust && cargo build`. Expected: builds.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(rust): unified MarketEvent schema for the streaming engine"`

---

## Task 3: ReconnectPolicy (`core/reconnect.rs`) — TDD

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/reconnect.rs`

- [ ] **Step 1: Write the failing tests**

```rust
//! Exponential-backoff reconnection policy with std-derived jitter.
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ReconnectPolicy {
    pub max_retries: Option<u32>,
    pub max_duration: Option<Duration>,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub jitter: bool,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            max_retries: None,
            max_duration: Some(Duration::from_secs(3600)),
            initial_delay: Duration::from_secs(5),
            max_delay: Duration::from_secs(3600),
            jitter: false,
        }
    }
}

impl ReconnectPolicy {
    /// Delay for a 0-based attempt: initial * 2^attempt, capped at max_delay,
    /// optionally jittered to 0.5..=1.0x, floored at 100ms.
    pub fn next_delay(&self, attempt: u32) -> Duration {
        let base = self.initial_delay.as_secs_f64() * 2_f64.powi(attempt as i32);
        let capped = base.min(self.max_delay.as_secs_f64());
        let final_secs = if self.jitter {
            // std-derived pseudo-jitter (no `rand` dependency): factor in 0.5..=1.0
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as f64;
            let factor = 0.5 + (nanos / 1_000_000_000.0) * 0.5; // 0.5..1.0
            capped * factor
        } else {
            capped
        };
        Duration::from_secs_f64(final_secs.max(0.1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grows_exponentially_and_caps() {
        let p = ReconnectPolicy { initial_delay: Duration::from_secs(5), max_delay: Duration::from_secs(60), jitter: false, ..Default::default() };
        assert_eq!(p.next_delay(0), Duration::from_secs(5));
        assert_eq!(p.next_delay(1), Duration::from_secs(10));
        assert_eq!(p.next_delay(2), Duration::from_secs(20));
        assert_eq!(p.next_delay(10), Duration::from_secs(60)); // capped
    }
    #[test]
    fn jitter_stays_in_half_to_full_range() {
        let p = ReconnectPolicy { initial_delay: Duration::from_secs(10), max_delay: Duration::from_secs(60), jitter: true, ..Default::default() };
        let d = p.next_delay(0).as_secs_f64();
        assert!(d >= 5.0 && d <= 10.0, "jittered delay {d} out of 0.5..1.0x range");
    }
    #[test]
    fn floors_at_100ms() {
        let p = ReconnectPolicy { initial_delay: Duration::from_millis(1), max_delay: Duration::from_secs(60), jitter: false, ..Default::default() };
        assert!(p.next_delay(0) >= Duration::from_millis(100));
    }
}
```

- [ ] **Step 2: Run tests, verify they pass** — `cd rust && cargo test reconnect`. Expected: 3 passed.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(rust): ReconnectPolicy with std-nanos jitter + tests"`

---

## Task 4: ProviderDriver trait + AttemptOutcome (`core/driver.rs`)

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/driver.rs`

- [ ] **Step 1: Write the trait**

```rust
//! The single-attempt provider driver contract. The supervisor owns the reconnect loop.
use tokio::sync::mpsc;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::MarketEvent;

/// Outcome of one connection attempt, used by the supervisor to decide the next action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptOutcome {
    /// Connected (authenticated/received data) then the socket dropped → reset backoff, retry.
    ConnectedThenDropped,
    /// Never connected/authenticated this attempt → grow backoff, retry.
    NeverConnected,
    /// Fatal error (e.g. auth rejected) → stop the supervisor.
    Fatal(String),
    /// Graceful stop requested via stop_rx → stop the supervisor.
    Stopped,
}

/// A self-contained driver for ONE financial data provider connection attempt.
#[allow(async_fn_in_trait)]
pub trait ProviderDriver: Send + Sync + 'static {
    /// Validate config (keys present, etc.) before the first attempt.
    fn validate(&self) -> Result<(), String> { Ok(()) }

    /// Perform ONE connection attempt: connect, (auth), subscribe `symbols`, apply live
    /// `sub_rx` updates, push `MarketEvent`s to `tx` (including `Status::Connected` on success),
    /// and return when the socket drops, a fatal error occurs, or `stop_rx` fires.
    async fn connect_once(
        &self,
        symbols: &[String],
        tx: &mpsc::Sender<MarketEvent>,
        sub_rx: &mut mpsc::Receiver<Vec<String>>,
        stop_rx: &mut mpsc::Receiver<()>,
    ) -> AttemptOutcome;
}
```

- [ ] **Step 2: Verify** — `cd rust && cargo build`. Expected: builds.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(rust): ProviderDriver connect_once trait + AttemptOutcome"`

---

## Task 5: Flat FFI payload + mapper (`finnhub/finnhub_streamer.rs`, part 1) — TDD

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs`

- [ ] **Step 1: Write the payload + mapper + tests**

```rust
//! FinnhubStreaming N-API facade, flat payload, and MarketEvent→flat mapper.
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, Trade, TradeExtras};

/// Flat per-provider pricing payload sent to JS `on_pricing` (mirrors AlpacaPricingData shape;
/// Finnhub timestamps are numeric epoch ms, so `timestamp` is f64).
#[napi(object)]
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct FinnhubPricingData {
    pub symbol: String,
    pub message_type: String,
    pub price: f64,
    pub volume: f64,
    pub timestamp: f64,
    pub conditions: Option<Vec<String>>,
}

/// Map a MarketEvent::Trade to the flat FinnhubPricingData. Returns None for non-pricing events.
pub fn market_event_to_finnhub_pricing(ev: &MarketEvent) -> Option<FinnhubPricingData> {
    match ev {
        MarketEvent::Trade { data: Trade { ticker, timestamp, price, extras, .. }, .. } => {
            let (volume, conditions) = match extras {
                TradeExtras::Finnhub(x) => (x.volume, x.conditions.clone()),
            };
            Some(FinnhubPricingData {
                symbol: ticker.clone(),
                message_type: "trade".to_string(),
                price: *price,
                volume,
                timestamp: timestamp.timestamp_millis() as f64,
                conditions: if conditions.is_empty() { None } else { Some(conditions) },
            })
        }
        MarketEvent::Status { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::{FinnhubTradeExtras, ProviderKind, ProviderStatus};
    use chrono::TimeZone;

    #[test]
    fn maps_trade_to_flat_payload() {
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
        let p = market_event_to_finnhub_pricing(&ev).unwrap();
        assert_eq!(p, FinnhubPricingData {
            symbol: "AAPL".into(), message_type: "trade".into(), price: 191.5, volume: 100.0,
            timestamp: 1_700_000_000_000.0, conditions: Some(vec!["@".into()]),
        });
    }
    #[test]
    fn status_events_are_not_pricing() {
        let ev = MarketEvent::Status { source: "finnhub_main".into(), status: ProviderStatus::Connected { provider: ProviderKind::Finnhub } };
        assert!(market_event_to_finnhub_pricing(&ev).is_none());
    }
}
```

- [ ] **Step 2: Run tests** — `cd rust && cargo test --features finnhub finnhub_streamer`. Expected: 2 passed.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(rust): FinnhubPricingData + MarketEvent mapper + tests"`

---

## Task 6: FinnhubDriver parse + connect_once (`finnhub/finnhub_driver.rs`) — TDD on parse

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs`

- [ ] **Step 1: Write the parse helper + tests** (parse is the unit-testable core; `connect_once` wires it to the socket)

```rust
//! FinnhubDriver: one WebSocket connection attempt + trade parsing.
use chrono::{TimeZone, Utc};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
    FinnhubTradeExtras, MarketEvent, Trade, TradeExtras,
};

/// Parse one Finnhub WS text frame into zero or more Trade events.
/// Finnhub trade frame: {"type":"trade","data":[{"s":sym,"p":price,"v":vol,"t":ms,"c":[..]}]}
pub fn parse_finnhub_frame(text: &str, source: &str) -> Vec<MarketEvent> {
    let obj: serde_json::Value = match serde_json::from_str(text) { Ok(v) => v, Err(_) => return vec![] };
    if obj["type"].as_str() != Some("trade") { return vec![]; }
    let data = match obj["data"].as_array() { Some(a) => a, None => return vec![] };
    let mut out = Vec::new();
    for item in data {
        let ticker = match item["s"].as_str() { Some(s) => s.to_string(), None => continue };
        let price = match item["p"].as_f64() { Some(p) => p, None => continue };
        let volume = item["v"].as_f64().unwrap_or(0.0);
        let time_ms = item["t"].as_i64().unwrap_or(0);
        let timestamp = Utc.timestamp_millis_opt(time_ms).single().unwrap_or_else(Utc::now);
        let conditions = item["c"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        out.push(MarketEvent::Trade {
            source: source.to_string(),
            data: Trade { ticker, timestamp, price, extras: TradeExtras::Finnhub(FinnhubTradeExtras { volume, conditions }), raw: Some(item.to_string()) },
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::TradeExtras;
    #[test]
    fn parses_trade_batch() {
        let frame = r#"{"type":"trade","data":[{"s":"AAPL","p":191.5,"v":100,"t":1700000000000,"c":["@"]},{"s":"MSFT","p":420.0,"v":50,"t":1700000000001,"c":[]}]}"#;
        let evs = parse_finnhub_frame(frame, "finnhub_main");
        assert_eq!(evs.len(), 2);
        match &evs[0] { MarketEvent::Trade { data, .. } => { assert_eq!(data.ticker, "AAPL"); assert_eq!(data.price, 191.5); match &data.extras { TradeExtras::Finnhub(x) => { assert_eq!(x.volume, 100.0); assert_eq!(x.conditions, vec!["@".to_string()]); } } }, _ => panic!() }
    }
    #[test]
    fn ignores_ping_and_unknown() {
        assert!(parse_finnhub_frame(r#"{"type":"ping"}"#, "s").is_empty());
        assert!(parse_finnhub_frame("not json", "s").is_empty());
    }
}
```

- [ ] **Step 2: Run tests** — `cd rust && cargo test --features finnhub parse_finnhub`. Expected: 2 passed.

- [ ] **Step 3: Add `FinnhubDriver` + `connect_once`** (below the parse fn; mirrors finstream's session, adapted to single-attempt + the spec's contract)

```rust
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{AttemptOutcome, ProviderDriver};
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, ProviderKind, ProviderStatus};

const FINNHUB_WS: &str = "wss://ws.finnhub.io";

pub struct FinnhubDriver { pub token: String, pub name: String }

impl ProviderDriver for FinnhubDriver {
    fn validate(&self) -> Result<(), String> {
        if self.token.is_empty() { Err("FINNHUB_API_KEY / token is required".into()) } else { Ok(()) }
    }

    async fn connect_once(
        &self,
        symbols: &[String],
        tx: &mpsc::Sender<MarketEvent>,
        sub_rx: &mut mpsc::Receiver<Vec<String>>,
        stop_rx: &mut mpsc::Receiver<()>,
    ) -> AttemptOutcome {
        let url = format!("{FINNHUB_WS}?token={}", self.token);
        let (mut ws, _) = match connect_async(&url).await {
            Ok(v) => v,
            Err(_) => return AttemptOutcome::NeverConnected,
        };
        // signal the supervisor to reset backoff
        let _ = tx.send(MarketEvent::Status { source: self.name.clone(), status: ProviderStatus::Connected { provider: ProviderKind::Finnhub } }).await;
        let mut current: Vec<String> = symbols.to_vec();
        for s in &current {
            let m = serde_json::json!({ "type": "subscribe", "symbol": s }).to_string();
            if ws.send(Message::Text(m.into())).await.is_err() { return AttemptOutcome::ConnectedThenDropped; }
        }
        loop {
            tokio::select! {
                _ = stop_rx.recv() => return AttemptOutcome::Stopped,
                upd = sub_rx.recv() => {
                    if let Some(syms) = upd {
                        for s in &syms { if !current.contains(s) {
                            let m = serde_json::json!({ "type": "subscribe", "symbol": s }).to_string();
                            let _ = ws.send(Message::Text(m.into())).await; current.push(s.clone());
                        }}
                    }
                }
                msg = ws.next() => match msg {
                    Some(Ok(Message::Text(t))) => { for ev in parse_finnhub_frame(&t, &self.name) { let _ = tx.send(ev).await; } }
                    Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => return AttemptOutcome::ConnectedThenDropped,
                }
            }
        }
    }
}
```

- [ ] **Step 4: Verify build** — `cd rust && cargo build --features finnhub`. Expected: builds. (Add `futures-util` to `[dependencies]` if not present — check `rust/Cargo.toml`; `alpaca_streamer.rs` uses `futures_util` so it is present.)
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(rust): FinnhubDriver connect_once + frame parser + tests"`

---

## Task 7: Supervisor reconnect loop (`core/supervisor.rs`)

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/supervisor.rs`

- [ ] **Step 1: Write the supervisor** (owns the loop; resets `attempt` on `ConnectedThenDropped`, grows on `NeverConnected`, stops on `Fatal`/`Stopped`)

```rust
//! Owns the reconnect loop for a ProviderDriver. Single place for backoff/state.
use tokio::sync::mpsc;
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{AttemptOutcome, ProviderDriver};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::MarketEvent;

/// Drive `driver` across reconnects until Fatal/Stopped. Sends events to `tx`.
pub async fn run_supervisor<D: ProviderDriver>(
    driver: D,
    symbols: Vec<String>,
    tx: mpsc::Sender<MarketEvent>,
    mut sub_rx: mpsc::Receiver<Vec<String>>,
    mut stop_rx: mpsc::Receiver<()>,
    policy: ReconnectPolicy,
) {
    if driver.validate().is_err() { return; }
    let mut attempt: u32 = 0;
    loop {
        let outcome = driver.connect_once(&symbols, &tx, &mut sub_rx, &mut stop_rx).await;
        match outcome {
            AttemptOutcome::Stopped | AttemptOutcome::Fatal(_) => break,
            AttemptOutcome::ConnectedThenDropped => { attempt = 0; }      // healthy drop → reset
            AttemptOutcome::NeverConnected => { attempt = attempt.saturating_add(1); }
        }
        if let Some(max) = policy.max_retries { if attempt > max { break; } }
        let delay = policy.next_delay(attempt);
        tokio::select! {
            _ = stop_rx.recv() => break,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}
```

- [ ] **Step 2: Verify** — `cd rust && cargo build`. Expected: builds.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(rust): supervisor reconnect loop with backoff reset on healthy drop"`

---

## Task 8: WebsocketStreamerHost<D> (`core/host.rs`)

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/host.rs`

Responsibilities (spec §4.1 `host.rs`): own per-instance redb (subscription persistence), spawn the supervisor task + the mpsc→TSFN pump task, route `subscribe` to redb + live `sub_rx`, and abort **both** tasks on `Drop`. Generic over `D: ProviderDriver` and over a pump closure that turns `MarketEvent` into the provider's typed TSFN calls.

- [ ] **Step 1: Write the host**

```rust
//! Generic FFI coordination host shared by all provider facades.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use redb::{Database, TableDefinition};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use crate::markets::nasdaq::datafeeds::streaming::core::driver::ProviderDriver;
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::MarketEvent;
use crate::markets::nasdaq::datafeeds::streaming::core::supervisor::run_supervisor;

static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build a unique per-instance redb path under temp_dir (b-1: no shared-file lock).
pub fn unique_db_path(prefix: &str, env_override: &str) -> std::path::PathBuf {
    if let Ok(p) = std::env::var(env_override) { return std::path::PathBuf::from(p); }
    let pid = std::process::id();
    let seq = INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    std::env::temp_dir().join(format!("{prefix}_{pid}_{seq}_{nanos}.redb"))
}

/// Shared coordination state. `Pump` consumes MarketEvents and calls the provider's typed TSFNs.
/// Like the b-1 Alpaca fix, we store the *monitor* task (which owns/awaits the supervisor) and the
/// pump task; the supervisor itself exits via `stop_tx`.
pub struct WebsocketStreamerHost {
    pub(crate) db: Database,
    pub(crate) table: &'static str,
    pub(crate) source: String,
    pub(crate) sub_tx: Option<mpsc::Sender<Vec<String>>>,
    pub(crate) stop_tx: Option<mpsc::Sender<()>>,
    pub(crate) monitor_task: Option<JoinHandle<()>>,
    pub(crate) pump_task: Option<JoinHandle<()>>,
}

impl WebsocketStreamerHost {
    /// Open/create the per-instance redb file. `source` names the instance (used in panic events).
    pub fn new(db_path: std::path::PathBuf, table: &'static str, source: String) -> Self {
        let db = Database::create(&db_path).expect("Failed to open redb");
        Self { db, table, source, sub_tx: None, stop_tx: None, monitor_task: None, pump_task: None }
    }

    /// Start the supervisor (driving `driver`), a panic monitor, and a pump that forwards events.
    pub fn start<D, P>(&mut self, driver: D, symbols: Vec<String>, policy: ReconnectPolicy, mut on_event_pump: P)
    where D: ProviderDriver, P: FnMut(MarketEvent) + Send + 'static {
        let (tx, mut rx) = mpsc::channel::<MarketEvent>(1024);
        let (sub_tx, sub_rx) = mpsc::channel::<Vec<String>>(64);
        let (stop_tx, stop_rx) = mpsc::channel::<()>(1);
        self.sub_tx = Some(sub_tx);
        self.stop_tx = Some(stop_tx);
        // b-1 §3.4: monitor awaits the supervisor; on panic emit a synthetic Error event via a tx clone.
        let monitor_tx = tx.clone();
        let source = self.source.clone();
        let sup = tokio::spawn(run_supervisor(driver, symbols, tx, sub_rx, stop_rx, policy));
        self.monitor_task = Some(tokio::spawn(async move {
            if let Err(e) = sup.await {
                if e.is_panic() {
                    use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
                    let _ = monitor_tx.send(MarketEvent::Status {
                        source,
                        status: ProviderStatus::Error { provider: ProviderKind::Finnhub, message: "supervisor task panicked; stream is dead".into() },
                    }).await;
                }
            }
        }));
        self.pump_task = Some(tokio::spawn(async move { while let Some(ev) = rx.recv().await { on_event_pump(ev); } }));
    }

    /// Persist + push a subscription set to the live driver.
    pub async fn subscribe(&self, symbols: Vec<String>) {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        if let Ok(wtx) = self.db.begin_write() {
            if let Ok(mut t) = wtx.open_table(table) { for s in &symbols { let _ = t.insert(s.as_str(), &true); } }
            let _ = wtx.commit();
        }
        if let Some(tx) = &self.sub_tx { let _ = tx.send(symbols).await; }
    }
}

impl Drop for WebsocketStreamerHost {
    fn drop(&mut self) {
        // Supervisor exits gracefully via stop_tx (mirrors b-1 Alpaca). Abort monitor + pump.
        if let Some(tx) = self.stop_tx.take() { let _ = tx.try_send(()); }
        if let Some(t) = self.monitor_task.take() { t.abort(); }
        if let Some(t) = self.pump_task.take() { t.abort(); } // b-1: abort BOTH facade tasks
    }
}
```

- [ ] **Step 2: Verify** — `cd rust && cargo build --features finnhub`. Expected: builds (fix import/redb API mismatches against `alpaca_streamer.rs`'s redb usage if the redb version's table API differs).
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(rust): WebsocketStreamerHost<D> (redb + supervisor + pump + Drop both tasks)"`

---

## Task 9: FinnhubStreaming N-API facade (`finnhub/finnhub_streamer.rs`, part 2)

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs`

- [ ] **Step 1: Add config (masked Debug), callbacks, and the `#[napi]` facade** (append below the mapper from Task 5)

```rust
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use crate::{EventRecord, LogRecord};
use crate::markets::nasdaq::datafeeds::streaming::core::host::{unique_db_path, WebsocketStreamerHost};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::finnhub::finnhub_driver::FinnhubDriver;

#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FinnhubConfig { pub token: Option<String>, pub name: Option<String> }

impl std::fmt::Debug for FinnhubConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FinnhubConfig")
            .field("name", &self.name)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[napi]
pub struct FinnhubStreaming {
    host: WebsocketStreamerHost,
    token: String,
    name: String,
    on_pricing: ThreadsafeFunction<FinnhubPricingData>,
    on_event: ThreadsafeFunction<EventRecord>,
    on_log: ThreadsafeFunction<LogRecord>,
}

#[napi]
impl FinnhubStreaming {
    #[napi(constructor)]
    pub fn new(config: FinnhubConfig, on_pricing: ThreadsafeFunction<FinnhubPricingData>, on_event: ThreadsafeFunction<EventRecord>, on_log: ThreadsafeFunction<LogRecord>) -> Self {
        let token = config.token.or_else(|| std::env::var("FINNHUB_API_KEY").ok()).unwrap_or_default();
        let name = config.name.unwrap_or_else(|| "finnhub".to_string());
        let host = WebsocketStreamerHost::new(unique_db_path("finnhub_streaming", "FINNHUB_DB"), "finnhub_subscriptions", name.clone());
        Self { host, token, name, on_pricing, on_event, on_log }
    }

    #[napi]
    pub fn start(&mut self, symbols: Vec<String>) {
        let driver = FinnhubDriver { token: self.token.clone(), name: self.name.clone() };
        let on_pricing = self.on_pricing.clone();
        let on_event = self.on_event.clone();
        self.host.start(driver, symbols, ReconnectPolicy { jitter: true, ..Default::default() }, move |ev: MarketEvent| {
            if let Some(p) = market_event_to_finnhub_pricing(&ev) {
                let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
            } else if let MarketEvent::Status { status, .. } = ev {
                let (t, d) = match status {
                    ProviderStatus::Connected { .. } => ("connected".to_string(), None),
                    ProviderStatus::Disconnected { reason, .. } => ("disconnected".to_string(), Some(reason)),
                    ProviderStatus::Reconnecting { attempt, delay_ms, .. } => ("reconnecting".to_string(), Some(format!("attempt {attempt}, {delay_ms}ms"))),
                    ProviderStatus::Error { message, .. } => ("error".to_string(), Some(message)),
                };
                let _ = on_event.call(Ok(EventRecord { r#type: t, data: d }), ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
    }

    #[napi]
    pub async fn subscribe(&self, symbols: Vec<String>) { self.host.subscribe(symbols).await; }

    #[napi]
    pub fn stop(&mut self) { if let Some(tx) = self.host.stop_tx.take() { let _ = tx.try_send(()); } }
}
```

- [ ] **Step 2: Verify build** — `cd rust && cargo build --features finnhub`. Expected: builds. (Reconcile `ThreadsafeFunction` generic arity + `.call` signature against `alpaca_streamer.rs`'s `NapiCallbacks` usage — match that exact API.)
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(rust): FinnhubStreaming napi facade (masked config, host delegation)"`

---

## Task 10: Build + clippy + test gate (Rust)

- [ ] **Step 1: Full rust verification**

Run:
```bash
cd rust && cargo build --features finnhub && cargo clippy --workspace --features finnhub && cargo test --workspace --features finnhub
```
Expected: build ok; clippy "no issues"; all tests pass (existing 51 + the new reconnect/mapper/parse tests).

- [ ] **Step 2: Confirm the FFI class is exported** — `cd rust && cargo build` then check the generated `index.d.ts` (napi) or grep the build output for `FinnhubStreaming`. Expected: `FinnhubStreaming` present.
- [ ] **Step 3: Commit any fixes** — `git add -A && git commit -m "test(rust): green build/clippy/test for finnhub pilot"`

---

## Task 11: TypeScript wrapper + exports

**Files:**
- Create: `ts-markets/src/nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming.ts`
- Modify: ts-markets streaming index (the file that re-exports `AlpacaStreaming`/`YahooStreaming`)
- Modify: `ts-markets/src/index.ts`

- [ ] **Step 1: Read the Alpaca wrapper** to mirror it exactly

Run: `Read ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts`

- [ ] **Step 2: Write `FinnhubStreaming.ts`** mirroring the Alpaca wrapper: import the FFI class via `coreFFI.FinnhubStreaming`, wrap `new/start/stop/subscribe`, register `on_pricing`/`on_event`/`on_log`, and use a child logger.

```typescript
import { coreFFI, logger } from "@ckir/corelib";

const moduleLogger = logger.child({ section: "FinnhubStreaming" });

export interface FinnhubPricingData {
  symbol: string;
  message_type: string;
  price: number;
  volume: number;
  timestamp: number;
  conditions?: string[];
}

export interface FinnhubConfig { token?: string; name?: string; }

/** TS wrapper over the native Finnhub streamer (coreFFI.FinnhubStreaming). */
export class FinnhubStreaming {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #native: any;

  constructor(
    config: FinnhubConfig,
    onPricing: (d: FinnhubPricingData) => void,
    onEvent: (e: { type: string; data?: string }) => void,
    onLog: (l: { level: string; msg: string; extras?: string }) => void,
  ) {
    const Native = (coreFFI as { FinnhubStreaming?: unknown } | null)?.FinnhubStreaming as
      | (new (...a: unknown[]) => unknown)
      | undefined;
    if (!Native) throw new Error("FinnhubStreaming FFI not available in this runtime");
    moduleLogger.debug("constructing native FinnhubStreaming", { name: config.name });
    this.#native = new Native(config, onPricing, onEvent, onLog);
  }

  start(symbols: string[]): void { moduleLogger.debug("start", { count: symbols.length }); this.#native.start(symbols); }
  async subscribe(symbols: string[]): Promise<void> { moduleLogger.trace("subscribe", { count: symbols.length }); await this.#native.subscribe(symbols); }
  stop(): void { moduleLogger.debug("stop"); this.#native.stop(); }
}
```

- [ ] **Step 3: Export it** — add `export * from "./nasdaq/datafeeds/streaming/finnhub/FinnhubStreaming";` to the streaming index and surface `FinnhubStreaming` from `ts-markets/src/index.ts` (match how `AlpacaStreaming` is exported — grep for it: `rg "AlpacaStreaming" ts-markets/src/index.ts`).

- [ ] **Step 4: Typecheck** — `pnpm --filter @ckir/corelib-markets typecheck`. Expected: Done (no errors).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ts-markets): FinnhubStreaming wrapper + exports"`

---

## Task 12: Final gate + docs

- [ ] **Step 1: Run the repo fast gate** — `pnpm verify:fast`. Expected: green (format/lint/typecheck across packages; rust clippy clean).
- [ ] **Step 2: Update README** — add `FinnhubStreaming` usage to `ts-markets/README.md` (AGENTS.md §6 mandate) mirroring the Alpaca example.
- [ ] **Step 3: Mark Phase 1 in ROADMAP** — note (d) Phase 1 complete under subproject (d).
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs(finnhub): README usage + roadmap update for (d) Phase 1"`

---

## Self-Review notes (resolved)

- **Spec coverage:** core trait (T4) · schema (T2) · ReconnectPolicy+jitter (T3) · supervisor reset-on-connect (T7) · host/redb/pump/Drop-both (T8) · FinnhubDriver+parse (T6) · facade+mapper+masked config (T5,T9) · Cargo features (T1) · TS wrapper+exports (T11) · b-1 checklist (Drop both T8, backoff reset T7, per-instance redb T8, masked Debug T9, panic monitor — see note). 
- **b-1 panic monitor:** ✅ implemented in T8 `start()` — a monitor task awaits the supervisor and on `JoinError::is_panic()` emits a synthetic `Status::Error` via a `tx` clone (the pump turns it into `on_event("error")`); `Drop` aborts the monitor + pump (mirrors `alpaca_streamer.rs:263-280`).
- **Symbology (spec §9):** verify Finnhub accepts corelib's Nasdaq tickers (plain `AAPL`) during T6 live testing; crypto/forex prefixes are out of scope.
- **redb API drift:** T8 uses `begin_write/open_table/insert/commit` — reconcile exact calls against `alpaca_streamer.rs`'s redb usage (same redb 4.1 version) during T8.
