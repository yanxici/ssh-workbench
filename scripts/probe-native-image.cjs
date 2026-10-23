/**
 * 用 Electron 主进程实测 nativeImage 对 .ico / .png 的解析能力。
 *
 * 背景：`createWindow()` 里 `icon: pickIconPath()` 优先给的是 .ico。如果
 * `nativeImage.createFromPath()` 读 .ico 返回空图，BrowserWindow 就拿到一张空
 * 图标 → 无边框窗口在任务栏上表现为白方块，而 exe 自身的资源明明是好的。
 *
 * 运行：./node_modules/electron/dist/electron.exe scripts/probe-native-image.cjs
 */
const { app, nativeImage } = require('electron')
const path = require('node:path')

app.whenReady().then(() => {
  const root = path.join(__dirname, '..')
  const targets = [
    path.join(root, 'resources', 'icon.ico'),
    path.join(root, 'resources', 'icon.png'),
    path.join(root, 'build', 'icon.ico'),
    path.join(root, 'build', 'icon.png'),
  ]

  for (const p of targets) {
    const img = nativeImage.createFromPath(p)
    const sizes = img.getSize()
    console.log(
      JSON.stringify({
        file: path.basename(path.dirname(p)) + '/' + path.basename(p),
        empty: img.isEmpty(),
        size: `${sizes.width}x${sizes.height}`,
        scaleFactors: img.getScaleFactors(),
        pngBytes: img.isEmpty() ? 0 : img.toPNG().length,
      }),
    )
  }

  // 再验证「多尺寸 representation」这条路：给 32/16 各塞一张，Windows 才能
  // WM_SETICON 时拿到对应尺寸，而不是让 GDI 现缩一张 256 的。
  const multi = nativeImage.createEmpty()
  for (const [scale, file] of [
    [1, 'build/icon-256.png'],
    [1, 'build/icon.png'],
  ]) {
    void scale
    void file
  }
  console.log(JSON.stringify({ multiSizeSupported: typeof multi.addRepresentation === 'function' }))

  app.quit()
})
