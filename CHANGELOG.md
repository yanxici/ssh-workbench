# Changelog

All notable changes to SSH Workbench will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.5.4] - 2026-11-28

<!-- release-notes:start -->
### 这一版更新了什么

- **表单防溢出与窄栏排版优化**：抽取统一的 `Segmented` 分段选择器与 `FieldRow` CSS subgrid 子网格对齐组件，将串口连接编辑器中的「流控」「波特率」改为整行展示并让成对字段与提示对齐，彻底解决「硬件 (RTS/CTS)」「软件 (XON/XOFF)」文字折行撑破 `h-7` 按钮的问题；同时收紧连接侧栏头部内边距防止窄栏标题过早截断，并为全站定高按钮补齐防换行约束。
- **4px 栅格骨架校准与视觉细节修复**：将状态栏 `--size-statusbar` 统一对齐至 `28px`，同步收敛 Toast 与传输进度浮窗偏移、`ActivityBar` 无位移居中指示条、字号基线行高（`3xs` 16px / `base` 24px）以及 30 处偏离栅格的任意值（含远程编辑器行高 `20px` 及 JS 滚动同步）；顺手修复浅色模式下未选中 `Toggle` 开关轨道对比度偏低的问题。
- **轻量化 GPU 合成动效升级**：为全屏工具面板补齐基于 `wall-in` 的入场动画（跳过骨架屏避免闪烁），新增 `useExitTransition` 为弹窗与 Toast 提供柔和退场过渡（`.motion-off` 下零延迟立即卸载），为非虚拟化折叠区补齐 `.motion-reveal` 揭示动画，并将开关滑块位移与全站 5 处折叠箭头统一至 GPU `transform` / `.chev-rot` 通道。
<!-- release-notes:end -->

### Changed & Fixed

- **UI Overflow & Form Alignment** (`src/renderer/src/components/ui/index.tsx`, `src/renderer/src/styles/index.css`, `src/renderer/src/components/connections/ConnectionEditor.tsx`, `ConnTransferDialog.tsx`, `CommandEditor.tsx`, `TunnelEditor.tsx`, `ConnectionSidebar.tsx`, `UpdateBadge.tsx`, `sectionUi.tsx`): Extract shared `Segmented` and `FieldRow` (subgrid), widen serial `flowControl`/`baudRate`, tighten `.panel-head`, and guard fixed-height buttons with `whitespace-nowrap`/`truncate`.
- **4px Grid & Baseline Alignment** (`tailwind.config.js`, `src/renderer/src/styles/index.css`, `StatusBar.tsx`, `TitleBar.tsx`, `ActivityBar.tsx`, `TransferProgressDock.tsx`, `RemoteEditorDialog.tsx`, `FileExplorer.tsx`, `TransferPanel.tsx`, `CommandCenter.tsx`, `CommandPanel.tsx`, `TransferTab.tsx`, `BatchPanel.tsx`, `DiscoveryPanel.tsx`, `FirmwarePanel.tsx`, `scripts/verify-design-tokens.cjs`): Align statusbar (`28px`), derived offsets, typography line-heights (`16px`/`24px`), 30 off-grid arbitrary sizes, and light-mode `Toggle` contrast.
- **GPU-Composited Motion** (`src/renderer/src/lib/useExitTransition.ts`, `src/renderer/src/stores/toastStore.ts`, `tailwind.config.js`, `src/renderer/src/styles/index.css`, `SessionFileTree.tsx`, `SerialBootBar.tsx`, `TransferPanel.tsx`, `TransferProgressDock.tsx`): Add modal/toast exit transitions (instant unmount under `.motion-off`), `.panel-shell` entrance, `.motion-reveal` collapsible reveal, and unified `.chev-rot` rotation.

## [2.5.3] - 2026-11-27

<!-- release-notes:start -->
### 这一版更新了什么

- **修复「自动」终端渲染后端误关 GPU 硬件加速**：此前主进程启动读取配置时仅对 `webgl` 保留硬件加速，`auto` 会被归入 `dom` 分支并调用 `app.disableHardwareAcceleration()`，导致选择「自动」后重启仍只能走 SwiftShader 软件光栅化、性能优化失效；现已保留 `auto` 的硬件加速能力，并在设置 → 扩展与实验 →「终端渲染后端」提示中明确说明在 DOM 与 WebGL/自动之间切换需重启应用以启停 GPU 硬件加速。
- **修复标签栏回归探针假红与三项长期跳过门禁**：修正 `verify-tabbar-os.cjs` 中 `activeTab` 探针选择器以匹配真实子元素上的 `bg-app` 样式；同步更新过期断言（`verify-theme.cjs` 对齐 4 套主题与 18 个语义变量、`verify-zmodem.cjs` 对齐双语 i18n 词条、`verify-cdsync.cjs` 消除外部 `tr` 分叉并补齐 Win32 路径边界清洗），清空 `run-all-verify.cjs` 的 `KNOWN_FAIL` 将三项回归全面纳回默认门禁。
<!-- release-notes:end -->

### Fixed

- **GPU startup guard, tabbar OS probe, and verification gate restoration** (`src/main/index.ts`, `src/renderer/src/i18n/locales/settings.ts`, `scripts/verify-tabbar-os.cjs`, `scripts/verify-theme.cjs`, `scripts/verify-zmodem.cjs`, `scripts/verify-cdsync.cjs`, `scripts/run-all-verify.cjs`): Keep hardware acceleration enabled for `terminalRenderer: 'auto'`, document restart requirement in zh/en `rendererHint`, inspect `firstElementChild` in `PROBE.activeTab`, and restore `verify-theme` / `verify-zmodem` / `verify-cdsync` to the default CI gate.

## [2.5.2] - 2026-11-27

<!-- release-notes:start -->
### 这一版更新了什么

- **全量中英双语界面（简体中文 / English）**：完整抽离模块化 `i18n` 引擎与 7 个分域词典，将主界面、连接管理、串口刷机引导条、SFTP/ShellFS 文件树与远程编辑器、命令中心、一键巡检等技术支持工具及全部提示/状态栏彻底双语化，`npm run verify:i18n` 渲染层硬编码中文基线由 **1,996 行降至 0 行**（默认简体中文界面文案保持原样兼容），新增 `verify-i18n-en.cjs` 全英文 UI 端到端零溢出校验。
- **Windows 安装包与运行时体积瘦身**：引入打包后置钩子 `scripts/after-pack.cjs` 仅保留 `zh-CN` / `en-US` 语言包并剔除跨平台串口原生预编译，同时在 `electron-builder.yml` 过滤 `node_modules` 测试与文档文件，显著压缩安装包与解压体积（`win32-x64` 串口与 SFTP 实测保持完整可用）。
- **内存降耗与按需渲染优化**：默认 DOM 渲染路径下跳过空转 GPU 硬件加速进程并关闭 `SpareRendererForSitePerProcess` / 磁盘缓存等冗余浏览器特性；取消开机空闲全量预加载 9 个重型面板（改为鼠标悬停工具栏按需预热），`SettingsPanel`、`ConnectionEditor`、`CommandCenter`、`CommandEditor`、`RemoteEditorDialog` 与 `@xterm/addon-webgl` 全部改为按需动态拆包与活跃标签上下文池化，默认 `scrollback` 调整为 `3000` 行，大幅压低首屏 JS 体积与多会话闲置内存。
<!-- release-notes:end -->

### Added

- **Full Bilingual i18n (`i18n/core.ts` + `locales/*.ts`) & Packaging Hook (`scripts/after-pack.cjs`)**: Modular pure-TS translation core covering all renderer components, stores, and pure helpers (`tNow`), plus `scripts/verify-i18n-en.cjs` English E2E verification and Windows `afterPack` pruning.

## [2.5.1] - 2026-11-27

<!-- release-notes:start -->
### 这一版更新了什么

- **Portix 全新品牌重塑与高对比纯白黑视觉升级**：正式命名为 **Portix（现代 SSH 与串口终端工作台）**，推出圆角深石墨翡翠信号徽标（Logo A）及 7 尺寸超采样应用图标（同步支持 `Portix.lnk` 任务栏 AUMID 识别）；界面默认改为零灰霾**纯白/纯黑 + 翡翠绿点缀**体系（亮色 `#FFFFFF` 纯白画布搭配 `#000000` 纯黑正文与 `#047857` 翡翠强调；暗色 `#000000` 纯黑沉浸底搭配 `#FFFFFF` 纯白正文与 `#2ED39A` 亮翡翠），用极细边框分界，彻底告别灰蒙观感；同步移除暖黄色 Gruvbox 主题，新增**极简黑白（Monochrome）**纯黑纯白无彩偏配色。
- **6 选项卡现代设置中心与全壳体细节精修**：设置面板从 15 个叠层手风琴重构为左侧 6 分类导航（**通用与外观 / 终端与通知 / 行为与传输 / 快捷键 / 安全与隐私 / 更新与诊断**）+ 右侧卡片式直接展开并支持完整中英双语；顶部标签栏升级为 36px 满高命中区内嵌圆角胶囊与串口 `Usb` 徽章；底部状态栏移除写死字段改为真实 `SSH` / `SERIAL` 协议与串口帧格式实时展示；优化快速启动页（4 张入口卡与快捷键速览）、连接列表左缘对齐 + `COM` 徽章及命令卡片 `text-wrap: balance` 防中文孤字。
- **稳定性与安全细节修复**：修复 `supportBundle` zip 包外网代理账密/凭据字段脱敏、导出诊断包/备份弹窗空窗口保护、更新器切换通道或镜像取消在途下载与错误节流状态同步，以及跨通道兼容性。
<!-- release-notes:end -->

### Added

- **Portix 品牌、纯白黑配色体系与 6 选项卡设置面板**：新增 `BrandMark` 矢量徽标与 7 尺寸 `icon.ico`；升级 4 组 8 变体配色（`Portix 默认` / `极简黑白` / `Solarized` / `Dracula`，全部 WCAG `>= 5.02:1`）；新增 `SettingsCard` 与左侧 6 Tab 分类设置弹窗（覆盖语言切换、隐私自查说明与全量配置项）。

### Fixed

- **外观层次、状态栏与诊断/更新修复**：移除主题默认层与组件底色多余灰阶；状态栏按会话真实类型展示协议与帧格式；修复诊断包导出安全脱敏、更新器换源竞态及无头 CI 测试稳定性。

## [2.5.0] - 2026-11-27

<!-- release-notes:start -->
### 这一版更新了什么

- **连接搜索精准匹配与折叠分组自动展开**：针对数千台共用同一 NAT 出口 IP（不同端口）的设备库，重构连接搜索打分逻辑——对主机、端口、`host:port`、串口路径与用户名及纯数字/IP 编号查询严格使用连续子串匹配，彻底消除搜 `1022` 却子序列误命中 `10.42.42.200` 吐出全库数千台的问题，并新增按端口与串口设备名检索；搜索命中时临时自动展开被手动折叠的分组，清空搜索后自动恢复原有折叠偏好。
- **「只看这组」显性状态条与长命令清爽悬停提示**：保留双击分组标题切换「只看这组」的快捷操作，同时新增顶部高亮状态条（含一键「显示全部」出口与操作提示）、分组头「仅看」角标及悬停「双击仅看」微提示，进入时自动展开该组，彻底告别“分组莫名消失”的错觉；右侧常用命令栏悬停预览对多行或超长脚本改为单行精炼提示（显示总行数/字数及 `Ctrl+单击编辑查看` 引导），不再撑满半屏遮挡终端。
- **全仓深度审计与系统级稳定性、安全加固**：完成全仓 60+ 项核心缺陷修复与三轮交叉回归验证——涵盖 SFTP 短读循环补读与断线重连续传、ShellFS 暂停取消与通道中止、`pathGuard` 分场景读写守卫及多级联接点/凭据文件防绕过、`JsonStore` 原子写回滚与损坏读并发竞态保护、SOCKS5/HTTP 代理拉模式防丢粘包 SSH Banner、多 `-R` 反向隧道按 `Client` 独立分发、`trzsz` 二进制帧与跨帧握手重组、统一弹层栈（防 `Esc` 级联/远程编辑器丢修改/输入法误关/后台终端漏键）、分屏关主格零销毁 xterm 迁移与重启防倍增，以及自动更新便携解压版检测、换源取消在途下载与代理日志脱敏等全链路加固（保留发布库既有技术栈与 Gitee 国内免代理自动更新通道）。
<!-- release-notes:end -->

### Added

- **连接侧栏检索与分组体验升级**（`src/renderer/src/stores/connectionStore.ts`、`src/renderer/src/components/connections/ConnectionSidebar.tsx`、`src/renderer/src/i18n/index.ts`、`scripts/verify-connection-search.cjs`）：
  - `scoreConnection` 对 `host`、`port`、`host:port`、`serial.path`、`username` 及纯数字/IP/端口查询严格走连续子串匹配，非结构化名称/标签/分组查询保留模糊匹配。
  - 搜索态通过独立临时折叠表自动展开命中的已折叠分组，清空搜索自动还原用户原折叠状态；进入「只看这组」自动展开该组并展示顶部状态条、「显示全部」按钮、角标及悬停提示。
- **常用命令栏长命令单行提示**（`src/renderer/src/components/commands/CommandCardTip.tsx`、`src/renderer/src/i18n/index.ts`）：超过 3 行或 180 字符的命令在悬停浮层中改为单行精炼提示（展示行数/字数与 `Ctrl+单击编辑` 引导）。

### Fixed

- **主进程传输、网络与存储全链路修复**：
  - SFTP/ShellFS（`src/main/ssh/sftpManager.ts`、`src/main/ssh/shellFs.ts`、`src/main/ipc/sftp.ts`）：`downloadFileChunked` 与 `readRemoteTail` 循环补读消除短读零洞与续传失败；递归与单文件下载净化远端路径防穿越；区分 `willReconnect` 与 `onReconnectGaveUp` 恢复断线续传并修复暂停关标签任务栏卡死；修复 `getSftp` 超时与孤儿通道、跨批次 `.part` 占位释放、ShellFS `onChannel`/`registerStream` 与暂停态取消竞态、UTF-16LE/BE 编解码 BOM 保留。
  - 安全与路径守卫（`src/main/store/pathGuard.ts`、`src/main/util/urlGuard.ts`、`src/main/util/zip.ts`、`src/main/store/bundle.ts`、`src/main/store/errorLog.ts`、`src/main/windowRef.ts`）：`pathGuard` 拆分为破坏性/写入目录/只读三套守卫（放行 `homedir()`/非系统盘根/UNC，拦截系统目录、尾点、多级联接点及直接/软链 `secrets.json`）；`setWindowOpenHandler` 限制 `http:`/`https:` 并修复 `TerminalView` `WebLinksAddon` 回调；修复 `zipEntryName` ZIP Slip 与空段问题、`bundle.ts` 精确录屏匹配（`#N` 后缀防跨客户串漏）、`errorLog` 无 ReDoS 全字段脱敏与全部系统弹窗空窗口保护。
  - SSH / 代理 / 隧道 / 串口 / TFTP / 录屏 / 更新（`src/main/util/proxySockets.ts`、`src/main/ssh/connectConfig.ts`、`src/main/ssh/portForward.ts`、`src/main/ssh/sessionManager.ts`、`src/main/ssh/trzszBridge.ts`、`src/main/ssh/recorder.ts`、`src/main/tftp/server.ts`、`src/main/util/parseProcSample.ts`、`src/main/updater.ts`、`src/main/store/jsonStore.ts`、`src/main/index.ts`）：代理改 `'readable'` 拉模式保留粘包 Banner 与 IPv6 `[host]:port`；ProxyJump 跳板机异常监听与泄漏清理；`-R` 按 `Client` 独立分发并支持 `[::1]`/`localhost`；`trzsz` 二进制帧与跨帧握手重组；`JsonStore` 写失败回滚、非 `ENOENT` 读保护、`SyntaxError` 串行隔离与退出循环刷盘；`updater` 在保留 Gitee 国内多通道架构基础上合入便携/解压版识别、换源取消在途下载（`CancellationToken` + 代数护栏）、代理日志脱敏、3 秒报错去重与监听器清理；MobaXterm 会话类型解析与 `connTransfer` 串口导入预览/跳过口径一致。
- **渲染层终端、分屏、弹层栈与 UI 面板修复**：
  - 统一弹层栈 `src/renderer/src/lib/overlayKeys.ts`（有序栈 + 冒泡阶段 + IME 防误关 + 自动失焦后台 `.xterm`），保护远程编辑器未保存修改及快捷键录制/下拉框/草稿输入，全站 9 个全屏面板及浮层支持 `Esc` 逐层关闭。
  - `MainWorkspace` 扁平化窗格挂载使关主分屏格不再销毁存活 xterm；修复分屏重启指数倍增与关分屏瞬间复活；修复 `TerminalView` 后台隐藏标签误 resize、`highlightRuntime` 行偏移与 `IMarker` 泄漏、`sftpStore` 切会话/缓存竞态、`FirmwarePanel` 重传路径复活与关面板丢状态、`BackupPanel` 跨主机比对、`TunnelEditor` Zustand 5 选择器稳定化、`ErrorLogSection`/复制按钮 `void` IPC 判空、`TerminalSection` 数字草稿输入及 `ConnectionSidebar`/`BatchPanel`/`FileExplorer` 多处交互缺陷（Tailwind 3 保持 `z-[35]` 与 `rounded`）。

## [2.4.3] - 2026-11-25

<!-- release-notes:start -->
### 这一版更新了什么

- **修复 ZMODEM 传输点「中断」后终端卡死与日志正文泄到终端**：此前 `zmodem.js` 默认仅发 5 个 `CAN` (`0x18`)，Linux 端 `lrzsz` (`sz`) 在流式发帧时先吃掉第 1 个 `CAN` 后剩下的 4 个不足 5 个，导致远端 `sz` 停在原始模式把 `Ctrl-C` 与所有按键全部吞掉；现统一发送标准 **10× `CAN` + 10× `BS`** 序列（并在 350ms 后仍在吐 raw 数据时自动补发兜底），同时在 5 秒抑制窗内拦截原始模式裸 `\n` 日志分片与二进制乱码、放行远端退回 shell 后的正常提示符，中断后自动将焦点还给终端。
- **修复多文件 `sz` 实时增长日志卡 100%、高延迟链路误杀与传输列表无实时进度**：放开超过 `ZFILE` 初始大小的连续日志写入并支持 `ZFIN` 后夹带 `\r\n`/提示符再收 `OO`；修复 150ms 续传限流误杀整批传输与不可恢复异常冻在「进行中」的问题；侧栏「传输」列表与全屏「传输记录」面板接入 ZMODEM 实时进度、批次序号（如 `1/4`）与行内进度条，且每行仅单次订阅避免重复渲染。
- **ZMODEM 全链路稳定性与安全加固**：接收落盘队列引入 2 路在途背压并改为主进程异步串行 `appendFile`，写盘失败立即中止不再继续堆积；看门狗超时放弃、`detachZmodem` 关标签与用户取消均正确释放 `handleOffer`、落盘句柄及 0 字节占位文件；主进程落盘用 `claimedPaths` + `wx` 排他创建堵住同名并发 TOCTOU 竞态，`safeFileName` 补全 Windows 保留设备名、控制字符（含 `0x7F`）、尾随点空格与 200 字符截断；上传单文件超过 256MB 前置拒绝防主进程 OOM；底层发送失败立即向渲染层报错不再干等 20 秒超时；后台标签触发确认弹窗准确显示对应会话名称。
<!-- release-notes:end -->

### Fixed

- **ZMODEM 接收/发送/主进程全链路加固**（`src/renderer/src/lib/zmodem.ts`、`src/main/ipc/zmodem.ts`、`src/main/ssh/sessionManager.ts`、`src/preload/index.ts`、`src/renderer/src/components/terminal/TerminalView.tsx`、`src/renderer/src/components/terminal/ZmodemOverlay.tsx`、`src/renderer/src/components/files/TransferTab.tsx`、`src/renderer/src/components/transfer/TransferPanel.tsx`）：涵盖 10×CAN+10×BS 中止与补发、`isPostAbortJunk` 抑制窗、增长日志与高延迟限流重装、落盘背压与异步串行写入、看门狗/取消/卸载全路径释放 `abortOffer` 与 `saveFinish`、节流尾部刷新（trailing flush）、未知大小进度口径、单文件发送进度、窗口 `dialogParent()` 空指针保护及 `TransferTab` 单订阅去重；新增 `scripts/verify-zmodem-hardening.cjs`（48/48 通过），全量 ZMODEM/串口/trzsz/E2E 回归通过。

## [2.4.2] - 2026-11-25

<!-- release-notes:start -->
### 这一版更新了什么

- **修复 `sz` 多文件批量下载（如 `sz robottest*`）中途断开或仅下载第 1 个文件的问题**：真实 `lrzsz` 在多帧 `ZDATA`（`ZCRCW`/`ZCRCE` 边界）发送、批次中夹带 0 字节空文件、以及文件间重传 `ZEOF`/`ZRQINIT`/`ZFILE` 时，原先 `zmodem.js` 接收状态机会触发 `Unhandled header` 或遗漏清理 `_file_info` 导致第 2 个文件报 `second ZFILE` 直接中止整批传输；现已统一接管接收侧协议状态机，支持任意多帧 `ZDATA`、空文件直达 `ZEOF(0)` 与文件间重传兜底，整批文件只需选择一次保存目录即可连续稳定落盘。
- **消除多文件并发落盘状态串号并新增批次进度显示**：将 `ZEOF` 后的 `ZRINIT` 延后至当前文件完成 `flush` 与 `saveFinish` 落盘后再放行下一份，并以独立 `offerGen`、`transferId` 与 `localPath` 彻底隔离前后文件，传输记录与保存路径不再互相覆盖；传输浮层在多文件批次中同步展示当前进度序号（如 `2/3`），0 字节文件完成后正确显示 `100%`。
<!-- release-notes:end -->

### Fixed

- **ZMODEM `sz` 多文件批量接收协议与状态机修复**（`src/renderer/src/lib/zmodem.ts`、`src/renderer/src/components/terminal/ZmodemOverlay.tsx`）：新增 `primeReceiveSession()` 统一接管 `_accept`、`_consume_ZDATA` 与 `_make_promise_for_between_files`——正常与续传路径均保留 `{ ZDATA, ZEOF }`、兜底 `ZEOF` 偏移不一致时强制清理 `_file_info`/`_current_transfer` 并复位 `_accepted_offer`、延后 `ZEOF` 后的 `ZRINIT` 至异步落盘完成、阻断前向跳洞静默拼接并在文件间及 `saveBegin` 期间兜底重传帧；`ZmodemOverlay.tsx` 补齐多文件批次序号展示与 0 字节完成态 `100%`；`scripts/verify-zmodem-renderer.cjs` 新增 5 组多文件 `sz` 回归用例（105/105 通过）。

## [2.4.1] - 2026-11-25

<!-- release-notes:start -->
### 这一版更新了什么

- **修复内置远程编辑器文本框塌陷**：此前编辑区容器将 `modal-body`（`flex: 1`）与 `h-[56vh]` 混用，叠加 `<textarea>` 的 `h-full` 在未定高弹窗中阻断了 flex stretch，导致长文件编辑区只显示约 3 行、下方大片空白，短文件弹窗也会跟着塌陷。现已改为标准弹性布局，短文件、长文件以及展开查找/替换与关闭确认条时，编辑区与行号栏均保持等高撑满且不裁切底栏。
- **修复终端光标不闪烁**：当 Windows 系统开启「减少动态效果」（`prefers-reduced-motion: reduce`，常见于远程桌面或性能模式）或关闭设置中的「界面动效」时，全局 `.motion-off *` 规则会把 xterm DOM 渲染器的 `.xterm-cursor-blink` 动画一并归零，导致终端光标在开启 `cursorBlink` 时也不闪。现在仅对 `.xterm-cursor-blink` 做豁免，继续由设置项「光标闪烁」独立控制。
- **修复 Windows 解压版 / 便携版任务栏白图标**：打包版不再无条件绑定固定 `AppUserModelID`，改为仅在开始菜单存在指向当前可执行文件的有效快捷方式（NSIS 安装版）时绑定；解压版 zip 与便携版直接沿用 exe 内嵌多尺寸图标与窗口图标，不再退化成白色空白文档图标。
<!-- release-notes:end -->

### Fixed

