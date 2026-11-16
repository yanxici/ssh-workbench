# 阶段 4（UI）：快捷键冲突检测的作用域修正

> 分支 `ui/shortcuts` · 父提交 `ui/virtual-list`（阶段 3 + 补做）

## 1. 一个必须先纠正的事实：冲突检测**本来就有**

阶段 0 的审计结论是「没有统一注册表、无冲突检测」。**那是错的。**

现实：`src/renderer/src/lib/shortcutConflict.ts`（99 行）早就存在，导出
`detectShortcutConflicts` 与 `checkSingleConflict`，而且 `ShortcutSection.tsx` 已经在用，
设置面板里有完整的冲突提示 UI（含「一键恢复冲突项」按动作 id 精确重置）。

漏掉的原因：审计时只 grep 了 `matchShortcut` / `addEventListener('keydown')` 这类模式，
没有扫「快捷键相关的独立模块」。**教训：按符号名 grep 会漏掉按职责命名的文件。**

## 2. 真正缺的东西：作用域

原实现只按「归一化后的组合键」分组，把**跨作用域**的重复也判成冲突。

具体后果：`terminalSearch` 默认就是 `Ctrl+F`（终端作用域）。用户若想把某个全局动作也
设成 `Ctrl+F`，会被冲突弹窗拦住 —— 而这两个键实际不会同时触发（终端聚焦时以终端为准）。

### 改动

| 文件 | 改动 |
|---|---|
| `lib/shortcuts.ts` | 新增 `ShortcutScope` 类型 + `SHORTCUT_SCOPE` 表（10 个动作逐个登记） |
| `lib/shortcutConflict.ts` | 归一化键改为 `scope + '\|' + combo`；`ConflictInfo` 增加 `scope` 字段；抽出重复的 normalize 逻辑（原来两个函数各抄一遍） |
| `settings/ShortcutSection.tsx` | 调用 `checkSingleConflict` 时传入被编辑动作自身的 scope |

判定规则：**同作用域重复 = 真冲突；跨作用域重复 = 不算冲突**。

## 3. 测试

新增 `scripts/verify-shortcut-scope.cjs`（6 条，走真实函数、esbuild 现场打包，不 mock）：

| # | 断言 |
|---|---|
| 1 | 默认映射无冲突 |
| 2 | 全局动作设 `Ctrl+F`（与终端搜索同名）**不算冲突** |
| 3 | 两个 global 动作都用 `Ctrl+N` **算冲突**，且 `scope === 'global'` |
| 4 | `checkSingleConflict` 跨作用域返回 null |
| 5 | `checkSingleConflict` 同作用域命中（返回 commandCenter） |
| 6 | **每个动作都登记了作用域**（防止新增动作漏登记后默认落 global 造成误判）|

**变异测试**：把归一化键改回 `'|' + normalized`（即退回原实现），第 2 条立刻变红，
并打印出被误判的 `Ctrl+F` 冲突项（commandCenter + terminalSearch）。恢复后 6/6。

## 4. 顺带修掉的门禁 flaky

本轮门禁连续两次出现**不同的**自起应用脚本失败（先 `verify-xterm6`，后 `verify-panel-switch`），
单独跑都通过。根因一致：这些脚本用**固定 `sleep(9000)` 等应用启动**，门禁串跑时机器忙，
9s 不够就全套断言连锁失败。

修法：把固定等待换成**轮询就绪**（`document.body.innerText.length > 100`，最多 30s，200ms 一次）。
通常 300ms 内就绪，慢的时候自己等。改动覆盖 4 个脚本：`verify-xterm6` / `verify-panel-switch` /
`verify-theme-tw4` / `verify-experimental-flags` / `verify-design-tokens`。

效果：单跑耗时不升反降（xterm6 从 27.9s → 22.9s），门禁一次跑过 59/59。

## 5. 门禁与基准

| 命令 | 结果 |
|---|---|
| typecheck / lint | ✅ 0 错误 |
| test:verify | ✅ **59 通过 / 0 失败**（阶段 3 是 58，新增 1） |
| UI e2e | ✅ 18/18 |

无新增依赖、无体积变化（纯逻辑改动）。

## 6. 风险与回滚

| 风险 | 说明 |
|---|---|
| 作用域登记错误导致漏判冲突 | 第 6 条断言强制每个动作都必须登记 |
| 跨作用域真的同时触发 | 现有代码里终端用 `attachCustomKeyEventHandler` 先拦，全局 keydown 监听在 capture 阶段；两条链路不会同时执行同一动作 |

回滚：`git checkout ui/virtual-list`。
