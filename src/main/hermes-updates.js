'use strict'
// Versiones de Hermes (el de este PC y el del servidor): si hay una nueva y, cuando Hermes sabe
// actualizarse solo (instalación git, la del instalador oficial), instalarla cuando lleve 10 minutos
// sin usarse. Un Hermes en Docker (un servidor) lo actualiza su propio servidor: aquí solo se avisa.
//
// «Sin usarse», en todas las miradas de los últimos 10 min:
//   - /api/status sin turnos en marcha (active_agents 0, gateway_busy falso);
//   - session.active_list sin chats trabajando y subagent.roster sin subagentes ni procesos en segundo
//     plano (active_agents no los cuenta, y `hermes update` para el gateway: los mataría);
//   - ningún chat con actividad (last_active, que Hermes renueva cada minuto mientras trabaja);
//   - y tú sin usar Pedila ni el PC (userBusy, desde index.js: así no se corta lo que estás escribiendo).
// Todo se vuelve a comprobar justo antes de actualizar.
const { EventEmitter } = require('node:events')
const { spawn, execFile } = require('node:child_process')
const { newer } = require('./extras')

const POLL_MS = 60 * 1000 // cada minuto: ¿Hermes trabaja?
const CHECK_MS = 6 * 60 * 60 * 1000 // cada 6 h: ¿hay versión nueva?
const CHECK_RETRY_MS = 15 * 60 * 1000 // si la comprobación de este PC falló, se repite a los 15 min
const IDLE_MS = 10 * 60 * 1000 // «sin usarse»
const RETRY_MS = 6 * 60 * 60 * 1000 // tras un fallo, esa versión no se reintenta en 6 h
const GITHUB_FAIL_MS = 60 * 60 * 1000 // tras un fallo de GitHub, 1 h sin preguntarle (6 h con 403/429)
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000
const LATEST_URL = 'https://api.github.com/repos/NousResearch/hermes-agent/releases/latest'

const clean = v => String(v || '').trim().replace(/^v/i, '')
// «0.23.0+12.gabc1234» (una compilación por delante de su etiqueta) es la misma 0.23.0 para comparar.
const base = v => clean(v).split('+')[0]
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
  return { version: v, latest: l, available: Boolean(v && l && newer(base(l), base(v))), canApply: false, method: String((j && j.install_method) || '') }
}

/**
 * ¿Se instala ya? `s` = el estado de esa conexión; `userBusy` = por qué no (lo que dice index.js de ti:
 * '' si no usas Pedila ni el PC). Devuelve 'instalar' o por qué no: 'al-dia' | 'servidor' (no se
 * puede desde aquí) | 'manual' (automático apagado) | 'instalando' | 'fallo-reciente' | 'en-uso' |
 * 'sin-saber' (no se pudo comprobar todo: subagentes, chats…) | 'tu-uso' | 'observando' (aún no
 * lleva 10 min mirando). Pura.
 */
