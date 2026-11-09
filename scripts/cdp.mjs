// Herramienta de pruebas en desarrollo (no va en el instalable): habla con la app abierta con
// HERMES_PANEL_CDP=<puerto>.
//   node scripts/cdp.mjs <puerto> eval "<expresión JS>"
//   node scripts/cdp.mjs <puerto> close
const [port, cmd, arg] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`

async function rpcOn(wsUrl, method, params) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no conecta')) })
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
  console.log('cerrada')
} else if (cmd === 'eval') {
  const targets = await (await fetch(base + '/json/list')).json()
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('app://shell'))
  if (!page) { console.log('no hay página app://shell'); process.exit(1) }
  const r = await rpcOn(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) { console.log('EXCEPCIÓN', JSON.stringify(r.exceptionDetails).slice(0, 800)) } else { console.log(JSON.stringify(r.result.value, null, 1)) }
}
process.exit(0)
