const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const aumid = process.argv.find((a) => a.startsWith('--aumid='))?.slice(8) || 'com.sshworkbench.app'
app.setAppUserModelId(aumid)
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 480, height: 300, frame: false, backgroundColor: '#ffffff',
    icon: path.join(__dirname, '..', 'resources', 'icon.ico'),
    title: 'Aumid ' + aumid,
    webPreferences: { sandbox: true },
  })
  win.loadURL('data:text/html,<body style="font:14px sans-serif;padding:28px">aumid=' + encodeURIComponent(aumid) + '</body>')
  win.once('ready-to-show', () => win.show())
  console.log('aumid=' + aumid)
  setTimeout(() => app.quit(), 60000)
})
