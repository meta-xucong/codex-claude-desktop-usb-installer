use crate::errors::AppError;
use std::path::Path;

#[cfg(windows)]
const DESKTOP_INSTALLER: &str = "payload/claude/Claude-6.28899.2-x64-offline.exe";

#[cfg(windows)]
fn stage_desktop(powershell: &Path, media_dir: &Path, updating: bool, expected: Option<&str>, progress: &(impl Fn(&str) + Sync)) -> Result<String, AppError> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    let script = media_dir.join("claude-desktop-stage.ps1");
    // The elevated child opens the script by name. Pin its ancestors and keep
    // the byte-checked file read-only until the child has exited.
    let _path_guard = super::uninstall_cleanup::pin_readonly_path(&script)
        .map_err(|e| AppError::Engine(format!("无法固定随包 Claude 部署脚本：{e}")))?;
    let _script_guard = open_worker(&script, include_str!("claude_stage_desktop.ps1"))?;
    let ps_home = powershell.parent().expect("system PowerShell executable has a parent");
    let operation = if updating { "update" } else { "install" };
    let failure = |phase: &str, e: std::io::Error| {
        log::warn!("Claude desktop stage action={operation} phase={phase} win32={:?}", e.raw_os_error());
        AppError::ClaudeDeployment(format!("{phase}：{e}"))
    };
    let mut child = std::process::Command::new(powershell)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", include_str!("claude_launch.ps1")])
        .current_dir(ps_home)
        .env("PSModulePath", ps_home.join("Modules"))
        .env("CAM_CLAUDE_MEDIA", super::capability_pack::powershell_provider_path(media_dir))
        .env("CAM_CLAUDE_ACTION", "stage")
        .env("CAM_CLAUDE_STAGE_ACTION", operation)
        .env("CAM_CLAUDE_EXPECTED_PAIR", expected.unwrap_or(""))
        .env_remove("CAM_CLAUDE_CONNECTION")
        .creation_flags(0x08000000)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| failure("启动部署进程", e))?;
    log::info!("Claude desktop stage action={operation} started pid={}", child.id());
    let stdout = child.stdout.take().expect("piped stdout");
    let (output, version) = std::thread::scope(|scope| {
        let reader = scope.spawn(move || -> std::io::Result<String> {
            use std::io::{BufRead, BufReader};
            let mut version = String::new();
            for line in BufReader::new(stdout).lines() {
                let line = line?;
                if let Some(stage) = line.strip_prefix("progress ") {
                    if updating { progress(stage); }
                } else if !line.trim().is_empty() {
                    version = line.trim().to_owned();
                }
            }
            Ok(version)
        });
        let output = child.wait_with_output().map_err(|e| failure("读取部署进程结果", e))?;
        let version = reader.join().map_err(|_| AppError::ClaudeDeployment("读取部署进度失败".into()))?
            .map_err(|e| failure("读取部署进度", e))?;
        Ok::<_, AppError>((output, version))
    })?;
    let code = output.status.code().unwrap_or(-1);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let reason = detail.lines().find(|s| s.starts_with("Claude deployment failed at line "));
        log::warn!("Claude desktop stage action={operation} exit={code} {}", reason.unwrap_or(""));
        let reason = reason.unwrap_or("");
        let download = if reason.contains("phase=desktop ") { Some("Claude 桌面安装包") }
            else if reason.contains("phase=code ") { Some("Claude Code 运行时") } else { None };
        let detail = reason.split_once("reason=").map_or("传输未完成", |(_, v)| v);
        let message = match (code, download) {
            (31, Some(file)) => format!("下载{file}失败（{detail}）。"),
            (39, _) => "Windows PowerShell 执行策略阻止了随包部署脚本。".to_owned(),
            (40, _) => "Windows PowerShell 无法加载随包部署脚本。".to_owned(),
            _ => format!("部署脚本已运行，退出码 {code}。{}", reason),
        };
        return Err(AppError::ClaudeDeployment(message));
    }
    if version.split('.').count() != 4 || !version.split('.').all(|n| n.parse::<u16>().is_ok()) {
        return Err(AppError::Engine("Claude 桌面部署未返回有效版本。".into()));
    }
    Ok(version)
}

