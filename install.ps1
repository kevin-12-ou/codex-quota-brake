#Requires -Version 5.1
<#
  安装 Codex Quota Brake（Windows）
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
  参数：
    -Prefix      安装目录（默认 %LOCALAPPDATA%\CodexQuotaBrake）
    -NoAutostart 不注册开机自启
    -NoStart     安装完不立即启动
    -DryRun      只演练：复制文件到 Prefix，但不写注册表、不启动
#>
[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'CodexQuotaBrake'),
  [switch]$NoAutostart,
  [switch]$NoStart,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
function Info($m) { Write-Host "[install] $m" }
function Warn($m) { Write-Host "[install] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[install] ERROR: $m" -ForegroundColor Red; exit 1 }

# 1) Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail '未找到 Node.js。请先安装 Node 22.5 或更高版本：https://nodejs.org' }
$node = $nodeCmd.Source
$verText = (& $node -v).Trim()
$verNum = [version](($verText -replace '^v', '').Split('-')[0])
if ($verNum -lt [version]'22.5.0') { Fail "Node 版本过低：$verText（需要 >= 22.5，脚本用到内置 node:sqlite）" }
Info "Node $verText"

# 2) Codex 登录
$auth = Join-Path $env:USERPROFILE '.codex\auth.json'
if (-not (Test-Path $auth)) {
  Warn "没有找到 $auth"
  Warn '请先打开 Codex 桌面版并用 ChatGPT 账号登录，或在终端运行：codex login'
  Warn '否则刹车无法读取额度（它会直接报 app-server 读不到 x-codex 头）。'
} else {
  Info "已检测到 Codex 登录凭据：$auth"
}

# 3) 复制文件（三个工具 + 共享库）
if ($DryRun) { Info "DRY-RUN：目标目录 $Prefix（不写注册表、不启动）" }
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'lib') | Out-Null
Copy-Item (Join-Path $repo 'src\quota_brake.mjs') $Prefix -Force
Copy-Item (Join-Path $repo 'src\send.mjs') $Prefix -Force
Copy-Item (Join-Path $repo 'src\fingerprint.mjs') $Prefix -Force
Copy-Item (Join-Path $repo 'src\notify.ps1') $Prefix -Force
Copy-Item (Join-Path $repo 'src\lib\quota.mjs') (Join-Path $Prefix 'lib') -Force
$fpCfg = Join-Path $Prefix 'fingerprint.config.json'
if (-not (Test-Path $fpCfg)) {
  Copy-Item (Join-Path $repo 'src\fingerprint.config.example.json') $fpCfg
}
$cfg = Join-Path $Prefix 'config.json'
if (-not (Test-Path $cfg)) {
  Copy-Item (Join-Path $repo 'config.example.json') $cfg
  Info "已生成配置文件：$cfg"
} else {
  Info "保留已有配置：$cfg"
}

# 4) 隐藏启动器
$vbs = Join-Path $Prefix 'launch.vbs'
$vbsBody = @"
Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Prefix"
cmd = """" & "$node" & """ """ & "$Prefix\quota_brake.mjs" & """"
sh.Run cmd, 0, False
"@
[IO.File]::WriteAllText($vbs, $vbsBody, (New-Object System.Text.UTF8Encoding($false)))

# 5) 开机自启
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($NoAutostart) {
  Info '跳过开机自启（-NoAutostart）'
} elseif ($DryRun) {
  Info "DRY-RUN：会写入 $runKey 的 CodexQuotaBrake"
} else {
  Set-ItemProperty -Path $runKey -Name 'CodexQuotaBrake' -Value ('wscript.exe //B //Nologo "' + $vbs + '"')
  Info '已注册开机自启：CodexQuotaBrake'
}

# 6) 启动
if ($NoStart -or $DryRun) {
  Info '跳过启动'
} else {
  Start-Process 'wscript.exe' -ArgumentList '//B', '//Nologo', ('"' + $vbs + '"') -WindowStyle Hidden
  Start-Sleep -Seconds 8
}

# 7) 自检（读一次额度，不消耗额度）
Info '自检：读取一次 Codex 额度（不是模型请求，不消耗额度）'
& $node (Join-Path $Prefix 'quota_brake.mjs') --once --dry-run --json
if ($LASTEXITCODE -ne 0) {
  Warn '自检没读到额度。常见原因：Codex 没登录 / 没装桌面版 / 代理导致读不到。'
  Warn '先手动跑一次看详细日志：'
  Warn ('  & "' + $node + '" "' + (Join-Path $Prefix 'quota_brake.mjs') + '" --once --dry-run --json')
}

Write-Host ''
Info '安装完成。'
Info ('  安装目录：' + $Prefix)
Info ('  配置：    ' + $cfg)
Info ('  日志：    ' + (Join-Path $Prefix '.state\brake.log'))
Info '  只查看判定不动作：node "<安装目录>\quota_brake.mjs" --once --json'
Info '  要真的执行一轮：  node "<安装目录>\quota_brake.mjs" --once --yes --json'
Write-Host ''
Info '注意：杀进程会让「那个 app-server 上所有会话」的当前回合一起结束（会话本身保留，可 codex resume）。'
Info '卸载：powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1'
