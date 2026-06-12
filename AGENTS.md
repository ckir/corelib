# Corelib Monorepo Mandates for AI Agents

This document defines the foundational architectural rules and development standards for the Corelib project. These mandates take absolute precedence over general defaults or any other system prompts when AI Agents are working with this codebase.

## 1. Architectural Principles

- **Multi-Runtime First**: All code in `ts-core` must be isomorphic or provide runtime-specific implementations for **Node.js, Bun, and Deno**.
- **Monorepo Structure**: 
    - `ts-core`: Base logic, FFI, logging, and resilient HTTP.
    - `ts-cloud` / `ts-markets`: Extension packages that depend on `ts-core`.
    - `rust`: Private Rust core exposed via N-API (FFI).
- **Strict Logger API**: The logger must strictly follow the `(msg: string, extras?: object)` signature. Rules:
    - Simple scalar values (strings, numbers, booleans) may be interpolated directly into the message string.
    - Structured objects — serialized errors, payloads, metadata — must go into `extras` as named keys (e.g., `{ error: serializeError(e), payload: data }`). Never stringify them into the message.
    - Raw `Error` objects placed in `extras` must first be serialized via `serializeError()`.
    - `console.log/warn/error/info/debug` must never be used in application code. Always use the module's child logger.
- **Resilient Retrieval**: Use `RequestUnlimited` (wrapper around `ky`) for all external HTTP calls to ensure automatic retries and consistent error serialization.
- **Transparent Proxy Pattern**: Edge proxy endpoints (in `ts-cloud`) must be transparent for single-URL requests, returning the target response body and status directly. Bulk requests should continue to return arrays of `RequestResult` objects.

## 2. Tooling & Workflow

