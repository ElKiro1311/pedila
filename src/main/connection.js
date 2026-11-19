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
const { modelUsageFrom } = require('./extras')

const BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000]
// Las estadísticas por modelo de Hermes: el último año, refrescadas cada 5 min como mucho (a
// Hermes le cuesta calcularlas); si ese Hermes no las tiene, no se vuelven a pedir en 30 min, y
// tras un fallo pasajero, en 2 min.
const MODEL_STATS_DAYS = 365
const MODEL_STATS_TTL = 5 * 60000
const MODEL_STATS_MISSING_TTL = 30 * 60000
const MODEL_STATS_FAIL_PAUSE = 2 * 60000
const COLS = 100

const str = v => (typeof v === 'string' ? v : '')
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// El complemento de Hermes que lee las cuotas (carpeta hermes-plugin/pedila de este repositorio).
const QUOTA_PLUGIN = 'pedila'
const QUOTA_PLUGIN_SOURCE = 'ElKiro1311/pedila/hermes-plugin/pedila'
const QUOTA_KINDS = ['openrouter', 'venice', 'opencode-go', 'opencode-zen']
const INSTALL_TIMEOUT = 180000

/** ¿Qué API de pago es, por su dirección? (las mismas reglas que el complemento). */
function paidKindOf(u) {
  try {
    const p = new URL(String(u || ''))
    const h = p.hostname.toLowerCase()
    if (h === 'openrouter.ai' || h.endsWith('.openrouter.ai')) { return 'openrouter' }
    if (h === 'api.venice.ai' || h.endsWith('.venice.ai')) { return 'venice' }
    if (h === 'opencode.ai' || h.endsWith('.opencode.ai')) { return p.pathname.toLowerCase().includes('/go') ? 'opencode-go' : 'opencode-zen' }
  } catch {}
  return null
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isoOf = v => (typeof v === 'string' && v && Number.isFinite(Date.parse(v)) ? v : null)

/** La respuesta del complemento, limpia: solo los campos y tipos que la pantalla sabe pintar. */
function quotaData(j) {
  const spentOf = s => {
    if (!s || typeof s !== 'object') { return null }
    const one = p => (p && typeof p === 'object' ? { tokens: num(p.tokens) || 0, calls: num(p.calls) || 0, cost: num(p.cost) || 0 } : { tokens: 0, calls: 0, cost: 0 })
    return { day: one(s.day), week: one(s.week), month: one(s.month) }
  }
  const providers = (Array.isArray(j.providers) ? j.providers : []).filter(p => p && QUOTA_KINDS.includes(p.kind)).slice(0, 12).map(p => {
    const o = { kind: p.kind, name: cut(str(p.name) || p.kind, 40), ok: p.ok !== false, error: p.ok === false ? cut(str(p.error) || 'no se pudo leer', 200) : '', noApi: Boolean(p.no_api), spent: spentOf(p.spent) }
    if (p.kind === 'openrouter') {
      const kl = p.key_limit && typeof p.key_limit === 'object' ? p.key_limit : null
      const ku = p.key_usage && typeof p.key_usage === 'object' ? p.key_usage : {}
      Object.assign(o, {
        balance: num(p.balance), creditsTotal: num(p.credits_total), creditsUsed: num(p.credits_used),
        freeTier: typeof p.free_tier === 'boolean' ? p.free_tier : null,
        keyLimit: kl && num(kl.limit) ? { limit: num(kl.limit), remaining: num(kl.remaining), reset: ['daily', 'weekly', 'monthly'].includes(kl.reset) ? kl.reset : null } : null,
        keyUsage: { total: num(ku.total), day: num(ku.day), week: num(ku.week), month: num(ku.month) }
      })
    } else if (p.kind === 'venice') {
      Object.assign(o, {
        usd: num(p.usd), diem: num(p.diem), bundled: num(p.bundled), tier: cut(str(p.tier), 30),
        access: typeof p.access === 'boolean' ? p.access : null, nextEpoch: isoOf(p.next_epoch), keyExpires: isoOf(p.key_expires),
        modelLimits: (Array.isArray(p.model_limits) ? p.model_limits : []).slice(0, 12).filter(m => m && typeof m.model === 'string')
          .map(m => ({ model: cut(m.model, 80), rpm: num(m.rpm), rpd: num(m.rpd), tpm: num(m.tpm) }))
      })
    } else if (p.kind === 'opencode-go') {
      o.windows = (Array.isArray(p.windows) ? p.windows : []).slice(0, 4).filter(w => w && num(w.percent) !== null)
        .map(w => ({ id: cut(str(w.id), 20), label: cut(str(w.label), 20), percent: Math.max(0, Math.min(100, num(w.percent))), resetsAt: isoOf(w.resets_at) }))
    }
    return o
  })
  return { version: cut(str(j.version), 20), fetchedAt: isoOf(j.fetched_at), providers }
}

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

// ── Lista de tareas de Hermes (su herramienta todo_list, como la de Claude Code) ────────────────
const TODO_TOOLS = new Set(['todo_list', 'todo'])
const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled']

/** {todos, revision} limpio para la interfaz, o null (una lista vacía sin revisión = no hay plan). */
function todoSnapshot(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.todos)) { return null }
  const todos = v.todos.filter(t => t && typeof t === 'object').slice(0, 256).map(t => ({
    id: cut(str(t.id) || String(t.id ?? '') || '?', 80),
    content: cut(str(t.content).replace(/\s+/g, ' ').trim(), 400),
    status: TODO_STATUSES.includes(t.status) ? t.status : 'pending',
    parent: cut(str(t.parent), 80)
  })).filter(t => t.content)
  const n = Number(v.revision)
  const revision = Number.isFinite(n) ? n : null
  if (!todos.length && !revision) { return null }
  return { todos, revision }
}

