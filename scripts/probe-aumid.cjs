/**
 * Isolate why the taskbar shows a white placeholder.
 *
 * Hypothesis: the app calls app.setAppUserModelId('com.sshworkbench.app').
 * When a window carries an explicit AppUserModelID, the Win10/11 taskbar
 * resolves the button icon through "AUMID -> shortcut in Start Menu", NOT
 * through WM_GETICON or the exe resource. If no shortcut carries that AUMID,
 * the shell falls back to a blank "document" placeholder.
 *
 * Run both variants and compare the taskbar pixels:
 *   electron scripts/probe-aumid.cjs              (AUMID set, no shortcut)
 *   electron scripts/probe-aumid.cjs --no-aumid   (no AUMID -> exe/window icon)
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const noAumid = process.argv.includes('--no-aumid')
const aumid = 'com.sshworkbench.probe.' + (noAumid ? 'off' : 'on')
const holdMs = Number((process.argv.find((a) => a.startsWith('--hold=')) || '').slice(7)) || 25000

if (!noAumid) app.setAppUserModelId(aumid)

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 520,
    height: 320,
    frame: false,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, '..', 'resources', 'icon.ico'),
    title: noAumid ? 'AUMID Probe OFF' : 'AUMID Probe ON',
    webPreferences: { sandbox: true },
  })
  win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        `<body style="font:13px sans-serif;padding:24px">
           <h3>${noAumid ? 'no setAppUserModelId' : 'setAppUserModelId: ' + aumid}</h3>
           <p>Look at the taskbar button for this window.</p>
         </body>`,
      ),
  )
  win.once('ready-to-show', () => win.show())
  console.log(JSON.stringify({ variant: noAumid ? 'no-aumid' : 'aumid', aumid: noAumid ? null : aumid }))
  // Keep the window alive so there is time to sample the taskbar.
  setTimeout(() => app.quit(), holdMs)
})
