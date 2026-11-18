'use strict'
// Claude Code como chat: leer las conversaciones guardadas y las piezas puras.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SID = '11111111-2222-4333-8444-555555555555'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-claude-'))
process.env.CLAUDE_CONFIG_DIR = tmp
const { ClaudeConnection, userText, todosOf } = require('../src/main/claude')
const { cmdLine } = require('../src/main/terms')

const lines = [
  { type: 'permission-mode', permissionMode: 'default', sessionId: SID },
  { type: 'user', cwd: 'C:\\proyectos\\web', sessionId: SID, message: { role: 'user', content: '<command-name>/model</command-name>' } },
  { type: 'user', cwd: 'C:\\proyectos\\web', sessionId: SID, isMeta: true, message: { role: 'user', content: 'aviso interno' } },
  { type: 'user', cwd: 'C:\\proyectos\\web', sessionId: SID, timestamp: '2026-11-18T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Arregla el build' }] } },
  { type: 'assistant', sessionId: SID, message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'miro el Makefile' }, { type: 'text', text: 'Voy a mirar.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:\\proyectos\\web\\Makefile' } }] } },
  { type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'all: build' }] } },
  { type: 'assistant', sessionId: SID, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu2', name: 'TodoWrite', input: { todos: [{ content: 'Leer', status: 'completed' }, { content: 'Arreglar', status: 'in_progress' }] } }] } },
  { type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok', is_error: true }] } },
  { type: 'assistant', sessionId: SID, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Listo.' }] } },
  { type: 'ai-title', aiTitle: 'Arreglar el build', sessionId: SID },
  { type: 'last-prompt', lastPrompt: 'Arregla el build', sessionId: SID },
  { type: 'cost-state', modelUsage: { 'claude-opus-5-5': { inputTokens: 10, cacheCreationInputTokens: 90, outputTokens: 7 } } }
]
const dir = path.join(tmp, 'projects', 'C--proyectos-web')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, SID + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
// Una sin mensajes tuyos (no sale) y un archivo que no es una conversación (tampoco).
fs.writeFileSync(path.join(dir, '22222222-2222-4333-8444-555555555555.jsonl'), JSON.stringify({ type: 'permission-mode' }) + '\n')
fs.writeFileSync(path.join(dir, 'notas.jsonl'), '{}\n')

const conn = () => new ClaudeConnection({ log: { info() {}, warn() {} }, settings: { data: { terminals: { claudeArgs: '' } } }, metaFile: path.join(tmp, 'meta.json'), trash: async f => fs.rmSync(f) })

test('claude: texto del usuario sin órdenes locales ni recordatorios', () => {
  assert.equal(userText('<command-name>/clear</command-name>'), '')
  assert.equal(userText('<local-command-stdout>x</local-command-stdout>'), '')
  assert.equal(userText([{ type: 'text', text: 'hola <system-reminder>no</system-reminder>' }]), 'hola')
  assert.equal(userText([{ type: 'tool_result', content: 'x' }]), '')
  assert.deepEqual(todosOf({ todos: [{ content: 'a', status: 'raro' }] }), { todos: [{ id: '1', content: 'a', status: 'pending' }] })
  assert.equal(todosOf({}), null)
})

test('claude: la lista sale de ~/.claude/projects con título, carpeta y tokens', async () => {
  const c = conn()
  const rows = await c.listSessions()
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.id, SID)
  assert.equal(r.title, 'Arreglar el build')
  assert.equal(r.cwd, 'C:\\proyectos\\web')
  assert.match(r.preview, /^web · Arregla el build/)
  assert.equal(r.model, 'claude-opus-5-5')
  assert.equal(r.inputTokens, 100)
  assert.equal(r.outputTokens, 7)
  // Fijar y archivar se guardan en Pedila, no en la conversación.
  await c.setArchived(SID, true)
  assert.equal((await c.listSessions()).length, 0)
  assert.equal((await c.archived()).length, 1)
  await c.setArchived(SID, false)
  await c.setPinned(SID, true)
  assert.equal((await c.listSessions())[0].pinned, true)
})

test('claude: la conversación se lee como un chat, con herramientas y tareas', async () => {
  const c = conn()
  const todos = []
  c.on('ui', e => { if (e.kind === 'todos') { todos.push(e) } })
  const t = await c.transcript(SID)
  assert.equal(t.length, 2)
  assert.deepEqual(t[0], { role: 'user', text: 'Arregla el build', ts: '2026-11-18T10:00:00Z' })
  assert.equal(t[1].reasoning, 'miro el Makefile')
  assert.deepEqual(t[1].blocks.map(b => b.type + ':' + (b.name || b.text)), ['text:Voy a mirar.', 'tool:Read', 'tool:TodoWrite', 'text:Listo.'])
  assert.equal(t[1].blocks[1].summary, 'all: build')
  assert.match(t[1].blocks[2].summary, /^Error: /)
  assert.equal(todos[0].todos[1].status, 'in_progress')
})

test('claude: los eventos de stream-json se convierten en los del chat', () => {
  const c = conn()
  const ev = []
  c.on('ui', e => ev.push(e))
  const s = { sid: SID, buf: '', blocks: new Map(), busy: true, queued: 0, turnAt: Date.now(), allow: new Set(), alive: true, proc: { stdin: { write() {} } } }
  c.onData(s, [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ho' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'la' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'de un subagente' } }, parent_tool_use_id: 'x' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: [{ type: 'text', text: 'a.txt' }] }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1 } } } },
    { type: 'result', subtype: 'success', result: 'Hola', duration_ms: 1200, usage: { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 5 }, modelUsage: { m: { contextWindow: 200000 } } }
  ].map(m => JSON.stringify(m)).join('\n') + '\n')
  const kinds = ev.map(e => e.kind + (e.phase ? ':' + e.phase : ''))
  assert.deepEqual(kinds.filter(k => k !== 'sessions-changed'), ['info', 'delta', 'delta', 'segment', 'tool:start', 'prompt', 'tool:complete', 'claude-limits', 'usage', 'complete', 'running'])
  assert.equal(ev.filter(e => e.kind === 'delta').map(e => e.text).join(''), 'Hola')
  assert.equal(ev.find(e => e.kind === 'usage').used, 1007)
  assert.equal(ev.find(e => e.kind === 'complete').outcome, 'completed')
  assert.equal(ev.find(e => e.kind === 'prompt').command, 'Bash: ls')
  assert.equal(s.busy, false)
})

test('claude: responder a un permiso manda la respuesta a claude', async () => {
  const c = conn()
  const sent = []
  const s = { sid: SID, blocks: new Map(), busy: true, queued: 0, allow: new Set(), alive: true, proc: { stdin: { write: x => sent.push(JSON.parse(x)) } } }
  c.procs.set(SID, s)
  let key = null
  c.on('ui', e => { if (e.kind === 'prompt') { key = e.key } })
  c.onMsg(s, { type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a' } } })
  await assert.rejects(c.answer(key, 'always'), /no válida/)
  assert.deepEqual(await c.answer(key, 'session'), { ok: true })
  assert.deepEqual(sent[0].response.response, { behavior: 'allow', updatedInput: { file_path: 'a' } })
  // «En este chat»: la siguiente vez del mismo programa no pregunta.
  c.onMsg(s, { type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } })
  assert.equal(sent[1].response.request_id, 'r3')
  assert.equal(c.prompts.size, 0)
})

test('cmd.exe: rutas con espacios y opciones con comillas', () => {
  assert.equal(cmdLine('C:/Users/Juan Perez/npm/claude.cmd', ['--resume', 'abc', '--append-system-prompt', 'responde en español']),
    '/d /s /c ""C:/Users/Juan Perez/npm/claude.cmd" --resume abc --append-system-prompt "responde en español""')
  assert.throws(() => cmdLine('claude.cmd', ['x"&calc&"']), /no válida/)
  assert.throws(() => cmdLine('claude.cmd', ['%PATH%']), /no válida/)
  assert.equal(cmdLine('claude.cmd', ['a&b']), '/d /s /c "claude.cmd "a&b""')
})

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

test('claude: lo que escribes a mitad de turno no deja el chat «trabajando» para siempre', async () => {
  const c = conn()
  const ev = []
  c.on('ui', e => ev.push(e.kind + (e.kind === 'running' ? ':' + e.running : '')))
  const sent = []
  const s = { sid: SID, buf: '', blocks: new Map(), busy: false, turnAt: 0, allow: new Set(), alive: true, lastUsed: Date.now(), proc: { stdin: { write: x => sent.push(x) } } }
  c.procs.set(SID, s)
  await c.send(SID, 'primero')
  assert.equal(s.busy, true)
  // Un segundo mensaje mientras trabaja: Claude lo mete en el mismo turno.
  assert.deepEqual(await c.send(SID, 'y otra cosa'), { status: 'queued' })
  c.onMsg(s, { type: 'result', subtype: 'success', result: 'ok', usage: {} })
  assert.equal(s.busy, false)
  assert.ok(ev.includes('running:false'))
  // Si después Claude sigue (un turno nuevo con lo que esperaba), vuelve a «trabajando».
  ev.length = 0
  c.onMsg(s, { type: 'stream_event', event: { type: 'message_start' } })
  assert.equal(s.busy, true)
  assert.deepEqual(ev, ['turn-start', 'running:true'])
  c.onMsg(s, { type: 'result', subtype: 'success', result: 'ok 2', usage: {} })
  assert.equal(s.busy, false)
  // La cuota y otros avisos sueltos no cuentan como trabajo.
  c.onMsg(s, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
  assert.equal(s.busy, false)
})
