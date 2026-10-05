// dsh-whale-desktop —— 修复 / 安装 Electron 二进制
//
//   npm run repair:electron
//
// 场景：node_modules 存在但 node_modules/electron/dist 缺失（npm ci / 脚本被拦 / 网络中断后常见），
// 此时 npm start 会报 “Electron failed to install correctly”，且 Electron 自带的惰性下载会直连
// npm 源 —— 在代理受限的网络里会直接 fetch failed。本脚本：
//   1) 检测二进制是否就绪；
//   2) 未就绪则调用 Electron 自带安装器，并默认走 npmmirror 镜像（国内可达性最好）；
//   3) 失败时打印可操作的排查建议（代理 / 镜像变量）。
//
// 可用环境变量覆盖：ELECTRON_MIRROR（镜像）、https_proxy / HTTPS_PROXY（代理）。

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = path.join(root, 'node_modules', 'electron')

function log(...a) { console.log('[repair-electron]', ...a) }
function fail(msg) { console.error('[repair-electron] ' + msg); process.exit(1) }

if (!existsSync(electronDir)) {
  fail('未找到 node_modules/electron —— 请先 npm install（网络受限时先配好代理或 npm 镜像）')
}

const wantVersion = (() => { try { return JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version } catch { return '?' } })()
const exeName = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app' : 'electron'
const distPath = path.join(electronDir, 'dist', exeName)

if (existsSync(distPath)) {
  log('Electron 二进制就绪：', wantVersion, '→', distPath)
  process.exit(0)
}

const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
log('Electron 二进制缺失（期望版本 ' + wantVersion + '），开始安装…')
log('使用镜像：', mirror)
if (!process.env.https_proxy && !process.env.HTTPS_PROXY) {
  log('提示：当前 shell 未设置 https_proxy；若镜像也不可达，请先 ' +
      'export https_proxy=http://<你的代理>:<端口>')
}

const installer = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'install-electron.cmd' : 'install-electron')
const useLocal = existsSync(installer)
const cmd = useLocal ? installer : 'npx'
const args = useLocal ? [] : ['--yes', 'install-electron']

const res = spawnSync(cmd, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: mirror },
  shell: process.platform === 'win32',
})

if (res.status === 0 && existsSync(distPath)) {
  log('完成：', distPath)
  process.exit(0)
}

fail(
  '安装失败（退出码 ' + res.status + '）。可尝试：\n' +
  '  1) 换镜像：ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm run repair:electron\n' +
  '  2) 配代理后重试：export https_proxy=http://IP:PORT && npm run repair:electron\n' +
  '  3) 完全离线：把 electron-v' + wantVersion + '-' + process.platform + '-' + process.arch + '.zip 放进\n' +
  '     ~/.cache/electron/ 后重试，或解压到 node_modules/electron/dist 并写入 path.txt（内容：electron）'
)
