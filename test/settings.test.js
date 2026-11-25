'use strict'
// Settings: the file with a BOM, the layout (order and what is hidden) and the settings of the versions
// with Claude Code and consoles (0.10–0.13), which clean themselves when this one opens.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Settings, sanitize, defaults, defaultLayout } = require('../src/main/settings')

test("settings: a settings.json saved with a BOM is read the same (it isn't lost)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-bom-'))
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), '\uFEFF' + JSON.stringify({ look: { palette: 'olivo', theme: 'dark' }, layout: { swap: true } }))
    const s = new Settings(dir).load()
    assert.equal(s.look.palette, 'olivo')
    assert.equal(s.layout.swap, true)
    assert.ok(!fs.existsSync(path.join(dir, 'settings.json.broken')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('layout: full order, known names and always something in sight', () => {
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

test("the panel's two views: which one, each one's cards and each one's width", () => {
  const s = raw => sanitize(raw)
  assert.equal(defaults().window.panelView, 'simple')
  assert.equal(s({ window: {} }).window.panelView, 'simple') // settings from before there were two
  assert.equal(s({ window: { panelView: 'advanced' } }).window.panelView, 'advanced')
  assert.equal(s({ window: { panelView: 'huge' } }).window.panelView, 'simple')
  const w = s({ window: { panelWidth: 680, panelWidthSimple: 90 } }).window
  assert.deepEqual([w.panelWidth, w.panelWidthSimple, s({ window: { panelWidth: 500 } }).window.panelWidthSimple], [680, 240, null])
  // The cards hidden before there were two views stay hidden in both; then each one goes its way.
  const old = s({ layout: { cardsChats: ['cuotas', 'ahora'] } }).layout
  assert.deepEqual([old.cardsChats, old.cardsSimple], [['cuotas', 'ahora'], ['cuotas', 'ahora']])
  assert.deepEqual(s({ layout: { cardsChats: ['cuotas'], cardsSimple: ['ahora', 'x', 'ahora'] } }).layout.cardsSimple, ['ahora'])
  assert.deepEqual(s({ layout: { cardsChats: ['cuotas'], cardsSimple: [] } }).layout.cardsSimple, [])
  assert.deepEqual(s({ layout: { cards: ['cuotas'] } }).layout.cardsSimple, defaultLayout().cardsSimple)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-vistas-'))
  try {
    const st = new Settings(dir)
    st.patch({ window: { panelView: 'advanced', panelWidthSimple: 320 } })
    st.patch({ window: { sidePanel: false } })
    const again = new Settings(dir).load().window
    assert.deepEqual([again.panelView, again.panelWidthSimple, again.panelWidth, again.sidePanel], ['advanced', 320, null, false])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("settings from 0.13 (with Claude Code and consoles): only Hermes's stay", () => {
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
  // Saved and read again, the same (nothing of the old comes back).
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

test('effort of new chats: "very deep" and "maximum" are remembered when it opens again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-esfuerzo-'))
  try {
    for (const v of ['xhigh', 'max', 'high', '']) {
      new Settings(dir).patch({ chat: { reasoning: v } })
      assert.equal(new Settings(dir).load().chat.reasoning, v, v || "(Hermes's)")
    }
    assert.equal(sanitize({ chat: { reasoning: 'ultra' } }).chat.reasoning, '')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
