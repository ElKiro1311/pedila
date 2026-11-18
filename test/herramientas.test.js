'use strict'
// Herramientas como en Claude Code: títulos, recuadros, resúmenes de grupo y lo que devuelve Hermes.
const test = require('node:test')
const assert = require('node:assert/strict')
const { hermesToolOutput, boundInput, contentImages, normalizeTranscript } = require('../src/main/connection')

test('herramientas: título y recuadro de cada clase (Claude y Hermes)', async () => {
  const { describeTool, toolKind, prettyName } = await import('../src/shell/tools.mjs')
  // Bash con su descripción, como en Claude Code.
  let d = describeTool({ name: 'Bash', input: { command: 'npm test', description: 'Pasar las pruebas' } })
  assert.equal(d.kind, 'run')
  assert.equal(d.title, 'Pasar las pruebas')
  assert.deepEqual(d.box, { lang: 'cmd', text: 'npm test' })
  // La terminal de Hermes, sin descripción.
  d = describeTool({ name: 'terminal', input: { command: 'ls -la' } })
  assert.equal(d.title, 'Ejecutó ls -la')
  d = describeTool({ name: 'Read', input: { file_path: 'C:\\a\\b\\badges.png' } })
  assert.equal(d.title, 'Leyó badges.png')
  d = describeTool({ name: 'Write', input: { file_path: '/x/nuevo.js', content: 'a\nb\nc\n' } })
  assert.equal(d.title, 'Creó nuevo.js')
  assert.equal(d.add, 3)
  d = describeTool({ name: 'Edit', input: { file_path: '/x/a.js', old_string: 'uno\ndos', new_string: 'tres' } })
  assert.equal(d.title, 'Editó a.js')
  assert.deepEqual([d.add, d.del], [1, 2])
  assert.equal(d.box.lang, 'diff')
  assert.equal(d.box.text, '- uno\n- dos\n+ tres')
  // patch de Hermes con su cambio ya dibujado: manda el de Hermes.
  d = describeTool({ name: 'patch', input: { path: 'a.py' }, diff: '@@ -1 +1 @@\n-x = 1\n+x = 2\n+y = 3' })
  assert.deepEqual([d.add, d.del, d.box.lang], [2, 1, 'diff'])
  assert.equal(toolKind('browser_navigate'), 'fetch')
  assert.equal(toolKind('mcp__coop-anything__get_game'), 'other')
  assert.equal(prettyName('mcp__plugin_ReVa_ReVa__get-functions'), 'get functions (ReVa ReVa)')
  d = describeTool({ name: 'mcp__coop-anything__get_game', input: { name: 'Sekiro' } })
  assert.equal(d.title, 'Usó get game (coop-anything)')
  assert.equal(d.box.lang, 'json')
  d = describeTool({ name: 'TodoWrite', input: { todos: [{ content: 'Leer', status: 'completed' }, { content: 'Arreglar', status: 'in_progress' }] } })
  assert.equal(d.box.text, '☑ Leer\n◐ Arreglar')
  // Sin entrada (conversaciones viejas): no se cae.
  assert.equal(describeTool({ name: 'Bash', args: 'echo hola' }).title, 'Ejecutó echo hola')
  assert.equal(describeTool({}).kind, 'other')
})

