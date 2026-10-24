$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\target\capabilities\screenshot\Capture.ps1'),[ref]$tokens,[ref]$errors)
if($errors){throw ($errors | Out-String)}
$command=$ast.Find({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' -and $node.Extent.Text -match '-TypeDefinition'},$true)
$definition=$command.CommandElements | Where-Object {$_ -is [System.Management.Automation.Language.StringConstantExpressionAst]} | Select-Object -Last 1
if(-not $definition){throw 'Missing native capture implementation'}
Add-Type -TypeDefinition $definition.Value
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
# Compile and exercise only off-screen bitmap encoding; no desktop is read.
$image=New-Object Drawing.Bitmap 1,1
$stream=New-Object IO.MemoryStream
try{
    $image.SetPixel(0,0,[Drawing.Color]::Black)
    $image.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
    if([BitConverter]::ToString($stream.ToArray(),0,8) -ne '89-50-4E-47-0D-0A-1A-0A'){throw 'PNG backend is unavailable'}
    'PASS capture native code compilation and off-screen PNG encoding; no real screen capture performed'
}finally{$stream.Dispose();$image.Dispose()}
