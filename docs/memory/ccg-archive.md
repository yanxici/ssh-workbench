# CCG 记忆归档 · ssh-workbench

> 间歇归档（第 10 轮）。每条按 CCG 六要素记录：功能名 / 生效条件 / 子功能 / 执行 / 验证方式 / 不适用条件。

---

## ⚠️ 纪律条款 0（用户明确要求，优先级最高）— `sshwb-rule-check-integrity-first`

- **功能名**：Windows 上「程序/构建产物明明存在却跑不起来」的**第一顺位检查项**
- **生效条件**：出现以下任一现象，**必须最先**检查所在文件夹的完整性级别，排在 exe 损坏、asar 损坏、依赖缺失、ACL deny、企业策略、架构不匹配之前
  - 双击无反应、窗口一闪而过
  - 退出码 `-2147483645` / `0xC0000005` / `EXCEPTION_BREAKPOINT`
  - 同一份文件换个目录就能跑，原地就崩
  - 打包工具报 `rcedit` / 写文件类莫名失败
- **子功能**：
  1. 一条命令读目标目录（含所有祖先目录）的完整性标签
  2. 判定 `Low` / `Medium` / `High` / `System`
  3. 若为 `Low` → 直接修复，不再往下查别的假设
- **执行**：
  ```powershell
  icacls "<DIR>" | Select-String "Mandatory"
  # 命中 Low 就修：
  icacls "<DIR>" /setintegritylevel "(OI)(CI)Medium" /T
  ```
- **验证方式**：修完立刻重跑程序，看到主窗口 title 与 `[main] renderer page loaded` 即成立；标签复查输出 `Medium`
- **不适用条件**：报错文本明确是 `Access is denied`（ACL 拒绝）、`ERROR_SHARING_VIOLATION`（文件被占用）、缺 DLL/模块、或崩溃栈里没有沙箱/完整性相关帧时，另行按对应节点排查

> **教训来源**：本次「SSH Workbench 打不开」排查中，先后误判为 exe 损坏、asar 损坏、ACL deny、企业 EDR 拦截，绕了很远才定位到 `Mandatory Label\Low`。根因只有一条：**目录被打了 Low 完整性标签**。以后按本条先查，一步到位。

---

## ⚠️ 纪律条款 1（用户明确要求）— `sshwb-rule-release-upload-setup-only`

- **功能名**：GitHub Release 资产上传口径
- **生效条件**：每次给 ssh-workbench 建/补 GitHub Release 时，无条件生效
- **子功能**：
  1. **只上传 NSIS 安装包** `ssh-workbench-Setup-<version>.exe`
  2. **不上传** `-portable.exe`、`-win.zip`（以及任何其它"可安装/可运行版本"的重复打包形态）
  3. 自动更新的配套元数据 `latest.yml` 与 `<Setup>.exe.blockmap` **必须**随安装包一起传 —— 它们不是"另一个版本"，缺了客户端就查不到更新 / 无法差量下载
- **执行**：
  ```
  上传：ssh-workbench-Setup-<ver>.exe
        ssh-workbench-Setup-<ver>.exe.blockmap
        latest.yml
  跳过：ssh-workbench-<ver>-portable.exe
        SSH Workbench-<ver>-win.zip
  ```
- **验证方式**：`GET /repos/yanxici/ssh-workbench/releases/<id>` 回读，`assets` 数组应恰好含那 3 个文件名，无 portable / zip
- **不适用条件**：
  - 用户当次明确要求附加 portable 或 zip（单次例外，不改本条款）
  - 本地 `dist-v11` 打包产物仍然是三件套 —— 本条只约束**远端上传**，不影响本地出包

> **要求来源**：用户 2026-10-26 明确指示"以后远端 release 只上传安装包就行 其他安装版本不上传"。历史前科：v1.4.2 传了 zip + portable + Setup 三件（约 264MB），其中 portable 与 zip 内容与 Setup 完全重叠，纯属白费带宽。