pub fn included(root: &Path) -> bool {
    super::usb_bundle::includes_claude_desktop(root)
}

#[cfg(windows)]
fn open_worker(path: &Path, source: &str) -> Result<std::fs::File, AppError> {
    use std::io::Read;
    use std::os::windows::fs::OpenOptionsExt;
    // The worker receives the USB account on prepare. Keep the checked file
    // open without write/delete sharing until Windows PowerShell exits.
    let mut file = std::fs::OpenOptions::new().read(true).share_mode(1).open(path)
        .map_err(|e| AppError::Engine(format!("无法打开随包 Claude 安装脚本：{e}")))?;
    let expected = format!("\u{feff}{}", source.replace("\r\n", "\n"));
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
                if let Some(name) = ["register", "profile", "seed", "skills", "connections", "finalize"]
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
fn worker(action: &'static str, stage: impl Fn(&str) + Sync) -> Result<u32, AppError> {
    worker_for(action, stage, None)
}

#[cfg(windows)]
fn worker_for(action: &'static str, stage: impl Fn(&str) + Sync, model: Option<(&str, String)>) -> Result<u32, AppError> {
    worker_with_update(action, stage, model, None)
}

#[cfg(windows)]
fn worker_with_update(action: &'static str, stage: impl Fn(&str) + Sync, model: Option<(&str, String)>, expected: Option<&str>) -> Result<u32, AppError> {
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
    if let Some((expected, payload)) = model {
        if expected != identity { return Err(AppError::Engine("当前 U 盘账号已更换，请刷新模型目录。".into())); }
        env.push(("CAM_CLAUDE_MODEL_REQUEST".into(), payload.into()));
    }
    let mut progress_path = None;
    if matches!(action, "prepare" | "update" | "capabilities" | "skills" | "models" | "connections") {
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
    let verify_deployment_bundle = || -> Result<(), AppError> {
        let checked = usb_guard::require_signed_codex_bundle("claude-desktop-deploy")?
            .ok_or_else(|| AppError::Engine("Claude 安装需要已签名的 U 盘套件。".into()))?;
        if checked.bundle_root != root || checked.license_digest != identity {
            return Err(AppError::Engine("准备 Claude 时 U 盘绑定发生变化。".into()));
        }
        Ok(())
    };
    if action == "prepare" || action == "update" {
        verify_deployment_bundle()?;
    }
    if action == "prepare" {
        // Install and launch workers run as the interactive user. The worker removes
        // this hand-off from its environment before starting any child process.
        env.push(("CAM_CLAUDE_CONNECTION".into(), OsString::from(&key)));
        env.push(("CAM_CLAUDE_SWITCH".into(), root.join("ccswitch").join(super::ccswitch::CCSWITCH_EXECUTABLE).into()));
        env.push(("CAM_CLAUDE_HELPER_BODY".into(), include_str!("claude_credential.ps1").into()));
    }
    let powershell = super::runtime::windows_powershell()?;
    let script = root.join("payload/claude/claude-desktop-worker.ps1");
    let _worker_file = open_worker(&script, include_str!("claude_desktop.ps1"))?;
    let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
        include_str!("claude_launch.ps1")]
        .map(OsString::from);
    let run = |env: &[(OsString, OsString)]| {
        let lease = if action == "open" { Some(usb_guard::claude_session_lease(&identity)?) } else { None };
        let launch = || match lease {
            Some(id) => super::claude_session::launch(id, &powershell, &args, env),
            None => codex_win_engine::run_as_desktop_user(&powershell, &args, env),
        };
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
    if action == "open" && code == 48 {
        // Upgrade the previous shared setup once, before opening the desktop.
        verify_deployment_bundle()?;
        env.retain(|(k, _)| k != "CAM_CLAUDE_PREPARE_PART");
        env.push(("CAM_CLAUDE_PREPARE_PART".into(), "upgrade-shared".into()));
        env.push(("CAM_CLAUDE_CONNECTION".into(), key.into()));
        env.push(("CAM_CLAUDE_SWITCH".into(), root.join("ccswitch").join(super::ccswitch::CCSWITCH_EXECUTABLE).into()));
        env.push(("CAM_CLAUDE_CODEX_HOME".into(), usb_guard::local_data_paths()?.codex_home.into()));
        env.push(("CAM_CLAUDE_SHARED".into(), include_str!("claude_shared.py").into()));
        code = run(&env)?;
    }
    if (code == 41 && action == "prepare") || (code == 47 && action == "update") {
        stage(if action == "update" { "manifest" } else { "desktop" });
        let version = stage_desktop(&powershell, &root.join("payload/claude"), action == "update", expected, &stage)?;
        env.push(("CAM_CLAUDE_STAGED_VERSION".into(), version.into()));
        if action == "prepare" { stage("account"); } else { stage("activate"); }
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
        10 | 11 | 12 | 14 | 15 if action == "status" => Ok(code),
        13 if action == "update" => Ok(code),
        28 if matches!(action, "skills" | "connections" | "capabilities") => Ok(code),
        0 if action != "status" => Ok(0),
        _ => Err(AppError::Engine(match code {
            20 => "当前机器或用户已有 Claude 连接策略，请保留现有设置并检查冲突。",
            21 => "请保存工作并正常退出已打开的 Claude，再准备当前 U 盘账号。",
            22 => "Claude 离线介质不完整，请检查双端安装包。",
            23 => "本机 Claude 版本与随包 Code 运行时不匹配，已有版本已保留。",
            24 => "官方 Claude 桌面文件没有准备完成。",
            25 => "官方 Claude 未完成本地 Code 运行时准备。",
            26 => "Claude 桌面未能打开可响应的窗口。",
            27 => "Claude 本机连接配置保存失败。",
            28 => "请先在启动器完成本机的 Claude 安装和账号配置。",
            29 => "CCSwitch 未能把当前 U 盘的 404token 账号配置到 Claude Desktop。",
            30 => "未能从备用源取得 Claude 配对版本信息。",
            31 => "Claude 更新文件下载或核验失败，当前版本仍可使用。",
            33 => "Claude 更新尚未完成，请关闭 Claude 后在启动器继续恢复。",
            34 => "新版 Claude 桌面文件准备失败。",
            35 => "新版 Claude Code 运行时未就绪，已恢复旧版。",
            36 => "Claude 技能未同步完成，请重试当前操作。",
            37 => "Claude 模型设置未保存，请刷新当前列表后重试。",
            38 => "Claude 工具连接未同步完成，请重试当前操作。",
            39 => "Windows PowerShell 执行策略阻止了 Claude 安装助手。请联系本机管理员核对策略。",
            40 => "Windows PowerShell 未能加载随包 Claude 安装助手。请检查双端安装包和本机策略。",
            _ => return Err(AppError::Engine(format!("Claude 本机检查或部署失败（{code}）。"))),
        }.into())),
    }
}

pub fn sync_if_installed(_action: &'static str) -> Result<&'static str, AppError> {
    #[cfg(windows)]
    if super::usb_guard::current_bundle_root().as_deref().is_some_and(included) {
        let paths = super::usb_guard::local_data_paths()?;
        let record = paths.local_app_data
            .join("CodexAppManager/claude-desktop/connection.json");
        if !record.try_exists().map_err(|e| AppError::Engine(format!("无法读取 Claude 本机配置：{e}")))? {
            return Ok("pending");
        }
        let config = super::usb_host::read_config(&paths.codex_home)?;
        if !super::capability_pack::host_core_ready(&paths.codex_home, &config)? {
            return Ok("pending");
        }
        return Ok(if worker(_action, |_| {})? == 28 { "pending" } else { "synced" });
    }
    Ok("not_applicable")
}

#[cfg(windows)]
#[path = "claude_models.rs"]
pub mod models;

#[cfg(windows)]
pub fn status() -> Result<&'static str, AppError> {
    Ok(match worker("status", |_| {})? { 10 => "install", 11 => "prepare", 14 => "recover", 15 => "components-pending", _ => "ready" })
}
#[cfg(windows)]
fn desktop_version(value: &str) -> Option<[u16; 4]> {
    let parts = value.split('.').map(|p| p.parse::<u16>().ok()).collect::<Option<Vec<_>>>()?;
    let parts: [u16; 4] = parts.try_into().ok()?;
    (parts[3] == 0).then_some(parts)
}

#[cfg(windows)]
pub fn check_update() -> Result<serde_json::Value, AppError> {
    use serde_json::{Value, json};
    let base = super::usb_guard::local_data_paths()?.local_app_data.join("CodexAppManager/claude-desktop");
    if base.join("desktop-pending.json").try_exists().map_err(|e| AppError::Engine(e.to_string()))? { return Ok(json!({"kind":"recover"})); }
    let current = match std::fs::read_to_string(base.join("desktop-version")) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"kind":"notInstalled"})),
        Err(e) => return Err(AppError::Engine(e.to_string())),
    };
    let current = current.trim();
    let installed = desktop_version(current).ok_or_else(|| AppError::Engine("无法读取 Claude 当前版本。".into()))?;
    let unavailable = |_| AppError::Engine("无法读取 Claude 备用源版本清单。".into());
    let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(unavailable)?;
    let response = client.get("https://update.404token.xyz/__codex_update__/claude/squirrel/latest.json")
        .send().and_then(|r| r.error_for_status()).map_err(unavailable)?;
    let pair: Value = serde_json::from_reader(response).map_err(|_| AppError::Engine("Claude 版本清单格式错误。".into()))?;
    update_offer(current, installed, &pair)
}

