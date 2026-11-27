'use strict'
// Quotas of the paid APIs: what comes from Hermes's "pedila" plugin, cleaned up.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { quotaData, quotaPluginOutdated, QUOTA_PLUGIN_WANT, paidKindOf, paidKindOfProvider, Connection } = require('../src/main/connection')
const { newer } = require('../src/main/extras')

test('quotas: which paid API each address is', () => {
  assert.equal(paidKindOf('https://openrouter.ai/api/v1'), 'openrouter')
  assert.equal(paidKindOf('https://api.venice.ai/api/v1'), 'venice')
  assert.equal(paidKindOf('https://opencode.ai/zen/go/v1'), 'opencode-go')
  assert.equal(paidKindOf('https://opencode.ai/zen/v1'), 'opencode-zen')
  assert.equal(paidKindOf('http://192.168.1.50:8181/v1'), null)
  assert.equal(paidKindOf('https://openrouter.ai.evil.example/v1'), null)
  assert.equal(paidKindOf('https://api.deepseek.com/v1'), 'deepseek')
  assert.equal(paidKindOf('https://api.deepseek.com/anthropic'), 'deepseek')
  assert.equal(paidKindOf('https://api.openference.com/v1'), 'openference')
  assert.equal(paidKindOf('https://api.deepseek.com.evil.example/v1'), null)
  assert.equal(paidKindOf('https://notapi.openference.com.example/v1'), null)
  assert.equal(paidKindOf('https://api.orcarouter.ai/v1'), 'orcarouter')
  assert.equal(paidKindOf('https://api.orcarouter.ai.evil.example/v1'), null)
  assert.equal(paidKindOf('https://notorcarouter.ai/v1'), null)
  assert.equal(paidKindOf(''), null)
})

