'use strict'
// Registro en %APPDATA%\Hermes Panel\logs\hermes-panel.log (rota a .1 al pasar de 2 MB).
// Nunca recibe contraseñas, cookies ni tickets: quien llama pasa solo datos seguros.
const fs = require('node:fs')
const path = require('node:path')

let file = null
const MAX = 2 * 1024 * 1024

function init(dir) {
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'hermes-panel.log')
  try {
    if (fs.statSync(file).size > MAX) { fs.renameSync(file, file + '.1') }
  } catch {}
}

function line(level, parts) {
  const text = parts.map(p => (typeof p === 'string' ? p : safeJson(p))).join(' ')
  const out = `${new Date().toISOString()} ${level} ${text}\n`
  if (process.env.HERMES_PANEL_DEBUG) { process.stdout.write(out) }
  if (!file) { return }
  try { fs.appendFileSync(file, out) } catch {}
}

function safeJson(v) {
  try { return JSON.stringify(v) } catch { return String(v) }
}

module.exports = {
  init,
  dir: () => (file ? path.dirname(file) : null),
  info: (...p) => line('INFO', p),
  warn: (...p) => line('WARN', p),
  error: (...p) => line('ERROR', p)
}
