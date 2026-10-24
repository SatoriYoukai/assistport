#requires -Version 5.1
[CmdletBinding()]
param([string]$User = $env:USERNAME, [switch]$CheckOnly, [switch]$Repair)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Read-SupportLog.ps1')
. (Join-Path $PSScriptRoot 'Read-SupportJson.ps1')

function Assert-NoReparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    while ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not allowed: $($item.FullName)" }
        $item = $item.Parent
    }
}
function Protect-Directory([string]$Path) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $admin = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl.SetOwner($admin)
    foreach ($sid in @($admin, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Write-Utf8([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false))) }
function New-ServiceFileAcl {
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $admin = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl.SetOwner($admin)
    foreach ($sid in @($admin, $system)) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    }
    return $acl
}
function Protect-ServiceFile([string]$Path) {
    # ssh-keygen adds an explicit ACE for its creating user even when the parent
    # directory is protected. SYSTEM sshd rejects that ACE on a host private key.
    Set-Acl -LiteralPath $Path -AclObject (New-ServiceFileAcl)
    $actual = Get-Acl -LiteralPath $Path
    $ownerSid = $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not $actual.AreAccessRulesProtected -or $ownerSid -ne 'S-1-5-32-544') { throw "Private file owner/inheritance verification failed: $Path" }
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw "Unexpected private file access rules: $Path" }
    foreach ($rule in $rules) {
        if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw "Private file access verification failed: $Path" }
    }
}

