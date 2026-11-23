// Tools as in Claude Code: what each one did (title, what it was given, how many lines it changed) and the
// summary of a group of consecutive tools ("Ran 2 commands, read a.png").
// It works for Claude Code and for Hermes: each one calls its tools another way.
// No DOM: tested with node.

import { tr } from './i18n.mjs'

const str = v => (typeof v === 'string' ? v : '')
const baseName = p => { const s = str(p).replace(/[\\/]+$/, ''); return s.split(/[\\/]/).pop() || s }
const oneLine = (s, n = 70) => { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const lines = s => (str(s) ? str(s).replace(/\n$/, '').split('\n').length : 0)
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

// Name of the tool (Claude Code or Hermes) → what kind of thing it does.
const KINDS = {
  run: ['bash', 'powershell', 'bashoutput', 'killshell', 'killbash', 'terminal', 'execute_code', 'process', 'shell', 'run_command'],
  read: ['read', 'notebookread', 'read_file', 'view_file', 'file_read'],
  write: ['write', 'write_file', 'create_file', 'file_write'],
  edit: ['edit', 'multiedit', 'notebookedit', 'patch', 'edit_file', 'str_replace', 'apply_patch'],
  search: ['grep', 'glob', 'ls', 'search_files', 'list_files', 'list_dir', 'find_files', 'toolsearch'],
  web: ['websearch', 'web_search'],
  fetch: ['webfetch', 'web_extract', 'web_fetch', 'fetch_url'],
  agent: ['task', 'agent', 'delegate_task', 'workflow'],
  todo: ['todowrite', 'todo_list', 'todo'],
  image: ['image_generate', 'vision_analyze', 'computer_use', 'screenshot']
}
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, names]) => names.map(n => [n, k])))

export function toolKind(name) {
  const n = str(name).toLowerCase()
  if (KIND_OF.has(n)) { return KIND_OF.get(n) }
  if (/^browser_/.test(n)) { return 'fetch' }
  return 'other'
}

/** "mcp__server__tool" → "tool (server)"; "skill_view" → "skill view". */
export function prettyName(name) {
  const n = str(name) || tr('tool')
  const m = /^mcp__(.+?)__(.+)$/.exec(n)
  if (m) { return `${m[2].replace(/[_-]+/g, ' ')} (${m[1].replace(/^plugin_/, '').replace(/_+/g, ' ')})` }
  return n.replace(/_/g, ' ')
}

const pathOf = i => str(i.file_path || i.path || i.notebook_path || i.filename || i.target_file)

/** Differences of an Edit/patch: "- old" / "+ new", and how many lines go in and out. */
function diffOf(i) {
  const pairs = Array.isArray(i.edits) ? i.edits : [{ old_string: i.old_string, new_string: i.new_string }]
  const out = []
  let add = 0
  let del = 0
  for (const e of pairs) {
    if (!e) { continue }
    const o = str(e.old_string ?? e.old_str ?? e.old)
    const n = str(e.new_string ?? e.new_str ?? e.new)
    if (!o && !n) { continue }
    if (out.length) { out.push('…') }
    const ol = o ? o.split('\n') : []
    const nl = n ? n.split('\n') : []
    // What is the same at the beginning and the end doesn't change: it goes as context (2 lines at most on
    // each side).
    let a = 0
    while (a < ol.length && a < nl.length && ol[a] === nl[a]) { a++ }
    let z = 0
    while (z < ol.length - a && z < nl.length - a && ol[ol.length - 1 - z] === nl[nl.length - 1 - z]) { z++ }
    for (const l of ol.slice(Math.max(0, a - 2), a)) { out.push('  ' + l) }
    for (const l of ol.slice(a, ol.length - z)) { out.push('- ' + l); del++ }
    for (const l of nl.slice(a, nl.length - z)) { out.push('+ ' + l); add++ }
    for (const l of ol.slice(ol.length - z, ol.length - z + 2)) { out.push('  ' + l) }
  }
  if (!out.length && str(i.patch || i.diff)) {
    const p = str(i.patch || i.diff)
    for (const l of p.split('\n')) { if (/^\+(?!\+\+)/.test(l)) { add++ } else if (/^-(?!--)/.test(l)) { del++ } }
    return { text: p, add, del }
  }
  return out.length ? { text: out.join('\n'), add, del } : null
}

/** Counts + and − in a diff that's already drawn (Hermes's "inline_diff"). */
export function diffStats(text) {
  let add = 0
  let del = 0
  for (const l of str(text).split('\n')) {
    if (/^\+(?!\+\+ )/.test(l)) { add++ } else if (/^-(?!-- )/.test(l)) { del++ }
  }
  return { add, del }
}

