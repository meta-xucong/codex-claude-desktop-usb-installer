#![cfg(windows)]

use std::{ffi::OsString, fs, path::PathBuf};

#[test]
#[ignore = "requires an elevated runner and an ordinary interactive Windows desktop"]
fn elevated_manager_runs_worker_as_desktop_user() {
    assert!(codex_win_engine::desktop_user_profile_paths_if_elevated().unwrap().is_some());
    let exe = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let check = concat!(
        "$ErrorActionPreference='Stop';$id=[Security.Principal.WindowsIdentity]::GetCurrent();",
        "if (([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 41};",
        "$session=(Get-Process -Id $PID).SessionId;",
        "$shell=Get-CimInstance Win32_Process -Filter \"Name='explorer.exe' AND SessionId=$session\";",
        "foreach($p in $shell){if((Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid -eq $id.User.Value){exit 0}};exit 42"
    );
    let args = ["-NoProfile", "-NonInteractive", "-Command", check].map(OsString::from);
    assert_eq!(codex_win_engine::run_as_desktop_user(&exe, &args, &[]).unwrap(), 0);
    packaged_claude_worker_returns_its_own_exit_code();
}

#[test]
fn packaged_claude_worker_returns_its_own_exit_code() {
    use codex_win_engine::run_as_desktop_user;

    let dir = std::env::temp_dir().join(format!("Claude worker 测试 {}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    let script = dir.join("claude-desktop-worker.ps1");
    let worker = concat!("\u{feff}", include_str!("../../../src-tauri/src/app/claude_update.ps1"),
        "\n", include_str!("../../../src-tauri/src/app/claude_desktop.ps1")).replace("\r\n", "\n");
    fs::write(&script, worker).unwrap();
    use std::os::windows::fs::OpenOptionsExt;
    let locked = fs::OpenOptions::new().read(true).share_mode(1).open(&script).unwrap();
    let exe = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let bootstrap = include_str!("../../../src-tauri/src/app/claude_launch.ps1");
    // CreateProcessWithTokenW accepts a command line of at most 1024 UTF-16 units.
    assert!(exe.to_string_lossy().encode_utf16().count() + bootstrap.encode_utf16().count() + 100 < 1024);
    let action_env = [
        ("CAM_CLAUDE_MEDIA".into(), dir.clone().into_os_string()),
        ("CAM_CLAUDE_ACTION".into(), "prepare".into()),
        ("CAM_CLAUDE_ID".into(), "test-binding".into()),
        ("CAM_CLAUDE_PIPE".into(), "test-pipe".into()),
        ("CAM_CLAUDE_CODEX_HOME".into(), dir.clone().into_os_string()),
        ("CAM_CLAUDE_SWITCH".into(), dir.join("no-switch.exe").into_os_string()),
        ("CAM_CLAUDE_CONNECTION".into(), "offline-fixture-only".into()),
        ("CAM_CLAUDE_SHARED".into(), include_str!("../../../src-tauri/src/app/claude_shared.py").into()),
        ("CAM_CLAUDE_HELPER_BODY".into(), include_str!("../../../src-tauri/src/app/claude_credential.ps1").into()),
    ];
    let invoke = |command: &str, policy: Option<&str>| {
        let mut args = vec!["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"];
        if let Some(value) = policy { args.extend(["-ExecutionPolicy", value]); }
        args.extend(["-Command", command]);
        let args: Vec<_> = args.into_iter().map(OsString::from).collect();
        run_as_desktop_user(&exe, &args, &action_env)
    };
    // The fixture has no MSIX. Reaching 22 proves the actual worker ran;
    // a generic PowerShell success or a rejected launch cannot pass.
    // Set RemoteSigned for this fixture, independent of the test user's defaults.
    let old_inline = concat!(include_str!("../../../src-tauri/src/app/claude_update.ps1"), "\n",
        include_str!("../../../src-tauri/src/app/claude_desktop.ps1"));
    let old = invoke(old_inline, None);
    let ambient = invoke(bootstrap, None);
    println!("Prior inline setup: {old:?}. Packaged worker under actual policy: {ambient:?}.");
    let missing_media = invoke(bootstrap, Some("RemoteSigned"));
    let restricted = invoke(bootstrap, Some("Restricted"));
    drop(locked);
    fs::remove_file(script).unwrap();
    fs::remove_dir(dir).unwrap();
    assert_eq!(missing_media.unwrap(), 22);
    assert_eq!(restricted.unwrap(), 39);
    // A configured policy can reject the file. Accept only a real worker
    // status or the explicit policy-denial result for the ambient-policy case.
    assert!(matches!(ambient.unwrap(), 22 | 39));
}
