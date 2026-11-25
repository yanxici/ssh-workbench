# SSH Workbench — 整体方案与设计文档

> 轻量级 SSH 客户端 + 嵌入式技术支持工作台
> 更新时间：2026-11-25 ｜ 阶段：**v2.4.1**，P0–P7（含串口控制台、客户端手感升级、嵌入式 SSH 韧性、终端效率迁移与精密仪器风外壳）已全部落地。
>
> v1.1–v1.5：连接分组管理、大规模连接性能优化、断线自动重连、命令中心范围筛选、侧栏文件面板右键下载、分组 Combobox、命令卡文本溢出修复、应用内自动更新、SFTP 批量目录读取、文件面板跟随终端 cwd。
>
> v1.6：上传文件夹（§5.13）、主机指纹更新（§5.14，并修掉一直算错的指纹算法）、IPC 按域拆分（§5.15）、上传/下载链路收敛（§5.16）、引入 ESLint、拆掉 `main/index.ts` / `repository.ts` / `SettingsPanel.tsx` 三个上帝文件。
>
> v1.9：右侧命令栏列数跟栏宽走、卡片去图标与命令行、自绘提示浮层；发布链路补文档同步门禁。
>
> v2.0：**串口控制台**（§5.17）—— 传输层抽象、串口会话、按 USB 身份认设备、拔插自动恢复、命令「适用环境」标记。
>
> v2.1–v2.2：**客户端手感与传输可靠化**（§5.18）—— 设计 token、虚拟滚动、面板骨架、WebGL 自愈降级、行级输出高亮、任务完成通知、嵌套分屏（最多 4 格）、`trzsz`、串口在线改波特率/BREAK/入站裸 LF 归一/内置 TFTP 与 U-Boot 刷机引导、断线自动续传与传输记录面板。
>
> v2.3：**交互动效、远程编辑器与更新通道**（§5.19）—— 交互动效层与 i18n 基座、零遥测隐私断言、智能 `Ctrl+C/V` 与终端鼠标手感、自适应输出合帧、零依赖升级内置远程编辑器；发布线 v2.3.2 补齐国内 Gitee 免代理自动更新通道与 `sha512` 防篡改校验。
>
> v2.4：**嵌入式 SSH 韧性 + 终端效率迁移 + 精密仪器风外壳**（§5.20–§5.22）—— 老旧设备 SSH 兼容算法与一键重连、无 `sftp-server` 自动降级纯 Shell/BusyBox 通道、隧道断线自愈/随连自启/远端端口发现与临时转发；拖放文件直传 `cwd`、多行/危险粘贴确认框、5 家外部客户端导入、分屏同步输入与后台未读点；36px 单色精密顶栏、主题精简 7→4（v3 静默迁移）、快速启动欢迎页与 `Ctrl+Shift+Z` Zen 专注模式。

---

## 1. 项目定位与范围

面向嵌入式设备技术支持场景的桌面工具：快速连上现场设备、执行常用制式命令、安全传输文件与固件、归档排查过程。

**明确不做**：AI 日志分析、遥测与崩溃上报（由 `verify:privacy` 硬门禁守护）。

**串口只做 Console 救急与刷机引导**（v2.0.0–v2.2.0，见 §5.17）：不做十六进制收发、不做协议调试器、不做 XMODEM/YMODEM 传文件、不做断线期间的缓冲回放、不开放串口文件系统浏览（串口只有单条物理字节流，无多路复用通道；传文件走终端内 ZMODEM `rz`/`sz` 或内置 TFTP）。判断标准是一条 —— Console 里敲命令与刷机，不用另开工具。

## 2. 技术选型与决策记录

本项目采用**双线维护**（全部业务代码逻辑双向同步，仅底层桌面与样式栈分轨）：
- **正式发布线（`yanxici/ssh-workbench`）**：守在稳定低体积栈（Electron 33 / React 18 / xterm 5.5 / Tailwind CSS 3 / Vite 5 / electron-builder 25，NSIS 安装包约 **80 MB**，另含 Gitee 国内免代理自动更新通道）。
- **实验升级线（`yanxici/ssh-workbench-upgrade-x`）**：验证前沿依赖栈（Electron 45 / React 19 / xterm 6 / Tailwind CSS 4 / Vite 7 / electron-builder 26.8，NSIS 安装包约 **112 MB**）。

| 层 | 选型（发布线 / 升级线） | 理由 |
|---|---|---|
| 桌面框架 | **Electron 33 + electron-vite 2** / **Electron 45 + electron-vite 5** | 零系统 WebView2 外部依赖（内网/精简版 Win10 开箱即用），ssh2 生态成熟 |
| 前端 | **React 18** / **React 19** + TypeScript 5.7 + **Vite 5 / 7** | 组件生态完整，类型贯通主/渲染进程 |
| UI | **Tailwind CSS 3 / 4**（语义色 CSS 变量）+ **lucide-react 0.469 / 1.72** + `@tanstack/react-virtual` | 主题切换只换 R G B 三通道 CSS 变量（4 套精选高对比配色 × 明暗，见 §5.7）；超长列表真实虚拟滚动 |
| 终端 | **@xterm/xterm 5.5 / 6.0** + `addon-fit` / `addon-search` / `addon-web-links` / `addon-webgl` | 事实标准；SSH 与串口共用同一终端组件；WebGL 崩溃时自愈降级软件渲染 |
| 串口 | serialport 13（`@serialport/bindings-cpp`）+ iconv-lite | bindings-cpp 提供 **NAPI v8 预编译**，Electron 33/45 与 Node 22/24 直接加载，无需 rebuild；GBK / GB18030 由 iconv-lite 流式解码 |
| 文件传输 | ssh2 SFTP 分块读写 + **`shellFs` 纯 Shell/BusyBox 降级** + `zmodem.js` + **`trzsz`** + **内置 RFC 1350 TFTP 服务端** | 覆盖现代 Linux、裁剪版 OpenWrt/BusyBox、跳板机内网与 U-Boot 刷机全场景 |
| SSH | ssh2 1.17（主进程） | 支持密码 / 私钥（PEM/OpenSSH/PuTTY `.ppk`）/ Agent / ProxyJump / SOCKS5 / HTTP CONNECT / SFTP / 端口转发 / 老旧算法兼容包（按运行时加密库能力动态构建） |
| 状态管理 | Zustand 5 | 轻、按域拆分 20+ 独立 store、无样板代码 |
| 本地存储 | **JSON 文件**（`userData/data/`） | 零 native 依赖；原子写（临时文件 + rename + 写队列）；可读可改、方便备份 |
| 凭据 | Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）+ 内存降级 | 密码、私钥口令、代理密码永不落明文 |

### 决策记录：为什么坚持 Electron，暂不重构为 Tauri / GPUI（OxideTerm 路线）

项目初期曾评估 Tauri 2，v2.4.0 完成后再次对照 OxideTerm（1.x 为 Tauri + Rust + Web；2.x 为纯 Rust + GPUI）复盘，结论仍是**保持 Electron（发布线稳守 Electron 33）**：
1. **资产体量与测试护城河**：当前业务代码约 **6.2 万行**（渲染层 3.76 万行、主进程 2.11 万行、共享与桥接 3.2 千行）外加 **3.5 万行 / 95 套自动化回归脚本**；迁纯 Rust + GPUI 等同 100% 推倒重写，迁 Tauri 也需重写全部 2.1 万行主进程逻辑且原有 JS 测试基本失效；
2. **嵌入式老算法兼容**：Rust 生态的 `russh` + `ring` 偏现代密码学，对老 Dropbear / 工业交换机必需的 `group1-sha1` / `ssh-dss` / `3des-cbc` / `hmac-md5` 支持很弱；
3. **Windows 现场离线环境约束**：现场工控机 / LTSC / 跳板机常缺失或存在老旧 WebView2 Runtime（若带 Fixed-Version WebView2 体积立刻涨回 130MB+）；GPUI 则重度依赖 DX12 显卡，在 RDP 与虚拟机上风险高，而 Electron 已内置 GPU 崩溃自动降级软件渲染；
4. **演进弹性与局部加速**：所有系统能力收敛在 `window.api` 之后，渲染层零 Node 权限；若未来某单一热点（如超大日志检索）真出现 CPU 瓶颈，优先以单个 **Rust N-API（`napi-rs`）原生插件**挂载，而非推倒整套桌面栈。

## 3. 目录结构

