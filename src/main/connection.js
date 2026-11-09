'use strict'
// Una conexión con un Hermes («Este PC» o «Servidor»). Habla los dos protocolos del gateway:
//  - canónico (gateway.ready trae session_authority: true; Hermes 0.23 en el PC): create con
//    request_id, submit con submission_id, y parar/permisos/preguntas con execution_generation;
//    los permisos y preguntas llegan como eventos approval.request / clarify.request;
//  - clásico (Hermes 0.22 en el servidor): los permisos y preguntas llegan como peticiones del
//    servidor ('approval', 'clarify') que se contestan en la misma petición.
// Hacia la interfaz todo sale con un formato único ({kind, conn, sid, …}) y con el id GUARDADO del
// chat (el de la lista), aunque por el socket viaje el id vivo.
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const { RpcSocket } = require('./rpc')

const BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000]
const COLS = 100

const str = v => (typeof v === 'string' ? v : '')
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** ¿La dirección del proveedor está en tu red (o en esta máquina)? Entonces el modelo es local. */
function isLocalUrl(u) {
  try {
    const h = new URL(String(u || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!h) { return false }
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h === '::1') { return true }
    const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
    if (!m) { return false }
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
  } catch { return false }
}

function contentText(c) {
  if (typeof c === 'string') { return c }
  if (Array.isArray(c)) {
    return c.map(p => (typeof p === 'string' ? p : p && p.type === 'text' ? str(p.text) : p && /image/.test(p.type || '') ? '[imagen]' : '')).filter(Boolean).join('\n')
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') { return c.text }
  return ''
}

function argsSummary(args, argsText) {
  if (args && typeof args === 'object') {
    const first = ['command', 'query', 'url', 'path', 'file_path', 'prompt', 'pattern', 'code', 'name']
      .map(k => args[k]).find(v => typeof v === 'string' && v.trim())
    if (first) { return cut(first.replace(/\s+/g, ' ').trim(), 140) }
    try { return cut(JSON.stringify(args), 140) } catch {}
  }
  return cut(str(argsText).replace(/\s+/g, ' ').trim(), 140)
}

function toolCallsOf(row) {
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : []
  return calls.map(c => {
    const fn = c && c.function ? c.function : c || {}
    let args = fn.arguments ?? c.args
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = { _: args } } }
    return { id: c.id || c.tool_call_id || '', name: str(fn.name || c.name) || 'herramienta', args: argsSummary(args) }
  })
}

/** Filas guardadas de /api/sessions/{id}/messages → turnos para la interfaz. */
function normalizeTranscript(rows) {
  const out = []
  let turn = null
  const sorted = [...rows].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  for (const r of sorted) {
    if (!r || r.active === false || r.display_kind === 'hidden') { continue }
    if (r.role === 'user') {
      turn = null
      const text = contentText(r.content)
      if (text.trim()) { out.push({ role: 'user', text, ts: r.timestamp || null }) }
    } else if (r.role === 'assistant') {
      if (!turn) { turn = { role: 'assistant', blocks: [], reasoning: '', ts: r.timestamp || null }; out.push(turn) }
      const reasoning = str(r.reasoning || r.reasoning_content)
      if (reasoning) { turn.reasoning += (turn.reasoning ? '\n\n' : '') + reasoning }
      const text = contentText(r.content)
      if (text.trim()) { turn.blocks.push({ type: 'text', text }) }
      for (const c of toolCallsOf(r)) { turn.blocks.push({ type: 'tool', id: c.id, name: c.name, args: c.args, done: false }) }
    } else if (r.role === 'tool') {
      if (!turn) { continue }
      const b = turn.blocks.find(x => x.type === 'tool' && !x.done && (!r.tool_call_id || x.id === r.tool_call_id))
      if (b) { b.done = true; b.summary = cut(contentText(r.content).replace(/\s+/g, ' ').trim(), 160) }
    }
  }
  for (const t of out) { if (t.blocks) { for (const b of t.blocks) { if (b.type === 'tool') { b.done = true } } } }
  return out
}

