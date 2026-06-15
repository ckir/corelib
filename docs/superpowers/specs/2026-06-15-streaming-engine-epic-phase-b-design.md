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

**Unsubscribe-resurrection trap (required, agy convergent 🟡):** because `connect_once` reads redb fresh, an `unsubscribe` followed immediately by a reconnect must NOT resurrect the dropped symbol. The facade's `unsubscribe` redb delete must **commit synchronously before** the supervisor's next `connect_once` can read — i.e. the delete is a committed redb write-txn, not a lazy/async write. redb txns are synchronous + durable on `commit()`, so the requirement is simply that the facade commits the delete inline (matching Alpaca/Yahoo, which already use this fresh-read pattern). The plan must add a test for: persist A+B → unsubscribe B (commit) → second `connect_once` re-sends only A.

**Oracle:** a Rust driver test seeding redb + asserting `load_subscriptions()` returns the persisted bare keys (mirror `yahoo_driver.rs::driver_tests::load_subscriptions_reads_bare_keys`); a reconnect-resume assertion (persisted subs re-sent on a second `connect_once`); and the unsubscribe-no-resurrection test above.

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

**Oracle (automated — agy convergent 🟡, upgraded from code-review):** a Rust test using a capturing `tracing` subscriber (e.g. a custom `tracing_subscriber` layer collecting events, or `tracing-test` if added as a dev-dep) that drives an undecodable frame through the pump/mapper path and asserts: (1) exactly one `debug` event on target `corelib_rust::stream`; (2) the recorded `bytes` field equals the input length; (3) the captured event contains **no** substring of the original frame/base64 (redaction proof). This guards against a future refactor silently dropping the log or leaking contents.

## 6. B3 (b) — Node↔Rust cross-runtime interop closure (the load-bearing item)

**Objective:** turn the existing non-asserting `AlpacaLoopbackServer` ↔ real-`AlpacaStreaming` path into a **deterministic, CI-gated** assertion that a known frame round-trips end-to-end with exact integrity — and fix whatever currently makes `RECEIVED=0` so it passes reliably.

**Step 0 — Config-mapping + secret guard (do before any networked run; agy convergent 🔴).** Verify that the `AlpacaStreaming` JS config's endpoint override (`baseUrl`) actually reaches the Rust `base_url` field (check the facade's config mapping / serde rename, as `finnhub-no-endpoint-override` did for Finnhub). **If the mapping is absent, the loopback test would silently connect to the production Alpaca endpoint** — a failure and a credential-exposure path. The mapping's existence is a precondition for Steps 1-3; adding it (if missing) is part of B3. The B3 test MUST construct `AlpacaStreaming` with **hardcoded dummy credentials** and MUST NOT read `APCA_*` env vars, so production keys cannot enter the test even if the override regressed.

