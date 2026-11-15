'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitize, defaults } = require('../src/main/settings')
const { parseSetCookie } = require('../src/main/remote')
const { normalizeTranscript, sessionRow, argsSummary } = require('../src/main/connection')
const { decide } = require('../src/main/notify')

test('ajustes: valores fuera de rango y claves desconocidas', () => {
  const s = sanitize({ look: { palette: 'egeo', theme: 'neón', accent: 'rosa', textSize: 400 }, raro: 1, notify: { minDurationSec: -5, sound: 'sí' }, server: { urls: ['javascript:alert(1)', 'http://a:b@x', 'http://192.168.1.50:9119/ruta'] } })
  assert.equal(s.look.theme, 'system')
  assert.equal(s.look.accent, 'rosa')
  assert.equal(s.look.textSize, 140)
  assert.equal(s.raro, undefined)
  assert.equal(s.notify.minDurationSec, 0)
  assert.equal(s.notify.sound, true)
  assert.deepEqual(s.server.urls, ['http://192.168.1.50:9119'])
  assert.deepEqual(sanitize(null), defaults())
  assert.equal(s.look.palette, 'egeo')
  assert.equal(sanitize({ look: { palette: 'neón' } }).look.palette, 'mensajera')
})

test('ajustes: al pasar desde antes de la 0.5 se estrenan el tema y la mascota nuevos', () => {
  const viejo = sanitize({ look: { theme: 'dark', accent: 'violeta', textSize: 110 }, pet: { slug: 'code-default', visible: true } })
  assert.equal(viejo.look.palette, 'mensajera')
  assert.equal(viejo.look.accent, 'tema')
  assert.equal(viejo.look.theme, 'dark')
  assert.equal(viejo.look.textSize, 110)
  assert.equal(viejo.pet.slug, 'pedila')
  // Otra mascota elegida a mano se respeta; y con los ajustes ya nuevos, Codux también.
  assert.equal(sanitize({ look: { theme: 'dark' }, pet: { slug: 'gato-x' } }).pet.slug, 'gato-x')
  assert.equal(sanitize({ look: { palette: 'clasico', accent: 'violeta' }, pet: { slug: 'code-default' } }).pet.slug, 'code-default')
  assert.equal(sanitize({ look: { palette: 'clasico', accent: 'violeta' } }).look.accent, 'violeta')
})

test('ajustes: ventana demasiado pequeña se descarta', () => {
  const s = sanitize({ window: { bounds: { x: 0, y: 0, width: 100, height: 100 } } })
  assert.equal(s.window.bounds, null)
})

test('cookies: Set-Cookie normal, caducada y vacía', () => {
  assert.deepEqual(parseSetCookie('hermes_session_at=abc; Path=/; Max-Age=43200; HttpOnly'), { name: 'hermes_session_at', value: 'abc', expired: false })
  assert.equal(parseSetCookie('hermes_session_at=abc; Max-Age=0').expired, true)
  assert.equal(parseSetCookie('hermes_session_rt=; Path=/').expired, true)
  assert.equal(parseSetCookie('sin-igual'), null)
})

test('transcripción: herramientas, razonamiento y filas ocultas', () => {
  const rows = [
    { id: 1, role: 'user', content: 'hola' },
    { id: 2, role: 'assistant', content: '', reasoning: 'pienso', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"ls -la"}' } }] },
    { id: 3, role: 'tool', tool_call_id: 'c1', content: 'archivo1\narchivo2' },
    { id: 4, role: 'assistant', content: 'Listo.' },
    { id: 5, role: 'user', content: 'oculto', display_kind: 'hidden' },
    { id: 6, role: 'system', content: 'sistema' },
    { id: 7, role: 'user', content: [{ type: 'text', text: 'mira' }, { type: 'image_url', image_url: {} }] }
  ]
  const t = normalizeTranscript(rows)
  assert.equal(t.length, 3)
  assert.equal(t[0].text, 'hola')
  assert.equal(t[1].reasoning, 'pienso')
  assert.deepEqual(t[1].blocks.map(b => b.type), ['tool', 'text'])
  assert.equal(t[1].blocks[0].args, 'ls -la')
  assert.equal(t[1].blocks[0].summary, 'archivo1 archivo2')
  assert.equal(t[2].text, 'mira\n[imagen]')
})

