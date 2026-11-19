'use strict'
// Versiones de Hermes (el de este PC y el del servidor): si hay una nueva y, cuando Hermes sabe
// actualizarse solo (instalación git, la del instalador oficial), instalarla cuando lleve 10 minutos
// sin usarse. Un Hermes en Docker (un servidor) lo actualiza su propio servidor: aquí solo se avisa.
//
// «Sin usarse» = /api/status sin turnos en marcha (active_agents 0, gateway_busy falso) en todas las
// miradas de los últimos 10 min y ningún chat con actividad en esos 10 min (last_active, que mientras
// un chat trabaja Hermes renueva cada minuto).
const { EventEmitter } = require('node:events')
const { spawn, execFile } = require('node:child_process')
const { newer } = require('./extras')

const POLL_MS = 60 * 1000 // cada minuto: ¿Hermes trabaja?
const CHECK_MS = 6 * 60 * 60 * 1000 // cada 6 h: ¿hay versión nueva?
const IDLE_MS = 10 * 60 * 1000 // «sin usarse»
const RETRY_MS = 6 * 60 * 60 * 1000 // tras un fallo, esa versión no se reintenta en 6 h
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000
const LATEST_URL = 'https://api.github.com/repos/NousResearch/hermes-agent/releases/latest'

const clean = v => String(v || '').trim().replace(/^v/i, '')
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * Lo que dice GET /api/hermes/update/check (null si no se pudo preguntar) → { version, latest,
 * available, canApply, method }. Con una instalación git que se puede actualizar manda Hermes; con
 * lo demás (Docker, sin sesión…) se compara su versión con la última estable publicada. Volver atrás
 * (rollback_to: esta compilación es más nueva que la estable) no cuenta como versión nueva. Pura.
 */
function infoFrom(check, version, latest) {
  const j = check && typeof check === 'object' ? check : null
  if (j && j.install_method === 'git' && j.can_apply === true) {
    const available = Boolean(j.update_available) && !j.rollback_to
    return { version: clean(j.current_version || version), latest: available ? clean(j.source_version) : clean(j.current_version || version), available, canApply: true, method: 'git' }
  }
  const v = clean((j && j.current_version) || version)
  const l = clean(latest)
  return { version: v, latest: l, available: Boolean(v && l && newer(l, v)), canApply: false, method: String((j && j.install_method) || '') }
}

/**
 * ¿Se instala ya? `s` = el estado de esa conexión. Devuelve 'instalar' o por qué no:
 * 'al-dia' | 'servidor' (no se puede desde aquí) | 'manual' (automático apagado) | 'instalando' |
 * 'fallo-reciente' | 'observando' (aún no lleva 10 min mirando) | 'en-uso'. Pura.
 */
function decide(s, { now, auto }) {
  const i = s.info
  if (!i || !i.available) { return 'al-dia' }
  if (!i.canApply) { return 'servidor' }
  if (!auto) { return 'manual' }
  if (s.applying) { return 'instalando' }
  const f = s.lastResult
  if (f && !f.ok && f.to === i.latest && now - f.at < RETRY_MS) { return 'fallo-reciente' }
  if (s.busy || (s.lastBusyAt && now - s.lastBusyAt < IDLE_MS)) { return 'en-uso' }
  if (s.lastActive && now - s.lastActive < IDLE_MS) { return 'en-uso' }
  if (!s.watchingSince || now - s.watchingSince < IDLE_MS) { return 'observando' }
  return 'instalar'
}

/** La actividad más reciente de una lista de chats de Hermes (last_active en segundos) → ms. Pura. */
function newestActivity(sessions) {
  let max = 0
  for (const r of Array.isArray(sessions) ? sessions : []) {
    const v = Number(r && (r.last_active || r.last_activity_at || r.started_at))
    if (Number.isFinite(v) && v > 0) { max = Math.max(max, v < 1e12 ? v * 1000 : v) }
  }
  return max
}

/** Lanza `file args` sin ventana; guarda el final de lo que escribe. → { code, tail } */
function runCapture(file, args, timeoutMs) {
  return new Promise(resolve => {
    let tail = ''
    const keep = d => { tail = (tail + String(d)).slice(-8000) }
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => {
      keep('\n[Pedila] no terminó en 30 min: lo paro\n')
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, tail: tail + '\n' + e.message }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, tail: tail.replace(ANSI, '') }) })
  })
}

