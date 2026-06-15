# DevelopersCockpit.py Ergonomic Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh `corelib/DevelopersCockpit.py` into a data-driven, workflow-grouped dev menu with audited/`pnpm run`-correct commands, a working 6-file lockstep version bump, and pure-part tests — zero new dependencies, stdlib only.

**Architecture:** Single-file Python CLI. Make the module importable (guard the loop under `main()`), model each menu item as an `Action` dataclass in one `ACTIONS` list grouped into four velocity tiers, dispatch data-drivenly (no per-letter `if/elif`), and add a stdlib `unittest` file testing the pure parts.

**Tech Stack:** Python 3.14 stdlib (`dataclasses`, `subprocess`, `os`, `re`, `json`, `platform`, `unittest`). Commands shell out via `subprocess.run(shell=True)`.

**Spec:** `docs/superpowers/specs/2026-06-15-developerscockpit-ergonomic-refresh-design.md`

**Working directory:** all paths relative to the corelib repo root (where `DevelopersCockpit.py` lives). Run the cockpit from the repo root (it already assumes this).

---

## File Structure (final)

`DevelopersCockpit.py` — top-to-bottom order after refactor:
1. imports + constants (`IS_WINDOWS`, `CMD_SEP`, `TIERS`, `NO_COLOR`)
2. `load_env()` + `config` (module-level) + `get_current_version()`
3. `run_cmd()`
4. version helpers: `next_version()`, `bump_version()` (+ `_bump_json/_bump_cargo/_bump_readme`)
5. command builders: `get_health_cmd()`, `get_tag_push_cmd()`, `make_release_cmd()`
6. action handlers: `build_rust_windows()`, `build_rust_linux()`, `health_check()`, `make_release()`, `tag_and_push()`, `version_bump()`
7. `Action` dataclass + `ACTIONS` list
8. `render_menu()`
9. `main()` + `if __name__ == "__main__": main()`

`test_developerscockpit.py` — stdlib `unittest`, run from repo root: `python -m unittest test_developerscockpit -v`.

---

### Task 1: Make the module importable + test scaffold

**Files:**
- Modify: `DevelopersCockpit.py` (wrap the bottom `while True:` loop)
- Create: `test_developerscockpit.py`

- [ ] **Step 1 (Step 0 verify):** open `DevelopersCockpit.py`. Confirm the bottom of the file is a module-level `while True:` loop (starting ~line 159) that calls `display_menu()` and `input(...)`, and that `config = load_env()` is assigned at module level (~line 43). If the structure differs, STOP and report `STATE_MISMATCH`.

- [ ] **Step 2: Write the failing test.** Create `test_developerscockpit.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


class TestImportable(unittest.TestCase):
    def test_import_does_not_launch_menu(self):
        # Importing must NOT block on input() or run the menu loop.
        import DevelopersCockpit  # noqa: F401
        self.assertTrue(hasattr(DevelopersCockpit, "main"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run it — verify it FAILS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: FAIL/hang — importing the current file executes the module-level `while True:` loop (blocks on `input()` / `EOFError`). (If it errors rather than hangs, that's still the failing state.)

- [ ] **Step 4: Wrap the loop in `main()`.** In `DevelopersCockpit.py`, replace the bottom module-level `while True:` block with a function and guard. The loop body is unchanged except indentation; the menu dispatch is rewritten later (Task 4) — for now keep the existing dispatch logic verbatim inside `main()`:

```python
def main():
    while True:
        display_menu()
        try:
            action = input("\nEnter the letter (Q to quit): ").strip().upper()
        except EOFError:
            break

        selected = next((c for c in choices if c['letter'] == action), None)
        if not selected:
            print("[CLI] Invalid action; try again.")
            continue

        if selected['letter'] == 'Q':
            print("[CLI] Quitting...")
            sys.exit(0)

        if selected['letter'] == 'R':
            build_rust_windows()
        elif selected['letter'] == 'X':
            build_rust_linux()
        else:
            cmd = selected.get('cmd')
            if selected['letter'] == 'P': cmd = get_health_cmd()
            elif selected['letter'] == 'E': cmd = get_release_cmd()
            elif selected['letter'] == 'K': cmd = get_tag_push_cmd()

            if cmd:
                run_cmd(cmd)
            else:
                print("[CLI] Command not defined for this action.")

        input("\nPress Enter to continue...")


