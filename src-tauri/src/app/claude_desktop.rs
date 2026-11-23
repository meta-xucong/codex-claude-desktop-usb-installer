use crate::errors::AppError;
use std::path::Path;

#[cfg(windows)]
const DESKTOP_INSTALLER: &str = "payload/claude/Claude-6.28899.2-x64-offline.exe";

#[cfg(windows)]
fn stage_desktop(powershell: &Path, media_dir: &Path, updating: bool) -> Result<String, AppError> {
    use std::os::windows::process::CommandExt;
    let ps_home = powershell.parent().expect("system PowerShell executable has a parent");
    let output = std::process::Command::new(powershell)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", include_str!("claude_stage_desktop.ps1")])
        .current_dir(ps_home)
        .env("PSModulePath", ps_home.join("Modules"))
        .env("CAM_CLAUDE_MEDIA", super::capability_pack::powershell_provider_path(media_dir))
        .env("CAM_CLAUDE_STAGE_ACTION", if updating { "update" } else { "install" })
        .env_remove("CAM_CLAUDE_CONNECTION")
        .creation_flags(0x08000000)
        .output().map_err(|e| AppError::Engine(format!("无法部署官方 Claude 桌面文件：{e}")))?;
    let code = output.status.code().unwrap_or(-1);
    if !output.status.success() {
        log::warn!("Claude desktop stage exit={code} {}", String::from_utf8_lossy(&output.stderr).trim());
        return Err(AppError::Engine(format!("Claude 桌面介质部署失败（阶段代码 {code}）。")));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if version.split('.').count() != 4 || !version.split('.').all(|n| n.parse::<u16>().is_ok()) {
        return Err(AppError::Engine("Claude 桌面部署未返回有效版本。".into()));
    }
    Ok(version)
}

pub fn included(root: &Path) -> bool {
    super::usb_bundle::includes_claude_desktop(root)
}

#[cfg(windows)]
fn open_worker(path: &Path) -> Result<std::fs::File, AppError> {
    use std::io::Read;
    use std::os::windows::fs::OpenOptionsExt;
    // The worker receives the USB account on prepare. Keep the checked file
    // open without write/delete sharing until Windows PowerShell exits.
    let mut file = std::fs::OpenOptions::new().read(true).share_mode(1).open(path)
        .map_err(|e| AppError::Engine(format!("无法打开随包 Claude 安装脚本：{e}")))?;
    let expected = concat!("\u{feff}", include_str!("claude_desktop.ps1")).replace("\r\n", "\n");
    let mut actual = Vec::new();
    (&mut file).take(expected.len() as u64 + 1).read_to_end(&mut actual)
        .map_err(|e| AppError::Engine(format!("无法读取随包 Claude 安装脚本：{e}")))?;
    if actual != expected.as_bytes() {
        return Err(AppError::Engine("USB_BUNDLE_CLAUDE_WORKER：Claude 安装脚本与本版管理器不匹配。".into()));
    }
    Ok(file)
}

#[cfg(windows)]
fn with_install_progress<T>(path: &Path, stage: &(impl Fn(&'static str) + Sync), run: impl FnOnce() -> T) -> T {
    use std::{fs::File, io::Read, sync::mpsc, thread, time::Duration};
    thread::scope(|scope| {
        let (stop, stopped) = mpsc::channel::<()>();
        let _watcher = thread::Builder::new().spawn_scoped(scope, move || {
            let mut last = "";
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(Duration::from_millis(250)) {
                let mut bytes = [0; 16];
                if File::open(path).and_then(|mut f| f.read_exact(&mut bytes)).is_err() { continue; }
                let value = std::str::from_utf8(&bytes).unwrap_or("").trim_end();
                if let Some(name) = ["register", "profile", "seed", "skills", "models", "connections", "finalize"]
                    .into_iter().find(|s| *s == value && *s != last) {
                    stage(name);
                    last = name;
                }
            }
        });
        let result = run();
        drop(stop);
        result
    })
}

#[cfg(windows)]
fn worker(action: &'static str, stage: impl Fn(&'static str) + Sync) -> Result<u32, AppError> {
    use crate::app::{codex_entry_ipc, usb_guard};
    use std::ffi::OsString;
    use std::os::windows::fs::OpenOptionsExt;
    let (root, identity, key) = usb_guard::claude_account()?;
    if !included(&root) {
        return Err(AppError::Engine("此安装包没有 Claude Desktop 介质。".into()));
    }
    let pipe = codex_entry_ipc::current_pipe_for(&root).map_err(AppError::Engine)?;
    let mut env: Vec<(OsString, OsString)> = vec![
        ("CAM_CLAUDE_MEDIA".into(), root.join("payload/claude").into()),
        ("CAM_CLAUDE_PIPE".into(), pipe.trim_start_matches(r"\\.\pipe\").into()),
        ("CAM_CLAUDE_ID".into(), OsString::from(&identity)),
        ("CAM_CLAUDE_ACTION".into(), action.into()),
    ];
    let mut progress_path = None;
    if matches!(action, "prepare" | "capabilities" | "skills" | "models" | "connections") {
        let home = usb_guard::local_data_paths()?.codex_home;
        if action == "prepare" {
            let path = home.join(format!("claude-progress-{}.tmp", uuid::Uuid::new_v4()));
            env.push(("CAM_CLAUDE_PROGRESS".into(), path.clone().into()));
            progress_path = Some(path);
        }
        env.push(("CAM_CLAUDE_CODEX_HOME".into(), home.into()));
        env.push(("CAM_CLAUDE_SHARED".into(), include_str!("claude_shared.py").into()));
    }
    // Keep the signed USB source stable throughout the offline deployment.
    let media = root.join(DESKTOP_INSTALLER);
    let _media_guard = if action == "prepare" {
        let entry = super::uninstall_cleanup::pin_readonly_path(&media)
            .map_err(|e| AppError::Engine(format!("无法打开 Claude 离线介质：{e}")))?;
        let file = std::fs::OpenOptions::new().read(true).share_mode(1).open(&media)
            .map_err(|e| AppError::Engine(format!("无法读取 Claude 离线介质：{e}")))?;
        Some((entry, file))
    } else { None };
    if action == "prepare" || action == "update" {
        let checked = usb_guard::require_signed_codex_bundle("claude-desktop-deploy")?
            .ok_or_else(|| AppError::Engine("Claude 安装需要已签名的 U 盘套件。".into()))?;
        if checked.bundle_root != root || checked.license_digest != identity {
            return Err(AppError::Engine("准备 Claude 时 U 盘绑定发生变化。".into()));
        }
    }
    if action == "prepare" {
        // Install and launch workers run as the interactive user. The worker removes
        // this hand-off from its environment before starting any child process.
        env.push(("CAM_CLAUDE_CONNECTION".into(), key.into()));
        env.push(("CAM_CLAUDE_SWITCH".into(), root.join("ccswitch").join(super::ccswitch::CCSWITCH_EXECUTABLE).into()));
        env.push(("CAM_CLAUDE_HELPER_BODY".into(), include_str!("claude_credential.ps1").into()));
    }
    use std::os::windows::ffi::OsStringExt;
    let mut dir = [0u16; 32768];
    let len = unsafe { windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(
        dir.as_mut_ptr(), dir.len() as u32,
    ) } as usize;
    if len == 0 || len >= dir.len() { return Err(AppError::Engine("未找到 Windows 系统目录。".into())); }
    let powershell = std::path::PathBuf::from(OsString::from_wide(&dir[..len]))
        .join(r"WindowsPowerShell\v1.0\powershell.exe");
    let script = root.join("payload/claude/claude-desktop-worker.ps1");
    let _worker_file = open_worker(&script)?;
    let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
        include_str!("claude_launch.ps1")]
        .map(OsString::from);
    let run = |env: &[(OsString, OsString)]| {
        let launch = || codex_win_engine::run_as_desktop_user(&powershell, &args, env);
        let result = match &progress_path {
            Some(path) => with_install_progress(path, &stage, launch),
            None => launch(),
        };
        let code = result.map_err(|e| {
            log::warn!("Claude desktop worker action={action} failed: {e}");
            AppError::ClaudeDesktopWorker(format!("{action}: {e}"))
        })?;
        if action == "open" {
            log::info!("Claude desktop worker action=open exit_code={code} (0x{code:08X}) unix_ms={}", usb_guard::now_ms());
        } else {
            log::info!("Claude desktop worker action={action} exit_code={code}");
        }
        Ok::<u32, AppError>(code)
    };
    env.push(("CAM_CLAUDE_PREPARE_PART".into(), "desktop".into()));
    if action == "prepare" { stage("desktop"); }
    let mut code = run(&env)?;
    if (code == 41 && action == "prepare") || (code == 47 && action == "update") {
        stage("desktop");
        let version = stage_desktop(&powershell, &root.join("payload/claude"), action == "update")?;
        env.push(("CAM_CLAUDE_STAGED_VERSION".into(), version.into()));
        if action == "prepare" { stage("account"); }
        code = run(&env)?;
    }
    if code == 42 && action == "prepare" {
        stage("runtime");
        env.retain(|(k, _)| k != "CAM_CLAUDE_CONNECTION" && k != "CAM_CLAUDE_PREPARE_PART");
        env.push(("CAM_CLAUDE_PREPARE_PART".into(), "runtime".into()));
        code = run(&env)?;
        if code == 0 { stage("complete"); }
    }
    match code {
        hr if action == "open" && hr >= 0x80000000 =>
            Err(AppError::Engine(format!("Windows 激活 Claude 失败（HRESULT 0x{hr:08X}）。"))),
        hr if action == "prepare" && hr >= 0x80000000 =>
            Err(AppError::Engine(format!("Windows 为当前桌面用户注册 Claude 失败（AppX 0x{hr:08X}）。"))),
        10 | 11 | 12 | 14 if action == "status" => Ok(code),
        13 if action == "update" => Ok(code),
        0 if action != "status" => Ok(0),
        _ => Err(AppError::Engine(match code {
            20 => "当前机器或用户已有 Claude 连接策略，请保留现有设置并检查冲突。",
            21 => "请保存工作并正常退出已打开的 Claude，再准备当前 U 盘账号。",
            22 => "Claude 离线介质不完整，请检查双端安装包。",
            23 => "本机 Claude 版本与随包 Code 运行时不匹配，已有版本已保留。",
            24 => "官方 Claude 桌面文件没有准备完成。",
            25 => "官方 Claude 未完成本地 Code 运行时准备。",
            26 => "Claude 桌面未能打开可响应的窗口。",
            43 => "找不到当前用户已注册的 Claude 桌面启动入口。",
            45 => "Windows 已接受激活请求，但未检测到当前用户的 Claude 桌面进程。",
            46 => "Claude 桌面进程已出现，随后在显示可用窗口前退出。",
            27 => "Claude 本机连接配置保存失败。",
            28 => "请先在启动器完成本机的 Claude 安装和账号配置。",
            29 => "CCSwitch 未能把当前 U 盘的 404token 账号配置到 Claude Desktop。",
            30 => "未能从备用源取得 Claude 配对版本信息。",
            31 => "Claude 更新文件下载或核验失败，当前版本仍可使用。",
            33 => "Claude 更新尚未完成，请关闭 Claude 后在启动器继续恢复。",
            34 => "新版 Claude 桌面文件准备失败。",
            35 => "新版 Claude Code 运行时未就绪，已恢复旧版。",
            36 => "Claude 技能未同步完成，请重试当前操作。",
            37 => "Claude 模型列表未同步完成，请重试当前操作。",
            38 => "Claude 工具连接未同步完成，请重试当前操作。",
            39 => "Windows PowerShell 执行策略阻止了 Claude 安装助手。请联系本机管理员核对策略。",
            40 => "Windows PowerShell 未能加载随包 Claude 安装助手。请检查双端安装包和本机策略。",
            _ => return Err(AppError::Engine(format!("Claude 本机检查或部署失败（{code}）。"))),
        }.into())),
    }
}

pub fn sync_if_installed(_action: &'static str) -> Result<(), AppError> {
    #[cfg(windows)]
    if super::usb_guard::current_bundle_root().as_deref().is_some_and(included) {
        let record = super::usb_guard::local_data_paths()?.local_app_data
            .join("CodexAppManager/claude-desktop/connection.json");
        if !record.try_exists().map_err(|e| AppError::Engine(format!("无法读取 Claude 本机配置：{e}")))? {
            return Ok(());
        }
        worker(_action, |_| {})?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn status() -> Result<&'static str, AppError> {
    Ok(match worker("status", |_| {})? { 10 => "install", 11 => "prepare", 14 => "recover", _ => "ready" })
}
#[cfg(windows)]
pub fn update() -> Result<bool, AppError> { worker("update", |_| {}).map(|code| code != 13) }
#[cfg(not(windows))]
pub fn update() -> Result<bool, AppError> { Err(AppError::UnsupportedPlatform) }
#[cfg(windows)]
pub fn open() -> Result<(), AppError> { worker("open", |_| {}).map(|_| ()) }
#[cfg(windows)]
pub fn prepare(stage: impl Fn(&'static str) + Sync) -> Result<(), AppError> { worker("prepare", stage).map(|_| ()) }
#[cfg(not(windows))]
pub fn prepare(_stage: impl Fn(&'static str)) -> Result<(), AppError> { Err(AppError::UnsupportedPlatform) }
#[cfg(not(windows))]
pub fn status() -> Result<&'static str, AppError> { Err(AppError::UnsupportedPlatform) }
#[cfg(not(windows))]
pub fn open() -> Result<(), AppError> { Err(AppError::UnsupportedPlatform) }

#[cfg(all(windows, test))]
mod tests {
    use super::open_worker;

    #[test]
    fn desktop_worker_reports_live_steps_without_leaving_a_file() {
        use std::{process::Command, sync::Mutex};
        let path = std::env::temp_dir().join(format!("claude-progress-{}.tmp", uuid::Uuid::new_v4()));
        let sender = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/app/claude_desktop.ps1");
        let observed = Mutex::new(Vec::new());
        // Load only the production reporter; this test does not deploy or launch Claude.
        let script = r#"
            $ErrorActionPreference = 'Stop'
            $ast = [Management.Automation.Language.Parser]::ParseFile($env:TEST_SENDER,[ref]$null,[ref]$null)
            $fn = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Show-InstallStep'},$true)
            . ([scriptblock]::Create($fn.Extent.Text))
            $action = 'prepare'
            foreach ($part in 'skills','models','connections') {
                Show-InstallStep $part
                Start-Sleep -Milliseconds 800
            }
            exit 37
        "#;
        let result = super::with_install_progress(&path, &|name| observed.lock().unwrap().push(name), || {
            Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("TEST_SENDER", sender).env("CAM_CLAUDE_PROGRESS", &path).status().unwrap()
        });
        assert_eq!(result.code(), Some(37));
        assert_eq!(*observed.lock().unwrap(), ["skills", "models", "connections"]);
        assert!(!path.exists());
    }

    #[test]
    fn only_matching_worker_can_receive_the_install_request() {
        let path = std::env::temp_dir().join(format!("claude-worker-{}.ps1", uuid::Uuid::new_v4()));
        let body = concat!("\u{feff}", include_str!("claude_desktop.ps1")).replace("\r\n", "\n");
        std::fs::write(&path, body).unwrap();
        let locked = open_worker(&path).unwrap();
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        drop(locked);
        std::fs::write(&path, b"exit 0").unwrap();
        assert!(open_worker(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