```
ssh-workbench/
├─ electron.vite.config.ts        # 三端构建配置（main / preload / renderer）
├─ electron-builder.yml           # 打包配置（win nsis + portable + zip）
├─ build/ · resources/            # 多尺寸 icon.ico / icon.png（scripts/make-icon.cjs 生成）+ app-update.yml
├─ docs/superpowers/              # v2.4.0 P0/P1/P2 设计规格、实施计划与交接归档（升级线）
├─ scripts/                       # make-icon.cjs、run-all-verify.cjs、95 套 verify-*.cjs、e2e-ui-sftp.cjs、
│                                 # check-integrity.ps1、sync-gitee-release.ps1（发布线）、extract/release-notes.cjs
├─ eslint.config.mjs              # ESLint 扁平配置（三档：主进程类型感知 / 渲染层 + Hooks / 脚本）
├─ tailwind.config.js             # 发布线 TW3 语义色 -> CSS 变量映射（升级线由 TW4 @theme 承载）
├─ src/
│  ├─ shared/                     # 三端共享（唯一契约来源，10 个模块）
│  │  ├─ types.ts                 #   全部数据模型 + IPC 请求/响应类型
│  │  ├─ ipc.ts                   #   173 个 IPC 通道常量（invoke + evt）
│  │  ├─ themeCompat.ts           #   v2.4.0 主题 ID 兼容归一化与 4 套有效主题表
│  │  ├─ commandEnv.ts            #   命令适用环境（ssh / serial）过滤
│  │  ├─ serialBaud.ts / serialDisplay.ts / serialTiming.ts  # 串口波特率、展示名与发送节奏常量
│  │  └─ bindHost.ts / remotePath.ts / arpVendor.ts          # 端口绑定、远端路径规范、ARP 厂商表
│  ├─ main/                       # Electron 主进程（91 文件，~2.1 万行）
│  │  ├─ index.ts                 #   窗口、生命周期、GPU 崩自愈降级软件渲染、事件转发
│  │  ├─ smoke.ts                 #   --smoke 冒烟与 DOM/视觉/压测探针（已从 index.ts 拆出）
│  │  ├─ windowRef.ts             #   主窗口引用（对话框父窗口；避免 ipc/* 反向依赖 index）
│  │  ├─ updater.ts               #   自动更新状态机（发布线配套 updaterChannel.ts 支持 Gitee 免代理多源回退）
│  │  ├─ app/settingsService.ts   #   设置修改统一入口（含副作用协调）
│  │  ├─ window/                  #   icon / notifier（系统任务完成通知）/ taskbar（任务栏进度）/ appUserModelId
│  │  ├─ tftp/server.ts           #   内置 RFC 1350 TFTP 只读服务端（blksize / tsize 协商，刷机引导用）
│  │  ├─ transport/               #   传输层抽象（Transport / sshTransport / serialTransport / memoryTransport /
│  │  │                           #   serialResolve / serialPorts / serialWatcher / serialLoader）
│  │  ├─ ipc/                     #   IPC 注册按域拆分（18 个文件），index.ts 调 registerAllIpc()
│  │  │  ├─ index.ts / handle.ts  #     统一注册、异常包装为 { ok:false }、中文标题映射
│  │  │  ├─ connections.ts / sessions.ts / serial.ts / commands.ts / settings.ts / errors.ts
│  │  │  ├─ sftp.ts / zmodem.ts / trzsz.ts / transferRecord.ts / localFs.ts / tftp.ts
│  │  │  └─ diagnostics.ts / devices.ts / backupTunnel.ts / windowUpdate.ts
│  │  ├─ store/
│  │  │  ├─ jsonStore.ts          #   原子写 JSON 存储（临时文件 + rename + 写队列）
│  │  │  ├─ pathGuard.ts          #   主进程路径白名单守卫（对话框授予的路径令牌校验）
│  │  │  ├─ repository.ts + repo/ #   8 个数据域（connections / commands / history / settings / diagSections / profiles / tunnels / knownHosts）
│  │  │  ├─ connTransfer.ts       #   本工具加密备份导出 / 导入
│  │  │  ├─ externalImport.ts     #   5 家外部客户端导入（ssh_config / MobaXterm / Xshell / SecureCRT / FinalShell）
│  │  │  ├─ transferRecord.ts     #   传输历史落盘与启动僵尸记录清理（sweepStale）
│  │  │  └─ vault.ts / backups.ts / reports.ts / bundle.ts / errorLog.ts / sessionLogs.ts / localFs.ts
│  │  ├─ ssh/
│  │  │  ├─ connectConfig.ts      #   连接配置构建、运行时动态 LEGACY_ALGORITHMS、指纹探测自动老算法回退
│  │  │  ├─ sessionManager.ts     #   会话生命周期、跳板链、自适应合帧、自动重连钩子（onClosed/onConnected/onReconnectGaveUp）
│  │  │  ├─ sftpManager.ts        #   SFTP 分块续传队列 + 无 sftp-server 双确认降级路由
│  │  │  ├─ shellFs.ts            #   纯 Shell/BusyBox 文件与流式二进制传输降级实现
│  │  │  ├─ portForward.ts        #   -L/-R/-D 隧道 + 断线挂起恢复 + 随连自启 + 临时转发去重与原地过户
│  │  │  ├─ remotePorts.ts        #   BusyBox 兼容远端监听端口探测（ss -> netstat -> /proc/net/tcp(6)）
│  │  │  ├─ recorder.ts           #   asciinema .cast + 剥 ANSI 纯文本 .log 双路独立录制
│  │  │  ├─ trzszBridge.ts / trzszDialogs.ts  # trzsz 文本传输桥接与对话框
│  │  │  └─ exec.ts / batchExec.ts / diagnostics.ts / metrics.ts / firmware.ts / netScan.ts / configBackup.ts / testConnection.ts
│  │  ├─ util/                    #   adaptiveFlush / parseSshCommand / privateKey / socks5 / proxySockets / zip / lineDiff / mdns / arp / tcpProbe 等
│  │  └─ data/                    #   seedCommands.ts（内置常用命令）+ diagTemplates.ts（31 项内置巡检模板）
│  ├─ preload/
│  │  ├─ index.ts / index.d.ts    # contextBridge 暴露类型化 window.api
│  └─ renderer/                   # React 渲染层（133 文件，~3.76 万行）
│     └─ src/
│        ├─ App.tsx               # 布局总装 + 全局快捷键 + Zen 快捷键 + 事件订阅 + 拖拽执行
│        ├─ i18n/index.ts         # 中英双语外壳字典与 translate/useI18n（基座 + 增量迁移）
│        ├─ styles/index.css      # 主题兜底变量 + 36px 单色精密外壳类 + token 行类 + 动效层
│        ├─ theme/colorThemes.ts  # 4 套高对比配色 × 明暗（精密默认 / Gruvbox / Solarized / Dracula）
│        ├─ lib/                  # 纯逻辑函数（均可用 esbuild 独立单测）：
│        │  ├─ fuzzy.ts / commandSearch.ts / commandWall.ts / groupOrder.ts
│        │  ├─ shellCwd.ts / cwdFollow.ts / dirLoader.ts / dirCache.ts / uploadDir.ts
│        │  ├─ terminalUx.ts / terminalDrop.ts / pasteGuard.ts / tabUnread.ts / editorText.ts
│        │  ├─ paneTree.ts / paneRegistry.ts / zenState.ts / layout.ts / ime.ts
│        │  ├─ highlight.ts / highlightRuntime.ts / notifyPlan.ts / taskNotify.ts
│        │  └─ shortcuts.ts / shortcutConflict.ts / zmodem.ts / zmodemRecord.ts / panelPrefetch.ts / useTokenFlag.ts
│        ├─ stores/               # 23 个 zustand store（含 splitStore / transferStore / trzszStore / tftpStore / cwdStore 等）
│        └─ components/
│           ├─ layout/            #   TitleBar(36px) / ActivityBar(44px) / SideNav / MainWorkspace / CommandRail / TabBar /
│           │                     #   StatusBar(26px) / PaneResizer / UpdateBadge / WelcomeQuickLaunch
│           ├─ connections/       #   ConnectionSidebar / ConnectionEditor / ConnTransferDialog（双模式导入）
│           ├─ terminal/          #   TerminalView / PasteConfirmDialog / SerialBootBar / ZmodemOverlay
│           ├─ files/             #   FileExplorer / SessionFileTree / LocalPane / RemotePane / RemoteEditorDialog /
│           │                     #   ShellModeBadge / TransferProgressDock / TransferTab / UploadTargetDialog / useUploadTarget
│           ├─ commands/          #   CommandPanel / CommandCenter / CommandEditor / CommandCard / CommandCardTip / Highlight
│           ├─ transfer/          #   TransferPanel（传输记录面板）
│           ├─ panels/            #   HistoryPanel / SessionLogsPanel / LogPlayerDialog / TunnelPanel / TunnelEditor / PanelSkeleton
│           ├─ settings/          #   SettingsPanel + sectionUi + 13 个分区（含 Appearance / Terminal / OutputHighlight / Notify / Transfer / Experimental / Update）
│           ├─ backup / batch / diagnostics / discovery / firmware / metrics / profiles / execution / ui
```

## 4. 架构与数据流

```
渲染层 (React)              preload 桥               主进程 (Node)                 远端设备 / 串口
─────────────              ─────────────             ─────────────                 ───────────────
window.api.xxx  ──invoke──▶ contextBridge ──ipc──▶  ipcMain.handle (173 通道)
                                                     ├─ repository ─▶ JSON 文件
                                                     ├─ vault ─▶ safeStorage 加密
                                                     ├─ sftpManager ─▶ SFTP 子系统 / shellFs 降级
                                                     └─ sessionManager ─▶ Transport
                                                                           ├─ SshTransport (ssh2)
                                                                           └─ SerialTransport (serialport)
xterm.write  ◀──webContents.send── EVT_SESSION_DATA ◀── 自适应合帧（8ms → 20/32ms, 256KB 强刷）
```

要点：
- **渲染进程零 Node 权限**：所有能力经 `window.api`（`IpcResult<T>` 统一包装，主进程异常永不越过 IPC 边界）；文件/外部配置导入路径经主进程对话框签发白名单令牌校验；
- **自适应高频数据合帧**（`adaptiveFlush.ts`，v2.3.1）：常规交互保持 8ms 低延迟；遇 `cat`/`dmesg` 洪峰自动升档至 20–32ms 并设 256KB 立即强刷上限，空闲 80ms 自动回落 8ms；解码下沉到 `Transport`（SSH 走 UTF-8，串口走 `iconv-lite` 流式 GBK/GB18030/UTF-8）；
- **输入路径与分屏广播**：xterm `onData` → `session:write`（开启分屏同步输入时经 `session:broadcast` 同步写到同标签所有格）→ `transport.write`；尺寸变化经 `ResizeObserver → fit → session:resize` 同步到远端 PTY；
- **反向路径（cwd 跟随）**：xterm `onData` 同时喂给 `shellCwd` 追踪器推断回车后的目录；`onData` 里解析出的 OSC 7 与 `sessionManager` 转发的 OSC 7 谁先到算谁，结果写 `cwdStore[sessionId]`，`FileExplorer` 订阅后按需批量拉目录（§5.11）。这条链路只读观察字节流，不向 PTY 注入任何东西；
- **文件通道双轨路由**（§5.20）：`sftpManager` 默认优先挂载原生 SFTP；遇到无 `sftp-server` 的嵌入式设备经错误特征 + `echo` 探针双确认后自动切入 `shellFs` 通道并广播 `EVT_SFTP_MODE`，渲染层亮出 `Shell 兼容` 徽标；
- **更新链路**（§5.12）：主进程 `updater.ts` 是唯一状态源 → `EVT_UPDATE_STATUS` 推给渲染层 → `UpdateBadge` / `UpdateSection` 纯展示；发布线叠加 `updaterChannel.ts` 支持 `Gitee → GitHub → gh-proxy.com → ghfast.top` 自动回退与官方 `sha512` 校验。

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

### 5.5 外观外壳与面板骨架（v2.4.0 单色精密仪器风升级）

**外壳五段**（`src/renderer/src/components/layout/`）：
- `TitleBar`：**36px**（`h-9`，与 `--size-titlebar: 36px` 同口径）单色中性面板底（`bg-panel`）+ 1px 下边框；取消旧版 44px 高饱和绿底，品牌色从「面」降级为「点」（Logo 徽标、激活标签顶部 2px 指示线、活动栏激活条）；右上角含命令中心、设置、**Zen 专注模式切换**、`UpdateBadge` 与窗口控制；
- `ActivityBar`：**44px** 窄轨（旧版 48px），激活项用绝对定位 `inset-y-1.5 left-0 w-0.5 bg-brand` 指示线；
- `SideNav`：默认 280px（可拖 220–520px），由 `activityView` 决定内容；
- `MainWorkspace`：`bg-app` 纯色，无活动会话时渲染快速启动欢迎页 `WelcomeQuickLaunch`，有会话时所有会话保持挂载仅切 `display`，支持单标签最多 4 格嵌套分屏与流式 `h-7` 分屏同步输入条；
- `StatusBar`：**26px**（`h-[26px]`，与 `--size-statusbar: 26px` 同口径）+ 等宽数字 `tabular-nums`，含 Git 分支、延迟、传输进度与终端行列数。

**品牌色使用边界**：每套主题拥有独立 `--c-brand`（不再硬编码 `#27c93f`），且严格收敛在「点/线」语义——Logo 徽标底光、激活标签顶部 2px 线、活动栏左边缘 2px 条、连接行 hover 左竖条、命令中心范围指示线与 Zen 激活图标。品牌色上的文字统一走 `--c-on-brand`（所有 8 组明暗变体实测 WCAG ≥ 4.5:1）。其余「选中」用 `--c-select`，「交互强调」用 `--c-accent`。

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

### 5.7 配色主题（v1.0.0 → v2.4.0 精简 7→4）

- `src/renderer/src/theme/colorThemes.ts` 定义 4 套高对比且各自拥有独立 `brand`/`accent`/`select` 的精选主题：**精密默认（`vscode`）**、**Gruvbox（`gruvbox`）**、**Solarized（`solarized`）**、**Dracula（`dracula`）**，每套均含 `dark` / `light` 两个 `ThemeVariant`（8 组变体全部实测 `ink/app`、`ink/panel`、`on-brand/brand` 对比度 ≥ 4.5:1），界面 CSS 变量与 xterm 调色板同源联动；外观设置画廊为 2×2 四宫格；
- 原 7 套中高度同质化的 `workbench` / `nord` / `onedark` 在 v2.4.0 退役，由 `src/shared/themeCompat.ts` 与 `UI_SHELL_VERSION = 3` 静默迁移回 `vscode`（且绝不覆写用户已选的 `dark`/`light`/`system` 明暗偏好）；
- 回归：`node scripts/verify-p2-theme-zen.cjs`、`node scripts/verify-theme-tw4.cjs`。

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

### 5.13 上传文件夹（v1.6.0）

