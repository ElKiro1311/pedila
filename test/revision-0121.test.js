'use strict'
// Los arreglos de la revisión de la 0.12 que tocan a Hermes: compactación, fallos de Hermes,
// resultados MCP/recortados y cambios con contexto.
const test = require('node:test')
const assert = require('node:assert/strict')
const { hermesToolOutput, hermesFailed, splitCompaction, normalizeTranscript } = require('../src/main/connection')

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