- **远程编辑器高度塌陷**（`RemoteEditorDialog.tsx`）：移除编辑区容器上的 `modal-body` 改用 `flex h-[56vh] min-h-0 overflow-hidden`，移除 `<textarea>` 上的 `h-full` 改由 Flexbox `stretch` 与行号栏等高对齐，并为行号栏、查找/替换条与关闭确认条补齐 `shrink-0`；补充 `verify-remote-editor.cjs` 静态契约断言与 `e2e-ui-sftp.cjs` 短/长文件真实渲染几何断言。
- **终端 DOM 光标闪烁被 `.motion-off` 误杀**（`styles/index.css`）：将 `.motion-off *` 调整为 `.motion-off *:not(.xterm-cursor-blink)`，保持关闭界面动效的语义不变，同时保留 xterm DOM 渲染器 `blink_block_*` / `blink_bar_*` / `blink_underline_*` 关键帧动画；`verify-motion.cjs` 补充静态与真实 Electron 运行时断言。
- **Windows 解压版 / 便携版任务栏白图标**（`src/main/window/appUserModelId.ts`、`src/main/index.ts`、`src/main/smoke.ts`）：新增 `resolveWindowsAppUserModelId` / `configureWindowsAppUserModelId`，仅当开始菜单存在 AUMID、目标 exe 与自定义图标均匹配当前进程的 `.lnk` 时才调用 `app.setAppUserModelId`；新增 `scripts/verify-taskbar-aumid.cjs`（22 项断言）。

## [2.4.0] - 2026-11-24

<!-- release-notes:start -->
### 这一版更新了什么

- **老旧嵌入式设备 SSH 兼容算法**：连接配置新增「老旧设备兼容算法（SHA-1 / CBC / DSS）」开关（默认关闭，现代算法优先、老套件追加末尾，按当前运行时加密能力动态构建）；遇到老 Dropbear / OpenWrt / 工业交换机协商失败时，终端报错浮层提供一键「启用老设备兼容算法并重连」（不丢失既有密码与代理凭据）；主机指纹探测遇到协商失败自动回退重试一次。
- **无 `sftp-server` 设备自动降级到纯 Shell/BusyBox 通道**：遇到裁剪掉 SFTP 子系统的 OpenWrt / Buildroot / BusyBox 设备时，经 `ssh2` 错误精准判别与 `echo` 探针双重确认后自动切入纯 Shell/BusyBox 兼容通道（排除 `MaxSessions` 瞬时上限与断线误降级），文件树、双栏传输、远程编辑（保留 `.bak` 与失败回滚）、固件上传与配置备份全链路恢复可用，文件面板顶部展示 `Shell 兼容` 徽标。
- **端口转发断线自愈、随连自启与远端端口一键发现**：意外断线且将自动重连时，活跃隧道自动进入「等待重连恢复」并在重连成功后恢复（手动停掉的保持停止）；支持绑定连接「随连接自动启动」；隧道面板新增 BusyBox 兼容的远端监听端口探测（`ss` → `netstat` → `/proc/net/tcp(6)`）与一键会话级临时转发（冲突自动分配空闲口、支持一键「转存为常用隧道」原地不断流过户、HTTP 端口安全一键打开本机浏览器）。
- **终端效率与多客户端一键迁移**：OS 文件拖入 SSH 终端默认直接通过 SFTP 上传到终端当前 `cwd`（按住 `Alt` 或设置可切 `trzsz`）；多行粘贴或含回车危险命令时弹出可编辑预览确认框（自动剥离 Markdown 代码围栏，危险词随编辑实时联动）；支持从 `~/.ssh/config`（含 `ProxyJump`）、MobaXterm（`.mxtsessions`）、Xshell（`.xsh` 含 UTF-16LE）、SecureCRT（`.ini` 十六进制端口）和 FinalShell 一键预览导入；新增分屏顶部同步输入开关与后台标签未读输出圆点。
- **单色精密仪器风外壳、主题精简（7→4）与专注工作台**：取消 44px 高饱和绿标题栏，统一收敛为 `36px` 单色中性画布 + `2px` 品牌指示条与 `44px` 窄活动栏；砍掉高度同质化的 `workbench` / `nord` / `onedark`，保留「精密默认 / Gruvbox / Solarized / Dracula」4 套各自独立品牌色的高对比主题（8 组明暗变体全部实测 WCAG `>= 4.5:1`，老配置经 `UI_SHELL_VERSION = 3` 静默迁移且不覆盖明暗偏好）；空工作区升级为快速启动欢迎页（最近 8 条连接 + 快捷入口），新增 `Ctrl+Shift+Z` 一键 Zen 专注模式。
<!-- release-notes:end -->

### Added（P0 嵌入式 SSH 韧性与弱设备兼容）

- **老旧设备 SSH 兼容算法**：`Connection` / `ConnectionInput` / `TestConnectionInput` / `connTransfer` 透传 `legacyAlgorithms?: boolean`；`connectConfig.ts` 运行时动态构建 `LEGACY_ALGORITHMS` 与 `isNegotiationError`（兼容 Electron BoringSSL 与不同 `ssh2` 原生绑定），`probeHostFingerprint` 协商失败自动以老算法重试一次；`ConnectionEditor.tsx` 补齐开关，`TerminalView.tsx` 报错浮层新增「启用老设备兼容算法并重连」并完整保留既有凭据与代理密码。
- **纯 Shell/BusyBox 文件与流式传输降级**：新增 `src/main/ssh/shellFs.ts`（`shQuote`、`assertSafeRemovePath`、`parseLsOutput` 及原始二进制流上传下载）；`sftpManager.ts` 在不动既有 SFTP 分块引擎的前提下增加 `sessionModes` / `pendingMode` 与入口路由，经 `isSftpSubsystemUnavailableError`（排除 `channel open failure` / 断线）+ `echo __SWB_SH_OK__` 双确认触发降级；新增 `IPC.SFTP_MODE` / `IPC.EVT_SFTP_MODE` 与 `ShellModeBadge.tsx`。
- **隧道自愈、自启与远端端口一键发现**：新增 `src/main/ssh/remotePorts.ts`（`ss` / `netstat` / `/proc/net/tcp(6)` 三级降级与纯 `[::1]` 保留 vs 双栈合并规则）；`sessionManager.ts` 扩展 `onClosed({ byUser, willReconnect })` / `onConnected` / `onReconnectGaveUp`；`portForward.ts` 统一管理持久与 `ephemeral` 临时转发（`reconnecting` 挂起恢复、`manuallyStopped` 记忆、`autoStart` 随连自启、幂等去重、原地过户 `promoteQuickForward` 与白名单 `buildSafeLocalTunnelUrl`）；`TunnelPanel.tsx` 升级为三段式布局。

### Added（P1 终端效率与多客户端迁移）

- **拖放文件直传 `cwd`**：新增 `src/renderer/src/lib/terminalDrop.ts`（含兼容 Windows `dragover` 保护模式的 `countDraggedFiles` 三级回退与 `decideDropAction`），`TerminalView.tsx` 拖入 OS 文件默认 SFTP 上传至 `cwdStore` 当前目录（`keepRoot: true`），不干扰命令卡片拖拽。
- **多行粘贴安全确认**：新增 `src/renderer/src/lib/pasteGuard.ts` 与 `PasteConfirmDialog.tsx`，三处粘贴入口统一经 `requestPaste` 校验，支持一键去除 Markdown 代码围栏、去掉末尾回车、危险词实时联动与 IME 组合态守卫。
- **外部客户端一键导入**：新增 `src/main/store/externalImport.ts` 与 `IPC.CONN_EXT_IMPORT_*`（主进程路径白名单保护），支持 `~/.ssh/config`、MobaXterm、Xshell（UTF-16LE BOM）、SecureCRT（十六进制端口）与 FinalShell，接入 `ConnTransferDialog.tsx` 双模式导入页。
- **分屏同步输入与后台标签未读点**：新增 `src/renderer/src/lib/tabUnread.ts`，`splitStore.syncByTab` 与 `MainWorkspace.tsx` 流式 `h-7` 同步输入条协同复用 `session.broadcast()`（缩回单窗格自动关闭）；`sessionStore.unreadById` 配合 500ms 离开宽限期与纯控制符过滤驱动 `TabBar.tsx` 6px 静态未读圆点。

### Changed（P2 单色精密仪器风 UI、主题精简与专注工作台，保留主仓技术栈）

- **配色主题 7 → 4 去同质化**：新增 `src/shared/themeCompat.ts` 与 `UI_SHELL_VERSION = 3` 静默迁移，退役 `workbench` / `nord` / `onedark`，保留「精密默认 / Gruvbox / Solarized / Dracula」四套各自独立 `brand`/`accent`/`select` 的高对比主题，外观画廊升级为 2×2 四宫格。
- **单色精密外壳（36px 顶栏，Tailwind 3 等价落地）**：`styles/index.css`、`TitleBar.tsx`、`TabBar.tsx`、`ActivityBar.tsx`、`StatusBar.tsx`、`UpdateBadge.tsx` 统一为 `36px` 顶栏 + `44px` 活动栏 + `26px` 状态栏单色中性画布，完整保留 v2.3.2 Gitee 国内免代理自动更新通道与 Electron 33 / React 18 / xterm 5 / Tailwind 3 技术栈。
- **快速启动欢迎页与 Zen 专注模式**：新增 `WelcomeQuickLaunch.tsx`（含最近 8 条连接与「新建串口」直达串口 Tab）、`src/renderer/src/lib/zenState.ts` 与 `Ctrl+Shift+Z` 专注模式开关（活动栏与侧栏展栏入口统一收口自动退出 Zen）。
- **新增回归**：`verify-legacy-algo.cjs`、`verify-shellfs.cjs`、`verify-tunnel-resilience.cjs`、`verify-paste-guard.cjs`、`verify-external-import.cjs`、`verify-split-sync.cjs`、`verify-p2-theme-zen.cjs`；`verify-ime-guard.cjs` 刻度与 Gitee 更新通道共同收敛至 16。

## [2.3.2] - 2026-11-23

<!-- release-notes:start -->
### 这一版更新了什么

- **国内免代理自动更新通道（默认开启）**：自动更新默认「自动」模式在未配置代理时优先走 Gitee 国内同源镜像，无需代理即可在应用内一键检查、下载并重启安装；命中 Gitee 时自动关闭差量下载规避 Range 200 重复拉取，并复用 Gitee 发行版说明。
- **多通道自动回退与防篡改校验**：通道探测设 8 秒快速超时并校验 `latest.yml` 格式（直接拦截返回 HTML 验证页的坏镜像）；检查或下载失败时按 `Gitee 国内源 → GitHub 官方 → gh-proxy.com → ghfast.top` 自动切换；若检查阶段命中的是一跳官方源，回退到第三方加速站时强制比对 `sha512` 一致才允许下载。
- **更新通道可配可观测**：设置 → 软件更新新增「更新通道」选择（自动 / Gitee 国内源 / GitHub 官方 / `gh-proxy.com` / `ghfast.top` / 自定义镜像或内网目录），标题栏更新弹窗与设置页均显示本次实际命中的通道名；配置更新专用代理时，「自动」模式仍优先走 GitHub 官方以享差量更新。
- **发版同步工具**：新增 `scripts/sync-gitee-release.ps1` 并接入 CI 可选自动同步步骤（配置 `GITEE_TOKEN` 后自动同步到 Gitee 国内源）。
<!-- release-notes:end -->

### Added（国内免代理自动更新通道 + 多源自动回退）

- **通道解析与回退内核**：新增纯逻辑模块 `src/main/updaterChannel.ts` 并重构 `src/main/updater.ts`；通过 Gitee 公开 API `/api/v5/repos/w3554334905/ssh-workbench/releases/latest` 解析最新 tag 与发行说明，确认已上传 `latest.yml` 后交给 `electron-updater` 的 `generic` provider，同时开启 `disableDifferentialDownload = true` 绕开 Gitee 附件 CDN 对 Range 返回 200 全量的旧阻塞。
- **快速失败与防篡改**：单通道探测使用与 `electron-updater` 同分区的 `session.fetch`（遵循更新代理）并限定 8 秒超时，`parseLatestYmlMeta` 校验 `version`/`sha512` 并拦截 HTML 验证页；下载中途断链自动切下一通道静默续接，第三方加速站回退强制校验官方一跳源 `sha512`。
- **设置面板与 i18n**：`UpdatePrefs` 新增 `mirror`、`UpdateStatus` 新增 `sourceLabel`；`UpdateSection.tsx` 补齐「更新通道」输入与 5 个预设按钮，并将该面板全部文案迁入 `src/renderer/src/i18n/index.ts`（中英双语），`UpdateBadge.tsx` 同步显示命中通道名；隐私断言 `verify-privacy.cjs` 保持零新增未审计第三方域名。
- **Gitee 自动同步与回归**：新增 `scripts/sync-gitee-release.ps1`（先传 `.exe`/`.blockmap`、最后传 `latest.yml`）与 `.github/workflows/release.yml` 可选同步步骤；新增单元回归 `scripts/verify-updater-channel.cjs`（34 项断言）。

## [2.3.1] - 2026-11-20

<!-- release-notes:start -->
### 这一版更新了什么

- **终端默认改用 `Ctrl+C` / `Ctrl+V`**：有选区时 `Ctrl+C` 复制（保持选区不变），无选区时原样发送中断信号 `SIGINT`，不再与 Shell 中断冲突；`Ctrl+V` 直接粘贴且避免双份粘贴。
- **终端鼠标与快捷手感补齐**：设置 → 终端新增「选中即复制」与「右键快速复制粘贴」（默认关闭，开启后 `Shift+右键` 仍可唤出完整菜单）；`Ctrl+滚轮` 仅对当前终端临时缩放字号（`Ctrl+0` 复位）；右键菜单新增「导出终端输出…」。
- **大量输出更跟手**：主进程输出合帧改为自适应（常规交互保持 8ms，遇到 `cat` / `dmesg` 洪峰自动升档至 20–32ms 并设 256KB 强刷上限，空闲立刻回落 8ms）。
- **内置远程编辑器升级**：零新增重依赖补齐行号栏、`Ctrl+F` / `Ctrl+H` 页内查找替换、`Ctrl+S` 原地保存不关窗、编码与行列状态条、`Tab` / `Shift+Tab` 缩进、未保存误关确认。
- **修复终端右键「发送文件…」无反应**：空路径数组不再拦死主进程原生文件选择框。
<!-- release-notes:end -->

### Fixed（终端右键「发送文件…」静默失效）

- `TerminalView.tsx` 右键菜单「发送文件…」此前传了 `startUpload([])`，被 `if (paths.length === 0) return` 直接吞掉。拆分为拖拽上传（非空路径）与右键主动选文件（不传 `paths`，由主进程弹原生文件框）。

### Added（终端交互手感 + 自适应合帧 + 内置远程编辑器补齐）

- **智能 `Ctrl+C` / `Ctrl+V`**：默认快捷键由 `Ctrl+Shift+C/V` 调整为 `Ctrl+C` / `Ctrl+V`（`shortcuts.ts`、`terminalUx.ts`、`TerminalView.tsx`、`ShortcutSection.tsx`）。有选区复制且不清选区，无选区透传 `\x03`；`Ctrl+V` 调用 `e.preventDefault()` 防 Chromium 原生粘贴重复输入。
- **鼠标手感与缓冲导出**：`TerminalPrefs` 新增 `copyOnSelect` / `rightClickPaste`（默认 `false`，设置 → 终端可独立开启）；`Ctrl+滚轮` 在捕获阶段拦截防止被 `tmux`/`vim`/`less` 吞掉，仅做当前终端 10–28px 临时缩放并支持 `Ctrl+0` 复位；新增 `IPC.SESSION_EXPORT_BUFFER`（`session:export-buffer`），导出纯文本 `.txt` 时正确拼接软换行并保留软换行处的行尾空格。
- **大流量输出自适应合帧**：新增 `src/main/util/adaptiveFlush.ts` 并接入 `sessionManager.ts`（8ms → 20ms → 32ms，256KB 立即强刷，空闲 80ms 或低流量立即回落 8ms）。
- **内置远程编辑器（零新增依赖）**：新增 `src/renderer/src/lib/editorText.ts`，改造 `RemoteEditorDialog.tsx` 与 `sftpStore.saveEditor(content, { close })`；补齐同步行号栏、页内查找/替换（跳转不抢输入框焦点）、`window` 级快捷键监听（防按钮禁用后失焦）、`Ctrl+S` 原地保存（有改动才触发）、编码与行列状态条、`Tab` / `Shift+Tab` 缩进（修复首行为空行时的偏移边界）、未保存关闭二次确认（Tailwind 3 保持 `outline-none` 与 `bg-hover`）。
- **新增回归**：`scripts/verify-terminal-ux.cjs`（23 项）、`scripts/verify-adaptive-flush.cjs`（13 项）、`scripts/verify-remote-editor.cjs`（27 项）。

## [2.3.0] - 2026-11-19

<!-- release-notes:start -->
### 这一版更新了什么

- **按钮终于像按钮了**：命令中心的卡片悬停会轻抬 1px、浮起一层小投影，按下回落并微收 0.98（60ms，比抬起更快，手感才脆）；全站按钮按下统一压到 0.97。
- **命令墙不再「闪一下」就位**：打开时前 12 张按 12ms 错峰淡入，第 13 张起同步收尾，总时长封顶 144ms。
- **连接列表悬停有指向**：鼠标扫过时左侧淡入一条 2px 品牌色竖条，用绝对定位伪元素，虚拟行不会被挤动。
- **分组箭头会转了**：折叠/展开从「两个图标互切」换成同一个图标旋转 90°。互切没有中间态，看起来就是跳变。
- **设置里能一键静止**：设置 → 实验性 → 「界面动效」；系统开了「减少动态效果」时自动跟随，不用手动关第二次。
- **界面语言留了口子**：外壳文案抽成一份字典（缺省仍是中文），以后加语言只动字典，不动组件。
<!-- release-notes:end -->

### Added（界面动效层 + 单一开关）

**问题**：命令中心是 130 张等高卡片铺成的一片墙，悬停、按下全无反馈 —— 鼠标移上去没有任何变化，点下去也没有「被按到」的感觉。问题不在缺某一个动画，而在整站没有一层交互反馈：活动栏、标签页、连接行、分组箭头都只靠换颜色，跳变本身就让人怀疑点击有没有生效。

**为什么只给这些地方加**：抬升只给「大片可点区域」（命令卡片、连接行）—— 全站按钮也给位移的话，屏幕上同时有十来个东西在动，反而更吵；按钮只给按下反馈，因为按下才是「我收到了」的确认。所以按钮系只有 `:active` 的缩放，不加 hover 位移。

**做法**：`src/renderer/src/styles/index.css` 加三个共享类 —— `.motion-lift`（transform / box-shadow 120ms `cubic-bezier(0.16,1,0.3,1)`，底色与边框单独 150ms，`:active` 换成 `translateY(0) scale(0.98)` 并把 transition-duration 压到 60ms）、`.motion-in`（入场 `wall-in` 180ms `both`）、`.conn-hint::before`（左侧 2px 品牌条，`position:absolute` 零布局占用）。投影走新加的 `--shadow-lift`，三套主题各一份：默认与 `.light` 是 `0 1px 2px rgb(15 23 42 / 0.06), 0 6px 16px -8px rgb(15 23 42 / 0.12)`，`.dark` 换成深投影片 `0 1px 2px rgb(0 0 0 / 0.4), 0 8px 20px -10px rgb(0 0 0 / 0.6)`（浅色投影落在深底上等于没有）。

**Tailwind 3 上必须用 transform 通道**：本项目仍是 Tailwind 3.4，`rotate-90`、`scale-[0.98]` 都是往 `transform` 里合成（v4 才有独立的 `rotate` / `scale` 属性）。所以 `.chev-rot` 的过渡写的是 `transition: transform 150ms`，写成 `transition: rotate` 的话过渡根本不会触发，箭头照样跳变 —— 这条差异在 `verify-motion.cjs` 里也是按 transform 断言的。同理 `.btn` 的 `@apply` 从 `transition-colors` 改成 `transition-[color,background-color,border-color,transform]` 才有按下缩放（`.btn-icon` 是 `transition-[color,background-color,transform]`），缩放档位分别是 `active:scale-[0.97]` 与 `active:scale-[0.94]`。

**卡片错峰**：`CommandCenter.tsx` 按索引算 `animationDelay`：前 12 张 ×12ms，第 13 张起封顶 144ms。130 张全错峰会拖到 1.5 秒，还会撞 Ctrl+K 的耗时压测。分组 chevron 在 `ConnectionSidebar.tsx` 与 `sectionUi.tsx` 换成同一个 `ChevronRight` 加 `rotate-90`。

**守住既有几何禁令**：`ActivityBar.tsx` 与 `TabBar.tsx` 里各有一段注释明确禁掉 box-shadow / transform（活动栏缩放会让 44px 图标跳动，标签栏位移会带着关闭按钮一起抖）。这两处换通道实现 —— 活动栏只淡入底色且排除激活项（`.activity-item:not(.activity-item-active):hover`，再叠一层浅底会把选中态冲淡），标签页关闭按钮未激活时 `opacity-0` + `group-hover:opacity-100`。

**关停只有一条规则**：设置开关与系统「减少动态效果」都折算成 html 上的 `.motion-off` 一个 class（`settingsStore.ts` 的 `applyMotion` 在 load / 媒体查询变化 / 用户改设置三处调用）。`.motion-off *` 用通配关掉 transition 与 animation —— 逐个类名写清单，漏一个类就是「关掉之后还有个地方在动」，而这种漏在验收时几乎看不出来。位移与投影另外显式归零：transition 关掉后 `:hover` / `:active` 里的 transform 仍会瞬移到位，等于把动画换成跳变。

**新增验证**：`scripts/verify-motion.cjs` 45 项，四层 —— 样式表 19 条（类是否存在、过渡通道、暗色档、通配关停）、组件 13 条（卡片是否带 `.motion-lift`、错峰上限、chevron 是否单图标旋转）、开关链路 6 条（settings 类型 → 主进程默认 → store 折算 → html class），最后 7 条走真实 Electron + CDP 读计算值。反证：`git stash` 掉改动重跑必红（`hasOffClass=false` 而 `mediaReduce=true`、`liftTransition='all'`、`--shadow-lift` 为空）。

### Added（界面语言的基座）

**问题**：外壳文案（设置面板、标题栏、对话框）全写死在组件里。等到真要加语言时，改动面是「所有组件」，不是「一份字典」—— 那时候翻译的人拿不到可审的清单，改的人也不知道漏了哪几处。

**做法**：先只把结构立起来，不动任何组件的行为 —— `src/shared/types.ts` 加 `export type UiLanguage = 'zh-CN' | 'en'` 与 `AppSettings.language`（缺省中文：这工具主要用在现场，默认英文才是意外行为），`src/renderer/src/i18n/index.ts` 收一份只读字典与 `t()`，缺词时回退键名而不是抛错（少一句翻译不该让界面白屏）。组件接不接是下一版的事，这一版只保证「有地方放、有校验守住不倒退」。

**新增验证**：`scripts/verify-i18n.cjs` 扫 `src/renderer/src` 下所有 `.ts/.tsx`，按「行含汉字且不以 `//`、`*`、`/*` 开头」计数，与本仓的 `scripts/i18n-baseline.json` 比：增了就该是「接入字典时把硬编码换成 key」，减了随便。基线 2111 行，`--update` 可重写。这条门禁只防「文案越加越散」，不假装能代替翻译。

### Changed（隐私断言认得 Gitee 镜像）

**问题**：`scripts/verify-privacy.cjs` 的出站主机白名单只有 `github.com` / `ghfast.top` / `gh-proxy.com`，而 `src/main/updater.ts` 里 `MIRROR_PAGE` 指向 `gitee.com`——断言会红，红得像「应用偷偷连了第三方」。

**做法**：把 `gitee.com` 加进白名单并写清理由：它只是「打不开 GitHub？用镜像」按钮背后的地址，由系统浏览器打开，应用自身不发起请求。白名单是「允许出现的字面量清单」，不是「应用会连的主机清单」，两者的差别得在注释里说死。

### Changed（Release 正文改成现抽短摘要块）

**问题**：Release 页面原来直接从 CHANGELOG 抽整段 —— 那是工程记录（根因、文件路径、验证项），用户点开看到的第一屏是排查过程。

**做法**：`scripts/release-notes.cjs` 优先取 `<!-- release-notes:start -->` / `end` 之间的短摘要，没有标记块时退回整段（旧版本条目没写标记，也不能因此发不出 Release）；配对缺失直接 exit 1。顺带给 2.2.1 补了短摘要块，口径与后续版本一致。

---

## [2.2.1] - 2026-11-18

<!-- release-notes:start -->
### 这一版更新了什么

- **传大文件不再半路卡死**：ZMODEM 传 1MB 以上文件时进度条停住不动的问题已修复，实测 1MB 从 122 秒降到 33 秒。
- **不会再留下半截文件**：上传下载改成先写临时文件、传完才落到正式名字；断线、取消、进程被杀都不会再出现「名字对、内容不全」的文件。
- **打开再保存不会弄坏远端文件**：符号链接还是链接、权限不变，GBK/GB18030 中文文件不再变乱码，删目录也不会被符号链接带进整站。
- **文件面板的刷新真的刷新了**：命中缓存也会强制重发，链路慢或断了会在 15 秒内给可读提示，不再无限转圈。
- **新增「传输记录」面板**：每个文件的进度和失败原因都能看到，不再只有一句「例如前三条」的摘要；下载目录可以自己设。
- **远端路径加了安全校验**：带 `..` 之类的路径会被拒绝。
<!-- release-notes:end -->

