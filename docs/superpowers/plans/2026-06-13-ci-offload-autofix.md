# CI-Offload + AI Auto-Fix Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offload heavy build/test to CI (free the low-spec Windows machine) via a fast CI pre-flight that gates the 9-cell matrix + a lightened local gate, and add a standalone `watch-ci` script (launched by a `/watch-ci` Claude Code skill) that auto-fixes a red `main` in a bounded loop and escalates when it can't.

**Architecture:** Two halves. **(A) corelib repo changes** — a ~1-min `validate` pre-flight job in `pipeline.yml` that gates the matrix, and `lefthook.yml` lightened to biome format+lint. **(B) a global tool** — `~/.claude/skills/watch-ci/watch-ci.mjs` (zero-dep Node worker: `gh run watch` → compress+scrub logs → headless `claude -p` fix in an isolated git worktree → script-side guarded push → N=3 → escalate) plus `~/.claude/skills/watch-ci/SKILL.md` (a thin launcher that starts the worker detached after a push).

**Tech Stack:** GitHub Actions, lefthook, `gh` CLI, `claude -p` (Claude Code headless), `git worktree`, zero-dep Node ≥18 ESM (`.mjs`), `node --test`, PowerShell toast (Windows).

**Spec:** `docs/superpowers/specs/2026-06-13-ci-offload-autofix-design.md` (Approved).

---

## Conventions for implementer subagents (READ FIRST)

1. **Step 0 — state verification.** Before editing, open each target file and confirm the quoted "Current state" matches reality. If it differs, STOP and report `STATE_MISMATCH: <what>`.
2. **SHAPE_DIVERGENCE rule.** If making something work would change a command's flags, an exported name, a config key, or a wire/JSON shape shown here — even to compile/run — STOP and report `[original] → [yours] because <reason>`.
3. **Two homes.** Part A edits live in the corelib repo (`C:\Users\user\Development\Node\corelib`) and are committed there (lefthook gate applies; never `--no-verify`; commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). Part B files live under `C:\Users\user\.claude\skills\watch-ci\` (NOT a corelib commit — they are global; no lefthook there).
4. **The worker is a zero-dep Node ESM `.mjs`** (Node ≥18 built-ins only: `node:child_process`, `node:fs`, `node:path`, `node:crypto`, `node:os`). No npm deps, no build step. Pure helpers get `node --test` unit tests; orchestration is exercised via a `--dry-run` mock mode.
5. **External CLIs** are invoked via `execFileSync`/`spawn` with argument arrays (never string-interpolated shell) to avoid injection and Windows quoting issues.

---

## File Structure

**Part A (corelib repo):**
- Modify: `.github/workflows/pipeline.yml` — add the `validate` pre-flight job; gate heavy jobs on it.
- Modify: `lefthook.yml` — pre-commit → format+lint only; drop pre-push.

**Part B (global, `C:\Users\user\.claude\skills\watch-ci\`):**
- Create: `watch-ci.mjs` — the worker (config, watch loop, log compress/scrub, worktree fixer, rails, push, escalation).
- Create: `watch-ci.test.mjs` — `node --test` unit tests for the pure helpers.
- Create: `toast.ps1` — the Windows toast snippet invoked on escalation.
- Create: `SKILL.md` — the `/watch-ci` launcher skill.
- Create: `README.md` — usage + the optional `.watch-ci.json` schema.

---

## Task 1: CI pre-flight lane (`pipeline.yml`)

Add a fast `validate` job (single Linux runner, offline) that gates the expensive matrix, so a typo costs ~1 CI-minute, not a full Rust×3-OS×3-runtime build. This is also the job the auto-fixer binds to.

**Files:** Modify `.github/workflows/pipeline.yml`

**Current state (verify):** The workflow has jobs `validate` (lint only), `test` (matrix `needs: validate`), `integration` (`needs: test`), `docs` (`needs: test`), `build-ts`/`build-rust` (`needs: test`), `release`. The existing `validate` job runs only `pnpm install` + `pnpm lint-all`.

- [ ] **Step 1: Expand the existing `validate` job into the full fast pre-flight.** Replace its steps so it also typechecks and runs the offline integration tier. Change the `validate` job's steps to:

```yaml
  validate:
    name: Validate (pre-flight)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v5
        with:
          version: 11.5.2
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: 'pnpm'
      - name: Install dependencies
        run: pnpm install
      - name: Lint + format check
        run: pnpm lint-all
      - name: Typecheck
        run: pnpm typecheck-all
      - name: Integration (replay, offline)
        run: pnpm test:integration && pnpm test:integration:validate