function sessionRow(r) {
  return {
    id: r.id,
    title: str(r.title) || str(r.preview).slice(0, 60) || 'Chat sin título',
    preview: cut(str(r.preview).replace(/\s+/g, ' ').trim(), 120),
    lastActive: r.last_active || r.last_activity_at || r.started_at || null,
    messages: r.message_count || 0,
    model: str(r.model),
    // `is_active` = el chat está cargado en el gateway (no que esté respondiendo ahora).
    active: Boolean(r.is_active),
    source: str(r.source),
    pinned: Boolean(r.pinned),
    archived: Boolean(r.archived),
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    startedAt: r.started_at || null
  }
}

class Connection extends EventEmitter {
  constructor({ id, name, transport, log }) {
    super()
    this.id = id
    this.name = name
    this.transport = transport
    this.log = log
    this.state = 'off'
    this.detail = ''
    this.canonical = false
    this.socket = null
    this.stopped = true
    this.connecting = false
    this.attempt = 0
    this.retryTimer = null
    this.live = new Map() // stored id → { liveId, generation, running }
    this.liveToStored = new Map()
    this.prompts = new Map() // key → { kind, sid, liveId, promptId?, serverRequestId?, generation? }
    this.turnStart = new Map()
    this.version = null
  }

  ui(evt) {
    this.emit('ui', { ...evt, conn: this.id })
  }

  setState(state, detail = '') {
    if (state === this.state && detail === this.detail) { return }
    this.state = state
    this.detail = detail
    this.log.info(`[${this.id}] estado ${state}${detail ? ' · ' + detail : ''}`)
    this.ui({ kind: 'conn', state, detail })
    this.emit('state', state)
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    if (this.socket) { this.socket.close(1000, 'bye') }
    this.socket = null
    this.transport.dispose()
  }

  /** Reintento inmediato (tras iniciar sesión o al pulsar «Reintentar»). */
  retryNow() {
    clearTimeout(this.retryTimer)
    this.attempt = 0
    if (!this.stopped && !this.socket) { this.connect() }
  }

  async connect() {
    if (this.stopped || this.connecting || this.socket) { return }
    this.connecting = true
    this.setState('connecting', this.state === 'offline' ? this.detail : '')
    try {
      const target = await this.transport.wsTarget()
      const sock = new RpcSocket({ url: target.url, protocols: target.protocols, name: this.id, log: this.log })
      sock.on('event', ev => this.onEvent(ev))
      sock.on('request', rq => this.onServerRequest(sock, rq))
      sock.on('close', info => this.onClose(sock, info))
      const ready = await sock.open()
      if (this.stopped) { sock.close(1000); return }
      this.socket = sock
      this.canonical = ready.session_authority === true
      this.live.clear()
      this.liveToStored.clear()
      for (const key of [...this.prompts.keys()]) { this.dropPrompt(key) }
      try { await sock.request('client.capabilities', { server_requests: true }, 15000) } catch {}
      this.attempt = 0
      this.setState('ready', this.canonical ? 'protocolo nuevo' : 'protocolo clásico')
      this.ui({ kind: 'reconnected' })
    } catch (e) {
      if (e.needLogin) {
        this.setState('login', e.message)
      } else if (e.setup) {
        this.setState('setup', e.message)
      } else if (e.fatal) {
        this.setState('error', e.message)
      } else {
        this.log.warn(`[${this.id}] no conecta: ${e.message}`)
        this.setState('offline', e.message)
        this.transport.invalidate()
        this.scheduleRetry()
      }
    } finally {
      this.connecting = false
    }
  }

