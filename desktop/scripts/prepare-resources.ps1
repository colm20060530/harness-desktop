#!/usr/bin/env pwsh
# ---------------------------------------------------------------------------
# Prepare the bundled resources for Harness Desktop:
#
#   resources/node     – standalone Node.js runtime (downloaded from nodejs.org)
#   resources/host     – @deepseek-ai/dsh server runtime (npm install)
#   resources/plugins/ – the built-in Aqua plugin (GitHub zip, or a local
#                        plugin/ checkout when one exists for development)
#
# Run from the desktop/ directory:
#   powershell -ExecutionPolicy Bypass -File scripts/prepare-resources.ps1
# ---------------------------------------------------------------------------
param(
    [string]$NodeVersion = 'v24.11.1',
    [switch]$SkipNode,
    [switch]$SkipHost
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$desktopRoot = Split-Path $PSScriptRoot -Parent
$repoRoot    = Split-Path $desktopRoot -Parent
$resources   = Join-Path $desktopRoot 'resources'

function Assert-PathUnderRoot {
    param([string]$Path, [string]$Root, [string]$Label)
    $full = [System.IO.Path]::GetFullPath($Path)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must stay under $rootFull (got $full)"
    }
}

Write-Host "== Harness Desktop: preparing resources ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $resources | Out-Null

# ---- 1. standalone Node runtime ---------------------------------------------
if (-not $SkipNode) {
    Write-Host '[1/3] Node runtime' -ForegroundColor Cyan
    $nodeDir = Join-Path $resources 'node'
    Assert-PathUnderRoot $nodeDir $resources 'node runtime dir'
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null

    $zipName   = "node-$NodeVersion-win-x64.zip"
    $zipPath   = Join-Path $env:TEMP $zipName
    $extract   = Join-Path $env:TEMP "node-$NodeVersion-extract"
    $nodeRoot  = Join-Path $extract "node-$NodeVersion-win-x64"

    if (-not (Test-Path $zipPath)) {
        Write-Host "  downloading https://nodejs.org/dist/$NodeVersion/$zipName"
        Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$zipName" -OutFile $zipPath
    }
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Expand-Archive $zipPath -DestinationPath $extract -Force
    if (-not (Test-Path (Join-Path $nodeRoot 'node.exe'))) {
        throw "node.exe not found in $nodeRoot"
    }

    Copy-Item (Join-Path $nodeRoot 'node.exe') $nodeDir -Force
    Get-ChildItem $nodeRoot -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.dll', '.dat' } |
        ForEach-Object { Copy-Item $_.FullName $nodeDir -Force }

    $nodeExe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path $nodeExe)) { throw 'node.exe missing after extraction' }
    $nodeVersion = & $nodeExe --version
    Write-Host "  bundled node: $nodeVersion" -ForegroundColor Green
} else {
    Write-Host '[1/3] Node runtime: skipped (-SkipNode)' -ForegroundColor DarkGray
}

# ---- 2. dsh server runtime ----------------------------------------------------
if (-not $SkipHost) {
    Write-Host '[2/3] dsh server runtime (npm install @deepseek-ai/dsh)' -ForegroundColor Cyan
    $hostDir = Join-Path $resources 'host'
    Assert-PathUnderRoot $hostDir $resources 'host runtime dir'
    New-Item -ItemType Directory -Force -Path $hostDir | Out-Null
    Copy-Item (Join-Path $desktopRoot 'host-package.json') (Join-Path $hostDir 'package.json') -Force

    Push-Location $hostDir
    try {
        npm install --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
        npm rebuild --foreground-scripts
        if ($LASTEXITCODE -ne 0) { throw "npm rebuild failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    $binPath = Join-Path $hostDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path $binPath)) { throw "dsh bin missing: $binPath" }
    $nodeExe = Join-Path $resources 'node\node.exe'
    if (Test-Path $nodeExe) {
        Write-Host "  verifying dsh CLI: $(& $nodeExe $binPath --version)" -ForegroundColor Green
    } else {
        Write-Host "  dsh CLI installed (native verify skipped: no bundled node yet)" -ForegroundColor Yellow
    }
} else {
    Write-Host '[2/3] dsh server runtime: skipped (-SkipHost)' -ForegroundColor DarkGray
}

# ---- 3. built-in plugin ---------------------------------------------------------
Write-Host '[3/3] built-in Aqua plugin' -ForegroundColor Cyan
$pluginDest = Join-Path $resources 'plugins\@deepseek-ai\dsh-client-ui-aqua'
Assert-PathUnderRoot $pluginDest $resources 'plugin destination'
New-Item -ItemType Directory -Force -Path $pluginDest | Out-Null

# Priority: a local `plugin/` checkout (development), then the GitHub source
# zip (the repo ships with a prebuilt lib/ bundle, same as its installer).
$localPlugin = Join-Path $repoRoot 'plugin'
if (Test-Path (Join-Path $localPlugin 'lib\client.js')) {
    Write-Host "  using local plugin checkout: $localPlugin" -ForegroundColor DarkGray
    Copy-Item (Join-Path $localPlugin 'lib') (Join-Path $pluginDest 'lib') -Recurse -Force
    Copy-Item (Join-Path $localPlugin 'package.json') $pluginDest -Force
    if (Test-Path (Join-Path $localPlugin 'LICENSE')) {
        Copy-Item (Join-Path $localPlugin 'LICENSE') $pluginDest -Force
    }
} else {
    $pluginZip     = Join-Path $env:TEMP 'dsh-client-ui-aqua.zip'
    $pluginExtract = Join-Path $env:TEMP 'dsh-client-ui-aqua-extract'
    Write-Host '  downloading plugin source from GitHub...' -ForegroundColor DarkGray
    Invoke-WebRequest 'https://github.com/WYH66666666/DSH-Transparent-UI-Plugin/archive/refs/heads/main.zip' -OutFile $pluginZip
    if (Test-Path $pluginExtract) { Remove-Item $pluginExtract -Recurse -Force }
    Expand-Archive $pluginZip -DestinationPath $pluginExtract -Force
    $inner = Get-ChildItem $pluginExtract -Directory | Select-Object -First 1
    if (-not $inner) { throw 'plugin zip contains no package directory' }
    if (-not (Test-Path (Join-Path $inner.FullName 'lib\client.js'))) {
        throw 'downloaded plugin has no prebuilt lib/client.js'
    }
    Copy-Item (Join-Path $inner.FullName 'lib') (Join-Path $pluginDest 'lib') -Recurse -Force
    Copy-Item (Join-Path $inner.FullName 'package.json') $pluginDest -Force
    if (Test-Path (Join-Path $inner.FullName 'LICENSE')) {
        Copy-Item (Join-Path $inner.FullName 'LICENSE') $pluginDest -Force
    }
}
Write-Host "  plugin bundle: $(Get-Item (Join-Path $pluginDest 'lib\client.js')).Length bytes" -ForegroundColor Green

Write-Host ''
Write-Host 'Resources ready. Run `npm start` to launch, or `npm run pack` to build installers.' -ForegroundColor Green
