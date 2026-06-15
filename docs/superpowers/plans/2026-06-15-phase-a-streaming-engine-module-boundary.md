# Phase A — Streaming Engine Module Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a napi-free engine/adapter module boundary inside the single `corelib-rust` crate and add pure-Rust loopback delivery tests for all three streaming providers, so the streaming engine is provably free of direct napi coupling and testable without Node.

**Architecture:** The streaming engine logic (3 provider drivers + `core/*`) is already napi-free; the only napi in the engine path is `#[napi(object)]`/`#[napi]` on five "wire" types. We convert those to `#[cfg_attr(feature = "napi", …)]` (single definition, serde unconditional, default feature on → zero behaviour change), add a `compile_error!` footgun guard, add a source-scanning boundary lint test that keeps the engine napi-free, and add three pure-Rust `tokio`-loopback tests that drive each provider driver against a local WS server and assert `CoreEvent` delivery. This is **Phase A** of the Streaming Engine Epic; the crate extraction and the Node↔Rust interop closure are deferred to Phase B.

**Tech Stack:** Rust, `napi`/`napi-derive` 3.x, `tokio` + `tokio-tungstenite` 0.29, `redb` 4, `prost` 0.14, `serde`. Project Rust gate: `cd rust && cargo test -- --test-threads=1` (single-threaded is **mandatory** — a global flight-recorder ring buffer). Lint gate: `cargo clippy --all-targets -- -D warnings`.

---

## Source of Truth

- Spec: `docs/superpowers/specs/2026-06-15-phase-a-streaming-engine-module-boundary-design.md`
- The wire payload structs and their byte-identity oracle test live in `rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs` (test `core_event_constructs_and_raw_payload_serializes_identically`).
- The napi binding contract is the tracked file `rust/index.d.ts` — it MUST NOT change shape for `AlpacaPricingData` / `FinnhubPricingData` / `JsPricingData`.

## Plan-level refinement vs. spec §8

The spec described moving the wire structs into a dedicated module (steps 2–3). Ground-truth inspection shows that is **unnecessary churn**: `AlpacaPricingData`/`FinnhubPricingData` are re-exported through the streamer facades and `lib.rs`, and applying `cfg_attr` in place removes the `use napi_derive::napi;` import from each file, leaving only the allowlisted `cfg_attr` line. We therefore **apply `cfg_attr` in place** (no physical move, no re-export edits) and the lint's allowlist handles the `cfg_attr` line. Same boundary outcome, far less churn.

## File Map

| File | Change |
|---|---|
| `rust/Cargo.toml` | Add `napi` feature; add it to `default`. |
| `rust/src/lib.rs` | Add `#[cfg(not(feature = "napi"))] compile_error!(…)` tripwire. |
| `rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs` | `cfg_attr` on `AlpacaPricingData`, `FinnhubPricingData`; drop `use napi_derive::napi;`. |
| `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streaming_proto_handler.rs` | `cfg_attr` on `JsPricingData`, `QuoteType`, `MarketHours`; drop `use napi_derive::napi;`. |
| `rust/tests/streaming_boundary_lint.rs` | New: source-scanning boundary lint test. |
| `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs` | New `#[cfg(test)] mod loopback_tests`. |
| `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs` | New `#[cfg(test)] mod loopback_tests`. |
| `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs` | New `#[cfg(test)] mod loopback_tests`. |
| `rust/src/markets/nasdaq/datafeeds/streaming/core/mod.rs` | Module rustdoc note on the boundary (Task 6). |
| `ROADMAP.md` | Mark Phase A complete (Task 6). |

---

### Task 1: `napi` feature gate + `compile_error!` guard + `cfg_attr` the 5 wire types

**Files:**
- Modify: `rust/Cargo.toml:41-43`
- Modify: `rust/src/lib.rs` (after the module-level doc comment, before `pub mod observability;`)
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs:4,8,29`
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streaming_proto_handler.rs:10,125,238,281`

