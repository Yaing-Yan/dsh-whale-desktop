// dsh-whale-desktop —— 编译期拉取上游挂件前端
//
// 本桌面壳**不内置** dsh-whale-widget 的前端源码：只维护壳（窗口/认证/代理/适配补丁），
// 编译时从上游把最新源码拉下来放进 vendor/（已 gitignore，不进仓库）。
// 上游持续更新、总体显示机制稳定 —— 每次编译重新拉取即可跟上新版本。
//
// 用法：
//   node scripts/fetch-widget.mjs                # 拉取 latest（多源自动回退）
//   node scripts/fetch-widget.mjs --version 0.3.18
//   node scripts/fetch-widget.mjs --if-missing   # 已有就不重复拉（开发常用）
//   node scripts/fetch-widget.mjs --force        # 强制重拉
//   node scripts/fetch-widget.mjs --offline      # 只用现有 vendor 副本
//   node scripts/fetch-widget.mjs --from <目录>  # 直接从本机已有的插件目录取源（不发网络请求）
//
// 取源顺序（任一成功即止）：
//   ① 显式 --from / DSHW_WIDGET_DIR
//   ② 各 registry：npm 官方 → npmmirror 镜像 → npm 配置里的 registry
//   ③ 本机已安装的 DSH 插件目录（$DSH_HOME/profiles/*/node_modules/dsh-whale-widget）—— 离线种子
// 这样在公司代理/镜像/断网环境里都能落地；版本一致性由 VERSION.json 记录。
//
// 产出：
//   vendor/dsh-whale-widget/assets/whale-widget.js   （上游前端本体，原样）
//   vendor/dsh-whale-widget/assets/DSniang02.png     （角色图，仅用于生成应用图标）
//   vendor/dsh-whale-widget/VERSION.json             （版本/来源/校验，可追溯）

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const vendorDir = path.join(rootDir, 'vendor', 'dsh-whale-widget')
const PKG = 'dsh-whale-widget'
const OFFICIAL = 'https://registry.npmjs.org'
const MIRROR = 'https://registry.npmmirror.com'

/** registry 候选：显式 env > npm 官方 > npmmirror > npm 配置里的 registry（去重、去掉尾部斜杠）。 */
function registryCandidates() {
  const list = [process.env.DSHW_NPM_REGISTRY, OFFICIAL, MIRROR]
  try {
    const { execFileSync } = require('node:child_process')
    const r = execFileSync('npm', ['config', 'get', 'registry'], { timeout: 5000, encoding: 'utf8' }).trim()
    if (r) list.push(r)
  } catch { /* 没 npm 就算了 */ }
  return [...new Set(list.filter(Boolean).map((u) => u.replace(/\/+$/, '')))]
}

/** 本机已有的挂件目录（离线种子候选）：--from / DSHW_WIDGET_DIR / DSH_HOME 下各 profile。 */
function localCandidates() {
  const from = arg('--from')
  const list = []
  if (typeof from === 'string') list.push(from)
  if (process.env.DSHW_WIDGET_DIR) list.push(process.env.DSHW_WIDGET_DIR)
  if (process.env.DSHW_PLUGIN_DIR) list.push(process.env.DSHW_PLUGIN_DIR)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const profilesDir = path.join(home, 'profiles')
    for (const name of readdirSync(profilesDir)) {
      list.push(path.join(profilesDir, name, 'node_modules', PKG))
    }
  } catch { /* 没有 profiles 目录 */ }
  return [...new Set(list)].filter((d) => existsSync(path.join(d, 'assets', 'whale-widget.js')))
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null
}
const wantVersion = typeof arg('--version') === 'string' ? arg('--version') : 'latest'
const force = !!arg('--force')
const ifMissing = !!arg('--if-missing')
const offline = !!arg('--offline')

function log(...a) { console.log('[fetch-widget]', ...a) }
function fail(msg) { console.error('[fetch-widget] 失败：' + msg); process.exit(1) }

