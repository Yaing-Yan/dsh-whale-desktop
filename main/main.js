// dsh-whale-desktop —— Electron 主进程
// 透明无边框悬浮窗 + 托盘 + 与 DSH 的只读数据通道（经本地代理）+ 独立本地设置。

import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dshHome, loadBrowserSessionSecret, mintCookie } from './auth.js'
import { loadPatchedWidget, pluginDir } from './patch.js'
import { createServer } from './proxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'

// —— 单实例 ——
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let win = null
let tray = null
let server = null
let dshConfig = null
let lastFitAt = 0
let lastFitTarget = null // 最近一次渲染层要求的目标尺寸；用于“尺寸自愈”（托盘显示/重新映射后纠正漂移）

const DSH_DEFAULT_ORIGIN = 'http://127.0.0.1:3080'

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
function writeJson(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch { /* 忽略 */ }
}

/** DSH 连接配置：env > userData/dsh.json > 默认 127.0.0.1:3080 */
function resolveDshConfig() {
  const saved = readJson(path.join(app.getPath('userData'), 'settings', 'dsh.json')) || {}
  let origin = process.env.DSHW_DSH_ORIGIN || saved.origin || DSH_DEFAULT_ORIGIN
  if (process.env.DSHW_DSH_PORT) origin = `http://127.0.0.1:${process.env.DSHW_DSH_PORT}`
  let u
  try { u = new URL(origin) } catch {
    u = new URL(DSH_DEFAULT_ORIGIN)
    origin = DSH_DEFAULT_ORIGIN
  }
  return { origin, authority: u.host }
}

function loadAuth() {
  const home = dshHome()
  const secret = loadBrowserSessionSecret(home)
  if (!secret) return { cookie: null, error: `未找到 ${path.join(home, '.credentials.yaml')} 里的浏览器会话密钥（需要先运行一次 dsh web）` }
  try {
    const c = mintCookie(secret, dshConfig.authority)
    return { cookie: c.header, error: null }
  } catch (err) {
    return { cookie: null, error: String((err && err.message) || err) }
  }
}

function loadWindowState() {
  const s = readJson(path.join(app.getPath('userData'), 'settings', 'window.json'))
  if (s && typeof s.x === 'number' && typeof s.y === 'number' && typeof s.w === 'number' && typeof s.h === 'number') {
    return s
  }
  return { x: undefined, y: undefined, w: 900, h: 780 }
}

/** 按本机挂件设置里的缩放直接算出初始窗口尺寸，避免启动/重新映射时先出现一个巨大的透明窗。 */
function initialWindowSize() {
  const s = readJson(path.join(app.getPath('userData'), 'settings', 'size.json')) || {}
  let scale = typeof s.scale === 'number' && s.scale >= 0.6 && s.scale <= 2.5 ? s.scale : 1.0
  const base = Math.max(122, Math.min(250 * scale, 625))
  const side = Math.round(base + 20) // 与 fit 的 2×10px 边距一致
  return { w: side, h: side }
}

function saveWindowState(bounds) {
  writeJson(path.join(app.getPath('userData'), 'settings', 'window.json'), {
    x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height,
  })
}