```

> **Note (no Rust here):** the pre-flight stays Node-only and offline — no `napi build`, no live network. `pnpm test:integration` runs MSW replay; the live streaming suites self-skip (`describe.skipIf(!INTEGRATION_LIVE)`), so the pre-flight can never go red on live-API flakiness. The native `.node` addon is committed/prebuilt in the repo, so the ffi-scalar integration tests that need it either run (if present) or loud-skip — they do not require a CI Rust build.

- [ ] **Step 2: Confirm the heavy jobs gate on the pre-flight.** Verify each of `test`, `integration`, `docs`, `build-ts`, `build-rust` has `needs:` including `validate` (directly, or transitively via `test` which is `needs: validate`). They already do (`test: needs: validate`; the rest `needs: test`). No change needed unless Step 0 shows otherwise — if any heavy job lacks the dependency, add `validate` to its `needs`.

- [ ] **Step 3: Validate the YAML.**

Run: `pnpm exec js-yaml .github/workflows/pipeline.yml >/dev/null` (or any YAML linter available; if none, `node -e "require('node:fs').readFileSync('.github/workflows/pipeline.yml','utf8')"` + visual check of indentation).
Expected: parses with no error.

- [ ] **Step 4: Commit.**

```bash
git add .github/workflows/pipeline.yml
git commit -m "$(cat <<'EOF'
ci: expand validate pre-flight (lint+typecheck+offline integration) gating the matrix

A ~1-min Linux validate job now runs lint, typecheck-all, and the offline (replay)
integration tier; the 9-cell test matrix + integration + release jobs already gate on
it (needs: validate), so a typo costs ~1 CI-minute instead of a full Rust x 3-OS x
3-runtime build. This is the job the watch-ci auto-fixer binds to.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Lighten the local gate (`lefthook.yml`)

**Files:** Modify `lefthook.yml`

**Current state (verify):** `pre-commit` runs `verify-fast: run: pnpm verify:fast` (= format-all && lint-all && typecheck-all) + an `api-escalation` glob-echo. `pre-push` runs `verify-full: run: pnpm verify:full` (= build-all && test-all:run).

- [ ] **Step 1: Drop typecheck from pre-commit and remove the pre-push gate.** Replace the file body so pre-commit runs only format+lint and there is no pre-push job:

```yaml
# token-discipline local gate (lightened 2026-06-13): the low-spec machine does only
# biome format+lint locally (sub-second on staged files). Typecheck + build + test are
# offloaded to the CI `validate` pre-flight (which gates the matrix); see
# docs/superpowers/specs/2026-06-13-ci-offload-autofix-design.md.
pre-commit:
  parallel: false
  commands:
    format-lint:
      run: |
        pnpm format-all && pnpm lint-all
    # Hint only (cross-shell echo): a type/API boundary changed — CI's validate
    # pre-flight will typecheck it; run `pnpm typecheck-all` locally if you want certainty.
    api-escalation:
      glob:
        - "**/*types.ts"
        - "**/*.d.ts"
        - "**/src/index.ts"
      run: echo "[token-discipline] API/type boundary changed -> CI validate will typecheck; local typecheck optional"
```

> **Note:** `pnpm lint-all` is `biome check` which already enforces formatting, so format+lint is the full cheap local gate. `verify:fast`/`verify:full` root scripts are left intact in `package.json` (still useful to run manually + the CI pre-flight composes the same checks); only the *hook* changes.

- [ ] **Step 2: Re-install hooks so the change takes effect.**

