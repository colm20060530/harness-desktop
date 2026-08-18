#!/usr/bin/env pwsh
# Generate the app icon (512x512 PNG) used by electron-builder and the
# dev-mode window. The brand icon is the project's own DeepSeek-style
# mark (picture/icons8-deepseek-94.png), upscaled with high-quality
# bicubic interpolation. Falls back to the existing build icon when the
# source picture is absent (e.g. fresh clones that skip picture/).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outPath = Join-Path $outDir 'icon.png'

$sourceCandidates = @(
    (Join-Path (Split-Path $root -Parent) 'picture\icons8-deepseek-94.png'),
    (Join-Path $root 'picture\icons8-deepseek-94.png')
)
$source = $sourceCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $source) {
    if (Test-Path $outPath) {
        Write-Host "source icon not found; keeping existing $outPath" -ForegroundColor Yellow
        exit 0
    }
    throw 'brand icon source missing (picture/icons8-deepseek-94.png)'
}

$src = [System.Drawing.Image]::FromFile($source)
$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$src.Dispose()
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "icon written: $outPath"
