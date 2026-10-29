# SSH Workbench 发布前检查清单

> 周期性发版用。以 **v1.6.3** 为基线整理，每次发版把「本次变更」小节换成当次内容，其余直接复用。

---

## 0. 优先排查：目录完整性标签

**动手前先跑这条。** 本机反复出现过「双击 exe 没反应 / 退出码 `-2147483645` / 0xC0000005 / 同一份 exe 拷到别的目录就能跑」——根因是目录被打上 `Low Mandatory Level` 完整性标签，Electron 沙箱子进程启动即被杀。

```powershell
npm run check:integrity
```

扫仓根 + 所有 `dist*` 目录 + 其中的 `*.exe` / `*.dll`；命中 Low 退出码 1。命中就修（**需管理员令牌**，改 SACL 要 SeSecurityPrivilege）：

```powershell
npm run fix:integrity
```

等价的手工命令（脚本内部就是它，可单独对某个目录用）：

```powershell
icacls "D:\ssh-workbench" /setintegritylevel "(OI)(CI)Medium" /T
```

> 修完不需要重启机器。判定标准是 `Mandatory Label\Medium Mandatory Level`。
>
> **为什么反复复发**：不在应用代码里，是「受限令牌沙箱」这类外部工具干的。本机有两个：
> - `@deepseek-ai/dsh-sandbox-windows-acl`（随 DSH 安装，见
>   `D:\dsh\resources\app\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl`）：
>   `lib\types-*.js` 里的 `buildLowLabelAcl` / `restrictTokenIntegrity` 会给工作区
>   `setintegritylevel Low`，README 原话是「被降级令牌必须匹配的 Low 完整性标签」
>   「工作区的安全描述符改动以常驻方式授予——dispose() 保留它们」。
>   它给 `D:\ssh-workbench` 写的那条就是 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`。
> - `CodexSandboxService.OpenAI.Codex`（开机自启）：实测**不打完整性标签**，只往目录里加
>   能力 SID 的允许 ACE 和 `Everyone:(CI)(DENY)(DC)` 删除拒绝。所以它只是「同案犯」，不是真凶。

### 0.1 治本：给目录装硬锁（拒绝 WRITE_OWNER）

打 Low 标签本质是 `SetNamedSecurityInfoW` 写 SACL，需要 `SeSecurityPrivilege` **加上**
目标对象上的 `WRITE_OWNER`。把这个权限从 Everyone 手里拒掉，任何工具都打不上 Low：

```powershell
npm run guard:integrity      # 装锁（需管理员）
npm run unguard:integrity    # 摘锁
```

实测行为（本机已验）：

| 操作 | 装锁后 |
| --- | --- |
| `icacls <dir> /setintegritylevel Low` | **Access is denied**（正是要的效果） |
| 新建 / 复制 / 删除 / 重命名文件 | 正常 |
| 改 DACL（`icacls /remove:d`） | 正常（只需 WRITE_DAC） |
| DSH 的 `read-only` 型 ACL 沙箱 | 正常（不做 grantWrite） |
| DSH 的 `workspace-write` 型 ACL 沙箱 | **fail-closed**：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<dir>)` |
| 打包出的 exe 启动 | 正常（Medium IL，已实测启动到主窗口） |

> 代价就一条：**别让 workspace-write 型沙箱以这棵树当工作区**。只用 `read-only` 或
> `danger-full-access` 的话完全可以开着硬锁。要用 workspace-write，先 `unguard:integrity`。

---

## 1. 本次变更（v1.6.3）

> v1.6.0 ~ v1.6.3 是一组连续改动：一个功能版（上传文件夹 + 指纹更新）+ 三版可维护性专项（IPC 拆分、ESLint、上帝文件拆分）。逐版细节见 `CHANGELOG.md`，设计取舍见 `DESIGN.md` §5.13~§5.16。

