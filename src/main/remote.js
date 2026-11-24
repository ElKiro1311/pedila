'use strict'
// "Server": a Hermes on another machine (`hermes dashboard` protected with a username and password). Like
// Hermes Desktop with a remote gateway of the cookie kind:
// - POST /auth/password-login {provider:'basic', username, password} leaves the cookies hermes_session_at
// (12 h), hermes_session_rt (30 days) and hermes_session_provider;
// - REST goes with those cookies; the middleware renews the access one with the refresh one and returns it
// in Set-Cookie, so each answer updates the jar;
// - the WebSocket needs a single-use ticket (30 s) from POST /api/auth/ws-ticket, in ?ticket=.
// The cookies are stored encrypted with safeStorage (DPAPI). The password is never stored.
const { tr } = require('./i18n')

class NeedLogin extends Error {
  constructor(msg = tr("You need to sign in to the server's Hermes")) {
    super(msg)
    this.needLogin = true
  }
}

class NeedSetup extends Error {
  constructor() {
    super(tr("The server's address is missing (Settings → Server)"))
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
    this.sessionNo = 0 // goes up when signing in or out
  }

  async init() {
    const enc = this.settings.data.secrets.server
    if (!enc) { return }
    try {
      const obj = await this.secrets.decrypt(enc)
      for (const [k, v] of Object.entries(obj.cookies || {})) { if (typeof v === 'string') { this.jar.set(k, v) } }
    } catch (e) {
      this.log.warn("[server] couldn't decrypt the stored session:", e.message)
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
    this.saveTimer = setTimeout(() => this.persist().catch(e => this.log.warn("[server] couldn't store the session:", e.message)), 300)
  }

  async persist() {
    const data = this.settings.data
    data.secrets.server = this.jar.size ? await this.secrets.encrypt({ cookies: Object.fromEntries(this.jar) }) : null
    this.settings.save()
  }

  urls() {
    return this.settings.data.server.urls
  }

  /** The first address that answers (the home one first, the alternative one after); remembered for 60 s. */
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
        lastErr = new Error(tr('{0} answered {1}', u, res.status))
      } catch (e) { lastErr = e }
    }
    this.base = null
    throw new Error(tr("Can't reach the server's Hermes") + (lastErr ? ` (${lastErr.cause?.code || lastErr.message})` : ''))
  }

  async login(username, password) {
    if (!this.urls().length) { return { ok: false, error: tr("First put the server's address in Settings → Server.") } }
    const base = await this.pickBase(true)
    const res = await fetch(base + '/auth/password-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'basic', username, password, next: '' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20000)
    })
    if (res.status === 429) { return { ok: false, error: tr('Too many attempts. Wait a few minutes and try again.') } }
    if (res.status === 401 || res.status === 403) { return { ok: false, error: tr('Wrong username or password.') } }
    if (!res.ok) { return { ok: false, error: tr('The server answered {0}.', res.status) } }
    this.jar.clear()
    this.sessionNo++
    this.absorb(res)
    if (!this.hasSession()) { return { ok: false, error: tr("The server didn't return the session.") } }
    await this.persist()
    return { ok: true }
  }

  async logout() {
    try {
      const base = await this.pickBase()
      await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: this.cookieHeader() }, redirect: 'manual', signal: AbortSignal.timeout(8000) })
    } catch {}
    this.jar.clear()
    this.sessionNo++
    await this.persist()
  }

  async wsTarget() {
    if (!this.urls().length) { throw new NeedSetup() }
    if (!this.hasSession()) { throw new NeedLogin() }
    const base = await this.pickBase()
    const res = await fetch(base + '/api/auth/ws-ticket', { method: 'POST', headers: { Cookie: this.cookieHeader() }, signal: AbortSignal.timeout(15000) })
    this.absorb(res)
    if (res.status === 401) { throw new NeedLogin(tr('The server session expired (was Hermes restarted there?)')) }
    if (!res.ok) { throw new Error(tr("Couldn't get a ticket from the server ({0})", res.status)) }
    const j = await res.json()
    if (!j || typeof j.ticket !== 'string') { throw new Error(tr('The server gave no ticket')) }
    return { url: base.replace(/^http/, 'ws') + '/api/ws?ticket=' + encodeURIComponent(j.ticket), protocols: null }
  }

  async fetchJson(p, opts) {
    if (!this.urls().length) { throw new NeedSetup() }
    if (!this.hasSession()) { throw new NeedLogin() }
    return this.requestJson(await this.pickBase(), p, opts)
  }

  /**
   * The same, tied to the address and the session of now: for several requests in a row that must go to the same
   * Hermes. If another session is started meanwhile (perhaps in another server), they're over.
   */
  async pinned() {
    if (!this.urls().length) { throw new NeedSetup() }
    const base = await this.pickBase()
    const session = this.sessionNo
    return {
      fetchJson: async (p, opts) => {
        if (!this.hasSession() || session !== this.sessionNo) { throw new NeedLogin() }
        return this.requestJson(base, p, opts)
      }
    }
  }

  async requestJson(base, p, { method = 'GET', body, timeoutMs = 30000 } = {}) {
    const session = this.sessionNo
    const headers = { Cookie: this.cookieHeader() }
    if (body !== undefined) { headers['Content-Type'] = 'application/json' }
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    // The answer to another session's request isn't this one's cookies.
    if (session === this.sessionNo) { this.absorb(res) }
    if (res.status === 401) { throw new NeedLogin(tr('The server session expired')) }
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json }
  }

  /** What Hermes shows without signing in (/api/status: version and whether it's working). */
  async publicJson(p, { timeoutMs = 15000 } = {}) {
    const base = await this.pickBase()
    const res = await fetch(base + p, { headers: this.hasSession() ? { Cookie: this.cookieHeader() } : {}, signal: AbortSignal.timeout(timeoutMs) })
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
