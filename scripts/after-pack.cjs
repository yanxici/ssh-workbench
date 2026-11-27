const fs = require('node:fs')
const path = require('node:path')

/**
 * 打包瘦身钩子：移除无关多语言 pak、跨平台原生预编译以及 dxcompiler.dll。
 */
module.exports = async function afterPack(context) {
  const outDir = context.appOutDir
  let saved = 0

  // 1. Chromium 语言包仅保留 zh-CN 与 en-US（约省 ~46 MB 解压体积）
  const localesDir = path.join(outDir, 'locales')
  if (fs.existsSync(localesDir)) {
    const keep = new Set(['zh-CN.pak', 'en-US.pak'])
    for (const f of fs.readdirSync(localesDir)) {
      if (!keep.has(f)) {
        const p = path.join(localesDir, f)
        const st = fs.statSync(p)
        fs.rmSync(p, { force: true })
        saved += st.size
      }
    }
  }

  // 2. Windows 平台专项瘦身
  if (context.electronPlatformName === 'win32') {
    const prebuildsDir = path.join(
      outDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      '@serialport',
      'bindings-cpp',
      'prebuilds'
    )
    if (fs.existsSync(prebuildsDir)) {
      // electron-builder Arch enum: 1=x64, 3=arm64
      const wantDir = context.arch === 3 ? 'win32-arm64' : 'win32-x64'
      for (const d of fs.readdirSync(prebuildsDir)) {
        if (d !== wantDir) {
          const p = path.join(prebuildsDir, d)
          const walkSize = (dir) =>
            fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, ent) => {
              const fp = path.join(dir, ent.name)
              return acc + (ent.isDirectory() ? walkSize(fp) : fs.statSync(fp).size)
            }, 0)
          saved += walkSize(p)
          fs.rmSync(p, { recursive: true, force: true })
        }
      }
    }

    const dxCompiler = path.join(outDir, 'dxcompiler.dll')
    if (fs.existsSync(dxCompiler)) {
      saved += fs.statSync(dxCompiler).size
      fs.rmSync(dxCompiler, { force: true })
    }
  }

  console.log(`[afterPack] trimmed ${(saved / 1048576).toFixed(2)} MB from ${outDir}`)
}
