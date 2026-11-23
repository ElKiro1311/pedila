'use strict'
// JSON-RPC 2.0 channel over a WebSocket with the Hermes gateway (/api/ws), like Hermes Desktop's
// (apps/shared/src/json-rpc-channel.ts): `{"method":"event","params":{type,…}}` events, requests from the
// server `{id, method, params}` (permissions, questions…) and the `gateway.ping` heartbeat every 15 s; if
// nothing comes in for 45 s, it's taken for dead and closed to reconnect.
const { EventEmitter } = require('node:events')
const { tr } = require('./i18n')

const READY_TIMEOUT_MS = 20000
const HEARTBEAT_MS = 15000
const DEADLINE_MS = 45000

class RpcError extends Error {
  constructor(message, code, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

class RpcSocket extends EventEmitter {
  constructor({ url, protocols, name, log }) {
    super()
    this.url = url
    this.protocols = protocols
    this.name = name
    this.log = log
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.lastInbound = 0
    this.timer = null
    this.closed = false
    this.ready = null
  }

  open() {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = err => { if (!settled) { settled = true; reject(err) } }
      const t = setTimeout(() => { fail(new Error(tr("The gateway didn't answer in time"))); this.close(4001, 'ready timeout') }, READY_TIMEOUT_MS)
      try {
        this.ws = this.protocols ? new WebSocket(this.url, this.protocols) : new WebSocket(this.url)
      } catch (e) {
        clearTimeout(t)
        return fail(e)
      }
      this.ws.addEventListener('message', async m => {
        this.lastInbound = Date.now()
        let text = m.data
        if (typeof text !== 'string') {
          try { text = typeof text.text === 'function' ? await text.text() : Buffer.from(text).toString('utf8') } catch { return }
        }
        let frame
        try { frame = JSON.parse(text) } catch { return }
        if (!frame || typeof frame !== 'object') { return }
        if (frame.method === 'event' && frame.params && typeof frame.params.type === 'string') {
          if (frame.params.type === 'gateway.ready' && !settled) {
            settled = true
            clearTimeout(t)
            this.ready = frame.params.payload || {}
            if (this.ready.heartbeat) { this.startHeartbeat() }
            resolve(this.ready)
          }
          this.emit('event', frame.params)
          return
        }
        if (frame.id !== undefined && frame.id !== null && typeof frame.method === 'string') {
          this.emit('request', { id: frame.id, method: frame.method, params: frame.params || {} })
          return
        }
        if (frame.id !== undefined && frame.id !== null) {
          const call = this.pending.get(frame.id)
          if (!call) { return }
          this.pending.delete(frame.id)
          clearTimeout(call.timer)
          if (frame.error) {
            const data = frame.error.data && typeof frame.error.data === 'object' ? frame.error.data : {}
            call.reject(new RpcError(String(frame.error.message || 'request_failed'), frame.error.code, data))
          } else {
            call.resolve(frame.result)
          }
        }
      })
      this.ws.addEventListener('close', ev => {
        clearTimeout(t)
        this.stopHeartbeat()
        for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new RpcError(tr('The connection with Hermes was lost'), -1)) }
        this.pending.clear()
        fail(new Error(tr('Connection closed ({0})', ev.code)))
        if (!this.closed) { this.closed = true; this.emit('close', { code: ev.code, reason: ev.reason || '' }) }
      })
      this.ws.addEventListener('error', () => { /* the closing arrives through 'close' */ })
    })
  }

  request(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) { return reject(new RpcError(tr('No connection with Hermes'), -1)) }
      const id = ++this.seq
      const timer = timeoutMs > 0
        ? setTimeout(() => { if (this.pending.delete(id)) { reject(new RpcError(tr("Hermes didn't answer ({0})", method), -2)) } }, timeoutMs)
        : null
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new RpcError(e.message, -1))
      }
    })
  }

  respond(id, result) {
    this.sendRaw({ jsonrpc: '2.0', id, result })
  }

  respondError(id, code, message) {
    this.sendRaw({ jsonrpc: '2.0', id, error: { code, message } })
  }

  sendRaw(obj) {
    try { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)) } } catch {}
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.lastInbound = Date.now()
    let n = 0
    this.timer = setInterval(() => {
      if (Date.now() - this.lastInbound > DEADLINE_MS) {
        this.log.warn(`[${this.name}] no heartbeat in ${DEADLINE_MS / 1000} s: reconnecting`)
        this.close(4000, 'heartbeat')
        return
      }
      this.sendRaw({ jsonrpc: '2.0', id: `ping-${++n}`, method: 'gateway.ping', params: {} })
    }, HEARTBEAT_MS)
  }

  stopHeartbeat() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  close(code = 1000, reason = '') {
    this.stopHeartbeat()
    try { if (this.ws && this.ws.readyState <= 1) { this.ws.close(code, reason) } } catch {}
  }
}

module.exports = { RpcSocket, RpcError }
