'use strict'
// Automatic updates: Hermes's new version (when it installs and when it doesn't), the .cmd that reinstalls
// Pedila and opens it again, and the new settings.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { sanitize } = require('../src/main/settings')
const { relaunchScript, verifiedFile } = require('../src/main/extras')
const { HermesUpdates, infoFrom, decide, newestActivity, rosterBusy, IDLE_MS } = require('../src/main/hermes-updates')

const MIN = 60 * 1000

test("settings: installing Pedila's and Hermes's versions automatically comes on and can be turned off", () => {
  const d = sanitize({})
  assert.equal(d.updates.autoInstall, true)
  assert.equal(d.hermes.autoUpdate, true)
  const s = sanitize({ updates: { autoInstall: false }, hermes: { autoUpdate: false } })
  assert.equal(s.updates.autoInstall, false)
  assert.equal(s.hermes.autoUpdate, false)
  assert.equal(sanitize({ hermes: { autoUpdate: 'yes' } }).hermes.autoUpdate, true)
})

test('Hermes version: git that can be updated, going back, Docker and no answer', () => {
  const git = infoFrom({ install_method: 'git', can_apply: true, current_version: '0.23.0', update_available: true, source_version: '0.23.2' }, '', '9.9.9')
  assert.deepEqual(git, { version: '0.23.0', latest: '0.23.2', available: true, canApply: true, method: 'git' })
  // This build is newer than the stable one: "updating" would be going back, and that isn't done
  // automatically.
  assert.equal(infoFrom({ install_method: 'git', can_apply: true, current_version: '0.24.0', update_available: true, rollback_to: '0.23.2', source_version: '0.23.2' }).available, false)
  const docker = infoFrom({ install_method: 'managed-runtime', can_apply: false, current_version: '0.23.1', update_available: false }, '', 'v0.23.2')
  assert.deepEqual(docker, { version: '0.23.1', latest: '0.23.2', available: true, canApply: false, method: 'managed-runtime' })
  assert.equal(infoFrom(null, '0.23.2', '0.23.2').available, false)
  assert.equal(infoFrom(null, '0.23.1', '').available, false, 'without the published version nothing is made up')
  assert.equal(infoFrom(null, '0.23.1', '0.23.2').canApply, false)
})

test('when Hermes installs itself', () => {
  const now = 100 * MIN
  const info = { version: '0.23.0', latest: '0.23.2', available: true, canApply: true }
  const base = { info, watchingSince: now - 11 * MIN, lastBusyAt: 0, lastActive: now - 30 * MIN, busy: false, applying: null, lastResult: null }
  assert.equal(decide(base, { now, auto: true }), 'install')
  assert.equal(decide({ ...base, info: { ...info, available: false } }, { now, auto: true }), 'up-to-date')
  assert.equal(decide({ ...base, info: { ...info, canApply: false } }, { now, auto: true }), 'server')
  assert.equal(decide(base, { now, auto: false }), 'manual')
  assert.equal(decide({ ...base, watchingSince: now - 5 * MIN }, { now, auto: true }), 'watching')
  assert.equal(decide({ ...base, busy: true }, { now, auto: true }), 'in-use')
  assert.equal(decide({ ...base, lastBusyAt: now - 9 * MIN }, { now, auto: true }), 'in-use')
  assert.equal(decide({ ...base, lastActive: now - 2 * MIN }, { now, auto: true }), 'in-use')
  assert.equal(decide({ ...base, lastResult: { ok: false, to: '0.23.2', at: now - 60 * MIN } }, { now, auto: true }), 'recent-failure')
  // After 6 h, or with another new version, it's tried again.
  assert.equal(decide({ ...base, lastResult: { ok: false, to: '0.23.2', at: now - 7 * 60 * MIN } }, { now: now, auto: true }), 'install')
  assert.equal(decide({ ...base, lastResult: { ok: false, to: '0.23.1', at: now - MIN } }, { now, auto: true }), 'install')
  assert.equal(decide({ ...base, applying: { at: now } }, { now, auto: true }), 'installing')
  // When subagents or chats can't be checked, no; nor if you're using Pedila or the PC.
  assert.equal(decide({ ...base, blind: true }, { now, auto: true }), 'unknown')
  assert.equal(decide(base, { now, auto: true, userBusy: 'the PC is in use' }), 'user-busy')
  assert.equal(decide({ ...base, busy: true }, { now, auto: true, userBusy: 'the PC is in use' }), 'in-use')
})

