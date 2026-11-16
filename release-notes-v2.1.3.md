# SSH Workbench v2.1.3

这一版加**终端输出高亮**：按关键词给输出行上色。

## 为什么做这一版

翻日志找 `error`、盯 `Permission denied`、看烧机时滚过去的 `timeout`，全靠肉眼在一屏二十行的
输出里挑。WindTerm / Netcatty 都有这能力，我们一直没有。

## 做了什么

### 只做行级，不做列级

行级 = 整行底色 + 左侧色条 + 右侧滚动条刻度。列级要把 ANSI 序列剥掉后按「显示列」反推每个字符
的屏幕坐标 —— 中文双宽、emoji、tab 停位、窄体字符拼接都会让坐标偏移。算错的表现是「染到了相邻
的词」，比不染更糟。这条边界写死在代码注释里，不是留个「以后再说」。

### 写入通路是一个函数

终端渲染层所有写入统一走 `writeSessionData(sessionId, term, data)`：

| 状态 | 行为 |
|---|---|
| 未启用 / 规则编译为空 | 直接 `term.write(data)`，零额外开销 |
| 有命中 | 先 `term.write(data)`，在写入回调里 `registerMarker()` + `registerDecoration()` |

`back = (endedWithNewline ? 1 : 2) + hit.fromEnd`。带换行时余光标停在下一行行首，不含换行时
停在当前行行尾 —— 差一行，整条色带就整体上移或下移一格。

### 规则

内置两条默认开：

| 规则 | 正则 | 底色 |
|---|---|---|
| 错误 | `\b(error\|fail(ed\|ure)?\|fatal\|panic\|exception\|denied\|refused)\b` | `#4a1d1d` |
| 警告 | `\b(warn(ing)?\|deprecated\|timeout)\b` | `#40320f` |

两个清洗点不是洁癖：

- `g` / `y` 标志被剔除。带 `lastIndex` 状态的正则，下一次 `test()` 会从上次匹配位置继续，
  表现是「同一个词有时染有时不染」。
- 颜色只收 `#RRGGBB`。xterm 的 decoration 只认这一种，传 `rgba()` 会**静默失效**。

### 设置页的试匹配框

规则写对写错，在设置页里本来完全看不出差别 —— 只能「改完回去等一条报错出现」。所以这一版带一个
可编辑的 8 行样本框，实时显示命中行数与耗时，超 5 ms 标黄（静态体检抓不到的回溯风险，这里量得出来）。

### 断线与关会话

- 断线时该会话的装饰统一 `dispose()`：断线遮罩是半透明的，底下染色行会透出来，看着像「断了还在报错」。
- 关会话时 `forgetSession()` 清缓冲：`sessionId` 会被复用，不清就会把上一条连接的半行残料算进下一条。

## 实测

| 项目 | 结果 |
|---|---|
| 纯逻辑吞吐 | 50 049 行 / 102.4 ms = **2.0 µs 每行** |
| 端到端 1200 行 × 3 轮（中位） | 开启 **118 ms** / 关闭 **60 ms** = **1.97×** |
| 装饰数 | 开启 33 个 / 关闭 0 个 |
| 数据完整性 | 两种模式都收到全部输出，哨兵行都在 |

## 验证

`scripts/verify-highlight.cjs`（64 项，7 组）：A 剥 ANSI 11 · B 切行器 9 · C 颜色/标志清洗 10 ·
D 规则编译 10 · E 命中判定 7 · F 回溯体检 6 · G 默认值归一 11。已接入 `npm run test:highlight`。

`scripts/verify-highlight-e2e.cjs`（17 项，真应用 + 真 SSH）：开规则 → 有装饰且落在含命中词的行、
整行宽、字符带规则底色与文字色；关开关 → 一条装饰都没有但输出照常显示（区分度）；删掉
`outputHighlight` 键 → 回落到内置默认规则；设置面板分区可见。

`scripts/perf-highlight.cjs`（12 项）：纯逻辑吞吐 + 开关两模式交替压测（交替是为了避免机器负载
漂移被算成高亮开销）。

## 踩过的坑

| 坑 | 现象 | 修法 |
|---|---|---|
| `stripAnsi` 把 `\n` 也剥了 | 切行器拿到整段输出粘成一行 | 加 `keepNewlines` 参数 |
| `\r\n` 的 `\r` 先清空缓冲 | 整行内容丢失，得到 `['','']` | 先判 `\r\n` 走换行分支并跳过 `\r` |
| `ESC(0` 字符集切换当成 2 字节序列 | 尾部 `0` 和后面的 `B` 残留成可见字符 | 中间字节在 0x20..0x2F 时整体跳 3 字节 |
| 超长行 overflow 时整行被丢 | 界面上凭空少一行 | 无条件产出一行 |
| 断言样本选错 | `cat: /x: No such file or directory` 想命中 `error`，但 `error` 长在 `directory` 里 | 换 `Permission denied` |

最后一条值得单独说：**量颜色不能量装饰 div**。`.xterm-decoration` 只是个透明的定位空壳
（`BufferDecorationRenderer._createElement` 只写 width/height/top/line-height），规则色是在
`DomRendererRowFactory` 里逐个 cell 覆盖上去的。量 `d.style.backgroundColor` 永远是空串，
据此判「颜色没生效」是假红 —— 改成量行内 cell 的 computed background 之后，实测
`rgb(74, 29, 29)` / `rgb(255, 180, 180)` 覆盖 44 个 cell。

## 兼容

老配置里没有 `outputHighlight` 键 → 回落到内置两条默认规则。故意**不**写进主进程
`DEFAULT_SETTINGS`：两处各存一份默认值，改一处漏一处就漂移。`{ rules: [] }` 是「用户自己
把规则删光了」，原样尊重，不塞回默认。
