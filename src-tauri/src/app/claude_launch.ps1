$ErrorActionPreference = 'Stop'
try {
    # This worker uses the Windows PowerShell modules, including Appx.
    $env:PSModulePath = $PSHOME + '\Modules'
    # Respect all configured policies. Only an unconfigured client needs a
    # process-local policy to run the local worker bundled with the manager.
    if (!(Get-ExecutionPolicy -List | Where-Object ExecutionPolicy -ne Undefined)) {
        Set-ExecutionPolicy RemoteSigned -Scope Process -Force
    }
    & (Join-Path $env:CAM_CLAUDE_MEDIA 'claude-desktop-worker.ps1')
    exit $LASTEXITCODE
} catch [System.Management.Automation.PSSecurityException] {
    exit 39
} catch {
    exit 40
}