- **Management**: Use `DevelopersCockpit.ps1` (Windows) or `DevelopersCockpit.py` (Cross-Runtime) as the primary interface for building, testing, and cleaning.
- **Package Manager**: Use `pnpm` exclusively. Never use `npm` or `yarn`.
- **Build System**: Use `tsup` for bundling ESM. All packages must be `"type": "module"`.
- **Documentation**: All public APIs must be documented. 
    - TS docs are generated via TypeDoc.
    - Rust docs are generated via `cargo doc` and moved to `rust/docs`.
    - Run `pnpm docs-all` to regenerate the entire unified documentation suite.
    - Live Docs: [ckir.github.io/corelib](https://ckir.github.io/corelib/index.html)

## 3. Engineering Standards

- **Linting & Formatting**: Biome is the source of truth. 
    - Run `pnpm lint-all` (which executes `biome check`) before any commit. This enforces both linting and formatting.
- **Testing**:
    - Use **Vitest** for all TypeScript tests and **MSW** for network mocks.
    - Maintain 100% pass rate for `pnpm test-all` across **Ubuntu, macOS, and Windows**.
- **Type Safety**: Avoid `any`. Export critical types from package entry points (`index.ts`).
- **FFI Stability**: The Rust FFI bridge is critical. Always verify the prebuilt `.node` binaries when changing core logic.

## 4. CI/CD Pipeline (`pipeline.yml`)

The monorepo uses a strictly staged GitHub Actions pipeline:
1.  **Validate**: Linting and formatting check (Biome).
2.  **Test**: Multi-OS execution (Ubuntu, macOS, Windows). **Mandatory**: TS packages must be built before testing to ensure correct workspace resolution.
3.  **Deploy Docs**: Triggered on `main` branch push. Publishes unified index to GitHub Pages.
4.  **Release**: Triggered on `v*` tags. Builds and attaches 11 assets:
    - TS Packages (`.tgz` for core, cloud, markets).
    - Rust FFI Nodes (Darwin x64/arm64, Linux x64, Win x64).
    - `yahoo_streamer` and `alpaca_streamer` CLI Binaries (Darwin x64/arm64, Linux x64, Win x64).

## 5. Development Environment & Tools

The following tools are available in the development environment and should be used for relevant tasks:
- **Cloud & Serverless**: `wrangler` (Cloudflare), `sam` (AWS), `gcloud` (GCP).
- **Automation & Containers**: `act` (Local GitHub Actions), `docker` (Docker Desktop), `gh` (GitHub CLI).
- **Environment**: `wsl` (Ubuntu 24.04).
- **Security & Secrets**: `sops` (Mozilla SOPS).
- **CLI Utilities**: `fd` (Fast find), `sd` (Smart search/replace), `rip` (Safe rm).

## 6. AI Agent Operational Mandates

- **Validation**: The full validation suite is **enforced by git hooks** (lefthook), not by manually re-running everything after each edit — see §10 *Task Completion Workflow* and §9 *Token Discipline*. During iteration use targeted checks; let `pre-commit` (`pnpm verify:fast`) and `pre-push` (`pnpm verify:full`) run the gate.
- **Surgical Edits**: Prefer `replace` over `write_file` for large files to preserve structure.
- **README Updates**: For any functionality change (new features, modified behavior, removed capabilities, changed APIs), update the relevant `README.md` file(s) to reflect the change. This does **not** apply to bug fixes that preserve existing documented behavior. Include usage examples for new or changed APIs, noting installation via release `.tgz` assets where applicable.
- **No Regressions**: If a change causes a TypeDoc warning or a Lint violation, it is incomplete. Fix it before reporting success.
- **Child Loggers:** Each module that requires logging MUST use a child logger to provide context.
  - *Pattern:* `const moduleLogger = logger.child({ section: '<class name> or <file basename>' });`

## 7. Advanced CLI Toolkit (Agent Instructions)

**Claude Code — rtk is automatic, do NOT prefix manually.** A global PreToolUse hook
(`rtk hook claude`, configured in `~/.claude/settings.json`) rewrites shell commands to
`rtk <cmd>` *before execution* — on the main thread **and inside subagents** (the hook fires for
subagent tool calls and carries an `agent_id`). It compresses recognized commands (git, vitest, gh,
grep, ls, …) and passes everything else through untouched, so manual `rtk ` prefixing is redundant and
unwanted. For reading/searching, use Claude Code's **native tools** (`Read`, `Grep`, `Glob`, `Edit`)
rather than routing through the shell — that's faster, and the hook still covers any shell calls you do
make.

**Agents without the rtk hook (e.g. Antigravity, Gemini) — the guidance below applies to you.** You
have no auto-rewrite hook, so prefer rtk's optimized local tools and prefix manually.

**MANDATORY (hookless agents only)**: prefix every shell command with `rtk` (e.g. `rtk bat file.txt`)
to compress token output.

**Tool Mapping (hookless agents):**
*   **Search/Find**: Use `rtk rg <pattern>` or `rtk fd <pattern>` (Do NOT use grep_search/find).
*   **Structural Search**: Use `rtk sg <pattern>` (ast-grep) to extract exact functions or classes.
*   **Read**: Use `rtk bat <file>` or `rtk mdcat <file>` (Do NOT use view_file).
*   **Replace**: Use `rtk sd <find> <replace> <file>`.
*   **Data Parsing**: Use `rtk jq`, `rtk yq`, `rtk htmlq`, or `rtk sqlite3`.
*   **Context Maps**: Use `rtk eza --tree` instead of standard `tree`, or `rtk dir-to-json` (Do NOT recursively crawl).
*   **Cloud/DevOps**: Use `rtk gh`, `rtk sops`, `rtk act`, `rtk aws`, `rtk gcloud`.
*   **GNU Fallback**: `rtk awk`, `rtk sort`, etc.

*Failover:* If a command fails due to syntax/escaping, or if complex multi-line refactoring is needed, fall back to your built-in API tools (e.g., `replace_file_content`).

## 8. Clarification Before Action

No prompt or user command should be executed on assumption alone. An agent that misreads intent and
implements the wrong thing wastes far more time than one that pauses to verify.

**Rules:**

- **Clarify before starting.** If a task contains ambiguity — unclear scope, missing context,
  conflicting requirements, or multiple valid interpretations — the agent MUST stop before writing any
  code and ask the user to resolve it. Do not pick the most likely interpretation and proceed.
- **Pause mid-task when blockers arise.** If an unexpected situation is encountered during
  implementation (an API that does not exist as assumed, a file that does not match expectations, a
  design decision that was not discussed), STOP. Do not invent a solution. Surface the blocker to the
  user with a clear description and ask how to proceed.
- **One question at a time.** When asking for clarification, present the specific question with the
  available options you have identified. Do not ask multiple unrelated questions at once.
- **State your interpretation.** Before writing code for a large or ambiguous task, briefly state how
  you understand the requirement and what you are about to do. This gives the user a chance to correct
  course before work begins.
- **No silent assumptions.** Any assumption that affects architecture, API shape, naming, or behaviour
  MUST be made explicit. Either confirm it with the user or call it out in your response so the user can
  validate it.
- **Do not proceed past a question.** If you asked a clarifying question, wait for the answer. Do not
  continue the implementation "in the meantime" and present a fait accompli alongside the question.

## 9. Token Discipline (dev-workflow)

- **Two-loop verification.** During iteration, run only targeted checks (`rg`-located file +
  `rtk vitest run <file>` for the touched package, `tsc --noEmit` for that package). The full suite is
  enforced at the git hooks (lefthook): `pre-commit` = `pnpm verify:fast` (`format-all` → `lint-all` →
  `typecheck-all`, kept sub-30s so nobody reaches for `--no-verify`); `pre-push` = `pnpm verify:full`
  (the heavy `build-all` → `test-all:run` gate). Do not manually re-run the full `*-all` pipeline after
  every edit.
- **Escalate on API/type changes.** When a change touches a `types.ts`, a `*.d.ts`, or an exported
  signature in a package `index.ts`, run `pnpm verify:full` before pushing (the pre-commit
  `api-escalation` grep also warns).
- **Line-bounded reading & editing.** Use ripgrep (`rg`) to find the exact lines, read only a ~50-line
  window, and patch surgically with native edit tools. Never load a 500-line file to change one line;
  never whole-file-rewrite what a patch can do. Prefer `rg` + native edits over AST tools.
- **Bounded discovery.** List directories at depth 2 (`rtk eza --tree --level=2`) and respect
  `.antigravityignore` / `.gitignore`. Never dump a deep recursive listing into context.
- **Measure.** Run `node C:/Users/user/.claude/skills/token-discipline-installer/bin/token-report.mjs latest --skill-version=1`
  to see per-tool and carried-cost offenders for a session. The ledger at `.claude/token-ledger.ndjson`
  tracks the trend. Telemetry is **manual** — there is no automatic post-commit hook writing the ledger
  (that would dirty the working tree after every commit). Run it explicitly when you want a snapshot.

`pnpm docs-all` (TypeDoc) is intentionally **not** in the push gate: it cleans its output dirs
(`ts-*/docs`, `rust/docs`) and would clobber working files. Run it manually or in CI when documentation
changes (§6 README Updates).

## 10. Task Completion Workflow

The full validation suite is **enforced by git hooks** (lefthook — see §9 Token Discipline), not by
manually re-running everything after each edit:

- **`pre-commit` → `pnpm verify:fast`:** `format-all` → `lint-all` → `typecheck-all` (kept fast).
- **`pre-push` → `pnpm verify:full`:** `build-all` → `test-all:run` (the heavy gate). TS packages are
  built before tests run so workspace resolution is correct (§4 CI/CD).

During iteration, use targeted checks (`rtk vitest run <file>`, `tsc --noEmit`); let the hooks run the
full gate at commit/push. The Rust FFI crate and the Cloudflare worker (`wrangler`) are **not** in the
local gate — the `.node` binary is prebuilt and CI already runs the multi-OS rust build and worker
checks; validate those via `pnpm build-all` / CI, or `cargo test` in `rust/` when changing FFI logic.

`lefthook` is installed globally (`lefthook version`). After cloning, run `lefthook install` once to
write `.git/hooks/pre-commit` and `.git/hooks/pre-push`.

## 11. Test Maintenance

Every code change **MUST** be accompanied by corresponding test updates. Tests must always reflect the
current behaviour of the code — a passing suite with stale or missing tests is a failing task.

**Rules:**
- **Update existing tests** when behaviour changes. If a function's contract, inputs, outputs, or
  side-effects change, every test that exercises that code path must be updated to match.
- **Add new tests** for every new code path, branch, or configuration mode introduced. A feature
  without tests is incomplete.
- **Remove or replace obsolete tests** that cover behaviour that no longer exists. Dead tests create
  false confidence.
- **Mock completeness:** When a dependency gains a new method that is called by code under test, add
  that method to the mock in every affected test file. A mock that silently ignores a call is a hidden
  gap. In particular, every `vi.mock("@ckir/corelib")` that stubs the logger child MUST include
  `trace: vi.fn()` and `debug: vi.fn()` alongside the other level mocks, or calls to those methods will
  throw at runtime during tests (see §12).
- **Scope:** Unit tests live in `src/**/*.test.ts` alongside the module they cover — one test file per
  source module — and run under **Vitest** with **MSW** for network mocks (§3). Integration tests, when
  added, live in their own tier (`tests/integration/`, `*.integration.test.ts`) and run via a dedicated
  command, separate from the fast unit loop.
- **No skipped tests:** Do not use `it.skip`, `xit`, or `describe.skip` to paper over failures. Fix the
  underlying issue.

## 12. Debug & Trace Logging

Every new or modified module **SHOULD** instrument its code with `debug` and `trace` log calls so that
`LOG_LEVEL=trace` produces a complete, machine-parseable record of the module's operation — detailed
enough for an AI agent to reconstruct the decision chain from logs alone without reading source code.
Use the module's child logger (§1, §6) and the strict `(msg, extras?)` signature.

**Level semantics:**

| Level | Volume | Use for |
|---|---|---|
| `trace` | Per-item (highest) | Every individual unit of work inside a hot-path loop: per-request retry attempt, per-row DB operation, per-item transform in a batch. |
| `debug` | Per-cycle (moderate) | Algorithmic decisions, state transitions, and summaries that occur once per operation: request start/finish, batch entry/exit, delta calculations, mode/runtime selection, FFI load path resolution. |
| `info` | Significant events | Lifecycle transitions, recovered errors, config load — things an operator watches at the default level. Do not downgrade these to `debug`. |

**Rules:**
- **Every hot-path handler should open and close with a `debug` summary** (e.g. entry:
  `"request: N urls"`, exit: `"ok / failed after M retries"`).
- **Every per-item iteration should emit a `trace` line** containing the item identity and the computed
  values used in the decision (attempt number, status code, elapsed ms, etc.).
- **State transitions are logged at `debug`** with both old and new value.
- **No-op decisions must still be traced** (skipped retry, cache hit, below-threshold) so the absence of
  action is explicit in the log record.
- **Structured extras over string interpolation for numeric data.** When logging more than two numeric
  values, pass them as the `extras` object (`{ attempt, status, elapsedMs }`) rather than embedding them
  in the message string — keeps log lines machine-parseable (§1 Strict Logger API).
- **No new `info` calls for per-cycle data.** Anything that fires on every request / item / row is
  `debug` or `trace`, never `info`.

## Working with Antigravity (agy) — collaboration policy (MANDATORY)

corelib is built by two AI agents working in tandem:

- **Claude (Opus) implements.** Claude writes all code, specs, and plans, and orchestrates subagents.
- **Antigravity (agy) reviews and generates.** Antigravity is a **design partner**, not only a
  validator. In review/design mode it **never edits code** — its only write target is the review record
  `ANTIGRAVITY-TO-CLAUDE.md`. The **one exception** is an *explicit implementation delegation* through
  the bridge (see *Primary transport* below), where the sub-agent is deliberately asked to edit and
  merge code.

This section is the standing brief for *both* agents. `CLAUDE.md`, `ANTIGRAVITY.md`, and `GEMINI.md` are
deprecated stubs that route both agents here, so it is written with both lanes explicit.

**Two transports, bridge-first.** Antigravity can be driven two ways. **Default to the automated
claudavity MCP bridge (`delegate_to_antigravity`)**; fall back to the **manual paste relay** only when
the bridge can't run (see *Failover transport*). Pick per handoff (Claude's judgment): the bridge fits
whenever there is a concrete repo state to review or modify; the manual relay covers anything else and
any time the bridge is unavailable. The *two-mode ask* and *cadence* below are transport-agnostic.

