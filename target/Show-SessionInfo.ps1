#requires -Version 5.1
[CmdletBinding()]
param([string]$PreviewPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$root=$PSScriptRoot
function Read-Info {
    $stream=[IO.File]::Open((Join-Path $root 'info.json'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
    try { $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'SUPPORT_JSON_INVALID: Could not read session information.' }
    finally { $reader.Dispose() }
}
if($PreviewPath){
    $info=[pscustomobject]@{id='0123456789abcdef';operatorLabel='技术协助者';targetUser='local-user';expiresAt=([DateTimeOffset]::Now.AddHours(4)).ToString('o');state='started';authorization=@{profile='full'}}
}else{
    $info=Read-Info
    $expected=Join-Path $env:ProgramData ('CodexTemporarySupport\'+$info.id)
    if($info.id -notmatch '^[a-f0-9]{16}$' -or -not [IO.Path]::GetFullPath($root).Equals([IO.Path]::GetFullPath($expected),[StringComparison]::OrdinalIgnoreCase)){throw 'Session information path mismatch'}
}
[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="临时协助" Width="760" Height="610" MinWidth="640" MinHeight="550" Background="#0D141E" Foreground="#ECF2FA" FontFamily="Microsoft YaHei UI" WindowStartupLocation="CenterScreen">
<Grid Margin="32"><Grid.RowDefinitions><RowDefinition Height="90"/><RowDefinition Height="*"/><RowDefinition Height="86"/></Grid.RowDefinitions>
<StackPanel><TextBlock Text="TEMPORARY SUPPORT // SESSION" Foreground="#60DCC1" FontFamily="Consolas" FontSize="13"/><TextBlock Name="Heading" Text="临时协助已启动" FontSize="28" FontWeight="SemiBold" Margin="0,12,0,0"/></StackPanel>
<StackPanel Grid.Row="1">
<Border Background="#162231" CornerRadius="8" Padding="20"><StackPanel><TextBlock Name="Operator" FontSize="19"/><TextBlock Name="Account" Foreground="#A8B7C9" Margin="0,10,0,0"/><TextBlock Name="Expiry" Foreground="#A8B7C9" Margin="0,8,0,0"/><TextBlock Name="Session" FontFamily="Consolas" Foreground="#A8B7C9" Margin="0,8,0,0"/></StackPanel></Border>
<TextBlock Name="Scope" FontSize="18" Margin="0,22,0,8"/>
<TextBlock Text="协助者可在本次范围内按需启用工具。授权仅在本次会话内有效；临时工具由协助者负责清理。" Foreground="#A8B7C9" TextWrapping="Wrap"/>
<TextBlock Name="State" Foreground="#60DCC1" TextWrapping="Wrap" Margin="0,16,0,0"/>
<TextBlock Text="远程操作按授权账户的权限执行。请只将接入包交给可信的协助者。" Foreground="#FFCD7C" TextWrapping="Wrap" Margin="0,12,0,0"/>
</StackPanel>
<Grid Grid.Row="2"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="140"/><ColumnDefinition Width="140"/></Grid.ColumnDefinitions><TextBlock Text="关闭窗口不结束协助。&#10;协助者名称由接入包提供。" Foreground="#A8B7C9" VerticalAlignment="Center" TextWrapping="Wrap"/><Button Name="CloseButton" Grid.Column="1" Content="关闭窗口" Margin="0,18,12,18"/><Button Name="StopButton" Grid.Column="2" Content="停止协助" Background="#60DCC1" Foreground="#0D141E" FontWeight="SemiBold" Margin="0,18,0,18"/></Grid>
</Grid></Window>
'@
if($PreviewPath){
    $controlXml=$xaml.OuterXml.Replace('<Window ','<UserControl ').Replace('</Window>','</UserControl>')
    $controlXml=$controlXml -replace ' Title="[^"]*"','' -replace ' WindowStartupLocation="[^"]*"',''
    $window=[Windows.Markup.XamlReader]::Parse($controlXml)
}else{$window=[Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))}
$window.FindName('Operator').Text='协助者：'+$info.operatorLabel
$window.FindName('Account').Text='授权账户：'+$info.targetUser
$window.FindName('Expiry').Text='到期时间：'+([DateTimeOffset]$info.expiresAt).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
$window.FindName('Session').Text='SESSION / '+$info.id
$window.FindName('Scope').Text=if($info.authorization.profile -eq 'full'){'完整协助：命令 · 文件 · 截图 · 桌面操作'}else{'旧版会话：授权范围未声明'}
$window.FindName('State').Text='接入环境已启动；须由协助者验证真实命令。截图与桌面能力按需部署。'
if($PreviewPath){
    $window.FindName('StopButton').IsEnabled=$false
    $window.Measure((New-Object Windows.Size(760,610)));$window.Arrange((New-Object Windows.Rect(0,0,760,610)));$window.UpdateLayout()
    $bitmap=New-Object Windows.Media.Imaging.RenderTargetBitmap(760,610,96,96,[Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($window)
    $encoder=New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $output=[IO.File]::Create([IO.Path]::GetFullPath($PreviewPath));try{$encoder.Save($output)}finally{$output.Dispose()}
    return
}
$stop=$window.FindName('StopButton');$state=$window.FindName('State')
$window.FindName('CloseButton').Add_Click({$window.Close()})
$stop.Add_Click({
    $stop.IsEnabled=$false
    try {
        $script=Join-Path $root 'Stop-Support.ps1'
        $process=Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$script+'"') -Verb RunAs -WindowStyle Hidden -PassThru -Wait
        if($process.ExitCode -ne 0){throw '停止未完成，请使用接入包中的 Stop-Support.ps1。'}
        $state.Text='协助已停止。收到的 ZIP 和解压目录需要另外删除。'
        $window.FindName('Heading').Text='临时协助已结束'
    }catch{$state.Text='停止未完成：'+$_.Exception.Message;$stop.IsEnabled=$true}
})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromSeconds(2)
$timer.Add_Tick({
    if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]$info.expiresAt){$state.Text='授权已到期；清理由到期任务执行。';$stop.IsEnabled=$true}
    try {if((Read-Info).state -eq 'stopped'){$state.Text='协助已停止。';$stop.IsEnabled=$false;$window.FindName('Heading').Text='临时协助已结束'}}catch{}
})
$timer.Start();try{[void]$window.ShowDialog()}finally{$timer.Stop()}
