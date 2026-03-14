# =============================================
# FILE: DevelopersCockpit.py
# PURPOSE: Python-based Developers Cockpit CLI (moved from TS for cross-runtime simplicity)
# Loads .env manually (no deps), displays menu, runs commands via subprocess
# NEW (2026-03-07): Full implementation replicating the original TS CLI menu and actions. Uses built-in modules only (no external deps like dotenv or inquirer). Handles all original options with subprocess calls for commands. Cross-OS compatible (uses shell=True for Windows cmd support). Defaults to safe behaviors (e.g., patch for version bump). All unrelated codebase features (e.g., TS logger loading, FFI in Rust, database stubs, retrieve/utils) remain fully maintained and unchanged—this only moves the CLI logic.
# FIXED (2026-03-07): Added loop to repeat the menu after each action (except Quit). Pauses with "Press Enter to continue..." after successful actions to allow user review before looping. Maintains all original menu options, commands, and env loading; no impact on unrelated features.
# FIXED (2026-03-07): Updated menu title to show current .env configuration (e.g., "Developers Cockpit [Config: PLATFORM=windows | RUNTIME=bun | MODE=development | LOG_LEVEL=debug] - Select an option:"). Parses and formats non-comment env vars for display. All unrelated features remain fully maintained.
# FIXED (2026-03-07): Made actions runtime/platform/mode-aware where appropriate. For 'E' (release package), uses 'powershell Compress-Archive' on Windows (PLATFORM=windows) for .zip, else 'tar' for .tar.gz. For 'B'/'W' (build/watch TS), inherits MODE for conditional minify in tsup.config.ts. For 'P' (health check), adds runtime-specific version checks (e.g., bun --version if RUNTIME=bun). All unrelated features remain fully maintained.
# FIXED (2026-03-07): Added new option 'M: Lint to File' after 'L: Lint TypeScript Code' to run lint and redirect output to 'lint-output.txt' (e.g., 'pnpm -r lint > lint-output.txt'). All original menu options, commands, and unrelated features remain fully maintained and unchanged.
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
        # Check ts-core/package.json as the source of truth for versioning
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
    {'letter': 'M', 'desc': 'Lint to File', 'cmd': 'pnpm -r lint > lint-output.txt'},
    {'letter': 'T', 'desc': 'Run Typescript Tests', 'cmd': 'pnpm -r test'},
    {'letter': 'R', 'desc': 'Build Rust', 'cmd': 'cd rust && npx napi build --release && copy corelib-rust.node ..\\ts-core\\corelib-rust.node'},
    {'letter': 'U', 'desc': 'Run Rust Tests', 'cmd': 'cargo test --manifest-path rust/Cargo.toml'},
    {'letter': 'F', 'desc': 'Format Code', 'cmd': 'pnpm -r format'},
    {'letter': 'V', 'desc': 'Bump version', 'cmd': 'pnpm -r version patch'},
    {'letter': 'K', 'desc': 'Tag & Push Version to Origin', 'cmd': None},
    {'letter': 'H', 'desc': 'Trigger GitHub Release Workflow', 'cmd': 'gh workflow run release.yml'},
    {'letter': 'G', 'desc': 'Verify GitHub Release Assets', 'cmd': 'powershell -ExecutionPolicy Bypass -File ./TestRelease.ps1'},
    {'letter': 'D', 'desc': 'Generate Documentation (TypeDoc)', 'cmd': 'pnpm -r docs'},
    {'letter': 'E', 'desc': 'Create Local release package (Zip/Tar)'},
    {'letter': 'Q', 'desc': 'Quit', 'cmd': None},
]

def get_health_cmd():
    base = 'pnpm --version && cargo --version && python --version'
    runtime = config.get('RUNTIME', 'node').lower()
    if runtime == 'bun':
        base += ' && bun --version'
    elif runtime == 'deno':
        base += ' && deno --version'
    elif runtime == 'node':
        base += ' && node --version'
    return base

def get_release_cmd():
    platform = config.get('PLATFORM', 'linux').lower()
    # Updated to include workspace dists and key files
    files = 'ts-core/dist ts-cloud/dist ts-markets/dist rust/target/release package.json LICENSE README.md'
    if platform == 'windows':
        return f'powershell Compress-Archive -Path {files} -DestinationPath release.zip -Force'
    else:
        return f'tar -czf release.tar.gz {files}'

def get_tag_push_cmd():
    version = get_current_version()
    tag = f"v{version}"
    return f'git tag {tag} && git push origin {tag}'

def display_menu():
    config_str = ' | '.join([f"{k}={v}" for k, v in config.items()])
    version = get_current_version()
    title = f"Developers Cockpit [v{version}] [Config: {config_str}]" if config_str else f"Developers Cockpit [v{version}]"
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

    cmd = selected.get('cmd')
    if selected['letter'] == 'P':
        cmd = get_health_cmd()
    elif selected['letter'] == 'E':
        cmd = get_release_cmd()
    elif selected['letter'] == 'K':
        cmd = get_tag_push_cmd()

    if cmd:
        print(f"[CLI] Running: {cmd}")
        try:
            subprocess.run(cmd, shell=True, check=True)
            print(f"[CLI] Action {action} completed.")
            input("Press Enter to continue...")  # Pause before looping
        except subprocess.CalledProcessError as e:
            print(f"[CLI] Error during action {action}: {e}")
            input("Press Enter to continue...")  # Pause even on error
    else:
        print("[CLI] Command not defined for this action.")