### The two-mode ask (every handoff)

Every Claude→Antigravity handoff MUST ask for **both**:

1. **Critical review** — correctness, race conditions, security / privilege-escalation paths, ordering
   bugs, test adequacy, over-engineering. Findings grouped by severity (🔴 Blocker / 🟡 Should-fix /
   🟢 Nit), each tied to the section it refers to, each with a concrete recommended fix.
2. **Creative improvement** — "what are we missing, what would you do differently, is there a simpler or
   stronger approach?" **Never send a review-only ask.** Antigravity's highest-value contributions are
   generative, not just validation.

### Cadence — relay at each artifact, per subproject

The review unit is the **subproject**: the decomposition unit defined during brainstorming (an
independent piece with its own spec → plan → implementation cycle). Per subproject, Claude relays to
Antigravity at four points:

| Phase | Antigravity mode | Trigger |
|---|---|---|
| Brainstorm | **divergent** — hand over the 2–3 candidate approaches and invite alternatives *before* converging | candidate approaches drafted |
| Spec | **divergent** — pressure-test for gaps, ambiguity, missing requirements | spec drafted, before the plan |
| Plan | **divergent** — review task breakdown, sequencing, risk | plan drafted, before code |
| Implementation complete | **convergent** — full critical review **plus exactly one** bounded, high-bar generative question ("ignoring settled decisions, anything materially simpler/stronger worth the churn before merge? else 'no change'") | subproject implementation complete and the §10 validation suite is green, before merge |

