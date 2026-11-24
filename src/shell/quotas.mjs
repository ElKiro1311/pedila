// What the quotas card decides, apart from painting it (so that the tests can load it as is).

import { tr } from './i18n.mjs'
import { hhmm, full } from './fmt.mjs'

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