test('subagent.roster: subagents or background processes', () => {
  assert.equal(rosterBusy({ sessions: [] }), false)
  assert.equal(rosterBusy({ sessions: [{ session_id: 'a', subagents: 0, background: 0 }] }), false)
  assert.equal(rosterBusy({ sessions: [{ session_id: 'a', subagents: 1, background: 0 }] }), true)
  assert.equal(rosterBusy({ sessions: [{ session_id: 'a', subagents: 0, background: 2 }] }), true)
  assert.equal(rosterBusy(null), null, 'an odd answer isn\'t taken for "nothing running"')
  assert.equal(rosterBusy({}), null)
})

test("most recent activity of Hermes's chats (seconds or milliseconds)", () => {
  assert.equal(newestActivity([{ last_active: 1000 }, { last_active: 2000.5 }, { last_activity_at: 1500 }]), 2000500)
  assert.equal(newestActivity([{ last_active: 1795102496000 }]), 1795102496000)
  assert.equal(newestActivity([]), 0)
  assert.equal(newestActivity(null), 0)
})

test('the .cmd that installs Pedila and opens it again the way it was: no paths inside (cmd would break accents)', () => {
  const s = relaunchScript(['--oculto'])
  assert.deepEqual(s.split('\r\n'), ['@echo off', '"%PEDILA_SETUP%" /S', 'start "" "%PEDILA_EXE%" --oculto', ''])
  assert.match(s, /^[\x20-\x7e\r\n]*$/, 'ASCII only: read the same with any code page')
  // Only --like-this options get through.
  const raro = relaunchScript(['--sin-foco', '& del *', '--x'])
  assert.match(raro, /"%PEDILA_EXE%" --sin-foco --x\r\n$/)
  assert.doesNotMatch(raro, /del \*/)
  assert.match(relaunchScript(), /start "" "%PEDILA_EXE%"\r\n$/)
})

test('installer already downloaded: reused only if its checksum still matches', () => {
  const tmp = path.join(os.tmpdir(), `pedila-test-${process.pid}.bin`)
  fs.writeFileSync(tmp, 'hola')
  const sha = crypto.createHash('sha256').update('hola').digest('hex')
  assert.equal(verifiedFile(tmp, sha), true)
  fs.writeFileSync(tmp, 'cambiado')
  assert.equal(verifiedFile(tmp, sha), false)
  fs.unlinkSync(tmp)
  assert.equal(verifiedFile(tmp, sha), false)
})

/**
 * A make-believe Hermes: what /api/status, the chat list, /api/hermes/update/check (null = it fails),
 * session.active_list and subagent.roster (an object, or a function per call) would answer.
 */
function fakeConn(id, over = {}) {
  const c = {
    id, state: 'ready', stopped: false, calls: [],
    status: { version: '0.23.0', active_agents: 0, gateway_busy: false },
    sessions: [{ last_active: 1 }],
    active: [],
    roster: { sessions: [] },
    rosterFail: false,
    check: { install_method: 'git', can_apply: true, current_version: '0.23.0', update_available: true, source_version: '0.23.2' },
    transport: {
      publicJson: async p => { c.calls.push('GET ' + p); return { status: 200, json: c.status } },
      fetchJson: async p => {
        c.calls.push('GET ' + p)
        if (p.startsWith('/api/sessions')) { return { status: 200, json: { sessions: c.sessions } } }
        if (p.startsWith('/api/hermes/update/check')) { return c.check ? { status: 200, json: c.check } : { status: 500, json: null } }
        return { status: 404, json: null }
      },
      invalidate: () => c.calls.push('invalidate'),
      pause: why => c.calls.push(why ? `pause ${why}` : 'pause'),
      resume: () => c.calls.push('resume')
    },
    async activeList() { c.calls.push('RPC session.active_list'); return c.active },
    async rpc(method) {
      c.calls.push('RPC ' + method)
      if (method !== 'subagent.roster') { throw new Error('unknown rpc') }
      if (c.rosterFail) { throw new Error('method not found') }
      return typeof c.roster === 'function' ? c.roster() : c.roster
    },
    stop() { c.stopped = true; c.calls.push('stop') },
    start() { c.stopped = false; c.state = 'ready'; c.calls.push('start') },
    setState(s, d) { c.state = s; c.calls.push(`state ${s}${d ? ' ' + d : ''}`) },
    ...over
  }
  return c
}

