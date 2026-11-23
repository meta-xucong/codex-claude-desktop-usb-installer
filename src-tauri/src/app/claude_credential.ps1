# Claude Desktop credential helper. Its stdout is the vendor's private token channel.
$ErrorActionPreference = 'Stop'
try {
    $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $parent = Get-Process -Id $self.ParentProcessId -ErrorAction Stop
    if ($parent.StartTime -gt (Get-Process -Id $PID).StartTime -or $parent.SessionId -ne (Get-Process -Id $PID).SessionId) { exit 1 }
    $root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'CodexUsbClaudeDesktop'
    $versions = @(if ([IO.File]::Exists((Join-Path $PSScriptRoot 'desktop-version'))) {
        [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'desktop-version'))
    })
    if ([IO.File]::Exists((Join-Path $PSScriptRoot 'desktop-pending.json'))) {
        $versions += (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-pending.json') -Raw | ConvertFrom-Json).to
    }
    $trusted = $false
    foreach ($v in $versions) {
        if ($v -cmatch '^\d+\.\d+\.\d+\.0$' -and $parent.Path -ieq (Join-Path $root ($v+'\app\claude.exe'))) { $trusted=$true; break }
    }
    if (!$trusted) { exit 1 }
    foreach ($path in 'HKLM:\SOFTWARE\Policies\Claude','HKCU:\SOFTWARE\Policies\Claude') {
        $policy = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        if ($policy -and @($policy.GetValueNames() -match '^(inference|bootstrap|deploymentMode)').Count) { exit 1 }
    }
    $library = Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary'
    $id = '00000000-0000-4000-8000-000000157210'
    $meta = Get-Content -LiteralPath (Join-Path $library '_meta.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $profile = Get-Content -LiteralPath (Join-Path $library ($id + '.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($meta.appliedId -cne $id -or $profile.inferenceGatewayBaseUrl -cne 'https://404token.xyz' -or
        $profile.inferenceProvider -cne 'gateway' -or $profile.inferenceCredentialHelper -ine $PSCommandPath -or $profile.inferenceGatewayApiKey) { exit 1 }
    $record = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.pipe -notmatch '^CodexUsbDirect-[0-9]+-[0-9a-f]{32}$') { exit 1 }
    $client = [IO.Pipes.NamedPipeClientStream]::new('.', $record.pipe, [IO.Pipes.PipeDirection]::InOut,
        [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Identification)
    try {
        $client.Connect(3000)
        $request = @{schemaVersion=1;requestId=[guid]::NewGuid().ToString('N');args=@('--claude-account-status')}
        $bytes = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress))
        $writer = [IO.BinaryWriter]::new($client)
        $writer.Write([int]$bytes.Length); $writer.Write($bytes); $writer.Flush()
        $reader = [IO.BinaryReader]::new($client)
        $length = $reader.ReadInt32()
        if ($length -lt 1 -or $length -gt 65536) { exit 1 }
        $response = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($length)) | ConvertFrom-Json
        if ($response.ok -ne $true -or $response.message -cne $record.identity) { exit 1 }
    } finally { $client.Dispose() }
    $secure = ConvertTo-SecureString $record.credential
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
    exit 0
} catch { exit 1 }