test('quotas: the real answer of OpenRouter and Venice (its shape on 2026-11-18)', () => {
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

test("quotas: OrcaRouter's answer, the same as OpenRouter's (plugin 1.7.0)", () => {
  const d = quotaData({ plugin: 'pedila', version: '1.7.0', providers: [
    { kind: 'orcarouter', name: 'OrcaRouter', ok: true, credits_total: 0, credits_used: 0, balance: 0, free_tier: true, key_limit: { limit: 3, remaining: 1, reset: 'weekly' }, key_usage: { total: 0, day: 0, week: 0, month: 0 } },
    { kind: 'orcarouter', name: 'OrcaRouter', ok: false, error: "the key isn't valid or isn't allowed to see this" }
  ] })
  assert.equal(d.providers.length, 2)
  const [o, bad] = d.providers
  assert.deepEqual([o.kind, o.balance, o.freeTier, o.keyUsage.week], ['orcarouter', 0, true, 0])
  assert.deepEqual(o.keyLimit, { limit: 3, remaining: 1, reset: 'weekly' })
  assert.equal(bad.ok, false)
  assert.equal(QUOTA_PLUGIN_WANT, '1.7.0')
  assert.equal(quotaPluginOutdated('1.6.0'), true)
  assert.equal(quotaPluginOutdated('1.7.0'), false)
})

test("quotas: Hermes's own providers, which come without an address", () => {
  assert.equal(paidKindOfProvider({ slug: 'deepseek', is_user_defined: false }), 'deepseek')
  assert.equal(paidKindOfProvider({ slug: 'OpenRouter' }), 'openrouter')
  assert.equal(paidKindOfProvider({ slug: 'deepseek', authenticated: false }), null)
  assert.equal(paidKindOfProvider({ slug: 'deepseek', is_user_defined: true }), null)
  assert.equal(paidKindOfProvider({ slug: 'deepseek', api_url: 'https://proxy.example/v1' }), null)
  assert.equal(paidKindOfProvider({ slug: 'mine', api_url: 'https://api.openference.com/v1' }), 'openference')
  assert.equal(paidKindOfProvider({ slug: 'orcarouter', is_user_defined: true, api_url: 'https://api.orcarouter.ai/v1' }), 'orcarouter')
  assert.equal(paidKindOfProvider({ slug: 'orcarouter' }), null) // not one of Hermes's own: only by its address
  assert.equal(paidKindOfProvider({ slug: 'tower' }), null)
  assert.equal(paidKindOfProvider({}), null)
})

test('quotas: the models used with each API (plugin 1.4.0)', () => {
  const day = { tokens: 12, calls: 2, cost: 0.5, cache: 100, others: { models: 2, tokens: 7 }, models: [{ model: 'A', tokens: 9, input: 6, output: 3, cache: 90, calls: 1, cost: 0.5 }, { model: '', tokens: 1 }, null, 'x', { model: 'B', tokens: -3, input: 'x' }] }
  const many = { models: Array.from({ length: 30 }, (_, i) => ({ model: 'm' + i, tokens: 1 })), others: 'x' }
  const of = spent => quotaData({ plugin: 'pedila', version: '1.4.0', providers: [{ kind: 'deepseek', ok: true, balances: [], spent }] }).providers[0].spent
  const s = of({ day, week: many, month: {} })
  assert.deepEqual(s.day, { tokens: 12, calls: 2, cost: 0.5, cache: 100, others: { models: 2, tokens: 7 }, models: [
    { model: 'A', tokens: 9, input: 6, output: 3, cache: 90, calls: 1, cost: 0.5 }, { model: 'B', tokens: 0, input: 0, output: 0, cache: 0, calls: 0, cost: 0 }] })
  assert.deepEqual([s.week.models.length, s.week.others], [12, null])
  const rest = quotaData({ plugin: 'pedila', version: '1.5.0', providers: [{ kind: 'opencode-go', ok: true, windows: [], spent: null, spent_rest: { day, week: many, month: many } }] }).providers[0]
  assert.deepEqual([rest.spent, rest.spentRest.day.tokens, rest.spentRest.month.models.length], [null, 12, 12])
  // An earlier plugin doesn't tell the models apart.
  assert.deepEqual(s.month, { tokens: 0, calls: 0, cost: 0, cache: 0, models: null, others: null })
  assert.equal(of(null), null)
  assert.equal(of({ day: 3 }).day.models, null)
})

test('quotas: the AI on your own network (plugin 1.6.0)', () => {
  const day = { tokens: 12, calls: 2, cost: 0, cache: 100, others: null, models: [{ model: 'qwen', tokens: 12, input: 8, output: 4, cache: 100, calls: 2, cost: 0 }] }
  const none = { tokens: 0, calls: 0, cost: 0, cache: 0, others: null, models: [] }
  const of = local => quotaData({ plugin: 'pedila', version: '1.6.0', providers: [], local }).local
  const [x, ...rest] = of([{ name: ' Homelab ', spent: { day: none, week: day, month: day } }, { name: '', spent: { day, week: day, month: day } }, { name: 'Unused', spent: { day: none, week: none, month: none } }, { name: 'Odd', spent: 3 }, null, 'x', { name: 7, spent: { day, week: day, month: day } }])
  assert.deepEqual(rest, [])
  assert.deepEqual([x.name, x.spent.week.tokens, x.spent.week.models[0].model, x.spent.day.models], ['Homelab', 12, 'qwen', []])
  assert.equal(of(Array.from({ length: 9 }, (_, i) => ({ name: 'p' + i, spent: { day, week: day, month: day } }))).length, 6)
  assert.equal(of([{ name: 'n'.repeat(90), spent: { day, week: day, month: day } }])[0].name.length, 40)
  assert.deepEqual(of([{ name: 'Half', spent: { month: day } }, { name: 'Half', spent: { day, month: day } }, { name: 'Half', spent: { week: day, month: day } }]), []) // it can't be painted
  // Nothing used = an empty list; null = an earlier plugin, or it couldn't read Hermes's records.
  assert.deepEqual([of([]), of(null), of(undefined), of('x'), of({})], [[], null, null, null, null])
})

test('quotas: what the local AI card shows', async () => {
  const { localUse } = await import('../src/shell/quotas.mjs')
  const isFile = m => m.endsWith('.gguf')
  const u = { models: [{ model: 'qwen', input: 5, output: 5 }, { model: 'cloudy', input: 900, output: 0 }, { model: '/m/x.gguf', input: 1, output: 0 }, { model: 'gemma', input: 0, output: 0 }] }
  const blocks = [{ name: 'Homelab', spent: {} }]
  // The plugin says it; with nothing used, there's no card (whatever the statistics say).
  assert.deepEqual(localUse({ state: 'ok', data: { local: blocks }, localModels: [{ name: 'Homelab', models: ['qwen'] }] }, u, isFile), { blocks })
  assert.equal(localUse({ state: 'ok', data: { local: [] }, localModels: [{ name: 'Homelab', models: ['qwen'] }] }, u, isFile), null)
  // Without the plugin or with an earlier one: the models of your providers (and the ones named after a file).
  const mine = [{ name: 'Homelab', models: ['qwen', 'gemma'] }]
  const names = r => r && [r.name, r.models.map(m => m.model)]
  assert.deepEqual(names(localUse({ state: 'missing', localModels: mine }, u, isFile)), ['Homelab', ['qwen', '/m/x.gguf']])
  assert.deepEqual(names(localUse({ state: 'ok', data: { local: null }, localModels: [...mine, { name: 'Ollama', models: ['cloudy'] }] }, u, isFile)), ['', ['qwen', 'cloudy', '/m/x.gguf']])
  assert.deepEqual(names(localUse({ state: 'missing', localModels: [] }, u, isFile)), ['', ['/m/x.gguf']])
  assert.equal(localUse({ state: 'missing', localModels: [] }, u), null)
  assert.deepEqual(names(localUse({ state: 'missing', localModels: [{ name: 'Ollama', models: ['gpt-oss:120b-cloud', 'llama3.2:3b', 'x:cloud'] }] }, { models: [{ model: 'gpt-oss:120b-cloud', input: 9, output: 0 }, { model: 'x:Cloud', input: 9, output: 0 }, { model: 'llama3.2:3b', input: 1, output: 0 }] }, () => true)), ['Ollama', ['llama3.2:3b']])
  // It isn't known yet: the quotas haven't been read (or that couldn't be), or the providers couldn't be asked.
  assert.deepEqual([localUse(null, u, isFile), localUse(undefined, u, isFile), localUse({ state: 'missing' }, u, isFile), localUse({ state: 'missing', localModels: null }, u, isFile), localUse({ state: 'missing', localModels: mine }, { models: 'x' }, isFile), localUse({ state: 'missing', localModels: mine }, null, isFile)], [null, null, null, null, null, null])
})

test("quotas: the simple view's figure (how much of the total has been used)", async () => {
  const { quotaTotal, usedOf } = await import('../src/shell/quotas.mjs')
  const now = Date.parse('2026-11-25T12:00:00Z')
  const win = (id, percent, more) => ({ id, percent, resetsAt: '2026-11-25T14:00:00Z', estimate: null, ...more })
  const at = Date.parse('2026-11-25T14:00:00Z')
  const seen = {}
  const peak = { bundled: 60, usd: 40, diem: 10, cny: 50 }
  let ranOut = now - 10 * 86400e3
  const observe = (name, value, epoch) => { seen[name] = [value, epoch]; const max = Math.max(value, peak[name] || 0); return { max, spent: max - value, pct: max > 0 ? (max - value) / max * 100 : 0, out: value > max * 0.02 ? 0 : ranOut } }
  const of = p => quotaTotal({ ok: true, ...p }, observe, now)
  const full = p => { const t = of(p); return [t.pct, t.text, t.warn, t.tight] }

  // OpenRouter: the credits; the key's limit only if there are none, or if it's about to run out before.
  const or = (more, limit) => ({ kind: 'openrouter', balance: 7.5, creditsTotal: 10, creditsUsed: 2.5, keyLimit: limit ? { limit: 5, remaining: limit[0], reset: limit[1] } : null, ...more })
  assert.deepEqual(full(or()), [25, '$7.50 left', false, null])
  assert.deepEqual(full(or({}, [4, 'daily'])), [25, '$7.50 left', false, null])
  assert.deepEqual(of(or({}, [0.5, 'daily'])).tight, { id: 'key', hours: null, pct: 90, at: Date.UTC(2026, 10, 26) })
  assert.deepEqual(of(or({}, [0, null])).tight, { id: 'key', hours: null, pct: 100, at: null })
  assert.equal(of(or({ creditsUsed: 9.9 }, [0.5, 'daily'])).tight, null) // the credits are nearer to their end
  assert.equal(of(or({}, [2, 'daily'])).tight, null) // 60%: not nearly spent yet
  assert.deepEqual(full(or({ creditsTotal: 0, creditsUsed: 0 }, [null, 'daily'])).slice(0, 2), [null, '$7.50 left']) // what's left of the limit isn't known
  assert.deepEqual(full(or({ creditsTotal: 0, creditsUsed: 0, balance: 0 }, [4, 'weekly'])), [20, 'no balance', false, null])
  assert.deepEqual(full(or({ creditsTotal: 0, creditsUsed: 0.31, balance: -0.31 })), [null, 'no balance', false, null])
  assert.deepEqual(full(or({ creditsTotal: null, creditsUsed: null, balance: null })), [null, '—', false, null])
  assert.equal(of(or({ creditsUsed: 12 })).pct, 100) // spent more than what was bought
  // OrcaRouter: the same as OpenRouter.
  assert.deepEqual(full(or({ kind: 'orcarouter' })), [25, '$7.50 left', false, null])
  assert.deepEqual(full(or({ kind: 'orcarouter', creditsTotal: 0, creditsUsed: 0, balance: 0 })), [null, 'no balance', false, null])

  // Venice: its two balances together, against the highest Pedila has seen; with neither, the day's DIEM.
  const ve = more => full({ kind: 'venice', usd: null, bundled: null, diem: null, nextEpoch: 'x', access: true, ...more })
  assert.deepEqual(ve({ usd: 30, bundled: 45, diem: 6 }), [25, '$75.00 left', false, null])
  assert.deepEqual(seen.diem, [6, 'x'])
  assert.deepEqual(ve({ diem: 6 }), [40, 'no balance', false, null])
  // What ran out in the last month is part of what has been used; with odd cents left, it's as good as spent…
  const t1 = x => Math.floor(x * 10) / 10
  assert.equal(t1(ve({ usd: 0, bundled: 45 })[0]), 55)
  assert.equal(t1(ve({ usd: 40, bundled: 0 })[0]), 60)
  assert.deepEqual([t1(ve({ usd: 0.099, bundled: 0, diem: 0, access: false })[0]), ...ve({ usd: 0.099, bundled: 0, diem: 0, access: false }).slice(1)], [99.9, '$0.099 left', true, null])
  // …and what ran out before that doesn't weigh on what's left.
  ranOut = now - 31 * 86400e3
  assert.equal(ve({ usd: 0, bundled: 45 })[0], 25)
  assert.equal(ve({ usd: 40, bundled: 0 })[0], 0)
  assert.equal(ve({ usd: 0, bundled: 0, diem: 0 })[0], 100)
  assert.equal(ve({ usd: 0, bundled: 0 })[0], 100)
  // Odd cents are as good as nothing here too, unless Venice doesn't let you use anything: then it's all spent.
  assert.equal(ve({ usd: 0.3, bundled: 45 })[0], 25)
  assert.equal(t1(ve({ usd: 0.3, bundled: 45, access: false })[0]), 54.7)
  assert.equal(t1(ve({ usd: 0.099, bundled: 0, access: false })[0]), 99.9)
  ranOut = 0 // not known since when
  assert.equal(ve({ usd: 0, bundled: 45 })[0], 25)
  ranOut = now - 10 * 86400e3
  // With nothing but odd cents, what it works with is the day's DIEM.
  assert.equal(ve({ usd: 0, bundled: 0, diem: 8 })[0], 20)
  assert.equal(ve({ usd: 0.099, bundled: 0, diem: 6 })[0], 40)
  assert.equal(t1(ve({ usd: 5, bundled: 0, diem: 6 })[0]), 95)
  assert.equal(ve({ usd: 0, bundled: 0, diem: 0 })[0], 100)
  assert.equal(ve({ usd: -0.5 })[0], 100)
  assert.equal(ve({ usd: -0.5, diem: 8 })[0], 20)
  assert.equal(ve({ diem: 0 })[0], 100)
  assert.deepEqual(ve({}), [null, 'no balance', false, null])
  assert.deepEqual(full({ kind: 'venice', usd: 0, bundled: null, diem: null, access: false }).slice(2), [true, null])
  assert.deepEqual([null, undefined].map(access => of({ kind: 'venice', usd: 1, bundled: null, diem: null, access }).warn), [false, false]) // not known isn't "no"

  // A plan's windows: the longest is the total; a shorter one nearly spent is told apart.
  const go = (...windows) => ({ kind: 'opencode-go', windows })
  assert.deepEqual(full(go(win('rolling', 20), win('weekly', 79), win('monthly', 46))), [46, '—', false, null])
  assert.deepEqual(of(go(win('rolling', 100), win('weekly', 85), win('monthly', 46))).tight, { id: 'rolling', hours: null, pct: 100, at })
  assert.equal(of(go(win('rolling', 85), win('monthly', 90))).tight, null)
  assert.equal(of(go(win('rolling', 3), win('weekly', 12))).pct, 12)
  assert.equal(of(go(win('monthly', 0, { estimate: 0.5691 }), win('rolling', 2))).pct, 0.5) // the decimal, cut off
  assert.deepEqual(full(go()), [null, '—', false, null])
  assert.equal(usedOf(win('weekly', 12.9)), 12)

  // Openference: its plan's windows or, without a plan, its credits.
  const ofc = more => ({ kind: 'openference', balance: 3, creditsTotal: 10, active: true, windows: [], ...more })
  assert.deepEqual(full(ofc()), [70, '$3.00 left', false, null])
  assert.deepEqual(full(ofc({ windows: [win('rolling', 84, { hours: 6, resetsAt: null }), win('weekly', 12), win('weekly-tokens', 33)] })), [33, '—', false, { id: 'rolling', hours: 6, pct: 84, at: null }])
  assert.deepEqual(full(ofc({ balance: 0, creditsTotal: 0 })), [null, 'no balance', false, null])
  assert.deepEqual(full(ofc({ balance: 12, creditsTotal: 10 })), [0, '$12.00 left', false, null])
  assert.deepEqual(full(ofc({ balance: null, active: false })), [null, '—', true, null])

  // DeepSeek: a balance without its total; with two currencies, the one with the most left.
  const ds = (balances, available = true) => ({ kind: 'deepseek', balances: balances.map(([currency, total]) => ({ currency, total })), available })
  assert.deepEqual(full(ds([['USD', 30]])), [25, '$30.00 left', false, null])
  assert.deepEqual(full(ds([['CNY', 0], ['USD', 40]])), [0, '$40.00 left', false, null]) // what was in yuan ran out
  assert.deepEqual(full(ds([['USD', 10], ['CNY', 40]])), [75, '$10.00 + ¥40.00 left', false, null]) // 40 yuan are less than 10 dollars
  assert.deepEqual(full(ds([['USD', 5], ['CNY', 45]])), [10, '$5.00 + ¥45.00 left', false, null])
  assert.deepEqual(full(ds([['CNY', 0], ['USD', 0]], false)), [100, 'no balance', true, null])
  assert.deepEqual(full(ds([['', 0]], false)), [null, 'no balance', true, null])
  assert.deepEqual(full(ds([])), [null, '—', false, null])
  assert.equal(of(ds([['USD', 4.2]], null)).warn, false)

  // With no total at all, what there is says by itself that it's what's left.
  assert.deepEqual([quotaTotal({ ok: true, ...or({ creditsTotal: null, creditsUsed: null }) }).text, quotaTotal({ ok: true, ...ds([['CNY', 3], ['USD', 0]]) }).text], ['$7.50 left', '¥3.00 left'])
  // What has no API for its balance, and what couldn't be read.
  assert.deepEqual(full({ kind: 'opencode-zen', noApi: true }), [null, '—', false, null])
  assert.deepEqual(full({ kind: 'venice', ok: false, error: 'x' }), [null, 'error', true, null])
})

test("quotas: the highest balance seen, for the ones that come without their total", async () => {
  const { nextPeak } = await import('../src/shell/quotas.mjs')
  let r = nextPeak(undefined, 60, '', 1)
  assert.deepEqual(r, { max: 60, since: 1, epoch: '', last: 60 })
  assert.equal(nextPeak(r, 60, '', 2), r) // nothing changes: nothing to store
  r = nextPeak(r, 12, '', 3)
  assert.deepEqual(r, { max: 60, since: 1, epoch: '', last: 12 })
  // A correction of some cents isn't a top-up; a top-up is, even one smaller than the one before.
  r = nextPeak(r, 12.04, '', 4)
  assert.deepEqual(r, { max: 60, since: 1, epoch: '', last: 12.04 })
  assert.deepEqual(nextPeak(r, 13, '', 5), { max: 60, since: 1, epoch: '', last: 13 })
  assert.deepEqual(nextPeak(r, 14, '', 5), { max: 14, since: 5, epoch: '', last: 14 })
  assert.deepEqual(nextPeak({ max: 0, since: 1, epoch: '', last: 0 }, 0.5, '', 6), { max: 0.5, since: 6, epoch: '', last: 0.5 })
  assert.deepEqual(nextPeak(nextPeak(r, 0, '', 6), 10, '', 7), { max: 10, since: 7, epoch: '', last: 10 })
  // Above the highest one, and in another day, it starts over too.
  assert.deepEqual(nextPeak(r, 60.5, '', 8), { max: 60.5, since: 8, epoch: '', last: 60.5 })
  assert.deepEqual(nextPeak({ max: 60, since: 1, epoch: '', last: 60 }, 60.5, '', 8), { max: 60.5, since: 8, epoch: '', last: 60.5 })
  assert.deepEqual(nextPeak({ max: 1, since: 1, epoch: '', last: 0.5 }, 0.54, '', 8), { max: 1, since: 1, epoch: '', last: 0.54 }) // four cents
  assert.deepEqual(nextPeak({ max: 10, since: 1, epoch: 'a', last: 2 }, 1.9, 'b', 9), { max: 1.9, since: 9, epoch: 'b', last: 1.9 })
  assert.deepEqual(nextPeak({ max: 10, since: 1, epoch: 'a', last: 2 }, 1.9, 'a', 9), { max: 10, since: 1, epoch: 'a', last: 1.9 })
  // What earlier versions stored has no `last`: what's below its highest one isn't a top-up.
  assert.deepEqual(nextPeak({ max: 58.7, since: 1, epoch: '' }, 4, '', 9), { max: 58.7, since: 1, epoch: '', last: 4 })
  assert.deepEqual(nextPeak({}, 5, '', 9), { max: 5, since: 9, epoch: '', last: 5 }) // garbage
  // When it ran out: the first time it's seen at zero (or below, or at odd cents), until there's something again.
  r = nextPeak({ max: 60, since: 1, epoch: '', last: 3 }, 0, '', 10)
  assert.deepEqual(r, { max: 60, since: 1, epoch: '', last: 0, out: 10 })
  assert.equal(nextPeak(r, 0, '', 11), r)
  assert.deepEqual(nextPeak(r, -0.2, '', 12), { max: 60, since: 1, epoch: '', last: -0.2, out: 10 })
  assert.deepEqual(nextPeak(r, 0.03, '', 12), { max: 60, since: 1, epoch: '', last: 0.03, out: 10 })
  assert.deepEqual(nextPeak(r, 20, '', 12), { max: 20, since: 12, epoch: '', last: 20 })
  assert.deepEqual(nextPeak({ max: 60, since: 1, epoch: '' }, 0, '', 13), { max: 60, since: 1, epoch: '', last: 0, out: 13 })
  assert.deepEqual(nextPeak({ max: 60, since: 1, epoch: '', last: 3 }, 0.9, '', 13), { max: 60, since: 1, epoch: '', last: 0.9, out: 13 })
  assert.deepEqual(nextPeak({ max: 60, since: 1, epoch: '', last: 0.9, out: 13 }, 2, '', 14), { max: 60, since: 1, epoch: '', last: 2 })
  // A debt that is forgiven isn't a top-up.
  assert.deepEqual(nextPeak({ max: 5, since: 1, epoch: '', last: -0.3, out: 2 }, 0, '', 14), { max: 5, since: 1, epoch: '', last: 0, out: 2 })
})

test('quotas: percentages in few characters, and money', async () => {
  const { pctShort, money } = await import('../src/shell/fmt.mjs')
  assert.deepEqual([0, 0.04, 0.5691, 0.99, 2, 2.5351, 9.99, 10, 10.9, 25.8, 99.96, 100, 130, -3, NaN].map(pctShort), ['0%', '0%', '0.5%', '0.9%', '2%', '2.5%', '9.9%', '10%', '10%', '25%', '99%', '100%', '100%', '0%', '0%'])
  assert.deepEqual([money(4.2, 'USD'), money(4.2, 'CNY'), money(0, ''), money(null, 'CNY')], ['$4.20', '¥4.20', '$0', '—'])
})

test('quotas: DeepSeek and Openference (their shape on 2026-11-24)', () => {
  const free = { kind: 'openference', name: 'Openference', ok: true, balance: 0, credits_total: 0, plan_name: 'Promo', subscribed: false, expires_at: null, active: true, windows: [], account_usage: { requests: 8, tokens: 25529, cost: 0 }, free_models: [{ model: 'GLM-5.3-Flash-Free', until: '2026-12-04' }, { model: 'Other', until: 'soon' }, { model: 'Odd', until: '2026-13-45' }, null, { until: '2026-12-04' }], email: 'x@example.com', apiKey: 'sk-something' }
  const d = quotaData({ plugin: 'pedila', version: '1.3.0', providers: [
    { kind: 'deepseek', name: 'DeepSeek', ok: true, balances: [{ currency: 'USD', total: 4.2, granted: 0, topped_up: 4.2 }, { currency: 'EUR', total: 1 }, { currency: 'CNY', total: 'x' }, null], available: true },
    free,
    { kind: 'openference', ok: true, balance: 3, credits_total: 10, plan_name: 'Minion', subscribed: true, expires_at: '2026-12-24T00:00:00Z', active: true, windows: [{ id: 'rolling', percent: 140, resets_at: '2026-11-24T19:00:00Z', hours: 5, used: null, limit: null, unit: '' }, { id: 'weekly', percent: 12.5, resets_at: 'x', used: 100, limit: 800, unit: 'requests' }, { id: 'monthly', percent: 'x' }] },
    { kind: 'deepseek', ok: true, balances: 'garbage', available: 'no' },
    { kind: 'openference', ok: false, error: "the key isn't valid or isn't allowed to see this", windows: 3, free_models: {}, account_usage: 'x' }
  ] })
  const [ds, of, paid, bad, off] = d.providers
  assert.deepEqual(ds.balances, [{ currency: 'USD', total: 4.2, granted: 0, toppedUp: 4.2 }, { currency: '', total: 1, granted: null, toppedUp: null }])
  assert.equal(ds.available, true)
  assert.deepEqual([of.balance, of.planName, of.subscribed, of.active, of.windows.length], [0, 'Promo', false, true, 0])
  assert.deepEqual(of.usage, { requests: 8, tokens: 25529, cost: 0 })
  assert.deepEqual(of.freeModels, [{ model: 'GLM-5.3-Flash-Free', until: '2026-12-04' }, { model: 'Other', until: null }, { model: 'Odd', until: null }])
  assert.ok(!JSON.stringify(of).includes('example.com') && !JSON.stringify(of).includes('sk-'))
  assert.deepEqual(paid.windows, [
    { id: 'rolling', percent: 100, resetsAt: '2026-11-24T19:00:00Z', hours: 5, used: null, limit: null, unit: 'requests' },
    { id: 'weekly', percent: 12.5, resetsAt: null, hours: null, used: 100, limit: 800, unit: 'requests' }])
  assert.equal(paid.expiresAt, '2026-12-24T00:00:00Z')
  assert.deepEqual([bad.balances, bad.available], [[], null])
  assert.deepEqual([off.ok, off.windows, off.freeModels, off.usage], [false, [], [], { requests: null, tokens: null, cost: null }])
})

test('quotas: OpenCode Go, errors and garbage', () => {
  const d = quotaData({
    plugin: 'pedila',
    providers: [
      { kind: 'opencode-go', ok: true, windows: [{ id: 'rolling', label: '5 h', percent: 140, resets_at: '2026-11-18T23:00:00Z' }, { id: 'weekly', percent: 'x' }] },
      { kind: 'venice', ok: false, error: "the key isn't valid" },
      { kind: 'something-else', ok: true },
      null,
      { kind: 'openrouter', ok: true, balance: 'mucho', key_limit: { limit: 5, remaining: 2, reset: 'hourly' } }
    ]
  })
  assert.equal(d.providers.length, 3)
  assert.deepEqual(d.providers[0].windows, [{ id: 'rolling', label: '5 h', percent: 100, resetsAt: '2026-11-18T23:00:00Z', estimate: null, cost: null, tokens: null, calls: null }])
  assert.equal(d.providers[0].plan, null)
  assert.deepEqual(d.providers[0].unpriced, [])
  assert.equal(d.providers[0].catalog, null)
  assert.equal(d.providers[1].ok, false)
  assert.equal(d.providers[1].error, "the key isn't valid")
  assert.equal(d.providers[2].balance, null)
  assert.deepEqual(d.providers[2].keyLimit, { limit: 5, remaining: 2, reset: null })
  assert.equal(quotaData({}).providers.length, 0)
})

test('quotas: money and UTC resets', async () => {
  const f = await import('../src/shell/fmt.mjs')
  assert.equal(f.usd(9.9066), '$9.91')
  assert.equal(f.usd(0.0933), '$0.093')
  assert.equal(f.usd(0), '$0')
  assert.equal(f.usd(0.0004), '$<0.001')
  assert.equal(f.usd(null), '—')
  // Wednesday 2026-11-18 at 20:00 UTC.
  const now = Date.UTC(2026, 10, 18, 20, 0)
  assert.equal(f.nextUtcReset('daily', now), Date.UTC(2026, 10, 19))
  assert.equal(f.nextUtcReset('weekly', now), Date.UTC(2026, 10, 23))
  assert.equal(f.nextUtcReset('monthly', now), Date.UTC(2026, 11, 1))
  // A Monday at exactly 00:00 UTC: the next Monday, not that same instant.
  assert.equal(f.nextUtcReset('weekly', Date.UTC(2026, 10, 23)), Date.UTC(2026, 10, 30))
  assert.equal(f.nextUtcReset('never', now), null)
  // Days to come, in local time.
  const base = new Date(2026, 10, 18, 15, 0).getTime()
  assert.equal(f.dayAhead(new Date(2026, 10, 18, 23, 0).getTime(), base), 'today')
  assert.equal(f.dayAhead(new Date(2026, 10, 19, 9, 0).getTime(), base), 'tomorrow')
  assert.equal(f.dayAhead(new Date(2026, 10, 22, 9, 0).getTime(), base), 'on Sunday')
  assert.equal(f.dayAhead(new Date(2026, 11, 7, 9, 0).getTime(), base), 'on Dec 7')
})

test('quotas: OpenCode Go with decimals', () => {
  const j = {
    plugin: 'pedila', version: '1.2.0', shell: '1.2.0', fetched_at: '2026-11-20T01:20:00+00:00',
    providers: [{
      kind: 'opencode-go', name: 'OpenCode Go', hermes_name: 'opencode-go', ok: true,
      spent: { day: { tokens: 680000, calls: 90, cost: 2.5 }, week: { tokens: 680000, calls: 90, cost: 2.5 }, month: { tokens: 680000, calls: 90, cost: 2.5 } },
      windows: [
        { id: 'rolling', label: '5 h', percent: 2.0, resets_at: '2026-11-20T05:50:37+00:00', estimate: 2.5351, own: 2.5351, cost: 2.5, tokens: 680000, calls: 90 },
        { id: 'weekly', label: 'week', percent: 1.0, resets_at: '2026-11-23T00:00:00+00:00', estimate: 1.014, own: 1.014, cost: 2.5, tokens: 680000, calls: 90 },
        { id: 'monthly', label: 'month', percent: 0.0, resets_at: '2026-12-19T18:20:30+00:00', estimate: 0.507, own: 0.507, cost: 2.5, tokens: 680000, calls: 90 }
      ],
      plan: 'go', unpriced: [], catalog: true
    }]
  }
  const d = quotaData(j)
  assert.equal(d.version, '1.2.0')
  assert.equal(d.shell, '1.2.0')
  const go = d.providers[0]
  assert.equal(go.plan, 'go')
  assert.equal(go.catalog, true)
  assert.deepEqual(go.windows[0], { id: 'rolling', label: '5 h', percent: 2, resetsAt: '2026-11-20T05:50:37+00:00', estimate: 2.5351, cost: 2.5, tokens: 680000, calls: 90 })
  assert.equal(go.windows[2].estimate, 0.507)
  assert.equal(go.spent.day.cost, 2.5)
  // Garbage: unknown plan, estimate out of range, odd unpriced models.
  const b = quotaData({ plugin: 'pedila', providers: [{ kind: 'opencode-go', ok: true, plan: 'go-ultra', catalog: 'yes', unpriced: ['a', 3, '', null, 'b'], windows: [{ id: 'weekly', percent: 5, estimate: 250, cost: -1, tokens: 'x' }] }] }).providers[0]
  assert.equal(b.plan, null)
  assert.equal(b.catalog, null)
  assert.deepEqual(b.unpriced, ['a', 'b'])
  assert.equal(b.windows[0].estimate, 100)
  assert.equal(b.windows[0].cost, 0)
  assert.equal(b.windows[0].tokens, null)
})

test('quotas: does the plugin have to be updated?', () => {
  assert.equal(quotaPluginOutdated('1.0.0'), true)
  assert.equal(quotaPluginOutdated(''), true)
  assert.equal(quotaPluginOutdated(undefined), true)
  assert.equal(quotaPluginOutdated('1.1.0'), true)
  assert.equal(quotaPluginOutdated('1.2.0'), true)
  assert.equal(quotaPluginOutdated('1.3.0'), true)
  assert.equal(quotaPluginOutdated('1.4.0'), true)
  assert.equal(quotaPluginOutdated('1.5.0'), true)
  assert.equal(quotaPluginOutdated('1.6.0'), true)
  assert.equal(quotaPluginOutdated('1.7.0'), false)
  assert.equal(quotaPluginOutdated('1.7.1'), false)
  assert.equal(quotaPluginOutdated('2.0.0'), false)
})

test('quotas: several keys of the same API are several quotas (plugin 1.2.0)', () => {
  const win = [{ id: 'weekly', label: 'week', percent: 40, resets_at: '2026-11-30T00:00:00+00:00' }]
  const d = quotaData({
    plugin: 'pedila', version: '1.2.0',
    providers: [
      { kind: 'opencode-go', name: 'OpenCode Go', ok: true, spent: null, spent_all: { day: { tokens: 10, calls: 1, cost: 0.1 } }, windows: win, account: { id: 'aaa111', n: 1, of: 2, active: false, resting: true, until: '2026-11-24T04:00:00+00:00', hidden: 0 } },
      { kind: 'opencode-go', name: 'OpenCode Go (extra)', ok: true, spent: null, windows: win, account: { id: 'bbb222', n: 2, of: 2, active: true, resting: false, until: null, hidden: 3 } },
      { kind: 'venice', name: 'Venice', ok: true, account: { id: 'x', n: 1, of: 1, active: true } },
      { kind: 'openrouter', name: 'OpenRouter', ok: true, account: { of: 5, n: 'x', active: 'yes', resting: 'no', until: 'garbage', hidden: -4, key: 'sk-secret' } },
      { kind: 'openrouter', name: 'OpenRouter 2', ok: true, account: 'x' }
    ]
  })
  assert.deepEqual(d.providers.map(p => p.name), ['OpenCode Go', 'OpenCode Go (extra)', 'Venice', 'OpenRouter', 'OpenRouter 2'])
  assert.deepEqual(d.providers[0].account, { id: 'aaa111', n: 1, of: 2, active: false, resting: true, until: '2026-11-24T04:00:00+00:00', hidden: 0 })
  assert.equal(d.providers[0].spent, null)
  assert.equal(d.providers[0].spentAll.day.tokens, 10)
  assert.deepEqual(d.providers[1].account, { id: 'bbb222', n: 2, of: 2, active: true, resting: false, until: null, hidden: 3 })
  assert.equal(d.providers[1].spentAll, null)
  assert.equal(d.providers[2].account, null) // a single key: nothing to tell apart
  assert.deepEqual(d.providers[3].account, { id: '', n: 1, of: 5, active: null, resting: false, until: null, hidden: 0 })
  assert.equal(d.providers[4].account, null)
})

/** A connection whose Hermes answers what each route says: { 'POST /path': answer | [answers] }. */
function fakeHermes(routes, transport = {}) {
  const calls = []
  transport.fetchJson = async (p, o = {}) => {
    const k = `${o.method || 'GET'} ${p.replace('/api/dashboard/agent-plugins/', '').replace('/api/dashboard/', '')}`
    calls.push(o.body === undefined ? k : `${k} ${JSON.stringify(o.body)}`)
    const a = routes[k]
    const r = Array.isArray(a) ? a.shift() : a
    if (!r) { throw new Error('unexpected: ' + k) }
    return { json: null, ...r }
  }
  return { calls, c: new Connection({ id: 'local', name: 'This PC', transport, log: { info() {}, warn() {} } }) }
}
const onDisk = v => ({ status: 200, json: [{ name: 'other', version: '9' }, { name: 'pedila', version: v }] })
const install = force => `POST install {"identifier":"ElKiro1311/pedila/hermes-plugin/pedila","enable":true,"force":${force}}`

test("quotas: updating the plugin goes through Hermes's own route, which changes nothing if it fails", async () => {
  let h = fakeHermes({ 'POST pedila/update': { status: 200, json: { ok: true, unchanged: false } }, 'GET plugins': onDisk(QUOTA_PLUGIN_WANT) })
  assert.deepEqual(await h.c.updateQuotaPlugin(), { ok: true, unchanged: false })
  assert.deepEqual(h.calls, ['POST pedila/update {}', 'GET plugins'])
  // What counts is the version that's left on disk: Hermes compares the whole repository's commit, not it.
  h = fakeHermes({ 'POST pedila/update': { status: 200, json: { ok: true, unchanged: false } }, 'GET plugins': onDisk('1.0.1') })
  assert.deepEqual(await h.c.updateQuotaPlugin(), { ok: true, unchanged: true })
  h = fakeHermes({ 'POST pedila/update': { status: 200, json: { ok: true, unchanged: true } }, 'GET plugins': onDisk('9.0.0') })
  assert.deepEqual(await h.c.updateQuotaPlugin(), { ok: true, unchanged: false })
  // A Hermes that can't say what's on disk: what its update said.
  for (const unchanged of [true, false]) {
    h = fakeHermes({ 'POST pedila/update': { status: 200, json: { ok: true, unchanged } }, 'GET plugins': { status: 404 } })
    assert.deepEqual(await h.c.updateQuotaPlugin(), { ok: true, unchanged })
  }
  // The security scan asks: it's returned, nothing is removed, and with the person's yes it's forced.
  h = fakeHermes({ 'POST pedila/update': [{ status: 200, json: { ok: false, scan_blocked: true, scan_verdict: 'caution', scan_findings: [{ message: 'uses the network' }] } }, { status: 200, json: { ok: true } }], 'GET plugins': onDisk('9.0.0') })
  assert.deepEqual(await h.c.updateQuotaPlugin(), { ok: false, scan: 'caution', findings: ['uses the network'] })
  assert.deepEqual(await h.c.updateQuotaPlugin(true), { ok: true, unchanged: false })
  assert.deepEqual(h.calls, ['POST pedila/update {}', 'POST pedila/update {"force":true}', 'GET plugins'])
  h = fakeHermes({ 'POST pedila/update': { status: 400, json: { detail: 'Security scan blocked (dangerous verdict)\n- reads keys\nReview the findings' } } })
  assert.deepEqual(await h.c.updateQuotaPlugin(), { ok: false, scan: 'dangerous', findings: ['- reads keys'] })
  // Any other failure (GitHub down, pinned, another update going on) is said, and nothing is removed either.
  h = fakeHermes({ 'POST pedila/update': { status: 400, json: { detail: 'Git clone failed: could not resolve host' } } })
  await assert.rejects(h.c.updateQuotaPlugin(), /could not resolve host/)
  assert.deepEqual(h.calls, ['POST pedila/update {}'])
})

test("quotas: with a Hermes that can't update it, the plugin is removed and installed again", async () => {
  for (const first of [{ status: 404 }, { status: 405 }, { status: 400, json: { detail: "Plugin 'pedila' is not a git checkout; cannot pull updates." } }]) {
    const h = fakeHermes({ 'POST pedila/update': first, 'DELETE pedila': { status: 200, json: { ok: true } }, 'POST install': { status: 200, json: { ok: true, restart_required: false } }, 'GET plugins': onDisk('9.0.0') })
    assert.deepEqual(await h.c.updateQuotaPlugin(true), { ok: true, unchanged: false })
    assert.deepEqual(h.calls, ['POST pedila/update {"force":true}', 'DELETE pedila', install(true), 'GET plugins'])
  }
  // The scan stops the installation: it's returned.
  let h = fakeHermes({ 'POST pedila/update': { status: 404 }, 'DELETE pedila': { status: 200, json: { ok: true } }, 'POST install': { status: 400, json: { detail: 'Security scan blocked (caution verdict)\n- uses the network' } } })
  assert.deepEqual(await h.c.updateQuotaPlugin(), { ok: false, scan: 'caution', findings: ['- uses the network'] })
  // The old one can't be removed: it isn't installed on top, and it's said.
  h = fakeHermes({ 'POST pedila/update': { status: 404 }, 'DELETE pedila': { status: 400, json: { detail: 'The folder is in use' } } })
  await assert.rejects(h.c.updateQuotaPlugin(), /in use/)
  // It's a linked folder: it's still there, so it isn't updated (and turning it on isn't updating it).
  h = fakeHermes({ 'POST pedila/update': { status: 400, json: { detail: "Plugin 'pedila' was not found under plugins" } }, 'DELETE pedila': { status: 400, json: { detail: 'not found' } }, 'POST install': { status: 400, json: { detail: 'already installed outside the catalog: Delete that link' } } })
  await assert.rejects(h.c.updateQuotaPlugin(), /Delete that link/)
  assert.ok(!h.calls.some(x => x.includes('enable {')))
  // Installing it for the first time, on the other hand, does turn on the one that was already there.
  h = fakeHermes({ 'POST install': { status: 400, json: { detail: 'Plugin already exists' } }, 'POST pedila/enable': { status: 200, json: { ok: true } } })
  assert.equal((await h.c.installQuotaPlugin()).ok, true)
})

test('quotas: the whole update goes to the same Hermes', async () => {
  const first = fakeHermes({ 'POST pedila/update': { status: 404 }, 'DELETE pedila': { status: 200, json: {} }, 'POST install': { status: 200, json: { ok: true } }, 'GET plugins': onDisk('9.0.0') })
  const h = fakeHermes({}, { pinned: async () => first.c.transport })
  assert.equal((await h.c.updateQuotaPlugin()).ok, true)
  assert.deepEqual(h.calls, [])
  assert.equal(first.calls.length, 4)
})

test("quotas: a plugin updated on disk but not loaded yet isn't offered again", async () => {
  const answer = (version, more = {}) => ({ status: 200, json: { plugin: 'pedila', version, providers: [], ...more } })
  const Q = 'GET /api/plugins/pedila/cuotas'
  const D = 'GET plugins'
  const ask = async routes => { const h = fakeHermes(routes); const r = await h.c.quotas(); return [r.outdated, r.onDisk, r.restart, h.calls.length] }
  assert.deepEqual(await ask({ [Q]: answer('1.0.0'), [D]: onDisk('1.7.0') }), [true, '1.7.0', true, 2])
  assert.deepEqual(await ask({ [Q]: answer('1.0.0'), [D]: onDisk('1.0.1') }), [true, '1.0.1', false, 2])
  // Not being able to know is taken as "not updated"; up to date, it isn't even asked.
  assert.deepEqual(await ask({ [Q]: answer('1.0.0'), [D]: { status: 401 } }), [true, '', false, 2])
  assert.deepEqual(await ask({ [Q]: answer('1.0.0') }), [true, '', false, 2])
  assert.deepEqual(await ask({ [Q]: answer('1.7.0') }), [false, '', false, 1])
  // Up to date in what reloads by itself, but with the fixed part from before.
  assert.deepEqual(await ask({ [Q]: answer('1.7.0', { shell: '1.2.0', shell_stale: true }) }), [false, '', true, 1])
})

test('quotas: what the card says about the plugin', async () => {
  const { pluginNotice } = await import('../src/shell/quotas.mjs')
  const ok = q => ({ state: 'ok', outdated: true, onDisk: '1.0.0', restart: false, ...q })
  assert.equal(pluginNotice(null), null)
  assert.equal(pluginNotice({ state: 'missing', outdated: true }), null)
  assert.equal(pluginNotice(ok({ outdated: false })), null)
  assert.equal(pluginNotice(ok({ outdated: false, restart: true })), 'restart')
  assert.equal(pluginNotice(ok({})), 'update')
  assert.equal(pluginNotice(ok({}), { ask: { scan: 'caution' } }), 'ask')
  assert.equal(pluginNotice(ok({ restart: true, onDisk: '1.2.0' }), { ask: { scan: 'caution' } }), 'restart')
  // Updated from here: it only counts if Hermes can't say what it has on disk.
  assert.equal(pluginNotice(ok({ onDisk: '' }), { updated: true }), 'restart')
  assert.equal(pluginNotice(ok({ onDisk: '1.0.1' }), { updated: true }), 'update')
})

test('quotas: what each key is doing', async () => {
  const { keyState } = await import('../src/shell/quotas.mjs')
  const { setHour12 } = await import('../src/shell/fmt.mjs')
  setHour12(false)
  const now = new Date(2026, 10, 23, 20, 0).getTime()
  const at = h => new Date(now + h * 3600e3).toISOString()
  assert.equal(keyState(null, now), null)
  assert.deepEqual([keyState({ active: true }, now).cls, keyState({ active: true }, now).text], ['on', 'in use'])
  assert.deepEqual([keyState({ active: false }, now).cls, keyState({ active: false }, now).text], ['', 'in reserve'])
  assert.equal(keyState({ active: null }, now).text, 'takes turns')
  const soon = keyState({ active: false, resting: true, until: at(2) }, now)
  assert.deepEqual([soon.cls, soon.text], ['rest', 'resting until 22:00'])
  assert.match(soon.title, /Until: /)
  // Days from now the time alone would mislead; without knowing until when, or an odd one, neither.
  assert.equal(keyState({ resting: true, until: at(50) }, now).text, 'resting')
  assert.equal(keyState({ resting: true, until: null }, now).text, 'resting')
  assert.doesNotMatch(keyState({ resting: true, until: 'garbage' }, now).title, /Until/)
})

test("quotas: the plugin's versions agree with each other", () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'hermes-plugin', 'pedila', f), 'utf8')
  const of = (f, re) => re.exec(read(f))[1]
  const plugin = of('dashboard/quotas_core.py', /^PLUGIN_VERSION = "([^"]+)"/m)
  const shell = of('dashboard/plugin_api.py', /^SHELL_VERSION = "([^"]+)"/m)
  // Hermes says the manifest's as the one on disk, and it's the one that decides whether it has to restart.
  assert.equal(JSON.parse(read('dashboard/manifest.json')).version, plugin)
  assert.equal(of('plugin.yaml', /^version: (\S+)$/m), plugin)
  assert.equal(newer(QUOTA_PLUGIN_WANT, plugin), false)
  assert.equal(newer(shell, plugin), false) // the fixed part may stay behind, never ahead
})