#[cfg(windows)]
fn update_offer(current: &str, installed: [u16; 4], pair: &serde_json::Value) -> Result<serde_json::Value, AppError> {
    let latest_version = pair["desktop"].as_str().unwrap_or_default();
    let latest = desktop_version(latest_version).ok_or_else(|| AppError::Engine("Claude 版本清单缺少有效的桌面版本。".into()))?;
    let code = pair["code"].as_str().unwrap_or_default();
    if code.split('.').count()!=3 || !code.split('.').all(|s| s.parse::<u16>().is_ok()) {
        return Err(AppError::Engine("Claude 版本清单缺少有效的桌面或 Code 版本。".into()));
    }
    for key in ["exe","archive"] {
        if !pair[key].as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) {
            return Err(AppError::Engine("Claude 备用源缺少完整的桌面与 Code 配对发布信息。".into()));
        }
    }
    Ok(serde_json::json!({"kind":if latest>installed {"available"} else {"none"}, "currentVersion":current,
        "latestVersion":latest_version,"codeVersion":code,"expected":format!("{latest_version}/{code}")}))
}
#[cfg(not(windows))]
pub fn check_update() -> Result<serde_json::Value, AppError> { Err(AppError::UnsupportedPlatform) }

#[cfg(windows)]
pub fn update(expected: &str, stage: impl Fn(&str) + Sync) -> Result<bool, AppError> {
    if expected.is_empty() { return Err(AppError::Engine("请先检查 Claude 更新。".into())); }
    worker_with_update("update", stage, None, Some(expected)).map(|code| code != 13)
}
#[cfg(not(windows))]
pub fn update(_expected: &str, _stage: impl Fn(&str)) -> Result<bool, AppError> { Err(AppError::UnsupportedPlatform) }
#[cfg(windows)]
pub fn open() -> Result<(), AppError> { worker("open", |_| {}).map(|_| ()) }
#[cfg(windows)]
pub fn prepare(stage: impl Fn(&str) + Sync) -> Result<(), AppError> { worker("prepare", stage).map(|_| ()) }
#[cfg(not(windows))]
pub fn prepare(_stage: impl Fn(&str)) -> Result<(), AppError> { Err(AppError::UnsupportedPlatform) }
#[cfg(not(windows))]
pub fn status() -> Result<&'static str, AppError> { Err(AppError::UnsupportedPlatform) }
#[cfg(not(windows))]
pub fn open() -> Result<(), AppError> { Err(AppError::UnsupportedPlatform) }

