# Portix（SSH Workbench）— 架构与设计概要

> 零遥测、免外挂的开源桌面 SSH 与串口终端工作台，面向嵌入式研发、现场运维与 SRE。
> 更新日期：2026-11-27 ｜ 发布线：**v2.5.2**（`yanxici/ssh-workbench`）｜ 升级实验线：**v2.5.2**（`yanxici/ssh-workbench-upgrade-x`）

详细历史演进见 [CHANGELOG.md](./CHANGELOG.md) 与 [Releases](https://github.com/yanxici/ssh-workbench/releases)。

---

## 1. 定位与边界

- **核心场景**：快速接入现场 Linux/BusyBox 设备与串口控制台，覆盖连接管理、常用命令墙、SFTP/ShellFS 文件与远程 `.bak` 编辑、ZMODEM/trzsz、内置 TFTP 刷机引导、多设备巡检与端口转发。
- **明确不做**：AI 日志分析、遥测或崩溃上报（由 `npm run verify:privacy` 硬门禁拦截外联域名与 `crashReporter`）。
- **串口只做 Console 与刷机引导**：不做十六进制收发、协议解析器或 XMODEM/YMODEM；传输依赖终端内 ZMODEM（`rz`/`sz`）或内置只读 TFTP 服务端（RFC 1350）。

---

## 2. 双轨技术栈与选型

全仓业务逻辑双向同步，仅底层桌面/样式栈分轨维护：

| 层次 | 正式发布线（`ssh-workbench` v2.5.2） | 实验升级线（`ssh-workbench-upgrade-x` v2.5.2） | 核心说明 |
| --- | --- | --- | --- |
| 桌面框架 | Electron `^33.3.1` + Vite `^5.4.11` | Electron `^45.3.1` + Vite `^7.3.8` | 离线/LTSC 内网免 WebView2 开箱即用；GPU 崩自动降级软件渲染 |
| 前端 / UI | React `^18.3.1` + Tailwind `^3.4.17` | React `^19.3.1` + Tailwind `^4.3.5` | 语义色 CSS 变量（R G B 三通道）；`@tanstack/react-virtual` 虚拟滚动 |
| 终端 / 串口 | `@xterm/xterm ^5.5.0` + `serialport ^13` | `@xterm/xterm ^6.0.0` + `serialport ^13` | SSH/串口共用终端；`iconv-lite` 流式解码 UTF-8/GBK/GB18030 |
| 传输 / 协议 | `ssh2 ^1.17.0` + `shellFs` + `zmodem.js` + `trzsz` + 内置 TFTP | 同左 | 覆盖现代 Linux、无 SFTP 的 BusyBox 与 U-Boot 刷机全链路 |
| 状态与存储 | Zustand `^5.0.2`（23 个 store）+ `safeStorage` + 原子 JSON | 同左 | 零原生数据库依赖；凭据走系统密钥加密，数据落盘 `userData/data/` |
| 构建与校验 | `electron-builder ^25.1.8` · 191 IPC · 104 组校验 | `electron-builder 26.8.1` · 189 IPC · 101 组校验 | 零测试框架，esbuild 单文件打包跑真实 Node / Electron CDP 回归 |

**为什么坚持 Electron（不迁 Tauri / GPUI）**：① 现场精简 Windows 常缺 WebView2 且内置显卡驱动差，Electron 自带软件渲染兜底；② 老式工业设备依赖 `ssh2` 对 `ssh-dss`/`hmac-md5`/CBC 等老算法的动态探测回退；③ 主/渲染进程 220+ 模块与 100+ 回归脚本高度耦合于 `window.api` 契约，未来仅在出现单一热点时挂载 `napi-rs` 原生插件。

---

## 3. 代码组织

```text
src/
├─ shared/                # 唯一契约源（10 模块）：types / ipc(常量) / themeCompat / serial* / commandEnv / remotePath / arpVendor
├─ main/                  # Node 主进程（~92–95 模块）
│  ├─ index.ts / smoke.ts / windowRef.ts / updater.ts / updaterChannel.ts(发布线)
│  ├─ app/                #   settingsService（设置变更与副作用协调）
│  ├─ transport/          #   Transport 抽象 / SshTransport / SerialTransport / MemoryTransport / serialPorts & Watcher
│  ├─ tftp/server.ts      #   内置 RFC 1350 只读 TFTP 服务端（blksize / tsize 协商）
│  ├─ ipc/                #   按域拆分为 18 个路由文件，统一 wrapResult 返回 { ok, data | error }
│  ├─ store/              #   jsonStore（队列+rename 原子写）/ pathGuard（路径令牌守卫）/ repository + repo/(8 域) / vault / externalImport
│  └─ ssh/                #   connectConfig / sessionManager / sftpManager / shellFs / portForward / remotePorts / recorder / diagnostics / exec / trzszBridge
├─ preload/               # contextBridge 暴露类型化 window.api（渲染层零 Node 权限）
└─ renderer/src/          # React UI（135 模块，23 个 zustand store）
   ├─ i18n/               #   中英双语字典与 verify:i18n 硬编码基线棘轮
   ├─ theme/              #   colorThemes.ts（4 套配色 × 明暗 8 变体，WCAG >= 4.5:1）
   ├─ lib/                #   纯逻辑模块（fuzzy / commandSearch / shellCwd / cwdFollow / paneTree / highlight / notifyPlan / shortcuts 等）
   └─ components/         #   layout(36px顶栏/44px活动栏/26px状态栏/WelcomeQuickLaunch) / connections / terminal(SerialBootBar/Zmodem) /
                          #   files(FileExplorer/RemoteEditorDialog/ShellModeBadge) / commands / settings(6选项卡) / diagnostics / backup / batch / discovery / firmware / metrics / profiles / transfer / ui(BrandMark)
```

---

## 4. 核心架构与数据流

```text
React 渲染层 (window.api) ──invoke──▶ contextBridge ──ipcMain──▶ 领域服务 / Transport
                                                                  ├─ repository ─▶ 原子 JSON + safeStorage
                                                                  ├─ sftpManager ─▶ SFTP / shellFs(BusyBox 回退)
                                                                  └─ sessionManager ─▶ SshTransport / SerialTransport
xterm.write ◀── EVT_SESSION_DATA ◀── adaptiveFlush(8ms → 20/32ms, 256KB 强刷)
```

- **文件双轨路由（`sftpManager` → `shellFs`）**：默认优先挂载原生 SFTP；若对端无 `sftp-server`，经错误特征 + `echo __SWB_SH_OK__` 探针双确认后自动降级至 POSIX Shell 通道并推送 `Shell 兼容` 角标，保留 `.swb-bak` 写入备份与原子 `.swb-part` 传输。
- **终端 `cwd` 跟随与自适应合帧**：`adaptiveFlush` 在常规敲击维持 8ms 延迟，大数据洪峰动态升档至 20–32ms 并设 256KB 强制刷新；输入追踪与 OSC 7 解析写入 `cwdStore[sessionId]`，驱动侧栏文件树静默跟随跳转。
- **串口与内置 TFTP 刷机闭环**：USB 身份三级识别（`serialNumber → pnpId → COM`）、`port.update()` 热切波特率不断线、`BREAK` 发送、`.cast` + 剥 ANSI `.log` 双写；`SerialBootBar` 提供 6s 倒计时后 250ms 连发 `2` 与单文件只读 TFTP（`blksize=1468`）。
- **发布线多通道自动更新（`updaterChannel.ts`）**：默认在无代理时优先尝试 Gitee 同源镜像（关闭 Range 差量避免 CDN 200 误判），按 `Gitee → GitHub → gh-proxy.com → ghfast.top` 自动回退并在第三方通道强制校验官方 `sha512`。

---

## 5. 视觉规范与硬性约束

1. **Portix 四层纯黑白 + 翡翠绿体系（v2.5.1）**：
   - 在架 4 套主题为 `vscode`（Portix 默认：纯白 `#FFFFFF` / 纯黑 `#000000` 消除灰霾 + 翡翠绿 `#059669`/`#10B981`）、`mono`（极简黑白）、`solarized`、`dracula`（见 `src/shared/themeCompat.ts`），明暗共 8 组全部通过对比度检测；UI 与 xterm 调色板联动。
   - 品牌色严格收敛为点/线语义（`BrandMark`、激活标签顶边线、活动栏 2px 指示条、连接行 hover 竖条），主内容与标题栏保持高对比极细边框（`border-edge`）。
2. **布局与性能约束**：
   - 左侧栏 `SideNav`（默认 280px）对视图做按需首次挂载 + `display` keep-alive 切换，保留滚动与展开状态；`settings` 已重构为 6 选项卡双语结构（`general / terminal / workflow / shortcuts / security / system`）。
   - 大规模连接（实测 2900+）采用组内分页（60/页）+ 超长组默认折叠 + 结构化字段（`host`/`port`/`serial.path`/`username`）及数字连续匹配 + 全局单轮转探活定时器 + `latencyById` 独立映射。
   - **渲染与内存铁律**：全站禁用 `backdrop-filter`（防 Windows 合成器残影发虚）；禁止 `transition-all`，过渡时长 `<= 150ms`；仅对 `opacity` / `transform` / `backgroundColor` 做动画；禁止任意 `text-[Npx]` 字号；`<button>` 内纵向 flex 子项必须配 `w-full min-w-0`；默认 DOM 渲染关闭硬件 GPU 加速并按活跃标签池化 WebGL 上下文，重型面板/弹窗均懒加载（鼠标悬停工具栏按需预热）；打包经 `scripts/after-pack.cjs` 仅留 `zh-CN`/`en-US` 语言 pak 与目标架构原生二进制。
   - **全量双语 `i18n`**：`src/renderer/src/i18n/core.ts` 保持零 React/Electron 依赖，7 个分域词典实现渲染层 `verify:i18n` 0 行硬编码中文基线，并由 `verify-i18n-en.cjs` 做全英文零溢出回归。
3. **品牌与仓库 Naming 收口**：
   自 **v2.5.1** 起应用端正式启用 **Portix**（窗口标题、`Portix.exe` 与 `make-icon.cjs` 生成的 7 尺寸 BMP+PNG `.ico`）；为维持老版自动更新与 `%APPDATA%/ssh-workbench/data/` 兼容性，仓库、安装包名（`ssh-workbench-Setup-*.exe`）与数据目录延续 `ssh-workbench` 命名。

---

## 6. 开发调试与发版门禁

- **Windows 完整性标签铁律**：本地安全沙箱工具可能给工作目录贴上 `Low Mandatory Level`，导致打包后的 `Portix.exe` 双击无反应（退出码 `-2147483645`）。**构建前与打包后**均须运行 `npm run check:integrity`（需修复时用管理员运行 `npm run fix:integrity`）。
- **常用命令**：

```bash
npm install --omit=optional         # 跳过 ssh2 可选 C++ 原生编译
npm run check                       # typecheck (node + web) + eslint
npm run build                       # electron-vite build -> out/
npm run verify:privacy              # 零遥测与外联域名白名单门禁
npm run verify:i18n                 # 渲染层硬编码中文基线守卫
npm run test:docs                   # verify-docs-sync（README / CHANGELOG 一致性）
CI=true node scripts/run-all-verify.cjs   # 全量自动化回归（100+ 模块脚本）
node scripts/e2e-ui-sftp.cjs        # 真实 Electron + SFTP/编辑器/ZMODEM UI 端到端
npm run check:integrity             # 扫描 Low 完整性标签
```

> **提示**：终端环境中若注入了 `ELECTRON_RUN_AS_NODE=1`，拉起 Electron 进程或 `--smoke` 前必须先取消该环境变量，并使用 `--user-data-dir=<临时目录>` 避开主进程单实例锁。
