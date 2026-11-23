'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitize, defaults } = require('../src/main/settings')
const { parseSetCookie } = require('../src/main/remote')
const { normalizeTranscript, sessionRow, argsSummary } = require('../src/main/connection')
const { decide } = require('../src/main/notify')

test('settings: values out of range and unknown keys', () => {
  const s = sanitize({ look: { palette: 'egeo', theme: 'neon', accent: 'rosa', textSize: 400 }, raro: 1, notify: { minDurationSec: -5, sound: 'yes' }, server: { urls: ['javascript:alert(1)', 'http://a:b@x', 'http://192.168.1.50:9119/ruta'] } })
  assert.equal(s.look.theme, 'system')
  assert.equal(s.look.accent, 'rosa')
  assert.equal(s.look.textSize, 140)
  assert.equal(s.raro, undefined)
  assert.equal(s.notify.minDurationSec, 0)
  assert.equal(s.notify.sound, true)
  assert.deepEqual(s.server.urls, ['http://192.168.1.50:9119'])
  assert.deepEqual(sanitize(null), defaults())
  assert.equal(s.look.palette, 'egeo')
  assert.equal(sanitize({ look: { palette: 'neon' } }).look.palette, 'mensajera')
})

test('settings: coming from before 0.5, the new theme and pet are used', () => {
  const viejo = sanitize({ look: { theme: 'dark', accent: 'violeta', textSize: 110 }, pet: { slug: 'code-default', visible: true } })
  assert.equal(viejo.look.palette, 'mensajera')
  assert.equal(viejo.look.accent, 'tema')
  assert.equal(viejo.look.theme, 'dark')
  assert.equal(viejo.look.textSize, 110)
  assert.equal(viejo.pet.slug, 'pedila')
  // Another pet chosen by hand is respected; and with the settings already new, Codux too.
  assert.equal(sanitize({ look: { theme: 'dark' }, pet: { slug: 'gato-x' } }).pet.slug, 'gato-x')
  assert.equal(sanitize({ look: { palette: 'clasico', accent: 'violeta' }, pet: { slug: 'code-default' } }).pet.slug, 'code-default')
  assert.equal(sanitize({ look: { palette: 'clasico', accent: 'violeta' } }).look.accent, 'violeta')
})

test("settings: a window that's too small is discarded", () => {
  const s = sanitize({ window: { bounds: { x: 0, y: 0, width: 100, height: 100 } } })
  assert.equal(s.window.bounds, null)
})

test('cookies: normal, expired and empty Set-Cookie', () => {
  assert.deepEqual(parseSetCookie('hermes_session_at=abc; Path=/; Max-Age=43200; HttpOnly'), { name: 'hermes_session_at', value: 'abc', expired: false })
  assert.equal(parseSetCookie('hermes_session_at=abc; Max-Age=0').expired, true)
  assert.equal(parseSetCookie('hermes_session_rt=; Path=/').expired, true)
  assert.equal(parseSetCookie('no-equals'), null)
})

test('transcript: tools, reasoning and hidden rows', () => {
  const rows = [
    { id: 1, role: 'user', content: 'hola' },
    { id: 2, role: 'assistant', content: '', reasoning: 'pienso', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"ls -la"}' } }] },
    { id: 3, role: 'tool', tool_call_id: 'c1', content: 'file1\nfile2' },
    { id: 4, role: 'assistant', content: 'Done.' },
    { id: 5, role: 'user', content: 'oculto', display_kind: 'hidden' },
    { id: 6, role: 'system', content: 'sistema' },
    { id: 7, role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: {} }] }
  ]
  const t = normalizeTranscript(rows)
  assert.equal(t.length, 3)
  assert.equal(t[0].text, 'hola')
  assert.equal(t[1].reasoning, 'pienso')
  assert.deepEqual(t[1].blocks.map(b => b.type), ['tool', 'text'])
  assert.equal(t[1].blocks[0].args, 'ls -la')
  assert.equal(t[1].blocks[0].summary, 'file1 file2')
  assert.equal(t[2].text, 'look\n[image]')
})

