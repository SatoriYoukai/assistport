#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('ensure','inspect','capture','stop','cleanup')][string]$Operation,
      [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{16}$')][string]$SessionId,
      [ValidateSet('screenshot')][string]$Capability='screenshot')
. (Join-Path $PSScriptRoot 'Capability.Core.ps1')
Invoke-SupportCapability -Operation $Operation -SessionId $SessionId -Capability $Capability
