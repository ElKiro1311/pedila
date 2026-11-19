// Herramientas como en Claude Code: qué hizo cada una (título, lo que se le pasó, cuántas líneas
// cambió) y el resumen de un grupo de herramientas seguidas («Ejecutó 2 órdenes, leyó a.png»).
// Sirve para Claude Code y para Hermes: cada uno llama a sus herramientas de otra forma.
// Sin DOM: se prueba con node.

const str = v => (typeof v === 'string' ? v : '')
const baseName = p => { const s = str(p).replace(/[\\/]+$/, ''); return s.split(/[\\/]/).pop() || s }
const oneLine = (s, n = 70) => { const t = str(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const lines = s => (str(s) ? str(s).replace(/\n$/, '').split('\n').length : 0)
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

// Nombre de la herramienta (Claude Code o Hermes) → qué clase de cosa hace.
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

/** «mcp__servidor__herramienta» → «herramienta (servidor)»; «skill_view» → «skill view». */
export function prettyName(name) {
  const n = str(name) || 'herramienta'
  const m = /^mcp__(.+?)__(.+)$/.exec(n)
  if (m) { return `${m[2].replace(/[_-]+/g, ' ')} (${m[1].replace(/^plugin_/, '').replace(/_+/g, ' ')})` }
  return n.replace(/_/g, ' ')
}

const pathOf = i => str(i.file_path || i.path || i.notebook_path || i.filename || i.target_file)

/** Diferencias de un Edit/patch: «- viejo» / «+ nuevo», y cuántas líneas entran y salen. */
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
    // Lo igual al principio y al final no cambia: va como contexto (como mucho 2 líneas a cada lado).
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

/** Cuenta + y − de un diff ya dibujado (el «inline_diff» de Hermes). */
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
 * Qué hizo una herramienta, para dibujarla: { kind, title, subject, box: {lang, text} | null, add, del }.
 * `b`: { name, input (objeto), args (resumen corto), diff (texto, opcional) }.
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
    title = desc || (subject ? `Ejecutó ${subject}` : 'Ejecutó una orden')
    if (cmd) { box = { lang: i.code && !i.command ? 'code' : 'cmd', text: cmd } }
  } else if (kind === 'read') {
    const p = pathOf(i) || short
    subject = baseName(p)
    title = subject ? `Leyó ${subject}` : 'Leyó un archivo'
    if (p) { box = { lang: 'path', text: p + (i.offset || i.limit ? ` (líneas ${i.offset || 1}${i.limit ? '–' + ((Number(i.offset) || 1) + Number(i.limit) - 1) : '…'})` : '') } }
  } else if (kind === 'write') {
    const p = pathOf(i) || short
    subject = baseName(p)
    title = subject ? `Creó ${subject}` : 'Creó un archivo'
    const content = str(i.content || i.text || i.file_text)
    add = lines(content)
    if (content) { box = { lang: 'code', text: content, path: p } }
  } else if (kind === 'edit') {
    const p = pathOf(i) || short
    subject = baseName(p)
    title = subject ? `Editó ${subject}` : 'Editó un archivo'
    const d = diffOf(i)
    if (d) { box = { lang: 'diff', text: d.text, path: p }; add = d.add; del = d.del }
  } else if (kind === 'search') {
    const pat = str(i.pattern || i.query || i.regex || i.glob || i.name) || short
    subject = oneLine(pat, 50)
    title = subject ? `Buscó «${subject}»` : 'Buscó en los archivos'
    const where = str(i.path || i.target || i.directory)
    if (pat) { box = { lang: 'text', text: pat + (where ? `\nen ${where}` : '') } }
  } else if (kind === 'web') {
    const q = str(i.query || i.q) || short
    subject = oneLine(q, 60)
    title = subject ? `Buscó en internet «${subject}»` : 'Buscó en internet'
  } else if (kind === 'fetch') {
    const urls = Array.isArray(i.urls) ? i.urls.map(str).filter(Boolean) : [str(i.url || i.href)].filter(Boolean)
    let host = ''
    try { host = urls[0] ? new URL(urls[0]).host : '' } catch { host = oneLine(urls[0], 50) }
    subject = host || oneLine(short, 50)
    title = /^browser_/.test(name.toLowerCase()) ? `Navegador: ${prettyName(name.slice(8))}${subject ? ' · ' + subject : ''}` : (subject ? `Abrió ${subject}` : 'Abrió una página')
    if (urls.length) { box = { lang: 'text', text: urls.join('\n') } } else if (i.prompt) { box = { lang: 'text', text: str(i.prompt) } }
  } else if (kind === 'agent') {
    const what = oneLine(i.description || i.goal || i.task || i.prompt || short, 90)
    subject = what
    title = what ? `Agente: ${what}` : 'Lanzó un agente'
    const prompt = str(i.prompt || i.context || i.goal || i.task)
    if (prompt) { box = { lang: 'text', text: prompt } }
  } else if (kind === 'todo') {
    title = 'Actualizó la lista de tareas'
    const todos = Array.isArray(i.todos) ? i.todos : []
    if (todos.length) { box = { lang: 'text', text: todos.map(t => `${TODO_MARK[t && t.status] || '☐'} ${str(t && (t.content || t.activeForm))}`).join('\n') } }
  } else if (kind === 'image') {
    const n = name.toLowerCase()
    subject = oneLine(i.prompt || i.question || i.image_url || i.path || short, 70)
    title = n === 'image_generate' ? 'Generó una imagen' : n === 'computer_use' ? `Usó el escritorio${subject ? ' · ' + subject : ''}` : 'Miró una imagen'
    if (i.prompt || i.question) { box = { lang: 'text', text: str(i.prompt || i.question) } }
  } else {
    subject = prettyName(name)
    title = desc || `Usó ${subject}${short ? ' · ' + oneLine(short, 60) : ''}`
    const keys = Object.keys(i).filter(k => k !== 'description')
    if (keys.length) { try { box = { lang: 'json', text: JSON.stringify(Object.fromEntries(keys.map(k => [k, i[k]])), null, 2) } } catch {} }
  }
  // Hermes manda el cambio ya dibujado (inline_diff): manda sobre el calculado.
  if (b && str(b.diff)) {
    const st = diffStats(b.diff)
    box = { lang: 'diff', text: str(b.diff), path: box && box.path }
    add = st.add
    del = st.del
  }
  return { kind, title, subject, box, add, del }
}

