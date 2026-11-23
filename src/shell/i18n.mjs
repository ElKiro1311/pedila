// The interface's language. The code has every text in English, tr('…'), and es.json the Spanish ones; a text that isn't
// there comes out in English. {0}, {1}… are the arguments.
import es from './es.json' with { type: 'json' }

const TABLES = { es }
let lang = 'en'

export function setLang(l) { lang = Object.hasOwn(TABLES, l) ? l : 'en' }
export const getLang = () => lang
/** For Intl: dates, times and numbers. */
export const locale = () => (lang === 'es' ? 'es' : 'en-US')

export function tr(text, ...args) {
  const s = (TABLES[lang] && TABLES[lang][text]) || text
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i]) : m)) : s
}

/** Translates a page written in English: its text and its title, placeholder and aria-label attributes. */
export function translateDom(root) {
  if (!TABLES[lang]) { return }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim()
    if (text) { n.nodeValue = n.nodeValue.replace(text, () => tr(text)) }
  }
  for (const e of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const a of ['title', 'placeholder', 'aria-label']) { if (e.getAttribute(a)) { e.setAttribute(a, tr(e.getAttribute(a))) } }
  }
}
