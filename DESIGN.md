# SSH Workbench — 整体方案与设计文档

> 轻量级 SSH 客户端 + 嵌入式技术支持工作台
> 更新时间：2026-10-27 ｜ 阶段：v1.5.2，P0–P4 已实现，v1.1-v1.5 新增连接分组管理、大规模连接性能优化、断线自动重连、命令中心范围筛选、侧栏文件面板右键下载、分组 Combobox、命令卡文本溢出修复、应用内自动更新、SFTP 批量目录读取、文件面板跟随终端 cwd（v1.5.2 修掉「开了跟随却看不到」）

---

## 1. 项目定位与范围

面向嵌入式设备技术支持场景的桌面工具：快速连上现场设备、执行常用制式命令、归档排查过程。

**明确不做**：串口终端、AI 日志分析。

## 2. 技术选型与决策记录

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Electron 33 + electron-vite** | 经评估后确定（见下方决策记录）；Node 22 环境零额外前置，ssh2 生态成熟 |
| 前端 | React 18 + TypeScript + Vite | 组件生态完整，类型贯通主/渲染进程 |
| UI | Tailwind CSS（语义色变量）+ lucide-react | 主题切换只换 CSS 变量（7 套配色 × 明暗，见 §5.7）；图标按名字动态解析 |
| 终端 | @xterm/xterm + addon-fit / addon-search / addon-web-links | 事实标准 |
| 文件传输 | zmodem.js（`rz` / `sz`）+ ssh2 SFTP 分块读写 | 终端内传文件；SFTP 支持暂停续传 |
| SSH | ssh2（主进程） | 支持密码 / 私钥 / Agent / ProxyJump / SFTP / forwardOut，纯 JS 可运行 |
| 状态管理 | Zustand | 轻、无样板代码 |
| 本地存储 | **JSON 文件**（`userData/data/`） | 零 native 依赖（better-sqlite3 需按 Electron ABI 重建，团队机器易装不上）；数据量小；可读可改、方便备份。封装在 repository 层，将来换 SQLite 只动这一层 |
| 凭据 | Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）+ 内存降级 | 密码、私钥口令永不落明文；无需 keytar 原生依赖 |

### 决策记录：为什么是 Electron 而不是 Tauri

原需求 Tauri 2 优先，评估后改为 Electron，理由：
1. 本机无 Rust 工具链与 MSVC Build Tools（Tauri 的硬前置，约 4–5GB 安装量，可能需管理员权限）；
2. Tauri 需用 rustsh/russh-sftp 重写全部 SSH/SFTP/隧道逻辑，交付周期显著拉长；
3. Electron 冷启动约 1–2s、安装包约 90MB，对内部技术支持工具属可接受区间；
4. **架构上保留了迁移弹性**：SSH 与全部系统能力收敛在主进程 + preload 桥（`window.api`）之后，渲染层不直接接触任何 Node/Electron API。将来若迁 Tauri，只需重写 main/preload 两层，5000+ 行渲染层代码不动。

## 3. 目录结构

```
ssh-workbench/
├─ electron.vite.config.ts        # 三端构建配置（main / preload / renderer）
├─ electron-builder.yml           # 打包配置（win nsis + portable / mac dmg / linux AppImage）
├─ build/ · resources/            # 多尺寸 icon.ico / icon.png（scripts/make-icon.cjs 生成）
├─ scripts/                       # make-icon.cjs、verify-*.cjs 自检脚本、check-integrity.ps1、release.ps1、probe-* 一次性排查脚本
├─ tailwind.config.js             # 语义色 -> CSS 变量映射
├─ src/
│  ├─ shared/                     # 三端共享（唯一契约来源）
│  │  ├─ types.ts                 #   全部数据模型 + IPC 请求/响应类型
│  │  └─ ipc.ts                   #   IPC 通道常量
│  ├─ main/                       # Electron 主进程（全部系统能力）
│  │  ├─ index.ts                 #   窗口、IPC 注册、生命周期、--smoke 自检
│  │  ├─ updater.ts               #   自动更新状态机（electron-updater，主进程单点维护）
│  │  ├─ store/
│  │  │  ├─ jsonStore.ts          #   原子写 JSON 存储（临时文件 + rename + 写队列）
│  │  │  ├─ repository.ts         #   连接/命令/历史/设置/已知主机 CRUD（唯一持久化入口）
│  │  │  └─ vault.ts              #   凭据保险箱（safeStorage 加密）
│  │  ├─ ssh/
│  │  │  ├─ sftpManager.ts        #   SFTP 管理 + 传输队列（分块读写、暂停/续传/取消、进度节流上报）
│  │  │  ├─ connectConfig.ts      #   连接配置构建（认证/指纹校验）+ 建连原语 + 错误翻译
│  │  │  ├─ sessionManager.ts     #   会话管理（跳板链/shell/合帧转发/延迟探测）
│  │  │  └─ testConnection.ts     #   测试连接
│  │  ├─ ssh/ 其余               #   exec / batchExec / diagnostics / metrics / firmware / netScan / portForward
│  │  ├─ util/                    #   parseSshCommand、socks5、proxySockets、zip、lineDiff、mdns、arp 等纯函数
│  │  └─ data/seedCommands.ts     #   内置常用命令（42 条，首次运行注入）
│  ├─ preload/
│  │  ├─ index.ts                 # contextBridge 暴露 window.api（类型化）
│  │  └─ index.d.ts               # Window 全局类型声明
│  └─ renderer/                   # React 渲染层
│     ├─ index.html
│     └─ src/
│        ├─ App.tsx               # 布局总装 + 全局快捷键 + 事件订阅 + 拖拽执行
│        ├─ styles/index.css      # 主题变量（暗/亮）+ 组件类（btn/input/menu/modal）
│        ├─ theme/colorThemes.ts  # 7 套配色 × 明暗（界面 CSS 变量 + xterm 主题同源）
│        ├─ lib/                  # utils / ipc 解包助手 / 图标白名单
│        │  ├─ fuzzy.ts           #   零依赖模糊匹配（子串 + 子序列，带命中区间）
│        │  ├─ commandSearch.ts   #   命令检索：字段加权 / 中英同义 / 使用热度 / 范围索引
│        │  ├─ layout.ts          #   栏宽规格表（上下限 / 拖拽换算 / 夹取）
│        │  ├─ shortcuts.ts       #   快捷键动作表与默认键位
│        │  ├─ shellCwd.ts        #   终端 cwd 推断：输入行追踪 + cd 解析 + OSC 7（零依赖纯逻辑）
│        │  ├─ dirLoader.ts       #   同帧目录请求合并成一条 SFTP_LIST_MANY IPC
│        │  ├─ dirCache.ts        #   目录结果 TTL 缓存（stale-while-revalidate）
│        │  └─ zmodem.ts          #   ZMODEM 会话（Sentry 接管字节流、分块保存）
│        ├─ stores/               # zustand：settings/layout/connection/session/command/execution/sftp/cwd/toast/ui 等
│        │                        #   cwdStore 按 sessionId 隔离终端 cwd（不进持久化，会话关闭即清）
│        └─ components/
│           ├─ layout/            #   TitleBar / ActivityBar / SideNav / MainWorkspace / CommandRail / TabBar / StatusBar / PaneResizer / UpdateBadge
│           ├─ connections/       #   ConnectionSidebar / ConnectionEditor
│           ├─ terminal/          #   TerminalView（xterm 集成）/ ZmodemOverlay
│           ├─ files/             #   FileExplorer / SessionFileTree / 双栏 Local/RemotePane / TransferProgressDock
│           ├─ commands/          #   CommandPanel / CommandCenter / CommandEditor / Highlight
│           ├─ panels/            #   HistoryPanel
│           ├─ settings/          #   SettingsPanel / UpdateSection（软件更新分区）
│           ├─ execution/         #   VariablePromptDialog / DangerConfirmDialog
│           └─ ui/                #   Modal / ConfirmDialog / ContextMenu / Toast / Combobox / 表单件
```

## 4. 架构与数据流

```
渲染层 (React)              preload 桥               主进程 (Node)                 远端设备
─────────────              ─────────────             ─────────────                 ────────
window.api.xxx  ──invoke──▶ contextBridge ──ipc──▶  ipcMain.handle
                                                     ├─ repository ─▶ JSON 文件
                                                     ├─ vault ─▶ 系统凭据加密
                                                     └─ sessionManager ──ssh2──▶  SSH/SFTP
xterm.write  ◀──webContents.send── EVT_SESSION_DATA ◀── shell data（8ms 合帧）
```

要点：
- **渲染进程零 Node 权限**：所有能力经 `window.api`（`IpcResult<T>` 统一包装，主进程异常永不越过 IPC 边界）；
- **高频数据合帧**：shell 输出在主进程按 8ms 窗口合并后成批推送，`StringDecoder` 保证跨帧多字节字符不断裂；
- **输入路径**：xterm `onData` → `session:write` → shell.write；尺寸变化经 `ResizeObserver → fit → session:resize` 同步到远端 PTY。
- **反向路径（cwd 跟随）**：xterm `onData` 同时喂给 `shellCwd` 追踪器推断回车后的目录；`onData` 里解析出的 OSC 7 与 `sessionManager` 转发的 OSC 7 谁先到算谁，结果写 `cwdStore[sessionId]`，`FileExplorer` 订阅后按需批量拉目录（§5.11）。这条链路只读观察字节流，不向 PTY 注入任何东西。
- **更新链路**（§5.12）：主进程 `updater.ts` 是唯一状态源 → `EVT_UPDATE_STATUS` 推给渲染层 → `UpdateBadge` / `UpdateSection` 纯展示；命令方向是 `update:check / download / install`。渲染层不自己比版本号。

## 5. 常用命令执行流水线（重点模块）

```
单击命令 / 拖拽到终端 / 历史重发
        │
        ▼
① 取当前活动终端 ── 无会话？→ toast「请先打开一个 SSH 连接」
        │
        ▼
② 解析模板中的 {{变量}}（定义 + 文本自动提取，模板里用了但未声明的也会被询问）
        │ 有变量 → 弹窗填写（实时预览替换结果，required 校验）
        ▼
③ 危险检查 = 命令自身标记 confirmRequired ‖ 命中全局关键词（settings.dangerPatterns）
        │ 命中 → 二次确认弹窗（展示最终命令 + 目标会话）
        ▼
④ session.write(命令 + "\r") + 写历史（含变量值、来源、会话信息）
```

- 命令数据模型含 `variables / confirmRequired / icon / color / group / sortOrder / useCount`；
- 面板支持分组折叠、关键字搜索、组内拖拽排序（不动其他组）、右键（执行/编辑/复制/删除）；
- 历史可一键收藏为常用命令（入「收藏」分组），useCount 随执行自动累计。

### 5.1 命令检索模型（P3-c 增补）