test('quotas: percentages with one decimal, cut off (not rounded)', async () => {
  const f = await import('../src/shell/fmt.mjs')
  assert.equal(f.pct1(2.5351), '2.5%')
  assert.equal(f.pct1(1.014), '1.0%')
  assert.equal(f.pct1(0.507), '0.5%')
  assert.equal(f.pct1(0.99), '0.9%')
  assert.equal(f.pct1(0.7468), '0.7%')
  assert.equal(f.pct1(0), '0.0%')
  assert.equal(f.pct1(100), '100.0%')
  assert.equal(f.pct1(250), '100.0%')
  assert.equal(f.pct1(-3), '0.0%')
  assert.equal(f.pct1(NaN), '0.0%')
  assert.equal(f.pct1(1e-7), '0.0%')
  const i18n = await import('../src/shell/i18n.mjs')
  i18n.setLang('es')
  assert.equal(f.pct1(2.5351), '2,5 %')
  i18n.setLang('en')
  // What's left + what's used add up to 100 (both cut off to the tenth).
  assert.equal(f.pct1(100 - f.trunc1(2.5351)), '97.5%')
  assert.equal(f.pct1(100 - f.trunc1(0.7)), '99.3%')
  assert.equal(f.trunc1(0.3), 0.3)
  assert.equal(f.trunc1(0.29), 0.2)
  assert.equal(f.trunc1(1.1), 1.1)
})
