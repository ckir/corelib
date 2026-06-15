# =============================================
# FILE: DevelopersCockpit.py
# PURPOSE: Python-based Developers Cockpit CLI (moved from TS for cross-runtime simplicity)
# =============================================

import os
import re
import subprocess
import sys
import json
import platform
from dataclasses import dataclass
from typing import Callable, Optional

# Detect OS for command separators
IS_WINDOWS = platform.system() == "Windows"
CMD_SEP = "&&"


def load_env():
    config = {}
    try:
        with open('.env', 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    try:
                        key, value = line.split('=', 1)
                        config[key.strip()] = value.strip().strip("\"'")
                    except ValueError:
                        continue
    except FileNotFoundError:
        print("[CLI] .env not found; using defaults.")
    return config

def get_current_version():
    try:
        path = os.path.join('ts-core', 'package.json')
        if os.path.exists(path):
            with open(path, 'r') as f:
                return json.load(f).get('version', '0.1.0')
    except Exception:
        pass
    return "0.1.0"


VERSION_JSON_FILES = [
    "package.json",
    os.path.join("ts-core", "package.json"),
    os.path.join("ts-markets", "package.json"),
    os.path.join("ts-cloud", "package.json"),
]
VERSION_CARGO_FILE = os.path.join("rust", "Cargo.toml")
VERSION_CARGO_LOCK_FILE = os.path.join("rust", "Cargo.lock")
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
    """Replace the first `version = "old"` line under [package]. Space-invariant +
    preserves the original prefix/spacing. Returns #changes."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    pattern = r'(?m)^(\s*version\s*=\s*)"' + re.escape(old) + r'"'
    new_text, n = re.subn(pattern, r'\g<1>"' + new + '"', text, count=1)
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
    return n


def _bump_cargo_lock_version(path, old, new):
    """Sync the corelib-rust package's own version entry in Cargo.lock (matches what
    cargo writes on the next build). Targets ONLY the corelib-rust [[package]] block —
    `name = "corelib-rust"` immediately precedes its `version`. Returns #changes."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    pattern = r'(name = "corelib-rust"\nversion = ")' + re.escape(old) + r'(")'
    new_text, n = re.subn(pattern, r"\g<1>" + new + r"\g<2>", text, count=1)
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_text)
    return n


