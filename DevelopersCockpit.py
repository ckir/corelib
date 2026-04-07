# =============================================
# FILE: DevelopersCockpit.py
# PURPOSE: Python-based Developers Cockpit CLI (moved from TS for cross-runtime simplicity)
# =============================================

import os
import subprocess
import sys
import json

def load_env():
    config = {}
    try:
        with open('.env', 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    key, value = line.split('=', 1)
                    config[key.strip()] = value.strip().strip("\"'")
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

config = load_env()

choices = [
    {'letter': 'P', 'desc': 'Check Prerequisites & Health'},
    {'letter': 'C', 'desc': 'Clean project & Reinstall Prerequisites (Fresh Start)', 'cmd': 'pnpm run clean-all'},
    {'letter': 'W', 'desc': 'Watch TypeScript', 'cmd': 'pnpm -r watch --parallel'},
    {'letter': 'B', 'desc': 'Build TypeScript', 'cmd': 'pnpm -r build'},
    {'letter': 'L', 'desc': 'Lint TypeScript Code', 'cmd': 'pnpm -r lint'},
    {'letter': 'M', 'desc': 'Lint to File', 'cmd': 'pnpm -r lint --fix > lint-output.txt'},
    {'letter': 'T', 'desc': 'Run Typescript Tests', 'cmd': 'pnpm -r test'},
    {'letter': 'R', 'desc': 'Build Rust (Windows/Local)', 'cmd': None},
    {'letter': 'X', 'desc': 'Build Linux Rust FFI (via Docker for Cloud Deployment)', 'cmd': None},
    {'letter': 'U', 'desc': 'Run Rust Tests', 'cmd': 'cargo test --manifest-path rust/Cargo.toml'},
    {'letter': 'F', 'desc': 'Format Code', 'cmd': 'pnpm -r format'},
    {'letter': 'V', 'desc': 'Bump version', 'cmd': 'pnpm -r version patch'},
    {'letter': 'K', 'desc': 'Tag & Push Version to Origin', 'cmd': None},
    {'letter': 'H', 'desc': 'Trigger GitHub Release Workflow', 'cmd': 'gh workflow run release.yml'},
    {'letter': 'G', 'desc': 'Verify GitHub Release Assets', 'cmd': 'pwsh -ExecutionPolicy Bypass -File ./TestRelease.ps1'},
    {'letter': 'D', 'desc': 'Generate Documentation', 'cmd': 'pnpm -r docs'},
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
    if run_cmd('cd rust && pnpm exec napi build --release'):
        # Copy to ts-core for local development
        run_cmd('copy rust\\corelib-rust.node ts-core\\corelib-rust.node')
        print("[CLI] ✅ Windows binary updated in ts-core/ for local development.")

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
    cmds = [
        'pnpm --version', 'cargo --version', 'python --version', 'gh --version',
        'pnpm -C ts-cloud exec wrangler --version', 'gcloud --version', 'sam --version', 'docker --version',
        'act --version', 'wsl --version', 'fd --version', 'sd --version', 'rip --version', 'sops --version --check-for-updates'
    ]
    runtime = config.get('RUNTIME', 'node').lower()
    if runtime == 'bun': cmds.append('bun --version')
    elif runtime == 'deno': cmds.append('deno --version')
    elif runtime == 'node': cmds.append('node --version')
    return ' && '.join(cmds)

def get_release_cmd():
    platform = config.get('PLATFORM', 'linux').lower()
    files = 'ts-core/dist ts-cloud/dist ts-markets/dist rust/target/release package.json LICENSE README.md'
    if platform == 'windows':
        return f'pwsh Compress-Archive -Path {files} -DestinationPath release.zip -Force'
    else:
        return f'tar -czf release.tar.gz {files}'

def get_tag_push_cmd():
    version = get_current_version()
    tag = f"v{version}"
    return f'git tag {tag} && git push origin {tag}'

def display_menu():
    config_str = ' | '.join([f"{k}={v}" for k, v in config.items()])
    version = get_current_version()
    title = f"Developers Cockpit [v{version}] [Config: {config_str}]"
    print(f"\n[CLI] {title}")
    print("Select an option:")
    for choice in choices:
        print(f"{choice['letter']}: {choice['desc']}")

while True:
    display_menu()
    action = input("Enter the letter: ").strip().upper()

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
