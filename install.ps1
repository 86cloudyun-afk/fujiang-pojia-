[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Profile = 'desktop',
  [string]$DshCommand = '',
  [string]$DshHome = '',
  # Only print the plan; change nothing.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourcePlugin = Join-Path $bundleRoot 'plugin'
$sourcePrompt = Join-Path $bundleRoot 'prompt-custom.json'
$logPath = Join-Path $bundleRoot 'install.log'

function Write-Step([string]$message) {
  Write-Host ('[dsh-prompt-custom] ' + $message)
}

function Get-HarnessProcesses {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like '*DeepSeek*Harness*' -or
    $_.ProcessName -like '*deepseek-harness*' -or
    ($_.Path -and $_.Path -like '*DeepSeek Harness*')
  })
}

if (-not (Test-Path -LiteralPath $sourcePlugin -PathType Container)) {
  throw 'The bundled plugin directory is missing.'
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    $targetHome = Join-Path $env:USERPROFILE '.dsh'
  } else {
    $targetHome = $env:DSH_HOME.Trim()
  }
} else {
  $targetHome = $DshHome.Trim()
}
$targetHome = [System.IO.Path]::GetFullPath($targetHome)
$env:DSH_HOME = $targetHome

$dshExecutable = ''
$desktopDsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if ([string]::IsNullOrWhiteSpace($DshCommand) -and (Test-Path -LiteralPath $desktopDsh -PathType Leaf)) {
  $dshExecutable = $desktopDsh
} else {
  $commandName = if ([string]::IsNullOrWhiteSpace($DshCommand)) { 'dsh' } else { $DshCommand }
  $dsh = Get-Command -Name $commandName -ErrorAction SilentlyContinue
  if (-not $dsh) {
    throw "DSH CLI '$commandName' was not found. Install the official DSH CLI or pass -DshCommand."
  }
  $dshExecutable = if ($dsh.Source) { $dsh.Source } else { $dsh.Definition }
}

if ($Profile -eq 'desktop') {
  $desktopProfile = Join-Path $targetHome 'profiles\desktop'
  if (-not (Test-Path -LiteralPath (Join-Path $desktopProfile 'package.json') -PathType Leaf)) {
    throw 'Start DeepSeek Harness Desktop once to initialize its desktop profile, then run this installer again.'
  }
}

$pluginTarget = Join-Path $targetHome 'local-plugins\dsh-prompt-custom'
$promptTarget = Join-Path $targetHome 'prompt-custom.json'
$harnessProcesses = Get-HarnessProcesses

if ($DryRun) {
  Write-Step 'Dry run; nothing will change.'
  Write-Step ('bundle    : ' + $bundleRoot)
  Write-Step ('plugin to : ' + $pluginTarget)
  Write-Step ('prompt to : ' + $promptTarget)
  Write-Step ('dsh cli   : ' + $dshExecutable)
  Write-Step ('harness   : ' + $(if ($harnessProcesses.Count) { 'running (' + $harnessProcesses.Count + ' processes)' } else { 'not running' }))
  return
}

# 进程还在：只提醒，不做任何动作。
if ($harnessProcesses.Count -gt 0) {
  Write-Host ''
  Write-Step ('检测到 DeepSeek Harness 正在运行（' + $harnessProcesses.Count + ' 个进程）。')
  Write-Step '请先完全退出 DeepSeek Harness（包括右下角托盘图标 → 退出），然后重新双击 点我执行脚本.cmd。'
  Write-Step '这次没有改动任何文件。'
  Write-Host ''
  exit 1
}

$promptBackup = $null
$hadPrompt = Test-Path -LiteralPath $promptTarget -PathType Leaf
$sourceHash = if (Test-Path -LiteralPath $sourcePrompt -PathType Leaf) { (Get-FileHash -LiteralPath $sourcePrompt -Algorithm SHA256).Hash } else { '' }
$targetMatches = $false

if ($hadPrompt -and $sourceHash) {
  $targetHash = (Get-FileHash -LiteralPath $promptTarget -Algorithm SHA256).Hash
  $targetMatches = $sourceHash -eq $targetHash
  if (-not $targetMatches) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $promptBackup = $promptTarget + '.backup-' + $stamp
    [System.IO.File]::Copy($promptTarget, $promptBackup, $false)
    Write-Step ('原有提示词配置已备份: ' + $promptBackup)
  }
}

New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
Get-ChildItem -LiteralPath $sourcePlugin -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $pluginTarget -Recurse -Force
}
if ($sourceHash -and -not $targetMatches) {
  [System.IO.File]::Copy($sourcePrompt, $promptTarget, $true)
}
Write-Step ('文件已复制到 ' + $pluginTarget)

try {
  & $dshExecutable plugin --profile $Profile add $pluginTarget
  $installExitCode = $LASTEXITCODE
  if ($installExitCode -ne 0) {
    throw "DSH plugin installation failed with exit code $installExitCode."
  }
} catch {
  if ($hadPrompt -and $promptBackup -and (Test-Path -LiteralPath $promptBackup -PathType Leaf)) {
    [System.IO.File]::Copy($promptBackup, $promptTarget, $true)
    Write-Step '安装失败，已还原原提示词配置'
  }
  throw
}

$version = ''
try { $version = (Get-Content -LiteralPath (Join-Path $sourcePlugin 'package.json') -Raw | ConvertFrom-Json).version } catch { }
Write-Step ('安装完成：@deepseek-ai/dsh-prompt-custom ' + $version + '（profile: ' + $Profile + '）')
try {
  Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + ' installed version ' + $version) -Encoding UTF8
} catch { }

Write-Step '现在打开 DeepSeek Harness 即可加载新版本。'