'use strict'
// Actualizaciones (GitHub Releases o una carpeta web con version.json + instalador) y estadísticas de uso.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const INSTALADOR = 'Pedila-Setup.exe'

/**
 * ¿`a` es más nueva que `b`? Como Semantic Versioning (semver.org, §11): primero x.y.z; con el
 * mismo número, la estable gana a su -alfa/-beta (0.8.0 > 0.8.0-beta). Los sufijos se comparan
 * campo a campo (separados por «.»): los numéricos como números (beta.10 > beta.9) y por debajo de
 * los de texto, y el texto en orden ASCII (beta > alfa); con todo igual, gana el que tiene más
 * campos. Lo que va tras «+» (datos de compilación) no cuenta. Todo lo que siga a los números es
 * sufijo, con o sin guion: una errata en version.json («0.8.0beta», «0.8.0 beta») sigue siendo esa
 * beta y no la 0.8.0 final, que se ofrecería después de cada instalación.
 */
function newer(a, b) {
  const parse = v => {
    const s = String(v).trim().replace(/^v/i, '').split('+')[0]
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s)
    const pre = (m ? m[2] : s).replace(/^[^0-9A-Za-z]/, '')
    return { nums: (m ? m[1] : '0').split('.').map(Number), pre: pre.split('.').filter(Boolean) }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    if ((pa.nums[i] || 0) !== (pb.nums[i] || 0)) { return (pa.nums[i] || 0) > (pb.nums[i] || 0) }
  }
  if (!pa.pre.length || !pb.pre.length) { return !pa.pre.length && pb.pre.length > 0 }
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined || y === undefined) { return y === undefined }
    if (x === y) { continue }
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { return Number(x) > Number(y) }
    if (nx !== ny) { return ny }
    return x > y
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

/**
 * El .cmd que instala la versión nueva y vuelve a abrir Pedila: el instalador en silencio (cmd espera
 * a que acabe) y después la app con `args` (['--oculto'] = sigue en la bandeja; ['--sin-foco'] = se
 * ve, pero sin quitar el foco). Las rutas NO van dentro: cmd lee el .cmd con la página de códigos
 * del sistema y rompería una ruta con tildes o «ñ» (C:\Users\José\…). Llegan en las variables de
 * entorno PEDILA_SETUP y PEDILA_EXE, que cmd recibe tal cual. Pura.
 */
function relaunchScript(args = []) {
  const extra = args.filter(a => /^--[a-z-]+$/.test(a))
  return ['@echo off', '"%PEDILA_SETUP%" /S', `start "" "%PEDILA_EXE%"${extra.length ? ' ' + extra.join(' ') : ''}`, ''].join('\r\n')
}

/** Baja el instalador de la versión nueva y comprueba su SHA-256. → ruta del instalador comprobado. */
async function downloadUpdate(info, log) {
  const res = await fetch(info.download, { headers: { 'User-Agent': 'pedila-updater' }, signal: AbortSignal.timeout(15 * 60000) })
  if (!res.ok) { throw new Error(`no pude bajar el instalador (${res.status})`) }
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (sha !== info.sha256) { throw new Error('el instalador descargado no coincide con su huella (SHA-256)') }
  const file = path.join(os.tmpdir(), `Pedila-Setup-${info.version}.exe`)
  fs.writeFileSync(file, buf)
  log.info(`[actualizar] ${info.version} descargada y comprobada`)
  return file
}

/** ¿Sigue ahí el instalador ya comprobado y no lo ha cambiado nadie? */
function verifiedFile(file, sha256) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256 } catch { return false }
}

/**
 * Lanza en silencio el instalador ya comprobado y, al acabar, vuelve a abrir la app (`exe`, con
 * `args`). Sin `exe` (en desarrollo) solo instala.
 */
