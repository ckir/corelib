# Epic 5 — Capstone Audit Probe Registry

Index of Epic-5 audit probes: id → path → cluster → how to run. Findings are recorded via
`node probes/tools/scratchpad.mjs add …` and ranked by `probes/tools/synthesize.mjs`.

**Spec:** `docs/superpowers/specs/2026-06-14-epic5-capstone-audit-design.md`
**Plan:** `docs/superpowers/plans/2026-06-14-epic5-capstone-audit.md`

## Running probes

- **Local JS probe (vitest):** `pnpm exec vitest run -c probes/vitest.config.ts probes/js/<id>.probe.test.ts`
- **Local Rust probe:** `cargo test --manifest-path probes/rust/Cargo.toml <name> -- --nocapture`
- **Heavy / CI (on-demand):** `gh workflow run heavy-probes.yml --ref <branch> -f probe=<id> -f commit=<sha>` then `gh run watch`.
  - Rust probe id → cargo test name (e.g. `shutdown_exit_under_load`).
  - JS/soak probe id → `js:<path> <flags>` (e.g. `js:probes/_harness/soak-runner.mjs --rate 20000 --duration 90000`).
    The `js:` branch of the workflow runs `pnpm build-all`, copies the freshly-built native binding to
    `ts-core/corelib-rust.node`, then runs the `.mjs` entrypoint (path + flags word-split, unquoted).

## Machine-parseable output contract

Probes print one line: `PROBE_CONFIRMED <id> <metric>` when a defect reproduces, else `PROBE_CLEAN <id> <metric>`.
The CI workflow appends `RESULT probe=<id> outcome=confirmed|not-reproduced`.

## Hard-gate thresholds (fix-inline trigger)

- Memory: post-GC V8 heap delta ≥ 1 MB **or** native RSS delta ≥ 5 MB (absolute, NOT extrapolated).
- Event-loop block: > 50 ms p99 (hard) / 10 ms (soft).
- Crash / hang / data-integrity / security: binary.

## Registry

| id | path | cluster | run |
| :-- | :-- | :-- | :-- |
| `soak` (steady) | `probes/_harness/soak-runner.mjs` | 3 (heap/leak) | `gh workflow run heavy-probes.yml --ref <branch> -f probe="js:probes/_harness/soak-runner.mjs --rate 20000 --duration 90000" -f commit=<sha>` |
| `soak` (bursty) | `probes/_harness/soak-runner.mjs` | 3 (fragmentation) | as above + `--bursty` |

_Phase 2–4 probes (tsfn-queue, transport-backpressure, shutdown-exit, multi-host-churn, correlation-id,
router-input-safety, dep-audit) are appended here as each task lands._

## Harness pieces (Phase 1)

- `rust` load generator: env-gated `napiLoadGenerator(rate, duration, bursty, cb)` (`CORELIB_LOADGEN=1`).
- `rust` latency ring: `napiLatencyAck(seq)` / `napiLatencyDrain(cb)` (Rust-side roundtrip-token timing).
- `probes/_harness/soak-runner.mjs` + `soak-child.mjs`: bare-node constrained-heap soak (post-GC absolute deltas).