/** 极简 tar 解包（只取需要的文件）：gzip → 512 字节头 → 内容。避免依赖系统 tar。 */
function extractFromTarGz(buf, wantPaths) {
  const tar = gunzipSync(buf)
  const out = new Map()
  let off = 0
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '')
    if (!name) break
    const sizeStr = tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const type = String.fromCharCode(tar[off + 156])
    const start = off + 512
    if ((type === '0' || type === '\0' || type === '') && wantPaths.some((w) => name === w || name.endsWith('/' + w))) {
      out.set(name, Buffer.from(tar.subarray(start, start + size)))
    }
    off = start + Math.ceil(size / 512) * 512
  }
  return out
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }

/** 从某个 registry 解析版本并下载解包，成功返回 true。 */
async function tryRegistry(registry, existingJs, existingMeta) {
  let meta
  try {
    const res = await fetch(`${registry}/${PKG}`, { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    meta = await res.json()
  } catch (err) {
    log('registry 不可用：', registry, '→', err.message)
    return false
  }
  const version = wantVersion === 'latest' ? ((meta['dist-tags'] && meta['dist-tags'].latest) || null) : wantVersion
  if (!version) { log('registry 未返回版本：', registry); return false }
  const vmeta = meta.versions && meta.versions[version]
  if (!vmeta || !vmeta.dist || !vmeta.dist.tarball) { log('registry 里没有版本', version, '：', registry); return false }
  if (!force && wantVersion === 'latest' && existingMeta && existingMeta.version === version && existsSync(existingJs) && existingMeta.source === 'npm') {
    log('已是最新版本', version, '，无需重拉')
    return true
  }
  log('拉取', `${PKG}@${version}`, '←', vmeta.dist.tarball)
  let tarBuf
  try {
    const res = await fetch(vmeta.dist.tarball)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    tarBuf = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    log('下载失败：', err.message)
    return false
  }
  if (vmeta.dist.integrity && vmeta.dist.integrity.startsWith('sha512-')) {
    const got = 'sha512-' + createHash('sha512').update(tarBuf).digest('base64')
    if (got !== vmeta.dist.integrity) { log('tarball 校验不符，丢弃该源'); return false }
  }
  const files = extractFromTarGz(tarBuf, ['assets/whale-widget.js', 'assets/DSniang02.png'])
  let jsBuf = null
  for (const [name, buf] of files) if (name.endsWith('assets/whale-widget.js')) jsBuf = buf
  if (!jsBuf) { log('tarball 里没找到 assets/whale-widget.js'); return false }
  writeVendor(jsBuf, files, { version, source: 'npm', registry, tarball: vmeta.dist.tarball, integrity: vmeta.dist.integrity || null })
  log('完成：', `${PKG}@${version}`, '（来自', registry + '）')
  return true
}

/** 从本机已有的插件目录取源（离线种子）：同一份 version/文件，覆盖进 vendor/。 */
function tryLocalDir(dir) {
  const srcJs = path.join(dir, 'assets', 'whale-widget.js')
  if (!existsSync(srcJs)) return false
  let version = null
  try { version = readFileSync(path.join(dir, 'package.json'), 'utf8') } catch { /* ignore */ }
  try { version = JSON.parse(version).version || null } catch { version = null }
  const jsBuf = readFileSync(srcJs)
  const files = []
  const icon = path.join(dir, 'assets', 'DSniang02.png')
  if (existsSync(icon)) files.push(['assets/DSniang02.png', readFileSync(icon)])
  writeVendor(jsBuf, files, { version, source: 'local-seed', from: dir, integrity: null, tarball: null })
  log('完成：从本机已装插件取源', version ? 'v' + version : '', '←', dir)
  return true
}

/** 落盘 + 写来源记录（vendor 已 gitignore）。 */
function writeVendor(jsBuf, extraFiles, provenance) {
  const outJs = path.join(vendorDir, 'assets', 'whale-widget.js')
  mkdirSync(path.dirname(outJs), { recursive: true })
  writeFileSync(outJs, jsBuf)
  for (const [name, buf] of extraFiles) {
    if (name.endsWith('assets/DSniang02.png')) writeFileSync(path.join(vendorDir, 'assets', 'DSniang02.png'), buf)
  }
  writeFileSync(path.join(vendorDir, 'VERSION.json'), JSON.stringify({
    name: PKG,
    version: provenance.version,
    source: provenance.source,
    registry: provenance.registry || null,
    from: provenance.from || null,
    tarball: provenance.tarball || null,
    integrity: provenance.integrity || null,
    fetchedAt: new Date().toISOString(),
    file: 'assets/whale-widget.js',
    sha256: sha256(jsBuf),
    bytes: jsBuf.length,
  }, null, 2) + '\n')
  writeFileSync(path.join(vendorDir, 'VERSION'), (provenance.version || 'unknown') + '\n')
}

async function main() {
  const existingMeta = (() => {
    try { return JSON.parse(readFileSync(path.join(vendorDir, 'VERSION.json'), 'utf8')) } catch { return null }
  })()
  const existingJs = path.join(vendorDir, 'assets', 'whale-widget.js')

  if (offline) {
    if (!existsSync(existingJs)) fail('--offline 但 vendor 里没有前端（先跑一次不带 --offline 的拉取）')
    log('offline 模式，沿用现有副本', existingMeta ? existingMeta.version : '')
    return
  }
  if (ifMissing && existsSync(existingJs) && !force) {
    log('已有副本，跳过拉取（版本', existingMeta ? existingMeta.version : '未知', '）')
    return
  }

  // ① 显式本地来源：--from / DSHW_WIDGET_DIR / DSHW_PLUGIN_DIR 优先（不做网络请求）
  const fromArg = arg('--from')
  if (typeof fromArg === 'string' || process.env.DSHW_WIDGET_DIR || process.env.DSHW_PLUGIN_DIR) {
    const locals = localCandidates()
    for (const dir of locals) if (tryLocalDir(dir)) return
    if (typeof fromArg === 'string') fail('--from 指定的目录里没有 assets/whale-widget.js：' + fromArg)
  }

  // ② 逐个 registry 尝试（官方 → npmmirror → npm 配置里的）
  const registries = registryCandidates()
  for (const reg of registries) {
    if (await tryRegistry(reg, existingJs, existingMeta)) return
  }

  // ③ 全部网络源失败 → 用本机已装插件兜底（离线种子）
  const locals = localCandidates()
  if (locals.length) {
    log('网络源均不可用，尝试从本机已装插件取源…')
    for (const dir of locals) if (tryLocalDir(dir)) return
  }
  if (existsSync(existingJs)) {
    log('取源失败，沿用现有副本', existingMeta ? existingMeta.version : '')
    return
  }

  fail(
    '无法获取上游前端（registry 与本地种子都不可用）。\n' +
    '  已尝试 registry：' + registries.join('、') + '\n' +
    '  已尝试本地目录：' + (locals.length ? locals.join('、') : '（无）') + '\n' +
    '  排查建议：\n' +
    '    1) 若你的 shell 配了代理，确认代理真的在运行（export https_proxy=http://IP:PORT 后再试）\n' +
    '    2) 或改用镜像：DSHW_NPM_REGISTRY=https://registry.npmmirror.com npm run fetch:widget\n' +
    '    3) 或从本机已安装的 DSH 插件取源：npm run fetch:widget -- --from "$DSH_HOME/profiles/web/node_modules/dsh-whale-widget"\n' +
    '    4) 或指定历史版本：npm run fetch:widget -- --version <版本>'
  )
}

main().catch((err) => fail(String((err && err.stack) || err)))
