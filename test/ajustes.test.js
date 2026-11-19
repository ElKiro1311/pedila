'use strict'
// Ajustes: el archivo con BOM, el diseño (orden y lo escondido) y los ajustes de las versiones con
// Claude Code y consolas (0.10–0.13), que se limpian solos al abrir esta.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Settings, sanitize, defaultLayout } = require('../src/main/settings')

test('ajustes: un settings.json guardado con BOM se lee igual (no se pierde)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-bom-'))
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), '\uFEFF' + JSON.stringify({ look: { palette: 'olivo', theme: 'dark' }, layout: { swap: true } }))
    const s = new Settings(dir).load()
    assert.equal(s.look.palette, 'olivo')
    assert.equal(s.layout.swap, true)
    assert.ok(!fs.existsSync(path.join(dir, 'settings.json.broken')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('diseño: orden completo, nombres conocidos y siempre algo a la vista', () => {
  const l = sanitize({ layout: { conns: ['server', 'raro', 'server'], connsHidden: ['local', 'server'], cards: ['cuotas'], cardsChats: ['cuotas', 'x'], swap: true, show: { model: false, raro: false } } }).layout
  assert.deepEqual(l.conns, ['server', 'local'])
  assert.deepEqual(l.connsHidden, [])
  assert.equal(l.cards[0], 'cuotas')
  assert.equal(l.cards.length, 7)
  assert.deepEqual(l.cardsChats, ['cuotas'])
  assert.equal(l.swap, true)
  assert.equal(l.show.model, false)
  assert.equal(l.show.raro, undefined)
  assert.deepEqual(sanitize({ layout: { connsHidden: ['server'] } }).layout.connsHidden, ['server'])
  assert.deepEqual(sanitize({}).layout, defaultLayout())
})

test('ajustes de la 0.13 (con Claude Code y consolas): se quedan solo los de Hermes', () => {
  const old = {
    lastConnection: 'claude',
    look: { palette: 'mensajera', theme: 'system', accent: 'tema', textSize: 100 },
    models: { local: { model: 'deepseek-v4-flash', provider: 'venice', local: false }, server: null, claude: { model: 'opus', provider: 'claude' } },
    chat: { reasoning: 'high' },
    terminals: { mode: 'terms', dirs: ['C:\\p'], restore: [{ kind: 'claude', cwd: 'C:\\p' }], claudeArgs: '--effort max', adoptOutside: true, autoRestore: true },
    layout: {
      conns: ['local', 'claude', 'server'], connsHidden: ['claude'], modes: ['chats', 'terms'], modesHidden: [],
      cards: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones', 'consolas'],
      cardsChats: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'], cardsTerms: ['consolas', 'cuotas', 'conexiones'],
      swap: false, show: { attach: true, dir: true, model: true }
    }
  }
  const s = sanitize(old)
  assert.equal(s.lastConnection, 'local')
  assert.deepEqual(Object.keys(s.models).sort(), ['local', 'server'])
  assert.equal(s.models.local.model, 'deepseek-v4-flash')
  assert.equal(s.chat.reasoning, 'high')
  assert.equal(s.terminals, undefined)
  assert.deepEqual(s.layout.conns, ['local', 'server'])
  assert.deepEqual(s.layout.connsHidden, [])
  assert.deepEqual(s.layout.cards, ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'])
  assert.deepEqual(s.layout.cardsChats, ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'])
  for (const k of ['modes', 'modesHidden', 'cardsTerms']) { assert.equal(s.layout[k], undefined, k) }
  assert.equal(s.layout.show.dir, undefined)
  // Guardado y vuelto a leer, igual (nada de lo viejo vuelve).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-0140-'))
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(old))
    const st = new Settings(dir)
    st.load()
    st.patch({ look: { textSize: 110 } })
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    assert.equal(disk.terminals, undefined)
    assert.equal(disk.lastConnection, 'local')
    assert.equal(disk.look.textSize, 110)
    assert.deepEqual(disk.layout.conns, ['local', 'server'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('esfuerzo de los chats nuevos: «muy a fondo» y «al máximo» se recuerdan al volver a abrir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-esfuerzo-'))
  try {
    for (const v of ['xhigh', 'max', 'high', '']) {
      new Settings(dir).patch({ chat: { reasoning: v } })
      assert.equal(new Settings(dir).load().chat.reasoning, v, v || '(el de Hermes)')
    }
    assert.equal(sanitize({ chat: { reasoning: 'ultra' } }).chat.reasoning, '')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