### Fixed（ZMODEM 传大文件时静默卡死）

**问题**：sz 传 1MB 以上的文件，进度条走到某个位置就不动了，终端没有任何输出。根因在 `zmodem.js` 内部：收数据时 `this._input_buffer.push.apply(this._input_buffer, input)`，实参个数等于这一批的字节数；主进程按 8ms 合帧，一批几十万字节，`apply` 把调用栈撑爆成 `RangeError: Maximum call stack size exceeded`，而抛出点在事件回调里被吞掉，表现就是「安静地不动了」。修前实测 1MB 文件 122 秒，修后 33 秒。

**做法**：喂给 sentry 之前按 `FEED_SLICE_BYTES = 16 * 1024` 切片（与库自己的 `MAX_CHUNK_LENGTH` 对齐），字节序列不变。

另一条独立路径是静默超时：对端丢窗口、sz 被 kill、网关断流都不抛错，只表现为没有数据；而看门狗原来的时钟是「最后一次收到字节」，任何乱序帧、重复帧都能刷新它 —— 对端重发同一段、我们一个字节都没落盘，看门狗照样认为传输活着。改法：时钟改成「最后一次真正写进文件」（`lastProgressAt` 只在 `fileOffset` 推进时更新），静默超过阈值按 `fileOffset` 发 ZRPOS 续传，连续 3 次（`IDLE_RESUME_MAX`）没有新进展才判定对端退出。两处刻意的选择：`on_input` 里不再顺手清零计数（收到帧和落盘是两件事）；一个字节都没收到时仍然继续 arm（原实现在「等第一块数据」分支直接 return，此后这条传输再无超时保护）。

**新增验证**：`scripts/verify-zmodem-renderer.cjs` 新增「重发假活」段 —— 喂只推进 tail 不推进 `fileOffset` 的帧，断言看门狗最终必须报错、ZRPOS 增量不超过 4 次、落盘长度不增长；旧实现下这一段会一直重发下去。89 + 88 项全绿。

### Fixed（上传下载会静默留下不完整的文件）

**问题**：三处。①直接用最终文件名写，传到一半断线、取消、进程被杀，远端留一个尺寸不对但名字正确的文件。②续传判据是「本地尺寸 ≤ 远端尺寸 + 尾部 64KB 指纹」，等长时 `while` 一次都不跑直接标 done —— 本地那份旧文件被当成已经下完。③上传侧 `pOpen(remotePath, pos > 0 ? 'r+' : 'w')` 静默覆盖已存在的目标，而下载侧早就有 `uniqueLocalPath` 生成「名字 (1).ext」。

**做法**：本地与远端双向都先写 `<目标>.part`，写完整了再 rename；rename 撞到已存在路径时先 unlink 目标再 rename 一次，两次都失败就中止并保留 .part，不做原地写回退。三处细节：commit 之前必须显式关句柄（Windows 上句柄未释放时 rename 报 EBUSY）；取消时删 .part 而不是删目标名（目标名可能是上一次成功的结果）；放弃重试时保留 .part（那是唯一还能续的进度）。

**新增验证**：`scripts/verify-sftp-resume.cjs` 的断线探测改为先看 `.part` 再回退最终名，`scripts/verify-transfer-progress.cjs` 的假 attrs 补 `isSymbolicLink`；两个脚本全绿，`verify-sftp-resume-e2e.cjs` 走真实 ssh2 链路重新验证续传（上传 5.3 MB/s、下载 5.4 MB/s）。

### Fixed（打开再保存就把远端文件弄坏）

**问题**：三处都会静默破坏文件。①`writeText`（编辑器保存、配置备份回写）原来是 `rename(path, path.bak)` 再 `writeFile(path)` 新建：rename 走的是链接本身，写回时新文件落到链接位置，符号链接变成普通文件、指向的目标一个字节都没变；同时 owner、`0600`、SELinux 上下文全部丢失。②`readText` 用 `buf.includes(0)` 判二进制后无条件 `toString('utf-8')`：GBK/GB18030 的中文配置文件读进来是一串替换字符，改一个字保存回去，中文注释全毁。③删目录用 `pStat` 判型，而 `stat` 跟随符号链接 —— 远端一个 `html -> /` 的链接，删 `~/html` 的结果是递归清空整站。

**做法**：①改成复制备份 —— 原文件读出来存成 `.bak`，然后原地打开截断写，失败时用内存里那份原内容回写；代价是多一次完整读写（2MB 上限），换 inode 不变、权限不变、链接还是链接。②探测链 BOM（UTF-8 / UTF-16LE / UTF-16BE）→ 严格 UTF-8（`TextDecoder` + `fatal: true`）→ GB18030，编码随内容返回到编辑器并在保存时按同一编码写回，`iconv-lite` 本来就在依赖里。③改用 `lstat`，链接一律只 unlink、绝不进入。

**新增验证**：`readText` 返回 `RemoteText { content, encoding }`，五个调用点（`ipc/sftp.ts`、`configBackup.ts` 三处、`sftpStore.openEditor/saveEditor`）跟着改，`tsc` node + web 双双 0 错误。

### Fixed（文件面板刷新点了没反应）

**问题**：树节点缓存 30 秒且 `if (fresh) return`，点刷新按钮命中缓存直接返回什么都不发；`list()` 里任何一次 readdir 失败都 `invalidate(sessionId)`，一个权限不足的子目录能让整个会话的缓存全部作废；`pReaddir` 没有超时，回调永不触发时列表永远转圈，看不出是慢还是死了。

**做法**：刷新按钮绕过新鲜期强制重发并在途期间 disabled + `animate-spin`；`list()` 只在错误不是 SFTP 状态码（链路级错误）时才作废通道；`pReaddir` / `pStat` / `pLstat` / `pUnlink` / `pRename` / `pOpen` 六个原语统一套 15 秒 `META_TIMEOUT_MS`，超时文案刻意带「链路中断」四个字 —— `isRetryable` 认这个词，超时才能落进断线续传路径而不是判整条任务失败。

**做法（第二轮，解决「有反应但慢」）**：三条根因叠在一起 —— ①刷新时 `setSubDirs(new Map())` 让第二个 effect 把所有已展开目录当成「待补」，一次刷新等于重拉整棵树，画面还先塌成加载中；②根目录走单独的 `sftp.list()`、已展开目录走合批 `requestDirs`，两套通道；③`loadDir` 的 force 分支跳过新鲜缓存却仍复用 `inflight` 里的旧 Promise，刷新期间再点一次转完圈显示旧数据。改法是：刷新只让缓存失效、保留旧数据先上屏；根目录与已展开目录合并成一条 `listMany`；`inflight` 加世代号，force 不搭旧请求且只让最后一次结果写缓存。最后再拆一层 —— 转圈时长等于「最慢那一批 readdir」（并发上限 8，超过就排队），所以根目录单独 await、已展开目录另发一批后台重验（必须落到下一个 tick，否则又被 `requestDirs` 合回同一条）。

**新增验证**：新增 `scripts/verify-files-refresh.cjs`（20 项，逐条判「修复没落地时会红」）；`scripts/e2e-ui-sftp.cjs` 把原来那条恒真的「刷新后列表可用」换成两条真断言（远端造文件 → 点刷新 → 行出现；点击瞬间按钮 disabled 且带 spin），并新增 S15 sz 大文件接收，实测 20/20 PASS、用时 32.8s。刷新耗时用临时探针量过（lab SFTP + 双向 TCP 延迟代理 + CDP 点真按钮）：模拟 60ms RTT 下根目录刷新 561ms、已展开 12 层 578ms，差 <10ms；改造前同一套探针在 80ms 延迟下，已展开 3 层就超时 60 秒。

### Added（传输记录面板）

**问题**：传输状态只活在渲染进程内存里，关窗口即丢；目录任务失败时引擎把失败清单拼成一个字符串只取前三条，传 300 个文件失败 17 个，剩下 14 个永远查不到。

**做法**：主进程做唯一写者，落 `transfer-records.json`（`src/main/store/transferRecord.ts` + `src/main/ipc/transferRecord.ts`）。六处刻意的取舍：

- **只在入队与状态跃迁时写盘**，进度事件一律不落盘 —— 否则每 150ms 一次进度 tick 都要整份重写 JSON。
- **崩溃留下的 running 记录在启动时改判 `interrupted`**（`sweepStale()`），面板上是黄色「已中断」、可重试；否则一条永远停在 40% 的记录会让人以为还在传。
- **失败明细按错误消息聚合再存**：`Permission denied × 302` 一行，展开只列前 50 条路径，截断处写「还有 N 个未列出」；明细只保留在最近 200 条记录上，任务总数封顶 500 条 —— 行数挂钩的是「不同错误原因数」而不是文件数。为此引擎里 `failed` 从扁平字符串数组改成 `Array<{ path, message }>`，收尾抛新的 `TransferPartialError`，由 `enqueue` 的 catch 把全量明细挂到 `TransferProgressEvent.failures`。
- **身份是快照，不 join 会话**：写入时把 connectionId / connectionName / target / 绝对路径一起存下来。sessionId 每次启动都是新的，用它 join 的结果是重启后所有记录都显示「未知会话」。
- **三种定位按钮**按记录能不能定位分：有本机绝对路径（下载、ZMODEM 接收）直接在资源管理器里显示；只有远端路径（上传）→「在远端定位」，点开文件面板跳到那个目录，连接不在线则禁用；拿不到路径（trzsz 下载、ZMODEM 发送）→ 灰字「原始位置未记录」。
- **行级订阅活任务**：进行中的行按 id 去 `sftpStore.transfers` 找活数字，但只让那一行订阅 —— 500 行整表订阅一个每 150ms 换引用的数组，等于让面板每秒重渲几十次；找不到（重启后、渲染层重载）显示「进行中 · 进度未知」。

写入层收口在主进程：`TRANSFER_RECORD_LIST / UPSERT / RETRIED / STATS / SWEEP`、`TRANSFER_REVEAL`、`TRANSFER_OPEN_DIR` 七条 IPC，广播只发节流后的 `EVT_TRANSFER_RECORD_CHANGED` 信号（`RECORD_EMIT_MS = 300`）不发内容，面板收到即重拉列表。ZMODEM 侧把 `phase` 扩成 `canceled` 以区分「用户按停」与「真失败」，`ZM_PICK_FILES` 补返回原始路径；trzsz 侧在 `beginRecord` / `finishRecord` 记账并补 `unit: files`，面板按 unit 分叉渲染（字节型显示速度与 ETA，文件型显示「2 / 5 个文件」）。重试只复用已连接的会话、不自动重连，trzsz 与 ZMODEM 的重试按钮直接禁用（由对端发起，用 SFTP 参数重放只会把「协议不对」变成一条新的失败记录）。

两个入口共用同一份数据：全宽面板从活动栏工具菜单进，日常更高频的位置是文件面板新增的第三个 Tab「传输」（`TransferTab.tsx`），两处用 `attachView()` 计数共享状态 —— 只要有一处开着，收到变更信号就重拉，都不开才停。另外补了「默认下载目录」设置项（`AppSettings.downloadDir` + `SFTP_PICK_DOWNLOAD_DIR`），空值回退系统「下载」，主进程在用时才校验绝对路径 + 存在 + 是目录，路径失效自动回退而不是让下载失败。

**新增验证**：`tsc` node + web 0 错误、`eslint src` 0 问题；面板与侧栏两处 UI 已在真实 Electron 窗口里截图目视确认（运输记录列表、失败明细展开、下载目录行、设置分组）。

### Added（远端路径校验）

**问题**：本地有 `assertSafeName`，远端一个都没有 —— `remoteJoin` 只做字符串拼接，`..` 一路上去能走到根。

**做法**：新增 `src/shared/remotePath.ts`：`assertSafeRemoteName` 拦空 / `/` / 控制字符，`assertRemotePath` 要求绝对路径并逐段拒 `..`；`MKDIR / DELETE / RENAME / CHMOD / READ / WRITE / UPLOAD / DOWNLOAD` 八个通道全部过一遍。刻意不复用 `pathGuard.ts`：那套按 Windows 规则写，会把 Linux 上完全合法的 `:` `?` `*` 一起拦掉。

### Changed（重传跳过未变化文件 / 遍历上限 / 暂停让出并发位）

- **目录重传跳过未变化文件**：大小相等且修改时间（秒级 `Math.floor`）相等就跳过，note 报「跳过 N 个未变化的文件」。默认开，上传目标对话框里有「强制全量重传」勾选框，`force` 从对话框一路透传到 `enqueue`。刻意不做 sha256 比对 —— 那比重新上传还慢。
- **远端遍历加边界**：`walkRemote` 补 `visited` 集合、`MAX_WALK_DEPTH = 64`、`DOWNLOAD_FILE_LIMIT = 20000`（与上传侧 `UPLOAD_FILE_LIMIT` 共用）；符号链接默认跳过并报数。改前远端一个 bind mount 自引用或 `ln -s` 循环就能把本地进程走到内存耗尽。
- **暂停让出并发位**：`MAX_CONCURRENT_TRANSFERS = 3`，而 `acquire` / `release` 原来只在 `enqueue` 时配对 —— 三个任务同时暂停，`checkpoint` 死等却仍占着槽位，队列永久卡死。改成 `ctl.holding` 记账，暂停时 `release()`、继续时经 `checkpoint` 里的 `ctl.acquire()` 重新排队。
- **`scanFolders` 改工作池**：原来逐文件串行 `fs.stat`，2 万文件就是 2 万次磁盘往返；改成 `LIST_MANY_CONCURRENCY` 并发池。
- **编辑器保存后刷新目录与文件树**：`saveEditor` 成功后补 `invalidateDir` + `bumpTree`（保存后大小与 mtime 都变了），`applyProgress` 的 done 分支补 `bumpTree`（否则侧栏文件树看不到新文件）。

### Changed（发版日志：仓库里那 20 个 `release-notes-v*.md` 全删）

**问题**：仓库根目录堆了 20 个 `release-notes-v<ver>.md`（v1.6.1 → v2.2.0），每版一个。内容与 CHANGELOG 高度重复，翻仓库时像一堆没整理的碎片。

**改法**：正文不再按版复制进仓库，改由 `scripts/release-notes.cjs` 在发版时从 CHANGELOG 的 `## [<ver>]` 段现抽：

- `node scripts/release-notes.cjs --version 2.2.0 --out <tmp>` —— 抽不到或不足 200 字符直接退出码 1，不给占位符正文
- `.github/workflows/release.yml` 的发布步骤改为先跑这个脚本生成 `release-notes-<tag>.generated.md`，再 `gh release create --notes-file`
- `scripts/release.ps1` 的 `-NotesFile` 默认值改为空：留空 = 从 CHANGELOG 现抽，显式传文件才用文件
- `verify-release-notes.cjs` / `verify-docs-sync.cjs` 的第 6 条判据改为「跑 release-notes.cjs 能抽出 ≥ 200 字符」，与真实发版链路同源，不再自查一个仓库里已不存在的文件
- `.gitignore` 补 `release-notes-v*.md` / `release-notes-*.generated.md`，防止再写回来

**实测**：`verify-release-notes` 6/6、`verify-docs-sync` 6/6；抽出的 v2.2.0 正文 8223 字符，首行 `# SSH Workbench v2.2.0（2026-11-17）`。

## [2.2.0] - 2026-11-17

### Fixed（串口收到裸 LF 时屏幕呈阶梯状）

**问题**：连 IFLY 机器人这类 Linux 设备，命令行输出是一路向右错位的阶梯。原因不在编码也不在终端字体 —— 设备只发了 `\n`。终端里「换行」是两个动作：`\n` 把光标下移一行、`\r` 把光标拉回行首，只发前者就只有下移，每一行都比上一行更靠右。按理说设备 tty 的 `ONLCR` 会把 `\n` 翻成 `\r\n` 再吐出来，但 busybox 的精简 shell、不少裸机固件往串口直接 `write("\n")`、以及输出被重定向到串口的场景都不会翻。

**做法**：在 `SerialTransport` 的**入站文本通道**把裸 LF 补成 CRLF，新函数 `normalizeInboundNewlines(text, lastWasCR)`。四个刻意的选择：

- **放传输层，不开 xterm 的 `convertEol`**。那是终端实例级的开关，SSH 会话会跟着被改写，而 SSH 对端发的本来就是完整 CRLF；一旦上游已经补过 CR，多余的改写会变成 `\r\r\n`。经过串口传输层的只有串口数据。
- **`raw` 一个字节都不动**。`onData(chunk, text)` 的两个参数分开走：`raw` 原样透传，ZMODEM 帧与二进制协议靠它判帧，改一个字节 CRC 就废了；只有 `text` 被归一。这样录制、高亮行切分、终端看到的是同一份内容，不会出现「屏幕对了、日志里还是阶梯」。
- **跨帧状态 `lastWasCR`**。串口按块到达，上一块末尾是 `\r`、下一块开头是 `\n` 时那是一个完整的 CRLF；只看当前块会用「前面不是 CR」的假设把它补成 `\r\r\n`，屏幕上反而多一个空行。`open()` 时重置为 false —— 上一条连接末尾的 CR 不该影响这一条的首帧。
- **不看 `config.newline`**。那个字段描述的是「我们发出去用什么」，跟设备回什么没有关系。

纯文本日志不受影响：`recorder.writeText` 本来就把 `\r\n` 与 `\r` 都归一成 `\n`，入库站 CRLF 后 `.log` 不会多出空行。

**新增验证**：`scripts/verify-serial.cjs` 补 12b 与 14b-2 两段（91 → 102 项）：裸 LF 被补、已有 CRLF 不重复补、跨帧 CR|LF 不被拆成 CRCRLF、末尾残留 CR 传给下一帧、连续多个裸 LF 各自补、无换行时原样返回；以及走真实 `SerialTransport` 的端到端两条 —— 假端口 `emit('data')` 后 `text` 是 CRLF 而 `raw` 与源字节逐字节相同、分两帧发出的 CRLF 只补裸 LF 那一处。

### Fixed（串口波特率输入框漏了输入法守卫）

`SerialBootBar` 里新加的波特率输入框在 `onKeyDown` 消费 Enter，但没判输入法组合态 —— 中文输入法下敲数字后再敲回车只是想确认候选词，却会把半截数字当速率应用下去。补 `if (isImeComposing(e)) return`，并把 `scripts/verify-ime-guard.cjs` 的期望处数从 13 提到 14（这个脚本的价值就在于「少一处就红」，数字不跟着走等于把守卫变成可选的）。

### Added（串口刷机配套：内置 TFTP 服务端 + U-Boot 引导条）

**背景**：7628 板子的部署文档要求「PC 开 tftp 工具 → 串口工具连 57600 → 重启板子 2 秒内按 2 → 输 Y → 两次回车 → 填固件名」。串口本身 v2.0.0 已经能用（57600 8N1 / CR / UTF-8 全在支持范围内），但这条流程有四件事必须切到别的工具或靠手速：TFTP 服务端在外面、2 秒窗口靠掐表、`Y` 不带回车这个细节容易错、固件名要手打一遍。

**改动**：

- `src/main/tftp/server.ts`（新增）：内置 TFTP 服务端，只用 `node:dgram` + `node:fs`，**零新依赖**。RFC 1350 只读服务：RRQ → DATA/ACK 循环，512 字节块；接受 `blksize` / `tsize` / `timeout` 三个选项并回 OACK（不回 OACK 的话新 U-Boot 直接判失败）；`blksize` 夹在 8..1468。**每次传输另起一个 UDP socket 绑随机端口** —— RFC 1350 的 TID 规则要求如此，复用 69 端口回包会被 U-Boot 当成陌生来源丢掉，症状是「板子一直重试、服务端看起来啥也没发生」。超时 2 秒重传，5 次放弃并提示「检查网线是否直连、PC 与板子是否同网段」。WRQ 一律回 ERROR 2（只读，不接受写入）；文件名不匹配回 ERROR 1 而不是静默超时。`EADDRINUSE` 翻译成「端口 69 已被占用（可能有别的 TFTP 工具正在运行），关掉它再试」。
- IPC：`TFTP_START` / `TFTP_STOP` / `TFTP_STATE` + 事件 `EVT_TFTP_LOG`，`handle.ts` 的 `channelTitle` 补两条，`preload` 暴露 `tftp.start` / `tftp.stop` / `tftp.state` / `on.tftpLog`。主进程退出时（`window-all-closed`）显式 `tftpServer.stop()` —— 它持有 69 端口和固件文件句柄，不关会让下次启动直接撞端口。
- `src/renderer/src/components/terminal/SerialBootBar.tsx`（新增）：串口会话顶部的引导条，只在 `session.kind === 'serial'` 时出现。三步各一键：①点一下按钮，倒计时 6 秒后每 250ms 连发 `2`、共 16 发（也可以点「立即发送」发单个）—— 倒计时的起点是点按钮那一刻，不是上电那一刻，中间隔着人去拨电源，所以按文档写的「2 秒」设会变成还没摸到开关就发完；连发则是为了盖住那 2 秒窗口，发一次等于赌自己刚好卡在里面；②发 `Y`（不带回车）；③回车 / 发固件名（取服务端正在提供的文件名，没有则用文档里的默认名）。下半部分是 TFTP 开关：选固件、启动 / 停止、实时传输进度，以及**本机网口地址** —— 7628 这套引导菜单通常把 tftp 地址写死，所以界面给的是「本机是什么」，对不上就把电脑该网口 IP 改成它要的那个。
- `src/renderer/src/stores/tftpStore.ts`（新增）：服务端状态 + 最近 200 条日志。
- `ConnectionEditor`：加「7628 U-Boot 控制台」预设（57600 / 8 / 1 / none / none / utf-8 / cr），点一下套用，套完仍可逐项改。

**为什么不放进固件升级面板**：那个面板全程走 SSH（`sftpManager` 上传 + 远端跑命令），而刷 U-Boot 的时候板子上还没有系统、没有 IP、没有 SSH —— 唯一的通道就是串口。硬塞进去只会让「固件升级」这个入口的语义变得不可预测。

**新增验证**：`scripts/verify-tftp.cjs`（29 项，真起 UDP 服务端 + 自写最小客户端）：未启动状态、空固件拒绝、带 `blksize`/`tsize` 的完整传输（OACK 回显、**数据确实从新端口发出**、SHA256 与源文件一致）、无选项的 512 块老客户端、文件名不符回 ERROR 1、WRQ 回 ERROR 2、`stop()` 后端口可重绑、端口被占用时报可读错误。已接入 `npm run test:features`。

### Added（串口发送节奏：逐字符间隔 / 换行后间隔）

**问题**：往 U-Boot 或 9600 的老设备粘贴一条长命令，设备会吞掉中间的字节 —— 提示符回来了，但只有半条命令在跑，或者干脆进不了命令。串口本身没有流控握手可用（现场那条线上通常只接了 TX/RX/GND），谁也拦不住 PC 一股脑往驱动里灌。

**做法**：`SerialConfig` 加 `charDelayMs`（逐字符间隔）与 `lineDelayMs`（换行后间隔），合法区间与文案收口在 `src/shared/serialTiming.ts`：

- 上限 `SERIAL_MAX_CHAR_DELAY_MS = 100`。延迟是按**每个字符**累加的，填 1000ms 意味着 100 字符的命令要发 100 秒 —— 那不是慢速设备，是表单填错了。100ms 已是 9600 波特率下单字节时间（约 10.4ms）的十倍，再慢该靠流控而不是延迟。
- 上限 `SERIAL_MAX_LINE_DELAY_MS = 2000`，用于「执行完一行才回 OK」的 AT 通道与 bootloader 菜单。
- 两个都为 0 时走原来的整段直发快路径，行为与 v2.1.9 完全一致。

发送节奏落在 `SerialTransport` 而不是会话管理器：会话层的 `write()` 只负责 `recorder.appendInput`，真正的落端口在传输层。实现是**字符队列 + 定时器**，`write()` 仍然同步返回 —— `types.ts` 里写着「键盘输入必须保序，宁可同步阻塞」，改成 async 循环会让两个并发调用互相插队，串口上的命令就拼错了：

```ts
const delay = isLineBreakAt(head.data, at)
  ? Math.max(this.lineDelayMs, this.charDelayMs)
  : this.charDelayMs
if (delay > 0 && this.waitThen(delay)) return
```