test('session row and argument summary', () => {
  const r = sessionRow({ id: 'x', title: '', preview: 'a long\nquestion', message_count: 3, is_active: 1, last_active: 1700000000 })
  assert.equal(r.title, 'a long\nquestion'.slice(0, 60))
  assert.equal(r.preview, 'a long question')
  assert.equal(r.active, true)
  assert.equal(argsSummary({ query: '  hello   world ' }), 'hello world')
  assert.equal(argsSummary(null, 'texto'), 'texto')
})

test('notifications: when yes and when no', () => {
  const notify = { enabled: true, done: true, needs: true, failed: false, minDurationSec: 10 }
  assert.equal(decide('done', { notify, focusedOnChat: false, ms: 20000 }), true)
  assert.equal(decide('done', { notify, focusedOnChat: false, ms: 3000 }), false)
  assert.equal(decide('done', { notify, focusedOnChat: true, ms: 20000 }), false)
  assert.equal(decide('needs', { notify, focusedOnChat: false }), true)
  assert.equal(decide('failed', { notify, focusedOnChat: false }), false)
  assert.equal(decide('done', { notify: { ...notify, enabled: false }, focusedOnChat: false, ms: 99999 }), false)
})

test('local models: home, VPN and cloud addresses', () => {
  const { isLocalUrl } = require('../src/main/connection')
  assert.equal(isLocalUrl('http://192.168.1.50:8181/v1'), true)
  assert.equal(isLocalUrl('http://10.0.0.5:8181/v1'), true)
  assert.equal(isLocalUrl('http://localhost:11434'), true)
  assert.equal(isLocalUrl('https://api.example.com/v1'), false)
  assert.equal(isLocalUrl('https://openrouter.ai/api/v1'), false)
  assert.equal(isLocalUrl(''), false)
})