const quiet = { info() {}, warn() {} }
const settingsOn = { data: { hermes: { autoUpdate: true } } }

test("the PC's Hermes: waits 10 min unused, closes the connection, updates and connects again", async () => {
  let t = 1000 * MIN
  const local = fakeConn('local')
  const runs = []
  const hu = new HermesUpdates({
    conns: { local }, settings: { data: { hermes: { autoUpdate: true } } }, log: { info() {}, warn() {} },
    hermesExe: () => 'C:\\hermes\\bin\\hermes.exe', now: () => t,
    run: async (file, args) => { runs.push([file, ...args]); return { code: 0, tail: 'Hermes updated' } },
    fetchImpl: async () => { throw new Error("it shouldn't ask GitHub with a git installation") }
  })
  await hu.tickOne(local)
  assert.equal(hu.view().local.available, true)
  assert.equal(hu.view().local.why, 'watching')
  assert.equal(runs.length, 0)
  // After 5 min it's working: another 10 have to be waited from there.
  t += 5 * MIN
  local.status = { ...local.status, active_agents: 1, gateway_busy: true }
  await hu.tickOne(local)
  assert.equal(hu.view().local.why, 'in-use')
  local.status = { ...local.status, active_agents: 0, gateway_busy: false }
  t += 9 * MIN
  await hu.tickOne(local)
  assert.equal(runs.length, 0, '9 min after working, not yet')
  t += 2 * MIN
  await hu.tickOne(local)
  assert.deepEqual(runs, [['C:\\hermes\\bin\\hermes.exe', 'update']])
  const seq = local.calls.filter(x => !x.startsWith('GET') && !x.startsWith('RPC'))
  // The transport is paused during the update: nothing of Hermes is started meanwhile.
  assert.deepEqual(seq, ['stop', 'pause', 'state updating 0.23.0 → 0.23.2', 'resume', 'invalidate', 'state connecting', 'start'])
  // The chat list goes by last activity (otherwise Hermes sorts it by creation date).
  assert.ok(local.calls.some(x => x.startsWith('GET /api/sessions') && x.includes('order=recent')))
  const v = hu.view().local
  assert.equal(v.lastResult.ok, true)
  assert.equal(v.applying, null)
})

test("the PC's Hermes: with subagents or background processes it isn't updated (active_agents doesn't count them)", async () => {
  let t = 4000 * MIN
  const local = fakeConn('local')
  local.roster = { sessions: [{ session_id: 's1', subagents: 0, background: 1 }] }
  let runs = 0
  const hu = new HermesUpdates({ conns: { local }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, run: async () => { runs++; return { code: 0 } } })
  for (let i = 0; i < 15; i++) { await hu.tickOne(local); t += MIN }
  assert.equal(runs, 0)
  assert.equal(hu.view().local.why, 'in-use')
  // A chat working according to session.active_list, the same.
  local.roster = { sessions: [] }
  local.active = [{ id: 'x', status: 'working' }]
  for (let i = 0; i < 12; i++) { await hu.tickOne(local); t += MIN }
  assert.equal(runs, 0)
  // Everything ends: 10 min later, yes.
  local.active = []
  for (let i = 0; i < 9; i++) { await hu.tickOne(local); t += MIN }
  assert.equal(runs, 0, 'less than 10 min since the last thing running')
  t += 2 * MIN
  await hu.tickOne(local)
  assert.equal(runs, 1)
})

