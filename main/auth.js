// dsh-whale-desktop —— DSH 浏览器会话凭据的离线复刻
//
// DSH web 的「浏览器信任栅栏」（dsh-client-connection BrowserAuth）要求所有
// /dsh-whale/* 请求带一个由持久签名密钥生成的 HttpOnly 签名 Cookie：
//   Cookie 名 = "dsh-auth-" + base64url(sha256(authority))
//   Cookie 值 = "v1.<base64url(payload)>.<base64url(hmac-sha256(secret, body))>"
//   payload   = { version:1, authority, issuedAt, expiresAt }
// 签名密钥由 DSH 首次启动时生成并明文保存在 $DSH_HOME/.credentials.yaml 的
// records["client-connection/browser-session"].payload.secret 里（不随进程重启变化，
// 浏览器 Cookie 本身最长存活 30 天，跨 DSH 重启依然有效）。
//
// 本模块：读取该密钥 → 在本地按同一算法铸造 Cookie → 之后所有对 DSH 的只读/写请求
// 都带上它。全程不接触浏览器、不触碰 DSH 会话令牌，等价于"在另一个地方登录了 DSH"。

import { createHash, createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

function encodeBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * 从 $DSH_HOME/.credentials.yaml 提取浏览器会话签名密钥。
 * 用行缩进解析（只关心 records → client-connection/browser-session → payload → secret）。
 * 返回 base64url 字符串；找不到返回 null。
 */
export function loadBrowserSessionSecret(home = dshHome()) {
  const file = path.join(home, '.credentials.yaml')
  if (!existsSync(file)) return null
  let txt
  try { txt = readFileSync(file, 'utf8') } catch { return null }
  const lines = txt.split(/\r?\n/)
  let inRec = false
  let inPayload = false
  for (const ln of lines) {
    if (!ln.trim() || ln.trim().startsWith('#')) continue
    const indent = (ln.match(/^\s*/) || [''])[0].length
    const m = ln.match(/^\s*([^:#\s][^:]*?):\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    const val = m[2].trim()
    if (indent < 2) { inRec = false; inPayload = false }
    if (indent === 2 && key === 'client-connection/browser-session') { inRec = true; continue }
    if (inRec) {
      if (indent === 4 && key === 'kind') continue
      if (indent === 4 && key === 'payload') { inPayload = true; continue }
      if (inPayload && indent === 6 && key === 'secret' && val) return val
    }
  }
  return null
}

/**
 * 铸造 DSH 浏览器会话 Cookie（与 dsh-client-connection 的 encodeCookie 一致）。
 * @param {string} secret  base64url 32 字节密钥
 * @param {string} authority 例如 "127.0.0.1:3080"
 * @param {number} [maxAgeDays] 默认 30 天（与 DSH 默认一致）
 * @returns {{ name: string, value: string, header: string, expiresAt: number }}
 */
export function mintCookie(secret, authority, maxAgeDays = 30) {
  const secretBytes = decodeBase64Url(secret)
  if (!secretBytes || secretBytes.byteLength !== 32) throw new Error('browser-session secret 无效（不是 32 字节 base64url）')
  const cookieName = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest())
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000
  const body = encodeBase64Url(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'))
  const sig = encodeBase64Url(createHmac('sha256', secretBytes).update(body).digest())
  const value = `v1.${body}.${sig}`
  return { name: cookieName, value, header: `${cookieName}=${value}`, expiresAt }
}