- 三层纯函数：`fuzzy.ts`（子串/子序列打分 + 命中下标）、`commandSearch.ts`（范围过滤 + 排序 + 同义词）、`layout.ts`（栏宽规格）；
- **按钮墙优先**：搜索词为空时，`CommandPanel` 与 `CommandCenter` 都按分组铺「堆叠按钮墙」，不再铺长列表 —— 命令多到几十条以后，找一条命令本来就该是「用眼睛扫」，而不是先想关键字再搜；一旦输入关键字才退回按相关度排序的列表；
- **按钮墙列数自适应**：`CommandPanel` 用 `grid-template-columns: repeat(auto-fill, minmax(112px, 1fr))`（横排 132px），列数由侧栏实际宽度决定 —— 侧栏现在可拖到 220~520，写死 `grid-cols-2` 在 520 时会剩一大片空白、在 220 时把命令名挤成省略号。冒烟 `wallColsProbe` 卡住这条：280px → 2 列、520px → 4 列；`CommandCenter` 浮层宽度固定，仍用 `WALL_COLS = 3`，**键盘 ↑↓ 的步长必须等于列数**，否则光标会跳到相邻列而非相邻行；墙上 `←/→` 单格移动；
- 卡片只显示「图标 + 名称 + 命令行」，热度/相对时间/危险标记都收进 `title`，目标是可扫读；右上角一个槽位，平时显示角标（Pin / 警示 / 变量），悬停交叉淡入换成收藏与编辑按钮 —— 两者不能同时占据同一坐标，否则按钮会盖在警示三角上；
- **卡片底色用 `bg-app`（白）+ `border-edge` 实边框**，不用 `bg-raised`：侧栏底色是 `#f8f9fa`，`#fafafa` 只差 1.5%，126 个按钮会糊成一片看不出边界；
- **分组标题竖排时 `sticky top-0`**：一屏放不下 10 个分组，滚两屏后看不出自己在哪个分组里；横排是每分组一列，列头天然常在，不吸顶；
- 性能：卡片里的索引必须走 `Map`（`flatIndexById` / `resultIndexById`），不能每块都 `findIndex` —— 否则鼠标一动 `setCursor` 就触发 O(n²) 重算。

命令管理器两个入口：

命令一多，原来的「长列表 + 分组折叠 + `toLowerCase().includes` 过滤」就不够用了：搜 `gst` 找不到 `git status`，搜 `disk` 找不到「磁盘占用」（名字是中文、命令是英文）。因此把检索拆成三层独立纯函数，可单测、不依赖 React。

**① 模糊匹配 `src/renderer/src/lib/fuzzy.ts`**

`fuzzyMatch(text, query): { score, indices, direct } | null`

- 子串命中走高分档（1000 基分：开头 +220、词首 +130、长度稀释扣分），`direct = true`；
- 否则走子序列（每个字符词首 +18 / 连续 +10 / 越靠前越高，跨度越长扣分），`direct = false`；
- **子序列带地板值 `SUBSEQUENCE_FLOOR = 118`，低于就返回 null** —— 长 shell 命令里随手能凑出 `d…i…s…k`，不设地板敲 `disk` 会冒出「GPIO 状态」（其命令文本含 `debugfs…kernel`）；
- 返回 `indices` 供 UI 高亮。

**② 中英同义扩展 `commandSearch.ts` 的 `SYNONYMS` / `synonymsOf()`**

命令名是中文（「磁盘占用」）、命令文本是英文（`df -h`），只按字面匹配必然对不上。维护 22 组 `{ zh: [...], en: [...] }` 对照表，`synonymsOf(query)` 返回同义的「另一半」词：

- 只收有辨识度的词；`dev` / `ip` / `config` / `image` / `unit` 这类通用词一律不收，否则搜「串口」会把所有含 `/dev/` 的命令全捞进来；
- 单字符不扩展（噪声太大）；
- **别名兜底时只认子串命中（`demandDirect`），且得分 ×0.8** —— 别名都是 2~3 字母短词，放开子序列会给「错误关键字汇总」「查看 IP 地址」「重启网络服务」这类误命中开门；
- 命中别名时在 `RankedCommand.via` 里记录来源，UI 显示「≈磁盘」小徽标，用户能看懂为什么这条被列出来。

**③ 排序与范围 `searchCommands` / `buildScopes`**

- 字段权重：名称 ×3、命令 ×2、分组 ×1、描述 ×0.6，取最高分那一路；
- 使用热度 `usageScore = log2(1 + useCount) × 26 + 40 × exp(-天数 / 7)`（次数取对数 + 一周半衰），叠加 ×0.5；
- 收藏是硬加权（+1000），保证置顶；
- 范围索引 `buildScopes`：全部 / 最近使用（30 天窗）/ 最常用 / 已收藏 四个虚拟范围，后面接真实分组（支持 `k8s/pod` 这类层级，带深度缩进与计数）。

**热度数据链路**：`Command.useCount / lastUsedAt` 两个字段本来就在模型里但从未写入。现由 `executionStore.send()` 在命令写进终端后调 `window.api.command.touch(id)`，主进程 `touchCommand()` 读改写累加 —— 于是「最近 / 最常用」不再是摆设。

**两个入口共享同一套检索**：
- `CommandPanel`（右栏，常驻）：搜索框常驻 + 全部/收藏/最近 chip + 排序轮转；无搜索词时按分组铺按钮墙，单击执行、`Ctrl+单击` 编辑、右键更多；
- `CommandCenter`（`Ctrl+K` 全屏浮层）：左范围索引 + 顶部搜索 + 三档排序 + 键盘全操作（↑↓←→ 选择 / ↵ 执行 / Ctrl+↵ 编辑 / Tab 切范围 / Ctrl+D 收藏）；无搜索词时同样是按钮墙，底部提示条会显示「按钮墙」。

### 5.2 栏宽可调（UI 精緻度）
- 现在有**两个**可拖区域：`src/renderer/src/lib/layout.ts` 的 `PaneKey = 'sidebar' | 'commandRail'`；
  - `PANE_SPECS.sidebar = { default: 280, min: 220, max: 520, axis: 'x', sign: 1 }` —— 默认从旧的 250 提到 280，因为 250 时 `root@192.168.100.120` 会被截断成 `root@192.168.100.…`，一行认不出是哪台设备；
  - `PANE_SPECS.commandRail = { default: 380, min: 340, max: 600, axis: 'x', sign: -1 }` —— 下限 340 是「固定三列放得下」算出来的（每列要放图标 20 + 间隔 6 + 内边距 16，再留 4~5 个中文字），上限 600 是「再宽不如收起，把宽度还给终端」；
- **`sign` 决定拖动方向语义**：左侧栏 `sign=1`（向右拖变宽），右侧命令栏 `sign=-1`（向左拖变宽）。这是这套代码最容易写反的地方，`verify-layout.cjs` 对两栏各测一遍「拖出去到底是变宽还是变窄」；
- 连接 / 文件 / 历史 / 日志 / 隧道五个面板共用左侧栏（由 `useLayoutStore.activityView` 切换），常用命令**不在侧栏**（见 §5.6）；老配置里的 `fileTree / commandPanel / commandPanelHeight` 被 `resolveLayout` 直接忽略，`LayoutSizes` 已收缩为 `{ sidebar?, commandRail? }`；
- `PaneResizer` 组件：拖拽改宽、双击复位、方向键微调、悬停/拖拽/已自定义时高亮；热区用负 margin 做到净占位 0，不占布局宽度；对应栏收起时不渲染 —— 否则 6px 热区留在窗口边缘，拖动会「拖出」看不见的宽度；
- **拖拽期间只改局部 state，松手才落盘** —— settings 走主进程串行读改写，每帧写会变成打字机手感；
- **落盘必须整份 `layout` 写入** —— `mergeSettings` 对 `layout` 是浅合并，只写单个键会把另一栏尺寸冲掉；
- **提交值时不能用 props 的旧值**：`pointerup` 常与最后一次 `pointermove` 落在同一任务里，React 尚未重渲染，若 `endDrag` 用 `valueRef.current` 提交，会把刚拖出的宽度原样冲回去（实测 `beforeDrag:280 → afterDrag:280`）。必须维护独立的 `liveRef`，`moveDrag` 内同步更新，`endDrag` 用 `liveRef.current` 提交；
- 设置面板「侧栏宽度」可输入数值、复位默认；hint 指向「拖动分隔条，双击复位」。
- 两个分隔条的 `aria-label` 分别是「调整侧边栏」和「调整命令栏」，冒烟一律用 `[role="separator"][aria-label="…"]` 精确定位 —— 裸 `[role="separator"]` 靠 DOM 顺序猜，改布局就会抓错目标。

### 5.3 大列表性能（「客户端好卡」专项）

实测数据（用户真实库）：`connections.json` 1.0 MB / **2929 条连接**，其中 XCMD 组 **2917 条**；`commands.json` 126 条 / 10 组。

根因与处置（按贡献排序）：

| 根因 | 处置 |
|---|---|
| 侧栏把 2929 条全量 `map`，超长分组默认展开 → 万级 DOM | `PAGE_SIZE = 60` 分页 + `LARGE_GROUP = 200` 超长组默认折叠 + 尾部「还有 N 条，继续展开」 |
| 每行 `sessions.find(...)` → O(n²) | `sessionByConn` 用 `Map` 预建索引 |
| 每会话一个 5s `setInterval` 发 `echo` 探活 → N 会话 × 每 5s | 改为**全局单定时器轮转**：`PROBE_TICK_MS = 1000` 每秒推进一个会话，`PROBE_MIN_GAP_MS = 5000` 保底间隔；无活会话自动停表 |
| `updateLatency` 重建整个 `sessions` 数组 → 每 5s 触发全 App + 所有终端重渲染 | 延迟数据拆到独立的 `latencyById: Record<string, number>`，并加相等短路 |

实测效果（`.perf-data` 拷真实库跑 `--smoke`）：全树 **3087 节点**（侧栏 180）、命令中心 `Ctrl+K` 打开 **113ms**、展开 XCMD 后只渲染 **72 行**（12 + 分页 60）而非 2917 行。

> 回答「是不是我连接太多」：是，但 2929 条本身不是问题，问题在渲染策略。数据层 1 MB 读一次毫无压力。

**折叠状态与默认折叠的坑**：超长组是「默认折叠」但 `collapsed[group]` 仍是 `undefined`，`toggleGroup` 若只按 `!collapsed[group]` 取反，第一次点击会把它设成折叠 —— 看起来像点了没反应。因此 `toggleGroup(group, currentlyCollapsed?)` 要传界面当前视觉状态。

### 5.4 视觉精緻度硬约束

- **全局禁 `backdrop-filter`**：Windows 上浮层关闭后合成器会残留缩放帧，导致整窗文字发虚（`sharpProbe.blurLayers` 为空可自证）。浮层遮罩改用纯色 `bg-black/55` / `bg-app/88`，`.menu`、Toast、传输浮窗、终端提示条全部去掉 `backdrop-blur`；
- **过渡统一 `≤ 150ms`，禁 `transition-all`**：一律写成具体属性（`transition-[width]`、`transition-[left]`、`transition-colors`），避免隐式动画无关属性；
- **动画只改 `opacity` / `transform` / `backgroundColor`**，不改 `box-shadow`（`pulse-soft` 改 opacity、`flash-ok` 改 backgroundColor，均合规）。