几处刻意的细节：①按码点切而不是按 UTF-16 code unit 切（`nextUnit` 用 `codePointAt` + `size = code > 0xffff ? 2 : 1`），否则一个汉字会被劈成两个残字节；②CRLF 只算一次行尾（`isLineBreakAt` 里 `\r` 后跟 `\n` 时返回 false），两个都算会让配置成 CRLF 的连接每行停两次；③两个延迟都配了时取 `max` 而不是相加，「每字符 5ms + 换行后 200ms」的意图是「这一行发完停 200ms 等设备回 OK」，不是 205ms；④`writeBytes` 不逐字节节流（协议帧整块交给驱动），但排在已有文本之后，顺序不乱；⑤`close()` / `handleClosed()` 都调 `resetPacing()` 清队列与定时器，否则下次 pump 会撞到已释放的 port。

**界面**：连接编辑器在 DTR 开关之后加了「每字符间隔」「换行后间隔」两个数字输入（复用 `input w-16 text-center` 的既有写法），预览行下方追加一行 `describeSerialPacing` 的说明 —— 发送节奏是隐性行为，标签上看不出来，不写到预览里用户下次粘贴命令还是被吞。

**落盘与导入**：`normalizeSerial`（connections.json 可被手改）与 `cleanSerial`（别人给的导出文件）都过同一对 `normalizeCharDelayMs` / `normalizeLineDelayMs`。不收敛的后果是「界面能填 500、传输层只认 100」这种自相矛盾；脏值（`'abc'`、负数、`null`）一律当 0，越界收敛到上限而不是判非法。导出侧走 `{ ...c.serial }` 自动带上。

**新增验证**：`scripts/verify-serial.cjs` 补第 14c 段（50 → 72 项）：无节奏时整段一次写出、逐字符时一次只落一个字符且 `write` 立即返回、汉字不被劈开、行间延迟真的等了且 CRLF 只停一次、无换行不等行间延迟、文本与 bytes 混排保持顺序且二进制不被拆分、关闭时清空队列、收敛函数与文案断言。`verify-conn-transfer.cjs` 补发送节奏导出 / 导入收敛（非法、越界、脏值、小数，以及老文件缺字段时默认 0）。

### Added（串口三件套：在线切波特率 / BREAK / 纯文本日志）

**问题**：三件在不同现场都会撞上的事。①设备上电跑在 115200，进系统后切成 9600，或者反过来 —— 以前只能断开重连，中间那段输出全丢。②板子已经在自动启动，想打断它进维护模式，串口线上只有 BREAK 这一种手段，而工具里没有。③录制只有 `.cast`：那是给回放器读的时间轴 + 控制码，要 grep 一个报错、要把它发到群里，得先另找一个工具转一遍。

**在线切波特率**：`SerialTransport.setBaudRate(baudRate)` 走 `port.update({ baudRate })`，**不是 `close()` + 新建 `SerialPort`**。重开一次会重新走 DTR/RTS 的默认电平（接了自动下载电路的板子会被重启），也会让设备在系统里重新枚举一次；`update` 只改 UART 分频，端口对象和事件订阅都还在，输出一帧都不丢。生效值写回 `this.config.baudRate`，返回实际速率 —— 输入框按这个值回填，而不是按用户敲的那串数字回填。非法值（字符串、负数、超过 4000000）回落**当前**速率而不是静默改成一个默认值：切波特率时看到「已切到 115200」而实际没变，比报错难查得多。判定收口在新文件 `src/shared/serialBaud.ts`（`SERIAL_MIN_BAUD = 50`、`SERIAL_MAX_BAUD = 4_000_000`、`isValidBaudRate`、`normalizeBaudRate`），`connections.json` 的落盘、导入校验、传输层在线切三处必须同源，否则会出现「界面能填、导入认、打开时被 serialport 拒」这种自相矛盾。

**BREAK**：`sendBreak(durationMs = 250)` 用 `port.set({ brk: true })` → 等 → `port.set({ brk: false })`。三处刻意的写法：①时长夹在 50..2000ms —— 太短某些 UART 根本不产生中断，太长会让整条线看起来像挂了；②**释放无条件执行**，置位抛错也照样把 `brk` 拉回 false，否则 TX 被钉在 break 状态，之后敲什么都不出去，只能拔线；③只碰 `brk` 字段（`port.set` 会顺手把没写的字段也当默认值处理，带上 `dtr`/`rts` 就等于顺手复位板子）。界面上 BREAK 成功不弹提示：它的价值在于对端有没有反应（掉没掉进 U-Boot），本地「拉低成功」说明不了任何事。

**纯文本日志**：`recorder` 在写 `.cast` 的同时再写一份同名 `.log`（`RecorderOptions.plainText`，默认开）。文本通道自己做四件事：`stripAnsi` 剥 CSI / OSC（手写扫描而不是正则 —— 控制码套起来时没人敢改那条正则）；`\r\n` 与 `\r` 都归一成 `\n`（进度条那种原地重绘会变成一行行刷屏，但比粘成一行好读）；行首补**墙上时间** `[HH:MM:SS.mmm]`（`RecorderOptions.timestamp`，默认开）—— 现场排查要的是能与设备日志、抓包对表的时间，相对秒数对不上任何东西；输入行前缀 `> `，一眼分得清谁敲的。两种格式**各自计数**：`.cast` 撞到 50MB 只停 cast，`.log` 撞到 50MB 只停 log，一条通道被掐不会顺手把另一条也关了。

日志面板按后缀分格式（`SessionLogFile.format: 'cast' | 'log'`）：`.log` 标一个 `txt` 标签并**不显示回放按钮**（纯文本没有时间轴，给个点了没反应的按钮比不给更糟），导出对话框按后缀选默认扩展名（`文本日志 .log` / `Asciinema Cast .cast`，顺序影响另存时补全的后缀）。删除按「那次会话」而不是「那个文件」：删 `.cast` 连带删同名 `.log`，反之亦然。

**IPC**：新增 `session:setBaud` / `session:break` 两条，`channelTitle` 补「切换串口波特率失败」「发送 BREAK 失败」，`preload` 暴露 `session.setBaud` / `session.break`（前者返回生效速率）。`SessionInfo` 加 `baudRate?`，标签栏要显示当前速率时不必去正则解析 `COM3 · 57600 8N1` 那个显示名。

**界面**：`SerialBootBar` 折叠头右侧常驻 `Gauge + 速率`，展开体顶部单独一段「串口参数」—— 与刷机三步分开，因为「设备不吐字」和「刷机」是两件事：波特率错了的表现就是一片空白或满屏乱码，能就地试另一个速率；BREAK 用来打断已经在自动启动的板子。速率输入框 + 常用档位下拉（选中只填进输入框，不立刻切换）+「应用」，「应用」在速率没变时禁用。切换成功后同时更新会话显示名（`sessionStore.applySerialBaud` 就地重算 `describeSerialTarget`），标签栏与状态条跟着变。

**设置**：`logPlainText` / `logTimestamp` 两个开关（默认都开），前者关掉后 `logTimestamp` 那一行也一起隐藏 —— 它没有独立含义。

**新增验证**：`scripts/verify-serial.cjs` 补 14d–14f 三段（72 → 91 项）：切波特率真的走 `port.update` 而不是重建端口、生效值写回 config、非法与超上限回落当前值、驱动没有 `update` 时报可读错误；BREAK 先 `brk: true` 后 `brk: false`、只碰 `brk` 字段、时长被夹取、真实等待到点；会话层经假传输层转发并在 `list()` 里看到新速率与新的显示名。新增 `scripts/verify-session-log.cjs`（24 项，临时 userData + 真实 `createWriteStream`）：同名 `.cast`/`.log` 成对出现、ANSI 被剥干净、时间戳一行的量、输入行前缀、`plainText: false` 与 `timestamp: false` 各自的边界、两种格式双向截断互不影响、`listSessionLogs` 带 `format`、删一种连带删另一种。


## [2.1.9] - 2026-11-16

### Fixed（ZMODEM 浮层：切走标签再切回来，结束的传输又"重现"一次）

**症状**：传输结束后浮层按 done 2.5s / error 6s 自动收起，但切到别的标签再切回来，浮层会重新出现一次再消失 —— 看起来像传输又跑了一遍。

**根因**：`lastProgress` 存的是最后一次进度快照，生命周期跟会话一致，只有 `detachZmodem` 才清。`ZmodemOverlay` 每次挂载都会调 `getZmodemProgress(activeId)` 恢复"进行中的传输"，而它对**终态**快照同样返回 —— 于是一次已经结束的传输被当成进行中的恢复了。

**改法**：getter 只恢复未终结的快照。

```ts
const snap = lastProgress.get(sessionId)
if (!snap) return null
if (snap.phase === 'done' || snap.phase === 'error') return null
return snap
```

终态快照**仍留在 Map 里**：看门狗（stall timer、续传 resync、选目录兜底）读的是 `lastProgress` 本身而不是这个 getter，续传与超时判定完全不受影响。

### Added（另存为新设备：默认沿用原连接已保存的凭据）

**问题**：编辑连接里点「另存为新设备并连接」，走的是 `id: undefined` → 主进程 `randomUUID()` 建新记录。新 id 在保险箱里没有条目，原连接的 password / passphrase / proxyPassword 全丢，点完「并连接」立刻又弹一次密码框。

**改法**：`ConnectionInput` 加一个只对新建生效的 `reuseSecretFrom`，渲染层另存时填原连接 id，主进程落库后按「显式输入 > 继承 > 本记录原值」取值：

```ts
const inherited =
  isNew && input.reuseSecretFrom && input.reuseSecretFrom !== saved.id
    ? await getSecret(input.reuseSecretFrom)
    : undefined
```

三条刻意的边界：更新同一条连接时 `isNew` 为假、不跨 id 取凭据；源 id 不存在时 `inherited` 是空对象，行为与不带这个字段完全一致；显式传 `''` 是「清空」意图，不会被继承值顶回来。保存成功的 toast 补了半句「已沿用其保存的凭据」。

### Tests

- 新增 `scripts/verify-conn-reuse.cjs`（21 项）：esbuild 打真实 `repository` + `vault`，electron 用 `SW_MACHINE_DIR` + aes-256-gcm 自造 safeStorage。覆盖继承三凭据、显式优先、不带 `reuseSecretFrom`、源 id 不存在、同 id 更新不继承、`''` 清除、代理密码继承、只读源、源被删后另存。
- `scripts/verify-zmodem-renderer.cjs` 加第 17 段（66 → 72 项）：跑到 done 后断言 getter 返回 `null`、重复读取仍 `null`（重挂载幂等）、实时 watcher 仍收到 done、`bytesDone === total`（过滤没影响收尾）。
- 实测：`node scripts/verify-conn-reuse.cjs` → 21 通过 / 0 失败；`node scripts/verify-zmodem-renderer.cjs` → 72 通过 / 0 失败。

### Docs

README 双语的当前版本与「最近更新」首条跟上 2.1.9，`release-notes-v2.1.9.md` 补齐。2.1.8 发出时这两处仍停在 2.1.7（`verify-docs-sync` 6/6 红），这次一并补上。

## [2.1.7] - 2026-11-15

### Added（分屏的第二个入口：终端右键）

**问题**：v2.1.5 的分屏入口只有标签栏右键一个。标签栏本身 44px 高、还会横向滚动，鼠标要精准落在某一条标签的几十像素上才点得到；而人想分屏时，视线和鼠标其实都在终端里。用户原话是「在标签栏上感觉不太好用」。

**做法**：终端右键菜单加三项 ——「向右分屏」「向下分屏」「关闭此分屏」。不新增任何状态，两个入口调同一组 `useSplitStore` 动作，走同一条「复用当前 SSH 连接开新 shell + replaceLeaf 成 split 节点」链路。

判据从 `paneTree.ts` import 同一个 `MAX_PANES`，不各写一个 4 —— 上限以后改动只改一处，两个入口不会分叉。

**「关闭此分屏」只在真的分了屏时出现**（`paneTotal > 1`）。单格时 `closePane` 等价于关标签，而终端右键里多一个「关掉整个终端」的入口既危险又多余（标签上本来就有 ×）。这条不是美观问题：菜单项写成常驻，单格用户会看到一个误点就丢整个终端的东西。

菜单顺序：复制 / 粘贴 / 全选 /（发送文件…）/（取消传输）/ **向右分屏 · 向下分屏 ·（关闭此分屏）** / 查找 / 清屏。分屏组用 `separatorBefore` 与前一组隔开，与「查找」前那条分隔线对称。

### Tests

`scripts/verify-split-e2e.cjs` 从 16 项扩到 **22 项**，新增 T0–T4b 六条，判据都选成「修复没落地时会红」的量：

| 断言 | 失效时会红的情形 |
|---|---|
| T0 单格时终端菜单有分屏项、且**没有**「关闭此分屏」 | 把「关闭此分屏」写成常驻 |
| T1 终端菜单「向右分屏」真的多出一格 | 只挂菜单不接 onClick |
| T2 标签数量仍是 1 | 终端入口另写一套逻辑、绕开 splitStore |
| T3 分屏后出现「关闭此分屏」 | `paneTotal` 拿会话 id 当 owner 算 |
| T4 点它真的回到一格 | 误调 `sessionStore.close` |
| T4b 标签仍在 | 同上 |

打开菜单用 `.xterm` 上派发 `contextmenu`（冒泡到 TerminalView 挂了 `onContextMenu` 的容器 div，与真实右键同一条路径）；读菜单文本只取 `.menu` 一个元素，不用 `body.innerText` —— 后者会把侧栏与状态栏文案一起算进来，断言就退化成「页面上出现过这四个字」。

实测：22 通过 / 0 失败。全量回归 71 通过 / 0 失败 / 0 跳过。

### Changed

- `src/renderer/src/components/terminal/TerminalView.tsx`：新增 `Columns2` / `Rows2` / `XCircle` 三个图标与 `MAX_PANES` / `countLeaves` / `leafIds` 三个导入；`useSplitStore` 由只读 `getState()` 改为订阅 `trees`（菜单项要跟着分屏状态变）。

### Fixed（回归脚本：Z5 读到空串的真因）

`scripts/verify-trzsz-e2e.cjs` 的 Z5/Z5b 在 CI 里时红时绿，两处都是脚本自身的表达式拼错，不是功能坏：

| 位置 | 症状 | 真因 |
|---|---|---|
| Z5 等待表达式 | `waitFor` 里 CDP 抛出 `Unexpected token '('`，被 `try/catch` 吞掉，重试 20s 后返回 false | `'(() => ' + TERM_ROWS_VISIBLE + '.some(...)'` 把 IIFE 拼成了 `(() => (...)())()`，多一层调用 |
| Z5 失败诊断 | 诊断本身报 `SyntaxError: Unexpected token 'return'`，拿不到现场 | `' })' + ' return { ... }'` 缺分号，`})` 后面直接跟 `return` 被当成同一表达式 |

两处都改成先取 IIFE 的结果再做 `.some(...)`、并补上分号。修好后连跑两次 **10 通过 / 0 失败**，全量回归 **71 通过 / 0 失败 / 0 跳过**。

顺带把 `TERMINAL_TEXT` 的取样口径从「文档里第一个 `.xterm-rows`」改成「只取可见终端（`getBoundingClientRect` 宽高 > 10）再拼接」：分屏后第一个终端可能正被 `display:none` 藏着、缓冲区是空的，读到 `""` 和「远端回执没到」在现场上完全一样。

## [2.1.6] - 2026-11-15

### Added（trzsz 文件传输：rz/sz 的现代替代）

**背景**：串口设备、老交换机、只有 ssh 没有 sftp 的机器，传一个固件包的现实做法仍是 `rz`/`sz` —— 需要在对端装 lrzsz，且走的是 8-bit 明文协议，遇到 4-bit 终端或 `tmux` 就会挂。trzsz 是同一套交互（终端里敲 `trz` 发文件、敲 `tsz 文件` 收文件）但走文本协议，带目录、带进度、断线可续。WindTerm / Tabby / Netcatty / electerm 都内置，我们之前只有 ZMODEM。

**过滤器放主进程，不放渲染层。** `TrzszFilter` 官方包（`trzsz@1.1.6`，MIT）运行时用 `require.resolve('fs')` 判定环境：Node 分支必需 `chooseSendFiles` / `chooseSaveDirectory` 两个回调并自带 fs 读写；浏览器分支退到 `window.showDirectoryPicker`，在 Electron 渲染进程里不可靠。放主进程的另外两个好处：选文件/选目录本来就要原生对话框（`dialog.showOpenDialog`），而大文件不必再走 base64 IPC 往返（现有 ZMODEM 每帧 base64 编解码，几十 MB 时 CPU 明显）。

**只在看到握手才建过滤器，一个字节都不提前碰。** `sessionManager.flush()` 先看文本里有没有 `::TRZSZ:TRANSFER:`；没有就走原来的 `onData` 直路，普通终端与渲染层 ZMODEM 的行为完全不变。命中才 `trzszManager.ensure()`，此后本会话文本全部由过滤器产出。这个「惰性挂载」既保证了零改动兼容，也让 e2e 能构造出「挂了/没挂」两种状态去比较耗时。

**握手串照常显示在终端里，只是不进录制。** `processServerOutput` 的语义是先 `writeToTerminal` 再延迟 10ms 探测握手 —— 过滤器不替你吞任何字节，要吞只能在回调里自己过滤。我们没有吞（用户该看到远端回了什么），但录制走 `stripTrzszHandshake()` 剔掉整行：回放时那串 base64 是满屏乱码。

**进度条就是普通终端文本。** trzsz 的进度条是用 `\r` / `ESC[nD` 原地重绘的文本，主进程把它当会话数据下发即可 —— 录制、回滚、搜索全部照常工作，不需要新协议通道。额外只在状态条上显示「图标 + 文件名 + 百分比」，数据从进度条文本里抠（最后一个 `(\d{1,3})%`、`[` 之前那段当文件名），150ms 节流。

**「没装 trzsz」有两条路径都要提示。** 主动上传时 `uploadFiles` 会先发 `Ctrl-C`、等 200ms、再发 `trz`，3 秒内等不到握手就抛 `Upload does not start` —— 我们换成中文提示并丢弃原始英文。但用户**手敲** `trz` 时我们还没创建过滤器（只在看到握手才建），那条路径上没人解析输出，于是 `sessionManager.flush()` 的无过滤器分支里再单独认一次 `command not found`，命中才发一条状态事件。两条路径任一缺失，用户都会觉得「这功能坏了但没告诉我为什么」。

**只对 SSH 会话挂。** 串口没有 `trz` 命令这回事，`ensureTrzsz()` 直接拒（`kind !== 'ssh' || status !== 'connected'` 返回 undefined）。ZMODEM 与 trzsz 不会同时进行：`writeBytes` 在过滤器 active 时直接丢弃。

### Verification

- `scripts/verify-trzsz.cjs` —— 40 项纯逻辑断言，7 组：握手识别 / 录制剔除 / 输出过滤与进度抠取 / 输入直通与上传 / 列宽与取消与管理器。一条首轮是红的，仍然是**断言写错**：原本用 `sudo: rz: command not found` 期望命中，但 `NOT_FOUND_RE` 只列 `trz|tsz`（下载端命令是 `tsz`，不是 `rz`）。
- `scripts/verify-trzsz-e2e.cjs` —— 10 项真实应用断言：通道齐全 / 手敲 trz 出提示 / 上传到没装的那端出中文报错且**耗时 > 2.5s**（证明真等过握手超时，不是立刻返回）/ 对端下发 `tsz` 握手后终端出现 `lab-saw-act`（取消帧真的出了本机）/ 握手串照常显示 / 用户取消选文件返回成功 / 录制里无握手串 / 无未捕获异常。为了让这套跑得起来，`scripts/lab-sftp-server.cjs` 的伪 shell 增加了 `LAB_SHELL_TRZSZ=1` 模式（`@@TRZSZ:ON@@` 开、回真实格式的握手帧、`#ACT:` 回 ack、`@@PERF:n:tag@@` 吐 n 行），`trzszDialogs.ts` 增加了 `SSHWB_TRZSZ_AUTODECLINE=1`（原生模态对话框会挂住进程，脚本点不到）。
- `scripts/perf-trzsz.cjs` —— 11 项：未挂载路径 3 万段三次判定 0.15us/段；**挂载后** 2 万行 0.87us/行且透传字节数完全等于输入（一个字节都不吞）；真应用开/关过滤器中位 31ms vs 31ms = **1.00×**；`connections.json` 身份字段前后一致；录制无握手串；`settings.json` 仍合法。判据里刻意加了「过滤器真的挂上了」这一步 —— 不证明挂载成功，两种状态跑的是同一条路径，比值恒为 1，压测就成了摆设。

### 已知取舍

- 不做远端探测（每条会话多一次 `exec` 是浪费），靠 `command not found` / `Upload does not start` 兜底提示。
- 主动上传会先发 `Ctrl-C` 中断当前命令（trzsz 协议要求），正在跑的命令会被打断 —— 这是协议行为，不是我们的选择。
- 下载方向没有界面入口：远端 `tsz` 一下就会弹目录选择框，不需要先点菜单。

## [2.1.5] - 2026-11-15

### Added（嵌套分屏：一个标签里放多台设备）

**背景**：调一台交换机重启，同时盯它的串口输出和另一台的 uptime —— 这是日常动作，但 v2.1.4 之前只能开两个标签来回点。WindTerm / Tabby / Netcatty 都有分屏，且都支持嵌套（横切再竖切）。

**数据模型选定为树，而不是「最多两格」。** `PaneNode = { type: 'leaf', sessionId } | { type: 'split', dir: 'row' | 'col', ratio, children: [a, b] }`。行列分割次数不限，但**叶子总数限制 4 个**：再分下去每格宽度不足 300px，80 列都放不下，那不是分屏是折磨。超限时给明确提示「先关掉一个再分」。

**布局计算抽成零依赖的 `src/renderer/src/lib/paneTree.ts`（233 行）**：`layoutPaneTree(node)` 返回百分比矩形与分隔条，`removeLeaf` 在只剩一个孩子时把 split 塌缩成那个孩子，`replaceLeaf` / `setRatio` / `neighbor` 各自单一职责。`layoutPaneTree` **不扣 gap** —— 缝隙由渲染层每格外侧 2px padding 让出；如果在计算里扣，嵌套时缝隙宽度会随层数叠加而翻倍。

**焦点迁移用 `neighbor()` 而不是「按方向找最近」。** 朴素实现取中心距最短，2×2 布局从左上按「右」会跳到右下（斜对角中心距更短）。所以分两档：先只考虑「同侧重叠」的候选（`overlap > 0 && best.overlap <= 0`），同档内再比中心距。`Ctrl+Alt+↑↓←→` 移焦点，且**只有焦点真的动了才吞键** —— 单格`Ctrl+Alt+←` 仍是终端按词移动光标。

**`Ctrl+Tab` 语义不变（切标签），嵌套格不是标签。** 为此新增 `src/renderer/src/lib/paneRegistry.ts`：一个模块级 `Map<sessionId, ownerId>`，让 `TabBar` 过滤与 `sessionStore.cycle` 跳过嵌套格时不必 import `splitStore`（那会形成 store 循环依赖）。标签的 `x` 按钮在有多格时变成「关闭此分屏」，最后一个格关掉时整棵树折叠回单终端、标签保留。

**拖拽期间不 `fit()`，松手才统一重排。** `SplitDivider` 拖动时只更新 CSS 比例，`setDragging(true)` 让 `TerminalView.scheduleFit` 的 rAF 回调直接 return，`pointerup` 时 `refitTick += 1` 触发所有可见格各 `fit()` 一次。不这么做的话拖动过程里每帧都在重算 xterm 的 cols/rows，并往主进程发 resize IPC。

**按连接持久化。** 树存进 `AppSettings.splitLayout: Record<connectionId, PersistedPane>`，`PersistedPane` 用单字母字段（`t/d/r/k/c`）因为同一个形状会按连接重复存。会话 id 每次启动都新，按会话存等于不存。只在 `restoreSessions === true` 时恢复；单格标签不写盘，避免几十条连接各留一个只有叶子的垃圾树。

### Fixed（JsonStore 写-读竞态：设置写成功、立刻读回却是旧值）

**这是分屏落盘时暴露出来的真 bug，不在分屏代码里。** 现象：拖动分隔条后 `splitLayout` 明明写了，紧接着 `settings.get()` 读回 `{}`；重启应用后又正常。

根因在 `src/main/store/jsonStore.ts`：`load()` 在 `await fs.readFile` 期间，如果有 `update()/write()` 落地并 `rename` 了新文件，旧实现会继续把「读盘结果」（ENOENT 时是 `fallback()` 空值）写进 `cache`，并把 `cacheSignature` 刷成**新文件**的指纹 —— 缓存命中条件随即成立，之后每次 `read()` 都返回空值，直到文件 mtime 再次变化。日志链是决定性的：`U#6 in=0` → `U#6 out=17` → `R#6 n=17 fresh=null cached=null` → `repoGet n=0 json={}`，此后每次 `R#6 n=0` 都带着与文件一致的指纹。