Run: `pnpm exec lefthook install`
Expected: rewrites `.git/hooks/pre-commit`; `.git/hooks/pre-push` becomes a no-op/absent.

- [ ] **Step 3: Smoke the new pre-commit** (it must NOT run typecheck). Make a trivial no-op commit on a scratch change or inspect:

Run: `pnpm exec lefthook run pre-commit`
Expected: runs `format-all` + `lint-all` only (no `tsc`/typecheck output), completes in seconds.

- [ ] **Step 4: Commit.**

```bash
git add lefthook.yml
git commit -m "$(cat <<'EOF'
chore(gate): lighten local lefthook to biome format+lint; drop pre-push

Typecheck + build + test move to the CI validate pre-flight (low-spec machine does
~150ms/commit). verify:fast/full scripts kept for manual use; only the hooks change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `watch-ci.mjs` — config + pure helpers (+ unit tests)

Build the testable, side-effect-free core first: config resolution, log compression, secret scrubbing, the path-denylist check, and the change fingerprint. These are `node --test`-covered.

**Files (global — NOT a corelib commit):**
- Create: `C:\Users\user\.claude\skills\watch-ci\watch-ci.mjs`
- Create: `C:\Users\user\.claude\skills\watch-ci\watch-ci.test.mjs`

- [ ] **Step 1: Write the failing tests** `watch-ci.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { compressLog, scrubLog, isDeniedPath, fingerprint, resolveConfig, DEFAULT_CONFIG } from "./watch-ci.mjs";

test("compressLog strips ANSI/setup noise and keeps error blocks under the cap", () => {
  const raw = [
    "2026-06-13T00:00:00 \x1b[32mRun pnpm typecheck-all\x1b[0m",
    "added 412 packages in 8s",
    "ts-core typecheck: src/foo.ts(12,3): error TS2322: Type 'number' is not assignable to type 'string'.",
    "noise noise noise",
    "biome ./src/bar.ts:4:1 lint/suspicious/noExplicitAny  Unexpected any.",
  ].join("\n");
  const out = compressLog(raw);
  assert.ok(out.includes("error TS2322"));
  assert.ok(out.includes("lint/suspicious/noExplicitAny"));
  assert.ok(!out.includes("\x1b["), "ANSI stripped");
  assert.ok(!out.includes("added 412 packages"), "install noise dropped");
  assert.ok(out.split("\n").length <= 80);
});

test("scrubLog redacts secret-looking tokens", () => {
  const raw = "APCA_API_KEY_ID=PKLIVE123 secret=abcd Authorization: Bearer ZZZ token=qwer";
  const out = scrubLog(raw);
  assert.ok(!out.includes("PKLIVE123"));
  assert.ok(!out.includes("ZZZ"));
  assert.ok(!out.includes("qwer"));
  assert.ok(out.includes("<REDACTED>"));
});

test("isDeniedPath blocks high-blast-radius files", () => {
  const denied = DEFAULT_CONFIG.paths_denylist;
  assert.equal(isDeniedPath(".github/workflows/pipeline.yml", denied), true);
  assert.equal(isDeniedPath("ts-core/tsconfig.json", denied), true);
  assert.equal(isDeniedPath("package.json", denied), true);
  assert.equal(isDeniedPath("Cargo.toml", denied), true);
  assert.equal(isDeniedPath("pnpm-lock.yaml", denied), true);
  assert.equal(isDeniedPath("ts-core/src/configs/ConfigManager.ts", denied), false);
});

test("fingerprint is stable for same content, differs otherwise", () => {
  assert.equal(fingerprint("a\nb"), fingerprint("a\nb"));
  assert.notEqual(fingerprint("a\nb"), fingerprint("a\nc"));
});

