# smoke-test.ps1 - Lightweight local checks for ds-image-skill.
# ASCII-only source. Offline by default; pass -Live to generate a real image.

param(
    [switch]$Live
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$failed = $false

Write-Output '## DS Image Skill - Smoke Test'
Write-Output ''

Write-Output '### PowerShell syntax'
foreach ($f in Get-ChildItem -Path $PSScriptRoot -Filter *.ps1) {
    $errs = $null
    $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw -LiteralPath $f.FullName), [ref]$errs)
    if ($errs -and $errs.Count) {
        $failed = $true
        Write-Output ("- {0}: FAIL" -f $f.Name)
        foreach ($e in $errs) { Write-Output ("  {0}" -f $e.Message) }
    } else {
        Write-Output ("- {0}: OK" -f $f.Name)
    }
}

Write-Output ''
Write-Output '### Preflight JSON'
$preflight = Join-Path $PSScriptRoot 'preflight.ps1'
try {
    $json = & $preflight | ConvertFrom-Json
    if ($json.skill -eq 'ds-image-skill' -and $json.models.Count -eq 2) {
        Write-Output '- preflight.ps1: OK'
    } else {
        $failed = $true
        Write-Output '- preflight.ps1: FAIL (unexpected payload)'
    }
} catch {
    $failed = $true
    Write-Output ("- preflight.ps1: FAIL ({0})" -f $_.Exception.Message)
}

Write-Output ''
Write-Output '### Docs'
foreach ($doc in @('SKILL.md', 'README.md', 'LICENSE', 'references\triggers.md', 'scripts\image-api.mjs')) {
    $path = Join-Path $root $doc
    if (Test-Path -LiteralPath $path) {
        Write-Output ("- {0}: OK" -f $doc)
    } else {
        $failed = $true
        Write-Output ("- {0}: FAIL (missing)" -f $doc)
    }
}

Write-Output ''
Write-Output '### Node fallback syntax'
$cmdNode = Get-Command node -ErrorAction SilentlyContinue
$checkNode = $null
if ($env:DSH_DESKTOP_ASSETS) {
    $assetsNode = Join-Path $env:DSH_DESKTOP_ASSETS 'node\node.exe'
    if (Test-Path -LiteralPath $assetsNode) { $checkNode = $assetsNode }
}
if (-not $checkNode -and $cmdNode) {
    $checkNode = $cmdNode.Source
}
if ($checkNode) {
    & $checkNode --check (Join-Path $PSScriptRoot 'image-api.mjs')
    if ($LASTEXITCODE -eq 0) {
        Write-Output '- image-api.mjs: OK'
    } else {
        $failed = $true
        Write-Output '- image-api.mjs: FAIL (node --check)'
    }
} else {
    Write-Output '- image-api.mjs: OK (file present, no node runtime for syntax check)'
}

if ($Live) {
    Write-Output ''
    Write-Output '### Live generation'
    $tmpOut = Join-Path $env:TEMP ("hd-image-live-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmpOut | Out-Null
    try {
        $json = & (Join-Path $PSScriptRoot 'image-generate.ps1') -Prompt 'a tiny red apple on white background' -Model 'qwen-image-2.0' -OutDir $tmpOut | ConvertFrom-Json
        if ($json.status -eq 'ok' -and (Test-Path -LiteralPath $json.path)) {
            Write-Output ("- live: OK ({0}, {1} bytes)" -f $json.path, $json.size_bytes)
        } else {
            $failed = $true
            Write-Output ("- live: FAIL ({0})" -f $json.message)
        }
    } catch {
        $failed = $true
        Write-Output ("- live: FAIL ({0})" -f $_.Exception.Message)
    } finally {
        if (Test-Path -LiteralPath $tmpOut) { Remove-Item -LiteralPath $tmpOut -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Output ''
if ($failed) {
    Write-Output 'RESULT: FAIL'
    exit 1
}

Write-Output 'RESULT: OK'
exit 0
