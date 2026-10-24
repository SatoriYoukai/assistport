#requires -Version 5.1
function Grant-SupportSshReadAccess {
    param([Parameter(Mandatory=$true)][string]$Root)
    # SYSTEM launches sshd-auth under an unprivileged virtual account. That
    # process must load the portable executables/DLLs, but must not read the
    # parent session directory's configuration or private keys.
    $portable=[IO.Path]::GetFullPath((Join-Path $Root 'openssh'))
    $directory=Get-Item -LiteralPath $portable -Force -ErrorAction Stop
    if(-not $directory.PSIsContainer){throw 'Portable SSH application path is not a directory'}
    $ancestor=$directory
    while($ancestor){
        if($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Portable SSH ACL setup refuses reparse points'}
        $ancestor=$ancestor.Parent
    }
    # Check the complete tree before changing any ACL. Walk one level at a
    # time so a junction cannot redirect recursive enumeration outside openssh.
    $entries=New-Object 'Collections.Generic.List[IO.FileSystemInfo]'
    $pending=New-Object 'Collections.Generic.Stack[IO.DirectoryInfo]'
    $entries.Add($directory);$pending.Push($directory)
    while($pending.Count){
        foreach($entry in Get-ChildItem -LiteralPath $pending.Pop().FullName -Force -ErrorAction Stop){
            if(-not $entry.FullName.StartsWith($portable+'\',[StringComparison]::OrdinalIgnoreCase) -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Portable SSH ACL setup refuses redirected paths'}
            $entries.Add($entry)
            if($entry.PSIsContainer){$pending.Push($entry)}
        }
    }
    $authenticated=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')
    foreach($entry in $entries){
        $inheritance=if($entry -is [IO.DirectoryInfo]){'ContainerInherit,ObjectInherit'}else{'None'}
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($authenticated,'ReadAndExecute',$inheritance,'None','Allow')
        $acl=$entry.GetAccessControl()
        $acl.SetAccessRule($rule)
        $entry.SetAccessControl($acl)
    }
}
function Get-SupportSsh {
    param([Parameter(Mandatory=$true)][string]$Root, [string]$ManifestSha256)
    $portable=Join-Path $Root 'openssh'
    if(Test-Path -LiteralPath $portable){
        $manifestFile=Join-Path $portable 'manifest.json'
        if($ManifestSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ManifestSha256){throw 'Portable SSH manifest integrity check failed'}
        $manifest=Read-SupportJson -Path $manifestFile
        $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach($entry in $manifest.files){
            if($entry.name -notmatch '^[a-zA-Z0-9_.-]+$' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or -not $names.Add($entry.name)){throw 'Invalid portable SSH manifest entry'}
            $file=Join-Path $portable $entry.name
            if((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Portable SSH refuses reparse points'}
            if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('Portable SSH file integrity check failed: '+$entry.name)}
            if([IO.Path]::GetExtension($entry.name) -in @('.exe','.dll')){
                $signature=Get-AuthenticodeSignature -LiteralPath $file
                if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw ('Portable SSH publisher verification failed: '+$entry.name)}
            }
        }
        foreach($required in @('sshd.exe','sshd-auth.exe','sshd-session.exe','ssh-shellhost.exe','ssh-keygen.exe','sftp-server.exe','libcrypto.dll','LICENSE.txt','NOTICE.txt')){if(-not $names.Contains($required)){throw ('Portable SSH is incomplete: '+$required)}}
        return [pscustomobject]@{Daemon=(Join-Path $portable 'sshd.exe');Keygen=(Join-Path $portable 'ssh-keygen.exe');Sftp=(Join-Path $portable 'sftp-server.exe');Portable=$true;Available=$true}
    }
    $system=Join-Path $env:WINDIR 'System32\OpenSSH'
    return [pscustomobject]@{Daemon=(Join-Path $system 'sshd.exe');Keygen=(Join-Path $system 'ssh-keygen.exe');Sftp=(Join-Path $system 'sftp-server.exe');Portable=$false;Available=(Test-Path -LiteralPath (Join-Path $system 'sshd.exe'))}
}
