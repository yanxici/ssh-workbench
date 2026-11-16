# 阶段 7（UI）：终端 WebGL + 自愈式降级

> 分支 `ui/webgl` · 父提交 `ui/status-detail`

## 1. 做了什么

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `@xterm/addon-webgl@0.19.0` |
| `components/terminal/TerminalView.tsx` | 先试 `WebglAddon`，失败/上下文丢失则回落 DOM |
| `main/index.ts` | 启动时**同步**读 `settings.experimental.softwareRender` 决定是否 `disableHardwareAcceleration()`；监听 `child-process-gone`，GPU 崩溃则落盘该 flag |
| `shared/types.ts` | `ExperimentalFlags.softwareRender?` |
| `settings/ExperimentalSection.tsx` | 新增「强制软件渲染」开关 |
| `scripts/verify-webgl.cjs` | **新增**，6 条断言，验 WebGL 路径 + 软件渲染路径 |

## 2. 关键设计：自愈式降级（Q7=b）

`app.disableHardwareAcceleration()` 必须在 `whenReady()` **之前同步**调用，而 `app.getGPUInfo()` 是异步的 ——
**探测不到真实 GPU 状态**。与其假装能预判，不如把「真实崩溃」当作信号：

```
启动 → 同步读 settings.experimental.softwareRender
        false → 硬件加速开 → 终端试 WebGL（失败回落 DOM）
        true  → 关硬件加速 → 终端走软件路径
运行中 → child-process-gone 且 type === 'GPU' → 落盘 softwareRender = true
         → 下次启动自动降级（不会反复崩）
```

只认 `type === 'GPU'`：渲染进程崩溃（OOM、页面异常）与显卡无关，不该触发全局降级。

## 3. 两个被实测推翻的假设（都写进了注释）

### 3.1 「软件渲染 ⇒ DOM 回落」是错的

关掉硬件加速后，Chromium 仍用 **SwiftShader 软件光栅化**提供 WebGL ——
实测 `softwareRender=true` 时终端**照样有 canvas**（2 个），WebGL 依然是激活状态。
真正的 DOM 回落只在 WebGL 上下文创建失败时发生。
原断言「canvas 数 == 0」因此是错的，已改为「软件渲染下不白屏（屏幕尺寸有效）」。

### 3.2 WebGL 下 `.xterm-rows` 是空的

WebGL 渲染器把字形画在 canvas 上，**不创建 `.xterm-rows` 的 DOM 行**，
`.xterm` 的 `innerText` 也是空的。这直接让 `verify-xterm6` 的两条断言（回显内容、DOM 行数）在阶段 7 后**假红**。

修法：
- 渲染存在性改为断言 `.xterm-screen` 有实际尺寸（两种后端都成立）；
- 回显内容改为读 **xterm buffer**（`terminalRegistry` 现在通过 `ZM_TEST` 测试桥暴露），
  主门禁用普通构建时该断言显式 `SKIP` 并说明原因 —— 不假装通过。

## 4. 门禁与基准

| 命令 | 结果 |
|---|---|
| typecheck / lint | ✅ 0 错误 |
| test:verify | ✅ **61 通过 / 0 失败**（阶段 5 是 60，新增 1） |
| UI e2e | ✅ 18/18 |
| `verify-webgl` 实测 | 默认路径 canvas=3、屏幕 507×720；软件渲染路径 canvas=2、屏幕 507×720（不白屏）|
| build | JS **2,035.15 kB**（+148 kB，WebGL addon 本体）|

## 5. 风险与回滚

| 风险 | 说明 |
|---|---|
| WebGL 上下文丢失 | 已挂 `onContextLoss` → dispose → 自动回落 DOM |
| 远程桌面/虚拟机 GPU 崩溃 | 自愈机制会在**崩一次之后**永久降级（可接受：代价是一次重启）|
| 包体 +148 kB | WebGL 渲染管线代码，与「强制 WebGL」的硬约束等价交换 |
| `verify-xterm6` 的回显断言在主门禁被 SKIP | 已明确标注，不伪装通过；内容级验证需 `npm run test:vlist` 同类的 ZM_TEST 构建 |

回滚：`git checkout ui/status-detail`。若只想关掉 WebGL 而不回退代码：设置里打开「强制软件渲染」
（注意：按 3.1 的实测，这不会禁用 WebGL，只会关硬件加速）。

## 6. 2026-11 修订：默认后端翻回 DOM（v2.1.1）

发布后现场反馈「升级后终端字体变丑、字距像双倍」。排查结论（数据见 `scripts/verify-webgl.cjs` 文件头）：

| 度量（dpr=1，`clip.scale=4` 截图列投影） | WebGL | DOM |
|---|---|---|
| cell pitch | 32.0px | 33.0px |
| `MWMWMWMW` 墨迹宽度 | 27/34/27/34… | 31/31/31/31… |
| `lab-shell ready` 细笔宽度 | 5~7px（笔画断开） | 24px（饱满） |
| 光标块 | 32×96 | 32×96 |

