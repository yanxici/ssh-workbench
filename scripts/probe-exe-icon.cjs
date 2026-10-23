/**
 * 解析 exe 的 PE 资源段，打印 RT_GROUP_ICON 里的全部尺寸条目。
 *
 * 为什么需要这个脚本：任务栏图标只取 16/24/32px。如果 exe 的资源里只有一条
 * 256x256，Windows 就只能现场用 GDI 缩，白边会把绿色糊掉 —— 表现为「图标是绿的，
 * 但任务栏上是白方块」。`extract-icon` / `System.Drawing.Icon` 这类 API 会「挑最接近
 * 的尺寸再缩放」，看不出这个毛病，必须直接读 PE 目录。
 *
 * 用法：node scripts/probe-exe-icon.cjs "path/to/app.exe"
 */
const fs = require('node:fs')

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('用法: node scripts/probe-exe-icon.cjs "path/to/app.exe"')
    process.exit(1)
  }
  const b = fs.readFileSync(target)
  const pe = b.readUInt32LE(0x3c)
  if (b.readUInt32LE(pe) !== 0x00004550) {
    console.error('不是有效的 PE 文件')
    process.exit(1)
  }
  const numSec = b.readUInt16LE(pe + 6)
  const optSize = b.readUInt16LE(pe + 20)
  const secTab = pe + 24 + optSize

  let rsrc = null
  for (let i = 0; i < numSec; i++) {
    const o = secTab + i * 40
    const name = b.toString('ascii', o, o + 8).replace(/\0/g, '')
    if (name === '.rsrc') {
      rsrc = {
        va: b.readUInt32LE(o + 12),
        size: b.readUInt32LE(o + 16),
        raw: b.readUInt32LE(o + 20),
      }
    }
  }
  if (!rsrc) {
    console.error('没有 .rsrc 段')
    process.exit(1)
  }

  const groups = []
  const icons = []

  function walk(dirOff, level, path) {
    const named = b.readUInt16LE(dirOff + 12)
    const ids = b.readUInt16LE(dirOff + 14)
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8
      const nameRaw = b.readUInt32LE(e)
      const offRaw = b.readUInt32LE(e + 4)
      const id = nameRaw & 0x80000000 ? `name:${nameRaw & 0x7fffffff}` : nameRaw
      const nextPath = path.concat(id)
      if (offRaw & 0x80000000) {
        walk(rsrc.raw + (offRaw & 0x7fffffff), level + 1, nextPath)
        continue
      }
      const d = rsrc.raw + offRaw
      const dataRva = b.readUInt32LE(d)
      const dataSize = b.readUInt32LE(d + 4)
      const fileOff = rsrc.raw + (dataRva - rsrc.va)
      const type = nextPath[0]
      if (type === 3) icons.push({ size: dataSize, fileOff })
      if (type === 14) {
        const cnt = b.readUInt16LE(fileOff + 4)
        const entries = []
        for (let k = 0; k < cnt; k++) {
          const p = fileOff + 6 + k * 14
          const w = b[p] === 0 ? 256 : b[p]
          const h = b[p + 1] === 0 ? 256 : b[p + 1]
          entries.push({
            w,
            h,
            bitCount: b.readUInt16LE(p + 6),
            bytes: b.readUInt32LE(p + 8),
          })
        }
        groups.push(entries)
      }
    }
  }
  walk(rsrc.raw, 0, [])

  console.log(`文件: ${target}`)
  console.log(`大小: ${b.length} B`)
  console.log(`RT_ICON 条目: ${icons.length}`)
  for (const [i, entries] of groups.entries()) {
    console.log(
      `RT_GROUP_ICON[${i}] 共 ${entries.length} 档: ` +
        entries.map((e) => `${e.w}x${e.h}/${e.bitCount}`).join('  '),
    )
    const need = [16, 24, 32]
    const have = entries.map((e) => e.w)
    const missing = need.filter((n) => !have.includes(n))
    console.log(
      missing.length === 0
        ? '  任务栏所需尺寸齐备 (16/24/32)'
        : `  缺少任务栏尺寸: ${missing.join(', ')}  <-- 任务栏会发白`,
    )
  }
}

main()