### 5.5 外观外壳与面板骨架（UI 重构落地）

**外壳五段**（`src/renderer/src/components/layout/`）：`TitleBar` 44px 绿底 `#27c93f`（品牌字色 `on-brand`）、`ActivityBar` 48px（激活项用绝对定位 `inset-y-1.5 left-0 w-0.5 bg-brand` 指示线，不用边框，避免影响布局宽度）、`SideNav` 280px（由 `activityView` 决定内容，`sidebarVisible` 为假直接返回 null）、`MainWorkspace`（`bg-app` 纯色，所有会话保持挂载仅切 `display`）、`StatusBar` 28px（含 Git 分支，用 `exec.run(sessionId, 'git rev-parse --abbrev-ref HEAD 2>/dev/null')` 取，`HEAD` 游离态不显示）。

**品牌绿使用边界**：仅 `--c-brand` 三处 —— TitleBar 背景、ActivityBar 激活指示线、命令中心左范围索引的选中指示线。其余「选中」一律用 `--c-select`（`#e0f2fe`），「强调」用 `--c-accent`（`#2563eb`）。绿色一旦扩散到按钮底色就会失去「品牌」含义。

**面板骨架类**（`styles/index.css` `@layer components`，六个侧栏面板共用，切换时不跳动）：

| 类 | 定义 | 用途 |
|---|---|---|
| `.panel-head` | `flex h-8 shrink-0 items-center gap-1.5 border-b border-edge px-2.5` | 定死 32px 头，`border-edge` 而非 `border-edge-soft` |
| `.panel-title` | `truncate text-xs font-semibold tracking-[-0.01em] text-ink` | 面板标题 |
| `.panel-count` | `shrink-0 rounded bg-raised px-1 font-mono text-3xs leading-4 text-ink-3` | 条数角标 |
| `.panel-toolbar` | `flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1.5` | 搜索/过滤行 |
| `.panel-body` | `scroll-thin min-h-0 flex-1 overflow-y-auto p-1` | 内容区 |
| `.row` / `.row-hover` / `.row-active` | `transition-colors duration-150` / `hover:bg-hover` / `bg-select` | 行 |

**信息密度取舍**：`CommandPanel` 头部原来塞 6 个图标按钮，280px 里挤成一排 → 只留「搜索 / 新建 / 更多⋯」，导入导出新建分组收进 `moreMenu`。筛选 chip 改分段控件（外壳 `bg-raised p-0.5`，选中块 `bg-app + shadow-[0_1px_2px_rgb(0_0_0/0.06)]`），不再用 `bg-accent/15 text-accent`（蓝底 chip 和浅色外壳打架）。

**字号阶梯（硬约束）**：`tailwind.config.js` 只留五档 —— `text-3xs` 10/14、`text-2xs` 11/16、`text-xs` 12/16、`text-sm` 13/20、`text-base` 15/22。重构前散着 9 / 10 / 10.5 / 11 / 11.5 / 12.5 / 13 / 15 八种像素值，同一屏里相邻文字只差 0.5px，单看每处都合理、并排就显脏。全部 `text-[Npx]` 已清零（`grep -rn 'text-\[[0-9.]*px\]' src/renderer/src` 应为空），新增代码不许再写任意值。

**键盘焦点**：全局加 `:focus-visible { outline: 2px solid rgb(var(--c-accent)/0.55); outline-offset: -1px }`，`input/textarea/select` 除外（它们已有自己的 focus ring，叠起来是双层框）。用 `outline` 不用 `box-shadow`：不占布局、不触发重绘、也符合「禁改 box-shadow」的约束。纯键盘操作时侧栏 6 个面板全是自定义按钮，没有焦点环等于摸黑。

**面板常驻（keep-alive）**：`SideNav` 对 6 个视图做「首次访问才挂载、之后常驻、靠 `display` 切换」。卸载式切换会丢内部状态 —— 连接列表滚到「37 號」切去文件再切回来又回顶部，命令面板折叠的分组/搜索词、文件树展开的目录同样全没，用户抱怨的「不方便」有一半来自「回来了却不是刚才那样」。首批不挂载是性能考虑：连接 2929 条 + 命令 126 条 + 6 个面板全挂会白多上千 DOM 节点。`display:none` 而不是 `visible/invisible`，隐藏面板不参与布局、不触发滚动重算。冒烟用 `keepAliveProbe` 卡住这条：`panes` 集合只增不减、`visible` 恒为当前视图。

**状态栏分隔符**：原来用 `<span className="text-edge">|</span>` 拿文字竖线假装分割线，字符中线偏上、宽度随字号变，相邻项一多就出现高低不齐的锯齿。改成 `Sep()` 组件 = `h-[9px] w-px bg-edge`，垂直居中交给 flex。数字列统一 `tabular-nums`（延迟、进度百分比、会话数、cols×rows），否则数字变化时宽度抖。

### 5.6 右侧常驻命令栏 + 固定三列（m03213 需求）

**为什么从侧栏视图改成右侧常驻栏**：原实现把「常用命令」当成活动栏的第 6 个视图，切过去就把左侧的连接列表挤走。执行命令时最常做的动作恰恰是「瞄一眼现在是哪台主机，再点命令」，为此要来回切两次视图。常驻之后两者同屏，命令栏的折叠状态与宽度都是独立记忆（`useLayoutStore.commandRailVisible` + `settings.layout.commandRail`）。

**结构**：`src/renderer/src/components/layout/CommandRail.tsx` = `<section aria-label="常用命令栏" style={{ width }} className="flex min-w-0 shrink-0 flex-col overflow-hidden border-l border-edge bg-panel">` 内包 `<CommandPanel onEdit={onEdit} onCollapse={toggleCommandRail} />`；栏体的开合由活动栏底部独立按钮（`aria-label="常用命令栏"`，`data-activity="command-rail"`）与快捷键 `Ctrl+Alt+B` 控制。

**三列固定（硬约束）**：`CommandPanel` 的 `WALL_COLS = 3`，网格写成 `style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}`，**不是** `auto-fill / minmax`。

- 理由：找命令靠的是**稳定的空间记忆**（「磁盘那个在第三行右边」）。列数随宽度变，这套记忆和口头交接（「第三行右边那个」）就同时失效；宁可卡片自己变宽变窄，也不让列数变。这条也解释了命令栏 340 的下限；
- 连带约束：键盘 `↑/↓` 的步长必须是 `±WALL_COLS`，`←/→` 是 `±1`。原来只有 `↑↓` 且步长 1，视觉上明明横排三个按钮，按一下 `↓` 却只挪到右边那个 —— 手感是错的；
- 冒烟用 `wallColsProbe` 卡住：拖动命令栏宽度（380 → 560）与双击复位（→ 380）三个状态下 `cols` 必须**恒为 3**，同时 `main` 宽度随之变化；`railToggleProbe` 再验收起后 `railPresent:false / mainWidth 增加`、展开后恢复。

**收起后不能失联**：命令栏头部自己有一个「收起」按钮，但它收起之后自己也跟着没了。所以活动栏底部必须留一个常驻开关（`Play` 图标 + 激活指示线），否则用户收起一次就再也打不开 —— 这是常驻型面板的通用陷阱。

**卡片视觉**：常态 `border-edge bg-app hover:bg-hover`，选中 `border-accent/50 bg-select`。不用 `bg-raised`（#fafafa）压 `bg-panel`（#f8f9fa）—— 两层只差 1.5%，126 个按钮会糊成一片没有边界；白底 + 实边框才读得出「这是一堆可以按的东西」。右上角单槽互斥：平时显示角标（收藏 / 需确认 / 有变量），悬停交叉淡入操作（收藏 / 编辑），只改 `opacity`，不产生位移。

### 5.7 配色主题（v1.0.0）

- `src/renderer/src/theme/colorThemes.ts` 定义 `COLOR_THEMES`：VS Code 浅色（默认）、Workbench、Dracula、Nord、Solarized、One Dark、Gruvbox，每套都有 `dark` / `light` 两个 `ThemeVariant` = 界面 CSS 变量 `vars` + xterm `terminal` 主题，**界面与终端同源**，切换时不会出现终端与外壳配色脱节；
- 设置项分两层：`settings.theme` 决定明暗（dark / light / 跟随系统），`settings.colorTheme` 在其上换整套配色；
- 回归：`node scripts/verify-theme.cjs`。

### 5.8 SFTP 传输进度与暂停 / 续传 / 取消

- 主进程 `SftpManager` 传输前先 `stat` 填总量，进度按 `PROGRESS_THROTTLE_MS = 150` 节流上报，结束时补齐 100%；目录传输按文件数计数，失败保留已传字节与错误原因；
- **分块读写**：`CHUNK_SIZE = 256KB` × `CHUNK_INFLIGHT = 6`（一批约 1.5MB，吞吐接近 `fastGet`、中断粒度可接受）。暂停冻结进度，继续时从已传位置续传；取消或失败会清理未完成的半截文件；
- IPC：`sftp:transfer-pause / resume / cancel`；任务状态新增 `paused` —— **`paused` 不是终态**，清理计时必须把它算作活动任务（`LIVE = ['pending','running','paused']`）；
- 渲染层：`TransferProgressDock` 进度面板（速度、队列、暂停/继续/取消按钮），状态栏显示传输状态；
- 回归：`node scripts/verify-transfer-progress.cjs`（含暂停续传、取消、上传一致性）。

### 5.9 ZMODEM（rz / sz）

- `src/renderer/src/lib/zmodem.ts`：每会话一个 `Sentry` 插在「主进程原始字节 → 终端」之间，检测到起始序列后**需用户确认**才接管；必须喂 `SessionDataEvent.raw`（base64 原始字节），未被协议接管的字节用 `TextDecoder({stream:true})` 解回文本，避免中文乱码；
- **sz 下载修复**：改为先选保存目录（`zm:pick-dir`，多文件复用同一目录令牌），再按 `zm:save-begin / append / finish` 分块流式写入，替代原先整文件攒在内存里一次性写盘；
- 接收方向三个曾导致终端卡死的点：Receive 会话必须 `start()` 发首个 ZRINIT；选目录期间远端重发起始帧导致 "Stale ZMODEM session" 时要记住用户选择、下次检测直接接管；协议解析抛错后必须 abort 并复位 Sentry；
- 回归：`verify-zmodem.cjs` / `verify-zmodem-decode.cjs` / `verify-zmodem-renderer.cjs` / `verify-zmodem-e2e.cjs`。

### 5.10 SFTP 目录批量读取（v1.5.1）

老链路「展开一层目录 = 一串串行往返」，且渲染层每次状态变化都把已展开的整棵树重读一遍（`bumpTree()` 自增 `version`，effect 依赖它）。展开 10 个目录、其中 3 层嵌套，光重复 `readdir` 就有几十次，每次几十到几百毫秒 RTT。

