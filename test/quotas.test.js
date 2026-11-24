'use strict'
// Quotas of the paid APIs: what comes from Hermes's "pedila" plugin, cleaned up.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { quotaData, quotaPluginOutdated, QUOTA_PLUGIN_WANT, paidKindOf, Connection } = require('../src/main/connection')
const { newer } = require('../src/main/extras')

test('quotas: which paid API each address is', () => {
  assert.equal(paidKindOf('https://openrouter.ai/api/v1'), 'openrouter')
  assert.equal(paidKindOf('https://api.venice.ai/api/v1'), 'venice')
  assert.equal(paidKindOf('https://opencode.ai/zen/go/v1'), 'opencode-go')
  assert.equal(paidKindOf('https://opencode.ai/zen/v1'), 'opencode-zen')
  assert.equal(paidKindOf('http://192.168.1.50:8181/v1'), null)
  assert.equal(paidKindOf('https://openrouter.ai.evil.example/v1'), null)
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
  assert.equal(quotaPluginOutdated('1.2.0'), false)
  assert.equal(quotaPluginOutdated('1.2.1'), false)
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
  assert.deepEqual(await ask({ [Q]: answer('1.0.0'), [D]: onDisk('1.2.0') }), [true, '1.2.0', true, 2])
  assert.deepEqual(await ask({ [Q]: answer('1.0.0'), [D]: onDisk('1.0.1') }), [true, '1.0.1', false, 2])
  // Not being able to know is taken as "not updated"; up to date, it isn't even asked.
  assert.deepEqual(await ask({ [Q]: answer('1.0.0'), [D]: { status: 401 } }), [true, '', false, 2])
  assert.deepEqual(await ask({ [Q]: answer('1.0.0') }), [true, '', false, 2])
  assert.deepEqual(await ask({ [Q]: answer('1.2.0') }), [false, '', false, 1])
  // Up to date in what reloads by itself, but with the fixed part from before.
  assert.deepEqual(await ask({ [Q]: answer('1.3.0', { shell: '1.2.0', shell_stale: true }) }), [false, '', true, 1])
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
