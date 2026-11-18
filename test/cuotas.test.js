'use strict'
// Cuotas de las APIs de pago: lo que llega del complemento «pedila» de Hermes, limpio.
const test = require('node:test')
const assert = require('node:assert/strict')
const { quotaData, paidKindOf } = require('../src/main/connection')

test('cuotas: qué API de pago es cada dirección', () => {
  assert.equal(paidKindOf('https://openrouter.ai/api/v1'), 'openrouter')
  assert.equal(paidKindOf('https://api.venice.ai/api/v1'), 'venice')
  assert.equal(paidKindOf('https://opencode.ai/zen/go/v1'), 'opencode-go')
  assert.equal(paidKindOf('https://opencode.ai/zen/v1'), 'opencode-zen')
  assert.equal(paidKindOf('http://192.168.1.70:8181/v1'), null)
  assert.equal(paidKindOf('https://openrouter.ai.evil.example/v1'), null)
  assert.equal(paidKindOf(''), null)
})

test('cuotas: la respuesta real de OpenRouter y Venice (forma del 2026-11-18)', () => {
  const j = {
    plugin: 'pedila', version: '1.0.0', fetched_at: '2026-11-18T20:44:06.132979+00:00',
    providers: [
      { kind: 'openrouter', name: 'OpenRouter', ok: true, spent: null, credits_total: 10.0, credits_used: 0.093328298, balance: 9.906671702, free_tier: false, key_limit: null, key_usage: { total: 0.093328298, day: 0.0, week: 0.002798673, month: 0.004162603 } },
      { kind: 'venice', name: 'Venice', ok: true, spent: { day: { tokens: 0, calls: 0, cost: 0.0 }, week: { tokens: 9458288, calls: 1611, cost: 0.0 }, month: { tokens: 21435529, calls: 3147, cost: 0.0 } }, usd: 0.09906891, diem: 0.0, bundled: 58.68287063, tier: 'paid', charged: true, access: true, next_epoch: '2026-11-19T00:00:00+00:00', key_expires: null, model_limits: [{ model: 'deepseek-v4-1-flash-uncensored', rpm: 1000.0, tpm: 30000000.0 }] }
    ]
  }
  const d = quotaData(j)
  assert.equal(d.version, '1.0.0')
  assert.equal(d.providers.length, 2)
  const [or, ve] = d.providers
  assert.equal(or.balance, 9.906671702)
  assert.equal(or.keyLimit, null)
  assert.equal(or.keyUsage.week, 0.002798673)
  assert.equal(or.spent, null)
  assert.equal(ve.bundled, 58.68287063)
  assert.equal(ve.nextEpoch, '2026-11-19T00:00:00+00:00')
  assert.equal(ve.spent.week.tokens, 9458288)
  assert.deepEqual(ve.modelLimits, [{ model: 'deepseek-v4-1-flash-uncensored', rpm: 1000, rpd: null, tpm: 30000000 }])
})

test('cuotas: OpenCode Go, errores y basura', () => {
  const d = quotaData({
    plugin: 'pedila',
    providers: [
      { kind: 'opencode-go', ok: true, windows: [{ id: 'rolling', label: '5 h', percent: 140, resets_at: '2026-11-18T23:00:00Z' }, { id: 'weekly', percent: 'x' }] },
      { kind: 'venice', ok: false, error: 'la clave no vale' },
      { kind: 'otra-cosa', ok: true },
      null,
      { kind: 'openrouter', ok: true, balance: 'mucho', key_limit: { limit: 5, remaining: 2, reset: 'hourly' } }
    ]
  })
  assert.equal(d.providers.length, 3)
  assert.deepEqual(d.providers[0].windows, [{ id: 'rolling', label: '5 h', percent: 100, resetsAt: '2026-11-18T23:00:00Z' }])
  assert.equal(d.providers[1].ok, false)
  assert.equal(d.providers[1].error, 'la clave no vale')
  assert.equal(d.providers[2].balance, null)
  assert.deepEqual(d.providers[2].keyLimit, { limit: 5, remaining: 2, reset: null })
  assert.equal(quotaData({}).providers.length, 0)
})

test('cuotas: dinero y reinicios UTC', async () => {
  const f = await import('../src/shell/fmt.mjs')
  assert.equal(f.usd(9.9066), '$9.91')
  assert.equal(f.usd(0.0933), '$0.093')
  assert.equal(f.usd(0), '$0')
  assert.equal(f.usd(0.0004), '$<0.001')
  assert.equal(f.usd(null), '—')
  // Miércoles 18-11-2026 a las 20:00 UTC.
  const now = Date.UTC(2026, 10, 18, 20, 0)
  assert.equal(f.nextUtcReset('daily', now), Date.UTC(2026, 10, 19))
  assert.equal(f.nextUtcReset('weekly', now), Date.UTC(2026, 10, 23))
  assert.equal(f.nextUtcReset('monthly', now), Date.UTC(2026, 11, 1))
  // Un lunes a las 00:00 UTC en punto: el siguiente lunes, no el mismo instante.
  assert.equal(f.nextUtcReset('weekly', Date.UTC(2026, 10, 23)), Date.UTC(2026, 10, 30))
  assert.equal(f.nextUtcReset('nunca', now), null)
  // Días que vienen, en hora local.
  const base = new Date(2026, 10, 18, 15, 0).getTime()
  assert.equal(f.dayAhead(new Date(2026, 10, 18, 23, 0).getTime(), base), 'hoy')
  assert.equal(f.dayAhead(new Date(2026, 10, 19, 9, 0).getTime(), base), 'mañana')
  assert.equal(f.dayAhead(new Date(2026, 10, 22, 9, 0).getTime(), base), 'el domingo')
  assert.equal(f.dayAhead(new Date(2026, 11, 7, 9, 0).getTime(), base), 'el 7 dic')
})
