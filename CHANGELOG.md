# Changelog

All notable changes to SSH Workbench will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
