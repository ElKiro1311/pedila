'use strict'
// Updates (GitHub Releases or a web folder with version.json + installer) and usage statistics.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { tr, getLang } = require('./i18n')

const INSTALLER = 'Pedila-Setup.exe'

/**
 * Is `a` newer than `b`? As in Semantic Versioning (semver.org, §11): first x.y.z; with the same number, the
 * stable one beats its -alpha/-beta (0.8.0 > 0.8.0-beta). Suffixes are compared field by field (separated by
 * "."): numeric ones as numbers (beta.10 > beta.9) and below the text ones, and text in ASCII order (beta >
 * alpha); with everything equal, the one with more fields wins. What comes after "+" (build data) doesn't
 * count. Everything that follows the numbers is a suffix, with or without a hyphen: a typo in version.json
 * ("0.8.0beta", "0.8.0 beta") is still that beta and not the final 0.8.0, which would be offered after every
 * installation.
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
  if (!j || typeof j.version !== 'string' || !/^[0-9a-f]{64}$/i.test(String(j.sha256 || ''))) { throw new Error(tr('invalid version.json')) }
  // The notes, in both languages: `notes` in English and `notas` in Spanish (the only one versions before 0.16 read).
  const notes = [getLang() === 'es' ? j.notas : j.notes, j.notes, j.notas].find(n => typeof n === 'string' && n) || ''
  return { version: j.version, notes: notes.slice(0, 2000), sha256: j.sha256.toLowerCase() }
}

/**
 * Looks for a new version. With `url` it uses that folder (version.json + Pedila-Setup.exe); without it, the
 * latest version published in the repository's GitHub Releases (`owner/repo`).
 */
async function checkUpdate(url, current, repo) {
  if (url) {
    const res = await fetch(`${url}/version.json`, { signal: AbortSignal.timeout(10000), cache: 'no-store' })
    if (!res.ok) { throw new Error(tr('the updates folder answered {0}', res.status)) }
    const m = parseManifest(await res.json())
    return { ...m, available: newer(m.version, current), download: `${url}/${INSTALLER}` }
  }
  if (!repo) { return { available: false, reason: 'no source' } }
  const rel = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: UA, signal: AbortSignal.timeout(15000) })
  if (rel.status === 404) { return { available: false, reason: 'no published versions' } }
  if (!rel.ok) { throw new Error(tr('GitHub answered {0}', rel.status)) }
  const r = await rel.json()
  const assets = Array.isArray(r.assets) ? r.assets : []
  const man = assets.find(a => a.name === 'version.json')
  const exe = assets.find(a => a.name === INSTALLER)
  if (!man || !exe) { return { available: false, reason: tr("the published version doesn't have version.json and the installer") } }
  const mres = await fetch(man.browser_download_url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: AbortSignal.timeout(15000) })
  if (!mres.ok) { throw new Error(tr("couldn't read version.json ({0})", mres.status)) }
  const m = parseManifest(await mres.json())
  return { ...m, available: newer(m.version, current), download: exe.browser_download_url }
}

/**
 * The .cmd that installs the new version and opens Pedila again: the installer silently (cmd waits for it to
 * end) and then the app with `args` (['--oculto'] = stays in the tray; ['--sin-foco'] = shows, but without
 * taking the focus). The paths do NOT go inside: cmd reads the .cmd with the system's code page and would
 * break a path with accents or "ñ" (C:\Users\José\…). They arrive in the PEDILA_SETUP and PEDILA_EXE
 * environment variables, which cmd gets as they are. Pure.
 */
function relaunchScript(args = []) {
  const extra = args.filter(a => /^--[a-z-]+$/.test(a))
  return ['@echo off', '"%PEDILA_SETUP%" /S', `start "" "%PEDILA_EXE%"${extra.length ? ' ' + extra.join(' ') : ''}`, ''].join('\r\n')
}

/** Downloads the new version's installer and checks its SHA-256. → path of the checked installer. */
async function downloadUpdate(info, log) {
  const res = await fetch(info.download, { headers: { 'User-Agent': 'pedila-updater' }, signal: AbortSignal.timeout(15 * 60000) })
  if (!res.ok) { throw new Error(tr("couldn't download the installer ({0})", res.status)) }
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (sha !== info.sha256) { throw new Error(tr("the downloaded installer doesn't match its checksum (SHA-256)")) }
  const file = path.join(os.tmpdir(), `Pedila-Setup-${info.version}.exe`)
  fs.writeFileSync(file, buf)
  log.info(`[update] ${info.version} downloaded and checked`)
  return file
}

/** Is the installer that was already checked still there, with nobody having changed it? */
function verifiedFile(file, sha256) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256 } catch { return false }
}

/**
 * Silently launches the installer that was already checked and, when it ends, opens the app again (`exe`,
 * with `args`). Without `exe` (in development) it only installs.
 */
function launchInstaller(file, log, { exe = '', args = [] } = {}) {
  log.info(`[update] launching the installer${args.length ? ` (on coming back: ${args.join(' ')})` : ''}`)
  let child
  if (exe) {
    const script = path.join(os.tmpdir(), 'pedila-update.cmd')
    fs.writeFileSync(script, relaunchScript(args))
    // /s and the double quotes: that way cmd takes a path with spaces.
    child = spawn('cmd.exe', ['/d', '/s', '/c', `""${script}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, PEDILA_SETUP: file, PEDILA_EXE: exe } })
  } else {
    child = spawn(file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
  }
  child.unref()
  return { ok: true }
}

/** Downloads, checks and launches (the "Update and restart" button). */
async function installUpdate(info, log, opts = {}) {
  const file = await downloadUpdate(info, log)
  return launchInstaller(file, log, opts)
}

/** Usage summary from the chat rows (all local). */
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
  // A Map and not an object: a model called "constructor" or "__proto__" must not clash with Object.
  const models = new Map()
  let input = 0
  let output = 0
  let messages = 0
  // The last task: the chat with the most recent activity (Hermes gives it by its last message, or by the
  // heartbeat it leaves while working), whether it comes from Pedila, Hermes Desktop or elsewhere.
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
  // With Hermes's clock ahead, the last activity would be in the future: now, at most.
  if (last && last.at > now) { last.at = now }
  // Today and the last 7 days (each chat counts on the day it started).
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
    // The models, from most to fewest tokens (read + written), adding up the list's chats. The panel
    // prefers the ones from Hermes's statistics (modelUsageFrom), which count more things.
    models: [...models.values()].sort(byTokens)
  }
}

const tokens = m => m.input + m.output
const byTokens = (a, b) => tokens(b) - tokens(a) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
const modelId = v => {
  const s = typeof v === 'string' ? v.trim().slice(0, 200) : ''
  return s && s !== 'unknown' ? s : tr('unknown')
}

/**
 * The models of Hermes's own statistics (`by_model` in GET /api/analytics/usage, what Hermes Desktop's usage
 * page shows) in the panel's shape: { model, input, output, tasks }, from most to fewest tokens. There
 * Hermes adds up all its chats (subagents' and tools' too) and what its auxiliary tasks spend (summarizing
 * memory, writing titles, looking at images…), which comes in `aux_tasks` and is already inside the totals;
 * `tasks` breaks it down by task. null if the answer doesn't bring the list.
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

module.exports = { checkUpdate, installUpdate, downloadUpdate, launchInstaller, verifiedFile, relaunchScript, usageStats, modelUsageFrom, newer, INSTALLER }