现在四层拆开：

| 层 | 实现 | 作用 |
|---|---|---|
| IPC | `SFTP_LIST_MANY`（`src/shared/ipc.ts` → `src/main/ssh/sftpManager.ts`），主进程内 `LIST_MANY_CONCURRENCY = 8` | 一次 IPC 批量 `readdir` 任意多个目录 |
| IPC | `SFTP_BOOTSTRAP` | 首次打开文件面板一次往返拿回 `home + 目录内容`，省掉 `realpath → readdir` 串行 |
| 渲染层 | `src/renderer/src/lib/dirLoader.ts` | 同一帧内到达的请求合并成 1 条批量 IPC（`setTimeout(0)` flush，**不用 rAF** —— 窗口不可见时 rAF 会被节流挂起）；按 `sessionId` 分段，切会话旧批次整批丢弃 |
| 渲染层 | `src/renderer/src/lib/dirCache.ts` | 目录结果 TTL 缓存（stale-while-revalidate：新鲜直接命中，过期先返回旧数据再后台重拉）。模块级单例而非 store —— 缓存是「网络结果副本」不是 UI 状态，进 zustand 会让每次写缓存触发订阅者重渲染 |

`FileExplorer` 加载 effect 重写为「只加载缺失目录」，依赖收敛后展开一次不再全树重走。实测：64 目录同帧请求 1 条 IPC / 15.0ms，256 目录 1 条 / 1.1ms（旧路径 64 / 256 条）；真实 Electron 30 次连续读取中位 17.1ms、p95 30.0ms，文件面板 61.5 FPS。

回归：`node scripts/verify-dirloader.cjs`、`node scripts/verify-dircache.cjs`、`node scripts/stress-cwd.cjs`、`npm run test:stress:e2e`。

### 5.11 文件面板跟随终端 cwd（v1.5.1）

SSH 协议本身不告诉客户端交互 shell 的 cwd。可取的三条正规途径各有代价：shell 上报（OSC 7）要远端配合；反查 `/proc/<pid>/cwd` 在 busybox / macOS 上根本没有；往 pty 注入 hook 会在终端留可见回显、改用户环境。而用户诉求非常具体 ——「**我 cd 的时候**侧栏跟过去」，那这一行本来就看得见（xterm `onData`）。于是两层叠加、谁先到算谁：

1. **输入追踪**（`src/renderer/src/lib/shellCwd.ts`，零依赖纯逻辑，不 import 任何 store / IPC，便于 esbuild 打成 CJS 单测）：回车时解析整行，识别 `cd` / `pushd`，支持 `~`、相对路径、`..`、带空格与引号路径、bracketed paste（`\x1b[200~ / \x1b[201~`）；`Ctrl-U` / `Ctrl-W` / 方向键等编辑操作后**保守丢弃整行**（宁可不动，不跳错）；单行缓冲上限 `MAX_LINE = 4096`，超限判为不可信。
2. **OSC 7**：远端 shell 上报真实 cwd 时直接采用，覆盖脚本内 `cd`、`pushd` / `popd` 等程序化切换。

状态隔离在 `src/renderer/src/stores/cwdStore.ts`，按 `sessionId` 分键；会话关闭 `forgetCwd(id)` 清 cwd / 输入追踪器 / home 缓存，重连复用同一 id 不会带上上一台机器的路径。开关两处：文件面板标题栏链状图标、设置 → 行为 →「跟随终端目录」；配置项 `filesFollowTerminalCwd`（`src/shared/types.ts`），**缺省按开启**（判断写 `!== false`，老配置无需迁移）。

性能：200,000 行（1/3 含 `cd`）解析 143.5ms ≈ **139 万行/秒**，每行 1.3µs，打字无感。

回归：`node scripts/verify-shellcwd.cjs`、`node scripts/verify-cwdstore.cjs`、`node scripts/verify-cwdfollow.cjs`（`npm run test:cwdfollow`）。

**v1.5.1 发布后修掉的一个「看起来没生效」**：解析和事件传递一直是对的（82 项 shellCwd 用例 + 19 项 cwdStore 用例都过），错在**面板没把结果展示出来**——`FileExplorer` 默认停在「工作区」Tab，那一栏是一列常用位置快捷入口（主目录 / 根目录 / 临时目录…），不是目录树。用户 `cd` 完点开文件面板，看到的是快捷入口，自然判定「没跟」。同源的第二个坑：面板首次挂载时把 `followedSeq` 一次对齐到当前序号，于是**挂载之前**发生的 `cd` 全被静默吞掉。

修法是把「什么时候跳、跳哪儿、要不要替用户切 Tab」从组件里抽成纯函数 `src/renderer/src/lib/cwdFollow.ts`：

- `decideInitial({ knownCwd, follow, tab })` —— 挂载 / 切会话时：有已知 cwd 且开着跟随，返回 `{ dir, tab: 'fs' }`，让目录树第一眼就是终端所在目录；没有已知 cwd 则保留用户原来选的 Tab（此前硬编码 `'workspace'`，会把正停在目录树里的用户踢回快捷入口）。
- `decideFollow({ seq, followedSeq, path, currentDir, connected, follow })` —— 每次 `cd`：只消费**新序号**，路径为空则**不推进游标**（否则这一事件被永久跳过）；关掉跟随或断线时游标照样前进（重新打开不该补跳历史目录）；序号回退不回退游标。
- 组件侧另加一段「用户手动把跟随重新打开 → 立刻补跳一次」，免去「关掉再打开还是不动」的困惑。

这套逻辑靠 DOM 测试很难覆盖（面板常驻挂载、靠 `display` 切换，`cd` 事件都在隐藏时到达），所以抽成零依赖纯函数，由 esbuild 打成 CJS 直接在 node 里跑，19 项用例覆盖上面每一条分支。

### 5.12 应用内自动更新（v1.5.0）

主进程单点维护状态机（`src/main/updater.ts`，基于 `electron-updater`），渲染层只展示、不重复推导版本高低：

```
idle → checking → available → downloading → downloaded → (restart & install)
              ↘ error（面板内可读原因，不弹窗打断当前 SSH 会话）
```

几个刻意的取舍：`autoDownload` 默认 **false**（现场网络按流量计费，一次检查偷偷拉 78MB 不可接受，查到只亮「更新」按钮）；`autoInstallOnAppQuit` 保持 **true**（用户点了重启又临时取消，下次正常退出顺手装上）；所有异常吞进 `phase='error'`，更新失败绝不影响正在用的会话。

差量更新靠 `electron-builder.yml` 的 `publish` 段（provider: github / owner / repo）在打包时生成 `resources/app-update.yml`，配合 `.blockmap` 只传差异部分。更新专用代理走 updater 自己的 `electron-updater` net session 分区（`NET_SESSION_NAME = 'electron-updater'`），与 SSH 连接代理完全隔离。

IPC：`update:state / check / download / install / open-release` + `evt:update-status`。渲染层视图两处：标题栏 `UpdateBadge`（chip + 下拉面板，启动约 8 秒静默检查一次）、设置 →「软件更新」（`UpdateSection`）。

> 自动更新只对 NSIS 安装版生效；portable 与 zip 没有安装上下文、无法自我替换，更新入口不显示。

## 6. 安全设计

| 项 | 实现 |
|---|---|
| 凭据存储 | safeStorage 加密后写入 `secrets.json`；系统加密不可用时仅内存持有 |
| 主机指纹 | 首次连接记录 SHA256 指纹；严格模式下指纹变化直接拒绝并给出处置指引；设置中可管理/删除记录（重刷固件场景） |
| 危险命令 | 命令级标记 + 全局关键词双保险，发送前强制二次确认 |
| 复制连接 | 刻意不复制凭据 |
| IPC 边界 | 通道白名单 + 统一错误包装，渲染层无任意 IPC 能力 |
| 更新包完整性 | 走 `electron-updater` 内建的 sha512 校验（`latest.yml` 里的 hash）+ `allowDowngrade = false` 防降级；更新元数据来自 `resources/app-update.yml` 固定的 owner/repo，不接受运行时传入的任意 URL |
| 更新链路只读观察 | 目录跟随只解析 xterm 收到的字节流，**不向 PTY 注入 hook**、不改远端环境（否则会在终端留可见回显、污染用户 shell） |

## 7. 分期路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 项目骨架 / SSH 连接管理（含 ProxyJump、剪贴板识别、测试连接）/ 多标签终端 / **常用命令全功能** / 命令历史 / 设置 / 主机指纹管理 | ✅ 完成 |
| **P1-a** | SFTP 文件管理：会话左侧文件树（懒加载、右键全操作、上传/下载/远程编辑 .bak 备份）+ 双栏传输模式 + 传输队列 | ✅ 完成 |
| **P1-b** | 会话日志录制（asciinema cast 格式）+ 回放器（变速/导出） | ✅ 完成 |
| **P1-c** | **端口转发/隧道管理**：-L 本地转发 / -R 远程转发 / -D 动态 SOCKS5；配置持久化、一键启停、会话断开自动停止；SOCKS5 协议 15 用例实测通过 | ✅ 完成 |
| **P1-d** | 网络诊断工具（ping/traceroute/nc/curl/tcpdump） | ⏭️ 用户明确不需要（直接用终端命令） |
| **P2-a** | **一键诊断巡检**：31 项内置模板（BusyBox 兼容、命令带降级兜底）+ 自定义诊断项 + 逐节实时进度 + 报告自动落盘 + Markdown/HTML 导出（HTML 单文件自包含、全量转义） | ✅ 完成 |
| **P2-b** | **多设备批量执行**：勾选多会话广播命令、并行执行、卡片/对比双视图、超时与取消、输出分别收集 | ✅ 完成 |
| **P2-c** | **客户/设备档案**（关联连接/命令分组/诊断报告） + **资源仪表盘**（实时 CPU/内存/磁盘/温度/网络曲线，多会话） | ✅ 完成 |
| **P3-a** | **固件升级助手**（选择→上传→SHA256 双端校验→流式升级→重启等待上线→启动日志）、**设备发现**（网段 TCP 扫描 + ARP 厂商 + 反向 DNS + mDNS 服务发现）、**配置备份对比**（备份/行级 diff/还原，自动 .bak） | ✅ 完成 |
| **P3-b** | **报告 zip 打包**（报告+日志+历史+配置备份一键打包，零依赖自实现 zip，Python 跨校验）、**连接代理接线**（SOCKS5 / HTTP CONNECT，密码走凭据保险箱） | ✅ 完成 |
| **P3-c** | **快捷键自定义**（已完成）、命令面板位置（已被 P4-d 的右侧常驻命令栏取代）；插件系统顺延至待办 | 🟡 部分完成 |
| **P3-d** | **命令检索重构**（模糊匹配 + 中英同义 + 使用热度 + 范围索引）、**Ctrl+K 命令中心**、**栏宽可拖拽**（四栏 + 双击复位 + 设置面板数值化）、视觉精緻度收尾 | ✅ 完成 |
| **P3-e** | **命令管理器按钮墙**（无搜索词时按分组堆叠按钮，扫读替代搜索）、**大列表性能专项**（2929 条连接不再卡顿）、**视觉硬约束**（禁 backdrop-filter / 过渡 ≤150ms） | ✅ 完成 |
| **P4-a**（v1.0.0） | **配色主题**：7 套配色 × 明暗，界面与终端联动（§5.7） | ✅ 完成 |
| **P4-b** | **SFTP 传输进度**（实时进度/速度/队列面板）+ **暂停/继续/取消**（分块读写断点续传，§5.8） | ✅ 完成 |
| **P4-c** | **sz 下载修复**（选择保存目录 + 分块流式写入，§5.9）+ **Windows 免安装版**（portable 单 exe） | ✅ 完成 |
| **P4-d** | **界面重构**：标题栏 + 活动栏 + 可拖拽侧栏 / 右侧常驻命令栏（§5.5、§5.6）、Ctrl+K 命令中心、任务栏图标修复（多尺寸 ico） | ✅ 完成 |
| **P4-e**（v1.5.0） | **应用内自动更新**：主进程状态机 + 标题栏 `UpdateBadge` + 设置「软件更新」分区，差量下载（§5.12） | ✅ 完成 |
| **P4-f**（v1.5.1） | **文件面板响应性**：目录批量读取（`SFTP_LIST_MANY` / `SFTP_BOOTSTRAP` + 同帧合并 + TTL 缓存，§5.10）、**面板跟随终端 cwd**（输入追踪 + OSC 7，§5.11） | ✅ 完成 |
| **待办** | 插件系统（JS 脚本扩展命令/诊断/报告模板） | ⏳ 未开始 |
| **已有独立安装包，暂无自动更新** | macOS（dmg）/ Linux（AppImage）不出更新元数据，`electron-updater` 当前只接了 Windows NSIS | ⏳ 未开始 |
| **已确认不做** | 安全与审计（除已实现的主机指纹/凭据加密/危险命令确认外不再扩展)、工单集成、VNC/RDP 入口、网络诊断工具、命令栏浮动形态、Gitee 更新源（理由见 §9） | ⏭️ 用户明确不需要 |

