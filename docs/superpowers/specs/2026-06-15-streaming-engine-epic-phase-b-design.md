# Streaming Engine Epic — Phase B Companion Design

**Date:** 2026-06-15
**Status:** DRAFT (design)
**Epic:** Streaming Engine (consolidated 2026-06-15; agy `CONSOLIDATE-BUT-KEEP-SPEC-ADD-COMPANION`).
**Companion to:** `2026-06-15-phase-a-streaming-engine-module-boundary-design.md` (Phase A — the napi-free module boundary). This spec is **not** a rewrite of Phase A; it covers the remaining Epic items.

---

## 1. Goal

Close out the Streaming Engine Epic's non-boundary work: the two small driver follow-ups (Finnhub reconnect-resume, Yahoo undecodable-frame logging) and — the load-bearing item — the **Node↔Rust cross-runtime interop closure**: prove (deterministically, in CI) that a frame round-trips `Node ws server → Rust driver → ThreadsafeFunction → JS callback`, closing the Epic-5 finding `probe-harness-loopback-no-delivery` that Phase A's pure-Rust loopback explicitly does **not** cover.

## 2. Background, sequencing, and the key reframe

agy's scoping review fixed the order **Phase A → (B1, B2) → B3** and the rule that *the Epic stays open until interop closure*. The rationale: Phase A's pure-Rust loopback **exonerates the engine** (proves frame→`CoreEvent` delivery is correct in Rust), so any residual failure in the Node↔Rust harness is isolated to the napi/Node-`ws` boundary — shrinking B3's search space by ~90%.

**The reframe (from ground-truth inspection):** the Node↔Rust loopback is **not greenfield**. It already exists:
- `probes/_harness/alpaca-loopback.mjs` — `AlpacaLoopbackServer`, a Node `ws`-library server implementing the full Alpaca handshake (connected → auth-ack → subscribe-ack → stream DATA frames), mirroring `alpaca_driver.rs::connect_once`.
- `probes/_harness/transport-backpressure-child.mjs` + `probes/js/transport-backpressure.probe.test.ts` — drive the **real** `AlpacaStreaming` (napi) through that server.

The Epic-5 gap is recorded in that probe (lines 25-30): in some environments `STREAM_READY=0 → RECEIVED=0` — frames never reach `on_pricing`. The probe's own hypothesis: the tokio timer driver does not advance after the first connection attempt **on the debug native build on Windows**, stalling the supervisor reconnect sleep. CI builds `napi build --release`. So B3 is fundamentally an **investigation + fix + promotion** task, not a build-from-scratch.

## 3. Scope & non-goals

**In scope:** B1 (Finnhub redb resume), B2 (Yahoo debug log), B3 (interop investigation → fix → deterministic CI test).

**Out of scope:** the `corelib-streaming` crate extraction (deferred to finstream); any change to the streaming public API; Group-2 test janitorial; Group-3 tooling.

---

## 4. B1 (c) — Finnhub reconnect-resume of in-session subscriptions

**Problem (verified):** `FinnhubDriver { token, name, base_url }` has **no redb handle**. `connect_once` subscribes from the `symbols` snapshot passed at `start()` and tracks live adds only in an in-memory `current: Vec<String>`. On reconnect, the supervisor calls `connect_once` again with the original snapshot → mid-session dynamic subscribes are lost. (Pre-existing Phase-1 behaviour, not a regression.)

