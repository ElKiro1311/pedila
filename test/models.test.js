'use strict'
// "Most used models": from most to fewest tokens (not by number of chats), with Hermes's own statistics
// when it has them; and the updater's x.y.z-beta versions.
const test = require('node:test')
const assert = require('node:assert/strict')

test('usage: models go from most to fewest tokens, not by number of chats', () => {
  const { usageStats } = require('../src/main/extras')
  const now = new Date(2026, 10, 16, 15, 0, 0).getTime()
  const rows = [
    { startedAt: now - 1e3, inputTokens: 100, outputTokens: 10, model: 'many-chats' },
    { startedAt: now - 2e3, inputTokens: 100, outputTokens: 10, model: 'many-chats' },
    { startedAt: now - 3e3, inputTokens: 100, outputTokens: 10, model: 'many-chats' },
    { startedAt: now - 4e3, inputTokens: 90000, outputTokens: 5000, model: 'one-long-chat' },
    { startedAt: now - 5e3, inputTokens: 7, outputTokens: 0, model: '' },
    { startedAt: now - 6e3, inputTokens: 3, outputTokens: 0, model: 'unknown' }
  ]
  const u = usageStats(rows, now)
  assert.deepEqual(u.models, [
    { model: 'one-long-chat', input: 90000, output: 5000, tasks: [] },
    { model: 'many-chats', input: 300, output: 30, tasks: [] },
    { model: 'unknown', input: 10, output: 0, tasks: [] }
  ])
  // A tie in tokens: by name, so that the order doesn't dance between reloads.
  const tie = usageStats([{ startedAt: now, inputTokens: 5, model: 'b' }, { startedAt: now, inputTokens: 5, model: 'a' }], now)
  assert.deepEqual(tie.models.map(m => m.model), ['a', 'b'])
  // Names that would clash with Object: they're still models and the summary goes through IPC (it's
  // cloned).
  const odd = usageStats(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'].map((model, i) => ({ startedAt: now, inputTokens: 10 + i, model })), now)
  assert.deepEqual(odd.models.map(m => m.model), ['hasOwnProperty', 'valueOf', 'toString', '__proto__', 'constructor'])
  assert.deepEqual(structuredClone(odd).models, odd.models)
  assert.equal(Object.prototype.input, undefined)
})

test("usage: tokens per model from Hermes's statistics (/api/analytics/usage)", () => {
  const { modelUsageFrom } = require('../src/main/extras')
  // As Hermes 0.23 returns it: totals with the auxiliary part inside and its breakdown in aux_tasks.
  const j = {
    by_model: [
      {
        model: 'agent-model', input_tokens: 3000000, output_tokens: 1000000, sessions: 4,
        aux_tasks: [
          { task: 'compression', input_tokens: 1000000, output_tokens: 800000 },
          { task: 'approval', input_tokens: 50000, output_tokens: 300 },
          { task: 'title_generation', input_tokens: 2000, output_tokens: 80 }
        ]
      },
      {
        model: 'auxiliary-model', input_tokens: 420000, output_tokens: 480000, sessions: 0,
        aux_tasks: [
          { task: 'compression', input_tokens: 400000, output_tokens: 470000, billing_provider: 'a' },
          { task: 'compression', input_tokens: 20000, output_tokens: 10000, billing_provider: 'b' },
          { task: 'vacia', input_tokens: 0, output_tokens: 0 }
        ]
      },
      { model: 'chat-model', input_tokens: 940000, output_tokens: 40000, sessions: 11 },
      { model: 'unknown', input_tokens: 5, output_tokens: -3 },
      { model: null, input_tokens: 'x', output_tokens: 2 },
      null,
      'basura'
    ]
  }
  const m = modelUsageFrom(j)
  assert.deepEqual(m.map(x => [x.model, x.input + x.output]), [
    ['agent-model', 4000000],
    ['chat-model', 980000],
    ['auxiliary-model', 900000],
    ['unknown', 7]
  ])
  assert.deepEqual(m[0].tasks, [
    { task: 'compression', tokens: 1800000 },
    { task: 'approval', tokens: 50300 },
    { task: 'title_generation', tokens: 2080 }
  ])
  // The same task with two providers is joined; the one that spent nothing doesn't show.
  assert.deepEqual(m[2].tasks, [{ task: 'compression', tokens: 900000 }])
  assert.deepEqual(m[1].tasks, [])
  // Without the list (a Hermes without statistics or an odd answer): null, and the panel uses the chat
  // list.
  for (const bad of [null, undefined, {}, { by_model: 'no' }, 'texto', 42]) { assert.equal(modelUsageFrom(bad), null) }
  assert.deepEqual(modelUsageFrom({ by_model: [] }), [])
})

test('usage: the statistics by model: one query at a time, 5 min, and no waiting on refresh', async () => {
  const { Connection } = require('../src/main/connection')
  const log = { info() {}, warn() {}, error() {} }
  const ok = { status: 200, json: { by_model: [{ model: 'a', input_tokens: 10, output_tokens: 1 }] } }
  const ok2 = { status: 200, json: { by_model: [{ model: 'b', input_tokens: 20, output_tokens: 2 }] } }
  const want = [{ model: 'a', input: 10, output: 1, tasks: [] }]
  const want2 = [{ model: 'b', input: 20, output: 2, tasks: [] }]
  const flush = () => new Promise(r => setImmediate(r))
  const make = answers => {
    const calls = []
    const transport = {
      fetchJson: async p => {
        calls.push(p)
        const a = answers.shift()
        if (a instanceof Error) { throw a }
        return a
      }
    }
    const c = new Connection({ id: 'local', name: 'This PC', transport, log })
    c.state = 'ready'
    return { c, calls }
  }
  const t0 = 1_000_000_000
  const min = 60000

  // Good: kept for 5 min, and two requests at once share the query. After 5 min what is stored is returned
  // right away and another one is asked for behind the scenes.
  {
    const { c, calls } = make([ok, ok2])
    const [a, b] = await Promise.all([c.modelUsage(t0), c.modelUsage(t0)])
    assert.equal(calls.length, 1)
    assert.equal(calls[0], '/api/analytics/usage?days=365')
    assert.deepEqual(a, want)
    assert.strictEqual(a, b)
    assert.strictEqual(await c.modelUsage(t0 + 4 * min), a)
    assert.equal(calls.length, 1)
    assert.strictEqual(await c.modelUsage(t0 + 6 * min), a)
    assert.equal(calls.length, 2)
    await flush()
    assert.deepEqual(await c.modelUsage(t0 + 6 * min + 1000), want2)
    assert.equal(calls.length, 2)
  }
  // A Hermes without statistics (404, or a 200 without the list): null for 30 min.
  {
    const { c, calls } = make([{ status: 404, json: null }, { status: 200, json: { otra: 'forma' } }, ok])
    assert.equal(await c.modelUsage(t0), null)
    assert.equal(await c.modelUsage(t0 + 20 * min), null)
    assert.equal(calls.length, 1)
    assert.equal(await c.modelUsage(t0 + 31 * min), null)
    assert.equal(calls.length, 2)
    assert.equal(await c.modelUsage(t0 + 50 * min), null)
    assert.equal(calls.length, 2)
    assert.deepEqual(await c.modelUsage(t0 + 62 * min), want)
    assert.equal(calls.length, 3)
  }
  // A passing failure (500, network) isn't stored, and isn't retried for 2 min.
  {
    const { c, calls } = make([{ status: 500, json: null }, new Error('network down'), ok])
    assert.equal(await c.modelUsage(t0), null)
    assert.equal(await c.modelUsage(t0 + 1 * min), null)
    assert.equal(calls.length, 1)
    await assert.rejects(c.modelUsage(t0 + 3 * min), /network down/)
    assert.equal(calls.length, 2)
    assert.equal(await c.modelUsage(t0 + 4 * min), null)
    assert.equal(calls.length, 2)
    assert.deepEqual(await c.modelUsage(t0 + 6 * min), want)
    assert.equal(calls.length, 3)
  }
  // With a good value, a refresh that fails doesn't throw it away: the stored one is still shown.
  {
    const { c, calls } = make([ok, { status: 503, json: null }, new Error('timeout'), ok2])
    const a = await c.modelUsage(t0)
    assert.strictEqual(await c.modelUsage(t0 + 6 * min), a)
    await flush()
    assert.strictEqual(await c.modelUsage(t0 + 7 * min), a)
    assert.equal(calls.length, 2)
    assert.strictEqual(await c.modelUsage(t0 + 9 * min), a)
    await flush()
    assert.equal(calls.length, 3)
    assert.strictEqual(await c.modelUsage(t0 + 10 * min), a)
    assert.equal(calls.length, 3)
    assert.strictEqual(await c.modelUsage(t0 + 12 * min), a)
    await flush()
    assert.deepEqual(await c.modelUsage(t0 + 12 * min + 1000), want2)
    assert.equal(calls.length, 4)
  }
  // When the connection is lost everything is forgotten (the pause too): another server or another
  // session.
  {
    const { c, calls } = make([{ status: 500, json: null }, ok])
    assert.equal(await c.modelUsage(t0), null)
    c.setState('connecting')
    c.state = 'ready'
    assert.deepEqual(await c.modelUsage(t0 + 1000), want)
    assert.equal(calls.length, 2)
  }
  // If the connection drops during the query, the answer is from before: it's returned, but not stored.
  {
    const { c, calls } = make([])
    let release
    c.transport.fetchJson = async p => {
      calls.push(p)
      await new Promise(r => { release = r })
      return ok
    }
    const slow = c.modelUsage(t0)
    await new Promise(r => setImmediate(r))
    c.setState('connecting')
    release()
    assert.deepEqual(await slow, want)
    assert.equal(c.modelStats, null)
    c.state = 'ready'
    c.transport.fetchJson = async p => { calls.push(p); return ok }
    await c.modelUsage(t0 + 1000)
    assert.equal(calls.length, 2)
  }
})

test('formats: model names, auxiliary tasks and tokens', async () => {
  const f = await import('../src/shell/fmt.mjs')
  assert.equal(f.tokensOf({ input: 1000, output: 90 }), 1090)
  assert.equal(f.tokensOf({ input: '5', output: null }), 5)
  assert.equal(f.tokensOf(null), 0)
  assert.equal(f.modelName('/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf'), 'Qwen3-VL-8B-Instruct-Q4_K_M')
  assert.equal(f.modelName('C:\\llm\\gemma-3-27b.GGUF'), 'gemma-3-27b')
  assert.equal(f.modelName('proveedor/modelo-v1.5-flash'), 'proveedor/modelo-v1.5-flash')
  assert.equal(f.modelName('qwen3-32b'), 'qwen3-32b')
  assert.equal(f.modelName(null), '')
  assert.equal(f.taskName('compression'), 'summarizing memory')
  assert.equal(f.taskName('side_question'), 'side questions (/btw)')
  assert.equal(f.taskName('plugin_side_question:mi-plugin'), 'plugin questions')
  assert.equal(f.taskName('other'), 'other')
  assert.equal(f.taskName('something_new'), 'something new')
  assert.equal(f.taskName('toString'), 'toString')
  assert.equal(f.taskName(''), 'other')
  assert.equal(f.tasksLine([
    { task: 'title_generation', tokens: 2450 },
    { task: 'compression', tokens: 1500000 },
    { task: 'voice_chat', tokens: 600 },
    { task: 'tts_audio_tags', tokens: 500 },
    { task: 'vision', tokens: 0 }
  ]), 'summarizing memory 1.5M · writing titles 2.45K · voice 1.1K')
  assert.equal(f.tasksLine(undefined), '')
  assert.equal(f.tasksLine([]), '')
})

test('updates: x.y.z versions with -alfa / -beta', () => {
  const { newer } = require('../src/main/extras')
  assert.equal(newer('0.8.0-beta', '0.7.0'), true)
  assert.equal(newer('0.7.0', '0.8.0-beta'), false)
  assert.equal(newer('0.8.0-beta', '0.8.0-beta'), false)
  assert.equal(newer('0.8.0', '0.8.0-beta'), true)
  assert.equal(newer('0.8.0-beta', '0.8.0'), false)
  assert.equal(newer('0.8.0-beta', '0.8.0-alfa'), true)
  assert.equal(newer('0.8.1-alfa', '0.8.0'), true)
  assert.equal(newer('0.10.0-beta', '0.9.3'), true)
  assert.equal(newer('v0.7.1', '0.7.0'), true)
  assert.equal(newer('0.7.0', '0.7.0'), false)
  // Suffixes field by field, the numeric ones as numbers (SemVer §11).
  assert.equal(newer('0.8.0-beta.10', '0.8.0-beta.9'), true)
  assert.equal(newer('0.8.0-beta.9', '0.8.0-beta.10'), false)
  assert.equal(newer('0.8.0-beta.2', '0.8.0-beta'), true)
  assert.equal(newer('0.8.0-beta', '0.8.0-beta.2'), false)
  assert.equal(newer('0.8.0-10', '0.8.0-9'), true)
  assert.equal(newer('0.8.0-beta', '0.8.0-9'), true)
  assert.equal(newer('0.8.0-rc.1', '0.8.0-beta.11'), true)
  // What comes after "+" doesn't count.
  assert.equal(newer('0.8.0+build.5', '0.8.0'), false)
  assert.equal(newer('0.8.1+x', '0.8.0'), true)
  // A typo in version.json is still that beta: it isn't offered again after installing it.
  for (const typo of ['0.8.0beta', '0.8.0.beta', '0.8.0 beta', '0.8.0_beta', '0.8.0–beta', ' 0.8.0-beta ']) {
    assert.equal(newer(typo, '0.8.0-beta'), false, typo)
  }
  // …but a newer one with a typo is offered.
  assert.equal(newer('0.9.0beta', '0.8.0-beta'), true)
  assert.equal(newer('0.8.0 beta.2', '0.8.0-beta'), true)
  // Odd versions: no false offers and no exceptions.
  for (const odd of ['', 'abc', '-beta', '0', '0.7', '0.8.0-beta.']) { assert.equal(newer(odd, '0.8.0-beta'), false, odd) }
  assert.equal(newer('1.0', '0.8.0-beta'), true)
  assert.equal(newer('1.0.0.1', '1.0.0'), true)
})

test("usage: changing the server's address forgets its statistics by model", async () => {
  const { Connection } = require('../src/main/connection')
  const log = { info() {}, warn() {}, error() {} }
  const answers = [
    { status: 200, json: { by_model: [{ model: 'from-A', input_tokens: 5, output_tokens: 0 }] } },
    { status: 200, json: { by_model: [{ model: 'from-B', input_tokens: 7, output_tokens: 0 }] } }
  ]
  const c = new Connection({ id: 'server', name: 'Server', transport: { fetchJson: async () => answers.shift() }, log })
  c.state = 'ready'
  assert.deepEqual((await c.modelUsage(1000)).map(m => m.model), ['from-A'])
  // With the socket open, the new address doesn't go through setState: index.js calls forgetModelStats().
  c.forgetModelStats()
  assert.deepEqual((await c.modelUsage(2000)).map(m => m.model), ['from-B'])
})
