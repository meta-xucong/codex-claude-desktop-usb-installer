$ErrorActionPreference = 'Stop'
$connection = $env:CAM_CLAUDE_CONNECTION
Remove-Item Env:CAM_CLAUDE_CONNECTION -ErrorAction SilentlyContinue
$action = $env:CAM_CLAUDE_ACTION
$base = Join-Path $env:LOCALAPPDATA 'CodexAppManager\claude-desktop'
$helper = Join-Path $base 'Get-UsbClaudeCredential.ps1'
$record = Join-Path $base 'connection.json'
$library = Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary'
$profileId = '00000000-0000-4000-8000-000000157210'
$profilePath = Join-Path $library ($profileId + '.json')
$metaPath = Join-Path $library '_meta.json'
$machineRoot = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'CodexUsbClaudeDesktop'
$selection = Join-Path $base 'desktop-version'
$journal = Join-Path $base 'desktop-pending.json'
$failure = 27
$sharedReady = Join-Path $base 'shared\ready-v1'

function Show-InstallStep([string]$name) {
    if (!$env:CAM_CLAUDE_PROGRESS -or $action -cne 'prepare') { return }
    try {
        if (!$script:progressStream) {
            $script:progressStream = [IO.FileStream]::new($env:CAM_CLAUDE_PROGRESS,
                [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
                ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete), 16, [IO.FileOptions]::DeleteOnClose)
        }
        $bytes = [Text.Encoding]::ASCII.GetBytes($name.PadRight(16))
        $script:progressStream.Position = 0
        $script:progressStream.Write($bytes, 0, $bytes.Length)
        $script:progressStream.Flush()
    } catch { } # Display telemetry cannot affect the worker result.
}

