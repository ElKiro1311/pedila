'use strict'
// Avisos de Windows: «Hermes terminó», «Hermes te necesita», «Hermes tuvo un problema».
// decide() es pura (se prueba sin Electron); show() usa Notification de Electron.

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

const alive = new Set() // que el recolector no se lleve el aviso antes de que lo pulses

function show({ Notification, icon, title, body, silent, onClick, log }) {
  if (!Notification.isSupported()) { if (log) { log.warn('avisos de Windows no disponibles') } return null }
  const n = new Notification({ title, body: body.length > 180 ? body.slice(0, 179) + '…' : body, icon, silent })
  alive.add(n)
  const forget = () => setTimeout(() => alive.delete(n), 60 * 60 * 1000)
  if (onClick) { n.on('click', onClick) }
  n.on('show', () => { if (log) { log.info(`aviso mostrado: ${title}`) } forget() })
  n.on('failed', (_e, err) => { if (log) { log.warn(`aviso fallido: ${title}: ${err}`) } alive.delete(n) })
  n.on('close', () => alive.delete(n))
  n.show()
  return n
}

module.exports = { decide, show }
