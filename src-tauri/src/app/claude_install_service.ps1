# Runs in the manager's already elevated context. No desktop account configuration is loaded.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
try {
    $pkg = Get-AppxPackage -Name Claude | Where-Object PackageFamilyName -ceq 'Claude_pzs8sxrjxfjjc' | Select-Object -First 1
    $expected = [version]'6.28899.2.0'
    if ($pkg -and [version]$pkg.Version -eq $expected -and $pkg.Status -eq 'Ok') { exit 0 }
    if ($pkg -and ([version]$pkg.Version -gt $expected -or $env:CAM_CLAUDE_SAME_ACCOUNT -cne '1')) { exit 23 }
    Add-AppxPackage -Path $env:CAM_CLAUDE_INSTALL_MSIX -ErrorAction Stop
    exit 0
} catch {
    $code = [regex]::Match($_.Exception.Message,'(?i)\b0x[89a-f][0-9a-f]{7}\b')
    if ($code.Success) { exit ([Convert]::ToInt32($code.Value.Substring(2),16)) }
    exit $_.Exception.HResult
}
