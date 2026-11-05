# SSH Workbench v1.8.1

这一版只修 ZMODEM 文件传输，但修的是两条每天都会撞到、却很难自查的链路：`sz` 下载（已经烂了很久，表现为终端被乱码刷屏然后卡住）和 `rz` 上传（几乎完全不可用，表现为进度条停在 0）。六个根因全部来自实测复现，不是读代码猜的。

## P0 — `sz` 下载：中途乱码刷屏并停住

进度走到某个百分比，终端突然刷出一屏二进制乱码，传输随即卡死。乱码不是"打印错了"，而是 **ZMODEM 报文本身被直接写进了终端**。三条独立根因：

1. **接收方从不对 ZCRCW 回 ZACK**。`zsession.js:659` 的条件是 `subpacket.ack_expected() && !subpacket.frame_end()`，而 ZCRCW 恰好两者都成立，被这个组合排除 —— lrzsz 的 `sz` 在窗口边界发的正是 ZCRCW，等不到 ZACK 就停在当前百分比。
2. **一帧解析失败就把整个会话判死**。库找不到处理器时抛 `Unhandled header: ZDATA`，而 `feedZmodem` 的 catch 只有 ZRQINIT 一条窄豁免，其余一律走 `abort()`。abort 之后 Sentry 把远端仍在推的每一帧原样交给终端 —— 就是那屏乱码。
3. **ZRPOS 续传没有落地路径**。库的 `_consume_ZDATA` 遇到 offset 不等直接抛 `Error correction is unimplemented.`，而真 `sz` 收到 ZRPOS 后经常整帧重发 —— 位置本就该以对端为准。

改法：挂 `session.on('data_in')`，对 `ack_expected() && frame_end()` 的子包按库自身 `_file_offset` 补发 ZACK；`to_terminal` 增加抑制窗，协议态或刚出错的一段时间内残渣只记账不下发；新增 `resyncReceive()` 命中可恢复错误时清缓冲、重发 ZRPOS 让对端断点续传而不是 abort；`relaxDataOffset()` 把本地 offset 对齐到对端；`ensureEofHandler()` 补上 ZEOF 处理器；落盘改成带偏移对账，续传后重复段落只保留尾巴。

## P0 — `rz` 上传：卡在 0 字节 / 传完又弹一次确认

三种表现都叫"传不上去"：(a) 进度条一直 0；(b) 文件其实传完了，界面又冒一次确认弹窗，再点还是没反应；(c) 大文件传输期间整个窗口卡死，连中断按钮都点不动。

1. **`_ensure_receiver_escapes_ctrl_chars()` 死等 ZACK**（`zsession.js:1327-1348`）：发一帧 ZSINIT 然后 `new Promise`，**没有任何超时**。对端不回这个 ZACK，`send_offer` 就永远进不了发 ZFILE 那一步 —— 表现就是 0 字节。
2. **迟到 / 重复的 ZACK 把会话判死**：发完一个文件后处理器表换成 `{ ZRINIT }`，此刻进来的 ZACK 命中 `throw Unhandled header` → `recoverFromError` → `abort()`。旧会话仍挂在 Sentry 上，下一次 `rz` 的起始帧被当成未知头部吞掉 —— 用户看到"传完又让我重来一遍，而且再也不动"。
3. **发送是同步死循环、无限等**：`transfer.send()` 在 `for` 里一口气塞完整个文件，几 MB 就能冻结渲染进程；`send_offer` / `end()` / `close()` 三个 promise 只在收到对应头部时兑现，对端不配合就永久挂起。

改法：`primeSendSession()` 停掉库的保活链并跳过 ZSINIT 死等（库的 `_stop_keepalive` 把字段拼成 `_keep_alive_promise`，永远清不掉，只能直接清 `_keepalive_timeout` + 钉死 `_start_keepalive`）；`installSendHeaderFallback()` 只在处理器表没人认领时吞掉噪声头部，且**绝不清表**；`startSendKeepalive()` 在**用户还没选完文件**时就每 5 秒补一帧 ZSINIT（远端 `rz` 的重试窗口只有十几秒，挑个几 MB 文件很容易跨过去）；`awaitSendStep()` 给三处等待各套 20 秒超时；发送改 32KB 分片、每 128KB 让出事件循环；收尾失败或取消选文件时补 `abort()`，否则旧会话留在 Sentry 上导致下次完全没反应。

## 测试

- `verify-zmodem-renderer` **66 通过 / 0 失败** —— 新增场景 12~16，用真的 `Zmodem.Session.Receive()` 当对端跑完整上传链路：正常上传 120000 字节、对端吞掉所有 ZACK、传输结束后注入迟到 ZACK、对端完全不理（20 秒超时路径）、在文件选择框停留 12 秒后取消。
- `verify-zmodem` **88 通过 / 0 失败** —— 其中 6 条断言原本指向已迁走的 `src/main/index.ts` 与 `App.tsx`，已跟着代码搬到 `src/main/ipc/zmodem.ts` 与 `MainWorkspace.tsx`。
- `verify-zmodem-e2e` 14/0、`verify-zmodem-decode` 10/0；`tsc` + `eslint` + `electron-vite build` 全绿。

## 下载

- **安装版**（推荐，支持自动更新）：`ssh-workbench-Setup-1.8.1.exe`
- 已安装 v1.8.0 的用户可直接从应用内「检查更新」升级。
