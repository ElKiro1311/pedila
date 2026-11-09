'use strict'
// «Servidor»: un Hermes en otra máquina (`hermes dashboard` protegido con usuario y contraseña).
// Igual que Hermes Desktop con un gateway remoto de tipo cookie:
//  - POST /auth/password-login {provider:'basic', username, password} deja las cookies
//    hermes_session_at (12 h), hermes_session_rt (30 días) y hermes_session_provider;
//  - el REST va con esas cookies; el middleware renueva la de acceso con la de refresco y la
//    devuelve en Set-Cookie, así que cada respuesta actualiza el tarro;
//  - el WebSocket necesita un ticket de un solo uso (30 s) de POST /api/auth/ws-ticket, en ?ticket=.
// Las cookies se guardan cifradas con safeStorage (DPAPI). La contraseña no se guarda nunca.

class NeedLogin extends Error {
  constructor(msg = 'Hay que iniciar sesión en el Hermes del servidor') {
    super(msg)
    this.needLogin = true
  }
}

class NeedSetup extends Error {
  constructor() {
    super('Falta la dirección del servidor (Ajustes → Servidor)')
    this.setup = true
  }
}

function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(';')
  const eq = pair.indexOf('=')
  if (eq <= 0) { return null }
  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  let expired = value === ''
  for (const a of attrs) {
    const [k, v] = a.split('=').map(s => (s || '').trim())
    if (/^max-age$/i.test(k) && Number(v) <= 0) { expired = true }
    if (/^expires$/i.test(k) && Date.parse(v) < Date.now()) { expired = true }
  }
  return { name, value, expired }
}

class RemoteTransport {
  constructor({ settings, secrets, log }) {
    this.settings = settings
    this.secrets = secrets
    this.log = log
    this.jar = new Map()
    this.base = null
    this.baseAt = 0
    this.kind = 'remote'
    this.saveTimer = null
  }

  async init() {
    const enc = this.settings.data.secrets.server
    if (!enc) { return }
    try {
      const obj = await this.secrets.decrypt(enc)
      for (const [k, v] of Object.entries(obj.cookies || {})) { if (typeof v === 'string') { this.jar.set(k, v) } }
    } catch (e) {
      this.log.warn('[servidor] no pude descifrar la sesión guardada:', e.message)
    }
  }

  hasSession() {
    return this.jar.has('hermes_session_rt') || this.jar.has('hermes_session_at')
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    let changed = false
    for (const h of list) {
      const c = parseSetCookie(h)
      if (!c || !c.name.startsWith('hermes_session')) { continue }
      if (c.expired) { changed = this.jar.delete(c.name) || changed } else if (this.jar.get(c.name) !== c.value) { this.jar.set(c.name, c.value); changed = true }
    }
    if (changed) { this.persistSoon() }
  }

  persistSoon() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.persist().catch(e => this.log.warn('[servidor] no pude guardar la sesión:', e.message)), 300)
  }

  async persist() {
    const data = this.settings.data
    data.secrets.server = this.jar.size ? await this.secrets.encrypt({ cookies: Object.fromEntries(this.jar) }) : null
    this.settings.save()
  }

  urls() {
    return this.settings.data.server.urls
  }

  /** La primera dirección que contesta (la de casa primero, la alternativa después); se recuerda 60 s. */
  async pickBase(force = false) {
    if (!this.urls().length) { throw new NeedSetup() }
    if (this.base && !force && Date.now() - this.baseAt < 60000) { return this.base }
    let lastErr = null
    for (const u of this.urls()) {
      try {
        const res = await fetch(u + '/api/status', { signal: AbortSignal.timeout(3500) })
        if (res.ok) {
          const st = await res.json().catch(() => ({}))
          this.base = u
          this.baseAt = Date.now()
          this.status = st
          return u
        }
        lastErr = new Error(`${u} respondió ${res.status}`)
      } catch (e) { lastErr = e }
    }
    this.base = null
    throw new Error('No llego al Hermes del servidor' + (lastErr ? ` (${lastErr.cause?.code || lastErr.message})` : ''))
  }

  async login(username, password) {
    if (!this.urls().length) { return { ok: false, error: 'Primero pon la dirección del servidor en Ajustes → Servidor.' } }
    const base = await this.pickBase(true)
    const res = await fetch(base + '/auth/password-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'basic', username, password, next: '' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20000)
    })
    if (res.status === 429) { return { ok: false, error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' } }
    if (res.status === 401 || res.status === 403) { return { ok: false, error: 'Usuario o contraseña incorrectos.' } }
    if (!res.ok) { return { ok: false, error: `El servidor respondió ${res.status}.` } }
    this.jar.clear()
    this.absorb(res)
    if (!this.hasSession()) { return { ok: false, error: 'El servidor no devolvió la sesión.' } }
    await this.persist()
    return { ok: true }
  }

  async logout() {
    try {
      const base = await this.pickBase()
      await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: this.cookieHeader() }, redirect: 'manual', signal: AbortSignal.timeout(8000) })
    } catch {}
    this.jar.clear()
    await this.persist()
  }

  async wsTarget() {
    if (!this.urls().length) { throw new NeedSetup() }
    if (!this.hasSession()) { throw new NeedLogin() }
    const base = await this.pickBase()
    const res = await fetch(base + '/api/auth/ws-ticket', { method: 'POST', headers: { Cookie: this.cookieHeader() }, signal: AbortSignal.timeout(15000) })
    this.absorb(res)
    if (res.status === 401) { throw new NeedLogin('La sesión del servidor caducó (¿se reinició Hermes allí?)') }
    if (!res.ok) { throw new Error(`No pude pedir el ticket al servidor (${res.status})`) }
    const j = await res.json()
    if (!j || typeof j.ticket !== 'string') { throw new Error('El servidor no dio ticket') }
    return { url: base.replace(/^http/, 'ws') + '/api/ws?ticket=' + encodeURIComponent(j.ticket), protocols: null }
  }

  async fetchJson(p, { method = 'GET', body } = {}) {
    if (!this.urls().length) { throw new NeedSetup() }
    if (!this.hasSession()) { throw new NeedLogin() }
    const base = await this.pickBase()
    const headers = { Cookie: this.cookieHeader() }
    if (body !== undefined) { headers['Content-Type'] = 'application/json' }
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    this.absorb(res)
    if (res.status === 401) { throw new NeedLogin('La sesión del servidor caducó') }
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json }
  }

  invalidate() {
    this.base = null
  }

  dispose() {}
}

module.exports = { RemoteTransport, NeedLogin, NeedSetup, parseSetCookie }