  onClose(sock, info) {
    if (sock !== this.socket) { return }
    this.socket = null
    this.log.warn(`[${this.id}] socket cerrado ${info.code} ${info.reason}`)
    for (const [sid] of this.turnStart) { this.ui({ kind: 'turn-lost', sid }) }
    this.turnStart.clear()
    if (this.stopped) { return }
    this.setState('offline', 'Se cortó la conexión; reconectando…')
    this.transport.invalidate()
    this.scheduleRetry(true)
  }

  scheduleRetry(fast = false) {
    clearTimeout(this.retryTimer)
    const ms = fast ? 700 : BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]
    this.retryTimer = setTimeout(() => this.connect(), ms)
  }

  waitReady(ms = 25000) {
    if (this.state === 'ready' && this.socket) { return Promise.resolve() }
    if (this.state === 'login') { return Promise.reject(Object.assign(new Error(this.detail || 'Hay que iniciar sesión'), { needLogin: true })) }
    if (this.state === 'error' || this.state === 'setup') { return Promise.reject(new Error(this.detail)) }
    if (!this.connecting && !this.socket) { this.retryNow() }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off('state', on); reject(new Error(`Sin conexión con ${this.name}${this.detail ? ': ' + this.detail : ''}`)) }, ms)
      const on = s => {
        if (s === 'ready') { clearTimeout(t); this.off('state', on); resolve() }
        if (s === 'login' || s === 'error' || s === 'setup') { clearTimeout(t); this.off('state', on); reject(Object.assign(new Error(this.detail), { needLogin: s === 'login' })) }
      }
      this.on('state', on)
    })
  }

  async rpc(method, params, timeoutMs) {
    await this.waitReady()
    return this.socket.request(method, params, timeoutMs)
  }

  // ── Eventos del gateway ────────────────────────────────────────────────────────────────────

  storedOf(liveId, payload) {
    return this.liveToStored.get(liveId) || (payload && str(payload.stored_session_id)) || liveId
  }

  bind(storedId, liveId, extra = {}) {
    const prev = this.live.get(storedId) || {}
    const rec = { ...prev, liveId, ...extra }
    this.live.set(storedId, rec)
    this.liveToStored.set(liveId, storedId)
    return rec
  }

  onEvent(ev) {
    const type = ev.type
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
    if (type === 'gateway.ready') { return }
    if (type === 'sessions.changed') { this.ui({ kind: 'sessions-changed' }); return }
    const liveId = ev.session_id
    if (!liveId) { return }
    const sid = this.storedOf(liveId, p)
    const rec = this.live.get(sid)
    const gen = typeof ev.execution_generation === 'number' ? ev.execution_generation : typeof p.execution_generation === 'number' ? p.execution_generation : null
    if (rec && gen !== null && gen >= (rec.generation ?? -1)) { rec.generation = gen }

    switch (type) {
      case 'session.info':
        if (p.stored_session_id && p.stored_session_id !== liveId && !this.liveToStored.has(liveId)) { this.bind(p.stored_session_id, liveId) }
        if (typeof p.running === 'boolean') {
          if (rec) { rec.running = p.running }
          this.ui({ kind: 'running', sid, running: p.running })
        }
        if (p.model) { this.ui({ kind: 'info', sid, model: str(p.model), provider: str(p.provider), contextMax: p.context_length || null }) }
        break
      case 'message.start':
        this.turnStart.set(sid, Date.now())
        this.ui({ kind: 'turn-start', sid })
        break
      case 'message.delta':
        if (typeof p.text === 'string' && p.text) { this.ui({ kind: 'delta', sid, text: p.text }) } else if (p.text === null) { this.ui({ kind: 'segment', sid }) }
        break
      case 'message.interim':
        if (!p.already_streamed && str(p.text)) { this.ui({ kind: 'delta', sid, text: p.text }) }
        this.ui({ kind: 'segment', sid })
        break
      case 'reasoning.delta':
        if (str(p.text)) { this.ui({ kind: 'reasoning', sid, text: p.text }) }
        break
      case 'reasoning.available':
        if (str(p.text)) { this.ui({ kind: 'reasoning', sid, text: p.text, full: true }) }
        break
      case 'thinking.delta':
        this.ui({ kind: 'thinking', sid, text: str(p.text) })
        break
      case 'status.update':
        if (str(p.text)) { this.ui({ kind: 'status', sid, text: cut(p.text, 160), statusKind: str(p.kind) }) }
        break
      case 'tool.generating':
        this.ui({ kind: 'tool', sid, phase: 'generating', id: str(p.tool_id), name: str(p.name) })
        break
      case 'tool.start':
        this.ui({ kind: 'tool', sid, phase: 'start', id: str(p.tool_id), name: str(p.name), args: argsSummary(p.args, p.args_text || p.preview) })
        break
      case 'tool.progress':
        this.ui({ kind: 'tool', sid, phase: 'progress', id: str(p.tool_id), name: str(p.name), percent: typeof p.percent === 'number' ? p.percent : null, message: str(p.message) })
        break
      case 'tool.complete':
        this.ui({ kind: 'tool', sid, phase: 'complete', id: str(p.tool_id), name: str(p.name), summary: cut(str(p.summary || p.result_text).replace(/\s+/g, ' ').trim(), 200), seconds: typeof p.duration_s === 'number' ? p.duration_s : null })
        break
      case 'message.complete': {
        const started = this.turnStart.get(sid)
        this.turnStart.delete(sid)
        const u = p.usage && typeof p.usage === 'object' ? p.usage : {}
        this.ui({ kind: 'complete', sid, text: str(p.text || p.content), status: str(p.status), outcome: str(p.outcome), reasoning: str(p.reasoning), ms: started ? Date.now() - started : null, out: Number(u.output || u.completion || 0) || null })
        break
      }
      case 'session.usage':
        this.ui({ kind: 'usage', sid, used: p.context_tokens || null, max: p.context_length || null, out: Number(p.output_tokens) || null })
        break
      case 'session.title':
        if (str(p.title)) { this.ui({ kind: 'title', sid, title: p.title }) }
        break
      case 'error':
        this.ui({ kind: 'error', sid, message: str(p.message) || 'Error de Hermes' })
        break
      case 'approval.request':
        this.addPrompt(`c:${p.prompt_id}`, { kind: 'approval', sid, liveId, promptId: str(p.prompt_id), generation: typeof p.execution_generation === 'number' ? p.execution_generation : gen, command: str(p.command), description: str(p.description), choices: Array.isArray(p.choices) ? p.choices : ['once', 'deny'] })
        break
      case 'clarify.request':
        this.addPrompt(`c:${p.prompt_id}`, { kind: 'clarify', sid, liveId, promptId: str(p.prompt_id), generation: typeof p.execution_generation === 'number' ? p.execution_generation : gen, questions: [{ qid: str(p.prompt_id), question: str(p.question), choices: Array.isArray(p.choices) ? p.choices : [], multi: Boolean(p.multi_select) }] })
        break
      case 'approval.settled':
      case 'clarify.settled':
        if (p.prompt_id) { this.dropPrompt(`c:${p.prompt_id}`) }
        break
      case 'approval.cancelled':
        for (const rid of Array.isArray(p.request_ids) ? p.request_ids : []) { this.dropPrompt(`c:${rid}`); this.dropPrompt(`l:${rid}`) }
        break
      default:
        break
    }
  }

  onServerRequest(sock, rq) {
    const p = rq.params || {}
    if (rq.method === 'approval' || rq.method === 'clarify') {
      const liveId = str(p.session_id) || str(p.gateway_session_id)
      const sid = liveId ? this.storedOf(liveId, p) : null
      const key = `l:${p.request_id || rq.id}`
      if (rq.method === 'approval') {
        const choices = Array.isArray(p.choices) && p.choices.length ? p.choices
          : ['once', ...(p.allow_session === false ? [] : ['session']), ...(p.allow_permanent === false ? [] : ['always']), 'deny']
        this.addPrompt(key, { kind: 'approval', sid, liveId, serverRequestId: rq.id, sock, command: str(p.command), description: str(p.description), choices })
      } else {
        const qs = Array.isArray(p.questions) ? p.questions : []
        this.addPrompt(key, { kind: 'clarify', sid, liveId, serverRequestId: rq.id, sock, questions: qs.map(q => ({ qid: str(q.qid), question: str(q.question), choices: Array.isArray(q.choices) ? q.choices : [], multi: Boolean(q.multi_select) })) })
      }
      return
    }
    // Lo demás (sudo, secretos, tutoriales, vista previa…) no existe en esta app: se rechaza al
    // momento para que Hermes no se quede esperando hasta su plazo.
    sock.respondError(rq.id, -32601, 'not supported by Pedila')
  }

  addPrompt(key, prompt) {
    this.prompts.set(key, prompt)
    const { sock, kind, serverRequestId, liveId, generation, promptId, ...pub } = prompt
    this.ui({ ...pub, kind: 'prompt', promptKind: kind, key })
  }

  dropPrompt(key) {
    const pr = this.prompts.get(key)
    if (!pr) { return }
    this.prompts.delete(key)
    this.ui({ kind: 'prompt-done', key, sid: pr.sid })
  }

  // ── Acciones ───────────────────────────────────────────────────────────────────────────────

  /** Todos los chats (de 100 en 100: el gateway no admite más por página). */
  async allSessions(max = 1000, archived = 'exclude') {
    const rows = []
    for (let off = 0; off < max; off += 100) {
      const r = await this.transport.fetchJson(`/api/sessions?limit=100&offset=${off}&min_messages=1&archived=${archived}`)
      if (r.status !== 200 || !r.json) { throw new Error(`No pude leer la lista de chats (${r.status})`) }
      const page = r.json.sessions || []
      rows.push(...page)
      if (page.length < 100) { break }
    }
    return rows.filter(s => !s.hidden).map(sessionRow)
  }

  async listSessions() {
    return (await this.allSessions(300)).filter(s => !s.archived)
  }

  async archived() {
    return this.allSessions(1000, 'only')
  }

  /** Búsqueda en el texto de todos los chats (la del propio gateway). */
  async search(q) {
    const r = await this.transport.fetchJson(`/api/sessions/search?q=${encodeURIComponent(q)}`)
    if (r.status !== 200 || !r.json) { throw new Error(`No pude buscar (${r.status})`) }
    return (r.json.results || []).map(x => ({ id: str(x.session_id), snippet: cut(str(x.snippet).replace(/>>>|<<</g, '').replace(/\s+/g, ' ').trim(), 160), role: str(x.role), lastActive: x.last_active || x.session_started || null, model: str(x.model) })).filter(x => x.id)
  }

  /**
   * Cambios protegidos sobre un chat guardado (como Hermes Desktop): primero se lee
   * /mutation-snapshot (revisión y generación) y el cambio lleva esa identidad; sin ella, el
   * gateway responde 409 y no cambia nada.
   */
  async mutate(sid, method, payload = {}) {
    const base = `/api/sessions/${encodeURIComponent(sid)}`
    const snap = await this.transport.fetchJson(`${base}/mutation-snapshot`)
    let identity = {}
    if (snap.status === 200 && snap.json && Number.isSafeInteger(snap.json.runtime_revision)) {
      if (!snap.json.exists && method === 'DELETE') { return { ok: true, gone: true } }
      identity = { request_id: crypto.randomUUID(), expected_revision: snap.json.runtime_revision }
      if (snap.json.exists && Number.isSafeInteger(snap.json.runtime_generation)) { identity.expected_generation = snap.json.runtime_generation }
    } else if (snap.status === 404 && method === 'DELETE') {
      return { ok: true, gone: true }
    }
    const r = method === 'DELETE'
      ? await this.transport.fetchJson(`${base}${Object.keys(identity).length ? '?' + new URLSearchParams(Object.entries(identity).map(([k, v]) => [k, String(v)])) : ''}`, { method })
      : await this.transport.fetchJson(base, { method, body: { ...payload, ...identity } })
    if (r.status >= 300) {
      const why = r.json && (r.json.detail || r.json.error || r.json.message)
      throw new Error(`Hermes no aceptó el cambio (${r.status}${why ? ': ' + (typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 120) : ''})`)
    }
    if (method === 'DELETE') {
      const live = this.live.get(sid)
      if (live) { this.liveToStored.delete(live.liveId); this.live.delete(sid) }
    }
    return { ok: true }
  }

  rename(sid, title) { return this.mutate(sid, 'PATCH', { title }) }
  setPinned(sid, pinned) { return this.mutate(sid, 'PATCH', { pinned }) }
  setArchived(sid, archived) { return this.mutate(sid, 'PATCH', archived ? { archived, pinned: false } : { archived }) }
  remove(sid) { return this.mutate(sid, 'DELETE') }

  /** Sube una imagen para el próximo mensaje de ese chat (image.attach_bytes, en los dos protocolos). */
  async attachImage(sid, base64, filename) {
    const rec = await this.attach(sid)
    const r = await this.socket.request('image.attach_bytes', { session_id: rec.liveId, content_base64: base64, filename }, 120000)
    return { path: str(r && r.path), mime: str(r && (r.mime || r.mime_type)) }
  }

  async transcript(sid) {
    const r = await this.transport.fetchJson(`/api/sessions/${encodeURIComponent(sid)}/messages?limit=400&order=latest`)
    if (r.status === 404) { return [] }
    if (r.status !== 200 || !r.json) { throw new Error(`No pude leer el chat (${r.status})`) }
    return normalizeTranscript(r.json.messages || [])
  }

  async modelOptions() {
    const r = await this.rpc('model.options', {}, 30000)
    const providers = (Array.isArray(r && r.providers) ? r.providers : []).map(pv => ({
      id: str(pv.slug || pv.id || pv.provider || pv.name),
      name: str(pv.name || pv.label || pv.slug || pv.id),
      local: isLocalUrl(pv.api_url || pv.base_url),
      models: (Array.isArray(pv.models) ? pv.models : []).map(m => (typeof m === 'string' ? { id: m, name: m } : { id: str(m.id || m.model || m.name), name: str(m.name || m.label || m.id || m.model) })).filter(m => m.id)
    })).filter(pv => pv.id && pv.models.length)
    const curProvider = str(r && r.provider)
    const cur = providers.find(pv => pv.id.toLowerCase() === curProvider.toLowerCase())
    return {
      current: { model: str(r && r.model), provider: curProvider, local: Boolean(cur && cur.local) },
      providers: [...providers.filter(pv => pv.local), ...providers.filter(pv => !pv.local)]
    }
  }

  /** Engancha el chat al socket (resume) para poder escribir y recibir sus eventos en vivo. */
  async attach(sid) {
    await this.waitReady()
    const rec = this.live.get(sid)
    if (rec && rec.liveId) { return rec }
    const params = this.canonical ? { session_id: sid } : { session_id: sid, cols: COLS }
    const snap = await this.socket.request('session.resume', params, 90000)
    const liveId = str(snap && snap.session_id) || sid
    const out = this.bind(sid, liveId, {
      generation: typeof (snap && snap.execution_generation) === 'number' ? snap.execution_generation : (snap && snap.info && snap.info.execution_generation) ?? null,
      running: Boolean(snap && (snap.running || (snap.info && snap.info.running)))
    })
    if (snap && snap.stored_session_id && snap.stored_session_id !== sid) { this.liveToStored.set(liveId, sid) }
    // Permisos y preguntas que ya estaban esperando (protocolo nuevo: van en el snapshot).
    for (const pr of Array.isArray(snap && snap.prompts) ? snap.prompts : []) {
      this.onEvent({ type: `${pr.kind}.request`, session_id: liveId, payload: pr })
    }
    // Protocolo clásico: las peticiones que seguían abiertas vuelven dentro de la respuesta
    // (`open_requests`), igual que las reentrega json-rpc-channel.ts de Hermes Desktop.
    for (const rq of Array.isArray(snap && snap.open_requests) ? snap.open_requests : []) {
      if (rq && rq.id !== undefined && typeof rq.method === 'string') { this.onServerRequest(this.socket, { id: rq.id, method: rq.method, params: rq.params || {} }) }
    }
    this.ui({ kind: 'running', sid, running: out.running })
    return out
  }

  async newChat({ model, provider, reasoning } = {}) {
    await this.waitReady()
    const params = this.canonical
      ? { request_id: crypto.randomUUID(), source: 'gui' }
      : { source: 'gui', cols: COLS }
    if (model) { params.model = model }
    if (model && provider) { params.provider = provider }
    if (reasoning) { params[this.canonical ? 'reasoning' : 'reasoning_effort'] = reasoning }
    const snap = await this.socket.request('session.create', params, 90000)
    const liveId = str(snap.session_id)
    const stored = str(snap.stored_session_id) || liveId
    this.bind(stored, liveId, { generation: typeof snap.execution_generation === 'number' ? snap.execution_generation : null, running: false })
    return { sid: stored }
  }

  async send(sid, text, attachments = []) {
    const rec = await this.attach(sid)
    const params = this.canonical
      ? { session_id: rec.liveId, text, submission_id: crypto.randomUUID() }
      : { session_id: rec.liveId, text }
    // Protocolo nuevo: las imágenes subidas van nombradas en el envío; en el clásico ya quedaron en cola.
    const files = attachments.filter(a => a && a.path && a.mime)
    if (this.canonical && files.length) { params.attachments = files.map(a => ({ path: a.path, mime: a.mime })) }
    return this.socket.request('prompt.submit', params, 120000)
  }

  async interrupt(sid) {
    const rec = this.live.get(sid)
    if (!rec || !this.socket) { return { ok: false } }
    const params = { session_id: rec.liveId }
    if (this.canonical) {
      if (typeof rec.generation !== 'number') { throw new Error('Todavía no sé qué turno parar; prueba otra vez en un segundo') }
      params.execution_generation = rec.generation
    }
    return this.socket.request('session.interrupt', params, 30000)
  }

  async answer(key, value) {
    const pr = this.prompts.get(key)
    if (!pr) { return { ok: false, gone: true } }
    if (pr.kind === 'approval' && !(Array.isArray(pr.choices) ? pr.choices : ['once', 'deny']).includes(value)) { throw new Error('respuesta de permiso no válida') }
    if (pr.kind === 'clarify' && !(typeof value === 'string' || (value && typeof value === 'object'))) { throw new Error('respuesta no válida') }
    if (pr.serverRequestId !== undefined) {
      const result = pr.kind === 'approval' ? { choice: value } : { answers: value, outcome: 'submitted' }
      pr.sock.respond(pr.serverRequestId, result)
      this.dropPrompt(key)
      return { ok: true }
    }
    const rec = this.live.get(pr.sid) || {}
    const generation = typeof pr.generation === 'number' ? pr.generation : rec.generation
    const params = { session_id: pr.liveId, execution_generation: generation, prompt_id: pr.promptId }
    if (pr.kind === 'approval') { params.choice = value } else { params.answer = typeof value === 'string' ? value : Object.values(value || {})[0] ?? '' }
    await this.rpc(pr.kind === 'approval' ? 'approval.respond' : 'clarify.respond', params, 30000)
    this.dropPrompt(key)
    return { ok: true }
  }

  publicState() {
    return { id: this.id, name: this.name, state: this.state, detail: this.detail, canonical: this.canonical }
  }
}

module.exports = { Connection, normalizeTranscript, sessionRow, argsSummary, isLocalUrl }
