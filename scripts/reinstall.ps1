# Rebuilds, repackages, and reinstalls the aboard extension from the VSIX.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    Write-Host "==> Packaging (check + build + vsix)" -ForegroundColor Cyan
    npm run package
    if ($LASTEXITCODE -ne 0) { throw "npm run package failed with exit code $LASTEXITCODE" }

    $vsix = Join-Path $root "dist\aboard-0.0.0.vsix"
    if (-not (Test-Path $vsix)) { throw "Expected VSIX not found: $vsix" }

    Write-Host "==> Installing $vsix" -ForegroundColor Cyan
    code --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed with exit code $LASTEXITCODE" }

    Write-Host "Done. Reload any VS Code windows to activate the new build." -ForegroundColor Green
} finally {
    Pop-Location
}