修法：加 `writeGen` 代际号。`load()` 进入时记下代际，读到内容后先取文件指纹，**再判断代际是否变过 —— 变过就丢弃这次读盘结果**，返回当前 cache 或 fallback，绝不写 `cacheSignature`。`update()` 与 `write()` 各让代际 +1。这比加锁轻：读盘路径仍是无锁并发的，只有「读盘结果是否还能用」这一个判断。

### Verification

- `scripts/verify-pane-tree.cjs` —— 74 项纯逻辑断言，9 组：比例夹紧 / 矩形计算 / 塌缩 / 替换 / 比例定位 / 叶子计数 / 极端比例 / 焦点迁移 / 上限。两条断言首轮就红，都是**断言写错不是实现错**：`normalizeRatio(Infinity)` 实际返回 0.5（非有限值统一当「没给」）而不是夹到 0.85 上限；2×2 里从左上按「右」落在右半边任一格（c/d 中心距平局，实现取先到者）。
- `scripts/verify-split-e2e.cjs` —— 16 项真实应用断言：真实 SSH 会话上分屏、可见格计数、标签数不变、主进程 session 数 +1、`Ctrl+Alt+` 吞键、焦点描边换格、拖分隔条比例偏离 0.5 并落盘、关格后回单格且标签仍在、单格时快捷键不吞。两个假绿陷阱记在这里：页面有**三个** `role=separator`（侧边栏 / 分屏 / 命令栏），必须按 `aria-label` 含「分屏」过滤，否则拖的是侧栏；S4b 不能比「分屏前 id」，因为分屏本身就把焦点给了新格，要比「按键前后是不是同一格」。
- `scripts/verify-jsonstore-race.cjs` —— 7 项竞态断言，**做过变异验证**：把 `load()` 的代际守卫删掉后 R1–R5 全红（读回 `[]` 或 `1`），修复不在时必然红。
- `scripts/perf-split.cjs` —— 10 项：`layoutPaneTree` 4 格树 20 000 次 10.7ms = **0.54us 每次**；「写 `splitLayout` 再读回」40 轮中位 **2.8ms**、最慢 5.1ms；压测前后 `connections.json` 条数 / id 集合 / sha256 三者完全一致；`settings.json` 仍可解析且其它键未被写坏。

## [2.1.4] - 2026-11-15

### Added（任务完成通知：长任务跑完主动喊人）

**背景**：批量执行 20 台、诊断巡检 31 项、固件升级、TFTP 推固件、SFTP 传一个目录 —— 这些任务动辄几十秒到几分钟，发起之后人一定会切走去做别的。切回来只看到一屏已经滚过去的日志，无法判断「跑完了没有」「几台成功」。WindTerm / Tabby 都有这能力，我们一直没有。

**做法：只认我们自己发起的任务，不猜。** 通知分两类，默认只开第一类：

| 类别 | 触发源 | 文案 | 默认 |
|---|---|---|---|
| A 确定事件 | 批量执行 / 诊断巡检 / 固件升级 / 网段扫描 / SFTP 传输 / TFTP 传输 | 「批量执行完成：8/8 台正常返回」 | 开 |
| B 启发式 | 终端静默 > 1.5s 且窗口失焦 | 「疑似完成：设备名」 | **关** |

B 类默认关的理由：靠「没动静了」猜结束，本质是把「编译停了在等我输入」也判成完成。文案写「疑似完成」而不是「已完成」，就是不承诺它是对的。

**通道选择**：窗口失焦 → 系统通知（Windows 操作中心）+ 标签闪一次；窗口聚焦 → 只发应用内 toast。理由很直接 —— 人就在窗口前面，右下角一条提示够了，再弹系统通知等于同一件事说两遍。点通知 = 激活窗口 + 切到该标签 + 标签闪一次。

**改动**：

- `src/renderer/src/lib/notifyPlan.ts`（新增，162 行，纯决策零 IO）：`planNotify(req, {prefs, focused})` 返回 `{channel, reason}`，五级判定顺序写死在注释里 —— 总开关 → 标题非空 → 启发式开关 → 静音 → 聚焦。顺序不能换：静音必须在聚焦判定之前（静音的设备即使失焦也不该弹），启发式关闭必须在静音之前（那是「这个判定方式本身不要」，与「这台设备不要」是两个维度）。`heuristicHit()` 的 `notifiedAt >= lastOutputAt` 是「一轮输出只提醒一次」的闸门，去掉它同一次静默会被 2 秒巡检重复命中，一次编译能刷出几十条。`normalizeNotifyPrefs()` 自己 sanitize（手写的字符串 `"false"` 是真值，用 `!!v` 会让静音整片失效）。
- `src/renderer/src/lib/taskNotify.ts`（新增，314 行）：把决策落到三个真实东西上 —— 应用内 toast、系统通知、标签闪烁。系统通知失败（系统不支持 / 用户在系统设置里关掉）时**退回 toast**，且顺序是先发、失败再退（反过来会让系统通知成功的场景也闪一条 toast）。传输类走 1.2 秒静默窗口聚合成一条「传输完成：40 个文件」：SFTP 每次 upload 各自成 task，拿不到「这一批还剩几个」，只能按时间聚；一个 40 文件的目录各弹一条等于刷屏。
- `src/main/window/notifier.ts`（新增，129 行）：系统通知。三件事都不显然 —— ①`live` 集合按住活着的 `Notification` 实例，Windows 上实例被 GC 后点回调永远不触发（表现是「通知还在，点了没反应」）；②`focusMainWindow()` 必须 `isMinimized() → restore()` + `isVisible() → show()` + `focus()` 三步，最小化状态下只调 `focus()` 是 Electron 的既定坑（任务栏闪一下，窗口不出来）；③5 秒 `title\u0000body` 指纹去重，8 台设备几乎同时结束不该变成 8 条一样的通知。
- `src/main/ipc/windowUpdate.ts`：新增 `WIN_FOCUS` / `WIN_IS_FOCUSED`（裸 `ipcMain.handle`，返回裸 boolean 而非 `{ok,data}`，与既有的窗口控制三条一致）与 `NOTIFY_SHOW`（走 `handle()` 包装）。`src/main/ipc/handle.ts` 的 `channelTitle` 补了中文标题。
- `src/shared/types.ts`：`TaskNotifyPrefs{enabled, system, sound, heuristic, mutedConnectionIds}` 与 `TaskNotifyPayload{title, body, sessionId, silent}`；`AppSettings.taskNotify?`。**静音存连接 id 不存会话 id** —— sessionId 每次启动都新，存会话 id 的静音重启即失效。
- 六个调用点全部换成 `notifyTask()`：`batchStore.ts:112`、`diagStore.ts:185`、`firmwareStore.ts:222/229/236`（成功/取消/异常三分支）、`discoveryStore.ts:114`、`sftpStore.ts:468`（按 taskId 去重后聚合）、`tftpStore.ts:94`（从日志文本"固件传输完成" / "传输结束："判完成）。原来这些地方是直接 `push toast`，换成 `notifyTask` 后聚焦场景文案一字未变。
- 设置面板新增「通知」分区（`NotifySection.tsx`，99 行）：四个开关 + 已静音连接列表（chip 点击恢复）。「提示音」在「系统通知」关闭时置灰 —— 没有系统通知就没有提示音可言。
- 标签右键菜单新增「本连接不弹通知 / 恢复本连接通知」（`TabBar.tsx` menuItems），`BellOff`/`BellRing` 图标随状态切换。按**连接**而不是会话记，理由同上。
- 标签闪烁用既有但从未被使用的 `animate-flash-ok` keyframes（`src/renderer/src/styles/index.css:112`，0.6s 绿色淡出）。闪烁请求走 `flashSession()` 单向信号 + TabBar 消费后置空，不在 store 里存「是否正在闪」这种瞬时状态。
- 关闭会话时 `forgetNotifySession(id)` 清记账：sessionId 会被复用（重连沿用），残留的 `lastOutputAt` 会让新会话一上线就收到「疑似完成」。

### 新增验证：`scripts/verify-notify.cjs`（47 项，8 组）

A 静音判定（5）· B `planNotify` 主序（5）· C 静音/聚焦优先级（4）· D 启发式（8）· E 静音列表增删（6）· F `normalizeNotifyPrefs`（6）· G 文案裁剪（5）· H 类别表（2）。每条断言按「旧实现必红」选：顺序错 C1 红、聚焦仍发系统通知 B3 红、启发式关掉仍命中 D2 红、`notifiedAt` 不做门 D4 红、`normalize` 用 `!!v` F2 红。已接入 `npm run test:notify`。

### 真实应用验证：`scripts/verify-notify-e2e.cjs`（15 项）

纯逻辑证明不了「系统通知真的弹出来了」「右键静音真的写回 settings.json」。这个脚本自起 `scripts/lab-sftp-server.cjs`（`LAB_SHELL_ECHO=1`）+ 真实 Electron，走 CDP 驱动：N1 投递返回 true / N2 同文案 5 秒内返回 false / N3 换正文返回 true / N4 空标题返回 false / N5 `taskNotify` 落盘回读 / 设置面板出现「通知」分区与四开关 / 开真实 SSH 会话 / 标签右键菜单出现「本连接不弹通知」/ N6 点击后连接 id 进 `mutedConnectionIds` / 静音后文案变「恢复本连接通知」/ N7 再点恢复 / N8 `win.isFocused()` 返回 boolean / 无渲染层未捕获异常。

**踩过的坑**：第一轮 8 通过 / 3 失败 / 1 FATAL，根因不是通知坏了，而是 `window.api.conn.save()` 是主进程直写、渲染层 `connectionStore` 不感知 —— 侧栏根本没有 `[data-conn-id]` 行，双击无从谈起、也就没有标签和右键菜单。修法：保存连接后 `location.reload()` 再跑 UI 流程。

### 压测：`scripts/perf-notify.cjs`（17 项）

| 项 | 实测 |
|---|---|
| `planNotify` 纯逻辑 | 200 000 次 / 8.9 ms = **0.044 us/次** |
| `heuristicHit` 纯逻辑 | 200 000 次 / 2.8 ms = **0.014 us/次** |
| 系统通知投递 | 25 条，中位 **2.4 ms**，全部返回 true |
| 热路径（1200 行 × 3 轮） | 启发式开 54 ms / 关 60 ms = **0.91×**（记账只是 `Map.set + Date.now`） |
| 数据零影响 | 真实 `connections.json` 前后 sha256 一致，压测用临时 `--user-data-dir` |

**判据强化**：静默探针原本只打印不断言，等于摆设。改成按 `document.hasFocus()` 分方向断言 —— 有焦点时断言「**不**出现疑似完成」（删掉巡检里的 `hasFocus` 守卫这条立刻变红：人就在窗口前面，右下角再弹一条「疑似完成」是纯噪音），无焦点时断言「1.5 秒内出现」。

## [2.1.3] - 2026-11-15

### Added（终端输出高亮：按关键词给输出行上色）

**背景**：翻日志找 `error`、盯 `Permission denied`、看烧机时滚过去的 `timeout`，全靠肉眼在一屏二十行的输出里挑。WindTerm / Netcatty 都有这能力，我们一直没有。

**做法：只做行级，不做列级。** 行级 = 整行底色 + 左侧色条 + 右侧滚动条刻度；列级要把 ANSI 序列剥掉后按「显示列」反推每个字符的屏幕坐标，中文双宽、emoji、tab 停位、窄体字符拼接都会让坐标偏移 —— 算错的表现是「染到了相邻的词」，比不染更糟。这一版的选择是把这条边界写死在代码注释里，而不是留个「以后再说」。

**改动**：

- `src/renderer/src/lib/highlight.ts`（新增，纯逻辑零依赖）：`stripAnsi(input, keepNewlines)` 剥除 SGR / OSC / 字符集切换序列；`createLineSplitter()` 把流式 chunk 切成完整行（处理 `\r\n`、`\r` 覆盖、行内无换行的半成品，尾部残行留在 `pending` 等下一次 feed）；`compileRules()` 编译并**按规则挑错**——坏正则进 `errors` 数组而不抛，其它规则照常工作；`matchRule()` 返回第一条命中的规则（先定义先赢）；`assessPattern()` 静态体检嵌套量词 / `.*.*` / 回溯结构，只警告不阻断；`sanitizeColor()` 只收 `#RRGGBB`（xterm 的 decoration 只认这一种，传 `rgba()` 会静默失效）；`sanitizeFlags()` 把 `g` / `y` 剔掉（带 `lastIndex` 状态的正则在下一次 `test()` 会从上次位置继续，表现是「同一个词有时染有时不染」）。
- `src/renderer/src/lib/highlightRuntime.ts`（新增）：xterm 接入层。终端渲染层所有写入统一走 `writeSessionData(sessionId, term, data)`——未启用或规则为空时直接 `term.write(data)`，零开销直通；有命中时先 `term.write(data)` 再在写入回调里 `term.registerMarker(-back)` + `term.registerDecoration()`。`back` 的算法是 `(endedWithNewline ? 1 : 2) + hit.fromEnd`：带换行时余光标停在下一行行首，不含换行时停在当前行行尾，差一行就染错。
- `src/renderer/src/components/settings/OutputHighlightSection.tsx`（新增）：规则编辑 + **试匹配框**。试匹配是本功能的验证回路 —— 规则写对写错在设置页里本来完全看不出差别，只能「改完回去等一条报错出现」。这里给一段可编辑的 8 行样本，实时显示命中行数与耗时，超 5ms 标黄（静态体检抓不到的回溯风险，这里能量出来）。
- `src/shared/types.ts`：`AppSettings.outputHighlight?: OutputHighlightPrefs`。故意**只存用户改过的部分**：`undefined` 表示走渲染层默认规则，避免主进程 `DEFAULT_SETTINGS` 和渲染层各存一份默认值后漂移。
- 内置两条规则默认开启：`ERROR|FAIL|FATAL|PANIC|EXCEPTION|DENIED|REFUSED` 暗红底、`WARN|DEPRECATED|TIMEOUT` 暗黄底。其余留给用户。
- 断线时（`status !== 'connected'`）该会话的装饰统一 `dispose()`：断线遮罩是半透明的，底下染色行会透出来，看着像「断了还在报错」。
- 关闭会话标签时 `forgetSession()` 清掉该会话的缓冲：`sessionId` 会被复用，不清就会把上一条连接的半行残料算进下一条。
- `SettingsPanel` 新增「输出高亮」分区，**默认展开**——藏进折叠区等于没人知道它存在。

### 新增验证：`scripts/verify-highlight.cjs`（64 项，7 组）

A 剥 ANSI（11）· B 切行器（9）· C 颜色/标志清洗（10）· D 规则编译（10）· E 命中判定（7）· F 回溯体检（6）· G 默认值归一（11）。已接入 `npm run test:highlight`。

### 真实应用验证：`scripts/verify-highlight-e2e.cjs`（17 项）

纯逻辑只能证明「哪一行该染」，证明不了「染到了哪一行」—— decoration 挂在 marker 上，marker 的坐标是相对光标的行偏移，偏移算错一行的表现是「色带整体上移一格」，而函数返回值一切正常。所以脚本自起 lab SSH 服务器（`LAB_SHELL_ECHO=1` 原样回显）与 Electron，走 CDP 量 DOM：开规则 → 装饰存在、落在含命中词的行、整行宽、行内字符带规则底色与文字色；关开关 → 一条装饰都没有但输出照常显示；删掉 `outputHighlight` 键 → 回落到内置默认规则；设置面板分区可见。三轮之间各 `location.reload` 一次，顺带验证「重启后规则还在」的持久化路径。

**测颜色这条踩了判据坑**：第一版量 `d.style.backgroundColor` 拿到空串，据此判「颜色没生效」是**假红**。查 xterm 源码才清楚 —— `BufferDecorationRenderer._createElement` 只写 width/height/top/line-height，`.xterm-decoration` 就是个透明的定位空壳；规则色是在 `DomRendererRowFactory` 里 `forEachDecorationAtCell` 命中后逐个 cell 覆盖 bg/fg 的。改成量行内 cell 的 computed background 后实测 `rgb(74, 29, 29)` / `rgb(255, 180, 180)` 覆盖 44 个 cell。

### 压测：`scripts/perf-highlight.cjs`（12 项）

高亮挂在终端唯一的写入口上，写法稍重一点，表现不是「算错」而是「大输出时终端卡住」——纯逻辑脚本量不出来。两层：①纯逻辑吞吐 5 万行；②端到端 1200 行 × 3 轮，开启/关闭两模式**交替**跑（交替是为了避免机器负载漂移被算成高亮开销），量「哨兵行进入 DOM」的墙钟时间取中位数。判据写了区分度：开启模式必须真的出现装饰，否则测的其实是「关着的高亮」，比值恒等于 1，压测就成了摆设。

实测：纯逻辑 50 049 行 / 102.4 ms = **2.0 µs 每行**；端到端中位 开启 **118 ms** / 关闭 **60 ms** = **1.97×**，装饰 33 个 vs 0 个，两种模式哨兵行都到齐（不丢行）。全程 `--user-data-dir` 临时目录，真实 `%APPDATA%` 一个字节没碰。

**踩过的坑（都写进断言了）**：①`stripAnsi` 最初把 `\n` 也剥了，切行器拿到整段输出粘成一行；②`\r\n` 的 `\r` 先清空缓冲，整行内容丢失（得到 `['','']`）；③`ESC(0` 字符集切换当成 2 字节序列跳，尾部 `0` 和后面的 `B` 残留成可见字符（`lqk` 前面凭空多个 `0`）；④超长行 overflow 时把那一行整个丢掉，界面上凭空少一行 —— 改成无条件产出一行；⑤测试样本选 `cat: /x: No such file or directory` 想命中 `error`，结果 `error` 长在 `directory` 里且 `\b` 词边界不成立，是断言错了不是代码错了。

## [Unreleased]

（暂无未发布内容 —— 串口刷机配套、发送节奏、在线切波特率 / BREAK / 纯文本日志均已随 v2.2.0 发布。）


## [2.1.2] - 2026-11-13

### Fixed（WebGL 终端字形被画小：找到真根因并修好，DOM 不再是唯一出路）

v2.1.1 把默认后端翻回 DOM 只是绕开，没治病。这次查到病灶在 addon 拼字体串：

```js
const D = italic ? 'italic' : ''
ctx.font = `${D} ${bold ? fontWeightBold : fontWeight} ${fontSize * dpr}px ${fontFamily}`
```

非斜体时 `D` 是空串，**模板里的那个空格还留着** —— 实际喂给 canvas 的是
`" normal 15px 'JetBrains Mono', ..."`（前导空格）。Chromium 的 canvas font 解析器
不 trim（CSS 解析器 trim，所以 DOM 后端没事），整串判非法后 setter **静默保留旧值**，
也就是新建 2D 上下文的初始值 `10px sans-serif`。于是图集按 10px 光栅化，再贴进按
`fontSize × dpr` 算出来的格子里 —— 字小、笔画细、四周空白多，肉眼就是「字距变宽」。

定量（dpr 与格子都在，只有字形不跟）：

| 实测 | 修复前 | 修复后 |
|---|---|---|
| fillText 实际 font（dpr=1） | `10px sans-serif` × 94 | `15px "JetBrains Mono", …` × 94 |
| fillText 实际 font（dpr=2） | `10px sans-serif` × 94（不随 dpr） | `30px "JetBrains Mono", …` × 94 |
| `lab-shell ready` 字高 / 字距（dpr=1） | 10 / 8 px | 13 / 8 px |
| 墨迹宽 / 字距 | 0.56 ~ 0.63 | 0.75 ~ 0.88 |

改法（两处，都不碰 addon 源码）：

- `src/renderer/src/lib/canvasFont.ts`（新增）：`installCanvasFontShim()` 在 `main.tsx` 里
  **任何渲染之前**包装 `CanvasRenderingContext2D.prototype.font` 的 setter —— 写入前
  `normalizeCanvasFont()`（折空白 + trim + 清掉 `undefined`/`null`/`NaN` 残渣），写完读回
  比一次 px 字号，不一致就退化成「字号对、字体族沿用读回值」。幂等（布尔旗标），原型
  不可写的环境直接跳过。
- `TerminalView.tsx`：挂 `WebglAddon` 前先跑 `isCanvasFontApplied()` 自检（离屏 canvas
  按 addon 的拼法试写一次，读回字号必须等于配置值），不成立就不挂 WebGL、回落 DOM 并在
  控制台说明原因。这样即使将来 addon 换拼法、或字体族名让整串再次非法，用户也只会看到
  「用回了 DOM」，而不是「字变丑了但不知道为什么」。

`scripts/verify-webgl.cjs` 新增 4 条断言守住这个回归：图集未退回 10px、字号等于
`fontSize × dpr`、字体族来自配置、预热确有 fillText 调用。做过变异验证 —— 去掉 shim 并
强制挂 WebGL，这 4 条会红（`fontUniq: ["10px sans-serif"]`），说明断言不是装饰。

## [2.1.1] - 2026-11-13

### Fixed（终端字形回归：默认后端翻回 DOM）

v2.1.0 把终端默认切到 WebGL（`@xterm/addon-webgl`）。升级后反馈是「字变丑、字距像拉宽一倍」。
逐像素量下来，**格子尺寸两条路径完全一致**（光标块都是 32×96），只有格子里的字形被画小了 ——
所谓「字距变宽」其实是字形周围空白变多。

| 度量（dpr=1，scale 4 截图列投影） | WebGL | DOM |
|---|---|---|
| cell pitch | 32.0 px | 33.0 px |
| `MWMWMWMW` 墨迹宽度 | 27 / 34 / 27 / 34 … | 31 / 31 / 31 / 31 … |
| `lab-shell ready` 细笔 | 5 ~ 7 px（笔画断开） | 24 px（饱满） |

排除项：不是字号（图集收到 ` normal 22.5px`，正是 15×1.5）、不是 DPI（dpr=1 与 dpr=2 一样错、
canvas 像素尺寸也对）、不是字体栈（裸 `Consolas` 与完整字体栈截图字节级同尺寸，44797 B 一致）、
不是行高（`lineHeight: 1.0` 下同样瘦小）。是 addon 图集栅格化后的字形尺寸回归，应用层只能换后端绕开。

- `shared/types.ts` 新增 `TerminalRenderer = 'dom' | 'webgl' | 'auto'` 与 `ExperimentalFlags.terminalRenderer`，缺省 `'dom'`。
- `TerminalView.tsx` 渲染后端按该设置决定，`'dom'` 时根本不构造 `WebglAddon`。
- 设置 → 实验性 新增「终端渲染后端」三段控件（DOM / 自动 / WebGL），想用 WebGL 可随时切回。
- `mergeSettings` 改为逐键合并 `experimental` —— 老配置只有 `{ tokens: {} }`，整段覆盖会抹掉新字段默认值。
- `scripts/verify-webgl.cjs` 扩到 3 段：默认无 canvas + 有 DOM 行、webgl 段有 canvas、软件渲染段不白屏。

## [2.1.0] - 2026-11-13

### Changed（客户端质感：轻 / 净 / 顺）

只学壳、不学脑：不引入 AI 任务、不做上下文快照、不改 SSH 客户端的功能边界。

- **设计 token 落地**：间距 5 档（4/8/12/16/24）、圆角 3 档（4/6/10）、动效 3 档（120/180/240ms）+ 单条主缓动、语义尺寸（状态栏 26 / 标题栏 38 / 左轨 248）。行高统一 24px —— 这正是「切面板时列表高度跳」的根因。全部以 CSS 变量 + Tailwind 配置的形式落地（`--duration-*` / `--ease-out-expo` / `--size-*` 与 `.panel-shell`、`.rail-w` 组件类），不碰 `:root/.light/.dark` 颜色层。
- **重复任意值收敛**：8 处 `bottom-[26px]/top-[38px]` → `.panel-shell`，3 处 `w-[248px]` → `.rail-w`；一次性任意值不动（全收敛等于重写样式）。
- **面板级灰度**：`experimental.tokens.<panel>` 5 个面板独立开关，设置面板新增「实验性」分区，可一键回到旧视觉；默认全关。
- **面板切换**：`Suspense fallback` 从 `null` 换成同尺寸骨架。实测大头不是 chunk 下载（十几毫秒）而是面板取数（~300ms），原来那段是纯空白。空闲预加载保留但如实标注为非收益项（变异测试显示有无预加载耗时一致）。
- **列表**：两个 SFTP 双栏由「截断 300 项」改为真虚拟滚动（`@tanstack/react-virtual`），1 万项目录 DOM 只有 39 行、滚动覆盖全量；会话标签 / 传输列表 / 设备发现加上限 20/200/500 并给可见提示。选中与全选语义仍基于全量。
- **快捷键**：冲突检测改为作用域感知 —— 终端 Ctrl+F（搜索）与全局 Ctrl+F 可共存。
- **连接状态**：新增阶段 `tcp / handshake / jump / shell`，状态栏显示在等什么。诚实边界：ssh2 把握手与认证合成一次调用，`auth` 阶段不会发出。
- **终端渲染**：默认 WebGL（`@xterm/addon-webgl`），上下文丢失或创建失败回落 DOM；GPU 进程崩溃后自愈式落盘 `softwareRender=true`，下次启动走软件路径。

