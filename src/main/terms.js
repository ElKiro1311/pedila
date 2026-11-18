'use strict'
// Terminales dentro de Pedila (como Herdr): cada pestaña es una consola de verdad de Windows
// (ConPTY, con node-pty) donde corre Claude Code, Hermes, Antigravity o PowerShell tal cual.
// La pantalla las dibuja con xterm.js; aquí viven los procesos, así que sobreviven a que la
// ventana se cierre a la bandeja o se recargue (se guarda lo último que mostraron para repintarlo).
const { EventEmitter } = require('node:events')
const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

let pty = null
function ptyLib() {
  if (!pty) { pty = require('node-pty') }
  return pty
}

// Lo que se puede abrir. `bins`: nombres que se buscan en el PATH, por orden.
const KINDS = {
  claude: { label: 'Claude Code', bins: ['claude'] },
  hermes: { label: 'Hermes', bins: ['hermes'] },
  agy: { label: 'Antigravity', bins: ['agy'] },
  shell: { label: 'PowerShell', bins: ['pwsh', 'powershell'] }
}
const MAX_TERMS = 24
const KEEP_BYTES = 400 * 1024 // lo último que mostró cada terminal, para repintarla
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Busca un programa en el PATH como lo haría Windows (con PATHEXT). */
function which(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
  // Sitios donde se instalan estos programas aunque no estén en el PATH de las apps gráficas.
  const home = os.homedir()
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, 'AppData', 'Roaming', 'npm'))
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, name + e.toLowerCase())
      try { if (fs.statSync(f).isFile()) { return f } } catch {}
    }
  }
  return null
}

function cleanEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(ELECTRON_|PEDILA_|CHROME_|GOOGLE_API_KEY$)/i.test(k) || k === 'NODE_OPTIONS') { delete env[k] }
  }
  // Si Pedila se abrió desde dentro de una sesión de Claude Code, sus marcas de sesión no deben
  // pasar: el Claude de la pestaña se creería «hijo» de aquella (no guarda la conversación y no
  // aparece en `claude agents`). Solo se quitan esas marcas, no la configuración de Claude.
  for (const k of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT']) {
    delete env[k]
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

class Terms extends EventEmitter {
  constructor({ log }) {
    super()
    this.log = log
    this.terms = new Map() // id → término
    this.seq = 0
    this.paths = null
    this.pathsAt = 0
    this.agents = [] // última lectura de `claude agents --json`
    this.agentsAt = 0
    this.agentsBusy = false
    this.timer = null
  }

  /** Qué programas hay en este PC (se vuelve a mirar como mucho cada 30 s). */
  tools() {
    if (!this.paths || Date.now() - this.pathsAt > 30000) {
      this.paths = {}
      for (const [kind, k] of Object.entries(KINDS)) {
        this.paths[kind] = k.bins.map(which).find(Boolean) || null
      }
      if (!this.paths.shell && process.platform === 'win32') { this.paths.shell = 'powershell.exe' }
      this.pathsAt = Date.now()
    }
    return Object.entries(KINDS).map(([kind, k]) => ({ kind, label: k.label, available: Boolean(this.paths[kind]) }))
  }

  open({ kind, cwd, resume, cont, cols, rows, extraArgs }) {
    if (!KINDS[kind]) { throw new Error('tipo de terminal desconocido') }
    if (this.terms.size >= MAX_TERMS) { throw new Error(`Ya hay ${MAX_TERMS} terminales abiertas; cierra alguna.`) }
    this.tools()
    const exe = this.paths[kind]
    if (!exe) { throw new Error(`No encuentro ${KINDS[kind].label} en este PC.`) }
    let dir = typeof cwd === 'string' && cwd ? path.resolve(cwd) : os.homedir()
    try { if (!fs.statSync(dir).isDirectory()) { throw new Error() } } catch { throw new Error('Esa carpeta no existe: ' + dir) }
    const args = []
    if (kind === 'claude') {
      if (resume) {
        if (!SID.test(resume)) { throw new Error('sesión no válida') }
        args.push('--resume', resume)
      } else if (cont) {
        args.push('--continue')
      }
    }
    if (kind === 'claude' && Array.isArray(extraArgs)) { args.unshift(...extraArgs) }
    if (kind === 'shell' && /pwsh|powershell/i.test(exe)) { args.push('-NoLogo') }
    // Los .cmd/.bat (programas de npm) se abren a través de cmd.exe, con la línea entera como texto
    // (node-pty la usa tal cual; si fuera una lista, volvería a poner comillas a su manera).
    let file = exe
    let argv = args
    if (/\.(cmd|bat)$/i.test(exe)) {
      file = process.env.ComSpec || 'cmd.exe'
      argv = cmdLine(exe, args)
    }
    const c = Math.max(20, Math.min(400, Number(cols) || 100))
    const r = Math.max(5, Math.min(200, Number(rows) || 30))
    const p = ptyLib().spawn(file, argv, { name: 'xterm-256color', cols: c, rows: r, cwd: dir, env: cleanEnv(), useConpty: true })
    noForkKill(p)
    const id = 't' + (++this.seq)
    const t = { id, kind, cwd: dir, pty: p, pid: p.pid, alive: true, code: null, buf: [], bytes: 0, pending: '', flushT: null, sessionId: resume || null, status: null, title: KINDS[kind].label, userTitle: '', startedAt: Date.now() }
    this.terms.set(id, t)
    p.onData(d => this.onData(t, d))
    p.onExit(e => {
      this.flush(t)
      t.alive = false
      t.code = e && Number.isFinite(e.exitCode) ? e.exitCode : null
      this.log.info(`[terminal ${id}] ${kind} terminó (código ${t.code})`)
      this.emit('ui', { kind: 'term-exit', id, code: t.code })
      this.emit('changed')
    })
    this.log.info(`[terminal ${id}] abierta: ${kind}${resume ? ' (retomando)' : cont ? ' (continuando)' : ''} en ${dir}`)
    this.emit('changed')
    if (kind === 'claude') { this.watch() }
    return this.publicOf(t)
  }

  onData(t, d) {
    if (t.kind === 'claude') {
      clearTimeout(t.quietT)
      t.quietT = setTimeout(() => { if (t.alive) { this.refreshAgents(true).catch(() => {}) } }, 2500)
    }
    t.buf.push(d)
    t.bytes += d.length
    while (t.bytes > KEEP_BYTES && t.buf.length > 1) { t.bytes -= t.buf.shift().length }
    // Se junta lo que llega en unos pocos milisegundos para no mandar un mensaje por letra.
    t.pending += d
    if (!t.flushT) { t.flushT = setTimeout(() => this.flush(t), 8) }
  }

  flush(t) {
    clearTimeout(t.flushT)
    t.flushT = null
    if (!t.pending) { return }
    const data = t.pending
    t.pending = ''
    this.emit('ui', { kind: 'term-data', id: t.id, data })
  }

  get(id) {
    const t = this.terms.get(id)
    if (!t) { throw new Error('esa terminal ya no existe') }
    return t
  }

  write(id, data) {
    const t = this.terms.get(id)
    if (t && t.alive && typeof data === 'string' && data.length <= 1024 * 1024) { t.pty.write(data) }
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id)
    if (!t || !t.alive) { return }
    const c = Math.max(20, Math.min(400, Math.floor(Number(cols)) || 0))
    const r = Math.max(5, Math.min(200, Math.floor(Number(rows)) || 0))
    try { t.pty.resize(c, r) } catch {}
  }

  /** Cierra la pestaña: si el programa sigue vivo, se termina. */
  close(id) {
    const t = this.terms.get(id)
    if (!t) { return false }
    clearTimeout(t.flushT)
    clearTimeout(t.quietT)
    if (t.alive) { try { t.pty.kill() } catch {} }
    this.terms.delete(id)
    this.emit('changed')
    return true
  }

  setTitle(id, title, byUser = false) {
    const t = this.terms.get(id)
    if (!t || typeof title !== 'string') { return }
    if (byUser) { t.userTitle = title.slice(0, 120) } else { t.title = title.slice(0, 120) }
  }

  alive() {
    return [...this.terms.values()].filter(t => t.alive).length
  }

  killAll() {
    this.unwatch()
    for (const t of this.terms.values()) {
      clearTimeout(t.quietT)
      if (t.alive) { try { t.pty.kill() } catch {} }
    }
  }

  publicOf(t, withBuffer = false) {
    return { id: t.id, kind: t.kind, label: KINDS[t.kind].label, cwd: t.cwd, alive: t.alive, code: t.code, sessionId: t.sessionId, status: t.status, title: t.title, userTitle: t.userTitle, startedAt: t.startedAt, ...(withBuffer ? { buffer: t.buf.join('') } : {}) }
  }

  list(withBuffer = false) {
    return [...this.terms.values()].map(t => this.publicOf(t, withBuffer))
  }

  /** Lo que hay que reabrir la próxima vez: las de Claude con su conversación. */
  snapshot() {
    return [...this.terms.values()].filter(t => t.alive).map(t => ({ kind: t.kind, cwd: t.cwd, sessionId: t.kind === 'claude' ? t.sessionId : null, title: (t.userTitle || t.title).slice(0, 80) }))
  }

  // ── Sesiones de Claude Code ─────────────────────────────────────────────────────────────────
  // `claude agents --json` lista las sesiones abiertas (las de aquí y las de otras ventanas) con
  // su pid, carpeta, conversación y si está trabajando. Con el pid se sabe cuál es cada pestaña.
  watch() {
    if (this.timer) { return }
    // Cada consulta arranca `claude` (~0,2 s de CPU): cada 5 s mientras se mira el modo Terminales y
    // cada 15 s si no (solo para avisar cuando Claude termina en una pestaña).
    this.timer = setInterval(() => {
      if (!this.keepWatching && ![...this.terms.values()].some(t => t.alive && t.kind === 'claude')) { this.unwatch(); return }
      if (!this.keepWatching && Date.now() - this.agentsAt < 14000) { return }
      this.refreshAgents().catch(() => {})
    }, 5000)
    this.refreshAgents().catch(() => {})
  }

  unwatch() {
    clearInterval(this.timer)
    this.timer = null
  }

  /** Mientras se ve el modo Terminales también se vigilan las sesiones de fuera. */
  setWatching(on) {
    this.keepWatching = Boolean(on)
    if (this.keepWatching) { this.watch() }
  }

  refreshAgents(force = false) {
    if (this.agentsBusy || (!force && Date.now() - this.agentsAt < 4000)) { return Promise.resolve(this.agents) }
    this.tools()
    const exe = this.paths.claude
    if (!exe) { return Promise.resolve(this.agents) }
    const viaCmd = /\.(cmd|bat)$/i.test(exe)
    this.agentsBusy = true
    return new Promise(resolve => {
      const file = viaCmd ? (process.env.ComSpec || 'cmd.exe') : exe
      const argv = viaCmd ? [cmdLine(exe, ['agents', '--json'])] : ['agents', '--json']
      execFile(file, argv, { windowsHide: true, windowsVerbatimArguments: viaCmd, timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: cleanEnv() }, (err, out) => {
        this.agentsBusy = false
        this.agentsAt = Date.now()
        if (err) { return resolve(this.agents) }
        let rows = null
        try { rows = JSON.parse(String(out)) } catch {}
        if (Array.isArray(rows)) { this.applyAgents(rows) }
        resolve(this.agents)
      })
    })
  }

  /** Lee la salida de `claude agents --json`: pone a cada pestaña de Claude su conversación y su
   *  estado (por el pid) y avisa cuando una pasa de trabajar a esperar. */
  applyAgents(rows) {
    this.agents = rows.filter(a => a && typeof a === 'object' && SID.test(String(a.sessionId || ''))).map(a => ({
      pid: Number(a.pid) || null,
      cwd: typeof a.cwd === 'string' ? a.cwd : '',
      kind: String(a.kind || ''),
      sessionId: String(a.sessionId),
      name: typeof a.name === 'string' ? a.name.slice(0, 80) : '',
      status: String(a.status || ''),
      startedAt: Number(a.startedAt) || null
    }))
    let changed = false
    for (const t of this.terms.values()) {
      if (t.kind !== 'claude' || !t.alive) { continue }
      let a = this.agents.find(x => x.pid === t.pid)
      if (!a) {
        const claimed = new Set([...this.terms.values()].filter(x => x !== t && x.sessionId).map(x => x.sessionId))
        const same = p => path.resolve(p || '').toLowerCase() === path.resolve(t.cwd).toLowerCase()
        a = this.agents.find(x => x.kind === 'interactive' && same(x.cwd) && x.startedAt && Math.abs(x.startedAt - t.startedAt) < 30000 && !claimed.has(x.sessionId))
      }
      if (a && (a.sessionId !== t.sessionId || a.status !== t.status)) {
        // Pasó de trabajar a esperar: Claude terminó una respuesta (para el aviso de Windows).
        if (t.status === 'busy' && a.status !== 'busy') { this.emit('done', this.publicOf(t), t.busySince ? Date.now() - t.busySince : null) }
        if (a.status === 'busy' && t.status !== 'busy') { t.busySince = Date.now() }
        t.sessionId = a.sessionId
        t.status = a.status
        changed = true
      }
    }
    if (changed) { this.emit('changed') }
    this.emit('ui', { kind: 'claude-agents', agents: this.agentsView() })
    if (![...this.terms.values()].some(t => t.alive && t.kind === 'claude') && !this.keepWatching) { this.unwatch() }
  }

  /** Las sesiones de Claude, marcando cuáles son pestañas de Pedila. */
  agentsView() {
    const byPid = new Map([...this.terms.values()].filter(t => t.alive).map(t => [t.pid, t.id]))
    const bySid = new Map([...this.terms.values()].filter(t => t.alive && t.sessionId).map(t => [t.sessionId, t.id]))
    return this.agents.map(a => ({ ...a, term: byPid.get(a.pid) || bySid.get(a.sessionId) || null }))
  }
}