test('pets: only petdex.dev, PNG/WebP, safe paths', () => {
  const { isPetdexUrl, sheetType, fold, Pets } = require('../src/main/pets')
  assert.equal(isPetdexUrl('https://assets.petdex.dev/pets/a/sprite.webp'), true)
  assert.equal(isPetdexUrl('http://assets.petdex.dev/pets/a/sprite.webp'), false)
  assert.equal(isPetdexUrl('https://petdex.dev.evil.com/x.png'), false)
  assert.equal(isPetdexUrl('https://evilpetdex.dev/x.png'), false)
  assert.equal(sheetType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png')
  assert.equal(sheetType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(sheetType(Buffer.from('<html>')), null)
  assert.equal(fold('Criatura Pequeña Ñandú'), 'criatura pequena nandu')
  const p = new Pets({ dataDir: 'C:/x', bundledDir: 'C:/nothing', log: { info() {}, warn() {} } })
  assert.equal(p.fileFor('pets/torty/sprite.webp'), require('node:path').join('C:/x', 'pets', 'torty', 'sprite.webp'))
  assert.equal(p.fileFor('pets/../../secretos/sprite.png'), null)
  assert.equal(p.fileFor('pets/torty/pet.json'), null)
  assert.equal(p.fileFor('pets/TORTY/sprite.png'), null)
})

test('pets: search by name, author and kind, with pages', async () => {
  const { Pets } = require('../src/main/pets')
  const p = new Pets({ dataDir: require('node:os').tmpdir() + '/hp-test-' + process.pid, bundledDir: 'C:/nothing', log: { info() {}, warn() {} } })
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

test('usage: summaries of today and the last 7 days', () => {
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

test('usage: the last task is the chat with the most recent activity', () => {
  const { usageStats } = require('../src/main/extras')
  const now = new Date(2026, 10, 15, 15, 0, 0).getTime()
  const rows = [
    { id: 'a', title: 'Old', startedAt: (now - 5 * 3600e3) / 1000, lastActive: (now - 4 * 3600e3) / 1000 },
    { id: 'b', title: 'Recent', startedAt: (now - 3 * 3600e3) / 1000, lastActive: (now - 25 * 60e3) / 1000 },
    { id: 'c', title: 'No activity', startedAt: (now - 2 * 3600e3) / 1000, lastActive: null }
  ]
  const u = usageStats(rows, now)
  assert.deepEqual(u.last, { at: now - 25 * 60e3, id: 'b', title: 'Recent' })
  // If there's only a start time, that one counts; without chats there's no last task.
  assert.equal(usageStats([rows[2]], now).last.at, now - 2 * 3600e3)
  assert.equal(usageStats([], now).last, null)
  // ISO text dates (some Hermes versions) are fine too.
  assert.equal(usageStats([{ id: 'd', lastActive: new Date(now - 60e3).toISOString() }], now).last.at, now - 60e3)
  // With Hermes's clock ahead it can't be in the future.
  assert.equal(usageStats([{ id: 'e', lastActive: (now + 9 * 60e3) / 1000 }], now).last.at, now)
})

test('chats working: active_list in both protocols', async () => {
  const { Connection } = require('../src/main/connection')
  const fake = sessions => ({ rpc: async (m, p, t) => { assert.equal(m, 'session.active_list'); assert.ok(t <= 5000); return { sessions } }, liveToStored: new Map([['sock-1', 'A']]) })
  // New: id and session_key are the stored one; only what works, waits or starts counts.
  assert.deepEqual(await Connection.prototype.activeList.call(fake([
    { id: 'B', session_key: 'B', status: 'working', title: 'One' },
    { id: 'C', session_key: 'C', status: 'idle' },
    { id: 'D', session_key: 'D', status: 'waiting' },
    { id: 'E', session_key: 'E', status: 'starting' }
  ])), [{ id: 'B', status: 'working', title: 'One' }, { id: 'D', status: 'waiting', title: '' }, { id: 'E', status: 'starting', title: '' }])
  // Classic: id is the socket's; the chat this window already has attached wins and, if not, session_key.
  assert.deepEqual((await Connection.prototype.activeList.call(fake([{ id: 'sock-1', session_key: 'A2', status: 'working' }, { id: 'sock-9', session_key: 'Z', status: 'working' }]))).map(x => x.id), ['A', 'Z'])
  assert.deepEqual(await Connection.prototype.activeList.call(fake(null)), [])
})

test('formats: tokens in K, M and B without "1000K"', async () => {
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

test('formats: 12 or 24 hours, days and lengths of time', async () => {
  const f = await import('../src/shell/fmt.mjs')
  const now = new Date(2026, 10, 15, 15, 41, 0).getTime()
  const at = new Date(2026, 10, 15, 15, 5, 0).getTime()
  f.setHour12(true)
  assert.match(f.hhmm(at), /^3:05\s?PM$/)
  assert.match(f.hhmm(new Date(2026, 10, 15, 9, 7).getTime()), /^9:07\s?AM$/)
  f.setHour12(false)
  assert.equal(f.hhmm(at), '15:05')
  assert.equal(f.dayLabel(at, now), '')
  assert.equal(f.dayLabel(new Date(2026, 10, 14, 23, 50).getTime(), now), 'yesterday')
  assert.equal(f.dayLabel(new Date(2026, 10, 10, 9, 0).getTime(), now), 'Tue')
  assert.equal(f.dayLabel(new Date(2026, 10, 8, 9, 0).getTime(), now), 'Nov 8')
  assert.equal(f.dayLabel(new Date(2025, 11, 31, 9, 0).getTime(), now), 'Dec 31, 2025')
  assert.equal(f.clock(new Date(2026, 10, 14, 23, 50).getTime(), now), 'yesterday, 23:50')
  assert.equal(f.span(40e3), '40 s')
  assert.equal(f.span(25 * 60e3 + 59e3), '25 min')
  assert.equal(f.span(113 * 60e3), '1 h 53 min')
  assert.equal(f.span(2 * 3600e3), '2 h')
  assert.equal(f.span(30 * 3600e3), '1 day')
  assert.equal(f.span(-5000), '0 s')
  assert.equal(f.ago(now - 30e3, now), 'a moment ago')
  assert.equal(f.ago(now + 90e3, now), 'a moment ago')
  assert.equal(f.ago(now - 25 * 60e3, now), '25 min ago')
})

test('settings: widths of the chat list and the panel', () => {
  assert.equal(sanitize({}).window.sideWidth, null)
  assert.equal(sanitize({}).window.panelWidth, null)
  const s = sanitize({ window: { sideWidth: 333.4, panelWidth: 9999 } })
  assert.equal(s.window.sideWidth, 333)
  assert.equal(s.window.panelWidth, 680)
  assert.equal(sanitize({ window: { sideWidth: 50, panelWidth: 'ancho' } }).window.sideWidth, 240)
  assert.equal(sanitize({ window: { sideWidth: 50, panelWidth: 'ancho' } }).window.panelWidth, null)
  assert.equal(sanitize({ window: { sideWidth: null } }).window.sideWidth, null)
})

test('tasks: the last list of a stored chat, as Hermes rebuilds it', () => {
  const { todoStateOf, todoSnapshot, isTodoCall } = require('../src/main/connection')
  const plan = (rev, st) => JSON.stringify({ todos: [{ id: '1', content: 'Read the code', status: 'completed' }, { id: '2', content: '  Build\n again ', status: st, parent: '1' }], revision: rev, summary: {} })
  const rows = [
    { id: 1, role: 'user', content: 'do this' },
    { id: 2, role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'todo_list', arguments: '{"todos":[]}' } }] },
    { id: 3, role: 'tool', tool_call_id: 'a', content: plan(1, 'pending') },
    // Through the tool finder's bridge (todo_list is "deferred" by default).
    { id: 4, role: 'assistant', tool_calls: [{ id: 'b', function: { name: 'tool_call', arguments: JSON.stringify({ calls: [{ name: 'todo_list', arguments: {} }] }) } }] },
    { id: 5, role: 'tool', tool_call_id: 'b', content: plan(2, 'in_progress') },
    // A loose result, without its call, doesn't count (even if it's newer).
    { id: 6, role: 'tool', tool_call_id: 'zz', content: plan(9, 'cancelled') }
  ]
  const st = todoStateOf(rows)
  assert.equal(st.revision, 2)
  assert.deepEqual(st.todos, [{ id: '1', content: 'Read the code', status: 'completed', parent: '' }, { id: '2', content: 'Build again', status: 'in_progress', parent: '1' }])
  assert.equal(todoStateOf(rows.slice(0, 1)), null)
  // If the newest result is an empty list without a revision, there's no plan (an old one doesn't come
  // back to life).
  const vacio = [...rows, { id: 7, role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'todo_list', arguments: '{}' } }] }, { id: 8, role: 'tool', tool_call_id: 'c', content: '{"todos": [], "revision": 0}' }]
  assert.equal(todoStateOf(vacio), null)
  // An unreadable one is skipped and the previous one will do.
  const roto = [...rows, { id: 7, role: 'assistant', tool_calls: [{ id: 'd', function: { name: 'todo_list', arguments: '{}' } }] }, { id: 8, role: 'tool', tool_call_id: 'd', content: '{"todos": [broken' }]
  assert.equal(todoStateOf(roto).revision, 2)
  assert.equal(todoStateOf([rows[0], rows[5]]), null)
  // No plan: an empty list without a revision; with a revision, it's a "cleared" that does count.
  assert.equal(todoSnapshot({ todos: [], revision: 0 }), null)
  assert.deepEqual(todoSnapshot({ todos: [], revision: 3 }), { todos: [], revision: 3 })
  assert.equal(todoSnapshot({ todos: [{ id: 'x', content: 'a', status: 'raro' }] }).todos[0].status, 'pending')
  assert.equal(todoSnapshot(null), null)
  assert.equal(isTodoCall({ function: { name: 'tool_call', arguments: '{"name":"todo_list"}' } }), true)
  assert.equal(isTodoCall({ function: { name: 'tool_call', arguments: '{"calls":[{"name":"todo_list"},{"name":"terminal"}]}' } }), false)
  assert.equal(isTodoCall({ function: { name: 'terminal', arguments: '{"command":"todo"}' } }), false)
  assert.equal(isTodoCall({ function: { name: 'tool_call', arguments: '{broken' } }), false)
})
