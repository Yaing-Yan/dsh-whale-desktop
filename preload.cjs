// dsh-whale-desktop —— preload（contextBridge）
// 只暴露最小窗口控制面，渲染层没有任何 Node 能力。
// dragMove 的两个调用方（挂件补丁 / loader 全局拖动）传的都是“从本次拖动起点算的
// 绝对位移”，这里转成“增量”再发给主进程 —— 事件即使被合并/丢帧也不会重复累计。

const { contextBridge, ipcRenderer } = require('electron')

let lastAbs = null

contextBridge.exposeInMainWorld('dshwDesktop', {
  dragMove: (dx, dy) => {
    dx = Number(dx) || 0
    dy = Number(dy) || 0
    if (lastAbs === null) {
      lastAbs = { x: dx, y: dy }
      return
    }
    const incX = dx - lastAbs.x
    const incY = dy - lastAbs.y
    lastAbs = { x: dx, y: dy }
    if (incX !== 0 || incY !== 0) ipcRenderer.send('win:moveBy', { dx: incX, dy: incY })
  },
  dragEnd: () => {
    lastAbs = null
    ipcRenderer.send('win:dragEnd')
  },
  fit: (info) => ipcRenderer.send('win:fit', info),
  bootInfo: () => ipcRenderer.invoke('boot:info'),
  onFlip: (cb) => {
    ipcRenderer.on('win:setFlip', (e, flip) => { try { cb(!!flip) } catch (err) {} })
  },
})
