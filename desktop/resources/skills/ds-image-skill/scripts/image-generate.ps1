# image-generate.ps1 - Generate an image via TokenRhythm's OpenAI-compatible
# /images/generations endpoint for the built-in ds-image-skill.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/image-generate.ps1 `
#     -Prompt "a red apple on white background" [-Model qwen-image-2.0] `
#     [-OutDir D:\path\to\images] [-Filename demo.png] [-NoOpen]
#
# Always prints exactly one JSON document to stdout.

param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt,

    [ValidateSet('qwen-image-2.0', 'wan2.7-image')]
    [string]$Model = 'qwen-image-2.0',

    [string]$OutDir = '',
    [string]$Filename = '',
    [switch]$NoOpen
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

function Write-JsonResult {
    param([hashtable]$Value)
    $Value | ConvertTo-Json -Compress
}

function Get-ConfigValue {
    param([string]$Name)
    $root = Split-Path -Parent $PSScriptRoot
    $cfg = Join-Path $root 'config.json'
    if (Test-Path -LiteralPath $cfg) {
        try {
            $json = Get-Content -Raw -LiteralPath $cfg | ConvertFrom-Json
            if ($json.tokenrhythm -and $json.tokenrhythm.$Name) { return [string]$json.tokenrhythm.$Name }
        } catch { }
    }
    return ''
}

function Get-ApiKey {
    $key = Get-ConfigValue 'apiKey'
    if (-not $key) { $key = [Environment]::GetEnvironmentVariable('TOKENRHYTHM_API_KEY', 'Process') }
    if (-not $key) { $key = [Environment]::GetEnvironmentVariable('OPENSQUILLA_API_KEY', 'Process') }
    return ($key -replace '^\s+|\s+$', '')
}

function Get-BaseUrl {
    $url = Get-ConfigValue 'baseUrl'
    if (-not $url) { $url = 'https://tokenrhythm.studio/v1' }
    return ($url -replace '/+$', '')
}

function Detect-ImageExt {
    param([byte[]]$Bytes)
    if ($Bytes.Length -ge 8 -and $Bytes[0] -eq 0x89 -and $Bytes[1] -eq 0x50 -and $Bytes[2] -eq 0x4E -and $Bytes[3] -eq 0x47) { return 'png' }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xD8 -and $Bytes[2] -eq 0xFF) { return 'jpg' }
    if ($Bytes.Length -ge 12 -and $Bytes[0] -eq 0x52 -and $Bytes[1] -eq 0x49 -and $Bytes[2] -eq 0x46 -and $Bytes[3] -eq 0x46) { return 'webp' }
    return 'png'
}

function Request-AppOpen {
    param([string]$FilePath)
    if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath)) { return $false }
    try {
        $markerRoot = Join-Path $env:TEMP 'hd-image-open'
        if (-not (Test-Path -LiteralPath $markerRoot)) {
            New-Item -ItemType Directory -Force -Path $markerRoot | Out-Null
        }
        $marker = Join-Path $markerRoot ("open-" + [guid]::NewGuid().ToString('N') + '.json')
        $payload = @{
            path = $FilePath
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($marker, $payload, (New-Object System.Text.UTF8Encoding($false)))
        return $true
    } catch {
        return $false
    }
}

function Open-GeneratedImage {
    param([string]$FilePath)
    if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath)) { return $false }
    # Inside the desktop app: the sandboxed shell cannot show viewer windows,
    # so hand the path to the Electron main process via a marker file.
    if ($env:DSH_DESKTOP_ASSETS) {
        return (Request-AppOpen $FilePath)
    }
    try {
        Invoke-Item -LiteralPath $FilePath -ErrorAction Stop
        return $true
    } catch { }
    try {
        Start-Process -FilePath $FilePath
        return $true
    } catch { }
    return $false
}

$apiKey = Get-ApiKey
if (-not $apiKey) {
    Write-JsonResult @{ status = 'error'; code = 'NO_API_KEY'; message = 'No TokenRhythm API key configured. Ask the user to configure it in Settings -> Models -> Image Generation card.' }
    exit 0
}

$baseUrl = Get-BaseUrl
$endpoint = "$baseUrl/images/generations"

