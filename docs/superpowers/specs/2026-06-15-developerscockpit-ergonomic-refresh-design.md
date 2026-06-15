# DevelopersCockpit.py — Ergonomic Refresh (Design)

**Date:** 2026-06-15
**Status:** DRAFT (design)
**Target:** `corelib/DevelopersCockpit.py` (the corelib dev-menu CLI).

---

## 1. Goal

Refresh the pre-AI-era `DevelopersCockpit.py` so its menu is **organized around a programmer's actual workflow** and its commands are **current with the monorepo's `package.json` scripts**. Two intertwined jobs: (a) regroup the flat 19-item lettered menu into workflow tiers, and (b) audit/fix/modernize the commands (delegate to the now-existing aggregate scripts, surface missing ones, fix stale/broken entries).

## 2. Scope & non-goals

**In scope:** `corelib/DevelopersCockpit.py` only.

**Non-goals (decided with the user):**
- NOT `DevelopersCockpitCloud.py`, the MarketMonitor copy, or the `.ps1` variants (siblings can follow later).
- NO arrow-key/fuzzy TUI; NO external dependencies (`rich`/`questionary`/`textual`). Stdlib only.
- Keep the **letter + Enter** selection mechanic (`input()`). The ergonomic win is the grouping, color, audited commands, and cleaner code — not the keypress mechanic.
- Not a rewrite: preserve the working builder functions (health check, rust-win build+copy, rust-linux docker) and the overall single-file shape.

## 3. Current state (audited)