「上传文件」早就有，但「上传一整个目录」在 v1.6.0 之前是**借拖拽顺带实现的**，语义藏在 `joinRemote(remoteDir, f.rel)` 里：本地目录的**内容**铺进目标目录，目录名本身不出现。这个语义对拖拽是合适的（用户把 `assets/` 拖进 `dest/`，期望 `dest/a.txt`），但对「上传文件夹」按钮就是错的 —— 用户明确选了一个文件夹，远端就该出现同名目录；否则选了两个同名不同内容的目录会互相覆盖，而且看不出来。

现在由 `TransferControl.keepRoot` 区分两条路径：

| 操作 | `keepRoot` | 远端落点 |
|---|---|---|
| 上传文件夹（按钮 / 右键菜单） | `true` | `目标目录/本地目录名/...`，空目录也会建出来 |
| 拖拽目录上传（历史行为） | `false` | 把本地目录的**内容**铺进目标目录 |

三条 UI 入口（侧栏文件面板、会话文件树、双栏远程栏）+ 三处右键菜单。IPC 新增 `SFTP_UPLOAD_FOLDER_DIALOG`（系统目录对话框，可多选）与 `SFTP_SCAN_FOLDERS`（上传前统计文件数 / 总字节数，2 万文件封顶并标记 `truncated`）。

空目录也要建：`transferUploadDir` 在 `keepRoot` 时会先 `ensureRemoteDir`，否则「上传一个空文件夹」看起来毫无反应。

回归：`node scripts/verify-upload-folder.cjs`（22 项，内存 SFTP 假通道覆盖保留目录名 / 铺平 / 空目录 / 扫描统计 / 单文件不受影响）。

### 5.14 主机指纹更新（v1.6.0）

设备重装 / 固件升级 / 换 sshd host key 之后，严格校验会把整台设备拒之门外。旧文案只让人「去设置里删除记录」，现场很绕。v1.6.0 把它做成一条闭环：**探测设备当前值 → 展示「旧 → 新」→ 用户确认 → 写回**。

三个入口共用同一套主进程能力：

- 设置 → 已知主机指纹：逐条指纹按钮 + 顶部「检查全部更新」
- 连接编辑器：测试连接报冲突时「更新主机指纹并重测」；成功时「用此指纹更新本地记录」
- 终端报错覆盖层：错误含「指纹」时「更新主机指纹并重连」

**两个必须知道的实现约束**：

1. **冲突不能靠 `hostVerifier` 抛异常传递**。那个回调在 ssh2 的密钥交换流程里是**同步**调用的，抛异常会打断协议状态机，错误退化成含糊的 `Host denied`，新旧指纹都带不出来。正确做法是：校验器只把事实记进 `hostKeyMismatches`（模块级 Map，按 host:port 索引、60 秒新鲜度），然后返回 `false`；连接按标准方式失败，上层用 `takeHostKeyMismatch()` 取详情。
2. **探测不能走校验流程**。要走的是「只握手、不认证、不写库」的 `probeHostFingerprint()`：`hostVerifier` 只记录并返回 `true`，`handshake` 事件一到就拿值收工。

> **顺带修掉一个一直错的算法**：旧实现给 ssh2 设了 `hostHash = 'sha256'`（ssh2 会把摘要转成 hex 再回调），代码又对**那份 hex 字符串**做 base64 —— 存下来的是 `SHA256:<hex>`，跟 `ssh-keygen -lf` 完全对不上。现在统一 `SHA256:` + base64(sha256(公钥)) 去 padding，与 OpenSSH 一致。老记录不失效：`isLegacyFingerprint()` 认得 64 位小写 hex 的旧格式，校验时两种都比对，命中一次即静默迁移成标准格式。

回归：`node scripts/verify-hostkey.cjs`（14 项：格式、与 openssl 手算一致、旧格式识别且不误判新格式）。

### 5.15 IPC 分层与完整性约束（v1.6.1）

`src/main/index.ts` 曾是 2199 行、装 134 个 handler 的单体文件：22 个业务域挤在一个 615 行的 `registerIpc()` 里，改 SFTP 和改固件升级要动同一处。v1.6.1 按域拆到 `src/main/ipc/`（12 个文件），`index.ts` 只调 `registerAllIpc()`。

两个配套模块是必须的，否则 12 个子文件会反向依赖入口形成循环 import：

| 模块 | 作用 |
|---|---|
| `ipc/handle.ts` | IPC 包装（异常统一转 `{ ok:false, error }`）+ 通道中文标题映射（错误日志用） |
| `windowRef.ts` | 主窗口引用 `getMainWindow() / setMainWindow() / dialogParent()` —— 弹系统对话框需要父窗口，而这个引用原本在 `index.ts` 里 |

**纯搬家的真正风险**：漏搬一个 `handle()` 不会编译失败，只会在用户点到那个按钮时报 `No handler registered`。所以新增三层对账的 `scripts/verify-ipc-registration.cjs`（`npm run test:ipc`）：

1. **静态**：`shared/ipc.ts` 里 141 个通道常量逐个在 `src/main` 找 `IPC.XXX` 注册点；
2. **运行时**：真跑一遍 `registerAllIpc()`，数 `ipcMain._invokeHandlers` 实际注册数与常量表比对，并检查有没有**多余注册**（改名字忘了改常量）；
3. **行为**：抽查通道可调用、失败被包装成 `{ ok:false }` 而非抛异常、导入通道拒绝未授权路径。

> 这个脚本第一次跑就抓出一条**死通道** `SESSION_RECONNECT_NOW`（`session:reconnect-now`）：常量表里有，但从未注册也从未被调用（查历史版本同样是 0 处）。它是 `sessionStore.reconnect()` 取代之后的遗留 —— 谁要是真去调它，会得到一个运行时 `No handler registered`。已删除。

### 5.16 前端契约收敛：上传/下载链路（v1.6.1）

v1.6.0 加上传文件夹时，在 4 个地方各写了一遍「解析目标目录 → 弹系统对话框 → toast → 失效缓存」，每份 19–26 行。改一处行为要同步改 4 个地方，漏一个就是「有的入口好使、有的不好使」。

v1.6.1 收敛成：

- **`sftpStore.uploadFileDialog / uploadFolder / downloadTo / downloadToDefault`** —— 唯一执行链路，返回 `{ count, target }` 让各面板自己决定怎么刷新
- **`components/files/useUploadTarget.ts`** —— 「先确认目标目录再弹文件框」的状态机（4 个 useState + busy/cancel/confirm），两个面板只渲染 `dialogProps`

净效果：`FileExplorer` 1082→993 行，`SessionFileTree` 812→729 行，两者 6 行重复片段 **31 → 2**；`window.api.sftp.*` 的直接调用从 5 个面板收敛到 store 一处。

### 5.17 串口控制台（v2.0.0）

**要解决的问题**：现场的真实动作是「插上 USB 转串口线，敲 `dmesg` 看设备起没起来」。连接管理、命令库、会话录制、日志归档都在这个工具里，唯独最救急的那条通道在外面 —— 必须切另一个串口工具。v1.x 把它列为「明确不做」，理由是开发效率：传输层与会话层是照 ssh2 的形状写的。

**做法：先抽传输层，再加串口**

| 文件 | 职责 |
|---|---|
| `src/main/transport/types.ts` | `Transport` 接口：`open` / `write` / `writeBytes` / `resize` / `close` + `onData(raw, text)` / `onClose(error)` |
| `sshTransport.ts` | 接管原先散在会话管理器里的解码：`StringDecoder('utf-8')`，stderr 混流 |
| `serialTransport.ts` | 换行归一（CR / LF / CRLF）、流式 iconv 解码、DTR 脉冲（**只碰 DTR，不碰 RTS**） |
| `memoryTransport.ts` | 内存假实现，验证脚本用 |
| `serialResolve.ts` | 端口解析：`serialNumber` → `pnpId` → 保存的 `path` |
| `serialPorts.ts` / `serialWatcher.ts` / `serialWatcherHolder.ts` | 枚举 + 指纹、2 秒轮询、单例持有 |
| `serialLoader.ts` | 原生模块懒加载 |

**关键决策**（都是踩过的坑，不是偏好）：