### v1.6.0 新增功能
- [x] **上传文件夹**：`TransferControl.keepRoot` 区分「远端保留目录名」与历史「把内容铺进目标目录」两种语义；空目录也会建出来
- [x] 三条 UI 入口（侧栏文件面板 / 会话文件树 / 双栏远程栏）+ 三处右键菜单
- [x] 新增 IPC `SFTP_UPLOAD_FOLDER_DIALOG`（系统目录对话框，可多选）、`SFTP_SCAN_FOLDERS`（上传前统计，2 万文件封顶并标 `truncated`）
- [x] **主机指纹更新**：探测 → 展示「旧 → 新」→ 用户确认 → 写回；三处入口（设置 / 连接编辑器 / 终端报错层）
- [x] 新增 IPC `KNOWN_HOSTS_PROBE`（只握手、不认证、不写库）、`KNOWN_HOSTS_REFRESH`
- [x] 修掉一直算错的指纹算法：统一 `SHA256:base64(sha256(公钥))` 去 padding；旧 `SHA256:<hex>` 记录兼容并静默迁移
- [x] 指纹冲突不再靠 `hostVerifier` 抛异常传递（会打断 ssh2 协议状态机），改为 `hostKeyMismatches` 记录 + 返回 `false`
- [x] 回归：`verify-upload-folder.cjs`（22）、`verify-hostkey.cjs`（14）、`perf-new-features.cjs`、`probe-packaged-features.cjs`

### v1.6.1 可维护性：拆主进程 + 收敛上传链路
- [x] `main/index.ts` 2199 → 1432 行；134 个 handler 按域拆到 `src/main/ipc/` 12 个文件
- [x] 抽出 `ipc/handle.ts`（IPC 包装 + 通道标题）与 `windowRef.ts`（主窗口引用），避免子模块循环 import
- [x] 上传/下载链路收敛进 `sftpStore`（`uploadFileDialog` / `uploadFolder` / `downloadTo` / `downloadToDefault`）+ `useUploadTarget` hook
- [x] `FileExplorer` 1082→993 行、`SessionFileTree` 812→729 行，两者 6 行重复片段 31 → 2
- [x] 删除死通道 `SESSION_RECONNECT_NOW`（常量表里有但从未注册也从未被调用）
- [x] 回归：`verify-ipc-registration.cjs`（`npm run test:ipc`，141 通道三层对账）、`probe-ipc-domains.cjs`（17 个域）

### v1.6.2 工具链：ESLint
- [x] 新增 `eslint.config.mjs`（ESLint 9 + typescript-eslint 8；主进程类型感知 / 渲染层加 React Hooks / 脚本单档）
- [x] 新增 `npm run lint` / `lint:fix` / `lint:scripts` / `lint:all` / `check`（typecheck + lint）
- [x] 首轮 49 条全部修掉，含两条真 bug：`?? []` 导致 `useMemo` 永不命中、`String(err ?? '')` 输出 `[object Object]`
- [x] 刻意不开 `semi` / `quotes` / `indent`（既有代码 23537 行不带分号是既定风格）

### v1.6.3 可维护性：最后两个上帝文件
- [x] `repository.ts` 764 → 70 行，8 个域搬到 `src/main/store/repo/`；保留 re-export barrel，40+ import 点零改动
- [x] `SettingsPanel.tsx` 959 → 118 行，拆成 `sectionUi.tsx` + 7 个 `*Section.tsx`
- [x] 回归：`verify-repository-split.cjs`（`npm run test:repository`，48 项行为断言）、`probe-settings-sections.cjs`（10 个分区）
- [x] 修 `smoke-cdp` 的偶发 FAIL：分区展开状态存 localStorage，改成「看到就停」的循环，脚本现在可重复运行

### 上一版对照：v1.5.2（已发布）

> 上一版 v1.5.1 的内容（目录批量读取 / cd 跟随 / 发布脚本代理探测）保留在 §1 末尾的「上一版对照」，需要回看时用。

