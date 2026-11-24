'use strict'
// The connection with a Hermes: connecting again from scratch (another session, another address), what it says
// while Hermes restarts, and requests that must all go to the same Hermes.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Connection } = require('../src/main/connection')
const { RemoteTransport } = require('../src/main/remote')
const { LocalTransport } = require('../src/main/local')
const { trayLabel } = require('../src/main/extras')
const { setLang } = require('../src/main/i18n')

const quiet = { info() {}, warn() {} }
const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let i = 0; i < 10; i++) { await tick() } }

/** A make-believe server: where it connects to, the sockets it opened and how each attempt goes. */
function fakeServer(over = {}) {
  const h = { base: 'http://192.168.1.50:9119', tickets: 0, sockets: [], hold: null, holdOpen: null, fail: null, invalidated: 0, states: [] }
  const transport = {
    async wsTarget() {
      h.tickets++
      const { base, hold, fail } = h
      if (hold) { await hold }
      if (fail) { throw fail }
      return { url: base.replace(/^http/, 'ws') + '/api/ws?ticket=' + h.tickets, protocols: null }
    },
    invalidate() { h.invalidated++ },
    dispose() {},
    fetchJson: async () => ({ status: 404, json: null })
  }
  class Socket extends EventEmitter {
    constructor({ url }) { super(); this.url = url; this.closed = false; h.sockets.push(this) }
    async open() { if (h.holdOpen) { await h.holdOpen } return { session_authority: false } }
    async request() { return {} }
    close() { this.closed = true }
  }
  h.c = new Connection({ id: 'server', name: 'Server', transport, log: quiet, Socket, ...over })
  h.c.reattachRunning = async () => {}
  h.c.on('state', s => h.states.push(s))
  h.open = () => h.sockets.filter(s => !s.closed)
  return h
}

test('signing in again with the socket still open connects from scratch', async () => {
  const h = fakeServer()
  h.c.start()
  await settle()
  assert.equal(h.c.state, 'ready')
  assert.equal(h.c.origin, 'ws://192.168.1.50:9119')
  // Hermes closed its web session, but not the socket. A chat was running.
  h.c.turnStart.set('chat-1', 1)
  const lost = []
  h.c.on('ui', e => { if (e.kind === 'turn-lost') { lost.push(e.sid) } })
  h.c.reconnect()
  assert.equal(h.c.state, 'connecting')
  await settle()
  assert.equal(h.c.state, 'ready')
  assert.equal(h.tickets, 2)
  assert.equal(h.open().length, 1)
  assert.equal(h.c.socket, h.sockets[1])
  assert.deepEqual(lost, ['chat-1'])
  // The socket from before closing now isn't a drop.
  h.c.onClose(h.sockets[0], { code: 1000, reason: 'bye' })
  assert.equal(h.c.state, 'ready')
  // A stopped connection isn't started.
  h.c.stop()
  assert.equal(h.open().length, 0)
  h.c.reconnect()
  await settle()
  assert.equal(h.tickets, 2)
})

test('an attempt from before (another session) is no longer good, wherever it was', async () => {
  // Waiting for its ticket, which fails because that session had expired.
  const h = fakeServer()
  let release
  h.hold = new Promise(resolve => { release = resolve })
  h.fail = Object.assign(new Error('expired'), { needLogin: true })
  h.c.start()
  await settle()
  h.hold = null
  h.fail = null
  h.c.reconnect()
  await settle()
  assert.equal(h.c.state, 'ready')
  release()
  await settle()
  assert.equal(h.c.state, 'ready') // it doesn't go to "not signed in"
  assert.equal(h.open().length, 1)
  // While a new attempt is under way, one from before that ends doesn't let another one in.
  h.hold = new Promise(resolve => { release = resolve })
  h.c.reconnect()
  let second
  h.hold = new Promise(resolve => { second = resolve })
  h.c.reconnect()
  release()
  await settle()
  const before = h.tickets
  h.c.connect()
  await settle()
  assert.equal(h.tickets, before)
  second()
  h.hold = null
  await settle()
  assert.equal(h.c.state, 'ready')
  assert.equal(h.open().length, 1)
  // Opening its socket.
  let letOpen
  h.holdOpen = new Promise(resolve => { letOpen = resolve })
  h.c.reconnect()
  await settle()
  assert.equal(h.c.state, 'connecting')
  h.holdOpen = null
  h.c.reconnect()
  await settle()
  assert.equal(h.c.state, 'ready')
  const current = h.c.socket
  letOpen()
  await settle()
  assert.equal(h.c.socket, current)
  assert.equal(h.open().length, 1)
  // Stopping and starting again at once isn't held back by the attempt that was under way.
  h.holdOpen = new Promise(resolve => { letOpen = resolve })
  h.c.reconnect()
  await settle()
  h.c.stop()
  h.holdOpen = null
  h.c.start()
  await settle()
  assert.equal(h.c.state, 'ready')
  letOpen()
  await settle()
  assert.equal(h.open().length, 1)
})