/** ¿Es una llamada a la lista de tareas? También a través de `tool_call`, el puente del buscador de herramientas. */
function isTodoCall(c) {
  const fn = c && c.function ? c.function : c || {}
  const name = str(fn.name || (c && c.name))
  if (TODO_TOOLS.has(name)) { return true }
  if (name !== 'tool_call') { return false }
  let args = fn.arguments ?? (c && c.args)
  try {
    if (typeof args === 'string') { args = JSON.parse(args) }
    let calls = args && (args.calls ?? (args.name ? [{ name: args.name }] : null))
    if (typeof calls === 'string') { calls = JSON.parse(calls) }
    if (calls && !Array.isArray(calls)) { calls = [calls] }
    return Array.isArray(calls) && calls.length === 1 && TODO_TOOLS.has(str(calls[0] && calls[0].name))
  } catch { return false }
}

/**
 * La lista de tareas de un chat guardado: el resultado más reciente de una llamada a la herramienta
 * (como hace Hermes al reanudar). Un resultado suelto sin su llamada no cuenta.
 */
function todoStateOf(rows) {
  const ids = new Set()
  for (const r of rows) {
    if (!r || r.role !== 'assistant' || !Array.isArray(r.tool_calls)) { continue }
    for (const c of r.tool_calls) { if (c && (c.id || c.tool_call_id) && isTodoCall(c)) { ids.add(c.id || c.tool_call_id) } }
  }
  if (!ids.size) { return null }
  const newest = [...rows].filter(r => r && r.role === 'tool' && ids.has(r.tool_call_id)).sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
  // Como Hermes: manda el resultado legible más nuevo, aunque sea una lista vacía (entonces, sin plan).
  for (const r of newest) {
    const text = contentText(r.content)
    if (!text.includes('"todos"') || text.length > 512000) { continue }
    let data
    try { data = JSON.parse(text) } catch { continue }
    return todoSnapshot(data)
  }
  return null
}

function toolCallsOf(row) {
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : []
  return calls.map(c => {
    const fn = c && c.function ? c.function : c || {}
    let args = fn.arguments ?? c.args
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = { _: args } } }
    return { id: c.id || c.tool_call_id || '', name: str(fn.name || c.name) || 'herramienta', args: argsSummary(args), input: boundInput(args) }
  })
}

// ── Detalle de las herramientas (como en Claude Code: qué se le pasó y qué devolvió) ─────────
const MAX_FIELD = 6000 // cada texto que se le pasó a una herramienta
const MAX_OUTPUT = 8000 // lo que devolvió

/** Copia acotada de lo que se le pasó a una herramienta (textos largos recortados, sin ciclos). */
function boundInput(v, depth = 0, max = MAX_FIELD) {
  if (typeof v === 'string') { return v.length > max ? v.slice(0, max) + '\n… (recortado)' : v }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') { return v }
  if (depth > 4) { return '…' }
  if (Array.isArray(v)) { return v.slice(0, 60).map(x => boundInput(x, depth + 1, max)) }
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).slice(0, 40)) { out[k] = boundInput(v[k], depth + 1, max) }
    return out
  }
  return null
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const capText = s => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n… (recortado)' : s)

/**
 * Lo que devolvió una herramienta de Hermes, para leerlo: { text, error }.
 * Hermes guarda los resultados como JSON; el de la terminal trae output, exit_code y error.
 * El fallo se decide como en Hermes (agent/display.py _detect_tool_failure), solo por su forma.
 */