test('herramientas: resumen de un grupo, como «Ran 2 commands, read badges.png, 1 failed»', async () => {
  const { groupSummary, failedText } = await import('../src/shell/tools.mjs')
  const g = groupSummary([
    { name: 'Bash', input: { command: 'a' }, done: true },
    { name: 'Bash', input: { command: 'b' }, done: true, error: true },
    { name: 'Read', input: { file_path: 'x/badges.png' }, done: true }
  ])
  assert.equal(g.text, 'Ejecutó 2 órdenes, leyó badges.png')
  assert.equal(g.failed, 1)
  assert.equal(failedText(g.failed), '1 falló')
  assert.equal(failedText(2), '2 fallaron')
  const w = groupSummary([{ name: 'Write', input: { file_path: 'b.py', content: 'x\ny' }, done: true }, { name: 'Bash', input: { command: 'python b.py' }, done: true }])
  assert.equal(w.text, 'Ejecutó una orden, creó b.py')
  assert.equal(w.add, 2)
  // Una sola: su descripción; en marcha y sin descripción, en gerundio.
  assert.equal(groupSummary([{ name: 'Bash', input: { command: 'x', description: 'Arrancar la copia de prueba' }, done: false }]).text, 'Arrancar la copia de prueba')
  assert.equal(groupSummary([{ name: 'Read', input: { file_path: 'a/b.txt' }, done: false }]).text, 'Leyendo b.txt')
  assert.equal(groupSummary([{ name: 'Read', input: { file_path: 'a.txt' }, done: true }, { name: 'Read', input: { file_path: 'b.txt' }, done: true }]).text, 'Leyó 2 archivos')
  assert.equal(groupSummary([{ name: 'mcp__a__uno', done: true }, { name: 'mcp__a__dos', done: true }, { name: 'mcp__a__tres', done: true }]).text, 'Usó uno (a) y dos (a) y 1 más')
  assert.equal(groupSummary([{ name: 'Bash', input: { command: 'a' }, done: false }, { name: 'Bash', input: { command: 'b' }, done: true }]).running, 1)
})

test('herramientas de Hermes: resultado legible y fallo como lo decide Hermes', () => {
  let o = hermesToolOutput('terminal', JSON.stringify({ output: 'hola', exit_code: 0, error: null }), null)
  assert.deepEqual(o, { text: 'hola', error: false })
  o = hermesToolOutput('terminal', JSON.stringify({ output: '', exit_code: 2, error: 'no existe' }), null)
  assert.equal(o.error, true)
  assert.match(o.text, /Error: no existe/)
  assert.match(o.text, /código 2/)
  assert.deepEqual(hermesToolOutput('read_file', JSON.stringify({ content: 'línea 1' }), null), { text: 'línea 1', error: false })
  assert.deepEqual(hermesToolOutput('write_file', JSON.stringify({ success: false, error: 'denegado' }), null), { text: 'denegado', error: true })
  // El aviso del propio Hermes (is_error) manda.
  assert.equal(hermesToolOutput('web_search', 'texto', true).error, true)
  assert.equal(hermesToolOutput('web_search', 'texto plano', null).text, 'texto plano')
  // Los colores de la consola (ANSI) se quitan.
  assert.equal(hermesToolOutput('terminal', JSON.stringify({ output: '\u001b[31mrojo\u001b[0m', exit_code: 0 }), null).text, 'rojo')
  assert.ok(hermesToolOutput('x', 'a'.repeat(20000), null).text.endsWith('(recortado)'))
})

test('herramientas: lo que se les pasó, acotado; imágenes y notas de la conversación', () => {
  const big = boundInput({ content: 'x'.repeat(10000), n: 3, list: Array.from({ length: 100 }, (_, i) => i), deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } })
  assert.ok(big.content.length < 6100)
  assert.equal(big.list.length, 60)
  assert.equal(big.n, 3)
  assert.equal(big.deep.a.b.c.d, '…')
  assert.deepEqual(contentImages([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'image_url', image_url: { url: 'https://fuera.com/x.png' } }]), [{ url: 'data:image/png;base64,AAAA', name: 'imagen' }])
  const t = normalizeTranscript([
    { id: 1, role: 'user', content: '[CONTEXT COMPACTION — REFERENCE ONLY] resumen…' },
    { id: 2, role: 'user', content: 'terminó el proceso 12', display_kind: 'process_complete' },
    { id: 3, role: 'user', content: 'hola' },
    { id: 4, role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'false' }) } }] },
    { id: 5, role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ output: '', exit_code: 1, error: 'falló' }) }
  ])
  assert.deepEqual(t.map(x => x.role + (x.kind ? ':' + x.kind : '')), ['note:compaction', 'note:process_complete', 'user', 'assistant'])
  const tool = t[3].blocks[0]
  assert.deepEqual(tool.input, { command: 'false' })
  assert.equal(tool.error, true)
  assert.match(tool.output, /Error: falló/)
})
