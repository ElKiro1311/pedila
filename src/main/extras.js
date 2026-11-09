'use strict'
// Actualizaciones (version.json + instalador en una carpeta web) y estadísticas de uso.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const INSTALADOR = 'HermesPanel-Setup.exe'

function newer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) { return (pa[i] || 0) > (pb[i] || 0) }
  }
  return false
}

async function checkUpdate(url, current) {
  if (!url) { return { available: false, reason: 'sin dirección' } }
  const res = await fetch(`${url}/version.json`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
  if (!res.ok) { throw new Error(`la carpeta de actualizaciones respondió ${res.status}`) }
  const j = await res.json()
  if (!j || typeof j.version !== 'string' || !/^[0-9a-f]{64}$/i.test(String(j.sha256 || ''))) { throw new Error('version.json no válido') }
  return { available: newer(j.version, current), version: j.version, notes: typeof j.notas === 'string' ? j.notas.slice(0, 2000) : '', sha256: j.sha256.toLowerCase() }
}

/** Baja el instalador, comprueba su SHA-256 y lo lanza en silencio; al terminar vuelve a abrir la app. */
async function installUpdate(url, info, log) {
  const res = await fetch(`${url}/${INSTALADOR}`, { signal: AbortSignal.timeout(15 * 60000) })
  if (!res.ok) { throw new Error(`no pude bajar el instalador (${res.status})`) }
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (sha !== info.sha256) { throw new Error('el instalador descargado no coincide con su huella (SHA-256)') }
  const file = path.join(os.tmpdir(), `HermesPanel-Setup-${info.version}.exe`)
  fs.writeFileSync(file, buf)
  log.info(`[actualizar] ${info.version} descargada y comprobada; lanzo el instalador`)
  const child = spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return { ok: true }
}

/** Resumen de uso a partir de las filas de chats (todo local). */
function usageStats(rows, now = Date.now()) {
  const ms = v => { const n = Number(v); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v) || 0 }
  const day = 86400000
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const days = []
  for (let i = 29; i >= 0; i--) { days.push({ date: new Date(start.getTime() - i * day).toISOString().slice(0, 10), chats: 0 }) }
  const models = {}
  let input = 0
  let output = 0
  let messages = 0
  for (const r of rows) {
    const t = ms(r.startedAt || r.lastActive)
    const idx = 29 - Math.floor((start.getTime() - new Date(t).setHours(0, 0, 0, 0)) / day)
    if (idx >= 0 && idx < 30) { days[idx].chats++ }
    const m = r.model || 'desconocido'
    models[m] = models[m] || { chats: 0, input: 0, output: 0 }
    models[m].chats++
    models[m].input += r.inputTokens || 0
    models[m].output += r.outputTokens || 0
    input += r.inputTokens || 0
    output += r.outputTokens || 0
    messages += r.messages || 0
  }
  return {
    chats: rows.length,
    messages,
    input,
    output,
    days,
    models: Object.entries(models).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.chats - a.chats)
  }
}

module.exports = { checkUpdate, installUpdate, usageStats, newer, INSTALADOR }