---

## node `sshwb-launch-integrity-low` — Electron 在该目录启动崩溃的真正根因

- **功能名**：Electron 应用在 Windows 上「点了没反应 / 主进程秒退」的启动失败诊断
- **生效条件**：目标目录的完整性标签被设为 `Low`（浏览器/下载降权标记），Electron 主进程以 Medium 运行时其渲染/GPU 子进程沙箱初始化被拦，抛 `EXCEPTION_BREAKPOINT`，进程以 `-2147483645`(0xC0000005 类) 退出
- **子功能**：
  1. 判定退出码族：`-2147483645` / `0xC0000005` / 无窗口秒退 → 走本节点
  2. 读当前标签：`icacls "<DIR>" | Select-String "Mandatory"`
  3. 读取复现实验：新建目录 → `icacls /setintegritylevel Low` → 立刻复现崩溃；改回 Medium → 立刻恢复
  4. 修复：`icacls "<DIR>" /setintegritylevel "(OI)(CI)Medium" /T`
- **执行**：
  ```powershell
  icacls "D:\ssh-workbench" | Select-String "Mandatory"
  icacls "D:\ssh-workbench" /setintegritylevel "(OI)(CI)Medium" /T
  ```
  实测 `D:\ssh-workbench` 标签由 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` 改为 `Medium` 后，`dist-v11\win-unpacked\SSH Workbench.exe` 直接启动成功（`title=SSH Workbench`, `responding=True`）。
- **验证方式**：
  - 标签核对：`icacls <DIR> | Select-String "Mandatory"` 输出含 `Medium` 且不再含 `Low`
  - 行为核对：启动后 `Get-Process -Name "SSH Workbench"` 存在带 `MainWindowTitle` 的进程；stdout 看到 `[main] renderer page loaded`
  - 反证：把新目录打回 `Low` 必须重现 `-2147483645`，否则结论不成立
- **不适用条件**：
  - exe 被**运行中实例占用**而打包失败（`rcedit: Unable to commit changes`）——那是文件锁，与完整性标签无关
  - asar 损坏 / 缺 `node_modules` / 架构不匹配导致的启动失败
  - 标签为 `System`（保护进程）或 ACL 显式 deny ACE 造成的拒绝访问（那是 `ACCESS_DENIED`，不是 `EXCEPTION_BREAKPOINT`）
  - 企业 EDR/DLP 直接杀进程的情况（无 stderr 栈、无 `EXCEPTION_BREAKPOINT`）

---

## node `sshwb-pack-verify-chain` — 从源码到可分发三产物的验证链

- **功能名**：electron-vite + electron-builder 的 Windows 三产物打包与验证
- **生效条件**：仓库含 `electron-builder.yml`（`output: dist-v11`、`asar: true`、`npmRebuild: false`、target = nsis/portable/zip），`package.json` 有 `build` = `electron-vite build`
- **子功能**：编译 → 打包 → 产物核对 → 启动冒烟
- **执行**：
  ```powershell
  cd D:\ssh-workbench
  Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue   # 关键
  npx electron-vite build
  npx electron-builder --win --config electron-builder.yml
  ```
- **验证方式**：
  - 三产物字节尺寸基准：`Setup 1.4.2.exe` 78.60 MB / `-1.4.2-portable.exe` 78.40 MB / `-1.4.2-win.zip` 106.90 MB（1.4.2 实测值，可用于回归比对）
  - `win-unpacked` 目录文件数基准：**107**（1.4.2 实测；曾出现 108，差异来自个别资源文件）
  - 启动冒烟必须看到 `[main] boot: module loaded` → `app ready` → `ipc registered` → `window created` → `renderer page loaded`
- **不适用条件**：
  - shell 里存在 `ELECTRON_RUN_AS_NODE=1`（process/user/machine 三层任一）时冒烟必失败，退出码 3 或 `0xC0000005` —— 这是环境变量污染，不是打包问题，须先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`
  - `dist-v11\win-unpacked\SSH Workbench.exe` 被运行中实例占用时 electron-builder 会 `rcedit` 报错重试 3 次，须先全部 `Stop-Process`
  - 目标目录完整性标签为 `Low` 时**产物正确但启动必崩**，属上一节点 `sshwb-launch-integrity-low`