### 修复：「跟随终端目录」开了却像没开
- [x] 根因不在解析层（`verify-shellcwd` 82 项 + `verify-cwdstore` 19 项全过），在展示层：`FileExplorer` 默认停在「工作区」Tab（一列快捷入口，不是目录树）
- [x] 第二个坑：面板常驻挂载、靠 `display` 切换，`cd` 事件都在隐藏时到达；首次挂载把 `followedSeq` 一次性对齐到当前序号，**挂载前**的 `cd` 被静默吞掉
- [x] 抽出零依赖纯函数 `src/renderer/src/lib/cwdFollow.ts`：`decideInitial` / `decideFollow`
- [x] `decideInitial`：有已知 cwd + 开着跟随 → `currentDir` 与 Tab **一起**定到 `fs`；无已知 cwd → 保留用户原选 Tab（此前硬编码 `'workspace'`）
- [x] `decideFollow`：显式区分「新事件 / 旧事件 / 空路径 / 关开关 / 断线 / 序号回退」六种分支；空路径不推进游标
- [x] 新增「手动重开跟随 → 立刻补跳一次」
- [x] 回归：新增 `scripts/verify-cwdfollow.cjs`（19 项，esbuild 打 CJS 直跑），并入 `npm run test:cwdfollow`

### 构建：产物目录切到 `dist-v13`
- [x] `electron-builder.yml` 的 `directories.output`
- [x] `scripts/release.ps1:33`、`scripts/build-release.sh:7`、`scripts/build-release.bat:6` 同步

### 随包发出：Low 完整性标签硬锁（v1.5.1 后未进包的部分）
- [x] `scripts/check-integrity.ps1` 重写：新增 `-Guard` / `-Unguard` / `-Skip` / `-Roots` / `-GuardRoots`
- [x] 硬锁 `npm run guard:integrity`：根目录加 `Everyone:(OI)(CI)(DENY)(WO)`，`SetNamedSecurityInfoW` 写 SACL 需要 `WRITE_OWNER`，锁掉后任何工具都打不上 Low
- [x] 两级扫描：每棵树一次 `icacls <dir> /T /C` 判有无 Low，命中才下钻，8 路并行；**25.9s → 5.8s**
- [x] 根因订正：打 Low 的是 DSH 自带 `@deepseek-ai/dsh-sandbox-windows-acl`（`buildLowLabelAcl` / `restrictTokenIntegrity`），不是 Codex

### 上一版对照：v1.5.1 目录批量读取 + cd 跟随（已发布）

- [x] 纯逻辑模块 `src/renderer/src/lib/shellCwd.ts`（零依赖，不 import store / IPC，便于 esbuild 打 CJS 单测）
- [x] 解析 `cd` / `pushd`，支持 `~`、相对路径、`..`、带空格与引号的路径、bracketed paste（`\x1b[200~` / `\x1b[201~`）
- [x] `Ctrl-U` / `Ctrl-W` / 方向键等编辑后保守丢弃整行；单行缓冲上限 `MAX_LINE = 4096`
- [x] OSC 7 上报优先覆盖，覆盖脚本内 `cd`、`pushd` / `popd`
- [x] 状态按 `sessionId` 隔离到 `src/renderer/src/stores/cwdStore.ts`，会话关闭 `forgetCwd(id)` 清 cwd / 追踪器 / home 缓存
- [x] 两处开关：`FileExplorer` 标题栏链状图标、设置 → 行为 →「跟随终端目录」
- [x] 配置项 `filesFollowTerminalCwd`（`src/shared/types.ts`），**缺省按开启**（判断写 `!== false`，老配置无需迁移）
- [x] 回归：`node scripts/verify-shellcwd.cjs`、`node scripts/verify-cwdstore.cjs`
- [x] 新增 IPC `SFTP_LIST_MANY`（`src/shared/ipc.ts` → `src/main/ssh/sftpManager.ts`），主进程内 `LIST_MANY_CONCURRENCY = 8`
- [x] 新增 IPC `SFTP_BOOTSTRAP`：首次打开面板一次往返拿回 `home + 目录内容`
- [x] 新增 `src/renderer/src/lib/dirLoader.ts`：同帧请求合并成 1 条批量 IPC（`setTimeout(0)` flush，**不用 rAF**——窗口不可见时会被节流挂起），按 `sessionId` 分段，切会话旧批次整批丢弃
- [x] 新增 `src/renderer/src/lib/dirCache.ts`：TTL 缓存 + stale-while-revalidate；模块级单例，不进 zustand
- [x] `FileExplorer` 加载 effect 改为「只加载缺失目录」，不再因 `version` 自增重读整棵已展开树
- [x] 实测：64 目录 1 条 IPC / 15.0ms，256 目录 1 条 / 1.1ms（旧路径 64 / 256 条）；真实 Electron 30 次连续读取中位 17.1ms、p95 30.0ms、61.5 FPS
- [x] 回归：`node scripts/verify-dirloader.cjs`、`node scripts/verify-dircache.cjs`、`node scripts/stress-cwd.cjs`、`npm run test:stress:e2e`
- [x] 修复 `currentDir` 跨会话串路径（cwd 存单个模块级变量 → 改按 `sessionId` 分键）
- [x] 修复 `scripts/release.ps1` 硬写代理 `127.0.0.1:7897`，改为启动探测、不通自动直连

