#requires -Version 5.1
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
# This helper is self-contained: the desktop viewer cannot read private runtime
# scripts, and only Capture.ps1/Run.vbs are deployed into its workspace.
function Read-CaptureJson([string]$Path){
    try{ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path,(New-Object Text.UTF8Encoding($false,$true)))) -ErrorAction Stop}
    catch{throw 'SUPPORT_JSON_INVALID: Could not read capture JSON. Configuration contents are withheld.'}
}
$request=Read-CaptureJson -Path (Join-Path $root 'request.json')
if($request.nonce -notmatch '^[a-f0-9]{32}$'){throw 'Invalid capture request'}
$output=Join-Path $root ('captures\'+$request.nonce+'.png')
$resultFile=Join-Path $root ('captures\'+$request.nonce+'.json')
$result=@{nonce=$request.nonce;ok=$false;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
try {
    $lease=Read-CaptureJson -Path (Join-Path $root 'lease.json')
    if([DateTimeOffset]$lease.expiresAt -le [DateTimeOffset]::UtcNow){throw 'Session expired'}
    if(Test-Path -LiteralPath (Join-Path $lease.runtimeRoot 'STOP')){throw 'Session stopped'}
    $process=Get-Process -Id $PID
    [IO.File]::WriteAllText((Join-Path $root ('captures\'+$request.nonce+'.running.json')),(@{nonce=$request.nonce;pid=$PID;startedAt=$process.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SupportCaptureDesktop {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint f, bool i, uint a);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr h, int n, StringBuilder b, uint l, out uint needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  public static string InputName() {
    IntPtr h=OpenInputDesktop(0,false,1);
    if(h==IntPtr.Zero) throw new InvalidOperationException("Input desktop unavailable: locked or secure desktop");
    try { uint n; var b=new StringBuilder(256); if(!GetUserObjectInformation(h,2,b,512,out n)) throw new InvalidOperationException("Cannot identify input desktop"); return b.ToString(); }
    finally { CloseDesktop(h); }
  }
}
'@
    $desktop=[SupportCaptureDesktop]::InputName()
    if($desktop -ine 'Default'){throw 'Locked or secure desktop is not supported'}
    [SupportCaptureDesktop]::SetProcessDPIAware() | Out-Null
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    $bounds=[Windows.Forms.SystemInformation]::VirtualScreen
    if($bounds.Width -le 0 -or $bounds.Height -le 0 -or ([long]$bounds.Width*$bounds.Height) -gt 64000000){throw 'Unsupported desktop dimensions'}
    $image=New-Object Drawing.Bitmap $bounds.Width,$bounds.Height
    $graphics=[Drawing.Graphics]::FromImage($image)
    try{$graphics.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size);$image.Save($output,[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$image.Dispose()}
    $result.ok=$true;$result.width=$bounds.Width;$result.height=$bounds.Height
    $result.desktop=$desktop;$result.desktopSessionId=(Get-Process -Id $PID).SessionId
}catch{$result.error=$_.Exception.Message}
[IO.File]::WriteAllText($resultFile,($result | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
if(-not $result.ok){exit 1}
