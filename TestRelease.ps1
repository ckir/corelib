# =============================================
# FILE: TestRelease.ps1
# PURPOSE: Uses GitHub CLI (gh) to verify the latest release and assets.
# Validates 15 assets per AGENTS.md §4 (3 TS .tgz + 4 FFI .node + 8 CLI binaries)
# =============================================

$REPO = "ckir/corelib"

Write-Host "--- Checking Latest GitHub Release for $REPO ---" -ForegroundColor Cyan

# 1. Get latest release
$latestRelease = gh release view --repo $REPO --json tagName,assets | ConvertFrom-Json

if (-not $latestRelease) {
    Write-Host "No release found for $REPO. Make sure you have pushed a tag (e.g., v0.1.0) and the Action has finished." -ForegroundColor Yellow
    exit
}

Write-Host "Latest Release Tag: $($latestRelease.tagName)" -ForegroundColor Green

# 2. Check for expected assets
$assets = $latestRelease.assets | Select-Object -ExpandProperty name
Write-Host "Assets found:"
$assets | ForEach-Object { Write-Host " - $_" }

# 11+ assets per AGENTS.md §4:
# - 3 TS packages (.tgz): corelib, corelib-markets, corelib-cloud
# - 4 Rust FFI .node: linux-x64, darwin-x64, darwin-arm64, win32-x64
# - 8 CLI binaries: yahoo_streamer ×4 + alpaca_streamer ×4 (linux-x64, darwin-x64, darwin-arm64, win32-x64)

$requiredAssets = @(
    # TS Packages (3)
    "ckirg-corelib-*.tgz",
    "ckirg-corelib-markets-*.tgz",
    "ckirg-corelib-cloud-*.tgz",
    
    # Rust FFI .node binaries (4)
    "corelib-rust-linux-x64.node",
    "corelib-rust-darwin-x64.node",
    "corelib-rust-darwin-arm64.node",
    "corelib-rust-win32-x64.node",
    
    # CLI Binaries - yahoo_streamer (4)
    "yahoo_streamer-linux-x64",
    "yahoo_streamer-darwin-x64",
    "yahoo_streamer-darwin-arm64",
    "yahoo_streamer-win32-x64.exe",
    
    # CLI Binaries - alpaca_streamer (4)
    "alpaca_streamer-linux-x64",
    "alpaca_streamer-darwin-x64",
    "alpaca_streamer-darwin-arm64",
    "alpaca_streamer-win32-x64.exe"
)

$missing = @()
foreach ($pattern in $requiredAssets) {
    $matched = $assets | Where-Object { $_ -like $pattern }
    if (-not $matched) {
        $missing += $pattern
    } else {
        Write-Host "  ✅ $($matched -join ', ')" -ForegroundColor Green
    }
}

if ($missing.Count -eq 0) {
    Write-Host "`n[SUCCESS] All 15 release assets are present." -ForegroundColor Green
} else {
    Write-Host "`n[FAILURE] Missing assets:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  ❌ $_" -ForegroundColor Red }
    exit 1
}

# 3. Installation Guide
Write-Host "`n--- Installation Instructions ---" -ForegroundColor Cyan
Write-Host "To install packages from this release:"

$v = $latestRelease.tagName

# Find all .tgz packages
$tgzAssets = $assets | Where-Object { $_ -like "*.tgz" }
if ($tgzAssets) {
    Write-Host "`nRun these commands:" -ForegroundColor White
    foreach ($tgz in $tgzAssets) {
        $url = "https://github.com/$REPO/releases/download/$v/$tgz"
        Write-Host "pnpm add $url" -ForegroundColor Yellow
    }
} else {
    Write-Host "No .tgz packages found in assets." -ForegroundColor Red
}

# 4. Verify checksums (optional)
Write-Host "`n--- Checksum Verification ---" -ForegroundColor Cyan
Write-Host "Run this to verify all asset checksums:" -ForegroundColor White
Write-Host "gh release download $v --repo $REPO --pattern '*' --dir ./release-verify" -ForegroundColor Yellow
Write-Host "cd ./release-verify && sha256sum *" -ForegroundColor Yellow