- [ ] **Step 1: Verify state (Step 0).** Open the four files. Confirm: `Cargo.toml` has `[features]` with `default = ["finnhub"]` and `finnhub = []`; `core/types.rs` line 4 is `use napi_derive::napi;` and lines 8 & 29 are `#[napi(object)]`; the proto handler line 10 is `use napi_derive::napi;`, line 125 is `#[napi(object)]` (on `JsPricingData`), lines 238 & 281 are `#[napi]` (on `QuoteType` / `MarketHours`). If any differ, STOP and report `STATE_MISMATCH: <what>`.

- [ ] **Step 2: Add the `napi` feature.** In `rust/Cargo.toml`, replace the `[features]` block:

```toml
[features]
default = ["finnhub", "napi"]
finnhub = []
# Gates the `#[napi(object)]` / `#[napi]` derive on the streaming WIRE types only.
# Default-on: corelib-rust is the napi cdylib and always builds with it. The feature
# exists to MARK the FFI seam and to make the future corelib-streaming crate lift
# mechanical (that crate builds with `--no-default-features` → napi-free wire structs).
napi = []
```

- [ ] **Step 3: Add the `compile_error!` tripwire.** In `rust/src/lib.rs`, immediately after the closing of the module doc comment block (the `// =====` banner ending at line 13) and before `pub mod observability;`, insert:

```rust
// The napi feature is mandatory for this crate: the streamer facades, the FFI entry
// points, and the wire-type derives all require it. Building `--no-default-features`
// would strip the napi derive off the wire structs while the adapter still calls napi
// conversions on them, yielding cryptic deep-macro errors. Fail legibly instead.
#[cfg(not(feature = "napi"))]
compile_error!(
    "The 'napi' feature is mandatory to compile the corelib-rust cdylib. \
     Do not build this crate with --no-default-features; the napi-free streaming \
     engine becomes buildable only once it is lifted into the corelib-streaming crate."
);
```

- [ ] **Step 4: `cfg_attr` the two payload structs in `core/types.rs`.** Delete line 4 (`use napi_derive::napi;`). Change the attribute on `AlpacaPricingData` (was line 8) and on `FinnhubPricingData` (was line 29) from `#[napi(object)]` to the cfg_attr form. After the edit those two attribute lines read exactly:

```rust
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
```

(Leave the `#[derive(Clone, Debug, Serialize, Deserialize)]` / `#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]` lines and all fields unchanged. `serde` stays unconditional.)

- [ ] **Step 5: `cfg_attr` the three napi types in the proto handler.** In `yahoo_streaming_proto_handler.rs`, delete line 10 (`use napi_derive::napi;`). Change the attribute on `JsPricingData` (was line 125) from `#[napi(object)]` to:

```rust
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
```

Change the attribute on `QuoteType` (was line 238) and on `MarketHours` (was line 281) from `#[napi]` to:

```rust
#[cfg_attr(feature = "napi", napi_derive::napi)]
```

(Leave the `#[derive(...)]`, `#[repr(i32)]`, `#[prost(...)]`, and all variant/field lines unchanged.)

- [ ] **Step 6: SHAPE-DIVERGENCE check.** The only change to generated code must be: with the default features on, the cfg_attr expands to exactly the prior attribute. No field types, names, ordering, or the prost `PricingData`/`From` impl change. If making it compile would require changing any of those, STOP and report `[original] -> [yours] because <reason>`.

- [ ] **Step 7: Run the existing Rust tests (oracle: the byte-identity test).**

Run: `cd rust && cargo test -- --test-threads=1`
Expected: PASS, including `core::types::tests::core_event_constructs_and_raw_payload_serializes_identically` and the proto-handler/driver tests. No new failures vs. baseline.

- [ ] **Step 8: Confirm the napi binding is unchanged (contract gate).**

Run: `cd rust && pnpm exec napi build --release && git diff --exit-code rust/index.d.ts`
Expected: the build succeeds and `git diff` exits 0 (no change to `rust/index.d.ts`). If `AlpacaPricingData` / `FinnhubPricingData` / `JsPricingData` shapes changed, the cfg_attr is wrong — STOP and report.

- [ ] **Step 9: Clippy.**

Run: `cd rust && cargo clippy --all-targets -- -D warnings`
Expected: clean (0 warnings).

