'use strict'
// Windows notifications: "Hermes finished", "Hermes needs you", "Hermes had a problem".
// decide() is pure (tested without Electron); show() uses Electron's Notification.

/**
 * @param {'done'|'needs'|'failed'} kind
 * @param {{notify: object, focusedOnChat: boolean, ms?: number|null}} ctx
 */
function decide(kind, ctx) {
  const n = ctx.notify || {}
  if (!n.enabled) { return false }
  if (ctx.focusedOnChat) { return false }
  if (kind === 'done') {
    if (!n.done) { return false }
    if (typeof ctx.ms === 'number' && ctx.ms < (n.minDurationSec || 0) * 1000) { return false }
    return true
  }
  if (kind === 'needs') { return Boolean(n.needs) }
  if (kind === 'failed') { return Boolean(n.failed) }
  return false
}

const alive = new Set() // so that the collector doesn't take the notification away before you click it

function show({ Notification, icon, title, body, silent, onClick, log }) {
  if (!Notification.isSupported()) { if (log) { log.warn('Windows notifications not available') } return null }
  const n = new Notification({ title, body: body.length > 180 ? body.slice(0, 179) + '…' : body, icon, silent })
  alive.add(n)
  const forget = () => setTimeout(() => alive.delete(n), 60 * 60 * 1000)
  if (onClick) { n.on('click', onClick) }
  n.on('show', () => { if (log) { log.info(`notification shown: ${title}`) } forget() })
  n.on('failed', (_e, err) => { if (log) { log.warn(`notification failed: ${title}: ${err}`) } alive.delete(n) })
  n.on('close', () => alive.delete(n))
  n.show()
  return n
}

module.exports = { decide, show }