test("the PC's Hermes: if something starts right before updating, it looks again and doesn't update", async () => {
  let t = 4500 * MIN
  const local = fakeConn('local')
  let n = 0
  // The 1st look and the 2nd (the one that decides) see nothing; the 3rd, right before updating, sees a
  // subagent.
  local.roster = () => (++n >= 3 ? { sessions: [{ session_id: 's', subagents: 1, background: 0 }] } : { sessions: [] })
  let runs = 0
  const hu = new HermesUpdates({ conns: { local }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, run: async () => { runs++; return { code: 0 } } })
  await hu.tickOne(local)
  t += 11 * MIN
  await hu.tickOne(local)
  assert.equal(n, 3)
  assert.equal(runs, 0)
  assert.equal(hu.view().local.why, 'in-use')
  assert.ok(!local.calls.includes('stop'), "the connection wasn't even closed")
})

test("the PC's Hermes: when subagents can't be checked it isn't updated, but that doesn't hold Pedila back", async () => {
  let t = 5000 * MIN
  const local = fakeConn('local')
  local.rosterFail = true
  let runs = 0
  const hu = new HermesUpdates({ conns: { local }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, run: async () => { runs++; return { code: 0 } } })
  for (let i = 0; i < 12; i++) { await hu.tickOne(local); t += MIN }
  assert.equal(runs, 0)
  assert.equal(hu.view().local.why, 'unknown')
  assert.equal(hu.busyWithin('local', IDLE_MS, t), false, 'restarting Pedila cuts nothing of Hermes off')
})

test("the PC's Hermes: if you're using Pedila or the PC, it waits", async () => {
  let t = 5500 * MIN
  const local = fakeConn('local')
  let you = 'the PC is in use'
  let runs = 0
  const hu = new HermesUpdates({ conns: { local }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, userBusy: () => you, run: async () => { runs++; return { code: 0 } } })
  await hu.tickOne(local)
  t += 11 * MIN
  await hu.tickOne(local)
  assert.equal(runs, 0)
  assert.equal(hu.view().local.why, 'user-busy')
  you = ''
  t += MIN
  await hu.tickOne(local)
  assert.equal(runs, 1)
})

test('version "0.23.0+12.gabc" (a build ahead of its tag): it isn\'t checked every minute', async () => {
  let t = 6000 * MIN
  const local = fakeConn('local')
  local.check = { install_method: 'git', can_apply: true, current_version: '0.23.0+12.gabc1234', update_available: false }
  const hu = new HermesUpdates({ conns: { local }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, run: async () => ({ code: 0 }) })
  for (let i = 0; i < 10; i++) { await hu.tickOne(local); t += MIN }
  assert.equal(local.calls.filter(x => x.includes('/update/check')).length, 1)
})

test("GitHub answering 403: it isn't asked again for hours (the limit without a key is per IP)", async () => {
  let t = 7000 * MIN
  const server = fakeConn('server', { state: 'login' })
  server.status = { version: '0.23.1', active_agents: 0, gateway_busy: false }
  let gh = 0
  const hu = new HermesUpdates({ conns: { server }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, fetchImpl: async () => { gh++; return { ok: false, status: 403 } } })
  await hu.tickOne(server)
  assert.equal(gh, 1)
  for (let i = 0; i < 3; i++) { t += MIN; await hu.checkNow('server') }
  assert.equal(gh, 1, '"Check now" doesn\'t insist either')
  t += 6 * 60 * MIN + MIN
  await hu.tickOne(server)
  assert.equal(gh, 2)
})

test("the PC's Hermes: if the check fails once, what was known stays and it's repeated after 15 min", async () => {
  let t = 8000 * MIN
  const local = fakeConn('local')
  const hu = new HermesUpdates({ conns: { local }, settings: { data: { hermes: { autoUpdate: false } } }, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, fetchImpl: async () => assert.fail("GitHub isn't needed") })
  await hu.tickOne(local)
  assert.equal(hu.view().local.canApply, true)
  const checks = () => local.calls.filter(x => x.includes('/update/check')).length
  local.check = null
  t += 6 * 60 * MIN + MIN
  await hu.tickOne(local)
  assert.equal(checks(), 2)
  assert.equal(hu.view().local.canApply, true, 'it doesn\'t turn into "it\'s updated from its server"')
  t += 10 * MIN
  await hu.tickOne(local)
  assert.equal(checks(), 2)
  t += 6 * MIN
  await hu.tickOne(local)
  assert.equal(checks(), 3)
})

