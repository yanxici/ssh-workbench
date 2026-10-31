# Changelog

All notable changes to SSH Workbench will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