- **解码下沉到传输层**。原先 `SessionRecord.decoder` 在会话管理器里对字节流做 UTF-8 解码，串口要 GBK 就得在这里加分支。改成传输层各自持解码器后，待写缓冲也按字节（`pendingRaw`）合帧，主进程不再假设「数据一定是 UTF-8」。
- **存了 USB 身份却对不上时，绝不退化到 COM 号**。Windows 的 COM 号按枚举顺序分配，拔插或换 USB 口都会变，而另一台同型号设备可能正好占了旧号。静默连上去等于把命令敲到别人的板子上 —— 返回 `not-found`，让界面提示重选。唯一例外是平台根本给不出身份（Linux 的 `/dev/ttyUSB0` 常常没有 serialNumber / pnpId，整个列表都是空身份），此时才按 COM 号判定。
- **拔插恢复不复用 SSH 退避**。SSH 用 1/2/4/8/16 秒退避重连是对的（对端可能只是重启）；串口拔线时按退避重开一个不存在的设备毫无意义，而且插回的瞬间常落在长间隔里，用户会以为功能坏了。改为把会话停在 `phase: 'waiting-device'`，由端口轮询驱动恢复，恢复成功后补发一个 `\r` 唤醒提示符（很多设备长时间无输入会停止回显）。
- **DTR 自动复位默认关**。ESP32 / STM32 / Arduino 的自动下载电路把 DTR 接到 EN 脚，一拉就重启 —— 用户只是想看日志，结果把设备重启了，在现场是事故。串口连接也隐藏了「测试连接」按钮，理由相同：反复开关端口会触发 DTR。
- **串口连接复用 `Connection`，只加 `kind`**，`host` / `port` / `username` / `authType` 落成空值而不是改成可选。改成可选会让 `connectConfig`、主机指纹校验、跳板链、导入导出、搜索几十处都要做类型收窄，收益只是「类型上更诚实」。
- **串口会话全隐藏**指标 / 诊断 / 固件 / 备份 / 批量 / SFTP / 隧道。这些面板全部建立在「远端跑一条命令」上（主进程统一走 `getClient` + `execCollect`），串口没有 client，列出来只会拿到一句「该功能仅支持 SSH 会话」。判据是 `kind !== 'serial'` 而不是「是否 connected」，因为状态过滤各面板自己在做。
- **统一显示名**。`src/shared/serialDisplay.ts` 的 `describeSerialTarget` 给出 `COM3 · 115200 8N1`，`connectionTarget` / `connectionAddress` 供渲染层用。原先 15 处手拼 `${username}@${host}`，串口的 username / host 都是空串，会显示成孤零零一个 `@`。
- **原生模块不能静态 import**。`serialLoader.ts` 用变量形式 `require` 让 esbuild 无法静态解析 —— 否则打包后在没有对应二进制的环境（CI、裸 node 跑验证脚本）里直接抛 `No native build was found`，连主进程都起不来。懒加载同时把「只用 SSH 的用户不必付这笔启动开销」和「原生模块加载失败只影响串口」两件事一起解决了。
- **命令「适用环境」**：`Command.envs?: ConnKind[]`（缺省 = 两者都适用），`src/shared/commandEnv.ts` 收口 `normalizeEnvs` / `appliesTo` / `filterByEnv` / `envLabel`。用数组而非三态字符串，因为判定只需一句 `includes`。种子命令只给 5 条只在完整 Linux 上可用的标 `['ssh']`（`nc -zv`、`curl -i`、`top -b -n 1`、`journalctl -b -p err`、`i2cdetect`），其余 36 条不动 —— `uname -a` / `dmesg` / `cat /proc/*` / `reboot` 在 BusyBox 上都很常见，一刀切会误伤。
- **发送节奏（逐字符 / 换行后间隔）落在传输层，用队列而不是 async 循环**。现场往 U-Boot 或 9600 老设备粘贴长命令会被吞字节，而那条线上通常只有 TX/RX/GND，没有流控可握。`SerialConfig` 加 `charDelayMs` / `lineDelayMs`，合法区间收口在 `src/shared/serialTiming.ts`（上限 100ms / 2000ms：延迟按每个字符累加，填大了不是「更稳」而是命令发不完）；`write()` 仍然同步返回，只是把字符推进队列由 `pump()` 按间隔逐个落端口 —— 改成 async 循环会让两个并发调用互相插队，命令就拼错了。三个细节都是踩出来的：按码点切（`codePointAt` + 代理对算 2）否则汉字被劈成残字节；CRLF 只算一次行尾，两个都算会让每行停两次；两个延迟都配时取 `max` 而非相加（「5ms 每字符 + 200ms 换行后」的意图是等设备回 OK，不是 205ms）。`writeBytes` 不逐字节节流但排在文本之后；`close()` 与 `handleClosed()` 都要 `resetPacing()`，否则下次 pump 撞到已释放的 port。
- **在线切波特率走 `port.update()`，BREAK 用 `port.set({ brk })`**。两个串口专有能力，都刻意**不**塞进 `Transport` 接口 —— 那会让接口变成 serialport 的类型镜像，与已有的 `client?: Client` 是同一笔取舍。能力探测（`typeof transport.setBaudRate === 'function'`）放在 `sessionManager.requireSerialTransport`，好处是测试可以注入假传输层直接验证会话层转发。切波特率绝不用 close + 新建 `SerialPort`：重开端口会拉一遍 DTR/RTS 默认电平（接了自动下载电路的板子被复位）、让设备重新枚举、把中间几帧直接吞掉，而这三点正是用户要切波特率时最不想付出的代价。生效值写回 `config.baudRate` 并作为返回值回填界面；非法值回落**当前**值而不是默认值 —— 「已切到 115200」而实际没变，比报错难查。BREAK 的时长夹在 50..2000ms，**释放无条件执行**（置位抛错也要拉回 `brk: false`，否则 TX 被钉住只能拔线），且 `set` 只带 `brk` 一个字段（`port.set` 会把没写的字段按默认值处理，带上 `dtr`/`rts` 等于顺手复位板子）。区间常量收口在 `src/shared/serialBaud.ts`，与落盘、导入校验同源，否则会出现「界面能填、导入认、打开时被 serialport 拒」。界面不弹 BREAK 成功提示：价值在对端反应，本地拉低说明不了任何事。
- **录制同时产出 `.cast` 与纯文本 `.log`，两者各自计数**。`.cast` 是给回放器的时间轴 + 原始控制码，要 grep 或发到群里得先找工具转一遍。文本通道自己剥 ANSI（`stripAnsi` 手写扫描而不是正则，理由见 `recorder.ts` 注释）、把 `\r\n` 与 `\r` 归一成 `\n`、行首补**墙上时间** `[HH:MM:SS.mmm]`（现场要与设备日志、抓包对表，相对秒数对不上任何东西）、输入行加 `> `。两个 50MB 上限**各自独立**：一条被掐不会顺手把另一条也关了。`SessionLogFile.format` 让界面按后缀分流：`.log` 打 `txt` 标签且不给回放按钮（纯文本没有时间轴，点了没反应的按钮比不给更糟）；删除按「那次会话」——删 `.cast` 连带删同名 `.log`。
- **入站裸 LF 在传输层补成 CRLF，`raw` 不动**。Linux 设备的 tty 本该由 `ONLCR` 把 `\n` 翻成 `\r\n`，但 busybox 的精简 shell、裸机固件直接 `write("\n")`、输出重定向到串口这几类都不翻，屏幕上就是一路右移的阶梯 —— 终端里 `\n` 只下移、`\r` 才回行首。修在 `SerialTransport` 的入站文本通道（`normalizeInboundNewlines`），刻意**不**去开 xterm 的 `convertEol`：那是终端实例级开关，SSH 会跟着被改写，而对端本来就发完整 CRLF，多改一次会变成 `\r\r\n`。`onData(chunk, text)` 两个参数分开走 —— `raw` 逐字节原样透传（ZMODEM 帧与二进制协议靠它判帧，改一个字节 CRC 就废），只归一 `text`，于是录制、高亮行切分、终端看到的是同一份内容，不会「屏幕对了、日志里还是阶梯」。跨帧状态 `lastWasCR` 是必须的：串口按块到达，上一块末尾 `\r` + 下一块开头 `\n` 是一个完整 CRLF，只看当前块会补成 `\r\r\n` 反而多一个空行；`open()` 时重置。`config.newline` 与此无关，它描述的是「我们发出去用什么」。纯文本日志不受影响：`recorder.writeText` 本来就把 `\r\n` 与 `\r` 都归一成 `\n`。
- **导出导入按 kind 分流**。原先「host 非空 + port 1..65535」的校验会把串口连接整条丢掉并计入 `invalid`，用户会看到「N 条字段不合法」却不知道是自己的串口。新增 `cleanSerial` 逐字段白名单（`baudRate: 0` 或 `dataBits: 9` 会让 serialport 在 open 时抛一串 C++ 侧错误，界面上看不出是哪条连接坏了）；`dupKey` 对串口改用端口路径，否则两台不同设备重名会被判重复。导入时按 USB 身份找回端口，找不到的置 `pathPending` 并提示重选。

**打包**：`@serialport/bindings-cpp@13.0.0` 是 NAPI v8 预编译，Electron 33.4.11（ABI 130）与 Node 24 都能直接加载，`npmRebuild: false` 保持不动；electron-builder 25.x 会自动解包原生模块，`asarUnpack` 不需要写 `'**/*.node'`（对照实验确认，注释写进 `electron-builder.yml`）。

**回归**：`scripts/verify-serial.cjs`（102 项，内存假实现 + 假端口：换行归一、入站裸 LF 补 CR 且 `raw` 与源字节一致、跨帧 CR|LF 不被拆成 CRCRLF、GBK 解码、DTR 只动 DTR、拔线 → `waiting-device` → 插回自动恢复、发送节奏的逐字符 / 行间 / 混排 / 关闭清队列、切波特率真的走 `port.update` 且越界回落、BREAK 先 true 后 false 且只碰 `brk`）、`scripts/verify-session-log.cjs`（24 项，临时 userData 跑真实 `createWriteStream`：`.cast`/`.log` 成对、ANSI 剥离、一行一个墙上时间戳、输入前缀、两个开关的边界、双向截断互不影响、删一份连带删另一份）、`verify-serial-native.cjs`、`serial-spike-main.cjs` / `serial-spike-packaged.cjs`（打包后原生模块能否加载）、`.github/workflows/serial-spike.yml`；`verify-conn-transfer.cjs` 补串口导出 / 导入 / USB 身份找回 / 待确认 / 参数非法五组用例。

### 5.18 客户端手感、嵌套分屏、高亮、通知与传输可靠化（v2.1.0–v2.3.0）

- **设计 token、虚拟滚动与骨架屏（v2.1.0–v2.1.2）**：收敛 `--duration-*` / `--ease-out-expo` / `--size-rail(248px)` / `--size-statusbar(26px)` / `--size-titlebar(36px)`，引入 `@tanstack/react-virtual` 与面板级实验开关（`ExperimentalSection`）；`PanelSkeleton` + `panelPrefetch` 消除面板切换白屏；终端 WebGL 渲染新增 GPU 崩溃自愈降级（写盘 `softwareRender: true` 下次启动强制回落 DOM），并修复 canvas 字体串前导空格导致的 WebGL 字形缩小真根因（`lib/canvasFont.ts`）。
- **行级输出高亮与任务完成通知（v2.1.3–v2.1.4）**：`highlight.ts` / `highlightRuntime.ts` 实现规则编译与终端行级着色，设置页自带实时试匹配；`notifyPlan.ts` / `taskNotify.ts` + 主进程 `window/notifier.ts` 实现长任务完成系统通知、去重与按连接粒度静音（标签右键切换）。
- **嵌套分屏树（v2.1.5 / v2.1.7）**：`paneTree.ts` / `paneRegistry.ts` / `splitStore.ts` 支持单标签最多 4 格递归二分（水平/垂直），分隔条拖拽比例按连接持久化；嵌套格不另占顶栏标签位；标签右键与终端右键共享同一条分屏/关闭分屏链路；标签栏右键菜单通过 `createPortal` 挂到 `document.body` 彻底脱离 `-webkit-app-region: drag` 区域（由 OS 级鼠标点击回归 `verify-tabmenu-os.cjs` / `verify-tabbar-os.cjs` 守门）。
- **trzsz 与传输可靠化（v2.1.6 / v2.2.1）**：接入 `trzsz` 文本传输协议（`trzszBridge.ts`）；`sftpManager` 新增弱网断线自动续传（90s 重连恢复窗口 + 64KB 尾部指纹校验 + 防并发续传零洞）；新增 `transferRecord.ts` 与 `TransferPanel.tsx` 持久化传输历史，启动时 `sweepStale()` 清理僵尸 `running` 记录；串口新增内置 RFC 1350 TFTP 只读服务端（`tftp/server.ts`）与 U-Boot 刷机引导条（`SerialBootBar.tsx`）。
- **动效层、i18n 基座与隐私守卫（v2.3.0）**：`styles/index.css` 落地卡片轻抬 / 12ms 错峰入场 / 连接行左指示条 / 分组箭头旋转与 `.motion-off` 一键静止；`src/renderer/src/i18n/index.ts` 建立中英双语字典基座（配合 `verify-i18n.cjs` 棘轮）；新增 `verify-privacy.cjs` 断言零遥测 SDK、零 `crashReporter` 与出站域名白名单。

### 5.19 终端手感、自适应合帧、远程编辑器与国内更新通道（v2.3.1–v2.3.2）

- **终端智能 `Ctrl+C/V` 与鼠标手感（`terminalUx.ts`）**：默认快捷键改为 `Ctrl+C` / `Ctrl+V`（有选区复制且保持选区，无选区透传 `\x03`；`Ctrl+V` `preventDefault()` 杜绝双份粘贴）；新增可选「选中即复制」「右键快速复制粘贴」（`Shift+右键` 仍呼出完整菜单）、捕获阶段拦截 `Ctrl+滚轮` 单终端临时缩放（10–28px，`Ctrl+0` 复位）及右键导出终端纯文本缓冲（`IPC.SESSION_EXPORT_BUFFER`）。
- **大流量自适应合帧（`src/main/util/adaptiveFlush.ts`）**：替代旧版固定 8ms 合帧；常态保持 8ms，遇到 `cat`/`dmesg` 洪峰自动升档 20ms → 32ms 并设 256KB 立即强刷上限，空闲 80ms 立刻回落 8ms。
- **零依赖内置远程编辑器升级（`editorText.ts` + `RemoteEditorDialog.tsx`）**：不引入 CodeMirror/Monaco，零依赖补齐同步行号栏、`Ctrl+F`/`Ctrl+H` 页内查找替换、`Ctrl+S` 原地保存不关窗、编码与行列状态条、`Tab`/`Shift+Tab` 缩进及未保存误关二次确认。
- **国内免代理自动更新通道（发布线 v2.3.2，`updaterChannel.ts`）**：通过 Gitee 公开 API 解析最新 tag 与发行说明，以 `latest.yml` 附件存在作为发布完成判据，交由 `electron-updater` 的 `generic` provider 并强制 `disableDifferentialDownload = true` 绕开 Gitee CDN 对 Range 返回 200 全量的旧阻塞；无代理时按 `Gitee → GitHub → gh-proxy.com → ghfast.top` 自动回退，第三方加速站回退强制校验官方一跳源 `sha512` 防篡改。

