# preflight.ps1 - Report the ds-image-skill configuration status as JSON.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$cfg = Join-Path $root 'config.json'
$configured = $false
$apiKeySet = $false
$baseUrl = 'https://tokenrhythm.studio/v1'

if (Test-Path -LiteralPath $cfg) {
    try {
        $json = Get-Content -Raw -LiteralPath $cfg | ConvertFrom-Json
        if ($json.tokenrhythm) {
            if ($json.tokenrhythm.baseUrl) { $baseUrl = [string]$json.tokenrhythm.baseUrl }
            if ($json.tokenrhythm.apiKey) { $apiKeySet = $true }
            $configured = $true
        }
    } catch { }
}

if (-not $apiKeySet) {
    $key = [Environment]::GetEnvironmentVariable('TOKENRHYTHM_API_KEY', 'Process')
    if (-not $key) { $key = [Environment]::GetEnvironmentVariable('OPENSQUILLA_API_KEY', 'Process') }
    $apiKeySet = [bool]$key
}

$result = @{
    skill = 'ds-image-skill'
    configured = $configured
    apiKeySet = $apiKeySet
    baseUrl = $baseUrl
    defaultModel = 'qwen-image-2.0'
    models = @('qwen-image-2.0', 'wan2.7-image')
}
$result | ConvertTo-Json -Compress
