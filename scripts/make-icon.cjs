/*
 * 生成应用图标：build/icon.png（1024）/ build/icon.ico（多尺寸）/ resources/icon.{png,ico}
 *
 * 为什么要有这个脚本：项目此前一直没有 build/icon.png，electron-builder 每次
 * 都打印 `default Electron icon is used reason=application icon is not set`，
 * 于是 exe 资源里带的是 Electron 自带图标 —— 在 Windows 11 的浅色任务栏上
 * 表现为一块几乎全白的方块，看不出是哪个程序。
 *
 * ---- 为什么必须出 .ico 而不是只给一张 png ----
 * 第一版只给了 build/icon.png，electron-builder 转出的 .ico 里就一条
 * 256×256（PNG 压缩）记录。实测：
 *   ExtractIconEx 报告 `resource icons=1 -> [0]=32x32`
 *   WM_GETICON(ICON_SMALL) 返回的句柄仍是 256×256 的位图
 * 也就是说 Windows 手上只有一张 256 的图，无论任务栏要多大的图标，都得由
 * GDI 现场缩。GDI 的图标缩小滤波很差，24/32px 上绿色被白边糊掉 —— 于是
 * 「图标明明是绿的，任务栏上却发白」。大预览（Alt+Tab、资源管理器大图标）
 * 反而是对的，这也是为什么之前一直误判成「没换图标」。
 *
 * 所以这里自己画 .ico，把 16 / 24 / 32 / 48 / 64 / 128 / 256 七个尺寸
 * 各自独立渲染（不是从 1024 缩），每个尺寸都用超采样抗锯齿，并且小尺寸
 * 单独加粗笔画 —— 16px 上 0.088 的线宽只有 1.4px，会断成虚线。
 *
 * 全部用纯 JS 画（不引 canvas / sharp）：4×4 超采样，够用且无依赖。
 * 运行：node scripts/make-icon.cjs
 */

const { deflateSync } = require('node:zlib')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const MASTER = 1024 // build/icon.png 用（electron-builder 也会读它做备用）
const SS = 4 // 每像素 4×4 子采样
const ROOT = join(__dirname, '..')

/* ---------- 几何 ---------- */

/** 点在圆角矩形内（单位坐标 0..1，矩形铺满画布，角落半径 r） */
function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 点到线段距离的平方 */
function distToSegSq(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0
  t = Math.min(1, Math.max(0, t))
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return dx * dx + dy * dy
}

/** 描边线段（圆头圆角），返回是否命中 */
function onStroke(x, y, ax, ay, bx, by, w) {
  return distToSegSq(x, y, ax, ay, bx, by) <= (w / 2) * (w / 2)
}

/* 提示符「>」：两段折线，转折用同一个半径 → 圆角连接 */
const CHEVRON = [
  [0.275, 0.305, 0.505, 0.5],
  [0.505, 0.5, 0.275, 0.695]
]
/* 下划线「_」 */
const UNDERSCORE = [0.575, 0.665, 0.745, 0.665]

/**
 * 线宽随尺寸变化。
 * 48px 以上保持 0.088（大约是 4px 粗的观感）；
 * 32px 给 0.105、24px 给 0.128、16px 给 0.155 —— 小图上细线会被抗锯齿
 * 抹成半透明的灰，看着像「右上角有一团脏东西」，加粗后仍是清楚的「>_」。
 */
function strokeFor(size) {
  if (size >= 64) return 0.088
  if (size >= 48) return 0.095
  if (size >= 32) return 0.108
  if (size >= 24) return 0.13
  return 0.16
}

/** 小尺寸下把字形略微收进一点，避免笔画贴到圆角边缘 */
function glyphScaleFor(size) {
  if (size >= 32) return 1
  if (size >= 24) return 0.96
  return 0.9
}

/** 品牌绿渐变：左上亮、右下深，避免纯平色显得廉价 */
function gradColor(t) {
  const from = [52, 217, 90] // #34d95a
  const to = [23, 160, 51] // #17a033
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t)
  ]
}

/* ---------- 渲染 ---------- */

