// dsh-whale-desktop —— 前端「取源 + 适配」引擎
//
// 架构约定：本桌面壳**不内置、不硬编码** dsh-whale-widget 的前端源码。
// 上游是持续更新的项目、总体显示机制稳定 —— 编译期用 scripts/fetch-widget.mjs
// 从 npm 官方源拉取最新前端放进 vendor/（已 gitignore，不进仓库），运行时优先加载它；
// 本文件只负责「取源」和少量“桌面化”外科手术（字符串级替换、逐条断言命中）：
//
//  P1 boot gate  —— 原前端只在 DSH 主聊天界面（#root 有 composer）才初始化，
//                   桌面端没有 #root，改为 __DSHW_STANDALONE__ 时无条件启动。
//  P2 启动兜底   —— 独立模式下跳过 MutationObserver 等待，直接 dshwStartOnce()。
//  P3 拖拽桥     —— 原前端拖鲸鱼是在“页面内”移动挂件；桌面端把位移转成
//                   window.__dshwDesktop.dragMove(dx,dy)（主进程移动整个窗口），
//                   抬手/取消时通知 dragEnd 保存窗口位置。
//  P4 基准尺寸   —— 原 CSS 用 min(100vw,100vh)*0.28 定鲸鱼基准尺寸，桌面窗口
//                   跟随鲸鱼尺寸时该公式会退化到 122px 下限；独立模式改为
//                   clamp(122px, 250px*scale, 625px)，与浏览器 1080p 视觉一致。
//  P5 钉位/边距  —— express() 把 root 钉在窗口右下角并留四周对称边距（否则鲸鱼贴边被裁）。
//  P6 朝向       —— 独立模式下 state.flip 跟随主进程下发的 window.__DSHW_FLIP__。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './auth.js'

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 前端来源候选（按优先级）：
 *  1. DSHW_WIDGET_DIR 显式指定（调试/自定义）
 *  2. vendor/dsh-whale-widget —— **编译期拉取的上游源码**（打包后就用这份）
 *  3. 本机 DSH 已安装的插件目录 —— 开发期兜底（没跑过拉取脚本时仍能启动）
 */
export function widgetCandidates() {
  const list = []
  if (process.env.DSHW_WIDGET_DIR) list.push({ dir: process.env.DSHW_WIDGET_DIR, kind: 'env' })
  list.push({ dir: path.join(appRoot, 'vendor', 'dsh-whale-widget'), kind: 'vendor' })
  list.push({ dir: path.join(dshHome(), 'profiles', 'web', 'node_modules', 'dsh-whale-widget'), kind: 'dsh-plugin' })
  return list.filter((c) => c.dir)
}

function readVersion(dir) {
  try {
    const v = readFileSync(path.join(dir, 'VERSION'), 'utf8').trim()
    if (v) return v
  } catch { /* 无 VERSION 文件 */ }
  try { return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null } catch { return null }
}

/** 解析出实际使用的前端来源；找不到返回带说明的对象。 */
export function resolveWidgetSource() {
  const tried = []
  for (const c of widgetCandidates()) {
    const js = path.join(c.dir, 'assets', 'whale-widget.js')
    tried.push(c.dir)
    if (existsSync(js)) return { dir: c.dir, srcPath: js, kind: c.kind, version: readVersion(c.dir), tried }
  }
  return { dir: null, srcPath: null, kind: null, version: null, tried }
}

/** 兼容旧调用：返回解析到的来源目录（找不到时给第一个候选路径）。 */
export function pluginDir() {
  const r = resolveWidgetSource()
  return r.dir || (process.env.DSHW_PLUGIN_DIR || (widgetCandidates()[0] && widgetCandidates()[0].dir) || '')
}