### 5.20 嵌入式 SSH 韧性（v2.4.0 P0）

- **老旧嵌入式设备 SSH 兼容算法（`connectConfig.ts`）**：每连接可选 `legacyAlgorithms?: boolean`（默认关闭，串口忽略）；`LEGACY_ALGORITHMS` 不再静态硬编码，而是在模块加载时通过 `createRequire(__filename)('ssh2/lib/protocol/constants')` 与 `node:crypto` 实测能力动态构建（现代默认算法严格排在最前，老算法按运行时支持表追加末尾；自动规避 Electron BoringSSL 缺失 `chacha20` 与 `modp2` 引发的同步抛错与 `Unknown DH group`）；`probeHostFingerprint` 遇到算法协商失败自动老算法重试一次；终端报错浮层提供一键「启用老设备兼容算法并重连」，保存时凭据传 `undefined` 完整保留既有登录密码与代理密码。
- **无 `sftp-server` 自动降级纯 Shell/BusyBox 通道（`shellFs.ts` + `sftpManager.ts`）**：遇到裁剪掉 SFTP 子系统的 OpenWrt / Buildroot / BusyBox 设备时，必须通过 `isSftpSubsystemUnavailableError`（排除 `MaxSessions` 瞬时 `channel open failure` 与断线误降级）+ `echo __SWB_SH_OK__` 探针**双重确认**才切入 `shellFs` 通道，并通过 `IPC.EVT_SFTP_MODE` 在文件面板/文件树/双栏顶部展示 `ShellModeBadge`；所有远端命令走 `shQuote` 转义，删除入口走 `assertSafeRemovePath` 禁删根路径与空白路径；支持列表解析（`parseLsOutput`）、远程编辑（保留 `.bak` 与失败回滚）及原始二进制流上传下载。
- **隧道断线自愈、随连自启与远端端口一键发现（`portForward.ts` + `remotePorts.ts`）**：`sessionManager` 区分 `onClosed({ byUser, willReconnect })` / `onConnected` / `onReconnectGaveUp`；意外断线且将重连时活跃隧道进入 `reconnecting` 挂起态并在重连后恢复，用户手动停掉的记入 `manuallyStopped` 保持停止；持久隧道支持绑定连接 `autoStart` 随连自启；新增 BusyBox 兼容三级端口探测（`ss` → `netstat` → `/proc/net/tcp(6)`，保留纯 `[::1]` 并合并双栈监听）与会话级临时转发（`startQuickForward` 幂等去重、失败清理运行时表、冲突自动换空闲口、`promoteQuickForward` 原地不断流转存为常用隧道、`buildSafeLocalTunnelUrl` 白名单放行 HTTP 端口打开浏览器）。

### 5.21 终端效率与多客户端一键迁移（v2.4.0 P1）

- **拖放 OS 文件直传终端 `cwd`（`terminalDrop.ts` + `TerminalView.tsx`）**：默认 SFTP（或已降级的 `shellFs`）直传至 `cwdStore` 当前目录（`keepRoot: true`），按住 `Alt` 或在设置中可切 `trzsz`；`countDraggedFiles(dt)` 通过 `files.length → items(kind==='file') → types.includes('Files')` 三级回退兼容 Windows `dragover` 保护模式（且不影响命令卡片拖拽），`onDragLeave` 校验 `currentTarget.contains(relatedTarget)` 消除提示层闪烁。
- **多行/危险粘贴可编辑确认框（`pasteGuard.ts` + `PasteConfirmDialog.tsx`）**：右键粘贴、`Ctrl+V`、原生 `paste` 三处入口统一走 `requestPaste`；多行或含回车触发危险词时弹窗预览，支持一键剥离 Markdown 代码围栏、去掉末尾回车、直接编辑命令且危险词警告实时联动，textarea 的 `Ctrl+Enter` 配齐 `isImeComposing(e)` 守卫。
- **5 家外部客户端一键预览导入（`externalImport.ts` + `ConnTransferDialog.tsx`）**：支持 `~/.ssh/config`（含 `ProxyJump`）、MobaXterm（`.mxtsessions`）、Xshell（`.xsh` 含 UTF-16LE BOM）、SecureCRT（`.ini` 十六进制端口）与 FinalShell；先扫描预览统计、去重策略（跳过/覆盖）再写库，加密密码不做破解；选择路径严格经主进程 `pathGuard` 白名单令牌校验。
- **分屏同步输入与后台标签未读圆点（`splitStore.ts` + `tabUnread.ts`）**：多格分屏时顶部显示流式 `h-7` 同步输入条（`MainWorkspace` 改为 `flex-col` 不遮挡上方终端头），开启后走 `session.broadcast()` 广播输入，缩回单格自动关闭；后台非激活标签收到实质输出（过滤纯控制序列 + 切走后 500ms 宽限期）时在标签上点亮 6px 静态未读圆点，切回即清。

### 5.22 单色精密外壳、主题精简、欢迎页与 Zen 专注模式（v2.4.0 P2）

- **单色精密外壳与主题去同质化**：顶栏 44px 绿底 → 36px 单色中性画布、活动栏 48px → 44px、状态栏 28px → 26px，品牌色降级为点/线；7 套主题精简为 4 套高对比且各自拥有独立品牌色的精选主题，老配置由 `UI_SHELL_VERSION = 3` 静默迁移（详见 §5.5、§5.7）。
- **快速启动欢迎页（`WelcomeQuickLaunch.tsx`）**：空工作区展示最近 8 条连接（`useMemo` 缓存）、新建 SSH、新建串口（传 `{ kind: 'serial' }` 直达串口表单）、设备发现与命令中心入口。
- **非破坏性 Zen 专注模式（`zenState.ts` + `layoutStore.ts`）**：`Ctrl+Shift+Z` 或标题栏按钮一键收起左右双栏并记录切换前的 `zenSnapshot`，再次切换按快照精准还原；Zen 期间任何手动展栏入口（侧栏开关、命令栏开关、活动栏 `setActivityView` / `toggleActivityView`）统一经 `panePatch` 自动退出 Zen 并清快照，杜绝半开残留态。

## 6. 安全设计


| 项 | 实现 |
|---|---|
| 凭据存储 | safeStorage 加密后写入 `secrets.json`；系统加密不可用时仅内存持有 |
| 主机指纹 | 首次连接记录 OpenSSH 风格 `SHA256:base64` 指纹；严格模式下指纹变化直接拒绝，并把「记录值 / 设备当前值」一并带出来。更新入口三处（设置 / 连接编辑器 / 终端报错层），统一走「探测 → 展示旧新对比 → 用户确认 → 写回」，不静默信任（§5.14） |
| 指纹记录兼容 | 老记录可能是历史错误格式 `SHA256:<64位hex>`；校验时两种格式都比对，命中一次即静默迁移成标准格式，不需要用户手工清理 |
| 老旧 SSH 算法隔离 | 默认关闭，仅按连接显式开启；开启后现代算法仍严格排在最前，老算法仅作兜底追加末尾（§5.20） |
| 危险命令与粘贴防误触 | 命令级标记 + 全局关键词双保险；多行粘贴或含回车危险命令强制弹出可编辑确认框，危险词随编辑实时重算（§5.21） |
| 复制连接 | 刻意不复制凭据 |
| IPC 边界与路径白名单 | 173 个通道白名单 + 统一错误包装；文件/外部客户端导入路径经主进程 `pathGuard` 校验对话框签发路径，渲染层无任意磁盘读取权限 |
| Shell 降级防误删 | `shellFs` 所有路径经 `shQuote` 单引号转义；删除操作经 `assertSafeRemovePath` 禁止空路径、`/` 与 `.` / `..` |
| 本地隧道打开白名单 | `buildSafeLocalTunnelUrl` 仅允许 `http://127.0.0.1:<port>` 形式打开系统浏览器，杜绝任意 scheme 注入 |
| 零遥测隐私守卫 | 无任何统计/崩溃上报 SDK、`crashReporter` 出现 0 次、出站域名仅限白名单更新主机，由 `npm run verify:privacy` 硬门禁把关 |
| 更新包完整性 | `electron-updater` 内建 sha512 校验 + `allowDowngrade = false`；发布线 Gitee/第三方加速站回退时额外比对官方一跳源 `sha512` 一致才允许下载 |
| 目录跟随只读观察 | 只解析 xterm 字节流，**不向 PTY 注入 hook**、不改远端环境 |
| 串口设备身份与 DTR | 存了 USB 身份（serialNumber / pnpId）却对不上时**不退化到 COM 号**；DTR 自动复位默认关；BREAK 释放无条件执行且不碰 DTR/RTS（§5.17） |

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
| **P4-g**（v1.6.0） | **上传文件夹**（`keepRoot` 区分「保留目录名」与历史「铺平」语义，§5.13）、**主机指纹更新**（探测 → 旧新对比 → 确认写回，三处入口，§5.14），并修掉一直算错的指纹算法 | ✅ 完成 |
| **P4-h**（v1.6.1~v1.6.3） | **可维护性专项**：IPC 按域拆分（§5.15）、上传/下载链路收敛进 store（§5.16）、引入 ESLint、拆掉最后两个上帝文件（`repository` 764→70、`SettingsPanel` 959→118） | ✅ 完成 |
| **P5-a**（v1.9.0） | **命令栏排布**：列数跟栏宽走（§5.6）、卡片去图标与命令行、自绘提示浮层、发布链路补文档同步门禁 | ✅ 完成 |
| **P5-b**（v2.0.0） | **串口控制台**：传输层抽象（`Transport`）、串口会话、按 USB 身份认设备、拔插自动恢复、命令「适用环境」标记、串口连接导出导入（§5.17） | ✅ 完成 |
| **P5-c**（v2.1.0–v2.2.1） | **客户端手感与传输可靠化**：设计 token / 虚拟滚动 / 骨架屏 / WebGL 自愈降级 / 输出高亮 / 任务通知 / 嵌套分屏 / `trzsz` / 串口在线改波特率与 BREAK / 内置 TFTP 与 U-Boot 引导 / 断线自动续传与传输记录面板（§5.18） | ✅ 完成 |
| **P6**（v2.3.0–v2.3.2） | **动效、远程编辑器与更新通道**：交互动效层与 i18n 基座 / 零遥测隐私断言 / 智能 `Ctrl+C/V` 与鼠标手感 / 自适应合帧 / 零依赖内置远程编辑器 / 发布线 Gitee 国内免代理自动更新通道（§5.19） | ✅ 完成 |
| **P7**（v2.4.0） | **嵌入式 SSH 韧性 + 终端效率迁移 + 精密仪器风外壳**：老旧算法兼容与一键重连、无 SFTP 自动降级 `shellFs`、隧道自愈/自启与远端端口发现、拖放直传 `cwd`、多行粘贴安全确认、5 家外部客户端导入、分屏同步输入与未读点、36px 单色外壳、7→4 主题精简、快速启动欢迎页与 Zen 专注模式（§5.20–§5.22） | ✅ 完成 |
| **待办** | 插件系统（JS 脚本扩展命令/诊断/报告模板）；串口共享流文件浏览（如需，基于 `shellFs` 另做显式挂载协议） | ⏳ 未开始 |
| **已有独立安装包，暂无自动更新** | macOS（dmg）/ Linux（AppImage）不出更新元数据，`electron-updater` 当前只接了 Windows NSIS | ⏳ 未开始 |
| **已确认不做** | AI 日志分析、遥测上报、工单集成、VNC/RDP 入口、网络诊断工具、命令栏浮动形态 | ⏭️ 用户明确不需要 |

> P3-a 附注：新增通用能力 `window.api.exec.run(sessionId, cmd, timeout)`（任意面板可执行一次性命令）；连接编辑器状态上收到 `uiStore`，支持任意面板带预设呼出（设备发现 →「新建连接」、欢迎页 →「新建串口」均用此能力）。