test("This PC: while Hermes updates nothing of its own is started, and afterwards it's asked again where it is", async () => {
  const { LocalTransport } = require('../src/main/local')
  const tr = new LocalTransport({ log: quiet })
  tr.ep = { api_origin: 'http://127.0.0.1:1', profile_id: 'x' }
  let disposed = 0
  tr.bridge = { dispose: () => { disposed++ }, mint: async () => assert.fail("it shouldn't ask for tickets") }
  tr.pause()
  assert.equal(disposed, 1)
  await assert.rejects(tr.fetchJson('/api/sessions'), /is updating/)
  await assert.rejects(tr.wsTarget(), /is updating/)
  tr.resume()
  assert.equal(Boolean(tr.paused), false)
  assert.equal(tr.ep, null)
  assert.equal(tr.bridge, null)
})

test("the PC's Hermes: if the update fails, it isn't retried until 6 h later", async () => {
  let t = 2000 * MIN
  const local = fakeConn('local')
  let runs = 0
  const hu = new HermesUpdates({
    conns: { local }, settings: { data: { hermes: { autoUpdate: true } } }, log: { info() {}, warn() {} },
    hermesExe: () => 'hermes.exe', now: () => t, run: async () => { runs++; return { code: 1, tail: "error: I couldn't\n✗ the download failed" } }
  })
  await hu.tickOne(local)
  t += 11 * MIN
  await hu.tickOne(local)
  assert.equal(runs, 1)
  assert.equal(hu.view().local.lastResult.ok, false)
  assert.equal(hu.view().local.lastResult.error, '✗ the download failed')
  for (let i = 0; i < 5; i++) { t += 30 * MIN; await hu.tickOne(local) }
  assert.equal(runs, 1, "meanwhile it isn't repeated")
  t += 4 * 60 * MIN
  await hu.tickOne(local)
  assert.equal(runs, 2)
})

test("the server's Hermes in Docker: only a notice, never updates; without a session it looks at its version too", async () => {
  const t = 3000 * MIN
  const server = fakeConn('server', { state: 'login' })
  server.status = { version: '0.23.1', active_agents: 0, gateway_busy: false }
  let runs = 0
  const hu = new HermesUpdates({
    conns: { server }, settings: { data: { hermes: { autoUpdate: true } } }, log: { info() {}, warn() {} },
    hermesExe: () => 'hermes.exe', now: () => t, run: async () => { runs++; return { code: 0 } },
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.23.2' }) })
  })
  await hu.tickOne(server)
  const v = hu.view().server
  assert.deepEqual([v.version, v.latest, v.available, v.canApply], ['0.23.1', '0.23.2', true, false])
  assert.ok(!server.calls.some(x => x.includes('/api/sessions') || x.includes('/update/check') || x.startsWith('RPC')), 'without a session it only reads /api/status')
  await hu.applyNow('server').then(() => assert.fail("it shouldn't"), e => assert.match(e.message, /server/))
  assert.equal(runs, 0)
  assert.equal(IDLE_MS, 10 * MIN)
})

test("on connecting, Pedila follows the working chats again (and doesn't stop because one fails)", async () => {
  const { Connection } = require('../src/main/connection')
  const c = new Connection({ id: 'local', name: 'This PC', transport: {}, log: { info() {}, warn() {} } })
  c.state = 'ready'
  c.stopped = false
  const attached = []
  c.rpc = async () => ({ sessions: [{ id: 'a', status: 'working', title: 'Paper Mario' }, { id: 'b', status: 'idle' }, { id: 'c', status: 'waiting' }, { session_key: 'd', id: 'sock-1', status: 'starting' }] })
  c.live.set('c', { liveId: 'c', running: true })
  c.attach = async sid => { if (sid === 'a') { throw new Error('it dropped') } attached.push(sid) }
  await c.reattachRunning()
  assert.deepEqual(attached, ['d'], "a failed, b isn't working, c was already attached, d is")
})

