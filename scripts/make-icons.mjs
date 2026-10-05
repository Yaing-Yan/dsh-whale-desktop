// dsh-whale-desktop —— 生成应用/打包图标
//
//   npm run icons        （内部：electron scripts/make-icons.mjs）
//
// 用 Electron 自带的 nativeImage 做缩放，跨平台、零额外依赖。
// 图标源用编译期拉取的上游角色图 vendor/.../DSniang02.png（仓库里不内置上游素材）；产物：
//   assets/icon.png / icon-256/128/64/32.png   （应用图标，install-app 用）
//   build/icon.png                              （electron-builder 生成 mac/win 图标用）
//   build/icons/<size>x<size>.png               （electron-builder Linux 图标）

import { app, nativeImage } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 居中裁剪成正方形（图标必须是方的；下游再统一放大 12% 形成透明边距）。 */
function squareCrop(img) {
  const { width, height } = img.getSize()
  const side = Math.min(width, height)
  return img.crop({
    x: Math.round((width - side) / 2),
    y: Math.round((height - side) / 2),
    width: side,
    height: side,
  })
}

app.whenReady().then(() => {
  const candidates = [
    path.join(root, 'vendor', 'dsh-whale-widget', 'assets', 'DSniang02.png'),
    path.join(root, 'assets', 'icon.png'), // 已有图标时可用于重建（自举）
  ]
  const srcPath = candidates.find((p) => existsSync(p))
  if (!srcPath) {
    console.error('[icons] 找不到图标源：先跑 npm run fetch:widget 拉取上游角色图')
    process.exit(1)
  }
  const src = nativeImage.createFromPath(srcPath)
  if (src.isEmpty()) {
    console.error('[icons] 无法读取图标源：' + srcPath)
    process.exit(1)
  }
  const base = squareCrop(src)
  const size = base.getSize()
  const padded = base.resize({
    width: Math.round(size.width * 1.12),
    height: Math.round(size.height * 1.12),
    quality: 'best',
  })

  const appSizes = [[512, 'assets/icon.png'], [256, 'assets/icon-256.png'], [128, 'assets/icon-128.png'], [64, 'assets/icon-64.png'], [32, 'assets/icon-32.png']]
  for (const [s, rel] of appSizes) {
    writeFileSync(path.join(root, rel), padded.resize({ width: s, height: s, quality: 'best' }).toPNG())
  }
  mkdirSync(path.join(root, 'build', 'icons'), { recursive: true })
  writeFileSync(path.join(root, 'build', 'icon.png'), padded.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG())
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    writeFileSync(path.join(root, 'build', 'icons', `${s}x${s}.png`), padded.resize({ width: s, height: s, quality: 'best' }).toPNG())
  }
  console.log('[icons] 完成，源：' + srcPath)
  console.log('[icons] assets/icon*.png + build/icon.png + build/icons/*.png')
  app.quit()
})