class HermesUpdates extends EventEmitter {
  /** conns: { local, server } · settings · log · hermesExe(): ruta de hermes.exe de este PC */
  constructor({ conns, settings, log, hermesExe, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), run = runCapture }) {
    super()
    this.conns = conns
    this.settings = settings
    this.log = log
    this.hermesExe = hermesExe
    this.fetch = fetchImpl
    this.now = now
    this.run = run
    this.st = {}
    this.latest = { at: 0, version: '' }
    this.timer = null
    this.ticking = false
  }

  state(id) {
    if (!this.st[id]) {
      this.st[id] = { version: '', info: null, checkedAt: 0, watchingSince: 0, lastBusyAt: 0, lastActive: 0, busy: false, applying: null, lastResult: null, why: '' }
    }
    return this.st[id]
  }

  start() {
    this.first = setTimeout(() => this.tick(), 30000)
    this.timer = setInterval(() => this.tick(), POLL_MS)
  }

  stop() {
    clearTimeout(this.first)
    clearInterval(this.timer)
  }

  /** Lo que enseña la pantalla, por conexión. */
  view() {
    const out = {}
    for (const id of Object.keys(this.conns)) {
      const s = this.state(id)
      const i = s.info
      out[id] = {
        version: s.version || (i && i.version) || '',
        latest: i ? i.latest : '',
        available: Boolean(i && i.available),
        canApply: Boolean(i && i.canApply),
        method: i ? i.method : '',
        checkedAt: s.checkedAt,
        busy: s.busy,
        why: s.why,
        applying: s.applying ? { ...s.applying } : null,
        lastResult: s.lastResult ? { at: s.lastResult.at, ok: s.lastResult.ok, from: s.lastResult.from, to: s.lastResult.to, error: s.lastResult.error } : null
      }
    }
    return out
  }

  changed() { this.emit('change', this.view()) }

  /** ¿Hay algo en marcha en ese Hermes (ahora o en los últimos `ms`)? Para la actualización de Pedila. */
  busyWithin(id, ms, now = this.now()) {
    const s = this.st[id]
    return Boolean(s && (s.busy || (s.lastBusyAt && now - s.lastBusyAt < ms)))
  }

  applyingAny() {
    return Object.values(this.st).some(s => s.applying)
  }

  async tick() {
    if (this.ticking) { return }
    this.ticking = true
    try {
      for (const c of Object.values(this.conns)) {
        await this.tickOne(c).catch(e => this.log.warn(`[hermes ${c.id}] al mirar su versión:`, e.message))
      }
    } finally {
      this.ticking = false
    }
  }

  /** Se le puede preguntar: el del PC conectado; el del servidor también sin sesión (/api/status es público). */
  reachable(c) {
    return c.state === 'ready' || (c.id === 'server' && c.state === 'login')
  }

  async tickOne(c, force = false) {
    const s = this.state(c.id)
    if (s.applying) { return }
    if (!this.reachable(c)) { s.watchingSince = 0; return }
    const now = this.now()
    let status = null
    try {
      const r = await c.transport.publicJson('/api/status', { timeoutMs: 15000 })
      if (r.status === 200 && r.json && typeof r.json === 'object') { status = r.json }
    } catch {}
    if (!status) { s.watchingSince = 0; return }
    if (!s.watchingSince) { s.watchingSince = now }
    s.busy = Number(status.active_agents) > 0 || status.gateway_busy === true
    if (s.busy) { s.lastBusyAt = now }
    if (status.version) { s.version = clean(status.version) }
    if (c.state === 'ready') {
      try {
        const r = await c.transport.fetchJson('/api/sessions?limit=50&offset=0&min_messages=0&archived=include', { timeoutMs: 20000 })
        if (r.status === 200 && r.json) { s.lastActive = newestActivity(r.json.sessions) }
      } catch {}
    }
    if (force || !s.info || now - s.checkedAt > CHECK_MS || (s.version && s.info.version && s.info.version !== s.version)) {
      await this.check(c, force)
    }
    s.why = decide(s, { now, auto: this.settings.data.hermes.autoUpdate })
    if (s.why === 'instalar' && c.id === 'local') {
      await this.apply(c, 'lleva 10 min sin usarse')
      return
    }
    this.changed()
  }

  async check(c, force = false) {
    const s = this.state(c.id)
    let j = null
    if (c.state === 'ready') {
      try {
        const r = await c.transport.fetchJson(`/api/hermes/update/check${force ? '?force=true' : ''}`, { timeoutMs: 60000 })
        if (r.status === 200 && r.json && typeof r.json === 'object') { j = r.json }
      } catch {}
    }
    const own = j && j.install_method === 'git' && j.can_apply === true
    let latest = this.latest.version
    if (!own) { latest = await this.latestStable(force).catch(e => { this.log.warn('[hermes] no pude leer la última versión publicada:', e.message); return this.latest.version }) }
    s.info = infoFrom(j, s.version, latest)
    s.checkedAt = this.now()
    if (s.info.available) { this.log.info(`[hermes ${c.id}] hay versión nueva: ${s.info.version} → ${s.info.latest || 'lo último'}${s.info.canApply ? '' : ' (la actualiza su servidor)'}`) }
  }

  /** La última versión estable de Hermes publicada en GitHub (se recuerda 6 h). */
  async latestStable(force = false) {
    const now = this.now()
    if (!force && this.latest.version && now - this.latest.at < CHECK_MS) { return this.latest.version }
    const res = await this.fetch(LATEST_URL, { headers: { 'User-Agent': 'pedila', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) { throw new Error(`GitHub respondió ${res.status}`) }
    const j = await res.json()
    const v = clean(j && j.tag_name)
    if (!/^\d+\.\d+/.test(v)) { throw new Error(`versión rara en GitHub: ${String(j && j.tag_name).slice(0, 40)}`) }
    this.latest = { at: now, version: v }
    return v
  }

  /**
   * Actualiza el Hermes de este PC con su propia orden (`hermes update`, la misma que lanza el botón
   * de Hermes). Antes se cierra la conexión de Pedila y su Python de los tickets: en Windows, un
   * proceso abierto con el Python de Hermes puede bloquear archivos que la actualización cambia.
   */
  async apply(c, reason) {
    const s = this.state(c.id)
    if (s.applying || c.id !== 'local' || !s.info || !s.info.canApply || !s.info.available) { return false }
    const from = s.version || s.info.version
    const to = s.info.latest
    s.applying = { at: this.now(), from, to, reason }
    s.why = 'instalando'
    this.log.info(`[hermes local] actualizo Hermes ${from} → ${to || 'lo último'} (${reason})`)
    this.changed()
    const wasOn = !c.stopped
    c.stop()
    c.setState('updating', to ? `${from} → ${to}` : '')
    let out
    try {
      out = await this.run(this.hermesExe(), ['update'], UPDATE_TIMEOUT_MS)
    } catch (e) {
      out = { code: -1, tail: e.message }
    }
    const ok = out.code === 0
    const tail = String(out.tail || '').trim().split(/\r?\n/).slice(-12).join('\n')
    if (ok) { this.log.info(`[hermes local] actualización terminada:\n${tail}`) } else { this.log.warn(`[hermes local] la actualización falló (código ${out.code}):\n${tail}`) }
    if (c.transport.invalidate) { c.transport.invalidate() }
    c.setState('connecting')
    if (wasOn) { c.start() }
    s.applying = null
    s.lastResult = { at: this.now(), ok, from, to, error: ok ? '' : (tail.split('\n').filter(Boolean).pop() || `terminó con el código ${out.code}`) }
    // La versión que quedó se lee en la próxima mirada (con el gateway ya arrancado otra vez).
    s.checkedAt = 0
    s.watchingSince = 0
    s.why = ''
    this.changed()
    return ok
  }

  /** «Buscar ahora» / «Actualizar ahora» desde la pantalla. */
  async checkNow(id) {
    const c = this.conns[id]
    if (!c) { throw new Error('conexión desconocida') }
    await this.tickOne(c, true)
    return this.view()[id]
  }

  async applyNow(id) {
    const c = this.conns[id]
    if (!c) { throw new Error('conexión desconocida') }
    const s = this.state(id)
    if (!s.info || !s.info.available) { await this.check(c, true) }
    if (!s.info || !s.info.available) { throw new Error('no hay versión nueva') }
    if (!s.info.canApply) { throw new Error('este Hermes se actualiza desde su servidor') }
    // Sin esperar: la pantalla sigue el avance con los avisos.
    this.apply(c, 'pedido a mano').catch(e => this.log.warn('[hermes local] al actualizar:', e.message))
    return true
  }
}

module.exports = { HermesUpdates, infoFrom, decide, newestActivity, IDLE_MS }
