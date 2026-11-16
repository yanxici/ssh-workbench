# SSH Workbench v2.1.5 —— 嵌套分屏

## 为什么做这个

调一台交换机重启，同时盯它的串口输出和另一台设备的 uptime —— 这是日常动作。v2.1.4 之前只能开两个标签来回点，切过去的瞬间正好错过那行报错。

WindTerm、Tabby、Netcatty 都有分屏，而且都支持嵌套（先横切、再在某一半里竖切）。这一版补上。

## 数据模型是树，不是「最多两格」

```ts
type PaneNode =
  | { type: 'leaf'; sessionId: string }
  | { type: 'split'; dir: 'row' | 'col'; ratio: number; children: [PaneNode, PaneNode] }
```

行列切分次数不限，但**叶子总数限制 4 个**。理由很实际：主区域扣掉侧栏与命令栏后约 900px，切到 5 格每格不到 200px，80 列的终端连 300px 都放不下。超限时提示「再分下去每格宽度不足 300px，先关掉一个再分」，不静默失败。

布局计算抽成零依赖的 `src/renderer/src/lib/paneTree.ts`（233 行），可以脱离 Electron 单测 —— 这也是它能被 74 条断言逐一钉住的原因。

## 三个容易做错的地方

### 1. `layoutPaneTree` 不扣 gap

它返回的是**纯百分比矩形**，格与格之间的 4px 缝隙由渲染层每格外侧 `p-[2px]` 让出。如果在计算里扣 gap，嵌套时缝隙会按层数叠加：一层 4px、两层 8px、三层 12px，看不出哪里错但就是不齐。

### 2. 焦点迁移不能只取「中心距最短」

朴素实现：按方向找中心点最近的格子。2×2 布局下从左上格按「右」，右下格的中心距可能比右上格更短，焦点就斜着跳了。

`neighbor()` 分两档：

```ts
const strictSide = overlap > 0 && best.overlap <= 0
const sameSide = (overlap > 0) === (best.overlap > 0)
if (strictSide || (sameSide && score < best.score)) best = { id, score, overlap }
```

先只在「同侧有重叠」的候选里选，同档内才比距离。这一档是 11 条断言里的 H 组专门守的。

### 3. 拖拽期间绝不能 `fit()`

拖动分隔条时若每帧都重算 xterm 的 cols/rows，还要往主进程发 resize IPC，表现是拖起来一顿一顿的，松手后终端内容还会重排两次。

做法：`setDragging(true)` → `TerminalView.scheduleFit` 的 rAF 回调直接 return；拖动过程只更新 CSS flex 比例；`pointerup` 时 `refitTick += 1`，所有可见格各 `fit()` 一次。

实测 `layoutPaneTree` 单次 **0.54 微秒**（4 格树 × 20 000 次 = 10.7ms），即拖动时算布局的开销可以忽略，真正的开销在 `fit()` 与 IPC —— 所以省掉它们才有意义。

## 顺手修掉一个真 bug：JsonStore 写-读竞态

**这个 bug 不在分屏代码里，是分屏落盘时撞出来的。**

现象：拖动分隔条后 `splitLayout` 明明写了，紧接着 `settings.get()` 读回 `{}`；重启应用后又正常。第一次看到以为是渲染层没提交。

根因在 `src/main/store/jsonStore.ts` 的 `load()`：

1. `load()` 开始 `await fs.readFile`
2. 期间 `update()` 完成，写临时文件 + `rename` 落地
3. `readFile` 拿着旧 inode 读，ENOENT
4. **旧实现**在 catch 里把 `cache = fallback()`（空对象），并把 `cacheSignature` 刷成**新文件**的指纹
5. 「缓存指纹 == 文件指纹」成立 → 之后每次 `read()` 都直接返回那个空对象，直到 mtime 再变

日志链是决定性的：`U#6 in=0` → `U#6 out=17` → `R#6 n=17 fresh=null cached=null` → `repoGet n=0 json={}`，此后每次 `R#6 n=0` 都带着与文件一致的指纹。

修法用代际号，不加锁：

```ts
private writeGen = 0

async load() {
  const gen = this.writeGen
  // ... await fs.readFile ...
  const sig = await this.statSignature()
  if (gen !== this.writeGen) return this.cache ?? this.fallback()   // 读盘结果已作废
  this.cacheSignature = sig
  this.cache = parsed
}
```