if __name__ == "__main__":
    main()
```

(Leave `config = load_env()` and all functions at module level above `main`.)

- [ ] **Step 5: Run the test — PASS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: PASS (`test_import_does_not_launch_menu`).

- [ ] **Step 6: Commit.**

```bash
git add DevelopersCockpit.py test_developerscockpit.py
git commit -m "refactor(cockpit): guard menu loop in main() so module is importable + test scaffold"
```

---

### Task 2: Version helpers — `next_version` + 6-file lockstep `bump_version`

**Files:**
- Modify: `DevelopersCockpit.py` (add helpers near the other version code, after `get_current_version`)
- Modify: `test_developerscockpit.py`

- [ ] **Step 1: Write the failing tests.** Append to `test_developerscockpit.py`:

```python
import shutil
import tempfile

import DevelopersCockpit as dc


class TestNextVersion(unittest.TestCase):
    def test_patch(self):
        self.assertEqual(dc.next_version("0.1.17", "patch"), "0.1.18")

    def test_minor(self):
        self.assertEqual(dc.next_version("0.1.17", "minor"), "0.2.0")

    def test_major(self):
        self.assertEqual(dc.next_version("0.1.17", "major"), "1.0.0")

    def test_bad_level(self):
        with self.assertRaises(ValueError):
            dc.next_version("0.1.17", "nope")


class TestBumpTargetSet(unittest.TestCase):
    def _seed(self, root):
        files = {
            "package.json": '{\n  "name": "root",\n  "version": "0.1.17"\n}\n',
            "ts-core/package.json": '{\n  "version": "0.1.17"\n}\n',
            "ts-markets/package.json": '{\n  "version": "0.1.17",\n  "dependencies": { "@ckir/corelib": "workspace:*" }\n}\n',
            "ts-cloud/package.json": '{\n  "version": "0.1.17"\n}\n',
            "rust/Cargo.toml": '[package]\nname = "corelib-rust"\nversion = "0.1.17"\nedition = "2021"\n',
            "README.md": "Install: download/v0.1.17/ckir-corelib-0.1.17.tgz and ckir-corelib-markets-0.1.17.tgz\n",
            # historical doc — MUST NOT be touched
            "docs/superpowers/old.md": "At the time this was version 0.1.17 (historical).\n",
        }
        for rel, content in files.items():
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)

    def test_bumps_six_files_leaves_history(self):
        root = tempfile.mkdtemp()
        cwd = os.getcwd()
        try:
            self._seed(root)
            os.chdir(root)
            old, new, changed = dc.bump_version("patch")
            self.assertEqual((old, new), ("0.1.17", "0.1.18"))
            # all six targets bumped
            for rel in ["package.json", "ts-core/package.json", "ts-markets/package.json",
                        "ts-cloud/package.json", "rust/Cargo.toml", "README.md"]:
                with open(rel, encoding="utf-8") as f:
                    text = f.read()
                self.assertIn("0.1.18", text, f"{rel} not bumped")
                self.assertNotIn("0.1.17", text, f"{rel} still has old version")
            # workspace:* ref untouched
            with open("ts-markets/package.json", encoding="utf-8") as f:
                self.assertIn("workspace:*", f.read())
            # historical doc untouched
            with open("docs/superpowers/old.md", encoding="utf-8") as f:
                self.assertIn("0.1.17", f.read())
        finally:
            os.chdir(cwd)
            shutil.rmtree(root, ignore_errors=True)
```

- [ ] **Step 2: Run — verify it FAILS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: FAIL (`AttributeError: module has no attribute 'next_version'` / `bump_version`).

- [ ] **Step 3: Implement the helpers.** In `DevelopersCockpit.py`, add `import re` to the imports, and add after `get_current_version`:

```python
VERSION_JSON_FILES = [
    "package.json",
    os.path.join("ts-core", "package.json"),
    os.path.join("ts-markets", "package.json"),
    os.path.join("ts-cloud", "package.json"),
]
VERSION_CARGO_FILE = os.path.join("rust", "Cargo.toml")
VERSION_README_FILE = "README.md"