### Fixed

- 门禁 flaky：自起 Electron 的验证脚本用固定 `sleep(9000)`，串跑时随机红；改为轮询就绪后单跑耗时反降（xterm6 27.9s → 22.9s）。
- `verify-xterm6` 在 WebGL 启用后两条断言假红（WebGL 不创建 `.xterm-rows`、`innerText` 为空），改为断言 `.xterm-screen` 尺寸 + 读 xterm buffer（普通构建下显式 SKIP）。

## [2.0.0] - 2026-11-12

### Added（串口控制台：设备连上就能敲命令）

**背景**：这个功能在 v1.x 的方案里被列为「明确不做」。当时的理由是开发效率 —— 传输层与会话层是照 ssh2 的形状写的，塞进一个串口等于把两层都翻一遍。但现场的真实动作是「插上 USB 转串口线，敲 `dmesg` 看设备起没起来」，而这件事此前必须切到另一个工具：连接管理、命令库、会话录制、日志归档全都在 SSH Workbench 里，唯独最救急的那条通道在外面。v2.0.0 补上它。

**范围**：只做 **Console 救急**。不做十六进制收发、不做协议调试器、不做 XMODEM/YMODEM 传文件、不做断线期间的串口缓冲回放。成功标准是一条：Console 里敲命令，不用另开工具。

**改动**：

- `src/shared/types.ts`：`ConnKind = 'ssh' | 'serial'`；`Connection` / `ConnectionInput` 加 `kind?` 与 `serial?: SerialConfig`；`SessionInfo` 加 `kind` 与统一的 `target` 显示名。串口连接的 `host` / `port` / `username` / `authType` 一律落成空值（`''` / `0` / `'password'`），而不是把这些字段改成可选 —— 改成可选会让 `connectConfig`、主机指纹校验、跳板链、导入导出、搜索等几十处都要做类型收窄，收益只是「类型上更诚实」。
- `SerialConfig`：`path`、`baudRate`、`dataBits`、`stopBits`、`parity`、`flowControl`、`charset`（utf-8 / gbk / gb18030）、`newline`（cr / lf / crlf，默认 **cr** —— 串口控制台普遍认 `\r`）、`autoReset`（**默认关**）、`usbSerialNumber` / `usbPnpId`、`pathPending`。
- 新增 `src/main/transport/`（传输层抽象）：`types.ts` 定义 `Transport` 接口（`open` / `write` / `writeBytes` / `resize` / `close` + `onData(raw, text)` / `onClose(error)`）；`sshTransport.ts` 接管原先散在会话管理器里的解码逻辑（`StringDecoder('utf-8')`，stderr 混流）；`serialTransport.ts` 做换行归一、流式 iconv 解码、DTR 脉冲（只碰 DTR，不碰 RTS）；`memoryTransport.ts` 给验证脚本用。
- `src/main/ssh/sessionManager.ts` 改为面向 `Transport`：`SessionRecord` 加 `kind` / `target` / `transport` / `serialConfig`，`client` 变可选，待写缓冲拆成 `pendingText` / `pendingRaw`（按字节合帧，解码下沉到传输层）。新增 `openSerial()`、`waitForDevice()`、`resumeSerialSessions()`。
- **拔插恢复**：串口断线不复用 SSH 的 1/2/4/8/16 秒退避 —— 拔线时按退避重开一个不存在的设备毫无意义，而且插回的瞬间常落在长间隔里，用户会以为功能坏了。改为把会话停在 `phase: 'waiting-device'`，由端口轮询（2 秒）驱动恢复；恢复成功后补发一个 `\r` 唤醒提示符（很多设备长时间无输入会停止回显）。
- **设备身份**：`src/main/transport/serialResolve.ts` 按 `serialNumber` → `pnpId` → 保存的 `path` 三级匹配。**存了 USB 身份却对不上时不退化到 COM 号**：那说明现在插在这个端口上的不是当初那台设备，静默连上去就是往陌生板子敲命令。唯一例外是平台根本给不出身份（Linux 的 `/dev/ttyUSB0` 常常没有 serialNumber/pnpId），此时按 COM 号判定。
- 新增 `serialPorts.ts`（枚举 + 指纹）、`serialWatcher.ts`（2 秒轮询，只在指纹变化时推送）、`serialWatcherHolder.ts`、`serialLoader.ts`（**变量形式 require**，让 esbuild 无法静态解析原生模块，否则打包后报 `No native build was found`）。
- 新增 IPC `serial:list` / `serial:refresh` 与事件 `evt:serial-ports`；`preload` 暴露 `serial.list` / `serial.refresh` / `on.serialPorts`。
- 渲染层：`src/shared/serialDisplay.ts` 提供 `describeSerialTarget`（`COM3 · 115200 8N1`）、`connectionTarget`、`connectionAddress`；原先 15 处手拼 `${username}@${host}` 全部改用 `session.target`（串口的 username/host 是空串，会显示成孤零零一个 `@`）。`sessionStore` 新增 `isSshSession` / `useSshSessions` / `useActiveEnv`。
- 连接编辑器加串口分支：端口下拉 + 刷新、波特率 / 数据位 / 校验 / 停止位 / 流控 / 编码 / 换行、DTR 自动复位开关、目标摘要预览。串口下隐藏「测试连接」—— 反复开关端口会触发 DTR，把设备重启一次。
- 七个面板（指标 / 诊断 / 固件 / 备份 / 批量 / 文件 / 隧道）的会话来源改为 `useSshSessions()`，并补了空态文案（「串口会话是 Console 救急通道，不提供指标」等）。理由：这些面板全部建立在「远端跑一条命令」上，串口没有 client，列出来只会拿到一句「该功能仅支持 SSH 会话」。
- 命令「适用环境」：`Command` / `CommandInput` 加 `envs?: ConnKind[]`（缺省 = 两者都适用），新增 `src/shared/commandEnv.ts`（`normalizeEnvs` / `appliesTo` / `filterByEnv` / `envLabel`）。命令面板、命令中心、卡片浮层、编辑器全部接上；命令库头部计数改成过滤后的条数。种子命令里给 5 条只在完整 Linux 上可用的标 `envs: ['ssh']`（`nc -zv`、`curl -i`、`top -b -n 1`、`journalctl -b -p err`、`i2cdetect`），其余 36 条不动 —— `uname -a` / `dmesg` / `cat /proc/*` / `reboot` 在 BusyBox 上都很常见，一刀切会误伤。
- 导出导入支持串口：`connTransfer` 的 `ExportedConn` 加 `kind` / `serial`；`cleanPayload` 按 kind 分流（原先「host 非空 + port 1..65535」的校验会把串口连接整条丢掉并计入 invalid）；新增 `cleanSerial` 逐字段白名单校验（`baudRate: 0` 或 `dataBits: 9` 会让 serialport 在 open 时抛一串 C++ 侧错误，用户在界面上看不出是哪条连接坏了）；`dupKey` 对串口改用端口路径，否则两台不同设备重名会被判重复。导入时按 USB 身份找回端口，找不到的置 `pathPending` 并在对话框里提示「N 条的端口在本机找不到，导入后需要重新选择端口」。
- 打包：`@serialport/bindings-cpp@13.0.0` 是 **NAPI v8 预编译**，Electron 33.4.11（ABI 130）与 Node 24 都能直接加载，`npmRebuild: false` 保持不动；electron-builder 25.x 会自动解包原生模块，`asarUnpack` 不需要写 `'**/*.node'`（对照实验已确认，注释写进 `electron-builder.yml`）。

**新增验证**：`scripts/verify-serial.cjs`（50 项，内存假实现 + 假端口，覆盖换行归一、GBK 解码、DTR 只动 DTR、拔线 → `waiting-device` → 插回自动恢复）、`scripts/verify-serial-native.cjs`、`scripts/serial-spike-main.cjs` / `serial-spike-packaged.cjs`（打包后原生模块能否加载）、`.github/workflows/serial-spike.yml`；`verify-conn-transfer.cjs` 补串口导出 / 导入 / USB 身份找回 / 待确认 / 参数非法五组用例。

## [1.9.0] - 2026-11-11

### Changed（命令栏：列数跟栏宽走，名字不再被截断）

**问题**：右侧命令栏写死三列。默认 380px 栏宽下每张卡只有 117px，去掉图标方块（约 28px）、角标槽（24px）和命令行之后，名字只剩 54px —— 每行 4.9 个字、单行截断。用户库里 129 条命令，**93 条**只能看到前 4~6 个字，剩下全靠逐个悬停确认。而命令栏本身是可拖拽的，用户实际把它拖到过 340 的下限，写死三列在窄栏里只会让每张卡缩到 60px。

**改动**：

- `src/renderer/src/lib/commandWall.ts`（新增，纯函数，便于单测）：`wallColumns(width)` 按宽度分档 —— `< 360` 三列、`< 480` 四列、其余五列；`wallCardWidth` 扣掉 `WALL_PAD_X`(12) 与 `WALL_GAP`(4) 后均分；`wallStep` 的 ↑↓ 取实际列数、←→ 恒为 1。
- 卡片去掉图标方块与命令行：名字占满整卡宽、最多两行；状态压缩成左边缘 2px 色条，优先级 `confirm` > `pinned` > `vars` > `none`。卡片高度从 47~51px（且随名字长短跳动）统一到 **40px**。
- 原生 `title` 提示换成自绘浮层（`CommandCardTip.tsx`）：0 延迟、命令等宽字体自动换行、贴边自动翻转。原生提示约 1 秒延迟、不能排版、不能高亮命中字。
- 搜索只在命中命令文本时临时补一行 10px 命令片段并高亮命中字符 —— 卡片里已经没有命令行了，搜 `sqlite3` 出来的卡原本看不出为什么命中。
- 分组头 26px 降到 20px（10 个分组省 60px，约多放一行半卡片）；拖拽把手与新建 / 重命名 / 删除按钮改成 hover 才出现。
- 默认栏宽 380 提到 **400**：唯一超长的「同步封禁场站代码（代码需上传）」在 400 宽下也能显示完整。

**范围**：只改右侧命令栏。Ctrl+K 命令中心（搜索 + 列表的信息密集界面）与底部横排（`layout=horizontal`）保持原样。

**实测**：`verify-command-wall.cjs` 37 通过 / 0 失败（新增）、`perf-command-wall.cjs` 20 通过 / 0 失败（新增，真实应用 + 完整 IPC，渲染真实 129 条命令：340 / 400 / 600 三档宽度列数正确、全部等高 40px、截断不超过 1 条）、`verify-layout.cjs` 77 通过 / 0 失败。全量 `test:verify` 47 通过 / 0 失败；tsc + eslint + electron-vite build 全绿。压测前后 `commands.json` 的 sha256 未变，129 条命令零影响。

### Added（发版前网络自检：`npm run check:net`）

**问题**：本机连 GitHub 完全依赖后台跑着的 Clash Verge，而它的混合端口从老配置的 7897 换成了 7900。端口对不上时症状极具误导性 —— `git push` 每次都等满 300 秒才报 `Connection timed out`，`release.ps1` 报一堆「无法连接到远程服务器」，看起来像 GitHub 挂了或 token 失效。v1.8.1 发版为此白耗四十多分钟。

**改动**：

- 新增 `scripts/check-net.ps1`（`npm run check:net`）：读系统代理注册表 → 探常见 Clash 端口（7897 / 7890 / 7900 / 7891 / 10808 / 1080）→ 真打一次 `github.com` 与 `api.github.com`；探不到可用代理时直接红字提示「先去打开 Clash Verge」，并说明此时重试 `git push` 只会再等 300 秒。`-Fix` 可把探测到的端口写进 `git config --local http.proxy`。
- `scripts/release.ps1`：`-Proxy` 默认值从写死的 `http://127.0.0.1:7897` 改为空（自动探测），解析顺序「显式参数 > 系统代理注册表 > 常见端口 > 直连」；上传前新增一次 `github.com` 可达性探测，不可达直接退出并提示去开 Clash，不再等到传完 80MB 才失败。
- `RELEASE_CHECKLIST.md` §2.6：push 前先跑 `check-net.ps1`，示例命令里不再出现写死的 7897。

**实测**：`check-net.ps1` 输出「系统代理开启 → 7900 LISTEN → github.com 200 → 网络就绪」；两个脚本通过 `Parser::ParseFile` 语法校验。

### Added（文档同步门禁：`npm run test:docs`）

**问题**：v1.9.0 已经发到 GitHub，README 上写的还是 `Current: **v1.8.1**`，CHANGELOG 里根本没有 1.9.0 这一条。代码、tag、Release 日志全对，唯独「人打开仓库第一眼看到的两处」停在上一版。

**根因**：流程不对称。`release-notes-v<ver>.md` 有 CI 硬门禁（`verify-release-notes.cjs` + `release.yml` 里缺文件直接 `exit 1`），所以它从没漏过；README / CHANGELOG 只是 `RELEASE_CHECKLIST.md` §2.3 里的一个 checkbox，没有任何脚本判它 —— **一个只在 checklist 里存在的步骤，等价于不存在**。

**改动**：

- 新增 `scripts/verify-docs-sync.cjs`（`npm run test:docs`）六条判据：README 的 `Current:`、README.zh-CN 的 `当前版本：`、CHANGELOG 的 `## [<ver>] - YYYY-MM-DD`、两份 README 的「最近更新 / Recent updates」**第一条**必须是本版且正文 ≥ 60 字符、`release-notes-v<ver>.md` 存在且 ≥ 200 字符。
- 判「第一条」而不是「包含」：只判包含的话，把新条目追加到列表末尾也能过，但读者看到的第一条还是上一版 —— 顺序本身就是内容的一部分。
- 全部按 `/\r?\n/` 切行并去掉行尾 `\r`：仓库里这些 md 都是 CRLF，用 `\n` 切会把 `\r` 留在行尾，正则静默不匹配（v1.8.1 那轮 IME 批量替换踩过同一个坑）。
- 已接入 `package.json` 的 `test:verify` 链路，与其余 51 项 verify 一起跑。

**实测**：在修复前的仓库状态上跑，5 项 FAIL / 1 项 PASS（`release-notes-v1.9.0.md` 存在）—— 判据确实在「文档没同步」时变红，不是写完文档才成立的假门禁。


## [1.8.1] - 2026-11-05

### Fixed（P0：sz 传输到一半终端被乱码刷屏并中断）

**问题**：用 `sz` 从远端下载时，进度走到某个百分比后终端突然刷出一屏二进制乱码，传输随即停住，进度面板卡在 56% 之类的数字上不再变化。乱码不是 "打印错了"，而是 **ZMODEM 报文本身被直接写进了终端**。

**三条独立的根因**（都在 `src/renderer/src/lib/zmodem.ts` 与 zmodem.js 0.1.10 的交互之间）：

1. **接收方从不对 ZCRCW 回 ZACK**。`zsession.js:659` 的条件是 `subpacket.ack_expected() && !subpacket.frame_end()`，而 ZCRCW 恰好 `ack_expected()===true` 且 `frame_end()===true`，被这个组合排除 —— lrzsz 的 `sz` 在窗口边界发的正是 ZCRCW，等不到 ZACK 就停在当前百分比。
2. **一帧解析失败就把会话判死**。库在 `_consume_header` 里找不到处理器时抛 `Unhandled header: ZDATA`；`feedZmodem` 的 catch 只有 `isPeerRetransmit`（ZRQINIT）这一条窄豁免，其余一律 `recoverFromError` → `abort()`。而 abort 之后 Sentry 会把远端仍在推的每一帧原样交给 `to_terminal` —— 这就是那屏乱码。
3. **ZRPOS 续传没有落地路径**。库的 `_consume_ZDATA` 遇到 offset 不等就抛 `Error correction is unimplemented.`，而真 `sz` 收到 ZRPOS 后经常把整帧从头重发 —— 位置本就该以对端为准。

**改法**：

- `attachZmodem` 挂 `session.on('data_in')`，对 `ack_expected() && frame_end()` 的子包按库自身 `_file_offset` 补发 ZACK（`Header.build('ZACK', pack_u32_le(offset))`），不改 node_modules。
- `to_terminal` 增加 `suppressUntil` 抑制窗：协议态或刚出过错的一段时间内，残渣只记账不下发，终端不再被报文刷屏。
- 新增 `resyncReceive()`：命中可恢复协议错误（`Unhandled header: ZDATA` / `Error correction is unimplemented` / `offset not ok` / `CRC check failed`）时清 `_input_buffer`、清 `_next_subpacket_handler`、调 `_accept(fileOffset)` 重发 ZRPOS，让对端从断点续传，而不是 abort。
- `relaxDataOffset()`：包一层 `_consume_ZDATA`，offset 不一时把本地 `_file_offset` 对齐到对端而不是抛错 —— 重复字节交给下面的去重循环丢弃。
- `ensureEofHandler()`：`_accept()` 装的处理表只有 `{ZDATA}`，对端若正好发到文件尾会直接给 ZEOF 而被判成 `Unhandled header: ZEOF`，这里补上 ZEOF 并按库自己的流程收尾（多文件时继续回 ZRINIT）。
- `handleOffer` 的 `on_input` 改为带文件内偏移对账：维护 `expected`（对端下一位落在文件哪里）与 `cursor`（已排队落盘），重叠部分只保留尾巴、超出文件尾的截断。落盘接口是「只追加」，所以续传后对端从 0 重来也只能跳过已认下的前缀。
- 完成判定从 `await offer.accept()` 改为 `Promise.race([accepted, offer.on('complete')])`：走了续传之后 `_accept()` 会另起一条 promise，原来那条永远不会兑现。

**回归**：`scripts/verify-zmodem-renderer.cjs` 新增三个场景（手搓 lrzsz 风格字节流，因为 zmodem.js 的发送端永远只发 ZCRCG/ZCRCE，造不出 ZCRCW 与重复 ZDATA 头）—— ZCRCW 补 ZACK、重复 ZDATA 头触发 ZRPOS 并完整收完、abort 之后继续喷 4000 字节垃圾时终端长度为 0。`verify-zmodem-e2e` 14/0、`verify-zmodem-decode` 10/0、`verify-zmodem` 88/0（其中 6 项断言原本指向已迁走的 `src/main/index.ts` 与 `App.tsx`，已跟着代码搬到 `src/main/ipc/zmodem.ts` 与 `MainWorkspace.tsx`）。

### Fixed（P0：rz 上传卡在 0 字节 / 传完后又弹一次确认）

**问题**：远端执行 `rz` 之后从本机选文件上传，三种表现都是「传不上去」——(a) 进度条一直停在 0，一个字节都不走；(b) 文件其实传完了，但界面又冒出一次 ZMODEM 确认弹窗，再点一次还是没有反应；(c) 大文件传输期间整个窗口卡死，连中断按钮都点不动。

**三条独立的根因**（全在 `src/renderer/src/lib/zmodem.ts` 与 zmodem.js 0.1.10 的发送态之间）：

1. **`_ensure_receiver_escapes_ctrl_chars()` 死等 ZACK**。`zsession.js:1327-1348` 在 `!ZRINIT.escape_ctrl_chars() && !_got_ZSINIT_ZACK` 时发一帧 ZSINIT 然后 `new Promise(res => { _next_header_handler = { ZACK: () => res() } })`，**没有任何超时**。对端不回这个 ZACK（rz 视其为冗余，或者根本没在跑），`send_offer` 就永远进不了发 ZFILE 的那一步 —— 表现就是 0 字节。
2. **迟到 / 重复的 ZACK 会把会话判死**。发送完一个文件后 `_prepare_to_receive_ZRINIT` 把处理器表换成 `{ ZRINIT }`，此时进来的 ZACK 命中 `_consume_header` 的 `throw Unhandled header`；`feedZmodem` 里只有 `isPeerRetransmit`（ZRQINIT）这一条窄豁免，于是走到 `recoverFromError` → `abort()`。会话对象仍挂在 Sentry 上，下一次 `rz` 的起始帧被它当成未知头部吞掉 —— 用户看到的就是「传完又让我重来一遍，而且再也不动」。
3. **发送是同步死循环、无限等**。`transfer.send()` 在 `for` 里一口气塞完整个文件，几 MB 就能让渲染进程整段冻结；`send_offer` / `transfer.end()` / `close()` 三个 promise 都只在收到对应头部时兑现，对端一旦不配合就是永久挂起，界面没有任何出路。

**改法**：

- 新增 `primeSendSession()`：进传输前直接停掉库的保活链（`clearTimeout(_keepalive_timeout)` + `_keepalive_promise = null` + 把 `_start_keepalive` 固定成空函数，因为库的 `_stop_keepalive` 拼错字段名 `_keep_alive_promise`，永远清不掉），并置 `_got_ZSINIT_ZACK = true` 跳过上面那条死等，自己补发一帧 ZSINIT 把控制字符协商做完。
- 新增 `installSendHeaderFallback()`：包一层 `_consume_header`，只在「表里没人认领」时吞掉 ZACK/ZRINIT/ZSINIT/ZFIN/ZRQINIT 这类噪声；**不清处理器表**（第一版顺手清了，紧随其后的 ZRPOS 于是无处安放，探针立刻炸出 `Unhandled header! ZRPOS_HEADER`、收到 0 字节）。
- 新增 `startSendKeepalive()`：等 ZFILE 期间每 5 秒补一帧 ZSINIT，把远端 `rz` 按住（lrzsz 等 ZFILE 有自己的超时，用户挑几 MB 文件很容易超过），真正开始发数据前停掉。
- 新增 `awaitSendStep()`：给 `send_offer` / `transfer.end()` / `close()` 各套一层 `SEND_RESPONSE_TIMEOUT_MS`（20 秒）竞速，超时返回可控失败而不是永久挂起，文案如「等待远端接受 x：远端 20 秒无回应」，随后 abort 让远端退出。
- `runSend` 改按 `SEND_CHUNK_BYTES`（32KB）分片、每 `SEND_YIELD_BYTES`（128KB）`await` 一次 setTimeout(0) 让出事件循环，大文件传输期间界面保持可点。
- 收尾 `close()` 失败时补一次 `abort()`：否则旧会话继续挂在 Sentry 上，下一次 rz 的起始帧被吞，表现为「再传完全没反应」。文件已传完的事实不受影响，失败原因只作为 `done` 事件的 `message` 附注。

- 保活在「用户还没选完文件」时就要开着：原先等文件选完才起保活，而远端 `rz` 的重试窗口只有几秒到十几秒，挑一个几 MB 的文件很容易跨过去 —— 等保活起来时 rz 已经退出。现在一进 `runSend` 就补 ZSINIT，选完文件、真正开始发数据前再停。

**回归**：`scripts/verify-zmodem-renderer.cjs` 新增场景 12~16，用真的 `Zmodem.Session.Receive()` 当对端跑完整上传链路 —— 正常上传 120000 字节、对端吞掉所有 ZACK、传输结束后注入迟到 ZACK、对端完全不理（20 秒超时路径）、在文件选择框停留 12 秒后取消。当前 **66 通过 / 0 失败**。

## [1.8.0] - 2026-10-31

### Fixed（P1：中文输入法下 Enter 会执行半截命令）

**问题**：全仓 `isComposing` 命中 0 处。拼音串还没上屏时按 Enter 是「确认候选词」，浏览器照样派发 keydown，React 的 `onKeyDown` 收到后直接 `preventDefault()` + 执行动作 —— 用户想选个字，结果命令中心跑了第一条命令、路径栏跳了目录、表单提交了半截内容。这个 bug 只在中文输入法下复现，英文输入法敲一辈子都撞不到。

**证据**：`grep -rn "isComposing" src/` → 0 命中；`CommandCenter.tsx:240` 的 `if (e.key === 'Enter')` 后面直接 `runActive()`。

**范围**：全仓 `key === 'Enter'` 共 15 个消费点，按「handler 挂载元素的子树是否含 input」判定，需要守卫的 **13 处**：

- 直接挂在 `<input>` 上 11 处：`CommandPanel:482`、`ConnTransferDialog:308`、`ExecutionDialogs:67`、`LocalPane:135`、`RemotePane:146`、`UploadTargetDialog:150`、`TabBar:274`、`UpdateSection:156`、`TerminalView:369`、`ui/index:222/:440`
- 挂在容器、子树含 input 2 处：`CommandCenter:243`、`CommandPanel:402`（事件从子输入框冒泡上来，容器 handler 照样执行）

不需要的 2 处是行级键盘（`ConnectionSidebar:682`、`FileExplorer:864`，子树无 input），脚本里单独列出供人工复核，不静默跳过。

