# SSH Workbench v2.1.1

一个回归修复版：把终端的默认渲染后端从 WebGL 翻回 DOM。

## 为什么发这一版

v2.1.0 把终端默认切到 WebGL 渲染器（`@xterm/addon-webgl`）。升级后现场反馈很直接：
**字变丑了，字距像被拉宽了一倍**。有人形容「像换了个字体」，但换字体不是原因。

## 根因：字形被画小了，不是字距变宽

同一份设置（`fontSize: 15`、`lineHeight: 1.35`、DPR 1.5、light 主题）下逐像素量同一行文本：

| 度量（dpr=1，`clip.scale=4` 截图列投影） | WebGL | DOM |
|---|---|---|
| 格子推进（cell pitch） | 32.0 px | 33.0 px |
| `MWMWMWMW` 墨迹宽度 | 27 / 34 / 27 / 34 … | 31 / 31 / 31 / 31 … |
| `lab-shell ready` 细笔宽度 | 5 ~ 7 px（笔画断开） | 24 px（饱满） |
| 光标块 | 32 × 96 | 32 × 96 |

**格子尺寸两条路径一致**（光标块像素级相同），只有格子里那个字形被画小了 ——
所以视觉上的「字距太宽」，实际是字形周围的空白变多。

排除掉的嫌疑：

- **不是字号**：图集 canvas 收到的 `font` 是 ` normal 22.5px <字体栈>`，正是 15 × 1.5。
- **不是 DPI**：强制 `--force-device-scale-factor=1`（dpr=1）和 `=2` 都一样错；
  canvas 像素尺寸也对（`768 = 512 × 1.5`）。
- **不是字体栈**：裸 `Consolas` 与完整字体栈的截图**字节级同尺寸**（44797 B 完全一致）。
  本机没装 JetBrains Mono / Fira Code，回落到 Consolas，等宽性正常（`M` 与 `─` 宽度相等）。
- **不是行高**：`lineHeight: 1.0` 下字形依旧瘦小。

是 `@xterm/addon-webgl@0.19.0` 图集栅格化后的字形尺寸回归，只能在应用层绕开 ——
addon 没有公开字形度量，做「检测到字形偏小就自动回落」只能截屏做像素分析，不能放在启动路径上。

## 做了什么

- `shared/types.ts` 新增 `TerminalRenderer = 'dom' | 'webgl' | 'auto'` 与 `ExperimentalFlags.terminalRenderer`，
  **缺省 `'dom'`**；
- `TerminalView.tsx` 的渲染后端由该设置决定，`'dom'` 时根本不构造 `WebglAddon`；
- 设置 → 实验性 新增「终端渲染后端」三段控件（DOM / 自动 / WebGL），
  想用 WebGL 的人随时可以切回去；
- `main/store/repo/settings.ts` 的 `mergeSettings` 改为**逐键合并 `experimental`** ——
  老配置里存的是 `{ tokens: {} }`，整段覆盖会把新字段的默认值抹掉（实测老配置读回 `dom`，已覆盖）；
- `scripts/verify-webgl.cjs` 从 2 段扩到 3 段，断言改为「默认无 canvas + 有 DOM 行」「webgl 段有 canvas」
  「软件渲染段不白屏」，并把上面这组度量写进文件头当回归说明。

## 升级方式

解压覆盖，重启应用即生效 —— 不需要动任何设置：老配置缺 `terminalRenderer` 时按 `dom` 处理。

## 验证

| 项 | 结果 |
|---|---|
| typecheck（web + node） | 0 错误 |
| `verify-webgl` | 10 通过 / 0 失败 |
| 视觉复核（scale 4 截图列投影） | 首行墨迹 36 / 37 / 38 / 26 …，`MWMW` 行 46 / 46 / 45 … —— 与 v2.0.0 观感一致 |
| 打包产物 | `SSH Workbench.exe` FileVersion 2.1.1 / ProductVersion 2.1.1.0 |
