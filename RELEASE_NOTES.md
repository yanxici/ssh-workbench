# SSH Workbench v1.5.1 Release Notes

> 两个都在"手感"上：**侧栏点开远端目录不再卡一下**，以及**终端 cd 到哪儿，侧栏文件面板就跟到哪儿**。

## ⚡ 侧栏打开远端目录：从"逐层串行往返"改成"一次问完"

### 以前为什么慢

老链路每展开一层目录都要走一整串串行往返，而且渲染层每次状态变化都会**把所有已展开目录重新拉一遍**：

1. `sftp.realpath('.')` → 拿 home，单独一个 SSH 往返
2. `sftp.readdir(home)` → 再一个往返
3. 展开某个子目录 → 又一个 `readdir`
4. 每展开一次，`bumpTree()` 让 `version` 自增，`FileExplorer` 的加载 effect 依赖 `version`，于是**整棵树（所有已展开目录）全部重读一遍**

展开 10 个目录、其中 3 层嵌套的话，光是重复 `readdir` 就有几十次，每次都是几十到几百毫秒的 RTT。远端在内网穿透 / 跨国链路上时，这个串行叠加非常明显。

### 现在怎么做的

| 改动 | 位置 | 效果 |
|---|---|---|
| 新增 `SFTP_LIST_MANY` | `src/shared/ipc.ts`、`src/main/ssh/sftpManager.ts` | 一次 IPC 批量 `readdir` 任意多个目录，主进程内部 8 并发（`LIST_MANY_CONCURRENCY = 8`）跑 SSH 请求 |
| 新增 `SFTP_BOOTSTRAP` | `src/main/ssh/sftpManager.ts` | 首次打开文件面板一次往返拿回 `home + 该目录内容`，省掉 `realpath → readdir` 的串行等待 |
| 新增 `src/renderer/src/lib/dirLoader.ts` | 渲染层 | 同一帧内所有目录请求合并成 1 条批量 IPC；按会话分段，切换会话/关闭会话时旧批次整批丢弃，回来不会串台 |
| `src/renderer/src/lib/dirCache.ts` | 渲染层 | 目录结果带 TTL 缓存，重复展开直接命中，不再回源 |
| `FileExplorer` 加载 effect 重写 | `src/renderer/src/components/files/FileExplorer.tsx` | 只加载**缺失**的目录，已有缓存的跳过；依赖收敛，不再"展开一次全树重走" |

### 实测数字

`scripts/stress-cwd.cjs`（跑的是线上那份 `.ts` 源码）：

| 场景 | IPC 次数 | 耗时 |
|---|---|---|
| 64 个目录同帧请求 | **1** 条（旧路径 64 条，省 98%） | 15.0ms |
| 256 个目录同帧请求 | **1** 条（旧路径 256 条，省 100%） | 1.1ms |

`scripts/stress-e2e.cjs`（真实 Electron + 真实主进程 + 真实渲染层 bundle）：

- 30 次连续目录读取：中位 **17.1ms**，p95 **30.0ms**
- 文件面板帧率：**61.5 FPS**
- 冷启动 FCP：**812ms**

## 🧭 终端 `cd` 之后，侧栏自动跟过去

在终端里敲 `cd /var/log/nginx`，侧栏「文件」面板同步跳到那个目录，并逐级展开父目录。

### 怎么拿到当前目录

两条路一起用，谁先到算谁：

1. **输入追踪**（`src/renderer/src/lib/shellCwd.ts`）：解析你在终端里敲的整行，`cd` / `pushd` 直接算目标路径。支持 `~`、相对路径、`..`、带空格引号路径，支持 bracketed paste（粘贴进来的一整块里带 `cd` 也认），`Ctrl-U` / `Ctrl-W` / 方向键等编辑操作后保守丢弃整行（宁可不动，不会跳错）
2. **OSC 7 序列**：远端 shell 若配置了上报当前工作目录（很多发行版的默认 `bash` / `zsh` 配置已经带），终端直接收到真实 cwd，程序化 `cd`、脚本里 `cd`、`pushd` / `popd` 都能跟上

> 两层叠加的原因：输入追踪零延迟但只认"人敲的 cd"；OSC 7 能覆盖脚本和程序化切换但要远端配合。两者互为兜底，不会打架。