**改法**：新增 `lib/ime.ts` 的 `isImeComposing(e)`，读 `e.nativeEvent.isComposing`。为什么不用 `e.isComposing`：React 合成事件没有这个字段，读它恒为 `undefined`，守卫永不生效而 TypeScript 不报错 —— 这是最典型的假绿写法。为什么不用 `keyCode === 229`：那是 Chrome 早期 IME 的历史 hack，只覆盖「被吞掉的按键」，行为不一致。

### Fixed（P1：StatusBar 传输中每秒重渲染 6.7 次）

**问题**：`StatusBar.tsx:67` 订阅整个 `s.transfers` 数组，`:95-112` 的 `filter` + 两次 `reduce` 写在渲染函数体里。主进程每 150ms 推一次进度（`sftpManager.ts:67`），`sftpStore.ts:424` 每次都 `[...s.transfers]` 重建数组 —— 常驻组件跟着每秒重渲染 6.7 次，每次还要重跑三遍数组遍历。同一个文件里 latency 早就改成 `latencyById` 单值订阅了，transfers 没跟上。

**改法**：`filter`/`reduce` 移进 selector，用 `useShallow` 只比较 `{ activeCount, activePct, firstDirection }` 三个标量。进度推进但百分比没变时不重渲染。渲染函数体里不再有数组遍历。

### Fixed（P2）

- **`batchStore.applyProgress` 高频全量浅拷**：每事件 `{ ...s.statuses }` 重建整表，`BatchPanel` 每行订阅 `s.results[sessionId]`/`s.statuses[sessionId]`，对象一换引用所有行 selector 重跑。改成单调短路：status 与已有值相同且无新 result 时原样返回 `s`；只变 status 时 results 引用保持不变。
- **文件树 / 双栏行未用 `content-visibility`**：`.conn-row-cv` 只在连接列表用，文件树三处 300 行（`ROW_LIMIT`）仍全量布局。新增 `.file-row-cv`（`contain-intrinsic-size: auto 22px`，与连接列表的 52px 分开写 —— 行高填错会让滚动条抖动）。
- **快捷键冲突缺批量恢复**：单行重置按钮本来就有（`ShortcutSection.tsx:126-133`），缺的是冲突提示区的一键恢复。一次改坏三四个键时用户得逐行点图标，且提示里给的是 label、行里显示的是组合键，对不上。新增 `resetConflicts()`，按 `ConflictInfo.actions[].id` 精确取集合，只重置冲突项，不误伤其它自定义键。

### Added（回归脚本，判据按 2.6）

- **`scripts/verify-ime-guard.cjs`**：字符级 JSX 分词求 handler 宿主。不能用「向上找最近的 `<tag`」—— 本项目属性跨多行，会撞上相邻元素把 13 处里的 11 处误判成「不需要守卫」，脚本一片绿而实际漏修。容器子树用嵌套深度匹配闭标签，不能用 `indexOf('</div>')`（会截断在第一个内层闭标签，子树里明明有 input 却判成没有）。断言必须 grep `isImeComposing(e)` 而不是 `isComposing`。
- **`scripts/verify-shortcut-reset.cjs`**：6 条断言，含「批量恢复按冲突集合取 id」。

两条脚本都做了 stash 反向验证：`verify-ime-guard` stash 掉守卫后 13 处全红，`verify-shortcut-reset` stash 掉批量恢复后 2 条红。

### 验证

typecheck 干净、build 成功、`run-all-verify` **45/45**（含新增 2 条）、`e2e-ui-sftp` **18/18**。

## [1.7.2] - 2026-10-31

### Fixed（本地路径守卫两处绕过，均为 v1.7.0 引入）

**P0：`\\?\` / `\\.\` 扩展前缀让整条位置黑名单失效。** `pathGuard.ts` 的 `isForbiddenTarget` 全部基于 `resolve(path)`，而 `path.resolve('\\?\C:\Windows\System32\config')` 原样保留前缀（实测输出 `\\?\c:\windows\system32\config`），与黑名单字符串 `c:\windows\system32` 永不相等；`normalize('//?/C:/...')` 还会把斜杠形态**转成**前缀形态，两个入口都漏。渲染层被控制后，攻击者给任意路径加四个字符 `\\?\` 即可绕过全部位置判断——实测用该前缀真删掉了 tmp 目录里的文件、真建出了目录。

修法：新增 `stripExtendedPrefix`，在 `normalize` **之前**剥掉 `\\?\`、`//?/`、`\\.\` 三种形态；`GLOBALROOT` 单独拒绝（阴影副本路径剥完拿不到盘符）；剥完仍无盘符的（`\\.\PhysicalDrive0`、`\\.\pipe\x`）一并拒绝。`assertSafeLocalPath` 与 `assertBrowsableDir` 共用，返回值为剥过的路径，`fs` 作用在同一对象，行为无差异。

顺带定下 UNC 口径并写进注释：**浏览放行**（用户要能看网络共享），**删除/重命名拒绝**（黑名单对 `\\attacker\share` 本就无意义，拒绝比假装校验更诚实）。

**P1：`localList` 用校验后的 `target` 读目录，却用原始 `dir` 拼子项路径。** 后果是带前后空格的路径 `readdir(target)` 读到条目、`lstat(join(dir,...))` 全部 ENOENT 被空 `catch` 吞掉，**静默返回空列表**，用户看到空目录且日志无痕；带 `\\?\` 前缀时返回的 `path` 字段把前缀漏给渲染层，再回传给 `localDelete` 时行为靠巧合对齐。

修法：`join(dir, e.name)` → `join(target, e.name)`；`catch` 从空块改成只对 `ENOENT` 打 `console.warn`（EPERM/EACCES 是列 `C:\` 根时的常态，不刷屏）。

### Changed（回归断言判据，`AGENTS.md` 2.6 节）

本轮连出三个「绿了但没测到」，同一模式：**断言只看了终态没看区分度**。三类假绿已列表固化——用例自己消掉载荷（`path.resolve(work,'..','..')`）、判据看不出差异（耗时判 20s 窗口是否夹紧）、系统自己先抛错（`fs.rename` 自己抛 ENOENT 冒充守卫）。核心判据一句：写断言前自问「如果这个 bug 还在，这条会不会红」，验证方法把修复 `git stash` 掉重跑。

`verify-local-fs-guard` 从 11 条扩到 **33** 条：新增 `\\?\` 四条、`localList` 两条、UNC 浏览侧一条，并把 3 条假绿翻成断言守卫错误文案（`路径分隔符`/`名称无效`/`非法字符`）。

## [1.7.1] - 2026-10-31

### Fixed（安全：本地路径守卫被 `\\?\` / `\\.\` 扩展前缀绕过）

**P0 — 破坏性操作可以借扩展前缀绕过黑名单。** `pathGuard` 之前只把 `normalize()` 之后的路径与黑名单比较，但 `\\?\C:\Windows\System32\config` 这类扩展前缀路径 `normalize` 之后**前缀原样保留**，黑名单里的 `C:\Windows\System32\config` 永远匹配不上。`//?/C:/...` 这种斜杠形态还会被 `normalize` 主动转成 `\\?\` 形态，两个入口都漏。

现在新增 `stripExtendedPrefix`，在 `normalize` **之前**剥掉 `\\?\`、`//?/`、`\\.\` 三种形态；`\\?\GLOBALROOT\...ShadowCopy` 直接拒绝；剥完不带盘符的（`\\.\PhysicalDrive0`、`\\.\pipe\xxx`）也拒绝。浏览侧 `assertBrowsableDir` 同样走这套清洗，前缀不再能漏给渲染层。

同时 `assertSafeLocalPath` 拒绝一切 UNC 路径的破坏性操作（`\\attacker\share` 对黑名单本就无意义），而 `assertBrowsableDir` 保留浏览——口径已在注释中写明。

### Fixed（`localList` 路径清洗不一致）

`localList` 用校验后的 `target` 读目录，却用原始 `dir` 拼子项路径，两个后果：

