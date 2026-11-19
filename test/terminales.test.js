'use strict'
// Terminales dentro de Pedila: ajustes, opciones de Claude y la vigilancia de `claude agents`.
const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitize } = require('../src/main/settings')
const { Terms, splitArgs, SID } = require('../src/main/terms')

const ID = '8ecacd0d-cc36-49b5-ad90-c6667bce6431'

test('ajustes de terminales: modo, carpetas, lista para reabrir y opciones de Claude', () => {
  const s = sanitize({ terminals: {
    mode: 'terms',
    dirs: ['C:\\proyectos', 'C:\\proyectos', 'x', 7, 'D:\\a\nb'],
    restore: [
      { kind: 'claude', cwd: 'C:\\proyectos', sessionId: ID, title: 'Arreglar build' },
      { kind: 'claude', cwd: 'C:\\otro', sessionId: '../../evil' },
      { kind: 'shell', cwd: 'C:\\proyectos', sessionId: ID },
      { kind: 'cmd.exe', cwd: 'C:\\' },
      { kind: 'agy' }
    ],
    claudeArgs: '  --effort max  '
  } })
  assert.equal(s.terminals.mode, 'terms')
  assert.deepEqual(s.terminals.dirs, ['C:\\proyectos'])
  assert.deepEqual(s.terminals.restore, [
    { kind: 'claude', cwd: 'C:\\proyectos', sessionId: ID, title: 'Arreglar build' },
    { kind: 'claude', cwd: 'C:\\otro', sessionId: null, title: '' },
    { kind: 'shell', cwd: 'C:\\proyectos', sessionId: null, title: '' }
  ])
  assert.equal(s.terminals.claudeArgs, '--effort max')
  assert.equal(sanitize({ terminals: { claudeArgs: 'a\nb' } }).terminals.claudeArgs, '')
  assert.equal(sanitize({ terminals: { mode: 'raro' } }).terminals.mode, 'chats')
  assert.deepEqual(sanitize({}).terminals, { mode: 'chats', dirs: [], restore: [], claudeArgs: '', adoptOutside: true, autoRestore: true })
  assert.equal(sanitize({ terminals: { adoptOutside: false, autoRestore: 'no' } }).terminals.adoptOutside, false)
  assert.equal(sanitize({ terminals: { autoRestore: 'no' } }).terminals.autoRestore, true)
})

