# CI-Offload + AI Auto-Fix Loop — Design Spec

- **Date:** 2026-06-13
- **Status:** Approved (design); agy divergent pass complete. Pending final user review.
- **Topic:** A developer workflow that offloads heavy build/test to CI (freeing a low-spec Windows machine) and an AI auto-fix loop that fixes red `main` without the developer manually saying "fix".
- **Review record:** `ANTIGRAVITY-TO-CLAUDE.md` → "2026-06-13 — Dev-workflow: CI-offload + AI auto-fix loop (divergent design)".
- **Proving ground:** corelib (its CI + lefthook are the Phase-1 targets). The auto-fix skill is global/cross-project.

## 1. Goal & context

The developer works on a **low-spec Windows machine** and wants the time/resource-consuming work to run in **CI** so they can develop *other* projects while CI runs. CI failures are surfaced today by GitHub email; the developer wants an **AI auto-fix loop** that fixes a red `main` autonomously (bounded), escalating only when it can't.

Current state:
- CI (`.github/workflows/pipeline.yml`): `validate` → `test` (a **9-cell matrix**: 3 OS × {node,bun,deno}, each runs `napi build --release` + `pnpm build-all` + full tests) → `integration` (3 OS, replay + coverage validator) → docs/release. Triggers on push/PR to `main`.
- Local gate (`lefthook.yml`): pre-commit `pnpm verify:fast` (format+lint+typecheck); pre-push `pnpm verify:full` (build-all + test-all:run). Rust/worker excluded (CI owns them).
- Tooling: Claude Code (CLI, has headless `claude -p`), Antigravity (agy), `gh` CLI, rtk.

## 2. Locked decisions

| # | Fork | Decision | Source |
|---|------|----------|--------|
| D1 | CI trigger model | **Push `main` directly; CI validates post-hoc** (solo-dev trunk). | user |
| D2 | Auto-fix location | **Hybrid** — a local agent fixes using repo context + CI logs; re-validation happens by **pushing to CI**, not by running heavy build/test locally. | user |
| D3 | Escalation policy | **Bounded retries (N=3) → then escalate** with a summary; never an unbounded loop. | user |
| D4 | Local gate weight | **biome format+lint only** locally; typecheck + build + test → CI (see D5). | agy + Claude concur |
| D5 | CI shape | **Split CI into a fast `validate` pre-flight** (single Linux runner, ~1 min: format+lint+typecheck+offline tests) that **gates** the 9-cell matrix (matrix skipped on pre-flight failure). The auto-fixer binds to **pre-flight** failures. | agy (Claude strongly endorses) |
| D6 | Auto-fix tool home | **Claude Code skill** (`/watch-ci`) — the skill-running Claude IS the fixer (no headless `claude -p` spawn). | user |

> **Claude's caveat on D4 (recorded):** dropping local typecheck means **cross-package** type breaks (a `ts-core` change breaking `ts-markets`) surface only after push — the editor LSP doesn't reliably catch those. Accepted because the cheap ~1-min pre-flight lane (D5) + the auto-fixer absorb them cheaply.

## 3. Architecture — Part A: CI pre-flight split + local-gate rebalance

### 3.1 CI pre-flight lane (`pipeline.yml`)
Add a fast `validate` (pre-flight) job — single `ubuntu-latest` runner — that runs, in ~1 minute:
`pnpm lint-all` (biome) + `pnpm typecheck-all` (tsc) + `pnpm test:integration` (MSW **replay**, offline) + `pnpm test:integration:validate`.
Make the heavy jobs depend on it: `test` (the 9-cell matrix), `integration`, `docs`, `build-*` all gain `needs: validate` (or `needs: [validate, test]` as today, with `validate` first). **If pre-flight fails, the matrix never runs** → a typo costs ~1 CI-minute, not a full Rust×3-OS×3-runtime build.

**Offline-only in pre-flight (must):** the pre-flight runs the integration tier strictly in **replay** mode; the live-streaming suites stay `INTEGRATION_LIVE`-gated (already true — they `describe.skipIf(!INTEGRATION_LIVE)`). This guarantees the auto-fixer can never trip on live-API flakiness and "fix" healthy code. Live tier stays on the separate nightly `integration-live.yml`.

### 3.2 Local gate (`lefthook.yml`)
- **pre-commit:** `biome format` + `biome check` (lint) only — sub-second on staged files. **Remove** the `pnpm verify:fast` typecheck from the local pre-commit (it moves to the CI pre-flight). Keep the `api-escalation` echo hint.
- **pre-push:** **removed** (no local build/test). CI owns build/test/the matrix.
- Net: the machine does ~150ms of work per commit; everything heavy is in CI.

## 4. Architecture — Part B: `/watch-ci` Claude Code skill

A skill the developer invokes in a **dedicated** Claude Code terminal right after pushing (e.g., `git push` then `/watch-ci` in a separate session). It babysits the run and exits when done; the developer works on other projects meanwhile. **The skill-running Claude is the fixer** — it has full repo context and edits directly.

