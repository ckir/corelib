# Monorepo Optimization Audit — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorm complete) — ready for implementation plan
**Type:** Audit cycle (produces a findings backlog; ships no fixes)

---

## 1. Context & Motivation

The corelib monorepo (`ts-core` = `@ckir/corelib`, `ts-markets`, `ts-cloud`, and the private
Rust N-API crate) grew to its current shape driven by *other-project-needs* — features were added
when a consuming project required them, never as part of a deliberate, audited whole. As a result the
codebase has **never been systematically reviewed** for cross-cutting concerns: concurrency/race
conditions, performance, architecture-conformance, or edge-case correctness.

This cycle performs that review. Restated design intent (the conformance baseline the audit checks
against, per `AGENTS.md` §1):

- **`ts-core`** — a general-purpose, multi-runtime-first library (isomorphic across Node.js, Bun,
  Deno) for use by any project.
- **`ts-markets`** — an extension of `ts-core` for financial/trading projects.
- **`ts-cloud`** — exposes `ts-core` + `ts-markets` functionality to edge environments, within their
  limitations.
- **`rust`** — the private Rust core that powers corelib, exposed via N-API (FFI).

## 2. Goal & Non-Goals

**Goal:** a single audit pass that produces a **prioritized, evidenced findings backlog**, with each
high-value finding **confirmed by a durable, re-runnable probe** where feasible.

**Non-goals (explicit):**

- **No production fixes this cycle.** The audit *finds and confirms*; it does not remediate. Each
  finding-cluster becomes its own later fix spec → plan → implementation cycle.
- **No restructuring of existing folders.** The only new top-level directory introduced is
  `/probes/`. Existing package/folder layout is left untouched.
- **No re-litigation of the documented architecture.** `AGENTS.md` §1 is the conformance oracle;
  the audit measures *drift from it*, it does not redesign it.

## 3. Key Definitions (read before everything else)

### 3.1 Reproducibility = behavioral-outcome equivalence

Throughout this audit, **"reproducible" means producing the same _behavioral outcome_, regardless of
how the underlying binary or code is arranged.** It does **not** mean a byte-identical or structurally
identical result.

- A probe *reproduces* a fault when it **reliably elicits the faulty behavior** — a deadlock, a
  corrupted/`redb` state, a dropped or mis-ordered event, task starvation, or a latency/throughput
  regression past a defined threshold — irrespective of thread scheduling, allocation order, or code
  layout.
- For **non-deterministic** faults, "reproduced" is probabilistic: the probe records the **observed
  frequency** (e.g. "12 / 10 000 interleavings") and, where a model-checker (loom) is used, the
  **specific offending interleaving**. A 1-in-N intermittent failure still *confirms* the fault.