> P3-a 附注：新增通用能力 `window.api.exec.run(sessionId, cmd, timeout)`（任意面板可执行一次性命令）；连接编辑器状态上收到 `uiStore`，支持任意面板带预设呼出（设备发现 →「新建连接」即用此能力）。

### 7.0 版本更新记录

#### v1.5.2（2026-10-27）

| 分类 | 内容 |
|---|---|
| **缺陷修复（cwd 跟随）** | **「开了跟随，`cd` 之后文件没跟过来」**：解析与事件链路本是对的（`verify-shellcwd` 82 项 + `verify-cwdstore` 19 项全过），病根在展示层 —— `FileExplorer` 默认停在「工作区」Tab，那是一列常用位置快捷入口，不是目录树；叠加面板首次挂载把 `followedSeq` 一次性对齐到当前序号，**挂载之前**发生的 `cd` 被静默吞掉（面板常驻挂载、靠 `display` 切换，事件都在隐藏时到达） |
| **重构** | 把「什么时候跳 / 跳哪儿 / 要不要替用户切 Tab」从 `FileExplorer` 抽成零依赖纯函数 `src/renderer/src/lib/cwdFollow.ts`：`decideInitial` 在「有已知 cwd + 开着跟随」时连 Tab 一起定到 `fs`（此前只改 `currentDir` 不改 Tab），没有已知 cwd 则保留用户原选 Tab（此前硬编码 `'workspace'`，会把正停在目录树里的用户踢回快捷入口）；`decideFollow` 显式区分「新事件 / 旧事件 / 空路径 / 关开关 / 断线 / 序号回退」六种分支，空路径不推进游标以免事件被永久跳过。另加「手动重开跟随 → 立刻补跳一次」 |
| **回归** | 新增 `scripts/verify-cwdfollow.cjs`（19 项，esbuild 打 CJS 直跑），并入 `npm run test:cwdfollow`。这套逻辑用 DOM 测试打不到 —— 面板常驻挂载、`cd` 事件都在隐藏时到达 |
| **构建** | 产物目录切到 `dist-v13`；`scripts/release.ps1` / `build-release.sh` / `build-release.bat` 同步；本次一并发出 v1.5.1 之后未进包的完整性标签硬锁修复（`WRITE_OWNER` + 两级扫描，25.9s → 5.8s） |

#### v1.5.1（2026-10-27）

| 分类 | 内容 |
|---|---|
| **性能（文件面板）** | **侧栏打开远端目录不再串行等待**：新增 IPC `SFTP_LIST_MANY`（`src/shared/ipc.ts` → `src/main/ssh/sftpManager.ts`，主进程内 `LIST_MANY_CONCURRENCY = 8` 并发 `readdir`）与 `SFTP_BOOTSTRAP`（一次往返拿回 `home + 目录内容`，省掉 `realpath → readdir`）。渲染层新增 `src/renderer/src/lib/dirLoader.ts`（同帧请求合并成 1 条批量 IPC、按会话分段、切会话整批丢弃）与 `src/renderer/src/lib/dirCache.ts`（TTL 缓存）。`FileExplorer` 加载 effect 重写为「只加载缺失目录」，不再因 `version` 自增把整棵已展开树重读。实测 256 个目录同帧请求：256 条 IPC → **1 条**，1.1ms；真实 Electron 30 次连续目录读取中位 17.1ms、p95 30.0ms |
| **新增功能（cwd 跟随）** | **终端 `cd` 之后侧栏文件面板自动跟过去**：新增 `src/renderer/src/lib/shellCwd.ts`（纯逻辑零依赖，`scripts/verify-shellcwd.cjs` 单测）解析回车前整行，识别 `cd` / `pushd`，支持 `~`、相对路径、`..`、带空格引号、bracketed paste；`Ctrl-U` / `Ctrl-W` / 方向键等编辑后保守丢弃整行。OSC 7 序列作为权威来源覆盖脚本内 `cd` / `pushd` / `popd`。新增 `src/renderer/src/stores/cwdStore.ts` 按 `sessionId` 隔离，会话关闭 `forgetCwd(id)` 清 cwd / 追踪器 / home 缓存。文件面板标题栏链状开关 + 设置 → 行为 →「跟随终端目录」双入口；配置项 `filesFollowTerminalCwd`（`src/shared/types.ts`），缺省按开启（`!== false`） |
| **缺陷修复** | `currentDir` 会带上一会话路径进新会话；`scripts/release.ps1` 硬写代理 `127.0.0.1:7897` 导致换网络即发布失败，改为启动探测端口、不可达自动直连 |
| **发布链路** | `scripts/release.ps1` 上传前硬性校验产物完整性标签（Low IL 的 Setup.exe 装完打不开），并在 `npm run build:win` 前置 `check-integrity.ps1` |

#### v1.5.0（2026-10-26）

| 分类 | 内容 |
|---|---|
| **新增功能（自动更新）** | **应用内自动更新**：标题栏 `UpdateBadge`（`src/renderer/src/components/layout/UpdateBadge.tsx`）启动约 8 秒静默检查一次，`available` 时亮出「更新」chip，点开是版本对比 + 更新说明 + 「立即更新」，全程不跳浏览器。状态机由主进程单点维护（`src/main/updater.ts`，基于 `electron-updater`），渲染层只展示：`checking` → `available` → `downloading`（百分比 + 进度条 + 速率/剩余）→ `downloaded`（重启并安装）→ `error`（面板内可读原因，不弹窗打断会话）。设置面板新增「软件更新」分区（`src/renderer/src/components/settings/UpdateSection.tsx`）：立即检查 / 启动自动检查 / 自动下载 / 更新专用代理 / 打开发布页，改完立即生效 |
| **差量更新** | `electron-builder.yml` 补 `publish` 段（provider: github / owner / repo），打包时自动生成 `resources/app-update.yml`；配合 `.blockmap` 走差量下载。更新代理走 updater 自己的 `electron-updater` net session 分区，与 SSH 连接代理隔离 |
| **默认值取舍** | 自动检查**开**、自动下载**关**（现场网络按流量计费，查到只亮按钮）；`autoInstallOnAppQuit` 保持**开**（用户点了重启又临时取消，下次正常退出顺手装上） |
| **限制** | 仅对 NSIS 安装版生效；portable 与 zip 版没有安装上下文、无法自我替换，更新入口不显示 |

#### v1.4.4（2026-10-26）

| 分类 | 内容 |
|---|---|
| **严重缺陷修复** | **分组字段选不了其他分组**：原生 `<datalist>` 会拿输入框当前值做子串过滤（预填「默认」时只剩 1 条候选），且浏览器无关闭开关。新增 `Combobox`（`src/renderer/src/components/ui/index.tsx`）替换三处分组字段：`CommandEditor`、`ConnectionEditor`、`DiagSectionEditor`。全量候选 + 打字过滤 + ↑↓/Enter/Esc + fixed 浮层按实测坐标定位、下方空间不足自动上翻 |
| **UI 修复** | **命令名/命令文本撑出卡片**：`<button>` 的 UA `align-items: flex-start` 使 column flex 交叉轴子项宽度由内容决定，`truncate` 不参与收缩。`CommandPanel` / `CommandCenter` 名称行与命令行补 `w-full min-w-0`；实测 129 张卡命令行溢出 82→0、名称行 92→0 |
| **全量复查** | 用 CDP 逐屏打开 12 个视图/面板扫描「元素右边界超出非裁切父容器」，结果 0 处 |

#### v1.4.2（2026-10-26）

| 分类 | 内容 |
|---|---|
| **新增功能** | **侧栏文件面板右键菜单**：行上右键作用于该文件/目录，空白处右键作用于当前目录。菜单项含编辑、下载文件/下载目录（主进程 `sftpManager.transferDownloadDir` 递归展开）、下载到本机「下载」文件夹（新增 IPC `sftp:downloads-dir`）、上传文件到此处、新建文件夹、重命名、删除（目录前弹递归删除确认） |

#### v1.4.0 / v1.4.1（2026-10-25）

| 分类 | 内容 |
|---|---|
| **UI 调整** | 去掉连接选中操作栏，批量操作统一走右键菜单；批量编辑标签接回右键菜单；修正 `electron-builder.yml` 中 `compression` 非法值 |

#### v1.3.0（2026-10-25）

| 分类 | 内容 |
|---|---|
| **连接管理增强** | **连接分组管理**：新建/重命名/删除分组、拖拽排序分组与连接；导出时包含完整分组结构 |
| **稳定性** | **断线自动重连**：连接异常断开时自动尝试重连（带可见的错误日志与重连状态提示） |
| **命令中心增强** | **范围筛选**：命令面板与命令中心新增「全部/最近使用/最常用/收藏」范围快速切换，支持按分组筛选 |
| **性能优化** | **大规模连接列表优化**：已验证 2900+ 条连接场景；分页渲染（60条/页）+ 超长分组默认折叠 + 会话索引 Map 加速 + 全局轮转延迟探测（替代每会话独立定时器） |
| **SFTP 优化** | **目录打开性能提升**：远端文件系统目录打开响应速度显著加快，不再有明显等待 |

