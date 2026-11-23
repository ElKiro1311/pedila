'use strict'
// Tools as in Claude Code: titles, boxes, group summaries and what Hermes returns.
const test = require('node:test')
const assert = require('node:assert/strict')
const { hermesToolOutput, boundInput, contentImages, normalizeTranscript } = require('../src/main/connection')

test('tools: title and box of each kind (Claude and Hermes)', async () => {
  const { describeTool, toolKind, prettyName } = await import('../src/shell/tools.mjs')
  // Bash with its description, as in Claude Code.
  let d = describeTool({ name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } })
  assert.equal(d.kind, 'run')
  assert.equal(d.title, 'Run the tests')
  assert.deepEqual(d.box, { lang: 'cmd', text: 'npm test' })
  // Hermes's terminal, without a description.
  d = describeTool({ name: 'terminal', input: { command: 'ls -la' } })
  assert.equal(d.title, 'Ran ls -la')
  d = describeTool({ name: 'Read', input: { file_path: 'C:\\a\\b\\badges.png' } })
  assert.equal(d.title, 'Read badges.png')
  d = describeTool({ name: 'Write', input: { file_path: '/x/new.js', content: 'a\nb\nc\n' } })
  assert.equal(d.title, 'Created new.js')
  assert.equal(d.add, 3)
  d = describeTool({ name: 'Edit', input: { file_path: '/x/a.js', old_string: 'one\ntwo', new_string: 'three' } })
  assert.equal(d.title, 'Edited a.js')
  assert.deepEqual([d.add, d.del], [1, 2])
  assert.equal(d.box.lang, 'diff')
  assert.equal(d.box.text, '- one\n- two\n+ three')
  // Hermes's patch with its change already drawn: Hermes's wins.
  d = describeTool({ name: 'patch', input: { path: 'a.py' }, diff: '@@ -1 +1 @@\n-x = 1\n+x = 2\n+y = 3' })
  assert.deepEqual([d.add, d.del, d.box.lang], [2, 1, 'diff'])
  assert.equal(toolKind('browser_navigate'), 'fetch')
  assert.equal(toolKind('mcp__coop-anything__get_game'), 'other')
  assert.equal(prettyName('mcp__plugin_ReVa_ReVa__get-functions'), 'get functions (ReVa ReVa)')
  d = describeTool({ name: 'mcp__coop-anything__get_game', input: { name: 'Sekiro' } })
  assert.equal(d.title, 'Used get game (coop-anything)')
  assert.equal(d.box.lang, 'json')
  d = describeTool({ name: 'TodoWrite', input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'in_progress' }] } })
  assert.equal(d.box.text, '☑ Read\n◐ Fix')
  // Without input (old conversations): it doesn't crash.
  assert.equal(describeTool({ name: 'Bash', args: 'echo hello' }).title, 'Ran echo hello')
  assert.equal(describeTool({}).kind, 'other')
})

test('tools: summary of a group, like "Ran 2 commands, read badges.png, 1 failed"', async () => {
  const { groupSummary, failedText } = await import('../src/shell/tools.mjs')
  const g = groupSummary([
    { name: 'Bash', input: { command: 'a' }, done: true },
    { name: 'Bash', input: { command: 'b' }, done: true, error: true },
    { name: 'Read', input: { file_path: 'x/badges.png' }, done: true }
  ])
  assert.equal(g.text, 'Ran 2 commands, read badges.png')
  assert.equal(g.failed, 1)
  assert.equal(failedText(g.failed), '1 failed')
  assert.equal(failedText(2), '2 failed')
  const w = groupSummary([{ name: 'Write', input: { file_path: 'b.py', content: 'x\ny' }, done: true }, { name: 'Bash', input: { command: 'python b.py' }, done: true }])
  assert.equal(w.text, 'Ran a command, created b.py')
  assert.equal(w.add, 2)
  // A single one: its description; running and without a description, in the -ing form.
  assert.equal(groupSummary([{ name: 'Bash', input: { command: 'x', description: 'Start the test copy' }, done: false }]).text, 'Start the test copy')
  assert.equal(groupSummary([{ name: 'Read', input: { file_path: 'a/b.txt' }, done: false }]).text, 'Reading b.txt')
  assert.equal(groupSummary([{ name: 'Read', input: { file_path: 'a.txt' }, done: true }, { name: 'Read', input: { file_path: 'b.txt' }, done: true }]).text, 'Read 2 files')
  assert.equal(groupSummary([{ name: 'mcp__a__one', done: true }, { name: 'mcp__a__two', done: true }, { name: 'mcp__a__three', done: true }]).text, 'Used one (a), two (a) and 1 more')
  assert.equal(groupSummary([{ name: 'Bash', input: { command: 'a' }, done: false }, { name: 'Bash', input: { command: 'b' }, done: true }]).running, 1)
})

test('Hermes tools: readable result and failure as Hermes decides it', () => {
  let o = hermesToolOutput('terminal', JSON.stringify({ output: 'hola', exit_code: 0, error: null }), null)
  assert.deepEqual(o, { text: 'hola', error: false })
  o = hermesToolOutput('terminal', JSON.stringify({ output: '', exit_code: 2, error: "it doesn't exist" }), null)
  assert.equal(o.error, true)
  assert.match(o.text, /Error: it doesn't exist/)
  assert.match(o.text, /code 2/)
  assert.deepEqual(hermesToolOutput('read_file', JSON.stringify({ content: 'line 1' }), null), { text: 'line 1', error: false })
  assert.deepEqual(hermesToolOutput('write_file', JSON.stringify({ success: false, error: 'denegado' }), null), { text: 'denegado', error: true })
  // Hermes's own notice (is_error) wins.
  assert.equal(hermesToolOutput('web_search', 'texto', true).error, true)
  assert.equal(hermesToolOutput('web_search', 'plain text', null).text, 'plain text')
  // The console's colors (ANSI) are removed.
  assert.equal(hermesToolOutput('terminal', JSON.stringify({ output: '\u001b[31mrojo\u001b[0m', exit_code: 0 }), null).text, 'rojo')
  assert.ok(hermesToolOutput('x', 'a'.repeat(20000), null).text.endsWith('(cut short)'))
})

test('tools: what they were given, bounded; images and notes of the conversation', () => {
  const big = boundInput({ content: 'x'.repeat(10000), n: 3, list: Array.from({ length: 100 }, (_, i) => i), deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } })
  assert.ok(big.content.length < 6100)
  assert.equal(big.list.length, 60)
  assert.equal(big.n, 3)
  assert.equal(big.deep.a.b.c.d, '…')
  assert.deepEqual(contentImages([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'image_url', image_url: { url: 'https://fuera.com/x.png' } }]), [{ url: 'data:image/png;base64,AAAA', name: 'image' }])
  const t = normalizeTranscript([
    { id: 1, role: 'user', content: '[CONTEXT COMPACTION — REFERENCE ONLY] summary…' },
    { id: 2, role: 'user', content: 'process 12 finished', display_kind: 'process_complete' },
    { id: 3, role: 'user', content: 'hola' },
    { id: 4, role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'false' }) } }] },
    { id: 5, role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ output: '', exit_code: 1, error: 'failed' }) }
  ])
  assert.deepEqual(t.map(x => x.role + (x.kind ? ':' + x.kind : '')), ['note:compaction', 'note:process_complete', 'user', 'assistant'])
  const tool = t[3].blocks[0]
  assert.deepEqual(tool.input, { command: 'false' })
  assert.equal(tool.error, true)
  assert.match(tool.output, /Error: failed/)
})
