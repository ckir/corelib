# Load .env file into current process environment variables
Get-Content .env -ErrorAction SilentlyContinue | ForEach-Object {
    $line = $_.Trim()
    if (-not [string]::IsNullOrWhiteSpace($line) -and -not $line.StartsWith('#')) {
        $name, $value = $line.Split('=', 2)
        if ($name) {
            $cleanName  = $name.Trim()
            $cleanValue = $value.Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($cleanName, $cleanValue, "Process")
        }
    }
}

# Get runtime choice
$RUNTIME = [System.Environment]::GetEnvironmentVariable("RUNTIME")?.Trim().ToLowerInvariant()
# Near the top, after loading .env
if (-not $RUNTIME) {
    $RUNTIME = "bun"   # fallback to bun if nothing is set in .env
}

Push-Location .\ts-core

switch ($RUNTIME) {
    "bun" {
        Write-Host "Running with bun ..." -ForegroundColor Cyan
        bun src/cli/index.ts
    }
    "deno" {
        Write-Host "Running with deno ..." -ForegroundColor Cyan
        deno run --allow-env --allow-read --allow-net src/cli/index.ts
    }
    "node" {
        Write-Host "Running with tsx (node) ..." -ForegroundColor Cyan
        # ────────────────────────────────────────────────
        # Preferred: tsx — fast, reliable ESM + path aliases
        # Fallback: npx ts-node-esm if you really want classic ts-node
        # ────────────────────────────────────────────────
        npx tsx src/cli/index.ts
        # Alternative (if you insist on old ts-node):
        # npx ts-node --esm --transpile-only src/cli/index.ts
    }
    default {
        Write-Host "Error: RUNTIME not set or unsupported." -ForegroundColor Red
        Write-Host "  Supported values: bun, node, deno" -ForegroundColor Red
        Write-Host "  Got: '$RUNTIME'" -ForegroundColor DarkYellow
        Write-Host "Example .env line:  RUNTIME=tsx" -ForegroundColor Gray
        exit 1
    }
}

Pop-Location