`update()` 与 `write()` 各让 `writeGen += 1`。读盘路径仍然无锁并发，只多一个「这次读盘结果还能不能用」的判断 —— 比加锁轻，而且不会在主进程里制造等待。

**变异验证**：把 `if (gen !== this.writeGen)` 这一行删掉做回归，R1–R5 立刻全红（读回 `[]`、update 基线变成 1 条）。这些断言是有区分度的，不是假绿。

## 交互细节

| 操作 | 行为 |
|---|---|
| 标签右键 → 向右/向下分屏 | 在焦点格上切分，新格开同连接的第二个会话 |
| `Ctrl+Alt+↑↓←→` | 焦点在格间移动；**单格时不吞键**，仍是终端按词移动光标 |
| `Ctrl+Tab` | 仍是切标签 —— 嵌套格不是标签 |
| `Ctrl+F` | 只搜焦点格 |
| 标签 `x` | 多格时变「关闭此分屏」，最后一格关掉时整树折叠回单终端、标签保留 |
| `Ctrl+Shift+W` | 关当前格；只剩一格则关标签 |

分屏比例与树结构按**连接 id** 存进 `settings.splitLayout`：

```ts
type PersistedPane =
  | { t: 'l'; c: string }                                        // leaf → connectionId
  | { t: 's'; d: 'row' | 'col'; r: number; k: [PersistedPane, PersistedPane] }
```

字段名是单字母，因为这个形状会按连接重复存进同一个 json。会话 id 每次启动都新，按会话存等于不存。只在 `restoreSessions === true` 时恢复；单格标签不写盘，避免几十条连接各留一棵只有叶子的垃圾树。

## 验证

| 脚本 | 内容 | 结果 |
|---|---|---|
| `scripts/verify-pane-tree.cjs` | 布局/塌缩/替换/比例/焦点迁移 9 组 | 74 条通过 |
| `scripts/verify-split-e2e.cjs` | 真实 SSH 会话上分屏、拖拽、焦点、落盘 | 16 项通过 |
| `scripts/verify-jsonstore-race.cjs` | 写-读竞态 + 变异验证 | 7 条通过，删守卫后 5 条红 |
| `scripts/perf-split.cjs` | 布局吞吐 + 落盘往返 + 数据零影响 | 10 项通过 |

四条踩过的坑，值得单独记：

1. **e2e 拖错了元素。** 页面有三个 `role="separator"`：侧边栏、分屏、命令栏。原来取第一个（侧边栏），拖完 `splitLayout` 当然是空的 —— 查了两小时实现，问题在选择器。
2. **`Ctrl+Alt+→` 的吞键断言是假绿。** 向右分屏后焦点落在新开的右格，右格右侧没有邻居，`focusSiblingPane('right')` 正确返回 `false`，快捷键本就不该吞键。改成按 `Ctrl+Alt+←`。
3. **焦点断言不能比「分屏前的 id」。** 分屏本身就把焦点给了新格，所以「按完键的焦点 ≠ 分屏前的焦点」恒真。要比「按之前那一格 ≠ 按之后那一格」。
4. **`normalizeRatio(Infinity)` 不是夹到上限。** 实现里非有限值统一当「没给」返回 0.5；断言写成 0.85 就红了 —— 又是断言错，不是实现错。

## 实测数据

- `layoutPaneTree`：4 格嵌套树 × 20 000 次 = 10.7ms，**单次 0.54us**
- 「写 `splitLayout` 再读回」40 轮：中位 **2.8ms**、最慢 5.1ms
- 压测前后 `connections.json`：条数、id 集合、sha256 三者完全一致
- 分屏后每格 276 × 741 px（1440 宽窗口、侧栏 + 命令栏常驻）

## 兼容性

- 老配置没有 `splitLayout` 键 → `DEFAULT_SETTINGS.splitLayout = {}`，一切照旧单终端。
- 树里引用的连接已被删除 → `reconcile()` 在恢复时丢弃无效叶子，剩一个就塌缩成单终端。
- `splitLayout` 是**整表覆盖**（`patch.splitLayout ?? base.splitLayout`），不做逐键合并 —— 删掉一个连接的分屏记录必须能真的删掉。
