#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('status','probe','exec','upload','download','revoke','capability','tool')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Session,
    [string]$Command, [string]$File, [string]$Local, [string]$Remote,
    [ValidateSet('screenshot')][string]$Capability,
    [ValidateSet('ensure','inspect','capture','stop','cleanup','register')][string]$Operation,
    [ValidateRange(1,3600)][int]$Timeout=120,
    [string]$NodePath
)
$ErrorActionPreference='Stop'
if (-not $NodePath) { $NodePath=(Get-Command node.exe -ErrorAction Stop).Source }
$arguments=@((Join-Path $PSScriptRoot 'operator.js'),$Action,'--session',[IO.Path]::GetFullPath($Session),'--timeout',"$Timeout")
if ($PSBoundParameters.ContainsKey('Command')) { $arguments+=@('--command',$Command) }
if ($File) { $arguments+=@('--file',[IO.Path]::GetFullPath($File)) }
if ($Local) { $arguments+=@('--local',[IO.Path]::GetFullPath($Local)) }
if ($Remote) { $arguments+=@('--remote',$Remote) }
if ($Capability) { $arguments+=@('--capability',$Capability) }
if ($Operation) { $arguments+=@('--operation',$Operation) }
& $NodePath @arguments
if ($LASTEXITCODE -ne 0) { throw 'Support operation failed or returned a non-zero exit code. See the result above.' }
