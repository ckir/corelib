# Epic 5 — Capstone Global Audit (gated-hybrid, CI-resident probes) — Design Spec

**Date:** 2026-06-14
**Epic:** 5 (roadmap subproject **(b-2)**; the capstone — follows Epics 1–4 and the (b-1)/(d)/(c)/(a) subprojects, all done)
**Status:** IMPLEMENTED (2026-06-15) — all 5 clusters probed; 2 hard-gate criticals fixed inline (unbounded streaming TSFN → bounded 1024; prod axios SSRF/credential-leak → vestigial @alpacahq/alpaca-trade-api pruned); soak confirmed NOT-a-leak; clippy gate tightened to -D warnings. Findings: `docs/superpowers/audits/2026-06-15-epic5-capstone-findings.md`.
**Owner files:** whole monorepo, audited by cluster (see Scope); new harness under `probes/**` + a new `.github/workflows/epic5-probes.yml`
**Decisions folded:** Scope = **broad capstone** (user, over agy's narrow FFI-seam-only proposal). Cycle = **gated-hybrid** (user + agy). Heavy probes run **on GitHub Actions, on-demand `workflow_dispatch` only** (no nightly), triggered by Claude (user). agy divergent pass (`AGY-EPIC5-DIVERGENT.md`) shaped the gated-hybrid + the FFI-seam-as-feedback-loop framing; agy convergent pass (`AGY-EPIC5-CONVERGENT.md`) folded — see "agy review record".

---

## Goal

Perform a **full correctness / architecture / edge-case review over the now-complete, tested, instrumented monorepo** (ROADMAP item b-2), with a bias toward the **Day-N failure modes of a market-data library that runs for days**: FFI-seam backpressure, memory growth/leak under sustained streaming, shutdown/lifecycle correctness, and observability completeness — plus a breadth pass over architecture, cloud routers, and dependencies.

This is the capstone: it was deliberately sequenced last so it audits an **instrumented** codebase (Epic 4's flight recorder + §12 tracing are the measurement substrate). The cycle produces a durable, ranked findings backlog + probe corpus, and fixes **only** the confirmed criticals inline.

## Current state (the gap this closes)

- Epics 1–3 closed all 28 findings of the 2026-06-13 boundary-first/bootstrap-first audit (boot, input/env safety, edge-compat). Epic 4 added §12 tracing + the Rust lock-free ring-buffer flight recorder.
- **Unprobed residuals** carried forward (ROADMAP §"Carry-forward"): FFI backpressure / event-loop starvation under flood; long-running marshaling memory-leak profile. Plus Epic-4 deferrals: correlation-ID propagation; channel queue-latency / socket-buffer probes.
- No probe yet exercises the **TS↔Rust seam as a live feedback loop** under sustained synthetic load. That is this epic's spine.

## Approach (decided)

**Gated-hybrid, CI-resident.** Probe broadly across five clusters; classify each finding against an objective **hard gate**; fix only hard-gate findings inline (with their reproducing probe); backlog everything else as a durable probe + regression test. Heavy probe execution lives in an on-demand GitHub Actions workflow so the developer's machine only runs the lightweight fast-gate probes + authoring.

---

## Scope — the five audit clusters

> Cluster boundaries are de-duplicated per the agy convergent review: **all memory/heap/leak/fragmentation profiling lives in Cluster 3**; Cluster 1 owns backpressure / TSFN-queue / transport only.

### Cluster 1 — FFI-seam runtime resiliency (the spine)
- Backpressure propagation under load: V8 event-loop block → N-API ThreadsafeFunction (TSFN) queue → does the Rust producer receive backpressure (TCP / try-push signal), or push blindly?
- **Central probe + hypothesis:** napi TSFN queues default **unbounded** (`max_queue_size = 0`). Under a sustained flood while the JS loop is blocked, a fast Rust producer can pile up napi contexts **off-heap → native OOM before the V8 heap limit is hit**. Probe the actual `max_queue_size` of the streaming TSFNs and whether `Blocking` call-mode actually backpressures. **Candidate fix IF confirmed:** cap the queue + propagate a try-push backpressure signal to Rust. (Not pre-mandated — gated-hybrid.)
- Transport behavior under a starved pump: does the WebSocket client apply TCP backpressure, drop, or buffer unboundedly? **Probed via a standalone local WebSocket loopback server** (point a driver at it through the Epic-2 `base_url`/endpoint override) — this is *decoupled* from the in-process FFI flood generator, which deliberately bypasses the network stack and so cannot exercise transport/TCP behavior.

### Cluster 2 — Lifecycle & concurrency correctness
- **Drop / shutdown-EXIT** deadlock or segfault under load: background OS threads (WS IO, redb) or a TSFN blocked on a shutting-down event loop hanging/segfaulting process exit. (Distinct from the reconnect/teardown loom coverage in the audit and the Drop-based teardown of b-1.)
- Multi-host spin-up → flood → drop loop (≈1000×) to surface drop-ordering races and raw-pointer hazards.
- Partial-failure across providers (one provider faults while others stream).
- Residual races beyond Epic 2 (TSFN-under-GC) and the loom reconnect/teardown model.

### Cluster 3 — Long-run soak / leak / memory profile (owns all memory analysis)
- Marshaling memory-leak hunt: per-tick JS string/buffer allocation across napi ref swaps.
- **V8 old-generation fragmentation** over multi-day-equivalent runs (RSS bloat without a classic "lost-reference" leak).
- Cheap redb growth / fd-handle check (**down-weighted** — the subscriptions store is low-churn, written on subscribe/unsubscribe, not per-tick).

### Cluster 4 — Architecture & API coherence + observability
- TS↔Rust seam clarity; the dual-mode raw-payload `#[napi(object)]` seam; error-mapping consistency (HostError → napi::Error → JS).
- **Correlation-ID propagation** (TS → napi → WebSocket). **Constraint (agy):** it cannot ride `AsyncLocalStorage` (TS) or `thread_local!` (Rust) across the FFI seam because tasks jump threads — the trace context must be **explicitly serialized through the boundary**.
- Trace / flight-recorder coverage gaps vs the §12 contract.

### Cluster 5 — Cloud routers + dependency / supply-chain
- Hono router input-validation / error-handling / secret-redaction across AWS / CloudRun / Cloudflare.
- Dependency freshness + vulnerability scan; unused-dep prune.
- Tighten the warn-only Rust lint gate to `cargo clippy -- -D warnings` (clean the 2 known pre-existing warnings first).

---

## The gated hard gate

A finding is **fix-now (inline this epic)** only if it is **(1) reproduced by a deterministic probe AND (2) crosses an objective threshold**:

| Trigger | Threshold |
| --- | --- |
| **Crash / hang** | any abort, `panic`→abort, segfault, or deadlock from normal operation **or shutdown** — binary |
| **Memory (leak)** | **post-GC absolute deltas** (force `global.gc()` at baseline + terminal): V8 heap delta **< 1 MB** and native RSS delta **< 5 MB** over a fixed run. Failing this — or OOM under the constrained-heap soak — is a leak. *(No hourly extrapolation — that false-positives on deferred GC / allocator arenas.)* |
| **Event-loop starvation** | main-thread block **> 50 ms (p99)** under synthetic peak flood (hard gate, robust to runner jitter). A **10 ms** soft-warning is emitted for local micro-starvation but does not gate. |
| **Data integrity** | silent market-event loss/corruption under backpressure (drops without surfacing) — binary |
| **Security** | secret/credential/PII leak (the §12 redaction rule) or auth/validation bypass in a router — binary |

Everything else → **soft gate (backlog):** add a durable probe + regression test to `.agent/audit_scratchpad.json`, rank it in the synthesized backlog (`docs/superpowers/audits/`), defer the fix to a follow-up epic. **Suspected-but-unreproduced → backlog WITH a confirming probe; never fix unverified.**

---

## Tooling

### Reuse (do not rebuild)
- `/probes` harness (vitest + cargo + loom; standalone, not a workspace member).
- `.agent/audit_scratchpad.json` findings register + `probes/tools/scratchpad.mjs` + `probes/tools/synthesize.mjs` ranked-backlog generator.
- Epic 4 flight recorder (`rust/src/observability/**`) and `napi_dump_flight_log`.

### New harness pieces (small, mostly Phase 1)
- **Parametric synthetic load generator** — extend the env-gated `napi_trigger_diagnostic_flood` with `volume / rate / event-shape` parameters **and a bursty/recurrent mode** (spikes → teardown → GC, not just steady flood — steady flood masks fragmentation + timing races). **In-process Rust threads → TSFN directly (no TCP loopback)** so a standard 4-vCPU runner can actually saturate the JS loop.
- **Constrained-heap soak runner** — runs a **precompiled bare-`node` entrypoint** in a spawned child (`node --max-old-space-size=128 --expose-gc compiled_entry.js`; start at 128 MB, calibrate down per the first baseline — see Risks), **not** vitest-under-constraint (the harness itself exceeds the limit at boot). Forces `global.gc()` for baseline/terminal deltas. **Default fixed run:** ~1,000,000 synthetic payloads (or 100 burst-rest cycles of 10k) at peak sustainable throughput — ≈60–90 s: long enough to expose growth/fragmentation, short enough to avoid a CI timeout.
- **Numeric latency-sample path** — a separate numeric ring (NOT the string-formatted flight ring) capturing serialization→delivery durations. **Measure entirely Rust-side via a roundtrip acknowledgment token:** send a lightweight token to JS with the payload; JS immediately acks it back over FFI; Rust measures elapsed against the *same* `Instant`. This avoids both NTP corruption (never wall-clock `now_ms()`) **and** the cross-runtime epoch mismatch — Rust `Instant` and Node `performance.now()`/`hrtime` have different, non-comparable epochs, so durations must never be computed by subtracting one runtime's clock from the other's. A probe dumps percentile distributions.
- **`.github/workflows/epic5-probes.yml`** — `workflow_dispatch` job(s) running the heavy suite. **A skeletal version must be merged to `main` first** (GitHub only recognizes `workflow_dispatch` for workflows present on the default branch) so `gh workflow run epic5-probes.yml --ref <epic5-branch>` can dispatch against the feature branch. **This `main` merge is a controller/user checkpoint** — a worktree subagent cannot self-merge to `main`: the workflow is *authored* in Phase 1, but the controller lands the skeletal file on `main` before any CI dispatch. Standard runner; escalate to a larger runner only if a load target is unmet. No live provider connections (synthetic only) → no secrets on CI.

---

## Execution sequencing (linear, to prevent a non-compiling broad-scope sprawl)

Per the agy convergent review — build the measurement substrate before touching FFI seams:

1. **Phase 1 — Observability & harness:** the numeric/monotonic latency-sample path, flight-recorder hooks, the parametric in-process load generator, the constrained-heap soak runner, and the skeletal `epic5-probes.yml` → `main`. (Cluster 4 instrumentation + tooling.)
2. **Phase 2 — Core seam resiliency & lifecycle:** Cluster 1 (backpressure / TSFN-queue) + Cluster 2 (Drop/shutdown, multi-host loop, partial-failure) + **Cluster 4 architecture** (explicit correlation-ID context-boundary passing, error-mapping consistency — they concern the FFI boundary / connection setup, so they belong here, not orphaned).
3. **Phase 3 — Heap & native safety:** run `pnpm build-all` first (the soak runs a *precompiled* bare-`node` entrypoint), then Cluster 3 soak/leak/fragmentation on the compiled bundle under constrained heap.
4. **Phase 4 — External boundaries:** Cluster 5 (router validation/redaction, dep audit, clippy `-D warnings`).

Within each phase: probe → classify against the hard gate → fix-inline-with-probe (criticals) or backlog (rest).

## CI execution model

Heavy probes run **only** via `gh workflow run epic5-probes.yml --ref <epic5-branch>` (Claude triggers on demand during development — no nightly schedule, not in the per-PR gate). Results watched via `gh run watch`. The lightweight fast-gate probes (and the unit/build gates) run locally / in the normal pipeline as today.

## Deliverables / Definition of Done

1. All 5 clusters probed; `epic5-probes` workflow green on-demand.
2. Every **hard-gate** finding fixed inline **with its verifying probe** — or, if not safely fixable, escalated to the user.
3. Regenerated ranked findings backlog (`docs/superpowers/audits/2026-06-14-epic5-capstone-findings.md`) + durable probes committed; `.agent/audit_scratchpad.json` updated.
4. ROADMAP item **(b-2)** marked done; this spec Status → IMPLEMENTED.
5. Full gate green (typechecks, vitest suites, `cargo test`, build-all, lint).

## Out of scope (deferred — do NOT do this cycle)

- **`corelib-streaming` napi-free engine extraction** (heavy refactor; finstream prerequisite — audit the *running interface*, not a structural separation).
- **Per-provider facade redesign** (Alpaca/Finnhub/Yahoo internals are black boxes; audit only the shared `WebsocketStreamerHost` / `ProviderDriver` / `ReconnectPolicy`).
- **Real multi-day live soak** against real providers (synthetic deterministic load only; live-tier stays gated/manual). The bursty load-generator mode is the stand-in.
- **Nightly/scheduled CI** (on-demand `workflow_dispatch` only, per user).
- General TS perf optimization unrelated to the streaming feed path.

## Risks & open questions

- **Threshold tuning:** the 50 ms / <1 MB V8 / <5 MB RSS lines are defaults; they may need adjustment once the first soak baselines land on the actual runner. Treat the first Phase-1 run as a calibration.
- **Runner saturation:** if a standard 4-vCPU runner cannot drive enough in-process load to expose backpressure, escalate to a larger runner (the generator being in-process Rust makes this unlikely to be needed).
- **False negatives:** continuous flood can mask allocator fragmentation / bursty-timing races — mitigated by the bursty/recurrent generator mode, but a true multi-day live soak remains a (deferred) higher-fidelity check.
- **Broad-scope sprawl:** the single biggest execution risk; mitigated by the linear phase sequencing + the gated-hybrid (inline fixes are few and verified) + subagent-driven per-task review.

## agy review record

- **Divergent (`AGY-EPIC5-DIVERGENT.md`):** proposed the gated-hybrid cycle and the FFI-seam-as-feedback-loop lens (folded); surfaced the Drop/shutdown-exit deadlock vector, V8 old-gen fragmentation, monotonic-clock probe correctness, and the flood-as-load-generator + constrained-heap-OOM acceleration (all folded). Its recommendation to narrow scope to FFI-seam-only was **overridden by the user** in favor of the broad capstone.
- **Convergent (`AGY-EPIC5-CONVERGENT.md`):** 4 blockers folded — (1) post-GC absolute-delta memory thresholds (not hourly extrapolation); (2) constrained-heap soak must run a precompiled bare-`node` child, not the test harness; (3) skeletal `workflow_dispatch` workflow to `main` first; (4) the unbounded-TSFN-queue vector → reframed as Cluster 1's central probe + candidate fix (not a pre-mandated fix). Should-fixes folded: Cluster 1↔3 memory de-dup; correlation-ID via explicit FFI context serialization (not ALS/TLS); 50 ms hard / 10 ms soft loop-block; bursty generator mode; clippy `-D warnings`; and the linear phase sequencing.
- **Spec review (`AGY-EPIC5-SPEC-REVIEW.md`, pre-plan):** verified all 8 convergent findings were encoded correctly; folded 6 plan-readiness edits — (1) Cluster 4 architecture (correlation-ID/error-mapping) added to Phase 2 (was orphaned from the phases); (2) transport-backpressure probe decoupled to a standalone WS loopback server via the Epic-2 endpoint override (the in-process generator bypasses the network); (3) Rust-side roundtrip-token latency measurement (cross-runtime clock epochs aren't comparable); (4) concrete soak workload (~1M payloads / ≈60–90 s); (5) skeletal workflow→`main` reframed as a controller/user checkpoint; (6) Phase 3 `pnpm build-all` pre-step.

## Verify commands

- Local fast gate: `pnpm verify:full` (build-all + all vitest suites); `cd rust && cargo test -- --test-threads=1` (global flight-ring → single-threaded).
- Heavy probes (CI, on-demand): `gh workflow run epic5-probes.yml --ref <epic5-branch>` → `gh run watch`.
- Lint: `pnpm lint-all` (clippy warn-only until Cluster 5 flips it to `-D warnings`).