#### v1.2.0（2026-10-24）

| 分类 | 内容 |
|---|---|
| **UI 修复** | 修复上传目标目录问题（不再落到远端根目录）；新增目标目录选择框 |
| | 修复多会话时标题栏标签条滚动条无法使用 |
| **构建** | 新增 zip 免安装版构建目标（portable.exe + zip 双产物） |

#### v1.1.0（2026-10-23）

| 分类 | 内容 |
|---|---|
| **文档** | 同步 v1.0.0 以来的主题、传输控制、ZMODEM 下载、免安装版与界面重构更新 |

### 7.1 缺陷修复记录（重要）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 连接瞬间文件树报「无法获取远端目录：会话可能未连接或已断开」 | 竞态：会话记录在创建瞬间（握手未完成）即进入会话表，其中 client 是未连接的占位对象；文件树此时挂载 SFTP 会在该对象上直接失败，且失败后无重试 | 主进程：新增 `sessionManager.waitUntilReady()`（连接中挂起、就绪放行、失败/断开/超时拒绝），`sftpManager.getSftp()` 先等待就绪再挂载（并发挂载去重）；渲染层：文件树仅在会话 connected 后请求，失败提供「重试」按钮 |
| 冒烟截图上整窗文字发虚、PNG 体积骤降 40% | 浮层的 `backdrop-blur` 关闭后，Windows 合成器残留缩放帧；`capturePage()` 抓到的是模糊帧。探针确认 `blurLayers: []`（DOM 里已无模糊层），说明残留发生在合成器而非样式 | 去掉 `.modal-overlay` 与命令中心的 `backdrop-blur-[2px]`，改用更深的纯色遮罩（`bg-black/55`）；截图前加 `webContents.invalidate()` + 双拍兜底 |
| 命令中心首次打开时列表顶部少一行 | `scrollIntoView` 在 pop-in 动画（约 120ms）期间按被压缩的高度计算滚动位置 | `firstPaint` ref 标记首帧，跳过第一次自动滚动 |
| 分隔条快速拖拽丢事件 | `moveDrag` 读闭包里的 `dragging` state，pointerdown 与 pointermove 落在同一 tick 时 state 尚未重渲染，读到 false 就丢弃移动 | 改用 `dragRef`（ref 同步赋值）；`setPointerCapture` 全包 try/catch（合成 PointerEvent 无真实指针时会抛） |
| 拖一侧栏宽，其它栏尺寸被冲掉 | `mergeSettings` 对 `layout` 只做浅合并，`persist({ [pane]: next })` 把整份对象替换成单键 | `persist` 始终写整份 `{...sizesRef.current, [pane]: next}` |
| 方向键微调方向反了 | `nudgePane` 用 `current - direction * step * sign`，与「分隔条往哪边挪」的语义相反 | 改为 `current + direction * step * sign`，并给 `sign` 补注释说明增长方向 |
| 2929 条连接时整窗卡顿 | 侧栏全量渲染 2917 条 + 每行 O(n) `sessions.find` + 每会话独立 5s 探活定时器 + 延迟更新重建整个 sessions 数组 | 分页 60 / 超长组默认折叠、`sessionByConn` Map、全局轮转探针、`latencyById` 拆出（详见 §5.3） |
| 展开超长分组「点了没反应」 | 超长组默认折叠但 `collapsed[group]` 为 `undefined`，`!undefined = true` 使第一次点击反把它设为折叠 | `toggleGroup(group, currentlyCollapsed)` 传入界面当前视觉状态 |
| 命令中心按钮墙上 ↓ 键跳到相邻列 | 网格是 3 列，但键盘步长仍按 1（单列时代的写法） | 步长改为 `WALL_COLS`，并新增 `←/→` 单格移动 |
| 侧栏分隔条拖完立刻弹回原宽度（`beforeDrag:280 → afterDrag:280`） | `pointerup` 与最后一次 `pointermove` 常落在同一任务里，React 未重渲染，`endDrag` 读 `valueRef.current` 拿到的仍是拖拽前旧值并原样提交 | 新增独立 `liveRef`，`beginDrag` 初始化、`moveDrag` 内同步写、`endDrag` 用 `liveRef.current` 提交 |
| 侧栏 2929 行里每行都印「N 天前」 | 相对时间对绝大多数老连接是同一个灰字，不再是信息而是均匀噪点 | 只在 7 天内用过的连接显示；色标也改为「设过颜色才画」（原来画灰竖线保持对齐，几千行短线排成一道虚线） |
| 长设备名的「打开」按钮把名字截短 24px | 按钮作为 flex 子项，`opacity-0` 仍占位 | 改 `absolute right-1` 悬浮，`group-hover` / `group-focus-visible` 才显形 |
| 打包后任务栏图标是一块白方块（Win11 浅色任务栏上几乎看不见） | 三重原因叠加：①仓库里没有 `build/icon.png`，electron-builder 打日志 `default Electron icon is used`；②`BrowserWindow` 未设 `icon` —— Windows 上「窗口图标」与「exe 资源图标」是两套东西，无边框窗口不设时退回 Electron 默认图标（近乎全白）；③`files` 白名单只有 `out/**` + `package.json`，即使补了 `resources/icon.png` 也进不了包 | ①新增 `scripts/make-icon.cjs`（纯 Node 手写 PNG 编码器，无依赖）生成 `build/icon.png` 1024px + `resources/icon.png` 256px，绿色圆角块 + 白色 `>_`；②`createWindow()` 加 `icon: pickIconPath()`，逐个探测 `process.resourcesPath/icon.png` → 仓库 `resources/icon.png` → `app.getAppPath()/resources/icon.png`；③`files` 加 `resources/**`、`asarUnpack` 保留、新增 `extraResources` 把图标拷到 asar 之外（原生层加载图标最稳）；④冒烟加 `iconProbe` 断言路径能解析且字节数 > 0 —— **图标加载失败在 Electron 里是静默的**，不报错只回退白图标，必须有断言兜住 |
| 上一行修完，任务栏**仍然**发白 | 只给了单张 png，electron-builder 转出的 ico 里只有一条 `256×256/32` 记录（解析 PE `.rsrc` 的 RT_GROUP_ICON 确认）；任务栏要 24/32px 时让 GDI 缩 256 的图，白边把绿色糊掉。Alt+Tab 大预览反而正常，所以「看预览是绿的」不能作为已修好的证据 | `make-icon.cjs` 改为自己封装多尺寸 ico：7 档 `ICO_SIZES = [256,128,64,48,32,24,16]`，每档独立渲染 + 按尺寸调整线宽与字形缩放；小尺寸写 BMP 条目、128/256 写 PNG 条目；`electron-builder.yml` 指定 `win.icon: build/icon.ico`；`iconProbe` 增加 `icoSizes` / `smallSizesOk`（必须同时含 16/24/32） |
| 用截图统计法判断「任务栏图标是白的」，结论在两次运行间自相矛盾（同一图标测出 `white=14.6%` 与 `white=82.2%`） | 统计区域取的是**整个按钮矩形（66×72）**，浅色任务栏背景下背景本身接近白，`white%` 主要由背景和悬停态决定，图标只占其中 32×32 | 新增 `scripts/probe-tb-icon.ps1`，只裁按钮正中 32×32 图标区（`$ox = $X + ($W-32)/2`）。实测 SSH 按钮 `green=90.4% white=6.7%` —— 图标一直是对的。**做像素级判据前先确认裁剪区域只含被测对象**，否则测的是背景 |
| 标题绿栏里的会话标签「不满格」，上下各露一条绿边 | `TabBar` 根容器是块级 `div`，`height` 默认 `auto`（只有内容高 ≈28px），而 `header.titlebar` 是 44px —— 容器没满高，标签被拉伸到容器高度也没用，绿栏被切成三条横向色带 | 根容器加 `h-full` + `data-tab-strip`（供探针定位）；新增 `tabStripProbe` 断言 `stripH === barH === 44 && stripGapTop === 0`。**只量标签高度查不出这个问题**（标签已被拉满容器），必须量容器本身 |
| 压测脚本让整个冒烟只能靠超时收场 | 第一版写成页面内 `setInterval` 自循环，某次 `toggleCommandCenter()` 抛错后 `step++` 走不到，定时器永远跑下去 | 改为「页面只放采样器 + 主进程逐步 `await` 驱动 + 每步 try/catch」，任何一步失败只记 `errors++`，流程继续 |
| 压测报告出现 `avgFrameMs: 0`（看起来完美，实际没测） | 采样器靠 `requestAnimationFrame`，窗口被别的实例遮挡时 Chromium 把 rAF 降到 0Hz，一帧都收不到 | 采样前 `win.show()` + `win.focus()`；并加 `stressProbe.valid = frames >= 30` 硬判据 —— 不能只看 `avgFrameMs`，没采到帧时它是 0 |
| 打包版压测 `actions: 45 / errors: 45`（等于没跑） | 压测用 `window.__lazy_test.stores` 驱动，而 `ZM_TEST` 只在验证构建里注入，生产构建没有这个钩子 | 改用真实输入：`pressKey('K', ['control'])` 敲 Ctrl+K、`document.querySelector('[data-activity=...]').click()` 点活动栏，走的就是用户的路 |
| `currentDir` 带着上一个会话的路径进新会话（v1.5.1 跟随功能的副产品） | cwd 状态存的是单个模块级变量，切会话时不重置；跟随功能让它变得可见 | cwd 按 `sessionId` 分键存进 `src/renderer/src/stores/cwdStore.ts`，会话关闭 `forgetCwd(id)` |
| 「开了跟随，`cd` 之后文件没跟过来」（v1.5.1 发布后用户首个反馈） | 解析与事件传递全对（82 + 19 项用例都过）。真正原因是**展示层**：文件面板默认停在「工作区」Tab —— 那是一列快捷位置（主目录/根目录/临时目录…），不是目录树，用户看到快捷入口就判定「没跟」。叠加第二个坑：面板首次挂载把 `followedSeq` 一次性对齐到当前序号，**挂载之前**发生的 `cd` 被静默吞掉 | 抽出 `src/renderer/src/lib/cwdFollow.ts`：`decideInitial` 在「有已知 cwd + 开着跟随」时把 Tab 一并定到 `fs`（此前只改 `currentDir` 不改 Tab）；`decideFollow` 显式区分「新事件 / 旧事件 / 空路径 / 关开关 / 断线 / 序号回退」六种分支，空路径不推进游标以免事件被永久跳过；另加「手动重开跟随立刻补跳」。19 项用例见 `scripts/verify-cwdfollow.cjs`。**教训：状态对了不等于用户看得见，「面板当前停在哪个 Tab」也是跟随链路的一环** |
| `scripts/release.ps1` 换网络环境即整条发布链路失败 | 脚本硬写代理 `127.0.0.1:7897`，该端口不通时上传直接超时 | 启动时先探端口，不可达自动改直连 |
| 发出去的 `Setup.exe` 在用户机器上双击毫无反应 | 产物目录被打上 `Low` 完整性标签（Codex 沙箱服务给「信任工作目录」打 IL，`d:\ssh-workbench` 在信任列表里），Electron 沙箱子进程启动即被杀。**字节一致、拷到别的目录就能跑** | `scripts/check-integrity.ps1`：扫仓根 + 所有 `dist*` + 其中 `*.exe`/`*.dll`，命中 Low 退出码 1；`npm run check:integrity` / `fix:integrity`（改 SACL 需管理员）。`npm run build:win` 前置该检查，`scripts/release.ps1` 上传前再拦一道 —— 带 Low IL 的包装完打不开，宁可不出门 |