$source = $PSScriptRoot
$config = Read-SupportJson -Path (Join-Path $source 'session.json')
if ($config.version -ne 1 -or $config.id -notmatch '^[a-f0-9]{16}$') { throw 'Invalid support package.' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This package requires 64-bit Windows and 64-bit PowerShell.' }
if ($config.revoked -or ([DateTimeOffset]$config.expiresAt) -le [DateTimeOffset]::UtcNow) { throw 'This support package has expired.' }
if ($User -notmatch '^[a-zA-Z0-9_.-]{1,64}$') { throw 'This version supports simple local Windows account names only.' }
if ($config.targetSshPort -lt 1024 -or $config.targetSshPort -gt 65535) { throw 'Invalid target port.' }
if ($config.controlPublicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$') { throw 'Invalid controller public key.' }
$node = Join-Path $source 'runtime\node.exe'
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.runtimeSha256) { throw 'Bundled Node runtime hash mismatch.' }
if ((Get-AuthenticodeSignature -FilePath $node).Status -ne 'Valid') { throw 'Node runtime signature is not valid on this computer.' }
. (Join-Path $source 'Read-SupportSsh.ps1')
$ssh = Get-SupportSsh -Root $source -ManifestSha256 $config.portableSshManifestSha256
if ($CheckOnly) {
    [pscustomobject]@{Session=$config.id; ExpiresAt=$config.expiresAt; User=$User; RuntimeVerified=$true; Transport=$config.transport; OpenSshPresent=$ssh.Available; PortableSshVerified=$ssh.Portable} | ConvertTo-Json
    return
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Administrator approval is needed to start the temporary support environment.'
    $arg = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -User "{1}"' -f $PSCommandPath, $User
    if ($Repair) { $arg += ' -Repair' }
    $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arg -Verb RunAs -WindowStyle Hidden -PassThru -Wait
    if ($elevated.ExitCode -ne 0) { throw 'Elevated bootstrap failed. Run Bootstrap.ps1 in an administrator PowerShell to see details.' }
    return
}
$account = Get-LocalUser -Name $User -ErrorAction Stop
if (-not $account.Enabled) { throw 'Selected local account is disabled.' }
$base = Join-Path $env:ProgramData 'CodexTemporarySupport'
if (Test-Path -LiteralPath $base) { Assert-NoReparse $base } else { New-Item -ItemType Directory -Path $base | Out-Null }
Protect-Directory $base
$root = Join-Path $base $config.id
$previousHostKey = $null
$previousHostPublic = $null
if (Test-Path -LiteralPath $root) {
    Assert-NoReparse $root
    if (-not $Repair) { throw 'A previous attempt exists. Run RETRY.cmd from the extracted package to diagnose and repair it.' }
    if ([IO.Path]::GetFullPath($source).Equals([IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase)) { throw 'Run repair from the ORIGINAL extracted package, not the runtime directory.' }
    $old = Read-SupportJson -Path (Join-Path $root 'session.json')
    if ($old.id -ne $config.id -or $old.runtimeRoot -ne $root) { throw 'Existing directory identity mismatch; refusing to move or clean it.' }
    Write-Host 'Previous attempt found. Diagnostic output follows:'
    foreach ($name in @('bootstrap-error.log','runner-error.log','tunnel-error.log','tunnel.log','sshd.log')) {
        $log = Join-Path $root $name
        if (Test-Path -LiteralPath $log) {
            Write-Host "--- $name ---"
            Read-SupportLog -Path $log -Lines 12
        }
    }
    # Keep an already registered target identity stable across a repair.
    if ((Test-Path -LiteralPath (Join-Path $root 'target_host_key')) -and (Test-Path -LiteralPath (Join-Path $root 'target_host_key.pub'))) {
        $previousHostKey = [IO.File]::ReadAllBytes((Join-Path $root 'target_host_key'))
        $previousHostPublic = [IO.File]::ReadAllBytes((Join-Path $root 'target_host_key.pub'))
    }
    # Use the fixed cleanup shipped in this package, rather than executing an
    # older failed installation's script during repair.
    & (Join-Path $source 'Stop-Support.ps1') -SessionId $config.id
    $archive = [IO.Path]::GetFullPath((Join-Path $base ($config.id + '-previous-' + [Guid]::NewGuid().ToString('N'))))
    if (-not $archive.StartsWith(([IO.Path]::GetFullPath($base) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped the support base directory.' }
    Move-Item -LiteralPath $root -Destination $archive
    Write-Host "Previous logs retained at $archive"
}
New-Item -ItemType Directory -Path $root | Out-Null
Protect-Directory $root
$runTask = 'CodexTemporarySupport-' + $config.id
$stopTask = $runTask + '-Expire'
$config | Add-Member -NotePropertyName targetUser -NotePropertyValue $User.ToLowerInvariant() -Force
$config | Add-Member -NotePropertyName computer -NotePropertyValue $env:COMPUTERNAME -Force
$config | Add-Member -NotePropertyName runtimeRoot -NotePropertyValue $root -Force
$config | Add-Member -NotePropertyName installedOpenSsh -NotePropertyValue $false -Force
$config | Add-Member -NotePropertyName createdDefaultFirewallRule -NotePropertyValue $false -Force
try {
    foreach ($entry in Get-ChildItem -LiteralPath $source -Force) { Copy-Item -LiteralPath $entry.FullName -Destination $root -Recurse }
    Write-Utf8 (Join-Path $root 'session.json') ($config | ConvertTo-Json -Depth 8)
    $ssh = Get-SupportSsh -Root $root -ManifestSha256 $config.portableSshManifestSha256
    $sshd = $ssh.Daemon
    if($ssh.Portable){
        Grant-SupportSshReadAccess -Root $root
        Write-Host 'Using bundled OpenSSH; Windows component installation is not required.'
    }
    if (-not (Test-Path -LiteralPath $sshd)) {
        $hadDefaultRule = [bool](Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)
        Write-Host 'Installing the Windows OpenSSH Server optional feature...'
        $result = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
        $config.installedOpenSsh = $true
        if (-not $hadDefaultRule -and (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
            Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Out-Null
            $config.createdDefaultFirewallRule = $true
        }
        Write-Utf8 (Join-Path $root 'session.json') ($config | ConvertTo-Json -Depth 8)
        if ($result.RestartNeeded) { throw 'Windows requested a restart after installing OpenSSH. Restart and generate a new support package.' }
    }
    if (-not (Test-Path -LiteralPath $sshd)) { throw 'Windows OpenSSH installation did not provide sshd.exe.' }
    $probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$config.targetSshPort)
    try { $probe.Start() } finally { $probe.Stop() }
    $hostKey = Join-Path $root 'target_host_key'
    $keygen = $ssh.Keygen
    if ($previousHostKey) {
        [IO.File]::WriteAllBytes($hostKey, $previousHostKey)
        [IO.File]::WriteAllBytes(($hostKey + '.pub'), $previousHostPublic)
    } else {
        $keyProcess = Start-Process -FilePath $keygen -ArgumentList ('-q -t ed25519 -N "" -f "{0}"' -f $hostKey) -WindowStyle Hidden -PassThru -Wait
        if ($keyProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath ($hostKey + '.pub'))) { throw 'Host key generation failed.' }
    }
    Protect-ServiceFile $hostKey
    Protect-ServiceFile (Join-Path $root 'tunnel_key')
    Write-Utf8 (Join-Path $root 'authorized_keys') ($config.controlPublicKey + "`n")
    # Standard accounts can read their public authorization file without being
    # allowed to edit the elevated runner, config, or private credentials.
    $keyAcl = Get-Acl -LiteralPath (Join-Path $root 'authorized_keys')
    $keyAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account.SID, 'Read', 'Allow')))
    Set-Acl -LiteralPath (Join-Path $root 'authorized_keys') -AclObject $keyAcl
    $rootAcl = Get-Acl -LiteralPath $root
    $rootAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($account.SID, 'ReadAndExecute', 'None', 'None', 'Allow')))
    Set-Acl -LiteralPath $root -AclObject $rootAcl
    $sshPath = $root.Replace('\', '/')
    $sftpPath = $ssh.Sftp.Replace('\', '/')
    $lines = @(
        "Port $($config.targetSshPort)", 'ListenAddress 127.0.0.1',
        ('HostKey "{0}/target_host_key"' -f $sshPath),
        ('AuthorizedKeysFile "{0}/authorized_keys"' -f $sshPath),
        "AllowUsers $($config.targetUser)", 'PubkeyAuthentication yes', 'AuthenticationMethods publickey',
        'PasswordAuthentication no', 'ChallengeResponseAuthentication no',
        'AllowAgentForwarding no', 'AllowTcpForwarding no', 'GatewayPorts no',
        'PermitTTY no', 'MaxAuthTries 3', 'LoginGraceTime 20', 'LogLevel VERBOSE',
        ('Subsystem sftp "{0}"' -f $sftpPath)
    )
    Write-Utf8 (Join-Path $root 'sshd_config') ($lines -join "`n")
    Protect-ServiceFile (Join-Path $root 'sshd_config')
    $validation = & $sshd -t -f (Join-Path $root 'sshd_config') 2>&1
    if ($LASTEXITCODE -ne 0) { throw "OpenSSH rejected the configuration: $validation" }
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}\Run-Support.ps1"' -f $root)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $runTask -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings | Out-Null
    $stopAction = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}\Stop-Support.ps1"' -f $root)
    $expire = ([DateTimeOffset]$config.expiresAt).LocalDateTime
    Register-ScheduledTask -TaskName $stopTask -Action $stopAction -Trigger (New-ScheduledTaskTrigger -Once -At $expire) -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $runTask
    Start-Sleep -Seconds 3
    $taskState = Get-ScheduledTask -TaskName $runTask -ErrorAction SilentlyContinue
    $taskInfo = Get-ScheduledTaskInfo -TaskName $runTask -ErrorAction SilentlyContinue
    if (-not $taskState -or ($taskState.State -ne 'Running' -and $taskInfo.LastTaskResult -ne 0)) {
        foreach ($name in @('runner-error.log','tunnel-error.log','sshd.log')) {
            $log = Join-Path $root $name
            if (Test-Path -LiteralPath $log) { Write-Host "--- $name ---"; Read-SupportLog -Path $log -Lines 20 }
        }
        throw 'Support runner did not remain running. See diagnostic output above.'
    }
    Write-Host "Temporary support started. Session: $($config.id)"
    Write-Host "Expires: $expire (local time). Stop: $root\Stop-Support.ps1"
    Write-Host 'Connection status is in tunnel.log. The operator must verify a real remote command.'
    # Public display data is separate from session.json and never exposes keys
    # or bearer credentials to the limited interactive desktop account.
    try {
        $display=[ordered]@{id=$config.id;operatorLabel=$config.operatorLabel;targetUser=$config.targetUser;expiresAt=$config.expiresAt;authorization=$config.authorization;state='started'}
        Write-Utf8 (Join-Path $root 'info.json') ($display | ConvertTo-Json -Depth 5)
        $viewer=(Get-CimInstance Win32_ComputerSystem).UserName
        if($viewer){
            $viewerSid=(New-Object Security.Principal.NTAccount($viewer)).Translate([Security.Principal.SecurityIdentifier])
            $visibleAcl=Get-Acl -LiteralPath $root
            $visibleAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($viewerSid,'ReadAndExecute','None','None','Allow')))
            Set-Acl -LiteralPath $root -AclObject $visibleAcl
            foreach($visibleFile in @('Show-SessionInfo.ps1','info.json')){
                $file=Join-Path $root $visibleFile
                $visibleAcl=Get-Acl -LiteralPath $file
                $visibleAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($viewerSid,'ReadAndExecute','Allow')))
                Set-Acl -LiteralPath $file -AclObject $visibleAcl
            }
            $uiAction=New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "'+$root+'\Show-SessionInfo.ps1"')
            $uiPrincipal=New-ScheduledTaskPrincipal -UserId $viewer -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName ($runTask+'-Info') -Action $uiAction -Principal $uiPrincipal -Settings $settings -Force | Out-Null
            Start-ScheduledTask -TaskName ($runTask+'-Info')
        }else{Write-Warning 'No signed-in desktop user; session information remains available in info.json.'}
    }catch{Write-Warning ('Session started, but the information window could not open: '+$_.Exception.Message)}
} catch {
    $problem = $_
    try { Write-Utf8 (Join-Path $root 'bootstrap-error.log') ($problem.ToString() + "`r`n" + $problem.ScriptStackTrace) } catch {}
    if (Test-Path -LiteralPath (Join-Path $root 'Stop-Support.ps1')) {
        try { & (Join-Path $root 'Stop-Support.ps1') } catch { Write-Warning "Rollback could not complete: $($_.Exception.Message)" }
    }
    throw $problem
}