### 4.1 The loop
1. **Identify the run:** `gh run list --branch main --limit 1 --json databaseId,status,workflowName` → the run for the just-pushed HEAD.
2. **Wait efficiently:** `gh run watch <id> --exit-status` (blocks until the run concludes; exit 0 = pass, non-zero = fail) — no busy-poll, near-zero local cost while waiting.
3. **Green** → success **toast + terminal bell** → exit. The developer never had to look.
4. **Red** → **harvest + compress** the failing logs: `gh run view <id> --log-failed` → strip ANSI/setup noise → regex the real error blocks (`error TS\d+`, biome diagnostics, vitest failures) down to <80 focused lines.
5. **Secret-scrub** the compressed logs (reuse the integration tier's scrubber denylist) before reasoning over them.
6. **Fix** (the skill-Claude, constrained to the files named in the logs; path-denylist enforced — §5): edit → run the **light** local check only (`biome format` + lint; never `verify:full` — re-validation is CI's job per D2).
7. **Concurrency guard:** confirm remote `main` HEAD still equals the SHA that failed. If a newer commit landed (the developer pushed again), **abort** — don't stack a fix on stale state.
8. **Commit + push** the fix → return to step 1 for the new run. Decrement the retry budget.
9. **Budget exhausted (N=3 or `max_total_minutes`)** → **escalate** (§5).

### 4.2 Optional worktree isolation
If the developer will also hand-edit corelib while `/watch-ci` runs, the skill fixes inside an isolated `git worktree add` (temp worktree at the failing SHA) so its edits never touch the active editor's files; it pushes from the worktree and tears it down. For a dedicated watch session that owns the checkout, this is optional. Default: **on** when the working tree has uncommitted changes or an env flag requests it; otherwise fix in place.

## 5. Safety rails (all in the MVP — these prevent harm, not polish)

1. **Bounded retries** N=3 (D3) + a hard **`max_total_minutes`** (≈30) ceiling.
2. **Concurrency/SHA guard** (§4.1 step 7): only ever fix the exact failing commit; abort if `main` moved.
3. **Loop-detection:** abort on an empty diff (agent produced no change) or a repeat of a prior attempt's file-state fingerprint (spinning).
4. **Path denylist:** the agent must NOT auto-edit high-blast-radius files — `.github/workflows/*`, `tsconfig*.json`, `package.json`, `Cargo.toml`, lockfiles. A fix that needs them → escalate immediately.
5. **No force-push, ever.** A rejected push → abort + escalate.
6. **Failure-class gate:** escalate immediately (don't attempt a code fix) on failures it can't localize to a diff — network/timeout/credential/infra/flaky. Only attempt failures tied to specific files (type/lint/test-logic).
7. **Secret-scrub** logs before they reach the model (§4.1 step 5).

## 6. Escalation

When the budget is exhausted (or a rail trips), reach a developer who's off on another project:
- **Windows native toast** via a zero-dep PowerShell snippet (or `BurntToast` if installed) — alert across virtual desktops.
- **Terminal bell** (`\x07`).
- **`CI-FAILURE-REPORT.md`** at repo root: the matched error, the diffs tried across the loops, and a "where I got stuck" handoff — so the developer (or a fresh Claude session pointed at it) resumes with full context.
- GitHub's failure email still arrives — belt and suspenders.

## 7. Phasing

**Phase 1 — MVP (the whole loop, lean; ships together):**
- `pipeline.yml`: add the `validate` pre-flight lane gating the matrix (§3.1).
- `lefthook.yml`: lighten to biome format+lint; drop pre-push (§3.2).
- `/watch-ci` skill: `gh run watch` → compress+scrub logs → fix (skill-Claude, optional worktree) → format+lint → concurrency-guarded push → N=3 → escalate. **All damage-prevention rails (§5) ship in the MVP.**

**Phase 2 — ergonomics + reach:**
- Content-fingerprint loop-detection refinement; richer log-compression patterns; per-repo config (`.watch-ci.json`: `workflow`, `branch`, `max_retries`, `max_total_minutes`, `preflight_job`, `paths_denylist`) with zero-config defaults; cross-project rollout; optional `rtk watch-ci` front-end (if rtk is extensible); a status line; CI-minute accounting.

## 8. Reusability

The skill is global (`~/.claude/skills/`), so it works in any repo with `gh` + a GitHub Actions workflow. Per-repo behavior comes from the optional `.watch-ci.json` (Phase 2); with no config it assumes `main` + the repo's default workflow + N=3. corelib is the proving ground; nothing in the skill is corelib-specific except the defaults it falls back to.

## 9. Risks & deferred

| Item | Status | Note |
|---|---|---|
| Flaky live-tier "fixed" by the agent | **Mitigated** | Pre-flight runs replay/offline only; live tier is nightly + `INTEGRATION_LIVE`-gated; failure-class gate (§5.6) escalates network/flaky. |
| Secret leakage from CI logs into the model/commits | **Mitigated** | Log secret-scrub (§5.7), reusing the integration scrubber. |
| Cross-package type break surfaces only post-push | **Accepted** | Cheap via the ~1-min pre-flight + auto-fix (D4 caveat). |
| Autonomous commits to `main` | **Bounded** | N=3 + concurrency guard + path denylist + no-force + escalation. |
| rtk extensibility for a `rtk watch-ci` front-end | **Deferred** | Phase 2, only if rtk source is owned/extensible. |
| Background daemon on Windows | **Rejected** | On-demand skill in a terminal session instead (sleep/hibernate-safe). |