const TODO_MARK = { completed: '☑', in_progress: '◐', pending: '☐', cancelled: '☒' }

/**
 * What a tool did, to draw it: { kind, title, subject, box: {lang, text} | null, add, del }.
 * `b`: { name, input (object), args (short summary), diff (text, optional) }.
 */
export function describeTool(b) {
  const name = str(b && b.name)
  const kind = toolKind(name)
  const i = b && b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {}
  const short = str(b && b.args)
  const desc = oneLine(i.description || '', 120)
  let title = ''
  let subject = ''
  let box = null
  let add = 0
  let del = 0
  if (kind === 'run') {
    const cmd = str(i.command || i.cmd || i.code || i.script) || short
    subject = oneLine(cmd, 60)
    title = desc || (subject ? tr('Ran {0}', subject) : tr('Ran a command'))
    if (cmd) { box = { lang: i.code && !i.command ? 'code' : 'cmd', text: cmd } }
  } else if (kind === 'read') {
    const p = pathOf(i) || short
    subject = baseName(p)
    title = subject ? tr('Read {0}', subject) : tr('Read a file')
    if (p) { box = { lang: 'path', text: p + (i.offset || i.limit ? tr(' (lines {0}{1})', i.offset || 1, i.limit ? '–' + ((Number(i.offset) || 1) + Number(i.limit) - 1) : '…') : '') } }
  } else if (kind === 'write') {
    const p = pathOf(i) || short
    subject = baseName(p)
    title = subject ? tr('Created {0}', subject) : tr('Created a file')
    const content = str(i.content || i.text || i.file_text)
    add = lines(content)
    if (content) { box = { lang: 'code', text: content, path: p } }
  } else if (kind === 'edit') {
    const p = pathOf(i) || short
    subject = baseName(p)
    title = subject ? tr('Edited {0}', subject) : tr('Edited a file')
    const d = diffOf(i)
    if (d) { box = { lang: 'diff', text: d.text, path: p }; add = d.add; del = d.del }
  } else if (kind === 'search') {
    const pat = str(i.pattern || i.query || i.regex || i.glob || i.name) || short
    subject = oneLine(pat, 50)
    title = subject ? tr('Searched for “{0}”', subject) : tr('Searched the files')
    const where = str(i.path || i.target || i.directory)
    if (pat) { box = { lang: 'text', text: pat + (where ? tr('\nin {0}', where) : '') } }
  } else if (kind === 'web') {
    const q = str(i.query || i.q) || short
    subject = oneLine(q, 60)
    title = subject ? tr('Searched the web for “{0}”', subject) : tr('Searched the web')
  } else if (kind === 'fetch') {
    const urls = Array.isArray(i.urls) ? i.urls.map(str).filter(Boolean) : [str(i.url || i.href)].filter(Boolean)
    let host = ''
    try { host = urls[0] ? new URL(urls[0]).host : '' } catch { host = oneLine(urls[0], 50) }
    subject = host || oneLine(short, 50)
    title = /^browser_/.test(name.toLowerCase()) ? tr('Browser: {0}{1}', prettyName(name.slice(8)), subject ? ' · ' + subject : '') : (subject ? tr('Opened {0}', subject) : tr('Opened a page'))
    if (urls.length) { box = { lang: 'text', text: urls.join('\n') } } else if (i.prompt) { box = { lang: 'text', text: str(i.prompt) } }
  } else if (kind === 'agent') {
    const what = oneLine(i.description || i.goal || i.task || i.prompt || short, 90)
    subject = what
    title = what ? tr('Agent: {0}', what) : tr('Launched an agent')
    const prompt = str(i.prompt || i.context || i.goal || i.task)
    if (prompt) { box = { lang: 'text', text: prompt } }
  } else if (kind === 'todo') {
    title = tr('Updated the task list')
    const todos = Array.isArray(i.todos) ? i.todos : []
    if (todos.length) { box = { lang: 'text', text: todos.map(t => `${TODO_MARK[t && t.status] || '☐'} ${str(t && (t.content || t.activeForm))}`).join('\n') } }
  } else if (kind === 'image') {
    const n = name.toLowerCase()
    subject = oneLine(i.prompt || i.question || i.image_url || i.path || short, 70)
    title = n === 'image_generate' ? tr('Generated an image') : n === 'computer_use' ? tr('Used the desktop{0}', subject ? ' · ' + subject : '') : tr('Looked at an image')
    if (i.prompt || i.question) { box = { lang: 'text', text: str(i.prompt || i.question) } }
  } else {
    subject = prettyName(name)
    title = desc || tr('Used {0}{1}', subject, short ? ' · ' + oneLine(short, 60) : '')
    const keys = Object.keys(i).filter(k => k !== 'description')
    if (keys.length) { try { box = { lang: 'json', text: JSON.stringify(Object.fromEntries(keys.map(k => [k, i[k]])), null, 2) } } catch {} }
  }
  // Hermes sends the change already drawn (inline_diff): it wins over the calculated one.
  if (b && str(b.diff)) {
    const st = diffStats(b.diff)
    box = { lang: 'diff', text: str(b.diff), path: box && box.path }
    add = st.add
    del = st.del
  }
  return { kind, title, subject, box, add, del }
}

