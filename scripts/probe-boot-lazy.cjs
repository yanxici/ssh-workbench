setTimeout(() => { try { require(__dirname + '/probe-lazy-panels.cjs') } catch (e) { console.error('[probe] load failed', String(e)) } }, 3000)