## 8. 运行与打包

```bash
cd ssh-workbench
npm install          # 本机无 VS Build Tools，使用 --omit=optional 跳过 ssh2 可选原生加速（不影响功能）
npm run dev          # 开发模式（热更新）
npm run typecheck    # 主进程 + 渲染层类型检查
npm run smoke        # 冒烟自检（注意：本机 ELECTRON_RUN_AS_NODE=1 会让它崩，见下表）
npm run build        # electron-vite build → out/（不是 npx vite build，后者找不到 index.html）
npm run build:win    # 先跑完整性检查，再打包 Windows 安装包 + 免安装版（output: dist-v13）
npm run build:win:portable  # 只打免安装版：ssh-workbench-<version>-portable.exe（不写注册表、不建开始菜单）
npm run check:integrity     # 只查完整性标签，命中 Low 退出码 1（v1.5.1）
npm run fix:integrity       # 查并修（改 SACL 需管理员令牌）
```

`electron-builder.yml` 的产物命名：`artifactName: ${name}-Setup-${version}.${ext}`（安装包，如 `ssh-workbench-Setup-1.5.1.exe`）、`${name}-${version}-portable.${ext}`（免安装）、zip 目标同名 —— **都不带 `v` 前缀**（v1.4.1 修过一次：带 `v` 会让 GitHub Release 里名字与 `latest.yml` 对不上）。

发布走 `scripts/release.ps1`（v1.5.1 起两条硬性前置）：启动时探测代理端口（不通自动直连，不再硬写 `127.0.0.1:7897`）；上传前调 `check-integrity.ps1`，产物带 Low 完整性标签直接中止 —— Low IL 的 Setup.exe 在用户机器上双击毫无反应，传上去等于发个装完打不开的版本。

本机实际使用的打包命令（产物目录可换，避免覆盖正在运行的版本）：

```bash
./node_modules/.bin/electron-builder --win nsis portable --config electron-builder.yml \
  -c.directories.output=dist-build
# 再 cp 三个产物 + latest.yml 到目标目录；不要 rm -rf 正在运行的 win-unpacked
```

冒烟命令（必须 `env -u ELECTRON_RUN_AS_NODE`，且 `--user-data-dir` 不可省 —— 主进程有 `requestSingleInstanceLock()`）：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . --smoke \
  --user-data-dir="D:/ssh-workbench/.smoke-t"
# 结果与截图都写在 user-data-dir 内：.smoke-t/smoke-result.json + smoke-shot-*.png
```

## 图标

`scripts/make-icon.cjs`（纯 Node，零依赖，自带 PNG 编码器 + ICO 封装器）生成：

| 产物 | 尺寸 | 用途 |
|---|---|---|
| `build/icon.ico` | 7 档：256/128(png) + 64/48/32/24/16(bmp) | electron-builder 的 `win.icon`，直接作为 exe 内嵌图标 |
| `build/icon.png` | 1024 | 备用 / 文档用 |
| `resources/icon.ico` | 同上 7 档 | 运行时窗口图标，被 `files` + `extraResources` 一起带进包 |
| `resources/icon.png` | 256 | 图标兜底（`pickIconPath()` 在 ico 全部缺失时用） |

**必须自己出多尺寸 ico，不能让 electron-builder 从单张 png 转**：它转出来的 ico 里只有一条 256×256 PNG 记录，Windows 任务栏要 24/32px 时只能让 GDI 现场缩 256 的图，白边把绿色糊掉 —— 表现为「图标本身是绿的，但任务栏上是一块白」。大预览（Alt+Tab）反而是对的，所以光看预览查不出来。

脚本里每个尺寸都独立 `render(n)`（不从 1024 缩），并且：

- `strokeFor(size)` 线宽随尺寸放大（≥64 → 0.088、≥48 → 0.095、≥32 → 0.108、≥24 → 0.13、16 → 0.16），否则 16px 上 0.088 只有 1.4px，描边会断成虚线；
- `glyphScaleFor(size)` 小图把字形往里收（16/24 → 0.9、24 → 0.96）；
- 16/24/32/48/64 用 **BMP 条目**（自底向上 BGRA + 1bpp AND 掩码），128/256 用 **PNG 条目**。老 shell 扩展读不了 PNG 条目，会直接退回默认图标。

改图标只需改脚本里的 `CHEVRON` / `UNDERSCORE` / `STROKE` / `gradColor`，然后 `npm run icon` 重跑。
**不要指望图标坏了会有报错** —— Electron 加载图标失败是静默的，只会在任务栏回退成默认白方块；靠冒烟的 `iconProbe` 兜住，其中 `smallSizesOk`（ico 里必须同时有 16/24/32）就是上面这个根因的回归断言，只断言「路径能解析 + 字节数 > 0」查不出白方块。


数据目录：`%APPDATA%/ssh-workbench/data/`（设置面板内可直接查看路径）。

### 8.1 运行环境注意事项（本机实测记录，重要）

| 问题 | 现象 | 处理方式 |
|---|---|---|
| **安全软件按路径拦截** | `electron.exe` 从**桌面路径**启动时被静默终止（终端无任何输出），换到其他目录可正常运行 | 把项目放在非桌面目录（如 `D:ssh-workbench`），或将 `node_moduleselectrondist` 加入安全软件排除项 |
| **目录完整性标签为 Low** | 目录被打上 `Low Mandatory Level` 后，Electron 沙箱子进程启动即崩：退出码恒为 `-2147483645` / `0xC0000005`，双击毫无反应，且**同一份 exe 拷到别的目录就能跑**（字节一致也不影响结论） | 一条命令：`npm run check:integrity`（只查）/ `npm run fix:integrity`（查+修，需管理员）。`scripts/check-integrity.ps1` 扫仓根 + 所有 `dist*` + 其中的 `*.exe`/`*.dll`，命中 Low 退出码 1。**复发源已定位**：本机 Codex 的 Windows 沙箱服务 `CodexSandboxService.OpenAI.Codex` 会给 `~/.codex/config.toml` 里 `trust_level = "trusted"` 的目录打 Low IL，`d:\ssh-workbench` 正在其中——打完包 / 发布前 / 双击没反应时先跑一次，不要先去怀疑 exe 或 asar |
| 本机无 VS C++ 编译环境 | `npm install` 在 cpu-features（ssh2 可选原生加速）处卡死 | `npm install --omit=optional`（无功能影响） |
| 直连 GitHub 不可达 | electron 二进制安装失败 | 项目 `.npmrc` 已固化 `electron_mirror=https://npmmirror.com/mirrors/electron/` |

> 诊断备忘：主进程内置启动阶段日志（`[main] boot/app ready/seed commands done/ipc registered/window created`）与全局异常捕获，配合 `ELECTRON_ENABLE_LOGGING=1` 可快速区分「native 层问题」与「JS 层问题」。

## 9. 已知限制与技术债

- 命令栏固定常驻右侧并固定三列（`WALL_COLS = 3`），不再提供「底部横条 / 浮动」形态 —— `commandPanelPosition` 字段仅为老配置兼容保留，渲染层已无消费者；
- 快捷键已可自定义（含 Ctrl+K 命令中心），默认组合：Ctrl+N 新建连接 / Ctrl+K 命令中心 / Ctrl+, 设置 / Ctrl+B 折叠侧栏 / Ctrl+Alt+B 折叠命令栏 / Ctrl+Tab 切换标签 / Ctrl+Shift+W 关标签 / Ctrl+Shift+C/V 复制粘贴 / Ctrl+F 终端搜索；
- 大量输出（如 `cat` 大文件）时合帧窗口可考虑自适应放大（当前固定 8ms）；
- 中英同义表 `SYNONYMS` 是手工维护的 22 组，新增命令分组时不会自动扩展 —— 需要新词时改表并跑 `scripts/verify-synonyms.cjs`；
- 连接分组拖拽排序已实现（v1.3.0），支持分组间拖放和组内排序，空分组会在下次加载时保留；
- 断线自动重连（v1.3.0）使用指数退避策略（1s / 2s / 4s / 8s / 16s 上限），最多尝试 5 次后需要用户手动重连；错误日志在终端内可见。
- **`<button>` 里的 column flex 一定要钉宽度**（v1.4.3/v1.4.4 连续踩两次）：浏览器给 `<button>` 的 UA 样式含 `align-items: flex-start`，交叉轴子项宽度由内容决定，`truncate` 的 `overflow: hidden` 拿不到受约束宽度、不参与收缩，长文本直接顶出边界。只加 `min-width: 0` 无效，必须 `w-full min-w-0` 一起上。新增任何「按钮内多行文本」结构都要复查这一条；
- **分组/枚举类输入不要用原生 `<datalist>`**（v1.4.4）：datalist 会拿输入框当前值做子串过滤，预填默认值时用户几乎看不到其他候选，且无关闭开关。统一用 `Combobox`（`src/renderer/src/components/ui/index.tsx`），浮层走 `fixed` + 实测坐标定位，避免被 modal 的 `overflow-hidden` 裁切。
- **自动更新只对 NSIS 安装版生效**（v1.5.0）：portable 与 zip 解压版没有安装上下文，`electron-updater` 无法自我替换，`isUpdateVisible()` 直接不显示更新入口，只能靠安装包覆盖升级；
- **Gitee 作为更新源不可用**（评估后搁置，用户 2026-10-26 定「先暂时不搞」）：`electron-updater` 的 `providerFactory.js` 无 gitee 分支（写 `publish.provider: gitee` 打包期直接抛 `Unsupported provider: gitee`）；Gitee Release 附件 CDN 对 `Range` 返回 **200 全量**而非 206，`isUrlProbablySupportMultiRangeRequests(url) = !url.includes('s3.amazonaws.com')` 会把 gitee URL 判成支持多 Range，导致差分下载必失败并回落全量重下（且无断点续传）；附件下载地址是带 `token` / `ts` 的时效签名，不能固化进 `latest.yml`。唯一干净通道是 Gitee raw 路径（实测 206 + `Accept-Ranges: bytes`），但 82MB exe 进 git 历史不可接受。当前发布链路仍是 `publish.provider: github` / owner `yanxici` / repo `ssh-workbench`；
- **文件面板跟随有边界**（v1.5.1）：只认单行 `cd` / `pushd` 与 OSC 7；`alias` 改写的 `cd`、环境里带函数的 `cd`、以及远端未配 OSC 7 时的脚本内 `cd` 都跟不到，此时面板停在上一个目录。`Ctrl-U` / `Ctrl-W` / 方向键等编辑后整行被保守丢弃，也是「宁可不动，不跳错」的取舍；
- **目录缓存的失效时机**（v1.5.1）：TTL 到期、显式 `refresh()`、会话关闭、以及上传/删除/改名/新建等写操作 —— 若是**远端其它人**改了目录内容，面板要等 TTL 到期才看到。

