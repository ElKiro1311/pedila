'use strict'
// The interface's language: every text in the code has its Spanish one, and the settings that choose it.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tr, setLang, getLang, resolveLang } = require('../src/main/i18n')
const { sanitize, defaults } = require('../src/main/settings')
const es = require('../src/shell/es.json')

const SRC = path.join(__dirname, '..', 'src')
const files = ['shell/app.js', 'shell/fmt.mjs', 'shell/quotas.mjs', 'shell/tools.mjs', 'shell/pet.js',
  ...fs.readdirSync(path.join(SRC, 'main')).filter(f => f.endsWith('.js')).map(f => 'main/' + f)]
const code = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n')
const html = fs.readFileSync(path.join(SRC, 'shell', 'index.html'), 'utf8')
// The quoted strings of the code, as their values.
const literals = new Set([...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)].map(m => {
  try { return Function('return ' + m[0])() } catch { return null }
}))
const pageTexts = new Set([
  ...html.replace(/<!--[\s\S]*?-->/g, '').split(/<[^>]*>/).map(s => s.trim()).filter(Boolean),
  ...[...html.matchAll(/\b(?:title|placeholder|aria-label)="([^"]*)"/g)].map(m => m[1])
])

test('language: every tr() text has its Spanish one, with the same arguments', () => {
  const used = [...code.matchAll(/\btr\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g)].map(m => Function('return ' + m[1])())
  assert.ok(used.length > 400)
  assert.deepEqual([...new Set(used)].filter(k => !Object.hasOwn(es, k)), [])
  const args = s => [...new Set([...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]))].sort().join()
  for (const [k, v] of Object.entries(es)) { assert.equal(args(v), args(k), k) }
})

test('language: every Spanish text belongs to something in the code or the page', () => {
  assert.deepEqual(Object.keys(es).filter(k => !literals.has(k) && !pageTexts.has(k)), [])
})

test("language: the page's texts are in English and have their Spanish one", () => {
  // Names, symbols and numbers are the same in both.
  const same = new Set(['Pedila', 'Panel', 'Normal', 'English', 'Español', 'Hermes', 'Chats', 'petdex.dev', '.', '0 s', '10 s', '30 s', '1 min'])
  const missing = [...pageTexts].filter(s => /[A-Za-z]/.test(s) && !same.has(s) && !Object.hasOwn(es, s))
  assert.deepEqual(missing, [])
})

test('language: chosen in Settings, or the system’s', () => {
  assert.equal(resolveLang('auto', ['es-US', 'en-US']), 'es')
  assert.equal(resolveLang('auto', ['en-US', 'es-ES']), 'en')
  assert.equal(resolveLang('auto', ['fr-FR']), 'en')
  assert.equal(resolveLang('auto', []), 'en')
  assert.equal(resolveLang('es', ['en-US']), 'es')
  assert.equal(resolveLang('en', ['es-ES']), 'en')
  // A new installation follows the system; settings saved before there was a choice stay in Spanish.
  assert.equal(defaults().language, 'auto')
  assert.equal(sanitize({ look: { palette: 'egeo' } }).language, 'es')
  assert.equal(sanitize({ language: 'en' }).language, 'en')
  assert.equal(sanitize({ language: 'klingon' }).language, 'auto')
})

test('language: texts, arguments, times and tools in both', async () => {
  const i18n = await import('../src/shell/i18n.mjs')
  const f = await import('../src/shell/fmt.mjs')
  const { groupSummary } = await import('../src/shell/tools.mjs')
  const now = new Date(2026, 10, 15, 15, 41).getTime()
  const group = [{ name: 'Bash', input: { command: 'a' }, done: true }, { name: 'Bash', input: { command: 'b' }, done: true }, { name: 'Read', input: { file_path: 'x/a.png' }, done: true }]
  assert.equal(tr('Saved to {0}', 'a.md'), 'Saved to a.md')
  assert.equal(groupSummary(group).text, 'Ran 2 commands, read a.png')
  try {
    setLang('es')
    i18n.setLang('es')
    assert.equal(getLang(), 'es')
    assert.equal(tr('Saved to {0}', 'a.md'), 'Guardado en a.md')
    assert.equal(tr('something without a translation'), 'something without a translation')
    assert.equal(i18n.tr('resets {0} at {1}', i18n.tr('tomorrow'), '21:00'), 'se reinicia mañana a las 21:00')
    assert.equal(f.ago(now - 25 * 60e3, now), 'hace 25 min')
    assert.equal(f.span(50 * 3600e3), '2 días')
    assert.equal(f.dayLabel(new Date(2026, 10, 8, 9, 0).getTime(), now), '8 nov')
    assert.equal(f.dayAhead(new Date(2026, 10, 17, 9, 0).getTime(), now), 'el martes')
    assert.equal(f.taskName('compression'), 'resumir la memoria')
    assert.equal(groupSummary(group).text, 'Ejecutó 2 órdenes, leyó a.png')
  } finally {
    setLang('en')
    i18n.setLang('en')
  }
  assert.equal(f.dayAhead(new Date(2026, 10, 17, 9, 0).getTime(), now), 'on Tuesday')
})