---

## node `sshwb-cwd-rename-lock` — 工作目录被会话 cwd 钉住导致无法重命名

- **功能名**：仓库目录重命名失败的判定
- **生效条件**：目标目录是当前 DSH/runner 会话的 cwd（`DeepSeek Harness.exe -- runner.js` 把 cwd 钉在里面）
- **子功能**：区分「权限不足」「策略拦截」「文件锁」三类重命名失败
- **执行**：`Rename-Item -LiteralPath "D:\ssh-workbench" -NewName "sw-rename-final"`
- **验证方式**：报错文本为 `The process cannot access the file because it is being used by another process.`（即 `ERROR_SHARING_VIOLATION`）→ 判定为 cwd 锁；此时 ACL / 完整性标签均无法解释该错误
- **不适用条件**：
  - 报 `Access is denied` → 是 ACL 或完整性标签问题，走 `sshwb-launch-integrity-low` 的标签检查
  - 目标目录被资源管理器 / 杀软扫描句柄占用（此时关掉会话也仍失败，需 `handle.exe` 定位）
  - 跨卷移动（那是复制删除语义，不是重命名）

---

## node `sshwb-workspace-topology` — 当前三目录分工（2026-10-26 定稿）

- **功能名**：ssh-workbench 相关目录的职责划分
- **生效条件**：本机 `D:` 盘，用户 `yuzhu22`
- **子功能**：
  - `D:\ssh-workbench` —— git 仓库，HEAD `d4785d5`（tag `v1.4.2`），完整性标签已修为 Medium，`dist-v11\win-unpacked` 已恢复，**可直接运行 exe**
  - `D:\ssh-workbench-ws` —— 备选新工作区（632.9 MB 全量，含 node_modules/.git），构建打包均已验证通过，但当前不作为主工作区
  - `D:\ssh-workbench2` —— 纯运行目录，桌面快捷方式 `C:\Users\yuzhu22\Desktop\SSH Workbench - 快捷方式.lnk` 指向 `D:\ssh-workbench2\SSH Workbench.exe`
- **执行**：无需操作，仅作定位参考
- **验证方式**：
  - `Test-Path "D:\ssh-workbench\dist-v11\win-unpacked\SSH Workbench.exe"` → `True`
  - `icacls "D:\ssh-workbench" | Select-String "Mandatory"` → `Medium Mandatory Level`
- **不适用条件**：若后续把主工作区迁到 `D:\ssh-workbench-ws`，本节点需更新；`dist-*` 被 `.gitignore` 忽略（含 `dist-*` 通配），删除产物不影响 git 状态

---

## node `sshwb-update-availability-matrix` — 自动更新在四种运行形态下的可用性

