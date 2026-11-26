/*
 * 生成 Portix 应用图标（方案 A：深石墨圆角底 + 翡翠绿端口触点与 `>_` 提示符）：
 *   build/icon.png（1024） / build/icon-256.png / build/icon.ico（多尺寸）
 *   resources/icon.{png,ico}
 *
 * 独立渲染 256 / 128 / 64 / 48 / 32 / 24 / 16 七个尺寸（纯 JS 4×4 超采样，零外部依赖），
 * 避免 Windows GDI 现场缩放 256px 位图导致 16/24/32px 任务栏图标发虚或发白。
 * 运行：node scripts/make-icon.cjs
 */

const { deflateSync } = require('node:zlib')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const MASTER = 1024
const SS = 4
const ROOT = join(__dirname, '..')

/* ---------- 几何 ---------- */

/** 圆角矩形有符号距离（单位坐标 0..1；<= 0 表示在内部） */
function sdRoundedRect(x, y, half, r) {
  const px = Math.abs(x - 0.5) - (half - r)
  const py = Math.abs(y - 0.5) - (half - r)
  const ox = Math.max(px, 0)
  const oy = Math.max(py, 0)
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(px, py), 0) - r
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

function onStroke(x, y, ax, ay, bx, by, w) {
  return distToSegSq(x, y, ax, ay, bx, by) <= (w / 2) * (w / 2)
}

/* 方案 A 几何坐标（对齐 BrandMark.tsx viewBox 48×48）：
 * - 左双端口导轨（垂直圆头胶囊）
 * - 右提示符 `>` 与浅翠信号条 `_`
 */
const RAILS = [
  [0.258, 0.352, 0.258, 0.420],
  [0.258, 0.580, 0.258, 0.648]
]
const CHEVRON = [
  [0.406, 0.323, 0.615, 0.500],
  [0.615, 0.500, 0.406, 0.677]
]
const SIGNAL_BAR = [0.635, 0.677, 0.792, 0.677]

function strokeFor(size) {
  if (size >= 64) return 0.088
  if (size >= 48) return 0.096
  if (size >= 32) return 0.110
  if (size >= 24) return 0.130
  return 0.155
}

function railWidthFor(size) {
  if (size >= 64) return 0.079
  if (size >= 48) return 0.084
  if (size >= 32) return 0.096
  if (size >= 24) return 0.112
  return 0.130
}

function glyphScaleFor(size) {
  if (size >= 32) return 1
  if (size >= 24) return 0.96
  return 0.92
}

function lerp3(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ]
}

const BG_FROM = [25, 33, 42] // #19212A
const BG_TO = [11, 15, 20] // #0B0F14
const RIM_COLOR = [46, 211, 154] // #2ED39A
const EM_FROM = [63, 232, 176] // #3FE8B0
const EM_TO = [14, 165, 113] // #0EA571
const MINT_BAR = [110, 231, 183] // #6EE7B7

/* ---------- 渲染 ---------- */

