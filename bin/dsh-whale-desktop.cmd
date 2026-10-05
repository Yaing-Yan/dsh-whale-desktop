@echo off
rem dsh-whale-desktop 启动器（Windows）
rem 开始菜单快捷方式指向这里：确保上游前端就位后拉起 Electron。
setlocal
set "APP_DIR=%~dp0.."
cd /d "%APP_DIR%"

if not exist "%APP_DIR%\node_modules\electron\dist\electron.exe" (
  echo dsh-whale-desktop: Electron not found. Run "npm install" in %APP_DIR% first.
  exit /b 1
)

if not exist "%APP_DIR%\vendor\dsh-whale-widget\assets\whale-widget.js" (
  node "%APP_DIR%\scripts\fetch-widget.mjs" --if-missing >nul 2>&1
)

start "" "%APP_DIR%\node_modules\electron\dist\electron.exe" "%APP_DIR%" %*
endlocal