### 评估后搁置：Gitee 作为更新源
- [x] 结论（用户 2026-10-26：「先暂时不搞」）：`electron-updater` 的 `providerFactory.js` 无 gitee 分支，写 `publish.provider: gitee` 打包期直接抛 `Unsupported provider: gitee`
- [x] Gitee Release 附件 CDN 对 `Range` 返回 **200 全量**而非 206；`isUrlProbablySupportMultiRangeRequests(url) = !url.includes('s3.amazonaws.com')` 会把 gitee URL 判成支持多 Range → 差分下载必失败并回落全量重下（且无断点续传）
- [x] 附件地址是带 `token` / `ts` 的时效签名，不能固化进 `latest.yml`
- [x] 唯一干净通道是 Gitee raw 路径（实测 206 + `Accept-Ranges: bytes`），但 82MB exe 进 git 历史不可接受
- [x] 当前仍是 `publish.provider: github` / owner `yanxici` / repo `ssh-workbench`，本条**回滚方法为改回 github**

### 上一版对照：v1.5.0 应用内自动更新（已发布）

- [x] `src/main/updater.ts` 状态机：`idle → checking → available → downloading → downloaded → error`
- [x] `autoDownload` 默认 **false**、`autoInstallOnAppQuit` 保持 **true**、异常全部吞进 `phase='error'` 不弹窗
- [x] `electron-builder.yml` 的 `publish` 段生成 `resources/app-update.yml`，配合 `.blockmap` 走差量
- [x] 更新专用代理走独立 net session 分区（`NET_SESSION_NAME = 'electron-updater'`），与 SSH 代理隔离
- [x] IPC：`update:state / check / download / install / open-release` + `evt:update-status`
- [x] 标题栏 `UpdateBadge`（启动约 8 秒静默检查一次）+ 设置 →「软件更新」（`UpdateSection`）
- [x] 仅 NSIS 安装版生效；portable / zip 不显示更新入口

---

## 2. 通用检查流程

### 2.1 类型检查

```bash
npm run typecheck   # 必须 EXIT=0
```

### 2.2 压测

```bash
npm run test:stress        # stress-test.js（连接规模）+ stress-cwd.cjs（目录批量 / cwd 解析吞吐）
npm run test:stress:e2e    # 真实 Electron：30 次连续目录读取
```

- [ ] 全部通过
- [ ] `stress-test-results/` 已更新（summary.txt + 4 个 json）
- [ ] 内存占用 < 100MB（2000 连接场景）
- [ ] 目录读取基线没退化：中位 ≈17ms / p95 ≈30ms / ≥55 FPS；`stress-cwd` 报的 IPC 条数等于批次而非目录数

### 2.3 版本号与日志

