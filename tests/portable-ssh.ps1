#requires -Version 5.1
$ErrorActionPreference='Stop'
if(-not $env:SUPPORT_OPENSSH_DIRECTORY){'SKIP native portable SSH artifact checks: set SUPPORT_OPENSSH_DIRECTORY to a reviewed distribution';return}
. (Join-Path $PSScriptRoot '..\target\Read-SupportJson.ps1')
. (Join-Path $PSScriptRoot '..\target\Read-SupportSsh.ps1')
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('support-portable-test-'+[Guid]::NewGuid().ToString('N'))
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Reject([scriptblock]$Action){$failed=$false;try{& $Action | Out-Null}catch{$failed=$true};Check $failed 'Portable SSH validation unexpectedly accepted modified or missing files'}
try{
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Copy-Item -LiteralPath $env:SUPPORT_OPENSSH_DIRECTORY -Destination (Join-Path $testRoot 'openssh') -Recurse
    $private=Join-Path $testRoot 'fixture-private-key'
    [IO.File]::WriteAllText($private,'Not a real key; the ACL must remain private')
    $parentAcl=(Get-Acl -LiteralPath $testRoot).Sddl
    $privateAcl=(Get-Acl -LiteralPath $private).Sddl
    $applicationAcl=(Get-Acl -LiteralPath (Join-Path $testRoot 'openssh\sshd-auth.exe')).Sddl
    $file=Join-Path $testRoot 'openssh\manifest.json'
    $digest=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $resolved=Get-SupportSsh -Root $testRoot -ManifestSha256 $digest
    Check ($resolved.Portable -and $resolved.Available) 'Portable backend was not selected'
    Check ($resolved.Daemon -eq (Join-Path $testRoot 'openssh\sshd.exe')) 'Portable daemon escaped its runtime'
    Check ((Get-Acl -LiteralPath (Join-Path $testRoot 'openssh\sshd-auth.exe')).Sddl -ceq $applicationAcl) 'Portable validation must not change ACLs'
    # Exercise real filesystem ACLs, without a SYSTEM process or SSH service.
    # Inspect only the added AU rules; development sandbox SIDs are unrelated.
    $nested=Join-Path $testRoot 'openssh\fixture-subdirectory'
    New-Item -ItemType Directory -Path $nested | Out-Null
    $nestedBinary=Join-Path $nested 'fixture.dll'
    [IO.File]::WriteAllText($nestedBinary,'ACL fixture, not an executable')
    $systemAdminBefore=@((Get-Acl -LiteralPath (Join-Path $testRoot 'openssh\sshd-auth.exe')).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -in @('S-1-5-18','S-1-5-32-544')} | ForEach-Object {$_.IdentityReference.Value+':'+[int]$_.FileSystemRights+':'+$_.AccessControlType})
    Grant-SupportSshReadAccess -Root $testRoot
    $required=[int][Security.AccessControl.FileSystemRights]::ReadAndExecute
    $allowed=$required -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
    foreach($entry in @((Join-Path $testRoot 'openssh'),(Join-Path $testRoot 'openssh\sshd-auth.exe'),(Join-Path $testRoot 'openssh\libcrypto.dll'),$nested,$nestedBinary)){
        $rules=@((Get-Acl -LiteralPath $entry).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -eq 'S-1-5-11' -and $_.AccessControlType -eq 'Allow'})
        Check ($rules.Count -gt 0) 'Portable application path has no Authenticated Users access'
        foreach($rule in $rules){
            $rights=[int]$rule.FileSystemRights
            Check (($rights -band $required) -eq $required -and ($rights -band (-bnot $allowed)) -eq 0) 'Portable application AU rule exceeds or lacks ReadAndExecute'
        }
    }
    $directoryRules=@((Get-Acl -LiteralPath (Join-Path $testRoot 'openssh')).GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -eq 'S-1-5-11' -and $_.AccessControlType -eq 'Allow'})
    Check (@($directoryRules | Where-Object {($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -and ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit)}).Count -gt 0) 'Portable application directory AU rule is not inheritable'
    $systemAdminAfter=@((Get-Acl -LiteralPath (Join-Path $testRoot 'openssh\sshd-auth.exe')).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -in @('S-1-5-18','S-1-5-32-544')} | ForEach-Object {$_.IdentityReference.Value+':'+[int]$_.FileSystemRights+':'+$_.AccessControlType})
    Check (($systemAdminBefore -join ',') -ceq ($systemAdminAfter -join ',')) 'Portable application SYSTEM/Admins access changed'
    Check ((Get-Acl -LiteralPath $testRoot).Sddl -ceq $parentAcl) 'Portable application permission setup changed its parent directory'
    Check ((Get-Acl -LiteralPath $private).Sddl -ceq $privateAcl) 'Portable application permission setup changed a private sibling file'
    $binary=Join-Path $testRoot 'openssh\sshd.exe'
    $original=[IO.File]::ReadAllBytes($binary)
    [IO.File]::AppendAllText($binary,'modified')
    Reject {Get-SupportSsh -Root $testRoot -ManifestSha256 $digest}
    [IO.File]::WriteAllBytes($binary,$original)
    Reject {Get-SupportSsh -Root $testRoot -ManifestSha256 ('0'*64)}
    Remove-Item -LiteralPath $binary -Force
    Reject {Get-SupportSsh -Root $testRoot -ManifestSha256 $digest}
    'PASS portable SSH selection, pinned manifest, real Microsoft signatures, hash tampering and missing-file rejection; real AU ReadAndExecute ACLs confined to openssh descendants, parent/private sibling unchanged; no SYSTEM process, installation or service changes'
}finally{
    $resolvedPath=[IO.Path]::GetFullPath($testRoot)
    if([IO.Path]::GetDirectoryName($resolvedPath) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.Path]::GetFileName($resolvedPath) -notmatch '^support-portable-test-[a-f0-9]{32}$'){throw 'Unsafe portable test cleanup path'}
    if(Test-Path -LiteralPath $resolvedPath){Remove-Item -LiteralPath $resolvedPath -Recurse -Force}
}
