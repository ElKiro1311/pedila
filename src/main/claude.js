'use strict'
// Claude Code como chat dentro de Pedila. Pedila solo hace de intermediario: abre TU `claude`
// (con tu cuenta y tus opciones) en modo de mensajes JSON (`-p --input-format stream-json
// --output-format stream-json`), le pasa lo que escribes tal cual y dibuja lo que contesta con la
// misma vista de chat que Hermes. Claude usa sus propias herramientas; Hermes no interviene.
// La lista de chats sale de las conversaciones que Claude Code guarda en ~/.claude/projects, así
// que también aparecen (y se pueden seguir) las empezadas en una consola.
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { argsSummary, boundInput, contentImages } = require('./connection')
const { which, cleanEnv, splitArgs, SID, cmdLine } = require('./terms')
const host = require('./host')

const str = v => (typeof v === 'string' ? v : '')
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const MAX_FILES = 400 // conversaciones más recientes que se listan
const IDLE_MS = 20 * 60 * 1000 // un chat sin usar 20 min suelta su proceso de claude
const MODELS = [
  { id: 'opus', name: 'Opus (el más capaz)' },
  { id: 'sonnet', name: 'Sonnet (rápido y capaz)' },
  { id: 'haiku', name: 'Haiku (el más rápido)' }
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/** El texto que escribió la persona (sin los avisos que Claude Code mete como si fueran del usuario). */
function userText(content) {
  let t = ''
  if (typeof content === 'string') { t = content } else if (Array.isArray(content)) {
    t = content.filter(b => b && b.type === 'text').map(b => str(b.text)).join('\n')
  }
  t = t.trim()
  if (!t) { return '' }
  // Órdenes locales (/model, /clear…), su salida, recordatorios del sistema y avisos de tareas.
  if (/^<(command-name|command-message|local-command-|system-reminder|task-notification|bash-|user-memory-input|local-command-caveat)/.test(t)) { return '' }
  if (/^Caveat: The messages below were generated/.test(t)) { return '' }
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function resultText(content) {
  if (typeof content === 'string') { return content }
  if (Array.isArray(content)) { return content.map(b => (b && b.type === 'text' ? str(b.text) : '')).filter(Boolean).join('\n') }
  return ''
}

// Lo que devolvió una herramienta, para su detalle: el texto (acotado), si falló y sus imágenes
// (un Read de una captura devuelve la imagen).
const MAX_OUTPUT = 8000
// En las conversaciones guardadas (una larga tiene miles de herramientas), algo menos por cada una.
const SAVED_OUTPUT = 3000
const SAVED_FIELD = 2500
function toolResult(b) {
  const text = resultText(b.content)
  return {
    output: text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n… (recortado)' : text,
    error: Boolean(b.is_error),
    images: contentImages(b.content).slice(0, 3)
  }
}

/** TodoWrite de Claude → la lista de tareas que el panel ya sabe dibujar. */
function todosOf(input) {
  if (!input || !Array.isArray(input.todos)) { return null }
  return {
    todos: input.todos.slice(0, 200).map((t, i) => ({
      id: String(i + 1),
      content: cut(str(t.content || t.activeForm).replace(/\s+/g, ' ').trim(), 400),
      status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending'
    }))
  }
}

/** Lee el principio y el final de un archivo sin cargarlo entero. */
function readEdges(file, size, headBytes = 96 * 1024, tailBytes = 320 * 1024) {
  const fd = fs.openSync(file, 'r')
  try {
    const hb = Buffer.alloc(Math.min(headBytes, size))
    fs.readSync(fd, hb, 0, hb.length, 0)
    let tail = ''
    if (size > headBytes) {
      const len = Math.min(tailBytes, size - headBytes)
      const tb = Buffer.alloc(len)
      fs.readSync(fd, tb, 0, len, size - len)
      tail = tb.toString('utf8')
      tail = tail.slice(tail.indexOf('\n') + 1) // la primera línea queda cortada
    }
    return { head: hb.toString('utf8'), tail }
  } finally { fs.closeSync(fd) }
}

function jsonLines(text) {
  const out = []
  for (const l of text.split('\n')) {
    if (!l || l[0] !== '{') { continue }
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

/** Resumen de una conversación guardada (para la lista). null si no tiene ningún mensaje tuyo. */
function summarize(file, st) {
  const { head, tail } = readEdges(file, st.size)
  const first = jsonLines(head)
  const last = tail ? jsonLines(tail) : first
  let cwd = ''
  let firstPrompt = ''
  let sidechain = false
  for (const d of first) {
    if (!cwd && typeof d.cwd === 'string') { cwd = d.cwd }
    if (d.type === 'user' && !d.isMeta && d.message) {
      if (d.isSidechain) { sidechain = true }
      const t = userText(d.message.content)
      if (t && !firstPrompt) { firstPrompt = t }
    }
  }
  let title = ''
  let customTitle = ''
  let lastPrompt = ''
  let model = ''
  let input = 0
  let output = 0
  let messages = 0
  for (const d of [...first, ...last]) {
    if (d.type === 'ai-title' && str(d.aiTitle)) { title = d.aiTitle }
    if (d.type === 'custom-title' && str(d.customTitle)) { customTitle = d.customTitle }
    if (d.type === 'last-prompt' && str(d.lastPrompt)) { lastPrompt = d.lastPrompt }
    if (d.type === 'assistant' && d.message && str(d.message.model) && !/synthetic/.test(d.message.model)) { model = d.message.model }
    if (d.type === 'user' && !d.isMeta && d.message && userText(d.message.content)) { messages++ }
    if (d.type === 'cost-state' && d.modelUsage && typeof d.modelUsage === 'object') {
      input = 0
      output = 0
      for (const u of Object.values(d.modelUsage)) {
        input += (Number(u.inputTokens) || 0) + (Number(u.cacheCreationInputTokens) || 0)
        output += Number(u.outputTokens) || 0
      }
    }
  }
  if (!firstPrompt && !lastPrompt) { return null }
  if (sidechain) { return null }
  return { cwd, firstPrompt, title: customTitle || title, lastPrompt, model, input, output, messages }
}

class ClaudeConnection extends EventEmitter {
  constructor({ log, settings, metaFile, trash }) {
    super()
    this.id = 'claude'
    this.name = 'Claude Code'
    this.log = log
    this.settings = settings
    this.metaFile = metaFile
    this.trash = trash
    this.state = 'off'
    this.detail = ''
    this.exe = null
    this.stopped = true
    this.cache = new Map() // archivo → { mtime, size, row }
    this.files = new Map() // sid → archivo
    this.procs = new Map() // sid → chat en marcha
    this.pending = new Map() // sid → { cwd, model, effort } de un chat nuevo aún sin mensajes
    this.prompts = new Map()
    this.images = new Map() // id → { mime, data }
    this.imageIndex = new Map() // sid → { file, refs: ref → { start, end } } (dónde están sus imágenes)
    // El anfitrión de cada chat (sobrevive a cerrar Pedila) y lo que dijo Claude mientras tanto.
    this.hostDir = path.join(path.dirname(metaFile), 'host')
    this.runDir = path.join(path.dirname(metaFile), 'claude-run')
    this.lastEffort = new Map() // sid → el esfuerzo con que respondió Claude por última vez (de la conversación)
    this.limits = null // lo último que dijo Claude de tu cuota
    this.meta = this.loadMeta()
    this.socket = null // (no tiene: así hp:usage no pregunta por chats en marcha)
    this.idleTimer = null
  }

  ui(evt) { this.emit('ui', { ...evt, conn: this.id }) }

  setState(state, detail = '') {
    if (this.state === state && this.detail === detail) { return }
    this.state = state
    this.detail = detail
    this.ui({ kind: 'conn', state, detail })
  }

  start() {
    this.stopped = false
    this.exe = which('claude')
    this.setState(this.exe ? 'ready' : 'missing', this.exe ? '' : 'No encuentro Claude Code (el programa «claude») en este PC.')
    clearInterval(this.idleTimer)
    this.idleTimer = setInterval(() => this.reapIdle(), 60 * 1000)
    this.reconnecting = this.reconnectHosts().catch(e => this.log.warn('[claude] no pude reengancharme a los chats:', e.message))
    // Si cambian las conversaciones guardadas (también desde una consola), la lista se refresca.
    try {
      this.watcher = fs.watch(path.join(configDir(), 'projects'), { recursive: true }, (_e, f) => {
        if (!f || !/\.jsonl$/.test(f) || /subagents/.test(f)) { return }
        clearTimeout(this.changedT)
        this.changedT = setTimeout(() => this.ui({ kind: 'sessions-changed' }), 1500)
      })
    } catch {}
  }

  stop() {
    this.stopped = true
    clearInterval(this.idleTimer)
    try { this.watcher && this.watcher.close() } catch {}
    for (const s of this.procs.values()) {
      if (s.sock) { s.leaving = true; try { s.sock.end() } catch {} } else { this.kill(s) }
    }
  }

  /** Los chats que se cortarían al cerrar Pedila (los que trabajan sin anfitrión). */
  fragileBusyCount() { return [...this.procs.values()].filter(s => s.busy && !s.sock).length }

  /** Al abrir Pedila: los chats cuyo anfitrión sigue vivo (trabajando o esperando) se reenganchan. */
  async reconnectHosts() {
    let files = []
    try { files = fs.readdirSync(this.runDir).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f)) } catch { return }
    let n = 0
    for (const f of files) {
      const sid = f.slice(0, 36)
      if (!SID.test(sid) || this.procs.has(sid)) { continue }
      let info = null
      try { info = JSON.parse(fs.readFileSync(path.join(this.runDir, f), 'utf8')) } catch {}
      const sock = info ? await host.hostAlive(sid) : null
      if (!sock) { this.cleanRun(sid); continue }
      const s = this.newState(sid, info.cwd)
      s.logFile = info.logFile
      s.at = Number(info.at) || Date.now()
      // Lo permitido «para toda la sesión» sigue valiendo (Claude es el mismo proceso).
      if (Array.isArray(info.allow)) { for (const t of info.allow) { if (typeof t === 'string') { s.allow.add(t) } } }
      this.procs.set(sid, s)
      this.wireHost(s, sock)
      s.ready = Promise.resolve()
      n++
      this.log.info(`[claude] chat ${sid.slice(0, 8)} siguió vivo mientras Pedila estaba cerrado: me reengancho`)
    }
    if (n) { this.ui({ kind: 'sessions-changed' }) }
  }

  newState(sid, cwd) {
    return { sid, cwd, alive: true, busy: false, buf: '', err: '', blocks: new Map(), turnAt: 0, lastUsed: Date.now(), allow: new Set(), tasks: new Map(), controls: new Map() }
  }

  /** Engancha la tubería del anfitrión: lo que llega va por onData; si se corta sin aviso, el chat terminó. */
  wireHost(s, sock) {
    s.sock = sock
    sock.setEncoding('utf8')
    sock.on('data', d => this.onData(s, d))
    sock.on('error', () => {})
    sock.on('close', () => {
      if (s.sock !== sock) { return }
      s.sock = null
      if (!s.exitSeen && !s.leaving && !this.stopped) { this.onExit(s, null) }
    })
  }

  /** Lo que hace falta para reengancharse a un chat con anfitrión al volver a abrir Pedila. */
  saveRunInfo(s) {
    if (!s.logFile) { return }
    if (!s.at) { s.at = Date.now() }
    try { fs.writeFileSync(path.join(this.runDir, s.sid + '.json'), JSON.stringify({ sid: s.sid, cwd: s.cwd, logFile: s.logFile, at: s.at, allow: [...s.allow] })) } catch {}
  }

  /** Borra el rastro de un anfitrión que ya terminó. */
  cleanRun(sid) {
    for (const ext of ['.json', '.jsonl', '.jsonl.err']) { try { fs.unlinkSync(path.join(this.runDir, sid + ext)) } catch {} }
  }

  retryNow() { this.exe = null; this.start() }
  forgetModelStats() {}

  publicState() {
    return { id: this.id, name: this.name, state: this.state, detail: this.detail, canonical: true }
  }

  // ── Pedila guarda aparte lo que Claude Code no tiene: fijados y archivados ─────────────────
  loadMeta() {
    try {
      const j = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
      const opts = {}
      for (const [k, v] of Object.entries(j.opts && typeof j.opts === 'object' ? j.opts : {})) {
        if (!SID.test(k) || !v || typeof v !== 'object') { continue }
        const o = {}
        if (MODELS.some(m => m.id === v.model)) { o.model = v.model }
        if (EFFORTS.includes(v.effort)) { o.effort = v.effort }
        if (typeof v.ultracode === 'boolean') { o.ultracode = v.ultracode }
        if (Object.keys(o).length) { opts[k] = o }
      }
      return { pinned: Array.isArray(j.pinned) ? j.pinned.filter(x => SID.test(x)) : [], archived: Array.isArray(j.archived) ? j.archived.filter(x => SID.test(x)) : [], opts }
    } catch { return { pinned: [], archived: [], opts: {} } }
  }

  saveMeta() {
    try {
      fs.mkdirSync(path.dirname(this.metaFile), { recursive: true })
      fs.writeFileSync(this.metaFile + '.tmp', JSON.stringify(this.meta, null, 1))
      fs.renameSync(this.metaFile + '.tmp', this.metaFile)
    } catch (e) { this.log.warn('[claude] no pude guardar fijados/archivados:', e.message) }
  }

  // ── Lista de chats ──────────────────────────────────────────────────────────────────────────
  scanFiles() {
    const root = path.join(configDir(), 'projects')
    const found = []
    let dirs = []
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()) } catch { return found }
    for (const d of dirs) {
      let names = []
      try { names = fs.readdirSync(path.join(root, d.name)) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) { continue }
        const sid = n.slice(0, -6)
        if (!SID.test(sid)) { continue }
        const file = path.join(root, d.name, n)
        try { const st = fs.statSync(file); found.push({ sid, file, st }) } catch {}
      }
    }
    found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    return found
  }

  rowOf({ sid, file, st }) {
    const c = this.cache.get(file)
    if (c && c.mtime === st.mtimeMs && c.size === st.size) { return c.row }
    let sum = null
    try { sum = summarize(file, st) } catch (e) { this.log.warn('[claude] no pude leer', path.basename(file), e.message) }
    const row = sum ? {
      id: sid,
      title: cut((sum.title || sum.firstPrompt || sum.lastPrompt).replace(/\s+/g, ' ').trim(), 80) || 'Chat sin título',
      preview: cut(`${path.basename(sum.cwd || '') || '—'} · ${(sum.lastPrompt || sum.firstPrompt).replace(/\s+/g, ' ').trim()}`, 120),
      lastActive: st.mtimeMs,
      messages: sum.messages,
      model: sum.model,
      active: false,
      source: 'claude',
      pinned: false,
      archived: false,
      inputTokens: sum.input,
      outputTokens: sum.output,
      startedAt: st.birthtimeMs || st.mtimeMs,
      cwd: sum.cwd
    } : null
    this.cache.set(file, { mtime: st.mtimeMs, size: st.size, row })
    return row
  }

  async allSessions(max = 1000, archived = 'exclude') {
    const files = this.scanFiles().slice(0, Math.min(max, MAX_FILES))
    const rows = []
    for (const f of files) {
      this.files.set(f.sid, f.file)
      const r = this.rowOf(f)
      if (!r) { continue }
      // running: la pantalla lo sabe aunque no viera empezar el turno (p. ej., reenganchado al abrir Pedila).
      const p = this.procs.get(f.sid)
      const row = { ...r, pinned: this.meta.pinned.includes(f.sid), archived: this.meta.archived.includes(f.sid), active: Boolean(p), running: Boolean(p && p.busy) }
      if (archived === 'exclude' && row.archived) { continue }
      if (archived === 'only' && !row.archived) { continue }
      rows.push(row)
    }
    return rows
  }

  async listSessions() { return this.allSessions(MAX_FILES) }
  async archived() { return this.allSessions(MAX_FILES, 'only') }

  fileOf(sid) {
    if (this.files.has(sid)) { return this.files.get(sid) }
    for (const f of this.scanFiles()) { this.files.set(f.sid, f.file) }
    return this.files.get(sid) || null
  }

  cwdOf(sid) {
    const p = this.pending.get(sid)
    if (p) { return p.cwd }
    const f = this.fileOf(sid)
    if (!f) { return null }
    const c = this.cache.get(f)
    if (c && c.row && c.row.cwd) { return c.row.cwd }
    try { const s = summarize(f, fs.statSync(f)); return s && s.cwd } catch { return null }
  }

  async search(q) {
    const needle = q.toLowerCase()
    const out = []
    for (const f of this.scanFiles().slice(0, MAX_FILES)) {
      if (out.length >= 30) { break }
      if (f.st.size > 30 * 1024 * 1024) { continue }
      let text
      try { text = fs.readFileSync(f.file, 'utf8') } catch { continue }
      if (!text.toLowerCase().includes(needle)) { continue }
      let snippet = ''
      for (const d of jsonLines(text)) {
        if ((d.type !== 'user' && d.type !== 'assistant') || !d.message || d.isSidechain) { continue }
        const t = d.type === 'user' ? userText(d.message.content) : (Array.isArray(d.message.content) ? d.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ') : '')
        const i = t.toLowerCase().indexOf(needle)
        if (i >= 0) {
          const s = Math.max(0, i - 50)
          snippet = (s ? '…' : '') + t.slice(s, i) + '>>>' + t.slice(i, i + q.length) + '<<<' + t.slice(i + q.length, i + q.length + 80)
          break
        }
      }
      if (!snippet) { continue }
      const row = this.rowOf(f)
      if (row) { out.push({ ...row, snippet: snippet.replace(/\s+/g, ' ') }) }
    }
    return out
  }

  // ── Leer una conversación ───────────────────────────────────────────────────────────────────
  async transcript(sid) {
    const f = this.fileOf(sid)
    if (!f) { return [] }
    let buf
    try { buf = fs.readFileSync(f) } catch { return [] }
    const out = []
    let turn = null
    let todos = null
    const tools = new Map()
    // Las imágenes no viajan con la conversación (una larga puede llevar cientos de capturas): se
    // apunta en qué línea del archivo está cada una y la pantalla la pide al enseñarla (media()).
    const refs = new Map()
    let lastEffort = null
    const countImages = c => (Array.isArray(c) ? c.filter(b => b && b.type === 'image' && b.source && b.source.type === 'base64').length : 0)
    let pos = 0
    while (pos < buf.length) {
      let nl = buf.indexOf(10, pos)
      if (nl < 0) { nl = buf.length }
      const start = pos
      pos = nl + 1
      if (nl - start < 2 || buf[start] !== 0x7b) { continue }
      let d
      try { d = JSON.parse(buf.toString('utf8', start, nl)) } catch { continue }
      if (d.isSidechain || !d.message) { continue }
      if (d.type === 'user') {
        const c = d.message.content
        if (Array.isArray(c) && c.some(b => b && b.type === 'tool_result')) {
          for (const b of c) {
            if (!b || b.type !== 'tool_result') { continue }
            const t = tools.get(b.tool_use_id)
            if (!t) { continue }
            const text = resultText(b.content)
            t.done = true
            t.output = text.length > SAVED_OUTPUT ? text.slice(0, SAVED_OUTPUT) + '\n… (recortado)' : text
            t.error = Boolean(b.is_error)
            t.summary = cut(((t.error ? 'Error: ' : '') + t.output).replace(/\s+/g, ' ').trim(), 160)
            const n = Math.min(3, countImages(b.content))
            if (n) { t.imageRef = `${sid}|t|${b.tool_use_id}`; t.imageCount = n; refs.set(t.imageRef, { start, end: nl }) }
          }
          continue
        }
        if (d.isMeta) { continue }
        // El resumen que escribe Claude Code al compactar: una nota, no un mensaje tuyo.
        if (d.isCompactSummary || d.isVisibleInTranscriptOnly) {
          const text = typeof c === 'string' ? c : resultText(c)
          if (text.trim()) { out.push({ role: 'note', kind: 'compaction', title: 'Claude resumió la conversación anterior para que quepa', text, ts: d.timestamp || null }) }
          turn = null
          continue
        }
        const text = userText(c)
        const n = Math.min(6, countImages(c))
        if (!text && !n) { continue }
        turn = null
        const row = { role: 'user', text, ts: d.timestamp || null }
        if (n) { row.imageRef = `${sid}|u|${str(d.uuid) || start}`; row.imageCount = n; refs.set(row.imageRef, { start, end: nl }) }
        out.push(row)
      } else if (d.type === 'assistant') {
        if (!turn) { turn = { role: 'assistant', blocks: [], reasoning: '', ts: d.timestamp || null }; out.push(turn) }
        for (const b of Array.isArray(d.message.content) ? d.message.content : []) {
          if (b.type === 'text' && str(b.text).trim()) {
            if (EFFORTS.includes(d.effort)) { lastEffort = d.effort }
            if (/^No response requested\.?$/.test(b.text.trim())) { continue }
            turn.blocks.push({ type: 'text', text: b.text })
          } else if (b.type === 'thinking' && str(b.thinking)) {
            turn.reasoning += (turn.reasoning ? '\n\n' : '') + b.thinking
          } else if (b.type === 'tool_use') {
            if (EFFORTS.includes(d.effort)) { lastEffort = d.effort }
            const t = { type: 'tool', id: b.id, name: b.name, args: argsSummary(b.input), input: boundInput(b.input, 0, SAVED_FIELD), done: false }
            tools.set(b.id, t)
            turn.blocks.push(t)
            if (b.name === 'TodoWrite') { todos = todosOf(b.input) || todos }
          }
        }
      }
    }
    // Sin resultado = terminada, salvo las del último turno de un chat que sigue trabajando (la
    // pantalla las enseña en marcha y les pone el resultado cuando llega en directo).
    const proc = this.procs.get(sid)
    const openTurn = proc && proc.busy && turn && out[out.length - 1] === turn ? turn : null
    for (const t of tools.values()) { if (!t.done && !(openTurn && openTurn.blocks.includes(t))) { t.done = true } }
    if (todos) { this.ui({ kind: 'todos', sid, history: true, revision: 0, ...todos }) }
    if (lastEffort) { this.lastEffort.set(sid, lastEffort) }
    // Dónde están sus imágenes (de los últimos chats abiertos).
    this.imageIndex.delete(sid)
    this.imageIndex.set(sid, { file: f, refs })
    while (this.imageIndex.size > 12) { this.imageIndex.delete(this.imageIndex.keys().next().value) }
    return out.slice(-400)
  }

  // ── Chatear ─────────────────────────────────────────────────────────────────────────────────
  async newChat({ model, reasoning, cwd } = {}) {
    if (!this.exe) { throw new Error('No encuentro Claude Code en este PC.') }
    let dir = typeof cwd === 'string' && cwd ? path.resolve(cwd) : os.homedir()
    try { if (!fs.statSync(dir).isDirectory()) { throw new Error() } } catch { throw new Error('Esa carpeta no existe: ' + dir) }
    const sid = crypto.randomUUID()
    this.pending.set(sid, { cwd: dir, model: MODELS.some(m => m.id === model) ? model : null, effort: EFFORTS.includes(reasoning) ? reasoning : null })
    return { sid }
  }

  async attach(sid) {
    const s = this.procs.get(sid)
    const running = Boolean(s && s.busy)
    this.ui({ kind: 'running', sid, running })
    // Los permisos que esperan respuesta (p. ej., pedidos antes de que la pantalla estuviera lista).
    for (const [key, p] of this.prompts) {
      if (p.sid !== sid) { continue }
      const { input, ...pub } = p
      this.ui({ ...pub, kind: 'prompt', promptKind: 'approval', key, again: true })
    }
    return { running }
  }

  /** El proceso de `claude` de ese chat (lo arranca si hace falta, dentro de su anfitrión). */
  async ensure(sid) {
    let s = this.procs.get(sid)
    if (s && s.alive) { if (s.ready) { await s.ready } return s }
    if (!this.exe) { this.exe = which('claude') }
    if (!this.exe) { throw new Error('No encuentro Claude Code en este PC.') }
    const p = this.pending.get(sid) || (this.meta.opts && this.meta.opts[sid] ? { ...this.meta.opts[sid], cwd: null } : null)
    const file = this.fileOf(sid)
    const cwd = (p && p.cwd) || this.cwdOf(sid)
    if (!cwd) { throw new Error('No encuentro esa conversación de Claude.') }
    try { if (!fs.statSync(cwd).isDirectory()) { throw new Error() } } catch { throw new Error('La carpeta de esta conversación ya no existe: ' + cwd) }
    let extra = splitArgs(this.settings.data.terminals.claudeArgs)
    // Las opciones de la consola que no valen aquí (las pone Pedila).
    const drop = new Set(['-p', '--print', '-c', '--continue', '-r', '--resume', '--session-id', '--output-format', '--input-format', '--include-partial-messages', '--verbose'])
    extra = extra.filter((a, i) => !drop.has(a) && !(i > 0 && ['-r', '--resume', '--session-id', '--output-format', '--input-format'].includes(extra[i - 1])))
    if (p && p.effort) { extra = extra.filter((a, i) => a !== '--effort' && extra[i - 1] !== '--effort') }
    if (p && p.model) { extra = extra.filter((a, i) => a !== '--model' && extra[i - 1] !== '--model') }
    const skipPerms = extra.includes('--dangerously-skip-permissions') || (extra.includes('--permission-mode') && extra[extra.indexOf('--permission-mode') + 1] === 'bypassPermissions')
    const args = [...extra, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    args.push(file ? '--resume' : '--session-id', sid)
    if (p && p.model) { args.push('--model', p.model) }
    if (p && p.effort) { args.push('--effort', p.effort) }
    if (p && typeof p.ultracode === 'boolean' && !/\.(cmd|bat)$/i.test(this.exe)) { args.push('--settings', JSON.stringify({ ultracode: p.ultracode })) }
    // Sin «saltarse los permisos», Claude pregunta por aquí y Pedila enseña la tarjeta de permiso.
    if (!skipPerms) { args.push('--permission-prompt-tool', 'stdio') }
    const viaCmd = /\.(cmd|bat)$/i.test(this.exe)
    // Con anfitrión, el chat sigue vivo aunque Pedila se cierre o se actualice.
    const hostExe = host.hostExe(this.hostDir, this.log)
    if (hostExe) {
      s = this.newState(sid, cwd)
      this.procs.set(sid, s)
      this.pending.delete(sid)
      fs.mkdirSync(this.runDir, { recursive: true })
      const logFile = path.join(this.runDir, sid + '.jsonl')
      s.logFile = logFile
      s.ready = (async () => {
        const live = await host.hostAlive(sid)
        if (live) { this.wireHost(s, live); return }
        host.startHost(hostExe, { sid, logFile, cwd, cmd: viaCmd ? (process.env.ComSpec || 'cmd.exe') : this.exe, args, raw: viaCmd ? cmdLine(this.exe, args) : null, env: cleanEnv() })
        this.saveRunInfo(s)
        this.wireHost(s, await host.connectHost(sid, 20000))
      })()
      try { await s.ready } catch (e) { s.alive = false; this.procs.delete(sid); throw e }
      this.log.info(`[claude] chat ${sid.slice(0, 8)} abierto en ${cwd}${file ? ' (sigue una conversación guardada)' : ''} · con anfitrión`)
      return s
    }
    let exe = this.exe
    let argv = args
    if (viaCmd) {
      exe = process.env.ComSpec || 'cmd.exe'
      argv = ['/d', '/s', '/c', [this.exe, ...args].map(a => (/[\s&()^|<>"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ')]
    }
    const proc = spawn(exe, argv, { cwd, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    s = { ...this.newState(sid, cwd), proc }
    this.procs.set(sid, s)
    this.pending.delete(sid)
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', d => this.onData(s, d))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', d => { s.err = (s.err + d).slice(-4000) })
    proc.on('error', e => { s.err += '\n' + e.message })
    proc.on('exit', code => this.onExit(s, code))
    proc.stdin.on('error', () => {})
    this.log.info(`[claude] chat ${sid.slice(0, 8)} abierto en ${cwd}${file ? ' (sigue una conversación guardada)' : ''}`)
    return s
  }

  write(s, obj) {
    const line = JSON.stringify(obj) + '\n'
    try {
      if (s.sock) { s.sock.write(line) } else if (s.proc) { s.proc.stdin.write(line) } else { throw new Error('Claude no está conectado') }
    } catch (e) { throw new Error('No pude hablar con Claude: ' + e.message) }
  }

  async send(sid, text, attachments = []) {
    const s = await this.ensure(sid)
    s.lastUsed = Date.now()
    const content = [{ type: 'text', text }]
    for (const a of attachments) {
      const img = this.images.get(a.path)
      if (img) { content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }); this.images.delete(a.path) }
    }
    const wasBusy = s.busy
    this.write(s, { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sid })
    if (wasBusy) { return { status: 'queued' } }
    s.busy = true
    s.turnAt = Date.now()
    this.ui({ kind: 'turn-start', sid })
    this.ui({ kind: 'running', sid, running: true })
    return { status: 'ok' }
  }

  async interrupt(sid) {
    const s = this.procs.get(sid)
    if (!s || !s.alive) { return { ok: false } }
    s.interrupted = true
    this.write(s, { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } })
    return { status: 'interrupting' }
  }

  async attachImage(_sid, base64, filename) {
    const ext = path.extname(String(filename || '')).toLowerCase()
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/png'
    const id = 'mem:' + crypto.randomUUID()
    this.images.set(id, { mime, data: base64 })
    // Las que nunca se llegan a enviar no se quedan para siempre.
    setTimeout(() => this.images.delete(id), 30 * 60 * 1000)
    return { path: id, mime }
  }

  // ── Lo que llega de claude ──────────────────────────────────────────────────────────────────
  onData(s, d) {
    s.buf += d
    let i
    while ((i = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, i).trim()
      s.buf = s.buf.slice(i + 1)
      if (!line) { continue }
      let m
      try { m = JSON.parse(line) } catch { continue }
      try { this.onMsg(s, m) } catch (e) { this.log.warn('[claude] mensaje raro:', e.message) }
    }
  }

  onMsg(s, m) {
    const sid = s.sid
    if (m.type === 'pedila_host') {
      if (m.event === 'hello') {
        s.hostPid = m.hostPid
        // Lo de este turno que se dijo sin Pedila delante: se repasa para que el chat se vea igual.
        if (s.logFile && m.logEnd > m.turnStart) {
          s.replaying = true
          try {
            for (const l of host.readLog(s.logFile, m.turnStart, m.logEnd)) {
              let x = null
              try { x = JSON.parse(l) } catch {}
              if (x && x.type !== 'pedila_host') { this.onMsg(s, x) }
            }
          } finally { s.replaying = false }
          // Los permisos que siguen sin contestar: si ya estaba permitido para toda la sesión se
          // contesta solo; si no, se pide (y avisa) ahora.
          for (const [k, p] of this.prompts) {
            if (p.sid !== sid) { continue }
            if (s.allow.has(p.tool)) { this.answer(k, 'once').catch(() => {}); continue }
            const { input, ...pub } = p
            this.ui({ ...pub, kind: 'prompt', promptKind: 'approval', key: k })
          }
        }
      } else if (m.event === 'exit') {
        s.exitSeen = true
        this.onExit(s, Number.isFinite(m.code) ? m.code : null)
      }
      return
    }
    // Lo que Pedila le mandó a Claude (lo apunta el anfitrión). Al repasar: un permiso ya contestado
    // no se vuelve a pedir.
    if (m.type === 'pedila_in') {
      const x = m.m
      if (s.replaying && x && x.type === 'control_response' && x.response) {
        const key = `cl:${x.response.request_id}`
        if (this.prompts.has(key)) { this.prompts.delete(key); this.ui({ kind: 'prompt-done', key, sid }) }
      }
      return
    }
    // Lo de los subagentes (Task/Agent) va con parent_tool_use_id: no se dibuja en el chat, pero
    // las herramientas que usan se cuentan en su tarea del panel.
    if (m.parent_tool_use_id) {
      if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
        const t = [...s.tasks.values()].find(x => x.toolUseId === m.parent_tool_use_id)
        for (const b of m.message.content) {
          if (!t || !b || b.type !== 'tool_use') { continue }
          t.tools = (t.tools || 0) + 1
          t.tool = str(b.name)
          this.ui({ kind: 'subagent', sid, id: t.id, phase: 'tool', goal: t.goal, tool: t.tool, tools: t.tools })
        }
      }
      return
    }
    // Actividad con el chat «parado»: Claude empezó otro turno (un mensaje que esperaba en cola).
    const active = m.type === 'assistant' || m.type === 'stream_event' || (m.type === 'system' && m.subtype === 'status' && m.status === 'requesting')
    if (active && !s.busy && s.alive) {
      s.busy = true
      s.turnAt = Date.now()
      this.ui({ kind: 'turn-start', sid })
      this.ui({ kind: 'running', sid, running: true })
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          s.model = str(m.model)
          this.ui({ kind: 'info', sid, model: s.model, provider: 'Claude Code' })
        } else if (m.subtype === 'compact_boundary') {
          this.ui({ kind: 'status', sid, text: 'Resumiendo la conversación para que quepa', statusKind: 'compacting' })
        } else if (/^task_|^background_tasks_changed$/.test(str(m.subtype))) {
          this.onTask(s, m)
        }
        return
      case 'stream_event': {
        const e = m.event || {}
        if (e.type === 'message_start') { s.blocks = new Map(); return }
        if (e.type === 'content_block_start') {
          const b = e.content_block || {}
          s.blocks.set(e.index, b.type)
          if (b.type === 'tool_use') { this.ui({ kind: 'tool', sid, phase: 'generating', id: str(b.id), name: str(b.name) }) }
          return
        }
        if (e.type === 'content_block_delta') {
          const dl = e.delta || {}
          if (dl.type === 'text_delta' && dl.text) { this.ui({ kind: 'delta', sid, text: dl.text }) }
          if (dl.type === 'thinking_delta' && dl.thinking) { this.ui({ kind: 'reasoning', sid, text: dl.thinking }) }
          return
        }
        if (e.type === 'content_block_stop' && s.blocks.get(e.index) === 'text') { this.ui({ kind: 'segment', sid }) }
        return
      }
      case 'assistant':
        for (const b of (m.message && Array.isArray(m.message.content)) ? m.message.content : []) {
          if (b.type !== 'tool_use') { continue }
          this.ui({ kind: 'tool', sid, phase: 'start', id: str(b.id), name: str(b.name), args: argsSummary(b.input), input: boundInput(b.input) })
          if (b.name === 'TodoWrite') { const t = todosOf(b.input); if (t) { this.ui({ kind: 'todos', sid, revision: Date.now(), ...t }) } }
        }
        return
      case 'user':
        for (const b of (m.message && Array.isArray(m.message.content)) ? m.message.content : []) {
          if (b.type !== 'tool_result') { continue }
          const r = toolResult(b)
          this.ui({ kind: 'tool', sid, phase: 'complete', id: str(b.tool_use_id), summary: cut(((b.is_error ? 'Error: ' : '') + r.output).replace(/\s+/g, ' ').trim(), 200), seconds: null, output: r.output, error: r.error, images: r.images })
        }
        return
      case 'rate_limit_event':
        if (m.rate_limit_info) { this.limits = { ...m.rate_limit_info, at: Date.now() }; this.ui({ kind: 'claude-limits', limits: this.limits }) }
        return
      case 'control_request':
        if (m.request && m.request.subtype === 'can_use_tool') { this.onPermission(s, m) }
        return
      case 'control_response': {
        // La respuesta a un cambio de modelo o de esfuerzo que mandó Pedila.
        const r = m.response || {}
        const w = s.controls.get(r.request_id)
        if (w) { s.controls.delete(r.request_id); clearTimeout(w.t); if (r.subtype === 'success') { w.ok(r.response || {}) } else { w.ko(new Error(str(r.error) || 'Claude no aceptó el cambio')) } }
        return
      }
      case 'result': {
        const u = m.usage || {}
        const mu = m.modelUsage && typeof m.modelUsage === 'object' ? Object.values(m.modelUsage)[0] : null
        const it = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : u
        const used = (Number(it.input_tokens) || 0) + (Number(it.cache_read_input_tokens) || 0) + (Number(it.cache_creation_input_tokens) || 0) + (Number(it.output_tokens) || 0)
        if (used) { this.ui({ kind: 'usage', sid, used, max: mu && Number(mu.contextWindow) ? Number(mu.contextWindow) : null, out: Number(u.output_tokens) || null }) }
        const more = Number(m.queued_turn_count) > 0
        s.busy = more
        const stopped = s.interrupted || /^aborted/.test(str(m.terminal_reason))
        s.interrupted = false
        const failed = m.is_error || (m.subtype && m.subtype !== 'success')
        this.ui({ kind: 'complete', sid, more, text: str(m.result), status: failed ? 'error' : 'completed', outcome: stopped ? 'interrupted' : failed ? (str(m.subtype) || 'error') : 'completed', ms: Number(m.duration_ms) || (s.turnAt ? Date.now() - s.turnAt : null), out: Number(u.output_tokens) || null })
        if (more) { s.turnAt = Date.now() } else { this.ui({ kind: 'running', sid, running: false }) }
        s.lastUsed = Date.now()
        // El título que pone Claude llega al archivo poco después de la primera respuesta.
        setTimeout(() => this.refreshTitle(sid), 2500)
        this.ui({ kind: 'sessions-changed' })
        return
      }
    }
  }

  /**
   * Avisos de tareas de Claude Code (task_started, task_updated, task_progress, task_notification,
   * background_tasks_changed) → los subagentes que el panel ya sabe dibujar.
   */
  onTask(s, m) {
    const sid = s.sid
    const TYPE = { local_bash: 'Orden en segundo plano', local_agent: 'Agente', remote_agent: 'Agente en la nube', local_workflow: 'Flujo de trabajo', workflow: 'Flujo de trabajo', monitor: 'Vigilancia', in_process_teammate: 'Compañero' }
    const goalOf = (type, desc) => [TYPE[type] || (type ? type.replace(/_/g, ' ') : ''), str(desc)].filter(Boolean).join(': ') || 'Tarea'
    const start = (id, type, desc, toolUseId) => {
      let t = s.tasks.get(id)
      if (!t) { t = { id, type, goal: goalOf(type, desc), state: 'running', since: Date.now(), toolUseId: toolUseId || '', tools: 0 }; s.tasks.set(id, t) }
      if (toolUseId) { t.toolUseId = toolUseId }
      this.ui({ kind: 'subagent', sid, id, phase: 'start', goal: t.goal })
      return t
    }
    const end = (id, status) => {
      const t = s.tasks.get(id)
      if (!t || t.state !== 'running') { return }
      t.state = 'ended'
      const st = /fail|error/.test(status) ? 'failed' : /kill|stop|cancel/.test(status) ? 'cancelled' : 'completed'
      this.ui({ kind: 'subagent', sid, id, phase: 'complete', goal: t.goal, status: st, seconds: (Date.now() - t.since) / 1000 })
    }
    const id = str(m.task_id)
    switch (m.subtype) {
      case 'task_started':
        if (id) { start(id, str(m.task_type), m.description, str(m.tool_use_id)) }
        return
      case 'task_progress': {
        const t = id && s.tasks.get(id)
        if (t) { this.ui({ kind: 'subagent', sid, id, phase: 'progress', goal: t.goal, text: str(m.description || m.summary || (m.last_tool_name ? 'usando ' + m.last_tool_name : '')) }) }
        return
      }
      case 'task_updated': {
        const st = str(m.patch && m.patch.status)
        if (id && st && st !== 'running' && st !== 'pending') { end(id, st) }
        return
      }
      case 'task_notification':
        if (id) { end(id, str(m.status)) }
        return
      case 'background_tasks_changed':
        for (const t of Array.isArray(m.tasks) ? m.tasks : []) {
          if (t && t.task_id && !s.tasks.has(str(t.task_id))) { start(str(t.task_id), str(t.task_type), t.description) }
        }
    }
  }

  /** Manda un control a claude y espera su respuesta (cambiar el modelo, el esfuerzo…). */
  control(s, request, ms = 15000) {
    return new Promise((ok, ko) => {
      const id = crypto.randomUUID()
      const t = setTimeout(() => { s.controls.delete(id); ko(new Error('Claude no respondió al cambio a tiempo')) }, ms)
      s.controls.set(id, { ok, ko, t })
      try { this.write(s, { type: 'control_request', request_id: id, request }) } catch (e) { clearTimeout(t); s.controls.delete(id); ko(e) }
    })
  }

  /**
   * Cambiar el modelo o el esfuerzo de un chat ya empezado. Con su proceso abierto, en caliente
   * (set_model y apply_flag_settings, como el SDK); si no, al abrirlo la próxima vez (--model/--effort).
   * Se recuerda para ese chat.
   */
  async setChatOptions(sid, { model, reasoning, ultracode } = {}) {
    const o = { ...((this.meta.opts && this.meta.opts[sid]) || {}) }
    if (ultracode !== undefined) { if (ultracode === null) { delete o.ultracode } else if (typeof ultracode === 'boolean') { o.ultracode = ultracode } else { throw new Error('Ultracode no válido') } }
    if (model !== undefined) { if (model === null) { delete o.model } else if (MODELS.some(m => m.id === model)) { o.model = model } else { throw new Error('modelo no válido') } }
    if (reasoning !== undefined) { if (reasoning === null || reasoning === '') { delete o.effort } else if (EFFORTS.includes(reasoning)) { o.effort = reasoning } else { throw new Error('esfuerzo no válido') } }
    const pend = this.pending.get(sid)
    if (pend) {
      // Chat nuevo aún sin mensajes: se arrancará ya con esto.
      if (model !== undefined) { pend.model = o.model || null }
      if (reasoning !== undefined) { pend.effort = o.effort || null }
      if (ultracode !== undefined) { pend.ultracode = typeof o.ultracode === 'boolean' ? o.ultracode : undefined }
      return { applied: 'next', model: o.model || null, effort: o.effort || null }
    }
    if (!this.meta.opts) { this.meta.opts = {} }
    if (Object.keys(o).length) { this.meta.opts[sid] = o } else { delete this.meta.opts[sid] }
    this.saveMeta()
    // Lo que se ve en el botón: el elegido; al volver al predeterminado, el último conocido ya no vale.
    if (reasoning !== undefined) { if (o.effort) { this.lastEffort.set(sid, o.effort) } else { this.lastEffort.delete(sid) } }
    const s = this.procs.get(sid)
    let shown = null
    if (s && s.alive) {
      if (model !== undefined) { const r = await this.control(s, { subtype: 'set_model', model: o.model || undefined }); shown = str(r.model) || o.model || null }
      if (reasoning !== undefined) { await this.control(s, { subtype: 'apply_flag_settings', settings: { effortLevel: o.effort || null } }) }
      if (ultracode !== undefined) { await this.control(s, { subtype: 'apply_flag_settings', settings: { ultracode: typeof o.ultracode === 'boolean' ? o.ultracode : this.defaultUltracode() } }) }
      this.log.info(`[claude] chat ${sid.slice(0, 8)}: ${[model !== undefined ? 'modelo ' + (o.model || 'predeterminado') : '', reasoning !== undefined ? 'esfuerzo ' + (o.effort || 'predeterminado') : '', ultracode !== undefined ? 'ultracode ' + o.ultracode : ''].filter(Boolean).join(', ')} (en caliente)`)
      if (shown) { this.ui({ kind: 'info', sid, model: shown, provider: 'Claude Code' }) }
      return { applied: 'now', model: shown || o.model || null, effort: o.effort || null }
    }
    this.log.info(`[claude] chat ${sid.slice(0, 8)}: cambio guardado para cuando se abra`)
    return { applied: 'next', model: o.model || null, effort: o.effort || null }
  }

  /** El esfuerzo que trae «Opciones de Claude» (p. ej. «--effort max»), o null. */
  argsEffort() {
    const a = splitArgs(this.settings.data.terminals.claudeArgs)
    const i = a.indexOf('--effort')
    return i >= 0 && EFFORTS.includes(a[i + 1]) ? a[i + 1] : null
  }

  /** Si Ultracode está activado en los ajustes de Claude Code (solo esa clave de ~/.claude/settings.json). */
  defaultUltracode() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'))
      return j.ultracode === true
    } catch { return false }
  }

  /**
   * Lo de un chat para los botones: lo elegido (model, effort, ultracode) y el esfuerzo con que
   * trabaja de verdad (effective: lo elegido, o el de la última respuesta, o el de las opciones).
   * Con sid «-», lo de un chat nuevo.
   */
  chatOptions(sid) {
    const o = (this.meta.opts && this.meta.opts[sid]) || this.pending.get(sid) || {}
    const effective = o.effort || (sid !== '-' && this.lastEffort.get(sid)) || this.argsEffort() || null
    return { model: o.model || null, effort: o.effort || null, effective, ultracode: typeof o.ultracode === 'boolean' ? o.ultracode : this.defaultUltracode() }
  }

  refreshTitle(sid) {
    const f = this.fileOf(sid)
    if (!f) { return }
    try {
      const st = fs.statSync(f)
      const r = this.rowOf({ sid, file: f, st })
      if (r && r.title) { this.ui({ kind: 'title', sid, title: r.title }) }
    } catch {}
  }

  onPermission(s, m) {
    const rq = m.request
    const name = str(rq.tool_name)
    // Al repasar no se contesta nada todavía: puede que ya se contestara (se sabe al acabar el repaso).
    if (s.allow.has(name) && !s.replaying) {
      this.write(s, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: rq.input || {} } } })
      return
    }
    const key = `cl:${m.request_id}`
    const prompt = { kind: 'approval', sid: s.sid, requestId: m.request_id, tool: name, input: rq.input || {}, command: `${name}: ${argsSummary(rq.input)}`, description: str(rq.description) || `Claude quiere usar ${name}`, choices: ['once', 'session', 'deny'] }
    this.prompts.set(key, prompt)
    if (s.replaying) { return } // se enseña al acabar el repaso, si sigue sin contestar
    const { input, ...pub } = prompt
    this.ui({ ...pub, kind: 'prompt', promptKind: 'approval', key })
  }

  async answer(key, value) {
    const pr = this.prompts.get(key)
    if (!pr) { return { ok: false, gone: true } }
    if (!pr.choices.includes(value)) { throw new Error('respuesta de permiso no válida') }
    const s = this.procs.get(pr.sid)
    this.prompts.delete(key)
    this.ui({ kind: 'prompt-done', key, sid: pr.sid })
    if (!s || !s.alive) { return { ok: false, gone: true } }
    if (value === 'session') { s.allow.add(pr.tool); this.saveRunInfo(s) }
    const response = value === 'deny'
      ? { behavior: 'deny', message: 'La persona no lo permitió desde Pedila.' }
      : { behavior: 'allow', updatedInput: pr.input }
    this.write(s, { type: 'control_response', response: { subtype: 'success', request_id: pr.requestId, response } })
    return { ok: true }
  }

  onExit(s, code) {
    s.alive = false
    if (this.procs.get(s.sid) === s) { this.procs.delete(s.sid) }
    // Sus tareas en segundo plano mueren con el proceso; los cambios pendientes ya no llegarán.
    for (const t of s.tasks ? s.tasks.values() : []) {
      if (t.state === 'running') { t.state = 'ended'; this.ui({ kind: 'subagent', sid: s.sid, id: t.id, phase: 'complete', goal: t.goal, status: 'cancelled', seconds: (Date.now() - t.since) / 1000 }) }
    }
    for (const w of s.controls ? s.controls.values() : []) { clearTimeout(w.t); w.ko(new Error('Claude se cerró antes de aplicar el cambio')) }
    if (s.controls) { s.controls.clear() }
    for (const [k, pr] of this.prompts) { if (pr.sid === s.sid) { this.prompts.delete(k); this.ui({ kind: 'prompt-done', key: k, sid: s.sid }) } }
    if (s.logFile) {
      try { const e = fs.readFileSync(s.logFile + '.err', 'utf8'); s.err = (s.err + e).slice(-4000) } catch {}
      this.cleanRun(s.sid)
    }
    if (s.busy) {
      const why = s.err.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
      this.ui({ kind: 'error', sid: s.sid, message: `Claude Code se cerró (código ${code})${why ? ': ' + why : ''}` })
      this.ui({ kind: 'complete', sid: s.sid, text: '', status: 'error', outcome: 'error', ms: s.turnAt ? Date.now() - s.turnAt : null })
      this.ui({ kind: 'running', sid: s.sid, running: false })
    }
    this.log.info(`[claude] chat ${s.sid.slice(0, 8)} cerrado (código ${code})`)
  }

  kill(s) {
    if (!s.alive) { return }
    if (s.sock) {
      try { this.write(s, { type: 'pedila_host_cmd', cmd: 'close' }) } catch {}
      const t = setTimeout(() => { try { if (s.alive && s.sock) { this.write(s, { type: 'pedila_host_cmd', cmd: 'kill' }) } } catch {} }, 5000)
      if (t.unref) { t.unref() }
      return
    }
    if (!s.proc) { return }
    try { s.proc.stdin.end() } catch {}
    const t = setTimeout(() => { try { s.proc.kill() } catch {} }, 3000)
    s.proc.once('exit', () => clearTimeout(t))
  }

  reapIdle() {
    for (const s of this.procs.values()) {
      if (!s.busy && Date.now() - s.lastUsed > IDLE_MS) { this.kill(s) }
    }
  }

  /** Para abrir la conversación en una consola: suelta su proceso (si no trabaja) y da su carpeta. */
  async release(sid) {
    const s = this.procs.get(sid)
    if (s && s.busy) { throw new Error('Claude está trabajando en este chat: espera a que termine o páralo antes.') }
    if (s) { this.kill(s) }
    const cwd = this.cwdOf(sid)
    if (!cwd) { throw new Error('Esta conversación todavía no tiene mensajes.') }
    return { cwd, sid }
  }

  busyCount() { return [...this.procs.values()].filter(s => s.busy).length }

  // ── Gestionar chats ─────────────────────────────────────────────────────────────────────────
  async rename(sid, title) {
    const f = this.fileOf(sid)
    if (!f) { throw new Error('Esta conversación todavía no tiene mensajes.') }
    if (this.procs.get(sid)?.busy) { throw new Error('Espera a que Claude termine para renombrarla.') }
    // Igual que /rename de Claude Code: una línea «custom-title» al final de la conversación.
    fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: sid }) + '\n')
    this.ui({ kind: 'title', sid, title })
    this.ui({ kind: 'sessions-changed' })
    return { ok: true }
  }

  async setPinned(sid, on) { this.toggleMeta('pinned', sid, on); return { ok: true } }
  async setArchived(sid, on) { this.toggleMeta('archived', sid, on); return { ok: true } }

  toggleMeta(list, sid, on) {
    const set = new Set(this.meta[list])
    if (on) { set.add(sid) } else { set.delete(sid) }
    this.meta[list] = [...set]
    this.saveMeta()
    this.ui({ kind: 'sessions-changed' })
  }

  /** Borrar = a la papelera de Windows (se puede recuperar). */
  async remove(sid) {
    const f = this.fileOf(sid)
    if (!f) { this.pending.delete(sid); return { ok: true } }
    if (this.procs.has(sid)) { this.kill(this.procs.get(sid)) }
    await this.trash(f)
    this.files.delete(sid)
    this.cache.delete(f)
    this.toggleMeta('pinned', sid, false)
    this.toggleMeta('archived', sid, false)
    return { ok: true }
  }

  async modelOptions() {
    return { paid: [], current: { model: '', provider: 'claude', local: false }, providers: [{ id: 'claude', name: 'Claude', local: false, paid: null, models: MODELS }] }
  }

  // Lo que el panel pide a los Hermes y aquí no aplica.
  async modelUsage() { return null }
  async activeList() { return null }
  /** Las tareas en marcha de un chat (la comprobación del panel no las da por terminadas). */
  async subagents(sid) {
    const s = this.procs.get(sid)
    if (!s || !s.alive) { return [] }
    return [...s.tasks.values()].filter(t => t.state === 'running').map(t => ({ id: t.id, status: 'running', tool: t.tool || '', tools: t.tools || null }))
  }
  async quotas() { return { state: 'none', providers: [], limits: this.limits } }
  async installQuotaPlugin() { throw new Error('No aplica a Claude Code') }
  async media(ref) {
    const m = /^([0-9a-f-]{36})\|([tu])\|([^|]{1,120})\|(\d)$/i.exec(String(ref || ''))
    if (!m) { throw new Error('imagen no válida') }
    const [, sid, kind, key, idx] = m
    const base = `${sid}|${kind}|${key}`
    let ix = this.imageIndex.get(sid)
    if (!ix || !ix.refs.has(base)) { await this.transcript(sid); ix = this.imageIndex.get(sid) }
    const r = ix && ix.refs.get(base)
    if (!r) { throw new Error('no encuentro esa imagen') }
    const fd = fs.openSync(ix.file, 'r')
    let d
    try {
      const b = Buffer.alloc(r.end - r.start)
      fs.readSync(fd, b, 0, b.length, r.start)
      d = JSON.parse(b.toString('utf8'))
    } finally { fs.closeSync(fd) }
    const content = d && d.message ? d.message.content : null
    const blocks = kind === 'u' ? content : (Array.isArray(content) ? (content.find(x => x && x.type === 'tool_result' && x.tool_use_id === key) || {}).content : null)
    const im = contentImages(blocks)[Number(idx)]
    if (!im) { throw new Error('no encuentro esa imagen') }
    return im.url
  }
}

module.exports = { ClaudeConnection, summarize, userText, todosOf }