function render(size) {
  const buf = Buffer.alloc(size * size * 4)
  const inv = 1 / size
  const sub = 1 / SS
  const subArea = 1 / (SS * SS)
  const stroke = strokeFor(size)
  const barStroke = stroke * 0.92
  const railW = railWidthFor(size)
  const gs = glyphScaleFor(size)
  const gx = (v) => 0.5 + (v - 0.5) * gs
  const radius = size >= 32 ? 0.228 : 0.21
  const half = 0.48
  const rimThickness = size >= 64 ? 0.028 : size >= 32 ? 0.038 : 0.052

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCov = 0
      let rimCov = 0
      let railCov = 0
      let chevCov = 0
      let barCov = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) * sub) * inv
          const y = (py + (sy + 0.5) * sub) * inv
          const sd = sdRoundedRect(x, y, half, radius)
          if (sd > 0) continue
          bgCov += 1
          if (sd >= -rimThickness) rimCov += 1

          let hitChev = false
          for (const s of CHEVRON) {
            if (onStroke(x, y, gx(s[0]), gx(s[1]), gx(s[2]), gx(s[3]), stroke)) {
              hitChev = true
              break
            }
          }
          if (hitChev) {
            chevCov += 1
            continue
          }
          if (onStroke(x, y, gx(SIGNAL_BAR[0]), gx(SIGNAL_BAR[1]), gx(SIGNAL_BAR[2]), gx(SIGNAL_BAR[3]), barStroke)) {
            barCov += 1
            continue
          }
          for (const s of RAILS) {
            if (onStroke(x, y, gx(s[0]), gx(s[1]), gx(s[2]), gx(s[3]), railW)) {
              railCov += 1
              break
            }
          }
        }
      }

      const o = (py * size + px) * 4
      if (bgCov === 0) {
        buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0
        continue
      }

      const tBg = Math.min(1, Math.max(0, (px * 0.45 + py * 0.55) / size))
      let [r, g, b] = lerp3(BG_FROM, BG_TO, tBg)

      const rimAlpha = (rimCov / bgCov) * 0.30
      if (rimAlpha > 0) {
        r += (RIM_COLOR[0] - r) * rimAlpha
        g += (RIM_COLOR[1] - g) * rimAlpha
        b += (RIM_COLOR[2] - b) * rimAlpha
      }

      const tEm = Math.min(1, Math.max(0, ((px / size) - 0.25 + (py / size) - 0.25)))
      const em = lerp3(EM_FROM, EM_TO, tEm)

      const railAlpha = (railCov / bgCov) * 0.66
      if (railAlpha > 0) {
        r += (em[0] - r) * railAlpha
        g += (em[1] - g) * railAlpha
        b += (em[2] - b) * railAlpha
      }

      const chevAlpha = chevCov / bgCov
      if (chevAlpha > 0) {
        r += (em[0] - r) * chevAlpha
        g += (em[1] - g) * chevAlpha
        b += (em[2] - b) * chevAlpha
      }

      const barAlpha = barCov / bgCov
      if (barAlpha > 0) {
        r += (MINT_BAR[0] - r) * barAlpha
        g += (MINT_BAR[1] - g) * barAlpha
        b += (MINT_BAR[2] - b) * barAlpha
      }

      buf[o] = Math.round(Math.min(255, Math.max(0, r)))
      buf[o + 1] = Math.round(Math.min(255, Math.max(0, g)))
      buf[o + 2] = Math.round(Math.min(255, Math.max(0, b)))
      buf[o + 3] = Math.round(255 * (bgCov * subArea))
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
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
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

function icoBmpEntry(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4, 20)

  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4
      const d = (y * size + x) * 4
      xor[d] = rgba[s + 2]
      xor[d + 1] = rgba[s + 1]
      xor[d + 2] = rgba[s]
      xor[d + 3] = rgba[s + 3]
    }
  }

  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      if (rgba[srcRow + x * 4 + 3] === 0) {
        mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  return Buffer.concat([header, xor, mask])
}

function buildIco(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)

  let offset = dir.length
  const blobs = []
  entries.forEach((e, i) => {
    const o = 6 + i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(e.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.data.length
    blobs.push(e.data)
  })

  return Buffer.concat([dir, ...blobs])
}

/* ---------- 落盘 ---------- */

console.log(`渲染 Portix 主图 ${MASTER}×${MASTER}（${SS}×${SS} 超采样）…`)
const master = render(MASTER)

mkdirSync(join(ROOT, 'build'), { recursive: true })
mkdirSync(join(ROOT, 'resources'), { recursive: true })

const png1024 = encodePng(master, MASTER)
writeFileSync(join(ROOT, 'build', 'icon.png'), png1024)
console.log(`build/icon.png                 ${png1024.length} B  ${MASTER}×${MASTER}`)

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

const png256 = encodePng(render(256), 256)
writeFileSync(join(ROOT, 'resources', 'icon.png'), png256)
console.log(`resources/icon.png             ${png256.length} B  256×256`)

writeFileSync(join(ROOT, 'build', 'icon-256.png'), png256)
console.log('完成')
