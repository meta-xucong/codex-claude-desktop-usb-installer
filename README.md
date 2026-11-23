# Codex 与 Claude Desktop 双客户端 U 盘管理器

Windows x64 双客户端开发仓库。管理器提供「一键安装 Codex 和 Claude」以及两个独立的启动入口。本仓库的起点是 2026-11-23 的双客户端开发源码。纯 Codex 发行线由[原仓库的稳定标签](https://github.com/meta-xucong/codex-desktop-usb-installer/tree/usb-runtime-261117-1122)维护。

## 开发入口

| 内容 | 文件 |
| --- | --- |
| 管理器首页和 Claude 操作 | [OfflineHome.tsx](src/app/views/OfflineHome.tsx)、[ClaudeDesktopAction.tsx](src/app/views/ClaudeDesktopAction.tsx) |
| Windows 端安装、启动、凭据交接和设置同步 | [claude_desktop.rs](src-tauri/src/app/claude_desktop.rs)、[配置同步脚本](src-tauri/src/app/claude_shared.py) |
| 双客户端 U 盘制作 | [build-oneclick-usb-layout.ps1](tools/build-oneclick-usb-layout.ps1) |
| 配套的 CCSwitch 源码补丁和构建入口 | [产品补丁](src-tauri/resources/ccswitch/source-patches/ccswitch-usb-product-85ad4969.patch)、[构建脚本](tools/build-ccswitch-with-env-patch.ps1) |
| 更新源和 Windows 回归 | [更新同步脚本](tools/claude-update-relay-sync.py)、[Windows worker 测试](crates/codex-win-engine/tests/claude_worker_windows.rs)、[设置保留测试](tools/test-claude-shared.py) |

在仓库根目录运行 `npm ci` 安装前端依赖，`npm run dev` 启动 Vite 开发界面，`npm run check` 进行类型检查。Windows 桌面和发行构建另需 Rust/MSVC 与下列发行输入。

## 还原离线构建输入

1. 将纯 Codex 稳定源码检出到相邻目录。把该标签下 `installer-pack/runtime/bundled/` 的运行时归档、安装程序和 `python-wheels/` 按原层级放回本仓库，并将同一标签的 CUA helper 放回 `src-tauri/resources/codex-cua-helper-experiment/codex-computer-use-mta-wrapper-candidate-v3.exe`。[固定源码标签](https://github.com/meta-xucong/codex-desktop-usb-installer/tree/usb-runtime-261117-1122)
2. 按离线说明获取 Chrome Headless Shell、FFmpeg GPL 和 HyperFrames 三个 Release 附件。Codex MSIX、VC++ 和 WebView2 离线安装程序仍按原构建流程准备。[离线输入清单与下载命令](docs/OFFLINE-BUILD-INPUTS-20261116.md)
3. 用本仓库的 `tools/build-ccswitch-with-env-patch.ps1` 从固定上游版本及双客户端补丁生成配套 CCSwitch，将产物目录传给 `tools/build-installer.ps1 -CcswitchArtifactDir`。USB CUA 版本使用该构建入口的 `-UsbCuaHelper` 参数；正式签名材料由发布方在本机提供。
4. 在同一介质目录准备 `Claude-6.28899.2-x64-offline.exe` 和 `claude-code-2.1.328-win32-x64.exe.zst`。沿用原有的安装器与 USB 布局构建参数，并向 `tools/build-oneclick-usb-layout.ps1` 传入 `-ClaudeMediaSource <介质目录>`。脚本将两份文件及与管理器配套的 worker 写入输出包。

账号、签名库、客户 U 盘许可证和实际运行记录由持有人在本地管理。
