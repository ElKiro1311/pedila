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
  assert.deepEqual(sanitize({}).terminals, { mode: 'chats', dirs: [], restore: [], claudeArgs: '' })
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