function SyncShared($kind) {
    $python = Join-Path $env:CAM_CLAUDE_CODEX_HOME 'codex-agent-kit\runtime\python-env\Scripts\python.exe'
    $mutex = [Threading.Mutex]::new($false, 'Local\CodexAppManagerClaudeShared')
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne() } catch [Threading.AbandonedMutexException] { $locked = $true }
        $parts = switch ($kind) {
            'prepare' { 'skills','connections' }
            'capabilities' { 'skills','connections' }
            default { $kind }
        }
        foreach ($part in $parts) {
            if ($kind -ceq 'prepare') { Show-InstallStep $part }
            $script:failure = @{skills=36;models=37;connections=38}[$part]
            & $python -I -c "import os;exec(os.environ.pop('CAM_CLAUDE_SHARED'))" $part (Join-Path $runtime 'claude.exe') $profilePath $base
            if ($LASTEXITCODE -ne 0) { throw 'Claude capability sync failed' }
        }
        if ($kind -in 'prepare','capabilities') {
            if ($kind -ceq 'prepare') { Show-InstallStep 'finalize' }
            # Preserve the outstanding provider migration until ConfigureDesktopProvider runs.
            if (!$legacyModels -or $action -in 'open','prepare') {
                PutText $sharedReady ($env:CAM_CLAUDE_ID + '|' + $env:CAM_CLAUDE_PIPE + '|shared-v4')
            }
        }
    } catch {
        if ($kind -ne 'models' -and (!$legacyModels -or $action -in 'open','prepare')) {
            try { PutText $sharedReady ($env:CAM_CLAUDE_ID+'|'+$env:CAM_CLAUDE_PIPE+'|components-pending') } catch { }
        }
        throw
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

# Component repair reports these failures separately from desktop activation.
function SyncForDesktop($kind) {
    try { SyncShared $kind } catch { Write-Verbose "Claude components need repair." }
}

function RuntimeReady {
    $exe = Get-Item -LiteralPath (Join-Path $runtime 'claude.exe') -ErrorAction SilentlyContinue
    return ($exe -and $exe.VersionInfo.ProductVersion -eq [string]$codeVersion -and
        (Test-Path -LiteralPath (Join-Path $runtime '.verified') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $runtime '.payload') -PathType Leaf))
}
function ReadJson($path) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
}
function SelectedProfileMatches {
    $profile = ReadJson $profilePath
    $meta = ReadJson $metaPath
    return ($meta.appliedId -ceq $profileId -and $profile.inferenceCredentialHelper -ieq $helper -and
        $profile.inferenceProvider -ceq 'gateway' -and $profile.inferenceGatewayBaseUrl -ceq 'https://404token.xyz' -and
        !$profile.inferenceGatewayApiKey)
}
function ProfileReady {
    if (!(SelectedProfileMatches)) { return $false }
    foreach ($dir in 'Claude','Claude-3p') {
        $desktop = ReadJson (Join-Path $env:LOCALAPPDATA "$dir\claude_desktop_config.json")
        if ($desktop.deploymentMode -cne '3p') { return $false }
    }
    return $true
}
function ConfigureDesktopProvider {
    $start = [Diagnostics.ProcessStartInfo]::new($env:CAM_CLAUDE_SWITCH, '--usb-prepare-claude-desktop')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['CODEX_USB_CCSWITCH_MODE'] = 'usb'
    $start.EnvironmentVariables['CCSWITCH_USB_CODEX_HOME'] = $env:CAM_CLAUDE_CODEX_HOME
    $start.EnvironmentVariables['CODEX_USB_EXPECTED_CODEX_HOME'] = $env:CAM_CLAUDE_CODEX_HOME
    $start.EnvironmentVariables['CCSWITCH_404TOKEN_DEVICE_KEY'] = $connection
    $p = [Diagnostics.Process]::Start($start)
    try {
        $p.WaitForExit()
        if ($p.ExitCode -ne 0 -or !(ProfileReady)) { throw 'Desktop provider unavailable' }
    } finally { $p.Dispose() }
}
function PutText($path, $text) {
    $tmp = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($tmp, $text, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($tmp,$path,[NullString]::Value) }
        else { [IO.File]::Move($tmp,$path) }
    } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function RunningApp($exe) {
    @(Get-Process Claude -ErrorAction SilentlyContinue | Where-Object {
        $_.SessionId -eq (Get-Process -Id $PID).SessionId -and $_.Path -and $_.Path -ieq $exe
    })
}
# Recover a temporary protocol handler left by the previous MSIX seed worker.
$protocolClass = 'Software\Classes\claude'
$protocolSubkeys = @('', '\shell', '\shell\open', '\shell\open\command')
function SeedProtocolBackup($stageExe) {
    Join-Path $base ((Split-Path (Split-Path $stageExe) -Leaf) + '.protocol.json')
}
function RestoreSeedProtocol($finishedExe) {
    $user = [Microsoft.Win32.Registry]::CurrentUser
    $key = $user.OpenSubKey($protocolClass + '\shell\open\command')
    $command = try {
        if ($key -and $key.GetValueNames() -contains '' -and $key.GetValueKind('') -eq 'String') {
            $key.GetValue('',$null,'DoNotExpandEnvironmentNames')
        }
    } finally { if ($key) { $key.Dispose() } }
    # Accept only the exact command shape and temporary directory made by
    # SeedRuntime. An existing user handler or a newly selected app wins.
    $temp = [regex]::Escape([IO.Path]::GetTempPath().TrimEnd('\') + '\')
    $pathPattern = $temp + 'CodexUsbClaude-[0-9a-f]{32}\\Claude\.exe'
    if ($command -isnot [string] -or $command -notmatch ('^(?:"(?<exe>' + $pathPattern +
        ')"|(?<exe>' + $pathPattern + ')) -- "%1"\z')) {
        if ($finishedExe) { [IO.File]::Delete((SeedProtocolBackup $finishedExe)) }
        return
    }
    $stageExe = $Matches['exe']
    if ($finishedExe -and $finishedExe -ine $stageExe) {
        [IO.File]::Delete((SeedProtocolBackup $finishedExe))
        return
    }
    $protocolBackup = SeedProtocolBackup $stageExe
    $backup = ReadJson $protocolBackup
    if (Test-Path -LiteralPath $stageExe) {
        if (!$backup -or @(RunningApp $stageExe).Count) { return }
    }
    # Restore metadata first and the command last. Only undo values that still
    # have the contents written by Electron. Older releases kept no snapshot.
    foreach ($i in @(0,3)) {
        $key = $user.OpenSubKey($protocolClass + $protocolSubkeys[$i], $true)
        if (!$key) { continue }
        try {
            $written = if ($i -eq 0) { @{''='URL:claude'; 'URL Protocol'=''} } else { @{''=$command} }
            foreach ($name in $written.Keys) {
                $now = $key.GetValue($name,$null,'DoNotExpandEnvironmentNames')
                if ($now -isnot [string] -or $now -cne $written[$name] -or $key.GetValueKind($name) -ne 'String') { continue }
                $old = if ($backup) { $backup.keys[$i].values | Where-Object name -eq $name }
                if ($null -eq $old) { $key.DeleteValue($name,$false); continue }
                $data = $old.data
                if ($old.kind -eq 'Binary' -or $old.kind -eq 'None') { $data = [byte[]]$data }
                if ($old.kind -eq 'MultiString') { $data = [string[]]$data }
                $key.SetValue($name,$data,[Microsoft.Win32.RegistryValueKind]$old.kind)
            }
        } finally { $key.Dispose() }
    }
    for ($i = 3; $i -ge 0; $i--) {
        if ($backup -and $backup.keys[$i].present) { continue }
        $path = $protocolClass + $protocolSubkeys[$i]
        $key = $user.OpenSubKey($path)
        if (!$key) { continue }
        try { $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0 } finally { $key.Dispose() }
        if ($empty) { $user.DeleteSubKey($path,$false) }
    }
    [IO.File]::Delete($protocolBackup)
}
function SelectDesktop([string]$v) {
    if ($v -cnotmatch '^\d+\.\d+\.\d+\.0$' -or ([version]$v).ToString() -cne $v) {throw 'Invalid desktop version'}
    $folder=Join-Path $machineRoot $v
    $pair=ReadJson (Join-Path $folder 'release.json')
    if (!$pair -or $pair.desktop -cne $v -or $pair.code -cnotmatch '^\d+\.\d+\.\d+$' -or $pair.archive -cnotmatch '^[a-f0-9]{64}$') {throw 'Desktop pair unavailable'}
    $script:exe=Join-Path $folder 'app\claude.exe'
    if (![IO.File]::Exists($exe)) {throw 'Missing desktop executable'}
    $script:codeVersion=[version]($pair.code+'.0')
    $script:runtime=Join-Path $env:LOCALAPPDATA ('Claude-3p\claude-code\'+$pair.code+'\'+$pair.archive.Substring(0,12))
}
function OtherDesktopRunning {
    $session=(Get-Process -Id $PID).SessionId
    # The Code CLI also uses claude.exe. Compare only known desktop images.
    foreach ($p in @(Get-Process Claude -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)) {
        $path=$p.Path
        if ($path -and ($path.StartsWith($machineRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith((Join-Path $env:LOCALAPPDATA 'AnthropicClaude\app-'),[StringComparison]::OrdinalIgnoreCase) -or
            $path -match '\\WindowsApps\\Claude_[^\\]+_pzs8sxrjxfjjc\\app\\Claude\.exe$')) {return $true}
    }
    return $false
}
function WaitForDesktop($path,[switch]$seed) {
    $info=[Diagnostics.ProcessStartInfo]::new($path)
    $info.WorkingDirectory=Split-Path $path
    $info.UseShellExecute=$false
    $started=[Diagnostics.Process]::Start($info)
    $clock=[Diagnostics.Stopwatch]::StartNew()
    try {
        do {
            $apps=@(RunningApp $path)
            $window=$apps | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Responding } | Select-Object -First 1
            if ($window -and !$seed) { return $window.Id }
            if ($window -and (RuntimeReady)) { return }
            if ($started.HasExited -and !$apps.Count) {throw 'Desktop exited'}
            Start-Sleep -Milliseconds 300
        } while ($clock.Elapsed.TotalSeconds -lt $(if ($seed) {300} else {40}))
        throw 'Desktop not ready'
    } finally {
        if ($seed) {
            # Called only with no desktop instance, under the manager operation lock.
            $mine=@(RunningApp $path)
            foreach ($p in $mine) {if ($p.MainWindowHandle) {[void]$p.CloseMainWindow()}}
            foreach ($p in $mine) {
                try {if (!$p.HasExited -and !$p.WaitForExit(3000)) {$p.Kill(); [void]$p.WaitForExit(3000)}} catch {if (!$p.HasExited) {throw}}
            }
        }
        $started.Dispose()
    }
}
function CompleteSelection($item) {
    SelectDesktop $item.to
    if (OtherDesktopRunning) {exit 21}
    try {
        $script:failure=25
        WaitForDesktop $exe -seed
        if (!(RuntimeReady)) {throw 'Code unavailable'}
        $script:failure=27
        if ($item.from -and $item.from -ne $item.to) {SyncForDesktop 'prepare'}
        PutText $selection $item.to
        [IO.File]::Delete($journal)
    } catch {
        if ($item.from -and $item.from -ne $item.to) {
            SelectDesktop $item.from
            if (!(RuntimeReady)) {WaitForDesktop $exe -seed}
            if (!(RuntimeReady)) {exit 33}
            SyncForDesktop 'prepare'
            PutText $selection $item.from
            [IO.File]::Delete($journal)
            exit 35
        }
        throw
    }
}
try {
    $syncOnly=$action -in @('models','skills','connections','capabilities')
    if ($syncOnly -and ![IO.File]::Exists($record)) {exit 28}
    foreach ($path in 'HKLM:\SOFTWARE\Policies\Claude','HKCU:\SOFTWARE\Policies\Claude') {
        $policy=Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        if ($policy -and @($policy.GetValueNames() -match '^(inference|bootstrap|deploymentMode)').Count) {exit 20}
    }
    $ours=SelectedProfileMatches
    if (!$ours -and (Test-Path -LiteralPath $library) -and @(Get-ChildItem -LiteralPath $library -File).Count) {exit 20}
    $active=if ([IO.File]::Exists($selection)) {[IO.File]::ReadAllText($selection)}
    $installed=$active -cmatch '^\d+\.\d+\.\d+\.0$' -and [IO.File]::Exists((Join-Path $machineRoot ($active+'\release.json')))
    if ($installed) {SelectDesktop $active}
    $prev=ReadJson $record
    $same=$ours -and $prev.identity -ceq $env:CAM_CLAUDE_ID -and $prev.pipe -ceq $env:CAM_CLAUDE_PIPE -and (ProfileReady) -and [IO.File]::Exists($helper)
    $ready=$installed -and $same -and (RuntimeReady)
    $pending=ReadJson $journal
    $bindingStamp=$env:CAM_CLAUDE_ID+'|'+$env:CAM_CLAUDE_PIPE
    $sharedStamp=try { if ([IO.File]::Exists($sharedReady)) {[IO.File]::ReadAllText($sharedReady)} } catch { $null }
    $legacyModels=$same -and $sharedStamp -ceq $bindingStamp
    $legacyConnections=$same -and $sharedStamp -ceq ($bindingStamp+'|shared-v3')
    $legacyShared=$legacyConnections -or $legacyModels -or ($same -and $sharedStamp -ceq ($bindingStamp+'|models-v2'))
    if ($action -ceq 'status') {
        if ($pending) {exit 14}
        if (!$installed) {exit 10}
        if ($ready -and $sharedStamp -ceq ($bindingStamp+'|shared-v4')) {exit 12}
        if ($ready) {exit 15}
        exit 11
    }
    if ($syncOnly) {if (!$same -or $pending -or !$ready) {exit 28}; SyncShared $action; exit 0}
    if ($action -ceq 'open') {
        if ($pending -or !$ready) {exit 28}
        RestoreSeedProtocol
        if (!(RunningApp $exe) -and (OtherDesktopRunning)) {exit 21}
        if ($legacyShared) {
            if ($env:CAM_CLAUDE_PREPARE_PART -cne 'upgrade-shared') {exit 48}
            if ($legacyModels) {
                if (!$connection) {exit 29}
                $failure=29; ConfigureDesktopProvider
            }
            if ($legacyConnections) {
                try {
                    SyncShared 'connections'
                    PutText $sharedReady ($bindingStamp+'|shared-v4')
                } catch { Write-Verbose "Claude connections need repair." }
            } else { SyncForDesktop 'prepare' }
        }
        $failure=26; $windowPid=WaitForDesktop $exe; exit (0x40000000 -bor [int]$windowPid)
    }
    if ($action -ceq 'update') {
        if (!$installed -or !$same) {exit 28}
        if (OtherDesktopRunning) {exit 21}
        if ($pending) {CompleteSelection $pending; exit 0}
        if (!$ready) {exit 28}
        if (!$env:CAM_CLAUDE_STAGED_VERSION) {exit 47}
        if ([version]$env:CAM_CLAUDE_STAGED_VERSION -le [version]$active) {exit 13}
        $pending=@{from=$active;to=$env:CAM_CLAUDE_STAGED_VERSION}
        PutText $journal ($pending|ConvertTo-Json -Compress)
        CompleteSelection $pending; exit 0
    }
    if ($action -cne 'prepare') {exit 27}
    if ($env:CAM_CLAUDE_PREPARE_PART -ceq 'runtime') {
        if (!$same) {exit 28}
        if ($pending) {CompleteSelection $pending}
        if (![IO.File]::Exists($selection)) {exit 28}
        SelectDesktop ([IO.File]::ReadAllText($selection))
        if (!(RuntimeReady)) {if (OtherDesktopRunning) {exit 21}; WaitForDesktop $exe -seed}
        SyncForDesktop 'prepare'; exit 0
    }
    if (!$connection) {exit 27}
    if ((!$ready -or $pending) -and (OtherDesktopRunning)) {exit 21}
    $target=if ($pending) {$pending.to} elseif ($installed) {$active} else {'6.28899.2.0'}
    if ($target -cnotmatch '^\d+\.\d+\.\d+\.0$') {exit 33}
    Show-InstallStep 'register'
    if (![IO.File]::Exists((Join-Path $machineRoot ($target+'\release.json')))) {
        if ($target -ne '6.28899.2.0') {exit 33}
        if ($env:CAM_CLAUDE_STAGED_VERSION) {exit 24}
        exit 41
    }
    [void][IO.Directory]::CreateDirectory($base)
    RestoreSeedProtocol
    Show-InstallStep 'profile'
    if (!$same) {
        $sealed=ConvertFrom-SecureString (ConvertTo-SecureString $connection -AsPlainText -Force)
        $failure=29; ConfigureDesktopProvider; $failure=27
        PutText $record (@{identity=$env:CAM_CLAUDE_ID;pipe=$env:CAM_CLAUDE_PIPE;credential=$sealed}|ConvertTo-Json -Compress)
    } elseif ($legacyModels) {
        $failure=29; ConfigureDesktopProvider; $failure=27
    }
    # Existing MSIX users may have a helper that only recognizes WindowsApps.
    if (![IO.File]::Exists($helper) -or [IO.File]::ReadAllText($helper) -cne $env:CAM_CLAUDE_HELPER_BODY) {PutText $helper $env:CAM_CLAUDE_HELPER_BODY}
    if (!$pending -and (!$installed -or !(RuntimeReady))) {PutText $journal (@{from=$active;to=$target}|ConvertTo-Json -Compress)}
    exit 42
} catch { exit $failure }