test('fila de sesión y resumen de argumentos', () => {
  const r = sessionRow({ id: 'x', title: '', preview: 'una pregunta\nlarga', message_count: 3, is_active: 1, last_active: 1700000000 })
  assert.equal(r.title, 'una pregunta\nlarga'.slice(0, 60))
  assert.equal(r.preview, 'una pregunta larga')
  assert.equal(r.active, true)
  assert.equal(argsSummary({ query: '  hola   mundo ' }), 'hola mundo')
  assert.equal(argsSummary(null, 'texto'), 'texto')
})

test('avisos: cuándo sí y cuándo no', () => {
  const notify = { enabled: true, done: true, needs: true, failed: false, minDurationSec: 10 }
  assert.equal(decide('done', { notify, focusedOnChat: false, ms: 20000 }), true)
  assert.equal(decide('done', { notify, focusedOnChat: false, ms: 3000 }), false)
  assert.equal(decide('done', { notify, focusedOnChat: true, ms: 20000 }), false)
  assert.equal(decide('needs', { notify, focusedOnChat: false }), true)
  assert.equal(decide('failed', { notify, focusedOnChat: false }), false)
  assert.equal(decide('done', { notify: { ...notify, enabled: false }, focusedOnChat: false, ms: 99999 }), false)
})

test('modelos locales: direcciones de casa, de VPN y de la nube', () => {
  const { isLocalUrl } = require('../src/main/connection')
  assert.equal(isLocalUrl('http://192.168.1.50:8181/v1'), true)
  assert.equal(isLocalUrl('http://10.0.0.5:8181/v1'), true)
  assert.equal(isLocalUrl('http://localhost:11434'), true)
  assert.equal(isLocalUrl('https://api.example.com/v1'), false)
  assert.equal(isLocalUrl('https://openrouter.ai/api/v1'), false)
  assert.equal(isLocalUrl(''), false)
})

test('mascotas: solo petdex.dev, PNG/WebP, rutas seguras', () => {
  const { isPetdexUrl, sheetType, fold, Pets } = require('../src/main/pets')
  assert.equal(isPetdexUrl('https://assets.petdex.dev/pets/a/sprite.webp'), true)
  assert.equal(isPetdexUrl('http://assets.petdex.dev/pets/a/sprite.webp'), false)
  assert.equal(isPetdexUrl('https://petdex.dev.evil.com/x.png'), false)
  assert.equal(isPetdexUrl('https://evilpetdex.dev/x.png'), false)
  assert.equal(sheetType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png')
  assert.equal(sheetType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(sheetType(Buffer.from('<html>')), null)
  assert.equal(fold('Criatura Pequeña Ñandú'), 'criatura pequena nandu')
  const p = new Pets({ dataDir: 'C:/x', bundledDir: 'C:/nada', log: { info() {}, warn() {} } })
  assert.equal(p.fileFor('pets/torty/sprite.webp'), require('node:path').join('C:/x', 'pets', 'torty', 'sprite.webp'))
  assert.equal(p.fileFor('pets/../../secretos/sprite.png'), null)
  assert.equal(p.fileFor('pets/torty/pet.json'), null)
  assert.equal(p.fileFor('pets/TORTY/sprite.png'), null)
})

test('mascotas: búsqueda por nombre, autor y tipo, con páginas', async () => {
  const { Pets } = require('../src/main/pets')
  const p = new Pets({ dataDir: require('node:os').tmpdir() + '/hp-test-' + process.pid, bundledDir: 'C:/nada', log: { info() {}, warn() {} } })
  p.adopt([
    { slug: 'gato', name: 'Gatito Ñu', kind: 'creature', author: 'ana', sheet: 'https://assets.petdex.dev/pets/gato-1/sprite.webp' },
    { slug: 'robot', name: 'Robot', kind: 'object', author: 'luis', sheet: 'https://assets.petdex.dev/pets/robot-1/sprite.png' },
    { slug: 'heroe', name: 'Héroe', kind: 'character', author: 'ana', sheet: 'https://assets.petdex.dev/pets/heroe-1/sprite.webp' }
  ])
  assert.equal((await p.search({ q: 'nu' })).total, 1)
  assert.equal((await p.search({ q: 'heroe' })).items[0].slug, 'heroe')
  assert.equal((await p.search({ q: 'ana' })).total, 2)
  assert.equal((await p.search({ kind: 'object' })).items[0].slug, 'robot')
  const page = await p.search({ offset: 1, limit: 1 })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].preview, 'https://assets.petdex.dev/pets/robot/preview.webp')
  assert.deepEqual(page.kinds, { creature: 1, object: 1, character: 1 })
})