const PATCHES = [
  {
    id: 'boot-gate-tryStart',
    critical: true,
    from: "if (dshwIsChatRoot(document.getElementById('root'))) { dshwStartOnce(); return true }",
    to: "if (window.__DSHW_STANDALONE__ || dshwIsChatRoot(document.getElementById('root'))) { dshwStartOnce(); return true }",
  },
  {
    id: 'boot-gate-outer',
    critical: true,
    from: "if (!dshwIsChatRoot(document.getElementById('root'))) {",
    to: "if (!window.__DSHW_STANDALONE__ && !dshwIsChatRoot(document.getElementById('root'))) {",
  },
  {
    id: 'boot-start-direct',
    critical: true,
    from: "} catch (err) {}\nfunction dshwInit() {",
    to: "} catch (err) {}\nif (window.__DSHW_STANDALONE__) { try { dshwTryStart(true) } catch (err) {} }\nfunction dshwInit() {",
  },
  {
    id: 'base-size-formula',
    critical: true,
    // 与浏览器版视觉对齐：浏览器公式 min(250px, 视口*0.28)*scale（1080p 下=250*scale），
    // 桌面窗口跟随鲸鱼尺寸，视口项会退化，故固定用 250px*scale（clamp 下限 122、上限 625）
    from: '--dshw-base:clamp(122px,calc(min(250px,min(100vw,100vh) * 0.28) * var(--dshw-scale)),625px)',
    to: '--dshw-base:clamp(122px,calc(250px * var(--dshw-scale)),625px)',
  },
  {
    id: 'drag-pointermove',
    // 非致命：万一上游大改这段逻辑，最坏只是「拖不动窗口」，挂件本身照常可用。
    critical: false,
    // 跨版本稳定锚点：这一行在 0.3.17 / 0.3.18 里都恰好出现一次（onDocPointerMove 内），
    // 而它前后的实现细节（clampWidgetTop、注释、flip 说明）上游改过 —— 所以只认这一行。
    // 独立模式下在它前面短路：鲸鱼在窗口内永不挪位，位移改为移动整个窗口。
    from: "  state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))",
    to: "  if (window.__DSHW_STANDALONE__) {\n    try { if (window.__dshwDesktop) window.__dshwDesktop.dragMove(dx, dy) } catch (err) {}\n    return\n  }\n  state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))",
  },
  {
    id: 'drag-endDrag-standalone',
    // 非致命：缺了它最坏是拖动收尾/点击语义退化为原版（鲸鱼仍被 express 钉住，不会漂）
    critical: false,
    // 独立模式：抬手不做任何页内落位/吸附/翻转（鲸鱼钉在右下角不动）；
    // 若只是点按（没拖）则照常触发点击冒泡；通知主进程保存窗口位置。
    from: "  pressUp()\n  root.classList.remove('dshwv-dragging')",
    to: "  pressUp()\n  root.classList.remove('dshwv-dragging')\n  if (window.__DSHW_STANDALONE__) {\n    try { if (window.__dshwDesktop) window.__dshwDesktop.dragEnd() } catch (err) {}\n    setWidgetCursor(isWhaleHit(e) ? 'grab' : '')\n    if (clickAllowed && !drag.moved) {\n      if (longPressRecent()) return\n      whaleClick()\n      refresh(true)\n    }\n    return\n  }",
  },
  {
    id: 'express-anchor-bottomright',
    critical: true,
    // 独立模式：express() 是所有“写挂件位置”路径（init / settle / resize / 自愈）的汇聚点。
    // 在这里直接把 root 钉到窗口右下角（等价于 CSS right:0/bottom:0 的语义），
    // 彻底保证“窗口内的小鲸鱼永不挪位”，任何 state 值都影响不到它。
    from: "function express() {\n  root.style.right = 'auto'\n  root.style.bottom = 'auto'\n  root.style.left = state.left + 'px'",
    to: "function express() {\n  if (window.__DSHW_STANDALONE__) {\n    // 独立模式：鲸鱼朝向跟随主进程按屏幕位置算好的 __DSHW_FLIP__（贴屏幕左半 => 面朝右）\n    state.flip = !!window.__DSHW_FLIP__\n    var vp0 = viewport()\n    var rw0 = root.offsetWidth || root.getBoundingClientRect().width || 0\n    var rh0 = root.offsetHeight || root.getBoundingClientRect().height || 0\n    // 四周对称边距 M0（与主进程 fit 的边距一致），且不再叠加浏览器滚动条避让偏移：\n    // 否则底部边距为 0，鲸鱼会紧贴/越出窗口底边被裁掉。\n    var m0 = 10\n    root.style.right = 'auto'\n    root.style.bottom = 'auto'\n    root.style.left = Math.max(0, vp0.w - rw0 - m0) + 'px'\n    root.style.top = Math.max(0, vp0.h - rh0 - m0) + 'px'\n    root.classList.toggle('dshwv-left', !!state.flip)\n    return\n  }\n  root.style.right = 'auto'\n  root.style.bottom = 'auto'\n  root.style.left = state.left + 'px'",
  },
]