Routine plan tasks do **not** each trigger a handoff. Divergent passes go wide (cheap-to-change,
high-leverage). The convergent pass keeps validation tight and must **not** reopen a converged design
beyond the single bounded generative question; if nothing clears the bar, Antigravity says **"no
change."** Deferred Antigravity ideas are captured in the spec's "Deferred" section or `ROADMAP.md`.

### Design decisions — agy-first, then the user decides (MANDATORY)

**Before** asking the user to choose on any subproject **design / scope / approach / sequencing fork**
(e.g. "fold this fix now vs. backlog it", "which of these approaches", "extract a helper or wire
inline", "thorough fix or minimal one"), Claude MUST consult agy **first**: send the options with their
trade-offs, get agy's recommendation, **then** present the user a single question carrying **both**
agy's recommendation **and** Claude's own, each clearly attributed. The user decides. **Never** delegate
the final call to agy, and **never** put a design fork to the user with agy's input still missing. This
fires more often than the four-phase cadence: it triggers on *every* design fork, not only at phase
boundaries.

Scope guard (so this stays useful, not ritual): it applies to decisions that materially shape the
subproject's design or implementation. It does **not** apply to trivial mechanical choices, pure
preference/workflow questions, or the user's explicit direct instructions — but when a call is
borderline, **bias toward consulting agy first.**

### Primary transport — the claudavity MCP bridge (`delegate_to_antigravity`)

Prefer this for every handoff with a concrete repo state to work on. The bridge runs a **headless
Antigravity sub-agent** in an isolated git worktree (under `ts-core/.agent/worktrees/`) and merges its
committed output back; Claude calls the MCP tool directly, so **no human paste is involved**.

**Two modes:**

- **Review / design (default).** Delegate the two-mode ask. The `task_prompt` MUST instruct the
  sub-agent to **write its findings as a new dated section in `ANTIGRAVITY-TO-CLAUDE.md` and NOT modify
  any source file**. Findings return two ways: the merged `ANTIGRAVITY-TO-CLAUDE.md` section (durable
  record) and the tool's JSON `summary`. This keeps the "Antigravity never edits code" rule intact.
- **Implementation (explicit only).** When you *deliberately* delegate a bounded coding task, the
  sub-agent edits code in the worktree, commits, and merges back. Use this only for well-scoped work you
  have explicitly chosen to hand off — never as a side effect of a review ask.

**Calling it:**

- `target_dir` = absolute repo path (`C:/Users/user/Development/Node/corelib`).
- `task_prompt` = the full brief: what to review/build, which files to open, the numbered critical
  questions, and the phase-appropriate generative ask. In review mode, end with the explicit "write
  findings to `ANTIGRAVITY-TO-CLAUDE.md`, do not touch source files" instruction.
- `timeout_seconds` = generous for large tasks (e.g. `300`).

**Usage caveat:** the bridge only returns what the sub-agent **commits**, so review findings must be
written to a **tracked** file — that is why `ANTIGRAVITY-TO-CLAUDE.md` is committed (not gitignored)
while `CLAUDE-TO-ANTIGRAVITY.md` (failover-only) stays ignored. Bridge work lands on the current branch
as an `agy task <id>` commit; squash or reword as you fold it.

For the bridge tool's own setup, internals, and troubleshooting, see the **claudavity** repo's
`README.md` (`C:\Users\user\Development\Rust\claudavity`) — those details live there, not here.

### Failover transport — manual sectioned files + short paste-pointer

Use this when the bridge can't run: not registered / not loaded, missing `GEMINI_API_KEY` or SDK auth
failure, MCP error/timeout, or you are driving `agy` interactively by choice. Detailed content flows
through files (agent ↔ disk ↔ agent); the human copy/paste carries only short pointers.

| File | Direction | Owner |
|---|---|---|
| `CLAUDE-TO-ANTIGRAVITY.md` | Claude → Antigravity | Claude writes the task summary + files to read + numbered questions (both modes) |
| `ANTIGRAVITY-TO-CLAUDE.md` | Antigravity → Claude | Antigravity writes findings grouped by severity, plus the generative answer |

Both files are **sectioned** — one dated heading per handoff — so a subproject's full design dialogue
accumulates as a readable record and Claude can point Antigravity at a specific section.
(`ANTIGRAVITY-TO-CLAUDE.md` is the same committed review record the bridge writes to;
`CLAUDE-TO-ANTIGRAVITY.md` is a gitignored buffer used only on this failover path.)

**Per handoff:**

1. **Before** starting handoff-eligible work, Claude reads `ANTIGRAVITY-TO-CLAUDE.md` for outstanding
   feedback.
2. Claude appends a new section to `CLAUDE-TO-ANTIGRAVITY.md`: what was built / is being designed, which
   repo files Antigravity should open, the numbered critical questions, and the phase-appropriate
   generative ask (divergent early; one bounded high-bar question at the convergent gate).
3. Claude emits a **short paste-block** for the user, e.g.: *"Antigravity: read the `## <heading>`
   section in `CLAUDE-TO-ANTIGRAVITY.md`, review the files it names, write your detailed findings to a
   new section in `ANTIGRAVITY-TO-CLAUDE.md`, and print a short summary to the console."*
4. The user pastes that single instruction into Antigravity.
5. Antigravity reads `CLAUDE-TO-ANTIGRAVITY.md` and the referenced files, writes detailed findings to a
   new section in `ANTIGRAVITY-TO-CLAUDE.md`, and prints a short summary. Antigravity addresses every
   numbered question; say "fine" for anything that's fine — only elaborate on what must change.
6. The user pastes the short console summary back to Claude.
7. Claude reads the detailed section in `ANTIGRAVITY-TO-CLAUDE.md`, applies fixes / folds ideas into the
   artifact, commits, and continues.

### Bridge usage patterns

**Governing principle — mode is the safety dial:** default to **review-mode** (the sub-agent only
writes findings to `ANTIGRAVITY-TO-CLAUDE.md`, never edits source → near-zero risk); make
**implementation-mode** (the sub-agent commits code that merges to the branch) opt-in and only for
bounded, *machine-verifiable* tasks. Two invariants on every pattern: a **Claude-only failover** (agy
can be down — degrade to doing it inline; a `failed` delegation triggers fallback, not retry), and for
implementation-mode, **Claude owns the gate** (review the merged diff; nothing pushes until `pre-push`
`pnpm verify:full` is green). Each `task_prompt` template below is copy-pasteable — replace `{...}`.

**Review-mode patterns — use across the cadence:**

*P1 — Divergent ideation* (brainstorm/spec, when you want alternatives):
```
You are delegated a DIVERGENT DESIGN task (design-partner mode), NOT implementation. Do NOT modify any
source file. Append your output as a new dated section "## {DATE} — {TOPIC}" to ANTIGRAVITY-TO-CLAUDE.md.
Context: {problem / subproject summary}. Read: {files / spec}. Give BOTH, going wide: (1) alternative
approaches we may have missed; (2) "what's missing, simpler, or stronger?" For each: the core, the
trade-off, when it wins. End with your single highest-conviction suggestion — or "no change".
```

*P2 — Convergent red-team* (implementation-complete, before merge — automates the gate's review half):
```
You are delegated a CONVERGENT CRITICAL REVIEW (design-partner mode), NOT implementation. Do NOT modify
source. Append findings as a new dated section to ANTIGRAVITY-TO-CLAUDE.md. The change under review is
`git diff {BASE}...HEAD`. Key files: {files}. Audit for: correctness; race conditions / async ordering;
error-handling & failure paths; FFI/runtime-boundary safety; test adequacy; scope creep. Group by
🔴 Blocker / 🟡 Should-fix / 🟢 Nit, each tied to `file:line` with a concrete fix. Then one bounded
question: ignoring settled decisions, anything materially simpler/stronger worth the churn? Else "no change".
```

*P3 — Config/boundary pressure-test* (spec/plan, when new config or a new public API appears):
```
You are delegated a REVIEW task (design-partner mode), NOT implementation. Do NOT modify source. Append
findings to ANTIGRAVITY-TO-CLAUDE.md. Examine the new configuration / exported surface: {keys / file}.
For EACH value reason about extremes — 0, negative, very large, below-a-dependent-threshold. Identify
starvation, deadlock, busy-loop, event-loop blocking, or silent-fail risks, and recommend safe bounds /
validation. Cite `file:line`.
```

**The two pilots — bounded, opt-in:**

*P4 — Exported-type drift guard* — **implementation-mode**; machine-verifiable (`biome`/`tsc`), one file:
```
You are delegated a BOUNDED IMPLEMENTATION task. A type re-exported by a consumer package
({ts-markets|ts-cloud}/src/index.ts) has drifted from its definition in ts-core. Compare {type} as
defined in ts-core against its re-export / consumer usage. Update ONLY the consumer file to match
ts-core. Run `pnpm --filter {pkg} typecheck` and `biome check .` and ensure both pass. Commit ONLY that
file. Touch nothing else.
```

*P5 — Regression / bisect grind* — **review-mode (diagnosis); impl-mode deferred.** Always cap the run-loop:
```
You are delegated a DIAGNOSIS task (design-partner mode) — do NOT modify source, do NOT commit a fix.
Append your diagnosis to ANTIGRAVITY-TO-CLAUDE.md. Symptom: `{test command}` fails with {error}. Suspect
range/area: {commits or modules}. Run the suite and isolate the exact cause (commit, line, lifecycle
phase). Report: root cause, the minimal fix, collateral risk. HARD BUDGET: stop and write
progress-so-far after at most {N} bisect steps or {M} execution attempts — do NOT loop indefinitely.
```

**Guardrails:** default review-mode; impl-mode only for bounded/verifiable tasks. Each call lands an
`agy task <id>` commit on the current branch — squash/reword as you fold; for review-mode the
`ANTIGRAVITY-TO-CLAUDE.md` entry *is* the durable record, keep it. Run-loop tasks (bisect/debug) need a
hard iteration/time cap. One worktree per call from HEAD → only fan out **provably-disjoint** file sets.

**Never delegate:** cross-cutting architectural / runtime-bootstrap / monorepo-config refactors; the
Rust FFI bridge surface or N-API boundary changes; DB schema migrations with stateful side-effects;
human-in-the-loop / subjective decisions.

### Delegating reviews to agy — wording principles

When delegating reviews to agy in review-mode, your prompt wording is the critical leverage. Because agy
is worktree-blind, write prompts to direct focus, enforce structural rigor, and bound its static
analysis. Three core drafting principles:

1. **Scope-gated severity + evidence mandate.** Prompt with a precise calibration rubric every time:
   🔴 (Blocker) = reachable bug *this diff* introduces under supported topology (including dormant
   pre-existing flaws made newly reachable by this change); 🟡 (Should-fix) = pre-existing, non-blocking,
   or reachable only under unsupported topology; 🟢 (Nit). Each finding MUST specify `file:line`, trigger
   conditions, and a step-by-step trace; without a traceable path, require a downgrade. Findings must be
   tagged `[VERIFIED]` or `[THEORETICAL]` (theoretical is never 🔴).
2. **Guided verification with safe harbors.** Seed specific invariants to assess (agy verifies better
   than it discovers). To prevent bias, mandate: *anti-anchoring* (seeding deepens focus but does not
   restrict scope — sweep all modified lines); *challenge the seed* (flag `[CLAIM-MISAIMED]` if an
   invariant target is wrong and propose a better one); *bounded unseeded discovery* (tag
   `[UNSEEDED-DISCOVERY]` for off-seed issues meeting the 🔴/🟡 bar within ~1 call-hop); *permission to
   pass* (allow agy to report nothing is must-fix via `[Verified Clean]`).
3. **Bootstrap context.** Always embed system purpose, supported topology (Node / Bun / Deno + the FFI
   boundary), invariants to maintain, and the *ignorance boundary* (black-box dependencies). Supply the
   exact diff range, worktree status, and a four-column calibration table of prior findings:
   `finding | proposed severity | final disposition | learning`.

**Findings format to request:** three severity sections; findings tagged `[VERIFIED]`/`[THEORETICAL]`
with `file:line`, step trace, a `[Surgical]`/`[Structural]` fix-size tag, and a suggested one-line
failing **Vitest** test. `[THEORETICAL]` findings must state: *"To raise confidence, verify: …"*.

**The delegation boundary:** agy reasons locally and sequentially; it will miss cross-graph cascades and
deep concurrency interleavings. For these, supply wide architecture/event-graph context, restrict the
query to `[isolated-scope only]`, or analyze them yourself. Force agy to output `[CONFIDENCE-LIMIT]`
disclaimers rather than guessing.

**Anti-patterns to avoid:**
- *Hyperbolic priming:* words like "red-team hard" or "destroy this" cause over-escalation and false positives.
- *Massive diffs:* cause skimming, poor recall, and noise.
- *Rigid demands:* forcing a verdict without an explicit "no must-fix is a successful result" escape hatch.