- [ ] **Step 10: Commit.**

```bash
git add rust/Cargo.toml rust/src/lib.rs \
  rust/src/markets/nasdaq/datafeeds/streaming/core/types.rs \
  rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streaming_proto_handler.rs
git commit -m "feat(streaming): cfg_attr-gate the napi wire types + napi feature guard"
```

---

### Task 2: Boundary lint test (engine source set is napi-free)

**Files:**
- Create: `rust/tests/streaming_boundary_lint.rs`

- [ ] **Step 1: Write the failing test.** Create `rust/tests/streaming_boundary_lint.rs` with the complete content below. (It is an integration test — auto-discovered, no module declaration needed. It reads source text; it does not use the crate API.)

```rust
//! Boundary lint: the streaming ENGINE source set must contain NO direct napi coupling.
//! The only permitted napi mention is the `cfg_attr(feature = "napi", …)` derive on wire types.
//! This stands in for the `--no-default-features` compile check we cannot run in a single crate
//! (the facades + non-streaming code require napi unconditionally — see lib.rs compile_error!).
use std::fs;
use std::path::Path;

/// Engine source files (relative to the crate root) that MUST stay napi-free.
const ENGINE_FILES: &[&str] = &[
    "src/markets/nasdaq/datafeeds/streaming/core/driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/host.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/reconnect.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/schema.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/supervisor.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/mod.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/types.rs",
    "src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streaming_proto_handler.rs",
];

/// Strip `//` line comments, `/* */` block comments, and "double-quoted" string literals,
/// so the napi-token scan sees code only (avoids false positives on docs/log strings).
/// Preserves line count (one `\n` per input line) so reported line numbers stay accurate.
fn strip_noise(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut in_block = false;
    let mut in_str = false; // persists across lines (Rust string literals can span lines)
    for line in src.lines() {
        let b = line.as_bytes();
        let mut i = 0usize;
        while i < b.len() {
            if in_block {
                if i + 1 < b.len() && b[i] == b'*' && b[i + 1] == b'/' {
                    in_block = false;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if in_str {
                if b[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if b[i] == b'"' {
                    in_str = false;
                }
                i += 1;
                continue;
            }
            if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'/' {
                break; // rest of line is a comment
            }
            if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
                in_block = true;
                i += 2;
                continue;
            }
            if b[i] == b'"' {
                in_str = true;
                i += 1;
                continue;
            }
            out.push(b[i] as char);
            i += 1;
        }
        out.push('\n');
    }
    out
}

#[test]
fn engine_source_has_no_direct_napi_coupling() {
    let root = env!("CARGO_MANIFEST_DIR");
    let forbidden = ["use napi", "napi::", "#[napi", "napi_derive"];
    let mut violations: Vec<String> = Vec::new();
    for rel in ENGINE_FILES {
        let path = Path::new(root).join(rel);
        let src = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("engine file unreadable: {rel}: {e}"));
        let cleaned = strip_noise(&src);
        for (n, (raw_line, clean_line)) in src.lines().zip(cleaned.lines()).enumerate() {
            // The single allowlisted exception: the cfg_attr napi gate on wire types.
            if raw_line.contains("cfg_attr") && raw_line.contains("\"napi\"") {
                continue;
            }
            for pat in &forbidden {
                if clean_line.contains(pat) {
                    violations.push(format!("{rel}:{}: `{pat}` in `{}`", n + 1, raw_line.trim()));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "streaming engine files must be napi-free (cfg_attr gate is the only exception):\n{}",
        violations.join("\n")
    );
}
```

- [ ] **Step 2: Run it — it must PASS (Task 1 already cleaned the engine).**

Run: `cd rust && cargo test --test streaming_boundary_lint -- --test-threads=1`
Expected: PASS (`engine_source_has_no_direct_napi_coupling ... ok`). If it FAILS, the failure message lists each offending file:line — that means Task 1 missed a cfg_attr conversion or an engine file has a stray napi reference; fix the source (not the test) and re-run.

- [ ] **Step 3: Prove the lint bites (temporary negative check — do NOT commit).** Temporarily add a line `use napi::bindgen_prelude::*;` to the top of `core/schema.rs`, re-run `cd rust && cargo test --test streaming_boundary_lint -- --test-threads=1`, and confirm it now FAILS naming `core/schema.rs`. Then revert that line.

- [ ] **Step 4: Clippy + commit.**

Run: `cd rust && cargo clippy --all-targets -- -D warnings`
Expected: clean.

```bash
git add rust/tests/streaming_boundary_lint.rs
git commit -m "test(streaming): boundary lint — engine source set must be napi-free"
```

---

### Task 3: Alpaca pure-Rust loopback delivery test

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs` (append a new `#[cfg(test)] mod loopback_tests` after the existing `driver_tests` module)

- [ ] **Step 1: Verify state (Step 0).** Confirm `alpaca_driver.rs` defines `pub struct AlpacaDriver { pub name, pub base_url: Option<String>, pub key_id, pub secret_key, pub silence_seconds: u32, pub db: Arc<Database>, pub table: &'static str }` and that `connect_once(&self, symbols: &[String], tx: &mpsc::Sender<CoreEvent>, sub_rx: &mut mpsc::Receiver<SubRequest>, stop_rx: &mut mpsc::Receiver<()>) -> BoxFuture<'a, AttemptOutcome>`. If different, STOP and report `STATE_MISMATCH`.

- [ ] **Step 2: Write the failing test.** Append to `rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs`:

```rust
#[cfg(test)]
mod loopback_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::driver::SubRequest;
    use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn text(s: &str) -> Message {
        Message::Text(s.to_string().into())
    }

    /// Temp redb seeded with one quote subscription so the driver emits an initial subscribe.
    fn tmp_db_seeded() -> Arc<redb::Database> {
        let path = std::env::temp_dir().join(format!(
            "test_alpaca_loop_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db = redb::Database::create(path).unwrap();
        let t: redb::TableDefinition<&str, bool> =
            redb::TableDefinition::new("alpaca_subscriptions");
        let w = db.begin_write().unwrap();
        {
            let mut tab = w.open_table(t).unwrap();
            tab.insert("quotes:AAPL", true).unwrap();
        }
        w.commit().unwrap();
        Arc::new(db)
    }

    /// Minimal Alpaca WS server: connected → (read auth) → authenticated → (read subscribe) → one quote.
    async fn serve_alpaca(listener: TcpListener) {
        if let Ok((stream, _)) = listener.accept().await {
            let mut ws = accept_async(stream).await.expect("ws accept");
            ws.send(text(r#"[{"T":"success","msg":"connected"}]"#)).await.unwrap();
            let _ = ws.next().await; // auth frame from driver
            ws.send(text(r#"[{"T":"success","msg":"authenticated"}]"#)).await.unwrap();
            let _ = ws.next().await; // subscribe frame from driver
            ws.send(text(
                r#"[{"T":"q","S":"AAPL","bp":191.0,"ap":192.0,"bs":1,"as":2,"t":"2024-01-02T15:00:00Z"}]"#,
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    #[tokio::test]
    async fn pure_rust_loopback_delivers_alpaca_quote() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_alpaca(listener));

        let driver = AlpacaDriver {
            name: "alpaca_main".into(),
            base_url: Some(format!("ws://127.0.0.1:{port}")),
            key_id: "k".into(),
            secret_key: "s".into(),
            silence_seconds: 60,
            db: tmp_db_seeded(),
            table: "alpaca_subscriptions",
        };
        let (tx, mut rx) = mpsc::channel::<CoreEvent>(64);
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(8);
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);

        let connect = driver.connect_once(&[] as &[String], &tx, &mut sub_rx, &mut stop_rx);
        tokio::pin!(connect);

        let got = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = &mut connect => return None,
                    ev = rx.recv() => match ev {
                        Some(CoreEvent::Pricing { raw: RawPricing::Alpaca(p), .. }) => return Some(p),
                        Some(_) => continue, // skip Status(Connected)
                        None => return None,
                    },
                }
            }
        })
        .await
        .expect("timed out waiting for pricing");

        let p = got.expect("driver ended before delivering a pricing event");
        assert_eq!(p.symbol, "AAPL");
        assert_eq!(p.message_type, "quote");
        assert_eq!(p.bid_price, 191.0);
        assert_eq!(p.ask_price, 192.0);
    }
}
```

- [ ] **Step 3: Run it.**

Run: `cd rust && cargo test --lib pure_rust_loopback_delivers_alpaca_quote -- --test-threads=1`
Expected: PASS. This proves the full Rust path `ws frame → parse_alpaca_obj → CoreEvent::Pricing → channel` with no Node and no `ws` library.

- [ ] **Step 4: Clippy + commit.**

Run: `cd rust && cargo clippy --all-targets -- -D warnings`
Expected: clean.

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs
git commit -m "test(streaming): pure-Rust loopback delivery test for Alpaca driver"
```

---

### Task 4: Finnhub pure-Rust loopback delivery test

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs` (append a new `#[cfg(test)] mod loopback_tests`)

- [ ] **Step 1: Verify state (Step 0).** Confirm `FinnhubDriver { pub token: String, pub name: String, pub base_url: Option<String> }` (no redb), and that `connect_once` subscribes from the `symbols` argument (sends one `{"type":"subscribe","symbol":s}` per symbol). If different, STOP and report `STATE_MISMATCH`.

- [ ] **Step 2: Write the failing test.** Append to `rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs`:

```rust
#[cfg(test)]
mod loopback_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::driver::SubRequest;
    use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn text(s: &str) -> Message {
        Message::Text(s.to_string().into())
    }

    /// Minimal Finnhub WS server: (read one subscribe) → one trade frame. No auth, no handshake.
    async fn serve_finnhub(listener: TcpListener) {
        if let Ok((stream, _)) = listener.accept().await {
            let mut ws = accept_async(stream).await.expect("ws accept");
            let _ = ws.next().await; // subscribe frame from driver
            ws.send(text(
                r#"{"type":"trade","data":[{"s":"AAPL","p":191.5,"v":100,"t":1700000000000,"c":["@"]}]}"#,
            ))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    #[tokio::test]
    async fn pure_rust_loopback_delivers_finnhub_trade() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_finnhub(listener));

        let driver = FinnhubDriver {
            token: "tok".into(),
            name: "finnhub_main".into(),
            base_url: Some(format!("ws://127.0.0.1:{port}")),
        };
        let (tx, mut rx) = mpsc::channel::<CoreEvent>(64);
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(8);
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let syms = vec!["AAPL".to_string()];

        let connect = driver.connect_once(&syms, &tx, &mut sub_rx, &mut stop_rx);
        tokio::pin!(connect);

        let got = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = &mut connect => return None,
                    ev = rx.recv() => match ev {
                        Some(CoreEvent::Pricing { raw: RawPricing::Finnhub(p), .. }) => return Some(p),
                        Some(_) => continue, // skip Status(Connected)
                        None => return None,
                    },
                }
            }
        })
        .await
        .expect("timed out waiting for pricing");

        let p = got.expect("driver ended before delivering a pricing event");
        assert_eq!(p.symbol, "AAPL");
        assert_eq!(p.price, 191.5);
    }
}
```

- [ ] **Step 3: Run it.**

Run: `cd rust && cargo test --lib pure_rust_loopback_delivers_finnhub_trade -- --test-threads=1`
Expected: PASS.

- [ ] **Step 4: Clippy + commit.**

Run: `cd rust && cargo clippy --all-targets -- -D warnings`
Expected: clean.

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs
git commit -m "test(streaming): pure-Rust loopback delivery test for Finnhub driver"
```

---

### Task 5: Yahoo pure-Rust loopback delivery test

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs` (append a new `#[cfg(test)] mod loopback_tests`)

- [ ] **Step 1: Verify state (Step 0).** Confirm `YahooDriver { pub name, pub base_url: Option<String>, pub silence_seconds: u32, pub db: Arc<Database>, pub table: &'static str }` (no auth), that `connect_once` reads pricing frames of the form `{"type":"pricing","message":"<base64-protobuf>"}` via `parse_yahoo_message`, and that the existing `mapper_tests` module has an `envelope(&PricingData)` pattern using `prost::Message::encode` + base64. If different, STOP and report `STATE_MISMATCH`.

- [ ] **Step 2: Write the failing test.** Append to `rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs`:

```rust
#[cfg(test)]
mod loopback_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::driver::SubRequest;
    use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
    use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::PricingData;
    use base64::{engine::general_purpose, Engine as _};
    use futures_util::{SinkExt, StreamExt};
    use prost::Message as _;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn text(s: &str) -> Message {
        Message::Text(s.to_string().into())
    }

    /// Empty temp redb (Yahoo sends no subscribe when there are no persisted symbols;
    /// the server pushes a pricing frame immediately).
    fn tmp_db() -> Arc<redb::Database> {
        let path = std::env::temp_dir().join(format!(
            "test_yahoo_loop_{}_{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(redb::Database::create(path).unwrap())
    }

    /// Minimal Yahoo WS server: push one base64-protobuf pricing envelope. No auth.
    async fn serve_yahoo(listener: TcpListener) {
        if let Ok((stream, _)) = listener.accept().await {
            let mut ws = accept_async(stream).await.expect("ws accept");
            let p = PricingData {
                id: "AAPL".into(),
                price: 191.5,
                time: 1_700_000_000_000,
                quote_type: 8,
                ..Default::default()
            };
            let mut buf = Vec::new();
            p.encode(&mut buf).unwrap();
            let b64 = general_purpose::STANDARD.encode(&buf);
            let env = serde_json::json!({ "type": "pricing", "message": b64 }).to_string();
            ws.send(text(&env)).await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    #[tokio::test]
    async fn pure_rust_loopback_delivers_yahoo_pricing() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve_yahoo(listener));

        let driver = YahooDriver {
            name: "yahoo".into(),
            base_url: Some(format!("ws://127.0.0.1:{port}")),
            silence_seconds: 60,
            db: tmp_db(),
            table: "yahoo_subscriptions",
        };
        let (tx, mut rx) = mpsc::channel::<CoreEvent>(64);
        let (_sub_tx, mut sub_rx) = mpsc::channel::<SubRequest>(8);
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);

        let connect = driver.connect_once(&[] as &[String], &tx, &mut sub_rx, &mut stop_rx);
        tokio::pin!(connect);

        let got = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                tokio::select! {
                    _ = &mut connect => return None,
                    ev = rx.recv() => match ev {
                        Some(CoreEvent::Pricing { raw: RawPricing::Yahoo(p), .. }) => return Some(p),
                        Some(_) => continue, // skip Status(Connected)
                        None => return None,
                    },
                }
            }
        })
        .await
        .expect("timed out waiting for pricing");

        let p = got.expect("driver ended before delivering a pricing event");
        assert_eq!(p.id, "AAPL");
        assert_eq!(p.price, 191.5);
    }
}
```

- [ ] **Step 3: Run it.**

Run: `cd rust && cargo test --lib pure_rust_loopback_delivers_yahoo_pricing -- --test-threads=1`
Expected: PASS. This exercises base64 → protobuf decode → `JsPricingData` → `CoreEvent::Pricing` in pure Rust.

- [ ] **Step 4: Clippy + commit.**

Run: `cd rust && cargo clippy --all-targets -- -D warnings`
Expected: clean.

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs
git commit -m "test(streaming): pure-Rust loopback delivery test for Yahoo driver"
```

---

### Task 6: Document the boundary + mark Phase A complete

**Files:**
- Modify: `rust/src/markets/nasdaq/datafeeds/streaming/core/mod.rs:1`
- Modify: `ROADMAP.md` (the (d) Phase 3 bullet, lines ~46-55)

- [ ] **Step 1: Update the engine module rustdoc.** In `core/mod.rs`, replace the first doc line:

```rust
//! Shared trait-backed streaming engine used by all providers.
```

with:

```rust
//! Shared trait-backed streaming engine used by all providers.
//!
//! ENGINE/ADAPTER BOUNDARY (Phase A): the files in this module + the three
//! `*_driver.rs` + `yahoo_streaming_proto_handler.rs` are the napi-free engine. They
//! must contain no direct `napi` use — the only permitted napi mention is the
//! `#[cfg_attr(feature = "napi", …)]` derive on the wire payload types. This is enforced
//! by `rust/tests/streaming_boundary_lint.rs`. The `*_streamer.rs` facades + `diagnostics.rs`
//! are the napi adapter. The future `corelib-streaming` crate lift moves this engine set out
//! verbatim (it already builds napi-free with `--no-default-features`).
```

- [ ] **Step 2: Mark Phase A complete in ROADMAP.** In `ROADMAP.md`, in the `(d) Phase 3` section, append after the existing `Phase A —` description line a status note:

```markdown
     - **Phase A — DONE (2026-06-15):** Module-Now boundary established in-place — the 5 wire
       types are `cfg_attr(feature="napi")`-gated, a `compile_error!` guards `--no-default-features`,
       and `rust/tests/streaming_boundary_lint.rs` enforces the napi-free engine source set.
       Pure-Rust tokio loopback delivery tests added for Alpaca/Finnhub/Yahoo (frame → CoreEvent,
       no Node). Spec: `docs/superpowers/specs/2026-06-15-phase-a-streaming-engine-module-boundary-design.md`.
       DEFERRED to Phase B (Streaming Engine Epic): the Node↔Rust loopback interop closure and the
       `corelib-streaming` crate extraction.
```

- [ ] **Step 3: Full gate.**

Run: `cd rust && cargo test -- --test-threads=1 && cargo clippy --all-targets -- -D warnings`
Expected: all tests PASS (including the boundary lint + all three loopback tests), clippy clean.

- [ ] **Step 4: Commit.**

```bash
git add rust/src/markets/nasdaq/datafeeds/streaming/core/mod.rs ROADMAP.md
git commit -m "docs(streaming): document engine/adapter boundary; mark Phase A done"
```

---

## Milestone offload dispatches

Per the spec's chosen verify mode, after **Task 1**, **Task 5**, and **Task 6**, dispatch `dev-offload.yml` (commit + nonce, run-name resolution) for the full remote matrix rather than relying only on the local single-threaded gate. (If `dev-offload.yml` is not yet committed to the repo, this is a no-op for those milestones; the local gate still applies.)

---

## Self-Review

**1. Spec coverage:**
- §4 boundary (engine vs adapter) → Tasks 1, 2, 6 (cfg_attr + lint + rustdoc). ✓
- §5 cfg_attr seam + `compile_error!` guard → Task 1. ✓
- §6 boundary lint (comment/string strip, cfg_attr allowlist, enumerated engine set) → Task 2. ✓
- §7 pure-Rust loopback + redb tempdir + dummy creds + 127.0.0.1:0 → Tasks 3 (Alpaca), 4 (Finnhub), 5 (Yahoo). ✓
- §8 migration order → reflected (cfg_attr before lint; loopbacks after; docs last). The spec's wire-module move is intentionally dropped (documented refinement). ✓
- §9 oracles (byte-identity test, `rust/index.d.ts` unchanged, lint) → Task 1 Steps 7-8, Task 2. ✓
- §12 success criteria 1-5 → lint (Task 2), cfg_attr+d.ts (Task 1), ≥Alpaca loopback (Task 3, +4/5), gate+clippy (every task), ROADMAP (Task 6). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✓

**3. Type consistency:** `AlpacaDriver`/`FinnhubDriver`/`YahooDriver` field sets and `connect_once` signature match the actual source (verified). `CoreEvent::Pricing { raw: RawPricing::{Alpaca|Finnhub|Yahoo}(p), .. }` matches `core/types.rs`. `SubRequest` import path matches `core/driver.rs`. `Message`/`accept_async`/`TcpListener` match the `tokio-tungstenite` 0.29 + `tokio` deps. `PricingData` + `prost::Message::encode` + base64 match the proto handler and the existing Yahoo `mapper_tests`. ✓

**Note for the executor:** the three loopback tests use `#[tokio::test]` (current-thread runtime); they run under the mandatory `--test-threads=1` gate without port conflicts (each binds `127.0.0.1:0`). Do not parallelize the Rust test run.
