// dsh-whale-desktop —— 渲染层加载器
// 1) 宣告独立模式（配合 patch.js 的 boot-gate / 尺寸补丁）
// 2) 把 preload 暴露的 window.dshwDesktop 接到补丁期望的 window.__dshwDesktop
// 3) 注入补丁后的挂件前端（与浏览器版同一份代码）
// 4) 自适应窗口：持续观察挂件 DOM，把「鲸鱼尺寸 + 所有可见面板/菜单的矩形」
//    上报主进程，主进程据此伸缩窗口并把鲸鱼锚定在屏幕上不动。
//    注意：root（.dshwv-root）是 right:0/bottom:0 固定定位 —— 它的 bottom 恒等于
//    视口高度，绝不能拿它的矩形算窗口高度（会形成正反馈无限增长）；只取它的尺寸。
//    同样，inset:0 的全屏遮罩矩形 == 视口，也要排除（它们应填满任意窗口尺寸）。
// 5) 启动自检：DSH 未运行 / 认证失败 / 插件缺失时显示一条可读提示

;(function () {
  'use strict'

  window.__DSHW_STANDALONE__ = true
  window.__dshwDesktop = window.dshwDesktop || null

  // —— 注入挂件前端 ——
  var s = document.createElement('script')
  s.src = '/dsh-whale/widget.js'
  s.onerror = function () { showStatus('挂件前端加载失败（/dsh-whale/widget.js 未就绪）') }
  document.body.appendChild(s)

  // —— 状态胶囊 ——
  var statusEl = document.getElementById('dshw-desktop-status')
  var statusTimer = null
  function showStatus(text, sticky) {
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.classList.add('show')
    if (!sticky) {
      clearTimeout(statusTimer)
      statusTimer = setTimeout(function () { statusEl.classList.remove('show') }, 6000)
    }
  }

  // —— 启动自检 ——
  if (window.__dshwDesktop && window.__dshwDesktop.bootInfo) {
    window.__dshwDesktop.bootInfo().then(function (info) {
      if (!info) return
      var lines = []
      if (!info.widgetOk) lines.push('⚠ 挂件不可用：' + (info.widgetError || '未知错误'))
      if (!info.auth) lines.push('⚠ 无法连接 DSH：' + (info.authError || '未找到会话密钥'))
      if (info.widgetMissing && info.widgetMissing.length) {
        lines.push('⚠ 适配补丁未命中（上游改版）：' + info.widgetMissing.join('、') + '，相关交互可能退化')
      }
      if (lines.length) showStatus(lines.join('\n'), true)
      else {
        var ver = info.widgetVersion ? ('（挂件 v' + info.widgetVersion + ' · ' + (info.widgetSource || '') + '）') : ''
        showStatus('已连接 ' + info.dshOrigin + ver, false)
      }
    }).catch(function () {})
  }

  // —— 自适应窗口 ——
  var VISIBLE_SELECTOR = '[class*="dshwv-"]'
  var lastSent = ''
  var prevCand = '' // 上一轮候选（用于稳定性判定：连续两轮一致才真正上报，杜绝“蠕动”）

  function rectOf(el) {
    try {
      var cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return null
      if (parseFloat(cs.opacity) === 0) return null
      // 祖先链上只要有一层隐藏（如菜单盒 opacity:0 时其子行仍是 opacity:1），整体视为不可见
      var anc = el.parentElement
      while (anc && anc !== document.body) {
        var acs = getComputedStyle(anc)
        if (acs.display === 'none' || acs.visibility === 'hidden' || parseFloat(acs.opacity) === 0) return null
        anc = anc.parentElement
      }
      var r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return null
      // 贴边锚定标记：挂件的菜单/面板用**内联** style.bottom/style.right 定位（贴底/贴右、向上/左生长），
      // 窗口缩放时它们跟着边缘走 —— 主进程必须据此计算所需尺寸，否则会在两个尺寸间来回跳。
      // 注意：必须读内联样式！getComputedStyle 对定位元素返回的是 used value，top/left 永远不是 'auto'。
      var iBottom = el.style.bottom, iTop = el.style.top
      var iRight = el.style.right, iLeft = el.style.left
      var ab = (iBottom && iBottom !== 'auto' && (!iTop || iTop === 'auto')) ? 1 : 0
      var ar = (iRight && iRight !== 'auto' && (!iLeft || iLeft === 'auto')) ? 1 : 0
      // 兜底：无内联定位信息、但上下都溢出（元素比视口还大）时按贴底处理，优先露出顶部
      if (!ab && r.top < 8 && r.bottom > window.innerHeight - 8) ab = 1
      return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, ab: ab, ar: ar }
    } catch (err) { return null }
  }

  function fitTick() {
    var root = document.querySelector('.dshwv-root')
    if (!root || !window.__dshwDesktop || !window.__dshwDesktop.fit) return
    var rr = rectOf(root)
    if (!rr) return
    var vw = window.innerWidth
    var vh = window.innerHeight
    // 收集其它可见挂件 UI（排除 root 自身、排除“盖满视口”的全屏遮罩）
    var items = []
    var els = document.querySelectorAll(VISIBLE_SELECTOR)
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el === root || root.contains(el)) continue
      var r = rectOf(el)
      if (!r) continue
      var fullscreen = r.l <= 2 && r.t <= 2 && r.r >= vw - 2 && r.b >= vh - 2
      if (fullscreen) continue
      items.push({ l: r.l, t: r.t, r: r.r, b: r.b, ab: r.ab, ar: r.ar })
    }
    var msg = JSON.stringify({ vw: vw, vh: vh, rootW: rr.w, rootH: rr.h, items: items })
    // 鲸鱼本体尺寸变化：
    //  · 变大 → 立刻上报（窗口慢了会把鲸鱼裁掉，用户拖缩放滑块就是这种）
    //  · 变小 → 仍走下面的“连续两轮一致”确认（瞬时误测量不能让窗口缩到比鲸鱼还小）
    var rootGrew = false
    if (lastSent) {
      try {
        var r0 = JSON.parse(msg), r1 = JSON.parse(lastSent)
        rootGrew = (r0.rootW > r1.rootW + 2) || (r0.rootH > r1.rootH + 2)
      } catch (err) { rootGrew = true }
    }
    // 稳定性判定（菜单/面板等“其它 UI”变化，以及鲸鱼本体缩小）：与上一轮候选一致才定格，约 500ms
    if (!rootGrew && msg !== prevCand) { prevCand = msg; return }
    // 死区：与已发送的目标差 < 4px 不重复上报
    if (lastSent) {
      try {
        var a = JSON.parse(msg), b = JSON.parse(lastSent)
        var dw = Math.abs(a.rootW - b.rootW), dh = Math.abs(a.rootH - b.rootH)
        var di = Math.abs((a.items.length) - (b.items.length))
        var changed = false
        if (dw > 4 || dh > 4 || di > 0) changed = true
        else {
          for (var k = 0; k < Math.min(a.items.length, b.items.length); k++) {
            var ia = a.items[k], ib = b.items[k]
            if (Math.abs(ia.l - ib.l) > 4 || Math.abs(ia.t - ib.t) > 4 || Math.abs(ia.r - ib.r) > 4 || Math.abs(ia.b - ib.b) > 4) { changed = true; break }
          }
        }
        if (!changed) return
      } catch (err) { /* 解析失败则照常上报 */ }
    }
    lastSent = msg
    prevCand = ''
    try { window.__dshwDesktop.fit(JSON.parse(msg)) } catch (err) {}
  }

  setInterval(fitTick, 250)

  // —— 鲸鱼朝向：主进程按窗口在屏幕左/右半决定是否镜像（贴左 => 面朝右，同浏览器吸附语义）——
  window.__DSHW_FLIP__ = false
  function applyFlip(flip) {
    window.__DSHW_FLIP__ = !!flip
    try {
      var root = document.querySelector('.dshwv-root')
      if (root) root.classList.toggle('dshwv-left', !!flip)
    } catch (err) {}
  }
  if (window.__dshwDesktop && window.__dshwDesktop.onFlip) {
    window.__dshwDesktop.onFlip(applyFlip)
  }

  // —— 拖窗口任意处 = 移动窗口（鲸鱼本体由挂件补丁驱动，这里只补非交互区域）——
  // 交互区（菜单/面板/遮罩/按钮/输入框/气泡图）除外：那些区域照常交给挂件自己处理。
  var DRAG_SKIP =
    '.dshwv-img,.dshwv-menu-btn,.dshwv-menu,.dshwv-rolelist,.dshwv-audiolist,.dshwv-slotlist,' +
    '.dshwv-custmenu,.dshwv-custbtn,.dshwv-cropmask,.dshwv-confirmmask,.dshwv-audiomask,' +
    '.dshwv-snapmask,.dshwv-bubmask,.dshwv-qedit,.dshwv-usagepanel,.dshwv-usage-mask,' +
    '.dshwv-resmask,.dshwv-rgbmenu,input,select,textarea,button'
  var winDrag = null
  document.addEventListener('pointerdown', function (e) {
    if (!window.__dshwDesktop || !window.__dshwDesktop.dragMove) return
    if (e.button !== 0) return
    var t = e.target
    if (t && t.closest && t.closest(DRAG_SKIP)) return
    winDrag = { sx: e.clientX, sy: e.clientY, moved: false }
  }, true)
  document.addEventListener('pointermove', function (e) {
    if (!winDrag) return
    var dx = e.clientX - winDrag.sx
    var dy = e.clientY - winDrag.sy
    if (!winDrag.moved && dx * dx + dy * dy >= 9) winDrag.moved = true
    if (!winDrag.moved) return
    try { window.__dshwDesktop.dragMove(dx, dy) } catch (err) {}
  }, true)
  function winDragEnd() {
    if (!winDrag) return
    winDrag = null
    try { if (window.__dshwDesktop && window.__dshwDesktop.dragEnd) window.__dshwDesktop.dragEnd() } catch (err) {}
  }
  document.addEventListener('pointerup', winDragEnd, true)
  document.addEventListener('pointercancel', winDragEnd, true)
})()
