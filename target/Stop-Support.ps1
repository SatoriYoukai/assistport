#requires -Version 5.1
[CmdletBinding()]
param([string]$SessionId)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Read-SupportJson.ps1')
$base = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'CodexTemporarySupport'))
if ($SessionId) {
    if ($SessionId -notmatch '^[a-f0-9]{16}$') { throw 'Invalid session ID.' }
    $root = Join-Path $base $SessionId
} else {
    $root = [IO.Path]::GetFullPath($PSScriptRoot)
    if (-not $root.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $package = Read-SupportJson -Path (Join-Path $PSScriptRoot 'session.json')
        if ($package.id -notmatch '^[a-f0-9]{16}$') { throw 'Invalid package session ID.' }
        $root = Join-Path $base $package.id
    }
}
if (-not $root.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($root) -notmatch '^[a-f0-9]{16}$') { throw 'Cleanup is restricted to the support runtime directory.' }
if (-not (Test-Path -LiteralPath $root)) { return }
$item = Get-Item -LiteralPath $root
while ($item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup refuses reparse points.' }
    $item = $item.Parent
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arg = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -SessionId "{1}"' -f $PSCommandPath, [IO.Path]::GetFileName($root)
    $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arg -Verb RunAs -WindowStyle Hidden -PassThru -Wait
    if ($elevated.ExitCode -ne 0) { throw 'Cleanup requires administrator permission.' }
    return
}
$config = Read-SupportJson -Path (Join-Path $root 'session.json')
if ($config.id -ne [IO.Path]::GetFileName($root) -or $config.runtimeRoot -ne $root) { throw 'Cleanup identity mismatch.' }
[IO.File]::WriteAllText((Join-Path $root 'STOP'), 'revoked')
$config.revoked = $true
[IO.File]::WriteAllText((Join-Path $root 'session.json'), ($config | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
if(Test-Path -LiteralPath (Join-Path $root 'capability-state\screenshot\record.json')){
    try{& (Join-Path $root 'Manage-Capability.ps1') -SessionId $config.id -Operation cleanup -Capability screenshot | Write-Host}
    catch{Write-Warning ('Screenshot cleanup incomplete: '+$_.Exception.Message)}
}
# Collect descendants before stopping the runner; terminate only captured support processes.
$all = @(Get-CimInstance Win32_Process)
$owned = @($all | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($root) -and
    (($_.Name -ieq 'sshd.exe' -and $_.CommandLine.Contains('sshd_config')) -or
     ($_.Name -ieq 'node.exe' -and $_.CommandLine.Contains('tunnel.js')) -or
     ($_.Name -ieq 'powershell.exe' -and $_.CommandLine.Contains('Run-Support.ps1')))
})
$ids = New-Object 'Collections.Generic.HashSet[uint32]'
foreach ($proc in $owned) { [void]$ids.Add([uint32]$proc.ProcessId) }
do {
    $added = $false
    foreach ($proc in $all) { if ($proc.ProcessId -ne $PID -and $ids.Contains([uint32]$proc.ParentProcessId) -and $ids.Add([uint32]$proc.ProcessId)) { $added = $true } }
} while ($added)
$task = 'CodexTemporarySupport-' + $config.id
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
foreach ($proc in $all | Where-Object { $ids.Contains([uint32]$_.ProcessId) }) {
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $proc.ProcessId)
    if ($current -and $current.CreationDate -eq $proc.CreationDate) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
}
if(Test-Path -LiteralPath (Join-Path $root 'info.json')){
    try{$display=Read-SupportJson -Path (Join-Path $root 'info.json');$display.state='stopped';[IO.File]::WriteAllText((Join-Path $root 'info.json'),($display | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))}catch{}
}
foreach ($name in @($task, ($task + '-Expire'), ($task + '-Info'))) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
foreach ($name in @('tunnel_key', 'target_host_key', 'authorized_keys')) {
    $file = Join-Path $root $name
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
if ($config.createdDefaultFirewallRule) { Remove-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue }
Write-Host "Support revoked: $($config.id). Keys removed; logs retained at $root."
Write-Host 'Delete the original received ZIP and extracted package too; they contain the tunnel credential.'
