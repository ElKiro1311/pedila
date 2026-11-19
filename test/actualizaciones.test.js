'use strict'
// Actualizaciones solas: la versión nueva de Hermes (cuándo se instala y cuándo no), el .cmd que
// reinstala Pedila y la vuelve a abrir, y los ajustes nuevos.
const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitize } = require('../src/main/settings')
const { relaunchScript } = require('../src/main/extras')
const { HermesUpdates, infoFrom, decide, newestActivity, IDLE_MS } = require('../src/main/hermes-updates')

const MIN = 60 * 1000

test('ajustes: instalar solas las versiones de Pedila y de Hermes viene encendido y se puede apagar', () => {
  const d = sanitize({})
  assert.equal(d.updates.autoInstall, true)
  assert.equal(d.hermes.autoUpdate, true)
  const s = sanitize({ updates: { autoInstall: false }, hermes: { autoUpdate: false } })
  assert.equal(s.updates.autoInstall, false)
  assert.equal(s.hermes.autoUpdate, false)
  assert.equal(sanitize({ hermes: { autoUpdate: 'sí' } }).hermes.autoUpdate, true)
})

test('versión de Hermes: git que se puede actualizar, volver atrás, Docker y sin respuesta', () => {
  const git = infoFrom({ install_method: 'git', can_apply: true, current_version: '0.23.0', update_available: true, source_version: '0.23.2' }, '', '9.9.9')
  assert.deepEqual(git, { version: '0.23.0', latest: '0.23.2', available: true, canApply: true, method: 'git' })
  // Esta compilación es más nueva que la estable: «actualizar» sería volver atrás, y eso no se hace solo.
  assert.equal(infoFrom({ install_method: 'git', can_apply: true, current_version: '0.24.0', update_available: true, rollback_to: '0.23.2', source_version: '0.23.2' }).available, false)
  const docker = infoFrom({ install_method: 'managed-runtime', can_apply: false, current_version: '0.23.1', update_available: false }, '', 'v0.23.2')
  assert.deepEqual(docker, { version: '0.23.1', latest: '0.23.2', available: true, canApply: false, method: 'managed-runtime' })
  assert.equal(infoFrom(null, '0.23.2', '0.23.2').available, false)
  assert.equal(infoFrom(null, '0.23.1', '').available, false, 'sin la versión publicada no se inventa nada')
  assert.equal(infoFrom(null, '0.23.1', '0.23.2').canApply, false)
})

test('cuándo se instala Hermes solo', () => {
  const now = 100 * MIN
  const info = { version: '0.23.0', latest: '0.23.2', available: true, canApply: true }
  const base = { info, watchingSince: now - 11 * MIN, lastBusyAt: 0, lastActive: now - 30 * MIN, busy: false, applying: null, lastResult: null }
  assert.equal(decide(base, { now, auto: true }), 'instalar')
  assert.equal(decide({ ...base, info: { ...info, available: false } }, { now, auto: true }), 'al-dia')
  assert.equal(decide({ ...base, info: { ...info, canApply: false } }, { now, auto: true }), 'servidor')
  assert.equal(decide(base, { now, auto: false }), 'manual')
  assert.equal(decide({ ...base, watchingSince: now - 5 * MIN }, { now, auto: true }), 'observando')
  assert.equal(decide({ ...base, busy: true }, { now, auto: true }), 'en-uso')
  assert.equal(decide({ ...base, lastBusyAt: now - 9 * MIN }, { now, auto: true }), 'en-uso')
  assert.equal(decide({ ...base, lastActive: now - 2 * MIN }, { now, auto: true }), 'en-uso')
  assert.equal(decide({ ...base, lastResult: { ok: false, to: '0.23.2', at: now - 60 * MIN } }, { now, auto: true }), 'fallo-reciente')
  // Pasadas 6 h, o con otra versión nueva, se vuelve a intentar.
  assert.equal(decide({ ...base, lastResult: { ok: false, to: '0.23.2', at: now - 7 * 60 * MIN } }, { now: now, auto: true }), 'instalar')
  assert.equal(decide({ ...base, lastResult: { ok: false, to: '0.23.1', at: now - MIN } }, { now, auto: true }), 'instalar')
  assert.equal(decide({ ...base, applying: { at: now } }, { now, auto: true }), 'instalando')
})

test('actividad más reciente de los chats de Hermes (segundos o milisegundos)', () => {
  assert.equal(newestActivity([{ last_active: 1000 }, { last_active: 2000.5 }, { last_activity_at: 1500 }]), 2000500)
  assert.equal(newestActivity([{ last_active: 1795102496000 }]), 1795102496000)
  assert.equal(newestActivity([]), 0)
  assert.equal(newestActivity(null), 0)
})

