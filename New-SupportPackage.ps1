#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'CodexTemporarySupportController'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'packages'),
    [ValidateSet('websocket','tcp')][string]$Transport = 'websocket',
    [string]$Endpoint,
    [string]$ReceiverHost,
    [ValidateRange(1024,65535)][int]$ReceiverPort = 22222,
    [ValidateRange(1024,65535)][int]$ReversePort = 23022,
    [ValidateRange(1024,65535)][int]$TargetPort = 22022,
    [ValidateRange(1,24)][int]$Hours = 4,
    [ValidateSet('full')][string]$Scope = 'full',
    [ValidateLength(1,80)][string]$OperatorLabel = 'Support operator',
    [string]$NodePath,
    [string]$OpenSshDirectory
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'target\Read-SupportJson.ps1')
# Node emits UTF-8. Windows PowerShell otherwise decodes native stdout with the
# console codepage, independently of Get-Content's ANSI default.
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
if (-not $NodePath) { $NodePath=(Get-Command node.exe -ErrorAction Stop).Source }
$StateDirectory=[IO.Path]::GetFullPath($StateDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $StateDirectory 'receiver_host_key'))) { throw 'Start the receiver first so the state directory is protected.' }
if ($Transport -eq 'websocket' -and -not $Endpoint) {
    $instance=Read-SupportJson -Path (Join-Path $StateDirectory 'receiver-processes.json')
    $Endpoint=$instance.endpoint
    if (-not $Endpoint) { throw 'Supply the HTTPS endpoint for the named Tunnel, or start a Quick Tunnel.' }
}
$id=[Guid]::NewGuid().ToString('N').Substring(0,16)
$stage=Join-Path $StateDirectory ('staging\' + $id)
$arguments=@((Join-Path $PSScriptRoot 'new-session.js'), '--state',$StateDirectory,'--id',$id,'--bundle',$stage,'--transport',$Transport,'--reverse-port',"$ReversePort",'--target-port',"$TargetPort",'--hours',"$Hours",'--node',$NodePath)
$arguments+=@('--scope',$Scope,'--operator',$OperatorLabel)
if($OpenSshDirectory){$arguments+=@('--openssh',[IO.Path]::GetFullPath($OpenSshDirectory))}
if ($Transport -eq 'websocket') { $arguments+=@('--endpoint',$Endpoint) } else { $arguments+=@('--host',$ReceiverHost,'--port',"$ReceiverPort") }
$json=& $NodePath @arguments
if ($LASTEXITCODE -ne 0) {
    $failedSession=Join-Path $StateDirectory ('sessions\' + $id + '\session.json')
    if (Test-Path -LiteralPath $failedSession) {
        $failed=Read-SupportJson -Path $failedSession
        $failed.revoked=$true
        [IO.File]::WriteAllText($failedSession,($failed | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
    }
    throw 'Session generation failed; any partial session was revoked.'
}
$result=ConvertFrom-SupportJson -Text ($json -join "`n")
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$zip=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ("Target-Support-$id.zip")
try {
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
    # Validate the DELIVERABLE, after extraction, using the target's actual PS5
    # entrypoint. CheckOnly never installs components or starts support tasks.
    $validationBase=[IO.Path]::GetFullPath((Join-Path $StateDirectory 'validation'))
    $validationRoot=[IO.Path]::GetFullPath((Join-Path $validationBase $id))
    if([IO.Path]::GetDirectoryName($validationRoot) -ne $validationBase -or [IO.Path]::GetFileName($validationRoot) -ne $id){throw 'Unsafe package validation path'}
    try {
        Expand-Archive -LiteralPath $zip -DestinationPath $validationRoot
        $winps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $preflightStart=New-Object Diagnostics.ProcessStartInfo
        $preflightStart.FileName=$winps
        $preflightStart.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $validationRoot 'Bootstrap.ps1')+'" -CheckOnly -User package-preflight'
        $preflightStart.UseShellExecute=$false
        $preflightStart.CreateNoWindow=$true
        $preflightStart.RedirectStandardOutput=$true
        $preflightStart.RedirectStandardError=$true
        $preflightStart.StandardOutputEncoding=[Text.Encoding]::UTF8
        $preflightStart.StandardErrorEncoding=[Text.Encoding]::Default
        # The packaging process may have inherited PowerShell 7's module path.
        # Validate the target with Windows PowerShell's own built-in modules;
        # otherwise Utility/Security can resolve to incompatible PS7 modules.
        $preflightStart.EnvironmentVariables['PSModulePath']=Join-Path (Split-Path -Parent $winps) 'Modules'
        $preflightProcess=New-Object Diagnostics.Process
        $preflightProcess.StartInfo=$preflightStart
        try{
            [void]$preflightProcess.Start()
            $preflightOutput=$preflightProcess.StandardOutput.ReadToEndAsync()
            $preflightError=$preflightProcess.StandardError.ReadToEndAsync()
            if(-not $preflightProcess.WaitForExit(60000)){$preflightProcess.Kill();throw 'Final ZIP Windows PowerShell 5.1 preflight timed out; no package is ready for handoff'}
            $preflight=$preflightOutput.Result
            $preflightDiagnostic=$preflightError.Result
            if($preflightProcess.ExitCode -ne 0){
                # Keep stderr private. Future validation errors must not echo
                # configuration contents through a packaging failure either.
                $reason='process exited with code '+$preflightProcess.ExitCode
                foreach($known in @('SUPPORT_JSON_INVALID','Bundled Node runtime hash mismatch','Node runtime signature is not valid','This package requires 64-bit Windows and 64-bit PowerShell','This support package has expired','Invalid support package')){
                    if($preflightDiagnostic.Contains($known)){$reason=$known;break}
                }
                throw ('Final ZIP failed Windows PowerShell 5.1 preflight ('+$reason+'); no package is ready for handoff')
            }
        }finally{$preflightProcess.Dispose()}
        $checked=ConvertFrom-SupportJson -Text $preflight
        if($checked.Session -ne $id -or $checked.RuntimeVerified -ne $true){throw 'Final ZIP preflight did not verify this session'}
    } finally {
        if(Test-Path -LiteralPath $validationRoot){
            $resolved=(Get-Item -LiteralPath $validationRoot).FullName
            if($resolved -ne $validationRoot -or [IO.Path]::GetDirectoryName($resolved) -ne $validationBase){throw 'Unsafe validation cleanup path'}
            Remove-Item -LiteralPath $validationRoot -Recurse -Force
        }
    }
}
catch {
    & $NodePath (Join-Path $PSScriptRoot 'operator.js') revoke --session $result.controllerSession | Out-Null
    throw
}
[pscustomobject]@{Session=$id; TargetZIP=$zip; ControllerSession=$result.controllerSession; ExpiresAt=$result.expiresAt; Transport=$Transport; PackageValidation='final-zip-windows-powershell-5.1-checkonly'} | ConvertTo-Json