- [ ] `package.json:3` 的 `version` 已 bump
- [ ] `CHANGELOG.md` 顶部新增本版条目（Fixed / Added / Changed 分类）
- [ ] `README.md` 与 `README.zh-CN.md` 的「当前版本 / 最近更新」已同步
- [ ] `RELEASE_NOTES.md` 已按本版重写
- [ ] `DESIGN.md` 目录结构（§3）+ §5 对应小节 + §6 安全表 + §7 路线表 + §7.0 版本更新记录 + §9 已知限制 + §10 自检脚本清单 已补
- [ ] `USAGE_GUIDE.md` 新功能的使用说明已补（按用户视角写，不写实现细节）
- [ ] `RELEASE_CHECKLIST.md` §1「本次变更」已换成当次内容

### 2.3.1 环境准备（v1.6.2 起）

```bash
npm run check         # typecheck + lint，两者都必须干净
npm run test:features # 主机指纹 + 上传文件夹（纯 Node，零依赖）
npm run test:repository  # 数据层 48 项行为断言
npm run test:ipc      # 需要真实 Electron 主进程（会拉起 ipcMain）
```

- [ ] `npm run check` 零 error（lint warning 允许，error 不允许）
- [ ] 新增/修改逻辑配了对应回归脚本，并加进 `package.json` 的 `test:*`
- [ ] 纯搬家的重构**不能只跑 typecheck** —— 必须补行为断言（参考 `verify-repository-split.cjs`：48 项全打在读写语义上，不是行数）

### 2.4 构建

```bash
npm run check:integrity   # 必须先过（见 §0）；build:win 内已前置一次
npx electron-vite build
npx electron-builder --win --config electron-builder.yml   # 输出目录由 directories.output 决定，当前 dist-v13
```

- [ ] `out/main/index.js`、`out/preload/index.js`、`out/renderer/` 均生成
- [ ] rcedit 阶段没报 `Fatal error: Unable to commit changes`（报了说明旧 exe 还在跑，先杀进程）
- [ ] 产物齐全（**本地仍出三件套**，只是远端不全传）：
  - `ssh-workbench-Setup-<ver>.exe` + `ssh-workbench-Setup-<ver>.exe.blockmap`
  - `ssh-workbench-<ver>-portable.exe`
  - `ssh-workbench-<ver>-win.zip`
  - `latest.yml`
- [ ] **产物名不带空格、不带 `v` 前缀**。这条是自动更新的硬要求：`electron-builder` 生成 `latest.yml` 时把空格换成 `-`，GitHub 上传时把空格换成 `.`，两边规则不同 → latest.yml 里的下载地址恒 404（v1.4.1 踩过）。所以 `nsis.artifactName` / `portable.artifactName` 都用 `${name}` 而不是 `${productName}`
- [ ] 打完再跑一次 `npm run check:integrity` —— Codex 沙箱服务可能在构建期间把 IL 打回 Low

### 2.5 打包产物冒烟（不能只测源码态）

源码态过了不代表产物能过——asar 打包、资源路径、原生层图标都可能变。

```powershell
# 注意：shell 里若存在 ELECTRON_RUN_AS_NODE，Electron 会被当纯 Node 跑，冒烟必挂
Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue
Start-Process "dist-v13\win-unpacked\SSH Workbench.exe" -ArgumentList '--remote-debugging-port=9337'
npm run smoke:cdp            # 或 node scripts/smoke-cdp.cjs 9337
```

> `scripts/smoke-cdp.cjs` 零依赖（Node 22+ 自带 `WebSocket`），11 项：标题 / 渲染挂载 / 活动栏入口 / 五个主视图视觉溢出 / 设置面板可开 / 「跟随终端目录」开关可见 / 无 console.error。
> **溢出判定用「元素矩形超出视口」，不用 `scrollWidth > clientWidth`** —— 侧栏里大量 `truncate` 文本本来就是 `scrollWidth` 大于 `clientWidth`（这正是省略号的实现方式），按后者判会把每一行截断文本都算成溢出，几百个假报。

