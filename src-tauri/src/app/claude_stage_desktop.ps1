# Runs in the elevated manager, without the account Key or desktop-user configuration.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
$root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'CodexUsbClaudeDesktop'
$feed = 'https://update.404token.xyz/__codex_update__/claude/squirrel/'
$bundled = @{desktop='6.28899.2.0';code='2.1.328';exe='997fa0850a14b1d428ce5aea52b47f329e17aa1b17c074a8d4f47c745009d7d0';archive='23e64dd91c09d522eb3571647e27efc40c174865ab5aa532d070d2ccb026c9a6'}
$stage = $null
$failure = 24
$phase = 'prepare'
function GetReleaseFile([string]$url,[string]$path,[string]$part) {
    $file = [IO.File]::Open($path,'CreateNew','Write','None')
    try {
        $buffer = New-Object byte[] 131072
        $total = -1L
        $lastPercent = -1
        $retries = 0
        [Console]::Out.WriteLine("progress $part")
        while ($total -lt 0 -or $file.Position -lt $total) {
            $start = $file.Position
            $end = $start + 16MB - 1
            if ($total -ge 0) { $end = [Math]::Min($end, $total-1) }
            $request = [Net.HttpWebRequest]::Create($url)
            $request.AddRange([long]$start,[long]$end)
            $response = $null
            try {
                $response = $request.GetResponse()
                if ([int]$response.StatusCode -eq 206) {
                    $range = $response.Headers['Content-Range']
                    if ($range -notmatch '^bytes (\d+)-(\d+)/(\d+)$') { throw 'Invalid Content-Range' }
                    $last = [long]$Matches[2]
                    $size = [long]$Matches[3]
                    if ([long]$Matches[1] -ne $start -or $last -lt $start -or $last -gt $end -or
                        $size -le $last -or ($total -ge 0 -and $size -ne $total)) { throw 'Unexpected byte range' }
                    $total = $size
                } elseif ([int]$response.StatusCode -eq 200 -and $start -eq 0) {
                    $total = $response.ContentLength
                    $last = $total - 1
                } else { throw 'Download resume not supported by relay' }
                $inputStream = $response.GetResponseStream()
                while ($true) {
                    try { $n = $inputStream.Read($buffer,0,$buffer.Length) }
                    catch [IO.IOException] { throw [IO.EndOfStreamException]::new('Network stream interrupted', $_.Exception) }
                    if ($n -eq 0) { break }
                    if ($total -ge 0 -and $file.Position+$n -gt $last+1) { throw 'Unexpected response length' }
                    $file.Write($buffer,0,$n)
                    if ($total -gt 0) {
                        $percent = [int][Math]::Floor(100.0*$file.Position/$total)
                        if ($percent -ne $lastPercent) {
                            [Console]::Out.WriteLine("progress $part $percent")
                            $lastPercent = $percent
                        }
                    }
                }
                if ($total -lt 0) { break }
                if ($file.Position -ne $last+1) { throw [IO.EndOfStreamException]::new('Incomplete response') }
                $retries = 0
            } catch {
                $e = $_.Exception
                while ($e -is [Management.Automation.RuntimeException] -and $e.InnerException) { $e = $e.InnerException }
                $status = if ($e -is [Net.WebException] -and $e.Response) { [int]$e.Response.StatusCode } else { 0 }
                $transient = $e -is [IO.EndOfStreamException] -or ($e -is [Net.WebException] -and
                    ($status -in 408,429,500,502,503,504 -or $e.Status -in 'Timeout','ReceiveFailure','ConnectionClosed','ConnectFailure','KeepAliveFailure'))
                if ($e -is [Net.WebException] -and $e.Response) { $e.Response.Dispose() }
                if (!$transient -or $retries -ge 2) { throw }
                $retries++
                [Console]::Out.WriteLine("progress retry-$part")
                Start-Sleep -Milliseconds (500*$retries)
            } finally { if ($response) { $response.Dispose() } }
        }
    } finally { $file.Dispose() }
}
function AssertProtected($path) {
    $dir = Get-Item -Force -LiteralPath $path
    if (!$dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected installation directory' }
    $acl = Get-Acl -LiteralPath $path
    $owners = @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $owners) { throw 'Untrusted installation owner' }
    $write = [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -eq 'Allow' -and ($ace.FileSystemRights -band $write) -and $ace.IdentityReference.Value -notin $owners) {
            # CREATOR OWNER, inherit-only, grants the creator access to its own children.
            if ($ace.IdentityReference.Value -eq 'S-1-3-0' -and ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
            throw 'Untrusted installation access'
        }
    }
}
function VerifyFile($path,$digest) {
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $digest) { throw 'Media does not match release' }
}
function ExpandOfficialDesktop($setup,$target,$desktop) {
    # Read the Squirrel DATA resource as data; do not execute the per-user installer as administrator.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class ClaudeSquirrelResource {
    [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibraryEx(string name, IntPtr file, uint flags);
    [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindResource(IntPtr module, IntPtr id, string type);
    [DllImport("kernel32")] static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32")] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32")] static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
    public static void Copy(string file,string dest) {
        var module=LoadLibraryEx(file,IntPtr.Zero,0x40); // LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE
        if(module==IntPtr.Zero) throw new IOException("Installer resource unavailable");
        try {
            var res=FindResource(module,(IntPtr)131,"DATA");
            var size=SizeofResource(module,res);
            var ptr=LockResource(LoadResource(module,res));
            if(ptr==IntPtr.Zero || size==0 || size>int.MaxValue) throw new InvalidDataException("Missing installer payload");
            byte[] buf=new byte[1024*1024];
            using(var output=new FileStream(dest,FileMode.CreateNew,FileAccess.Write)){
                for(int pos=0;pos<(int)size;){
                    int count=Math.Min(buf.Length,(int)size-pos);
                    Marshal.Copy(IntPtr.Add(ptr,pos),buf,0,count);output.Write(buf,0,count);pos+=count;
                }
            }
        } finally { FreeLibrary(module); }
    }
}
'@
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $outer=Join-Path $stage 'installer.zip'; $inner=Join-Path $stage 'desktop.nupkg'
    [ClaudeSquirrelResource]::Copy($setup,$outer)
    $z=[IO.Compression.ZipFile]::OpenRead($outer)
    try {
        $name='AnthropicClaude-'+([version]$desktop).ToString(3)+'-full.nupkg'
        $entry=$z.GetEntry($name)
        if (!$entry) { throw 'Wrong desktop release' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$inner)
    } finally { $z.Dispose() }
    [IO.File]::Delete($outer)
    $zip=[IO.Compression.ZipFile]::OpenRead($inner)
    try {
        foreach ($entry in $zip.Entries) {
            if (!$entry.FullName.StartsWith('lib/net45/',[StringComparison]::Ordinal) -or !$entry.Name) {continue}
            $rel=$entry.FullName.Substring(10)
            if ($rel -match '[:\\]|(^|/)\.{1,2}(/|$)') {throw 'Invalid desktop entry'}
            $dst=[IO.Path]::GetFullPath((Join-Path $target $rel))
            if (!$dst.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'Invalid desktop destination'}
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dst))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$dst)
        }
    } finally { $zip.Dispose() }
    [IO.File]::Delete($inner)
    if (!(Test-Path -LiteralPath "$target\claude.exe" -PathType Leaf) -or !(Test-Path -LiteralPath "$target\resources\app.asar" -PathType Leaf)) {throw 'Missing official desktop'}
}
try {
    $isUpdate=$env:CAM_CLAUDE_STAGE_ACTION -ceq 'update'
    $security=[Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)')
    [void][IO.Directory]::CreateDirectory($root,$security)
    AssertProtected $root
    $web=[Net.WebClient]::new()
    if ($isUpdate) {
        $failure=30
        $phase='manifest'
        [Console]::Out.WriteLine('progress manifest')
        $pair=$web.DownloadString($feed+'latest.json') | ConvertFrom-Json
    } else {$pair=$bundled}
    if ($pair.desktop -cnotmatch '^\d+\.\d+\.\d+\.0$' -or $pair.code -cnotmatch '^\d+\.\d+\.\d+$' -or
        $pair.exe -cnotmatch '^[a-f0-9]{64}$' -or $pair.archive -cnotmatch '^[a-f0-9]{64}$') {throw 'Invalid release'}
    $v=([version]$pair.desktop).ToString()
    if ($v -cne $pair.desktop -or [version]$v -lt [version]$bundled.desktop) {throw 'Invalid desktop version'}
    if ($isUpdate -and $env:CAM_CLAUDE_EXPECTED_PAIR -and "$v/$($pair.code)" -cne $env:CAM_CLAUDE_EXPECTED_PAIR) {throw 'The release changed; check for updates again'}
    $dest=Join-Path $root $v
    $failure=31
    if (!(Test-Path -LiteralPath $dest)) {
        $stage=Join-Path $root ('.stage-'+[guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($stage)
        $setup=Join-Path $stage 'desktop.exe'
        $archive=Join-Path $stage 'code.zst'
        if ($isUpdate) {
            $phase='desktop'
            GetReleaseFile ($feed+$v+'/desktop.exe') $setup $phase
            $phase='code'
            GetReleaseFile ($feed+$v+'/code.zst') $archive $phase
        } else {
            [IO.File]::Copy((Join-Path $env:CAM_CLAUDE_MEDIA 'Claude-6.28899.2-x64-offline.exe'),$setup)
            [IO.File]::Copy((Join-Path $env:CAM_CLAUDE_MEDIA 'claude-code-2.1.328-win32-x64.exe.zst'),$archive)
        }
        $phase='verify'
        if ($isUpdate) { [Console]::Out.WriteLine('progress verify') }
        VerifyFile $setup $pair.exe
        VerifyFile $archive $pair.archive
        $sig=Get-AuthenticodeSignature -LiteralPath $setup
        # The bundled installer is pinned to the exact previously vendor-verified WinGet file.
        # Online updates also authenticate the original publisher with Windows.
        if ($isUpdate -and ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '^CN="Anthropic, PBC", O="Anthropic, PBC",')) {throw 'Unexpected installer publisher'}
        $tree=Join-Path $stage 'image'
        $app=Join-Path $tree 'app'
        $phase='extract'
        if ($isUpdate) { [Console]::Out.WriteLine('progress extract') }
        ExpandOfficialDesktop $setup $app $v
        $seed=Join-Path $app 'resources\preseed\claude-code'
        [void][IO.Directory]::CreateDirectory($seed)
        [IO.File]::Move($archive,(Join-Path $seed 'win32-x64.zst'))
        [IO.File]::WriteAllText((Join-Path $tree 'release.json'),($pair|ConvertTo-Json -Compress))
        try {[IO.Directory]::Move($tree,$dest)} catch {if (!(Test-Path -LiteralPath $dest -PathType Container)) {throw}}
    }
    $have=Get-Content -Raw -LiteralPath (Join-Path $dest 'release.json') | ConvertFrom-Json
    if ($have.exe -cne $pair.exe -or $have.archive -cne $pair.archive -or $have.code -cne $pair.code -or $have.desktop -cne $v) {throw 'Immutable release mismatch'}
    Write-Output $v
    exit 0
} catch {
    $e=$_.Exception
    while ($e -is [Management.Automation.RuntimeException] -and $e.InnerException) { $e=$e.InnerException }
    $reason=$e.GetType().Name
    if ($e -is [Net.WebException]) {
        $reason=$e.Status.ToString()
        if ($e.Response) { $reason="HTTP $([int]$e.Response.StatusCode)" }
    } elseif ($e -is [IO.IOException]) {
        $reason="$reason (0x{0:X8})" -f $e.HResult
    }
    [Console]::Error.WriteLine(('Claude deployment failed at line {0} phase={1} reason={2}' -f $_.InvocationInfo.ScriptLineNumber,$phase,$reason))
    exit $failure
} finally {
    if ($web) {$web.Dispose()}
    if ($stage -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($stage)) -ieq $root -and
        [IO.Path]::GetFileName($stage) -cmatch '^\.stage-[0-9a-f]{32}$' -and [IO.Directory]::Exists($stage)) {
        [IO.Directory]::Delete($stage,$true)
    }
}
