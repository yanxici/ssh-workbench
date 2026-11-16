# 阶段 5（UI）：连接状态分阶段反馈

> 分支 `ui/status-detail` · 父提交 `ui/shortcuts`

## 1. 问题

原先只有 `connecting / connected / disconnected / error` 四态。用户看到「连接中」卡住时，
**下一步动作完全取决于卡在哪一步**：TCP 没通要查网络/防火墙，认证卡住要查凭据或键盘交互，
跳板链卡住要查跳板机。只说「连接中」等于什么都没说。

## 2. 改动

| 文件 | 改动 |
|---|---|
| `shared/types.ts` | 新增 `ConnPhase = 'tcp' \| 'handshake' \| 'auth' \| 'jump' \| 'shell'`；`SessionInfo.phase?`；`SessionStatusEvent.phase?` |
| `main/ssh/sessionManager.ts` | `emitStatus` 增加 phase 参数；在 tcp / handshake / jump / shell 四处广播；`record.phase` 仅在 connecting 时保留 |
| `main/index.ts` | 状态事件透传 phase |
| `renderer/stores/sessionStore.ts` | `updateStatus` 接收 phase，非 connecting 时清空 |
| `renderer/components/layout/StatusBar.tsx` | `PHASE_LABEL` 映射，connecting 时优先显示阶段文案 |

## 3. 诚实边界：`auth` 不会发出

ssh2 的 `connect()` 把「握手 + 认证」合成一次异步调用，主进程**拿不到两者之间的分界点**。
所以类型里保留 `'auth'` 供将来换成分步握手时使用，**当前不会发出**。
与其编一个假的 auth 状态，不如不显示 —— 这条已写进代码注释。

## 4. 抓到并修掉的一个自造回归

把 `emitStatus(record, 'connected')` 改写成 `emitStatus(record, 'connecting', undefined, 'shell')` 之后，
**连接成功的 'connected' 事件消失了** —— 会话永远停在 connecting。
`verify-conn-phase` 第 3 条断言当场抓到（`seen` 里只有三个 connecting，没有 connected）。
修法：`await transport.open(...)` 之后再发一次 `connected`。

这条正好说明「用真实会话验证状态机」的价值：类型检查、lint、UI e2e 都不会发现这个缺失。

## 5. 门禁与基准

| 命令 | 结果 |
|---|---|
| typecheck / lint | ✅ 0 错误 |
| test:verify | ✅ **60 通过 / 0 失败**（阶段 4 是 59，新增 1） |
| UI e2e | ✅ 18/18 |

实测事件序列（lab 服务器，本机回环）：

```
connecting/tcp → connecting/handshake → connecting/shell → connected/null
```

## 6. 风险与回滚

| 风险 | 说明 |
|---|---|
| 阶段事件变多导致状态栏频繁重渲染 | 每会话只多发 3 次事件，且都在 connecting 期间；`updateStatus` 仍是单次 map |
| 老前端读到未知 phase | phase 只是可选字段，未知值回落为「连接中」 |

回滚：`git checkout ui/shortcuts`。