**Design:** mirror the `AlpacaDriver`/`YahooDriver` pattern — make the redb DB the single source of truth, read fresh on every `connect_once`:
- Add `db: Arc<Database>` + `table: &'static str` to `FinnhubDriver` (matching the other two drivers' fields).
- Add `FinnhubDriver::load_subscriptions(&self) -> Vec<String>` reading the full persisted **bare-key** set (Finnhub is single-channel, identical to `YahooDriver::load_subscriptions`).
- In `connect_once`, replace the initial subscribe loop's source: subscribe the fresh `load_subscriptions()` set (ignore the `symbols` arg, consistent with Alpaca/Yahoo which already mark it `_`).
- Wire the host's shared `Arc<Database>` + table name into the driver where `FinnhubStreaming` constructs it (mirror how `AlpacaStreaming`/`YahooStreaming` pass `host.db_handle()` + `host.table_name()`).

**Persistence semantics:** the facade's `subscribe`/`unsubscribe` must already persist to redb for resume to work; confirm during implementation that `FinnhubStreaming` writes subscriptions to the host table (Alpaca/Yahoo do). If it does not, add the persist write — that is part of this item.

**Oracle:** a Rust driver test seeding redb + asserting `load_subscriptions()` returns the persisted bare keys (mirror `yahoo_driver.rs::driver_tests::load_subscriptions_reads_bare_keys`), plus a reconnect-resume assertion: persisted subs are re-sent on a second `connect_once`.

## 5. B2 (d) — Yahoo debug-log for undecodable frames

**Problem (verified):** `YahooDriver` pump (yahoo_driver.rs ~line 234) silently drops frames `parse_yahoo_message` can't decode: `if let Some((raw, uni)) = parse_yahoo_message(&t, &self.name) { … }` with no `else`. The old bespoke Yahoo streamer trace-logged them; diagnosing a Yahoo wire-protocol change is now blind.

**Design:** add a `tracing::debug!` in the `else` branch, under the existing `target: "corelib_rust::stream"`. **Redaction rule (hard):** never log the frame contents (a base64 protobuf payload may carry data) — log **shape only**: the byte length and a fixed marker. Example shape:

```rust
Some(Ok(Message::Text(t))) => {
    silence.reset();
    if let Some((raw, uni)) = parse_yahoo_message(&t, &self.name) {
        let _ = tx.send(CoreEvent::Pricing { raw: RawPricing::Yahoo(raw), uni }).await;
    } else {
        tracing::debug!(target: "corelib_rust::stream", provider = "yahoo", bytes = t.len(), "undecodable frame skipped");
    }
}
```

**Oracle:** a focused assertion is awkward (it's a log side effect); acceptance is a code-review check that the `else` logs **length only** (no `t` contents, no base64) + the existing Yahoo tests stay green. This is the one item without a strong automated oracle; keep it minimal.

## 6. B3 (b) — Node↔Rust cross-runtime interop closure (the load-bearing item)

**Objective:** turn the existing non-asserting `AlpacaLoopbackServer` ↔ real-`AlpacaStreaming` path into a **deterministic, CI-gated** assertion that a known frame round-trips end-to-end with exact integrity — and fix whatever currently makes `RECEIVED=0` so it passes reliably.

**Step 1 — Characterize (do this first, it may collapse the whole item).** Run the existing `transport-backpressure-child.mjs` / a minimal driver harness against a **release** `napi build` (the CI build profile) on Linux and Windows. Record `STREAM_READY` and `RECEIVED`. Two outcomes:
- **(A) Release is clean** (`STREAM_READY=1`, `RECEIVED>0`): the Epic-5 `RECEIVED=0` was a **debug-build Windows tokio-timer artifact**, not a release defect. Then B3 reduces to *promotion* (Step 3) gated on the release binary, plus documenting the debug-build caveat.
- **(B) Release still drops** (`RECEIVED=0`): a genuine interop defect → Step 2.

**Step 2 — Root-cause (only if outcome B).** With Phase A having exonerated the engine (the Rust driver delivers `CoreEvent`s against a Rust loopback), the fault is isolated to the napi/Node boundary. Investigate, in order of likelihood: the supervisor's reconnect/timer scheduling under the napi `tokio_rt`; the `ThreadsafeFunction` delivery (the bounded-1024 NonBlocking path from Epic 5) under the loopback's timing; the Node-`ws` ↔ tokio-tungstenite handshake/framing. **Time-box** the investigation (see Risks); the deliverable on a deep/won't-fix root cause is a documented finding + a `INTEGRATION_LIVE`-gated test, not an open-ended dig.

**Step 3 — Promote to a deterministic CI test.** Add a new integration test under `ts-markets/tests/integration/` (sibling to `AlpacaStreaming.live.integration.test.ts`) that:
1. Starts `AlpacaLoopbackServer` (reuse `probes/_harness/alpaca-loopback.mjs`).
2. Constructs a real `AlpacaStreaming` pointed at `server.url` via the `baseUrl`/`base_url` config override, with **dummy credentials** (the loopback's auth ack is unconditional).
3. Subscribes a symbol; the server streams one canned trade frame (`streamTradeAll("AAPL", …)` once `streamingCount > 0`).
4. **Asserts** the `on_pricing` callback fires within a timeout with the exact payload (`symbol === "AAPL"`, expected price), and tears down cleanly (no leaked sockets/threads).

This test runs in the **standard integration tier** (not `INTEGRATION_LIVE`-gated) so it gates CI — *that* is the interop closure. If Step 1 found the debug-build caveat, the test asserts against the release addon the CI matrix builds.

**Determinism requirements:** bind `127.0.0.1:0`; wait on `streamingCount > 0` before streaming (no fixed sleeps); generous per-step timeouts; one canned frame; full teardown in `afterEach`/`finally`. Redaction: dummy keys only; assert on shapes/values, never log URLs-with-creds.

**Acceptance for the Epic:** this CI test green on the matrix = `probe-harness-loopback-no-delivery` closed = the Streaming Engine Epic closes.

---

## 7. Sequencing & dependencies

```
Phase A (boundary + pure-Rust loopback, engine exonerated)   ← prerequisite
        │
        ├─ B1 (Finnhub redb resume)      ── bounded, Rust + facade
        ├─ B2 (Yahoo debug log)          ── tiny, Rust
        └─ B3 (interop closure)          ── Step 1 characterize → 2 root-cause? → 3 promote
                                            (depends on Phase A exoneration to isolate fault)
```

B1 and B2 are independent and can land in either order. B3 **must** follow Phase A. The Epic does not close until B3 Step 3 is green in CI.

## 8. Verification & gates

- **Rust:** `cd rust && cargo test -- --test-threads=1` (single-threaded mandatory); `cargo clippy --all-targets -- -D warnings`.
- **TS:** `pnpm verify:fast` for the touched TS; the new B3 integration test runs in the integration tier.
- **B1 oracle:** Finnhub `load_subscriptions` + reconnect-resume Rust tests.
- **B3 oracle:** the deterministic loopback integration test asserting frame round-trip with exact integrity.
- **Milestone offload:** dispatch `dev-offload.yml` after B3 Step 3 (the full matrix is where the release-build interop is proven across OSes).

## 9. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **B3 root-cause balloons** (deep napi/tokio interop dig) | High | Phase A exoneration shrinks the search space; **time-box** Step 2; the fallback deliverable is a documented finding + `INTEGRATION_LIVE`-gated test, not infinite debugging. The Epic can ship B1/B2 + a characterized-but-gated B3 if the root cause is intractable now. |
| Release is clean but debug stalls → false sense the harness is broken | Med | Step 1 explicitly tests the **release** profile (CI's build); document the debug-build caveat in the test. |
| B1 widens (facade doesn't persist subs) | Med | Confirm `FinnhubStreaming` persists to redb early; if not, the persist write is part of B1 (bounded). |
| Loopback integration test flakiness (timing) | Med | Wait on `streamingCount > 0`; ephemeral port; generous timeouts; one canned frame; full teardown. |
| B2 logs leak frame contents | Med (redaction) | Log **byte length only**; code-review gate. |

## 10. Success criteria

1. **B1:** `FinnhubDriver` reads subscriptions fresh from redb on every `connect_once`; a Rust test proves persisted subs survive a simulated reconnect. Facade persists subscribe/unsubscribe to the host table.
2. **B2:** `YahooDriver` emits a `debug`-level, **length-only** log for undecodable frames; existing Yahoo tests green.
3. **B3:** the Node↔Rust loopback path is characterized (release vs debug); a **deterministic integration test** asserts a frame round-trips `Node ws → Rust driver → TSFN → on_pricing` with exact integrity and runs in the CI integration tier (or, if root cause is intractable, a documented finding + a gated test + Epic-open note).
4. Full Rust gate green single-threaded; clippy `-D warnings` clean; TS gate green; verified on the remote matrix via a `dev-offload.yml` dispatch.
5. ROADMAP updated: B1/B2/B3 marked done; the Streaming Engine Epic marked **closed** (interop closure achieved) or explicitly **open-pending-B3** with the documented finding; only the `corelib-streaming` crate lift remains deferred.
