'use strict'
// Actualizaciones (GitHub Releases o una carpeta web con version.json + instalador) y estadísticas de uso.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const INSTALADOR = 'Pedila-Setup.exe'

function newer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) { return (pa[i] || 0) > (pb[i] || 0) }
  }
  return false
}

const UA = { 'User-Agent': 'pedila-updater', Accept: 'application/vnd.github+json' }

function parseManifest(j) {
  if (!j || typeof j.version !== 'string' || !/^[0-9a-f]{64}$/i.test(String(j.sha256 || ''))) { throw new Error('version.json no válido') }
  return { version: j.version, notes: typeof j.notas === 'string' ? j.notas.slice(0, 2000) : '', sha256: j.sha256.toLowerCase() }
}

/**
 * Busca versión nueva. Con `url` usa esa carpeta (version.json + Pedila-Setup.exe); sin ella, la
 * última versión publicada en GitHub Releases del repositorio (`owner/repo`).
 */
async function checkUpdate(url, current, repo) {
  if (url) {
    const res = await fetch(`${url}/version.json`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
    if (!res.ok) { throw new Error(`la carpeta de actualizaciones respondió ${res.status}`) }
    const m = parseManifest(await res.json())
    return { ...m, available: newer(m.version, current), download: `${url}/${INSTALADOR}` }
  }
  if (!repo) { return { available: false, reason: 'sin origen' } }
  const rel = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: UA, signal: AbortSignal.timeout(15000) })
  if (rel.status === 404) { return { available: false, reason: 'sin versiones publicadas' } }
  if (!rel.ok) { throw new Error(`GitHub respondió ${rel.status}`) }
  const r = await rel.json()
  const assets = Array.isArray(r.assets) ? r.assets : []
  const man = assets.find(a => a.name === 'version.json')
  const exe = assets.find(a => a.name === INSTALADOR)
  if (!man || !exe) { return { available: false, reason: 'la versión publicada no trae version.json e instalador' } }
  const mres = await fetch(man.browser_download_url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: AbortSignal.timeout(15000) })
  if (!mres.ok) { throw new Error(`no pude leer version.json (${mres.status})`) }
  const m = parseManifest(await mres.json())
  return { ...m, available: newer(m.version, current), download: exe.browser_download_url }
}

/** Baja el instalador, comprueba su SHA-256 y lo lanza en silencio; al terminar vuelve a abrir la app. */
async function installUpdate(info, log) {
  const res = await fetch(info.download, { headers: { 'User-Agent': 'pedila-updater' }, signal: AbortSignal.timeout(15 * 60000) })
  if (!res.ok) { throw new Error(`no pude bajar el instalador (${res.status})`) }
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (sha !== info.sha256) { throw new Error('el instalador descargado no coincide con su huella (SHA-256)') }
  const file = path.join(os.tmpdir(), `Pedila-Setup-${info.version}.exe`)
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
  for (let i = 29; i >= 0; i--) {
    const d = new Date(start.getTime() - i * day)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    days.push({ date, chats: 0, messages: 0, input: 0, output: 0 })
  }
  const models = {}
  let input = 0
  let output = 0
  let messages = 0
  for (const r of rows) {
    const t = ms(r.startedAt || r.lastActive)
    const idx = 29 - Math.floor((start.getTime() - new Date(t).setHours(0, 0, 0, 0)) / day)
    if (idx >= 0 && idx < 30) {
      days[idx].chats++
      days[idx].messages += r.messages || 0
      days[idx].input += r.inputTokens || 0
      days[idx].output += r.outputTokens || 0
    }
    const m = r.model || 'desconocido'
    models[m] = models[m] || { chats: 0, input: 0, output: 0 }
    models[m].chats++
    models[m].input += r.inputTokens || 0
    models[m].output += r.outputTokens || 0
    input += r.inputTokens || 0
    output += r.outputTokens || 0
    messages += r.messages || 0
  }
  // Hoy y los últimos 7 días (cada chat cuenta en el día en que empezó).
  const sum = list => list.reduce((a, d) => ({ chats: a.chats + d.chats, messages: a.messages + d.messages, input: a.input + d.input, output: a.output + d.output }), { chats: 0, messages: 0, input: 0, output: 0 })
  return {
    today: sum(days.slice(-1)),
    week: sum(days.slice(-7)),
    chats: rows.length,
    messages,
    input,
    output,
    days,
    models: Object.entries(models).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.chats - a.chats)
  }
}

module.exports = { checkUpdate, installUpdate, usageStats, newer, INSTALADOR }