- This is **distinct from — and must not be confused with — the SHAPE-DIVERGENCE rule** (data/wire/
  serialization formats are byte-exact contracts). That structural-exactness rule applies **only** to
  serialization/FFI encoding contracts (e.g. a timestamp that must stay an RFC3339 string, an FFI
  struct's field types). It is the **wrong lens** for race/perf/edge-case findings, which are
  behavioral by nature.

**Consequence for durable probes:** because a probe pins an *outcome*, it survives correctly into the
later fix-cycle — a structural refactor that *preserves* the bug still trips the probe; a correct fix
that merely *rearranges* code does **not** false-trip it. A structure-pinning probe would do the
opposite (rot on every refactor, miss layout-preserving bugs). Behavioral-outcome reproducibility is
precisely what makes durable probes worth keeping.

### 3.2 Lenses

Every finding is tagged with one or more of four lenses. All four are in scope; **relative priority is
ranked _after_ the findings land**, not pre-committed.

1. **Concurrency / races** — async ordering, shared mutable state, FFI thread-safety, concurrent
   `redb` access, reconnect/teardown/`Drop` races, re-entrancy.
2. **Performance** — hot paths, allocations, serialization cost across the FFI boundary, edge
   cold-start, bundle size, retry/backoff overhead.
3. **Architecture-conformance** — drift from `AGENTS.md` §1: multi-runtime isomorphism, the
   ts-markets/ts-cloud → **ts-core-only** dependency direction, the strict logger API,
   `RequestUnlimited` for all external HTTP, the transparent-proxy pattern, rust-as-private-core.
4. **Edge-case correctness** — error handling & propagation, resource cleanup (`Drop`/teardown),
   reconnect/resume durability, boundary conditions, panic→JS propagation.

## 4. Partitioning — Boundary-First (zones)

Partition by **inter-system boundary (friction interface)**, not by package or by lens. The nastiest,
most-invisible faults live *at* a boundary, not inside either side of it — so each boundary is its own
first-class audit zone.

| Zone | Surface | Primary lenses |
|---|---|---|
| **Phase 0 — Static sweep** | Whole repo: logger-contract conformance + cross-package import graph (does `ts-markets`/`ts-cloud` import **only** `ts-core`; any layering reach-arounds; any `console.*` in app code; raw `Error` placed in `extras` without `serializeError()`). | architecture-conformance |
| **Z-Boot** (`ts-core`) | `ConfigManager` singleton & `initialize(args?)` ordering, per-runtime logger factories (module state), `RequestUnlimited` retry/abort/backoff, runtime detection. | races, runtime-isomorphism, perf |
| **Z-FFI** (the N-API threshold) | Thread transitions across the boundary, `threadsafe_function` callback queues, JS-GC ↔ Rust-`Drop` lifecycle, **callback-deadlock / re-entrancy starvation** (see §8), serialization cost of raw + unified payloads. | races, perf, edge-cases |
| **Z-Engine** (Rust internals) | Concurrent `redb` access, `tokio` channels/mutexes, reconnect/supervisor state machines, the shared dual-mode streaming host + the three provider drivers (Alpaca/Yahoo/Finnhub). | races, perf, edge-cases |
| **Z-Facade** (`ts-markets` / `ts-cloud`) | Layering & transparent-proxy conformance, `wrangler` bundle size, edge cold-start, polling correctness, edge-environment limits. | architecture, perf, edge-cases |

## 5. Sequencing — Bootstrap-First

Order is deliberate: **establish JS-side determinism before auditing anything downstream of it.**
`ConfigManager`/logger outputs feed args *down* the FFI bridge; if JS-side startup is racy it injects
poisoned inputs that make Rust stress-results **non-deterministic and untrustworthy** — so the boot
layer is stabilized first.

```
Phase 0 (Static sweep)
   → Z-Boot (ts-core singletons / runtime)
      → Z-FFI (N-API threshold probes)
         → Z-Engine (Rust concurrency stress)
            → Synthesize (correlate · dedup · rank)
```

## 6. Execution Model

**Subagent-driven, bottom-up model-gated** (per the global CODING SUBAGENT RULES):

- **Haiku** — import-graph sweeps, logger-contract grep sweeps, reference collection, mechanical
  enumeration (low judgment, high volume).
- **Sonnet** — contained concurrency/perf reads of a single module, well-specified probe authoring
  against a named behavioral oracle, reviewing a probe diff.
- **Opus (main thread)** — Z-FFI and Z-Engine reasoning (re-entrancy, lifecycle, lock ordering),
  cross-zone correlation, ranking. Spawn Opus subagents only for parallel disjoint zones.
- Error-cost rider: financial-streaming / FFI work bumps a tier and is verified harder.

**Disjoint zones are parallelizable.** Every subagent logs each suspect **immediately** to a shared,
gitignored register `.agent/audit_scratchpad.json` (append-only finding records). The main thread then
runs a **correlation / dedup / rank sweep** so a single cross-system fault does not land as three
disconnected backlog entries.

**agy-first cadence continues during execution** (per `AGENTS.md` §250, §268): a divergent agy relay
at each **phase boundary** (Phase 0 → Z-Boot → Z-FFI → Z-Engine → synthesize). agy's view and Claude's
view are presented attributed; the user decides; final approval is never delegated to agy.

## 7. Finding Schema

Each finding (in `.agent/audit_scratchpad.json` during the run, promoted to the backlog doc at
synthesis) carries:

| Field | Values / meaning |
|---|---|
| `id` | stable slug, e.g. `ffi-reentrancy-deadlock-01` |
| `zone` | `phase0` \| `boot` \| `ffi` \| `engine` \| `facade` |
| `lenses` | subset of {races, perf, arch, edge} |
| `severity` | `impact × likelihood` → `critical` \| `high` \| `medium` \| `low` |
| `confidence` | `confirmed-by-probe` (behavioral, per §3.1) \| `confirmed-by-reading` \| `suspected` |
| `os_sensitivity` | `windows-only` \| `linux-only` \| `cross-os` — `redb`/SQLite/socket/mutex behavior differs on the Windows dev box vs Linux CI; flag early |
| `testability` | `A` unit-testable \| `B` loom/cargo-modelable \| `C` stress-harness-required \| `D` non-deterministic-e2e |
| `evidence` | `file:line` reference + repro note (observed frequency / interleaving for non-deterministic) |
| `probe` | path under `/probes/` (if a durable harness exists) |
| `fix_sketch` | one-paragraph remediation direction (NOT implemented this cycle) |
| `fix_cycle` | pointer/placeholder for the future fix spec→plan→cycle |

## 8. The N-API Re-entrancy / Callback-Deadlock Blindspot

Called out as a first-class Z-FFI target (surfaced by agy's divergent pass): the dominant risk is not
pure Rust-engine concurrency nor simple TS module mutation — it is **uncoordinated execution looping
across the FFI threshold**. If Rust invokes JS callbacks via `threadsafe_function` while the Node main
thread is blocked waiting on an active synchronous FFI call, the JS callback queue cannot drain and
the Rust native queue cannot empty → **permanent deadlock that bypasses Vitest's limits and fails
silently with zero logs**.

A dedicated `/probes/` harness simulates **concurrent reconnect operations firing during
high-frequency GC sweeps**, pressure-testing N-API state integrity and callback-queue liveness under
load. The behavioral oracle: the bridge transitions gracefully (no hang, no dropped/duplicated events)
within a bounded time budget.

## 9. Probe Policy — Durable `/probes/`

- All confirming probes (stress harnesses, loom models, FFI re-entrancy repros, micro-benchmarks) are
  **checked into a single new top-level `/probes/` directory** and **linked from their finding** as a
  live, re-runnable verification harness. (User decision: start fully durable; prune/edit later with
  cause. Minimal folder-structure change — `/probes/` is the only new directory.)
- `/probes/` is **excluded from ordinary test sweeps** (Vitest config override + outside the Rust
  crate's default `cargo test` scope) so it does not affect pipeline build speed.
- Probes assert **behavioral invariants/outcomes** (§3.1), never structural arrangement.
- **Heavy runs offload to CI** (the dev box is low-spec): loom model-checks, nightly-toolchain
  ThreadSanitizer, stress harnesses, and benches run via a temporary/opt-in CI workflow; the finding
  records the probe + observed result so it is reproducible (behaviorally) without re-deriving it.

## 10. Deliverables

1. **Findings backlog** — `docs/superpowers/audits/2026-06-13-monorepo-audit-findings.md`: the ranked,
   deduplicated finding records (schema §7).
2. **`/probes/`** — durable, linked verification harnesses for confirmed findings.
3. **ROADMAP seeding** — the top finding-clusters added to `ROADMAP.md` as future fix cycles, each its
   own spec→plan→implementation cycle.

## 11. Out of Scope / Deferred

- **Any remediation.** Fixes are explicitly deferred to per-cluster cycles spawned from the backlog.
- **The deferred (b-2) capstone audit** overlaps this cycle's correctness lens; this audit may
  *subsume or feed* (b-2) — reconcile at synthesis, do not run both blindly.
- **(a) trace/flight-recording retro-instrumentation** remains its own roadmap item; if the audit
  finds the lack of instrumentation *is itself* a blindspot for confirming a fault, that is recorded
  as a finding, not fixed here.

## 12. Provenance

Design produced via the brainstorming skill with a mandatory agy-first divergent pass
(`ANTIGRAVITY-TO-CLAUDE.md`, 2026-06-13 "Monorepo Audit Approach"). Folded from agy: boundary-first
partitioning, bootstrap-first sequencing, the shared-register + correlation-sweep execution model, the
`os_sensitivity` + `testability` schema fields, durable `/probes/`, and the N-API callback-deadlock
blindspot (§8). User rulings: audit→backlog shape, all-four-lenses, probes-allowed-everywhere, durable
probes, minimal folder change, and the behavioral-outcome **Reproducibility** definition (§3.1).