test('model and effort of a chat already started, new protocol: session.mutate with its fences, confirmation and retry', async () => {
  const { Connection } = require('../src/main/connection')
  const c = new Connection({ id: 'local', name: 'This PC', transport: {}, log: { info() {}, warn() {} } })
  c.canonical = true
  c.attach = async sid => ({ liveId: sid })
  let rev = 7
  c.transport.fetchJson = async p => ({ status: 200, json: { exists: true, runtime_revision: rev, runtime_generation: 3 } })
  const calls = []
  let conflictOnce = true
  c.rpc = async (method, params) => {
    calls.push([method, params.operation, params.payload, params.expected_revision, params.expected_generation])
    if (params.operation === 'model' && conflictOnce) { conflictOnce = false; rev = 8; const e = new Error('revision_conflict'); throw e }
    if (params.operation === 'model' && params.payload.model === 'caro' && !params.payload.confirm) { return { status: 'confirmation_required', confirm: 'abc123', confirm_message: "It's expensive", target_model: 'caro', target_provider: 'nube' } }
    return { ok: true }
  }
  const ui = []
  c.on('ui', e => ui.push(e))
  assert.deepEqual(await c.setChatOptions('s1', { model: 'qwen', provider: 'local' }), { applied: 'now', model: 'qwen', effort: null })
  assert.deepEqual(calls.slice(0, 2).map(x => x.slice(0, 4)), [['session.mutate', 'model', { model: 'qwen', provider: 'local' }, 7], ['session.mutate', 'model', { model: 'qwen', provider: 'local' }, 8]], "after a revision clash, it's repeated once with the new one")
  assert.equal(calls[1][4], 3)
  assert.equal(ui.find(e => e.kind === 'info').model, 'qwen')
  const r = await c.setChatOptions('s1', { model: 'caro', provider: 'nube' })
  assert.deepEqual(r, { needsConfirm: true, confirm: 'abc123', message: "It's expensive", model: 'caro', provider: 'nube' })
  assert.equal((await c.setChatOptions('s1', { model: 'caro', provider: 'nube', confirm: 'abc123' })).applied, 'now')
  await c.setChatOptions('s1', { reasoning: 'max' })
  await c.setChatOptions('s1', { reasoning: '' })
  await c.setChatOptions('s1', { model: null })
  assert.deepEqual(calls.slice(-3).map(x => [x[1], x[2]]), [['reasoning', { effort: 'max' }], ['reasoning', { effort: null }], ['model', { model: 'reset' }]])
  c.rpc = async () => { const e = new Error('session busy: turn_active'); throw e }
  await assert.rejects(c.setChatOptions('s1', { reasoning: 'low' }), /change it when it finishes/)
})

