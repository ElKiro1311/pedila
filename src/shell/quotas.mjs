// What the quotas card decides, apart from painting it (so that the tests can load it as is).

import { tr } from './i18n.mjs'
import { hhmm, full, usd, money, trunc1, nextUtcReset } from './fmt.mjs'

/**
 * With several keys for the same API (Hermes's credential pool): what this one is doing → { cls, text, title },
 * or null if there's nothing to tell apart.
 */
export function keyState(a, now = Date.now()) {
  if (!a) { return null }
  if (a.resting) {
    const at = a.until ? Date.parse(a.until) : NaN
    const soon = Number.isFinite(at) && at - now < 24 * 3600e3
    const why = tr('It ran out (or the provider rejected it): for now Hermes leaves it alone and uses the next one.')
    return { cls: 'rest', text: soon ? tr('resting until {0}', hhmm(at)) : tr('resting'), title: Number.isFinite(at) ? `${why} ${tr('Until: {0}.', full(at))}` : why }
  }
  if (a.active === true) { return { cls: 'on', text: tr('in use'), title: tr('The key Hermes uses now. When it runs out, Hermes moves on to the next one by itself.') } }
  if (a.active === false) { return { cls: '', text: tr('in reserve'), title: tr('Hermes will use it when the ones before it run out.') } }
  return { cls: '', text: tr('takes turns'), title: tr('Hermes uses the keys of this provider in turns.') }
}

/**
 * What has been used of one of a plan's windows, in %: with a decimal if there's one to trust (`estimate`); if not,
 * the provider's number, whole and cut off.
 */
export function usedOf(w) {
  return w.estimate !== null && w.estimate !== undefined ? trunc1(w.estimate) : Math.floor(w.percent)
}

// A plan's windows, from the shortest to the longest: the longest one is its total.
const WINDOW_RANK = { rolling: 0, weekly: 1, 'weekly-tokens': 1, monthly: 2 }
/** From here on (in %), something is nearly spent. */
export const NEARLY = 80
// With less than this share of what there was, what's left is the odd cents of something that ran out.
const ODD_CENTS = 0.02
// What ran out still counts as used for this long (a month of a plan); then it's an old story.
const RAN_OUT_MS = 30 * 86400e3

/**
 * What Pedila remembers of a balance that comes without its total: the highest one since the last top-up (`max`, since
 * `since`), the last one (`last`) and when it ran out, or was down to odd cents (`out`). → the same record if nothing changes, or the new one. It
 * starts over when the balance goes up (a top-up, even a smaller one than the one before; not a correction of some
 * cents) or in another `epoch` (a new day).
 */
export function nextPeak(r, value, epoch = '', now = Date.now()) {
  const up = r && value > 0 ? value - r.last : 0 // (what versions before 0.21 stored has no `last`: it isn't a top-up)
  if (!r || typeof r.max !== 'number' || value > r.max + 1e-9 || (epoch && r.epoch !== epoch) || up > Math.max(0.05, r.max * ODD_CENTS)) { return { max: value, since: now, epoch, last: value } }
  if (r.last === value) { return r }
  const { out, ...rest } = r
  return value > Math.max(0, r.max * ODD_CENTS) ? { ...rest, last: value } : { ...rest, last: value, out: out || now }
}

/**
 * The one figure of the simple view: how much of a quota's total has been used → { pct, text, warn, tight }.
 * - pct: 0–100; null if there's no total to compare it with, and then `text` says what there is.
 * - warn: it can't be used now or it couldn't be read.
 * - tight: a shorter limit that is nearly spent and would stop it before its total does: { id, hours, pct, at }.
 * `observe(name, value, epoch)` = what has been spent of a balance that comes without its total, or null (observedUse).
 */