test("resolveConfig merges .watch-ci.json over defaults", () => {
  const cfg = resolveConfig({ branch: "main", max_retries: 5 });
  assert.equal(cfg.branch, "main");
  assert.equal(cfg.max_retries, 5);
  assert.equal(cfg.max_total_minutes, DEFAULT_CONFIG.max_total_minutes); // default kept
});
```

- [ ] **Step 2: Run — expect FAIL** (module/exports missing).

Run: `node --test "C:\Users\user\.claude\skills\watch-ci\watch-ci.test.mjs"`
Expected: FAIL (cannot find exports).

- [ ] **Step 3: Implement the helpers** at the top of `watch-ci.mjs`:

```js
#!/usr/bin/env node
// watch-ci.mjs — zero-dep Node (>=18) CI watch + bounded AI auto-fix worker.
// Part B of docs/superpowers/specs/2026-06-13-ci-offload-autofix-design.md.
import { createHash } from "node:crypto";

export const DEFAULT_CONFIG = {
  workflow: null, // null => the latest run on the branch, any workflow
  branch: "main",
  max_retries: 3,
  max_total_minutes: 30,
  preflight_job: "validate",
  paths_denylist: [
    ".github/workflows/",
    "tsconfig", // matches tsconfig.json / tsconfig.*.json anywhere
    "package.json",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "Cargo.lock",
  ],
  poll_seconds: 12,
};

