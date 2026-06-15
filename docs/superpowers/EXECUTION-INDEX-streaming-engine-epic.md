# Streaming Engine Epic — EXECUTION INDEX (survives session reset)

**Purpose:** strict, durable task tracker for executing Phase A then Phase B. On any session resume, READ THIS FIRST.

**Branch:** `worktree-epic5-capstone-audit` (worktree at `.claude/worktrees/epic5-capstone-audit`).
**Execution method:** subagent-driven-development (fresh implementer subagent per task with FULL task text from the plan; then spec-review + code-quality-review; then tick this index). agy review available anytime.
**Plans (source of truth — give subagents the full task text from these):**
- Phase A: `docs/superpowers/plans/2026-06-15-phase-a-streaming-engine-module-boundary.md`
- Phase B: `docs/superpowers/plans/2026-06-15-streaming-engine-epic-phase-b.md`
**Specs:** `docs/superpowers/specs/2026-06-15-phase-a-streaming-engine-module-boundary-design.md`, `…/2026-06-15-streaming-engine-epic-phase-b-design.md`

## RESUME PROTOCOL (on session reset)
1. Read this index. Run `git log --oneline -25` on this branch; confirm the SHAs of DONE tasks are present.
2. Find the first task with status `PENDING` or `IN-PROGRESS`. If `IN-PROGRESS`, inspect the working tree (`git status`, `git diff`) to see how far it got; re-verify or finish it.
3. Continue subagent-driven from there. Gates below MUST pass per task before marking DONE.
4. After each task: update its row (status → DONE + commit SHA), commit this index, optionally push.

## GATES (every code task)
- Rust: `cd rust && cargo test -- --test-threads=1` (single-thread MANDATORY — global flight-recorder ring) + `cargo clippy --all-targets -- -D warnings`.
- TS (when TS touched / index.d.ts may change): `pnpm verify:fast`.
- Task A1 contract gate: `rust/index.d.ts` UNCHANGED for the 3 payload objects.

## SEQUENCING
Phase A fully, THEN Phase B. (Phase A exonerates the engine → de-risks Phase B Task 4 / B3.) B1 (Phase B Task 1) adds `db`/`table` to `FinnhubDriver`, which BREAKS Phase A Task 4's `FinnhubDriver{…}` literal — Phase B Task 1 Step 7 fixes that literal in-commit.

---

## PHASE A — module boundary (6 tasks)

| # | Task | Key files | Status | Commit |
|---|---|---|---|---|
| A1 | napi feature + `compile_error!` + `cfg_attr` the 5 wire types | `rust/Cargo.toml`, `rust/src/lib.rs`, `core/types.rs`, `yahoo_streaming_proto_handler.rs` | ✅ DONE | `2127b6e1` |
| A2 | boundary lint test | `rust/tests/streaming_boundary_lint.rs` | PENDING | |
| A3 | Alpaca pure-Rust loopback delivery test | `alpaca/alpaca_driver.rs` | PENDING | |
| A4 | Finnhub pure-Rust loopback delivery test | `finnhub/finnhub_driver.rs` | PENDING | |
| A5 | Yahoo pure-Rust loopback delivery test | `yahoo/yahoo_driver.rs` | PENDING | |
| A6 | rustdoc boundary note + ROADMAP Phase-A-done | `core/mod.rs`, `ROADMAP.md` | PENDING | |

**After Phase A:** milestone `dev-offload.yml` dispatch (if committed; else no-op). Consider `git push`.

## PHASE B — companion (5 tasks; plan Task numbers)

| # | Task | Key files | Status | Commit |
|---|---|---|---|---|
| B-T1 | FinnhubDriver reads subs fresh from redb (+ `load_subscriptions`, +`db`/`table` fields, + unit + no-resurrection loopback tests). **Fix Phase A A4 `FinnhubDriver{}` literal here.** | `finnhub/finnhub_driver.rs` | PENDING | |
| B-T2 | Wire Finnhub facade: `db: g.host.db_handle(), table: g.host.table_name()` | `finnhub/finnhub_streamer.rs` | PENDING | |
| B-T3 | Yahoo undecodable-frame debug log (length-only) + tracing-capture test | `yahoo/yahoo_driver.rs` | PENDING | |
| B-T4 | Deterministic Node↔Rust loopback delivery test (integration tier) + characterize/root-cause if RED | `ts-markets/tests/integration/alpaca-loopback-delivery.integration.test.ts` (+ `_harness/` copy fallback; + finding doc if RED) | PENDING | |
| B-T5 | ROADMAP: B1/B2 done; Epic closed (if B-T4 green on CI) or open-pending-B3 | `ROADMAP.md` | PENDING | |

**Epic closes ONLY when B-T4's release loopback test is green on the standard CI matrix (no `INTEGRATION_LIVE` bypass).** B-T4 root-cause is REQUIRED (fix or positively explain the debug-build stall — not a caveat); time-box the fix effort, escalate to human if it balloons.

## DONE LOG (append one line per completed task)
- A1 `2127b6e1` (2026-06-15): cfg_attr 5 wire types + napi feature + compile_error guard. 95 tests green, index.d.ts unchanged, clippy clean, no shape divergence.
