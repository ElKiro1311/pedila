'use strict'
// «Modelos más usados»: de más a menos tokens (no por número de chats), con las estadísticas del
// propio Hermes cuando las tiene; y las versiones x.y.z-beta del actualizador.
const test = require('node:test')
const assert = require('node:assert/strict')

test('uso: los modelos van de más a menos tokens, no por número de chats', () => {
  const { usageStats } = require('../src/main/extras')
  const now = new Date(2026, 10, 16, 15, 0, 0).getTime()
  const rows = [
    { startedAt: now - 1e3, inputTokens: 100, outputTokens: 10, model: 'muchos-chats' },
    { startedAt: now - 2e3, inputTokens: 100, outputTokens: 10, model: 'muchos-chats' },
    { startedAt: now - 3e3, inputTokens: 100, outputTokens: 10, model: 'muchos-chats' },
    { startedAt: now - 4e3, inputTokens: 90000, outputTokens: 5000, model: 'un-chat-largo' },
    { startedAt: now - 5e3, inputTokens: 7, outputTokens: 0, model: '' },
    { startedAt: now - 6e3, inputTokens: 3, outputTokens: 0, model: 'unknown' }
  ]
  const u = usageStats(rows, now)
  assert.deepEqual(u.models, [
    { model: 'un-chat-largo', input: 90000, output: 5000, tasks: [] },
    { model: 'muchos-chats', input: 300, output: 30, tasks: [] },
    { model: 'desconocido', input: 10, output: 0, tasks: [] }
  ])
  // Empate de tokens: por nombre, para que el orden no baile entre recargas.
  const tie = usageStats([{ startedAt: now, inputTokens: 5, model: 'b' }, { startedAt: now, inputTokens: 5, model: 'a' }], now)
  assert.deepEqual(tie.models.map(m => m.model), ['a', 'b'])
  // Nombres que chocarían con Object: siguen siendo modelos y el resumen pasa por IPC (se clona).
  const odd = usageStats(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'].map((model, i) => ({ startedAt: now, inputTokens: 10 + i, model })), now)
  assert.deepEqual(odd.models.map(m => m.model), ['hasOwnProperty', 'valueOf', 'toString', '__proto__', 'constructor'])
  assert.deepEqual(structuredClone(odd).models, odd.models)
  assert.equal(Object.prototype.input, undefined)
})

test('uso: tokens por modelo de las estadísticas de Hermes (/api/analytics/usage)', () => {
  const { modelUsageFrom } = require('../src/main/extras')
  // Como lo devuelve Hermes 0.23: totales con lo auxiliar dentro y su desglose en aux_tasks.
  const j = {
    by_model: [
      {
        model: 'modelo-de-agente', input_tokens: 3000000, output_tokens: 1000000, sessions: 4,
        aux_tasks: [
          { task: 'compression', input_tokens: 1000000, output_tokens: 800000 },
          { task: 'approval', input_tokens: 50000, output_tokens: 300 },
          { task: 'title_generation', input_tokens: 2000, output_tokens: 80 }
        ]
      },
      {
        model: 'modelo-auxiliar', input_tokens: 420000, output_tokens: 480000, sessions: 0,
        aux_tasks: [
          { task: 'compression', input_tokens: 400000, output_tokens: 470000, billing_provider: 'a' },
          { task: 'compression', input_tokens: 20000, output_tokens: 10000, billing_provider: 'b' },
          { task: 'vacia', input_tokens: 0, output_tokens: 0 }
        ]
      },
      { model: 'modelo-de-chat', input_tokens: 940000, output_tokens: 40000, sessions: 11 },
      { model: 'unknown', input_tokens: 5, output_tokens: -3 },
      { model: null, input_tokens: 'x', output_tokens: 2 },
      null,
      'basura'
    ]
  }
  const m = modelUsageFrom(j)
  assert.deepEqual(m.map(x => [x.model, x.input + x.output]), [
    ['modelo-de-agente', 4000000],
    ['modelo-de-chat', 980000],
    ['modelo-auxiliar', 900000],
    ['desconocido', 7]
  ])
  assert.deepEqual(m[0].tasks, [
    { task: 'compression', tokens: 1800000 },
    { task: 'approval', tokens: 50300 },
    { task: 'title_generation', tokens: 2080 }
  ])
  // La misma tarea con dos proveedores se junta; la que no gastó nada no sale.
  assert.deepEqual(m[2].tasks, [{ task: 'compression', tokens: 900000 }])
  assert.deepEqual(m[1].tasks, [])
  // Sin lista (Hermes sin estadísticas o respuesta rara): null, y el panel usa la lista de chats.
  for (const bad of [null, undefined, {}, { by_model: 'no' }, 'texto', 42]) { assert.equal(modelUsageFrom(bad), null) }
  assert.deepEqual(modelUsageFrom({ by_model: [] }), [])
})

test('uso: las estadísticas por modelo: una consulta a la vez, 5 min, y sin esperar al refrescar', async () => {
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
    const c = new Connection({ id: 'local', name: 'Este PC', transport, log })
    c.state = 'ready'
    return { c, calls }
  }
  const t0 = 1_000_000_000
  const min = 60000

  // Vale: se guarda 5 min, y dos peticiones a la vez comparten la consulta. Pasados los 5 min se
  // devuelve lo guardado al momento y se pide otra por detrás.
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
  // Hermes sin estadísticas (404, o un 200 sin la lista): null durante 30 min.
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
  // Un fallo pasajero (500, red) no se guarda, y no se reintenta en 2 min.
  {
    const { c, calls } = make([{ status: 500, json: null }, new Error('red caída'), ok])
    assert.equal(await c.modelUsage(t0), null)
    assert.equal(await c.modelUsage(t0 + 1 * min), null)
    assert.equal(calls.length, 1)
    await assert.rejects(c.modelUsage(t0 + 3 * min), /red caída/)
    assert.equal(calls.length, 2)
    assert.equal(await c.modelUsage(t0 + 4 * min), null)
    assert.equal(calls.length, 2)
    assert.deepEqual(await c.modelUsage(t0 + 6 * min), want)
    assert.equal(calls.length, 3)
  }
  // Con un valor bueno, un refresco que falla no lo tira: se sigue enseñando el guardado.
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
  // Al perder la conexión se olvida todo (también la pausa): otro servidor u otra sesión.
  {
    const { c, calls } = make([{ status: 500, json: null }, ok])
    assert.equal(await c.modelUsage(t0), null)
    c.setState('connecting')
    c.state = 'ready'
    assert.deepEqual(await c.modelUsage(t0 + 1000), want)
    assert.equal(calls.length, 2)
  }
  // Si la conexión cae durante la consulta, la respuesta es de antes: se devuelve, pero no se guarda.
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

test('formatos: nombres de modelo, tareas auxiliares y tokens', async () => {
  const f = await import('../src/shell/fmt.mjs')
  assert.equal(f.tokensOf({ input: 1000, output: 90 }), 1090)
  assert.equal(f.tokensOf({ input: '5', output: null }), 5)
  assert.equal(f.tokensOf(null), 0)
  assert.equal(f.modelName('/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf'), 'Qwen3-VL-8B-Instruct-Q4_K_M')
  assert.equal(f.modelName('C:\\llm\\gemma-3-27b.GGUF'), 'gemma-3-27b')
  assert.equal(f.modelName('proveedor/modelo-v1.5-flash'), 'proveedor/modelo-v1.5-flash')
  assert.equal(f.modelName('qwen3-32b'), 'qwen3-32b')
  assert.equal(f.modelName(null), '')
  assert.equal(f.taskName('compression'), 'resumir la memoria')
  assert.equal(f.taskName('side_question'), 'preguntas al margen (/btw)')
  assert.equal(f.taskName('plugin_side_question:mi-plugin'), 'preguntas de plugins')
  assert.equal(f.taskName('other'), 'otras')
  assert.equal(f.taskName('algo_nuevo'), 'algo nuevo')
  assert.equal(f.taskName('toString'), 'toString')
  assert.equal(f.taskName(''), 'otras')
  assert.equal(f.tasksLine([
    { task: 'title_generation', tokens: 2450 },
    { task: 'compression', tokens: 1500000 },
    { task: 'voice_chat', tokens: 600 },
    { task: 'tts_audio_tags', tokens: 500 },
    { task: 'vision', tokens: 0 }
  ]), 'resumir la memoria 1.5M · poner títulos 2.45K · voz 1.1K')
  assert.equal(f.tasksLine(undefined), '')
  assert.equal(f.tasksLine([]), '')
})

test('actualizaciones: versiones x.y.z con -alfa / -beta', () => {
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
  // Sufijos campo a campo, los numéricos como números (SemVer §11).
  assert.equal(newer('0.8.0-beta.10', '0.8.0-beta.9'), true)
  assert.equal(newer('0.8.0-beta.9', '0.8.0-beta.10'), false)
  assert.equal(newer('0.8.0-beta.2', '0.8.0-beta'), true)
  assert.equal(newer('0.8.0-beta', '0.8.0-beta.2'), false)
  assert.equal(newer('0.8.0-10', '0.8.0-9'), true)
  assert.equal(newer('0.8.0-beta', '0.8.0-9'), true)
  assert.equal(newer('0.8.0-rc.1', '0.8.0-beta.11'), true)
  // Lo de tras «+» no cuenta.
  assert.equal(newer('0.8.0+build.5', '0.8.0'), false)
  assert.equal(newer('0.8.1+x', '0.8.0'), true)
  // Una errata en version.json sigue siendo esa beta: no se ofrece otra vez tras instalarla.
  for (const typo of ['0.8.0beta', '0.8.0.beta', '0.8.0 beta', '0.8.0_beta', '0.8.0–beta', ' 0.8.0-beta ']) {
    assert.equal(newer(typo, '0.8.0-beta'), false, typo)
  }
  // …pero una más nueva con errata sí se ofrece.
  assert.equal(newer('0.9.0beta', '0.8.0-beta'), true)
  assert.equal(newer('0.8.0 beta.2', '0.8.0-beta'), true)
  // Versiones raras: ni ofertas falsas ni excepciones.
  for (const odd of ['', 'abc', '-beta', '0', '0.7', '0.8.0-beta.']) { assert.equal(newer(odd, '0.8.0-beta'), false, odd) }
  assert.equal(newer('1.0', '0.8.0-beta'), true)
  assert.equal(newer('1.0.0.1', '1.0.0'), true)
})

test('uso: al cambiar la dirección del servidor se olvidan sus estadísticas por modelo', async () => {
  const { Connection } = require('../src/main/connection')
  const log = { info() {}, warn() {}, error() {} }
  const answers = [
    { status: 200, json: { by_model: [{ model: 'de-A', input_tokens: 5, output_tokens: 0 }] } },
    { status: 200, json: { by_model: [{ model: 'de-B', input_tokens: 7, output_tokens: 0 }] } }
  ]
  const c = new Connection({ id: 'server', name: 'Servidor', transport: { fetchJson: async () => answers.shift() }, log })
  c.state = 'ready'
  assert.deepEqual((await c.modelUsage(1000)).map(m => m.model), ['de-A'])
  // Con el socket abierto, la nueva dirección no pasa por setState: index.js llama a forgetModelStats().
  c.forgetModelStats()
  assert.deepEqual((await c.modelUsage(2000)).map(m => m.model), ['de-B'])
})
