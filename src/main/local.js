'use strict'
// «Este PC»: el mismo Hermes que usa Hermes Desktop. Igual que su local-gateway.ts:
//  1. `hermes gateway ensure --json` da el endpoint (api_origin, instance_id…) y arranca el gateway
//     si no está en marcha;
//  2. los tickets de un solo uso salen del canal privado de Windows del gateway, que solo atiende al
//     mismo usuario; como Hermes Desktop, se piden con el Python de Hermes (_session_ticket) desde un
//     proceso auxiliar que se reutiliza;
//  3. el WebSocket /api/ws lleva el ticket como subprotocolo; cada petición REST lleva uno propio en
//     `X-Hermes-Gateway-Ticket` (propósito `native-http`).
const { execFile, spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const PROTOCOL = 'hermes-gateway-v1'

const BRIDGE_PY = `
import json, sys
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, ROOT)
with redirect_stdout(sys.stderr):
    import hermes_bootstrap
    from hermes_cli.gateway_client import _session_ticket
for raw in sys.stdin:
    try:
        req = json.loads(raw)
    except Exception:
        break
    try:
        with redirect_stdout(sys.stderr):
            ep = SimpleNamespace(**{'control_home': None, **req['endpoint']})
            purpose = req['purpose']
            ticket = _session_ticket(Path(ep.profile_id), ep, purpose=purpose,
                                     scope='host' if purpose == 'interactive' else None)
        out = {'id': req['id'], 'ticket': ticket}
    except Exception as exc:
        out = {'id': req.get('id'), 'error': type(exc).__name__ + ': ' + str(exc)[:200]}
    print(json.dumps(out), flush=True)
`

function hermesHome() {
  return path.join(process.env.LOCALAPPDATA || '', 'hermes')
}

function hermesExe() {
  return path.join(hermesHome(), 'bin', 'hermes.exe')
}

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(-400); return reject(err) }
      resolve(stdout)
    })
  })
}

class TicketBridge {
  constructor(python, root, home, log) {
    this.python = python
    this.root = root
    this.home = home
    this.log = log
    this.child = null
    this.buf = ''
    this.seq = 0
    this.pending = new Map()
    this.idle = null
  }

  start() {
    const code = `ROOT = ${JSON.stringify(this.root)}\n` + BRIDGE_PY
    this.child = spawn(this.python, ['-I', '-u', '-c', code], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: this.home, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      this.buf += chunk
      let nl
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line.startsWith('{')) { continue }
        let reply
        try { reply = JSON.parse(line) } catch { continue }
        const p = this.pending.get(reply.id)
        if (!p) { continue }
        this.pending.delete(reply.id)
        clearTimeout(p.timer)
        if (typeof reply.ticket === 'string' && reply.ticket) { p.resolve(reply.ticket) } else { p.reject(new Error(reply.error || 'ticket_failed')) }
      }
    })
    this.child.stderr.on('data', () => {})
    const dead = () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('El ayudante de tickets se cerró')) }
      this.pending.clear()
      this.child = null
    }
    this.child.on('exit', dead)
    this.child.on('error', dead)
  }

  mint(endpoint, purpose) {
    if (!this.child) { this.start() }
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.dispose(), 5 * 60 * 1000)
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => { if (this.pending.delete(id)) { reject(new Error('El ticket tardó demasiado')) } }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(JSON.stringify({ id, endpoint, purpose }) + '\n')
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  dispose() {
    clearTimeout(this.idle)
    if (this.child) {
      try { this.child.stdin.end() } catch {}
      const c = this.child
      setTimeout(() => { try { c.kill() } catch {} }, 2000)
      this.child = null
    }
  }
}

class LocalTransport {
  constructor({ log }) {
    this.log = log
    this.ep = null
    this.bridge = null
    this.kind = 'local'
  }

  available() {
    return fs.existsSync(hermesExe())
  }

  async endpoint(force = false) {
    if (this.ep && !force) { return this.ep }
    if (!this.available()) {
      const e = new Error('No encuentro Hermes en este PC (falta %LOCALAPPDATA%\\hermes\\bin\\hermes.exe)')
      e.fatal = true
      throw e
    }
    const out = await run(hermesExe(), ['gateway', 'ensure', '--json'], 120000)
    const line = out.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop()
    const j = line ? JSON.parse(line) : null
    if (!j || j.state !== 'ready' || !j.endpoint || j.endpoint.runtime_protocol !== 1) {
      throw new Error(`El gateway de Hermes no está listo (${j ? j.state : 'sin respuesta'})`)
    }
    const ep = j.endpoint
    const origin = new URL(ep.api_origin)
    if (origin.hostname !== '127.0.0.1' && origin.hostname !== 'localhost') { throw new Error('El gateway local no está en 127.0.0.1') }
    if (!this.bridge || (this.ep && this.ep.profile_id !== ep.profile_id)) { await this.makeBridge(ep) }
    this.ep = ep
    return ep
  }

  async makeBridge(ep) {
    if (this.bridge) { this.bridge.dispose() }
    const out = await run(hermesExe(), ['--print-runtime-command'], 60000)
    const cmd = JSON.parse(out.trim().split(/\r?\n/).pop())
    const python = cmd[0]
    if (typeof python !== 'string' || !path.isAbsolute(python) || !fs.existsSync(python)) { throw new Error('No encuentro el Python de Hermes') }
    const codeArg = cmd.find(a => typeof a === 'string' && a.includes('sys.path.insert(0,')) || ''
    const m = codeArg.match(/sys\.path\.insert\(0, '((?:[^'\\]|\\.)*)'\)/)
    const root = m ? m[1].replace(/\\\\/g, '\\') : path.join(hermesHome(), 'hermes-agent')
    this.bridge = new TicketBridge(python, root, ep.profile_id, this.log)
  }

  async ticket(purpose) {
    const ep = await this.endpoint()
    return this.bridge.mint(ep, purpose)
  }

  async wsTarget() {
    const ep = await this.endpoint()
    const ticket = await this.ticket('interactive')
    return { url: ep.api_origin.replace(/^http/, 'ws') + '/api/ws', protocols: [PROTOCOL, `hermes-gateway-ticket.${ticket}`] }
  }

  async fetchJson(p, { method = 'GET', body } = {}) {
    const ep = await this.endpoint()
    const ticket = await this.ticket('native-http')
    const headers = { 'X-Hermes-Gateway-Ticket': ticket }
    if (body !== undefined) { headers['Content-Type'] = 'application/json' }
    const res = await fetch(ep.api_origin + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json }
  }

  /** Tras una caída del socket: el gateway pudo reiniciarse con otro puerto o instancia. */
  invalidate() {
    this.ep = null
  }

  dispose() {
    if (this.bridge) { this.bridge.dispose() }
  }
}

module.exports = { LocalTransport, PROTOCOL }