## 10. 开发自检

纯函数逻辑用 esbuild 打包成单文件后由 node 直接断言，不引入测试框架：

```bash
node scripts/verify-command-search.cjs   # 模糊匹配 / 字段加权 / 排序 / 范围索引（49 项）
node scripts/verify-synonyms.cjs         # 中英同义扩展 + 别名检索回归（28 项）
node scripts/verify-layout.cjs           # 双栏宽度夹取 / 拖拽换算 / 方向 / 升级兼容（77 项）
node scripts/verify-group-order.cjs      # 分组顺序与拖拽落点（18 项）
node scripts/verify-theme.cjs            # 配色主题（P4-a）
node scripts/verify-transfer-progress.cjs # SFTP 进度 / 暂停续传 / 取消（P4-b）
node scripts/verify-shellcwd.cjs         # cd / pushd / ~ / 引号 / bracketed paste / 编辑丢弃 + OSC 7（v1.5.1）
node scripts/verify-cwdstore.cjs         # cwd 按 sessionId 隔离、会话关闭清理（v1.5.1）
node scripts/verify-cwdfollow.cjs        # 跟随决策：初始 Tab / 序号消费 / 关开关与断线 / 重开补跳（v1.5.1 修复）
node scripts/verify-dirloader.cjs        # 同帧请求合并、按会话分段、切会话丢弃（v1.5.1）
node scripts/verify-dircache.cjs         # TTL 缓存 / stale-while-revalidate / 写操作失效（v1.5.1）
for f in scripts/verify-zmodem*.cjs; do node "$f"; done  # ZMODEM 协议 / 解码 / 渲染层 / 端到端（P4-c，4 个脚本）
```

耗时类基线（不是断言，用来对比回归）：

```bash
node scripts/stress-cwd.cjs      # 目录批量请求 IPC 次数 + shellCwd 解析吞吐（139 万行/秒）
npm run test:stress:e2e          # 真实 Electron：30 次连续目录读取 中位 17.1ms / p95 30.0ms / 61.5 FPS
```

发版前另有一条硬性检查（Windows 专有，见 §8.1）：

```bash
npm run check:integrity   # 命中 Low 完整性标签退出码 1，必须先 fix:integrity 再打包 / 发布
```

界面与交互用真实 Electron 跑一条脚本化回归（`npm run smoke` 在本机受 `ELECTRON_RUN_AS_NODE` 干扰，用下面的直接调用）：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . \
  --smoke --user-data-dir="D:/ssh-workbench/.smoke-data"
```

`--user-data-dir` 不可省：主进程有 `requestSingleInstanceLock()`，复用默认目录会因已有实例而直接退出。冒烟会依次截取 初始 / 命令中心 / 输入 `disk` 后 / Esc 关闭 / 设置面板 / 栏宽分组 / 面板筛选 / 拖拽后 / 复位后 / 侧栏加宽 等图到 user-data-dir 内（**不是仓库根**），同时把分隔条拖拽前后的实际像素宽度写进 `smoke-result.json`（当前基线：280 → 370 → 280）。

除截图外还做 **DOM 级断言**（截图看不出「是不是列表」，而这正是用户抱怨的点）：

| 字段 | 断言内容 | 当前基线 |
|---|---|---|
| `shellProbe` | 外壳五段尺寸、品牌绿与主题实际落地值 | `titlebar.h: 44`、`activitybar.w: 48`、`sidebar.w: 280`、`statusbar.h: 28`、`main.w: 572`、`titlebarBg: rgb(39, 201, 63)`、`brandBgCount: 3`、`themeClass: 'light'`、`appBg: '255 255 255'`、`sidebarBg: 'rgb(248, 249, 250)'` |
| `visualProbe` | 视觉硬约束的运行时证据（不靠人眼看截图） | `blurCount: 0`、`longTransitionCount: 0`、`transitionAllCount: 0`、`animatedCount: 1`（仅 `slide-up`） |
| `switchProbe` | 切到「命令历史」后侧栏仍在、主区宽度正确、面板头 32px | `asidePresent: true`、`asideWidth: 280`、`pane: 'history'`、`headH: 32`、`railPresent: true`、`railWidth: 380`、`cols: 3` |
| `collapseProbe` | 再点同一项 = 收起侧栏，主区撑满 | `asidePresent: false`、`mainWidth: 852`、`railWidth: 380` |
| `filesProbe` | 文件面板 Tab / 引导态 / 面板头高 / 节点数 | `tabs: 2`、`hasHead: true`、`headH: 32`、`hasGuide: true`、`hasConnectCta: true`、`nodeCount: 22`（只统计 `[data-pane="files"]` 内，keep-alive 后侧栏还挂着另外两个面板） |
| `wallProbe` | 无搜索词时命令中心是分组网格而非列表 | `gridCount: 10`、`cols: 3`、`cardCount: 126`、`groupCount: 10` |
| `listProbe` | 输入关键字后退回列表 | `gridCount: 0`、`rowCount: 3` |
| `panelWallProbe` | 右侧命令栏常驻、按钮墙三列 | `found: true`、`railPresent: true`、`railWidth: 380`、`gridCount: 10`、`cols: 3`、`cardCount: 126` |
| `wallColsProbe` | 拖宽命令栏 / 复位时**列数恒为 3**（可变列数会让「第三行右边那个」的空间记忆失效） | `railDefault: {railWidth: 380, mainWidth: 572, cols: 3}`、`railWide: {railWidth: 560, mainWidth: 392, cols: 3}`、`railReset: {railWidth: 380, mainWidth: 572, cols: 3}` |
| `railToggleProbe` | 活动栏底部开关收起 / 展开命令栏 | `railCollapsed: {railPresent: false, mainWidth: 952}`、`railExpanded: {railPresent: true, railWidth: 380, cols: 3, cardCount: 126}` |
| `resizerProbe` | 分隔条真实拖拽 → 提交 → 双击复位 | `beforeDrag: 280` → `afterDrag: 370` → `afterReset: 280` |
| `iconProbe` | 窗口图标路径能解析、文件非空，**且 ico 里含 16/24/32 小尺寸** | 开发：`{iconBytes: 43888, icoSizes: [256,128,64,48,32,24,16], smallSizesOk: true, packaged: false}`；打包：同上但 `fromResources: true`、`packaged: true` |
| `tabStripProbe` | 标签栏容器必须满高（`h-full`），否则绿栏上下各留一条绿边，标题栏被切成三条色带 | `barH: 44`、`stripH: 44`、`stripGapTop: 0`、`tabCount: 3`、`tabH: 44`、`tabGapTop: 0` |
| `stressProbe` | 压测：45 个动作（Ctrl+K 开关 ×30、活动栏切视图 ×15）期间的帧间隔 | `frames: 124~141`、`avgFrameMs: 19.2~21.9`、`maxFrameMs: 78~111`、`longFrames: 4~10`、`over100: 0~2`、`actions: 45`、`errors: 0`、`valid: true` |
| `perfProbe` | DOM 规模不随连接数爆掉 | `totalNodes: 395`、`sidebarNodes: 192`、`sidebarRows: 12` |
| `expandProbe` | 展开 2917 条的 XCMD 组后仍受分页约束 | `rowsAfterExpand: 72`（12 默认组 + 60 分页） |
| `commandCenterOpenMs` | Ctrl+K 到浮层可见的轮询实测耗时 | `13 ~ 200 ms`（首次含冷加载） |
| `keepAliveProbe` | 切走过的面板仍挂载但隐藏（保留滚动/折叠/搜索状态） | `panes: ['connections','files','history']`、`visible: ['connections']`、`hiddenCount: 2` |
| `sharpProbe` | 无残留模糊层 | `blurLayers: []` |

`visualProbe` 的口径要注意：`transition-property` 的计算值默认就是 `all`，只看它会误判所有元素 —— 必须同时满足 `transitionDuration !== '0s'` 才算一条真实违规。

`stressProbe` 的判据同理要看三个值一起：`valid`（采到 ≥30 帧，防 rAF 被降到 0Hz 时 `avgFrameMs: 0` 的假绿）、`errors`（必须 0，否则动作根本没发生）、`maxFrameMs` / `longFrames`（抓尖峰，不看平均值 —— 平均会被空闲帧拉平）。当前基线 45 个动作 / 124~141 帧 / 平均 19~22ms / 最长 78~111ms / >50ms 的帧 4~10 个。

冒烟内有两处顺序依赖：

1. **侧栏视图**：切换 ActivityBar 会改侧栏内容，所以顺序固定为「文件（filesProbe）→ 命令历史（switchProbe）→ 命令历史（collapseProbe）→ 连接」。
   注意活动栏按钮的 `aria-label` 是 **「命令历史」**，写成 `clickActivity('历史')` 会匹配不到（返回 `found: false`），后续 `collapseProbe` 全为 `false`。
2. **命令栏宽度**：`wallColsProbe` 的拖宽会挤窄主区，必须在 `switchProbe` / `collapseProbe` 之后跑，否则那两个断言里的 `mainWidth` 基准会漂。收起/展开（`railToggleProbe`）同理放在最后。

两栏默认值会吃掉窗口宽度：1280 窗口下 `1280 - 48(活动栏) - 280(侧栏) - 380(命令栏) = 572`。这是「命令栏常驻右侧」的既定代价，不是 bug；`verify-layout.cjs` 里有一条断言保证默认布局下主区仍 ≥ 560。

跑真实数据压测：把 `%APPDATA%/ssh-workbench/data` 拷到 `.perf-data/data` 后把 `--user-data-dir` 指过去，即可复现 2929 条连接的场景。

`tabStripProbe` 需要标签栏里有标签才量得到，而冒烟环境没有 SSH 服务器，所以它会调 `window.__lazy_test.seedTabs(3)` 造三个假会话。`__lazy_test` 只在 `ZM_TEST=1` 的构建里注入（见 `electron.vite.config.ts`），普通构建跑出来是 `tabCount: 0`、`tabH: -1` —— 要验这条断言必须 `ZM_TEST=1 npm run build` 后再跑冒烟，**验完记得重新做一次不带 `ZM_TEST` 的发布构建**。

图标相关的一次性排查脚本（不属于常规自检，需要时手工跑）：

```bash
node scripts/probe-exe-icon.cjs "dist-v10/win-unpacked/SSH Workbench.exe"  # 解析 PE 资源，看 ico 有几档
node scripts/probe-native-image.cjs                                       # Electron nativeImage 能否读 ico/png
```