- [ ] 进程存活，`title=SSH Workbench`
- [ ] `npm run smoke:cdp` 11/11 通过
- [ ] 通过 CDP 验证本次改动的关键交互
- [ ] 全视图溢出扫描 0 处
- [ ] v1.6.x 专项（都已在 `scripts/probe-*.cjs` 里脚本化，逐个跑）：
  - [ ] `node scripts/probe-packaged-features.cjs <port>` → 10/10：preload 新 API 真进包、`known:refresh` 拒绝非法指纹、`sftp:scan-folders` 统计正确
  - [ ] `node scripts/probe-ipc-domains.cjs <port>` → 17/17：每个 IPC 域挑一个代表通道都能调通
  - [ ] `node scripts/probe-settings-sections.cjs <port>` → 20/20：设置面板 10 个分区逐个展开，渲染出真实控件（不是空壳），主题切换生效
  - [ ] 上传文件夹：选一个含子目录 + 空目录的文件夹 → 远端出现同名目录树，空目录也在
  - [ ] 拖拽目录上传 → 仍按老语义铺平（远端不出现目录名那一层）
  - [ ] 指纹更新：点某条记录的指纹按钮 → 弹「旧 → 新」对比 → 取消后记录不变 → 再确认后记录更新
- [ ] 上一版专项（v1.5.2，跟随终端目录）：
  - [ ] 开着跟随、启动后**第一次**打开文件面板 → 直接停在「文件系统」Tab（不是「工作区」快捷入口）
  - [ ] 面板还**没打开**时先 `cd /tmp`，再打开面板 → 直接跳到 `/tmp`（挂载前的 `cd` 不再被吞）
  - [ ] 面板正停在目录树里，切走再切回 → 仍停在目录树，不被踢回「工作区」

### 上一版专项对照：v1.5.1
  - [x] 终端敲 `cd /tmp` → 文件面板跳到 `/tmp`
  - [x] 展开一棵 3 层以上的目录树 → DevTools Network 里 `SFTP_LIST_MANY` 次数远少于目录数（不是一目录一条）
  - [x] 折叠再展开同一目录 → 第二次直接命中缓存（无请求）
  - [x] 切标签再切回来 → 面板还在各自会话的目录，不串台
  - [x] 关掉跟随开关后再 `cd` → 面板不动

> 冒烟脚本注意：点选后**不要**在同一个 `Runtime.evaluate` 里同步读 `input.value`，React 还没重渲染会误判 FAIL。改成 click → 等 300~500ms → 另起一次 evaluate 读值。
> 另一个坑：上一轮测试残留的弹窗/浮层会污染下一轮，每轮开头先关掉所有 `[role="dialog"]`，必要时重启应用。
> 第三个坑（v1.6.3 修）：设置分区的展开状态存在 `localStorage`（key `sshwb.settings.sections`），所以**不能假设「点一下就会展开」** —— 上一轮已经展开过的话，再点就是收起。UI 脚本要用「看到就停」的循环（`smoke-cdp.cjs` 已按此改写）。
> 压测驱动也别用 `window.__lazy_test.stores` —— `ZM_TEST` 只在验证构建里注入，打包产物没有这个钩子，脚本会「45 个动作 45 个错误」假装跑完。改用真实输入：`pressKey('K', ['control'])`、`document.querySelector('[data-activity=...]').click()`。

### 2.6 提交与发布

```bash
git add <具体文件>          # 不要 git add .
git commit -m "fix(scope): 简述"
git tag -a v<ver> -m "v<ver>"
git -c http.proxy=http://127.0.0.1:7897 push origin main
git -c http.proxy=http://127.0.0.1:7897 push origin v<ver>
```

- [ ] commit 信息能说清「改了什么 + 为什么」
- [ ] tag 与 `package.json` 版本一致
- [ ] push 走本地代理（直连 GitHub 不可达；端口不通就换直连，别把 7897 写死在脚本里 —— v1.5.1 已改成启动探测）

### 2.7 GitHub Release

