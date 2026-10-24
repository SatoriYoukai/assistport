#requires -Version 5.1
[CmdletBinding()]
param([string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'CodexTemporarySupportController'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'target\Read-SupportJson.ps1')
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$recordFile = Join-Path $StateDirectory 'receiver-processes.json'
if (-not (Test-Path -LiteralPath $recordFile)) { return }
$record = Read-SupportJson -Path $recordFile
foreach ($entry in @($record.cloudflared, $record.receiver)) {
    if (-not $entry) { continue }
    $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $entry.startedAt) { Stop-Process -Id $entry.id -Force }
}
Remove-Item -LiteralPath $recordFile -Force
Write-Host 'The support receiver and its own temporary Tunnel have stopped.'