export function resolveConfig(fileCfg = {}) {
  return { ...DEFAULT_CONFIG, ...fileCfg };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Lines that carry the actual signal we want to keep.
const SIGNAL_RES = [
  /error TS\d+/i,
  /\b(FAIL|✗|×)\b/,
  /lint\/[a-z/]+/i,
  /\berror\b/i,
  /\bpanicked\b/i,
  /\bAssertionError\b/i,
  /npm ERR!/i,
  /Expected .* Received/i,
];
// Lines that are pure noise even if they contain a signal word.
const NOISE_RES = [
  /^added \d+ packages/i,
  /^\s*Run /,
  /actions\/(checkout|setup-node|setup-bun)/i,
  /^\s*Downloading|^\s*Resolving|^\s*Fetching/i,
];

export function compressLog(raw, cap = 80) {
  const lines = raw.replace(ANSI_RE, "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (NOISE_RES.some((re) => re.test(line))) continue;
    if (SIGNAL_RES.some((re) => re.test(line))) kept.push(line.trimEnd());
    if (kept.length >= cap) break;
  }
  return kept.join("\n");
}

const SECRET_RES = [
  /(APCA_API_KEY_ID|APCA_API_SECRET_KEY|FINNHUB_API_KEY|GH_TOKEN|GITHUB_TOKEN)\s*[=:]\s*\S+/gi,
  /\b(secret|token|password|apikey|api_key|authorization)\b\s*[=:]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /\b(pk|sk)[-_][A-Za-z0-9]{8,}\b/g,
];
export function scrubLog(raw) {
  let out = raw;
  for (const re of SECRET_RES) {
    out = out.replace(re, (m) => {
      const eq = m.search(/[=:]/);
      return eq >= 0 ? `${m.slice(0, eq + 1)} <REDACTED>` : "<REDACTED>";
    });
  }
  return out;
}

export function isDeniedPath(path, denylist) {
  const p = path.replace(/\\/g, "/");
  return denylist.some((d) => p.includes(d));
}

export function fingerprint(text) {
  return createHash("sha256").update(text).digest("hex");
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `node --test "C:\Users\user\.claude\skills\watch-ci\watch-ci.test.mjs"`
Expected: PASS (5 tests).

---

## Task 4: `watch-ci.mjs` — the orchestration loop

Add the side-effecting orchestration on top of the helpers: resolve the run, watch it, on red drive the bounded fix loop with all rails, push, recurse. Exercised via a `--dry-run` mock so it's runnable without a live CI/Claude.

**Files:** Modify `C:\Users\user\.claude\skills\watch-ci\watch-ci.mjs`

- [ ] **Step 1: Add the process helpers + the loop.** Append to `watch-ci.mjs`:

```js
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const log = (...a) => console.log("[watch-ci]", ...a);

function sh(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function shTry(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, status: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function loadRepoConfig(cwd) {
  const p = join(cwd, ".watch-ci.json");
  if (existsSync(p)) { try { return resolveConfig(JSON.parse(readFileSync(p, "utf8"))); } catch { /* fall through */ } }
  return resolveConfig();
}

// --- gh interactions ---
function latestRun(cfg) {
  const args = ["run", "list", "--branch", cfg.branch, "--limit", "1", "--json", "databaseId,headSha,status,conclusion,workflowName"];
  const arr = JSON.parse(sh("gh", args));
  return arr[0] ?? null;
}
function watchRun(id) {
  // Blocks until the run concludes; exit 0 = success, non-zero = failure.
  const r = shTry("gh", ["run", "watch", String(id), "--exit-status"]);
  return r.ok;
}
function failedLog(id) {
  const r = shTry("gh", ["run", "view", String(id), "--log-failed"]);
  return r.out;
}

// --- git interactions ---
function remoteHead(cfg) {
  const out = sh("git", ["ls-remote", "origin", `refs/heads/${cfg.branch}`]).trim();
  return out.split(/\s+/)[0] || "";
}
function changedFiles(cwd) {
  return sh("git", ["-C", cwd, "diff", "--name-only", "HEAD"], {}).split(/\r?\n/).filter(Boolean);
}

// --- the fix attempt (returns "pushed" | "abort:<reason>") ---
function attemptFix({ cfg, failSha, compressed, repoRoot, attempt }) {
  // Isolated worktree at the failing commit.
  const wt = join(repoRoot, ".git", "watch-ci-worktrees", `fix-${attempt}-${Date.now()}`);
  sh("git", ["-C", repoRoot, "worktree", "add", "--detach", wt, failSha]);
  try {
    const prompt =
      `CI failed on commit ${failSha}. Fix ONLY the code at fault, then run \`pnpm format-all && pnpm lint-all\`, ` +
      `and \`git commit -am "fix(ci): auto-fix CI failure"\`. Do NOT push. Do NOT edit build/config files ` +
      `(.github/workflows, tsconfig*, package.json, lockfiles, Cargo.*). Failing log:\n\n${compressed}`;
    // Headless fix in the worktree. --dangerously-skip-permissions keeps it non-interactive for an unattended run.
    const fix = shTry("claude", ["-p", prompt, "--permission-mode", "acceptEdits"], { cwd: wt });
    if (!fix.ok) return "abort:claude-failed";

    // RAILS (deterministic, script-side) ---
    const diff = changedFiles(wt);
    if (diff.length === 0) return "abort:empty-diff";
    const denied = diff.filter((f) => isDeniedPath(f, cfg.paths_denylist));
    if (denied.length) return `abort:denied-path:${denied.join(",")}`;
    const fp = fingerprint(sh("git", ["-C", wt, "diff", failSha]));
    if (seenFingerprints.has(fp)) return "abort:loop-detected";
    seenFingerprints.add(fp);
    // Concurrency guard: main must not have moved since the failing run.
    if (remoteHead(cfg) !== failSha) return "abort:main-moved";

    // Push the worktree's HEAD onto the branch (never force).
    const push = shTry("git", ["-C", wt, "push", "origin", `HEAD:${cfg.branch}`]);
    if (!push.ok) return "abort:push-rejected";
    return "pushed";
  } finally {
    try { sh("git", ["-C", repoRoot, "worktree", "remove", "--force", wt]); } catch { /* best effort */ }
  }
}

