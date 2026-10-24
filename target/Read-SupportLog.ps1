#requires -Version 5.1
function Read-SupportLog {
    param([Parameter(Mandatory=$true)][string]$Path,[ValidateRange(1,200)][int]$Lines=20)
    $stream=$null; $reader=$null
    try {
        $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
        # Bound diagnostics to the trailing 128 KiB, even for large logs.
        $skip=$stream.Length -gt 131072
        if($skip){[void]$stream.Seek(-131072,[IO.SeekOrigin]::End)}
        $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
        if($skip){[void]$reader.ReadLine()}
        $reader.ReadToEnd() -split '\r?\n' | Where-Object {$_ -ne ''} | Select-Object -Last $Lines
    } catch { Write-Warning ('Log unavailable: '+[IO.Path]::GetFileName($Path)+'. Diagnostic failure does not stop repair.') }
    finally {if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}}
}
