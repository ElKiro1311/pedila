'use strict'
// Los arreglos de la revisión de la 0.12: imágenes que se piden aparte, compactación, fallos de
// Hermes, resultados MCP/recortados, «parado», turno en cola y cambios con contexto.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SID = '33333333-2222-4333-8444-555555555555'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-rev-'))
process.env.CLAUDE_CONFIG_DIR = tmp
const { ClaudeConnection } = require('../src/main/claude')
const { hermesToolOutput, hermesFailed, splitCompaction, normalizeTranscript } = require('../src/main/connection')

const IMG = 'iVBORw0KGgo='
const lines = [
  { type: 'user', cwd: 'C:\\p', sessionId: SID, uuid: 'u-1', message: { role: 'user', content: [{ type: 'text', text: 'mira esto' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }] } },
  { type: 'assistant', sessionId: SID, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:\\p\\a.png' } }] } },
  { type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }] }] } },
  { type: 'user', sessionId: SID, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation…' } },
  { type: 'user', sessionId: SID, message: { role: 'user', content: 'sigue' } }
]
const dir = path.join(tmp, 'projects', 'C--p')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, SID + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
const conn = () => new ClaudeConnection({ log: { info() {}, warn() {} }, settings: { data: { terminals: { claudeArgs: '' } } }, metaFile: path.join(tmp, 'meta.json'), trash: async () => {} })

test('claude: las imágenes no viajan con la conversación, se piden al verlas', async () => {
  const c = conn()
  await c.listSessions()
  const t = await c.transcript(SID)
  assert.ok(!JSON.stringify(t).includes(IMG), 'la conversación no lleva los bytes de las imágenes')
  const u = t.find(x => x.role === 'user' && x.imageCount)
  assert.equal(u.imageCount, 1)
  assert.equal(await c.media(`${u.imageRef}|0`), `data:image/png;base64,${IMG}`)
  const tool = t.find(x => x.role === 'assistant').blocks[0]
  assert.equal(tool.imageCount, 1)
  assert.equal(await c.media(`${tool.imageRef}|0`), `data:image/png;base64,${IMG}`)
  await assert.rejects(c.media('../../etc/passwd'), /no válida/)
  await assert.rejects(c.media(`${u.imageRef}|5`), /no encuentro/)
  // Tras reiniciar (sin índice), la imagen se sigue encontrando.
  assert.equal(await conn().media(`${tool.imageRef}|0`), `data:image/png;base64,${IMG}`)
  // El resumen de compactación de Claude es una nota, no un mensaje tuyo.
  assert.deepEqual(t.map(x => x.role), ['user', 'assistant', 'note', 'user'])
})

test('claude: parar sale como «parado» y con un turno en cola no se da por terminado', () => {
  const c = conn()
  const ev = []
  c.on('ui', e => ev.push(e))
  const s = { sid: SID, buf: '', blocks: new Map(), busy: true, turnAt: Date.now(), allow: new Set(), alive: true, tasks: new Map(), controls: new Map(), proc: { stdin: { write() {} } } }
  c.procs.set(SID, s)
  c.interrupt(SID)
  c.onMsg(s, { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', usage: {} })
  assert.equal(ev.find(e => e.kind === 'complete').outcome, 'interrupted')
  ev.length = 0
  s.busy = true
  c.onMsg(s, { type: 'result', subtype: 'success', result: 'uno', queued_turn_count: 1, usage: {} })
  assert.equal(s.busy, true)
  assert.equal(ev.find(e => e.kind === 'complete').more, true)
  assert.ok(!ev.some(e => e.kind === 'running' && e.running === false))
})

test('hermes: fallos como los decide Hermes', () => {
  assert.equal(hermesFailed('web_extract', '', { results: [{ url: 'a', error: null }], failed: 0 }), false)
  assert.equal(hermesFailed('search_files', '', { error: 'repetida', guardrail_refusal: true }), false)
  assert.equal(hermesFailed('delegate_task', '', { results: [{ error: 'interrumpido' }, { error: 'x' }] }), true)
  assert.equal(hermesFailed('delegate_task', '', { results: [{ error: 'interrumpido' }, { result: 'ok' }] }), false)
  assert.equal(hermesFailed('x', '', { status: 'failed' }), true)
  assert.equal(hermesFailed('write_file', '', { bytes_written: 10 }), false)
  assert.equal(hermesFailed('x', 'Error: no pude', null), true)
  assert.equal(hermesFailed('x', 'todo bien, "error": null', null), false)
  assert.equal(hermesFailed('x', 'algo "failed": "sí"', null), true)
  assert.equal(hermesFailed('terminal', '', { exit_code: 0, error: 'warn' }), false)
})

test('hermes: resultados MCP y recortados se leen como texto', () => {
  assert.equal(hermesToolOutput('mcp_x', JSON.stringify({ result: 'línea 1\nlínea 2' }), null).text, 'línea 1\nlínea 2')
  const inner = JSON.stringify({ output: 'hola\nmundo '.repeat(3), exit_code: 0 })
  const cut = JSON.stringify({ output: inner.slice(0, 30), truncated: true })
  const o = hermesToolOutput('terminal', cut, false)
  assert.match(o.text, /^hola\nmundo/)
  assert.match(o.text, /Hermes lo recortó/)
})

test('hermes: al compactar, tu mensaje no desaparece ni se llena con el resumen', () => {
  const END = '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
  assert.deepEqual(splitCompaction(`[CONTEXT COMPACTION — REFERENCE ONLY] resumen\n${END}\nArregla el build`), { summary: '[CONTEXT COMPACTION — REFERENCE ONLY] resumen', message: 'Arregla el build' })
  const prior = '[PRIOR CONTEXT — for reference only; not a new message]\nmi mensaje\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n[CONTEXT COMPACTION] resumen'
  assert.deepEqual(splitCompaction(prior), { summary: '[CONTEXT COMPACTION] resumen', message: 'mi mensaje' })
  assert.equal(splitCompaction('hola'), null)
  const t = normalizeTranscript([
    { id: 1, role: 'user', content: `[CONTEXT COMPACTION — REFERENCE ONLY] resumen\n${END}\nArregla el build`, display_content: 'Arregla el build de Android' },
    { id: 2, role: 'user', content: '[OUT-OF-BAND USER MESSAGE — x] para ya [/OUT-OF-BAND USER MESSAGE]', display_content: 'para ya' }
  ])
  assert.deepEqual(t.map(x => `${x.role}:${x.role === 'note' ? x.kind : x.text}`), ['note:compaction', 'user:Arregla el build de Android', 'user:para ya'])
})

test('herramientas: un Edit cuenta solo lo que cambia', async () => {
  const { describeTool, diffStats } = await import('../src/shell/tools.mjs')
  const d = describeTool({ name: 'Edit', input: { file_path: 'a.js', old_string: 'l1\nl2\nl3\nl4', new_string: 'l1\nl2\nNUEVA\nl3\nl4' } })
  assert.deepEqual([d.add, d.del], [1, 0])
  assert.equal(d.box.text, '  l1\n  l2\n+ NUEVA\n  l3\n  l4')
  // En un diff de Hermes, el contexto empieza por espacio y no cuenta.
  assert.deepEqual(diffStats(' - sin cambio\n-borrada\n+nueva\n +contexto'), { add: 1, del: 1 })
})

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
