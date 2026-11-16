# SSH Workbench v2.1.2

一个更正版：v2.1.1 说「WebGL 字形回归，只能在应用层绕开」——这个判断错了。真根因是一个前导空格，已经修掉。

## 根因

`@xterm/addon-webgl@0.19.0` 的 `TextureAtlas` 这样拼 canvas font：

~~~js
const D = italic ? 'italic' : ''
this._tmpCtx.font = `${D} ${bold ? config.fontWeightBold : config.fontWeight} ${fontSize * dpr}px ${fontFamily}`
~~~

非斜体时 `D` 是空串，但**模板里的空格还在**。实际写入的是：

~~~text
" normal 15px 'JetBrains Mono', 'Fira Code', Consolas, monospace"
~~~

Chromium 的 **canvas** font 解析器不 trim（CSS 解析器 trim，所以 DOM 渲染器从来没出过问题）。
整串被判非法后，`font` 的 setter **静默保留旧值** —— 也就是新建 2D 上下文的初始值 `10px sans-serif`。
图集于是按 10px 光栅化，再贴进按 `fontSize × dpr` 算出来的格子：字形小、笔画细、四周空白变多。
肉眼读作「字距变宽」，其实是字形没填满格子。

## 证据

不靠观感，直接看实际生效值（`Page.addScriptToEvaluateOnNewDocument` 注入 `fillText` 猴补丁，记录 `this.font`）：

| 场景 | `fillText` 实际 font |
|---|---|
| 修复前，dpr=1 | `10px sans-serif` × 94 |
| 修复前，dpr=2 | `10px sans-serif` × 94（**不随 dpr 变**，所以高分屏更糟） |
| 修复后，dpr=1 | `15px "JetBrains Mono", "Fira Code", Consolas, monospace` × 94 |
| 修复后，dpr=2 | `30px "JetBrains Mono", "Fira Code", Consolas, monospace` × 94 |

另一组对照：把 15 种带前导空格的写法（`" normal 15px Consolas"`、`" bold 15px monospace"`、
`" 15px monospace"` …）喂给 `ctx.font`，读回**全部**是旧值；只有去掉前导空格的
`"normal 15px …"`、`"15px Consolas"` 被接受。与字体族、字号、粗体全部无关，只和前导空格有关。

像素层面（dpr=1，scale 4 截图列投影）：字高 10 → 13 px，墨迹宽 ÷ 字距 0.56~0.63 → 0.75~0.88。

## 改了什么

两处，都不碰 addon 源码：

- `src/renderer/src/lib/canvasFont.ts`（新增）：`installCanvasFontShim()` 在 `main.tsx` 里**任何渲染之前**
  包装 `CanvasRenderingContext2D.prototype.font` 的 setter —— 写入前 `normalizeCanvasFont()`
  （折空白 + trim + 清掉 `undefined`/`null`/`NaN` 残渣），写完读回比一次 px 字号，不一致就
  退化成「字号对、字体族沿用读回值」。幂等，原型不可写的环境直接跳过。
- `TerminalView.tsx`：挂 `WebglAddon` 之前先跑 `isCanvasFontApplied()`（离屏 canvas 按 addon 的
  拼法试写一次，读回字号必须等于配置值），不成立就不挂 WebGL、回落 DOM 并打日志。
  将来 addon 换拼法、或字体族名让整串再次非法，用户也只会看到「用回了 DOM」，而不是「字变丑了」。

设置面板里「终端渲染后端」的说明同步改了 —— 不再是「WebGL 会把字画小」，而是
「挂载前会自检字形是否按配置光栅化，不成立自动回落 DOM」。默认后端仍然是 DOM（保守），
想用 WebGL 随时切。

## 门禁

- `verify-webgl.cjs` 新增 4 条断言：图集未退回 canvas 默认 10px、字号等于 `fontSize × dpr`、
  字体族来自配置、图集预热确有 `fillText` 调用。做过变异验证 —— 去掉 shim 并强制挂 WebGL，
  这 4 条会红（`fontUniq: ["10px sans-serif"]`），说明断言不是装饰。
- `typecheck` / `eslint` / `electron-vite build` 全绿；`verify-webgl` 14/14、`verify-xterm6` 8/8。

## 其它

同批还带着串口刷机配套的 TFTP 服务端与 U-Boot 引导条（详见 CHANGELOG 的对应条目）。
