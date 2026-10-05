// dsh-whale-desktop —— 注册到系统「应用列表」
//
//   node scripts/install-app.mjs            安装（开始菜单/启动器/Spotlight 里出现）
//   node scripts/install-app.mjs --uninstall 卸载
//
// 各平台落地方式：
//   Linux   → ~/.local/share/applications/dsh-whale-desktop.desktop
//             + ~/.local/share/icons/hicolor/<size>/apps/dsh-whale-desktop.png
//             + 刷新 desktop/icon 缓存（有对应命令才刷）
//   macOS   → ~/Applications/DSH 小鲸鱼.app（最小 .app 包装，含 Info.plist 与图标）
//   Windows → 开始菜单快捷方式（PowerShell WScript.Shell）
//
// 打包安装版（electron-builder）会自动带 .desktop / 开始菜单项，无需本脚本。

import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.join(__dirname, '..')
const APP_ID = 'dsh-whale-desktop'
const APP_NAME = 'DSH 小鲸鱼（桌面版）'
const APP_COMMENT = '独立桌面版 DSH 小鲸鱼挂件：透明悬浮窗，实时余额/消耗/提问·授权提示'
const uninstall = process.argv.includes('--uninstall')

function log(...a) { console.log('[install-app]', ...a) }
function warn(msg) { console.warn('[install-app] 提示：' + msg) }
function tryRun(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }) ; return true } catch { return false }
}

const launcher = path.join(APP_DIR, 'bin', 'dsh-whale-desktop')

function ensureLauncher() {
  if (process.platform === 'win32') return
  if (!existsSync(launcher)) throw new Error('缺少启动器 ' + launcher)
  chmodSync(launcher, 0o755)
}

