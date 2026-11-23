'use strict'
// Log in %APPDATA%\Pedila\logs\pedila.log (rotates to .1 when it goes over 2 MB).
// It never gets passwords, cookies or tickets: whoever calls passes only safe data.
const fs = require('node:fs')
const path = require('node:path')

let file = null
const MAX = 2 * 1024 * 1024

function init(dir) {
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'pedila.log')
  try {
    if (fs.statSync(file).size > MAX) { fs.renameSync(file, file + '.1') }
  } catch {}
}

function line(level, parts) {
  const text = parts.map(p => (typeof p === 'string' ? p : safeJson(p))).join(' ')
  const out = `${new Date().toISOString()} ${level} ${text}\n`
  if (process.env.PEDILA_DEBUG) { process.stdout.write(out) }
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
