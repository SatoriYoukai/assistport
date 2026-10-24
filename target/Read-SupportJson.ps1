#requires -Version 5.1
# JSON crosses Node/Windows boundaries. Never depend on the system ANSI codepage
# and never propagate ConvertFrom-Json's exception, which embeds the input.
# A PS5 child can inherit a PS7 module search path. Prefer this host's built-in
# modules so Get-FileHash and signature checks resolve to compatible modules.
$builtinModules=Join-Path $PSHOME 'Modules'
if(-not $env:PSModulePath.StartsWith($builtinModules+[IO.Path]::PathSeparator,[StringComparison]::OrdinalIgnoreCase)){$env:PSModulePath=$builtinModules+[IO.Path]::PathSeparator+$env:PSModulePath}
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Global -ErrorAction Stop
function ConvertFrom-SupportJson {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text)
    try {
        if ([string]::IsNullOrWhiteSpace($Text)) { throw 'Empty JSON' }
        ConvertFrom-Json -InputObject $Text -ErrorAction Stop
    } catch {
        throw 'SUPPORT_JSON_INVALID: Could not parse support JSON. Configuration contents are withheld.'
    }
}
function Read-SupportJson {
    param([Parameter(Mandatory=$true)][string]$Path)
    try {
        $text = [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false, $true)))
        ConvertFrom-SupportJson -Text $text
    } catch {
        throw 'SUPPORT_JSON_INVALID: Could not read UTF-8 support JSON. Configuration contents are withheld.'
    }
}
