$ErrorActionPreference='Stop'
if($env:USERNAME -ne 'WDAGUtilityAccount' -or (Get-AppxPackage Claude)){throw 'Fresh disposable guest required'}
$result=[ordered]@{}
function Save { [IO.File]::WriteAllText('C:\Evidence\result.json',($result|ConvertTo-Json)) }
function Assert($ok,$label) { $result[$label]=[bool]$ok; Save; if(!$ok){throw $label} }
function Worker($action) {
    $env:CAM_CLAUDE_ACTION=$action
    $env:CAM_CLAUDE_CONNECTION=if($action -eq 'prepare'){'offline-fixture-device-key'}
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File C:\worker-under-test.ps1
    $LASTEXITCODE
}
try {
    $worker=[IO.File]::ReadAllText('C:\Test\claude_update.ps1')+[Environment]::NewLine+[IO.File]::ReadAllText('C:\Test\claude_desktop.ps1')
    $official='https://update.404token.xyz/__codex_update__/claude/'
    if (!$worker.Contains($official)) {throw 'Expected production relay call site missing'}
    [IO.File]::WriteAllText('C:\worker-under-test.ps1',$worker.Replace($official,'http://127.0.0.1:18678/'),[Text.UTF8Encoding]::new($true))
    $env:CAM_CLAUDE_MEDIA='C:\Media'
    $env:CAM_CLAUDE_SWITCH='C:\Test\CodexSwitch.exe'
    $env:CAM_CLAUDE_PIPE='CodexUsbDirect-1-00000000000000000000000000000000'
    $env:CAM_CLAUDE_ID='integration-test-binding'
    $env:CAM_CLAUDE_CODEX_HOME=Join-Path $env:LOCALAPPDATA 'CodexAppManager\usb-codex-home'
    $env:CAM_CLAUDE_HELPER_BODY=[IO.File]::ReadAllText('C:\Test\claude_credential.ps1')
    $base=Join-Path $env:LOCALAPPDATA 'CodexAppManager\claude-desktop'
    $updates=Join-Path $base 'updates'
    [void][IO.Directory]::CreateDirectory($updates)
    Copy-Item C:\Export\5.11492.2.0 $updates -Recurse
    Add-AppxPackage -Path C:\Export\5.11492.2.0\desktop.msix
$fixture='offline-fixture-device-key'
    $null=New-Item -ItemType Directory -Force -Path $env:CAM_CLAUDE_CODEX_HOME
    $config=Join-Path $env:CAM_CLAUDE_CODEX_HOME 'config.toml'
    [IO.File]::WriteAllText($config,'model = "gpt-6-astra"')
    $start=[Diagnostics.ProcessStartInfo]::new("$env:SystemRoot\System32\cmd.exe",'/d /c C:\Test\CodexSwitch.exe --usb-model-selection < C:\fixture-model-input.json')
    $start.UseShellExecute=$false
    $start.RedirectStandardOutput=$true
    $start.CreateNoWindow=$true
    $vars=@{CODEX_USB_CCSWITCH_MODE='usb';CCSWITCH_USB_CODEX_HOME=$env:CAM_CLAUDE_CODEX_HOME;
        CODEX_USB_EXPECTED_CODEX_HOME=$env:CAM_CLAUDE_CODEX_HOME;CCSWITCH_404TOKEN_DEVICE_KEY=$fixture;
        CCSWITCH_404TOKEN_PROVIDER='404token-sub2api';CCSWITCH_404TOKEN_ACCOUNT='USB-0000';CCSWITCH_404TOKEN_CREDENTIAL_ID='fixture';
        CCSWITCH_404TOKEN_GROUP_ID='1';CCSWITCH_404TOKEN_USER_ID='1'}
    foreach($key in $vars.Keys){$start.EnvironmentVariables[$key]=$vars[$key]}
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $fingerprint=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('["404token-sub2api","USB-0000","fixture",1,1]')))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    [IO.File]::WriteAllText('C:\fixture-model-input.json',(@{schemaVersion=3;requestId='fixture';operation='snapshot';bindingFingerprint=$fingerprint}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    $p=[Diagnostics.Process]::Start($start)
    try {
        $response=$p.StandardOutput.ReadToEnd()|ConvertFrom-Json
        $p.WaitForExit(); $result.codexProviderResult=$response.code
        if (!$response.ok) { throw 'Codex bootstrap' }
    } finally { $p.Dispose(); Save }
    $codexBefore=[IO.File]::ReadAllText($config)
    $normalDir=Join-Path $env:LOCALAPPDATA 'Claude'
    $null=New-Item -ItemType Directory -Force -Path $normalDir
    $normalConfig=Join-Path $normalDir 'claude_desktop_config.json'
    [IO.File]::WriteAllText($normalConfig,'{"preferences":{"locale":"en-US"}}',[Text.UTF8Encoding]::new($false))

    $beforeCfg=[IO.File]::ReadAllText($config)
    $userCfg=Join-Path $env:LOCALAPPDATA 'Claude\claude_desktop_config.json'
    Assert ((Worker prepare) -eq 0) 'oldPrepared'
    Assert ((Worker status) -eq 12) 'oldReady'
    $beforePrefs=[IO.File]::ReadAllText($userCfg)
    $beforeBinding=[IO.File]::ReadAllText((Join-Path $base 'connection.json'))
    $bad='C:\wrong-code'
    [IO.File]::WriteAllText($bad,'yes')
    $server=Start-Job {
        $srv=[Net.HttpListener]::new()
        $srv.Prefixes.Add('http://127.0.0.1:18678/')
        $srv.Start()
        [IO.File]::WriteAllText('C:\relay-ready','1')
        try { while($srv.IsListening){
            $c=$srv.GetContext()
            try {
                $rel=$c.Request.Url.AbsolutePath.TrimStart('/')
                if($rel -notin @('latest.json','6.28899.2.0/desktop.msix','6.28899.2.0/code.zst')){$c.Response.StatusCode=404;continue}
                $path=Join-Path C:\Export $rel
                if($rel -like '*/code.zst' -and (Test-Path C:\wrong-code)){$path='C:\wrong-code'}
                $in=[IO.File]::OpenRead($path)
                try {$c.Response.ContentLength64=$in.Length;$in.CopyTo($c.Response.OutputStream)}finally{$in.Dispose()}
            }finally{$c.Response.Close()}
        }}finally{$srv.Close()}
    }
    for($i=0;$i -lt 30 -and !(Test-Path C:\relay-ready);$i++){Start-Sleep -Milliseconds 300}
    Assert (Test-Path C:\relay-ready) 'relayReady'
    Assert ((Worker update) -eq 31 -and [string](Get-AppxPackage Claude).Version -eq '5.11492.2.0') 'badDownloadPreservedOld'
    [IO.File]::Delete($bad)
    Assert ((Worker update) -eq 0) 'upgrade'
    Assert ([string](Get-AppxPackage Claude).Version -eq '6.28899.2.0' -and (Worker status) -eq 12) 'newReady'
    Assert ((Worker update) -eq 13) 'alreadyCurrent'
    $rt=Join-Path $env:LOCALAPPDATA 'Claude-3p\claude-code\2.1.328\23e64dd91c09'
    Assert ((Get-Item (Join-Path $rt 'claude.exe')).VersionInfo.ProductVersion -eq '2.1.328.0') 'runtimeVersion'
    $journal=Join-Path $updates 'pending.json'
    [IO.File]::WriteAllText($journal,'{"from":"5.11492.2.0","to":"6.28899.2.0"}')
    Assert ((Worker status) -eq 14 -and (Worker prepare) -eq 0 -and !(Test-Path $journal)) 'resumeAfterRegistration'
    # Real Windows rollback after registration, with the new Code cache and archive unavailable.
    Rename-Item -LiteralPath $rt -NewName 'qa-held-runtime'
    $archive=Join-Path $updates '6.28899.2.0\code.zst'
    Rename-Item -LiteralPath $archive -NewName 'qa-held-code.zst'
    [IO.File]::WriteAllText($journal,'{"from":"5.11492.2.0","to":"6.28899.2.0"}')
    Assert ((Worker prepare) -eq 35 -and [string](Get-AppxPackage Claude).Version -eq '5.11492.2.0') 'rollback'
    Assert ((Worker status) -eq 12) 'rollbackReady'
    Rename-Item -LiteralPath (Join-Path $updates '6.28899.2.0\qa-held-code.zst') -NewName 'code.zst'
    Assert ((Worker update) -eq 0 -and (Worker status) -eq 12) 'reapply'
    Assert ($beforeCfg -ceq [IO.File]::ReadAllText($config) -and $beforePrefs -ceq [IO.File]::ReadAllText($userCfg) -and $beforeBinding -ceq [IO.File]::ReadAllText((Join-Path $base 'connection.json'))) 'settingsPreserved'
    Assert ((Worker open) -eq 0) 'officialDesktopOpened'
} catch { $result.failureLine=$_.InvocationInfo.ScriptLineNumber; $result.error=$_.Exception.Message; Save; exit 1 }
finally {if($server){Stop-Job $server}}
