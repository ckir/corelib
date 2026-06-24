# Monorepo Optimization Audit — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorm complete; rev 2 — agy spec-review folded) — ready for implementation plan
**Type:** Audit cycle (produces a findings backlog; ships no fixes)

---

## 1. Context & Motivation

The corelib monorepo (`ts-core` = `@ckirg/corelib`, `ts-markets`, `ts-cloud`, and the private
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

**Goal:** a single audit pass that produces a **prioritized, evidenced findings backlog**. A durable,
re-runnable probe is **mandatory only for findings rated `confidence = confirmed-by-probe`**; findings
established by static analysis sit in the backlog as `confirmed-by-reading` with **no harness
required** (this caps probe-authoring scope — see §7, §9).

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

**Stopping rule & budget envelope (every non-deterministic probe).** To keep probes bounded and CI
budgets finite, each non-deterministic probe adopts a uniform execution envelope:

- **Budget cap** — default ≤ 20 000 iterations *or* ≤ 20 s of continuous run-time (a probe may
  override with a one-line justification in its header).
- **Exit-early on confirmation** — stop and report success on the **first** occurrence of the targeted
  faulty behavioral outcome.
- **Budget-exhausted ≠ proven-absent** — if the cap is reached without reproducing the outcome, the
  probe reports `0 / N` and exits `0`, and the finding is classified **`suspected` / unconfirmed
  under this profile** — *never* "confirmed absent." Per §3.1, absence of reproduction is not proof of
  absence; it bounds effort, it does not clear the suspect.
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
| **Phase 0 — Static sweep** | Whole repo: logger-contract conformance + cross-package import graph (does `ts-markets`/`ts-cloud` import **only** `ts-core`; any layering reach-arounds; any `console.*` in app code; raw `Error` placed in `extras` without `serializeError()`). **Plus the isomorphic-import denylist** (§4.1): `ts-core` files reachable from edge/Bun/Deno entry points must not import Node-only built-ins (`node:fs`, `node:path`, `node:module`, raw `fs`/`path`, etc.) outside runtime-guarded branches. | architecture-conformance |
| **Z-Boot** (`ts-core`) | `ConfigManager` singleton & `initialize(args?)` ordering, per-runtime logger factories (module state), `RequestUnlimited` retry/abort/backoff, runtime detection — **including dynamic cross-runtime behavior** (do Node-only paths stay unreachable under Bun/Deno/edge?). | races, runtime-isomorphism, perf |
| **Z-FFI** (the N-API threshold) | Thread transitions across the boundary, `threadsafe_function` callback queues, JS-GC ↔ Rust-`Drop` lifecycle, **callback-deadlock / re-entrancy starvation** (see §8), serialization cost of raw + unified payloads. | races, perf, edge-cases |
| **Z-Engine** (Rust internals) | Concurrent `redb` access, `tokio` channels/mutexes, reconnect/supervisor state machines, the shared dual-mode streaming host + the three provider drivers (Alpaca/Yahoo/Finnhub). | races, perf, edge-cases |
| **Z-Facade** (`ts-markets` / `ts-cloud`) | Layering & transparent-proxy conformance, `wrangler` bundle size, edge cold-start, polling correctness, edge-environment limits, **isomorphic execution** (does the bundled `ts-core` it pulls actually run in the edge/worker sandbox without Node-only escape hatches?). | architecture, perf, edge-cases |

### 4.1 Isomorphic-import denylist (Phase 0)

`AGENTS.md` §1 mandates `ts-core` is multi-runtime-first (Node/Bun/Deno) and `ts-cloud` exposes it to
edge sandboxes. The Phase 0 sweep therefore enforces, statically, that `ts-core` source reachable from
non-Node entry points does **not** hard-depend on Node-only built-ins. The denylist (starting set,
extend during the sweep): `node:fs`, `node:path`, `node:module`, `node:child_process`, `node:os`, and
their bare aliases (`fs`, `path`, `module`, …) — **unless** the import sits behind a runtime guard
(e.g. the `runtime.ts` detection) so the Node-only branch is unreachable under Bun/Deno/edge. A bare
top-level Node-only import in an edge-reachable `ts-core` file is a **finding** (lens:
architecture-conformance; os/runtime-sensitivity: edge-breaking).

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

**Deterministic dedup ownership rule** (drives the correlation sweep — not an aesthetic exercise):

1. **Cluster** suspects by **identity** — the target symbol they implicate (Rust `struct`/`fn` or JS
   `class`/function) plus `file`. Same symbol-identity across records ⇒ candidate duplicate.
2. **Assign a single owner zone** — when a fault chains across a boundary (e.g. surfaces in Z-Facade
   but originates at the FFI threshold), it is owned by the **lowest boundary zone in the chain**
   (`engine` < `ffi` < `boot` < `facade`); the higher zones are recorded as `affected_surfaces`, not
   as separate findings. This yields **exactly one** backlog entry per root fault.
3. **Rank** the deduplicated set by `severity` (only after all zones have reported).

### 6.1 Plan phasing (applied when this spec becomes an implementation plan)

The implementation plan is **split into two sequenced phases** so a single plan does not overwhelm
subagent sessions (mirrors the bootstrap-first sequence):

- **Phase A — Static & isomorphic foundation:** Phase 0 static + isomorphic-import sweep, Z-Boot
  singleton/runtime validations, Z-Facade bundle/cold-start + isomorphic-execution checks, and the
  one-time `/probes/` scaffolding (exclusion config §9.1 + `_harness/` loopback §9.2).
- **Phase B — Concurrency & native FFI:** Z-FFI (callback-deadlock/re-entrancy, §8), Z-Engine
  (concurrent redb, tokio channels/supervisor), loom/TSan integration, the CI-offload trigger
  protocol (§9.3), and the final correlation/dedup/rank synthesis into the backlog.

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

**Probe-requirement rule:** `confidence = confirmed-by-probe` **requires** a non-empty `probe` path
under `/probes/`; `confirmed-by-reading` and `suspected` findings **must not** be blocked on authoring
a harness (they carry `probe: null`). This is the scope cap from §2 — no probe is written to "prove" a
finding that direct code reading already establishes.

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
- Probes assert **behavioral invariants/outcomes** (§3.1), never structural arrangement.

### 9.1 Isolation from the standard test suites

`/probes/` must run *only* when explicitly invoked — never swept by the normal gates:

- **Vitest:** append `'/probes/**'` (and the repo-root `probes/**`) to `exclude` in every package
  `vitest.config.*`, so `**/*.test.ts` collection cannot reach it. Probes run solely via a dedicated
  `vitest -c probes/vitest.config.ts`.
- **Cargo:** the Rust probes live in a **standalone crate `probes/rust/` that is NOT part of any Cargo
  workspace** (the repo has no workspace today — `rust/` is a standalone `[package]`). It depends on the
  core crate by path — `corelib-rust = { path = "../../rust" }`; the `rlib` target links cleanly for a
  plain Rust test binary, and the `#[napi]`/`cdylib` surface resolves its host symbols only at runtime,
  so no Node host is required to build it as a dependency. Isolation is automatic: root cargo commands
  run inside `rust/` and never see the probe crate; **no root workspace is created, so the Rust target
  dir stays at `rust/target` and the release workflow's `rust/target/release/...` paths are untouched.**
  Probes execute via `cargo test --manifest-path probes/rust/Cargo.toml`. (Chosen over a root-workspace
  `default-members` layout — agy "Standalone Vs. Workspace Probes", RECOMMEND-A — to avoid relocating
  `rust/target` and breaking the tag-release paths; honors §9.1's isolation intent.)
- **loom variant:** loom model-checks run against **standalone models of the concurrency pattern placed
  in `probes/rust/`** (re-modelling the lock / channel / teardown logic), **not** by adding
  `#[cfg(loom)]` shims into `corelib-rust` — instrumenting the production crate is itself a change
  deferred to a fix cycle (no-fixes-this-cycle). If a fault genuinely cannot be modelled without in-situ
  loom instrumentation, that is recorded as a finding, not implemented here.

### 9.2 `/probes/_harness/` — deterministic loopback (highest-value infra)

FFI/concurrency probes must **not** depend on live Alpaca/Yahoo/Finnhub sockets (arbitrary delays,
rate limits, no control over timing). A shared in-process **Node TCP/WebSocket mock server** under
`/probes/_harness/` lets probes orchestrate explicit disconnects, block threads on demand, stream raw
recorded tick payloads, and force specific execution timelines — so Rust↔JS behavior is verified
deterministically and offline.

- This is the long-deferred ROADMAP "loopback mock server for Rust-native streaming" item, now built
  as durable audit infra that **outlives the audit** (reusable by every later fix-cycle).
- **Prerequisite / contingency:** the harness requires the Rust streamers to accept an **endpoint
  override** (`localhost:<port>`). **The plan's first task verifies this.** If the streamers already
  support it → proceed. If not, that gap is recorded as a **finding** and the deterministic-FFI probes
  fall back to recorded-frame replay; we do **not** silently add a production endpoint-override change
  under the audit banner (that is a fix → its own later cycle, per the no-fixes-this-cycle rule).

### 9.3 CI-offload trigger & result-reclaim protocol

Heavy runs (loom, nightly-toolchain ThreadSanitizer, long WS stress, benches) offload to CI (low-spec
dev box) via a headless, automatable protocol — no human steps:

1. The local agent writes a stub finding with `confidence = suspected` (annotate `pending-ci`) to
   `.agent/audit_scratchpad.json`.
2. Trigger the workflow: `gh workflow run heavy-probes.yml -f probe=<probe-id> -f commit=<sha>`.
3. Poll run status; on completion pull logs via `gh run view <id> --log` (use `--log-failed` for the
   failing leg), parse the probe's reported statistics (frequency / interleaving / threshold result).
4. Merge the parsed outcome back into the scratchpad — promoting `suspected → confirmed-by-probe` (or
   leaving it `suspected` if budget-exhausted per §3.1), and recording the run id for provenance.

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

**Rev 2 (agy spec-review pass, `ANTIGRAVITY-TO-CLAUDE.md` "Spec Review", verdict
PLAN-READY-WITH-FIXES) folded:** the probe stopping-rule/budget envelope (§3.1), the isomorphic-import
denylist (§4.1) + strengthened Z-Boot/Z-Facade isomorphism, the deterministic dedup ownership rule
(§6), the two-phase (A/B) plan split (§6.1), the `confirmed-by-probe`-only probe scope cap (§2, §7),
the `/probes/` Vitest + cargo `default-members` isolation (§9.1), the `/probes/_harness/` loopback mock
+ endpoint-override contingency (§9.2), and the `gh workflow run` CI-offload trigger/reclaim protocol
(§9.3). Claude sharpenings: dedup framed as a synthesis ownership-rule, budget-exhausted ⇒ `suspected`
(not proven-absent), and endpoint-override verification made the plan's first task.
