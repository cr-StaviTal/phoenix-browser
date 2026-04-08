# register-native-host.ps1 — Register the Phoenix Shield native messaging host
# with Chrome on Windows.
#
# Usage (from repo root, in PowerShell):
#   .\scripts\register-native-host.ps1 -ExtensionId <id> -HostExePath <path>
#
# Parameters:
#   -ExtensionId   Your Chrome extension ID (32-char string from chrome://extensions)
#   -HostExePath   Full path to phoenix-native-host.exe
#                  Default: .\native-host\target\aarch64-pc-windows-msvc\release\phoenix-native-host.exe
#
# Example:
#   .\scripts\register-native-host.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

param(
    [Parameter(Mandatory=$true)]
    [string]$ExtensionId,

    [string]$HostExePath = ""
)

$ErrorActionPreference = "Stop"

$HostName = "com.phoenix.shield"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir

if ($HostExePath -eq "") {
    $HostExePath = Join-Path $RepoRoot "native-host\target\aarch64-pc-windows-msvc\release\phoenix-native-host.exe"
}

if (-not (Test-Path $HostExePath)) {
    Write-Error "phoenix-native-host.exe not found at: $HostExePath`nBuild it first: native-host\build-windows.sh"
    exit 1
}

$HostExePath = Resolve-Path $HostExePath

# Write manifest JSON next to the exe
$ManifestDir  = Split-Path -Parent $HostExePath
$ManifestPath = Join-Path $ManifestDir "$HostName.json"

$Manifest = @{
    name             = $HostName
    description      = "Phoenix Shield Native Messaging Host — clipboard bridge"
    type             = "stdio"
    path             = $HostExePath.ToString()
    allowed_origins  = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3

Set-Content -Path $ManifestPath -Value $Manifest -Encoding UTF8

Write-Host "Manifest written to: $ManifestPath"

# Register in the Chrome native messaging registry key
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath

Write-Host "Registry key set:    $RegKey"
Write-Host ""
Write-Host "Done. Restart Chrome for changes to take effect."
