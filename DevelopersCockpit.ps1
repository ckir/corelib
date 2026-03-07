# Runs on Windows/Linux/Mac with PowerShell (pwsh on non-Windows).
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

# FIXED (2026-03-07): Updated to run the new Python-based DevelopersCockpit.py script instead of the removed TS CLI. This maintains the original .env loading and cross-OS compatibility while shifting CLI logic to Python as requested. All unrelated features (e.g., logger, FFI, database stubs, retrieve/utils exports) remain fully maintained and unchanged in the codebase.

Write-Host "Running Developers Cockpit via Python..." -ForegroundColor Cyan
python DevelopersCockpit.py