function decide(s, { now, auto, userBusy = '' }) {
  const i = s.info
  if (!i || !i.available) { return 'al-dia' }
  if (!i.canApply) { return 'servidor' }
  if (!auto) { return 'manual' }
  if (s.applying) { return 'instalando' }
  const f = s.lastResult
  if (f && !f.ok && f.to === i.latest && now - f.at < RETRY_MS) { return 'fallo-reciente' }
  if (s.busy || (s.lastBusyAt && now - s.lastBusyAt < IDLE_MS)) { return 'en-uso' }
  if (s.lastActive && now - s.lastActive < IDLE_MS) { return 'en-uso' }
  if (s.blind) { return 'sin-saber' }
  if (userBusy) { return 'tu-uso' }
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

/** ¿Hay subagentes o procesos en segundo plano según subagent.roster? null = respuesta rara (no se sabe). Pura. */
function rosterBusy(r) {
  if (!r || !Array.isArray(r.sessions)) { return null }
  return r.sessions.some(x => x && (Number(x.subagents) > 0 || Number(x.background) > 0))
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
  /**
   * conns: { local, server } · settings · log · hermesExe(): ruta de hermes.exe de este PC ·
   * userBusy(): por qué no tocar nada ahora por tu parte ('' = no usas Pedila ni el PC).
   */
  constructor({ conns, settings, log, hermesExe, userBusy = () => '', fetchImpl = (...a) => fetch(...a), now = () => Date.now(), run = runCapture }) {
    super()
    this.conns = conns
    this.settings = settings
    this.log = log
    this.hermesExe = hermesExe
    this.userBusy = userBusy
    this.fetch = fetchImpl
    this.now = now
    this.run = run
    this.st = {}
    this.latest = { at: 0, version: '', failAt: 0, failMs: 0 }
    this.timer = null
    this.ticking = false
  }

  state(id) {
    if (!this.st[id]) {
      this.st[id] = { version: '', info: null, checkedAt: 0, checkTtl: CHECK_MS, watchingSince: 0, lastBusyAt: 0, lastActive: 0, busy: false, blind: false, applying: null, lastResult: null, why: '', said: '' }
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

  /**
   * Una mirada a ese Hermes: ¿trabaja (turnos, chats, subagentes, procesos de fondo)? ¿cuándo tuvo
   * actividad? → { ok, busy, version, lastActive }. ok=false si no se pudo saber.
   */
  async look(c) {
    let status = null
    try {
      const r = await c.transport.publicJson('/api/status', { timeoutMs: 15000 })
      if (r.status === 200 && r.json && typeof r.json === 'object') { status = r.json }
    } catch {}
    if (!status) { return { ok: false } }
    let busy = Number(status.active_agents) > 0 || status.gateway_busy === true
    let lastActive = 0
    // Sin conexión lista solo se sabe lo de /api/status (chats, subagentes y procesos, no).
    let known = c.state === 'ready'
    if (c.state === 'ready') {
      try {
        // order=recent: por la última actividad (si no, Hermes ordena por fecha de creación).
        const r = await c.transport.fetchJson('/api/sessions?limit=5&offset=0&min_messages=0&archived=include&order=recent', { timeoutMs: 20000 })
        if (r.status === 200 && r.json) { lastActive = newestActivity(r.json.sessions) } else { known = false }
      } catch { known = false }
      try { if ((await c.activeList()).length) { busy = true } } catch { known = false }
      try {
        const rb = rosterBusy(await c.rpc('subagent.roster', {}, 8000))
        if (rb === null) { known = false } else if (rb) { busy = true }
      } catch { known = false }
    }
    return { ok: true, known, busy, version: clean(status.version), lastActive }
  }

  async tickOne(c, force = false) {
    const s = this.state(c.id)
    if (s.applying) { return }
    if (!this.reachable(c)) { s.watchingSince = 0; return }
    const now = this.now()
    const l = await this.look(c)
    if (!l.ok) { s.watchingSince = 0; return }
    if (!s.watchingSince) { s.watchingSince = now }
    s.busy = l.busy
    // Lo que no se pudo saber (subagentes, chats…) frena la actualización de Hermes (mejor esperar
    // que cortar algo), pero no la de Pedila: reiniciar Pedila no corta nada de Hermes.
    s.blind = !l.known
    if (s.busy) { s.lastBusyAt = now }
    if (l.lastActive) { s.lastActive = l.lastActive }
    if (l.version) { s.version = l.version }
    if (force || !s.info || now - s.checkedAt > s.checkTtl || (s.version && s.info.version && base(s.info.version) !== base(s.version))) {
      await this.check(c, force)
    }
    s.why = decide(s, { now, auto: this.settings.data.hermes.autoUpdate, userBusy: c.id === 'local' ? this.userBusy() : '' })
    if (s.why === 'instalar' && c.id === 'local') {
      await this.apply(c, 'lleva 10 min sin usarse', { recheck: true })
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
    // El de este PC conectado y sin respuesta: lo de antes se queda y se vuelve a preguntar pronto
    // (con una respuesta cualquiera se daría por «no se puede actualizar desde aquí» durante 6 h).
    if (!j && c.id === 'local' && c.state === 'ready') {
      s.checkedAt = this.now()
      s.checkTtl = CHECK_RETRY_MS
      if (s.info) { return }
    }
    const own = j && j.install_method === 'git' && j.can_apply === true
    let latest = this.latest.version
    if (!own) { latest = await this.latestStable(force).catch(e => { this.log.warn('[hermes] no pude leer la última versión publicada:', e.message); return this.latest.version }) }
    s.info = infoFrom(j, s.version, latest)
    s.checkedAt = this.now()
    s.checkTtl = j || c.id !== 'local' ? CHECK_MS : CHECK_RETRY_MS
    // El aviso, una vez por versión nueva.
    if (s.info.available && s.said !== s.info.latest) {
      s.said = s.info.latest
      this.log.info(`[hermes ${c.id}] hay versión nueva: ${s.info.version} → ${s.info.latest || 'lo último'}${s.info.canApply ? '' : ' (la actualiza su servidor)'}`)
    }
  }

  /** La última versión estable de Hermes publicada en GitHub (se recuerda 6 h; tras un fallo, se espera). */
  async latestStable(force = false) {
    const now = this.now()
    const L = this.latest
    if (!force && L.version && now - L.at < CHECK_MS) { return L.version }
    if (L.failAt && now - L.failAt < L.failMs) { return L.version }
    try {
      const res = await this.fetch(LATEST_URL, { headers: { 'User-Agent': 'pedila', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
      if (!res.ok) {
        const e = new Error(`GitHub respondió ${res.status}`)
        e.status = res.status
        throw e
      }
      const j = await res.json()
      const v = clean(j && j.tag_name)
      if (!/^\d+\.\d+/.test(v)) { throw new Error(`versión rara en GitHub: ${String(j && j.tag_name).slice(0, 40)}`) }
      this.latest = { at: now, version: v, failAt: 0, failMs: 0 }
      return v
    } catch (e) {
      // El límite de GitHub sin clave es de 60 por hora y por IP (lo comparte la propia Pedila): sin insistir.
      this.latest = { ...L, failAt: now, failMs: e.status === 403 || e.status === 429 ? CHECK_MS : GITHUB_FAIL_MS }
      throw e
    }
  }

  /**
   * Actualiza el Hermes de este PC con su propia orden (`hermes update`, la misma que lanza el botón
   * de Hermes). Antes se cierra la conexión de Pedila y se pausa su transporte: en Windows, el Python
   * de Hermes que Pedila usa para los tickets bloquearía archivos que la actualización cambia.
   * Con `recheck`, justo antes se vuelve a mirar que nadie lo use.
   */
  async apply(c, reason, { recheck = false } = {}) {
    const s = this.state(c.id)
    if (s.applying || c.id !== 'local' || !s.info || !s.info.canApply || !s.info.available) { return false }
    if (recheck) {
      const l = c.state === 'ready' ? await this.look(c) : { ok: false }
      const you = this.userBusy()
      const hermes = !l.ok || !l.known || l.busy || Boolean(l.lastActive && this.now() - l.lastActive < IDLE_MS)
      if (hermes || you) {
        if (l.ok && l.busy) { s.lastBusyAt = this.now() }
        if (l.lastActive) { s.lastActive = Math.max(s.lastActive, l.lastActive) }
        s.why = hermes ? 'en-uso' : 'tu-uso'
        this.log.info(`[hermes local] no actualizo todavía: ${hermes ? 'Hermes tiene algo en marcha o no pude comprobarlo' : 'estás usando Pedila o el PC'}`)
        this.changed()
        return false
      }
    }
    const from = s.version || s.info.version
    const to = s.info.latest
    s.applying = { at: this.now(), from, to, reason }
    s.why = 'instalando'
    this.log.info(`[hermes local] actualizo Hermes ${from} → ${to || 'lo último'} (${reason})`)
    this.changed()
    const wasOn = !c.stopped
    c.stop()
    if (c.transport.pause) { c.transport.pause() }
    c.setState('updating', to ? `${from} → ${to}` : '')
    let out
    try {
      out = await this.run(this.hermesExe(), ['update'], UPDATE_TIMEOUT_MS)
    } catch (e) {
      out = { code: -1, tail: e.message }
    } finally {
      if (c.transport.resume) { c.transport.resume() }
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

module.exports = { HermesUpdates, infoFrom, decide, newestActivity, rosterBusy, IDLE_MS }
