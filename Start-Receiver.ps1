#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'CodexTemporarySupportController'),
    [ValidateRange(1024,65535)][int]$HttpPort = 20246,
    [int]$DirectPort = 0,
    [string]$DirectBind = '::',
    [switch]$QuickTunnel,
    [string]$CloudflaredPath,
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'target\Read-SupportJson.ps1')
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
if ($DirectPort -ne 0 -and ($DirectPort -lt 1024 -or $DirectPort -gt 65535)) { throw 'Invalid direct port.' }
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$item = Get-Item -LiteralPath $StateDirectory
while ($item) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'State directory cannot contain reparse points.' }; $item = $item.Parent }
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($owner)
foreach ($sid in @($owner, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -LiteralPath $StateDirectory -AclObject $acl
$instanceFile = Join-Path $StateDirectory 'receiver-processes.json'
if (Test-Path -LiteralPath $instanceFile) {
    $old = Read-SupportJson -Path $instanceFile
    $existing = Get-Process -Id $old.receiver.id -ErrorAction SilentlyContinue
    if ($existing -and $existing.StartTime.ToUniversalTime().ToString('o') -eq $old.receiver.startedAt) { throw 'Receiver is already running. Use Stop-Receiver.ps1 first.' }
}
& $NodePath (Join-Path $PSScriptRoot 'new-session.js') init --state $StateDirectory
if ($LASTEXITCODE -ne 0) { throw 'Receiver state initialization failed.' }
$receiver = $null
$cloud = $null
try {
    $receiverArgs = '"{0}" --state "{1}" --http-port {2}' -f (Join-Path $PSScriptRoot 'receiver.js'), $StateDirectory, $HttpPort
    if ($DirectPort) { $receiverArgs += ' --direct-port {0} --direct-bind "{1}"' -f $DirectPort,$DirectBind }
    $receiver = Start-Process -FilePath $NodePath -ArgumentList $receiverArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'receiver.log') -RedirectStandardError (Join-Path $StateDirectory 'receiver-error.log')
    $ready = $false
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        if ($receiver.HasExited) { throw (Get-Content -LiteralPath (Join-Path $StateDirectory 'receiver-error.log') -Raw) }
        try {
            $health = Invoke-WebRequest -Uri "http://127.0.0.1:$HttpPort/health" -UseBasicParsing -TimeoutSec 1
            if ($health.Content.Trim() -eq 'temporary-support') { $ready=$true; break }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Receiver failed its local health check.' }
    $endpoint = $null
    if ($QuickTunnel) {
        if (-not $CloudflaredPath) { $CloudflaredPath = (Get-Command cloudflared.exe -ErrorAction Stop).Source }
        $emptyConfig = Join-Path $StateDirectory 'cloudflared-empty.yml'
        [IO.File]::WriteAllText($emptyConfig, "{}")
        $cloudLog = Join-Path $StateDirectory 'cloudflared.log'
        $cloudArgs = '--no-autoupdate tunnel --config "{0}" --url http://127.0.0.1:{1} --protocol http2 --metrics 127.0.0.1:0' -f $emptyConfig,$HttpPort
        $cloud = Start-Process -FilePath $CloudflaredPath -ArgumentList $cloudArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $StateDirectory 'cloudflared-output.log') -RedirectStandardError $cloudLog
        for ($attempt=0; $attempt -lt 100; $attempt++) {
            if ($cloud.HasExited) { throw 'Temporary Cloudflare Tunnel exited. See cloudflared.log.' }
            $text = Get-Content -LiteralPath $cloudLog -Raw -ErrorAction SilentlyContinue
            if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $endpoint=$Matches[0]; break }
            Start-Sleep -Milliseconds 300
        }
        if (-not $endpoint) { throw 'No Quick Tunnel endpoint was obtained within 30 seconds.' }
    }
    $record = [ordered]@{
        receiver=@{id=$receiver.Id; startedAt=$receiver.StartTime.ToUniversalTime().ToString('o')};
        cloudflared=$null; endpoint=$endpoint; httpPort=$HttpPort; directPort=$DirectPort
    }
    if ($cloud) { $record.cloudflared=@{id=$cloud.Id; startedAt=$cloud.StartTime.ToUniversalTime().ToString('o')} }
    [IO.File]::WriteAllText($instanceFile, ($record | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    [pscustomobject]@{StateDirectory=$StateDirectory; Endpoint=$endpoint; ReceiverPID=$receiver.Id; DirectPort=$DirectPort} | ConvertTo-Json
} catch {
    if ($cloud -and -not $cloud.HasExited) { $cloud.Kill() }
    if ($receiver -and -not $receiver.HasExited) { $receiver.Kill() }
    throw
}
