'use strict'
// The fixes of the 0.12 review that have to do with Hermes: compaction, Hermes failures, MCP/cut-short
// results and changes with context.
const test = require('node:test')
const assert = require('node:assert/strict')
const { hermesToolOutput, hermesFailed, splitCompaction, normalizeTranscript } = require('../src/main/connection')

test('hermes: failures as Hermes decides them', () => {
  assert.equal(hermesFailed('web_extract', '', { results: [{ url: 'a', error: null }], failed: 0 }), false)
  assert.equal(hermesFailed('search_files', '', { error: 'repetida', guardrail_refusal: true }), false)
  assert.equal(hermesFailed('delegate_task', '', { results: [{ error: 'interrumpido' }, { error: 'x' }] }), true)
  assert.equal(hermesFailed('delegate_task', '', { results: [{ error: 'interrumpido' }, { result: 'ok' }] }), false)
  assert.equal(hermesFailed('x', '', { status: 'failed' }), true)
  assert.equal(hermesFailed('write_file', '', { bytes_written: 10 }), false)
  assert.equal(hermesFailed('x', "Error: I couldn't", null), true)
  assert.equal(hermesFailed('x', 'all fine, "error": null', null), false)
  assert.equal(hermesFailed('x', 'something "failed": "yes"', null), true)
  assert.equal(hermesFailed('terminal', '', { exit_code: 0, error: 'warn' }), false)
})

test('hermes: MCP and cut-short results are read as text', () => {
  assert.equal(hermesToolOutput('mcp_x', JSON.stringify({ result: 'line 1\nline 2' }), null).text, 'line 1\nline 2')
  const inner = JSON.stringify({ output: 'hello\nworld '.repeat(3), exit_code: 0 })
  const cut = JSON.stringify({ output: inner.slice(0, 30), truncated: true })
  const o = hermesToolOutput('terminal', cut, false)
  assert.match(o.text, /^hello\nworld/)
  assert.match(o.text, /cut short by Hermes/)
})

test('hermes: when compacting, your message neither disappears nor fills up with the summary', () => {
  const END = '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
  assert.deepEqual(splitCompaction(`[CONTEXT COMPACTION — REFERENCE ONLY] summary\n${END}\nFix the build`), { summary: '[CONTEXT COMPACTION — REFERENCE ONLY] summary', message: 'Fix the build' })
  const prior = '[PRIOR CONTEXT — for reference only; not a new message]\nmy message\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n[CONTEXT COMPACTION] summary'
  assert.deepEqual(splitCompaction(prior), { summary: '[CONTEXT COMPACTION] summary', message: 'my message' })
  assert.equal(splitCompaction('hola'), null)
  const t = normalizeTranscript([
    { id: 1, role: 'user', content: `[CONTEXT COMPACTION — REFERENCE ONLY] summary\n${END}\nFix the build`, display_content: 'Fix the Android build' },
    { id: 2, role: 'user', content: '[OUT-OF-BAND USER MESSAGE — x] stop now [/OUT-OF-BAND USER MESSAGE]', display_content: 'stop now' }
  ])
  assert.deepEqual(t.map(x => `${x.role}:${x.role === 'note' ? x.kind : x.text}`), ['note:compaction', 'user:Fix the Android build', 'user:stop now'])
})

test('tools: an Edit counts only what changes', async () => {
  const { describeTool, diffStats } = await import('../src/shell/tools.mjs')
  const d = describeTool({ name: 'Edit', input: { file_path: 'a.js', old_string: 'l1\nl2\nl3\nl4', new_string: 'l1\nl2\nNEW\nl3\nl4' } })
  assert.deepEqual([d.add, d.del], [1, 0])
  assert.equal(d.box.text, '  l1\n  l2\n+ NEW\n  l3\n  l4')
  // In a Hermes diff, context starts with a space and doesn't count.
  assert.deepEqual(diffStats(' - no change\n-deleted\n+new\n +context'), { add: 1, del: 1 })
})
