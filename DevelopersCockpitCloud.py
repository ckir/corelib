# =============================================
# FILE: DevelopersCockpitCloud.py
# PURPOSE: Cloud Deployment & Simulation CLI for ts-cloud
# =============================================

import os
import subprocess
import sys

# --- CONFIGURATION DEFAULTS ---
GCP_PROJECT_ID = "costasalerts"
GCP_REGION = "us-east1"
SERVICE_NAME = "tscloud"
IMAGE_TAG = f"gcr.io/{GCP_PROJECT_ID}/{SERVICE_NAME}:latest"

def load_sops_env():
    """Decrypts .env-encrypted using SOPS and injects into process env."""
    sops_file = '.env-encrypted'
    secrets = {}
    if not os.path.exists(sops_file):
        print(f"\n[SOPS] {sops_file} not found in root directory. Skipping decryption.")
        return secrets

    print("\n[SOPS] Decrypting secrets from .env-encrypted...")
    try:
        result = subprocess.run(
            ['sops', '-d', sops_file], 
            capture_output=True, text=True, check=True
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                clean_key = key.strip()
                clean_val = value.strip().strip('"\'')
                os.environ[clean_key] = clean_val
                secrets[clean_key] = clean_val
        print("[SOPS] ✅ Secrets successfully loaded into environment.")
    except subprocess.CalledProcessError as e:
        print(f"[SOPS] ❌ Decryption failed: {e.stderr}")
    except FileNotFoundError:
        print("[SOPS] ❌ SOPS executable not found. Please install Mozilla SOPS.")
    return secrets

def run_cmd(cmd, cwd=None, ignore_error=False):
    """Executes a shell command with environment variables passed down."""
    print(f"\n[CLI] Running: {cmd}")
    try:
        subprocess.run(cmd, shell=True, check=not ignore_error, cwd=cwd)
        return True
    except subprocess.CalledProcessError as e:
        if not ignore_error:
            print(f"[CLI] ❌ Command failed with exit code {e.returncode}")
        return False

def ensure_linux_ffi(force=False):
    """Ensures the Linux Rust FFI binary is present in ts-cloud/dist/cloudrun."""
    target_path = 'ts-cloud/dist/cloudrun/corelib-rust.node'
    
    # On Windows, we almost always want to force this if we just ran a build, 
    # because the TS postbuild script copies the Windows binary.
    if not force and os.path.exists(target_path) and sys.platform != 'win32':
        print(f"[CLI] Found existing FFI at {target_path}. Proceeding...")
        return True

    print(f"[CLI] {'Forcing' if force else 'Ensuring'} Linux Rust FFI build/extraction (via Docker)...")
    # 1. Build the compilation image (uses cache if possible)
    if not run_cmd('docker build -t corelib-builder -f rust/Dockerfile.linux .'):
        return False

    # 2. Extract binary via temporary container
    run_cmd('docker rm -f corelib-temp', ignore_error=True)
    if not run_cmd('docker create --name corelib-temp corelib-builder'):
        return False

    try:
        os.makedirs('ts-cloud/dist/cloudrun', exist_ok=True)
        os.makedirs('ts-cloud/dist/aws', exist_ok=True)
        print("[CLI] Extracting Linux binary to ts-cloud/dist/ folders...")
        run_cmd('docker cp corelib-temp:/app/rust/corelib-rust.node ts-cloud/dist/aws/corelib-rust.node')
        return run_cmd('docker cp corelib-temp:/app/rust/corelib-rust.node ts-cloud/dist/cloudrun/corelib-rust.node')
    finally:
        run_cmd('docker rm -f corelib-temp', ignore_error=True)

def generate_sam_env(secrets):
    """Generates a temporary env.json for SAM local."""
    import json
    # Combine os.environ (which has .env) and secrets (from SOPS)
    combined = {**os.environ, **secrets}
    
    # We only want to pass relevant variables or all of them?
    # SAM env.json format: { "FunctionName": { "VAR": "VAL" } }
    env_data = {
        "CorelibFunction": {
            k: v for k, v in combined.items() 
            if k.startswith("CORELIB_") or k in ["MODE", "LOG_LEVEL", "PLATFORM"]
        }
    }
    
    env_path = 'sam-corelib/env.json'
    with open(env_path, 'w') as f:
        json.dump(env_data, f, indent=4)
    return env_path

def display_menu():
    print(f"\n=== Developers Cockpit Cloud (ts-cloud) ===")
    print(f"Target Service: {SERVICE_NAME} | GCP Project: {GCP_PROJECT_ID}")
    print("-------------------------------------------")
    print("B: Build All TypeScript Cloud Targets")
    print("X: Build/Extract Linux Rust FFI (via Docker)")
    print("-------------------------------------------")
    print("1: Local Cloudflare Simulation (wrangler dev)")
    print("2: Deploy to Cloudflare Edge (wrangler deploy)")
    print("-------------------------------------------")
    print("3: Local AWS SAM Simulation (sam local start-api)")
    print("4: Deploy to AWS Lambda (sam deploy)")
    print("-------------------------------------------")
    print("5: Local GCP Cloud Run Simulation (docker build & run)")
    print("6: Deploy to GCP Cloud Run (gcloud builds & deploy)")
    print("-------------------------------------------")
    print("Q: Quit")

def main():
    # Attempt to load decrypted secrets initially
    secrets = load_sops_env()

    while True:
        display_menu()
        action = input("\nEnter your choice: ").strip().upper()

        if action == 'Q':
            print("Quitting...")
            sys.exit(0)
            
        elif action == 'B':
            run_cmd('pnpm --filter @ckir/corelib-cloud build')

        elif action == 'X':
            ensure_linux_ffi()

        elif action == '1':
            run_cmd('pnpm exec wrangler dev', cwd='ts-cloud')

        elif action == '2':
            run_cmd('pnpm exec wrangler deploy', cwd='ts-cloud')

        elif action == '3':
            print("[CLI] --- Local AWS SAM Simulation ---")
            # 1. Build TS
            if not run_cmd('pnpm --filter @ckir/corelib-cloud build'):
                continue
            
            # 2. Ensure Linux FFI
            if sys.platform == 'win32':
                if not ensure_linux_ffi():
                    continue

            # 3. Generate Env
            env_path = generate_sam_env(secrets)
            
            # 4. Run SAM
            run_cmd(f'sam local start-api --template-file template.yaml --env-vars env.json', cwd='sam-corelib')

        elif action == '4':
            print("[CLI] --- Deploying to AWS Lambda ---")
            # 1. Build TS
            if not run_cmd('pnpm --filter @ckir/corelib-cloud build'):
                continue
            
            # 2. Ensure Linux FFI
            if sys.platform == 'win32':
                if not ensure_linux_ffi():
                    continue

            run_cmd('sam deploy --template-file template.yaml --config-file samconfig.toml', cwd='sam-corelib')

        elif action == '5':
            print("[CLI] --- Local GCP Cloud Run Simulation ---")
            # 1. Build TS
            if not run_cmd('pnpm --filter @ckir/corelib-cloud build'):
                print("[CLI] ❌ TS Build failed.")
                continue
            
            # 2. Ensure Linux FFI
            if sys.platform == 'win32':
                if not ensure_linux_ffi():
                    print("[CLI] ❌ Failed to ensure Linux FFI.")
                    continue

            # 3. Docker Build
            print(f"[CLI] Building local Docker image '{SERVICE_NAME}-local'...")
            if not run_cmd(f'docker build -t {SERVICE_NAME}-local -f Dockerfile .', cwd='ts-cloud'):
                continue

            # 4. Docker Run
            print(f"[CLI] Running container on http://localhost:3000 ...")
            
            # Combine .env file and SOPS secrets
            # We use -e for each SOPS secret to override/complement
            env_args = ""
            for key, val in secrets.items():
                # Simple escape for double quotes in value
                safe_val = str(val).replace('"', '\\"')
                env_args += f' -e {key}="{safe_val}"'
            
            env_file_arg = ""
            if os.path.exists("../.env"):
                env_file_arg = "--env-file ../.env"
            
            run_cmd(f'docker run --rm -p 3000:3000 {env_file_arg} {env_args} {SERVICE_NAME}-local', cwd='ts-cloud')

        elif action == '6':
            print("[CLI] --- Deploying to GCP Cloud Run ---")
            # 1. Build TS
            if not run_cmd('pnpm --filter @ckir/corelib-cloud build'):
                continue
            
            # 2. Ensure Linux FFI
            if sys.platform == 'win32':
                if not ensure_linux_ffi():
                    continue

            print("[CLI] Submitting build to Google Cloud...")
            if run_cmd(f'gcloud builds submit --tag {IMAGE_TAG} --project {GCP_PROJECT_ID}', cwd='ts-cloud'):
                print("[CLI] Deploying to Cloud Run...")
                run_cmd(f'gcloud run deploy {SERVICE_NAME} --image {IMAGE_TAG} --region {GCP_REGION} --project {GCP_PROJECT_ID} --platform managed --allow-unauthenticated', cwd='ts-cloud')

        else:
            print("[CLI] Invalid action; try again.")

if __name__ == "__main__":
    main()
