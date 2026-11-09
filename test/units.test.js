'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitize, defaults } = require('../src/main/settings')
const { parseSetCookie } = require('../src/main/remote')
const { normalizeTranscript, sessionRow, argsSummary } = require('../src/main/connection')
const { decide } = require('../src/main/notify')

test('ajustes: valores fuera de rango y claves desconocidas', () => {
  const s = sanitize({ look: { theme: 'neón', accent: 'rosa', textSize: 400 }, raro: 1, notify: { minDurationSec: -5, sound: 'sí' }, server: { urls: ['javascript:alert(1)', 'http://a:b@x', 'http://192.168.1.50:9119/ruta'] } })
  assert.equal(s.look.theme, 'system')
  assert.equal(s.look.accent, 'rosa')
  assert.equal(s.look.textSize, 140)
  assert.equal(s.raro, undefined)
  assert.equal(s.notify.minDurationSec, 0)
  assert.equal(s.notify.sound, true)
  assert.deepEqual(s.server.urls, ['http://192.168.1.50:9119'])
  assert.deepEqual(sanitize(null), defaults())
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
