/**
 * Canvas 2D `font` 设置器的兼容补丁 + 自检。
 *
 * 为什么需要它（这是真实踩到的坑，不是防御性编程）：
 *
 *   @xterm/addon-webgl 0.19.0 在 TextureAtlas 里这样拼字体串（lib/addon-webgl.js）：
 *
 *     const S = bold ? config.fontWeightBold : config.fontWeight
 *     const D = italic ? 'italic' : ''
 *     this._tmpCtx.font = `${D} ${S} ${fontSize * dpr}px ${fontFamily}`
 *
 *   D 为空串时模板里那个空格还在，于是非斜体字形拿到的是
 *
 *     " normal 15px 'JetBrains Mono', 'Fira Code', Consolas, monospace"
 *     ^ 前导空格
 *
 *   Chromium 的 canvas font 解析器**不 trim**：带前导空格的 shorthand 被判为
 *   非法赋值，setter 静默保留旧值 —— 而上下文刚 new 出来时是初始值
 *   `10px sans-serif`。于是整个字符图集都用 10px sans-serif 光栅化，
 *   再按配置算出来的格子（deviceCellWidth/Height，按 15px 算）贴回去：
 *
 *     - 字形墨迹恒为 4~5px，与 dpr 无关（dpr=2 时格子翻倍、字不放大）
 *     - 视觉上就是「笔画细、字距变宽、字像是被摊开」
 *
 *   DOM 渲染器走 CSS（CSS 解析器对前导空格宽容），所以只有 WebGL 会翻车 ——
 *   这也解释了「切回 DOM 就正常」。
 *
 * 补丁做法：只包一层 setter，赋值前
 *   1. 去掉 undefined/null/NaN 这类拼接残渣（配置没给 fontWeight 时会出现
 *      "undefined 15px ..."，同样是非法串）
 *   2. 折叠空白并 trim（修掉前导空格这个真凶）
 * 其余语义完全交给浏览器，getter 原样返回。
 *
 * 为什么不改 addon：它是压缩产物，改 node_modules 会被重装冲掉。这里改的是
 * 「宿主页面一个 API 的行为」，作用域清晰、可自测，对其它 canvas 使用者无害
 * （只把非法串修成等价合法串，合法串原样通过）。
 */

const SHIM_FLAG = '__swCanvasFontShimInstalled'

/** 把拼接残渣与前导/重复空白处理掉；合法串经过这里应当原样返回 */
export function normalizeCanvasFont(value: string): string {
  return value
    .replace(/\b(?:undefined|null|NaN)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取字体串里的 px 字号（取不到返回 null） */
function pxSize(font: string): string | null {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return m ? m[1] : null
}

/** 取字体串里 px 之后的字体族部分（取不到返回 monospace） */
function familyOf(font: string): string {
  const m = /\d+(?:\.\d+)?px\s+(.+)$/.exec(font)
  return m ? m[1] : 'monospace'
}

/**
 * 安装补丁。幂等：重复调用只有第一次生效。
 * 必须在任何 canvas 绘制之前调用（main.tsx 里紧跟样式导入）。
 */
export function installCanvasFontShim(): void {
  const win = window as unknown as Record<string, unknown>
  if (win[SHIM_FLAG] === true) return

  const proto = window.CanvasRenderingContext2D?.prototype
  if (!proto) return
  const desc = Object.getOwnPropertyDescriptor(proto, 'font')
  if (!desc || typeof desc.get !== 'function' || typeof desc.set !== 'function') return

  /*
   * 原生访问器必须保留在原型上按 ctx 调用，取出来单独持有正是意图所在，
   * 不是把方法当回调传出去。这里显式收窄签名并 .call 绑定接收者。
   */
  type FontGetter = (this: CanvasRenderingContext2D) => string
  type FontSetter = (this: CanvasRenderingContext2D, value: string) => void
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 见上：刻意取出原生访问器再以 ctx 为接收者调用
  const readFont = desc.get as FontGetter
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const writeFont = desc.set as FontSetter
  const read = (ctx: CanvasRenderingContext2D): string => readFont.call(ctx)
  const write = (ctx: CanvasRenderingContext2D, v: string): void => {
    writeFont.call(ctx, v)
  }

  try {
    Object.defineProperty(proto, 'font', {
      configurable: true,
      enumerable: desc.enumerable === true,
      get(this: CanvasRenderingContext2D): string {
        return read(this)
      },
      set(this: CanvasRenderingContext2D, value: string): void {
        if (typeof value !== 'string') {
          write(this, value)
          return
        }
        const fixed = normalizeCanvasFont(value)
        write(this, fixed)
        /*
         * 兜底：极少数字体族本身含特殊字符时，修正后仍可能非法，
         * setter 会静默失败、font 停在旧值。读回来比一次字号，
         * 不一致就退化成「字号对、字体族沿用读回值」——
         * 字小比字体族不对更难忍。
         */
        try {
          const back = read(this)
          if (!back) return
          const want = pxSize(fixed)
          const got = pxSize(back)
          if (want && got !== want) write(this, `${want}px ${familyOf(back)}`)
        } catch {
          /* 读回失败不影响主流程 */
        }
      }
    })
    win[SHIM_FLAG] = true
  } catch {
    /* 原型不可改（罕见）：保持原样，相当于没有补丁 */
  }
}

/**
 * 自检：把字体串按 addon 的拼法（含那个前导空格）喂给离屏 canvas，
 * 看浏览器是否真的接受 —— 读回的字号与期望一致才算通过。
 *
 * 用途：
 *   1. WebGL 渲染器挂载后立刻验证字形是否真按配置光栅化，不成立就回落 DOM；
 *   2. 诊断脚本里判定「这台机器 + 这个版本」是否已经修好。
 */
export function isCanvasFontApplied(fontFamily: string, fontSize: number): boolean {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  ctx.font = '10px sans-serif'
  // 复刻 addon 的拼法：非粗体非斜体时，前面的空格会被保留
  ctx.font = ` normal ${fontSize}px ${fontFamily}`
  return pxSize(ctx.font) === String(fontSize)
}