test('uso: resúmenes de hoy y de los últimos 7 días', () => {
  const { usageStats } = require('../src/main/extras')
  const now = new Date(2026, 10, 9, 15, 0, 0).getTime()
  const h = 3600e3
  const rows = [
    { startedAt: now - 2 * h, messages: 4, inputTokens: 1000, outputTokens: 100, model: 'a' },
    { startedAt: now - 3 * 24 * h, messages: 2, inputTokens: 500, outputTokens: 50, model: 'a' },
    { startedAt: now - 20 * 24 * h, messages: 6, inputTokens: 9000, outputTokens: 900, model: 'b' }
  ]
  const u = usageStats(rows, now)
  assert.deepEqual(u.today, { chats: 1, messages: 4, input: 1000, output: 100 })
  assert.deepEqual(u.week, { chats: 2, messages: 6, input: 1500, output: 150 })
  assert.equal(u.days.length, 30)
  assert.equal(u.days[29].date, '2026-11-09')
  assert.equal(u.chats, 3)
})

test('uso: la última tarea es el chat con la actividad más reciente', () => {
  const { usageStats } = require('../src/main/extras')
  const now = new Date(2026, 10, 15, 15, 0, 0).getTime()
  const rows = [
    { id: 'a', title: 'Viejo', startedAt: (now - 5 * 3600e3) / 1000, lastActive: (now - 4 * 3600e3) / 1000 },
    { id: 'b', title: 'Reciente', startedAt: (now - 3 * 3600e3) / 1000, lastActive: (now - 25 * 60e3) / 1000 },
    { id: 'c', title: 'Sin actividad', startedAt: (now - 2 * 3600e3) / 1000, lastActive: null }
  ]
  const u = usageStats(rows, now)
  assert.deepEqual(u.last, { at: now - 25 * 60e3, id: 'b', title: 'Reciente' })
  // Si solo hay hora de inicio, cuenta esa; sin chats no hay última tarea.
  assert.equal(usageStats([rows[2]], now).last.at, now - 2 * 3600e3)
  assert.equal(usageStats([], now).last, null)
  // Fechas en texto ISO (algunas versiones de Hermes) también valen.
  assert.equal(usageStats([{ id: 'd', lastActive: new Date(now - 60e3).toISOString() }], now).last.at, now - 60e3)
  // Con el reloj de Hermes adelantado no puede ser del futuro.
  assert.equal(usageStats([{ id: 'e', lastActive: (now + 9 * 60e3) / 1000 }], now).last.at, now)
})

