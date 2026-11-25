# Run on Windows. Only the native window and Code start are simulated.
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\src-tauri\src\app\claude_desktop.ps1'
$root=Join-Path ([IO.Path]::GetTempPath()) ('claude-selection-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
try {
    $script=@'
param($source,$root,$fail)
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$null,[ref]$null)
foreach($f in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'CompleteSelection','PutText','SyncForDesktop'},$false)){
    . ([scriptblock]::Create($f.Extent.Text))
}
$selection=Join-Path $root 'desktop-version'
$journal=Join-Path $root 'desktop-pending.json'
function SelectDesktop($version){$script:exe=$version}
function OtherDesktopRunning {return $false}
function RuntimeReady {return $true}
function WaitForDesktop($path,[switch]$seed){if($fail -eq 'fail'){throw 'Fixture: new Code did not start'}}
function SyncShared($kind){[IO.File]::WriteAllText((Join-Path $root 'shared'),$script:exe)}
$item=@{from='6.28899.2.0';to='6.28899.6.0'}
PutText $selection $item.from
PutText $journal ($item|ConvertTo-Json -Compress)
CompleteSelection $item
'@
    $case=Join-Path $root 'case.ps1'
    [IO.File]::WriteAllText($case,$script)
    foreach($mode in 'fail','success'){
        & powershell.exe -NoProfile -NonInteractive -File $case $source $root $mode
        $code=$LASTEXITCODE
        $want=if($mode -eq 'fail'){'6.28899.2.0'}else{'6.28899.6.0'}
        if($code -ne $(if($mode -eq 'fail'){35}else{0}) -or
           [IO.File]::ReadAllText((Join-Path $root 'desktop-version')) -cne $want -or
           [IO.File]::ReadAllText((Join-Path $root 'shared')) -cne $want -or
           [IO.File]::Exists((Join-Path $root 'desktop-pending.json'))){throw "Failed selection case $mode ($code)"}
        Write-Output "$mode restored/selected $want"
    }
}finally{
    foreach($name in 'case.ps1','desktop-version','shared','desktop-pending.json'){[IO.File]::Delete((Join-Path $root $name))}
    [IO.Directory]::Delete($root)
}
