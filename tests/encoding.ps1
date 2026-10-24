#requires -Version 5.1
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -ne 5){throw 'Run this test with Windows PowerShell 5.1 (powershell.exe)'}
$target=Join-Path $PSScriptRoot '..\target'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('support-encoding-test-'+[Guid]::NewGuid().ToString('N'))
$utf8=New-Object Text.UTF8Encoding($false)
$utf8Bom=New-Object Text.UTF8Encoding($true)
$sentinel='SUPPORT_TEST_SECRET_'+[Guid]::NewGuid().ToString('N')
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Expect-SafeFailure([scriptblock]$Action,[string]$Name){
    $failure=$null
    try{& $Action | Out-Null}catch{$failure=$_}
    Check ($null -ne $failure) ($Name+' did not reject invalid JSON')
    $printed=$failure | Out-String
    Check ($printed -match 'SUPPORT_JSON_INVALID') ($Name+' did not return its stable error code')
    Check (-not $printed.Contains($sentinel)) ($Name+' leaked the sentinel in its error record')
    Check (-not $failure.Exception.ToString().Contains($sentinel)) ($Name+' leaked the sentinel in its exception')
}
function Run-CopiedScript([string]$Name,[string]$Fixture){
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $Fixture $Name)+'"'
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true
    $start.RedirectStandardError=$true
    $start.StandardOutputEncoding=[Text.Encoding]::UTF8
    $start.StandardErrorEncoding=[Text.Encoding]::UTF8
    $start.EnvironmentVariables['ProgramData']=Join-Path $Fixture 'fake-program-data'
    $process=New-Object Diagnostics.Process
    $process.StartInfo=$start
    try{
        [void]$process.Start()
        $stdout=$process.StandardOutput.ReadToEndAsync()
        $stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(30000)){$process.Kill();throw ($Name+' did not fail before side effects')}
        $text=$stdout.Result+"`n"+$stderr.Result
        Check (-not $text.Contains($sentinel)) ($Name+' leaked the sentinel to stdout/stderr')
        $runnerLog=Join-Path $Fixture 'runner-error.log'
        if(Test-Path -LiteralPath $runnerLog){
            $log=[IO.File]::ReadAllText($runnerLog,[Text.Encoding]::UTF8)
            Check (-not $log.Contains($sentinel)) ($Name+' leaked the sentinel to runner-error.log')
            $text+="`n"+$log
        }
        Check ($text -match 'SUPPORT_JSON_INVALID') ($Name+' did not report safe JSON rejection')
        if($Name -ne 'Run-Support.ps1'){Check ($process.ExitCode -ne 0) ($Name+' unexpectedly succeeded')}
        Check (-not (Test-Path -LiteralPath (Join-Path $Fixture 'fake-program-data'))) ($Name+' touched a runtime directory before rejecting JSON')
        Check (-not (Test-Path -LiteralPath (Join-Path $Fixture 'captures'))) ($Name+' touched capture output before rejecting JSON')
    }finally{$process.Dispose()}
}
try{
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    . (Join-Path $target 'Read-SupportJson.ps1')
    # Actual Chinese strings and a literal apostrophe, with an ASCII test source.
    $directory=Join-Path $testRoot (([string][char]0x8BFE)+[char]0x5802+"'s files")
    New-Item -ItemType Directory -Path $directory | Out-Null
    $label=([string][char]0x6280)+[char]0x672F+[char]0x534F+[char]0x52A9+[char]0x8005
    $json=@{operatorLabel=$label;runtimeRoot=$directory;id='0123456789abcdef'} | ConvertTo-Json -Compress
    foreach($encoding in @(@{Name='no-bom';Value=$utf8},@{Name='bom';Value=$utf8Bom})){
        $file=Join-Path $directory ($encoding.Name+'.json')
        [IO.File]::WriteAllText($file,$json,$encoding.Value)
        $value=Read-SupportJson -Path $file
        Check ($value.operatorLabel -ceq $label) ($encoding.Name+' changed the Chinese operator label')
        Check ($value.runtimeRoot -ceq $directory) ($encoding.Name+' changed the Chinese/apostrophe path')
    }
    $parsed=ConvertFrom-SupportJson -Text $json
    Check ($parsed.operatorLabel -ceq $label) 'In-memory JSON changed the operator label'
    $bad='{"webToken":"'+$sentinel+'","operatorLabel":"'+[char]0x4E01+'" INVALID'
    $badFile=Join-Path $directory 'bad.json'
    [IO.File]::WriteAllText($badFile,$bad,$utf8)
    Expect-SafeFailure {Read-SupportJson -Path $badFile} 'UTF8 malformed file'
    Expect-SafeFailure {ConvertFrom-SupportJson -Text $bad} 'Malformed JSON text'
    $invalidUtf8=Join-Path $directory 'invalid-utf8.json'
    [IO.File]::WriteAllBytes($invalidUtf8,[byte[]]@(123,34,120,34,58,34,255,34,125))
    Expect-SafeFailure {Read-SupportJson -Path $invalidUtf8} 'Invalid UTF8 bytes'
    if([Text.Encoding]::Default.CodePage -eq 936){
        $repro=Join-Path $directory 'cp936-repro.json'
        $reproText='{"operatorLabel":"'+[char]0x4E01+'"}'
        [IO.File]::WriteAllText($repro,$reproText,$utf8)
        $failed=$false
        try{$null=Get-Content -LiteralPath $repro -Raw | ConvertFrom-Json -ErrorAction Stop}catch{$failed=$true}
        Check $failed 'CP936 default Get-Content no longer reproduces the BOMless JSON failure'
        Check ((Read-SupportJson -Path $repro).operatorLabel -ceq ([string][char]0x4E01)) 'Safe reader failed the same CP936 reproduction file'
        'PASS reproduced CP936 default-read failure on the same BOMless UTF8 file that the safe reader accepts'
    }else{'SKIP CP936 default-read reproduction: this host uses ACP '+[Text.Encoding]::Default.CodePage}
    foreach($name in @('Bootstrap.ps1','Run-Support.ps1','Stop-Support.ps1','Diagnose-Support.ps1','Capture.ps1')){
        $fixture=Join-Path $directory ([IO.Path]::GetFileNameWithoutExtension($name))
        New-Item -ItemType Directory -Path $fixture | Out-Null
        $source=if($name -eq 'Capture.ps1'){Join-Path $target 'capabilities\screenshot\Capture.ps1'}else{Join-Path $target $name}
        Copy-Item -LiteralPath $source -Destination (Join-Path $fixture $name)
        foreach($helper in @('Read-SupportJson.ps1','Read-SupportLog.ps1')){Copy-Item -LiteralPath (Join-Path $target $helper) -Destination (Join-Path $fixture $helper)}
        $configName=if($name -eq 'Capture.ps1'){'request.json'}else{'session.json'}
        [IO.File]::WriteAllText((Join-Path $fixture $configName),$bad,$utf8)
        Run-CopiedScript -Name $name -Fixture $fixture
    }
    'PASS Windows PowerShell 5 UTF8 BOM/no-BOM and Chinese/apostrophe path round trips; malformed/invalid-UTF8 rejection; five actual copied scripts fail without secret output or runtime/capture side effects'
}finally{
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if([IO.Path]::GetDirectoryName($resolved) -ne $temporary -or [IO.Path]::GetFileName($resolved) -notmatch '^support-encoding-test-[a-f0-9]{32}$'){throw 'Unsafe encoding test cleanup path'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
