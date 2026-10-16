# SSH Workbench — 整体方案与设计文档

> 轻量级 SSH 客户端 + 嵌入式技术支持工作台
> 更新时间：2026-10-14 ｜ 阶段：P0（核心闭环）已实现

---

## 1. 项目定位与范围

面向嵌入式设备技术支持场景的桌面工具：快速连上现场设备、执行常用制式命令、归档排查过程。

**明确不做**：串口终端、AI 日志分析。

## 2. 技术选型与决策记录

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Electron 33 + electron-vite** | 经评估后确定（见下方决策记录）；Node 22 环境零额外前置，ssh2 生态成熟 |
| 前端 | React 18 + TypeScript + Vite | 组件生态完整，类型贯通主/渲染进程 |
| UI | Tailwind CSS（语义色变量）+ lucide-react | 双主题切换只换 CSS 变量；图标按名字动态解析 |
| 终端 | @xterm/xterm + addon-fit / addon-search / addon-web-links | 事实标准 |
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
├─ electron-builder.yml           # 打包配置（win nsis / mac dmg / linux AppImage）
├─ tailwind.config.js             # 语义色 -> CSS 变量映射
├─ src/
│  ├─ shared/                     # 三端共享（唯一契约来源）
│  │  ├─ types.ts                 #   全部数据模型 + IPC 请求/响应类型
│  │  └─ ipc.ts                   #   IPC 通道常量
│  ├─ main/                       # Electron 主进程（全部系统能力）
│  │  ├─ index.ts                 #   窗口、IPC 注册、生命周期、--smoke 自检
│  │  ├─ store/
│  │  │  ├─ jsonStore.ts          #   原子写 JSON 存储（临时文件 + rename + 写队列）
│  │  │  ├─ repository.ts         #   连接/命令/历史/设置/已知主机 CRUD（唯一持久化入口）
│  │  │  └─ vault.ts              #   凭据保险箱（safeStorage 加密）
│  │  ├─ ssh/
│  │  │  ├─ connectConfig.ts      #   连接配置构建（认证/指纹校验）+ 建连原语 + 错误翻译
│  │  │  ├─ sessionManager.ts     #   会话管理（跳板链/shell/合帧转发/延迟探测）
│  │  │  └─ testConnection.ts     #   测试连接
│  │  ├─ util/parseSshCommand.ts  #   剪贴板 ssh 命令解析
│  │  └─ data/seedCommands.ts     #   内置常用命令（42 条，首次运行注入）
│  ├─ preload/
│  │  ├─ index.ts                 # contextBridge 暴露 window.api（类型化）
│  │  └─ index.d.ts               # Window 全局类型声明
│  └─ renderer/                   # React 渲染层
│     ├─ index.html
│     └─ src/
│        ├─ App.tsx               # 布局总装 + 全局快捷键 + 事件订阅 + 拖拽执行
│        ├─ styles/index.css      # 主题变量（暗/亮）+ 组件类（btn/input/menu/modal）
│        ├─ theme/terminalThemes.ts
│        ├─ lib/                  # utils / ipc 解包助手 / 图标白名单
│        ├─ stores/               # zustand：settings/connection/session/command/execution/toast
│        └─ components/
│           ├─ layout/            #   TabBar / StatusBar
│           ├─ connections/       #   ConnectionSidebar / ConnectionEditor
│           ├─ terminal/          #   TerminalView（xterm 集成）
│           ├─ commands/          #   CommandPanel / CommandEditor
│           ├─ panels/            #   HistoryPanel
│           ├─ settings/          #   SettingsPanel
│           ├─ execution/         #   VariablePromptDialog / DangerConfirmDialog
│           └─ ui/                #   Modal / ConfirmDialog / ContextMenu / Toast / 表单件
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

## 6. 安全设计