### 7.0 版本更新记录

#### v2.4.1（2026-11-25）

| 分类 | 内容 |
|---|---|
| **远程编辑器塌陷修复** | `RemoteEditorDialog.tsx` 编辑区移除 `modal-body` 改用 `flex h-[56vh] min-h-0 overflow-hidden`，移除 `<textarea>` 的 `h-full` 改由 Flexbox `stretch` 与行号栏等高对齐，短/长文件及展开查找替换条均不再塌陷；补齐 `verify-remote-editor.cjs` 与 `e2e-ui-sftp.cjs` 渲染几何断言 |
| **终端光标闪烁修复** | `styles/index.css` 将 `.motion-off *` 改为 `.motion-off *:not(.xterm-cursor-blink)`，开启系统「减少动态效果」或关闭界面动效时不再误杀 xterm DOM 光标闪烁动画；`verify-motion.cjs` 补静态与真 Electron 断言 |
| **解压/便携版白图标修复** | 新增 `src/main/window/appUserModelId.ts`：打包版仅当开始菜单存在 AUMID、目标 exe 与图标均匹配的 `.lnk`（NSIS 安装版）时才绑定固定 `AppUserModelID`，解压 zip 与便携版直接沿用 exe 多尺寸图标不再退化白图标；新增 `verify-taskbar-aumid.cjs`（22 项） |
| **发布线 Gitee 同步优化** | 发布线取消海外 GitHub Actions CI 跨境上传 Gitee（避免 600s 超时），改由本机拉取 GitHub 同字节正式产物直传 `scripts/sync-gitee-release.ps1`；同步更新主界面门面图 `docs/ui/overview.png` |

#### v2.4.0（2026-11-24）

| 分类 | 内容 |
|---|---|
| **P0 嵌入式 SSH 韧性** | ① 每连接老旧算法兼容（运行时动态构建 `LEGACY_ALGORITHMS`，兼容 Electron BoringSSL 无 `chacha20`/`modp2` 与不同 `ssh2` 原生绑定）+ 报错浮层一键启用并重连 + 指纹探测自动回退；② 无 `sftp-server` 经错误判别 + `echo` 探针双确认自动降级 `shellFs.ts`（文件树/双栏/远程编辑/固件/备份全可用，顶部显示 `ShellModeBadge`）；③ 隧道断线挂起恢复、`manuallyStopped` 记忆、`autoStart` 随连自启、BusyBox 远端监听端口探测（`remotePorts.ts`）与临时转发幂等去重/原地不断流过户 |
| **P1 终端效率与迁移** | ① OS 文件拖入终端默认直传当前 `cwd`（`terminalDrop.ts` 三级计数兼容 Windows `dragover` 保护模式，`Alt`/设置可切 `trzsz`）；② 多行/危险粘贴可编辑预览框（`pasteGuard.ts` + `PasteConfirmDialog.tsx`，剥离 Markdown 围栏、危险词实时联动、IME 守卫）；③ `externalImport.ts` 支持 `~/.ssh/config`、MobaXterm、Xshell（UTF-16LE）、SecureCRT（十六进制端口）与 FinalShell 一键预览导入；④ 分屏顶部流式 `h-7` 同步输入条（`splitStore.syncByTab`）与后台标签 6px 未读输出圆点（`tabUnread.ts`） |
| **P2 单色外壳与专注台** | ① 取消 44px 绿标题栏，收敛为 36px 中性顶栏 + 44px 窄活动栏 + 26px 等宽状态栏，品牌色降级为点/线；② 7 套主题精简为 4 套高对比主题（精密默认 / Gruvbox / Solarized / Dracula，8 组变体全部 WCAG ≥ 4.5:1），`themeCompat.ts` + `UI_SHELL_VERSION = 3` 静默迁移退役 ID 且不动明暗偏好；③ 空工作区升级为 `WelcomeQuickLaunch` 快速启动欢迎页；④ 新增 `Ctrl+Shift+Z` 非破坏性 Zen 专注模式（所有展栏入口走 `panePatch` 自动退 Zen） |
| **双线同步与验证** | 升级线（Electron 45 / TW4）与发布线（Electron 33 / TW3，保留 v2.3.2 Gitee 通道）均已发版 `v2.4.0`；新增 7 套专项回归（`verify-legacy-algo` / `verify-shellfs` 165 / `verify-tunnel-resilience` 143 / `verify-paste-guard` 49 / `verify-external-import` 55 / `verify-split-sync` 29 / `verify-p2-theme-zen`），修复 `_osclick.ps1` 句柄枚举避开 UAC 50×50 覆盖窗与 `verify-batch-exec` 的 `ssh2` ed25519 密钥偶发失败 |

#### v2.3.0–v2.3.2（2026-11-19 ~ 2026-11-23）

| 分类 | 内容 |
|---|---|
| **v2.3.0 动效与基座** | 卡片悬停轻抬/按下回弹、命令墙 12ms 错峰入场、连接行左品牌竖条、分组箭头旋转、设置一键静止动效（跟随系统偏好）；抽离 `i18n/index.ts` 外壳字典基座；新增 `verify-privacy.cjs` 零遥测守卫 |
| **v2.3.1 终端与编辑器** | 终端默认改用智能 `Ctrl+C`/`Ctrl+V`、可选选中即复制与右键粘贴、单终端 `Ctrl+滚轮` 缩放、导出终端缓冲 `.txt`；`adaptiveFlush.ts` 8–32ms 自适应合帧；零依赖升级 `RemoteEditorDialog`（行号、`Ctrl+F/H`、`Ctrl+S` 原地保存、编码/行列条、`Tab` 缩进、未保存提醒） |
| **v2.3.2 更新通道（发布线）** | 新增 `updaterChannel.ts` 与 `scripts/sync-gitee-release.ps1`：国内免代理默认走 Gitee 公开 API + `generic` provider（关闭差量下载规避 200 Range）并按 `Gitee → GitHub → gh-proxy.com → ghfast.top` 自动回退，第三方加速站回退强制校验官方 `sha512` |

#### v2.1.0–v2.2.1（2026-11-14 ~ 2026-11-18）

| 分类 | 内容 |
|---|---|
| **v2.1.x 客户端手感** | 设计 token + 虚拟列表 + 骨架屏 + WebGL 自愈降级（修复 canvas 字体前导空格 bug）+ 行级输出高亮 + 任务完成通知与按连接静音 + 嵌套分屏树（最多 4 格）+ `trzsz` 文件传输 + 标签栏右键菜单 Portal 脱离 drag-region 及 OS 级点击回归 |
| **v2.2.0 串口刷机闭环** | 串口在线改波特率（`port.update()` 不复位 DTR）、发 BREAK、入站裸 LF 补 CRLF、`cast` + 纯文本 `.log` 双路录制、内置 RFC 1350 TFTP 服务端与 U-Boot 刷机引导条 |
| **v2.2.1 传输加固** | ZMODEM 续传防卡死、SFTP 断线 90s 自动续传（64KB 尾指纹校验、修复并发续传零洞）、远程编辑原子写防损坏、新增传输记录面板（`TransferPanel`） |

#### v2.0.0（2026-11-12）

| 分类 | 内容 |
|---|---|
| **串口（范围）** | 只做 **Console 救急**：不做十六进制收发、不做协议调试器、不做 XMODEM/YMODEM 传文件、不做断线期间缓冲回放。成功标准是「Console 里敲命令，不用另开工具」。§1 原「明确不做：串口终端」已改写 |
| **串口（传输层）** | 新增 `src/main/transport/`：`Transport` 接口（`open`/`write`/`writeBytes`/`resize`/`close` + `onData(raw,text)`/`onClose`），`sshTransport` / `serialTransport` / `memoryTransport` 三个实现。解码从会话管理器下沉到传输层，待写缓冲改为按字节合帧（`pendingRaw`）—— 主进程不再假设「收到的都是 UTF-8」 |
| **串口（会话层）** | `SessionRecord` 加 `kind` / `target` / `transport` / `serialConfig`，`client` 变可选。新增 `openSerial()` / `waitForDevice()` / `resumeSerialSessions()`。拔线后停在 `phase: 'waiting-device'`，由 2 秒端口轮询驱动恢复（**不复用 SSH 的 1/2/4/8/16 秒退避** —— 拔线时按退避重开不存在的设备没意义，插回瞬间常落在长间隔里），恢复后补发 `\r` 唤醒提示符 |
| **串口（设备身份）** | `resolveSerialPath` 按 `serialNumber` → `pnpId` → `path` 三级匹配。**存了身份对不上时不退化到 COM 号**：那说明端口上不是当初那台设备，静默连上去就是往陌生板子敲命令。例外：平台整体给不出身份时（Linux 常见）才按 COM 号 |
| **串口（DTR）** | 自动复位默认关。ESP32 / STM32 的自动下载电路把 DTR 接到 EN 脚，一拉就重启。串口连接隐藏「测试连接」按钮，理由相同 |
| **串口（原生模块）** | `serialLoader.ts` 用变量形式 `require`，让 esbuild 无法静态解析 —— 否则打包后在无二进制环境直接抛 `No native build was found`，主进程都起不来。`@serialport/bindings-cpp@13.0.0` 是 NAPI v8 预编译，`npmRebuild: false` 不用动；electron-builder 25.x 自动解包原生模块，`asarUnpack` 不必写 `'**/*.node'`（对照实验确认） |
| **串口（界面）** | 连接编辑器加串口分支（端口下拉 + 刷新、波特率 / 数据位 / 校验 / 停止位 / 流控 / 编码 / 换行、DTR 开关、目标摘要预览）；`src/shared/serialDisplay.ts` 统一显示名（`COM3 · 115200 8N1`），渲染层 15 处手拼 `${username}@${host}` 全部改用 `session.target`（串口下会显示成孤零零一个 `@`）；七个面板会话来源改为 `useSshSessions()` 并补空态文案 |
| **命令（适用环境）** | `Command` / `CommandInput` 加 `envs?: ConnKind[]`（缺省 = 两者都适用），新增 `src/shared/commandEnv.ts`。面板、命令中心、卡片浮层、编辑器全部接上；命令库头部计数改成过滤后的条数。种子命令只给 5 条标 `['ssh']`，其余 36 条不动（`uname -a` / `dmesg` / `cat /proc/*` / `reboot` 在 BusyBox 上很常见，一刀切会误伤） |
| **导出导入** | `ExportedConn` 加 `kind` / `serial`；`cleanPayload` 按 kind 分流（原「host 非空 + port 1..65535」会把串口整条丢掉并计入 invalid）；新增 `cleanSerial` 逐字段白名单；`dupKey` 对串口改用端口路径（否则两台不同设备重名判重复）；导入时按 USB 身份找回端口，找不到置 `pathPending` 并提示「N 条的端口在本机找不到」 |
| **回归** | 新增 `verify-serial.cjs`（50 项，内存假实现 + 假端口）、`verify-serial-native.cjs`、`serial-spike-main.cjs` / `serial-spike-packaged.cjs`、`.github/workflows/serial-spike.yml`；`verify-conn-transfer.cjs` 补串口五组用例 |

#### v1.9.0（2026-11-11）

