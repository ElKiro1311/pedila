'use strict'
// Hermes versions (this PC's and the server's): whether there's a new one and, when Hermes knows how to
// update itself (a git installation, the official installer's), installing it after 10 minutes unused. A
// Hermes in Docker (a server) is updated by its own server: here there's only a notice.
//
// "Unused", in every look of the last 10 min:
// - /api/status without turns running (active_agents 0, gateway_busy false);
// - session.active_list without chats working and subagent.roster without subagents or background
// processes (active_agents doesn't count them, and `hermes update` stops the gateway: it would kill them);
// - no chat with activity (last_active, which Hermes renews every minute while it works);
// - and you not using Pedila or the PC (userBusy, from index.js: that way what you're typing isn't cut
// off).
// Everything is checked again right before updating.
const { EventEmitter } = require('node:events')
const { spawn, execFile } = require('node:child_process')
const { newer } = require('./extras')
const { tr } = require('./i18n')

const POLL_MS = 60 * 1000 // every minute: is Hermes working?
const CHECK_MS = 6 * 60 * 60 * 1000 // every 6 h: is there a new version?
const CHECK_RETRY_MS = 15 * 60 * 1000 // if this PC's check failed, it's repeated after 15 min
const IDLE_MS = 10 * 60 * 1000 // "unused"
const RETRY_MS = 6 * 60 * 60 * 1000 // after a failure, that version isn't retried for 6 h
const GITHUB_FAIL_MS = 60 * 60 * 1000 // after a GitHub failure, 1 h without asking it (6 h with 403/429)
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000
const RESTART_TIMEOUT_MS = 3 * 60 * 1000
const LATEST_URL = 'https://api.github.com/repos/NousResearch/hermes-agent/releases/latest'

const clean = v => String(v || '').trim().replace(/^v/i, '')
// "0.23.0+12.gabc1234" (a build ahead of its tag) is the same 0.23.0 for comparing.
const base = v => clean(v).split('+')[0]
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * What GET /api/hermes/update/check says (null if it couldn't be asked) → { version, latest, available,
 * canApply, method }. With a git installation that can be updated, Hermes rules; with anything else (Docker,
 * not signed in…) its version is compared with the latest stable one published. Going back (rollback_to:
 * this build is newer than the stable one) doesn't count as a new version. Pure.
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
 * Install it now? `s` = that connection's state; `userBusy` = why not (what index.js says about you: '' if
 * you aren't using Pedila or the PC). Returns 'install' or why not: 'up-to-date' | 'server' (can't be done
 * from here) | 'manual' (automatic is off) | 'installing' | 'recent-failure' | 'in-use' | 'unknown' (not
 * everything could be checked: subagents, chats…) | 'user-busy' | 'watching' (not 10 min watching yet).
 * Pure.
 */
function decide(s, { now, auto, userBusy = '' }) {
  const i = s.info
  if (!i || !i.available) { return 'up-to-date' }
  if (!i.canApply) { return 'server' }
  if (!auto) { return 'manual' }
  if (s.applying) { return 'installing' }
  const f = s.lastResult
  if (f && !f.ok && f.to === i.latest && now - f.at < RETRY_MS) { return 'recent-failure' }
  if (s.busy || (s.lastBusyAt && now - s.lastBusyAt < IDLE_MS)) { return 'in-use' }
  if (s.lastActive && now - s.lastActive < IDLE_MS) { return 'in-use' }
  if (s.blind) { return 'unknown' }
  if (userBusy) { return 'user-busy' }
  if (!s.watchingSince || now - s.watchingSince < IDLE_MS) { return 'watching' }
  return 'install'
}

/** The most recent activity in a list of Hermes chats (last_active in seconds) → ms. Pure. */
function newestActivity(sessions) {
  let max = 0
  for (const r of Array.isArray(sessions) ? sessions : []) {
    const v = Number(r && (r.last_active || r.last_activity_at || r.started_at))
    if (Number.isFinite(v) && v > 0) { max = Math.max(max, v < 1e12 ? v * 1000 : v) }
  }
  return max
}