// How each kind is told in the summary (in the past, and while it's running).
const PHRASE = {
  run: [n => (n === 1 ? tr('ran a command') : tr('ran {0} commands', n)), n => (n === 1 ? tr('running a command') : tr('running {0} commands', n))],
  read: [(n, s) => (n === 1 ? (s ? tr('read {0}', s) : tr('read a file')) : tr('read {0} files', n)), (n, s) => (n === 1 ? (s ? tr('reading {0}', s) : tr('reading a file')) : tr('reading {0} files', n))],
  write: [(n, s) => (n === 1 ? (s ? tr('created {0}', s) : tr('created a file')) : tr('created {0} files', n)), (n, s) => (n === 1 ? (s ? tr('creating {0}', s) : tr('creating a file')) : tr('creating {0} files', n))],
  edit: [(n, s) => (n === 1 ? (s ? tr('edited {0}', s) : tr('edited a file')) : tr('edited {0} files', n)), (n, s) => (n === 1 ? (s ? tr('editing {0}', s) : tr('editing a file')) : tr('editing {0} files', n))],
  search: [n => (n === 1 ? tr('made a search') : tr('made {0} searches', n)), n => (n === 1 ? tr('searching') : tr('making {0} searches', n))],
  web: [n => (n === 1 ? tr('searched the web') : tr('searched the web {0} times', n)), () => tr('searching the web')],
  fetch: [n => (n === 1 ? tr('opened a page') : tr('opened {0} pages', n)), n => (n === 1 ? tr('opening a page') : tr('opening {0} pages', n))],
  agent: [n => (n === 1 ? tr('launched an agent') : tr('launched {0} agents', n)), n => (n === 1 ? tr('with an agent') : tr('with {0} agents', n))],
  todo: [() => tr('updated the tasks'), () => tr('updating the tasks')],
  image: [n => (n === 1 ? tr('used an image') : tr('used {0} images', n)), () => tr('with an image')]
}
const ORDER = ['run', 'read', 'write', 'edit', 'search', 'web', 'fetch', 'agent', 'image', 'todo', 'other']

/**
 * Summary of consecutive tools: { text, add, del, failed, running }.
 * A single tool: its title (the description Claude gave, if any).
 */
export function groupSummary(tools) {
  const list = (Array.isArray(tools) ? tools : []).filter(Boolean)
  const ds = list.map(t => ({ t, d: describeTool(t) }))
  const add = ds.reduce((n, x) => n + (x.d.add || 0), 0)
  const del = ds.reduce((n, x) => n + (x.d.del || 0), 0)
  const failed = list.filter(t => t.error).length
  const running = list.filter(t => !t.done).length
  if (ds.length === 1) {
    const { t, d } = ds[0]
    const text = !t.done && !str(t.input && t.input.description) && PHRASE[d.kind] ? cap(PHRASE[d.kind][1](1, d.subject)) : d.title
    return { text, add, del, failed, running }
  }
  const by = new Map()
  for (const x of ds) {
    const k = x.d.kind
    if (!by.has(k)) { by.set(k, []) }
    by.get(k).push(x)
  }
  const parts = []
  for (const k of ORDER) {
    const xs = by.get(k)
    if (!xs) { continue }
    if (k === 'other') {
      const names = [...new Set(xs.map(x => x.d.subject))]
      parts.push(names.length > 2 ? tr('used {0} and {1} more', names.slice(0, 2).join(', '), names.length - 2) : tr('used {0}', names.join(tr(' and '))))
      continue
    }
    const subjects = [...new Set(xs.map(x => x.d.subject).filter(Boolean))]
    const busy = xs.some(x => !x.t.done)
    // Files: the different ones that are seen; if one doesn't bring its path yet, the calls are counted.
    const n = ['read', 'write', 'edit'].includes(k) ? (xs.every(x => x.d.subject) ? subjects.length : xs.length) : xs.length
    parts.push(PHRASE[k][busy ? 1 : 0](n, subjects.length === 1 ? subjects[0] : ''))
  }
  return { text: cap(parts.join(', ')), add, del, failed, running }
}

/** "1 failed" / "2 failed". */
export function failedText(n) { return n === 1 ? tr('1 failed') : tr('{0} failed', n) }