| 分类 | 内容 |
|---|---|
| **界面（命令栏）** | **列数跟栏宽走**。`src/renderer/src/lib/commandWall.ts` 收口全部判据：`wallColumns(width)` 按 `< 360` / `< 480` / 其余分三 / 四 / 五列，`wallCardWidth` 扣掉 `WALL_PAD_X`(12) 与 `WALL_GAP`(4) 后均分，`wallStep` 的 ↑↓ 取实际列数、←→ 恒为 1。旧实现把 `WALL_COLS` 写死为 3，注释理由是「保空间记忆」，但前提是用户从不拖宽度 —— 实际被拖到过 340 下限，写死三列等于惩罚用户。代价是拖动跨越阈值时列数跳一次 |
| **界面（卡片）** | 去掉图标方块与命令行：名字占满整卡宽、最多两行；状态压缩成左边缘 2px 色条，优先级 `confirm` > `pinned` > `vars` > `none`。卡片高度 47~51px（且随名字长短跳动）→ 统一 **40px**，比改动前更矮。默认栏宽 380 → **400** |
| **界面（提示层）** | 原生 `title` 换成自绘浮层 `CommandCardTip.tsx`：0 延迟、命令等宽字体自动换行、贴边自动翻转。原生提示约 1 秒延迟、不能排版、不能高亮命中字 |
| **界面（搜索）** | 卡片里没有命令行了，搜 `sqlite3` 出来的卡看不出为什么命中 —— 命中命令字符索引非空时临时补一行 10px 命令片段并高亮。分组头 26px → 20px（10 组省 60px，约多放一行半卡片），拖拽把手与增删改按钮改 hover 出现 |
| **量化** | 129 条命令里被截断的从 **93 条**降到 **0~1 条**；名字可用宽度 54px → 70~81px；每行 4.9 字单行 → 7 字两行 |
| **范围** | 只改右侧命令栏。Ctrl+K 命令中心与底部横排（`layout=horizontal`）保持原样 |
| **回归** | 新增 `verify-command-wall.cjs`（37 项，断言刻意选「旧实现必红」的判据，如四列时下键步长必须是 4 而非写死的 3）与 `perf-command-wall.cjs`（20 项，真实应用 + 完整 IPC，渲染真实 129 条命令，340 / 400 / 600 三档宽度验列数与等高）。`verify-layout.cjs` 默认栏宽快照跟到 400 |
| **发布链路** | 新增 `verify-docs-sync.cjs`（`npm run test:docs`）：README `Current:` / README.zh-CN `当前版本：` / CHANGELOG 本版条目 / 两份 README「最近更新」**首条**必须是本版且正文 ≥ 60 字符 / CHANGELOG 本版条目 ≥ 200 字符（Release 正文发版时从这里现抽）。起因：v1.9.0 发出后 GitHub 上 README 还写 v1.8.1、CHANGELOG 没有 1.9.0 —— 发版日志有 CI 硬门禁所以从没漏过，README / CHANGELOG 只是 checklist 里的 checkbox，等于没有 |

#### v1.6.3（2026-10-29）

| 分类 | 内容 |
|---|---|
| **重构（数据层）** | **`repository.ts` 764 → 70 行**。8 个互不相干的域（连接 / 命令 / 历史 / 设置 / 巡检项 / 档案 / 隧道 / 已知主机）拆到 `src/main/store/repo/*.ts`。刻意保留 `repository.ts` 作为 **re-export barrel**，40 多个 import 点一行都不用改 —— 纯搬家的价值全在「不动调用方」。顺带删掉 `addHistory` 里与 `touchCommand` 完全重复的内联逻辑 |
| **重构（设置面板）** | **`SettingsPanel.tsx` 959 → 118 行**。拆成 `sectionUi.tsx`（Section / Row / Segmented 原子）+ 7 个 `*Section.tsx`；指纹状态机（273 行）整块进 `KnownHostsSection.tsx`。UI 原子必须独立放，否则 7 个 section 会反向依赖 `SettingsPanel` 形成循环 import |
| **回归** | 新增 `scripts/verify-repository-split.cjs`（`npm run test:repository`）：临时数据目录真跑 8 个域读写，**48 个断言全打在行为上** —— 凭据三态语义、分组默认值、空分组名必须抛错、sortOrder 递增、导入去重、历史上限、设置合并与迁移、巡检项超时三档钳制、指纹 refresh 不新增条目、8 个 JSON 各写各的 |
| **回归** | 新增 `scripts/probe-settings-sections.cjs`：CDP 逐个展开 10 个设置分区，确认渲染出真实控件并实测主题切换生效 |
| **修测试的坑** | `smoke-cdp` 的「跟随终端目录」偶发 FAIL：分区展开状态存进 localStorage，前一个 probe 展开过后 smoke 再点反而收起。代码本身没问题（全新 profile 11/11），但脚本不能重复运行是真坑，已改成「看到就停」的循环 |

#### v1.6.2（2026-10-29）

| 分类 | 内容 |
|---|---|
| **工具链** | **项目第一次有 lint 机制**。此前只有 `tsc` 把类型关。新增 `eslint.config.mjs`（扁平配置，ESLint 9 + typescript-eslint 8）分三档：主进程 / preload / shared 走 `recommendedTypeChecked`；渲染层加 `eslint-plugin-react-hooks`；`scripts/*.cjs` 只查明显错误。**刻意不开** `semi` / `quotes` / `indent` —— 既有代码 23537 行不带分号、单引号为主，是既定风格，动了只会制造噪声把真问题埋掉 |
| **修掉的真 bug** | ① `CommandPanel` / `CommandCenter` 的 `?? []` 每次渲染都分配新数组，作为 `useMemo` 依赖永不相等 —— 记忆化等于没有；② `SessionFileTree` 的 `forceRefresh` 是 `version` 的纯函数却在渲染期计算后被 effect 隐式捕获；③ `zmodem.ts` 的 `send_offer` 返回值没标注，导致 `transfer.*` 整条 any 调用链；④ `String(err ?? '')` 会把对象变成 `[object Object]`，既匹配不到协议特征又掩盖真实原因 |
| **规则误报的处理** | `require-await` 在 `firmware.upload` / `firmwareStore.startWaitOnline` 上是误报（接口契约是 Promise，调用方一律 `await`），保留 `async` + 行内 disable 说明。ZMODEM 的 `no-control-regex` 同理 —— ZDLE / DLE 就是协议字节 |

#### v1.6.1（2026-10-29）

| 分类 | 内容 |
|---|---|
| **重构（主进程）** | **`main/index.ts` 2199 → 1432 行**（其中约 1050 行是原有的 `--smoke` 自检）。134 个 handler 从单个 615 行 `registerIpc()` 按域拆到 `src/main/ipc/` 的 12 个文件。配套抽出 `ipc/handle.ts`（包装 + 通道标题）与 `windowRef.ts`（主窗口引用），避免子模块反向依赖入口形成循环 import（§5.15） |
| **重构（前端）** | 上传/下载执行链路收敛进 `sftpStore`（`uploadFileDialog` / `uploadFolder` / `downloadTo` / `downloadToDefault`）+ `useUploadTarget` hook。`FileExplorer` 1082→993 行、`SessionFileTree` 812→729 行，两者 6 行重复片段 **31 → 2**（§5.16） |
| **新增回归** | `scripts/verify-ipc-registration.cjs`（`npm run test:ipc`）三层对账：141 个通道常量逐个找注册点 / 真跑 `registerAllIpc()` 数 `ipcMain` 注册数与常量表比对并查多余注册 / 抽查失败包装与越权路径。**第一次跑就抓出死通道 `SESSION_RECONNECT_NOW`**（常量表里有但从未注册也从未被调用），已删除 |
| **新增回归** | `scripts/probe-ipc-domains.cjs`：真实应用里逐个域调一个代表通道（17 个域） |

#### v1.6.0（2026-10-29）

| 分类 | 内容 |
|---|---|
| **新增功能** | **上传文件夹**：`TransferControl.keepRoot` 区分「保留目录名」与历史「把内容铺进目标目录」两种语义，空目录也建出来；三条 UI 入口 + 三处右键菜单；新增 IPC `SFTP_UPLOAD_FOLDER_DIALOG` / `SFTP_SCAN_FOLDERS`（§5.13） |
| **新增功能** | **主机指纹更新**：探测设备当前值 → 展示「旧 → 新」→ 用户确认 → 写回。三处入口（设置 / 连接编辑器 / 终端报错层）。新增 IPC `KNOWN_HOSTS_PROBE`（只握手不认证不写库）/ `KNOWN_HOSTS_REFRESH`（§5.14） |
| **缺陷修复** | **指纹算法一直是错的**：旧实现设了 `hostHash='sha256'`（ssh2 把摘要转 hex 再回调），代码又对那份 hex 做 base64，存下来的是 `SHA256:<hex>`，跟 `ssh-keygen -lf` 完全对不上。现统一 `SHA256:base64(sha256(公钥))`；老记录靠 `isLegacyFingerprint()` 兼容并静默迁移 |
| **缺陷修复** | 指纹冲突不再靠 `hostVerifier` 抛异常传递（那个回调在 ssh2 密钥交换流程里同步调用，抛异常会打断协议状态机、错误退化成含糊的 `Host denied`）。改为记录进 `hostKeyMismatches` 并返回 `false`，上层用 `takeHostKeyMismatch()` 取详情 |
| **新增回归** | `verify-upload-folder.cjs`（22 项）、`verify-hostkey.cjs`（14 项）、`perf-new-features.cjs`（真实 IPC 链路）、`probe-packaged-features.cjs`（打包产物内核对新 API 是否真的进包） |

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

