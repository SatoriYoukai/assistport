$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\target\Read-SupportLog.ps1')
$file=Join-Path ([IO.Path]::GetTempPath()) ('support-log-test-'+[Guid]::NewGuid().ToString('N')+'.log')
$stream=$null
try {
    [IO.File]::WriteAllText($file,"old`nfirst`nlast`n",(New-Object Text.UTF8Encoding($false)))
    $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
    $lines=@(Read-SupportLog -Path $file -Lines 2)
    if(($lines -join ',') -ne 'first,last'){throw 'Concurrent writer log read failed'}
    $stream.Dispose();$stream=$null
    $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $locked=@(Read-SupportLog -Path $file -WarningAction SilentlyContinue)
    if($locked.Count -ne 0){throw 'Exclusive lock should produce no diagnostic lines'}
    'PASS concurrent log writer and exclusive-lock diagnostics do not abort repair'
} finally {if($stream){$stream.Dispose()}; Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue}