**Step 1 — Characterize release vs debug.** Run the existing `transport-backpressure-child.mjs` / a minimal driver harness against BOTH a **release** `napi build` (the CI profile) AND a **debug** build, on Linux and Windows. Record `STREAM_READY` and `RECEIVED` for each. Possible findings: release-clean+debug-clean; release-clean+debug-stalls (the probe's recorded Windows hypothesis); or both-drop. Whichever profile drops, proceed to Step 2 — characterization scopes the dig, it does not end the item.

**Step 2 — Root-cause the stall (REQUIRED whenever any profile drops; agy convergent 🔴).** Root-causing is **not** optional even if release is clean: the probe's hypothesis is a tokio-timer-driver stall after the first connection attempt on the Windows debug build, and timer/thread starvation across the napi boundary can be latent on release under load — and local developers iterate on debug builds, so a test that silently stalls there is a productivity trap. With Phase A having exonerated the engine (the Rust driver delivers `CoreEvent`s against a Rust loopback), the fault is isolated to the napi/Node boundary. Investigate, in order of likelihood: the supervisor's reconnect/timer scheduling under the napi `tokio_rt`; the `ThreadsafeFunction` delivery (the bounded-1024 NonBlocking path from Epic 5) under the loopback's timing; the Node-`ws` ↔ tokio-tungstenite handshake/framing. **Acceptable outcomes: (i) fix it, or (ii) positively identify it as a benign, documented profile-specific artifact** (e.g. a known napi-rs debug-build behaviour) — NOT "observe `RECEIVED=0` and add a caveat." **Time-box** the dig (see Risks); the time-box bounds the *fix effort*, not the requirement to understand the cause.

**Step 3 — Promote to a deterministic CI test.** Add a new integration test under `ts-markets/tests/integration/` (sibling to `AlpacaStreaming.live.integration.test.ts`) that:
1. Starts `AlpacaLoopbackServer` (reuse `probes/_harness/alpaca-loopback.mjs`).
2. Constructs a real `AlpacaStreaming` pointed at `server.url` via the `baseUrl`/`base_url` config override, with **dummy credentials** (the loopback's auth ack is unconditional).
3. Subscribes a symbol; the server streams one canned trade frame (`streamTradeAll("AAPL", …)` once `streamingCount > 0`).
4. **Asserts** the `on_pricing` callback fires within a timeout with the exact payload (`symbol === "AAPL"`, expected price), and tears down cleanly (no leaked sockets/threads).

This test runs in the **standard integration tier** (not `INTEGRATION_LIVE`-gated) so it gates CI — *that* is the interop closure. It asserts against the release addon the CI matrix builds; per Step 2 the debug-build behaviour must be fixed or positively explained, not merely caveated.

**Determinism requirements:** bind `127.0.0.1:0`; wait on `streamingCount > 0` before streaming (no fixed sleeps); generous per-step timeouts; one canned frame; full teardown in `afterEach`/`finally`. Redaction: dummy keys only; assert on shapes/values, never log URLs-with-creds.

**Acceptance for the Epic (agy convergent 🟡 — no bypass):** the Epic closes **only** when this deterministic test is green on the standard CI matrix **without** the `INTEGRATION_LIVE` bypass. The Step-2 time-box fallback (a documented finding + an `INTEGRATION_LIVE`-gated test) may unblock dependent work, but it leaves **B3 OPEN** — it is never a basis for declaring the Epic closed. The cross-runtime interop is the single highest-value deliverable of this Epic.

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

B1 and B2 are independent and can land in either order. B3 **should follow Phase A's merge** — not for compilation (Phase A does not change the JS-facing API or the `AlpacaPricingData` shape, so B3 compiles against today's facade) but for the **fault-isolation leverage**: the merged pure-Rust loopback proves the engine delivers, so any B3 failure is the napi/Node boundary. The Epic does not close until B3 Step 3 is green on the standard CI matrix (no `INTEGRATION_LIVE` bypass).

## 8. Verification & gates

- **Rust:** `cd rust && cargo test -- --test-threads=1` (single-threaded mandatory); `cargo clippy --all-targets -- -D warnings`.
- **TS:** `pnpm verify:fast` for the touched TS; the new B3 integration test runs in the integration tier.
- **B1 oracle:** Finnhub `load_subscriptions` + reconnect-resume Rust tests.
- **B3 oracle:** the deterministic loopback integration test asserting frame round-trip with exact integrity.
- **Milestone offload:** dispatch `dev-offload.yml` after B3 Step 3 (the full matrix is where the release-build interop is proven across OSes).

## 9. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **B3 root-cause balloons** (deep napi/tokio interop dig) | High | Phase A exoneration shrinks the search space; **time-box the FIX effort** (not the requirement to understand the cause). If the fix is intractable now, the fallback is a documented finding + an `INTEGRATION_LIVE`-gated test that **unblocks dependent work but leaves B3/the Epic OPEN** — never a basis to close the Epic. |
| Release clean but debug stalls silently → local-dev productivity trap | Med→High | Step 1 tests BOTH profiles; Step 2 **requires** fixing or positively explaining the debug stall — a caveat alone is not acceptable (agy 🔴). |
| `baseUrl` override not mapped to Rust `base_url` → test hits PROD Alpaca | High (secret) | Step 0 verifies the mapping before any networked run; the test uses hardcoded dummy creds and never reads `APCA_*` env (agy 🔴). |
| B1 unsubscribe-then-reconnect resurrects a dropped symbol | Med | Facade `unsubscribe` commits the redb delete **inline** before the supervisor can re-read (§4); covered by the no-resurrection test. |
| B1 widens (facade doesn't persist subs) | Med | Confirm `FinnhubStreaming` persists to redb early; if not, the persist write is part of B1 (bounded). |
| Loopback integration test flakiness (timing) | Med | Wait on `streamingCount > 0`; ephemeral port; generous timeouts; one canned frame; full teardown. |
| B2 logs leak frame contents | Med (redaction) | Log **byte length only**; automated tracing-capture test asserts no-contents (§5). |

## 10. Success criteria

1. **B1:** `FinnhubDriver` reads subscriptions fresh from redb on every `connect_once`; a Rust test proves persisted subs survive a simulated reconnect. Facade persists subscribe/unsubscribe to the host table.
2. **B2:** `YahooDriver` emits a `debug`-level, **length-only** log for undecodable frames; an automated tracing-capture test asserts the event fires, `bytes` matches, and no payload contents leak.
3. **B3:** the `baseUrl`→`base_url` mapping is verified (Step 0); the path is characterized on release AND debug; the debug stall is fixed or positively explained (not caveated); and a **deterministic integration test** asserts a frame round-trips `Node ws → Rust driver → TSFN → on_pricing` with exact integrity, green on the **standard** CI matrix (no `INTEGRATION_LIVE` bypass).
4. Full Rust gate green single-threaded; clippy `-D warnings` clean; TS gate green; verified on the remote matrix via a `dev-offload.yml` dispatch.
5. ROADMAP updated: B1/B2 marked done; the Streaming Engine Epic marked **closed** only when B3's standard-CI test is green — otherwise **open-pending-B3** with the documented finding. Only the `corelib-streaming` crate lift remains deferred beyond that.