- 命令栏固定常驻右侧，列数跟栏宽走（`wallColumns(width)`，v1.9.0 起），不再提供「底部横条 / 浮动」形态 —— `commandPanelPosition` 字段仅为老配置兼容保留，渲染层已无消费者；
- **串口只做 Console 救急**（v2.0.0）：没有十六进制收发、没有协议调试器（Modbus / AT 帧解析等）、不支持 XMODEM / YMODEM 传文件、断线期间的串口输出不缓冲也不回放。要这些请用专门的串口工具；
- **串口会话只提供终端**：指标、诊断、固件、备份、批量、SFTP、隧道全部只对 SSH 会话开放 —— 它们都建立在「远端跑一条命令」上，串口没有 `client`；
- **串口换行只影响发送**：`newline` 配置作用于 `write()`，粘贴多行内容仍按原样发送；HEX 模式不存在，所以没有「不转换」的第三种选择；
- **串口设备身份可能缺失**：廉价 CH340 的 `pnpId` 只有 VID/PID，同型号两台无法区分；Linux 的 `/dev/ttyUSB*` 常常完全没有身份字段，此时只能按 COM 号认设备，拔插后可能连到别的设备上（界面不会替你兜底）；
- 快捷键已可自定义（含 `Ctrl+K` 命令中心与作用域感知冲突检测），默认组合：`Ctrl+N` 新建连接 / `Ctrl+K` 命令中心 / `Ctrl+,` 设置 / `Ctrl+B` 折叠侧栏 / `Ctrl+Alt+B` 折叠命令栏 / `Ctrl+Shift+Z` Zen 专注模式 / `Ctrl+Tab` 切换标签 / `Ctrl+Shift+W` 关标签 / `Ctrl+C`/`Ctrl+V` 智能复制粘贴（v2.3.1 起取代 `Ctrl+Shift+C/V`）/ `Ctrl+F` 终端搜索 / `Ctrl+滚轮` 与 `Ctrl+0` 单终端临时缩放；
- 大量输出合帧窗口已在 v2.3.1 升级为自适应（`adaptiveFlush.ts`：常规 8ms → 洪峰 20/32ms + 256KB 强刷上限，空闲 80ms 回落 8ms）；
- **Electron BoringSSL 老算法边界（v2.4.0 实测）**：Electron 内置 BoringSSL 不支持 OpenSSL 的 `chacha20` cipher 与 `modp2`（`diffie-hellman-group1-sha1`）。`connectConfig.ts` 已在加载期按当前运行时的 `ssh2` / `node:crypto` 实测能力动态过滤 `LEGACY_ALGORITHMS`，确保绝不同步抛出 `Unsupported algorithm` 或在协商时崩于 `Unknown DH group`；只支持 `group1-sha1` 且不支持 `group14-sha1` / `group-exchange-sha1` 的极老设备在 BoringSSL 下仍无法握手；
- **外部客户端加密密码不破解（v2.4.0）**：MobaXterm / Xshell / SecureCRT / FinalShell 导出文件里由各客户端加密的密码不做逆向解密，导入后仅搬运地址、端口、用户名、私钥与分组，首次连接需手输一次密码；
- 中英同义表 `SYNONYMS` 是手工维护的 22 组，新增命令分组时不会自动扩展 —— 需要新词时改表并跑 `scripts/verify-synonyms.cjs`；
- 连接分组拖拽排序已实现（v1.3.0），支持分组间拖放和组内排序，空分组会在下次加载时保留；
- 断线自动重连（v1.3.0）使用指数退避策略（1s / 2s / 4s / 8s / 16s 上限），最多尝试 5 次后需要用户手动重连；错误日志在终端内可见。
- **`<button>` 里的 column flex 一定要钉宽度**（v1.4.3/v1.4.4 连续踩两次）：浏览器给 `<button>` 的 UA 样式含 `align-items: flex-start`，交叉轴子项宽度由内容决定，`truncate` 的 `overflow: hidden` 拿不到受约束宽度、不参与收缩，长文本直接顶出边界。只加 `min-width: 0` 无效，必须 `w-full min-w-0` 一起上。新增任何「按钮内多行文本」结构都要复查这一条；
- **分组/枚举类输入不要用原生 `<datalist>`**（v1.4.4）：datalist 会拿输入框当前值做子串过滤，预填默认值时用户几乎看不到其他候选，且无关闭开关。统一用 `Combobox`（`src/renderer/src/components/ui/index.tsx`），浮层走 `fixed` + 实测坐标定位，避免被 modal 的 `overflow-hidden` 裁切。
- **自动更新只对 NSIS 安装版生效**（v1.5.0）：portable 与 zip 解压版没有安装上下文，`electron-updater` 无法自我替换，`isUpdateVisible()` 直接不显示更新入口，只能靠安装包覆盖升级；
- **Gitee 国内更新通道（v2.3.2 / v2.4.1 勘误：已在发布线落地）**：早期评估曾因 `electron-updater` 无内置 gitee provider 且 Gitee CDN 对 Range 返回 200 全量而搁置；发布线 v2.3.2 通过 `updaterChannel.ts` 改走「Gitee 公开 API 解析最新 tag + `generic` provider + `disableDifferentialDownload = true` 关闭差量 + `latest.yml` 压轴上传 + 官方 `sha512` 校验」成功打通，并支持自动回退 GitHub 与加速站。由于海外 GitHub runner 跨境上传 80MB 安装包至 Gitee 易触发 600s 超时，v2.4.1 起发布线取消 CI 内跨境上传，改为发版后在国内本机拉取 GitHub 同字节正式产物运行 `scripts/sync-gitee-release.ps1` 直传；
- **文件面板跟随有边界**（v1.5.1）：只认单行 `cd` / `pushd` 与 OSC 7；`alias` 改写的 `cd`、环境里带函数的 `cd`、以及远端未配 OSC 7 时的脚本内 `cd` 都跟不到，此时面板停在上一个目录。`Ctrl-U` / `Ctrl-W` / 方向键等编辑后整行被保守丢弃，也是「宁可不动，不跳错」的取舍；
- **目录缓存的失效时机**（v1.5.1）：TTL 到期、显式 `refresh()`、会话关闭、以及上传/删除/改名/新建等写操作 —— 若是**远端其它人**改了目录内容，面板要等 TTL 到期才看到。
- **lint 覆盖的是 `src/`，不是全部**（v1.6.2）：`npm run lint` 只跑 `src/**/*.{ts,tsx}`；`scripts/*.cjs` 要单独 `npm run lint:scripts`（`npm run lint:all` 一次跑完）。`npm run check` 只做 typecheck + src lint。
- **ESLint 刻意不开排版规则**（v1.6.2）：`semi` / `quotes` / `indent` 全部关闭。既有代码 23537 行不带分号、以单引号为主，那是既定风格；开排版规则会产出几千条噪声把真问题埋掉。要统一风格应该单独做一次全仓格式化。
- **两条 `require-await` 是行内豁免**（v1.6.2）：`firmware.upload` 与 `firmwareStore.startWaitOnline` 的接口契约是 Promise，调用方一律 `await`，去掉 `async` 会让类型对不上。这类豁免必须带注释说明原因。
- **`repository.ts` 是 re-export barrel**（v1.6.3）：新增数据域请直接在 `src/main/store/repo/` 下开新文件，并在 `repository.ts` 补一行 `export`。不要往里加实现 —— 它会重新长回上帝文件。
- **设置分区的展开状态存在 localStorage**（v1.6.3）：key 为 `sshwb.settings.sections`。副作用是**自动化脚本不能假设「点一下就会展开」** —— 上一轮已经展开过的话，再点就是收起。写 UI 脚本要用「看到就停」的循环（`smoke-cdp.cjs` 已按此改写）。

## 10. 开发自检

纯函数逻辑用 esbuild 打包成单文件后由 node 直接断言，不引入测试框架；**全量一键运行器**为 `node scripts/run-all-verify.cjs`（`npm run test:verify`，当前纳入 **93（升级线）/ 95（发布线）** 套活跃回归脚本，已接入 CI `Build and Release` 硬门禁）：

```bash
npm run check                            # typecheck:node + typecheck:web + eslint（提交前必跑）
npm run test:verify                      # 一键跑全量 verify-*.cjs（支持 --only=<关键词> / --list）
npm run test:p0                          # v2.4.0 P0 三件套：legacy-algo / shellfs(165) / tunnel-resilience(143)
npm run verify:privacy                   # 零遥测 / 零 crashReporter / 出站域名白名单
npm run verify:i18n                      # 中文硬编码行棘轮守卫
node scripts/verify-paste-guard.cjs      # 拖放计数(含 Windows dragover 保护模式) + 粘贴预览与围栏剥离(49 项)
node scripts/verify-external-import.cjs  # 5 家外部客户端导入解析与去重(55 项)
node scripts/verify-split-sync.cjs       # 分屏同步输入与后台标签未读点(29 项)
node scripts/verify-p2-theme-zen.cjs     # 4 套主题 WCAG 4.5:1 / v3 静默迁移 / Zen 模式状态机
node scripts/verify-taskbar-aumid.cjs    # Windows 解压版/便携版条件绑定 AppUserModelID（22 项）
node scripts/verify-ime-guard.cjs        # Enter/Ctrl+Enter IME 组合态守卫棘轮（16 处全覆盖）
node scripts/verify-docs-sync.cjs        # README / CHANGELOG 版本号与最近更新同步（6 项）
node scripts/verify-updater-channel.cjs  # 发布线 Gitee/GitHub 多通道更新与 sha512 校验（34 项）
node scripts/e2e-ui-sftp.cjs             # 真 Electron CDP UI 级 SFTP 全流程 E2E（20 项）
node scripts/verify-tabbar-os.cjs        # 标题栏/标签栏 OS 级真机鼠标点击回归（EnumWindows 精准取主窗 HWND）
node scripts/verify-tabmenu-os.cjs       # 标签右键菜单 OS 级真机点击回归
```

需要真实 Electron 主进程才能跑的代表脚本（会拉起 `ipcMain`）：

```bash
npm run test:ipc          # 173 个通道三层对账：静态注册点 / 运行时注册数 / 失败包装与越权拒绝
```

其余历史专项回归（`verify-command-search`、`verify-synonyms`、`verify-layout`、`verify-group-order`、`verify-transfer-progress`、`verify-shellcwd/cwdstore/cwdfollow`、`verify-dirloader/dircache`、`verify-upload-folder`、`verify-hostkey`、`verify-repository-split`、`verify-release-notes`、`verify-command-wall`、`verify-serial`、`verify-session-log`、`verify-conn-transfer`、`verify-highlight*`、`verify-notify*`、`verify-split-e2e`、`verify-trzsz*`、`verify-terminal-ux`、`verify-adaptive-flush`、`verify-remote-editor`、`verify-design-tokens`、`verify-motion`、`verify-zmodem*`）均由 `run-all-verify.cjs` 自动调度。

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

| 字段 | 断言内容 | 当前基线（v2.4.0） |
|---|---|---|
| `shellProbe` | 外壳五段尺寸、单色精密外壳与主题实际落地值 | `titlebar.h: 36`、`activitybar.w: 44`、`sidebar.w: 280`、`statusbar.h: 26`、`main.w: 555`、`titlebarIsBrand: false`、`brandBgCount: 2`、`themeClass: 'light motion-off'`、`appBg: '255 255 255'`、`sidebarBg: 'rgb(248, 249, 250)'` |
| `visualProbe` | 视觉硬约束的运行时证据（不靠人眼看截图） | `blurCount: 0`、`longTransitionCount: 0`、`transitionAllCount: 0`、`animatedCount: 0`（`.motion-off` 时） |
| `switchProbe` | 切到「命令历史」后侧栏仍在、主区宽度正确、面板头 32px | `asidePresent: true`、`asideWidth: 280`、`pane: 'history'`、`headH: 32`、`railPresent: true`、`railWidth: 400`、`cols: 4` |
| `collapseProbe` | 再点同一项 = 收起侧栏，主区撑满 | `asidePresent: false`、`mainWidth: 835`、`railWidth: 400` |
| `filesProbe` | 文件面板 Tab / 引导态 / 面板头高 / 节点数 | `tabs: 2`、`hasHead: true`、`headH: 32`、`hasGuide: true`、`hasConnectCta: true` |
| `wallProbe` | 无搜索词时命令中心是分组网格而非列表 | `gridCount: 10`、`cols: 3`、`groupCount: 10` |
| `listProbe` | 输入关键字后退回列表 | `gridCount: 0`、`rowCount: 3` |
| `panelWallProbe` | 右侧命令栏常驻、默认 400px 宽四列 | `found: true`、`railPresent: true`、`railWidth: 400`、`cols: 4` |
| `wallColsProbe` | 拖宽命令栏 / 复位时列数随宽度自适应（`<360` 三列、`<480` 四列、`>=480` 五列） | `railDefault: {railWidth: 400, cols: 4}`、`railWide: {railWidth: 580, cols: 5}`、`railReset: {railWidth: 400, cols: 4}` |
| `railToggleProbe` | 活动栏底部开关收起 / 展开命令栏 | `railCollapsed: {railPresent: false, mainWidth: 955}`、`railExpanded: {railPresent: true, railWidth: 400, cols: 4}` |
| `resizerProbe` | 分隔条真实拖拽 → 提交 → 双击复位 | `beforeDrag: 280` → `afterDrag: 370` → `afterReset: 280` |
| `iconProbe` | 窗口图标路径能解析、文件非空，**且 ico 里含 16/24/32 小尺寸** | `{iconBytes: 43888, icoSizes: [256,128,64,48,32,24,16], smallSizesOk: true}` |
| `tabStripProbe` | 标签栏容器必须满高（`h-full`），贴齐 36px 顶栏 | `barH: 36`、`stripH: 35`（含 1px 底边）、`stripGapTop: 0` |
| `stressProbe` | 压测：45 个动作（Ctrl+K 开关 ×30、活动栏切视图 ×15）期间的帧间隔 | `over100: 0`、`actions: 45`、`errors: 0`、`valid: true` |
| `perfProbe` | DOM 规模不随连接数爆掉 | 2929 条连接下仍保持千级节点、`frameMs < 1` |
| `expandProbe` | 展开 2917 条的 XCMD 组后仍受分页约束 | 分页截断不爆 DOM |
| `commandCenterOpenMs` | Ctrl+K 到浮层可见的轮询实测耗时 | `< 200 ms` |
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