// Las mismas reglas que Hermes (agent/display.py _detect_tool_failure y
// agent/tool_result_classification.py): fallo por la forma del JSON o, si no es JSON, por el texto.
const FAILURE_MARKER = /"(?:error|failed)"(?!\s*:\s*(?:null|false|0|""|\[\]|\{\})\s*(?:[,}\]]|$))/gi
function hermesFailed(name, raw, data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // Un archivo escrito o un parche aplicado de verdad nunca es un fallo.
    if (name === 'write_file' && !data.error && 'bytes_written' in data) { return false }
    if (name === 'patch' && !data.error && data.success === true) { return false }
    // Una negativa del arnés (llamada repetida) no es un fallo.
    if (data.guardrail_refusal === true) { return false }
    if (data.user_summary) { return true }
    if (name === 'terminal') { const ec = data.exit_code; return !(ec === undefined || ec === null || ec === 0) }
    const err = data.error || data.message
    if (err && (data.success === false || 'error' in data)) { return true }
    if (['failed', 'error'].includes(String(data.status || '').toLowerCase())) { return true }
    const items = data.results
    if (Array.isArray(items) && items.length && items.every(i => i && typeof i === 'object' && !Array.isArray(i)) && items.every(i => i.error)) { return true }
    return false
  }
  if (!raw) { return false }
  if (raw.startsWith('Error')) { return true }
  const head = raw.slice(0, 600)
  FAILURE_MARKER.lastIndex = 0
  let m
  while ((m = FAILURE_MARKER.exec(head))) { if (m.index < 500) { return true } }
  return false
}

/** De un JSON cortado por Hermes ({"output": "<json recortado>", "truncated": true}), el texto de dentro. */
function innerText(s) {
  const m = /"(?:output|stdout|content|result|error)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s)
  if (!m) { return s }
  try { return JSON.parse('"' + m[1].replace(/\\$/, '') + '"') } catch { return m[1].replace(/\\n/g, '\n') }
}

function hermesToolOutput(name, result, isError) {
  const raw = typeof result === 'string' ? result : result === undefined || result === null ? '' : JSON.stringify(result)
  let data = null
  if (result && typeof result === 'object') { data = result } else if (/^\s*[{[]/.test(raw)) { try { data = JSON.parse(raw) } catch {} }
  const error = typeof isError === 'boolean' ? isError : hermesFailed(name, raw, data)
  let text = raw
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.truncated === true && (typeof data.output === 'string' || typeof data.error === 'string')) {
      // Recortado por Hermes: lo de dentro suele ser otro JSON; se saca su texto.
      text = innerText(str(data.output || data.error)) + '\n… (Hermes lo recortó)'
    } else if (typeof data.output === 'string' || typeof data.stdout === 'string') {
      const bits = [str(data.output || data.stdout)]
      if (str(data.stderr)) { bits.push(str(data.stderr)) }
      if (data.error) { bits.push('Error: ' + (typeof data.error === 'string' ? data.error : JSON.stringify(data.error))) }
      if (data.exit_code !== undefined && data.exit_code !== null && data.exit_code !== 0) { bits.push(`(terminó con el código ${data.exit_code})`) }
      text = bits.filter(Boolean).join('\n')
    } else if (data.user_summary) {
      text = str(data.user_summary)
    } else if (error && typeof data.error === 'string') {
      text = data.error
    } else if (typeof data.content === 'string') {
      text = data.content
    } else if (typeof data.result === 'string') {
      // Herramientas MCP: {"result": texto}.
      text = data.result
    } else {
      try { text = JSON.stringify(data, null, 2) } catch {}
    }
  }
  return { text: capText(text.replace(ANSI, '')), error }
}

/** Imágenes que vienen dentro de un mensaje (partes image_url con data:): [{url, name}]. */
function contentImages(c) {
  if (!Array.isArray(c)) { return [] }
  const out = []
  for (const p of c) {
    const url = p && (p.type === 'image_url' ? str(p.image_url && (p.image_url.url || p.image_url)) : p.type === 'image' && p.source && p.source.type === 'base64' ? `data:${str(p.source.media_type) || 'image/png'};base64,${str(p.source.data)}` : '')
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/.test(url) && url.length < 6 * 1024 * 1024) { out.push({ url, name: 'imagen' }) }
    if (out.length >= 6) { break }
  }
  return out
}