// Cómo se cuenta cada clase en el resumen (en pasado y mientras está en marcha).
const PHRASE = {
  run: [n => (n === 1 ? 'ejecutó una orden' : `ejecutó ${n} órdenes`), n => (n === 1 ? 'ejecutando una orden' : `ejecutando ${n} órdenes`)],
  read: [(n, s) => (n === 1 ? (s ? `leyó ${s}` : 'leyó un archivo') : `leyó ${n} archivos`), (n, s) => (n === 1 ? (s ? `leyendo ${s}` : 'leyendo un archivo') : `leyendo ${n} archivos`)],
  write: [(n, s) => (n === 1 ? (s ? `creó ${s}` : 'creó un archivo') : `creó ${n} archivos`), (n, s) => (n === 1 ? (s ? `creando ${s}` : 'creando un archivo') : `creando ${n} archivos`)],
  edit: [(n, s) => (n === 1 ? (s ? `editó ${s}` : 'editó un archivo') : `editó ${n} archivos`), (n, s) => (n === 1 ? (s ? `editando ${s}` : 'editando un archivo') : `editando ${n} archivos`)],
  search: [n => (n === 1 ? 'hizo una búsqueda' : `hizo ${n} búsquedas`), n => (n === 1 ? 'buscando' : `haciendo ${n} búsquedas`)],
  web: [n => (n === 1 ? 'buscó en internet' : `buscó en internet ${n} veces`), () => 'buscando en internet'],
  fetch: [n => (n === 1 ? 'abrió una página' : `abrió ${n} páginas`), n => (n === 1 ? 'abriendo una página' : `abriendo ${n} páginas`)],
  agent: [n => (n === 1 ? 'lanzó un agente' : `lanzó ${n} agentes`), n => (n === 1 ? 'con un agente' : `con ${n} agentes`)],
  todo: [() => 'actualizó las tareas', () => 'actualizando las tareas'],
  image: [n => (n === 1 ? 'usó una imagen' : `usó ${n} imágenes`), () => 'con una imagen']
}
const ORDER = ['run', 'read', 'write', 'edit', 'search', 'web', 'fetch', 'agent', 'image', 'todo', 'other']

/**
 * Resumen de herramientas seguidas: { text, add, del, failed, running }.
 * Una sola herramienta: su título (la descripción que puso Claude, si la hay).
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
      parts.push(names.length > 2 ? `usó ${names.slice(0, 2).join(', ')} y ${names.length - 2} más` : `usó ${names.join(' y ')}`)
      continue
    }
    const subjects = [...new Set(xs.map(x => x.d.subject).filter(Boolean))]
    const busy = xs.some(x => !x.t.done)
    // Archivos: los distintos que se ven; si alguno aún no trae su ruta, se cuentan las llamadas.
    const n = ['read', 'write', 'edit'].includes(k) ? (xs.every(x => x.d.subject) ? subjects.length : xs.length) : xs.length
    parts.push(PHRASE[k][busy ? 1 : 0](n, subjects.length === 1 ? subjects[0] : ''))
  }
  return { text: cap(parts.join(', ')), add, del, failed, running }
}

/** «1 falló» / «2 fallaron». */
export function failedText(n) { return n === 1 ? '1 falló' : `${n} fallaron` }