格子尺寸两路径一致 → **不是** 字号 / DPI / 字体栈（裸 `Consolas` 与完整字体栈截图字节级同尺寸，
44797 B 完全一致）。是 `@xterm/addon-webgl@0.19.0` 图集栅格化后字形被画小，只能换后端绕开。

改动：

- `shared/types.ts` 新增 `TerminalRenderer = 'dom' | 'webgl' | 'auto'` 与 `ExperimentalFlags.terminalRenderer`，
  **缺省 `'dom'`**；
- `TerminalView.tsx` 渲染后端由 `settings.experimental.terminalRenderer` 决定，`'dom'` 时根本不 `new WebglAddon()`；
- `ExperimentalSection.tsx` 新增「终端渲染后端」三段控件（DOM / 自动 / WebGL）；
- `main/store/repo/settings.ts` 的 `mergeSettings` 改为**逐键合并 `experimental`** ——
  老配置存的是 `{ tokens: {} }`，整段覆盖会抹掉 `terminalRenderer` 默认值；
- `verify-webgl.cjs` 从 2 段扩到 3 段、断言改为「默认无 canvas + 有 DOM 行」「webgl 段有 canvas」「软件渲染段不白屏」。

为什么不做「检测字形尺寸自动回落」：addon 没有公开字形度量，只能截屏做像素分析，
在启动路径上不可接受。给用户一个显式开关，比猜更可靠。

回滚：设置里把「终端渲染后端」切回 WebGL 即恢复阶段 7 行为。

## 7. 2026-11 修订二：真根因是字体串前导空格（v2.1.2）

上一节把「图集栅格化后字形被画小」当成了 addon 的黑箱行为，绕开了但没解释。继续追的结果：

`@xterm/addon-webgl@0.19.0` 的 `TextureAtlas` 这样拼 canvas font：

~~~js
const S = bold ? config.fontWeightBold : config.fontWeight
const D = italic ? 'italic' : ''
this._tmpCtx.font = `${D} ${S} ${fontSize * dpr}px ${fontFamily}`
~~~

非斜体时 `D` 是空串，**模板里那个空格还在**，实际写入的是
`" normal 15px 'JetBrains Mono', 'Fira Code', Consolas, monospace"` —— 前导空格。

Chromium 的 **canvas** font 解析器不 trim（CSS 解析器 trim，这就是 DOM 后端一直正常的原因）。
整串判非法后，`font` setter **静默保留旧值**，也就是新建 2D 上下文的初始值 `10px sans-serif`。
图集于是按 10px 光栅化，再贴进按 `fontSize × dpr` 算出的格子里：字小、笔画细、四周空白多
—— 肉眼读作「字距变宽」。

验证不靠观感，直接看实际生效值（`Page.addScriptToEvaluateOnNewDocument` 注入
`fillText` 猴补丁，记录 `this.font`）：

| 场景 | `fillText` 实际 font |
|---|---|
| 修复前，dpr=1 | `10px sans-serif` × 94（图集预热 94 个字符） |
| 修复前，dpr=2 | `10px sans-serif` × 94（**不随 dpr 变**，所以高清屏更惨） |
| 修复后，dpr=1 | `15px "JetBrains Mono", "Fira Code", Consolas, monospace` × 94 |
| 修复后，dpr=2 | `30px "JetBrains Mono", "Fira Code", Consolas, monospace` × 94 |

另做过一组对照：把 15 种带前导空格的写法（`" normal 15px Consolas"`、`" bold 15px monospace"`、
`" 15px monospace"` …）喂给 `ctx.font`，读回**全部**是旧值；只有去掉前导空格的
`"normal 15px …"`、`"15px Consolas"` 被接受。与字体族、字号、粗体无关，只和前导空格有关。

改动：

- `src/renderer/src/lib/canvasFont.ts`（新增）：`installCanvasFontShim()` 在 `main.tsx` 里
  任何渲染之前包装 `CanvasRenderingContext2D.prototype.font` 的 setter ——
  写入前 `normalizeCanvasFont()`（折空白 + trim + 清 `undefined`/`null`/`NaN` 残渣），
  写完读回比 px 字号，不一致就退化成「字号对、字体族沿用读回值」。幂等。
- `TerminalView.tsx`：挂 `WebglAddon` 前先跑 `isCanvasFontApplied()`（离屏 canvas 按 addon
  的拼法试写一次，读回字号必须等于配置值），不成立就不挂 WebGL、回落 DOM 并打日志。
  这一条替代了上一节「给用户一个开关让他自己切」的思路 —— 开关保留，但不再是唯一出路。
- `verify-webgl.cjs` 新增 4 条断言（图集未退回 10px / 字号 = `fontSize × dpr` / 字体族来自配置 /
  预热确有 `fillText`）。做了变异验证：去掉 shim 再强制挂 WebGL，这 4 条会红。