test("the server's address changes: it only connects again if what's open goes to one that's no longer there", async () => {
  const h = fakeServer()
  h.c.start()
  await settle()
  // An alternative one is added: the socket stays.
  h.c.addressesChanged(['http://192.168.1.50:9119', 'http://100.64.0.1:9119/'])
  await settle()
  assert.equal(h.tickets, 1)
  assert.equal(h.open().length, 1)
  assert.equal(h.invalidated, 1)
  // It's another one.
  h.base = 'http://192.168.1.99:9119'
  h.c.addressesChanged(['http://192.168.1.99:9119', 'not an address'])
  await settle()
  assert.equal(h.c.state, 'ready')
  assert.equal(h.c.origin, 'ws://192.168.1.99:9119')
  assert.equal(h.open().length, 1)
  // While it's connecting to the one from before, that attempt is no longer good.
  let release
  h.hold = new Promise(resolve => { release = resolve })
  h.c.reconnect()
  h.hold = null
  h.base = 'http://192.168.1.77:9119'
  h.c.addressesChanged(['http://192.168.1.77:9119'])
  release()
  await settle()
  assert.equal(h.c.state, 'ready')
  assert.equal(h.c.origin, 'ws://192.168.1.77:9119')
  assert.equal(h.open().length, 1)
  // With none, it's closed.
  h.fail = Object.assign(new Error('missing'), { setup: true })
  h.c.addressesChanged([])
  await settle()
  assert.equal(h.c.state, 'setup')
  assert.equal(h.open().length, 0)
})

test("while Hermes restarts, it's said so (and not with the mark it's stored with)", async () => {
  const h = fakeServer()
  h.c.stopped = true
  h.c.setState('updating', 'restarting')
  await assert.rejects(h.c.waitReady(5), /Server: restarting Hermes…/)
  h.c.setState('updating', '0.23.2 → 0.23.3')
  await assert.rejects(h.c.waitReady(5), /Server: 0\.23\.2 → 0\.23\.3/)
  const local = new LocalTransport({ log: quiet })
  local.pause('restart')
  await assert.rejects(local.fetchJson('/api/sessions'), /is restarting/)
  local.pause()
  await assert.rejects(local.fetchJson('/api/sessions'), /is updating/)
  setLang('es')
  try {
    assert.equal(trayLabel({ state: 'updating', detail: 'restarting' }), 'reiniciando Hermes…')
    assert.equal(trayLabel({ state: 'updating', detail: '0.23.2 → 0.23.3' }), 'actualizando Hermes…')
    assert.equal(trayLabel({ state: 'ready', detail: 'restarting' }), 'conectado')
    assert.equal(trayLabel({ state: 'something-new' }), 'something-new')
  } finally {
    setLang('en')
  }
})

test('several requests in a row that must go to the same server, even if its address changes meanwhile', async t => {
  const settings = { data: { server: { urls: ['http://a:9119'] }, secrets: {} }, save() {} }
  const tr = new RemoteTransport({ settings, secrets: { encrypt: async () => 'x' }, log: quiet })
  tr.jar.set('hermes_session_at', 'x')
  const asked = []
  const answer = { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({}), text: async () => '{"ok":true}' }
  t.mock.method(globalThis, 'fetch', async (url, o = {}) => { if (!url.endsWith('/api/status')) { asked.push(`${o.method || 'GET'} ${url}`) } return answer })
  const pinned = await tr.pinned()
  assert.deepEqual(await pinned.fetchJson('/one', { method: 'POST', body: {} }), { status: 200, json: { ok: true } })
  settings.data.server.urls = ['http://b:9119']
  tr.invalidate()
  await pinned.fetchJson('/two', { method: 'DELETE' })
  await tr.fetchJson('/three')
  assert.deepEqual(asked, ['POST http://a:9119/one', 'DELETE http://a:9119/two', 'GET http://b:9119/three'])
  // Another session (perhaps in another server) cuts it off: its cookie doesn't go to the one from before.
  answer.headers.getSetCookie = () => ['hermes_session_at=session-of-b; Path=/']
  assert.equal((await tr.login('someone', 'x')).ok, true)
  await assert.rejects(pinned.fetchJson('/four'), e => e.needLogin === true)
  // And an answer that arrives late to the session from before doesn't touch the new one's cookies.
  const late = await tr.pinned()
  let letGo
  const wait = new Promise(resolve => { letGo = resolve })
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/api/status')) { return answer }
    await wait
    return { ...answer, headers: { getSetCookie: () => ['hermes_session_at=; Max-Age=0'] } }
  })
  const pending = late.fetchJson('/five')
  await settle()
  tr.sessionNo++
  letGo()
  await pending
  assert.equal(tr.jar.get('hermes_session_at'), 'session-of-b')
  tr.jar.clear()
  await assert.rejects(tr.fetchJson('/six'), e => e.needLogin === true)
  clearTimeout(tr.saveTimer)
  settings.data.server.urls = []
  await assert.rejects(tr.pinned(), e => e.setup === true)
})
