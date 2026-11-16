# SSH Workbench v2.1.7 —— 终端右键也能分屏

## 为什么做这一版

v2.1.5 的分屏只有一个入口：右键标签。

问题不在功能，在位置。标签栏 44px 高、装不下就横向滚动，你得把指针精准落进某一条标签中间那几十像素才点得到菜单。而人真正想分屏的那一刻，视线和鼠标都在终端里 —— 先抬头、找标签、对准、右键，四步。

真实反馈就一句：「在标签栏上感觉不太好用。」

## 做法：第二个入口，同一套状态

终端右键菜单加三项：

```
复制
粘贴
全选
──────────────
发送文件…
──────────────
向右分屏        ← 新增
向下分屏        ← 新增
（关闭此分屏）   ← 新增，仅分屏后出现
──────────────
查找
清屏
```

**没有新增任何状态。** 两个入口调的是同一组 `useSplitStore` 动作：

```ts
const splitPane = useSplitStore((s) => s.splitPane)
const closePane = useSplitStore((s) => s.closePane)
```

走同一条链路 —— 复用当前 SSH 连接开新 shell、`replaceLeaf` 把叶子换成 split 节点、焦点交给新格。终端入口不是「另一条实现」，只是另一扇门。

上限判据也从 `paneTree.ts` import 同一个常量：

```ts
import { MAX_PANES, countLeaves, leafIds } from '@/lib/paneTree'
const canSplit = session.status === 'connected' && paneTotal < MAX_PANES
```

不各写一个 4。上限以后要改（比如允许 6 格），只改一处，两个入口不会分叉。

## 「关闭此分屏」为什么不是常驻项

判据是 `paneTotal > 1` —— 只有真的分了屏才出现在菜单里。

这不是审美问题。单格时 `closePane` 等价于关标签，如果菜单里写死一个「关闭此分屏」，单格用户看到的是一个**误点就丢整个终端**的项。而标签上本来就有 ×，功能重复、风险不对等。

```ts
...(paneTotal > 1
  ? [{ label: '关闭此分屏', icon: <XCircle size={12} />, onClick: () => closePane(sessionId) } as MenuEntry]
  : [])
```

顺带一处必要改动：`useSplitStore` 从只读的 `getState()` 改成订阅 `trees`。菜单项要跟着分屏状态变，拿快照不会重渲染。

## 回归从 16 项加到 22 项

新增 T0–T4b 六条，每条判据都选成「修复没落地时会红」的量：

| 断言 | 失效时会红的情形 |
|---|---|
| T0 单格时菜单有分屏项、且**不含**「关闭此分屏」 | 把关闭项写成常驻 |
| T1 点「向右分屏」可见格真的变 2 | 只挂菜单不接 onClick |
| T2 标签数量仍是 1 | 终端入口另写一套逻辑、绕开 splitStore |
| T3 分屏后菜单出现「关闭此分屏」 | `paneTotal` 拿会话 id 当 owner 算 |
| T4 点它可见格回到 1 | 误调 `sessionStore.close` |
| T4b 标签仍在 | 同上 |

两个测试细节值得记：

**打开菜单的方式**：在 `.xterm` 元素上派发 `contextmenu`，让它冒泡到挂了 `onContextMenu` 的容器 div —— 与真实右键同一条路径。直接 `click()` 容器不行，事件目标和冒泡顺序都不同。

**读菜单文本的范围**：只取 `.menu` 元素的 `innerText`。用 `body.innerText` 会把侧栏文案和状态栏一起算进来，断言就退化成「页面上出现过这四个字」—— 假绿。这条是踩过的坑：`page.innerText.includes('向下分屏')` 在按钮根本没渲染时也可能为真，只要别处提过这个词。

## 实测

```
=== 分屏真实应用验证：22 通过 / 0 失败 ===
```

全量回归 `node scripts/run-all-verify.cjs` → 71 通过 / 0 失败 / 0 跳过（三个历史失败按设计跳过：`verify-cdsync`、`verify-theme`、`verify-zmodem`）。

```
npm run typecheck   → 干净
npm run build       → out/renderer/assets/index-*.js 2,116.33 kB / 4.65s
```

## 顺带修的一条：trzsz e2e 为什么时红时绿

`scripts/verify-trzsz-e2e.cjs` 的 Z5/Z5b 一直在 CI 里翻红翻绿，最后一查是**脚本自己拼错了表达式**，功能本身没问题：

| 位置 | 症状 | 真因 |
|---|---|---|
| Z5 等待表达式 | CDP 抛 `Unexpected token '('`，被 `try/catch` 吞掉，重试满 20s 后返回 false | `'(() => ' + TERM_ROWS_VISIBLE + '.some(...)'` 拼出 `(() => (...)())()`，多了一层调用 |
| Z5 失败诊断 | 诊断自身 `SyntaxError: Unexpected token 'return'`，现场一片空白 | `' })' + ' return { ... }'` 缺分号，`})` 后直接跟 `return` |

两处补上后连跑两次 **10 通过 / 0 失败**。同时把取样口径从「文档里第一个 `.xterm-rows`」改成「只取可见终端（`getBoundingClientRect` 宽高 > 10）再拼接」—— 分屏后第一个终端可能正被 `display:none` 藏着、缓冲区是空的，读到 `""` 和「远端回执没到」在现场上完全一样，这正是这条断言过去时红时绿的假象来源。

## 升级


覆盖安装即可，`settings.json` 与 `connections.json` 结构未变。已有分屏布局原样保留 —— 这一版只加了入口，没动树的编码格式。