const seenFingerprints = new Set();

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const repoRoot = sh("git", ["rev-parse", "--show-toplevel"]).trim();
  const cfg = loadRepoConfig(repoRoot);
  const startedAt = Date.now();
  let attempts = 0;

  while (true) {
    if (dryRun) { log("dry-run: would watch + fix; exiting"); return; }
    const run = latestRun(cfg);
    if (!run) { log("no run found for", cfg.branch); return; }
    log(`watching run ${run.databaseId} (${run.workflowName}) @ ${run.headSha.slice(0, 7)}`);
    const green = watchRun(run.databaseId);
    if (green) { success(repoRoot); return; }

    if (attempts >= cfg.max_retries) return escalate(repoRoot, cfg, "max retries", run);
    if ((Date.now() - startedAt) / 60000 >= cfg.max_total_minutes) return escalate(repoRoot, cfg, "time budget", run);
    attempts++;

    const compressed = scrubLog(compressLog(failedLog(run.databaseId)));
    if (!compressed.trim()) return escalate(repoRoot, cfg, "no localizable error (likely infra/flaky)", run);

    log(`attempt ${attempts}/${cfg.max_retries}: fixing`);
    const result = attemptFix({ cfg, failSha: run.headSha, compressed, repoRoot, attempt: attempts });
    if (result !== "pushed") return escalate(repoRoot, cfg, result, run, compressed);
    log("fix pushed; re-watching new run");
  }
}

// success()/escalate() are added in Task 5.