export function quotaTotal(p, observe = () => null, now = Date.now()) {
  const out = { pct: null, text: '—', warn: false, tight: null }
  if (!p.ok) { return { ...out, text: tr('error'), warn: true } }
  const share = (used, total) => Math.max(0, Math.min(100, used / total * 100))
  const some = v => v !== null && v !== undefined
  const most = (list, of) => list.reduce((a, b) => (of(b) > of(a) ? b : a))
  const sum = (list, k) => list.reduce((a, o) => a + o[k], 0)
  // Next to the others' "used", it must be plain that this is what's left.
  const left = (n, text) => (typeof n !== 'number' ? '—' : n > 0 ? tr('{0} left', text) : tr('no balance'))
  const seen = (name, value, epoch) => { const o = some(value) ? observe(name, value, epoch) : null; return o ? { ...o, left: value } : null }
  if (p.kind === 'openrouter' || p.kind === 'orcarouter') {
    const kl = p.keyLimit && some(p.keyLimit.remaining) && p.keyLimit.limit > 0 ? share(p.keyLimit.limit - p.keyLimit.remaining, p.keyLimit.limit) : null
    out.text = left(p.balance, usd(p.balance))
    if (p.creditsTotal > 0 && some(p.creditsUsed)) {
      out.pct = share(p.creditsUsed, p.creditsTotal)
      if (kl !== null && kl >= NEARLY && kl > out.pct) { out.tight = { id: 'key', hours: null, pct: kl, at: nextUtcReset(p.keyLimit.reset, now) } }
    } else { out.pct = kl }
    return out
  }
  if (p.kind === 'venice') {
    const all = [seen('bundled', p.bundled), seen('usd', p.usd)].filter(Boolean)
    const day = seen('diem', p.diem, p.nextEpoch || '')
    const total = (p.usd || 0) + (p.bundled || 0)
    out.text = left(total, usd(total))
    out.warn = p.access === false
    // Its two balances together, except what ran out long ago if Venice still lets you use the rest; with just odd cents,
    // the day's DIEM if there is any.
    const recent = p.access === false ? all : all.filter(o => o.left > Math.max(0, o.max * ODD_CENTS) || (o.out && now - o.out < RAN_OUT_MS))
    const funds = sum(recent, 'max') > 0 ? recent : all
    if (day && day.left > 0 && sum(funds, 'left') <= sum(funds, 'max') * ODD_CENTS) { out.pct = day.pct } else if (sum(funds, 'max') > 0) { out.pct = share(sum(funds, 'spent'), sum(funds, 'max')) } else if (day && day.max > 0) { out.pct = day.pct }
    return out
  }
  if (p.kind === 'deepseek') {
    // With balances in two currencies, the one with the most left (a yuan is about a seventh of a dollar).
    const worth = (b, n) => (b.currency === 'CNY' ? n / 7 : n)
    const all = p.balances.map(b => ({ b, o: seen((b.currency || 'balance').toLowerCase(), b.total) })).filter(x => x.o && x.o.max > 0)
    const live = all.filter(x => x.o.left > 0)
    const rest = p.balances.filter(b => b.total > 0)
    out.text = !p.balances.length ? '—' : rest.length ? tr('{0} left', rest.map(b => money(b.total, b.currency)).join(' + ')) : tr('no balance')
    out.warn = p.available === false
    if (live.length) { out.pct = most(live, x => worth(x.b, x.o.left)).o.pct } else if (all.length) { out.pct = most(all, x => worth(x.b, x.o.max)).o.pct }
    return out
  }
  if (p.windows && p.windows.length) {
    const rank = w => WINDOW_RANK[w.id] || 0
    const long = Math.max(...p.windows.map(rank))
    const total = most(p.windows.filter(w => rank(w) === long), usedOf)
    out.pct = usedOf(total)
    const near = p.windows.filter(w => w !== total && usedOf(w) >= NEARLY && usedOf(w) > out.pct)
    if (near.length) {
      const w = most(near, usedOf)
      const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      out.tight = { id: w.id, hours: w.hours || null, pct: usedOf(w), at: Number.isFinite(at) ? at : null }
    }
  } else if (p.kind === 'openference' && some(p.balance)) {
    const o = p.creditsTotal > 0 && p.balance <= p.creditsTotal ? null : observe('credits', p.balance)
    out.text = left(p.balance, usd(p.balance))
    if (p.creditsTotal > 0 && p.balance <= p.creditsTotal) { out.pct = share(p.creditsTotal - p.balance, p.creditsTotal) } else if (o && o.max > 0) { out.pct = o.pct }
  }
  if (p.kind === 'openference') { out.warn = p.active === false }
  return out
}

/**
 * What Hermes has used of the AI on your own network, for the panel:
 * - { blocks: [{ name, spent }] }, provider by provider and with its 24 h, 7 d and 30 d: the plugin says it (1.6.0);
 * - { name, models }, over the last year: without the plugin, the models in Hermes's statistics that a provider of
 *   yours has now (`q.localModels`), or whose name is a file's;
 * - null: nothing used, or it isn't known yet (the quotas, or your providers' models, haven't been read).
 * `q` = the quotas' reading; `u` = the usage summary.
 */
export function localUse(q, u, isFile = () => false) {
  if (!q) { return null }
  if (q.state === 'ok' && q.data && Array.isArray(q.data.local)) { return q.data.local.length ? { blocks: q.data.local } : null }
  const mine = q.localModels
  if (!Array.isArray(mine)) { return null }
  const names = new Set(mine.flatMap(p => p.models))
  // (Ollama's cloud models are used through its local address, but they run in its cloud.)
  const models = (u && Array.isArray(u.models) ? u.models : []).filter(m => m.input + m.output > 0 && (names.has(m.model) || isFile(m.model)) && !/[:-]cloud\s*$/i.test(m.model))
  return models.length ? { name: mine.length === 1 ? mine[0].name : '', models } : null
}

/**
 * What the card says about the plugin:
 * - 'restart': the new one is on disk, but Hermes will only load it when it restarts;
 * - 'ask': Hermes's security scan raised an objection to the new one;
 * - 'update': there's a new one to install;
 * - null: nothing.
 * `q` = the reading (Connection.quotas). `updated` = it was updated from here (only counts with a Hermes that
 * can't say what it has on disk: q.onDisk === '').
 */
export function pluginNotice(q, { updated = false, ask = null } = {}) {
  if (!q || q.state !== 'ok') { return null }
  if (q.restart || (q.outdated && updated && !q.onDisk)) { return 'restart' }
  if (!q.outdated) { return null }
  return ask ? 'ask' : 'update'
}
