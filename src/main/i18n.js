'use strict'
// The language of what the main process shows (tray, notifications, errors): the same texts as the screen's (shell/es.json).
const es = require('../shell/es.json')

let lang = 'en'
const setLang = l => { lang = l === 'es' ? 'es' : 'en' }
const getLang = () => lang

/** The language of a setting; 'auto' = the system's: Spanish if it is, English otherwise. Pure. */
function resolveLang(setting, system = []) {
  if (setting === 'en' || setting === 'es') { return setting }
  return /^es\b/i.test(String(system[0] || '')) ? 'es' : 'en'
}

function tr(text, ...args) {
  const s = (lang === 'es' && es[text]) || text
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s
}

module.exports = { tr, setLang, getLang, resolveLang }