test('chats trabajando: active_list en los dos protocolos', async () => {
  const { Connection } = require('../src/main/connection')
  const fake = sessions => ({ rpc: async (m, p, t) => { assert.equal(m, 'session.active_list'); assert.ok(t <= 5000); return { sessions } }, liveToStored: new Map([['sock-1', 'A']]) })
  // Nuevo: id y session_key son el guardado; solo cuenta lo que trabaja, espera o arranca.
  assert.deepEqual(await Connection.prototype.activeList.call(fake([
    { id: 'B', session_key: 'B', status: 'working', title: 'Uno' },
    { id: 'C', session_key: 'C', status: 'idle' },
    { id: 'D', session_key: 'D', status: 'waiting' },
    { id: 'E', session_key: 'E', status: 'starting' }
  ])), [{ id: 'B', status: 'working', title: 'Uno' }, { id: 'D', status: 'waiting', title: '' }, { id: 'E', status: 'starting', title: '' }])
  // Clásico: id es el del socket; manda el chat que esta ventana ya tiene enganchado, y si no, session_key.
  assert.deepEqual((await Connection.prototype.activeList.call(fake([{ id: 'sock-1', session_key: 'A2', status: 'working' }, { id: 'sock-9', session_key: 'Z', status: 'working' }]))).map(x => x.id), ['A', 'Z'])
  assert.deepEqual(await Connection.prototype.activeList.call(fake(null)), [])
})

test('formatos: tokens en K, M y B sin «1000K»', async () => {
  const { kfmt } = await import('../src/shell/fmt.mjs')
  const cases = [
    [0, '0'], [null, '0'], [undefined, '0'], [NaN, '0'], [7, '7'], [999, '999'],
    [1000, '1K'], [1234, '1.23K'], [1500, '1.5K'], [12345, '12.3K'], [98304, '98.3K'], [131072, '131K'],
    [999499, '999K'], [999500, '1M'], [999999, '1M'], [1000000, '1M'], [1048576, '1.05M'],
    [1090000, '1.09M'], [4315000, '4.32M'], [1005000, '1.01M'], [12340000, '12.3M'], [999999999, '1B'],
    [1500000000, '1.5B'], [2.5e12, '2500B'], [-1500, '-1.5K'], ['2048', '2.05K']
  ]
  for (const [n, want] of cases) { assert.equal(kfmt(n), want, `kfmt(${n})`) }
})

test('formatos: horas de 12 o 24, días y ratos', async () => {
  const f = await import('../src/shell/fmt.mjs')
  const now = new Date(2026, 10, 15, 15, 41, 0).getTime()
  const at = new Date(2026, 10, 15, 15, 5, 0).getTime()
  f.setHour12(true)
  assert.match(f.hhmm(at), /^3:05\s?p\.\s?m\.$/)
  assert.match(f.hhmm(new Date(2026, 10, 15, 9, 7).getTime()), /^9:07\s?a\.\s?m\.$/)
  f.setHour12(false)
  assert.equal(f.hhmm(at), '15:05')
  assert.equal(f.dayLabel(at, now), '')
  assert.equal(f.dayLabel(new Date(2026, 10, 14, 23, 50).getTime(), now), 'ayer')
  assert.equal(f.dayLabel(new Date(2026, 10, 10, 9, 0).getTime(), now), 'mar')
  assert.equal(f.dayLabel(new Date(2026, 10, 8, 9, 0).getTime(), now), '8 nov')
  assert.equal(f.dayLabel(new Date(2025, 11, 31, 9, 0).getTime(), now), '31 dic 2025')
  assert.equal(f.clock(new Date(2026, 10, 14, 23, 50).getTime(), now), 'ayer, 23:50')
  assert.equal(f.span(40e3), '40 s')
  assert.equal(f.span(25 * 60e3 + 59e3), '25 min')
  assert.equal(f.span(113 * 60e3), '1 h 53 min')
  assert.equal(f.span(2 * 3600e3), '2 h')
  assert.equal(f.span(30 * 3600e3), '1 día')
  assert.equal(f.span(-5000), '0 s')
  assert.equal(f.ago(now - 30e3, now), 'hace un momento')
  assert.equal(f.ago(now + 90e3, now), 'hace un momento')
  assert.equal(f.ago(now - 25 * 60e3, now), 'hace 25 min')
})