function createWindow() {
  const ws = loadWindowState()
  const initSize = initialWindowSize()
  // 平台兜底：部分 X11 无合成器 / WSL 旧版 / 特殊 WM 下透明窗会渲染成黑底，
  // 允许用户在本机 settings/dsh.json 里配置 "backgroundColor": "#1e293b" 改用不透明底。
  const ui = readJson(path.join(app.getPath('userData'), 'settings', 'dsh.json')) || {}
  const transparent = ui.backgroundColor !== undefined ? false : true
  const backgroundColor = ui.backgroundColor || '#00000000'
  // 多显示器 / 分辨率变化后，保存的位置可能跑到屏幕外：夹回主屏可视区
  let x = ws.x, y = ws.y
  if (typeof x === 'number' && typeof y === 'number') {
    try {
      const disp = screen.getAllDisplays()
      const visible = disp.some((d) => x >= d.bounds.x - 50 && y >= d.bounds.y - 50 && x < d.bounds.x + d.bounds.width - 50 && y < d.bounds.y + d.bounds.height - 50)
      if (!visible) { x = undefined; y = undefined }
    } catch { /* 保持原样 */ }
  }
  win = new BrowserWindow({
    x,
    y,
    width: initSize.w,
    height: initSize.h,
    transparent,
    frame: false,
    // 注意：不要设 resizable:false —— 部分 Wayland 合成器（Hyprland 等）会把
    // 固定尺寸窗口的 setBounds/setSize 直接忽略，导致窗口永远缩不回鲸鱼大小。
    // 保持可缩放，靠自适应 fit 循环在 250ms 内把任何手动拉伸纠正回来。
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    backgroundColor,
    // 窗口/任务栏图标（Linux 上还会通过 StartupWMClass 与应用列表项关联）
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 显式声明“不忽略鼠标事件”：Electron 在 Wayland 上通过 wl_surface 输入区域实现
  // setIgnoreMouseEvents，个别合成器/版本对透明窗默认输入区域为空（点击直接穿透）。
  // 这里强制把输入区域设为全窗口，杜绝穿透。
  try { win.setIgnoreMouseEvents(false) } catch { /* 非 Wayland 平台无副作用 */ }
  if (process.platform === 'linux') {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { /* 可选 */ }
  }
  win.loadURL(`http://127.0.0.1:${server.port}/`)
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`)
  })
  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.log('[renderer did-fail-load]', code, desc)
  })
  win.once('ready-to-show', () => { win.show() })
  // 托盘再次显示 / 合成器重新映射后，窗口尺寸可能漂移成一个巨大的透明窗：
  // 立刻按最近的目标尺寸纠正，并同步朝向。
  win.on('show', () => { ensureWindowSize(); sendFlip() })
  win.on('close', () => {
    if (win) saveWindowState(win.getBounds())
  })
  win.on('closed', () => { win = null })
}
/** Linux 浮窗兜底：Hyprland 默认平铺新窗口，运行时注入 float 规则（不落盘，重启即还原）。
 *  注意：no_focus 会让合成器把该窗口当“不可交互”处理（实测点击直接穿透），所以这里
 *  刻意不加 no_focus；需要“点击不抢键盘焦点”请用 noinitialfocus（只影响启动时的焦点）。 */
function applyLinuxFloatHint() {
  if (process.platform !== 'linux') return
  const ui = readJson(path.join(app.getPath('userData'), 'settings', 'dsh.json')) || {}
  if (ui.hyprlandFloat === false) return
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return
  const cls = '^(dsh-whale-desktop)$'
  try {
    // Hyprland ≥0.5x（Lua 配置）：非 legacy 解析器，走 eval
    execFile('hyprctl', ['eval', `hl.window_rule({ match = { class = "${cls}" }, float = true, border_size = 0, rounding = 0 })`], { timeout: 4000 }, () => {})
    // 旧版 Hyprland：legacy keyword（失败静默，无碍）
    execFile('hyprctl', ['keyword', 'windowrule', `float, class:${cls}`], { timeout: 4000 }, () => {})
  } catch { /* 无 hyprctl 则忽略 */ }
}

function setupTray() {
  try {
    // 托盘图标用生成的应用图标（npm run icons 产出）；依次回退到 512 图标、上游角色图
    const candidates = [
      path.join(__dirname, '..', 'assets', 'icon-32.png'),
      path.join(__dirname, '..', 'assets', 'icon.png'),
    ]
    let image = nativeImage.createEmpty()
    for (const p of candidates) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) { image = img; break }
    }
    if (image.isEmpty()) {
      // 兜底：运行时从插件/上游目录读角色图
      try {
        image = nativeImage.createFromPath(path.join(pluginDir(), 'assets', 'DSniang02.png'))
      } catch { /* ignore */ }
    }
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip('DSH 小鲸鱼（桌面版）')
    const menu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show() } },
      { label: 'DSH 连接', enabled: false, toolTip: dshConfig.origin },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
    tray.setContextMenu(menu)
    tray.on('click', () => { if (win) (win.isVisible() ? win.hide() : win.show()) })
  } catch (err) {
    // 某些 Linux 桌面没有托盘区（WSLg / 精简 WM）：挂件照常可用，只是少了托盘入口
    console.log('[dsh-whale-desktop] 托盘不可用（不影响挂件）:', String((err && err.message) || err))
  }
}

// —— IPC：窗口拖拽 / 自适应尺寸 ——
//
// 平台差异（重要）：
//  - X11 / Windows / macOS：客户端可以直接 setPosition / setBounds。
//  - Wayland（Hyprland / KDE / GNOME）：协议不允许客户端自定位 —— setPosition 是空操作；
//    窗口移动必须走合成器。Hyprland 0.5x 用 Lua 配置，正确姿势是
//    `hyprctl eval 'hl.dispatch(hl.dsp.window.move({ x,y, relative=true, window="class:…" }))'`，
//    缩放同理 `hl.dsp.window.resize({ x,y, window="class:…" })`（合成器决定锚点，缩放后
//    再按 hyprctl 实测坐标补偿位移，把鲸鱼钉回原屏幕位置）。其它 Wayland 合成器无公开
//    外部移动 API：只能依赖 Alt+拖拽等合成器手势（README 说明）。

function isHyprland() {
  return process.platform === 'linux' && !!process.env.HYPRLAND_INSTANCE_SIGNATURE
}

function hyprEval(code) {
  return new Promise((resolve) => {
    try {
      execFile('hyprctl', ['eval', code], { timeout: 3000 }, (err) => resolve(!err))
    } catch { resolve(false) }
  })
}

/** 从 hyprctl 读取本挂件窗口在合成器眼中的真实边界（Wayland 上 Electron 自己的数值不可信）。 */
function hyprBounds() {
  return new Promise((resolve) => {
    if (!isHyprland()) return resolve(null)
    try {
      execFile('hyprctl', ['clients', '-j'], { timeout: 3000 }, (err, out) => {
        if (err) return resolve(null)
        try {
          const list = JSON.parse(out)
          const c = list.find((w) => (w.class || '') === 'dsh-whale-desktop')
          if (c && Array.isArray(c.at) && Array.isArray(c.size)) {
            resolve({ x: c.at[0], y: c.at[1], w: c.size[0], h: c.size[1] })
          } else resolve(null)
        } catch { resolve(null) }
      })
    } catch { resolve(null) }
  })
}

/** Wayland 上拖动窗口：hyprctl 相对移动；其余平台 setPosition。 */
async function moveWindowBy(dx, dy) {
  if (!win) return
  dx = Math.round(dx || 0)
  dy = Math.round(dy || 0)
  if (dx === 0 && dy === 0) return
  if (isHyprland()) {
    await hyprEval(`hl.dispatch(hl.dsp.window.move({ x = ${dx}, y = ${dy}, relative = true, window = "class:^(dsh-whale-desktop)$" }))`)
  } else {
    const [x, y] = win.getPosition()
    win.setPosition(x + dx, y + dy)
  }
}

/** 缩放窗口并保持鲸鱼（窗口右下角）在屏幕上的位置不动。 */
async function resizeWindowTo(w, h) {
  if (!win) return
  w = Math.max(120, Math.min(Math.ceil(w), 2600))
  h = Math.max(120, Math.min(Math.ceil(h), 2600))
  // 已在目标尺寸则跳过（Wayland 上 win.getBounds 不可信，用 hyprctl 实测）；±6px 死区防抖动
  const cur = isHyprland() ? await hyprBounds() : win.getBounds()
  if (cur && Math.abs(cur.w - w) < 6 && Math.abs(cur.h - h) < 6) return
  const before = isHyprland() ? cur : null
  if (isHyprland()) {
    await hyprEval(`hl.dispatch(hl.dsp.window.resize({ x = ${w}, y = ${h}, window = "class:^(dsh-whale-desktop)$" }))`)
    // 合成器按自己的锚点缩放，鲸鱼可能被挪走：用实测坐标把鲸鱼右下角钉回原位
    if (before) {
      const after = await hyprBounds()
      if (after) {
        const whaleBRx = before.x + before.w
        const whaleBRy = before.y + before.h
        const dx = whaleBRx - (after.x + after.w)
        const dy = whaleBRy - (after.y + after.h)
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          await hyprEval(`hl.dispatch(hl.dsp.window.move({ x = ${Math.round(dx)}, y = ${Math.round(dy)}, relative = true, window = "class:^(dsh-whale-desktop)$" }))`)
        }
      }
    }
  } else {
    const bounds = win.getBounds()
    const nx = bounds.x - (w - bounds.width)
    const ny = bounds.y - (h - bounds.height)
    win.setBounds({ x: Math.round(nx), y: Math.round(ny), width: w, height: h })
  }
}

async function saveWindowStateNow() {
  if (!win) return
  const b = await hyprBounds()
  if (b) saveWindowState({ x: b.x, y: b.y, width: b.w, height: b.h })
  else saveWindowState(win.getBounds())
}

/** 鲸鱼朝向：窗口在屏幕左半 => 镜像（面朝右，同浏览器“贴左吸附翻转”语义）。 */
async function sendFlip() {
  if (!win) return
  try {
    const b = isHyprland() ? await hyprBounds() : win.getBounds()
    if (!b) return
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    const disp = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.w, height: b.h })
    const centerX = disp.bounds.x + disp.bounds.width / 2
    const flip = cx < centerX
    if (win && !win.isDestroyed()) win.webContents.send('win:setFlip', flip)
  } catch { /* ignore */ }
}

/** 尺寸自愈：实际尺寸偏离最近目标超过 6px 时纠正。
 *  解决“托盘二次点击/合成器重新映射后出现巨大透明窗、要激活一下才恢复”的问题。 */
async function ensureWindowSize() {
  if (!win || !lastFitTarget) return
  try {
    const cur = isHyprland() ? await hyprBounds() : win.getBounds()
    if (!cur) return
    if (Math.abs(cur.w - lastFitTarget.w) > 6 || Math.abs(cur.h - lastFitTarget.h) > 6) {
      await resizeWindowTo(lastFitTarget.w, lastFitTarget.h)
    }
  } catch { /* ignore */ }
}

ipcMain.on('win:moveBy', (e, { dx, dy }) => { moveWindowBy(dx, dy); sendFlip() })
ipcMain.on('win:dragEnd', () => { saveWindowStateNow(); sendFlip() })
ipcMain.on('win:fit', (e, info) => {
  if (!win || !info) return
  const now = Date.now()
  if (now - lastFitAt < 120) return
  lastFitAt = now
  try {
    const M = 10 // 边距
    const rootW = info.rootW, rootH = info.rootH
    if (!(rootW > 0) || !(rootH > 0)) return
    const vw = typeof info.vw === 'number' ? info.vw : rootW + 2 * M
    const vh = typeof info.vh === 'number' ? info.vh : rootH + 2 * M
    // 基础尺寸 = 鲸鱼尺寸 + 边距；其它可见 UI（菜单/面板）超出部分再扩张
    let w = rootW + 2 * M
    let h = rootH + 2 * M
    const items = Array.isArray(info.items) ? info.items : []
    for (const it of items) {
      if (typeof it.r !== 'number' || typeof it.b !== 'number') continue
      const l = typeof it.l === 'number' ? it.l : M
      const t = typeof it.t === 'number' ? it.t : M
      const b = it.b, r = it.r
      // 贴底锚定（挂件菜单：style.bottom + style.top:auto，向上生长）：
      // 窗口高度变化时它跟着底边走，所需高度恒为「它到窗底的距离 + 自身高度 + 边距」
      //   = (vh - t) + M
      // 无论当前是否已完整可见都要用这条 —— 否则「已可见时按底边算 → 缩小 → 又溢出 → 放大」
      // 会在两个尺寸之间无限来回跳。贴顶元素则按常规包含（b + M）。
      if (it.ab) h = Math.max(h, (vh - t) + M)
      else h = Math.max(h, b + M)
      // 水平同理（贴右锚定：style.right + style.left:auto）
      if (it.ar) w = Math.max(w, (vw - l) + M)
      else w = Math.max(w, r + M)
    }
    resizeWindowTo(w, h)
    lastFitTarget = { w, h }
    sendFlip()
  } catch { /* ignore */ }
})
ipcMain.handle('boot:info', () => {
  return {
    dshOrigin: dshConfig.origin,
    home: dshHome(),
    auth: authState.cookie ? true : false,
    authError: authState.error,
    widgetOk: widgetState.js ? true : false,
    widgetError: widgetState.error || null,
    widgetVersion: widgetState.version || null,
    widgetSource: widgetState.kind || null,
    widgetDir: widgetState.dir || null,
    widgetApplied: widgetState.applied || [],
    widgetMissing: widgetState.missing || [],
  }
})

let authState = { cookie: null, error: null }
let widgetState = { js: null, error: null }

app.whenReady().then(async () => {
  // macOS：桌面挂件不占 Dock（仍然可经托盘/快捷键唤出）
  if (isMac) {
    try { app.dock.hide() } catch { /* ignore */ }
  }
  dshConfig = resolveDshConfig()
  authState = loadAuth()
  widgetState = loadPatchedWidget(app.getPath('userData'))
  server = await createServer({
    userDataDir: app.getPath('userData'),
    dshHome: dshHome(),
    dshOrigin: dshConfig.origin,
    cookie: authState.cookie,
    widget: widgetState,
    rendererDir: path.join(__dirname, '..', 'renderer'),
  })
  console.log('[dsh-whale-desktop] DSH origin:', dshConfig.origin, '| auth:', authState.cookie ? 'ok' : 'FAIL', authState.error || '')
  console.log('[dsh-whale-desktop] widget source:', widgetState.kind || 'none', 'v' + (widgetState.version || '?'), '→', widgetState.dir || '(无)')
  console.log('[dsh-whale-desktop] widget patches applied:', (widgetState.applied || []).join(', '), '| missing:', (widgetState.missing || []).join(', ') || 'none')
  applyLinuxFloatHint()
  createWindow()
  setupTray()
  // 周期性：同步鲸鱼朝向 + 尺寸自愈（兜住托盘显示/合成器重映射导致的尺寸漂移）
  setTimeout(() => { ensureWindowSize(); sendFlip() }, 2500)
  setInterval(() => { ensureWindowSize(); sendFlip() }, 2000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (win) { win.show(); win.focus() }
})

app.on('before-quit', async () => {
  if (server) { try { await server.close() } catch { /* ignore */ } }
  server = null
})

app.on('window-all-closed', () => {
  if (!isMac) {
    // 托盘常驻：窗口关闭不退出（托盘「退出」才真正退出）
  }
})