/**
 * Are there subagents or background processes according to subagent.roster? null = an odd answer (not
 * known). Pure.
 */
function rosterBusy(r) {
  if (!r || !Array.isArray(r.sessions)) { return null }
  return r.sessions.some(x => x && (Number(x.subagents) > 0 || Number(x.background) > 0))
}

/** Launches `file args` without a window; keeps the end of what it writes. → { code, tail } */
function runCapture(file, args, timeoutMs) {
  return new Promise(resolve => {
    let tail = ''
    const keep = d => { tail = (tail + String(d)).slice(-8000) }
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => {
      keep(`\n[Pedila] not finished in ${Math.round(timeoutMs / 60000)} min: stopping it\n`)
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, tail: tail + '\n' + e.message }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, tail: tail.replace(ANSI, '') }) })
  })
}

class HermesUpdates extends EventEmitter {
  /**
   * conns: { local, server } · settings · log · hermesExe(): path of this PC's hermes.exe · userBusy(): why
   * nothing should be touched now on your side ('' = you aren't using Pedila or the PC).
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

  /** What the screen shows, per connection. */
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

  /** Is there something running in that Hermes (now or in the last `ms`)? For Pedila's update. */
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
        await this.tickOne(c).catch(e => this.log.warn(`[hermes ${c.id}] looking up its version:`, e.message))
      }
    } finally {
      this.ticking = false
    }
  }

  /** It can be asked: the PC's, connected; the server's, also without being signed in (/api/status is public). */
  reachable(c) {
    return c.state === 'ready' || (c.id === 'server' && c.state === 'login')
  }

  /**
   * One look at that Hermes: is it working (turns, chats, subagents, background processes)? when was it last
   * active? → { ok, busy, version, lastActive }. ok=false if it couldn't be known.
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
    // Without a ready connection only what /api/status gives is known (chats, subagents and processes
    // aren't).
    let known = c.state === 'ready'
    if (c.state === 'ready') {
      try {
        // order=recent: by last activity (otherwise Hermes sorts by creation date).
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
    // What couldn't be known (subagents, chats…) holds Hermes's update back (better to wait than to cut
    // something off), but not Pedila's: restarting Pedila cuts nothing of Hermes off.
    s.blind = !l.known
    if (s.busy) { s.lastBusyAt = now }
    if (l.lastActive) { s.lastActive = l.lastActive }
    if (l.version) { s.version = l.version }
    if (force || !s.info || now - s.checkedAt > s.checkTtl || (s.version && s.info.version && base(s.info.version) !== base(s.version))) {
      await this.check(c, force)
    }
    s.why = decide(s, { now, auto: this.settings.data.hermes.autoUpdate, userBusy: c.id === 'local' ? this.userBusy() : '' })
    if (s.why === 'install' && c.id === 'local') {
      await this.apply(c, 'unused for 10 min', { recheck: true })
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
    // This PC's, connected and with no answer: what was there stays and it's asked again soon (with just
    // any answer it would be taken as "can't be updated from here" for 6 h).
    if (!j && c.id === 'local' && c.state === 'ready') {
      s.checkedAt = this.now()
      s.checkTtl = CHECK_RETRY_MS
      if (s.info) { return }
    }
    const own = j && j.install_method === 'git' && j.can_apply === true
    let latest = this.latest.version
    if (!own) { latest = await this.latestStable(force).catch(e => { this.log.warn("[hermes] couldn't read the latest published version:", e.message); return this.latest.version }) }
    s.info = infoFrom(j, s.version, latest)
    s.checkedAt = this.now()
    s.checkTtl = j || c.id !== 'local' ? CHECK_MS : CHECK_RETRY_MS
    // The notice, once per new version.
    if (s.info.available && s.said !== s.info.latest) {
      s.said = s.info.latest
      this.log.info(`[hermes ${c.id}] new version: ${s.info.version} → ${s.info.latest || 'the latest'}${s.info.canApply ? '' : ' (its server updates it)'}`)
    }
  }

  /** The latest stable version of Hermes published on GitHub (remembered for 6 h; after a failure, it waits). */
  async latestStable(force = false) {
    const now = this.now()
    const L = this.latest
    if (!force && L.version && now - L.at < CHECK_MS) { return L.version }
    if (L.failAt && now - L.failAt < L.failMs) { return L.version }
    try {
      const res = await this.fetch(LATEST_URL, { headers: { 'User-Agent': 'pedila', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
      if (!res.ok) {
        const e = new Error(`GitHub answered ${res.status}`)
        e.status = res.status
        throw e
      }
      const j = await res.json()
      const v = clean(j && j.tag_name)
      if (!/^\d+\.\d+/.test(v)) { throw new Error(`odd version on GitHub: ${String(j && j.tag_name).slice(0, 40)}`) }
      this.latest = { at: now, version: v, failAt: 0, failMs: 0 }
      return v
    } catch (e) {
      // GitHub's limit without a key is 60 per hour and per IP (Pedila itself shares it): no insisting.
      this.latest = { ...L, failAt: now, failMs: e.status === 403 || e.status === 429 ? CHECK_MS : GITHUB_FAIL_MS }
      throw e
    }
  }

  /**
   * Updates this PC's Hermes with its own command (`hermes update`, the same one Hermes's button launches).
   * First Pedila's connection is closed and its transport paused: on Windows, the Hermes Python that Pedila
   * uses for the tickets would lock files the update changes.
   * With `recheck`, right before that it looks again that nobody is using it.
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
        s.why = hermes ? 'in-use' : 'user-busy'
        this.log.info(`[hermes local] not updating yet: ${hermes ? "Hermes has something running or it couldn't be checked" : 'Pedila or the PC is in use'}`)
        this.changed()
        return false
      }
    }
    const from = s.version || s.info.version
    const to = s.info.latest
    s.applying = { at: this.now(), from, to, reason }
    s.why = 'installing'
    this.log.info(`[hermes local] updating Hermes ${from} → ${to || 'the latest'} (${reason})`)
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
    if (ok) { this.log.info(`[hermes local] update finished:\n${tail}`) } else { this.log.warn(`[hermes local] the update failed (code ${out.code}):\n${tail}`) }
    if (c.transport.invalidate) { c.transport.invalidate() }
    c.setState('connecting')
    if (wasOn) { c.start() }
    s.applying = null
    s.lastResult = { at: this.now(), ok, from, to, error: ok ? '' : (tail.split('\n').filter(Boolean).pop() || tr('finished with code {0}', out.code)) }
    // The resulting version is read in the next look (with the gateway already started again).
    s.checkedAt = 0
    s.watchingSince = 0
    s.why = ''
    this.changed()
    return ok
  }

  /**
   * Restarts this PC's Hermes with its own command (`hermes gateway restart`) so that it loads what has
   * changed on disk (a new plugin). Only if it's doing nothing right now: no turns, no chats working, no
   * subagents or background processes (it looks right before; if it can't be known, no).
   * As when updating: Pedila's connection is closed, its transport is paused, and it's opened again.
   * `--detach`: the new gateway doesn't stay inside this command (which is stopped after a few minutes); and
   * without `--yes`, Hermes itself refuses if something is running.
   */
  async restart(c, reason) {
    const s = this.state(c.id)
    if (c.id !== 'local') { throw new Error(tr("the server's Hermes is restarted from the server")) }
    if (s.applying) { throw new Error(s.applying.kind === 'restart' ? tr('Hermes is already restarting') : tr('Hermes is updating')) }
    const v = s.version || (s.info && s.info.version) || ''
    // The spot is taken BEFORE looking: while it looks, an automatic update can't start.
    s.applying = { at: this.now(), from: v, to: v, reason, kind: 'restart' }
    let l
    try {
      l = c.state === 'ready' ? await this.look(c) : { ok: false }
    } catch {
      l = { ok: false }
    }
    if (!l.ok || !l.known || l.busy) {
      s.applying = null
      if (l.ok && l.busy) { s.lastBusyAt = this.now() }
      this.changed()
      throw new Error(l.ok && l.busy ? tr('Hermes is working: wait until it finishes') : tr("couldn't check whether Hermes is working"))
    }
    this.log.info(`[hermes local] restarting Hermes (${reason})`)
    this.changed()
    const wasOn = !c.stopped
    c.stop()
    if (c.transport.pause) { c.transport.pause('restart') }
    c.setState('updating', 'restarting')
    let out
    try {
      out = await this.run(this.hermesExe(), ['gateway', 'restart', '--detach'], RESTART_TIMEOUT_MS)
      // A Hermes from before --detach.
      if (out.code === 2 && /unrecognized arguments/i.test(String(out.tail))) { out = await this.run(this.hermesExe(), ['gateway', 'restart'], RESTART_TIMEOUT_MS) }
    } catch (e) {
      out = { code: -1, tail: e.message }
    } finally {
      if (c.transport.resume) { c.transport.resume() }
    }
    const ok = out.code === 0
    const tail = String(out.tail || '').trim().split(/\r?\n/).slice(-8).join('\n')
    if (ok) { this.log.info(`[hermes local] restart finished:\n${tail}`) } else { this.log.warn(`[hermes local] the restart failed (code ${out.code}):\n${tail}`) }
    if (c.transport.invalidate) { c.transport.invalidate() }
    c.setState('connecting')
    if (wasOn) { c.start() }
    s.applying = null
    s.watchingSince = 0
    // Something started between the look and the command (a scheduled task, a message from elsewhere): Hermes
    // refuses, and its last line is the order to force it, which would cut that work off.
    const refused = !ok && /refusing to (restart|stop) the gateway/i.test(String(out.tail))
    if (refused) { s.lastBusyAt = this.now() }
    this.changed()
    if (refused) { throw new Error(tr('Hermes is working: wait until it finishes')) }
    if (!ok) { throw new Error(tail.split('\n').filter(Boolean).pop() || tr('finished with code {0}', out.code)) }
    return true
  }

  /** Is that Hermes working now? (null = it couldn't be known). Loading a plugin makes it load all of them again. */
  async working(id) {
    const c = this.conns[id]
    const l = c ? await this.look(c).catch(() => ({ ok: false })) : { ok: false }
    if (!l.ok || (!l.busy && !l.known)) { return null }
    return l.busy
  }

  async restartNow(id, reason = 'asked for by hand') {
    const c = this.conns[id]
    if (!c) { throw new Error(tr('unknown connection')) }
    return this.restart(c, reason)
  }

  /** "Check now" / "Update now" from the screen. */
  async checkNow(id) {
    const c = this.conns[id]
    if (!c) { throw new Error(tr('unknown connection')) }
    await this.tickOne(c, true)
    return this.view()[id]
  }

  async applyNow(id) {
    const c = this.conns[id]
    if (!c) { throw new Error(tr('unknown connection')) }
    const s = this.state(id)
    if (!s.info || !s.info.available) { await this.check(c, true) }
    if (!s.info || !s.info.available) { throw new Error(tr("there's no new version")) }
    if (!s.info.canApply) { throw new Error(tr('this Hermes is updated from its server')) }
    // Without waiting: the screen follows the progress through the events.
    this.apply(c, 'asked for by hand').catch(e => this.log.warn('[hermes local] while updating:', e.message))
    return true
  }
}

module.exports = { HermesUpdates, infoFrom, decide, newestActivity, rosterBusy, IDLE_MS }
