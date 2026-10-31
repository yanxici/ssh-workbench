# SSH Workbench v1.8.0

本轮修复 3 个真实缺陷，全部来自实测而非读代码推测。其中 IME 那条是中文用户每天都会撞到、但开发者用英文输入法永远复现不出来的问题。

## P1 — 中文输入法下 Enter 会执行半截命令

拼音串还没上屏时按 Enter 是「确认候选词」，浏览器照样派发 keydown，React 的 `onKeyDown` 收到后直接 `preventDefault()` 并执行动作。用户想选个字，结果命令中心跑了第一条命令、路径栏跳了目录、表单提交了半截内容。

全仓 `isComposing` 命中 **0 处**，13 个 Enter 消费点全部没有守卫：

- 直接挂在 `<input>` 上 **11 处**：命令面板搜索、文件口令、执行参数、本地/远端路径栏、上传目标目录、标签重命名、更新代理、终端搜索、通用 Combobox、Prompt 输入
- 挂在容器、子树含 input **2 处**：命令中心、命令面板（事件从子输入框冒泡上来，容器 handler 照样执行）

修复用 `lib/ime.ts` 的 `isImeComposing(e)`，读 `e.nativeEvent.isComposing`。

**为什么不写 `e.isComposing`**：React 合成事件没有这个字段，读它恒为 `undefined`，守卫永不生效，而 TypeScript 不报错 —— 这是最典型的假绿写法。

**为什么不用 `keyCode === 229`**：那是 Chrome 早期 IME 的历史 hack，只覆盖「被吞掉的按键」，跨浏览器行为不一致。

## P1 — StatusBar 传输中每秒重渲染 6.7 次

`StatusBar.tsx:67` 订阅整个 `s.transfers` 数组，`filter` + 两次 `reduce` 写在渲染函数体里。主进程每 **150ms** 推一次进度，store 每次都 `[...s.transfers]` 重建数组 —— 常驻组件跟着每秒重渲染 6.7 次，每次还要重跑三遍数组遍历。同一个文件里 latency 早就改成单值订阅了，transfers 没跟上。

改成把 `filter`/`reduce` 移进 selector，用 `useShallow` 只比较 `{ activeCount, activePct, firstDirection }` 三个标量。进度推进但百分比没变时不重渲染。

## P2 — 三处

- **`batchStore.applyProgress` 高频全量浅拷**：每事件重建整个状态表，`BatchPanel` 每行订阅 `s.results[sessionId]`，对象换引用后所有行 selector 重跑。改成单调短路，值不变时原样返回 store。
- **文件树未用 `content-visibility`**：连接列表有 `.conn-row-cv`，文件树三处 300 行仍全量布局。新增 `.file-row-cv`，`contain-intrinsic-size` 按 22px 单独调（行高填错会让滚动条抖动）。
- **快捷键冲突缺批量恢复**：单行重置按钮本来就有，缺的是冲突提示区的一键恢复。一次改坏三四个键时得逐行点图标，且提示里给的是 label、行里显示的是组合键，对不上。新增 `resetConflicts()`，按冲突集合精确取 id，不误伤其它自定义键。

## 测试

新增 2 个回归脚本，判据按「修复未落地时会红」：

- **`verify-ime-guard.cjs`**：字符级 JSX 分词求 handler 宿主。不能用「向上找最近的 `<tag`」—— 属性跨多行会撞上相邻元素，13 处里 11 处被误判成「不需要守卫」，脚本一片绿而实际漏修。容器子树用嵌套深度匹配闭标签，不能用 `indexOf('</div>')`（会截断在第一个内层闭标签）。
- **`verify-shortcut-reset.cjs`**：6 条断言。

两个脚本都做了 **stash 反向验证**：`verify-ime-guard` 拿掉守卫后 13 处全红，`verify-shortcut-reset` 拿掉批量恢复后 2 条红。

写脚本过程中自己踩了三次同类坑，都记进了注释：正则未转义括号导致断言恒假、`<HTMLElement>` 被当成 JSX 宿主、`indexOf` 截断子树。**断言写错和功能写错一样危险，因为错的断言是绿的。**

## 验证

| 项 | 结果 |
|---|---|
| typecheck | 干净 |
| build | 成功 |
| `run-all-verify` | **45/45**（新增 2 条） |
| `e2e-ui-sftp` | **18/18**，28.0s |

## 安装

- **安装版**（推荐，支持自动更新）：`ssh-workbench-Setup-1.8.0.exe`
- 自动更新元数据：`latest.yml` + `.blockmap`

本地构建产物只作留档，**不作发布来源** —— 上传一律走 CI，避免同版本号两份字节不同的包。
