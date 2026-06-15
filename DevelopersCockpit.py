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


config = load_env()

choices = [
    {'letter': 'P', 'desc': 'Check Prerequisites & Health'},
    {'letter': 'C', 'desc': 'Clean project & Reinstall Prerequisites (Fresh Start)', 'cmd': 'pnpm run clean-all'},
    {'letter': 'W', 'desc': 'Watch TypeScript', 'cmd': 'pnpm -r run watch --parallel'},
    {'letter': 'B', 'desc': 'Build TypeScript', 'cmd': 'pnpm -r run build'},
    {'letter': 'L', 'desc': 'Lint TypeScript Code', 'cmd': 'pnpm -r run lint'},
    {'letter': 'M', 'desc': 'Lint to File', 'cmd': f'pnpm -r run lint --fix > lint-output.txt'},
    {'letter': 'T', 'desc': 'Run Typescript Tests', 'cmd': 'pnpm -r run test'},
    {'letter': 'R', 'desc': 'Build Rust (Windows/Local)', 'cmd': None},
    {'letter': 'X', 'desc': 'Build Linux Rust FFI (via Docker for Cloud Deployment)', 'cmd': None},
    {'letter': 'U', 'desc': 'Run Rust Tests', 'cmd': 'cargo test --manifest-path rust/Cargo.toml'},
    {'letter': 'F', 'desc': 'Format Code', 'cmd': 'pnpm -r run format'},
    {'letter': 'V', 'desc': 'Bump version', 'cmd': 'pnpm -r run version patch'},
    {'letter': 'K', 'desc': 'Tag & Push Version to Origin', 'cmd': None},
    {'letter': 'H', 'desc': 'Trigger GitHub Release Workflow', 'cmd': 'gh workflow run release.yml'},
    {'letter': 'G', 'desc': 'Verify GitHub Release Assets', 'cmd': 'pwsh -ExecutionPolicy Bypass -File ./TestRelease.ps1'},
    {'letter': 'D', 'desc': 'Generate Documentation', 'cmd': 'pnpm run docs'},
    {'letter': 'A', 'desc': 'Analyze Module Dependencies (SVG)', 'cmd': 'npx depcruise --config .dependency-cruiser.js --output-type dot ts-core/src ts-markets/src ts-cloud/src | dot -T svg > full-modules.svg'},
    {'letter': 'E', 'desc': 'Create Local release package (Zip/Tar)'},
    {'letter': 'Q', 'desc': 'Quit', 'cmd': None},
]

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

def display_menu():
    config_str = ' | '.join([f"{k}={v}" for k, v in config.items()])
    version = get_current_version()
    title = f"Developers Cockpit [v{version}] [Config: {config_str}]"
    print(f"\n[CLI] {title}")
    print("-" * len(title))
    print("Select an option:")
    for choice in choices:
        print(f"{choice['letter']}: {choice['desc']}")

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
