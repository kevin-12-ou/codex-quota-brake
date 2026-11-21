param(
  [string]$Title = 'Codex Quota Brake',
  [string]$Body = ''
)

# 桌面气泡通知（无第三方依赖）。纯 ASCII，中文标题/正文由调用方作为参数传入。
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Information
$icon.Visible = $true
$icon.ShowBalloonTip(6000, $Title, $Body, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Milliseconds 6500
$icon.Visible = $false
$icon.Dispose()
