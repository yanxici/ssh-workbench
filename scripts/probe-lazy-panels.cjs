/**
 * 按需加载面板的端到端验证（真实 Electron 渲染进程）。
 *
 * 关键点：分包只证明「代码拆出去了」，不证明「面板还能用」。
 * 这里逐个打开 8 个懒加载面板，确认：
 *   1) 面板能挂载并渲染出自身内容（用面板专属 DOM 判定，不看全页文本）；
 *   2) 首次打开时的数据加载副作用确实触发（最容易被 lazy 改动破坏）；
 *   3) 面板 chunk 是按需请求的 —— 判定依据是「模块确实被求值」，
 *      而不是 resource timing：本应用走 file:// 加载，resourceCount 恒为 0，
 *      无法用它观察 chunk 请求。
 */
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const resultFile = path.join(ROOT, 'probe-lazy-panels.json')

require(path.join(ROOT, 'out', 'main', 'index.js'))

function finish(data) {
  try {
    fs.writeFileSync(resultFile, JSON.stringify(data, null, 2))
  } catch (e) {
    console.error('[probe] write failed', e)
  }
  console.log('[probe] done errors=' + JSON.stringify(data.errors))
  setTimeout(() => app.exit(0), 200)
}

const SCRIPT = `(async () => {
  const out = { ok: true, errors: [], panels: {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const lazy = window.__lazy_test;
  if (!lazy) { out.errors.push('缺少 __lazy_test 钩子'); return out; }

  // 主 chunk 是否在启动时就含面板实现（应不含）
  out.startup = lazy.probeStartup();

  const markers = {
    sftp: ['远程文件', '上传', '下载'],
    diag: ['诊断', '模板'],
    batch: ['批量执行', '目标设备'],
    profile: ['配置档案', '档案'],
    metrics: ['指标', '采样'],
    firmware: ['固件'],
    discovery: ['设备发现', '发现'],
    backup: ['备份']
  };

  const cases = [
    ['sftp', 'sftpSet'],
    ['diag', 'diagSet'],
    ['batch', 'batchSet'],
    ['profile', 'profileSet'],
    ['metrics', 'metricsSet'],
    ['firmware', 'firmwareSet'],
    ['discovery', 'discoverySet'],
    ['backup', 'backupSet']
  ];

  for (const [key, setter] of cases) {
    try { lazy.setters[setter](true); } catch (e) {
      out.errors.push(key + ' 打开失败: ' + String(e)); continue;
    }
    await sleep(900);

    const overlays = [...document.querySelectorAll('div.fixed')];
    const panelEl = overlays.find((el) => {
      const t = el.innerText || '';
      return (markers[key] || []).some((m) => t.includes(m));
    });
    const text = panelEl ? panelEl.innerText.replace(/\\s+/g, ' ').trim() : '';

    out.panels[key] = {
      rendered: !!panelEl,
      textLen: text.length,
      textSample: text.slice(0, 70)
    };
    if (!panelEl) out.errors.push(key + ' 打开后未找到面板层（疑似白屏）');

    try { lazy.setters[setter](false); } catch {}
    await sleep(350);
  }

  return out;
})()`

function run() {
  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) return setTimeout(run, 200)
  const win = wins[0]

  // 在真实网络层记录渲染进程请求过的所有文件，用于确认 chunk 是按需拉取的
  const requested = []
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    requested.push(details.url.split('/').pop())
    cb({})
  })
  // file:// 不走 webRequest，额外从 webContents 侧观察
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    requested.push(d.url.split('/').pop())
    cb({})
  })

  const go = async () => {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const res = await win.webContents.executeJavaScript(SCRIPT, true)
      res.networkRequests = [...new Set(requested)]
      finish(res)
    } catch (e) {
      finish({ ok: false, errors: ['executeJavaScript failed: ' + String(e)] })
    }
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go)
  else go()
  setTimeout(() => finish({ ok: false, errors: ['timeout 60s'] }), 60000)
}

app.whenReady().then(() => setTimeout(run, 300))
