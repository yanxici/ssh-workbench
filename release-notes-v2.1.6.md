# SSH Workbench v2.1.6 —— trzsz 文件传输

## 为什么做这一版

串口控制台、只有 ssh 没有 sftp 的交换机，传一个固件包的现实做法仍然是 `rz` / `sz`。

但 lrzsz 有两个硬伤：对端得先装；协议是 8-bit 明文的，遇到 4-bit 终端、`tmux`、或者中间有设备做字符集转换就会挂 —— 表现是传到一半卡死，你还不知道卡在第几个字节。

trzsz 保留同一套交互（终端里敲 `trz` 发文件、敲 `tsz 文件名` 收文件），但走的是文本协议，支持整个目录、带进度条。WindTerm / Tabby / Netcatty / electerm 都有。我们之前只有 ZMODEM。

## 过滤器为什么放主进程

官方包 `trzsz@1.1.6`（MIT）在运行时这样判断环境：

```js
const zi = (function () {
  try { if ('fs' === require.resolve('fs')) { require('fs'); return false } } catch {}
  return true
})()
```

`zi === true` 表示浏览器。构造函数里 `if (!zi && !options.chooseSendFiles) throw ...` —— 也就是 Node 环境**强制**要求这两个回调，并且包自己用 fs 读写文件。

浏览器分支退到 `window.showDirectoryPicker` / `window.showOpenFilePicker`，在 Electron 渲染进程里不可靠。所以放主进程。

另外两个理由：

1. 选文件 / 选目录本来就要原生对话框（`dialog.showOpenDialog`），主进程直接调。
2. 大文件不必再走 base64 IPC 往返 —— 现有 ZMODEM 每帧 base64 编解码，几十 MB 时 CPU 明显。

## 惰性挂载：握手出现前一个字节都不碰

`sessionManager.flush()` 先判断文本里有没有 `::TRZSZ:TRANSFER:`：

| 情况 | 行为 |
|---|---|
| 没有握手 | 走原来的 `onData` 直路，渲染层 ZMODEM Sentry 照旧 |
| 有握手 | 为该会话 `ensure()` 一个过滤器，此后文本全部由它产出 |

这个顺序保证了「不支持 trzsz 的终端」与「ZMODEM 传输」的行为和 v2.1.5 完全一致 —— 不是靠代码里到处 `if`，是靠根本没人被创建出来。

## 握手串照常显示，只是不进录制

`processServerOutput` 的语义是：先 `writeToTerminal(整段)`，再 `setTimeout(探测握手, 10)`。过滤器不替你吞任何字节 —— 想吞只能在 `writeToTerminal` 回调里自己过滤。

我们没吞。用户该看到远端回了什么。但录制走 `stripTrzszHandshake()` 剔掉整行：回放时那串 base64 是满屏噪声。

## 进度条不需要新通道

trzsz 的进度条是用 `\r` 和 `ESC[nD` 原地重绘的**普通文本**：

```
fw.bin [██████░░░░] 62% | 7.8 MB/12.5 MB | 3.2 MB/s | 00:01:28 ETA
```

主进程把它当会话数据下发即可 —— 录制、回滚、搜索全部照常工作。额外只在状态条上显示「图标 + 文件名 + 百分比」，数据从那段文本里抠（最后一个 `(\d{1,3})%`、`[` 之前那段当文件名），150ms 节流。

## 「没装 trzsz」有两条入口，都接了

| 入口 | 触发路径 | 处理 |
|---|---|---|
| 主动上传 | `uploadFiles` 先发 Ctrl-C、等 200ms、发 `trz`；3 秒内没握手 → 抛 `Upload does not start` | 换成中文提示 + 状态事件 |
| 用户手敲 `trz` | 我们**还没**创建过滤器（只在看到握手才建），没人解析输出 | `flush()` 的无过滤器分支单独认 `command not found` |

第二条是最容易漏的：功能看起来「能上传」，用户自己敲命令时却毫无提示，只会觉得卡了一下。

## 只对 SSH 会话挂

串口没有 `trz` 命令这回事。`ensureTrzsz()` 直接拒（`kind !== 'ssh' || status !== 'connected'` 返回 `undefined`）。

传输期间 `writeBytes` 直接丢弃 —— ZMODEM 与 trzsz 不会交错。

## 实测

| 项 | 数值 |
|---|---|
| 未挂载路径（3 万段 × 三次判定） | 0.15 µs / 段，误命中 0 |
| 挂载后（2 万行） | 0.87 µs / 行 |
| 非传输态透传 | 1 020 000 字节输入 → 1 020 000 字节输出 |
| 真应用开 / 关过滤器中位 | 31 ms vs 31 ms = **1.00×** |
| `connections.json` | 身份字段前后一致（条数与内容） |

## 验证

- `scripts/verify-trzsz.cjs` —— 40 项纯逻辑断言，7 组。
- `scripts/verify-trzsz-e2e.cjs` —— 10 项真实应用断言，含「上传耗时 > 2.5s」（证明真等过握手超时，不是立刻返回）与「终端出现 `lab-saw-act`」（取消帧真的出了本机）。
- `scripts/perf-trzsz.cjs` —— 11 项。刻意先证明过滤器**真的挂上了**才比耗时：不证明的话两种状态跑的是同一条路径，比值恒为 1，压测就成了摆设。

## 踩坑

| 坑 | 现象 | 修法 |
|---|---|---|
| 断言写错不是实现错 | 用 `sudo: rz: command not found` 期望命中「没装」 | `NOT_FOUND_RE` 只列 `trz|tsz`，下载端命令是 `tsz` 不是 `rz` |
| 原生对话框挂住脚本 | e2e 跑到上传就再也不返回 | `SSHWB_TRZSZ_AUTODECLINE=1`，两个 pick 函数立即返回 canceled |
| 伪 shell 量不到大段输出 | 压测比值恒为 1 | lab 服务器加 `@@PERF:n:tag@@` 分支吐 n 行 |
| 数据零影响断言永红 | `connections.json` sha256 每次都变 | `lastUsedAt` 是**设计上**该变的，归一化成身份字段再哈希 |

## 已知取舍

- 不做远端探测（每条会话多一次 `exec` 是浪费），靠 `command not found` / `Upload does not start` 兜底提示。
- 主动上传会先发 `Ctrl-C` 中断当前命令 —— 这是 trzsz 协议要求，正在跑的命令会被打断。
- 下载方向没有界面入口：远端 `tsz` 一下就会弹目录选择框，不需要先点菜单。

## 兼容

无配置项、无迁移。老配置文件直接可用；不支持 trzsz 的对端一切照旧。