- **功能名**：应用内自动更新（`src/main/updater.ts`）在「源码开发态 / win-unpacked 目录版 / portable 单文件版 / NSIS 安装版」四形态下的实际行为
- **生效条件**：判断「为什么我这版看不到更新提示」时无条件适用，先查本节点再查网络/发布源
- **子功能**（2026-10-26 实测，非推断）：
  1. **源码开发态**（`D:\ssh-workbench` 下 `electron .`）—— **完全不可用**。`initUpdater` 里 `const enabled = app.isPackaged || DEV_ENABLED`，`DEV_ENABLED = process.env['SSHWB_UPDATE_DEV'] === '1'`（`src/main/updater.ts:58`）。未打包时直接 `return () => undefined`，状态恒为 `idle`，渲染层 `isUpdateVisible(status)` 判 false → 标题栏不显示任何更新 UI。日志特征：`[main] [updater] disabled (not packaged). set SSHWB_UPDATE_DEV=1 to force`
  2. **win-unpacked 目录版**（`dist-v11\win-unpacked\SSH Workbench.exe`）—— **能查、能下，但装不了**。`app.isPackaged` 为 true、`resources/app-update.yml` 存在（owner/repo/provider=github），日志出现 `[updater] Checking for update`，状态正常 `idle→checking→available`。但 `quitAndInstall` 最终走 `NsisUpdater.doInstall`，它 `spawnLog(installerPath, ['--updated', '--force-run', ...])` 拉起 NSIS 安装器替换**安装目录**里的文件——目录版没有安装记录，替换的是别处的安装副本，或直接报错
  3. **portable 单文件版**—— 同样无安装上下文，`--force-run` 无法定位自身，不可用
  4. **NSIS 安装版**—— **唯一完整可用**。安装目录写在注册表，`doInstall` 能定位并替换
- **执行**：
  ```powershell
  # 判定当前跑的是哪种形态（打包产物才有 app-update.yml）
  Test-Path "<APP_DIR>\resources\app-update.yml"
  # 强开开发态更新（仅调试链路用，仍无安装目标）
  $env:SSHWB_UPDATE_DEV="1"; npx electron .
  # 用本地 feed 覆盖发布源做灰度/离线验证
  $env:SSHWB_UPDATE_URL="http://127.0.0.1:8788"
  ```
- **验证方式**：
  - 开发态：日志 `[updater] disabled (not packaged)`，CDP 读 `window.api.update.state().then(r=>r.data)` → `{"phase":"idle","currentVersion":"1.5.0",...}`，`document.querySelectorAll('button')` 里搜不到「更新」chip（实测返回 `null`）
  - 目录版：日志 `[updater] proxy: system` → `[updater] Checking for update`；`resources/app-update.yml` 存在且含 `provider: github`
- **不适用条件**：
  - 用户要的是「开发时也能看到更新提示」——那不是修 bug，是改产品语义，需求得先确认
  - 若将来给 portable 版做了自替换逻辑（下载新版 exe 后改名为自身并重启），第 3 条需重测

---

## node `sshwb-gitee-update-infeasible` — 把更新源换成 Gitee 的三个硬阻塞（2026-10-26 实测，暂不实施）

- **场景**：用户问「项目传到 gitee 了，客户端更新走 gitee 是不是就不用代理」。网络层结论成立，工程层不成立。
- **网络层实测（直连、不挂 7897）**：
  - `https://gitee.com/` → HTTP 200，3.2s
  - `https://gitee.com/yanxici` → HTTP 200
  - `https://github.com/` → 超时 exit 28（10s 无响应）
  - 即：git push / 客户端拉更新确实可以脱离代理
- **硬阻塞 1 — `electron-updater` 无 gitee provider**：
  - `node_modules/electron-updater/out/providers/` 仅 `GenericProvider` / `GitHubProvider` / `GitLabProvider` / `BitbucketProvider` / `KeygenProvider` / `PrivateGitHubProvider`
  - `node_modules/electron-updater/out/providerFactory.js` 的 `switch (provider)` 无 gitee 分支
  - 写 `publish.provider: gitee` → 打包期直接抛 `Unsupported provider: gitee`
  - 唯一退路：`provider: generic` + 自托管 latest.yml
