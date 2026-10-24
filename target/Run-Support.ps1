#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Read-SupportJson.ps1')
$root = $PSScriptRoot
$daemon = $null
$tunnel = $null
try {
    $config = Read-SupportJson -Path (Join-Path $root 'session.json')
    if ($config.runtimeRoot -ne $root -or $config.id -notmatch '^[a-f0-9]{16}$') { throw 'Runtime identity mismatch.' }
    $expiry = [DateTimeOffset]$config.expiresAt
    if ($config.revoked -or $expiry -le [DateTimeOffset]::UtcNow -or (Test-Path -LiteralPath (Join-Path $root 'STOP'))) { return }
    . (Join-Path $root 'Read-SupportSsh.ps1')
    $sshd = (Get-SupportSsh -Root $root -ManifestSha256 $config.portableSshManifestSha256).Daemon
    $daemon = Start-Process -FilePath $sshd -ArgumentList ('-D -f "{0}\sshd_config" -E "{0}\sshd.log"' -f $root) -WindowStyle Hidden -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ($daemon.HasExited) { throw 'Temporary sshd exited. See sshd.log.' }
        $client = New-Object Net.Sockets.TcpClient
        try { $client.Connect('127.0.0.1', [int]$config.targetSshPort); $ready = $true; break } catch { Start-Sleep -Milliseconds 250 } finally { $client.Dispose() }
    }
    if (-not $ready) { throw 'Temporary sshd did not begin listening.' }
    $node = Join-Path $root 'runtime\node.exe'
    $tunnel = Start-Process -FilePath $node -ArgumentList ('"{0}\target\tunnel.js" --root "{0}"' -f $root) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'tunnel.log') -RedirectStandardError (Join-Path $root 'tunnel-error.log')
    while ([DateTimeOffset]::UtcNow -lt $expiry -and -not (Test-Path -LiteralPath (Join-Path $root 'STOP'))) {
        if ($daemon.HasExited -or $tunnel.HasExited) { throw 'A support process exited. See logs.' }
        Start-Sleep -Seconds 1
    }
} catch { $_.ToString() | Out-File -LiteralPath (Join-Path $root 'runner-error.log') -Encoding utf8 -Append }
finally {
    if ($tunnel -and -not $tunnel.HasExited) { $tunnel.Kill() }
    if ($daemon -and -not $daemon.HasExited) { $daemon.Kill() }
    # Explicit Stop and the independent expiry task own credential cleanup.
    # A detached cleanup launched here could delete a repaired runtime's keys.
    # On failure we stop owned child processes and retain logs/keys until Stop
    # or expiry, rather than scheduling cleanup against a potentially new root.
}
