#!/usr/bin/env pwsh
# Generate the app icon (512x512 PNG) used by electron-builder.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outPath = Join-Path $outDir 'icon.png'

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

$radius = 104
$rect = New-Object System.Drawing.Rectangle(12, 12, ($size - 24), ($size - 24))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 26, 61, 92),
    [System.Drawing.Color]::FromArgb(255, 8, 16, 26),
    90.0)
$g.FillPath($bgBrush, $path)

$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowRect = New-Object System.Drawing.Rectangle(56, 40, 400, 300)
$glow.AddEllipse($glowRect)
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(70, 90, 190, 235)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 90, 190, 235))
$g.FillEllipse($glowBrush, $glowRect)

$stroke = New-Object System.Drawing.Pen(
    [System.Drawing.Color]::FromArgb(190, 140, 220, 248), 3)
$g.DrawPath($stroke, $path)

$font = New-Object System.Drawing.Font('Segoe UI', 248, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$textBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 190, 238, 255),
    [System.Drawing.Color]::FromArgb(255, 96, 178, 224),
    90.0)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rectF = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $rect.Width, $rect.Height)
$g.DrawString('H', $font, $textBrush, $rectF, $fmt)

$whaleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 190, 238, 255))
$g.FillEllipse($whaleBrush, 372, 396, 18, 18)

$g.Dispose()
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "icon written: $outPath"