def next_version(current, level):
    """Compute the next semver. Raises ValueError on a bad level."""
    major, minor, patch = (int(x) for x in current.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    if level == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError(f"unknown bump level: {level}")


def _bump_json_version(path, old, new):
    """Replace the first `"version": "old"` (format-preserving). Returns #changes."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    pattern = r'("version"\s*:\s*)"' + re.escape(old) + r'"'
    new_text, n = re.subn(pattern, r'\g<1>"' + new + '"', text, count=1)
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
    return n


def _bump_cargo_version(path, old, new):
    """Replace the first `version = "old"` line under [package]. Returns #changes."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    pattern = r'(?m)^version = "' + re.escape(old) + r'"'
    new_text, n = re.subn(pattern, f'version = "{new}"', text, count=1)
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
    return n


def _bump_readme_version(path, old, new):
    """Bump the install/release-URL refs only: `v<old>` and `-<old>.tgz`. Returns #changes."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    n = text.count(f"v{old}") + text.count(f"-{old}.tgz")
    text = text.replace(f"v{old}", f"v{new}").replace(f"-{old}.tgz", f"-{new}.tgz")
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return n


def bump_version(level):
    """Lockstep-bump the version across the explicit target set (4 package.json +
    Cargo.toml + README install refs). NEVER touches historical/planning docs.
    Returns (old, new, {path: change_count}). Does not git-commit/tag."""
    old = get_current_version()
    new = next_version(old, level)
    changed = {}
    for p in VERSION_JSON_FILES:
        if os.path.exists(p):
            changed[p] = _bump_json_version(p, old, new)
    if os.path.exists(VERSION_CARGO_FILE):
        changed[VERSION_CARGO_FILE] = _bump_cargo_version(VERSION_CARGO_FILE, old, new)
    if os.path.exists(VERSION_README_FILE):
        changed[VERSION_README_FILE] = _bump_readme_version(VERSION_README_FILE, old, new)
    return old, new, changed
```

- [ ] **Step 4: Run — PASS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: PASS (`TestNextVersion.*`, `TestBumpTargetSet.test_bumps_six_files_leaves_history`).

- [ ] **Step 5: Commit.**

```bash
git add DevelopersCockpit.py test_developerscockpit.py
git commit -m "feat(cockpit): 6-file lockstep version bump (next_version + bump_version)"
```

---

### Task 3: Fix the local-release command (`make_release_cmd`)

**Files:**
- Modify: `DevelopersCockpit.py` (replace `get_release_cmd`)
- Modify: `test_developerscockpit.py`

- [ ] **Step 1: Write the failing test.** Append to `test_developerscockpit.py`:

```python
class TestReleaseCmd(unittest.TestCase):
    def test_no_python_list_repr(self):
        cmd = dc.make_release_cmd()
        if cmd is not None:
            self.assertNotIn("['", cmd, "release cmd leaked a Python list repr")
            self.assertNotIn("']", cmd)

    def test_platform_shape(self):
        # Force a known existing path so the command is non-None.
        cmd = dc.make_release_cmd()
        if cmd is not None:
            if dc.IS_WINDOWS:
                self.assertIn("Compress-Archive", cmd)
                self.assertTrue(cmd.startswith("pwsh "), "must invoke pwsh, not bare cmdlet")
            else:
                self.assertIn("tar -czf", cmd)
```

- [ ] **Step 2: Run — verify it FAILS** (the current `get_release_cmd` produces `{files.split()}` list-repr; and the function is named `get_release_cmd`, not `make_release_cmd`).

Run: `python -m unittest test_developerscockpit -v`
Expected: FAIL (`AttributeError: make_release_cmd`).

- [ ] **Step 3: Replace `get_release_cmd` with `make_release_cmd`.** In `DevelopersCockpit.py`, delete the old `get_release_cmd` and add:

```python
def make_release_cmd():
    """Build a local release archive command. Filters to paths that exist (a missing
    path hard-fails the archive). Windows uses pwsh (Compress-Archive is a cmdlet, not a
    cmd.exe builtin); POSIX uses tar. Returns None if nothing to archive."""
    candidates = [
        "ts-core/dist", "ts-cloud/dist", "ts-markets/dist",
        "rust/target/release", "package.json", "LICENSE", "README.md",
    ]
    existing = [f for f in candidates if os.path.exists(f)]
    if not existing:
        return None
    if IS_WINDOWS:
        quoted = ",".join(f"'{f}'" for f in existing)
        inner = f"Compress-Archive -Path {quoted} -DestinationPath release.zip -Force"
        return f'pwsh -NoProfile -NonInteractive -Command "{inner}"'
    return f'tar -czf release.tar.gz {" ".join(existing)}'
```

- [ ] **Step 4: Run — PASS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: PASS (`TestReleaseCmd.*`).

- [ ] **Step 5: Commit.**

```bash
git add DevelopersCockpit.py test_developerscockpit.py
git commit -m "fix(cockpit): local release archive — pwsh-wrapped Compress-Archive + path filter (was list-repr bug)"
```

---

### Task 4: Data-driven `Action`/`ACTIONS` + dispatch (the regroup + audit)

**Files:**
- Modify: `DevelopersCockpit.py` (add `Action`, `ACTIONS`, handlers; rewrite `main()` dispatch; remove old `choices`)
- Modify: `test_developerscockpit.py`

- [ ] **Step 1: Write the failing tests.** Append to `test_developerscockpit.py`:

```python
class TestActionsIntegrity(unittest.TestCase):
    def test_keys_unique_upper_single(self):
        keys = [a.key for a in dc.ACTIONS]
        self.assertEqual(len(keys), len(set(keys)), "duplicate keys")
        self.assertTrue(all(len(k) == 1 and k.isupper() for k in keys))

    def test_exactly_one_of_cmd_or_handler(self):
        for a in dc.ACTIONS:
            self.assertTrue(
                bool(a.cmd) ^ bool(a.handler),
                f"action {a.key} must have exactly one of cmd/handler",
            )

    def test_group_is_a_known_tier(self):
        for a in dc.ACTIONS:
            self.assertIn(a.group, dc.TIERS)

    def test_pnpm_run_convention(self):
        # No bare `pnpm <script>` — must be `pnpm run <script>` (pnpm docs opens npmjs).
        for a in dc.ACTIONS:
            if a.cmd and a.cmd.startswith("pnpm ") and not a.cmd.startswith("pnpm exec"):
                self.assertTrue(a.cmd.startswith("pnpm run "), f"{a.key}: {a.cmd!r}")

    def test_rust_tests_single_threaded(self):
        u = next(a for a in dc.ACTIONS if a.key == "U")
        self.assertIn("--test-threads=1", u.cmd)

    def test_has_new_workflow_items(self):
        keys = {a.key for a in dc.ACTIONS}
        self.assertTrue({"Y", "N", "I", "J"}.issubset(keys))  # verify:fast, typecheck, integration, verify:full
        self.assertNotIn("M", keys)  # dropped lint-to-file
```

- [ ] **Step 2: Run — verify it FAILS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: FAIL (`AttributeError: ACTIONS` / `TIERS`).

- [ ] **Step 3: Add the model, handlers, and ACTIONS.** In `DevelopersCockpit.py`: add `from dataclasses import dataclass` and `from typing import Callable, Optional` to imports. Add the handler wrappers (after the builder functions) and the model + data:

```python
def health_check():
    run_cmd(get_health_cmd(), ignore_error=True)


def make_release():
    cmd = make_release_cmd()
    if cmd:
        run_cmd(cmd)
    else:
        print("[CLI] No build artifacts found to package (run a build first).")


def tag_and_push():
    run_cmd(get_tag_push_cmd())


def version_bump():
    old = get_current_version()
    print(f"[CLI] Current version: {old}")
    level = input("[CLI] Bump level [patch/minor/major] (Enter=patch): ").strip().lower() or "patch"
    if level not in ("patch", "minor", "major"):
        print("[CLI] Invalid level; aborting bump.")
        return
    old, new, changed = bump_version(level)
    print(f"[CLI] {old} -> {new}")
    for path, count in changed.items():
        print(f"[CLI]   {path}: {count} change(s)")
    print("[CLI] Not committed/tagged — use 'K' to tag & push.")


TIERS = ["INNER LOOP", "QUALITY GATE", "SHIP & RELEASE", "HOUSEKEEPING"]


@dataclass
class Action:
    key: str
    group: str
    desc: str
    cmd: Optional[str] = None
    handler: Optional[Callable[[], None]] = None
    note: str = ""


ACTIONS = [
    # [1] INNER LOOP
    Action("W", "INNER LOOP", "Watch all", cmd="pnpm run watch-all"),
    Action("B", "INNER LOOP", "Build all", cmd="pnpm run build-all"),
    Action("R", "INNER LOOP", "Build Rust (local)", handler=build_rust_windows),
    Action("F", "INNER LOOP", "Format all", cmd="pnpm run format-all", note="mutates"),
    # [2] QUALITY GATE
    Action("Y", "QUALITY GATE", "Verify fast (format+lint+typecheck)", cmd="pnpm run verify:fast", note="mutates"),
    Action("N", "QUALITY GATE", "Typecheck all", cmd="pnpm run typecheck-all"),
    Action("L", "QUALITY GATE", "Lint all", cmd="pnpm run lint-all", note="mutates"),
    Action("T", "QUALITY GATE", "Unit tests", cmd="pnpm run test-all:run"),
    Action("U", "QUALITY GATE", "Rust tests", cmd="cargo test --manifest-path rust/Cargo.toml -- --test-threads=1"),
    Action("I", "QUALITY GATE", "Integration tests", cmd="pnpm run test:integration"),
    Action("J", "QUALITY GATE", "Verify full (build+test)", cmd="pnpm run verify:full"),
    # [3] SHIP & RELEASE
    Action("X", "SHIP & RELEASE", "Build Rust (Linux/Docker)", handler=build_rust_linux),
    Action("V", "SHIP & RELEASE", "Version bump (lockstep)", handler=version_bump),
    Action("K", "SHIP & RELEASE", "Tag & push version", handler=tag_and_push),
    Action("H", "SHIP & RELEASE", "Trigger GitHub release", cmd="gh workflow run release.yml"),
    Action("E", "SHIP & RELEASE", "Local release package (zip/tar)", handler=make_release),
    Action("G", "SHIP & RELEASE", "Verify release assets", cmd="pwsh -ExecutionPolicy Bypass -File ./TestRelease.ps1"),
    # [4] HOUSEKEEPING
    Action("P", "HOUSEKEEPING", "Health check (tool versions)", handler=health_check),
    Action("C", "HOUSEKEEPING", "Clean & reinstall", cmd="pnpm run clean-all"),
    Action("D", "HOUSEKEEPING", "Generate docs", cmd="pnpm run docs"),
    Action("A", "HOUSEKEEPING", "Dependency graph (SVG)",
           cmd="npx depcruise --config .dependency-cruiser.js --output-type dot ts-core/src ts-markets/src ts-cloud/src | dot -T svg > full-modules.svg"),
    Action("Q", "HOUSEKEEPING", "Quit", handler=lambda: sys.exit(0)),
]
```

Then DELETE the old `choices = [...]` list and the old `display_menu()` (replaced in Task 5), and rewrite `main()`'s dispatch to be data-driven:

```python
def main():
    while True:
        render_menu()
        try:
            key = input("\nEnter the letter (Q to quit): ").strip().upper()
        except EOFError:
            break
        action = next((a for a in ACTIONS if a.key == key), None)
        if action is None:
            print("[CLI] Invalid action; try again.")
            continue
        try:
            if action.handler is not None:
                action.handler()
            else:
                run_cmd(action.cmd)
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001 — keep the menu alive on any command error
            print(f"[CLI] Error: {e}")
        input("\nPress Enter to continue...")
```

(`render_menu` is added in Task 5. To keep the module importable between tasks, add a temporary `def render_menu(): pass` placeholder now if implementing strictly task-by-task — it is fully defined in Task 5.)

- [ ] **Step 4: Run — PASS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: PASS (all `TestActionsIntegrity.*`).

- [ ] **Step 5: Commit.**

```bash
git add DevelopersCockpit.py test_developerscockpit.py
git commit -m "refactor(cockpit): data-driven Action/ACTIONS, 4 workflow tiers, audited commands"
```

---

### Task 5: Tiered colored render + final wiring

**Files:**
- Modify: `DevelopersCockpit.py` (implement `render_menu`; remove the old `display_menu` if still present)

- [ ] **Step 1 (Step 0 verify):** confirm `display_menu` (old) is gone or about to be replaced, and `render_menu` is referenced by `main()`. Confirm `config` is module-level.

- [ ] **Step 2: Implement `render_menu` + color helper.** Add near the top (after `config`):

```python
NO_COLOR = "NO_COLOR" in os.environ


def _color(code, text):
    if NO_COLOR or not sys.stdout.isatty():
        return text
    return f"\033[{code}m{text}\033[0m"
```

And implement `render_menu` (replacing any placeholder / the old `display_menu`):

```python
def render_menu():
    version = get_current_version()
    config_str = " | ".join(f"{k}={v}" for k, v in config.items())
    print()
    banner = f"DEVELOPERS COCKPIT  v{version}"
    if config_str:
        banner += f"   [{config_str}]"
    print(_color("1;36", banner))
    for tier in TIERS:
        header = f"-- [{TIERS.index(tier) + 1}] {tier} "
        print(_color("1;33", header + "-" * max(4, 52 - len(header))))
        for a in ACTIONS:
            if a.group == tier:
                note = _color("0;90", f"  ({a.note})") if a.note else ""
                print(f"  {_color('1;32', a.key)}  {a.desc}{note}")
```

- [ ] **Step 3: Run the full test suite — PASS.**

Run: `python -m unittest test_developerscockpit -v`
Expected: PASS (all tests green).

- [ ] **Step 4: Manual smoke (render without color, no menu hang).**

Run: `python -c "import os; os.environ['NO_COLOR']='1'; import DevelopersCockpit as d; d.render_menu()"`
Expected: prints the four tiers (INNER LOOP / QUALITY GATE / SHIP & RELEASE / HOUSEKEEPING) with their items, plain text, no ANSI codes, and exits cleanly (does not block on input).

- [ ] **Step 5: Lint sanity (optional, stdlib only — no new deps).**

Run: `python -m py_compile DevelopersCockpit.py test_developerscockpit.py`
Expected: no output (compiles clean).

- [ ] **Step 6: Commit.**

```bash
git add DevelopersCockpit.py
git commit -m "feat(cockpit): tiered colored menu render (NO_COLOR/non-TTY aware)"
```

---

## Self-Review

**1. Spec coverage:**
- §4.1 data-driven structure → Task 4 (`Action`/`ACTIONS`, dispatch). ✓
- §4.2 four tiers + preserved letters → Task 4 ACTIONS + Task 5 render. ✓
- §4.3 audit (delegate to `*-all`, `pnpm run`, drop M, add Y/N/I/J, U `--test-threads=1`) → Task 4 ACTIONS + `test_pnpm_run_convention`/`test_rust_tests_single_threaded`/`test_has_new_workflow_items`. ✓
- §4.4 version bump (6-file lockstep, no historical docs) → Task 2 + `TestBumpTargetSet`. ✓
- §4.5 release fix (pwsh, list-repr, path filter) → Task 3 + `TestReleaseCmd`. ✓
- §4.6 cosmetics (color, NO_COLOR/TTY) → Task 5. ✓
- §5 error handling (shell=True kept; menu survives errors) → Task 4 `main()` try/except. ✓
- §6 testing (pure parts, stdlib unittest) → Tasks 1-4 tests. ✓
- §7 success criteria → covered across tasks. ✓

**2. Placeholder scan:** the only "placeholder" is the deliberate temporary `def render_menu(): pass` in Task 4, fully replaced in Task 5 — called out explicitly, not a gap. No TBDs. All code blocks complete.

**3. Type/name consistency:** `Action(key, group, desc, cmd, handler, note)`, `ACTIONS`, `TIERS`, `next_version`, `bump_version`, `make_release_cmd`, `render_menu`, `health_check`/`make_release`/`tag_and_push`/`version_bump` handlers, `build_rust_windows`/`build_rust_linux` (preserved), `get_health_cmd`/`get_tag_push_cmd` (preserved) — names are consistent across tasks and tests. `get_release_cmd` is removed and fully replaced by `make_release_cmd` (Task 3 + the `E` handler `make_release`).

**Executor notes:**
- Edit the canonical file `corelib/DevelopersCockpit.py` (repo root). The worktree copy is a checkout of the same file; work wherever the branch for this refresh lives.
- Run tests from the repo root so relative imports/paths resolve: `python -m unittest test_developerscockpit -v`.
- Preserve the existing `load_env`, `get_current_version`, `get_health_cmd`, `get_tag_push_cmd`, `build_rust_windows`, `build_rust_linux`, `run_cmd` bodies (only `get_release_cmd`→`make_release_cmd` is replaced, and the bottom loop is restructured).
- Zero new dependencies — stdlib only.
```