# Prefer Node's OpenSSL TLS (bundled with the desktop app) so the request works
# even in shells where Windows Schannel cannot acquire client credentials.
# Falls back to curl.exe when Node is unavailable or produces no usable result.
$nodeExe = ''
if ($env:DSH_DESKTOP_ASSETS) {
    $assetsNode = Join-Path $env:DSH_DESKTOP_ASSETS 'node\node.exe'
    if (Test-Path -LiteralPath $assetsNode) { $nodeExe = $assetsNode }
}
if (-not $nodeExe) {
    $cmdNode = Get-Command node -ErrorAction SilentlyContinue
    if ($cmdNode) { $nodeExe = $cmdNode.Source }
}
if ($nodeExe) {
    $env:HD_IMAGE_API_KEY = $apiKey
    $env:HD_IMAGE_BASE_URL = $baseUrl
    $env:HD_IMAGE_PROMPT = $Prompt
    $env:HD_IMAGE_MODEL = $Model
    $env:HD_IMAGE_OUT_DIR = $OutDir
    $env:HD_IMAGE_FILENAME = $Filename
    $nodeScript = Join-Path $PSScriptRoot 'image-api.mjs'
    $nodeOut = & $nodeExe $nodeScript 2>$null
    $nodeExit = $LASTEXITCODE
    Remove-Item Env:HD_IMAGE_API_KEY, Env:HD_IMAGE_BASE_URL, Env:HD_IMAGE_PROMPT, Env:HD_IMAGE_MODEL, Env:HD_IMAGE_OUT_DIR, Env:HD_IMAGE_FILENAME -ErrorAction SilentlyContinue
    if ($nodeExit -eq 0) {
        $line = $nodeOut | Select-Object -Last 1
        if ($line) {
            try {
                $parsed = $line | ConvertFrom-Json
                if ($parsed.status) {
                    $opened = $false
                    if ($parsed.status -eq 'ok' -and $parsed.path -and -not $NoOpen) {
                        $opened = Open-GeneratedImage $parsed.path
                    }
                    $parsed | Add-Member -NotePropertyName opened -NotePropertyValue $opened -Force
                    $parsed | ConvertTo-Json -Compress
                    exit 0
                }
            } catch { }
        }
    }
}

$tmpPayload = Join-Path $env:TEMP ("hd-image-payload-" + [guid]::NewGuid().ToString('N') + '.json')
$tmpResp = Join-Path $env:TEMP ("hd-image-resp-" + [guid]::NewGuid().ToString('N') + '.json')
$tmpImg = Join-Path $env:TEMP ("hd-image-dl-" + [guid]::NewGuid().ToString('N') + '.bin')

try {
    $payload = @{ model = $Model; prompt = $Prompt } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($tmpPayload, $payload, (New-Object System.Text.UTF8Encoding($false)))

    & curl.exe -sS -m 180 -X POST $endpoint -H 'Content-Type: application/json' -H "Authorization: Bearer $apiKey" --data-binary "@$tmpPayload" -o $tmpResp
    if ($LASTEXITCODE -ne 0) {
        Write-JsonResult @{ status = 'error'; code = 'HTTP_ERROR'; message = "Image API request failed (curl exit $LASTEXITCODE)." }
        exit 0
    }

    if (-not (Test-Path -LiteralPath $tmpResp)) {
        Write-JsonResult @{ status = 'error'; code = 'BAD_RESPONSE'; message = 'Image API returned no response body.' }
        exit 0
    }

    $response = Get-Content -Raw -LiteralPath $tmpResp | ConvertFrom-Json
    $item = $null
    if ($response.data -and $response.data.Count -gt 0) { $item = $response.data[0] }

    $imageBytes = $null
    if ($item -and $item.b64_json) {
        $imageBytes = [Convert]::FromBase64String([string]$item.b64_json)
    } elseif ($item -and $item.url) {
        & curl.exe -sS -L -m 120 -o $tmpImg $item.url
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmpImg)) {
            Write-JsonResult @{ status = 'error'; code = 'DOWNLOAD_FAILED'; message = "Failed to download the generated image (curl exit $LASTEXITCODE)." }
            exit 0
        }
        $imageBytes = [System.IO.File]::ReadAllBytes($tmpImg)
    } else {
        $msg = ''
        if ($response.message) { $msg = [string]$response.message }
        if ($response.code -and -not $msg) { $msg = [string]$response.code }
        Write-JsonResult @{ status = 'error'; code = 'BAD_RESPONSE'; message = "Image API returned no image data. $msg" }
        exit 0
    }

    $ext = Detect-ImageExt $imageBytes
    $mime = switch ($ext) { 'png' { 'image/png' }; 'jpg' { 'image/jpeg' }; 'webp' { 'image/webp' }; default { 'image/png' } }

    if (-not $OutDir) { $OutDir = Join-Path (Get-Location) 'images' }
    if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

    $fileName = $Filename
    if ($fileName) {
        if (-not ([System.IO.Path]::GetExtension($fileName))) { $fileName = "$fileName.$ext" }
    } else {
        $fileName = 'generated-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".$ext"
    }

    $target = Join-Path $OutDir $fileName
    [System.IO.File]::WriteAllBytes($target, $imageBytes)

    $opened = $false
    if (-not $NoOpen) { $opened = Open-GeneratedImage $target }
    $result = @{
        status = 'ok'
        provider = 'tokenrhythm'
        model = $Model
        path = $target
        opened = $opened
        mime_type = $mime
        size_bytes = $imageBytes.Length
        image_id = if ($item.image_id) { [string]$item.image_id } else { '' }
        cost_cny = if ($response.cost_cny) { [string]$response.cost_cny } else { '' }
    }
    Write-JsonResult $result
} catch {
    Write-JsonResult @{ status = 'error'; code = 'UNEXPECTED'; message = $_.Exception.Message }
} finally {
    foreach ($f in @($tmpPayload, $tmpResp, $tmpImg)) {
        if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    }
}