main().catch((e) => { console.error("[watch-ci] fatal", e); process.exit(1); });
```

> **Oracle note (verify in Step 0):** confirm the exact non-interactive `claude -p` flag for unattended edits. The plan uses `claude -p "<prompt>" --permission-mode acceptEdits`. If your installed Claude Code uses a different flag for non-interactive auto-accept (e.g. `--dangerously-skip-permissions` or a settings-based permission mode), use the real one and report `SHAPE_DIVERGENCE`. The headless invocation MUST run unattended (no prompts) in the worktree `cwd`.

- [ ] **Step 2: Dry-run smoke (no live CI needed).**

Run: `node "C:\Users\user\.claude\skills\watch-ci\watch-ci.mjs" --dry-run` (from inside a git repo, e.g. corelib)
Expected: prints `dry-run: would watch + fix; exiting` and returns 0. (`success`/`escalate` are added in Task 5; until then the dry-run path doesn't reach them.)

- [ ] **Step 3: Re-run the helper unit tests (no regression).**

Run: `node --test "C:\Users\user\.claude\skills\watch-ci\watch-ci.test.mjs"`
Expected: PASS (the appended orchestration must not break the helper exports).

---

## Task 5: Escalation (toast + bell + report) + success

**Files:**
- Modify: `C:\Users\user\.claude\skills\watch-ci\watch-ci.mjs`
- Create: `C:\Users\user\.claude\skills\watch-ci\toast.ps1`

- [ ] **Step 1: Create `toast.ps1`** (zero-dep Windows toast; takes title + message as args):

```powershell
param([string]$Title = "watch-ci", [string]$Message = "")
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).AppendChild($xml.CreateTextNode($Title)) > $null
$texts.Item(1).AppendChild($xml.CreateTextNode($Message)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('watch-ci').Show($toast)
```

- [ ] **Step 2: Add `notify`, `success`, `escalate`** to `watch-ci.mjs` (insert before `main()`):

```js
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dir = dirname(fileURLToPath(import.meta.url));

function bell() { process.stdout.write("\x07".repeat(3)); }

function toast(title, message) {
  if (process.platform !== "win32") return;
  shTry("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(__dir, "toast.ps1"), "-Title", title, "-Message", message]);
}

function success(repoRoot) {
  log("CI is GREEN ✅");
  bell();
  toast("watch-ci ✅", "CI is green.");
}

function escalate(repoRoot, cfg, reason, run, compressed = "") {
  log(`ESCALATING: ${reason}`);
  bell();
  toast("watch-ci 🚨 takeover needed", `CI still red after auto-fix (${reason}).`);
  const report = [
    `# CI Auto-Fix Escalation`,
    ``,
    `- When: ${new Date().toISOString()}`,
    `- Branch: ${cfg.branch}`,
    `- Failing run: ${run?.databaseId} (${run?.workflowName}) @ ${run?.headSha}`,
    `- Reason the loop stopped: **${reason}**`,
    ``,
    `## Compressed, scrubbed failing log`,
    "```",
    compressed || "(none captured)",
    "```",
    ``,
    `## Take over`,
    `Open a Claude Code session in this repo and ask it to fix the failure above, or run \`gh run view ${run?.databaseId} --log-failed\` for the full log.`,
  ].join("\n");
  try { writeFileSync(join(repoRoot, "CI-FAILURE-REPORT.md"), report, "utf8"); } catch { /* ignore */ }
}
```

- [ ] **Step 3: Dry-run still clean + helpers still green.**

Run: `node "C:\Users\user\.claude\skills\watch-ci\watch-ci.mjs" --dry-run` → returns 0.
Run: `node --test "C:\Users\user\.claude\skills\watch-ci\watch-ci.test.mjs"` → PASS.

- [ ] **Step 4: Toast smoke (Windows).**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\.claude\skills\watch-ci\toast.ps1" -Title "watch-ci test" -Message "hello"`
Expected: a Windows toast appears. (If toast APIs are unavailable in the environment, note it; the bell + report are the fallback.)

---

## Task 6: The `/watch-ci` launcher skill + README

**Files:**
- Create: `C:\Users\user\.claude\skills\watch-ci\SKILL.md`
- Create: `C:\Users\user\.claude\skills\watch-ci\README.md`

- [ ] **Step 1: Create `SKILL.md`** (the thin launcher — it starts the worker DETACHED and returns immediately so the session is freed):

```markdown
---
name: watch-ci
description: After pushing, launch the detached watch-ci worker that watches GitHub CI for the current repo's main branch and auto-fixes a red run in a bounded loop (escalating with a toast + CI-FAILURE-REPORT.md if it can't). Use right after `git push`.
---

# watch-ci — launch the CI watch + auto-fix worker

When the user invokes this skill (typically right after a push), start the standalone
worker as a DETACHED background process and return immediately — do not block the session.

Steps:
1. Confirm the cwd is a git repo with a GitHub remote and `gh` is authenticated
   (`gh auth status`). If not, tell the user how to fix it and stop.
2. Launch the worker detached so it survives this turn and does not tie up the session:
   - Bash tool, run_in_background: true →
     `node "$HOME/.claude/skills/watch-ci/watch-ci.mjs"`
     (on Windows the Bash tool maps `$HOME`; or use the absolute
     `C:/Users/user/.claude/skills/watch-ci/watch-ci.mjs`.)
3. Tell the user: "watch-ci is now watching <branch>. It will toast + bell on green, and
   auto-fix up to N=3 times on red, escalating with CI-FAILURE-REPORT.md if it can't.
   You're free to switch projects." Then end the turn.

Do NOT run the worker in the foreground or poll it yourself — it is autonomous.
Per-repo behavior is read from an optional `.watch-ci.json` (see README); with none it
defaults to branch=main, N=3, 30-min budget.
```

- [ ] **Step 2: Create `README.md`** documenting usage + the `.watch-ci.json` schema:

```markdown
# watch-ci

A zero-dep Node worker that watches GitHub Actions for a branch and auto-fixes a red run
in a bounded loop using a headless `claude -p`, with deterministic safety rails. Launched
by the `/watch-ci` Claude Code skill (after a push) or run directly:

    node ~/.claude/skills/watch-ci/watch-ci.mjs

## Requirements
- `gh` CLI authenticated (`gh auth status`)
- `claude` CLI on PATH (Claude Code headless)
- Run from inside the target git repo

## Optional per-repo config: `.watch-ci.json` (repo root)
```json
{
  "branch": "main",
  "workflow": null,
  "max_retries": 3,
  "max_total_minutes": 30,
  "preflight_job": "validate",
  "paths_denylist": [".github/workflows/", "tsconfig", "package.json", "pnpm-lock.yaml", "Cargo.toml", "Cargo.lock"]
}
```
With no file, the defaults above apply.

## Safety rails (deterministic, script-side)
Bounded N=3 + time budget · concurrency/SHA guard (won't fix a stale failure if you pushed
again) · empty-diff + loop-detection abort · path denylist (never edits build/config) ·
never force-pushes · secret-scrubbed logs · escalation = Windows toast + terminal bell +
`CI-FAILURE-REPORT.md`.
```

- [ ] **Step 3: Confirm the skill is discoverable.**

Run: `ls "C:\Users\user\.claude\skills\watch-ci\"`
Expected: `SKILL.md`, `README.md`, `watch-ci.mjs`, `watch-ci.test.mjs`, `toast.ps1`. (Claude Code discovers user skills under `~/.claude/skills/`; the `/watch-ci` skill should now be invocable.)

---

## Task 7: End-to-end validation against corelib (controlled)

Prove the loop on a real (but safe) failure, since the orchestration can't be unit-tested.

**Files:** none (validation only). **Requires:** the corelib remote is pushed at least once so CI runs (this is the first real push — get the user's explicit consent before pushing, per the standing no-push-without-consent rule).

- [ ] **Step 1: Pre-req — confirm CI actually runs.** With the user's consent, push `main` once so GitHub Actions executes the new `validate` pre-flight. Confirm a run appears: `gh run list --branch main --limit 1`.

- [ ] **Step 2: Inject a controlled, trivially-fixable failure** on a scratch commit — e.g. a lint error (an unused variable) or a one-character type error in a leaf file — and push it. (Choose a failure the pre-flight catches in ~1 min, NOT something that triggers the full matrix.)

- [ ] **Step 3: Launch the worker and observe the full loop.**

Run: `node "C:\Users\user\.claude\skills\watch-ci\watch-ci.mjs"`
Expected sequence in the log: `watching run …` → (red) → `attempt 1/3: fixing` → worktree created → `claude -p` fixes the injected error → rails pass → `fix pushed; re-watching` → next run green → `CI is GREEN ✅` + toast + bell. Confirm: the fix landed on `main`, no denied paths touched, the worktree was cleaned up (`git worktree list` shows none left), and no force-push occurred.

- [ ] **Step 4: Validate the escalation path** — inject a failure the agent canNOT fix in 3 tries (e.g. a failing assertion with an impossible expectation), launch the worker, and confirm after N=3 it stops, fires the toast/bell, and writes `CI-FAILURE-REPORT.md` with the scrubbed log + reason. Then revert the injected failure.

- [ ] **Step 5: Record the result.** Note the observed behavior (fix-path + escalate-path) in the PR/commit message or a short note; if any rail behaved unexpectedly, capture it for Phase 2.

> No commit for Task 7 itself (validation); any corelib scratch commits from Steps 2/4 must be reverted/cleaned so `main` ends green.

---

## Self-Review (planner checklist — completed)

- **Spec coverage:** D5 pre-flight → Task 1; D4 local-gate → Task 2; the `watch-ci` worker (D2/D6) → Tasks 3–5 (helpers, loop, escalation); all §5 rails → Task 4 (`attemptFix`) + Task 3 (`isDeniedPath`/`fingerprint`); §6 escalation → Task 5; the `/watch-ci` launcher skill → Task 6; §8 reusability (`.watch-ci.json`, global home) → Tasks 3/6; end-to-end + the live-flakiness isolation (§9) → Task 7 + Task 1's offline pre-flight note.
- **Type/name consistency:** exported helper names (`compressLog`, `scrubLog`, `isDeniedPath`, `fingerprint`, `resolveConfig`, `DEFAULT_CONFIG`) match between `watch-ci.mjs` and `watch-ci.test.mjs`; `attemptFix` return strings (`pushed`/`abort:*`) are handled in `main`; `success`/`escalate` referenced in Task 4 are defined in Task 5 (note the intentional cross-task forward reference — Task 4's non-dry-run path isn't exercised until Task 5 lands).
- **Oracle flag:** the non-interactive `claude -p` permission flag (Task 4 Step 1) is the one detail to confirm against the installed Claude Code — called out inline with a SHAPE_DIVERGENCE instruction.
- **Placeholders:** none — all code complete, all commands exact.
- **Two-homes hygiene:** Part A tasks commit to corelib (lefthook gate); Part B tasks write to `~/.claude/skills/watch-ci/` (no corelib commit). Task 7 is the only place corelib is pushed — gated on explicit user consent.
