# install-etw-monitor.ps1 — Copy the ETW monitor binary to Program Files and
# create a shortcut that runs it elevated (as Administrator).
#
# Must be run as Administrator itself to write to Program Files and create the
# scheduled task.
#
# Usage (elevated PowerShell, from repo root):
#   .\scripts\install-etw-monitor.ps1
#
# Optional parameter:
#   -ExePath   Path to phoenix-etw-monitor.exe
#              Default: .\native-host\target\aarch64-pc-windows-msvc\release\phoenix-etw-monitor.exe

param(
    [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot    = Split-Path -Parent $ScriptDir
$InstallDir  = "$env:ProgramFiles\PhoenixShield"
$TaskName    = "PhoenixETWMonitor"

if ($ExePath -eq "") {
    $ExePath = Join-Path $RepoRoot "native-host\target\aarch64-pc-windows-msvc\release\phoenix-etw-monitor.exe"
}

if (-not (Test-Path $ExePath)) {
    Write-Error "phoenix-etw-monitor.exe not found at: $ExePath`nBuild it first: native-host\build-windows.sh"
    exit 1
}

# ---- Copy binary ----

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item $ExePath "$InstallDir\phoenix-etw-monitor.exe" -Force
Write-Host "Installed to: $InstallDir\phoenix-etw-monitor.exe"

# ---- Create scheduled task (runs as SYSTEM = always elevated) ----

$Action  = New-ScheduledTaskAction -Execute "$InstallDir\phoenix-etw-monitor.exe"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartOnIdle $false
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Phoenix Shield ETW process monitor (requires elevation)" `
    -Force | Out-Null

Write-Host "Scheduled task '$TaskName' created — runs as SYSTEM at logon."
Write-Host ""
Write-Host "To start it now without rebooting:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To stop it:"
Write-Host "  Stop-ScheduledTask  -TaskName '$TaskName'"
Write-Host ""
Write-Host "Logs written to: %USERPROFILE%\phoenix-etw-monitor.log"
