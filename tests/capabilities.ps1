$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\target\Capability.Core.ps1')
# Test only orchestration and file ownership. No real task or screen capture.
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('support-capability-test-'+[Guid]::NewGuid().ToString('N'))
$savedProgramData=$env:ProgramData
$env:ProgramData=$testRoot
$id='0123456789abcdef'
$runtime=Join-Path $testRoot ('CodexTemporarySupport\'+$id)
$workspace=Join-Path $runtime 'capability-state\screenshot'
$fixtureTask=$null;$registerCount=0;$captureCount=0;$successfulCaptures=0;$fixtureLiveProcess=$null;$killedProcesses=0;$produceResult=$true;$adminAllowed=$true
$viewerName=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$testConfig=@{id=$id;runtimeRoot=$runtime;expiresAt=[DateTimeOffset]::UtcNow.AddHours(1).ToString('o');revoked=$false;authorization=@{capabilities=@('command','files','screenshot','desktop')}}
function Write-TestConfig{[IO.File]::WriteAllText((Join-Path $runtime 'session.json'),($testConfig | ConvertTo-Json -Depth 4))}
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Expect-Failure([scriptblock]$Action,[string]$Pattern){$failed=$false;try{& $Action}catch{$failed=$_.Exception.Message -match $Pattern};Check $failed ('Expected failure: '+$Pattern)}
function Test-CapabilityAdministrator{return $adminAllowed}
function Set-CapabilityDirectoryRights {param($Path,$Viewer,$Rights)}
function Get-CimInstance {param($ClassName,$Filter) if($ClassName -eq 'Win32_Process'){$fixtureLiveProcess}else{[pscustomobject]@{UserName=$viewerName}}}
function Stop-Process {param($Id,[switch]$Force) $script:killedProcesses++}
function Get-ScheduledTask {[CmdletBinding()]param($TaskName) if($fixtureTask -and $fixtureTask.TaskName -eq $TaskName){$fixtureTask}}
function New-ScheduledTaskAction {param($Execute,$Argument) [pscustomobject]@{Execute=$Execute;Arguments=$Argument}}
function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel) [pscustomobject]@{UserId=(New-Object Security.Principal.NTAccount($UserId)).Translate([Security.Principal.SecurityIdentifier]).Value}}
function New-ScheduledTaskSettingsSet {[CmdletBinding()]param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$MultipleInstances) [pscustomobject]@{}}
function Register-ScheduledTask {param($TaskName,$Action,$Principal,$Settings) $script:registerCount++;$script:fixtureTask=[pscustomobject]@{TaskName=$TaskName;Actions=@($Action);Principal=$Principal;State='Ready'}}
function Start-ScheduledTask {param($TaskName)
    $script:captureCount++
    $request=Get-Content (Join-Path $workspace 'request.json') -Raw | ConvertFrom-Json
    [IO.File]::WriteAllText((Join-Path $workspace ('captures\'+$request.nonce+'.running.json')),(@{nonce=$request.nonce;pid=12345;startedAt=[DateTimeOffset]::UtcNow.ToString('o')} | ConvertTo-Json))
    if(-not $produceResult){$fixtureTask.State='Running';return}
    $script:successfulCaptures++
    $png=[Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=')
    [IO.File]::WriteAllBytes((Join-Path $workspace ('captures\'+$request.nonce+'.png')),$png)
    [IO.File]::WriteAllText((Join-Path $workspace ('captures\'+$request.nonce+'.json')),(@{nonce=$request.nonce;ok=$true;width=1;height=1} | ConvertTo-Json))
}
function Stop-ScheduledTask {param($TaskName) $fixtureTask.State='Ready'}
function Disable-ScheduledTask {param($TaskName) $fixtureTask.State='Disabled'}
function Enable-ScheduledTask {param($TaskName) $fixtureTask.State='Ready'}
function Unregister-ScheduledTask {[CmdletBinding(SupportsShouldProcess=$true)]param($TaskName) $script:fixtureTask=$null}
function Run([string]$Operation){Invoke-SupportCapability -Operation $Operation -SessionId $id | ConvertFrom-Json}
try{
    New-Item -ItemType Directory -Path $runtime | Out-Null;Write-TestConfig
    Check ((Run inspect).state -eq 'not-installed') 'Fresh capability should not be ready'
    $ready=Run ensure
    Check ($ready.state -eq 'ready' -and $captureCount -eq 1) 'Ensure must perform a verification capture'
    $second=Run ensure
    Check ($registerCount -eq 1 -and $captureCount -eq 2) 'Repeated ensure must reuse installation and verify again'
    Check ($ready.file -ne $second.file) 'Fresh nonce must prevent stale screenshots'
    $history=Run inspect
    Check ($history.record.state -eq 'ready' -and $captureCount -eq 2) 'Inspect must be historical and not capture'
    $null=Run stop;Check ($fixtureTask.State -eq 'Disabled') 'Stop must disable its task'
    $null=Run capture;Check ($registerCount -eq 1) 'Resume must not register another task'
    $active=(Run inspect).record.activeProcess
    $fixtureLiveProcess=[pscustomobject]@{Name='notepad.exe';ProcessId=$active.pid;CommandLine='foreign process';CreationDate=[DateTimeOffset]$active.startedAt}
    Expect-Failure {Run stop} 'belongs to another process';Check ($killedProcesses -eq 0) 'A reused or foreign PID was killed'
    $fixtureLiveProcess.Name='powershell.exe';$fixtureLiveProcess.CommandLine='powershell.exe -File "'+(Join-Path $workspace 'Capture.ps1')+'"'
    $null=Run stop;Check ($killedProcesses -eq 1) 'Owned helper process was not stopped'
    $fixtureLiveProcess=$null
    $adminAllowed=$false;Expect-Failure {Run ensure} 'administrator SSH account';$adminAllowed=$true
    $produceResult=$false
    Expect-Failure {Run capture} 'timed out'
    Check ((Run inspect).record.state -eq 'unknown') 'Timeout must not report ready'
    $attempts=$captureCount;Expect-Failure {Run ensure} 'already in progress';Check ($captureCount -eq $attempts) 'Unknown capture was replayed automatically'
    $produceResult=$true;$fixtureTask.State='Ready'
    $originalViewer=$viewerName;$viewerName='changed-user'
    Expect-Failure {Run ensure} 'Desktop user changed';$viewerName=$originalViewer
    $originalArguments=$fixtureTask.Actions[0].Arguments;$fixtureTask.Actions[0].Arguments='foreign task'
    Expect-Failure {Run cleanup} 'Task was changed';$fixtureTask.Actions[0].Arguments=$originalArguments
    $fixtureTask.State='Running';Expect-Failure {Run capture} 'already in progress';$fixtureTask.State='Ready'
    [IO.File]::WriteAllText((Join-Path $workspace 'user-note.txt'),'User-owned note must survive')
    Add-Content (Join-Path $workspace 'Capture.ps1') '# user modification'
    Expect-Failure {Run capture} 'file was changed'
    $clean=Run cleanup
    Check ($clean.state -eq 'cleanup-incomplete') 'Modified helper must be retained and reported'
    Check (Test-Path (Join-Path $workspace 'Capture.ps1')) 'Modified helper was removed'
    Check (Test-Path (Join-Path $workspace 'user-note.txt')) 'Unknown file was removed'
    Check (@(Get-ChildItem (Join-Path $workspace 'captures') -Filter *.png).Count -eq $successfulCaptures) 'Diagnostic artifacts must be retained'
    Check (-not (Test-Path (Join-Path $workspace 'Run.vbs')) -and -not $fixtureTask) 'Owned unmodified resources must be removed'
    $testConfig.authorization.capabilities=@('command');Write-TestConfig
    Expect-Failure {Run ensure} 'outside the declared'
    $testConfig.authorization.capabilities=@('screenshot');$testConfig.expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');Write-TestConfig
    Expect-Failure {Run capture} 'expired or stopped'
    $null=Run cleanup
    'PASS screenshot lifecycle: verification/reuse, fresh requests, stop/resume, scope/expiry, changed ownership refusal and artifact retention'
}finally{
    $env:ProgramData=$savedProgramData
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.Path]::GetFileName($resolved) -notlike 'support-capability-test-*'){throw 'Unsafe test cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
