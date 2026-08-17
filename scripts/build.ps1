#!/usr/bin/env pwsh
# One-command build for Harness Desktop:
#   1. prepare bundled resources (Node runtime + dsh runtime + plugin)
#   2. package Windows installers (NSIS + portable)
param(
    [switch]$SkipPrepare,
    [string]$ElectronMirror = 'https://npmmirror.com/mirrors/electron/'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$desktop = Join-Path $root 'desktop'

if (-not $SkipPrepare) {
    & (Join-Path $desktop 'scripts\prepare-resources.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'resource preparation failed' }
}

Push-Location $desktop
try {
    # electron-builder downloads the Electron dist from GitHub by default;
    # the mirror makes builds reliable on CN networks (override with -ElectronMirror '').
    if ($ElectronMirror -ne '') {
        $env:ELECTRON_MIRROR = $ElectronMirror
    }
    if (-not (Test-Path 'node_modules\electron-builder')) {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }
    & (Join-Path $desktop 'scripts\make-icon.ps1')
    npx electron-builder --win nsis portable
    if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host "Build complete. Artifacts in $desktop\dist" -ForegroundColor Green
