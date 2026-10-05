# dsh-whale-desktop

把 DSH Web 插件 [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
**原样**渲染到一个独立的**透明、无边框、置顶**桌面悬浮窗里
每轮消耗、提问/授权挂起……这些“广播事件”都照常冒泡 —— 相当于“在另一个地方登录了 DSH”。

## 本仓库只有“桌面壳”，不含上游源码

上游 `dsh-whale-widget` 是**持续更新**的项目，而整体显示机制稳定。因此：

- 本仓库**不内置、不硬编码**上游前端源码（`vendor/` 已 gitignore）；
- **编译期**用 `scripts/fetch-widget.mjs` 从 npm 官方源拉取最新前端 → `vendor/dsh-whale-widget/`；
- 运行时按优先级取源：`DSHW_WIDGET_DIR` > `vendor/`（编译期拉取） > 本机 DSH 已装插件（开发兜底）；
- 壳只维护「取源 + 适配层」：一小批**跨版本稳定锚点**的字符串补丁（见下），
  关键补丁失配会**明确报错拒绝启动**（绝不带病运行），非关键补丁失配则降级并在状态提示里告警。

```bash
npm run fetch:widget                 # 拉取 npm latest（编译前会自动跑）
npm run fetch:widget -- --version 0.3.18   # 复现构建：钉住某个上游版本
npm run fetch:widget -- --offline    # 完全离线：沿用现有 vendor 副本
npm run fetch:widget:latest          # 强制重拉最新
npm run dist                         # 先拉最新前端，再 electron-builder 打包
```

拉取后会写 `vendor/dsh-whale-widget/VERSION.json`（版本 / tarball / sha512 / sha256 / 抓取时间），
便于追溯「这次构建用的是哪个上游版本」。

## 特性 / 与浏览器版的关系

| 项目 | 行为 |
|---|---|
| 数据（余额 / 今日已用 / 每轮消耗 / 提问·授权 / 角色 / 音效 / 泡泡图） | **与浏览器版一致**：只读代理到 DSH 的 `/dsh-whale/*`，同一份“广播” |
| 挂件设置（大小 / 泡泡内容 / 音效与提示 / 预算预警） | **完全独立**：只写本机 `userData/settings/`，绝不写 `~/.dsh/*` |
| 首次启动 | 从 DSH 现有 `.dshw-size.json` / `.dshw-bubble.json` 抄一份做种子，之后各改各的 |
| 窗口 | 透明 + 无边框 + 置顶 + 无任务栏；**大小 = 插件当前想展示的大小**（鲸鱼本体尺寸；菜单/面板展开自动撑大，收起自动缩回，鲸鱼在屏幕上纹丝不动） |
| 拖动 | **拖动窗口任意处 = 移动窗口；窗口内的小鲸鱼永不挪位**（永远钉在窗口右下角） |
| 点按 | 点鲸鱼照常冒泡（点击序列 / 余额泡 / 消耗泡 / 提问·授权泡），右键/长按唤菜单，音效照常 |

## 快速开始

前置：DSH web 正在运行，且已安装 `dsh-whale-widget` 插件（`dsh plugin --profile web add dsh-whale-widget`）
—— 数据（余额/消耗/挂起）来自该插件在 DSH 里注册的路由，桌面壳只读它们。

```bash
git clone https://github.com/Yaing-Yan/dsh-whale-desktop.git
cd dsh-whale-desktop
npm install                       # 装有 npm_config_allow_scripts 等环境变量的 shell 需先 unset，见下
npm run install:app               # 可选：拉取上游前端 + 生成图标 + 注册到系统应用列表
npm start                         # 会自动 fetch:widget --if-missing；Linux 无 setuid sandbox 时用 npm run start:no-sandbox
```

> 仓库里**没有**上游前端源码，`npm start` / `npm run install:app` 会自动拉取；
> 也可随时手动 `npm run fetch:widget`。

> 这台机器（Arch）的 shell 里 `npm_config_allow_scripts` 被设成只允许部分包，
> 会直接报 `EALLOWSCRIPTS` 拒绝 Electron 的 postinstall。用
> `env -u npm_config_allow_scripts npm install` 装一次即可（装完不影响日常启动）。

启动后右下角出现小鲸鱼；拖动任意位置移动它，点它出泡泡。托盘图标可显示/隐藏/退出。
右上角会短暂显示一条状态提示，含当前使用的挂件版本与来源。

**鲸鱼朝向**：窗口在屏幕左半时小鲸鱼自动镜像（面朝屏幕中心，同浏览器“贴左吸附翻转”的
语义）；拖到右半恢复原朝向。主进程按窗口实测位置每 2 秒同步一次，拖动过程中即时生效。

## 加入系统应用列表

```bash
npm run install:app       # 生成图标 + 注册（应用列表/启动器里出现「DSH 小鲸鱼（桌面版）」）
npm run uninstall:app     # 移除
```

各平台落地方式：

| 平台 | 落地位置 |
|---|---|
| Linux | `~/.local/share/applications/dsh-whale-desktop.desktop` + `~/.local/share/icons/hicolor/<size>/apps/dsh-whale-desktop.png`，并刷新 desktop/icon 缓存 |
| macOS | `~/Applications/DSH 小鲸鱼.app`（最小 .app 包装，Spotlight/启动台可搜到；有 `sips`/`iconutil` 时自动转 .icns） |
| Windows | 开始菜单快捷方式（PowerShell 创建，指向 `bin\dsh-whale-desktop.cmd`） |

- 所有平台的入口都指向 `bin/dsh-whale-desktop*` 启动器：它会解析自身路径、必要时补拉上游前端、
  按需加 `--no-sandbox`，所以路径/版本变化都不影响已有快捷方式。
- `.desktop` 的 `StartupWMClass=dsh-whale-desktop` 与 Electron 窗口的 wm_class 一致，
  alt-tab / 任务栏能把窗口正确归到这个图标上。
- 图标源同样来自上游（编译期拉取的角色图），`npm run icons` 可随时重建；
  **打包安装版**（`npm run dist`）由 electron-builder 自动生成应用列表项，无需本脚本。

## 它是怎么工作的

1. **认证**：DSH web 的信任栅栏要求请求带一个 HMAC 签名 Cookie，签名密钥明文存在
   `$DSH_HOME/.credentials.yaml`（`records["client-connection/browser-session"].payload.secret`）。
   桌面版读密钥 → 用与 DSH 相同的算法**离线铸造 Cookie** → 全程不碰浏览器、不碰会话令牌。
2. **数据通道**：渲染层跑的是插件原前端（`assets/whale-widget.js` 打 7 处补丁），它每秒轮询
   `wait.json`（提问/授权）、`last-turn.json`（每轮消耗）、每 60 秒轮询 `balance.json`。
   这些请求落到**本地代理服务器**，代理带上铸造的 Cookie 转发给 DSH —— 事件照常冒泡。
3. **设置独立**：`size.json` / `bubble.json` / `usage-settings.json` 的读写由本地代理
   直接落到 `userData/settings/`，网络层根本不碰 `$DSH_HOME`。
4. **桌面化补丁**（`main/patch.js`，字符串级、逐条断言、按源文件 mtime 缓存，插件升级自动重打）：
   - 独立模式无条件启动（浏览器里要等 DSH 聊天页的 composer）；
   - 鲸鱼基准尺寸从“视口的 28%”改为 `clamp(122px, 250px×scale, 625px)`，与浏览器 1080p 视觉一致；
   - 拖动只移动窗口、绝不在窗口内移动鲸鱼（`express()` 把 root 钉死在右下角）；
   - `express()` 里鲸鱼四周留**对称 10px 边距**、且不叠加浏览器滚动条避让偏移 —— 否则底边距为 0，鲸鱼会被窗口底边裁掉；
   - 抬手仍是“点击”语义（冒泡照常）；
   - 翻转跟随 `window.__DSHW_FLIP__`（主进程按屏幕位置下发）。
5. **自适应尺寸（含贴边锚定感知 + 防抖）**：渲染层 250ms 轮询挂件 DOM：
   - 过滤“祖先隐藏但自身 opacity=1”的幽灵元素（如收起中的菜单行）；
   - 每个可见元素带**锚定标记**：`ab`（内联 `style.bottom` 且 `top:auto` = 贴底向上生长）、`ar`（贴右）。
     注意必须读**内联**样式 —— `getComputedStyle` 对定位元素返回 used value，`top/left` 永远不是 `auto`；
   - 鲸鱼本体尺寸变化**立即**上报（缩放滑块等），其它 UI 变化需**连续两轮一致**（约 500ms 定格）；
   - 主进程按锚定方向算所需尺寸：贴底元素用 `h = (vh - t) + M`（**不是** `b + M`）——
     它是跟着窗口底边走动的，用 `b + M` 会「装得下→缩小→又溢出→再放大」无限来回跳；
   - 再叠加 ±6px 死区。窗口因此既能完整容纳菜单/面板，又不会“蠕动”。
6. **尺寸自愈**：主进程记住最近的目标尺寸，窗口 `show` 时立即校验、之后每 2 秒校验一次，
   实际尺寸偏离 >6px 就纠正 —— 解决“托盘点两下第二次出现巨大透明窗、要激活一下才恢复”的问题。
   初始窗口尺寸也直接按设置里的缩放算好，启动不再出现 900×780 → 缩小的闪烁。

## 平台矩阵（重要）

| 平台 | 透明窗 | 置顶 | 拖动移窗 | 自适应缩放 | 备注 |
|---|---|---|---|---|---|
| Windows 10/11 | ✅ DWM | ✅ | ✅ `setPosition` | ✅ `setBounds` | Electron ≥ 37；Win7/XP 不支持（系统限制） |
| macOS | ✅ | ✅ | ✅ `setPosition` | ✅ `setBounds` | 不占 Dock；菜单栏图标控制 |
| Linux · X11（GNOME/KDE 等） | ✅（需合成器） | ✅ | ✅ `setPosition` | ✅ `setBounds` | 无合成器时窗口会黑底，可改不透明底色（见下） |
| Linux · Wayland · **Hyprland** | ✅ | ✅ | ✅ 走 `hyprctl dispatch`（协议不允许客户端自定位） | ✅ 走 `hyprctl dispatch resize` + 实测坐标回锚 | 需要浮窗规则，见下 |
| Linux · Wayland · KDE/GNOME | ✅ | ✅ | ⚠️ 无公开外部移动 API：**只能 Alt+拖拽**（合成器手势） | ✅（Electron 能改尺寸，位置由合成器决定） | 这是 Wayland 协议限制，非本应用缺陷 |
| WSL2（WSLg） | ✅（需桌面） | ✅ | ⚠️ 同 Wayland 限制 | ✅ | 托盘可能不可用（自动降级，不影响挂件） |

### Hyprland 用户必读

1. **浮窗规则**：Hyprland 默认平铺新窗口。本应用在 `HYPRLAND_INSTANCE_SIGNATURE` 存在时
   会自动注入浮窗规则（运行时、不落盘；0.5x Lua 配置的新版语法，旧版自动回退 legacy `keyword`）：
   - Hyprland ≥0.5x（Lua 配置）：`hyprctl eval 'hl.window_rule({ match = { class = "^(dsh-whale-desktop)$" }, float = true, border_size = 0, rounding = 0 })'`
   - 旧版：`hyprctl keyword windowrule 'float, class:^(dsh-whale-desktop)$'`
   ⚠️ **不要加 `no_focus`**：Hyprland 的 `no_focus` 会让合成器把窗口当“不可交互”处理，
   实测点击直接穿透到下面的窗口。需要“点击不抢键盘焦点”时用 `noinitialfocus`（只影响启动时的焦点）。
2. 想关掉自动注入：`settings/dsh.json` 里写 `{ "hyprlandFloat": false }`。

### 输入/透明窗注意事项（重要经验）

- **Wayland 透明窗点击穿透**：若某个合成器/版本下窗口能看见但点击穿透，先确认：
  ① 没有把窗口误设成 `no_focus`；② 合成器没有处于“锁屏崩溃”状态（Hyprland 遇到 hyprlock
  崩溃会黑屏+吞输入，恢复命令：`hyprctl --instance 0 eval 'hl.clear_crashed_lockscreen()'`）。
- **Electron ≥ 41**（本项目用 44）：`setIgnoreMouseEvents` 在 Wayland 上才有了真正的输入区域
  实现；主进程启动时会显式调用 `win.setIgnoreMouseEvents(false)` 把输入区域钉死为全窗口。
  更早的 Electron（如 37）该 API 在 Wayland 上是 no-op，若遇到穿透建议升级 Electron。
- 仍然穿透时的两条降级通道（二选一）：
  1. 用 XWayland 跑：`npm run start -- --ozone-platform=x11`（X11 输入路径最成熟）；
  2. 改用不透明底：`settings/dsh.json` 设 `{ "backgroundColor": "#1e293b" }`。

### 无合成器 / WSL 黑底兜底

`userData/settings/dsh.json`（本机路径：Linux `~/.config/dsh-whale-desktop/settings/dsh.json`、
Windows `%APPDATA%\dsh-whale-desktop\settings\dsh.json`、macOS `~/Library/Application Support/dsh-whale-desktop/settings/dsh.json`）支持：

```json
{
  "backgroundColor": "#1e293b",
  "hyprlandFloat": false,
  "origin": "http://127.0.0.1:3080"
}
```

- `backgroundColor`：填任意颜色 → 窗口改用不透明底色（透明窗渲染成黑底的临时出路）。
- `origin`：DSH 不在 3080 端口时改这里（或环境变量 `DSHW_DSH_ORIGIN` / `DSHW_DSH_PORT`）。
- 其它环境变量：`DSH_HOME`（数据目录）、`DSHW_PLUGIN_DIR`（插件前端位置）。

## 文件

| 路径 | 说明 |
|---|---|
| `scripts/fetch-widget.mjs` | **编译期拉取上游前端**（npm registry → vendor/，含 sha512 校验与版本记录） |
| `scripts/install-app.mjs` | 注册/移除系统应用列表项（Linux .desktop / macOS .app / Windows 快捷方式） |
| `scripts/make-icons.mjs` | 用 Electron 缩放生成应用与打包图标（跨平台零依赖，源取上游角色图） |
| `bin/dsh-whale-desktop*` | 启动器（应用列表项指向它；解析路径、按需补拉前端、按需 --no-sandbox） |
| `main/main.js` | Electron 主进程：窗口/托盘/IPC/平台适配/尺寸自愈 |
| `main/auth.js` | 读取 DSH 会话密钥 → 铸造签名 Cookie |
| `main/proxy.js` | 本地 HTTP 服务：渲染层 + 只读代理 + 独立设置存储 |
| `main/patch.js` | 取源（vendor > 本机插件）+ 适配补丁引擎（缓存到 userData/cache） |
| `renderer/loader.js` | 桌面化垫片：启动自检 / 自适应窗口 / “拖任意处移窗” / 朝向 |
| `preload.cjs` | contextBridge（最小窗口控制面） |
| `vendor/`（gitignore） | 编译期拉取的上游 `whale-widget.js` + `VERSION.json` |
| `userData/settings/*` | 本挂件的独立设置（size/bubble/usage-settings/window/dsh） |

## 适配层（补丁）与上游版本漂移

补丁全部是**字符串级、逐条断言**，并刻意挑选**跨版本稳定锚点**（例如拖动补丁只认
`state.left = clamp(drag.origLeft + dx, ...)` 这一行 —— 它在 0.3.17/0.3.18 里都恰好出现一次，
而它周围的实现细节上游改过）。已实测 `0.3.17` 与 `0.3.18` 两个版本 **7/7 命中**。

- **关键补丁**（启动门槛、基准尺寸、钉位边距）：任一失配 → 拒绝启动并打印明确原因与所需操作；
- **非关键补丁**（拖动桥、抬手语义）：失配 → 降级运行，并在右上角状态提示里列出缺失项。

上游大改导致关键补丁失配时的处理：`npm run fetch:widget -- --version <上一个可用版本>` 钉住版本先跑，
同时按报错信息调整 `main/patch.js` 里的锚点。

## 打包（全平台）

开发依赖里已声明 `electron`。要打安装包，加 `electron-builder` 后在**对应平台**上执行：

```bash
npm i -D electron-builder
npx electron-builder --win nsis --mac dmg --linux AppImage
```

（`electron-builder` 的图标、asar 等可按需在 `package.json` 的 `build` 字段配置；跨平台打包需在各平台分别执行或配置 CI。）

## 已知边界

- Wayland（非 Hyprland）：客户端无法自定位是协议限制；KDE/GNOME 上用合成器手势（Alt+拖拽）。
- Windows XP / 7：Electron 37 不支持，属系统层面限制。
- 本应用依赖 DSH web 运行 + 插件已装：DSH 未启动时挂件显示“无法连接”提示，不影响窗口本身。

## 许可与来源

- 本仓库（桌面壳）: **MIT**，见 [LICENSE](LICENSE)。
- 上游挂件 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget): **MIT**。
  本仓库**不包含**其源码 —— 编译期从 npm 官方源拉取到 `vendor/`（已 gitignore），运行时仅做字符串级适配；
  上游版权与许可归其作者所有。
- 应用图标由上游角色素材缩放生成（`npm run icons`），仅用于本应用标识。