/**
 * Línea para `cmd.exe /d /s /c "…"`. Cada parte con espacios o símbolos de cmd va entre comillas;
 * una comilla o un % dentro de una parte no se puede pasar con seguridad: se rechaza.
 */
function cmdLine(exe, args) {
  const q = a => {
    if (/["%\r\n\0]/.test(a)) { throw new Error('Opción no válida para cmd.exe (lleva comillas o %): ' + a) }
    return /[\s&()^|<>,;=!]/.test(a) || a === '' ? `"${a}"` : a
  }
  return '/d /s /c "' + [exe, ...args].map(q).join(' ') + '"'
}

/**
 * node-pty, al cerrar una consola, lanza un `fork` de Node para saber qué procesos cuelgan de ella.
 * En la app instalada el fusible runAsNode está apagado: ese fork arrancaría otro Pedila. Se cambia
 * por `taskkill /T` (cierra el programa y lo que haya abierto); el cierre de la consola hace el resto.
 */
function noForkKill(p) {
  const agent = p && p._agent
  if (!agent || typeof agent._getConsoleProcessList !== 'function') { return }
  agent._getConsoleProcessList = () => new Promise(resolve => {
    const pid = agent._innerPid || p.pid
    if (!pid) { return resolve([]) }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => resolve([]))
  })
}

/** «--effort max --model "opus"» → ['--effort', 'max', '--model', 'opus'] (comillas dobles o simples). */
function splitArgs(text) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(String(text || '')))) { out.push(m[1] ?? m[2] ?? m[3]) }
  return out.slice(0, 40)
}

module.exports = { Terms, KINDS, which, SID, splitArgs, cleanEnv, cmdLine }
