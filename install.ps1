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

# ==================== omp persona 双通道部署（追加段） ====================
# 上方 DSH 插件安装逻辑保持不变。本段只写 omp 的两条注入通道：
#   通道一 $HOME\.omp\agent\PERSONALITY.md  —— omp 启动时自动读取
#   通道二 $HOME\.local\bin\omp-armor.cmd    —— 启动时注入 --system-prompt
$armorRoot     = Join-Path $bundleRoot 'armor'
$armorKernel   = Join-Path $armorRoot 'kernel.md'
$armorContract = Join-Path $armorRoot 'contract.md'

$kernelText   = ''
$contractText = ''
if (Test-Path -LiteralPath $armorKernel -PathType Leaf) {
  $kernelText = [System.IO.File]::ReadAllText($armorKernel)
}
if (Test-Path -LiteralPath $armorContract -PathType Leaf) {
  $contractText = [System.IO.File]::ReadAllText($armorContract)
}

$kernelBytes   = if (Test-Path -LiteralPath $armorKernel -PathType Leaf) { (Get-Item -LiteralPath $armorKernel).Length } else { 0 }
$contractBytes = if (Test-Path -LiteralPath $armorContract -PathType Leaf) { (Get-Item -LiteralPath $armorContract).Length } else { 0 }
if ($kernelBytes -lt 9000 -or $kernelText -notmatch 'Operating Specification' -or $kernelText -notmatch 'Boundaries') {
  throw ('armor\kernel.md 缺失或不是完整内核 (' + $kernelBytes + ' bytes)。从仓库重新 clone 后再装。')
}
if ($contractBytes -lt 100 -or $contractText -notmatch 'Format contract') {
  throw ('armor\contract.md 缺失或不完整 (' + $contractBytes + ' bytes)。从仓库重新 clone 后再装。')
}

$ompAgentDir   = Join-Path $HOME '.omp\agent'
$ompPersonaDir = Join-Path $HOME '.pi\agent\personas'
$ompBinDir     = Join-Path $HOME '.local\bin'
New-Item -ItemType Directory -Force -Path $ompAgentDir, $ompPersonaDir, $ompBinDir | Out-Null

Copy-Item -LiteralPath $armorKernel   -Destination (Join-Path $ompPersonaDir 'kernel.md')   -Force
Copy-Item -LiteralPath $armorContract -Destination (Join-Path $ompPersonaDir 'contract.md') -Force

$personalityPath = Join-Path $ompAgentDir 'PERSONALITY.md'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($personalityPath, ($kernelText + "`r`n`r`n" + $contractText), $utf8NoBom)

$ompCommand = Get-Command -Name 'omp' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ompCommand) {
  Write-Step ('omp 已就绪: ' + $ompCommand.Source)
} else {
  Write-Step '未检测到 omp；先执行 npm i -g @oh-my-pi/pi-coding-agent@18.16.0，再使用 omp-armor。'
}

$wrapperPs1 = Join-Path $ompBinDir 'omp-armor.ps1'
$wrapperBody = @'
$personaPath = Join-Path $HOME '.omp\agent\PERSONALITY.md'
if (-not (Test-Path -LiteralPath $personaPath -PathType Leaf)) {
  Write-Error ('omp-armor: persona file missing: ' + $personaPath)
  exit 1
}
$persona = [System.IO.File]::ReadAllText($personaPath)
& omp --system-prompt $persona @args
exit $LASTEXITCODE
'@
[System.IO.File]::WriteAllText($wrapperPs1, $wrapperBody, $utf8NoBom)

$wrapperCmd = Join-Path $ompBinDir 'omp-armor.cmd'
$cmdBody = "@echo off`r`nsetlocal`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%USERPROFILE%\.local\bin\omp-armor.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n"
[System.IO.File]::WriteAllText($wrapperCmd, $cmdBody, (New-Object System.Text.ASCIIEncoding))

Write-Step ('PERSONALITY: ' + $personalityPath + ' (' + (Get-Item -LiteralPath $personalityPath).Length + ' bytes)')
Write-Step ('Wrapper    : ' + $wrapperCmd)
Write-Step 'omp 双通道部署完成。'