def _bump_readme_version(path, old, new):
    """Bump the install/release-URL refs only: `v<old>` (not followed by a digit, so
    `v0.1.17` never clobbers a `v0.1.170`) and `-<old>.tgz`. Returns #changes."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    v_pat = r'v' + re.escape(old) + r'(?!\d)'
    tgz_pat = r'-' + re.escape(old) + r'\.tgz'
    n = len(re.findall(v_pat, text)) + len(re.findall(tgz_pat, text))
    text = re.sub(v_pat, f'v{new}', text)
    text = re.sub(tgz_pat, f'-{new}.tgz', text)
    if n:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return n


def bump_version(level):
    """Lockstep-bump the version across the explicit target set (4 package.json +
    Cargo.toml + Cargo.lock + README install refs). NEVER touches historical/planning docs.
    Returns (old, new, {path: change_count}). Does not git-commit/tag."""
    old = get_current_version()
    new = next_version(old, level)
    changed = {}
    for p in VERSION_JSON_FILES:
        if os.path.exists(p):
            changed[p] = _bump_json_version(p, old, new)
    if os.path.exists(VERSION_CARGO_FILE):
        changed[VERSION_CARGO_FILE] = _bump_cargo_version(VERSION_CARGO_FILE, old, new)
    if os.path.exists(VERSION_CARGO_LOCK_FILE):
        changed[VERSION_CARGO_LOCK_FILE] = _bump_cargo_lock_version(VERSION_CARGO_LOCK_FILE, old, new)
    if os.path.exists(VERSION_README_FILE):
        changed[VERSION_README_FILE] = _bump_readme_version(VERSION_README_FILE, old, new)
    return old, new, changed


config = load_env()


def run_cmd(cmd, ignore_error=False):
    print(f"[CLI] Running: {cmd}")
    try:
        subprocess.run(cmd, shell=True, check=not ignore_error)
        return True
    except subprocess.CalledProcessError as e:
        if not ignore_error:
            print(f"[CLI] Error: {e}")
        return False

def build_rust_windows():
    print("[CLI] Building Rust FFI for Windows...")
    # Use napi build directly in rust dir for better isolation
    if run_cmd(f'cd rust {CMD_SEP} pnpm exec napi build --release'):
        # Copy to ts-core for local development
        src = os.path.join('rust', 'corelib-rust.node')
        dst = os.path.join('ts-core', 'corelib-rust.node')
        if os.path.exists(src):
            try:
                import shutil
                shutil.copy2(src, dst)
                print(f"[CLI] ✅ Windows binary updated in {dst} for local development.")
            except Exception as e:
                print(f"[CLI] Error copying binary: {e}")
        else:
            print("[CLI] Error: corelib-rust.node not found after build.")

def build_rust_linux():
    print("[CLI] Building Linux Rust FFI via Docker...")
    # 1. Build the compilation image
    if not run_cmd('docker build -t corelib-builder -f rust/Dockerfile.linux .'):
        return

    # 2. Extract binary via temporary container
    run_cmd('docker rm -f corelib-temp', ignore_error=True)
    if not run_cmd('docker create --name corelib-temp corelib-builder'):
        return

    try:
        # Create destination directories
        os.makedirs('ts-cloud/dist/aws', exist_ok=True)
        os.makedirs('ts-cloud/dist/cloudrun', exist_ok=True)

        # Copy to cloud deployment folders only (keeps ts-core windows-compatible)
        print("[CLI] Extracting Linux binaries to cloud deployment folders...")
        run_cmd('docker cp corelib-temp:/app/rust/corelib-rust.node ts-cloud/dist/aws/corelib-rust.node')
        run_cmd('docker cp corelib-temp:/app/rust/corelib-rust.node ts-cloud/dist/cloudrun/corelib-rust.node')
        run_cmd('docker cp corelib-temp:/app/rust/corelib-rust.node rust/corelib-rust.linux.node')
        
        print("[CLI] ✅ Linux binary placed in ts-cloud/dist/ folders for deployment.")
        print("[CLI] 💡 Local Windows development remains unaffected.")
    finally:
        run_cmd('docker rm -f corelib-temp', ignore_error=True)

def get_health_cmd():
    tools = [
        'pnpm --version', 'cargo --version', 'python --version', 'gh --version',
        'pnpm -C ts-cloud exec wrangler --version', 'gcloud --version', 'sam --version', 'docker --version',
        'act --version', 'wsl --version', 'fd --version', 'sd --version', 'rip --version', 'sops --version --check-for-updates'
    ]
    
    runtime = config.get('RUNTIME', 'node').lower()
    if runtime == 'bun': tools.append('bun --version')
    elif runtime == 'deno': tools.append('deno --version')
    elif runtime == 'node': tools.append('node --version')
    
    # Run tools individually so one failure doesn't stop the whole health check
    return f' {CMD_SEP} '.join([f'{t} || echo "[CLI] Tool {t.split()[0]} failed check"' for t in tools])

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

def get_tag_push_cmd():
    version = get_current_version()
    tag = f"v{version}"
    return f'git tag {tag} {CMD_SEP} git push origin {tag}'

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


NO_COLOR = "NO_COLOR" in os.environ


def _color(code, text):
    if NO_COLOR or not sys.stdout.isatty():
        return text
    return f"\033[{code}m{text}\033[0m"


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
        except Exception as e:  # keep the menu alive on any command error
            print(f"[CLI] Error: {e}")
        input("\nPress Enter to continue...")


if __name__ == "__main__":
    main()
