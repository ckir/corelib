# Phase A — Streaming Engine Module Boundary (Module-Now)

**Date:** 2026-06-15
**Status:** DRAFT (design)
**Roadmap:** (d) Phase 3 — the napi-free streaming engine. This is **Phase A** of that roadmap item, deliberately scoped down from "extract a crate" to "establish the module boundary" (see Decision Record).

---

## 1. Goal

Establish a **strict, enforced engine/adapter module boundary** inside the existing `corelib-rust` crate so the streaming engine (WS state machines, reconnect, host/supervisor, channel types) is provably free of direct napi/N-API coupling and testable in **pure Rust** — and add the pure-Rust loopback delivery test that this boundary unlocks.

We do **not** extract a separate `corelib-streaming` crate in this phase. That crate split is the *finstream* prerequisite, and finstream is not being built now (YAGNI). This phase makes the eventual lift mechanical.

## 2. Background & Decision Record

The original roadmap framing was "extract a napi-free `corelib-streaming` crate." A divergent design review (agy, 2026-06-15) argued — correctly — that:

1. The engine logic is **already** napi-free (verified: all three `*_driver.rs` and `core/{driver,host,reconnect,schema,supervisor}.rs` contain zero napi tokens), and is **already** testable via `cargo test` without Node. A separate crate is therefore not required to gain pure-Rust testability.
2. The only unique payoff of a *crate* split is giving the (future, unprioritized) finstream gateway a napi-free dependency. Extracting it now is premature abstraction.
3. Moving `#[napi(object)]` types into a dependency crate risks the **napi-cli binding-generator blindspot** (per-crate static analysis may omit the types from `index.d.ts`). Staying in one crate sidesteps this entirely.

We also rejected agy's "serialization-bypass" seam (engine emits JSON/Buffer, JS parses) because it is an **API change**, not a refactor — out of scope for Phase A.

**Decision:** Module-Now. Enforce the boundary in-place, add the loopback test, defer the crate split. Confirmed by the user 2026-06-15.

## 3. Current State (verified)

napi token counts across `rust/src/markets/nasdaq/datafeeds/streaming/`:

| File | napi | Layer |
|---|---|---|
| `core/driver.rs` (`ProviderDriver` trait) | 0 | **engine** |
| `core/host.rs` (`StreamHost`, redb persistence) | 0 | **engine** |
| `core/reconnect.rs` (`ReconnectPolicy`) | 0 | **engine** |
| `core/schema.rs` (`MarketEvent`, `ProviderStatus`, `ProviderKind`) | 0 | **engine** (shared vocabulary) |
| `core/supervisor.rs` | 0 | **engine** |
| `core/mod.rs` | 0 | **engine** |
| `alpaca/alpaca_driver.rs` | 0 | **engine** |
| `finnhub/finnhub_driver.rs` | 0 | **engine** |
| `yahoo/yahoo_driver.rs` | 0 | **engine** |
| `core/types.rs` (`CoreEvent`, `RawPricing` + payloads) | 3 | **SEAM** |
| `yahoo/yahoo_streaming_proto_handler.rs` (`JsPricingData`, 33 fields) | 4 | **SEAM** |
| `alpaca/alpaca_streamer.rs` (`AlpacaStreaming` facade + TSFN) | 17 | **adapter** |
| `finnhub/finnhub_streamer.rs` (`FinnhubStreaming` facade + TSFN) | 23 | **adapter** |
| `yahoo/yahoo_streamer.rs` (`YahooStreaming` facade + TSFN) | 18 | **adapter** |
| `diagnostics.rs` (`napi_load_generator`, `napi_trigger_diagnostic_flood`) | 10 | **adapter** (test/diagnostic FFI entry points) |

The seam is small and already well-isolated:
- `core/types.rs`: `RawPricing` and `CoreEvent` are **already napi-free enums**; the napi lives only in the three `#[napi(object)]` **payload structs** they carry (`AlpacaPricingData`, `FinnhubPricingData`) plus the imported `JsPricingData`.
- `core/types.rs` already carries a serde **byte-identity test** (`core_event_constructs_and_raw_payload_serializes_identically`) — the oracle that the payload wire shape is stable. The seam treatment must keep this passing.

## 4. Architecture — the module boundary

Logical two-layer split, **dependency direction adapter → engine only**:

```
streaming/
  engine/                        (napi-free; the future corelib-streaming crate)
    core/  driver, host, reconnect, schema, supervisor, mod
    drivers/  alpaca_driver, finnhub_driver, yahoo_driver  (+ their frame parsers)
    types  (CoreEvent, RawPricing)            <- napi-free enums
    wire   (the 3 payload structs)            <- SEAM: cfg_attr-gated napi (see §5)
  adapter/  (napi)
    alpaca_streamer, finnhub_streamer, yahoo_streamer   (facades + ThreadsafeFunction delivery)
    diagnostics   (napi_load_generator / napi_trigger_diagnostic_flood)
```

This phase does **not** physically relocate every file into new directories if that churns paths gratuitously; the **boundary is logical + enforced by lint** (§6). Physical re-namespacing is applied where it clarifies the boundary (notably isolating the payload "wire" structs from the napi-free `CoreEvent`/`RawPricing`), and kept minimal otherwise. The litmus test for "engine": **zero direct napi use** (the cfg_attr derive on wire structs is the sole, documented exception).

The adapter remains the only place that:
- declares `#[napi]` / `#[napi(constructor)]` facades,
- holds the `ThreadsafeFunction` callbacks (bounded 1024) and calls `on_pricing.call(...)`,
- converts engine `CoreEvent` → the JS-facing payloads at the delivery boundary.

## 5. The payload seam — `cfg_attr` feature gate

Apply to the three payload structs (`AlpacaPricingData`, `FinnhubPricingData` in `core/types.rs`; `JsPricingData` in the proto handler):

```rust
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
#[derive(Clone, Debug, Serialize, Deserialize)]  // serde stays UNCONDITIONAL
pub struct AlpacaPricingData { /* fields unchanged */ }
```

Add to `rust/Cargo.toml`:

```toml
[features]
default = ["napi"]
napi = []   # gates the #[napi(object)] derive on streaming wire structs
```

**Footgun guard (required).** Because the rest of the crate (facades, non-streaming napi code) references napi unconditionally, building `corelib-rust` with `--no-default-features` would strip the napi derives off the wire structs while the adapter still calls napi conversions on them — yielding cryptic deep-macro errors. Add a compile-time tripwire in `lib.rs` (outside the engine boundary) so the failure is legible:

```rust
#[cfg(not(feature = "napi"))]
compile_error!(
    "The 'napi' feature is mandatory to compile the corelib-rust cdylib. \
     Do not build this crate with --no-default-features; the napi-free engine \
     becomes buildable only once it is lifted into the corelib-streaming crate."
);
```