test('el .cmd que instala Pedila y la vuelve a abrir como estaba', () => {
  const s = relaunchScript('C:\\Temp\\Pedila-Setup-1.0.0.exe', 'C:\\Users\\a b\\AppData\\Local\\Programs\\pedila\\Pedila.exe', ['--oculto'])
  assert.deepEqual(s.split('\r\n'), ['@echo off', '"C:\\Temp\\Pedila-Setup-1.0.0.exe" /S', 'start "" "C:\\Users\\a b\\AppData\\Local\\Programs\\pedila\\Pedila.exe" --oculto', ''])
  // «%» se dobla (en un .cmd sería una variable), las comillas no se cuelan y solo pasan opciones --así.
  const raro = relaunchScript('C:\\T\\100%\\s"e.exe', 'C:\\P\\Pedila.exe', ['--sin-foco', '& del *', '--x'])
  assert.match(raro, /"C:\\T\\100%%\\se\.exe" \/S/)
  assert.match(raro, /Pedila\.exe" --sin-foco --x\r\n$/)
  assert.doesNotMatch(raro, /del \*/)
  assert.match(relaunchScript('a.exe', 'b.exe'), /start "" "b\.exe"\r\n$/)
})

/** Un Hermes de mentira: lo que contestaría /api/status, la lista de chats y /api/hermes/update/check. */
function fakeConn(id, over = {}) {
  const c = {
    id, state: 'ready', stopped: false, calls: [],
    status: { version: '0.23.0', active_agents: 0, gateway_busy: false },
    sessions: [{ last_active: 1 }],
    check: { install_method: 'git', can_apply: true, current_version: '0.23.0', update_available: true, source_version: '0.23.2' },
    transport: {
      publicJson: async p => { c.calls.push('GET ' + p); return { status: 200, json: c.status } },
      fetchJson: async p => {
        c.calls.push('GET ' + p)
        if (p.startsWith('/api/sessions')) { return { status: 200, json: { sessions: c.sessions } } }
        if (p.startsWith('/api/hermes/update/check')) { return { status: 200, json: c.check } }
        return { status: 404, json: null }
      },
      invalidate: () => c.calls.push('invalidate')
    },
    stop() { c.stopped = true; c.calls.push('stop') },
    start() { c.stopped = false; c.state = 'ready'; c.calls.push('start') },
    setState(s, d) { c.state = s; c.calls.push(`state ${s}${d ? ' ' + d : ''}`) },
    ...over
  }
  return c
}

test('Hermes del PC: espera 10 min sin uso, cierra la conexión, actualiza y vuelve a conectar', async () => {
  let t = 1000 * MIN
  const local = fakeConn('local')
  const runs = []
  const hu = new HermesUpdates({
    conns: { local }, settings: { data: { hermes: { autoUpdate: true } } }, log: { info() {}, warn() {} },
    hermesExe: () => 'C:\\hermes\\bin\\hermes.exe', now: () => t,
    run: async (file, args) => { runs.push([file, ...args]); return { code: 0, tail: 'Hermes actualizado' } },
    fetchImpl: async () => { throw new Error('no debería preguntar a GitHub con una instalación git') }
  })
  await hu.tickOne(local)
  assert.equal(hu.view().local.available, true)
  assert.equal(hu.view().local.why, 'observando')
  assert.equal(runs.length, 0)
  // A los 5 min trabaja: hay que esperar otros 10 desde ahí.
  t += 5 * MIN
  local.status = { ...local.status, active_agents: 1, gateway_busy: true }
  await hu.tickOne(local)
  assert.equal(hu.view().local.why, 'en-uso')
  local.status = { ...local.status, active_agents: 0, gateway_busy: false }
  t += 9 * MIN
  await hu.tickOne(local)
  assert.equal(runs.length, 0, '9 min después de trabajar, todavía no')
  t += 2 * MIN
  await hu.tickOne(local)
  assert.deepEqual(runs, [['C:\\hermes\\bin\\hermes.exe', 'update']])
  const seq = local.calls.filter(x => !x.startsWith('GET'))
  assert.deepEqual(seq, ['stop', 'state updating 0.23.0 → 0.23.2', 'invalidate', 'state connecting', 'start'])
  const v = hu.view().local
  assert.equal(v.lastResult.ok, true)
  assert.equal(v.applying, null)
})

test('Hermes del PC: si la actualización falla, no se reintenta hasta pasadas 6 h', async () => {
  let t = 2000 * MIN
  const local = fakeConn('local')
  let runs = 0
  const hu = new HermesUpdates({
    conns: { local }, settings: { data: { hermes: { autoUpdate: true } } }, log: { info() {}, warn() {} },
    hermesExe: () => 'hermes.exe', now: () => t, run: async () => { runs++; return { code: 1, tail: 'error: no pude\n✗ falló la descarga' } }
  })
  await hu.tickOne(local)
  t += 11 * MIN
  await hu.tickOne(local)
  assert.equal(runs, 1)
  assert.equal(hu.view().local.lastResult.ok, false)
  assert.equal(hu.view().local.lastResult.error, '✗ falló la descarga')
  for (let i = 0; i < 5; i++) { t += 30 * MIN; await hu.tickOne(local) }
  assert.equal(runs, 1, 'mientras tanto no se repite')
  t += 4 * 60 * MIN
  await hu.tickOne(local)
  assert.equal(runs, 2)
})

test('Hermes del servidor en Docker: solo avisa, nunca actualiza; sin sesión también mira su versión', async () => {
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
  assert.ok(!server.calls.some(x => x.includes('/api/sessions') || x.includes('/update/check')), 'sin sesión solo lee /api/status')
  await hu.applyNow('server').then(() => assert.fail('no debería'), e => assert.match(e.message, /servidor/))
  assert.equal(runs, 0)
  assert.equal(IDLE_MS, 10 * MIN)
})

test('al conectar, Pedila vuelve a seguir los chats que están trabajando (y no se para por uno que falle)', async () => {
  const { Connection } = require('../src/main/connection')
  const c = new Connection({ id: 'local', name: 'Este PC', transport: {}, log: { info() {}, warn() {} } })
  c.state = 'ready'
  c.stopped = false
  const attached = []
  c.rpc = async () => ({ sessions: [{ id: 'a', status: 'working', title: 'Paper Mario' }, { id: 'b', status: 'idle' }, { id: 'c', status: 'waiting' }, { session_key: 'd', id: 'sock-1', status: 'starting' }] })
  c.live.set('c', { liveId: 'c', running: true })
  c.attach = async sid => { if (sid === 'a') { throw new Error('se cayó') } attached.push(sid) }
  await c.reattachRunning()
  assert.deepEqual(attached, ['d'], 'a falló, b no trabaja, c ya estaba enganchado, d sí')
})