function render(size) {
  const buf = Buffer.alloc(size * size * 4)
  const inv = 1 / size
  const sub = 1 / SS
  const subArea = 1 / (SS * SS)
  const stroke = strokeFor(size)
  const gs = glyphScaleFor(size)
  /* 字形绕中心缩放：x' = 0.5 + (x - 0.5) * gs */
  const gx = (v) => 0.5 + (v - 0.5) * gs
  const radius = size >= 32 ? 0.22 : 0.2

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCov = 0
      let fgCov = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) * sub) * inv
          const y = (py + (sy + 0.5) * sub) * inv

          if (!inRoundedRect(x, y, radius)) continue
          bgCov += 1

          let hit = false
          for (const s of CHEVRON) {
            if (onStroke(x, y, gx(s[0]), gx(s[1]), gx(s[2]), gx(s[3]), stroke)) {
              hit = true
              break
            }
          }
          if (
            !hit &&
            onStroke(x, y, gx(UNDERSCORE[0]), gx(UNDERSCORE[1]), gx(UNDERSCORE[2]), gx(UNDERSCORE[3]), stroke)
          ) {
            hit = true
          }
          if (hit) fgCov += 1
        }
      }

      const bgA = bgCov * subArea
      const fgA = fgCov * subArea
      const o = (py * size + px) * 4
      if (bgA === 0) {
        buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0
        continue
      }
      // 渐变沿对角线方向取 t
      const t = Math.min(1, Math.max(0, (px * 0.35 + py * 0.65) / size))
      const [r, g, b] = gradColor(t)
      // 白色字形按覆盖率覆盖在底色上
      buf[o] = Math.round(r + (255 - r) * fgA)
      buf[o + 1] = Math.round(g + (255 - g) * fgA)
      buf[o + 2] = Math.round(b + (255 - b) * fgA)
      buf[o + 3] = Math.round(255 * bgA)
    }
  }
  return buf
}

/* ---------- PNG 编码 ---------- */

function crc32(buf) {
  let c
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const t = new Int32Array(256)
      for (let n = 0; n < 256; n++) {
        c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c
      }
      return t
    })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- ICO 编码 ---------- */

/**
 * 一个 ICO 条目（BMP 形式）：BITMAPINFOHEADER + 自底向上 BGRA + 1bpp AND 掩码。
 * 小尺寸用 BMP 而不是 PNG：PNG 压缩的 ICO 条目在 Vista 以后合法，但一些老的
 * shell 扩展（含部分国产安全软件的文件图标钩子）读不出来，会退回默认图标。
 * 128/256 用 PNG，纯粹是为了不让 ico 文件涨到 300KB 以上。
 */
function icoBmpEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight（XOR + AND 两张图叠起来的高度）
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20) // biSizeImage

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4 // 自底向上
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }

  const maskStride = Math.ceil(size / 32) * 4 // 每行按 4 字节对齐
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const alpha = rgba[srcRow + x * 4 + 3]
      if (alpha === 0) {
        // 全透明像素在掩码里置 1（= 不绘制）
        mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  return Buffer.concat([header, xor, mask])
}

function buildIco(entries) {
  // entries: [{ size, data }]
  const dir = Buffer.alloc(6 + entries.length * 16)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type = icon
  dir.writeUInt16LE(entries.length, 4)

  let offset = dir.length
  const blobs = []
  entries.forEach((e, i) => {
    const o = 6 + i * 16
    dir[o] = e.size >= 256 ? 0 : e.size // 256 记作 0
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0 // colorCount
    dir[o + 3] = 0 // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bitCount
    dir.writeUInt32LE(e.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.data.length
    blobs.push(e.data)
  })

  return Buffer.concat([dir, ...blobs])
}

/* ---------- 落盘 ---------- */

console.log(`渲染主图 ${MASTER}×${MASTER}（${SS}×${SS} 超采样）…`)
const master = render(MASTER)

mkdirSync(join(ROOT, 'build'), { recursive: true })
mkdirSync(join(ROOT, 'resources'), { recursive: true })

const png1024 = encodePng(master, MASTER)
writeFileSync(join(ROOT, 'build', 'icon.png'), png1024)
console.log(`build/icon.png                 ${png1024.length} B  ${MASTER}×${MASTER}`)

/*
 * .ico：每个尺寸单独渲染。
 * 16/24/32 是任务栏、标题栏、Alt+Tab 小图真正会用到的尺寸，必须由我们自己
 * 画出干净的像素，不能交给系统缩。
 */
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]
const entries = []
for (const n of ICO_SIZES) {
  const rgba = render(n)
  const data = n >= 128 ? encodePng(rgba, n) : icoBmpEntry(rgba, n)
  entries.push({ size: n, data })
  console.log(`  ico ${String(n).padStart(3)}×${String(n).padEnd(3)}  ${String(data.length).padStart(6)} B  ${n >= 128 ? 'png' : 'bmp'}`)
}
const ico = buildIco(entries)
writeFileSync(join(ROOT, 'build', 'icon.ico'), ico)
writeFileSync(join(ROOT, 'resources', 'icon.ico'), ico)
console.log(`build/icon.ico                 ${ico.length} B  ${ICO_SIZES.join('/')}`)

/*
 * resources/icon.* 是给 BrowserWindow 用的窗口图标（开发模式任务栏也要有图标）。
 * 打包后 exe 自身带图标，但仍然显式传：
 *   - png 给 macOS/Linux 与「读不到 ico」的老 Windows 兜底；
 *   - ico 优先，Windows 才能按需取 16/24/32 而不去缩 256 的图。
 */
const png256 = encodePng(render(256), 256)
writeFileSync(join(ROOT, 'resources', 'icon.png'), png256)
console.log(`resources/icon.png             ${png256.length} B  256×256`)

writeFileSync(join(ROOT, 'build', 'icon-256.png'), png256)
console.log('完成')