### 配套细节

- **可关**：文件面板标题栏有链状图标，一键开关；设置 → 行为 → 「跟随终端目录」也能关
- **默认开**：老配置文件里没这个键同样按开启处理（`filesFollowTerminalCwd !== false`）
- **切会话不串台**：`src/renderer/src/stores/cwdStore.ts` 按 `sessionId` 隔离；会话关闭时 `forgetCwd(id)` 清掉 cwd / 输入追踪器 / home 缓存，重连复用同一个 id 也不会带着上一台机器的路径跳过去
- **解析开销极低**：200,000 行（含 1/3 是 `cd`）解析共 143.5ms，约 **139 万行/秒**；每行 1.3µs，打字时完全无感

## 🐞 顺带修的

- `currentDir` 会带着上一个会话的路径进新会话（跟随功能的副产品，一并修掉）
- 发布脚本 `scripts/release.ps1` 默认挂死代理 `127.0.0.1:7897`，换网络环境就整个发不出去。现在启动时先探端口，探测不到自动改直连

## 🛡️ 发版加固：不再发出「装完打不开」的安装包

这次排查到一个会让用户彻底失去信任的坑：产物本身字节完好，但目录被打上 **`Low` 完整性标签**后，Electron 的沙箱子进程会在启动瞬间被杀 —— 表现就是**双击 exe 毫无反应**，而把同一个 exe 拷到别的目录又能正常跑。

现在三道闸：

| 闸 | 位置 | 作用 |
|---|---|---|
| `npm run check:integrity` | 手动 / CI 均可 | 扫仓根 + 所有 `dist*` + 其中的 `*.exe` / `*.dll`，命中 `Low` 退出码 1 |
| `npm run fix:integrity` | 手动（需管理员令牌） | 把命中的目录树改回 `Medium` |
| `build:win` 前置 + `release.ps1` 上传前校验 | 自动 | 带 `Low` IL 的包在打包阶段与发布阶段各拦一次 |

> 复发源是外部程序（Codex 的 Windows 沙箱服务会给「信任工作目录」打 `Low` IL），不是代码问题，所以这条检查要长期留着。

## 🙅 本次没有做的

**Gitee 作为更新源** —— 评估后按你的意思「先暂时不搞」，原因记在这里省得下次重复调研：

- `electron-updater` 的 `providerFactory.js` 里没有 gitee 分支，写 `publish.provider: gitee` 打包期直接抛 `Unsupported provider: gitee`
- Gitee Release 附件 CDN 对 `Range` 请求返回 **200 全量**而不是 206，而 `isUrlProbablySupportMultiRangeRequests()` 只排除了 `s3.amazonaws.com`，gitee URL 会被判成「支持多 Range」→ 差量下载必失败并回退成全量重下（且没有断点续传）
- 附件下载地址带 `token` / `ts` 时效签名，没法固化进 `latest.yml`
- 唯一干净通道是 Gitee raw 路径（实测 206 + `Accept-Ranges: bytes`），但 82MB 的 exe 进 git 历史不可接受

更新源仍是 GitHub（`yanxici/ssh-workbench`）。

## 🔧 从旧版本升级

1. 下载 `ssh-workbench-Setup-1.5.1.exe` 安装，会覆盖旧版本（已装 1.5.0 的话标题栏会直接提示更新）
2. 连接配置、命令库、诊断项、历史记录都不受影响（都存在 `%APPDATA%/ssh-workbench/data/`）
3. 老配置无需迁移，新设置项都有合理默认值

## 📥 关于产物

GitHub Release **只上传安装包**：`ssh-workbench-Setup-1.5.1.exe`、其 `.blockmap`、`latest.yml`。后两个是自动更新的元数据，缺了客户端查不到更新 / 走不了差量下载。

portable 与 zip 解出来的 `win-unpacked` 与安装包完全一致，多传只是白费 200+ MB 带宽，因此不传。本地要免安装版：

```bash
npm run build:win            # 三件套全出（Setup + portable + zip）
npm run build:win:portable   # 单 exe，不写注册表
```

## 📚 文档

- [使用指南](./USAGE_GUIDE.md)
- [设计文档](./DESIGN.md)
- [变更日志](./CHANGELOG.md)
