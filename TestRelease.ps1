# =============================================
# FILE: TestRelease.ps1
# PURPOSE: Uses GitHub CLI (gh) to verify the latest release and assets.
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

$requiredBins = @(
    "corelib-rust-linux-x64.node", 
    "corelib-rust-darwin-x64.node", 
    "corelib-rust-darwin-arm64.node", 
    "corelib-rust-win32-x64.node"
)

$missing = @()
foreach ($bin in $requiredBins) {
    if ($assets -notcontains $bin) {
        $missing += $bin
    }
}

if ($missing.Count -eq 0) {
    Write-Host "`n[SUCCESS] All platform binaries are present in the release." -ForegroundColor Green
} else {
    Write-Host "`n[WARNING] Some binaries are missing: $($missing -join ', ')" -ForegroundColor Red
}

# 3. Installation Guide
Write-Host "`n--- Installation Instructions ---" -ForegroundColor Cyan
Write-Host "To install the minimal ready-to-use package from this release:"

# Find the .tgz for corelib
$corelibTgz = $assets | Where-Object { $_ -like "ckir-corelib-*.tgz" }

if ($corelibTgz) {
    $v = $latestRelease.tagName
    $url = "https://github.com/$REPO/releases/download/$v/$corelibTgz"
    Write-Host "`nRun this command:" -ForegroundColor White
    Write-Host "pnpm add $url" -ForegroundColor Yellow
} else {
    Write-Host "No .tgz package found in assets. Ensure the 'build-ts' job in release.yml is working." -ForegroundColor Red
}