/**
 * 读取插件前端 → 应用补丁 → 按源文件 mtime 缓存到 userData/cache。
 * @returns {{ js: string|null, dir: string|null, srcPath: string|null, kind: string|null, version: string|null, applied: string[], missing: string[], error?: string }}
 */
export function loadPatchedWidget(userDataDir) {
  const src = resolveWidgetSource()
  const srcPath = src.srcPath
  const cacheDir = path.join(userDataDir, 'cache')
  const outPath = path.join(cacheDir, 'whale-widget.patched.js')
  const metaPath = path.join(cacheDir, 'whale-widget.patched.meta.json')

  if (!srcPath) {
    return {
      js: null, dir: null, srcPath: null, kind: null, version: null,
      applied: [], missing: [],
      error: '未找到 dsh-whale-widget 前端源码。请先运行 `npm run fetch:widget` 从上游拉取最新前端' +
        '（或设置 DSHW_WIDGET_DIR 指向源码目录；开发期也可在本机 DSH 里安装该插件作为兜底）。\n已尝试：' + src.tried.join('、'),
    }
  }

  let stat = null
  try { stat = statSync(srcPath) } catch { /* missing */ }
  if (!stat) {
    return { js: null, dir: src.dir, srcPath, kind: src.kind, version: src.version, applied: [], missing: [], error: `读取不到 ${srcPath}` }
  }
  const srcKey = `${stat.mtimeMs}:${stat.size}:v7`

  // 缓存命中（源文件未变）
  try {
    if (existsSync(outPath) && existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta.srcKey === srcKey) {
        return { js: readFileSync(outPath, 'utf8'), dir: src.dir, srcPath, kind: src.kind, version: src.version, applied: meta.applied || [], missing: meta.missing || [], cached: true }
      }
    }
  } catch { /* rebuild */ }

  let code
  try { code = readFileSync(srcPath, 'utf8') } catch (err) {
    return { js: null, dir: src.dir, srcPath, kind: src.kind, version: src.version, applied: [], missing: [], error: `读取 ${srcPath} 失败：${err.message}` }
  }

  const applied = []
  const missing = []
  for (const p of PATCHES) {
    if (code.includes(p.from)) {
      code = code.split(p.from).join(p.to)
      applied.push(p.id)
    } else {
      missing.push(p.id)
      if (p.critical) {
        return {
          js: null, dir: src.dir, srcPath, kind: src.kind, version: src.version,
          applied, missing,
          error: `关键补丁 ${p.id} 未命中（上游前端 dsh-whale-widget@${src.version || '?'} 的这部分代码变了，适配层需同步更新）：${p.from.slice(0, 60)}...`,
        }
      }
    }
  }

  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(outPath, code, 'utf8')
    writeFileSync(metaPath, JSON.stringify({ srcKey, applied, missing, version: src.version, kind: src.kind }), 'utf8')
  } catch (err) {
    return { js: code, dir: src.dir, srcPath, kind: src.kind, version: src.version, applied, missing, error: `写缓存失败（无碍运行）：${err.message}` }
  }
  return { js: code, dir: src.dir, srcPath, kind: src.kind, version: src.version, applied, missing }
}
