@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "desktop=%LOCALAPPDATA%\AnthropicClaude\app-6.28899.2"
set "seed=%desktop%\resources\preseed\claude-code"
if not exist "%~dp0Claude-6.28899.2-x64-offline.exe" goto incomplete
if not exist "%~dp0claude-code-2.1.328-win32-x64.exe.zst" goto incomplete
if exist "%LOCALAPPDATA%\AnthropicClaude\Update.exe" goto existing

echo [1/3] 正在为当前 Windows 用户安装官方 Claude Desktop...
start "" /wait "%~dp0Claude-6.28899.2-x64-offline.exe" --silent
if errorlevel 1 goto failed
if not exist "%desktop%\claude.exe" goto failed

:resume
echo [2/3] 正在放置官方 Code 离线运行时...
if not exist "%seed%\" mkdir "%seed%"
if not exist "%seed%\" goto failed
copy /b /y "%~dp0claude-code-2.1.328-win32-x64.exe.zst" "%seed%\win32-x64.zst.partial" >nul
if errorlevel 1 goto failed
move /y "%seed%\win32-x64.zst.partial" "%seed%\win32-x64.zst" >nul
if errorlevel 1 goto failed

:open
echo [3/3] 正在打开刚安装的 Claude Desktop...
start "" /d "%desktop%" "%desktop%\claude.exe"
exit /b %errorlevel%

:incomplete
echo 请完整解压 ZIP，再双击本文件。
goto quit
:existing
for /d %%V in ("%LOCALAPPDATA%\AnthropicClaude\app-*") do if /i not "%%~nxV"=="app-6.28899.2" goto version
if not exist "%desktop%\claude.exe" goto version
if exist "%seed%\win32-x64.zst" goto open
echo 已安装同版本，继续放置 Code 离线介质。
goto resume
:version
echo 已有其他版本的个人 Claude 安装。请保留该安装，本包用于全新安装。
goto quit
:failed
echo 本次安装未完成，请保留此窗口的提示。
:quit
pause
exit /b 1
