param([string]$Worker = "$PSScriptRoot\..\src-tauri\src\app\claude_desktop.ps1")
$ErrorActionPreference='Stop'
# Use a private test key, under the disposable guest's user hive only.
if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw 'Run inside Windows Sandbox' }
$source=[IO.File]::ReadAllText($Worker).Replace([Environment]::NewLine,[string][char]10)
$boundary=$source.IndexOf(('try {'+[char]10+'    $syncOnly'))
if ($boundary -lt 0) { throw 'Worker entry point missing' }
$env:CAM_CLAUDE_MEDIA=$env:TEMP
. ([scriptblock]::Create($source.Substring(0,$boundary)))
$id=[guid]::NewGuid().ToString('N')
$base=Join-Path $env:TEMP "ClaudeProtocolTest-$id"
[void][IO.Directory]::CreateDirectory($base)
$protocolClass="Software\ClaudeProtocolTest-$id\claude"
$cmdPath=$protocolClass+'\shell\open\command'
$userRoot=[Microsoft.Win32.Registry]::CurrentUser
$tempExe=Join-Path ([IO.Path]::GetTempPath()) ('CodexUsbClaude-'+$id+'\Claude.exe')
$registered='"'+$tempExe+'" -- "%1"'
function SetField($sub,$name,$data,$kind) {
    $k=$userRoot.CreateSubKey($sub)
    try { $k.SetValue($name,$data,$kind) } finally { $k.Dispose() }
}
function ReadField($sub,$name) {
    $k=$userRoot.OpenSubKey($sub)
    try { if ($k) { $k.GetValue($name,$null,'DoNotExpandEnvironmentNames') } } finally { if ($k) { $k.Dispose() } }
}
function Assert($ok,$case) { if (!$ok) { throw $case }; $case }
function ImitateTemporaryHandler {
    SetField $protocolClass '' 'URL:claude' String
    SetField $protocolClass 'URL Protocol' '' String
    SetField $cmdPath '' $registered String
}
$original='"%LOCALAPPDATA%\Original Desktop.exe" "%1"'
SetField $cmdPath '' $original ExpandString
SetField $protocolClass '' 'original' String
SetField ($protocolClass+'\DefaultIcon') '' 'original icon' String
SaveSeedProtocol $tempExe
ImitateTemporaryHandler
# No call from the original worker's finally. The next worker has only the
# registry value and the persisted snapshot.
RestoreSeedProtocol
Assert ((ReadField $cmdPath '') -ceq $original -and (ReadField $protocolClass '') -ceq 'original' -and
        $null -eq (ReadField $protocolClass 'URL Protocol') -and !(Test-Path (SeedProtocolBackup $tempExe))) 'interrupted seed restores previous handler'
Assert ((ReadField ($protocolClass+'\DefaultIcon') '') -ceq 'original icon') 'unrelated metadata preserved'
SaveSeedProtocol $tempExe
ImitateTemporaryHandler
SetField $protocolClass '' 'concurrent metadata' String
RestoreSeedProtocol $tempExe
Assert ((ReadField $cmdPath '') -ceq $original -and (ReadField $protocolClass '') -ceq 'concurrent metadata') 'concurrent metadata preserved'
SaveSeedProtocol $tempExe
ImitateTemporaryHandler
SetField $cmdPath '' 'new user command' String
RestoreSeedProtocol $tempExe
Assert ((ReadField $cmdPath '') -ceq 'new user command' -and !(Test-Path (SeedProtocolBackup $tempExe))) 'newly selected handler wins'
foreach ($value in @($registered.Replace($id,'personal'),$registered.Replace(' -- ',' /x '))) {
    SetField $cmdPath '' $value String
    RestoreSeedProtocol
    Assert ((ReadField $cmdPath '') -ceq $value) 'nonmatching handler untouched'
}
SetField $cmdPath '' $registered ExpandString
RestoreSeedProtocol
Assert ((ReadField $cmdPath '') -ceq $registered) 'different registry type untouched'