test("Restart Hermes for a new plugin: only the PC's, only if it isn't working, and it connects again", async () => {
  const t = 1000 * MIN
  const local = fakeConn('local')
  const runs = []
  const hu = new HermesUpdates({ conns: { local, server: fakeConn('server') }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, run: async (file, args) => { runs.push([file, ...args]); return { code: 0, tail: 'Gateway restarted' } } })
  await assert.rejects(hu.restartNow('server'), /from the server/)
  // Working (a chat running): it isn't restarted and is free for the next time.
  local.active = [{ id: 'x', status: 'working' }]
  await assert.rejects(hu.restartNow('local'), /is working/)
  assert.equal(runs.length, 0)
  assert.equal(hu.state('local').applying, null)
  // With background subagents, it isn't either.
  local.active = []
  local.roster = { sessions: [{ session_id: 's', subagents: 1, background: 0 }] }
  await assert.rejects(hu.restartNow('local'), /is working/)
  // When it can't be checked, it isn't either.
  local.roster = { sessions: [] }
  local.rosterFail = true
  await assert.rejects(hu.restartNow('local'), /couldn't check/)
  assert.equal(runs.length, 0)
  // Free: the connection stops, it's restarted with its command and connected again.
  local.rosterFail = false
  local.calls.length = 0
  assert.equal(await hu.restartNow('local'), true)
  assert.deepEqual(runs, [['hermes.exe', 'gateway', 'restart', '--detach']])
  assert.deepEqual(local.calls.filter(x => !x.startsWith('GET') && !x.startsWith('RPC')), ['stop', 'pause restart', 'state updating restarting', 'resume', 'invalidate', 'state connecting', 'start'])
  assert.equal(hu.state('local').applying, null)
  // While it restarts, neither another restart nor an update can start.
  let release
  const slow = new HermesUpdates({ conns: { local: fakeConn('local') }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, run: () => new Promise(r => { release = r }) })
  const first = slow.restartNow('local')
  await assert.rejects(slow.restartNow('local'), /already restarting/)
  assert.equal(slow.view().local.applying.kind, 'restart')
  while (!release) { await new Promise(r => setImmediate(r)) }
  release({ code: 1, tail: "error: couldn't stop the gateway" })
  await assert.rejects(first, /couldn't stop the gateway/)
  assert.equal(slow.state('local').applying, null)
})

test('Restart Hermes: meanwhile, the automatic update neither looks nor starts', async () => {
  let t = 1000 * MIN
  const local = fakeConn('local')
  const runs = []
  let release
  const hu = new HermesUpdates({
    conns: { local }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t,
    run: (file, args) => { runs.push(args.join(' ')); return args[0] === 'gateway' ? new Promise(r => { release = r }) : Promise.resolve({ code: 0, tail: '' }) }
  })
  await hu.tickOne(local)
  t += 11 * MIN // a new version, and unused long enough to install it
  const restart = hu.restartNow('local')
  while (!release) { await new Promise(r => setImmediate(r)) }
  local.state = 'ready' // even if it looked connected
  local.calls.length = 0
  await hu.tickOne(local)
  assert.deepEqual(local.calls, [])
  assert.equal(await hu.apply(local, 'by hand'), false)
  assert.deepEqual(runs, ['gateway restart --detach'])
  release({ code: 0, tail: 'Gateway restarted' })
  assert.equal(await restart, true)
  t += 11 * MIN
  await hu.tickOne(local)
  t += 11 * MIN
  await hu.tickOne(local)
  assert.deepEqual(runs, ['gateway restart --detach', 'update'])
})

test('Is Hermes working? (before changing its plugin)', async () => {
  const local = fakeConn('local')
  const hu = new HermesUpdates({ conns: { local }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => 1000 * MIN, run: async () => ({ code: 0, tail: '' }) })
  assert.equal(await hu.working('local'), false)
  local.active = [{ id: 'x', status: 'working' }]
  assert.equal(await hu.working('local'), true)
  // Busy for sure, even if the rest couldn't be known; and not knowing isn't "no".
  local.rosterFail = true
  assert.equal(await hu.working('local'), true)
  local.active = []
  assert.equal(await hu.working('local'), null)
  local.status = null
  assert.equal(await hu.working('local'), null)
  assert.equal(await hu.working('nobody'), null)
})

test("Restart Hermes: an older Hermes without --detach, and one that refuses because something started", async () => {
  const t = 1000 * MIN
  const make = answers => {
    const runs = []
    const seen = []
    const hu = new HermesUpdates({ conns: { local: fakeConn('local') }, settings: settingsOn, log: quiet, hermesExe: () => 'hermes.exe', now: () => t, run: async (file, args) => { runs.push(args.join(' ')); return answers.shift() } })
    hu.on('change', () => seen.push(hu.state('local').applying ? 'restarting' : 'free'))
    return { hu, runs, seen }
  }
  let m = make([{ code: 2, tail: 'hermes: error: unrecognized arguments: --detach' }, { code: 0, tail: 'Gateway restarted' }])
  assert.equal(await m.hu.restartNow('local'), true)
  assert.deepEqual(m.runs, ['gateway restart --detach', 'gateway restart'])
  // Its last line is the order to cut that work off: it isn't shown.
  m = make([{ code: 1, tail: 'Refusing to restart the gateway: 1 live session(s)\n  Let them finish, or interrupt them deliberately:\n    hermes gateway restart --yes   # interrupts 1 live session(s)' }])
  await assert.rejects(m.hu.restartNow('local'), /^Error: Hermes is working: wait until it finishes$/)
  assert.equal(m.runs.length, 1)
  assert.equal(m.hu.state('local').lastBusyAt, t)
  assert.equal(m.seen.at(-1), 'free')
  // Refused before launching anything: the screen is told that it's free again.
  m = make([])
  m.hu.conns.local.active = [{ id: 'x', status: 'working' }]
  await assert.rejects(m.hu.restartNow('local'), /is working/)
  assert.equal(m.seen.at(-1), 'free')
})