function launchInstaller(file, log, { exe = '', args = [] } = {}) {
  log.info(`[actualizar] lanzo el instalador${args.length ? ` (al volver: ${args.join(' ')})` : ''}`)
  let child
  if (exe) {
    const script = path.join(os.tmpdir(), 'pedila-actualizar.cmd')
    fs.writeFileSync(script, relaunchScript(args))
    // /s y las comillas dobles: así cmd acepta una ruta con espacios.
    child = spawn('cmd.exe', ['/d', '/s', '/c', `""${script}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, PEDILA_SETUP: file, PEDILA_EXE: exe } })
  } else {
    child = spawn(file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
  }
  child.unref()
  return { ok: true }
}

/** Baja, comprueba y lanza (el botón «Actualizar y reiniciar»). */
async function installUpdate(info, log, opts = {}) {
  const file = await downloadUpdate(info, log)
  return launchInstaller(file, log, opts)
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
  // Un Map y no un objeto: un modelo llamado «constructor» o «__proto__» no debe chocar con Object.
  const models = new Map()
  let input = 0
  let output = 0
  let messages = 0
  // La última tarea: el chat con la actividad más reciente (Hermes la da por su último mensaje, o
  // por el latido que deja mientras trabaja), venga de Pedila, de Hermes Desktop o de otro sitio.
  let last = null
  for (const r of rows) {
    const la = ms(r.lastActive || r.startedAt)
    if (la > 0 && (!last || la > last.at)) { last = { at: la, id: r.id || null, title: r.title || '' } }
    const t = ms(r.startedAt || r.lastActive)
    const idx = 29 - Math.floor((start.getTime() - new Date(t).setHours(0, 0, 0, 0)) / day)
    if (idx >= 0 && idx < 30) {
      days[idx].chats++
      days[idx].messages += r.messages || 0
      days[idx].input += r.inputTokens || 0
      days[idx].output += r.outputTokens || 0
    }
    const m = modelId(r.model)
    const e = models.get(m) || { model: m, input: 0, output: 0, tasks: [] }
    e.input += r.inputTokens || 0
    e.output += r.outputTokens || 0
    models.set(m, e)
    input += r.inputTokens || 0
    output += r.outputTokens || 0
    messages += r.messages || 0
  }
  // Con el reloj de Hermes adelantado, la última actividad sería del futuro: como mucho, ahora.
  if (last && last.at > now) { last.at = now }
  // Hoy y los últimos 7 días (cada chat cuenta en el día en que empezó).
  const sum = list => list.reduce((a, d) => ({ chats: a.chats + d.chats, messages: a.messages + d.messages, input: a.input + d.input, output: a.output + d.output }), { chats: 0, messages: 0, input: 0, output: 0 })
  return {
    today: sum(days.slice(-1)),
    week: sum(days.slice(-7)),
    chats: rows.length,
    messages,
    input,
    output,
    last,
    days,
    // Los modelos, de más a menos tokens (leídos + escritos), sumando los chats de la lista. El
    // panel prefiere los de las estadísticas de Hermes (modelUsageFrom), que cuentan más cosas.
    models: [...models.values()].sort(byTokens)
  }
}

const tokens = m => m.input + m.output
const byTokens = (a, b) => tokens(b) - tokens(a) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
const modelId = v => {
  const s = typeof v === 'string' ? v.trim().slice(0, 200) : ''
  return s && s !== 'unknown' ? s : 'desconocido'
}

/**
 * Los modelos de las estadísticas del propio Hermes (`by_model` de GET /api/analytics/usage, lo que
 * enseña la página de uso de Hermes Desktop) en la forma del panel: { model, input, output, tasks },
 * de más a menos tokens. Hermes suma ahí todos sus chats (también los de subagentes y herramientas)
 * y lo que gastan sus tareas auxiliares (resumir la memoria, poner títulos, ver imágenes…), que
 * viene en `aux_tasks` y ya está dentro de los totales; `tasks` lo desglosa por tarea. null si la
 * respuesta no trae la lista.
 */
function modelUsageFrom(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.by_model)) { return null }
  const n = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0 }
  const out = new Map()
  for (const r of j.by_model) {
    if (!r || typeof r !== 'object') { continue }
    const id = modelId(r.model)
    const m = out.get(id) || { model: id, input: 0, output: 0, tasks: [] }
    m.input += n(r.input_tokens)
    m.output += n(r.output_tokens)
    for (const t of Array.isArray(r.aux_tasks) ? r.aux_tasks : []) {
      const used = n(t && t.input_tokens) + n(t && t.output_tokens)
      const task = t && typeof t.task === 'string' && t.task.trim() ? t.task.trim().slice(0, 60) : 'other'
      if (!used) { continue }
      const same = m.tasks.find(x => x.task === task)
      if (same) { same.tokens += used } else { m.tasks.push({ task, tokens: used }) }
    }
    out.set(id, m)
  }
  for (const m of out.values()) { m.tasks.sort((a, b) => b.tokens - a.tokens) }
  return [...out.values()].sort(byTokens).slice(0, 200)
}

module.exports = { checkUpdate, installUpdate, downloadUpdate, launchInstaller, verifiedFile, relaunchScript, usageStats, modelUsageFrom, newer, INSTALADOR }
