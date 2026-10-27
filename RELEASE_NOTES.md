# SSH Workbench v1.5.2 Release Notes

> 一个 bug、一处加固。**「开了跟随，`cd` 之后文件面板还是不动」修好了** —— 病根不在解析，而在你眼睛看的那一栏。

## 🧭 开了跟随却没跟：修的是「你看不见」，不是「它没算」

v1.5.1 上线后收到的第一个反馈就是这个。当时的现象很干脆：设置里「跟随终端目录」明明是开的，`cd /var/log` 回车，侧栏文件面板纹丝不动。

### 为什么之前的测试全过了，用户还是没感觉

解析层和事件层一直是对的 —— `verify-shellcwd.cjs` 82 项、`verify-cwdstore.cjs` 19 项，全部通过。真正的问题在展示层，而且是两个叠在一起的：

1. **面板默认停在「工作区」Tab。** 那一栏不是目录树，是「主目录 / 根目录 / 临时目录 / 最近访问」这样一列快捷入口。跟随逻辑很尽职地把 `currentDir` 改成了 `/var/log`，但你打开面板看到的是这列快捷入口 —— 于是判定「没跟」。
2. **面板首次挂载会把事件游标一次性对齐到当前序号。** 文件面板是常驻挂载、靠 `display` 切换的，也就是说 `cd` 事件全部在它「隐藏」时到达。等它真的挂载，游标一跳，**挂载之前**发生的那些 `cd` 就被静默吞掉了。

第一条解释了「为什么看起来完全没反应」，第二条解释了「为什么有时候重启一下就又好了」。

### 现在怎么修

把「什么时候跳 / 跳哪儿 / 要不要替用户切 Tab」从 `FileExplorer` 里抽成零依赖纯函数 `src/renderer/src/lib/cwdFollow.ts`：

| 决策 | 行为 |
|---|---|
| `decideInitial`：有已知 cwd + 开着跟随 | `currentDir` 和 Tab **一起**定到「文件系统」，第一眼就是目录树 |
| `decideInitial`：没有已知 cwd | 保留用户原来选的 Tab（此前硬编码 `'workspace'`，会把正停在目录树里的人踢回快捷入口） |
| `decideFollow`：新事件 | 跳，并逐级展开父目录 |
| `decideFollow`：旧事件 / 序号回退 | 不动（避免切会话回来被旧事件拽走） |
| `decideFollow`：空路径 | 不动，且**不推进游标** —— 否则这个事件被永久跳过 |
| `decideFollow`：关着开关 / 已断线 | 不动 |

另外加了一个小动作：**手动把跟随重新打开，立刻补跳一次**。以前「关掉再打开还是不动」会让人以为是开关坏了，现在这一下会强制对齐到当前 cwd。

### 为什么这套逻辑之前没有单测

因为 DOM 测试打不到它 —— 面板常驻挂载，事件都在隐藏时到达，任何「渲染出来看一看」的测试都会把它漏掉。所以这次直接测纯函数：新增 `scripts/verify-cwdfollow.cjs`（19 项，esbuild 打成 CJS 直跑，零测试框架依赖），并入 `npm run test:cwdfollow`。

## 🛡️ 发版加固：这一版才真正带上「装完打不开」的根治

上一版修了一个会让用户彻底失去信任的坑：产物字节完好，但目录被打上 **`Low` 完整性标签**后，Electron 的沙箱子进程会在启动瞬间被杀 —— 表现就是**双击 exe 毫无反应**，而把同一个 exe 拷到别的目录又能正常跑。

这版把「治本」的那部分一并发出（v1.5.1 的安装包里还没有）：

| 能力 | 命令 | 作用 |
|---|---|---|
| 硬锁 | `npm run guard:integrity` | 给根目录加一条 `Everyone:(OI)(CI)(DENY)(WO)`。打 Low 本质是 `SetNamedSecurityInfoW` 写 SACL，需要对象上的 `WRITE_OWNER`；锁掉之后**任何工具都打不上 Low** |
| 摘锁 | `npm run unguard:integrity` | 需要时（例如跑 `workspace-write` 型 ACL 沙箱）摘掉 |
| 检查 | `npm run check:integrity` | 两级扫描：每棵树一次 `icacls /T /C` 判有无 Low，命中才下钻定位，8 路并行 |

根因也订正了：打 Low 的不是 Codex，是 DSH 自带的 `@deepseek-ai/dsh-sandbox-windows-acl`（`buildLowLabelAcl` / `restrictTokenIntegrity`），会给工作区 `setintegritylevel Low` 且常驻保留。所以 `CodexSandboxService` 不必卸载。

扫描提速：旧版对每个对象单跑一次 `icacls`，45 个对象 **25.9s**；新版全仓（含两个 `dist*`、1.7 万文件）**5.8s**。

> 硬锁唯一的代价：`workspace-write` 型 ACL 沙箱会 fail-closed（`SetNamedSecurityInfoW failed (Win32 5): grantWrite`）。要用就先 `npm run unguard:integrity`。常规读写、复制、删除、重命名、打包 exe 启动全部不受影响。

## 🐞 其他

- 产物目录切到 `dist-v13`，`release.ps1` / `build-release.sh` / `build-release.bat` 同步指过去
- 发布链路的上传前校验保留：带 `Low` IL 的包在打包阶段（`build:win` 前置）和发布阶段（`release.ps1`）各拦一次

## 🔧 从旧版本升级

1. 下载 `ssh-workbench-Setup-1.5.2.exe` 覆盖安装（已在 1.5.0 / 1.5.1 的话标题栏会直接提示更新，走差量下载，通常只有几 MB）
2. 连接配置、命令库、诊断项、历史记录都不受影响（都存在 `%APPDATA%/ssh-workbench/data/`）
3. 老配置无需迁移：跟随开关仍是「缺键即开」

## 📥 关于产物

GitHub Release **只上传安装包**：`ssh-workbench-Setup-1.5.2.exe`、其 `.blockmap`、`latest.yml`。后两个是自动更新的元数据，缺了客户端查不到更新 / 走不了差量下载。

portable 与 zip 解出来的 `win-unpacked` 与安装包完全一致，多传只是白费 200+ MB 带宽，因此不传。本地要免安装版：

```bash
npm run build:win            # 三件套全出（Setup + portable + zip）
npm run build:win:portable   # 单 exe，不写注册表
```

## 📚 文档

- [使用指南](./USAGE_GUIDE.md)
- [设计文档](./DESIGN.md)
- [变更日志](./CHANGELOG.md)