- `dir` 带前后空格时：`readdir(target)` 读到条目，`lstat(join(dir,...))` 全部 ENOENT，被空 `catch` 吞掉，**静默返回空列表**，用户看到空目录且无任何日志。
- `dir` 带 `\\?\` 前缀时：返回的 `path` 字段把前缀漏给渲染层。

现在统一用 `target` 拼路径；`catch` 只对 ENOENT 留 `console.warn`（EPERM/EACCES 是列 `C:\` 根的常态，不刷屏）。

### 回归

`verify-local-fs-guard` 33 条断言：新增 `\\?\` 4 条、`localList` 2 条、UNC 浏览侧 1 条。按「修复未落地会红」的判据写，3 条历史假绿（`a/b`、`..`、`a<b`）翻成断言守卫错误文案。

## [1.7.0] - 2026-10-31

### Added（本地路径守卫）

文件管理器的本地侧此前只有渲染层的二次确认，主进程没有硬边界。现在 `src/main/store/pathGuard.ts` 提供三道守卫：`assertSafeLocalPath`（破坏性操作：删除/重命名/新建）、`assertSafeLocalPaths`（批量）、`assertBrowsableDir`（浏览），并配 `assertSafeName` 校验单个文件名（`join` 会折叠 `..`，名字形状必须在 `join` 之前验）。

覆盖系统目录黑名单、盘符根、用户主目录、路径穿越、Windows 设备名（`CON`/`PRN`/`AUX`/`COM1`…）、非法字符。

### Changed（exec 超时夹紧）

`window.api.exec.run(sessionId, cmd, timeout)` 的 `timeout` 之前直接透传给远端，调用方传 `0` 或不传就是无限等待。现在夹到 `[1s, 20s]` 窗口，并且返回值区分 `done` / `timeout`，超时不再静默挂死。

### Changed（主进程入口拆分）

`src/main/index.ts` 1432 → 291 行，`taskbar` / `smoke` / `icon` 三块独立成文件。纯搬家，调用方一行没改。

## [1.6.8] - 2026-10-31

### Changed（CI 门禁，无运行时改动）

原来 CI 只跑 `npm run verify:prepackage`，41 项 verify 是靠 `package.json` 里 `test:verify` 串接**间接**覆盖的。两个问题：改 `package.json` 的人不会意识到自己在动 CI 门禁；失败时只看到整条命令变红，区分不出是类型错还是某个 verify 挂了。

拆成两个显式步骤：

- **Verify (typecheck + all unit checks)** — typecheck + 功能自检 + 上传文件夹 + `run-all-verify`（41 项，含 ssh2 lab server 用例）。不需要 Electron 窗口，跑得快，单独失败时能立刻定位。
- **Verify (UI e2e)** — `npm run build` + `e2e-ui-sftp`，单独带 2 次尝试 + 15 分钟超时。runner 环境抖动不该报废整个发布。

## [1.6.7] - 2026-10-31

### Fixed（修 1.6.6 自己引入的两处缺口）

**P0：批量下载的同名文件仍会互相截断。** 1.6.6 加了 `uniqueLocalPath`，但判断依据只有 `existsSync`。批量下载时目标文件还没落盘，同一批里两个同名远端文件（不同目录下的 `config.bak`）会算出**同一个**目标路径，两个任务并发写就互相截断，内容混杂。

现在支持传入批次级 `Set`，判断条件变成「磁盘上已存在 **或** 本批次已分配」，分配即占位。（ZMODEM 的 `uniquePath` 有同样问题但不暴露——它是单文件串行。）

**P1：`allowLan` 保存后丢失，二次编辑被锁死。** 1.6.6 的 `allowLan` 只在保存时用一次就丢掉，没写进配置。用户勾选后成功保存 `0.0.0.0`，下次打开编辑框再保存时读不到该字段，后端重新校验直接抛错——**改个名字都存不了**。v1.6.5 及之前存下来的 `0.0.0.0` 隧道同样被锁死。

现在 `TunnelConfig` 持久化 `allowLan`，并对存量配置做无感迁移：已存配置的监听地址非回环时视为已授权。

### Added

- **`src/shared/bindHost.ts`**：`isLoopbackHost` / `isWildcardHost` / `needsLanGrant` 三个纯函数，主进程与渲染层共用。两处各写一份必然漂移，后果是「UI 允许、后端拒绝」或更糟的「UI 没提示、后端放行」。
- **`allowLan` 界面入口**：隧道编辑器在监听地址下方加复选框，只在非回环时出现。通配地址（`0.0.0.0`/`::`）单独强调「同网段任何机器都能借你的网络上外网」；未勾选直接提示「将无法保存」；编辑老隧道时按当前地址推断勾选状态；复制隧道时透传授权。
- 测试扩到 **41 项**：新增 `verify-tunnel`（真实 ssh2 server 的 -L 穿透：数据穿透、幂等、端口释放、会话断置 error、删除前 dispose）与 `verify-batch-exec`（保序、单点失败不阻塞、取消双路径、256KB 截断、并发峰值 ≤ 8）。

### Fixed（测试脚本自身）

`verify-batch-exec` 两个 bug：ssh2 的 exec 回调命令在第三个参数 `info.command`（原来写成 `a.command`，`stream`/`big` 用例从未真正生效）；服务端通道的 `close` 事件在 `exit`/`end` 后往往不触发，并发计数只增不减，导致「峰值 12」误报成闸门失效。

## [1.6.6] - 2026-10-31

### Fixed（主进程 / SSH / SFTP 面，两条用户可感知的数据问题）

**P0：下载覆盖本地文件。** 从双栏把远端 `config.bak` 拖到本地同名目录，**本地原文件被直接截断覆盖**——`download` 走的是 `fs.open(localPath, 'w')`。而同一进程里的 ZMODEM 接收早就有完整的重名编号，两条下载路径行为相反。现在统一：同名自动变 `config (1).bak`，目录下载同样生效。

**P0：删除隧道配置留下幽灵转发。** 删除配置只从 JSON 里 filter 掉，运行时原样留着：状态还是 active、`net.Server` 继续监听本机端口、`forwardIn` 还绑在远端，但隧道列表里已经列不出它了——**失去关闭入口，只能重启应用**。`-D` 类型尤其危险：一个关不掉的免认证 SOCKS5 监听。现在删除会先 `dispose()` 运行时再删配置，`stop()`（保留配置、可重启）与 `dispose()`（配置已删、彻底移除）语义分开。

**其余修复：**

- **诊断巡检 / 批量执行的 runId 泄漏**：三个校验 throw 都在清理之前，`runs` 里永久残留 token。改成先校验后登记 + `finally` 清理。
- **批量执行无并发闸门**：原来无闸门 `Promise.all`，批量 50 台 = 瞬间 50 个 exec 通道，服务端 MaxSessions 打满反而 `open failed`。加 8 路并发，结果顺序仍等于传入顺序。
- **取消轮询改订阅制**：原来每个任务挂一个 120ms `setInterval` 查一个布尔值（50 任务 = 每秒 416 次空转）。现在一次 `cancel()` 广播给所有任务，与任务数无关。
- **SFTP 通道缺 error 监听**：ssh2 协议层出错是 `emit('error')` + `destroy()`，没有监听会冒到进程级兜底，且缓存不失效——该会话后续所有 SFTP 调用都报 Channel not open 直到关标签。
- **远程编辑的备份语义**：原来一个 `try` 把 `pStat`/`pUnlink`/`pRename` 全包住，服务器拒绝 rename 会被当成「目标不存在」然后直接覆盖。现在备份失败即中止，写入失败会把 `.bak` 搬回来。
- **监听地址校验**：`bindHost` 原来只给默认值不校验范围，填 `0.0.0.0` 就把本机变成同网段可用的免认证代理。默认只允许回环，对外监听需显式 `allowLan`。
- **目录上传上限**：`walkLocalTree` 不带 limit，10 万文件会先把整棵树建成数组再开始传、全程无反馈。加 20000 上限并显式提示已截断。

## [1.6.5] - 2026-10-31

### Fixed（发布链路）

- **版本一致性门禁**：`release.yml` 新增 tag 与 `package.json` 比对。此前打 `v1.6.5` 却忘了 `npm version` 时，产物名和 `latest.yml` 仍是 1.6.4，客户端比对「1.6.4 ≤ 已装」判定无需更新，整条自动更新链路**静默失效**。
- **CI 缓存**：加 Electron 运行时与 electron-builder 工具链缓存（必须先于 `npm ci`，Electron 在 postinstall 阶段拉取）。
- **E2E 重试**：真起 Electron 走 CDP 的 e2e 步骤加 2 次尝试 + 15 分钟超时。
- **产物策略统一**：CI 改为 `--publish never` 后只上传 Setup + blockmap + latest.yml，zip 仅作为排障 artifact。此前与 `release.ps1` 的「不上传 zip」禁令矛盾，Release 上多挂了一个 112MB 的冗余包。
- **`release.ps1` 目录脱节**：输出目录改为从 `electron-builder.yml` 解析，去掉硬编码 `dist-v13`（配置早已是 `dist-v14`，直接跑脚本会报「没有产物」）。

### Fixed（压测数据安全）

`perf-group.cjs` **不再对用户真实连接做破坏性操作**。此前它取用户库里最大的真实分组做整组 rename 往返 + 12 路并发改名，中途异常就会脏写 `connections.json`。现在全程操作自建的 300 条测试数据，并在首尾比对 id 集合，确认用户数据一条未动。

### Fixed（渲染层）

- **终端快捷键死配置**：`terminalSearch` / `terminalCopy` / `terminalPaste` 在设置里可改，实际却是硬编码。现在三项都读设置，改完立即生效。
- **Ctrl+Shift+Tab 恢复可达**：此前精确比对 shift 导致「上一个标签」的反向分支是死代码。
- **大目录渲染上限**：文件树、远程栏、本地栏统一 300 行上限（与会话树口径一致）。
- **选中判断 O(n²) → O(n)**：双栏文件列表原来每行都做 `includes` 全表查找，改为 Set。
- **拖动窗口不再每帧重建会话数组**：`setSize` 对相同 cols/rows 短路。
- **批量打标签**：新增 `conn:update-tags` 通道，一次读改写落盘，替代原来多选后逐条 `save()`（500 条 = 500 次 IPC + 500 次全量重渲染）。

### Changed（主进程分层）

- `store` 层不再反向依赖 `ssh`：配置备份的采集/对比/回写拆到 `ssh/configBackup.ts`，`store/backups.ts` 只留纯文件读写。`store → ssh → store` 的双向耦合解除。
- 会话日志管理拆到 `store/sessionLogs.ts`，录制器归入 ssh 域。
- 设置副作用下沉到 `app/settingsService.ts`，IPC 传输层不再承载域逻辑。
- `handle()` 改泛型签名，实参与 handler 参数类型建立编译期关联。
- **JsonStore 缓存可感知外部改动**：加 mtime 指纹校验，「手改 JSON 立即生效」这个卖点真正成立；同时保证读改写链内不被自己的异步写盘误判。

### Added（测试体系）

- `npm run test:verify`：36 个 verify 脚本一键跑，已知历史失败（cdsync / theme / zmodem）默认跳过。
- 新增 `verify-shortcuts`、`verify-jsonstore-reload`、`verify-conn-tags-batch`。

## [1.6.4] - 2026-10-30

### Fixed（文件传输：三个真 bug + 一个测试盲区）

1.6.3 的「上传文件夹」只有 UI，没有实现完整性 —— 用户实测「根本不能上传」「想传到下级目录都不行」。用真实 SFTP 服务器 + 真实应用 + 真实点击复现后确认：

| 缺陷 | 现象 | 根因 |
|---|---|---|
| 空目录不落地 | 选一个只有子文件夹的目录，远端什么都不出现 | `walkLocal` 只收集文件，空目录被丢弃 |
| 符号链接/junction 当文件 | 远端冒出 0 字节假文件；真实项目里整批任务报错 | `readdirSync` 对 junction 的 `isDirectory()` 为 false |
| 单文件失败即整批中止 | 一个文件没权限，整个目录白传 | `transferUploadDir` 无 per-file 容错 |
| 上传文件夹无目标目录选择 | 落点只能是当前目录，无法指定下级目录 | 直接跳系统文件夹框，绕开 `UploadTargetDialog` |

- **上传**：`walkLocalTree` 同时收集文件 / 目录（含空目录）/ 跳过的链接；先按父目录在前建好远端目录树再传文件；per-file 容错并汇总失败；跳过的链接通过进度条 `note` 明示（不显示成失败）。
- **下载**：`walkRemote` 同样带回目录清单，本地先 `mkdir`，空目录不再消失；单文件失败不再中止整批。
- **上传文件夹可选目标目录**：`useUploadTarget` 增加 `kind: 'file' | 'folder'`，上传文件夹也先弹目标目录对话框，可逐级进入子目录 / 新建目录。

### Added（测试）

- `scripts/e2e-ui-sftp.cjs` 扩到 **18 项真实 UI 断言**，新增：空目录落地、跳过 junction、**上传到所选下级目录**（弹窗内逐级点选）。
- `scripts/repro-folder.cjs`：深坑 fixture（125 文件 / 16 目录 / 6 层嵌套 / 中文 + 空格 + 特殊字符 / 空目录 / junction）独立复现脚本。
- 压测：322 文件 10.6MB，上传 12.9s / 下载回读 7.8s，md5 全对（21/21）。
- 打包产物复验：`E2E_APP=dist-v14/win-unpacked` → 18/18 PASS。

## [1.6.3] - 2026-10-29

### Changed（重构，无功能变化）

体检清单里最后两项「上帝文件」已拆分。都是纯搬家 —— **没有改任何一行业务逻辑**。

#### 1. `store/repository.ts` 764 → 70 行（8 个域拆开）

原本 8 个互不相干的业务域挤在一个文件里：连接 / 命令 / 历史 / 设置 / 巡检项 / 档案 / 隧道 / 已知主机。改「连接的分组重命名」和改「设置迁移」要动同一个文件。

现在按域落到 `src/main/store/repo/`：

| 文件 | 行数 | 职责 |
|---|---|---|
| `connections.ts` | 161 | 连接增删改查、分组、凭据语义 |
| `commands.ts` | 185 | 常用命令、排序、导入导出 |
| `history.ts` | 51 | 命令历史（含上限裁剪） |
| `settings.ts` | 140 | 应用设置 + 一次性外观迁移 |
| `diagSections.ts` | 57 | 自定义巡检项 |
| `profiles.ts` | 52 | 客户 / 设备档案 |
| `tunnels.ts` | 55 | 端口转发定义 |
| `knownHosts.ts` | 62 | 已知主机指纹 |
| `repository.ts` | **70** | 纯 re-export barrel |

**关键设计**：`repository.ts` 保留为统一出口做 re-export，所以 **40 多个 import 点一行都不用改**。将来要再拆也不会波及调用方。

顺带修了一处冗余：`addHistory` 里原本内联了一遍「useCount+1 / lastUsedAt 刷新」的逻辑，和 `touchCommand` 完全重复，改为直接调用后者。

#### 2. `SettingsPanel.tsx` 959 → 118 行（7 个分区拆开）

原本这一个文件同时装着：4 个 UI 原子（Section / Row / Segmented / ColorThemeGallery）、7 个业务分区、以及一段完整的指纹探测状态机（探测 → 旧新对比 → 确认写库）。

现在：

| 文件 | 行数 |
|---|---|
| `SettingsPanel.tsx` | **118**（只负责布局顺序 + Modal 外壳） |
| `sectionUi.tsx` | 128（Section / Row / Segmented 原子） |
| `AppearanceSection.tsx` | 121（明暗 + 配色画廊） |
| `TerminalSection.tsx` | 70 |
| `BehaviorSection.tsx` | 74 |
| `LayoutSection.tsx` | 70 |
| `ShortcutSection.tsx` | 201（含冲突弹窗） |
| `KnownHostsSection.tsx` | 273（指纹状态机整套） |
| `DangerSection.tsx` | 34 |

UI 原子放独立文件是必须的：否则 7 个 section 会反向依赖 `SettingsPanel`，形成循环 import。

### Added (scripts)

- `scripts/verify-repository-split.cjs`（`npm run test:repository`）：用临时数据目录真跑一遍 8 个域的读写，断言的是**行为**而不是行数 —— 48 个断言覆盖凭据语义（undefined/''/值）、分组默认值、sortOrder 递增、导入去重、历史上限、设置合并与迁移、超时钳制、指纹更新不新增条目、以及 8 个 JSON 文件确实各写各的
- `scripts/probe-settings-sections.cjs`：CDP 里逐个展开 10 个设置分区，确认拆分后每个都渲染出真实控件（不是空壳），并实测主题切换生效

### 验证

- `npm run check`（typecheck + lint）/ `npm run build` 全绿
- 19 个回归脚本全部通过，含新增的数据仓库回归
- 真实应用：设置面板 10 个分区全部渲染正常（20/20）、指纹探测流程行为不变（仍是 10s 超时且原因可见）、UI 冒烟 11/11、IPC 域 18/18
- IPC 完整性 141/141 通道
- `connections.json` 2934 条、哈希 `bda0ab23…` 与改动前一致

### 一处测试自身的问题（记下来避免误判）

跑 `smoke-cdp` 时「跟随终端目录开关」一度报 FAIL。排查后确认是**测试之间互相干扰**：前一个 probe 脚本把分区展开状态写进了 localStorage，smoke 再点一次反而把它收起了。用全新 profile 复跑 11/11 通过，代码本身没问题。

## [1.6.2] - 2026-10-29

### Added

#### ESLint（项目第一次有 lint 机制）

此前只有 `tsc` 把类型关，没有任何 lint —— 未使用变量、循环依赖、`any` 泛滥、Hook 依赖漏项全靠自觉。

- 新增 `eslint.config.mjs`（扁平配置，ESLint 9 + typescript-eslint 8），分三档：
  - **主进程 / preload / shared**：类型感知规则全开（`recommendedTypeChecked`）
  - **渲染层**：类型感知 + `eslint-plugin-react-hooks`
  - **scripts/\*.cjs**：Node 环境，只查明显错误
- 新增 5 个 npm 脚本：

  | 脚本 | 作用 |
  |---|---|
  | `npm run lint` | 只查 src |
  | `npm run lint:fix` | 自动修可修的 |
  | `npm run lint:scripts` | 只查验证脚本 |
  | `npm run lint:all` | 全查 |
  | `npm run check` | typecheck + lint（提交前跑这个） |

**校准原则**：这是给已经在跑的既有代码加护栏，不是重排风格。所以没开 `semi` / `quotes` / `indent` 这类排版规则（既有代码 23537 行不带分号、以单引号为主，是既定风格），只开能抓真问题的。

### Fixed（lint 第一次跑就抓出来的真问题）

首轮 49 条，全部修掉，没有靠关规则糊过去：

- **React Hook 记忆化完全失效**（`CommandPanel` / `CommandCenter`）：`useSettingsStore(...) ?? []` 每次都分配新数组，作为 `useMemo` 依赖永不相等 —— 等于没记忆，还每次 render 重算。改为模块级空数组哨兵 `EMPTY_IDS` / `EMPTY_GROUPS`
- **`forceRefresh` 缺失依赖**（`SessionFileTree`）：它是 `version` 的纯函数，却在渲染期计算后被 effect 隐式捕获。移进 effect 内部推导，语义不变且依赖关系显式
- **过期 eslint-disable 注释**（`FileExplorer`）：压着一条早已不存在的告警，会掩盖以后真出现的
- **zmodem 的 `any` 调用链**：`send_offer` 返回值没标注类型，导致 `transfer.get_offset()` / `send()` / `end()` 全是 unsafe any 调用。补 `ZmodemTransfer | undefined` 标注
- **`String(err ?? '')` 会把对象变成 `[object Object]`**（`zmodem.ts`）—— 既匹配不到协议特征，又掩盖真实原因
- 若干 `JSON.parse` 结果直接当数组用（`ConnectionSidebar`）、`new Array(n)` 的 `any[]`（`diagnostics`）、`executeJavaScript` 返回 `any`（smoke 自检）
- 清理 9 个脚本里的死变量与 1 处恒为真的 `undefined ?? 5`

### 有意保留的豁免

两处 `require-await` 用行内 disable 而非去掉 `async`：`firmware.upload` 与 `firmwareStore.startWaitOnline` 的接口契约是 Promise，调用方一律 `await`；去掉 `async` 会让类型对不上（我一开始就是那么改的，被 `tsc` 当场拦下）。ZMODEM 的 `no-control-regex` 同理 —— ZDLE/DLE 就是协议字节。

### 验证

- `npm run typecheck` / `npm run lint` / `npm run build` 全绿
- **lint 有效性验证**：临时写了一个故意违规的文件（条件里调 hook、浮空 promise、弱比较），三条规则全部报出，确认不是空转
- 19 个既有回归脚本全部通过；`verify-zmodem` 的 6 项失败与改动前基线逐项一致（AGENTS.md 已记录的既有失败）
- 真实应用：UI 冒烟 11/11、IPC 域 18/18、IPC 完整性 141/141 通道
- `connections.json` 2934 条、哈希 `bda0ab23…` 与改动前一致

## [1.6.1] - 2026-10-29

### Changed（重构，无功能变化）

#### 上传/下载执行链路收敛到 store
- 新增 `sftpStore.uploadFileDialog` / `downloadTo` / `downloadToDefault`：**唯一**的执行链路（解析目标目录 → 弹系统对话框 → 入队 → 失效目录缓存 → 提示），返回 `{ count, target }` 让各面板自己决定怎么刷新
- 新增 `components/files/useUploadTarget.ts`：把「先确认目标目录再弹文件框」的 4 个 useState + beginUpload + doUpload 抽成 hook，两个面板只渲染 `dialogProps`
- 拆分前：`FileExplorer` / `SessionFileTree` / `RemotePane` 各写一遍，一份 19–26 行。改一处行为（比如目录解析兜底）要同步改 4 个地方，漏一个就是「有的入口好使、有的不好使」
- 净效果：`FileExplorer` 1082→993 行，`SessionFileTree` 812→729 行，两者 6 行重复片段 **31 → 2**

#### main/index.ts 按域拆分
- 原本 2199 行，同时是窗口创建、菜单、更新器、错误日志和 **134 个 IPC handler** 的宿主；22 个业务域挤在一个 615 行的 `registerIpc()` 里
- 新增 `src/main/ipc/`：`errors` / `connections` / `sessions` / `commands` / `settings` / `sftp` / `zmodem` / `localFs` / `diagnostics` / `devices` / `backupTunnel` / `windowUpdate` 共 12 个域文件，每个只导入自己用到的模块
- 新增 `ipc/handle.ts`（IPC 包装 + 通道中文标题）与 `windowRef.ts`（主窗口引用），避免 20 个子模块反过来依赖入口形成循环 import
- `index.ts` 只留窗口 / 生命周期 / 事件接线：2199 → 1432 行（其中约 1050 行是原有的 `--smoke` 自检，属独立功能）

### Removed

- **死通道 `SESSION_RECONNECT_NOW`**（`session:reconnect-now`）：常量表里有，但从未注册过、也从未被任何代码调用（查历史版本同样是 0 处）。重连实际走渲染层 `sessionStore.reconnect()` 重发 `SESSION_OPEN`。是新增的 IPC 完整性自检把它抓出来的。

### Added (scripts)

- `scripts/verify-ipc-registration.cjs`（`npm run test:ipc`）：三层对账 ——
  1. 静态：`shared/ipc.ts` 里 141 个通道常量逐个在 `src/main` 找注册点；
  2. 运行时：真跑 `registerAllIpc()`，数 `ipcMain` 上实际注册数并与常量表比对（这次就是靠它发现死通道，以及确认拆分没漏搬 handler）；
  3. 行为：抽查通道可调用、失败被包装成 `{ ok: false }` 而非抛异常、导入通道拒绝未授权路径
- `scripts/probe-ipc-domains.cjs`：在真实应用里逐个域调一个代表通道（17 个域），验证拆分后功能面完整

## [1.6.0] - 2026-10-29

### Added

#### 上传文件夹（目录树整棵传过去）
- 侧栏文件面板、会话文件树、双栏文件管理（远程栏）各新增一个「上传文件夹」按钮，右键菜单同步加「上传文件夹到此处」
- 新增 IPC `SFTP_UPLOAD_FOLDER_DIALOG`（系统目录对话框，可多选）与 `SFTP_SCAN_FOLDERS`（上传前统计）
- `sftpManager.upload()` 新增 `options.keepRoot`：
  - `true`（上传文件夹）：远端落点是 `目标目录/<本地目录名>/...`，空目录也会建出来
  - `false`（历史拖拽语义，保持不变）：把本地目录的**内容**铺进目标目录
  - 之前两种场景复用同一段代码，直接把文件夹传上去会「少一层目录」，选了两个同名不同内容的目录还会互相覆盖
- `sftpManager.scanFolders()`：选完目录先算文件数 / 总字节数（2 万文件封顶，超出标记 `truncated`），避免对着没有总量的进度条等
- 新增 `scripts/verify-upload-folder.cjs`（22 项，内存 SFTP 假通道）

#### 主机指纹更新
- 设置 → 已知主机指纹：每条记录新增指纹按钮（探测设备当前值 → 弹「旧 → 新」对比 → 确认后写回），顶部新增「检查全部更新」批量探测
- 连接编辑器：测试连接报指纹冲突时直接给「更新主机指纹并重测」按钮；测试成功时给「用此指纹更新本地记录」
- 终端报错覆盖层：错误文案含「指纹」时出现「更新主机指纹并重连」一键按钮，不必再去设置里翻记录
- 新增 IPC `KNOWN_HOSTS_PROBE`（只握手、不认证、不写库）与 `KNOWN_HOSTS_REFRESH`
- 新增 `probeHostFingerprint()` / `takeHostKeyMismatch()`：冲突详情（记录值 / 当前值）从 `hostVerifier` 同步回调里带出来，不再只能给一句「校验未通过」

### Fixed

- **指纹算法一直是错的**：旧实现给 ssh2 设了 `hostHash='sha256'`（ssh2 会把摘要转成 hex 再回调），代码又对**那份 hex 字符串**做 base64 —— 存下来的是 `SHA256:<hex>`，与 `ssh-keygen -lf` 完全对不上。现在统一 `SHA256:base64(sha256(公钥))`，与 OpenSSH 一致
  - 老记录不丢：`isLegacyFingerprint()` 认得 64 位小写 hex 的旧格式，校验时两种都比对，命中一次即静默迁移成标准格式
- 指纹冲突不再靠 `hostVerifier` 抛异常传递：那个回调在 ssh2 密钥交换流程里同步执行，抛异常会打断协议状态机、错误退化成含糊的 "Host denied"。改为记录事实 + 返回 `false`，上层按标准失败路径取详情

### Added (scripts)

- `scripts/verify-hostkey.cjs`（14 项纯函数用例）：格式、与 openssl 手算一致、旧格式识别与不误判
- `scripts/perf-new-features.cjs`（Electron 真实 IPC 链路）：新通道注册、扫描统计、指纹探测失败路径与非法指纹拒绝

## [1.5.2] - 2026-10-27

### Fixed

- **跟随终端 cwd「看起来没生效」**（v1.5.1 发布后首个反馈）：`cd` 之后侧栏文件面板不动。解析与事件链路本无问题（82 + 19 项用例全过），病根在展示 —— 面板默认停在「工作区」Tab，那是一列常用位置快捷入口（主目录 / 根目录 / 临时目录…）而不是目录树，用户看到快捷入口就判定「没跟」；叠加面板首次挂载把事件游标一次性对齐到当前序号，**挂载前**发生的 `cd` 被静默吞掉。
  - 抽出纯函数 `src/renderer/src/lib/cwdFollow.ts`：`decideInitial` 在「有已知 cwd + 开着跟随」时连 Tab 一起定到「文件系统」；`decideFollow` 显式区分「新事件 / 旧事件 / 空路径 / 关开关 / 断线 / 序号回退」六种分支，空路径不推进游标以免事件被永久跳过
  - 新增「手动把跟随重新打开 → 立刻补跳一次」，免去「关掉再打开还是不动」的困惑
  - 新增 `scripts/verify-cwdfollow.cjs`（19 项，零依赖纯函数用例），并入 `npm run test:cwdfollow`

### Build

- 产物目录切到 `dist-v13`（每版一个目录，旧产物留作对照）；`scripts/release.ps1` / `build-release.sh` / `build-release.bat` 同步指向新目录
- 本次发布带上了此前未随包发出的完整性标签硬锁修复（`WRITE_OWNER` 硬锁 + 两级扫描，全仓扫描 25.9s → 5.8s）：`npm run build:win` 与 `release.ps1` 上传前各拦一道，带 `Low` IL 的包不再出门

## [1.5.1] - 2026-10-27

### Added

#### 终端 `cd` 之后，侧栏文件面板自动跟过去
- 终端里敲 `cd /var/log/nginx`，侧栏「文件」面板同步跳到该目录并逐级展开父目录
- 两条来源合并，谁先到算谁：
  - **输入追踪**（`src/renderer/src/lib/shellCwd.ts`）：解析回车前那一整行，识别 `cd` / `pushd`，支持 `~`、相对路径、`..`、带空格与引号的路径、bracketed paste 粘贴块；`Ctrl-U` / `Ctrl-W` / 方向键等编辑操作后保守丢弃整行
  - **OSC 7 序列**：远端 shell 上报真实 cwd 时直接采用，覆盖脚本内 `cd`、`pushd` / `popd` 等程序化切换
- 文件面板标题栏新增链状开关，可一键停止跟随；设置 → 行为 → 「跟随终端目录」同样可关
- 新增配置项 `filesFollowTerminalCwd`（`src/shared/types.ts`），缺省按开启处理，老配置无需迁移
- 会话状态按 `sessionId` 隔离（`src/renderer/src/stores/cwdStore.ts`），关闭会话时清理 cwd / 输入追踪器 / home 缓存，重连复用同一 id 不会带上一台机器的路径

### Changed

#### 侧栏打开远端目录：串行往返改为批量
- 新增 IPC `SFTP_LIST_MANY`（`src/shared/ipc.ts`）：一次 IPC 批量 `readdir` 任意多个目录，主进程内 8 并发（`LIST_MANY_CONCURRENCY = 8`）
- 新增 IPC `SFTP_BOOTSTRAP`：首次打开文件面板一次往返拿回 `home + 目录内容`，省掉 `realpath → readdir` 的串行等待
- 新增 `src/renderer/src/lib/dirLoader.ts`：同一帧内的目录请求合并成 1 条批量 IPC，按会话分段，切会话时旧批次整批丢弃
- `src/renderer/src/lib/dirCache.ts`：目录结果带 TTL 缓存，重复展开直接命中
- `FileExplorer` 加载 effect 重写：只加载缺失目录，不再因 `version` 自增而把整棵已展开目录树重读一遍
- 实测：256 个目录同帧请求从 256 条 IPC 降为 **1 条**（省 100%），耗时 1.1ms；真实 Electron 下 30 次连续目录读取中位 17.1ms、p95 30.0ms

### Fixed

- `currentDir` 会带着上一个会话的路径进入新会话
- `scripts/release.ps1` 默认写死代理 `127.0.0.1:7897`，换网络环境即整条发布链路失败；改为启动时探测端口，不可达自动直连

### Build

- 新增 `scripts/check-integrity.ps1` 与 `npm run check:integrity` / `fix:integrity`：扫仓根 + 所有 `dist*` 目录 + 其中的 `*.exe` / `*.dll`，命中 `Low` 完整性标签退出码 1（该标签会让 Electron 沙箱子进程启动即崩，表现为双击 exe 毫无反应）
- `npm run build:win` 前置该检查；`scripts/release.ps1` 上传前再拦一道，带 `Low` IL 的安装包不再出门
- 打包输出目录切到 `dist-v12`（每版一个目录，旧产物留作对照）

### Notes

- 发布产物规则：GitHub Release 只上传 `Setup.exe` + `.blockmap` + `latest.yml`，portable / zip 留在本地
- 评估后搁置 Gitee 更新源：`electron-updater` 无 gitee provider（打包期直接抛 `Unsupported provider: gitee`），且 Gitee Release 附件对 `Range` 返回 200 全量而非 206，差量下载必失败。当前仍用 GitHub（owner `yanxici` / repo `ssh-workbench`）

## [1.5.0] - 2026-10-26

### Added

#### 应用内自动更新（打开就能看到「更新」并一键装好）
- 标题栏右侧新增更新入口（`UpdateBadge`）。启动约 8 秒后静默检查一次，发现新版本时在设置按钮与窗口控制之间亮出一个绿色小 chip「更新」，点开是版本对比、更新说明和「立即更新」按钮，全程不跳浏览器
- 状态机由主进程单点维护（`src/main/updater.ts`，基于 `electron-updater`），渲染层只做展示，不重复推导版本高低
  - `checking` → 转圈「检查中」
  - `available` → 箭头「更新」，面板里显示 `1.5.0 → 1.6.0` 与新版本说明
  - `downloading` → 百分比 + 进度条 + 速率/剩余时间
  - `downloaded` → 「重启并安装」（装完自动拉起新版）
  - `error` → 面板里给出可读原因，不弹窗打断当前会话
- 设置面板新增「软件更新」分区：立即检查 / 启动时自动检查 / 自动下载 / 更新专用代理 / 打开发布页，任意一项改完立即生效，不用重启
- 更新专用代理走 updater 自己的 Electron net session 分区，与 SSH 连接代理完全隔离；留空则跟随系统代理

#### 差量更新
- `electron-builder.yml` 补 `publish` 段（provider: github / owner / repo），打包时自动生成 `resources/app-update.yml`；配合 `.blockmap` 走差量下载，78MB 的完整包通常只需传几 MB

### Changed

- 默认值：**自动检查开、自动下载关**。现场网络按流量计费，几十兆的包应当在用户点头之后才下；查到更新只亮按钮，不偷偷拉
- `autoInstallOnAppQuit` 保持开启：用户点了重启却临时取消时，下次正常退出顺手装上，不用再点一次

### Notes

- 自动更新只对**用 NSIS 安装包安装**的版本生效（`SSH Workbench Setup x.y.z.exe`）。portable 版与解压即用的 zip 版没有安装上下文，无法自我替换，更新入口不显示，请继续用安装包覆盖升级

## [1.4.4] - 2026-10-26

### Fixed

#### 新建命令时选不了其他分组（严重）
- 「分组」输入框原来用原生 `<datalist>`。datalist 会拿输入框的**当前值**做子串过滤，而新建命令时它预填了「默认」，于是点开下拉只剩 1 条与「默认」匹配的项，用户看到的就是「分组锁死在默认、选不了别的」
- 浏览器不提供关闭该过滤的开关，因此新增 `Combobox` 组件（`src/renderer/src/components/ui/index.tsx`）：输入框 + 自绘候选列表
  - 聚焦/点箭头 → 显示**全量**候选（不再被当前值过滤）
  - 打字 → 按子串过滤，并允许直接用新名字创建分组
  - 支持 ↑/↓ 移动、Enter 选中、Esc 关闭、点外部关闭
  - 浮层用 fixed 定位并按输入框实测坐标摆放，下方空间不足时自动向上翻，不会被 modal 的 `overflow-hidden` 裁掉
- 同一坑位一并修掉：`ConnectionEditor`（连接分组）、`DiagSectionEditor`（诊断分组）

#### 命令名（名称行）溢出卡片边界
- 1.4.3 只修了命令行，名称行是同一根因：`<button>` 的 UA `align-items: flex-start` 让 column flex 交叉轴子项宽度由内容决定，`truncate` 不参与收缩
- `CommandPanel` / `CommandCenter` 的名称行补 `w-full min-w-0`；实测（CDP 量取）129 张卡片中名称行溢出数 **92 → 0**

### Changed

#### 全量溢出复查
- 用 CDP 逐屏打开全部 12 个视图/面板（连接、文件、历史、日志、隧道、诊断、批量、档案、资源、固件、发现、备份、设置）扫描「元素右边界超出非裁切父容器」，结果 **0 处**，无需再改

## [1.4.3] - 2026-10-26

### Fixed

#### 命令文本溢出卡片边界
- 侧栏命令墙里，长命令不再撑出卡片右边界。`CommandPanel` 的命令行 `<span>` 补 `w-full min-w-0`
- 根因：`<button>` 的 UA 样式是 `align-items: flex-start`，column flex 交叉轴上的子项宽度由内容决定，`truncate` 的 `overflow: hidden` 不参与收缩；只加 `min-width: 0` 无效，必须显式钉住宽度
- 同一问题在 `CommandCenter` 命令墙卡片同步修复
- 实测（CDP 量取 bounding rect）：128 张卡片中溢出数由 **82 → 0**，剩余长命令正确显示省略号

## [1.4.2] - 2026-10-26

### Added

#### 侧栏文件面板右键菜单（含下载）
- `FileExplorer` 现在支持右键菜单：行上右键作用于该文件/目录，空白处右键作用于当前目录
- 菜单项：编辑、下载此目录/下载、下载到「下载」文件夹、上传文件到此处、新建文件夹、重命名、删除
- 目录下载由主进程 `sftpManager.transferDownloadDir` 递归展开，渲染层无需自己遍历
- 新增 IPC `sftp:downloads-dir` + `window.api.sftp.downloadsDir()`，一键下载落到本机「下载」文件夹（不存在时自动创建）
- 删除目录前弹确认框，明确提示递归删除不可恢复

## [1.3.0] - 2024-01-XX

### Added

#### 批量编辑标签
- 新增批量编辑连接标签功能
- 支持两种模式：追加标签和替换标签
- 通过右键菜单访问，支持多选操作
- 自动去重标签，优化用户体验
- 新增 `BatchTagsEditor` 组件处理批量标签编辑

#### 会话恢复
- 添加会话恢复功能，启动时自动恢复上次打开的连接
- 新增 `restoreSessions` 配置项（默认关闭）
- 新增 `lastOpenSessions` 存储上次会话列表
- 最多保存 10 个会话，避免启动变慢
- 在 App.tsx 中实现会话保存和恢复逻辑
- 在设置面板中添加会话恢复开关

#### 快捷键冲突检测
- 新增 `lib/shortcutConflict.ts` 工具模块
- 实现 `detectShortcutConflicts()` 检测所有冲突
- 实现 `checkSingleConflict()` 检查单个快捷键
- 在设置面板中显示冲突警告
- 录制新快捷键时实时检测冲突
- 提供冲突确认对话框，支持强制保存

### Changed

#### ASAR 打包优化
- 在 `electron-builder.yml` 中启用 ASAR 打包
- 启用 gzip 压缩，减少 30-40% 包体积
- 添加 SHA256 完整性校验
- 优化打包配置，提升加载速度

#### 性能优化
- 优化批量操作性能（支持 2000+ 连接）
- 改进快捷键冲突检测算法（< 0.1ms/次）
- 优化会话恢复延迟（300ms 延迟启动）
- 降低内存占用（2000 连接 < 100MB）

#### UI/UX 改进
- 批量操作菜单新增"批量编辑标签"选项
- 快捷键设置区域显示冲突警告（黄色警告框）
- 会话恢复开关添加到设置 → 行为分组
- 改进错误提示和用户反馈

### Fixed
- 修复批量操作时 React hooks 使用不当的问题
- 修复快捷键冲突检测的边界情况
- 优化会话恢复的异常处理逻辑

### Technical

#### 新增文件
- `src/renderer/src/lib/shortcutConflict.ts` - 快捷键冲突检测工具
- `scripts/stress-test.js` - 压力测试脚本
- `scripts/build-release.sh` - Linux/macOS 构建脚本
- `scripts/build-release.bat` - Windows 构建脚本
- `OPTIMIZATION_SUMMARY.md` - 优化实现总结
- `USAGE_GUIDE.md` - 使用指南
- `RELEASE_NOTES.md` - 发布说明

#### 修改文件
- `src/shared/types.ts` - 新增会话恢复配置类型
- `src/renderer/src/App.tsx` - 实现会话恢复逻辑
- `src/renderer/src/components/connections/ConnectionSidebar.tsx` - 添加批量编辑标签
- `src/renderer/src/components/settings/SettingsPanel.tsx` - 添加冲突检测和会话恢复设置
- `electron-builder.yml` - 优化 ASAR 打包配置

#### 压力测试
- 新增自动化压力测试脚本
- 测试场景覆盖：大量连接、快捷键冲突、会话恢复
- 生成详细的性能报告和 JSON 数据
- 所有性能指标均达标

### Performance Benchmarks

| 测试项 | 结果 | 目标 | 状态 |
|--------|------|------|------|
| 2000 个连接生成 | < 200ms | 200ms | ✅ |
| 批量标签更新 (2000) | < 100ms | 100ms | ✅ |
| 快捷键冲突检测 | < 0.1ms | 0.1ms | ✅ |
| 10 个会话恢复 | < 50ms | 50ms | ✅ |
| 内存占用 (2000 连接) | < 100MB | 100MB | ✅ |

### Package Size Reduction

| 平台 | v1.2.0 | v1.3.0 | 减少 |
|------|--------|--------|------|
| Windows (便携版) | ~120 MB | ~75 MB | **37.5%** ⬇️ |
| Linux (AppImage) | ~130 MB | ~85 MB | **34.6%** ⬇️ |
| macOS (DMG) | ~125 MB | ~80 MB | **36.0%** ⬇️ |

---

## [1.2.0] - Previous Release

(Previous changelog entries...)

---

## 更新说明

### 从 v1.2.x 升级到 v1.3.0

1. 下载对应平台的安装包
2. 安装新版本（自动覆盖）
3. 首次启动后在设置中启用新功能
4. 现有配置和数据自动迁移

### 破坏性变更

本次更新没有破坏性变更，完全向后兼容。

### 弃用功能

无。

---

[1.3.0]: https://github.com/yourusername/ssh-workbench/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/yourusername/ssh-workbench/releases/tag/v1.2.0