- **硬阻塞 2 — Gitee Release 附件 CDN 忽略 Range（最关键）**：
  - 稳定路径 `https://gitee.com/<owner>/<repo>/releases/download/<tag>/<file>` → 302 → `gitee.com/.../attach_files/<id>/download/<file>` → 302 → `foruda.gitee.com/attach_file/<id>/<file>?token=...&ts=...`
  - 对最终 CDN 地址发 `Range: bytes=0-99` → 返回 **HTTP 200 + Content-Length: 364940（全量）**，不是 206；`HEAD` 无 `Accept-Ranges`
  - 而 `providerFactory.js:53` 是 `isUseMultipleRangeRequest: options.useMultipleRangeRequest !== false && isUrlProbablySupportMultiRangeRequests(options.url)`，其中 `isUrlProbablySupportMultiRangeRequests(url) = !url.includes("s3.amazonaws.com")`
  - **gitee URL 不含 `s3.amazonaws.com` → 被判定支持多 Range → 差分下载必失败 → 回落 `AppUpdater.js:724` 的全量重下**
  - 后果：能装，但每次更新都全量拉 82MB，且无断点续传。与本地自建 feed 不支持 Range 是同一个坑
- **硬阻塞 3 — 签名 URL 有时效，latest.yml 不能固化 CDN 地址**：
  - `foruda.gitee.com/attach_file/...?token=<hex>&ts=1793009454&attname=...`，`ts` 是过期时间戳
  - latest.yml 里必须写稳定路径（每次请求重新走 302 拿新签名），不能写最终 CDN 地址
- **对照：Gitee raw 文件支持 Range（唯一干净的 206 通道）**：
  - `https://gitee.com/<owner>/<repo>/raw/<ref>/<path>` → 302 → `raw.giteeusercontent.com/...`
  - 发 `Range: bytes=0-1023` → **HTTP 206，`Content-Range: bytes 0-1023/1575`，`Accept-Ranges: bytes`**
  - 但 82MB exe 进 git 历史不可接受，且顶 Gitee 单文件 100MB 限制 → 需要独立静态托管
- **私有仓库前置问题（实测当前状态）**：
  - `https://gitee.com/api/v5/users/yanxici/repos` → `count=0`
  - `https://gitee.com/yanxici/ssh-workbench` → 404；`ssh-workbench` / `SSH-Workbench` / `ssh_workbench` / `workbench` 全部 404
  - 即仓库是私有的。私有 Release 附件需认证，`generic` provider 只能靠 `autoUpdater.requestHeaders` 塞 `Authorization`，等于把 access_token 硬编码进 asar（反编译即可取出）
  - 公开化的替代风险：Gitee 对公开仓库有内容审核下架机制
- **三条候选路线（均未实施）**：
  1. `generic` + Release 稳定路径 —— 改动最小，受硬阻塞 2 影响（每次全量、无差分）；注意 `/releases/download/latest/<file>` 别名实测 **404**，得每版更新 latest.yml 或用固定 tag 滚动覆盖
  2. `generic` + raw 文件 —— 差分可用（206 已验证），但受 git 体积 / 100MB 单文件限制
  3. 双源（GitHub 主 + gitee 兜底）—— `src/main/updater.ts:276-279` 已有 `SSHWB_UPDATE_URL` 覆盖钩子（`autoUpdater.setFeedURL({ provider: 'generic', url: ... })`），无需改架构
- **现状**：用户明确「先暂时不搞」。当前发布链路仍为 `publish.provider: github` / owner `yanxici` / repo `ssh-workbench`，未做任何改动。
- **不适用条件**：
  - 若将来 Gitee Release 附件 CDN 开始支持 Range（206），硬阻塞 2 消失，方案 1 可直接用
  - 若改用自建对象存储 / OSS，Range 通常天然支持，本条整段不适用

---

## 附：环境坑位速查

| 现象 | 原因 | 处置 |
|---|---|---|
| `python` 命令不存在 | Windows 应用执行别名拦截 | 用 `node -e` 生成 JSON |
| Git Bash 的 `/tmp` 与 node 解析不一致 | 路径语义差异 | 用仓库内相对路径 |
| 直连 GitHub 超时 | 网络受限 | `git -c http.proxy=http://127.0.0.1:7897 ...` |
| `The trust relationship between this workstation and the primary domain failed.` | 域信任关系异常（stderr 噪音） | 不影响本地文件操作，忽略 |
