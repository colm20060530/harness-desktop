#!/usr/bin/env pwsh
# ---------------------------------------------------------------------------
# 一键发布到 GitHub：
#   1. 检查 gh 登录状态
#   2. 初始化/提交本地 git 仓库
#   3. 创建 GitHub 仓库并推送
#   4. 创建 Release 并上传安装版（release/ 下的 exe）
#
# 前置条件（只做一次）：
#   winget install GitHub.cli          # 安装 gh
#   gh auth login                      # 浏览器登录你的 GitHub 账号
#
# 用法：
#   .\scripts\publish.ps1 -Owner <你的GitHub用户名> [-Repo harness-desktop] [-Visibility public]
# ---------------------------------------------------------------------------
param(
    [Parameter(Mandatory = $true)]
    [string]$Owner,

    [string]$Repo = 'harness-desktop',

    [ValidateSet('public', 'private')]
    [string]$Visibility = 'public',

    [string]$Tag = 'v2.0.2'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# gh may be installed system-wide or kept locally under .tools/gh
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    $localGh = Join-Path $root '.tools\gh'
    if (Test-Path (Join-Path $localGh 'gh.exe')) {
        $env:PATH = "$localGh;$env:PATH"
    } else {
        throw '未找到 GitHub CLI。请安装 gh 或放到 .tools\gh\ 下，然后运行 gh auth login'
    }
}

Write-Host '[1/4] 检查 gh 登录状态...' -ForegroundColor Cyan
gh auth status | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw 'gh 未登录。请先运行：gh auth login（浏览器授权）后重试'
}

Push-Location $root
try {
    Write-Host '[2/4] 准备 git 仓库...' -ForegroundColor Cyan
    if (-not (Test-Path '.git')) {
        git init -b main | Out-Null
    }
    git config user.name "$Owner"
    git config user.email "$Owner@users.noreply.github.com"
    git add -A
    if (-not [string]::IsNullOrWhiteSpace((git status --porcelain))) {
        git commit -m "chore: prepare $Tag release" | Out-Null
    }

    Write-Host "[3/4] 创建仓库 $Owner/$Repo ($Visibility) 并推送..." -ForegroundColor Cyan
    gh repo create "$Owner/$Repo" `
        --source . --push --$Visibility `
        --description 'Harness Desktop：基于官方 deepseek-harness 全新构建的 Windows 桌面版，内置 Aqua 玻璃拟态 UI' `
        --homepage 'https://github.com/deepseek-ai/deepseek-harness'
    if ($LASTEXITCODE -ne 0) { throw '仓库创建/推送失败' }

    Write-Host "[4/4] 创建 Release $Tag 并上传安装包..." -ForegroundColor Cyan
    $setup    = Join-Path $root "release\Harness-Desktop-Setup-$($Tag.Substring(1)).exe"
    if (-not (Test-Path $setup)) {
        throw "release 产物缺失，请确认 release\ 下存在安装包"
    }
    gh release create $Tag $setup `
        --title "Harness Desktop $Tag" `
        --notes "## Harness Desktop $Tag

基于官方 deepseek-harness 全新构建的 Windows 桌面版，内置 Aqua 玻璃拟态 UI（默认开启、不可卸载）。

- 安装版：\`Harness-Desktop-Setup-$($Tag.Substring(1)).exe\`（向导安装 + 快捷方式 + 可卸载）

详见 README.md。"
    if ($LASTEXITCODE -ne 0) { throw 'Release 创建失败' }

    Write-Host ''
    Write-Host "发布完成：https://github.com/$Owner/$Repo/releases/tag/$Tag" -ForegroundColor Green
} finally {
    Pop-Location
}