#[cfg(all(windows, test))]
mod tests {
    use super::open_worker;

    #[test]
    fn independent_check_compares_numeric_versions_and_requires_both_assets() {
        let mut pair = serde_json::json!({"desktop":"6.10.1.0","code":"2.1.4","exe":"a".repeat(64),"archive":"b".repeat(64)});
        let offer = |v| super::update_offer(v, super::desktop_version(v).unwrap(), &pair);
        assert_eq!(offer("6.9.1.0").unwrap()["expected"], "6.10.1.0/2.1.4");
        assert_eq!(offer("6.10.1.0").unwrap()["kind"], "none");
        assert_eq!(offer("6.11.1.0").unwrap()["kind"], "none");
        pair.as_object_mut().unwrap().remove("archive");
        assert!(super::update_offer("6.9.1.0",[6,9,1,0],&pair).is_err());
    }

    #[test]
    fn deployment_rejects_the_desktop_worker_and_a_missing_powershell() {
        let root = std::env::temp_dir().join(format!("Claude QA 中文 {}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let script = root.join("claude-desktop-stage.ps1");
        let missing = root.join("missing.exe");
        let write = |src: &str| std::fs::write(&script, format!("\u{feff}{}", src.replace("\r\n", "\n"))).unwrap();
        write(include_str!("claude_desktop.ps1"));
        assert!(super::stage_desktop(&missing, &root, false, None, &|_| {}).unwrap_err().to_string().contains("不匹配"));
        write(include_str!("claude_stage_desktop.ps1"));
        for update in [false, true] {
            let err = super::stage_desktop(&missing, &root, update, None, &|_| {}).unwrap_err();
            assert_eq!(err.code(), "claude_deployment");
            assert!(err.to_string().contains("启动部署进程"));
        }
        std::fs::remove_file(script).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    // Run only inside Windows Sandbox with the release media copied to C:\QA\media.
    #[test]
    #[ignore = "deploys the official desktop in an isolated Windows Sandbox"]
    fn sandbox_first_install_and_reuse() {
        assert_eq!(std::env::var("USERNAME").as_deref(), Ok("WDAGUtilityAccount"));
        let ps = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let media = std::path::Path::new(r"C:\QA\media");
        for _ in 0..2 {
            assert_eq!(super::stage_desktop(&ps, media, false, None, &|_| {}).unwrap(), "6.28899.2.0");
        }
    }

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
            foreach ($part in 'skills','connections') {
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
        assert_eq!(*observed.lock().unwrap(), ["skills", "connections"]);
        assert!(!path.exists());
    }

    #[test]
    fn only_matching_worker_can_receive_the_install_request() {
        let path = std::env::temp_dir().join(format!("claude-worker-{}.ps1", uuid::Uuid::new_v4()));
        let body = concat!("\u{feff}", include_str!("claude_desktop.ps1")).replace("\r\n", "\n");
        std::fs::write(&path, body).unwrap();
        let locked = open_worker(&path, include_str!("claude_desktop.ps1")).unwrap();
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        drop(locked);
        std::fs::write(&path, b"exit 0").unwrap();
        assert!(open_worker(&path, include_str!("claude_desktop.ps1")).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
