#requires -Version 5.1
. (Join-Path $PSScriptRoot 'Read-SupportJson.ps1')
function Test-CapabilityAdministrator {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Set-CapabilityDirectoryRights([string]$Path,[Security.Principal.SecurityIdentifier]$Viewer,[string]$Rights){
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl.SetOwner($admin)
    foreach($sid in @($admin,$system)){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Viewer,$Rights,'ContainerInherit,ObjectInherit','None','Allow')))
    (New-Object IO.DirectoryInfo($Path)).SetAccessControl($acl)
}
function Invoke-SupportCapability {
param([Parameter(Mandatory=$true)][ValidateSet('ensure','inspect','capture','stop','cleanup')][string]$Operation,
      [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{16}$')][string]$SessionId,
      [ValidateSet('screenshot')][string]$Capability='screenshot')
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$script:record=$null
$runtime=[IO.Path]::GetFullPath((Join-Path $env:ProgramData ('CodexTemporarySupport\'+$SessionId)))
$root=Join-Path $runtime 'capability-state\screenshot'
$recordFile=Join-Path $root 'record.json'
$taskName='CodexTemporarySupport-'+$SessionId+'-Screenshot'
function Assert-Path([string]$Path){
    $item=Get-Item -LiteralPath $Path -ErrorAction Stop
    while($item){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Capability refuses reparse points'};$item=$item.Parent}
}
function Read-Json([string]$Path){Read-SupportJson -Path $Path}
function Save-Record { [IO.File]::WriteAllText($recordFile,($script:record | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false))) }
function Digest([string]$Path){$sha=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Assert-Record {
    if($script:record.sessionId -ne $SessionId -or $script:record.capability -ne 'screenshot' -or $script:record.taskName -ne $taskName){throw 'Capability ownership record mismatch'}
    foreach($entry in $script:record.files){if($entry.name -notin @('Capture.ps1','Run.vbs','lease.json','request.json')){throw 'Unexpected owned file'}}
}
function Assert-Task($Task){
    $taskSid=if($Task.Principal.UserId -match '^S-1-'){$Task.Principal.UserId}else{(New-Object Security.Principal.NTAccount($Task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value}
    if($Task.Actions.Count -ne 1 -or $Task.Actions[0].Execute -ine $script:record.execute -or $Task.Actions[0].Arguments -cne $script:record.arguments -or $taskSid -ne $script:record.viewerSid){throw 'Task was changed; refusing to operate on it'}
}
function Assert-Files {
    foreach($entry in $script:record.files){$file=Join-Path $root $entry.name;Assert-Path $file;if((Digest $file) -ne $entry.sha256){throw 'Capability file was changed; refusing to execute it'}}
}
function Record-Process([string]$Nonce){
    $running=Join-Path $root ('captures\'+$Nonce+'.running.json')
    if(Test-Path -LiteralPath $running){
        try{$process=Read-Json $running;if($process.nonce -eq $Nonce -and [int]$process.pid -gt 0){$script:record | Add-Member -NotePropertyName activeProcess -NotePropertyValue $process -Force;Save-Record}}catch{}
    }
}
function Stop-OwnedProcess {
    $process=$script:record.activeProcess
    if(-not $process){return}
    $live=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$process.pid) -ErrorAction SilentlyContinue
    if(-not $live){return}
    $path=Join-Path $root 'Capture.ps1'
    $pattern=[regex]::Escape($path)+'(?=["''\s]|$)'
    if($live.Name -ine 'powershell.exe' -or $live.CommandLine -notmatch $pattern -or [Math]::Abs((([DateTimeOffset]$live.CreationDate).UtcDateTime-([DateTimeOffset]$process.startedAt).UtcDateTime).TotalMilliseconds) -gt 2){throw 'Recorded capture PID belongs to another process; refusing to kill it'}
    Stop-Process -Id $live.ProcessId -Force
}
function Capture {
    Assert-Files
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop;Assert-Task $task
    if($task.State -eq 'Running'){throw 'Capture already in progress; completion is unknown. Inspect before retrying'}
    $nonce=[Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText((Join-Path $root 'request.json'),(@{nonce=$nonce} | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
    $script:record.files=@($script:record.files | Where-Object {$_.name -ne 'request.json'})+@(@{name='request.json';sha256=(Digest (Join-Path $root 'request.json'))})
    $script:record.state='verifying';Save-Record
    Start-ScheduledTask -TaskName $taskName
    $resultPath=Join-Path $root ('captures\'+$nonce+'.json')
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(20)
    while(-not (Test-Path -LiteralPath $resultPath)){
        Record-Process $nonce
        if([DateTimeOffset]::UtcNow -ge $deadline){$script:record.state='unknown';Save-Record;throw 'Capture timed out; task completion is unknown. No automatic replay'}
        if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]$config.expiresAt){throw 'Session expired during capture'}
        Start-Sleep -Milliseconds 200
    }
    Record-Process $nonce
    $result=$null
    for($i=0;$i -lt 10 -and -not $result;$i++){try{$result=Read-Json $resultPath}catch{Start-Sleep -Milliseconds 100}}
    if(-not $result -or $result.nonce -ne $nonce){throw 'Capture result mismatch'}
    if($result.ok -ne $true){$script:record.state='installed-unverified';Save-Record;throw ('Capture unavailable: '+$result.error)}
    $file=Join-Path $root ('captures\'+$nonce+'.png');Assert-Path $file
    $bytes=[IO.File]::ReadAllBytes($file)
    if($bytes.Length -lt 24 -or [BitConverter]::ToString($bytes,0,8) -ne '89-50-4E-47-0D-0A-1A-0A'){throw 'Capture did not produce PNG data'}
    $script:record.state='ready';$script:record | Add-Member -NotePropertyName lastVerifiedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force;Save-Record
    @{sessionId=$SessionId;capability='screenshot';state='ready';file=$file;sha256=(Digest $file);width=$result.width;height=$result.height;verifiedAt=$script:record.lastVerifiedAt}
}
Assert-Path $runtime
$config=Read-Json (Join-Path $runtime 'session.json')
if($config.id -ne $SessionId -or $config.runtimeRoot -ne $runtime){throw 'Runtime identity mismatch'}
if($Operation -in @('ensure','capture')){
    if($config.revoked -or [DateTimeOffset]$config.expiresAt -le [DateTimeOffset]::UtcNow -or (Test-Path -LiteralPath (Join-Path $runtime 'STOP'))){throw 'Session expired or stopped'}
    if($config.authorization.capabilities -notcontains 'screenshot'){throw 'Screenshot is outside the declared session scope'}
}
if($Operation -ne 'inspect'){
    if(-not (Test-CapabilityAdministrator)){throw 'Screenshot management currently requires an authorized administrator SSH account'}
}
if(Test-Path -LiteralPath $root){Assert-Path $root}
if(Test-Path -LiteralPath $recordFile){$script:record=Read-Json $recordFile;Assert-Record}
elseif(Test-Path -LiteralPath $root){throw 'Unowned capability directory; refusing to overwrite or clean it'}
if($Operation -eq 'inspect'){
    if($script:record){@{sessionId=$SessionId;capability='screenshot';record=$script:record;note='Recorded verification is historical; capture performs a fresh check'} | ConvertTo-Json -Depth 8}
    else{@{sessionId=$SessionId;capability='screenshot';state='not-installed'} | ConvertTo-Json}
    return
}
if($Operation -in @('stop','cleanup')){
    if(-not $script:record){@{state='not-installed'} | ConvertTo-Json;return}
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if($task){Assert-Task $task;Stop-ScheduledTask -TaskName $taskName;Disable-ScheduledTask -TaskName $taskName | Out-Null}
    Stop-OwnedProcess
    $script:record.state='stopped';Save-Record
    if($Operation -eq 'cleanup'){
        if($task){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
        $retained=@()
        foreach($entry in $script:record.files){
            $file=Join-Path $root $entry.name
            if(Test-Path -LiteralPath $file){Assert-Path $file;if((Digest $file) -eq $entry.sha256){Remove-Item -LiteralPath $file -Force}else{$retained+=$entry.name}}
        }
        $script:record.state=if($retained.Count){'cleanup-incomplete'}else{'cleaned'}
        $script:record | Add-Member -NotePropertyName retainedModifiedFiles -NotePropertyValue $retained -Force;Save-Record
    }
    @{state=$script:record.state;artifactsRetained=(Join-Path $root 'captures')} | ConvertTo-Json;return
}
if($script:record -and $script:record.state -in @('cleaned','cleanup-incomplete')){throw 'Cleaned capability cannot be silently redeployed; use a new session'}
$viewer=(Get-CimInstance Win32_ComputerSystem).UserName
if(-not $viewer){throw 'No signed-in desktop user'}
if($script:record -and $script:record.viewer -ine $viewer){throw 'Desktop user changed; use a new session or explicitly review the existing instance'}
if(-not $script:record){
    if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){throw 'Unowned task exists; refusing to overwrite it'}
    $viewerSid=(New-Object Security.Principal.NTAccount($viewer)).Translate([Security.Principal.SecurityIdentifier])
    New-Item -ItemType Directory -Path $root | Out-Null
    Set-CapabilityDirectoryRights $root $viewerSid 'ReadAndExecute'
    $script:record=[pscustomobject]@{sessionId=$SessionId;capability='screenshot';version=1;source='builtin';viewer=$viewer;viewerSid=$viewerSid.Value;taskName=$taskName;execute=(Join-Path $env:WINDIR 'System32\wscript.exe');arguments=('"'+$root+'\Run.vbs"');state='deploying';createdAt=[DateTimeOffset]::UtcNow.ToString('o');files=@()}
    Save-Record
    foreach($name in @('Capture.ps1','Run.vbs')){
        $source=Join-Path $PSScriptRoot ('capabilities\screenshot\'+$name)
        $script:record.files+=@{name=$name;sha256=(Digest $source)};Save-Record
        Copy-Item -LiteralPath $source -Destination (Join-Path $root $name)
    }
    New-Item -ItemType Directory -Path (Join-Path $root 'captures') | Out-Null
    Set-CapabilityDirectoryRights (Join-Path $root 'captures') $viewerSid 'Modify'
    [IO.File]::WriteAllText((Join-Path $root 'lease.json'),(@{runtimeRoot=$runtime;expiresAt=$config.expiresAt} | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
    $script:record.files+=@{name='lease.json';sha256=(Digest (Join-Path $root 'lease.json'))};Save-Record
    $action=New-ScheduledTaskAction -Execute $script:record.execute -Argument $script:record.arguments
    $principal=New-ScheduledTaskPrincipal -UserId $viewer -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromSeconds(30)) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $script:record.state='installed-unverified';Save-Record
}elseif($script:record.state -eq 'stopped'){$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop;Assert-Task $task;Enable-ScheduledTask -TaskName $taskName | Out-Null}
# Ensure verifies via a real capture as well, rather than reporting task registration as readiness.
Capture | ConvertTo-Json -Depth 5

}