**Why this seam (over the alternatives):**
- **Single definition, zero `From` boilerplate** vs. double-definition (engine plain struct + adapter napi mirror). agy confirmed the per-tick struct-copy cost that double-definition would add is negligible against napi marshaling — but it is still avoidable boilerplate, and these payloads (esp. Yahoo's 33 fields) are large to mirror.
- **napi-cli blindspot is moot** — everything stays in one crate, so the binding generator scans the types normally and `index.d.ts` is unaffected.
- **The crate lift later is mechanical** — finstream builds the extracted engine with `default-features = false`; the payloads are already plain `Serialize/Deserialize` structs with the napi derive compiled out. No payload edits at lift time.

**Honest scope note (what this does / does not buy in Module-Now):** because `corelib-rust` also contains non-streaming napi code and the streaming facades, the *whole crate* cannot be built `--no-default-features`; so the feature gate does **not** yet give a machine-checked "engine compiles napi-free" build. Its value now is (a) explicitly typing the FFI seam and (b) pre-wiring the deferred lift. The **live enforcement** in this phase is the lint in §6. The byte-identity test in `core/types.rs` must continue to pass unchanged (serde is unconditional, so it does).

## 6. Boundary enforcement — the lint

A Rust test (compiled into the existing `cargo test` gate, runnable standalone) that statically scans the engine source set and **fails if any engine file contains a direct napi reference** (`use napi`, `napi::`, `#[napi]`, `napi_derive`) — with a single allowlisted exception: the `cfg_attr(feature = "napi", ...)` derive line on the documented wire structs.

```rust
// rust/src/markets/nasdaq/datafeeds/streaming/boundary_lint.rs (or tests/)
// Engine source set (relative to streaming/): the drivers + core logic.
// For each file: STRIP line comments (//…), block comments (/*…*/), and
// string literals ("…") FIRST, then assert the cleaned source contains no
// `use napi`, `use napi_derive`, `napi::`, or `#[napi` — outside the single
// allowlisted `cfg_attr(feature = "napi", napi…)` derive on wire structs.
```

- **Comment/string stripping is mandatory** — a raw substring scan would false-positive on doc comments mentioning napi (e.g. the existing "raw FFI pricing structs" docs) or on log strings. The check targets import/path/attribute *tokens* in cleaned source, not the word "napi" anywhere. (`syn`-based AST parsing is an acceptable heavier alternative if `syn` is already a dev-dependency, but the strip-then-scan approach is sufficient and zero-dep.)
- The **engine source set** is an explicit, enumerated list in the test (no globs that could silently include new adapter files).
- A new engine file that imports napi → red test → caught in the gate.
- This is the mechanism that keeps "the engine is napi-free" honest in a single crate, standing in for the `--no-default-features` build we cannot run here.

## 7. The do-now payoff — pure-Rust engine delivery test (and what it does NOT prove)

Add a pure-Rust integration test that:

1. Stands up a **local tokio WebSocket server** (e.g. `tokio-tungstenite` accept loop) that speaks one provider's frame protocol (start with **Alpaca**: connect → expect auth → send a canned trade/quote frame).
2. Points the provider **driver** (`alpaca_driver`) at that server's `ws://127.0.0.1:<port>` via the **existing `base_url` override** (verified present on the driver).
3. Drives the driver and **asserts a `CoreEvent::Pricing` with the expected `RawPricing::Alpaca` payload arrives on the engine channel** within a timeout.

This exercises the full **frame → parse → CoreEvent → channel** delivery path **in pure Rust** — giving the engine state machines, parsers, and channel dispatch real regression coverage they currently lack outside the napi/Node path.

**Scope honesty (do NOT overclaim — corrected per convergent review).** The Epic-5 finding `probe-harness-loopback-no-delivery` was a **Rust ↔ Node cross-runtime** defect: ws:// frames did not transit Rust `tokio-tungstenite` ↔ **Node's `ws`** library. This test uses tokio-tungstenite on **both** ends (Rust server ↔ Rust client), so it **does NOT reproduce or close that cross-runtime gap** — it would pass green even if the Rust↔Node wire path were still broken. What it *does* deliver:
- **Engine correctness:** proves the Rust frame→`CoreEvent` path is correct.
- **Fault isolation:** by proving the engine path works Rust↔Rust, it **narrows the Epic-5 fault to the Rust↔Node adapter boundary** (napi delivery or Node's `ws`) by elimination — a diagnostic win, not a closure.

**Actual closure of the cross-runtime gap is OUT OF SCOPE for Phase A** and remains an E2E task: the Node adapter driving the Rust cdylib against a loopback (the Epic-5 probe itself), tracked separately. Phase A's justification stands on the boundary + pure-Rust engine testability + finstream prep + this fault isolation — not on closing the interop bug.

- Initial scope: **one provider (Alpaca)** end-to-end as the pattern; Finnhub/Yahoo loopback tests are a fast follow within the same harness (the harness is provider-parameterized where practical).
- **redb isolation (required):** the driver's `connect_once` does a redb subscription read (`load_subscriptions()`), so the test path touches `redb` exclusive-locked storage. The test MUST inject a **`tempfile`-provided temporary directory** for the redb DB (seeding the subscription there) — never the default/production path — to avoid lock-flakiness and local-storage pollution.
- The test must honor the redaction rule (no secrets/URLs-with-creds in assertions or logs; shapes/counts only).
- The auth handshake in the test server uses a **dummy/fake** credential — never a real key.

## 8. Migration plan & order

Incremental, each step independently `cargo test`-green and committed:

1. **Lint scaffold first (green-on-today):** add the boundary lint test with the engine source set enumerated (comment/string-stripping per §6); confirm it passes against today's tree (the engine files are already napi-free) — this pins the boundary before any movement.
2. **Isolate the wire structs:** move the three payload structs out of `core/types.rs` into a dedicated `wire` module, cleanly separated from the napi-free `CoreEvent`/`RawPricing` enums; update imports. Lint + tests green. (Done **before** the cfg_attr edit so the structs are touched once in their final home — avoids double-editing.)
3. **Seam:** add the `napi` feature (+ the `compile_error!` tripwire in `lib.rs`) and convert the three payload structs to `cfg_attr` in their new `wire` home. Verify the byte-identity test + full `cargo test` stay green; **diff `index.d.ts`** to confirm the object shapes for `AlpacaPricingData` / `FinnhubPricingData` / `JsPricingData` are byte-identical (the derive output is unchanged when the feature is on).
4. **Loopback test (Alpaca):** add the tokio loopback server harness (127.0.0.1:0, tempfile redb) + the Alpaca delivery test. Green.
5. **Loopback fast-follow:** Finnhub + Yahoo delivery tests on the same harness. Green.
6. **Docs:** update the streaming module doc comment + ROADMAP to record Phase A done and the crate lift + the E2E interop closure as the remaining deferred steps.

Heavy verification (the full Rust gate: `cd rust && cargo test -- --test-threads=1`, plus the 9-cell matrix where relevant) is **offloaded by dispatching `dev-offload.yml` at milestones** (after steps 3, 4, and 6), per the chosen verify mode. Note the Rust gate is single-threaded (global flight-recorder ring).

## 9. Verification & gates

- **Local per-task:** `cd rust && cargo test -- --test-threads=1` (the project Rust gate; single-threaded is mandatory due to the global ring buffer). `cargo clippy -- -D warnings`. The TS gate (`pnpm verify:fast`) for any `index.d.ts` churn.
- **Milestone:** dispatch `dev-offload.yml` (commit + nonce, run-name resolution) for the full remote matrix at steps 3, 4, 6.
- **Oracle for the seam:** the existing `core_event_constructs_and_raw_payload_serializes_identically` test + the unchanged `index.d.ts` object shapes for `AlpacaPricingData` / `FinnhubPricingData` / `JsPricingData`. If a value or shape would change, **stop** — the wire format is a contract.
- **Oracle for the boundary:** the boundary lint test (§6) — green means no engine file gained napi coupling.

## 10. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| `cfg_attr` changes the `index.d.ts` object shape | Med | Diff `index.d.ts` before/after step 3; the derive output is identical when the feature is on (default), so it must not change. Gate on it. |
| Loopback test is flaky (port binding, timing) | Med | Bind `127.0.0.1:0` (OS-assigned port); generous timeout; deterministic single canned frame; no real network. |
| redb exclusive-lock flakiness / local-storage pollution from the loopback test | Med | Inject a `tempfile` temp dir for the redb DB in the test (§7); never touch the default/production path. |
| Downstream `--no-default-features` build of corelib-rust silently strips napi | Med | `compile_error!` tripwire in `lib.rs` (§5) turns it into a legible failure. |
| Boundary lint gives false confidence (single-crate, no `--no-default-features` build) | Low-Med | Documented honestly (§5); lint enumerates the engine set explicitly; the crate lift later adds the real compile-time guarantee. |
| Re-namespacing churns paths / imports broadly | Low | Keep physical movement minimal (§4); boundary is logical + lint-enforced; only the wire/channel separation is a real move. |
| Vestigial-looking `napi` feature (always on in this crate) | Low | Documented as the seam marker + lift pre-wiring; becomes load-bearing at the crate split. |

## 11. Deferred (explicitly out of scope for Phase A)

- **The `corelib-streaming` crate extraction** — lift the `engine/` module set into a workspace crate with `[features] napi = []` (default off), have `corelib-rust` depend on it with `features = ["napi"]`. Triggered when finstream is prioritized. Made mechanical by this phase.
- **E2E cross-runtime interop closure** — the *actual* fix/validation of `probe-harness-loopback-no-delivery` (Rust cdylib ↔ Node `ws`), which the §7 Rust-only test does **not** cover. Phase A only isolates the fault to this boundary; closing it is a separate downstream debugging task.
- **finstream gateway** itself.
- **Serialization-bypass delivery** (engine emits Buffer/JSON) — a future *perf/API* decision, not this refactor.
- Finnhub/Yahoo are in-scope for the loopback fast-follow (step 5) but if time-boxed, Alpaca-only still satisfies the engine-delivery success criterion.

## 12. Success criteria

1. Boundary lint test exists, enumerates the engine source set, and is green (no engine file has direct napi coupling).
2. The three payload structs are `cfg_attr(feature = "napi", ...)`-gated with unconditional serde; `index.d.ts` object shapes unchanged; byte-identity test green.
3. A pure-Rust tokio loopback test proves `frame → CoreEvent` delivery for **at least Alpaca**, with no Node/`ws`. This validates the **engine** delivery path and isolates the Epic-5 fault to the Rust↔Node boundary — it does **not** claim to close `probe-harness-loopback-no-delivery` (the cross-runtime closure is deferred, §11).
4. Full Rust gate green single-threaded; clippy `-D warnings` clean; TS gate green; verified on the remote matrix via a `dev-offload.yml` milestone dispatch.
5. ROADMAP records Phase A complete, with the crate lift **and** the E2E interop closure as the remaining deferred steps of roadmap (d) Phase 3.
