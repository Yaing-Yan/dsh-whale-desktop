// dsh-whale-desktop —— 编译期拉取上游挂件前端
//
// 本桌面壳**不内置** dsh-whale-widget 的前端源码：只维护壳（窗口/认证/代理/适配补丁），
// 编译时从上游把最新源码拉下来放进 vendor/（已 gitignore，不进仓库）。
// 上游持续更新、总体显示机制稳定 —— 每次编译重新拉取即可跟上新版本。
//
// 用法：
//   node scripts/fetch-widget.mjs                # 拉取 npm latest
//   node scripts/fetch-widget.mjs --version 0.3.18
//   node scripts/fetch-widget.mjs --if-missing   # 已有就不重复拉（开发常用）
//   node scripts/fetch-widget.mjs --force        # 强制重拉
//   node scripts/fetch-widget.mjs --offline      # 只用现有 vendor 副本
//
// 产出：
//   vendor/dsh-whale-widget/assets/whale-widget.js   （上游前端本体，原样）
//   vendor/dsh-whale-widget/assets/DSniang02.png     （角色图，仅用于生成应用图标）
//   vendor/dsh-whale-widget/VERSION.json             （版本/来源/校验，可追溯）

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const vendorDir = path.join(rootDir, 'vendor', 'dsh-whale-widget')
const PKG = 'dsh-whale-widget'
const REGISTRY = process.env.DSHW_NPM_REGISTRY || 'https://registry.npmjs.org'

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

  // 1) 解析版本
  let meta
  try {
    const res = await fetch(`${REGISTRY}/${PKG}`, { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } })
    if (!res.ok) throw new Error('registry HTTP ' + res.status)
    meta = await res.json()
  } catch (err) {
    if (existsSync(existingJs)) {
      log('无法访问 npm registry（' + err.message + '），沿用现有副本', existingMeta ? existingMeta.version : '')
      return
    }
    fail('无法访问 npm registry 且本地无副本：' + err.message)
  }

  const version = wantVersion === 'latest' ? ((meta['dist-tags'] && meta['dist-tags'].latest) || null) : wantVersion
  if (!version) fail('无法确定版本（registry 未返回 dist-tags.latest）')
  const vmeta = meta.versions && meta.versions[version]
  if (!vmeta || !vmeta.dist || !vmeta.dist.tarball) fail(`registry 里没有版本 ${version}`)

  if (!force && existingMeta && existingMeta.version === version && existsSync(existingJs)) {
    log('已是最新版本', version, '，无需重拉')
    return
  }

  // 2) 下载 tarball（走环境代理）
  log('拉取', `${PKG}@${version}`, '←', vmeta.dist.tarball)
  let tarBuf
  try {
    const res = await fetch(vmeta.dist.tarball)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    tarBuf = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    if (existsSync(existingJs)) { log('下载失败（' + err.message + '），沿用现有副本'); return }
    fail('下载失败：' + err.message)
  }
  if (vmeta.dist.integrity && vmeta.dist.integrity.startsWith('sha512-')) {
    const got = 'sha512-' + createHash('sha512').update(tarBuf).digest('base64')
    if (got !== vmeta.dist.integrity) fail(`tarball 校验不符（期望 ${vmeta.dist.integrity}，实际 ${got}）`)
  }

  // 3) 解包出前端本体
  const files = extractFromTarGz(tarBuf, ['assets/whale-widget.js', 'assets/DSniang02.png'])
  let jsBuf = null
  for (const [name, buf] of files) if (name.endsWith('assets/whale-widget.js')) jsBuf = buf
  if (!jsBuf) fail('tarball 里没找到 assets/whale-widget.js')

  // 4) 落盘 + 记录来源（vendor 目录已 gitignore，不进仓库）
  const outJs = path.join(vendorDir, 'assets', 'whale-widget.js')
  mkdirSync(path.dirname(outJs), { recursive: true })
  writeFileSync(outJs, jsBuf)
  // 角色图也一并取出：仅用于生成应用图标（npm run icons），不参与界面渲染
  for (const [name, buf] of files) {
    if (name.endsWith('assets/DSniang02.png')) {
      writeFileSync(path.join(vendorDir, 'assets', 'DSniang02.png'), buf)
    }
  }
  writeFileSync(path.join(vendorDir, 'VERSION.json'), JSON.stringify({
    name: PKG,
    version,
    source: 'npm',
    registry: REGISTRY,
    tarball: vmeta.dist.tarball,
    integrity: vmeta.dist.integrity || null,
    fetchedAt: new Date().toISOString(),
    file: 'assets/whale-widget.js',
    sha256: sha256(jsBuf),
    bytes: jsBuf.length,
  }, null, 2) + '\n')
  // 记一份纯文本版本，运行时零解析即可读取
  writeFileSync(path.join(vendorDir, 'VERSION'), version + '\n')
  log('完成：', `${PKG}@${version}`, '→ vendor/dsh-whale-widget/assets/whale-widget.js', `(${jsBuf.length} bytes)`)
}

main().catch((err) => fail(String((err && err.stack) || err)))