function linux() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  const appsDir = path.join(dataHome, 'applications')
  const desktopFile = path.join(appsDir, APP_ID + '.desktop')
  const iconsBase = path.join(dataHome, 'icons', 'hicolor')

  if (uninstall) {
    rmSync(desktopFile, { force: true })
    for (const size of ['32x32', '64x64', '128x128', '256x256', '512x512']) {
      rmSync(path.join(iconsBase, size, 'apps', APP_ID + '.png'), { force: true })
    }
    tryRun('update-desktop-database', [appsDir])
    log('已从应用列表移除：', desktopFile)
    return
  }

  ensureLauncher()
  if (!existsSync(path.join(APP_DIR, 'assets', 'icon.png'))) {
    warn('未找到应用图标，请先执行 npm run icons（或直接跑 npm run install:app，它会先生成图标）')
  }
  // 图标按 hicolor 规范分尺寸安装，桌面环境会挑最合适的一张
  const iconMap = [['32x32', 'icon-32.png'], ['64x64', 'icon-64.png'], ['128x128', 'icon-128.png'], ['256x256', 'icon-256.png'], ['512x512', 'icon.png']]
  for (const [size, file] of iconMap) {
    const src = path.join(APP_DIR, 'assets', file)
    if (!existsSync(src)) continue
    const dstDir = path.join(iconsBase, size, 'apps')
    mkdirSync(dstDir, { recursive: true })
    copyFileSync(src, path.join(dstDir, APP_ID + '.png'))
  }

  // .desktop：Exec 指向启动器（脚本里再解析路径/按需拉取上游前端），StartupWMClass 与 Electron 的 wm_class 一致，
  // 这样窗口能被正确归到这个图标上（alt-tab / 任务栏分组）。
  const desktop = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${APP_NAME}`,
    'Name[en]=DSH Whale Widget (Desktop)',
    `Comment=${APP_COMMENT}`,
    `Comment[en]=Standalone desktop whale widget for DSH`,
    `Exec=${launcher}`,
    `TryExec=${launcher}`,
    `Icon=${APP_ID}`,
    `StartupWMClass=${APP_ID}`,
    'Terminal=false',
    'Categories=Utility;',
    'Keywords=DSH;DeepSeek;whale;balance;挂件;余额;小鲸鱼;',
    'StartupNotify=false',
    '',
  ].join('\n')
  mkdirSync(appsDir, { recursive: true })
  writeFileSync(desktopFile, desktop, 'utf8')

  tryRun('update-desktop-database', [appsDir])
  tryRun('gtk-update-icon-cache', ['-f', '-t', iconsBase])
  log('已加入应用列表：', desktopFile)
  log('启动命令：', launcher)
}

function macos() {
  const appBundle = path.join(os.homedir(), 'Applications', 'DSH 小鲸鱼.app')
  if (uninstall) {
    rmSync(appBundle, { recursive: true, force: true })
    log('已移除：', appBundle)
    return
  }
  ensureLauncher()
  const macOsDir = path.join(appBundle, 'Contents', 'MacOS')
  const resDir = path.join(appBundle, 'Contents', 'Resources')
  mkdirSync(macOsDir, { recursive: true })
  mkdirSync(resDir, { recursive: true })
  writeFileSync(path.join(appBundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>DSH 小鲸鱼</string>
  <key>CFBundleDisplayName</key><string>DSH 小鲸鱼（桌面版）</string>
  <key>CFBundleIdentifier</key><string>io.github.${APP_ID}</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`, 'utf8')
  writeFileSync(path.join(macOsDir, 'launch'), `#!/bin/bash\nexec "${launcher}" "$@"\n`, 'utf8')
  chmodSync(path.join(macOsDir, 'launch'), 0o755)
  // 图标：有 iconutil 就转 .icns，否则退化为 png（仍可被 Finder 显示）
  const png = path.join(APP_DIR, 'assets', 'icon.png')
  const iconset = path.join(resDir, 'icon.iconset')
  let madeIcns = false
  try {
    mkdirSync(iconset, { recursive: true })
    for (const s of [16, 32, 64, 128, 256, 512]) {
      execSync(`sips -z ${s} ${s} "${png}" --out "${path.join(iconset, `icon_${s}x${s}.png`)}"`, { stdio: 'ignore' })
    }
    execSync(`iconutil -c icns "${iconset}" -o "${path.join(resDir, 'icon.icns')}"`, { stdio: 'ignore' })
    rmSync(iconset, { recursive: true, force: true })
    madeIcns = true
  } catch { /* 非 macOS 或无 sips/iconutil */ }
  if (!madeIcns) copyFileSync(png, path.join(resDir, 'icon.png'))
  log('已创建应用：', appBundle, '（可在 Spotlight/启动台搜到）')
}

function windows() {
  ensureLauncher()
  const cmd = path.join(APP_DIR, 'bin', `${APP_ID}.cmd`)
  const startMenu = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const link = path.join(startMenu, `${APP_NAME}.lnk`)
  if (uninstall) {
    try { rmSync(link, { force: true }) } catch { /* ignore */ }
    log('已移除开始菜单快捷方式：', link)
    return
  }
  mkdirSync(startMenu, { recursive: true })
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell;',
    `$sc = $ws.CreateShortcut('${link.replace(/'/g, "''")}');`,
    `$sc.TargetPath = '${cmd.replace(/'/g, "''")}';`,
    `$sc.WorkingDirectory = '${APP_DIR.replace(/'/g, "''")}';`,
    `$sc.IconLocation = '${path.join(APP_DIR, 'assets', 'icon-256.png').replace(/'/g, "''")}';`,
    `$sc.Description = '${APP_COMMENT.replace(/'/g, "''")}';`,
    '$sc.Save()',
  ].join(' ')
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
    log('已加入开始菜单：', link)
  } catch (err) {
    warn('创建快捷方式失败（可手动把 bin\\' + APP_ID + '.cmd 固定到开始菜单）：' + err.message)
  }
}

try {
  if (process.platform === 'linux') linux()
  else if (process.platform === 'darwin') macos()
  else if (process.platform === 'win32') windows()
  else warn('未知平台 ' + process.platform + '，跳过')
} catch (err) {
  console.error('[install-app] 失败：' + ((err && err.message) || err))
  process.exit(1)
}
