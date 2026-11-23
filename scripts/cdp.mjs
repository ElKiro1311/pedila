// Test tool for development (it isn't in the installer): talks to the app opened with PEDILA_CDP=<port>.
// node scripts/cdp.mjs <port> eval "<JS expression>"
// node scripts/cdp.mjs <port> close
// node scripts/cdp.mjs <port> shot <file.png>   (a screenshot of the app's page only)
const [port, cmd, arg] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`

async function rpcOn(wsUrl, method, params) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("can't connect")) })
  const out = await new Promise((res, rej) => {
    ws.onmessage = m => { const f = JSON.parse(m.data); if (f.id === 1) { f.error ? rej(new Error(f.error.message)) : res(f.result) } }
    ws.send(JSON.stringify({ id: 1, method, params }))
  })
  ws.close()
  return out
}

if (cmd === 'close') {
  const v = await (await fetch(base + '/json/version')).json()
  try { await rpcOn(v.webSocketDebuggerUrl, 'Browser.close', {}) } catch {}
  console.log('closed')
} else if (cmd === 'shot') {
  const targets = await (await fetch(base + '/json/list')).json()
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('app://shell'))
  if (!page) { console.log("there's no app://shell page"); process.exit(1) }
  const r = await rpcOn(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(arg, Buffer.from(r.data, 'base64'))
  console.log('screenshot', arg)
} else if (cmd === 'eval') {
  const targets = await (await fetch(base + '/json/list')).json()
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('app://shell'))
  if (!page) { console.log("there's no app://shell page"); process.exit(1) }
  const r = await rpcOn(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) { console.log('EXCEPTION', JSON.stringify(r.exceptionDetails).slice(0, 800)) } else { console.log(JSON.stringify(r.result.value, null, 1)) }
}
process.exit(0)
