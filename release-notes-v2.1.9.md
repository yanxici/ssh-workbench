# SSH Workbench v2.1.9 —— 两处「用起来才看得见」的修复

这一版没有新功能，只有两个都在真实使用中才暴露的问题：一个浮层在自己重现，一个另存连接把密码弄丢。

## 一、传输浮层：切走标签再切回来，结束的传输又出现一次

**症状**：ZMODEM 传输结束后浮层自己收起（done 2.5s / error 6s），但切到别的标签、再切回来，浮层会重新出现一次再消失。用户看到的是「传输好像又跑了一遍」。

**根因在两层生命周期的错位**：

- `lastProgress` 存最后一次进度快照，它的生命周期跟**会话**一致，只有 `detachZmodem` 才清（`src/renderer/src/lib/zmodem.ts:1518`）。
- `ZmodemOverlay` 每次挂载都会调 `getZmodemProgress(activeId)` 来「恢复进行中的传输」。

两件事单独都对，合起来就是：一个**已经结束**的传输，被当成进行中的恢复了。

**改法**：getter 只恢复未终结的快照。

```ts
export function getZmodemProgress(sessionId: string): ZmodemProgress | null {
  const snap = lastProgress.get(sessionId)
  if (!snap) return null
  if (snap.phase === 'done' || snap.phase === 'error') return null
  return snap
}
```

**为什么不干脆在 done 时把快照删掉**：看门狗读的是 `lastProgress` 本身，不走这个 getter —— stall timer 要拿 `bytesTotal` 判停滞，续传 resync 要拿 `bytesDone` 对齐，选目录兜底也要读快照。删了会连带影响这三处。**过滤放在读口，不放在写口**，是这里唯一安全的位置。

## 二、「另存为新设备并连接」把已保存的凭据弄丢

**症状**：编辑连接里点「另存为新设备并连接」，新连接建出来了，但点「连接」立刻又弹密码框 —— 明明原连接是保存过密码的。

**根因**：另存走的是 `id: undefined`，主进程用 `randomUUID()` 建新记录。新 id 在保险箱（`secrets.json`）里没有任何条目，于是 password / passphrase / proxyPassword 三份凭据全丢。

**改法**：给 `ConnectionInput` 加一个只对新建生效的 `reuseSecretFrom`。

渲染层在「另存」时填原连接 id：

```ts
reuseSecretFrom: asNew ? initial?.id : undefined
```

主进程落库后按「**显式输入 > 继承 > 本记录原值**」取值：

```ts
const inherited =
  isNew && input.reuseSecretFrom && input.reuseSecretFrom !== saved.id
    ? await getSecret(input.reuseSecretFrom)
    : undefined
```

三条刻意的边界，每条都对应一种会出事的情形：

| 边界 | 不这么写会怎样 |
|---|---|
| 只有 `isNew` 为真才继承 | 更新同一条连接时会把「另一个 id」的凭据写进来 |
| `reuseSecretFrom !== saved.id` | 指向自己时白读一次保险箱，逻辑上也说不通 |
| `input.X === undefined` 才走继承 | 显式传 `''`（清空）会被继承值顶回来，用户清不掉密码 |

源 id 不存在时 `getSecret` 返回空对象，行为与不带这个字段完全一致 —— 不抛错、不中断保存。继承是**只读**的：原连接的凭据和条数都不变，删掉源连接也不影响已继承的副本。

保存成功的 toast 顺手补了半句：有保存凭据时显示「原连接「xxx」保持不变，已沿用其保存的凭据」。

## 回归

**新增 `scripts/verify-conn-reuse.cjs`（21 项）**：esbuild 打真实的 `src/main/store/repository` 与 `vault`，electron 用 `SW_MACHINE_DIR` + aes-256-gcm 自造 safeStorage，每个 `machine(name)` 换新实例。覆盖九组：继承三凭据 + 新 id + `hasSecret` 为真、显式填写优先、留空继承、不带 `reuseSecretFrom` 的新建无凭据、源 id 不存在、同 id 更新不继承、`''` 清空不被顶回、代理密码继承与清除、继承后源连接不变、源被删后另存。

**`scripts/verify-zmodem-renderer.cjs` 加第 17 段（66 → 72 项）**：手搓 `ZRQINIT → ZFILE → ZDATA(ZCRCW) → ZEOF` 跑到 done，然后断言五条 —— 传输中 getter 仍能恢复（`active` / `detected`）、实时 watcher 仍收到 done、完成后 getter 为 `null`、**重复读取仍为 `null`**（重挂载幂等）、`doneEv.bytesDone === total`（过滤没影响收尾）。

第五条的来历值得记：最初写的是「done 后 `isZmodemActive === false`」，它红了 —— 因为 done 之后 `active` 仍为真，会话要等 `detachZmodem` 或远端 ZFIN 才结束。断言写错了，不是代码错了；改成校验 `bytesDone` 才真的在测「过滤没伤到收尾」。

## 实测

```
node scripts/verify-conn-reuse.cjs        → 21 通过 / 0 失败
node scripts/verify-zmodem-renderer.cjs   → 72 通过 / 0 失败（原 66）
node scripts/run-all-verify.cjs --only=conn-reuse → PASS 686ms
npm run typecheck                         → 干净（node + web）
```

`verify-zmodem.cjs` 里 `flush 使用 Buffer.concat` 那条是 `run-all-verify.cjs` 已登记的基线失败（`KNOWN_FAIL`，用 git stash 对比过），与本版无关。

## 升级

覆盖安装即可。`settings.json`、`connections.json`、`secrets.json` 结构未变 —— 新增的 `reuseSecretFrom` 只在保存请求里出现，不落盘。