A flat 19-letter menu; `input()` → look up letter → `subprocess.run(shell=True)` → "Press Enter". Letters P/E/K/R/X are special-cased with Python builder functions. Audit vs. the current scripts found: missing aggregates (`verify:fast`, `verify:full`, `typecheck-all`, the integration tier), a broken `V` (`pnpm -r run version patch` — no `version` script exists anywhere), a real bug in `E` (interpolates a Python list repr into `Compress-Archive`), and `U` (Rust tests) missing the **mandatory** `--test-threads=1` (corelib's global flight-recorder ring makes parallel runs flaky).

## 4. Design

### 4.1 Data-driven structure (replaces the special-case `if/elif`)

Model each action as a record and drive the menu + dispatch from data — this is what makes grouping clean and kills the tangled P/E/K/R/X branches:

```python
@dataclass
class Action:
    key: str            # uppercase letter
    group: str          # tier name (see 4.2)
    desc: str           # menu label
    cmd: str | None = None       # shell command (run via subprocess shell=True)
    handler: Callable[[], None] | None = None   # Python fn (build_rust_win, etc.)
    note: str = ""      # optional shown hint (e.g. "mutates files", "--test-threads=1")
```

One ordered `ACTIONS: list[Action]`. The render loop groups by `group` (insertion-ordered tiers); the dispatch loop does `action.handler() if action.handler else run_cmd(action.cmd)`. No per-letter conditionals. Builder functions (`build_rust_windows`, `build_rust_linux`, `health_check`, `version_bump`, `make_release`, `tag_and_push`) become `handler`s.

### 4.2 Workflow tiers (grouped by action velocity)

Four tiers, ordered by how often you reach for them (agy's velocity grouping):

```
 DEVELOPERS COCKPIT  v0.1.17   runtime=node
 ── [1] INNER LOOP ──────────────────────────────
   W  Watch all              pnpm run watch-all
   B  Build all              pnpm run build-all
   R  Build Rust (local)     napi build:local → copy to ts-core   [handler]
   F  Format all             pnpm run format-all                      (mutates)
 ── [2] QUALITY GATE ────────────────────────────
   Y  Verify fast       ★    pnpm run verify:fast   (format+lint+typecheck; mutates)
   N  Typecheck         ★    pnpm run typecheck-all (no mutation)
   L  Lint all               pnpm run lint-all                        (mutates)
   T  Unit tests             pnpm run test-all:run
   U  Rust tests        ⚙    cargo test --manifest-path rust/Cargo.toml -- --test-threads=1
   I  Integration tests ★    pnpm run test:integration
   J  Verify full       ★    pnpm run verify:full   (build + test)
 ── [3] SHIP & RELEASE ──────────────────────────
   X  Build Rust (Linux)     docker (Dockerfile.linux → cloud dist)  [handler]
   V  Version bump      ⚙    lockstep bump of all 5 manifests        [handler]
   K  Tag & push             git tag vX + push                       [handler]
   H  GitHub release         gh workflow run release.yml
   E  Local package     ⚙    zip (Windows) / tar (POSIX)             [handler, bug-fixed]
   G  Verify release          pwsh TestRelease.ps1
 ── [4] HOUSEKEEPING ────────────────────────────
   P  Health check           tool versions                          [handler]
   C  Clean all              pnpm run clean-all
   D  Docs                   pnpm run docs
   A  Dependency graph (SVG) npx depcruise … | dot -T svg
   Q  Quit
```

`★` = newly surfaced existing script. `⚙` = audited fix. Dropped: the old `M` "lint to file" (`--fix` was bogus; redirecting `lint-all` to a file is trivial ad-hoc — YAGNI). Letters are preserved where they already existed (muscle memory); new items use free letters (Y, N, I, J).

### 4.3 Command audit — resolutions

| Item | Old | New |
|---|---|---|
| W Watch | `pnpm -r run watch --parallel` | `pnpm run watch-all` |
| B Build | `pnpm -r run build` | `pnpm run build-all` |
| F Format | `pnpm -r run format` | `pnpm run format-all` |
| L Lint | `pnpm -r run lint` | `pnpm run lint-all` |
| T Unit tests | `pnpm -r run test` (watch) | `pnpm run test-all:run` (one-shot) |
| U Rust tests | `cargo test --manifest-path rust/Cargo.toml` | **+ ` -- --test-threads=1`** (mandatory) |
| Y Verify fast | — | `pnpm run verify:fast` ★ |
| N Typecheck | — | `pnpm run typecheck-all` ★ |
| I Integration | — | `pnpm run test:integration` ★ |
| J Verify full | — | `pnpm run verify:full` ★ |
| V Version bump | `pnpm -r run version patch` (broken) | lockstep handler (4.4) |
| E Local package | `{files.split()}` list-repr bug | fixed builder (4.5) |
| M Lint to file | `pnpm -r run lint --fix > …` | **dropped** |
| C/D/A/H/G/K/P/R/X | (unchanged or already correct) | kept; R/X/P/K builders retained |

**pnpm invocation convention (REQUIRED):** always `pnpm run <script>`, never bare `pnpm <script>`. `pnpm docs` invokes pnpm's built-in *open-package-homepage* command (opens npmjs in a browser) instead of the `docs` script — the original cockpit correctly used `pnpm run docs`. Explicit `run` avoids this and every other built-in-name collision. All script rows above and the menu use `pnpm run …` accordingly.

### 4.4 Version bump (`V`) — lockstep handler

Evidence: all five manifests (`package.json`, `ts-core/`, `ts-markets/`, `ts-cloud/` package.json, `rust/Cargo.toml`) are in lockstep at `0.1.17`; no changesets, no release-workflow versioning. **And the version is also embedded in `README.md`** (the install snippets: the `v0.1.17` release-tag path and the `ckir-corelib[-markets]-0.1.17.tgz` filenames — 5 spots). So `V` becomes a stdlib Python handler that: reads the current version (from `ts-core/package.json`, as `get_current_version` already does), prompts `patch/minor/major`, computes the next semver, and **writes the new version across an EXPLICIT target set** in sync. Prints old→new + the per-file change count. Does NOT git-commit/tag (that's `K`'s job).

**Target set (explicit — NEVER a blanket repo scan):**
1. The four `package.json` `version` fields (JSON edit).
2. `rust/Cargo.toml` — the `version = "x.y.z"` line (anchored line edit, the first `version =` under `[package]`).
3. **`README.md`** — replace the old version token in the install/release-URL references (`v<old>` → `v<new>` and `-<old>.tgz` → `-<new>.tgz`).

**Do NOT touch historical/planning docs.** `0.1.17` also appears in `ANTIGRAVITY-TO-CLAUDE.md` and `docs/superpowers/**` — those are point-in-time records, not live version refs. The handler operates ONLY on the enumerated target set; it must not grep-and-replace the version across all `*.md`.

**No sibling-ref / lockfile churn (verified, closes agy 🔴/🟡):** the inter-package deps use `workspace:*` (`ts-cloud`/`ts-markets` → `@ckir/corelib*`), not pinned `workspace:^x.y.z`, so a version bump needs **no** updates to `dependencies` ranges and does **not** desync `pnpm-lock.yaml` (workspace links are by name). The handler edits only the version fields/refs; no `pnpm install` required.

> **CONFIRM AT REVIEW:** (a) manual lockstep versioning across these six files is the intended flow? (b) Are there OTHER live version-bearing files beyond the 5 manifests + `README.md` (e.g. a docs install guide, a badge) that should be in the target set? Name them and I'll add them; the design keeps the set explicit/configurable so adding a file is trivial.

### 4.5 Local package (`E`) — bug fix

Current: `f'... -Path {files.split()} ...'` emits a Python list repr. Fix: build the path set explicitly **and filter to paths that exist** (a missing path hard-fails the archive). `Compress-Archive` is a PowerShell cmdlet, not a `cmd.exe` builtin — so the Windows branch MUST wrap it in pwsh (the original cockpit did; preserve that), e.g.:
- **Windows:** `pwsh -NoProfile -NonInteractive -Command "Compress-Archive -Path <comma-joined 'single-quoted' paths> -DestinationPath release.zip -Force"`
- **POSIX:** `tar -czf release.tar.gz <space-joined paths>`

Build the path list in Python from the existing file set (`ts-core/dist ts-cloud/dist ts-markets/dist rust/target/release package.json LICENSE README.md`), dropping any that don't exist before composing the command. (agy convergent 🔴/🟡 — cmd.exe vs pwsh + missing-file filtering.)

### 4.6 Cosmetics (zero-dep)

ANSI color for tier headers + the version/runtime banner, via a tiny helper. **Respect `NO_COLOR` and non-TTY** (`sys.stdout.isatty()`) → emit plain text (so piped/redirected output stays clean). Letters shown in a stable column. No other visual machinery.

## 5. Error handling

- `run_cmd` keeps `shell=True` (needed for the `&&` health chain, the `depcruise | dot` pipe, `>` redirects) and the existing try/except on `CalledProcessError`; surface a clear `✗ <cmd> failed (exit N)` and return to the menu (never crash the loop).
- Missing-tool / missing-file paths (health check, release file set) degrade gracefully (already partly done).
- Known risk (agy): long-running `watch-all` spawns node daemons; on `Ctrl+C` the cockpit returns to the menu — document that watchers are foreground and Ctrl+C stops them (orphans are an inherent risk of running watchers from a menu; not solved here).

## 6. Testing

It's an interactive single-file dev tool, so test the **pure/data parts**, not the input loop:
- `ACTIONS` integrity: every action has exactly one of `cmd`/`handler`; all `key`s unique + uppercase; every action's `group` is one of the four tiers.
- `next_version("0.1.17", "patch"|"minor"|"major")` → `"0.1.18"|"0.2.0"|"1.0.0"`.
- `make_release_cmd()` emits no Python-list-repr (regression guard for the 4.5 bug); contains the expected archive verb per platform.
- **Version bump:** against a temp fixture (copies of the six target files seeded at a known version), the bump rewrites the version in ALL six (4 package.json + Cargo.toml + README's `v<x>`/`-<x>.tgz` refs) to the new value, and a seeded historical-doc fixture (e.g. a `docs/…md` containing the old version) is **left untouched** — proving the explicit-target-set discipline.
- A smoke check that the menu renders all four tiers without error.
Run under the repo's Python (3.14 per the `__pycache__`). No new test framework — a `if __name__ == "__main__"`-guarded `--selftest` flag or a tiny `pytest`/`unittest` file (decide in plan).

## 7. Success criteria

1. Menu renders in four workflow tiers; letters preserved for existing items; color respects `NO_COLOR`/non-TTY.
2. Commands delegate to current scripts; `verify:fast`, `verify:full`, `typecheck-all`, `test:integration` are reachable; no `pnpm -r run …` hand-rolls remain where an aggregate exists.
3. `U` runs Rust tests with `--test-threads=1`; `E` produces a valid archive (no list-repr); `V` bumps the version in lockstep across the six target files (4 package.json + `rust/Cargo.toml` + `README.md` install refs) while leaving historical/planning docs untouched; the dead `M`/broken `V` paths are gone.
4. Data-driven dispatch — no per-letter `if/elif` chain; builders are `handler`s.
5. Zero new runtime dependencies; runs on stdlib Python. Pure-part tests pass.