test('ajustes: un settings.json guardado con BOM se lee igual (no se pierde)', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { Settings } = require('../src/main/settings')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-bom-'))
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), '﻿' + JSON.stringify({ terminals: { adoptOutside: false, claudeArgs: '--effort max' } }))
    const s = new Settings(dir).load()
    assert.equal(s.terminals.adoptOutside, false)
    assert.equal(s.terminals.claudeArgs, '--effort max')
    assert.ok(!fs.existsSync(path.join(dir, 'settings.json.broken')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('opciones de Claude: comillas y espacios', () => {
  assert.deepEqual(splitArgs('--effort max --dangerously-skip-permissions'), ['--effort', 'max', '--dangerously-skip-permissions'])
  assert.deepEqual(splitArgs('--model "claude opus"  --append-system-prompt \'hola mundo\''), ['--model', 'claude opus', '--append-system-prompt', 'hola mundo'])
  assert.deepEqual(splitArgs(''), [])
  assert.deepEqual(splitArgs(null), [])
  assert.ok(SID.test(ID) && !SID.test('x' + ID))
})

test('terminales: abrir con un tipo, carpeta o sesión no válidos falla sin arrancar nada', () => {
  const t = new Terms({ log: { info() {}, warn() {} } })
  assert.throws(() => t.open({ kind: 'cmd' }), /desconocido/)
  t.paths = { claude: 'C:\\no\\claude.exe', hermes: null, agy: null, shell: 'powershell.exe' }
  t.pathsAt = Date.now()
  assert.throws(() => t.open({ kind: 'hermes' }), /No encuentro Hermes/)
  assert.throws(() => t.open({ kind: 'claude', cwd: 'Z:\\no-existe-pedila-123' }), /no existe/)
  assert.throws(() => t.open({ kind: 'claude', cwd: __dirname, resume: '--dangerously-skip-permissions' }), /sesión no válida/)
  assert.equal(t.terms.size, 0)
})

test('terminales: la sesión de Claude se reconoce por el pid y avisa al pasar de trabajar a esperar', () => {
  const t = new Terms({ log: { info() {}, warn() {} } })
  const fake = { id: 't1', kind: 'claude', cwd: 'C:\\p', pty: null, pid: 4242, alive: true, code: null, buf: [], bytes: 0, pending: '', flushT: null, sessionId: null, status: null, title: 'Claude Code', startedAt: 0 }
  t.terms.set('t1', fake)
  const done = []
  t.on('done', info => done.push(info.id))
  const apply = rows => t.applyAgents(rows)
  apply([{ pid: 4242, sessionId: ID, status: 'busy', kind: 'interactive', cwd: 'C:\\p' }, { pid: 99, sessionId: ID.replace('8', '9'), status: 'idle', kind: 'interactive', cwd: 'D:\\' }])
  assert.equal(fake.sessionId, ID)
  assert.deepEqual(done, [])
  apply([{ pid: 4242, sessionId: ID, status: 'idle', kind: 'interactive', cwd: 'C:\\p' }])
  assert.deepEqual(done, ['t1'])
  const view = t.agentsView()
  assert.equal(view[0].term, 't1')
  assert.deepEqual(t.snapshot(), [{ kind: 'claude', cwd: 'C:\\p', sessionId: ID, title: 'Claude Code' }])
})

test('sesiones de fuera: las que lleva un programa no se traen (ni se cierran)', async () => {
  const { isManagedCmd, commandLines } = require('../src/main/terms')
  // Ventanas de Claude Code de verdad.
  assert.equal(isManagedCmd('"C:\\Users\\x\\.local\\bin\\claude.exe"'), false)
  assert.equal(isManagedCmd('"C:\\Users\\x\\.local\\bin\\claude.exe" --resume ' + ID + ' --effort max'), false)
  assert.equal(isManagedCmd('claude.exe "explica git log -p"'), false)
  // Las que lleva un programa: chats de Pedila (con o sin anfitrión), VS Code, el SDK.
  assert.equal(isManagedCmd('claude.exe -p --input-format stream-json --output-format stream-json --verbose --session-id ' + ID), true)
  assert.equal(isManagedCmd('claude.exe --output-format=stream-json --print'), true)
  assert.equal(isManagedCmd('claude.exe --sdk-url wss://x'), true)
  assert.equal(isManagedCmd(''), false)

  const t = new Terms({ log: { info() {}, warn() {} } })
  const rows = [
    { pid: 101, startedAt: 5, sessionId: ID, status: 'idle', kind: 'interactive', cwd: 'C:\\p' },
    { pid: 102, startedAt: 6, sessionId: ID.replace('8', '9'), status: 'idle', kind: 'interactive', cwd: 'C:\\p' },
    { pid: 103, startedAt: 7, sessionId: ID.replace('8', '7'), status: 'idle', kind: 'interactive', cwd: 'C:\\p' }
  ]
  t.launch.set('101:5', true)
  t.launch.set('102:6', false)
  t.launchFailAt = Date.now() // sin PowerShell en la prueba: la 103 se queda «sin saber»
  t.applyAgents(rows)
  assert.deepEqual(t.agents.map(a => a.managed), [true, false, null])
  assert.deepEqual(t.agentsView().map(a => a.managed), [true, false, null])
  await assert.rejects(t.adopt(ID), /otro programa/)
  // Lo de procesos que ya no están se olvida.
  await t.classify([rows[1]], true)
  assert.deepEqual([...t.launch.keys()], ['102:6'])

  if (process.platform === 'win32') {
    const m = await commandLines([process.pid])
    assert.ok(m && /node/i.test(m.get(process.pid) || ''), 'lee la línea de órdenes de un proceso')
  }
})

test('diseño: orden completo, nombres conocidos y siempre algo a la vista', () => {
  const { sanitize: san, defaultLayout } = require('../src/main/settings')
  const l = san({ layout: { conns: ['claude', 'raro', 'claude'], connsHidden: ['local', 'server', 'claude'], modesHidden: ['chats', 'terms'], cards: ['cuotas'], cardsTerms: ['consolas', 'x'], swap: true, show: { model: false, raro: false } } }).layout
  assert.deepEqual(l.conns, ['claude', 'local', 'server'])
  assert.deepEqual(l.connsHidden, [])
  assert.deepEqual(l.modesHidden, [])
  assert.equal(l.cards[0], 'cuotas')
  assert.equal(l.cards.length, 8)
  assert.deepEqual(l.cardsTerms, ['consolas'])
  assert.equal(l.swap, true)
  assert.equal(l.show.model, false)
  assert.equal(l.show.raro, undefined)
  assert.deepEqual(san({}).layout, defaultLayout())
})