// Filas de «usuario» que en realidad escribe Hermes (resúmenes de memoria, avisos de procesos o de
// subagentes): se enseñan como una nota plegable, no como un mensaje tuyo.
const NOTE_KINDS = { internal_notification: 'Aviso de Hermes', process_complete: 'Terminó un proceso', async_delegation_complete: 'Terminó un subagente', model_switch: 'Cambio de modelo' }
// Marcas de agent/context_compressor.py: al compactar, Hermes junta el resumen con un mensaje tuyo
// en la misma fila (delante, o con el mensaje de antes como «PRIOR CONTEXT»).
const SUMMARY_END = '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
const PRIOR_HEAD = '[PRIOR CONTEXT — for reference only; not a new message]'
const PRIOR_DELIM = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]'
/** { summary, message } si la fila trae un resumen de compactación; null si no. */
function splitCompaction(raw) {
  const i = raw.indexOf(SUMMARY_END)
  if (i >= 0) { return { summary: raw.slice(0, i).trim(), message: raw.slice(i + SUMMARY_END.length).trim() } }
  const j = raw.indexOf(PRIOR_DELIM)
  if (raw.startsWith(PRIOR_HEAD) && j >= 0) { return { summary: raw.slice(j + PRIOR_DELIM.length).trim(), message: raw.slice(PRIOR_HEAD.length, j).trim() } }
  if (/^\[CONTEXT COMPACTION/.test(raw)) { return { summary: raw, message: '' } }
  return null
}
const compactionNote = (r, text) => ({ role: 'note', kind: 'compaction', title: 'Hermes resumió la conversación anterior para que quepa', text, ts: r.timestamp || null })
function noteOf(r, text) {
  if (NOTE_KINDS[r.display_kind]) { return { role: 'note', kind: r.display_kind, title: NOTE_KINDS[r.display_kind], text, ts: r.timestamp || null } }
  return null
}

/** Filas guardadas de /api/sessions/{id}/messages → turnos para la interfaz. */
const MAX_TRANSCRIPT_IMAGES = 8 * 1024 * 1024
function normalizeTranscript(rows) {
  const out = []
  let turn = null
  let imageBytes = 0
  const sorted = [...rows].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  for (const r of sorted) {
    if (!r || r.active === false || r.display_kind === 'hidden') { continue }
    if (r.role === 'user') {
      turn = null
      const raw = contentText(r.content)
      const note = raw.trim() ? noteOf(r, raw) : null
      if (note) { out.push(note); continue }
      // Lo que se enseña es display_content si Hermes lo da (como Hermes Desktop): el mensaje tuyo
      // sin los envoltorios (resumen de compactación, «OUT-OF-BAND USER MESSAGE»…).
      const hasDisplay = r.display_content !== undefined && r.display_content !== null
      const comp = splitCompaction(raw)
      if (comp && comp.summary) { out.push(compactionNote(r, comp.summary)) }
      const text = hasDisplay ? contentText(r.display_content) : comp ? comp.message : raw
      // Imágenes: con un tope para toda la conversación (son base64 y viajan a la pantalla).
      let images = contentImages(hasDisplay ? r.display_content : r.content)
      const bytes = images.reduce((n, x) => n + x.url.length, 0)
      if (imageBytes + bytes > MAX_TRANSCRIPT_IMAGES) { images = [] } else { imageBytes += bytes }
      const shown = images.length ? text.replace(/^\[imagen\]\n?/gm, '').trim() : text
      if (shown.trim() || images.length) { out.push({ role: 'user', text: shown, ts: r.timestamp || null, ...(images.length ? { images } : {}) }) }
    } else if (r.role === 'assistant') {
      if (!turn) { turn = { role: 'assistant', blocks: [], reasoning: '', ts: r.timestamp || null }; out.push(turn) }
      const reasoning = str(r.reasoning || r.reasoning_content)
      if (reasoning) { turn.reasoning += (turn.reasoning ? '\n\n' : '') + reasoning }
      const text = contentText(r.content)
      if (text.trim()) { turn.blocks.push({ type: 'text', text }) }
      for (const c of toolCallsOf(r)) { turn.blocks.push({ type: 'tool', id: c.id, name: c.name, args: c.args, input: c.input, done: false }) }
    } else if (r.role === 'tool') {
      if (!turn) { continue }
      const b = turn.blocks.find(x => x.type === 'tool' && !x.done && (!r.tool_call_id || x.id === r.tool_call_id))
      if (b) {
        const o = hermesToolOutput(b.name, typeof r.content === 'string' ? r.content : contentText(r.content), null)
        b.done = true
        b.summary = cut(o.text.replace(/\s+/g, ' ').trim(), 160)
        b.output = o.text
        b.error = o.error
      }
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
    this.modelStats = null // { at, models } de la última consulta de modelUsage()
    this.modelStatsPending = null
    this.modelStatsFailAt = null // cuándo falló la última (fallo pasajero); null si no falló
    this.modelStatsEpoch = 0 // sube al perder la conexión: lo que llegue de antes ya no vale
  }

  ui(evt) {
    this.emit('ui', { ...evt, conn: this.id })
  }

  setState(state, detail = '') {
    if (state === this.state && detail === this.detail) { return }
    // Al reconectar puede ser otro servidor, otra sesión o un Hermes reiniciado: estadísticas nuevas.
    if (state !== 'ready') { this.forgetModelStats() }
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
    // Sin Hermes en este equipo: se mira en silencio (sin pasar por «conectando», que haría
    // reaparecer la pestaña un momento cada minuto).
    if (this.state === 'missing' && this.transport.available && !this.transport.available()) {
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => this.connect(), 60000)
      return
    }
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
      // Los chats que siguen trabajando se vuelven a seguir enseguida (al abrir o actualizar Pedila):
      // si se quedaran sin nadie mirando, a los 5 min Hermes cortaría sus tareas en segundo plano.
      this.reattachRunning().catch(e => this.log.warn(`[${this.id}] al reengancharme:`, e.message))
    } catch (e) {
      if (e.needLogin) {
        this.setState('login', e.message)
      } else if (e.setup) {
        this.setState('setup', e.message)
      } else if (e.missing) {
        // Este equipo no tiene ese Hermes: la pestaña se oculta. Se mira de nuevo cada minuto por si
        // se instala con Pedila abierta.
        this.setState('missing', e.message)
        clearTimeout(this.retryTimer)
        this.retryTimer = setTimeout(() => this.connect(), 60000)
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
        if (p.model || p.reasoning_effort) { this.ui({ kind: 'info', sid, model: str(p.model), provider: str(p.provider), contextMax: p.context_length || null, effort: str(p.reasoning_effort) }) }
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
        this.ui({ kind: 'tool', sid, phase: 'start', id: str(p.tool_id || p.tool_call_id), name: str(p.name || p.tool_name), args: argsSummary(p.args, p.args_text || p.preview || p.context), input: p.args && typeof p.args === 'object' ? boundInput(p.args) : null })
        break
      case 'tool.progress':
        this.ui({ kind: 'tool', sid, phase: 'progress', id: str(p.tool_id), name: str(p.name), percent: typeof p.percent === 'number' ? p.percent : null, message: str(p.message) })
        break
      case 'tool.complete': {
        // Lo que devolvió (result, o result_text en modo «verbose»), si falló, el cambio de un
        // archivo ya dibujado (inline_diff) y la imagen que produjo o miró (image_path).
        const name = str(p.name || p.tool_name)
        const o = hermesToolOutput(name, p.result !== undefined ? p.result : p.result_text, typeof p.is_error === 'boolean' ? p.is_error : null)
        this.ui({
          kind: 'tool', sid, phase: 'complete', id: str(p.tool_id || p.tool_call_id), name,
          summary: cut(str(p.summary || p.result_text || o.text).replace(/\s+/g, ' ').trim(), 200),
          seconds: typeof p.duration_s === 'number' ? p.duration_s : null,
          output: o.text, error: o.error,
          diff: str(p.inline_diff) ? capText(str(p.inline_diff).replace(ANSI, '')) : '',
          image: str(p.image_path),
          ...(p.args && typeof p.args === 'object' ? { input: boundInput(p.args) } : {})
        })
        const st = Array.isArray(p.todos) ? todoSnapshot(p) : null
        if (st) { this.ui({ kind: 'todos', sid, ...st }) }
        break
      }
      case 'todo.updated': {
        // La lista entera tras cada cambio; la revisión deja descartar los avisos atrasados.
        const st = todoSnapshot(p)
        if (st) { this.ui({ kind: 'todos', sid, ...st }) }
        break
      }
      case 'subagent.spawn_requested':
      case 'subagent.start':
      case 'subagent.progress':
      case 'subagent.tool':
      case 'subagent.complete':
        // Los subagentes (delegate_task); su razonamiento y su texto letra a letra no hacen falta aquí.
        this.ui({
          kind: 'subagent', sid, phase: type.slice(9),
          id: str(p.subagent_id) || `t${Number(p.task_index) || 0}`,
          goal: cut(str(p.goal).replace(/\s+/g, ' ').trim(), 200),
          index: Number(p.task_index) || 0,
          count: Number(p.task_count) || 1,
          status: str(p.status),
          tool: str(p.tool_name),
          text: cut(str(p.text).replace(/\s+/g, ' ').trim(), 160),
          tools: Number.isFinite(p.tool_count) ? p.tool_count : null,
          seconds: typeof p.duration_seconds === 'number' ? p.duration_seconds : null
        })
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

  /**
   * Los tokens de cada modelo según las estadísticas del propio Hermes (GET /api/analytics/usage,
   * las de la página de uso de Hermes Desktop): cuentan todos sus chats y también lo que gastan
   * sus tareas auxiliares (resumir la memoria, poner títulos, ver imágenes…), que la lista de chats
   * no trae. null si este Hermes no las da: entonces el panel suma la lista de chats.
   * Solo se espera la primera vez. Con un valor bueno guardado se devuelve ese al momento y, si
   * tiene más de 5 min, se pide otro por detrás; si ese falla, se sigue con el guardado (así el
   * orden no salta a las cifras de la lista de chats por un fallo suelto).
   */
  async modelUsage(now = Date.now()) {
    const c = this.modelStats
    const fresh = Boolean(c) && now - c.at < (c.models ? MODEL_STATS_TTL : MODEL_STATS_MISSING_TTL)
    const resting = this.modelStatsFailAt !== null && now - this.modelStatsFailAt < MODEL_STATS_FAIL_PAUSE
    if (!fresh && !resting && !this.modelStatsPending) {
      // Una sola consulta a la vez (el panel y «Ver todo» pueden pedirla juntos).
      const p = this.loadModelStats(this.modelStatsEpoch, now)
      const clear = () => { if (this.modelStatsPending === p) { this.modelStatsPending = null } }
      p.then(clear, clear)
      this.modelStatsPending = p
    }
    if (c && c.models) { return c.models }
    if (fresh || resting || !this.modelStatsPending) { return null }
    return this.modelStatsPending
  }

  /**
   * Olvida las estadísticas por modelo, la consulta en curso y la pausa: al perder la conexión o al
   * cambiar la dirección del servidor (con el socket abierto, eso no pasa por setState).
   */
  forgetModelStats() {
    this.modelStats = null
    this.modelStatsPending = null
    this.modelStatsFailAt = null
    this.modelStatsEpoch++
  }

  async loadModelStats(epoch, now) {
    let r
    try {
      r = await this.transport.fetchJson(`/api/analytics/usage?days=${MODEL_STATS_DAYS}`)
    } catch (e) {
      if (epoch === this.modelStatsEpoch) { this.modelStatsFailAt = now }
      throw e
    }
    const models = r.status === 200 ? modelUsageFrom(r.json) : null
    // Si la conexión cayó mientras tanto, la respuesta es de antes: no se guarda.
    if (epoch !== this.modelStatsEpoch) { return models }
    if (models || r.status === 200 || [404, 405, 422].includes(r.status)) {
      // Lo que vale, o «este Hermes no las tiene» (404, 405, 422 o un 200 sin la lista).
      this.modelStats = { at: now, models }
      this.modelStatsFailAt = null
    } else {
      // Un fallo pasajero (5xx…): se sigue con lo guardado y no se reintenta en 2 min.
      this.modelStatsFailAt = now
    }
    return models
  }

  /**
   * Los chats en los que Hermes está trabajando ahora mismo, los empezara quien los empezara
   * (Pedila, Hermes Desktop…), sin engancharse a ellos: `session.active_list`, lo mismo que lee
   * la barra lateral de Hermes Desktop. En el protocolo clásico `id` es el del socket y el
   * guardado va en `session_key`; en el nuevo los dos son el guardado.
   */
  async activeList() {
    const r = await this.rpc('session.active_list', {}, 5000)
    return (Array.isArray(r && r.sessions) ? r.sessions : []).map(x => ({
      // Primero el chat que esta ventana ya tiene enganchado a ese id (tras una compresión o con
      // un chat de varios tramos, el id de Hermes puede no ser el de la fila de la lista).
      id: this.liveToStored.get(str(x && x.id)) || str(x && x.session_key) || str(x && x.id),
      status: str(x && x.status),
      title: str(x && x.title)
    })).filter(x => x.id && ['working', 'waiting', 'starting'].includes(x.status))
  }

  /** Se engancha a los chats en los que Hermes está trabajando ahora (los empezara quien los empezara). */
  async reattachRunning() {
    const list = await this.activeList()
    for (const x of list) {
      if (this.stopped || this.state !== 'ready') { return }
      if (this.live.has(x.id)) { continue }
      try {
        await this.attach(x.id)
        this.log.info(`[${this.id}] sigo el chat ${x.id.slice(0, 12)} («${x.title.slice(0, 40)}»), que estaba trabajando`)
      } catch (e) {
        this.log.warn(`[${this.id}] no pude seguir el chat ${x.id.slice(0, 12)}:`, e.message)
      }
    }
  }

  async archived() {
    return this.allSessions(1000, 'only')
  }

  /**
   * Los subagentes que siguen vivos en un chat enganchado (subagent.list, los dos protocolos), para
   * cerrar en el panel los que ya no existen aunque su aviso de fin no llegara. null si no se puede saber.
   */
  async subagents(sid) {
    const rec = this.live.get(sid)
    if (!rec || !rec.liveId || this.state !== 'ready' || !this.socket) { return null }
    const r = await this.socket.request('subagent.list', { session_id: rec.liveId }, 5000)
    if (!r || !Array.isArray(r.subagents)) { return null }
    return r.subagents.filter(x => x && x.subagent_id).map(x => ({
      id: str(x.subagent_id),
      status: str(x.status),
      tool: str(x.last_tool),
      tools: Number.isFinite(x.tool_count) ? x.tool_count : null
    }))
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

  /** Una imagen que Hermes nombró con «MEDIA:<ruta>» (image_generate, capturas…). La ruta es del equipo
   *  donde corre Hermes, así que se pide a su gateway: GET /api/media solo sirve imágenes de sus carpetas
   *  de medios (images, screenshots, cache) y la devuelve como data URL. */
  async media(file) {
    const r = await this.transport.fetchJson(`/api/media?path=${encodeURIComponent(file)}`)
    const url = r.json && r.json.data_url
    if (r.status !== 200 || typeof url !== 'string' || !/^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(url)) {
      throw new Error(r.status === 403 ? 'la imagen está fuera de las carpetas de Hermes' : r.status === 404 ? 'la imagen ya no existe' : `no pude traer la imagen (${r.status})`)
    }
    return url
  }

  /**
   * Lo que queda de las APIs de pago de este Hermes (OpenRouter, Venice, OpenCode), leído por el
   * complemento «pedila» que corre dentro de Hermes: las claves no salen de allí, solo llegan números.
   * { state: 'ok', data } · { state: 'missing' } si el complemento no está (o no está activado).
   */
  async quotas(fresh = false) {
    const r = await this.transport.fetchJson(`/api/plugins/${QUOTA_PLUGIN}/cuotas${fresh ? '?fresh=1' : ''}`)
    if ([403, 404, 405].includes(r.status) || (r.status === 200 && !(r.json && r.json.plugin === QUOTA_PLUGIN))) { return { state: 'missing' } }
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.providers)) { throw new Error(`Hermes no dio las cuotas (${r.status})`) }
    return { state: 'ok', data: quotaData(r.json) }
  }

  /**
   * Instala y activa el complemento «pedila» en este Hermes con su propia ruta de instalación
   * (la del botón «Instalar» de su página de complementos), sin reiniciarlo. Si el análisis de
   * seguridad de Hermes pone una pega, se devuelve para que la persona decida (`force` = instalar igual).
   */
  async installQuotaPlugin(force = false) {
    // Instalar clona el repositorio y lo analiza: puede tardar bastante más que una consulta.
    const r = await this.transport.fetchJson('/api/dashboard/agent-plugins/install', { method: 'POST', body: { identifier: QUOTA_PLUGIN_SOURCE, enable: true, force: Boolean(force) }, timeoutMs: INSTALL_TIMEOUT })
    const j = r.json || {}
    if (r.status === 200 && j.ok) { return { ok: true, restart: Boolean(j.restart_required) } }
    const detail = str(j.detail) || str(j.error)
    // El análisis de seguridad de Hermes paró la instalación (la ruta lo devuelve como 400 con el informe).
    if (j.scan_blocked || /security scan blocked/i.test(detail)) {
      const report = str(j.scan_verdict) || detail
      const lines = Array.isArray(j.scan_findings)
        ? j.scan_findings.map(f => (typeof f === 'string' ? f : str(f && (f.message || f.description || f.rule || f.pattern))))
        : detail.split(/\r?\n/).slice(1)
      return {
        ok: false,
        scan: /dangerous/i.test(report) ? 'dangerous' : 'caution',
        findings: lines.map(x => x.trim()).filter(x => x && !/^review the findings|scanning can be configured/i.test(x)).slice(0, 12).map(x => cut(x, 300))
      }
    }
    // Ya estaba instalado (por ejemplo, de un intento anterior) pero sin activar: se activa.
    if (/already exists|already installed/i.test(detail)) {
      const e = await this.transport.fetchJson(`/api/dashboard/agent-plugins/${QUOTA_PLUGIN}/enable`, { method: 'POST', body: {} })
      if (e.status === 200) { return { ok: true, restart: Boolean(e.json && e.json.restart_required) } }
      throw new Error(cut(str(e.json && (e.json.detail || e.json.error)) || `Hermes no lo activó (${e.status})`, 300))
    }
    if (r.status === 404 || r.status === 405) { throw new Error('este Hermes no sabe instalar complementos desde fuera (actualízalo)') }
    throw new Error(cut(detail || `Hermes respondió ${r.status}`, 300))
  }

  async transcript(sid) {
    const r = await this.transport.fetchJson(`/api/sessions/${encodeURIComponent(sid)}/messages?limit=400&order=latest`)
    if (r.status === 404) { return [] }
    if (r.status !== 200 || !r.json) { throw new Error(`No pude leer el chat (${r.status})`) }
    const rows = Array.isArray(r.json.messages) ? r.json.messages : []
    // Su lista de tareas, si Hermes hizo una (para el panel, aunque el chat ya no esté en marcha).
    const todos = todoStateOf(rows)
    if (todos) { this.ui({ kind: 'todos', sid, history: true, ...todos }) }
    return normalizeTranscript(rows)
  }

  async modelOptions() {
    const r = await this.rpc('model.options', {}, 30000)
    const providers = (Array.isArray(r && r.providers) ? r.providers : []).map(pv => ({
      id: str(pv.slug || pv.id || pv.provider || pv.name),
      name: str(pv.name || pv.label || pv.slug || pv.id),
      local: isLocalUrl(pv.api_url || pv.base_url),
      paid: paidKindOf(pv.api_url || pv.base_url),
      models: (Array.isArray(pv.models) ? pv.models : []).map(m => (typeof m === 'string' ? { id: m, name: m } : { id: str(m.id || m.model || m.name), name: str(m.name || m.label || m.id || m.model) })).filter(m => m.id)
    })).filter(pv => pv.id && pv.models.length)
    const curProvider = str(r && r.provider)
    const cur = providers.find(pv => pv.id.toLowerCase() === curProvider.toLowerCase())
    return {
      // Las APIs de pago que ese Hermes tiene puestas (para ofrecer activar sus cuotas).
      paid: [...new Set(providers.map(pv => pv.paid).filter(Boolean))],
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
    // La lista de tareas que tenía el chat (los dos protocolos la mandan al reanudar).
    const todos = todoSnapshot(snap && snap.todo_state)
    if (todos) { this.ui({ kind: 'todos', sid, ...todos }) }
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

  /**
   * Cambiar el modelo o el razonamiento de un chat ya empezado, con las órdenes del propio Hermes
   * (`/model <modelo> --provider <p> --session` y `/reasoning <nivel>`) por slash.exec. Hermes las
   * rechaza mientras el chat está respondiendo.
   */
  async setChatOptions(sid, { model, provider, reasoning } = {}) {
    const rec = await this.attach(sid)
    const run = async command => {
      let r
      try {
        r = await this.rpc('slash.exec', { session_id: rec.liveId, command }, 60000)
      } catch (e) {
        if (/32601|method not found|unknown method|unsupported/i.test(e.message || '')) { throw new Error('Este Hermes no deja cambiarlo en un chat ya empezado (empieza uno nuevo).') }
        if (/busy|in progress|running/i.test(e.message || '')) { throw new Error('Hermes está respondiendo en este chat: cámbialo cuando termine.') }
        throw e
      }
      if (r && (r.type === 'error' || r.error)) { throw new Error(str(r.message || r.output || r.error) || 'Hermes no aceptó el cambio') }
      return r
    }
    if (model !== undefined) { await run(model === null ? '/model reset --session' : `/model ${model}${provider ? ' --provider ' + provider : ''} --session`) }
    if (reasoning !== undefined && reasoning) { await run(`/reasoning ${reasoning}`) }
    if (model) { this.ui({ kind: 'info', sid, model, provider: provider || '' }) }
    return { applied: 'now', model: model || null, effort: reasoning || null }
  }

  chatOptions() { return { model: null, effort: null } }

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

module.exports = { quotaData, paidKindOf, Connection, normalizeTranscript, sessionRow, argsSummary, boundInput, hermesToolOutput, hermesFailed, splitCompaction, contentImages, isLocalUrl, todoSnapshot, todoStateOf, isTodoCall }
