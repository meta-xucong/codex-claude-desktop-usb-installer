# Loaded in the same interactive-user worker as claude_desktop.ps1.
function CheckPair($pair) {
    if ($pair.desktop -cnotmatch '^\d+\.\d+\.\d+\.\d+$' -or
        $pair.code -cnotmatch '^\d+\.\d+\.\d+$' -or
        $pair.archive -cnotmatch '^[0-9a-f]{64}$' -or $pair.msix -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid Claude release descriptor' }
    [void][version]$pair.desktop
    [void][version]$pair.code
}
function SelectPair($pair, $folder) {
    $script:version = [version]$pair.desktop
    $script:codeVersion = [version]($pair.code + '.0')
    $script:media = Join-Path $folder 'desktop.msix'
    $script:cli = Join-Path $folder 'code.zst'
    $script:runtime = Join-Path $env:LOCALAPPDATA ('Claude-3p\claude-code\' + $pair.code + '\' + $pair.archive.Substring(0,12))
}
function SelectInstalledMedia([version]$installed) {
    if ($installed -eq $bundledVersion) {
        $script:version = $bundledVersion
        $script:codeVersion = $bundledCode
        $script:media = $bundledMedia
        $script:cli = $bundledCli
        $script:runtime = $bundledRuntime
        return
    }
    $dir = Join-Path $updates ([string]$installed)
    $pair = ReadJson (Join-Path $dir 'release.json')
    CheckPair $pair
    if ([version]$pair.desktop -ne $installed) { throw 'Wrong recovery media' }
    SelectPair $pair $dir
}
function ReadClaudePackage {
    Get-AppxPackage -Name Claude | Where-Object PackageFamilyName -ceq $family | Select-Object -First 1
}
function RegisterClaudeUpdate($file, [switch]$rollback) {
    $options=@{Path=$file;ErrorAction='Stop'}
    if ($rollback) { $options.ForceUpdateFromAnyVersion=$true }
    try { Add-AppxPackage @options; return } catch {
        if ($_.Exception.HResult -ne -2147009278 -and $_.Exception.Message -notmatch '(?i)0x80073D02') { throw }
        $current=ReadClaudePackage
        if (!$current) { throw }
        $root=$current.InstallLocation.TrimEnd('\')+'\'
        $serviceExe=Join-Path $root 'app\resources\cowork-svc.exe'
        $owners=@(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) })
        $service=@($owners | Where-Object { $_.Path -ieq $serviceExe -and $_.SessionId -eq 0 })
        if ($owners.Count -ne 1 -or $service.Count -ne 1 -or
            !(Get-CimInstance Win32_Service -Filter ("State='Running' AND ProcessId="+$service[0].Id))) { exit 21 }
        # Windows reported this package in use. Only its registered background service remains.
        # Let AppX coordinate that service, never stop a user desktop or a process by PID.
        $options.ForceTargetApplicationShutdown=$true
        Add-AppxPackage @options
    }
}
function VerifyUpdateMedia($pair,$dir) {
    $file = Join-Path $dir 'desktop.msix'
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $pair.msix -or
        (Get-FileHash -LiteralPath (Join-Path $dir 'code.zst') -Algorithm SHA256).Hash -ine $pair.archive) { throw 'Incomplete Claude pair' }
    # Compare the intended MSIX identity before Windows is asked to register anything.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip=[IO.Compression.ZipFile]::OpenRead($file)
    try {
        $reader=[IO.StreamReader]::new($zip.GetEntry('AppxManifest.xml').Open())
        try { $identity=([xml]$reader.ReadToEnd()).DocumentElement.SelectSingleNode("*[local-name()='Identity']") } finally { $reader.Dispose() }
        $installed=ReadClaudePackage
        if (!$installed -or $installed.Publisher -cne $identity.GetAttribute('Publisher') -or $identity.GetAttribute('Name') -cne 'Claude' -or
            $identity.GetAttribute('ProcessorArchitecture') -ine 'x64' -or [version]$identity.GetAttribute('Version') -ne [version]$pair.desktop) { throw 'Unexpected Claude MSIX identity' }
    } finally { $zip.Dispose() }
}
function RestoreClaude($old,$new) {
    $installed=ReadClaudePackage
    if (!$installed -or [version]$installed.Version -notin @($old,$new)) { exit 33 }
    SelectInstalledMedia $old
    if ([version]$installed.Version -eq $new) {
        if ($old -ne $bundledVersion) {
            $oldDir=Join-Path $updates ([string]$old)
            VerifyUpdateMedia (ReadJson (Join-Path $oldDir 'release.json')) $oldDir
        }
        RegisterClaudeUpdate $media -rollback
    }
    $restored=ReadClaudePackage
    if (!$restored -or [version]$restored.Version -ne $old -or $restored.Status -ne 'Ok') { exit 33 }
    # The vendor preseed removes obsolete CLI caches on a successful upgrade.
    if (!(RuntimeReady)) { SeedRuntime (PackageExe $restored) }
    if (!(RuntimeReady)) { exit 33 }
    [IO.File]::Delete($journal)
}
function FinishUpdate($entry, [switch]$resume) {
    $old=[version]$entry.from
    $new=[version]$entry.to
    if ($old -ge $new) { throw 'Invalid pending update' }
    $installed=ReadClaudePackage
    if (!$installed -or [version]$installed.Version -notin @($old,$new)) { throw 'Installed package changed' }
    if (@(RunningApp (PackageExe $installed)).Count) { exit 21 }
    if ($entry.phase -eq 'restore') { RestoreClaude $old $new; return }
    $stage='register'
    try {
        $dir=Join-Path $updates ([string]$new)
        $pair=ReadJson (Join-Path $dir 'release.json')
        CheckPair $pair
        if ([version]$pair.desktop -ne $new) { throw 'Wrong pending pair' }
        if ($resume -and [version]$installed.Version -eq $old) { VerifyUpdateMedia $pair $dir }
        SelectPair $pair $dir
        if ([version]$installed.Version -eq $old) { RegisterClaudeUpdate $media }
        $installed=ReadClaudePackage
        if (!$installed -or [version]$installed.Version -ne $new -or $installed.Status -ne 'Ok') { throw 'Registration incomplete' }
        $stage='runtime'
        if (!(RuntimeReady)) { SeedRuntime (PackageExe $installed) }
        if (!(RuntimeReady)) { throw 'Code runtime unavailable' }
    } catch {
        PutText $journal (@{from=[string]$old;to=[string]$new;phase='restore'} | ConvertTo-Json -Compress)
        RestoreClaude $old $new
        if ($stage -eq 'runtime') { exit 35 }; exit 34
    }
    [IO.File]::Delete($journal)
}
function UpdateClaude($installed, [uri]$source) {
    $root=$source.AbsoluteUri
    $script:failure=30
    $web=[Net.WebClient]::new()
    try {
        $pair=($web.DownloadString($root+'latest.json') | ConvertFrom-Json)
        CheckPair $pair
        if ([version]$pair.desktop -le [version]$installed.Version) { exit 13 }
        if (@(RunningApp (PackageExe $installed)).Count) { exit 21 }
        if (!(RuntimeReady) -or !(Test-Path -LiteralPath $media -PathType Leaf)) { exit 28 }
        [void][IO.Directory]::CreateDirectory($updates)
        $dir=Join-Path $updates $pair.desktop
        $script:failure=31
        $reuse=$false
        if ([IO.Directory]::Exists($dir)) {
            try { VerifyUpdateMedia $pair $dir; $reuse=$true } catch {
                # The destination is a previously attempted, currently inactive version.
                # Only remove our three payload files. Keep unrelated contents intact.
                foreach ($name in 'desktop.msix','code.zst','release.json') { [IO.File]::Delete((Join-Path $dir $name)) }
                [IO.Directory]::Delete($dir)
            }
        }
        if (!$reuse) {
            $temp=Join-Path $updates 'downloading'
            [void][IO.Directory]::CreateDirectory($temp)
            foreach ($name in 'desktop.msix','code.zst') {
                $web.DownloadFile(($root+$pair.desktop+'/'+$name),(Join-Path $temp $name))
            }
            VerifyUpdateMedia $pair $temp
            PutText (Join-Path $temp 'release.json') ($pair | ConvertTo-Json -Compress)
            [IO.Directory]::Move($temp,$dir)
        } else { PutText (Join-Path $dir 'release.json') ($pair | ConvertTo-Json -Compress) }
    } finally { $web.Dispose() }
    $entry=@{from=[string]$installed.Version;to=$pair.desktop}
    PutText $journal ($entry | ConvertTo-Json -Compress)
    $script:failure=33
    FinishUpdate $entry
}
