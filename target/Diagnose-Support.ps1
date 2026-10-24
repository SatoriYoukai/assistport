#requires -Version 5.1
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'Read-SupportLog.ps1')
. (Join-Path $PSScriptRoot 'Read-SupportJson.ps1')
$config = Read-SupportJson -Path (Join-Path $PSScriptRoot 'session.json')
if ($config.id -notmatch '^[a-f0-9]{16}$') { throw 'Invalid session.' }
$root = Join-Path $env:ProgramData ('CodexTemporarySupport\' + $config.id)
Write-Host "Session: $($config.id)"
Write-Host "Time: $([DateTimeOffset]::UtcNow.ToString('o'))"
Write-Host "Windows OpenSSH component present: $(Test-Path -LiteralPath (Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe'))"
Write-Host "Session portable OpenSSH present: $(Test-Path -LiteralPath (Join-Path $root 'openssh\sshd.exe'))"
if (Test-Path -LiteralPath $root) {
    foreach ($name in @('bootstrap-error.log','runner-error.log','tunnel-error.log','tunnel.log','sshd.log')) {
        $file = Join-Path $root $name
        if (Test-Path -LiteralPath $file) { Write-Host "--- $name ---"; Read-SupportLog -Path $file -Lines 20 }
    }
}
Get-ScheduledTask -TaskName ('CodexTemporarySupport-' + $config.id + '*') -ErrorAction SilentlyContinue | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName ('CodexTemporarySupport-' + $config.id) -ErrorAction SilentlyContinue | Select-Object LastRunTime,LastTaskResult
Write-Host 'Diagnostic output contains no session credentials.'