> #### ⚠️ 先处理自带 CI：`.github/workflows/release.yml`
>
> 仓库里有一个 **push tag 即触发**的 workflow，它会在 windows-latest 上跑 `npm run build:win` **自己打包并上传**。v1.6.0~v1.6.3 每次都撞上了，症状：
>
> - `gh run list` 四版全是 `failure` —— 挂在最后一步 `create-release`，报 `already_exists: tag_name`（因为我们已经手工建过 Release）
> - 但它的 `build:win` **在失败之前就跑完了**，产物按 `electron-builder.yml` 输出到 `dist-v13`，**覆盖掉本地刚打好的包**
> - 结果 Release 里出现两套字节数不同的同名资产；`latest.yml` 指向 CI 那一份，本地那份对不上 —— 自动更新的 `sha512` 校验会失败
>
> **选一种处理并写进本次记录**：
>
> 1. **以本地构建为准**（推荐，本地跑了完整回归 + 冒烟）：tag 推完等 CI 结束，再用 `gh release upload ... --clobber` 把本地三件套 + `latest.yml` 全部覆盖，并删掉 CI 用短横线命名的那份 zip（`gh release delete-asset`）
> 2. **以 CI 构建为准**：本地一个资产都不传，等 CI 传完再验
>
> **无论哪种，发布后必须核对 `latest.yml` 的 `sha512` 与远端 Setup 的实际哈希一致**，否则用户点「立即更新」会在校验阶段失败：
>
> ```bash
> curl -sL -o /tmp/s.exe "<release>/ssh-workbench-Setup-<ver>.exe"
> node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha512').update(f.readFileSync(process.argv[2])).digest('base64'))" /tmp/s.exe
> # 与 latest.yml 里的 sha512 逐字符比对，同时核对 size
> ```
>
> 另注意 GitHub CDN 有缓存：刚 `--clobber` 完 `latest.yml` 读到的可能还是旧内容，等几十秒或加 `?t=<随机数>` 再读。

- [ ] 创建 Release，tag 选中刚推的
- [ ] 正文用 `RELEASE_NOTES.md` 内容
- [ ] **远端资产口径**（用户 2026-10-26 定的规则，v1.6.x 实际执行如下）
  - **最小口径（规则原文）**：只传 `ssh-workbench-Setup-<ver>.exe` + `.blockmap` + `latest.yml` —— 后两个是自动更新元数据，不是"另一个版本"，缺了客户端查不到更新 / 无法差量下载
  - **不传**：`portable.exe`、`win.zip` —— 与 Setup 解出来的 `win-unpacked` 一致，多传白费 200+ MB
  - **v1.6.x 实际做法（偏离了规则，需用户确认）**：三个产物全传了，因为 CI 先传过一套、`--clobber` 覆盖时干脆一起传齐了。**下次发版请按最小口径**，除非用户明确要 zip/portable
  - 本地 `dist-v13` 照样出三件套，这条**只约束远端上传**
- [ ] asset `state=uploaded`，体积与本地一致
- [ ] 回读 release 的 `assets` 数组：恰好 3 个文件，无 portable / zip
- [ ] 上传前跑过 `check-integrity.ps1`（`scripts/release.ps1` 会替你拦一道）

> 凭证：`git credential fill` 可取到系统凭证管理器里的 token（用户 `yanxici`，scope 含 `repo`）。上传走 `https://uploads.github.com`；`NODE_TLS_REJECT_UNAUTHORIZED=0` 只在本地网络有 TLS 中间人时需要。

### 2.8 发布后验证

- [ ] Release 页面可访问，asset 可下载
- [ ] 三个产物 + `latest.yml` 逐个 `curl -r 0-1048575` 验：返回 **206** 且 1MB，文件头 `4d5a`（exe）/ `504b`（zip）
- [ ] `git status` 干净（临时脚本、日志都已清理）
- [ ] 用户数据零影响：`connections.json` 条数与 id 哈希在压测/打包前后一致（动过数据层时必须比）
- [ ] 杀掉所有残留的 `SSH Workbench` / `electron` 进程
- [ ] 本地旧版本产物已清理（`dist-v13/` 只留本版三件套 + `win-unpacked`），避免几百 MB 历史包堆积

---

## 3. 退出条件

全部页面测试项通过 + 冒烟在**打包产物**上通过 + Release asset 完整，才算发布完成。

保留上一版安装包以便回滚。