| 项 | 实现 |
|---|---|
| 凭据存储 | safeStorage 加密后写入 `secrets.json`；系统加密不可用时仅内存持有 |
| 主机指纹 | 首次连接记录 SHA256 指纹；严格模式下指纹变化直接拒绝并给出处置指引；设置中可管理/删除记录（重刷固件场景） |
| 危险命令 | 命令级标记 + 全局关键词双保险，发送前强制二次确认 |
| 复制连接 | 刻意不复制凭据 |
| IPC 边界 | 通道白名单 + 统一错误包装，渲染层无任意 IPC 能力 |

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
| **P3-c** | 插件系统（JS 脚本扩展命令/诊断/报告模板）、**快捷键自定义**（已完成）、**命令面板底部/浮动位置**（底部已完成，floating 待办） | 🟡 部分完成 |

> P3-a 附注：新增通用能力 `window.api.exec.run(sessionId, cmd, timeout)`（任意面板可执行一次性命令）；连接编辑器状态上收到 `uiStore`，支持任意面板带预设呼出（设备发现 →「新建连接」即用此能力）。
| **已确认不做** | 安全与审计（除已实现的主机指纹/凭据加密/危险命令确认外不再扩展）、工单集成、VNC/RDP 入口、网络诊断工具 | ⏭️ 用户明确不需要 |
| **P3** | 固件升级助手、设备发现（mDNS/ARP）、工单集成、插件系统、VNC/RDP 入口、配置备份对比、快捷键自定义、命令面板底部/浮动位置 | 待开发 |

### 7.1 缺陷修复记录（重要）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 连接瞬间文件树报「无法获取远端目录：会话可能未连接或已断开」 | 竞态：会话记录在创建瞬间（握手未完成）即进入会话表，其中 client 是未连接的占位对象；文件树此时挂载 SFTP 会在该对象上直接失败，且失败后无重试 | 主进程：新增 `sessionManager.waitUntilReady()`（连接中挂起、就绪放行、失败/断开/超时拒绝），`sftpManager.getSftp()` 先等待就绪再挂载（并发挂载去重）；渲染层：文件树仅在会话 connected 后请求，失败提供「重试」按钮 |

## 8. 运行与打包

```bash
cd ssh-workbench
npm install          # 本机无 VS Build Tools，使用 --omit=optional 跳过 ssh2 可选原生加速（不影响功能）
npm run dev          # 开发模式（热更新）
npm run typecheck    # 主进程 + 渲染层类型检查
npm run smoke        # 冒烟自检：构建 + 启动 + 自动截图 smoke-shot.png + 退出
npm run build:win    # 打包 Windows 安装包（dist/）
```

数据目录：`%APPDATA%/ssh-workbench/data/`（设置面板内可直接查看路径）。

### 8.1 运行环境注意事项（本机实测记录，重要）

| 问题 | 现象 | 处理方式 |
|---|---|---|
| **安全软件按路径拦截** | `electron.exe` 从**桌面路径**启动时被静默终止（终端无任何输出），换到其他目录可正常运行 | 把项目放在非桌面目录（如 `D:ssh-workbench`），或将 `node_moduleselectrondist` 加入安全软件排除项 |
| 本机无 VS C++ 编译环境 | `npm install` 在 cpu-features（ssh2 可选原生加速）处卡死 | `npm install --omit=optional`（无功能影响） |
| 直连 GitHub 不可达 | electron 二进制安装失败 | 项目 `.npmrc` 已固化 `electron_mirror=https://npmmirror.com/mirrors/electron/` |

> 诊断备忘：主进程内置启动阶段日志（`[main] boot/app ready/seed commands done/ipc registered/window created`）与全局异常捕获，配合 `ELECTRON_ENABLE_LOGGING=1` 可快速区分「native 层问题」与「JS 层问题」。

## 9. 已知限制与技术债（P0）

- 代理（SOCKS5/HTTP，数据模型已预留 `proxy` 字段）未接线，当前支持直连 + ProxyJump 链；
- 命令面板位置仅「右侧」（设置项已留位）；
- 快捷键当前为固定组合（Ctrl+N 新建连接 / Ctrl+, 设置 / Ctrl+B 折叠面板 / Ctrl+Tab 切换标签 / Ctrl+Shift+W 关标签 / Ctrl+Shift+C/V 复制粘贴 / Ctrl+F 终端搜索），自定义功能在 P3；
- 会话日志持久化在 P1（当前仅内存回滚缓冲）；
- 大量输出（如 `cat` 大文件）时合帧窗口可考虑自适应放大（当前固定 8ms）。
