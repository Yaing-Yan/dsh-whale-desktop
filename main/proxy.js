// dsh-whale-desktop —— 本地 HTTP 服务（渲染层唯一入口）
//
// 职责分三层：
//  1. 渲染页面与补丁后的前端本体（index.html / loader.js / widget.js）。
//  2. 「只读数据」代理到 DSH（http://127.0.0.1:3080，带铸造的会话 Cookie）：
//     balance.json / last-turn.json / wait.json / usage-records.json /
//     api-models.json / roles.json / 角色图 / 音效 / 泡泡图 ……
//     —— 这就是“在另一个地方登录 DSH”的数据通道：每轮消耗、提问/授权挂起、
//        余额变化全部从这里来，与浏览器版收到的是同一份“广播”。
//  3. 「挂件设置」完全本地化（独立于浏览器版，两边互不覆盖）：
//     size.json / bubble.json / usage-settings.json 的 GET/PUT 只落在
//     userData/settings/ 目录，绝不写 $DSH_HOME 的任何文件。
//     其余写接口（余额校正、角色增删、泡泡图上传、自定义模型）属于共享账户
//     数据，仍然代理到 DSH，保持两边数据一致。

import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { loadPatchedWidget } from './patch.js'

const LOCAL_KEYS = new Set(['size.json', 'bubble.json', 'usage-settings.json'])

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readLocal(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}
function writeLocal(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

/** 首次运行时，把 DSH 现有的挂件配置抄一份做种子（此后完全独立）。 */
function seedSettings(settingsDir, home) {
  const seeds = [
    ['.dshw-size.json', 'size.json'],
    ['.dshw-bubble.json', 'bubble.json'],
  ]
  for (const [srcName, dstName] of seeds) {
    const dst = path.join(settingsDir, dstName)
    if (existsSync(dst)) continue
    const src = path.join(home, srcName)
    if (!existsSync(src)) continue
    try {
      const data = JSON.parse(readFileSync(src, 'utf8'))
      if (data && typeof data === 'object') {
        // bubble 配置存的是裸 {v,items,lib,...}；DSH 的 GET 回包 {ok,config} 由我们包一层
        writeLocal(dst, dstName === 'bubble.json' ? { v: 1, items: data.items || [], lib: data.lib || [], tapAdvance: !!data.tapAdvance } : data)
      }
    } catch { /* 忽略损坏种子 */ }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {string} opts.dshHome
 * @param {string} opts.dshOrigin  例如 http://127.0.0.1:3080
 * @param {string} opts.cookie     DSH 会话 Cookie 头
 * @param {string} opts.rendererDir 渲染层静态文件目录（index.html / loader.js）
 * @param {{ js: string|null, error?: string, applied?: string[], missing?: string[] }} opts.widget
 */
export function createServer(opts) {
  const { userDataDir, dshHome: home, dshOrigin, cookie, widget, rendererDir } = opts
  const settingsDir = path.join(userDataDir, 'settings')
  seedSettings(settingsDir, home)

  function handleLocal(req, res, key) {
    const file = path.join(settingsDir, key)
    if (req.method === 'PUT' || req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const prev = readLocal(file) || {}
          // DSH 语义：缺字段沿用现有值，绝不落默认
          const merged = { ...prev, ...parsed }
          writeLocal(file, merged)
          if (key === 'size.json') json(res, 200, { ok: true, ...merged })
          else if (key === 'bubble.json') {
            const cfg = { v: 1, items: merged.items || [], lib: merged.lib || [], tapAdvance: merged.tapAdvance === true }
            writeLocal(file, cfg)
            json(res, 200, { ok: true, config: cfg })
          } else json(res, 200, { ok: true, settings: merged })
        } catch (err) {
          json(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
      })
      return
    }
    // GET
    if (key === 'size.json') json(res, 200, readLocal(file) || {})
    else if (key === 'bubble.json') json(res, 200, { ok: true, config: readLocal(file) || { v: 1, items: [], lib: [], tapAdvance: false } })
    else json(res, 200, { ok: true, settings: readLocal(file) || {} })
  }

  async function proxy(req, res, pathname) {
    const url = dshOrigin + pathname + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')
    const headers = {
      cookie: cookie,
      'accept': req.headers['accept'] || '*/*',
      'accept-encoding': req.headers['accept-encoding'] || 'identity',
      'user-agent': req.headers['user-agent'] || 'dsh-whale-desktop',
    }
    const body = (req.method === 'GET' || req.method === 'HEAD') ? null : await readReqBody(req)
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    const ctype = upstream.headers.get('content-type') || 'application/octet-stream'
    res.writeHead(upstream.status, { 'Content-Type': ctype, 'Cache-Control': 'no-store' })
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.end(buf)
  }

  function readReqBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => { chunks.push(c); size += c.length })
      req.on('end', () => resolve(Buffer.concat(chunks, size)))
      req.on('error', () => resolve(Buffer.alloc(0)))
    })
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    try {
      if (pathname === '/' || pathname === '/index.html') {
        const html = readFileSync(path.join(rendererDir, 'index.html'), 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(html)
        return
      }
      if (pathname === '/loader.js') {
        const js = readFileSync(path.join(rendererDir, 'loader.js'), 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(js)
        return
      }
      if (pathname === '/dsh-whale/widget.js') {
        if (!widget.js) {
          json(res, 500, { ok: false, error: widget.error || 'widget 前端不可用' })
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(widget.js)
        return
      }
      if (pathname === '/__boot__.json') {
        json(res, 200, {
          ok: true,
          dshOrigin,
          auth: !!cookie,
          widgetOk: !!widget.js,
          widgetError: widget.error || null,
          applied: widget.applied || [],
          missing: widget.missing || [],
          home,
          widgetVersion: widget.version || null,
          widgetSource: widget.kind || null,
          widgetDir: widget.dir || null,
        })
        return
      }
      if (pathname.startsWith('/dsh-whale/')) {
        const key = pathname.slice('/dsh-whale/'.length)
        if (LOCAL_KEYS.has(key)) { handleLocal(req, res, key); return }
        await proxy(req, res, pathname)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (err) {
      try {
        json(res, 502, { ok: false, error: `DSH 代理失败：${String((err && err.message) || err)}` })
      } catch { /* socket already closed */ }
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ port, close: () => new Promise((r) => server.close(r)) })
    })
  })
}
