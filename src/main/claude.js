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
const { which, cleanEnv, splitArgs, SID } = require('./terms')

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
    for (const s of this.procs.values()) { this.kill(s) }
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
      return { pinned: Array.isArray(j.pinned) ? j.pinned.filter(x => SID.test(x)) : [], archived: Array.isArray(j.archived) ? j.archived.filter(x => SID.test(x)) : [] }
    } catch { return { pinned: [], archived: [] } }
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
      const row = { ...r, pinned: this.meta.pinned.includes(f.sid), archived: this.meta.archived.includes(f.sid), active: this.procs.has(f.sid) }
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
    let lines
    try { lines = jsonLines(fs.readFileSync(f, 'utf8')) } catch { return [] }
    const out = []
    let turn = null
    let todos = null
    const tools = new Map()
    for (const d of lines) {
      if (d.isSidechain || !d.message) { continue }
      if (d.type === 'user') {
        const c = d.message.content
        if (Array.isArray(c) && c.some(b => b && b.type === 'tool_result')) {
          for (const b of c) {
            if (!b || b.type !== 'tool_result') { continue }
            const t = tools.get(b.tool_use_id)
            if (t) {
              const r = toolResult(b)
              t.done = true
              t.summary = cut(((b.is_error ? 'Error: ' : '') + r.output).replace(/\s+/g, ' ').trim(), 160)
              t.output = r.output
              t.error = r.error
              if (r.images.length) { t.images = r.images }
            }
          }
          continue
        }
        if (d.isMeta) { continue }
        const text = userText(c)
        const images = contentImages(c)
        if (!text && !images.length) { continue }
        turn = null
        out.push({ role: 'user', text, ts: d.timestamp || null, ...(images.length ? { images } : {}) })
      } else if (d.type === 'assistant') {
        if (!turn) { turn = { role: 'assistant', blocks: [], reasoning: '', ts: d.timestamp || null }; out.push(turn) }
        for (const b of Array.isArray(d.message.content) ? d.message.content : []) {
          if (b.type === 'text' && str(b.text).trim()) {
            if (/^No response requested\.?$/.test(b.text.trim())) { continue }
            turn.blocks.push({ type: 'text', text: b.text })
          } else if (b.type === 'thinking' && str(b.thinking)) {
            turn.reasoning += (turn.reasoning ? '\n\n' : '') + b.thinking
          } else if (b.type === 'tool_use') {
            const t = { type: 'tool', id: b.id, name: b.name, args: argsSummary(b.input), input: boundInput(b.input), done: false }
            tools.set(b.id, t)
            turn.blocks.push(t)
            if (b.name === 'TodoWrite') { todos = todosOf(b.input) || todos }
          }
        }
      }
    }
    for (const t of tools.values()) { t.done = true }
    if (todos) { this.ui({ kind: 'todos', sid, history: true, revision: 0, ...todos }) }
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
    return { running }
  }

  /** El proceso de `claude` de ese chat (lo arranca si hace falta). */
  ensure(sid) {
    let s = this.procs.get(sid)
    if (s && s.alive) { return s }
    if (!this.exe) { this.exe = which('claude') }
    if (!this.exe) { throw new Error('No encuentro Claude Code en este PC.') }
    const p = this.pending.get(sid)
    const file = this.fileOf(sid)
    const cwd = p ? p.cwd : this.cwdOf(sid)
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
    // Sin «saltarse los permisos», Claude pregunta por aquí y Pedila enseña la tarjeta de permiso.
    if (!skipPerms) { args.push('--permission-prompt-tool', 'stdio') }
    let exe = this.exe
    let argv = args
    if (/\.(cmd|bat)$/i.test(exe)) {
      exe = process.env.ComSpec || 'cmd.exe'
      argv = ['/d', '/s', '/c', [this.exe, ...args].map(a => (/[\s&()^|<>"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ')]
    }
    const proc = spawn(exe, argv, { cwd, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    s = { sid, cwd, proc, alive: true, busy: false, buf: '', err: '', blocks: new Map(), turnAt: 0, lastUsed: Date.now(), allow: new Set(), queued: 0 }
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
    try { s.proc.stdin.write(JSON.stringify(obj) + '\n') } catch (e) { throw new Error('No pude hablar con Claude: ' + e.message) }
  }

  async send(sid, text, attachments = []) {
    const s = this.ensure(sid)
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
    // Lo de los subagentes (Task/Agent) va con parent_tool_use_id: aquí solo el hilo principal.
    if (m.parent_tool_use_id) { return }
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
      case 'result': {
        const u = m.usage || {}
        const mu = m.modelUsage && typeof m.modelUsage === 'object' ? Object.values(m.modelUsage)[0] : null
        const it = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : u
        const used = (Number(it.input_tokens) || 0) + (Number(it.cache_read_input_tokens) || 0) + (Number(it.cache_creation_input_tokens) || 0) + (Number(it.output_tokens) || 0)
        if (used) { this.ui({ kind: 'usage', sid, used, max: mu && Number(mu.contextWindow) ? Number(mu.contextWindow) : null, out: Number(u.output_tokens) || null }) }
        s.busy = false
        const failed = m.is_error || (m.subtype && m.subtype !== 'success')
        this.ui({ kind: 'complete', sid, text: str(m.result), status: failed ? 'error' : 'completed', outcome: failed ? (m.subtype === 'error_during_execution' && /interrupt/i.test(str(m.terminal_reason)) ? 'interrupted' : str(m.subtype) || 'error') : 'completed', ms: Number(m.duration_ms) || (s.turnAt ? Date.now() - s.turnAt : null), out: Number(u.output_tokens) || null })
        if (!s.busy) { this.ui({ kind: 'running', sid, running: false }) }
        s.lastUsed = Date.now()
        // El título que pone Claude llega al archivo poco después de la primera respuesta.
        setTimeout(() => this.refreshTitle(sid), 2500)
        this.ui({ kind: 'sessions-changed' })
        return
      }
    }
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
    if (s.allow.has(name)) {
      this.write(s, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: rq.input || {} } } })
      return
    }
    const key = `cl:${m.request_id}`
    const prompt = { kind: 'approval', sid: s.sid, requestId: m.request_id, tool: name, input: rq.input || {}, command: `${name}: ${argsSummary(rq.input)}`, description: str(rq.description) || `Claude quiere usar ${name}`, choices: ['once', 'session', 'deny'] }
    this.prompts.set(key, prompt)
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
    if (value === 'session') { s.allow.add(pr.tool) }
    const response = value === 'deny'
      ? { behavior: 'deny', message: 'La persona no lo permitió desde Pedila.' }
      : { behavior: 'allow', updatedInput: pr.input }
    this.write(s, { type: 'control_response', response: { subtype: 'success', request_id: pr.requestId, response } })
    return { ok: true }
  }

  onExit(s, code) {
    s.alive = false
    if (this.procs.get(s.sid) === s) { this.procs.delete(s.sid) }
    for (const [k, pr] of this.prompts) { if (pr.sid === s.sid) { this.prompts.delete(k); this.ui({ kind: 'prompt-done', key: k, sid: s.sid }) } }
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
  async subagents() { return [] }
  async quotas() { return { state: 'none', providers: [], limits: this.limits } }
  async installQuotaPlugin() { throw new Error('No aplica a Claude Code') }
  async media() { throw new Error('No aplica a Claude Code') }
}

module.exports = { ClaudeConnection, summarize, userText, todosOf }
