#Requires -Version 5.1
<#
  卸载 Codex Quota Brake
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge   # 连配置和日志一起删
#>
[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'CodexQuotaBrake'),
  [switch]$Purge
)

$ErrorActionPreference = 'Continue'
function Info($m) { Write-Host "[uninstall] $m" }

# 1) 取消开机自启
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ((Get-ItemProperty -Path $runKey -Name 'CodexQuotaBrake' -ErrorAction SilentlyContinue)) {
  Remove-ItemProperty -Path $runKey -Name 'CodexQuotaBrake'
  Info '已移除开机自启'
} else {
  Info '没有找到开机自启项（可能已经手动删过）'
}

# 2) 停掉正在跑的刹车
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $Prefix + '*') -and $_.CommandLine -like '*quota_brake.mjs*' }
if ($procs) {
  foreach ($p in $procs) {
    & taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
    Info ("已停止进程 " + $p.ProcessId)
  }
} else {
  Info '没有正在运行的刹车进程'
}

# 3) 删除文件
if ($Purge) {
  if (Test-Path $Prefix) {
    Remove-Item -Path $Prefix -Recurse -Force
    Info "已删除目录 $Prefix（含配置与日志）"
  }
} else {
  Info "保留目录 $Prefix（配置和日志还在）。要连它们一起删，加 -Purge"
}
