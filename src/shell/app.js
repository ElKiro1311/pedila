// Pedila: la pantalla. Sin Node; habla con el proceso principal por window.hp (preload).
import { Pet, loadSheet } from './pet.js'
import { createTerms } from './terms.js'
import { describeTool, groupSummary, failedText } from './tools.mjs'
import { kfmt, setHour12, hhmm, full, dayLabel, span, ago, tokensOf, modelName, tasksLine, usd, nextUtcReset, dayAhead } from './fmt.mjs'

const demo = new URLSearchParams(location.search).get('demo') === '1'
const api = demo ? (await import('./demo.js')).demoApi : window.hp
const $ = sel => document.querySelector(sel)
const CONN_NAMES = { local: 'Este PC', server: 'Servidor', claude: 'Claude Code' }
// Quién contesta en cada conexión: Claude Code en «Claude», Hermes en las demás.
const WHO = conn => (conn === 'claude' ? 'Claude' : 'Hermes')
const CHOICE_LABELS = { once: 'Permitir una vez', session: 'Permitir en este chat', always: 'Permitir siempre', deny: 'Denegar' }

// ── Estado ───────────────────────────────────────────────────────────────────────────────────
const S = {
  settings: null,
  dark: true,
  version: '',
  conns: { local: { state: 'off', detail: '' }, server: { state: 'off', detail: '' }, claude: { state: 'off', detail: '' } },
  active: 'local',
  sessions: { local: [], server: [], claude: [] },
  listLoaded: { local: false, server: false, claude: false },
  listError: { local: '', server: '', claude: '' },
  current: { conn: 'local', sid: null },
  chats: new Map(),
  modelChoice: { local: null, server: null, claude: null },
  models: { local: null, server: null, claude: null },
  // Carpeta del próximo chat nuevo de Claude y lo último que dijo Claude de tu cuota.
  claudeDir: '',
  claudeLimits: null,
  // Las conversaciones de Claude abiertas ahora mismo (en una consola o en otra ventana): id → estado.
  claudeOpen: new Map(),
  search: '',
  found: { local: [], server: [], claude: [] },
  attach: [],
  readOnly: false,
  reasoning: '',
  ctxHidden: new Set()
}

const key = (conn, sid) => `${conn}|${sid}`

function chat(conn, sid) {
  const k = key(conn, sid)
  if (!S.chats.has(k)) {
    S.chats.set(k, { conn, sid, title: '', transcript: [], loaded: false, live: null, running: false, prompts: new Map(), model: '', usage: null, todos: null, subagents: new Map() })
  }
  return S.chats.get(k)
}

const currentChat = () => (S.current.sid ? chat(S.current.conn, S.current.sid) : null)

async function call(fn, ...args) {
  const r = await fn(...args)
  if (r && r.ok === false) {
    const e = new Error(r.error || 'Error')
    e.needLogin = Boolean(r.needLogin)
    throw e
  }
  return r ? r.value : undefined
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) { continue }
    if (k === 'class') { n.className = v } else if (k === 'text') { n.textContent = v } else if (k.startsWith('on')) { n.addEventListener(k.slice(2), v) } else { n.setAttribute(k, v === true ? '' : v) }
  }
  for (const kid of kids.flat()) { if (kid !== null && kid !== undefined && kid !== false) { n.append(kid) } }
  return n
}

// Hermes entrega las imágenes (image_generate, capturas…) con una línea «MEDIA:<ruta>». Esa línea se
// cambia por un hueco que fillMedia llena con la imagen, pedida al gateway de esa conexión.
const MEDIA_LINE = /^[ \t]*`?MEDIA:[ \t]*(\S[^\n`]*?\.(?:png|jpe?g|gif|webp|bmp))`?[ \t]*$/gim

function md(text) {
  const src = String(text || '').replace(MEDIA_LINE, (_, p) => `\n\n<div class="media-img" data-media="${encodeURIComponent(p.trim())}"></div>\n\n`)
  const html = window.marked.parse(src, { gfm: true, breaks: true })
  return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] })
}

// Imágenes ya traídas, por conexión y ruta: una promesa mientras llega, luego el data URL (o null si falló;
// el fallo se olvida a los 30 s para reintentar). Así los repintados del chat en vivo no las vuelven a pedir.
const mediaCache = new Map()

function fillMedia(root, conn) {
  for (const box of root.querySelectorAll('.media-img[data-media]')) {
    let file
    try { file = decodeURIComponent(box.dataset.media) } catch { continue }
    const name = file.split(/[\\/]/).pop()
    const show = url => {
      box.replaceChildren()
      box.classList.remove('loading')
      if (!url) {
        // En el detalle de una herramienta, si no se puede enseñar, no se enseña (sin error).
        if (box.dataset.quiet !== undefined) { box.remove(); return }
        box.classList.add('fail')
        box.textContent = `🖼 No pude cargar la imagen ${name}`
        return
      }
      const img = el('img', { src: url, alt: name, title: name })
      img.addEventListener('click', () => openImage(url, name))
      box.append(img)
    }
    const k = conn + '\n' + file
    let c = mediaCache.get(k)
    if (typeof c === 'string' || c === null) { show(c); continue }
    box.classList.add('loading')
    box.textContent = 'Cargando imagen…'
    if (!c) {
      c = call(api.media, conn, file).catch(() => null).then(url => {
        mediaCache.set(k, url || null)
        if (!url) { setTimeout(() => { if (mediaCache.get(k) === null) { mediaCache.delete(k) } }, 30000) }
        return url || null
      })
      mediaCache.set(k, c)
    }
    c.then(show)
  }
}

/** La imagen a pantalla completa; un clic o Esc la cierra. */
function openImage(url, name) {
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true) }
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  const box = el('div', { class: 'image-view', role: 'dialog', 'aria-label': name, onclick: close }, el('img', { src: url, alt: name }))
  document.addEventListener('keydown', onKey, true)
  document.body.append(box)
}

function decorate(root) {
  for (const a of root.querySelectorAll('a[href]')) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer') }
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector('.copy')) { continue }
    const b = el('button', { class: 'copy', text: 'Copiar' })
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText).then(() => { b.textContent = 'Copiado' ; setTimeout(() => { b.textContent = 'Copiar' }, 1200) }).catch(() => { b.textContent = 'No se pudo' })
    })
    pre.append(b)
  }
}

function toMs(v) {
  if (v === null || v === undefined || v === '') { return 0 }
  if (typeof v === 'number') { return v < 1e12 ? v * 1000 : v }
  const n = Number(v)
  if (Number.isFinite(n)) { return n < 1e12 ? n * 1000 : n }
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : 0
}

function groupOf(ms) {
  if (!ms) { return 'Anteriores' }
  const d = new Date(ms)
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= start) { return 'Hoy' }
  if (ms >= start - 86400000) { return 'Ayer' }
  if (ms >= start - 6 * 86400000) { return 'Últimos 7 días' }
  if (d.getFullYear() === now.getFullYear()) { return d.toLocaleDateString('es', { month: 'long' }).replace(/^\w/, c => c.toUpperCase()) }
  return String(d.getFullYear())
}

// ── Aspecto ──────────────────────────────────────────────────────────────────────────────────
// Temas (paletas). El primero es el predeterminado; «Clásico» es el de las primeras versiones.
const PALETTES = [
  { id: 'mensajera', name: 'Mensajera', desc: 'Tinta, grises y oro, como Pedila.', pet: true },
  { id: 'clasico', name: 'Clásico', desc: 'El de siempre: grises fríos y violeta.' },
  { id: 'egeo', name: 'Egeo', desc: 'Azul noche del mar y oro.' },
  { id: 'anfora', name: 'Ánfora', desc: 'Negro y terracota, como la cerámica griega.' },
  { id: 'olivo', name: 'Olivo', desc: 'Verdes de olivar, tranquilos.' },
  { id: 'claude', name: 'Claude', desc: 'Pizarra, marfil y terracota, como Claude.' }
]

function lookMode() {
  const L = S.settings.look
  return L.theme === 'system' ? (S.dark ? 'dark' : 'light') : L.theme
}

/** Las tarjetas del menú de temas: cada una se pinta con su paleta, en el modo actual. */
function renderThemeGrid() {
  const grid = $('#theme-grid')
  if (!grid) { return }
  const mode = lookMode()
  if (!grid.childElementCount) {
    for (const p of PALETTES) {
      const card = el('button', { class: 'theme-card', role: 'radio', 'data-palette': p.id, title: p.name },
        el('div', { class: 'tp' },
          el('div', { class: 'tp-side' }, el('i'), el('i'), el('i'), el('i')),
          el('div', { class: 'tp-main' }, el('div', { class: 'tp-b in' }), el('div', { class: 'tp-b out' }), el('div', { class: 'tp-b in' }),
            p.pet ? el('div', { class: 'tp-pet' }) : null,
            el('div', { class: 'tp-in' }, el('span', { class: 'tp-send' })))),
        el('div', { class: 'theme-meta' },
          el('span', { class: 'theme-name' }, p.name, p.id === PALETTES[0].id ? el('em', {}, 'predeterminado') : null),
          el('span', { class: 'theme-desc' }, p.desc),
          el('span', { class: 'theme-dots' }, el('span', { style: 'background: var(--bg)' }), el('span', { style: 'background: var(--surface-2)' }), el('span', { style: 'background: var(--text)' }), el('span', { style: 'background: var(--accent)' }))))
      // Al elegir un tema se vuelve a su color de acento.
      card.addEventListener('click', () => saveSetting({ look: { palette: p.id, accent: 'tema' } }))
      grid.append(card)
    }
  }
  for (const card of grid.children) {
    card.dataset.mode = mode
    const on = card.dataset.palette === S.settings.look.palette
    card.classList.toggle('active', on)
    card.setAttribute('aria-checked', String(on))
    const pet = card.querySelector('.tp-pet')
    if (pet) { pet.style.backgroundImage = `url("${PEDILA_SHEET}")` }
  }
}

function applyLook() {
  const L = S.settings.look
  const mode = lookMode()
  document.documentElement.dataset.palette = L.palette
  document.documentElement.dataset.mode = mode
  document.documentElement.dataset.accent = L.accent
  document.documentElement.style.setProperty('--scale', String(L.textSize / 100))
  $('#pet-stage').hidden = !S.settings.pet.visible
  $('#pet').className = S.settings.pet.size === 'normal' ? '' : S.settings.pet.size
  applyPanel()
  terms.applyLook()
  applyLayout()
}

// ── Conexiones ───────────────────────────────────────────────────────────────────────────────
/**
 * Los Hermes que esta persona tiene: el de este PC si está instalado y el del servidor si puso su
 * dirección en Ajustes. Los demás no se enseñan (ni pestaña, ni tarjeta, ni bandeja). Si no tiene
 * ninguno, queda «Este PC» con el aviso de cómo empezar.
 */
function visibleConns() {
  const v = []
  if (S.conns.local && S.conns.local.state !== 'missing') { v.push('local') }
  if (S.settings && S.settings.server && Array.isArray(S.settings.server.urls) && S.settings.server.urls.length) { v.push('server') }
  // Claude Code, si está instalado en este PC.
  if (S.conns.claude && !['missing', 'off'].includes(S.conns.claude.state)) { v.push('claude') }
  // El orden y lo escondido de Ajustes → Diseño (si lo escondes todo, queda la primera que tienes).
  const L = layout()
  const shown = L.conns.filter(c => v.includes(c) && !L.connsHidden.includes(c))
  return shown.length ? shown : (v.length ? [v[0]] : ['local'])
}

function renderConnSwitch() {
  schedulePanel()
  const vis = visibleConns()
  // Con un solo Hermes no hace falta elegir: el selector entero se esconde.
  $('#conn-switch').hidden = vis.length < 2
  for (const b of document.querySelectorAll('#usage-tabs button')) { b.hidden = !vis.includes(b.dataset.conn) }
  if (!vis.includes(S.active)) { switchConn(vis[0]); return }
  const box = $('#conn-switch')
  for (const c of layout().conns) { const b = box.querySelector(`button[data-conn="${c}"]`); if (b) { box.append(b) } }
  for (const b of document.querySelectorAll('#conn-switch button')) {
    const c = b.dataset.conn
    b.hidden = !vis.includes(c)
    b.classList.toggle('active', c === S.active)
    const dot = b.querySelector('.dot')
    dot.className = 'dot ' + S.conns[c].state
    b.title = connLabel(c)
  }
}

function connLabel(c) {
  const st = S.conns[c]
  const what = { ready: c === 'claude' ? 'listo' : 'conectado', connecting: 'conectando…', offline: 'sin conexión', login: 'falta iniciar sesión', setup: 'falta su dirección', missing: c === 'claude' ? 'sin Claude Code instalado' : 'sin Hermes instalado', error: 'error', off: 'apagado' }[st.state] || st.state
  return `${CONN_NAMES[c]}: ${what}${st.detail && st.state !== 'ready' ? ' — ' + st.detail : ''}`
}

function renderBanner() {
  const b = $('#banner')
  const st = S.conns[S.active]
  b.className = ''
  b.replaceChildren()
  if (st.state === 'missing' && S.active === 'claude') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: 'No encuentro Claude Code en este PC. ' }), el('span', { class: 'muted', text: 'Instálalo (el programa «claude») y vuelve a abrir Pedila.' })))
  } else if (st.state === 'missing') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: 'No encuentro Hermes en este PC. ' }), el('span', { class: 'muted', text: 'Instálalo aquí, o si tu Hermes está en otro equipo pon su dirección en Ajustes → Servidor.' })),
      el('button', { class: 'btn-primary', text: 'Abrir Ajustes', onclick: () => openSettings('servidor') }))
  } else if (st.state === 'login') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: 'Falta iniciar sesión en el Hermes del servidor. ' }), el('span', { class: 'muted', text: st.detail && !/^Hay que/.test(st.detail) ? st.detail : 'Usa el usuario y la contraseña de su página web.' })),
      el('button', { class: 'btn-primary', text: 'Iniciar sesión', onclick: openLogin }))
  } else if (st.state === 'setup') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: 'Falta la dirección de tu servidor. ' }), el('span', { class: 'muted', text: 'Ponla en Ajustes → Servidor (la de su página web de Hermes, por ejemplo http://192.168.1.50:9119).' })),
      el('button', { class: 'btn-primary', text: 'Abrir Ajustes', onclick: () => openSettings('servidor') }))
  } else if (st.state === 'offline' || st.state === 'error') {
    b.className = st.state
    b.append(el('div', { class: 'grow' }, el('strong', { text: `Sin conexión con ${CONN_NAMES[S.active]}. ` }), el('span', { class: 'muted', text: st.detail || '' })),
      el('button', { class: 'btn-ghost', text: 'Reintentar', onclick: () => call(api.retry, S.active).catch(() => {}) }))
  } else if (st.state === 'connecting' && st.detail) {
    b.append(el('div', { class: 'grow muted', text: `Conectando con ${CONN_NAMES[S.active]}… ${st.detail}` }))
  } else {
    b.hidden = true
    return
  }
  b.hidden = false
}

async function switchConn(c) {
  if (S.active === c) { return }
  S.active = c
  watchClaudeList()
  renderConnSwitch()
  renderBanner()
  newChatView()
  call(api.settings, { lastConnection: c }).catch(() => {})
  await loadSessions(c)
}

// ── Lista de chats ───────────────────────────────────────────────────────────────────────────
let listTimer = null
function reloadSessionsSoon(conn) {
  clearTimeout(listTimer)
  listTimer = setTimeout(() => loadSessions(conn), 700)
}

async function loadSessions(conn = S.active) {
  try {
    const rows = await call(api.sessions, conn)
    S.sessions[conn] = rows
    S.listError[conn] = ''
    for (const r of rows) {
      const ch = chat(conn, r.id)
      if (!ch.title) { ch.title = r.title }
      // Claude dice qué chats trabajan (también los reenganchados al abrir Pedila, cuyo comienzo no
      // vio la pantalla). Los que se siguen en directo desde aquí mandan sus propios avisos.
      if (conn === 'claude' && typeof r.running === 'boolean' && (!ch.live || ch.live.done)) { ch.running = r.running }
    }
  } catch (e) {
    S.listError[conn] = e.needLogin ? 'login' : S.conns[conn].state === 'setup' ? 'setup' : e.message
  }
  S.listLoaded[conn] = true
  if (conn === S.active) { renderList() }
  // El panel usa la lista (mensajes del chat, abrir la última tarea).
  schedulePanel()
}

function renderList() {
  const nav = $('#chat-list')
  nav.replaceChildren()
  const conn = S.active
  if (S.listError[conn] === 'login') {
    nav.append(el('div', { class: 'list-empty', text: 'Inicia sesión para ver los chats del servidor.' }))
    return
  }
  if (S.listError[conn] === 'setup') {
    nav.append(el('div', { class: 'list-empty', text: 'Pon la dirección de tu servidor en Ajustes → Servidor para ver sus chats.' }))
    return
  }
  if (S.listError[conn]) {
    nav.append(el('div', { class: 'list-empty', text: `No pude cargar los chats: ${S.listError[conn]}` }))
    return
  }
  if (!S.listLoaded[conn]) {
    nav.append(el('div', { class: 'list-empty', text: 'Cargando chats…' }))
    return
  }
  const q = S.search.trim().toLowerCase()
  const rows = S.sessions[conn]
    .map(r => ({ ...r, title: chat(conn, r.id).title || r.title, ms: toMs(r.lastActive) }))
    .filter(r => !q || r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q))
    .sort((a, b) => b.ms - a.ms)
  if (!rows.length && !(q.length >= 3 && S.found[conn].length)) {
    nav.append(el('div', { class: 'list-empty', text: q ? (q.length >= 3 ? 'Ningún chat coincide (buscando también en el contenido…).' : 'Ningún chat coincide.') : 'Todavía no hay chats aquí. Escribe algo para empezar.' }))
    if (!q) { nav.append(el('button', { class: 'archived-link', text: '🗄 Ver chats archivados', onclick: () => openArchived() })) }
    return
  }
  let group = null
  const pinned = rows.filter(r => r.pinned)
  if (pinned.length) { nav.append(el('div', { class: 'group-label', text: '📌 Fijados' })); for (const r of pinned) { nav.append(chatRow(conn, r)) } }
  for (const r of rows.filter(x => !x.pinned)) {
    const g = groupOf(r.ms)
    if (g !== group) { group = g; nav.append(el('div', { class: 'group-label', text: g })) }
    nav.append(chatRow(conn, r))
  }
  if (q.length >= 3 && S.found[conn].length) {
    nav.append(el('div', { class: 'group-label', text: '🔎 En el contenido' }))
    for (const h of S.found[conn].slice(0, 30)) {
      const known = S.sessions[conn].find(x => x.id === h.id)
      const row = el('button', { class: 'chat-row found', title: h.snippet },
        el('div', { class: 't' }, el('span', { text: (known && (chat(conn, h.id).title || known.title)) || 'Chat' })),
        el('div', { class: 'p', text: h.snippet }))
      row.addEventListener('click', () => openChat(conn, h.id))
      nav.append(row)
    }
  }
  nav.append(el('button', { class: 'archived-link', text: '🗄 Ver chats archivados', onclick: () => openArchived() }))
}

function chatRow(conn, r) {
  const ch = chat(conn, r.id)
  const running = ch.running || (ch.live && !ch.live.done)
  const row = el('button', { class: 'chat-row' + (S.current.conn === conn && S.current.sid === r.id ? ' active' : ''), title: r.title },
    el('div', { class: 't' }, running ? el('span', { class: 'run' }) : null, el('span', { text: r.title }), activeBadge(conn, r, running)),
    r.preview ? el('div', { class: 'p', text: r.preview }) : null)
  row.addEventListener('click', () => openChat(conn, r.id))
  row.addEventListener('contextmenu', e => { e.preventDefault(); openChatMenu(conn, r.id, e.clientX, e.clientY) })
  const more = el('button', { class: 'row-more', title: 'Más opciones', 'aria-label': 'Más opciones', text: '⋯' })
  more.addEventListener('click', e => { e.stopPropagation(); const b = more.getBoundingClientRect(); openChatMenu(conn, r.id, b.right, b.bottom) })
  return el('div', { class: 'chat-row-wrap' }, row, more)
}

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────
function setTopbar() {
  if (terms.mode === 'terms') {
    const t = terms.topbar()
    $('#chat-title').textContent = t.title
    $('#chat-meta').textContent = t.meta
    $('#chat-actions').hidden = true
    $('#term-close').hidden = !t.canClose
    $('#ctx-warn').hidden = true
    document.title = `${t.title} · Pedila`
    schedulePanel()
    return
  }
  const ch = currentChat()
  $('#chat-title').textContent = ch ? (ch.title || 'Chat') : 'Nuevo chat'
  const bits = [CONN_NAMES[S.current.conn]]
  if (ch && ch.model) { bits.push(ch.model) }
  if (ch && ch.usage && ch.usage.used && ch.usage.max) { bits.push(`contexto ${kfmt(ch.usage.used)} / ${kfmt(ch.usage.max)}`) }
  $('#chat-meta').textContent = bits.join(' · ')
  $('#chat-actions').hidden = !ch
  $('#term-close').hidden = true
  const pct = ch && ch.usage && ch.usage.used && ch.usage.max ? Math.min(100, Math.round(ch.usage.used / ch.usage.max * 100)) : 0
  const bar = $('#ctx-bar')
  bar.hidden = !pct
  bar.firstElementChild.style.width = pct + '%'
  bar.classList.toggle('warn', pct >= 80)
  bar.title = pct ? `Memoria del chat: ${pct} % (Hermes resume lo antiguo al 85 %)` : ''
  const warn = $('#ctx-warn')
  warn.hidden = !(ch && pct >= 80 && !S.ctxHidden.has(key(ch.conn, ch.sid)))
  if (!warn.hidden) { $('#ctx-warn-text').textContent = `Este chat va por el ${pct} % de su memoria. Si cambias de tema, mejor sigue en uno nuevo.` }
  document.title = ch && ch.title ? `${ch.title} · Pedila` : 'Pedila'
  schedulePanel()
}

function newChatView() {
  S.current = { conn: S.active, sid: null }
  call(api.viewing, S.active, null, '').catch(() => {})
  setTopbar()
  renderChat()
  renderList()
  updateComposer()
  updateModelPill()
  updateExtrasPills()
  ensureModelDefault(S.active)
  $('#input').focus()
}

async function openChat(conn, sid) {
  if (conn !== S.active) {
    S.active = conn
    renderConnSwitch()
    renderBanner()
    await loadSessions(conn)
  }
  S.current = { conn, sid }
  const ch = chat(conn, sid)
  loadChatOptions(ch)
  setTopbar()
  renderList()
  call(api.viewing, conn, sid, ch.title).catch(() => {})
  renderChat()
  updateComposer()
  updateModelPill()
  try {
    const turns = await call(api.transcript, conn, sid)
    const L = ch.live
    if (conn === 'claude' && L && !L.done && L.startedAt) {
      // Con un turno en directo (p. ej., al volver a este chat a mitad de respuesta), lo que ya guardó
      // Claude de ese turno no se repite: lo enseña el turno en directo. Al acabar se relee entero.
      ch.transcript = turns.filter(t => !(t.role === 'assistant' && t.ts && Date.parse(t.ts) >= L.startedAt - 1000))
      ch.resumed = true
    } else {
      ch.transcript = turns
    }
    ch.loaded = true
  } catch (e) {
    ch.loaded = true
    ch.loadError = e.message
  }
  if (S.current.sid === sid) { renderChat(true) }
  if (conn === 'claude') { ch.optsLoaded = false; loadChatOptions(ch) }
  const row = S.sessions[conn].find(r => r.id === sid)
  if (row && row.model && !ch.model) { ch.model = row.model; setTopbar(); updateModelPill() }
  // Si el chat está cargado en el gateway (quizá respondiendo desde Hermes Desktop), me engancho
  // para recibir sus eventos en vivo y sus permisos pendientes.
  if ((row && row.active) || ch.running || (ch.live && !ch.live.done)) {
    call(api.attach, conn, sid).then(r => {
      ch.running = r.running
      if (!r.running && ch.live && ch.live.done) { ch.live = null; if (currentChat() === ch) { renderChat(false) } }
      // Trabajando sin que la pantalla viera empezar el turno (reenganchado al abrir Pedila).
      if (r.running && (!ch.live || ch.live.done)) { ch.resumed = true }
      updateComposer()
      renderList()
    }).catch(() => {})
  }
  $('#input').focus()
}

let liveRaf = 0
// Mientras se pulsa algo del chat no se repinta el turno en directo (el clic caería en un botón
// que ya no existe); se repinta al soltar.
let liveHold = false
let liveHeld = false
let liveHeldFull = false
function scheduleLive() {
  if (liveHold) { liveHeld = true; return }
  if (liveRaf) { return }
  liveRaf = requestAnimationFrame(() => { liveRaf = 0; if (liveHold) { liveHeld = true; return } renderLiveOnly() })
}

function nearBottom() {
  const s = $('#scroller')
  return s.scrollHeight - s.scrollTop - s.clientHeight < 140
}

function toBottom() {
  const s = $('#scroller')
  s.scrollTop = s.scrollHeight
}

function renderChat(scroll = true) {
  if (liveHold) { liveHeldFull = true; return }
  const ch = currentChat()
  const msgs = $('#messages')
  msgs.replaceChildren()
  const empty = !ch || (ch.loaded && !ch.transcript.length && !ch.live && !ch.loadError)
  $('#welcome').hidden = !(empty || !ch)
  $('#welcome-where').textContent = S.current.conn === 'claude'
    ? `Vas a hablar con Claude Code, que trabajará en ${S.claudeDir || 'tu carpeta personal'} con sus propias herramientas.`
    : `Vas a hablar con el Hermes de ${S.current.conn === 'server' ? 'tu servidor' : 'este PC'}.`
  if (!ch) { return }
  if (!ch.loaded && !ch.live) { msgs.append(el('div', { class: 'status-line' }, el('span', { class: 'spin' }), el('span', { text: 'Cargando el chat…' }))) }
  if (ch.loadError) { msgs.append(el('div', { class: 'turn-error', text: `No pude cargar el chat: ${ch.loadError}` })) }
  for (const t of ch.transcript) { msgs.append(renderTurn(t)) }
  if (ch.live) { msgs.append(renderLiveTurn(ch)) }
  for (const [k, p] of ch.prompts) { msgs.append(renderPrompt(ch, k, p)) }
  if (scroll) { toBottom() }
}

function renderLiveOnly() {
  const ch = currentChat()
  if (!ch) { return }
  const stick = nearBottom()
  const old = document.getElementById('live-turn')
  if (!old || !ch.live || old._live !== ch.live) { renderChat(stick); return }
  const scrolls = new Map([...old.querySelectorAll('.tbox[data-k]')].filter(x => x.scrollTop > 0).map(x => [x.dataset.k, x.scrollTop]))
  const focusKey = old.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.k : null
  const node = renderLiveTurn(ch)
  old.replaceWith(node)
  for (const x of node.querySelectorAll('.tbox[data-k]')) { if (scrolls.has(x.dataset.k)) { x.scrollTop = scrolls.get(x.dataset.k) } }
  if (focusKey) { node.querySelector(`[data-k="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true }) }
  if (stick) { toBottom() }
}

function whoRow() {
  if (S.current.conn === 'claude') { return el('div', { class: 'who claude' }, el('span', { class: 'ti small claude', text: '✳\uFE0E' }), el('span', { text: 'Claude' })) }
  return el('div', { class: 'who' }, el('img', { src: 'assets/tray@2x.png', alt: '' }), el('span', { text: 'Hermes' }))
}

function renderBlocks(blocks) {
  const out = []
  // Las herramientas seguidas (sin texto entre ellas) van juntas en un grupo plegable, como en Claude Code.
  let group = []
  const flush = () => { if (group.length) { out.push(renderToolGroup(group)); group = [] } }
  for (const b of blocks) {
    if (b.type === 'tool') { group.push(b); continue }
    if (b.type === 'text' && !String(b.text || '').trim()) { continue }
    flush()
    if (b.type === 'text') {
      const d = el('div', { class: 'md' })
      d.innerHTML = md(b.text)
      decorate(d)
      fillMedia(d, S.current.conn)
      out.push(d)
    }
  }
  flush()
  return out
}

// ── Herramientas como en Claude Code ─────────────────────────────────────────────────────────
// Cada grupo es una línea («Ejecutó 2 órdenes, leyó a.png · +12 −3 · 1 falló») que se abre; dentro,
// cada herramienta con su título, lo que se le pasó (la orden, el código, el cambio) y lo que
// devolvió. Lo abierto se recuerda mientras dura la ventana (también al repintar en directo).
const toolOpen = new Map()
let toolSeq = 0
const keyOf = b => {
  if (b.id) { return `${S.current.conn}|${S.current.sid}|${b.id}` }
  if (!b._k) { Object.defineProperty(b, '_k', { value: 'k' + (++toolSeq), enumerable: true, writable: true }) }
  return b._k
}

function renderToolGroup(tools) {
  const gk = 'g:' + keyOf(tools[0])
  const open = toolOpen.get(gk) === true
  const sum = groupSummary(tools)
  const single = tools.length === 1
  const t0 = tools[0]
  const node = el('div', { class: 'tgroup' + (open ? ' open' : '') + (sum.failed ? ' fail' : '') + (single ? ' single' : '') })
  const head = el('button', { class: 'tg-head', 'data-k': gk, 'aria-expanded': String(open), title: open ? 'Pulsa para plegar' : 'Pulsa para ver qué hizo' },
    el('span', { class: 'tg-chev', text: '›' }),
    sum.running ? el('span', { class: 'spin' }) : null,
    el('span', { class: 'tg-text', text: sum.text }),
    sum.add || sum.del ? el('span', { class: 'tg-diff' }, sum.add ? el('span', { class: 'add', text: `+${sum.add}` }) : null, sum.del ? el('span', { class: 'del', text: `−${sum.del}` }) : null) : null,
    sum.failed ? el('span', { class: 'tg-fail', text: single ? 'Falló' : failedText(sum.failed) }) : null,
    single && t0.done && t0.seconds ? el('span', { class: 'tg-time', text: `${t0.seconds.toFixed(1)} s` }) : null)
  head.addEventListener('click', () => {
    toolOpen.set(gk, !open)
    if (single) { toolOpen.set('t:' + keyOf(t0), !open) }
    const had = document.activeElement === head
    const n = renderToolGroup(tools)
    node.replaceWith(n)
    if (had) { n.querySelector('.tg-head').focus() }
  })
  node.append(head)
  if (open) {
    node.append(el('div', { class: 'tg-body' }, ...(single ? [toolDetails(t0)] : tools.map(renderToolItem))))
  }
  return node
}

function renderToolItem(b) {
  const tk = 't:' + keyOf(b)
  const saved = toolOpen.get(tk)
  const open = saved === undefined ? Boolean(b.error) : saved
  const d = describeTool(b)
  const node = el('div', { class: 'titem' + (open ? ' open' : '') + (b.error ? ' fail' : '') })
  const head = el('button', { class: 'ti-head', 'data-k': tk, 'aria-expanded': String(open) },
    el('span', { class: 'tg-chev', text: '›' }),
    !b.done ? el('span', { class: 'spin' }) : null,
    el('span', { class: 'ti-title', text: d.title }),
    d.add || d.del ? el('span', { class: 'tg-diff' }, d.add ? el('span', { class: 'add', text: `+${d.add}` }) : null, d.del ? el('span', { class: 'del', text: `−${d.del}` }) : null) : null,
    b.error ? el('span', { class: 'tg-fail', text: 'Falló' }) : null,
    b.done && b.seconds ? el('span', { class: 'tg-time', text: `${b.seconds.toFixed(1)} s` }) : null)
  head.addEventListener('click', () => {
    toolOpen.set(tk, !open)
    const had = document.activeElement === head
    const n = renderToolItem(b)
    node.replaceWith(n)
    if (had) { n.querySelector('.ti-head').focus() }
  })
  node.append(head)
  if (open) { node.append(toolDetails(b)) }
  return node
}

/** Lo de dentro de una herramienta: lo que se le pasó, lo que devolvió y sus imágenes. */
function toolDetails(b) {
  const d = describeTool(b)
  const parts = []
  if (d.box && d.box.text) { parts.push(toolBox(d.box, keyOf(b) + ':in')) }
  if (!b.done) {
    parts.push(el('div', { class: 'tout-label' }, el('span', { class: 'spin' }), el('span', { text: b.message ? ` ${b.message}${b.percent ? ` (${b.percent} %)` : ''}` : ' En marcha…' })))
  } else {
    const out = typeof b.output === 'string' ? b.output : (b.summary || '')
    if (out.trim()) {
      parts.push(el('div', { class: 'tout-label' + (b.error ? ' fail' : ''), text: b.error ? 'Falló:' : 'Resultado:' }))
      parts.push(el('pre', { class: 'tbox out' + (b.error ? ' err' : ''), 'data-k': keyOf(b) + ':out', text: out }))
    } else if (b.error || !((Array.isArray(b.images) && b.images.length) || b.image || b.imageCount)) {
      parts.push(el('div', { class: 'tout-label muted', text: b.error ? 'Falló sin decir por qué.' : 'Sin resultado que enseñar.' }))
    }
  }
  const thumbs = []
  for (const im of Array.isArray(b.images) ? b.images : []) { thumbs.push(thumbOf(im.url, im.name || 'imagen')) }
  // Hermes: la imagen por su ruta. Claude: las de la conversación guardada, que se piden al verlas.
  if (b.image) { thumbs.push(el('div', { class: 'media-img', 'data-quiet': '', 'data-media': encodeURIComponent(b.image) })) }
  for (let i = 0; i < (b.imageCount || 0); i++) { thumbs.push(el('div', { class: 'media-img', 'data-quiet': '', 'data-media': encodeURIComponent(`${b.imageRef}|${i}`) })) }
  if (thumbs.length) {
    const box = el('div', { class: 'thumbs' }, ...thumbs)
    fillMedia(box, S.current.conn)
    parts.push(box)
  }
  return el('div', { class: 'tdetails' }, ...parts)
}

/** El recuadro de lo que se le pasó: «$ orden», código, cambios en verde y rojo, ruta o JSON. */
function toolBox(box, k) {
  const pre = el('pre', { class: 'tbox ' + box.lang, 'data-k': k || '' })
  if (box.lang === 'cmd') {
    pre.append(el('span', { class: 'prompt', text: '$ ' }), document.createTextNode(box.text))
  } else if (box.lang === 'diff') {
    for (const line of box.text.split('\n')) {
      const cls = /^\+(?!\+\+ )/.test(line) ? 'add' : /^-(?!-- )/.test(line) ? 'del' : /^@@/.test(line) ? 'hunk' : ''
      pre.append(el('span', { class: 'dl ' + cls, text: line + '\n' }))
    }
  } else {
    pre.textContent = box.text
  }
  const wrap = el('div', { class: 'tbox-wrap' })
  if (box.path) { wrap.append(el('div', { class: 'tbox-path', text: box.path })) }
  wrap.append(pre)
  return wrap
}

/** Miniatura de una imagen (data:); al pulsar, se ve en grande. */
function thumbOf(url, name) {
  const img = el('img', { src: url, alt: name, title: name, loading: 'lazy' })
  const b = el('button', { class: 'thumb', title: `${name} (pulsa para verla en grande)`, onclick: e => { e.stopPropagation(); openImage(url, name) } }, img)
  return b
}

function renderReasoning(text, live) {
  if (!text) { return null }
  const d = el('details', { class: 'reasoning' }, el('summary', { text: live ? 'Razonando…' : 'Razonamiento' }), el('div', { class: 'rtext', text }))
  return d
}

function renderTurn(t) {
  if (t.role === 'user') {
    const images = Array.isArray(t.images) ? t.images : []
    const n = images.length + (t.imageCount || 0)
    let thumbs = null
    if (n) {
      thumbs = el('div', { class: 'thumbs' }, ...images.map(im => thumbOf(im.url, im.name || 'imagen')))
      for (let i = 0; i < (t.imageCount || 0); i++) { thumbs.append(el('div', { class: 'media-img', 'data-media': encodeURIComponent(`${t.imageRef}|${i}`) })) }
      fillMedia(thumbs, S.current.conn)
    }
    return el('div', { class: 'msg user' }, el('div', { class: 'bubble' + (n ? ' with-images' : '') },
      thumbs, t.text ? el('div', { class: 'btext', text: t.text }) : null))
  }
  // Lo que Hermes escribe como si fuera tuyo (resúmenes de memoria, avisos): una nota plegable.
  if (t.role === 'note') {
    return el('details', { class: 'chat-note' }, el('summary', { text: `ℹ ${t.title}` }), el('div', { class: 'note-text', text: t.text }))
  }
  return el('div', { class: 'msg assistant' }, whoRow(), renderReasoning(t.reasoning, false), renderBlocks(t.blocks), turnActions(t))
}

function turnText(t) {
  return t.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
}

function statsText(st) {
  if (!st) { return '' }
  const bits = []
  if (st.ms) { bits.push(st.ms >= 60000 ? `${Math.floor(st.ms / 60000)} min ${Math.round(st.ms % 60000 / 1000)} s` : `${(st.ms / 1000).toFixed(1)} s`) }
  if (st.tps) { bits.push(`${st.tps.toFixed(1)} tok/s`) }
  return bits.join(' · ')
}

function turnActions(t) {
  const text = turnText(t)
  if (!text && !t.stats) { return null }
  const copy = el('button', { class: 'mini', text: 'Copiar' })
  copy.addEventListener('click', () => navigator.clipboard.writeText(text).then(() => { copy.textContent = 'Copiado'; setTimeout(() => { copy.textContent = 'Copiar' }, 1200) }).catch(() => {}))
  return el('div', { class: 'turn-actions' }, text ? copy : null, t.stats ? el('span', { class: 'muted small', text: statsText(t.stats) }) : null)
}

function renderLiveTurn(ch) {
  const L = ch.live
  const node = el('div', { class: 'msg assistant', id: 'live-turn' }, whoRow(), renderReasoning(L.reasoning, !L.done), renderBlocks(L.blocks))
  node._live = L
  if (!L.done) {
    const status = L.status || (L.blocks.length ? 'Escribiendo' : 'Pensando')
    node.append(el('div', { class: 'status-line' }, el('span', { class: 'spin' }), el('span', { class: 'dots', text: status })))
  }
  if (L.error) { node.append(el('div', { class: 'turn-error', text: L.error })) }
  if (L.note) { node.append(el('div', { class: 'turn-note', text: L.note })) }
  if (L.done) { const a = turnActions(liveToTurn(L)); if (a) { node.append(a) } }
  return node
}

function renderPrompt(ch, k, p) {
  if (p.promptKind === 'approval') {
    const card = el('div', { class: 'prompt-card' },
      el('h4', { text: `${WHO(ch.conn)} te pide permiso` }),
      p.command ? el('pre', { text: p.command }) : null,
      p.description ? el('div', { class: 'muted small', text: p.description }) : null)
    const actions = el('div', { class: 'actions' })
    const order = ['once', 'session', 'always', 'deny'].filter(c => (p.choices || []).includes(c))
    for (const c of order) {
      actions.append(el('button', { class: c === 'once' ? 'yes' : c === 'deny' ? 'no' : '', text: CHOICE_LABELS[c] || c, onclick: () => answerPrompt(ch, k, c, actions) }))
    }
    card.append(actions)
    return card
  }
  const card = el('div', { class: 'prompt-card clarify' })
  const answers = {}
  const qs = p.questions || []
  for (const q of qs) {
    card.append(el('h4', { text: q.question || `${WHO(ch.conn)} te pregunta` }))
    const actions = el('div', { class: 'actions' })
    for (const choice of q.choices || []) {
      actions.append(el('button', { text: choice, onclick: () => {
        answers[q.qid] = choice
        if (qs.length === 1) { answerPrompt(ch, k, demoOr(answers, choice), actions) } else { for (const b of actions.children) { b.classList.toggle('yes', b.textContent === choice) } }
      } }))
    }
    if ((q.choices || []).length) { card.append(actions) }
    const input = el('input', { placeholder: (q.choices || []).length ? 'U otra respuesta…' : 'Tu respuesta…' })
    input.addEventListener('input', () => { answers[q.qid] = input.value })
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && qs.length === 1 && input.value.trim()) { answerPrompt(ch, k, { [q.qid]: input.value.trim() }, card) } })
    card.append(el('div', { class: 'free' }, input, qs.length === 1 ? el('button', { class: 'btn-ghost', text: 'Responder', onclick: () => { if (input.value.trim()) { answerPrompt(ch, k, { [q.qid]: input.value.trim() }, card) } } }) : null))
  }
  if (qs.length > 1) {
    card.append(el('div', { class: 'actions' }, el('button', { class: 'yes', text: 'Enviar respuestas', onclick: () => answerPrompt(ch, k, answers, card) })))
  }
  return card
}

function demoOr(answers) {
  return { ...answers }
}

async function answerPrompt(ch, k, value, container) {
  for (const b of container.querySelectorAll('button')) { b.disabled = true }
  try {
    await call(api.answer, ch.conn, k, value)
    ch.prompts.delete(k)
    if (ch.live && !ch.live.done) { ch.live.status = 'Continuando' }
  } catch (e) {
    for (const b of container.querySelectorAll('button')) { b.disabled = false }
    alertInChat(`No pude enviar la respuesta: ${e.message}`)
  }
  if (currentChat() === ch) { renderChat(nearBottom()) }
  updatePet()
}

function alertInChat(text) {
  const ch = currentChat()
  if (ch && ch.live) { ch.live.error = text; scheduleLive() } else { $('#messages').append(el('div', { class: 'turn-error', text })) }
}

// ── Escribir y enviar ────────────────────────────────────────────────────────────────────────
function busy(ch) {
  return Boolean(ch && ((ch.live && !ch.live.done) || ch.running))
}

function updateComposer() {
  const ch = currentChat()
  const b = $('#send')
  const running = busy(ch)
  const hasText = $('#input').value.trim().length > 0
  if (running && !hasText) {
    b.classList.add('stop')
    b.textContent = '■'
    b.title = 'Parar'
    b.disabled = false
  } else {
    b.classList.remove('stop')
    b.textContent = '➤'
    b.title = running ? 'Enviar (se pondrá en cola)' : 'Enviar'
    b.disabled = !hasText
  }
  const who = WHO(S.current.conn)
  $('#input').placeholder = S.current.sid ? `Escribe a ${who}…` : S.current.conn === 'claude' ? `Escribe a Claude (en ${baseName(S.claudeDir) || 'tu carpeta'})…` : `Escribe a Hermes (${CONN_NAMES[S.current.conn]})…`
  updateDirPill()
  if (typeof updateExtrasPills === 'function') { updateExtrasPills() }
}

function autoGrow() {
  const t = $('#input')
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px'
}

async function onSendClick() {
  const ch = currentChat()
  let text = $('#input').value.trim()
  if (!text && busy(ch) && !S.attach.length) { return stopTurn(ch) }
  if (!text && S.attach.length) { text = 'Mira la imagen.' }
  if (!text) { return }
  closeSnippets()
  const images = S.attach.splice(0)
  renderAttach()
  const conn = S.current.conn
  let sid = S.current.sid
  $('#input').value = ''
  autoGrow()
  if (!sid) {
    $('#send').disabled = true
    try {
      const choice = S.modelChoice[conn]
      const r = await call(api.newChat, conn, { ...(choice ? { model: choice.model, provider: choice.provider } : {}), ...(S.reasoning ? { reasoning: S.reasoning } : {}), ...(conn === 'claude' && S.claudeDir ? { cwd: S.claudeDir } : {}) })
      sid = r.sid
      S.current = { conn, sid }
      const nc = chat(conn, sid)
      nc.loaded = true
      nc.title = cutTitle(text)
      if (choice) { nc.model = choice.model }
      S.sessions[conn] = [{ id: sid, title: nc.title, preview: text.slice(0, 120), lastActive: Date.now(), messages: 1, model: nc.model, active: true }, ...S.sessions[conn].filter(r => r.id !== sid)]
      call(api.viewing, conn, sid, nc.title).catch(() => {})
    } catch (e) {
      $('#input').value = text
      S.attach.push(...images)
      renderAttach()
      autoGrow()
      updateComposer()
      showToastLine(e.needLogin ? 'Falta iniciar sesión en el servidor.' : `No pude crear el chat: ${e.message}`)
      if (e.needLogin) { openLogin() }
      return
    }
  }
  const c = chat(conn, sid)
  // Con Hermes ya trabajando el mensaje va en cola: la tarea en marcha sigue contando desde antes.
  if (!busy(c)) { c.turnAt = Date.now() }
  if (c.live && c.live.done) { c.transcript.push(liveToTurn(c.live)); c.live = null }
  // Tus imágenes se ven en tu mensaje (miniaturas que se abren en grande).
  c.transcript.push({ role: 'user', text, ...(images.length ? { images: images.map(i => ({ url: i.url, name: i.name })) } : {}) })
  if (!c.live) { c.live = { blocks: [], reasoning: '', status: 'Enviando', done: false, startedAt: Date.now() } }
  c.running = true
  setTopbar()
  renderList()
  renderChat(true)
  updateComposer()
  updatePet()
  try {
    const files = []
    for (const img of images) { files.push(await call(api.attachImage, conn, sid, img.b64, img.name)) }
    const wire = S.readOnly ? `${READ_ONLY_NOTE}\n\n${text}` : text
    const r = await call(api.send, conn, sid, wire, files)
    if (r && r.status === 'queued' && c.live && !c.live.done && c.live.blocks.length) { c.live.note = `Tu mensaje va en cola: ${WHO(conn)} lo leerá al terminar.` }
    if (c.live && c.live.status === 'Enviando') { c.live.status = 'Pensando' }
    scheduleLive()
  } catch (e) {
    if (c.live) { c.live.error = e.needLogin ? 'Falta iniciar sesión en el servidor.' : `No se pudo enviar: ${e.message}`; c.live.done = true }
    c.running = false
    c.turnAt = 0
    if (e.needLogin) { openLogin() }
    renderChat(true)
    updateComposer()
    updatePet()
  }
}

function cutTitle(t) {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? one.slice(0, 59) + '…' : one
}

async function stopTurn(ch) {
  if (!ch) { return }
  try {
    await call(api.stop, ch.conn, ch.sid)
    if (ch.live) { ch.live.status = 'Parando' }
    scheduleLive()
  } catch (e) {
    showToastLine(`No pude parar: ${e.message}`)
  }
}

/** Una herramienta del último turno del historial que aún no tiene resultado (o null). */
function pendingPastTool(ch, id) {
  const last = ch.transcript[ch.transcript.length - 1]
  if (!last || last.role !== 'assistant' || !Array.isArray(last.blocks)) { return null }
  return last.blocks.find(b => b.type === 'tool' && b.id === id && !b.done) || null
}

/** Lo que trae el aviso de «herramienta terminada»: resultado, si falló, el cambio y las imágenes. */
function toolDone(b, evt) {
  b.done = true
  b.summary = evt.summary
  b.seconds = evt.seconds !== null && evt.seconds !== undefined ? evt.seconds : (b.startedAt ? (Date.now() - b.startedAt) / 1000 : null)
  if (typeof evt.output === 'string') { b.output = evt.output }
  b.error = Boolean(evt.error)
  if (evt.diff) { b.diff = evt.diff }
  if (Array.isArray(evt.images) && evt.images.length) { b.images = evt.images }
  if (evt.image) { b.image = evt.image }
}

function liveToTurn(L) {
  return { role: 'assistant', blocks: L.blocks.map(b => ({ ...b, done: true })), reasoning: L.reasoning, stats: L.stats || null }
}

let toastT = null
function showToastLine(text) {
  const h = $('#composer-hint')
  h.textContent = text
  h.classList.add('error')
  clearTimeout(toastT)
  toastT = setTimeout(() => { h.textContent = 'Enter para enviar · Mayús+Enter, salto de línea'; h.classList.remove('error') }, 6000)
}

// ── Modelos ──────────────────────────────────────────────────────────────────────────────────
function updateModelPill() {
  const p = $('#model-pill')
  const ch = currentChat()
  if (ch) {
    p.textContent = ch.model ? `Modelo: ${ch.model}` : 'Modelo del chat'
    p.disabled = false
    p.title = 'Cambiar el modelo de este chat (desde tu próximo mensaje)'
    return
  }
  const conn = S.current.conn
  const choice = S.modelChoice[conn]
  const opts = S.models[conn]
  if (conn === 'claude') {
    p.textContent = choice ? `Modelo: ${choice.model}` : 'Modelo: el de tu Claude Code'
    p.disabled = false
    p.title = 'Modelo para este chat nuevo de Claude'
    return
  }
  if (choice) {
    p.textContent = `Modelo: ${choice.model}${choice.local === false ? ' ☁' : ''}`
  } else if (opts && opts.current.model) {
    p.textContent = `Modelo: predeterminado (${opts.current.model}${opts.current.local ? '' : ' ☁'})`
  } else {
    p.textContent = 'Modelo: predeterminado'
  }
  p.disabled = false
  p.title = choice && choice.local === false || (!choice && opts && !opts.current.local)
    ? 'Ojo: este modelo está en la nube, no en tu red. Pulsa para elegir otro.'
    : 'Modelo para este chat nuevo'
}

/** Al abrir un chat nuevo: si el predeterminado de ese Hermes está en la nube y hay modelos en tu
 *  red, propone el primero local (no se guarda hasta que lo eliges tú). */
async function ensureModelDefault(conn) {
  if (S.conns[conn].state !== 'ready') { return }
  if (!S.models[conn]) {
    try { S.models[conn] = await call(api.models, conn) } catch { return }
  }
  const opts = S.models[conn]
  if (!S.modelChoice[conn] && !opts.current.local) {
    const local = opts.providers.find(pv => pv.local && pv.models.length)
    if (local) { S.modelChoice[conn] = { model: local.models[0].id, provider: local.id, local: true, auto: true } }
  }
  if (!S.current.sid && S.current.conn === conn) { updateModelPill() }
}

async function openModelMenu() {
  const conn = S.current.conn
  const menu = $('#model-menu')
  if (!menu.hidden) { menu.hidden = true; return }
  menu.replaceChildren(el('div', { class: 'mh', text: 'Cargando modelos…' }))
  placeMenu(menu)
  menu.hidden = false
  try {
    S.models[conn] = await call(api.models, conn)
  } catch (e) {
    menu.replaceChildren(el('div', { class: 'mh', text: `No pude leer los modelos: ${e.message}` }))
    return
  }
  const opts = S.models[conn]
  let showCloud = conn === 'claude' || Boolean(S.modelChoice[conn] && S.modelChoice[conn].local === false)
  let filter = ''
  const pick = async choice => {
    menu.hidden = true
    const sid = S.current.sid
    if (sid) {
      const ch = chat(conn, sid)
      try {
        const r = await call(api.chatOptions, conn, sid, { model: choice ? choice.model : null, ...(choice && choice.provider ? { provider: choice.provider } : {}) })
        if (r && r.model) { ch.model = r.model } else if (choice) { ch.model = choice.model }
        updateModelPill()
        setTopbar()
        showNote(`Modelo de este chat: ${choice ? choice.model : 'el predeterminado'}${r && r.applied === 'next' ? ' (desde tu próximo mensaje)' : ''}.`)
      } catch (e) { showNote(`No pude cambiar el modelo: ${e.message}`, true) }
      return
    }
    S.modelChoice[conn] = choice
    updateModelPill()
    call(api.settings, { models: { [conn]: choice ? { model: choice.model, provider: choice.provider, local: choice.local } : null } }).catch(() => {})
  }
  const search = el('input', { class: 'menu-search', placeholder: 'Buscar modelo…', spellcheck: 'false' })
  const list = el('div')
  const draw = () => {
    list.replaceChildren()
    const q = filter.trim().toLowerCase()
    const local = opts.providers.filter(pv => pv.local)
    const cloud = opts.providers.filter(pv => !pv.local)
    const cur = opts.current
    if (!q) {
      list.append(el('button', { class: S.modelChoice[conn] ? '' : 'active', text: conn === 'claude' ? 'Predeterminado (el de tu Claude Code)' : `Predeterminado de este Hermes${cur.model ? ` (${cur.model}${cur.local ? '' : ' ☁'})` : ''}`, onclick: () => pick(null) }))
    }
    const group = (pv, cloudy) => {
      const models = pv.models.filter(m => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
      if (!models.length) { return }
      list.append(el('div', { class: 'mh', text: conn === 'claude' ? (pv.name || pv.id) : `${pv.name || pv.id}${cloudy ? ' · en la nube ☁' : ' · en tu red'}` }))
      for (const m of models) {
        const c = S.modelChoice[conn]
        const active = c && c.model === m.id && c.provider === pv.id
        list.append(el('button', { class: active ? 'active' : '', text: m.name || m.id, onclick: () => pick({ model: m.id, provider: pv.id, local: !cloudy }) }))
      }
    }
    for (const pv of local) { group(pv, false) }
    const cloudCount = cloud.reduce((n, pv) => n + pv.models.length, 0)
    if (cloudCount) {
      if (showCloud || q) {
        for (const pv of cloud) { group(pv, true) }
      } else {
        list.append(el('button', { class: 'more', text: `☁ Ver también los modelos en la nube (${cloudCount})`, onclick: e => { e.stopPropagation(); showCloud = true; draw() } }))
      }
    }
    if (!list.children.length) { list.append(el('div', { class: 'mh', text: 'Ningún modelo coincide.' })) }
  }
  search.addEventListener('input', () => { filter = search.value; draw() })
  menu.replaceChildren(search, list)
  draw()
  search.focus()
  updateModelPill()
}

function placeMenu(menu) {
  const pill = $('#model-pill').getBoundingClientRect()
  const main = $('#main').getBoundingClientRect()
  menu.style.left = Math.max(10, pill.left - main.left) + 'px'
  menu.style.bottom = (main.bottom - pill.top + 8) + 'px'
  menu.style.top = 'auto'
}

// ── Eventos del proceso principal ────────────────────────────────────────────────────────────
function onEvent(evt) {
  if (terms.onEvent(evt)) { return }
  switch (evt.kind) {
    case 'conn': {
      const prev = S.conns[evt.conn].state
      S.conns[evt.conn] = { state: evt.state, detail: evt.detail || '' }
      renderConnSwitch()
      if (evt.conn === S.active) { renderBanner() }
      if (evt.state === 'ready' && prev !== 'ready') { loadSessions(evt.conn); ensureModelDefault(evt.conn) }
      // Una conexión que vuelve puede ser otro Hermes (reinicio, otra sesión): cuotas nuevas.
      if (evt.state !== 'ready' && prev === 'ready') { forgetQuotas(evt.conn) }
      if ((evt.state === 'login' || evt.state === 'setup') && evt.conn === S.active) { S.listError.server = evt.state; renderList() }
      updatePet()
      return
    }
    case 'reconnected': {
      const ch = currentChat()
      if (ch && ch.conn === evt.conn) {
        call(api.transcript, ch.conn, ch.sid).then(t => {
          ch.transcript = t
          if (ch.live) { ch.live = null }
          renderChat(true)
          return call(api.attach, ch.conn, ch.sid)
        }).then(r => { if (r) { ch.running = r.running; updateComposer(); updatePet() } }).catch(() => {})
      }
      // Los demás chats que estaban trabajando: el socket nuevo ya no los sigue (connect() olvida los
      // enganches) y su final no llegaría nunca. Se vuelven a enganchar: si siguen, llegará; si ya
      // acabaron, dejan de contar como «en marcha». Lo ya escrito se vuelve a leer al abrirlos.
      for (const c of S.chats.values()) {
        if (c === ch || c.conn !== evt.conn || !(busy(c) || liveSubs(c))) { continue }
        c.live = null
        const settle = running => {
          c.running = running
          if (!running) { c.turnAt = 0 }
          renderList()
          updatePet()
          schedulePanel()
        }
        call(api.attach, c.conn, c.sid).then(r => settle(Boolean(r && r.running))).catch(() => settle(false))
      }
      return
    }
    case 'sessions-changed':
      if (evt.conn === S.active) {
        reloadSessionsSoon(evt.conn)
        // Con trabajo en marcha fuera de esta ventana, se mira enseguida si ya terminó (como mucho cada 10 s).
        if (remoteBusy(evt.conn).length && Date.now() - P.at[evt.conn] > 10000) { loadPanelUsage(evt.conn, true) }
      }
      return
    case 'claude-limits':
      S.claudeLimits = evt.limits || null
      schedulePanel()
      return
    case 'theme':
      S.dark = evt.dark
      applyLook()
      return
    case 'new-chat':
      if (terms.mode === 'terms') { terms.setMode('chats') }
      newChatView()
      return
    case 'focus-chat':
      if (terms.mode === 'terms') { terms.setMode('chats') }
      if (evt.sid) { openChat(evt.conn, evt.sid) }
      return
    case 'pet':
      if (evt.pet) { applyPet(evt.pet, { greet: true }).then(() => { $('#pet-stage').hidden = !S.settings.pet.visible }).catch(() => {}) }
      return
    case 'focus-input':
      if (terms.mode === 'terms') { document.querySelector('.term-pane.active textarea')?.focus(); return }
      $('#input').focus()
      return
    case 'update':
      showUpdate(evt.version, evt.notes)
      return
    default:
      break
  }
  if (!evt.sid) { return }
  const ch = chat(evt.conn, evt.sid)
  const isCur = currentChat() === ch
  let fullRender = false // cambió algo del historial, no solo el turno en directo
  const ensureLive = () => {
    if (!ch.live || ch.live.done) {
      if (ch.live && ch.live.done) { ch.transcript.push(liveToTurn(ch.live)) }
      ch.live = { blocks: [], reasoning: '', status: 'Pensando', done: false, startedAt: Date.now() }
    }
    return ch.live
  }
  switch (evt.kind) {
    case 'turn-start': {
      const L = ensureLive()
      L.status = 'Pensando'
      ch.running = true
      // Cuándo empezó la tarea (si se envió desde aquí ya está puesta, con la hora del envío).
      if (!ch.turnAt) { ch.turnAt = Date.now() }
      for (const [id, sa] of ch.subagents) { if (sa.state !== 'running' && sa.state !== 'queued') { ch.subagents.delete(id) } }
      break
    }
    case 'delta': {
      const L = ensureLive()
      const last = L.blocks[L.blocks.length - 1]
      if (!L.firstAt) { L.firstAt = Date.now() }
      if (last && last.type === 'text' && !L.cut) { last.text += evt.text } else { L.blocks.push({ type: 'text', text: evt.text }); L.cut = false }
      L.status = 'Escribiendo'
      break
    }
    case 'segment':
      if (ch.live) { ch.live.cut = true }
      break
    case 'reasoning': {
      const L = ensureLive()
      L.reasoning = evt.full ? evt.text : L.reasoning + evt.text
      L.status = 'Razonando'
      break
    }
    case 'thinking':
      if (ch.live && !ch.live.done && evt.text) { ch.live.status = 'Pensando' }
      break
    case 'status':
      if (evt.text && busy(ch) && (!ch.live || ch.live.done)) { ensureLive() }
      if (ch.live && !ch.live.done && evt.text) {
        // Al resumir lo antiguo del chat (puede tardar minutos) se dice en castellano y se cuenta el rato.
        const text = evt.statusKind === 'compacting' ? COMPACT_TEXT : evt.text.replace(/[.…]+$/, '')
        if (text === COMPACT_TEXT && ch.live.status !== COMPACT_TEXT) { ch.live.compactAt = Date.now() }
        ch.live.status = text
      }
      break
    case 'tool': {
      // La que ya está en el historial sin terminar (turno empezado antes de que la pantalla lo
      // siguiera, p. ej., reenganchado al abrir Pedila): se completa allí, no se repite en directo.
      const inLive = ch.live && !ch.live.done && ch.live.blocks.some(x => x.type === 'tool' && x.id === evt.id)
      const past = evt.id && !inLive ? pendingPastTool(ch, evt.id) : null
      if (past) {
        if (evt.phase === 'complete') { toolDone(past, evt) }
        if (evt.input && typeof evt.input === 'object') { past.input = evt.input }
        if (ch.live && !ch.live.done) { ch.live.status = evt.phase === 'complete' ? 'Pensando' : `Usando ${past.name}` }
        ch.resumed = true
        fullRender = true
        break
      }
      const L = ensureLive()
      let b = L.blocks.find(x => x.type === 'tool' && x.id && x.id === evt.id)
      // «Preparando» (tool.generating) y «en marcha» (tool.start) pueden llegar con ids distintos:
      // el bloque que se estaba preparando con el mismo nombre se reutiliza.
      if (!b && evt.phase === 'start') { b = L.blocks.find(x => x.type === 'tool' && x.generating && !x.done && x.name === evt.name) }
      if (!b) {
        b = { type: 'tool', id: evt.id, name: evt.name, args: evt.args || '', done: false, generating: evt.phase === 'generating', startedAt: Date.now() }
        L.blocks.push(b)
        L.cut = true
      }
      if (evt.phase === 'start') { if (b.generating) { b.startedAt = Date.now() } b.generating = false; if (evt.id) { b.id = evt.id } }
      if (evt.args) { b.args = evt.args }
      if (evt.name) { b.name = evt.name }
      // El detalle para el grupo plegable: lo que se le pasó, lo que devolvió, si falló, el cambio
      // de un archivo y las imágenes (las de Claude vienen dentro; la de Hermes, por su ruta).
      if (evt.input && typeof evt.input === 'object') { b.input = evt.input }
      if (evt.phase === 'progress') { b.percent = evt.percent; b.message = evt.message }
      if (evt.phase === 'complete') { toolDone(b, evt) }
      L.status = evt.phase === 'complete' ? 'Pensando' : `Usando ${b.name}`
      break
    }
    case 'complete': {
      const L = ensureLive()
      if (!L.blocks.some(b => b.type === 'text') && evt.text) { L.blocks.push({ type: 'text', text: evt.text }) }
      if (!L.reasoning && evt.reasoning) { L.reasoning = evt.reasoning }
      for (const b of L.blocks) { if (b.type === 'tool') { b.done = true } }
      L.done = true
      ch.running = Boolean(evt.more)
      ch.turnAt = evt.more ? Date.now() : 0
      // La hora exacta en que terminó (el panel la junta con la última actividad que da Hermes).
      ch.doneAt = Date.now()
      P.done[evt.conn] = { at: ch.doneAt, sid: evt.sid }
      {
        const out = evt.out || (ch.usage && ch.usage.out && ch.usage.outStart !== undefined ? ch.usage.out - ch.usage.outStart : 0)
        const streamMs = L.firstAt ? Date.now() - L.firstAt : 0
        L.stats = { ms: evt.ms || (L.startedAt ? Date.now() - L.startedAt : null), tps: out && streamMs > 500 ? out / (streamMs / 1000) : null }
      }
      if (ch.resumed && !evt.more) {
        // El turno empezó sin la pantalla delante (o se volvió al chat a mitad): al acabar se lee entero
        // del archivo, como una sola respuesta (si mientras tanto empieza otro turno desde aquí, ese manda).
        ch.resumed = false
        setTimeout(() => {
          call(api.transcript, evt.conn, evt.sid).then(t => {
            // Con un error o una nota («Parado.») se queda como está: releer la borraría.
            if (ch.live !== L || ch.running || L.error || L.note) { return }
            // La duración del turno se queda (el archivo no la guarda).
            const last = t[t.length - 1]
            if (last && last.role === 'assistant' && L.stats) { last.stats = L.stats }
            ch.transcript = t
            ch.live = null
            if (currentChat() === ch) { renderChat(nearBottom()) }
          }).catch(() => {})
        }, 400)
      }
      if (S.settings.notify.chime && !evt.more && (!document.hasFocus() || !isCur)) { chime() }
      if (evt.more) {
        L.note = 'Sigue con tu siguiente mensaje…'
      } else if (evt.outcome && !['completed', 'complete'].includes(evt.outcome)) {
        const stopped = ['interrupted', 'cancelled', 'canceled'].includes(evt.outcome)
        L.note = stopped ? 'Parado.' : `Terminó así: ${evt.outcome}`
        pet.flash(stopped ? 'waving' : 'failed', 2)
      } else {
        pet.flash('jumping', 2)
      }
      reloadSessionsSoon(evt.conn)
      break
    }
    case 'running':
      ch.running = evt.running
      if (!evt.running && ch.live && !ch.live.done && ch.live.blocks.length) { ch.live.done = true }
      // Al enviar a un chat sin enganchar, el enganche dice «parado» antes de empezar: la hora del envío se queda.
      if (!evt.running && !busy(ch)) { ch.turnAt = 0 }
      break
    case 'todos': {
      // La lista entera. Los avisos en vivo y la foto al engancharse mandan siempre (Hermes puede volver
      // a numerar desde 1 tras reiniciarse o tras una hora parado); la leída del historial solo gana si
      // no es más vieja o si el chat no está trabajando.
      const cur = ch.todos
      if (evt.history && busy(ch) && cur && evt.revision != null && cur.revision != null && evt.revision < cur.revision) { break }
      ch.todos = { items: Array.isArray(evt.todos) ? evt.todos : [], revision: evt.revision ?? (cur ? cur.revision : null) }
      break
    }
    case 'subagent': {
      const prev = ch.subagents.get(evt.id) || { id: evt.id, goal: '', state: 'queued', tools: 0, since: Date.now(), index: evt.index }
      const sa = { ...prev, goal: evt.goal || prev.goal, index: evt.index, count: evt.count }
      if (evt.phase === 'start' || ((evt.phase === 'tool' || evt.phase === 'progress') && !['running', 'done', 'failed'].includes(sa.state))) { sa.state = 'running'; sa.since = sa.since && evt.phase !== 'start' ? sa.since : Date.now() }
      sa.misses = 0
      if (evt.phase === 'tool' && evt.tool) { sa.tool = evt.tool }
      if (evt.phase === 'progress' && evt.text) { sa.text = evt.text }
      if (evt.tools != null) { sa.tools = evt.tools }
      if (evt.phase === 'complete') {
        sa.state = ['failed', 'error', 'timeout'].includes(evt.status) ? 'failed' : ['interrupted', 'cancelled', 'canceled', 'killed', 'stopped'].includes(evt.status) ? 'stopped' : 'done'
        sa.seconds = evt.seconds != null ? evt.seconds : (Date.now() - sa.since) / 1000
      }
      ch.subagents.set(evt.id, sa)
      break
    }
    case 'info':
      if (evt.model) { ch.model = evt.model }
      if (evt.provider) { ch.provider = evt.provider }
      if (evt.contextMax) { ch.contextMax = evt.contextMax }
      if (evt.effort) { ch.effortNow = evt.effort; if (isCur) { updateExtrasPills() } }
      break
    case 'usage':
      ch.usage = { used: evt.used, max: evt.max, out: evt.out, outStart: ch.usage && ch.usage.outStart !== undefined && ch.live && !ch.live.done ? ch.usage.outStart : (ch.usage && ch.usage.out) || 0 }
      break
    case 'title':
      ch.title = evt.title
      { const r = S.sessions[evt.conn].find(x => x.id === evt.sid); if (r) { r.title = evt.title } }
      if (isCur) { call(api.viewing, ch.conn, ch.sid, ch.title).catch(() => {}) }
      break
    case 'error': {
      const L = ensureLive()
      L.error = evt.message
      pet.flash('failed', 3)
      break
    }
    case 'turn-lost':
      if (ch.live && !ch.live.done) { ch.live.note = 'Se cortó la conexión mientras Hermes trabajaba. Al reconectar recargo el chat.' }
      break
    case 'prompt':
      ch.prompts.set(evt.key, evt)
      break
    case 'prompt-done':
      ch.prompts.delete(evt.key)
      break
    default:
      return
  }
  if (isCur) {
    if (fullRender || ['prompt', 'prompt-done', 'error', 'turn-lost', 'complete'].includes(evt.kind)) { renderChat(nearBottom()) } else if (['delta', 'reasoning', 'tool', 'status', 'thinking', 'turn-start', 'segment', 'running'].includes(evt.kind)) { scheduleLive() }
    if (['info', 'usage', 'title'].includes(evt.kind)) { setTopbar() }
    updateComposer()
  }
  if (['turn-start', 'complete', 'running', 'title'].includes(evt.kind)) { renderList() }
  updatePet()
  // El panel: al acabar una respuesta, el uso se recalcula (Hermes tarda un poco en guardar los tokens).
  if (evt.kind === 'complete') { setTimeout(() => loadPanelUsage(evt.conn, true), 1500) }
  schedulePanel()
}

// ── Mascota ──────────────────────────────────────────────────────────────────────────────────
const pet = new Pet($('#pet'))
const terms = makeTerms()
const welcomePet = new Pet($('#welcome-pet'))
const settingsPet = new Pet($('#settings-pet'))
const PEDILA_SHEET = 'assets/pets/pedila/sprite.webp'
const DEFAULT_PET = { slug: 'pedila', name: 'Pedila', author: '', kind: 'character', url: PEDILA_SHEET, bundled: true, own: true }
const KIND_NAMES = { character: 'personaje', creature: 'criatura', object: 'objeto' }
const petName = p => { const n = (p && p.name) || 'mascota'; return n.charAt(0).toUpperCase() + n.slice(1) }
const petBy = p => (p && p.own ? 'la mensajera, dibujo propio de Pedila' : p && p.author ? `de ${p.author} en Petdex` : 'de Petdex')

function updatePet() {
  let base = 'idle'
  const all = [...S.chats.values()]
  const relevant = all.filter(c => c.conn === S.active || c === currentChat())
  if (all.some(c => c.prompts.size)) { base = 'waiting' } else if (relevant.some(c => c.live && !c.live.done && c.live.blocks.some(b => b.type === 'tool' && !b.done))) { base = 'review' } else if (relevant.some(c => (c.live && !c.live.done) || c.running)) { base = 'running' }
  // Claude trabajando en una pestaña de terminal también la pone a correr.
  const claudeBusy = base === 'idle' && terms.busyCount() > 0
  if (claudeBusy) { base = 'running' }
  pet.setBase(base)
  const name = petName(S.pet)
  const what = claudeBusy ? 'Claude está trabajando en una terminal' : { idle: `${name} está ${S.pet && S.pet.own ? 'tranquila' : 'tranquilo'}`, waiting: 'Hermes te necesita', review: 'Hermes está usando herramientas', running: 'Hermes está trabajando' }[base]
  $('#pet').title = what
}

function renderPetLabels() {
  const p = S.pet || DEFAULT_PET
  $('#settings-pet-name').textContent = petName(p)
  $('#settings-pet-by').textContent = petBy(p) + (p.kind ? ` · ${KIND_NAMES[p.kind] || p.kind}` : '')
  $('#about-pet').textContent = `Mascota: ${petName(p)}, ${petBy(p)}.`
  updatePet()
}

/** Pone la mascota en la barra, la bienvenida y Ajustes. Si su hoja no vale, lanza el error. */
async function applyPet(info, { greet = false } = {}) {
  await pet.load(info.url)
  S.pet = info
  welcomePet.load(info.url).catch(() => {})
  settingsPet.load(info.url).catch(() => {})
  renderPetLabels()
  if (greet) { pet.flash('waving', 3) }
}

// Selector: «Tus mascotas» (la de la app y las que ya usaste) y el catálogo de Petdex.
const PP = { tab: 'petdex', q: '', kind: '', items: [], total: 0, sel: null, seq: 0, kinds: null }

function stripFor(item, cls = '') {
  const d = el('div', { class: `strip ${cls}`.trim() })
  const fail = text => { d.classList.add('missing'); d.textContent = text }
  if (item.url) {
    // Hoja completa guardada: se anima la fila «idle».
    loadSheet(item.url).then(sh => {
      d.style.setProperty('--cols', String(sh.cols))
      d.style.setProperty('--rows', String(sh.rows))
      d.style.backgroundImage = `url("${item.url}")`
    }).catch(() => fail('no se puede ver'))
  } else if (item.preview) {
    // Vista previa de Petdex: una tira de 6 cuadros (la usa su propia web).
    const probe = new Image()
    probe.onload = () => { d.style.backgroundImage = `url("${item.preview}")` }
    probe.onerror = () => fail('sin vista previa')
    probe.src = item.preview
  }
  return d
}

function petCard(item) {
  const current = S.pet && S.pet.slug === item.slug
  const card = el('button', { class: 'pet-card' + (PP.sel && PP.sel.slug === item.slug ? ' sel' : ''), title: `${petName(item)} — ${petBy(item)}`, 'data-slug': item.slug },
    stripFor(item),
    el('div', { class: 'n', text: petName(item) }),
    el('div', { class: 'a', text: item.author ? `de ${item.author}` : '' }),
    current ? el('div', { class: 'badge', text: 'La que tienes' }) : item.installed ? el('div', { class: 'badge', text: 'Guardada' }) : null)
  card.addEventListener('click', () => selectPet(item))
  card.addEventListener('dblclick', () => { selectPet(item); usePet() })
  return card
}

function selectPet(item) {
  PP.sel = item
  for (const c of document.querySelectorAll('#pp-grid .pet-card')) { c.classList.toggle('sel', c.dataset.slug === item.slug) }
  $('#pp-sel-strip').replaceWith(Object.assign(stripFor(item, 'big'), { id: 'pp-sel-strip' }))
  $('#pp-sel-name').textContent = petName(item)
  $('#pp-sel-by').textContent = petBy(item) + (item.kind ? ` · ${KIND_NAMES[item.kind] || item.kind}` : '')
  const current = S.pet && S.pet.slug === item.slug
  $('#pp-use').disabled = current
  $('#pp-use').textContent = current ? 'Ya es tu mascota' : 'Usar esta mascota'
}

function ppStatus(text, retry = false) {
  const s = $('#pp-status')
  s.replaceChildren()
  s.hidden = !text
  if (text) { s.append(text) }
  if (retry) { s.append(' ', el('button', { class: 'btn-ghost', text: 'Reintentar', onclick: () => loadPetPage(true) })) }
}

async function loadPetPage(reset) {
  const seq = ++PP.seq
  const grid = $('#pp-grid')
  $('#pp-filters').hidden = PP.tab !== 'petdex'
  if (reset) { grid.replaceChildren(); PP.items = []; $('#pp-more').hidden = true }
  if (PP.tab === 'mine') {
    try {
      const mine = await call(api.petsInstalled)
      if (seq !== PP.seq) { return }
      PP.items = mine
      grid.replaceChildren(...mine.map(petCard))
      ppStatus(mine.length > 1 ? '' : 'Aquí aparecerán las mascotas que elijas del catálogo de Petdex.')
    } catch (e) {
      if (seq === PP.seq) { ppStatus(`No pude leer tus mascotas: ${e.message}`) }
    }
    return
  }
  ppStatus(PP.items.length ? '' : 'Cargando el catálogo de Petdex…')
  try {
    const r = await call(api.petsSearch, { q: PP.q, kind: PP.kind, offset: PP.items.length, limit: 30 })
    if (seq !== PP.seq) { return }
    if (!PP.kinds) {
      PP.kinds = r.kinds
      for (const b of document.querySelectorAll('#pp-kinds button')) {
        const n = b.dataset.kind ? r.kinds[b.dataset.kind] : r.all
        if (n) { b.textContent = `${b.textContent.replace(/ \(\d+\)$/, '')} (${n})` }
      }
    }
    PP.items.push(...r.items)
    PP.total = r.total
    grid.append(...r.items.map(petCard))
    $('#pp-more').hidden = PP.items.length >= r.total
    $('#pp-count').textContent = `${PP.items.length} de ${r.total}`
    ppStatus(r.total ? '' : 'Ninguna mascota coincide.')
  } catch (e) {
    if (seq === PP.seq) { ppStatus(e.message, true) }
  }
}

async function usePet() {
  const item = PP.sel
  if (!item || (S.pet && S.pet.slug === item.slug)) { return }
  const btn = $('#pp-use')
  btn.disabled = true
  btn.textContent = item.url ? 'Cambiando…' : 'Descargando…'
  const prev = S.pet
  try {
    const info = await call(api.petUse, item.slug)
    try {
      await applyPet(info, { greet: true })
    } catch (e) {
      // La hoja no tiene la geometría de Petdex: vuelvo a la anterior.
      if (prev) { await call(api.petUse, prev.slug).catch(() => {}) }
      throw new Error(`${petName(item)} ${e.message}; sigues con ${petName(prev)}`)
    }
    $('#pet-dialog').close()
  } catch (e) {
    ppStatus(`No pude cambiar de mascota: ${e.message}`)
    btn.disabled = false
    btn.textContent = 'Usar esta mascota'
  }
}

function openPetPicker() {
  PP.sel = null
  $('#pp-sel-name').textContent = 'Elige una'
  $('#pp-sel-by').textContent = ''
  $('#pp-sel-strip').replaceWith(Object.assign(el('div', { class: 'strip big missing' }), { id: 'pp-sel-strip' }))
  $('#pp-use').disabled = true
  $('#pp-use').textContent = 'Usar esta mascota'
  for (const b of document.querySelectorAll('#pp-tabs button')) { b.classList.toggle('active', b.dataset.tab === PP.tab) }
  $('#pet-dialog').showModal()
  loadPetPage(true)
}

function wirePetPicker() {
  $('#choose-pet').addEventListener('click', openPetPicker)
  $('#pp-close').addEventListener('click', () => $('#pet-dialog').close())
  $('#pp-use').addEventListener('click', usePet)
  $('#pp-more-btn').addEventListener('click', () => loadPetPage(false))
  for (const b of document.querySelectorAll('#pp-tabs button')) {
    b.addEventListener('click', () => {
      PP.tab = b.dataset.tab
      for (const x of document.querySelectorAll('#pp-tabs button')) { x.classList.toggle('active', x === b) }
      loadPetPage(true)
    })
  }
  for (const b of document.querySelectorAll('#pp-kinds button')) {
    b.addEventListener('click', () => {
      PP.kind = b.dataset.kind
      for (const x of document.querySelectorAll('#pp-kinds button')) { x.classList.toggle('active', x === b) }
      loadPetPage(true)
    })
  }
  let t = null
  $('#pp-search').addEventListener('input', e => {
    clearTimeout(t)
    t = setTimeout(() => { PP.q = e.target.value; loadPetPage(true) }, 300)
  })
}

// ── Inicio de sesión ─────────────────────────────────────────────────────────────────────────
function openLogin() {
  const d = $('#login-dialog')
  if (d.open) { return }
  $('#login-error').hidden = true
  $('#login-pass').value = ''
  d.showModal()
  $('#login-user').focus()
}

async function submitLogin(e) {
  e.preventDefault()
  const user = $('#login-user').value.trim()
  const pass = $('#login-pass').value
  const btn = $('#login-submit')
  btn.disabled = true
  btn.textContent = 'Entrando…'
  try {
    const r = await call(api.login, user, pass)
    if (r && r.ok) {
      $('#login-dialog').close()
      S.listError.server = ''
      S.settings.serverSignedIn = true
      if (Q.login.server || Q.installed.server) { Q.login.server = false; Q.err.server = ''; Q.at.server = 0; setTimeout(() => loadQuotas('server', true), 1500) }
      if (S.active === 'server') { S.listLoaded.server = false; renderList(); loadSessions('server') }
    } else {
      $('#login-error').textContent = (r && r.error) || 'No se pudo entrar.'
      $('#login-error').hidden = false
    }
  } catch (err) {
    $('#login-error').textContent = err.message
    $('#login-error').hidden = false
  } finally {
    $('#login-pass').value = ''
    btn.disabled = false
    btn.textContent = 'Entrar'
  }
}

// ── Ajustes ──────────────────────────────────────────────────────────────────────────────────
function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj)
}

function patchFor(p, v) {
  const [a, b] = p.split('.')
  return { [a]: { [b]: v } }
}

function renderSettings() {
  const st = S.settings
  for (const g of document.querySelectorAll('#settings-dialog [data-set]')) {
    const p = g.dataset.set
    const v = getPath(st, p)
    if (g.tagName === 'INPUT' && g.type === 'checkbox') { g.checked = Boolean(v); continue }
    for (const b of g.querySelectorAll('button[data-v]')) { b.classList.toggle('active', String(v) === b.dataset.v) }
  }
  const urls = st.server.urls || []
  $('#srv-url-1').value = urls[0] || ''
  $('#srv-url-2').value = urls[1] || ''
  $('#srv-session').textContent = st.serverSignedIn ? 'Sesión del servidor iniciada (guardada cifrada).' : 'Sin sesión en el servidor.'
  $('#srv-logout').disabled = !st.serverSignedIn
  $('#about-version').textContent = S.version
  renderThemeGrid()
  renderPetLabels()
  renderSnippetSettings()
  $('#upd-url').value = (st.updates && st.updates.url) || ''
  renderLayoutSettings()
  $('#term-claude-args').value = (st.terminals && st.terminals.claudeArgs) || ''
  $('#term-args-status').textContent = ''
}

async function saveSetting(patch) {
  try {
    const before = JSON.stringify(S.settings && S.settings.server ? S.settings.server.urls : [])
    S.settings = await call(api.settings, patch)
    // Otra dirección del servidor = quizá otro Hermes: sus cuotas se vuelven a pedir.
    if (JSON.stringify(S.settings.server.urls) !== before) { forgetQuotas('server') }
    applyLook()
    renderSettings()
    renderConnSwitch()
  } catch (e) {
    showToastLine(`No pude guardar el ajuste: ${e.message}`)
  }
}

function openSettings(section = null) {
  renderSettings()
  if (section) {
    for (const x of document.querySelectorAll('.settings-nav button')) { x.classList.toggle('active', x.dataset.sec === section) }
    for (const sec of document.querySelectorAll('.settings-body section')) { sec.hidden = sec.dataset.sec !== section }
  }
  const dlg = $('#settings-dialog')
  if (!dlg.open) { dlg.showModal() }
}

function wireSettings() {
  const dlg = $('#settings-dialog')
  $('#open-settings').addEventListener('click', () => openSettings())
  $('#settings-close').addEventListener('click', () => dlg.close())
  for (const b of document.querySelectorAll('.settings-nav button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.settings-nav button')) { x.classList.toggle('active', x === b) }
      for (const s of document.querySelectorAll('.settings-body section')) { s.hidden = s.dataset.sec !== b.dataset.sec }
    })
  }
  for (const g of document.querySelectorAll('#settings-dialog [data-set]')) {
    const p = g.dataset.set
    if (g.tagName === 'INPUT' && g.type === 'checkbox') {
      g.addEventListener('change', () => saveSetting(patchFor(p, g.checked)))
    } else {
      for (const b of g.querySelectorAll('button[data-v]')) {
        b.addEventListener('click', () => {
          const raw = b.dataset.v
          saveSetting(patchFor(p, /^\d+$/.test(raw) ? Number(raw) : raw))
        })
      }
    }
  }
  $('#srv-save').addEventListener('click', () => {
    const urls = [$('#srv-url-1').value.trim(), $('#srv-url-2').value.trim()].filter(Boolean)
    saveSetting({ server: { urls } })
  })
  $('#srv-login').addEventListener('click', () => { dlg.close(); openLogin() })
  $('#srv-logout').addEventListener('click', async () => {
    await call(api.logout).catch(() => {})
    S.settings = await call(api.settings)
    renderSettings()
  })
  $('#term-args-save').addEventListener('click', async () => {
    await saveSetting({ terminals: { claudeArgs: $('#term-claude-args').value.trim() } })
    $('#term-args-status').textContent = 'Guardado: se usará en las pestañas de Claude que abras a partir de ahora.'
  })
  $('#test-notify').addEventListener('click', () => call(api.testNotify).catch(() => {}))
  $('#open-logs').addEventListener('click', () => call(api.openLogs).catch(() => {}))
}

// ── Arranque ─────────────────────────────────────────────────────────────────────────────────
async function start() {
  const init = await call(api.init)
  S.settings = init.settings
  S.dark = init.dark
  S.version = init.version
  setHour12(init.hour12)
  applyWidths()
  document.querySelector('#toasts-off').hidden = !init.toastsOff
  $('#version').textContent = `v${init.version}${init.demo ? ' · demo' : ''}`
  for (const c of init.connections) { S.conns[c.id] = { state: c.state, detail: c.detail } }
  S.active = init.settings.lastConnection || 'local'
  S.current = { conn: S.active, sid: null }
  S.modelChoice = { local: init.settings.models?.local || null, server: init.settings.models?.server || null, claude: init.settings.models?.claude || null }
  applyLook()
  renderConnSwitch()
  renderBanner()
  newChatView()
  api.onEvent(onEvent)
  await terms.init(init.settings)
  wireLayout()
  applyLayout()
  wireSettings()
  wirePetPicker()
  wireExtras()
  S.reasoning = init.settings.chat?.reasoning || ''
  updateExtrasPills()

  for (const b of document.querySelectorAll('#conn-switch button')) { b.addEventListener('click', () => switchConn(b.dataset.conn)) }
  $('#new-chat').addEventListener('click', newChatView)
  $('#search').addEventListener('input', e => { S.search = e.target.value; renderList() })
  const input = $('#input')
  input.addEventListener('input', () => { autoGrow(); updateComposer() })
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSendClick() }
  })
  $('#send').addEventListener('click', onSendClick)
  $('#model-pill').addEventListener('click', openModelMenu)
  document.addEventListener('click', e => { const m = $('#model-menu'); if (!m.hidden && !m.contains(e.target) && e.target !== $('#model-pill')) { m.hidden = true } })
  for (const c of document.querySelectorAll('.suggestions .chip')) {
    c.addEventListener('click', () => { input.value = c.textContent.replace(/…$/, ' '); autoGrow(); updateComposer(); input.focus(); input.setSelectionRange(input.value.length, input.value.length) })
  }
  $('#login-form').addEventListener('submit', submitLogin)
  $('#login-cancel').addEventListener('click', () => $('#login-dialog').close())
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); terms.openNewDialog(); return }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n' && terms.mode !== 'terms') { e.preventDefault(); newChatView() }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings() }
    if (e.key === 'Escape') { $('#model-menu').hidden = true }
  })
  const petEl = $('#pet')
  petEl.addEventListener('click', () => pet.flash('waving', 2))
  petEl.addEventListener('mouseenter', () => { if (pet.base === 'idle') { pet.flash('waving', 1) } })

  if (init.pet) {
    await applyPet(init.pet).catch(() => {})
  } else {
    // Primera vez: la mascota se está descargando de Petdex; aparece en cuanto llega.
    $('#pet-stage').hidden = true
    for (let i = 0; i < 20 && !S.pet; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const mine = await call(api.petsInstalled).catch(() => [])
      const p = (mine || []).find(x => x.slug === S.settings.pet.slug) || (mine || [])[0]
      if (p) { await applyPet(p, { greet: true }).catch(() => {}); $('#pet-stage').hidden = !S.settings.pet.visible }
    }
  }
  pet.flash('waving', 2)
  welcomePet.setBase('idle')
  welcomePet.flash('waving', 3)
  setInterval(() => { if (!$('#welcome').hidden) { welcomePet.flash('waving', 1) } }, 15000)
  await loadSessions(S.active)
  for (const other of visibleConns()) { if (other !== S.active) { loadSessions(other) } }
  watchClaudeList()
  try { S.claudeDefaults = await call(api.chatOptions, 'claude', '-') } catch { S.claudeDefaults = null }
  S.claudeDir = (S.settings.terminals && S.settings.terminals.dirs && S.settings.terminals.dirs[0]) || ''
  updateComposer()
  updateExtrasPills()
  if (!S.current.sid) { renderChat() }
}

start().catch(e => {
  document.body.append(el('pre', { class: 'error', text: 'No pude arrancar la pantalla: ' + e.message }))
})

// ── Terminales ───────────────────────────────────────────────────────────────────────────────
function makeTerms() {
  return createTerms({
    api, call, el, $, showPopup, askBox,
    toast: text => askBox({ title: 'No pude abrir la terminal', text, ok: 'Vale' }),
    onAgents: list => onClaudeAgents(list),
    openClaudeChat: sid => { terms.setMode('chats'); openChat('claude', sid) },
    onTopbar: () => setTopbar(),
    onChange: () => { schedulePanel(); updatePet() },
    onChatsMode: () => { watchClaudeList(); const ch = currentChat(); call(api.viewing, S.current.conn, S.current.sid, ch ? ch.title : '').catch(() => {}) }
  })
}

// ── Gestión de chats: menú, renombrar, fijar, archivar, borrar, exportar ─────────────────────
function closePopup() { $('#popup').hidden = true }

function showPopup(items, x, y) {
  const m = $('#popup')
  m.replaceChildren(...items.map(([label, fn, cls]) => el('button', { class: cls || '', text: label, onclick: () => { closePopup(); fn() } })))
  m.hidden = false
  const w = m.offsetWidth
  const h = m.offsetHeight
  m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px'
  m.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px'
}

function rowOf(conn, sid) {
  return S.sessions[conn].find(r => r.id === sid) || { id: sid, title: chat(conn, sid).title || 'Chat', pinned: false }
}

function openChatMenu(conn, sid, x, y) {
  const r = rowOf(conn, sid)
  showPopup([
    ['✏️ Renombrar', () => renameChat(conn, sid)],
    [r.pinned ? '📌 Quitar de fijados' : '📌 Fijar arriba', () => mutateChat(conn, sid, 'pin', !r.pinned)],
    ['🗄 Archivar', () => mutateChat(conn, sid, 'archive', true)],
    ['⬇️ Exportar a Markdown', () => exportChat(conn, sid)],
    conn === 'claude' ? ['▣ Seguir en una consola', () => chatToConsole(sid)] : null,
    conn === 'claude' ? ['📁 Abrir su carpeta', () => { const cwd = rowOf(conn, sid).cwd; if (cwd) { call(api.showFile, cwd).catch(() => {}) } }] : null,
    ['🗑 Borrar…', () => deleteChat(conn, sid), 'danger']
  ].filter(Boolean), x, y)
}

function askBox({ title, text = '', value = null, ok = 'Aceptar', danger = false }) {
  return new Promise(resolve => {
    const d = $('#ask-dialog')
    $('#ask-title').textContent = title
    $('#ask-text').textContent = text
    $('#ask-text').hidden = !text
    const input = $('#ask-input')
    input.hidden = value === null
    input.value = value || ''
    const okBtn = $('#ask-ok')
    okBtn.textContent = ok
    okBtn.className = danger ? 'btn-danger' : 'btn-primary'
    const done = v => { d.close(); okBtn.onclick = null; $('#ask-cancel').onclick = null; resolve(v) }
    okBtn.onclick = () => done(value === null ? true : input.value.trim() || null)
    $('#ask-cancel').onclick = () => done(value === null ? false : null)
    d.onclose = () => resolve(value === null ? false : null)
    d.showModal()
    if (value !== null) { input.focus(); input.select() } else { okBtn.focus() }
  })
}

async function renameChat(conn, sid) {
  const r = rowOf(conn, sid)
  const title = await askBox({ title: 'Renombrar el chat', value: chat(conn, sid).title || r.title, ok: 'Guardar' })
  if (!title) { return }
  if (await mutateChat(conn, sid, 'rename', title)) {
    chat(conn, sid).title = title
    r.title = title
    if (S.current.sid === sid) { setTopbar(); call(api.viewing, conn, sid, title).catch(() => {}) }
    renderList()
  }
}

async function deleteChat(conn, sid) {
  const title = chat(conn, sid).title || rowOf(conn, sid).title
  const yes = await askBox({ title: '¿Borrar este chat?', text: conn === 'claude'
    ? `La conversación «${title}» de Claude Code irá a la papelera de Windows (de ahí se puede recuperar). Ya no saldrá en Pedila ni en «claude --resume».`
    : `«${title}» desaparecerá de Pedila y de Hermes Desktop, con todos sus mensajes. No se puede deshacer. (Si solo quieres quitarlo de en medio, mejor «Archivar».)`, ok: 'Borrar', danger: true })
  if (yes) { await mutateChat(conn, sid, 'delete') }
}

async function mutateChat(conn, sid, op, value) {
  try {
    await call(api.mutate, conn, sid, op, value)
  } catch (e) {
    showToastLine(`No se pudo: ${e.message}`)
    return false
  }
  const rows = S.sessions[conn]
  const r = rows.find(x => x.id === sid)
  if (op === 'delete' || (op === 'archive' && value)) {
    S.sessions[conn] = rows.filter(x => x.id !== sid)
    if (op === 'delete') { S.chats.delete(key(conn, sid)) }
    if (S.current.conn === conn && S.current.sid === sid) { newChatView() }
    showToastLine(op === 'delete' ? 'Chat borrado.' : 'Chat archivado. Lo tienes en «Ver chats archivados».')
  } else if (r && op === 'pin') {
    r.pinned = Boolean(value)
  }
  renderList()
  reloadSessionsSoon(conn)
  return true
}

function chatMarkdown(conn, sid) {
  const ch = chat(conn, sid)
  const lines = [`# ${ch.title || 'Chat'}`, '', `_Exportado de Pedila · ${CONN_NAMES[conn]}${ch.model ? ' · ' + ch.model : ''} · ${new Date().toLocaleString('es')}_`, '']
  const turns = [...ch.transcript, ...(ch.live && ch.live.done ? [liveToTurn(ch.live)] : [])]
  for (const t of turns) {
    if (t.role === 'note') { lines.push(`> ℹ ${t.title}`, ''); continue }
    if (t.role === 'user') { lines.push('## Tú', '', t.text + (t.images && t.images.length ? `\n\n_(${t.images.length === 1 ? 'una imagen' : t.images.length + ' imágenes'})_` : ''), ''); continue }
    lines.push(`## ${WHO(conn)}`, '')
    for (const b of t.blocks) {
      if (b.type === 'text') { lines.push(b.text, ''); continue }
      const d = describeTool(b)
      lines.push(`> 🔧 ${d.title.replace(/`/g, "'")}${b.error ? ' — **falló**' : ''}`, '')
    }
  }
  return lines.join('\n')
}

async function exportChat(conn, sid) {
  const ch = chat(conn, sid)
  try {
    if (!ch.loaded) { ch.transcript = await call(api.transcript, conn, sid); ch.loaded = true }
    const r = await call(api.exportChat, ch.title || rowOf(conn, sid).title, chatMarkdown(conn, sid))
    if (r.saved) { showToastLine(`Guardado en ${r.file}`) }
  } catch (e) {
    showToastLine(`No pude exportar: ${e.message}`)
  }
}

async function openArchived() {
  const d = $('#archived-dialog')
  const list = $('#archived-list')
  const conn = S.active
  $('#archived-where').textContent = CONN_NAMES[conn]
  list.replaceChildren(el('p', { class: 'muted', text: 'Cargando…' }))
  d.showModal()
  try {
    const rows = await call(api.archived, conn)
    list.replaceChildren()
    if (!rows.length) { list.append(el('p', { class: 'muted', text: 'No hay chats archivados.' })); return }
    for (const r of rows) {
      const item = el('div', { class: 'arch-row' },
        el('div', { class: 'grow' }, el('div', { class: 'n', text: r.title }), el('div', { class: 'muted small', text: r.preview })),
        el('button', { class: 'btn-ghost', text: 'Abrir', onclick: () => { d.close(); openChat(conn, r.id) } }),
        el('button', { class: 'btn-ghost', text: 'Desarchivar', onclick: async () => { if (await mutateChat(conn, r.id, 'archive', false)) { item.remove(); loadSessions(conn) } } }),
        el('button', { class: 'btn-ghost danger', text: 'Borrar', onclick: async () => {
          const yes = await askBox({ title: '¿Borrar este chat?', text: `«${r.title}» se borrará para siempre (también de Hermes Desktop).`, ok: 'Borrar', danger: true })
          if (yes && await mutateChat(conn, r.id, 'delete')) { item.remove() }
          if (!d.open) { d.showModal() }
        } }))
      list.append(item)
    }
  } catch (e) {
    list.replaceChildren(el('p', { class: 'error', text: `No pude leerlos: ${e.message}` }))
  }
}

// ── Escribir: imágenes, solo consultar, razonamiento, frases ─────────────────────────────────
const READ_ONLY_NOTE = '[Modo solo consulta: puedes leer, buscar e investigar, pero NO cambies, borres, instales ni ejecutes nada que modifique archivos, programas o el sistema. Si hiciera falta un cambio, explícame cuál y pregúntame antes.]'
const REASONING = [['', 'el de Hermes'], ['low', 'rápido (low)'], ['medium', 'normal (medium)'], ['high', 'a fondo (high)'], ['xhigh', 'muy a fondo (xhigh)'], ['max', 'al máximo (max)']]
const effortName = v => (REASONING.find(r => r[0] === v) || [v, v])[1]

function updateExtrasPills() {
  const ro = $('#readonly-pill')
  ro.classList.toggle('on', S.readOnly)
  const who = WHO(S.current.conn)
  ro.title = S.readOnly ? `Solo consultar: ${who} no cambiará nada (pulsa para quitarlo)` : `Pulsa para que ${who} solo lea y consulte, sin cambiar nada`
  const rp = $('#reason-pill')
  const ch = currentChat()
  rp.disabled = false
  const eff = currentEffort()
  const label = eff.value ? effortName(eff.value) + (eff.own ? '' : ` · el de ${who === 'Claude' ? 'tu Claude' : 'Hermes'}`) : ch ? 'el del chat' : `el de ${who === 'Claude' ? 'tu Claude' : 'Hermes'}`
  rp.textContent = `🧠 ${label}${S.current.conn === 'claude' && eff.ultracode ? ' ⚡' : ''}`
  rp.title = ch ? `Cuánto piensa ${who} en este chat (pulsa para cambiarlo)` : `Cuánto piensa ${who} en el chat nuevo (pulsa para cambiar)`
  schedulePanel()
}

function renderAttach() {
  const strip = $('#attach-strip')
  strip.replaceChildren(...S.attach.map((a, i) => el('div', { class: 'att' },
    el('img', { src: a.url, alt: a.name, title: `${a.name} (pulsa para verla en grande)`, onclick: () => openImage(a.url, a.name) }),
    el('button', { class: 'att-x', text: '✕', title: 'Quitar', onclick: () => { S.attach.splice(i, 1); renderAttach(); updateComposer() } }))))
  strip.hidden = !S.attach.length
}

async function addImages(files) {
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { showToastLine('Solo se pueden adjuntar imágenes (PNG, JPG, WebP o GIF).'); continue }
    if (file.size > 15 * 1024 * 1024) { showToastLine(`«${file.name}» pasa de 15 MB.`); continue }
    if (S.attach.length >= 6) { showToastLine('Como mucho 6 imágenes por mensaje.'); break }
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) { bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)) }
    const ext = file.type.split('/')[1].replace('jpeg', 'jpg')
    const b64 = btoa(bin)
    // La miniatura va como data: (la política de seguridad de la ventana no deja cargar blob:).
    S.attach.push({ name: file.name && file.name !== 'image.png' ? file.name : `captura-${Date.now()}.${ext}`, b64, url: `data:${file.type};base64,${b64}` })
  }
  renderAttach()
  updateComposer()
}

function snippetMatches() {
  const v = $('#input').value
  if (!v.startsWith('/') || v.includes('\n') || v.length > 40) { return null }
  const q = v.slice(1).toLowerCase()
  return (S.settings.snippets || []).filter(x => x.name.toLowerCase().includes(q))
}

function closeSnippets() { $('#snip-menu').hidden = true }

function updateSnippets() {
  const list = snippetMatches()
  const m = $('#snip-menu')
  if (!list || !list.length) { m.hidden = true; return }
  m.replaceChildren(el('div', { class: 'mh', text: 'Frases rápidas (Tab o clic para usar)' }), ...list.map(x => el('button', { text: x.name, title: x.text, onclick: () => useSnippet(x) })))
  const box = $('#composer').getBoundingClientRect()
  const main = $('#main').getBoundingClientRect()
  m.style.left = (box.left - main.left) + 'px'
  m.style.bottom = (main.bottom - box.top + 6) + 'px'
  m.hidden = false
}

function useSnippet(x) {
  const t = $('#input')
  t.value = x.text
  closeSnippets()
  autoGrow()
  updateComposer()
  t.focus()
  t.setSelectionRange(t.value.length, t.value.length)
}

// ── Sonido al terminar (generado aquí, sin archivos) ─────────────────────────────────────────
let audioCtx = null
function chime() {
  try {
    audioCtx = audioCtx || new AudioContext()
    const now = audioCtx.currentTime
    for (const [freq, at] of [[880, 0], [1318.5, 0.12]]) {
      const o = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, now + at)
      g.gain.exponentialRampToValueAtTime(0.12, now + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45)
      o.connect(g).connect(audioCtx.destination)
      o.start(now + at)
      o.stop(now + at + 0.5)
    }
  } catch {}
}

// ── Panel derecho: uso y parámetros ──────────────────────────────────────────────────────────
// Como las tarjetas de Claude Panel: lo que pasa ahora, el chat abierto y el uso, siempre a la vista.
const P = { usage: { local: null, server: null, claude: null }, at: { local: 0, server: 0, claude: 0 }, loading: { local: false, server: false, claude: false }, done: { local: null, server: null, claude: null }, raf: 0, day: '', hold: false, held: false, reconciling: false }
const panelOn = () => S.settings && S.settings.window && S.settings.window.sidePanel !== false

function applyPanel() {
  const on = panelOn()
  $('#app').classList.toggle('with-panel', on)
  applyWidths()
  const b = $('#panel-toggle')
  b.classList.toggle('active', on)
  b.setAttribute('aria-pressed', String(on))
  schedulePanel()
}

function schedulePanel() {
  if (P.hold || P.dragging) { P.held = true; return }
  if (P.raf || !panelOn()) { return }
  P.raf = requestAnimationFrame(() => { P.raf = 0; renderPanel() })
}

/** El resumen de uso de una conexión, como mucho una vez por minuto (o al acabar una respuesta). */
async function loadPanelUsage(conn, force = false) {
  if (P.loading[conn] || (!force && Date.now() - P.at[conn] < 60000)) { return }
  if (!S.conns[conn] || S.conns[conn].state !== 'ready') { return }
  P.loading[conn] = true
  try { P.usage[conn] = await call(api.usage, conn); P.at[conn] = Date.now() } catch { P.at[conn] = Date.now() } finally { P.loading[conn] = false }
  schedulePanel()
}

const spKv = pairs => el('dl', { class: 'sp-kv' }, ...pairs.filter(Boolean).flatMap(([k, v, t]) => [el('dt', { text: k }), el('dd', { text: v, title: t || v })]))

function hermesNow() {
  const all = [...S.chats.values()]
  const live = all.filter(c => (c.live && !c.live.done) || c.running)
  // También lo que Hermes hace fuera de esta ventana (Hermes Desktop, o empezado antes de abrir Pedila).
  const remote = remoteBusy(S.active)
  if (all.some(c => c.prompts.size) || remote.some(a => a.status === 'waiting')) { return { cls: 'need', text: 'Hermes te necesita', live, remote } }
  if (live.some(c => c.live && !c.live.done && c.live.blocks.some(b => b.type === 'tool' && !b.done))) { return { cls: 'busy', text: 'Usando herramientas', live, remote } }
  if (live.length || remote.length) { return { cls: 'busy', text: 'Trabajando', live, remote } }
  if (all.some(c => liveSubs(c))) { return { cls: 'busy', text: 'Subagentes trabajando', live, remote } }
  return { cls: 'idle', text: 'Tranquilo', live, remote }
}

function panelChatCard() {
  const ch = currentChat()
  if (!ch) {
    return el('section', { class: 'sp-card' }, el('h4', { text: 'Este chat' }),
      el('p', { class: 'muted small', text: `Chat nuevo en ${CONN_NAMES[S.current.conn]}. Al empezar verás aquí su memoria, sus tokens y su velocidad.` }))
  }
  const u = ch.usage || {}
  const max = u.max || ch.contextMax || 0
  const pct = u.used && max ? Math.min(100, Math.round(u.used / max * 100)) : 0
  const row = (S.sessions[ch.conn] || []).find(r => r.id === ch.sid) || {}
  const turns = [...(ch.transcript || []), ...(ch.live ? [ch.live] : [])]
  const tools = turns.reduce((n, t) => n + ((t.blocks || []).filter(b => b.type === 'tool').length), 0)
  const last = [...(ch.transcript || [])].reverse().find(t => t.role === 'assistant' && t.stats)
  const ring = el('div', { class: 'sp-ring' + (pct >= 80 ? ' warn' : ''), style: `--p:${pct}`, title: 'Memoria del chat: Hermes resume lo antiguo al 85 %' }, el('span', { text: max ? pct + '%' : '—' }))
  return el('section', { class: 'sp-card' }, el('h4', { text: 'Este chat' }),
    el('div', { class: 'sp-ctx' }, ring, el('div', { class: 'sp-ctx-txt' },
      el('b', { text: 'Memoria usada' }),
      el('span', { class: 'muted', text: max ? `${kfmt(u.used || 0)} de ${kfmt(max)} tokens` : 'Aún sin datos' }))),
    spKv([
      ['Modelo', ch.model || '—'],
      (() => { const e = currentEffort(); return e.value ? ['Esfuerzo', effortName(e.value) + (ch.conn === 'claude' && e.ultracode ? ' · Ultracode' : '')] : null })(),
      ch.provider ? ['Proveedor', ch.provider] : null,
      ['Mensajes', String(row.messages || turns.length || 0)],
      ['Tokens leídos', kfmt(row.inputTokens || 0)],
      ['Tokens escritos', kfmt(row.outputTokens || u.out || 0)],
      ['Herramientas', String(tools)],
      last ? ['Última respuesta', statsText(last.stats) || '—'] : null
    ]))
}

function panelNowCard() {
  const now = hermesNow()
  const model = $('#model-pill') ? $('#model-pill').textContent.replace(/^Modelo:\s*/, '') : ''
  return el('section', { class: 'sp-card' }, el('h4', { text: 'Ahora' }),
    el('div', { class: 'sp-state' }, el('span', { class: 'dot ' + now.cls }), el('span', { text: now.text })),
    spKv([
      ['Chats en marcha', String(now.live.length + now.remote.length)],
      ['Solo consultar', S.readOnly ? 'sí' : 'no'],
      // El razonamiento y el modelo se eligen al empezar un chat; con uno abierto, el modelo sale en «Este chat».
      (() => { const e = currentEffort(); return [currentChat() ? 'Esfuerzo (este chat)' : 'Esfuerzo (chat nuevo)', e.value ? effortName(e.value) : `el de ${WHO(S.current.conn) === 'Claude' ? 'tu Claude' : 'Hermes'}`] })(),
      !currentChat() ? ['Modelo (chat nuevo)', model || '—'] : null
    ]))
}

/**
 * La primera fila de «Uso»: a qué hora respondió Hermes por última vez y cuánto hace, o, con
 * Hermes trabajando, desde qué hora. El tiempo se pone al día solo (tickPanel), sin repintar.
 */
function panelLastTiles(conn, u) {
  const now = Date.now()
  const busyChats = [...S.chats.values()].filter(c => c.conn === conn && busy(c))
  const remote = remoteBusy(conn)
  const total = busyChats.length + remote.length
  if (total) {
    // Inicio: el envío o el comienzo del turno que vio Pedila; si el chat se abrió con Hermes ya
    // trabajando, tu último mensaje guardado. De lo empezado fuera de esta ventana Hermes no da la hora.
    const starts = busyChats.map(c => c.turnAt || toMs([...(c.transcript || [])].reverse().find(t => t.role === 'user' && t.ts)?.ts)).filter(t => t > 0 && t <= now + 60000)
    const first = starts.length ? Math.min(...starts, now) : 0
    const label = total > 1 ? `${total} tareas en marcha` : 'en marcha'
    if (!first) {
      // Un clic la abre aquí y entonces ya se ve desde cuándo trabaja.
      const row = total === 1 && remote.length ? listedRow(conn, remote[0].id) : null
      const open = row ? () => openChat(conn, row.id) : null
      const names = remote.map(a => a.title || (listedRow(conn, a.id) || {}).title).filter(Boolean)
      return [el('div', { class: 'sp-num sp-wide' + (open ? ' sp-go' : ''), title: open ? `Abrir «${row.title || 'el chat'}»` : names.join(' · '), ...opener(open, 'busy') },
        el('b', { text: 'Trabajando ahora' }), el('span', { text: total > 1 ? label : 'una tarea en marcha' }))]
    }
    const day = dayLabel(first)
    return [
      el('div', { class: 'sp-num', title: `Empezó: ${full(first)}` }, el('b', { text: hhmm(first) }), el('span', { text: `empezó la tarea${day ? ' · ' + day : ''}` })),
      el('div', { class: 'sp-num', title: 'Lo que lleva Hermes con esta tarea' }, el('b', { 'data-span': first, text: span(now - first) }), el('span', { text: label }))
    ]
  }
  // Lo más reciente entre lo que vio terminar Pedila (al momento) y la última actividad que guarda
  // Hermes (cuenta también lo hecho desde Hermes Desktop u otros sitios, y sobrevive a reinicios).
  const fromHermes = u && u.last && u.last.at ? u.last : null
  const mine = P.done[conn]
  const last = mine && (!fromHermes || mine.at >= fromHermes.at) ? { at: mine.at, id: mine.sid, title: (S.chats.get(key(conn, mine.sid)) || {}).title || '' } : fromHermes
  if (!last) { return [] }
  const at = Math.min(last.at, now)
  const day = dayLabel(at)
  // Solo se abre si el chat está en la lista (no archivado ni borrado).
  const row = last.id ? listedRow(conn, last.id) : null
  const name = (row && row.title) || last.title || ''
  const open = row ? () => openChat(conn, row.id) : null
  return [
    el('div', { class: 'sp-num' + (open ? ' sp-go' : ''), title: `${open ? `Abrir «${name || 'el chat'}»` : name || 'Última respuesta'} · ${full(at)}`, ...opener(open, 'last') },
      el('b', { text: hhmm(at) }), el('span', { text: `última respuesta${day ? ' · ' + day : ''}` })),
    el('div', { class: 'sp-num', title: 'El tiempo que ha pasado desde la última respuesta de Hermes' }, el('b', { 'data-span': at, text: span(now - at) }), el('span', { text: 'desde entonces' }))
  ]
}

// El chat solo si está en la lista (ni archivado ni borrado); rowOf da uno de relleno.
const listedRow = (conn, id) => (S.sessions[conn] || []).find(r => r.id === id) || null

/** Atributos de una tarjeta del panel que abre un chat, con ratón o teclado. */
function opener(open, focus) {
  if (!open) { return {} }
  return { role: 'button', tabindex: '0', 'data-focus': focus, onclick: open, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } } }
}

/**
 * Chats en los que Hermes trabaja sin que esta ventana los siga (empezados en Hermes Desktop, o
 * antes de abrir Pedila), según la última consulta a `session.active_list`. Lo que esta ventana
 * sigue manda, y lo que vio terminar después de esa consulta ya no cuenta.
 */
function remoteBusy(conn) {
  const u = P.usage[conn]
  // Sin conexión, o con una consulta de hace más de 3 minutos, no se sabe: no se cuenta nada.
  if (!u || !Array.isArray(u.active) || !S.conns[conn] || S.conns[conn].state !== 'ready' || Date.now() - (u.activeAt || 0) > 180000) { return [] }
  return u.active.filter(a => {
    const ch = S.chats.get(key(conn, a.id))
    return !(ch && (busy(ch) || (ch.doneAt || 0) >= (u.activeAt || 0)))
  })
}

/** Cada segundo: los relojes del panel («25 min», «40 s») al día; al cambiar de día se repinta (hoy → ayer). */
function tickPanel() {
  if (!panelOn()) { return }
  const d = new Date().toDateString()
  if (P.day && P.day !== d) { schedulePanel(); return }
  for (const n of document.querySelectorAll('#panel-body [data-span]')) { n.textContent = span(Date.now() - Number(n.dataset.span)) }
}

function panelUsageCard() {
  const conn = S.active
  const u = P.usage[conn]
  loadPanelUsage(conn)
  const head = el('h4', {}, el('span', { class: 'grow', text: `Uso · ${CONN_NAMES[conn]}` }), el('button', { class: 'sp-link', text: 'Ver todo', 'data-focus': 'usage-all', onclick: () => openUsage(conn) }))
  if (!u) { return el('section', { class: 'sp-card' }, head, el('p', { class: 'muted small', text: S.conns[conn] && S.conns[conn].state === 'ready' ? 'Calculando…' : 'Sin conexión.' })) }
  const days = u.days.slice(-14)
  const max = Math.max(1, ...days.map(d => d.chats))
  const today = u.today || { chats: 0, input: 0, output: 0 }
  const week = u.week || { chats: 0, input: 0, output: 0 }
  return el('section', { class: 'sp-card' }, head,
    el('div', { class: 'sp-nums' },
      ...panelLastTiles(conn, u),
      el('div', { class: 'sp-num' }, el('b', { text: String(today.chats) }), el('span', { text: 'chats hoy' })),
      el('div', { class: 'sp-num' }, el('b', { text: kfmt(today.input + today.output) }), el('span', { text: 'tokens hoy' })),
      el('div', { class: 'sp-num' }, el('b', { text: String(week.chats) }), el('span', { text: 'chats en 7 días' })),
      el('div', { class: 'sp-num' }, el('b', { text: kfmt(week.input + week.output) }), el('span', { text: 'tokens en 7 días' }))),
    el('div', { class: 'sp-spark', title: 'Chats por día, últimos 14 días' }, ...days.map(d => el('div', { class: d.chats ? '' : 'zero', style: `height:${d.chats ? Math.max(8, Math.round(d.chats / max * 100)) : 4}%`, title: `${d.date}: ${d.chats} chats · ${kfmt(d.input + d.output)} tokens` }))),
    el('div', { class: 'sp-spark-l' }, el('span', { text: 'hace 14 días' }), el('span', { text: 'hoy' })))
}

/** Qué cuentan los tokens por modelo, para los textos de ayuda. */
function modelsHow(u) {
  return u && u.modelsFrom === 'hermes'
    ? 'Tokens leídos + escritos de cada modelo en el último año, según las estadísticas de Hermes: todos sus chats y también lo que gasta en resumir la memoria, poner títulos o ver imágenes.'
    : 'Tokens leídos + escritos de cada modelo, sumando tus chats.'
}

/** Los modelos que más tokens han gastado (leídos + escritos), no los de más chats. */
function panelModelsCard() {
  const u = P.usage[S.active]
  const used = u && Array.isArray(u.models) ? u.models.filter(m => tokensOf(m) > 0) : []
  if (!used.length) { return null }
  const top = used.slice(0, 4)
  const max = Math.max(1, ...top.map(tokensOf))
  return el('section', { class: 'sp-card' }, el('h4', { text: 'Modelos más usados', title: modelsHow(u) }),
    ...top.map(m => {
      const n = tokensOf(m)
      const aux = tasksLine(m.tasks)
      return el('div', { class: 'sp-model', title: `${m.model}\n${kfmt(n)} tokens: ${kfmt(m.input)} leídos · ${kfmt(m.output)} escritos${aux ? `\nIncluye ${aux}` : ''}` },
        el('span', { class: 'n', text: modelName(m.model) }), el('span', { class: 'muted', text: `${kfmt(n)} tokens` }),
        el('div', { class: 'sp-bar' }, el('i', { style: `width:${Math.max(2, Math.round(n / max * 100))}%` })))
    }))
}

// ── Cuotas de las APIs de pago (OpenRouter, Venice, OpenCode) ───────────────────────────────
// Las lee el complemento «pedila» dentro de Hermes (las claves no salen de allí). La tarjeta solo
// aparece si ese Hermes tiene alguna de esas APIs: con el complemento, las que tienen clave; sin él,
// un botón para activarlo si Hermes tiene alguna puesta. Si no, no se ve nada.
const Q = { data: { local: null, server: null, claude: null }, at: { local: 0, server: 0, claude: 0 }, loading: { local: false, server: false, claude: false }, again: { local: false, server: false, claude: false }, gen: { local: 0, server: 0, claude: 0 }, err: { local: '', server: '', claude: '' }, login: { local: false, server: false, claude: false }, note: { local: '', server: '', claude: '' }, busy: { local: '', server: '', claude: '' }, ask: { local: null, server: null, claude: null }, installed: { local: false, server: false, claude: false } }
const QUOTA_NAMES = { openrouter: 'OpenRouter', venice: 'Venice', 'opencode-go': 'OpenCode Go', 'opencode-zen': 'OpenCode Zen' }
const RESET_NAMES = { daily: 'cada día', weekly: 'cada semana', monthly: 'cada mes' }

/** Olvida las cuotas de una conexión (otra dirección, otra sesión…): se vuelven a pedir. */
function forgetQuotas(conn) {
  Q.gen[conn]++ // lo que esté llegando de antes ya no vale
  Q.data[conn] = null
  Q.at[conn] = 0
  Q.err[conn] = ''
  Q.note[conn] = ''
  Q.ask[conn] = null
  Q.installed[conn] = false
}

/** Las cuotas de una conexión, como mucho una vez por minuto (o al pulsar ↻). */
async function loadQuotas(conn, fresh = false) {
  if (Q.loading[conn]) { if (fresh) { Q.again[conn] = true } return }
  if (!fresh && Date.now() - Q.at[conn] < 60000) { return }
  if (!S.conns[conn] || S.conns[conn].state !== 'ready') { return }
  Q.loading[conn] = true
  const gen = Q.gen[conn]
  try {
    const r = await call(api.quotas, conn, fresh)
    if (gen !== Q.gen[conn]) { return }
    Q.data[conn] = r
    Q.err[conn] = ''
    Q.login[conn] = false
    if (r && r.state === 'ok') { Q.note[conn] = ''; Q.installed[conn] = false }
  } catch (e) {
    if (gen === Q.gen[conn]) { Q.err[conn] = e.message || String(e); Q.login[conn] = Boolean(e.needLogin) }
  } finally {
    if (gen === Q.gen[conn]) { Q.at[conn] = Date.now() }
    Q.loading[conn] = false
    schedulePanel()
    // Alguien pidió leer de nuevo mientras tanto (↻ o justo tras instalar): se lee otra vez.
    if (Q.again[conn]) { Q.again[conn] = false; loadQuotas(conn, true) }
  }
}

async function installQuotas(conn, force = false) {
  if (Q.busy[conn] === 'installing') { return }
  Q.busy[conn] = 'installing'
  Q.ask[conn] = null
  Q.note[conn] = ''
  schedulePanel()
  try {
    const r = await call(api.quotasInstall, conn, force)
    Q.busy[conn] = ''
    if (!r.ok) {
      // El análisis de seguridad de Hermes puso una pega: se enseña y decide la persona.
      if (r.scan) { Q.ask[conn] = { scan: r.scan, findings: r.findings || [] } } else { Q.note[conn] = r.error || 'No pude activar las cuotas.' }
      schedulePanel()
      return
    }
    Q.installed[conn] = true
    if (r.restart) { Q.note[conn] = 'Complemento instalado. Si las cuotas no salen en un momento, reinicia Hermes y pulsa «Ya lo reinicié: comprobar».' }
    schedulePanel()
    await loadQuotas(conn, true)
  } catch (e) {
    Q.busy[conn] = ''
    Q.note[conn] = `No pude activar las cuotas: ${e.message || e}`
    // Puede que se cortara la espera pero Hermes sí lo instalara: se vuelve a mirar.
    loadQuotas(conn, true)
    schedulePanel()
  }
}

function quotaBar(usedPct, warnAt = 80) {
  const p = Math.max(0, Math.min(100, usedPct))
  return el('div', { class: 'sp-bar q-bar' + (p >= warnAt ? ' warn' : '') }, el('i', { style: `width:${Math.max(p > 0 ? 2 : 0, Math.round(p))}%` }))
}

/** «se reinicia en 3 h 10 min (21:00)» o «se reinicia mañana, 19:00». */
function resetText(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) { return '' }
  if (ms <= now) { return 'se reinicia ahora' }
  if (ms - now < 24 * 3600e3) { return `se reinicia en ${span(ms - now)} (${hhmm(ms)})` }
  return `se reinicia ${dayAhead(ms, now)} a las ${hhmm(ms)}`
}

function spentLine(sp) {
  if (!sp) { return null }
  const part = (label, x) => `${label} ${kfmt(x.tokens)}${x.cost > 0 ? ' · ' + usd(x.cost) : ''}`
  return el('div', { class: 'q-line muted', title: 'Lo que Hermes ha gastado con esta API según su propio registro: tokens leídos + escritos (y el coste, si Hermes lo conoce). Cuenta también resúmenes, títulos e imágenes.' },
    `Hermes gastó: ${part('24 h', sp.day)} · ${part('7 d', sp.week)} · ${part('30 d', sp.month)}`)
}

/**
 * Una medida de un proveedor, con el mismo molde para todos: nombre y valor en una línea, la barra
 * de lo gastado debajo y, si hace falta, una nota (cuándo se reinicia, desde cuándo cuenta…).
 */
function quotaMetric({ label, value, pct = null, note = '', warn = false, title = '' }) {
  return el('div', { class: 'q-win', title },
    el('span', { text: label }), el('b', { class: warn ? 'warn' : '', text: value }),
    pct === null ? null : quotaBar(pct),
    note ? el('span', { class: 'q-line muted', text: note }) : null)
}

// Para los saldos sin «total» (Venice), Pedila recuerda el más alto que ha visto desde la última
// recarga y la barra enseña lo gastado desde entonces. Si el saldo sube (recarga o día nuevo), se
// empieza a contar otra vez. Solo en este PC (es una ayuda para mirar, no un dato de la API).
const PEAKS_KEY = 'pedila.cuotas.picos'
let peaks = null
function observedUse(key, value, epoch = '') {
  if (typeof value !== 'number' || !Number.isFinite(value)) { return null }
  if (!peaks) { try { peaks = JSON.parse(localStorage.getItem(PEAKS_KEY) || '{}') || {} } catch { peaks = {} } }
  let r = peaks[key]
  if (!r || value > r.max + 1e-9 || (epoch && r.epoch !== epoch)) {
    r = { max: value, since: Date.now(), epoch }
    peaks[key] = r
    try { localStorage.setItem(PEAKS_KEY, JSON.stringify(peaks)) } catch {}
  }
  const spent = Math.max(0, r.max - value)
  return { pct: r.max > 0 ? spent / r.max * 100 : 0, spent, max: r.max, since: r.since }
}
const sinceText = (o, fmt) => (o.spent > 0 ? `gastado ${fmt(o.spent)} de ${fmt(o.max)} desde ${dayLabel(o.since)} ${hhmm(o.since)}` : `sin gastar desde ${dayLabel(o.since)} ${hhmm(o.since)}`)
const diemFmt = n => `${(n || 0).toLocaleString('es', { maximumFractionDigits: 2 })} DIEM`

function quotaBlock(p, conn = S.active) {
  const now = Date.now()
  const head = el('div', { class: 'q-head' }, el('b', { text: p.name || QUOTA_NAMES[p.kind] || p.kind }))
  const big = (text, title) => head.append(el('span', { class: 'q-big', text, title }))
  const rows = []
  const line = (text, cls = 'muted', title = '') => rows.push(el('div', { class: 'q-line ' + cls, text, title }))
  if (!p.ok) {
    line(`No pude leerla: ${p.error}`, 'warn')
  } else if (p.kind === 'openrouter') {
    big(usd(p.balance), 'Saldo de créditos que te queda en OpenRouter')
    if (p.creditsTotal > 0 && p.creditsUsed !== null) {
      rows.push(quotaMetric({ label: 'Créditos', value: `${usd(p.balance)} de ${usd(p.creditsTotal)}`, pct: p.creditsUsed / p.creditsTotal * 100, note: `gastado ${usd(p.creditsUsed)} de lo comprado` }))
    }
    if (p.keyLimit) {
      const used = p.keyLimit.remaining !== null ? p.keyLimit.limit - p.keyLimit.remaining : null
      const at = nextUtcReset(p.keyLimit.reset, now)
      rows.push(quotaMetric({ label: 'Límite de la clave', value: `${usd(p.keyLimit.remaining)} de ${usd(p.keyLimit.limit)}`, pct: used !== null ? used / p.keyLimit.limit * 100 : null, note: p.keyLimit.reset ? `${RESET_NAMES[p.keyLimit.reset]}, ${resetText(at, now)}` : 'no se reinicia' }))
    }
    const ku = p.keyUsage || {}
    if (ku.total !== null && ku.total !== undefined) { line(`Esta clave: hoy ${usd(ku.day)} · semana ${usd(ku.week)} · mes ${usd(ku.month)} · total ${usd(ku.total)}`) }
    if (p.freeTier) { line('Sin créditos comprados: los modelos «:free» tienen un límite de peticiones al día que vuelve a las 00:00 UTC.') }
  } else if (p.kind === 'venice') {
    big(usd((p.usd || 0) + (p.bundled || 0)), 'Saldo USD + créditos incluidos en tu plan')
    const epoch = p.nextEpoch ? Date.parse(p.nextEpoch) : NaN
    const k = `${conn}:venice:`
    if (p.bundled !== null && p.bundled !== undefined) {
      const o = observedUse(k + 'bundled', p.bundled)
      rows.push(quotaMetric({ label: 'Créditos del plan', value: usd(p.bundled), pct: o ? o.pct : null, note: o ? sinceText(o, usd) : '', title: 'La barra cuenta lo gastado desde el saldo más alto que Pedila ha visto (se reinicia al recargar)' }))
    }
    if (p.usd !== null && p.usd !== undefined) {
      const o = observedUse(k + 'usd', p.usd)
      rows.push(quotaMetric({ label: 'Saldo USD', value: usd(p.usd), pct: o ? o.pct : null, note: o ? sinceText(o, usd) : '' }))
    }
    if (p.diem !== null && p.diem !== undefined) {
      const o = observedUse(k + 'diem', p.diem, p.nextEpoch || '')
      rows.push(quotaMetric({ label: 'DIEM de hoy', value: diemFmt(p.diem), pct: o ? o.pct : null, note: Number.isFinite(epoch) ? resetText(epoch, now) : '', title: '1 DIEM = 1 $ de uso al día mientras lo tienes en stake; lo que no gastas no se acumula' }))
    }
    if (p.tier) { line(`Plan: ${p.tier}`) }
    if (p.access === false) { line('Sin acceso: Venice no deja usar la API (falta saldo).', 'warn') }
    if (p.keyExpires) { line(`La clave caduca el ${full(Date.parse(p.keyExpires))}`) }
    if (p.modelLimits.length) {
      const fmtL = m => [m.rpm ? `${kfmt(m.rpm)}/min` : '', m.rpd ? `${kfmt(m.rpd)}/día` : '', m.tpm ? `${kfmt(m.tpm)} tokens/min` : ''].filter(Boolean).join(' · ')
      rows.push(el('details', { class: 'q-more' }, el('summary', { text: `Límites por modelo (${p.modelLimits.length})` }),
        ...p.modelLimits.map(m => el('div', { class: 'q-line muted', title: m.model, text: `${modelName(m.model)}: ${fmtL(m)}` }))))
    }
  } else if (p.kind === 'opencode-go') {
    if (!p.windows.length) {
      line('OpenCode no dio el uso de tu plan.')
    } else {
      big(`${Math.round(100 - Math.max(0, ...p.windows.map(w => w.percent)))} %`, 'Lo que te queda de la ventana más gastada')
    }
    const label = { rolling: 'Ventana de 5 h', weekly: 'Semana', monthly: 'Mes' }
    for (const w of p.windows) {
      const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      rows.push(quotaMetric({ label: label[w.id] || w.label, value: `${Math.round(w.percent)} % usado`, pct: w.percent, note: Number.isFinite(at) ? resetText(at, now) : '' }))
    }
  } else if (p.kind === 'opencode-zen') {
    line('OpenCode no publica el saldo de Zen (míralo en opencode.ai). Aquí sale lo que Hermes ha gastado con ella.')
  }
  return el('div', { class: 'q-prov' }, head, ...rows, spentLine(p.spent))
}

function panelQuotasCard() {
  const conn = S.active
  if (conn === 'claude') { return claudePlanCard() }
  loadQuotas(conn)
  const q = Q.data[conn]
  const title = `Cuotas · ${CONN_NAMES[conn]}`
  const refresh = el('button', { class: 'sp-link', text: Q.loading[conn] ? '…' : '↻', title: 'Volver a leer las cuotas', 'aria-label': 'Volver a leer las cuotas', 'data-focus': 'quotas-refresh', onclick: () => loadQuotas(conn, true) })
  const note = Q.note[conn] ? el('div', { class: 'q-line warn', text: Q.note[conn] }) : null
  const err = Q.err[conn] ? el('div', { class: 'q-line warn', text: `No pude leer las cuotas: ${Q.err[conn]}` }) : null
  if (!q) {
    // La primera lectura falló: se dice, con la opción de reintentar (si no, no hay nada que enseñar).
    return err ? el('section', { class: 'sp-card' }, el('h4', {}, el('span', { class: 'grow', text: title }), refresh), err, Q.login[conn] ? loginAgain(conn) : null) : null
  }
  if (q.state === 'missing') {
    if (!Array.isArray(q.paid) || !q.paid.length) { return null }
    const names = q.paid.map(k => QUOTA_NAMES[k] || k).join(', ')
    const busy = Q.busy[conn] === 'installing'
    const ask = Q.ask[conn]
    const parts = [el('h4', { text: title }),
      el('p', { class: 'small', text: `Este Hermes usa ${names}. Pedila puede enseñarte lo que te queda de cada una: saldo, límites, cuándo se reinician y lo que llevas gastado.` }),
      el('p', { class: 'muted small', text: 'Para eso instala en Hermes un complemento pequeño de Pedila: lee el saldo dentro de Hermes y solo devuelve números, así tus claves no salen de allí. No toca tus chats ni reinicia Hermes.' })]
    // Al cargar un complemento, un Hermes con usuario y contraseña sin «secret» fijo cierra las sesiones de su web.
    if (conn === 'server') { parts.push(el('p', { class: 'muted small', text: 'Ojo: al cargarlo, el Hermes del servidor puede cerrar las sesiones de su página (también la de Pedila) y tendrás que volver a iniciar sesión una vez.' })) }
    if (ask && ask.scan === 'dangerous') {
      parts.push(el('div', { class: 'q-ask' },
        el('p', { class: 'small warn', text: 'El análisis de seguridad de Hermes no deja instalar este complemento.' }),
        ...ask.findings.map(f => el('div', { class: 'q-line muted', text: '• ' + f })),
        el('div', { class: 'q-actions' }, el('button', { class: 'btn-ghost', text: 'Entendido', onclick: () => { Q.ask[conn] = null; schedulePanel() } }))))
    } else if (ask) {
      parts.push(el('div', { class: 'q-ask' },
        el('p', { class: 'small', text: 'El análisis de seguridad de Hermes pide confirmación. Es lo esperable: el complemento usa tus claves dentro de Hermes para preguntar el saldo.' }),
        ...ask.findings.map(f => el('div', { class: 'q-line muted', text: '• ' + f })),
        el('div', { class: 'q-actions' },
          el('button', { class: 'btn-primary', text: 'Instalar igualmente', onclick: () => installQuotas(conn, true) }),
          el('button', { class: 'btn-ghost', text: 'Ahora no', onclick: () => { Q.ask[conn] = null; schedulePanel() } }))))
    } else if (Q.installed[conn]) {
      parts.push(el('button', { class: 'btn-ghost', text: Q.loading[conn] ? 'Comprobando…' : 'Ya lo reinicié: comprobar', disabled: Q.loading[conn], onclick: () => loadQuotas(conn, true) }))
    } else {
      parts.push(el('button', { class: 'btn-primary', text: busy ? 'Instalando… (puede tardar un minuto)' : 'Activar cuotas', disabled: busy, onclick: () => installQuotas(conn) }))
    }
    if (note) { parts.push(note) }
    if (err) { parts.push(err) }
    if (Q.login[conn]) { parts.push(loginAgain(conn)) }
    return el('section', { class: 'sp-card' }, ...parts)
  }
  const provs = q.data && Array.isArray(q.data.providers) ? q.data.providers : []
  if (!provs.length) { return null }
  const at = q.data.fetchedAt ? Date.parse(q.data.fetchedAt) : NaN
  return el('section', { class: 'sp-card' },
    el('h4', {}, el('span', { class: 'grow', text: title }),
      Number.isFinite(at) ? el('span', { class: 'q-ago', text: ago(at), title: `Leído: ${full(at)}` }) : null, refresh),
    ...provs.map(pv => quotaBlock(pv, conn)),
    err, Q.login[conn] ? loginAgain(conn) : null)
}

/** Hermes cerró la sesión (por ejemplo, al cargar el complemento): botón para entrar otra vez. */
function loginAgain(conn) {
  if (conn !== 'server') { return null }
  return el('div', { class: 'q-actions' }, el('button', { class: 'btn-primary', text: 'Iniciar sesión otra vez', onclick: () => openLogin() }))
}

function panelConnsCard() {
  return el('section', { class: 'sp-card' }, el('h4', { text: 'Conexiones' }),
    ...visibleConns().filter(c => S.conns[c]).map(c => {
      const st = S.conns[c]
      const what = { ready: 'conectado', connecting: 'conectando…', offline: 'sin conexión', login: 'falta iniciar sesión', setup: 'falta su dirección', missing: 'sin Hermes instalado', error: 'error', off: 'apagado' }[st.state] || st.state
      return el('div', { class: 'sp-conn', title: connLabel(c) }, el('span', { class: 'dot ' + st.state }), el('span', { text: CONN_NAMES[c] }), el('span', { class: 's', text: st.state === 'ready' && st.detail ? `${what} · ${st.detail}` : what }))
    }))
}

function renderPanel() {
  if (!panelOn() || !S.settings) { return }
  const body = $('#panel-body')
  const top = body.scrollTop
  // Con el foco en una tarjeta que se puede pulsar, al repintar se le devuelve (teclado).
  const focused = body.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null
  // Las tarjetas y su orden salen de Ajustes → Diseño (cada una dice en qué modo se ve).
  const L = layout()
  const on = terms.mode === 'terms' ? L.cardsTerms : L.cardsChats
  const cards = []
  for (const id of L.cards) {
    if (!on.includes(id) || !CARDS[id]) { continue }
    const c = CARDS[id].make()
    if (!c) { continue }
    c.dataset.card = id
    const h = c.querySelector('h4')
    if (h) { h.classList.add('drag-handle'); h.title = 'Arrastra para cambiar de sitio' }
    cards.push(c)
  }
  body.replaceChildren(...cards)
  body.scrollTop = top
  P.day = new Date().toDateString()
  if (focused) { body.querySelector(`[data-focus="${focused}"]`)?.focus({ preventScroll: true }) }
}

// ── Tareas: el plan de Hermes y lo que está haciendo (como en Claude Code) ──────────────────
// El plan sale de su herramienta todo_list (avisos todo.updated, o el último resultado guardado);
// lo demás, de lo que ya llega del turno: estado, herramientas en marcha y subagentes.
const COMPACT_TEXT = 'Resumiendo la memoria del chat'
const TODO_ICON = { completed: '✓', in_progress: '●', pending: '○', cancelled: '✕' }
const TODO_NAME = { completed: 'Hecha', in_progress: 'En curso', pending: 'Pendiente', cancelled: 'Cancelada' }
const SUB_ICON = { running: '⟳', queued: '○', done: '✓', failed: '✕', stopped: '■', gone: '–' }
const liveSubs = c => { let n = 0; for (const sa of c.subagents.values()) { if (sa.state === 'running' || sa.state === 'queued') { n++ } } return n }

/**
 * Los subagentes que Pedila cree vivos se comparan cada 10 s con los que Hermes tiene de verdad
 * (subagent.list): un hijo que nunca arrancó, o cuyo aviso de fin se perdió (reconexión, reinicio
 * del gateway), deja de salir «trabajando» para siempre. Dos faltas seguidas = «terminó».
 */
async function reconcileSubagents() {
  if (P.reconciling) { return }
  P.reconciling = true
  try { await reconcileOnce() } finally { P.reconciling = false }
}

async function reconcileOnce() {
  for (const c of S.chats.values()) {
    if (!liveSubs(c) || !S.conns[c.conn] || S.conns[c.conn].state !== 'ready') { continue }
    let list
    try { list = await call(api.subagents, c.conn, c.sid) } catch { continue }
    if (!Array.isArray(list)) { continue }
    const byId = new Map(list.map(x => [x.id, x]))
    let changed = false
    for (const sa of c.subagents.values()) {
      if (sa.state !== 'running' && sa.state !== 'queued') { continue }
      const live = byId.get(sa.id)
      if (live) {
        sa.misses = 0
        if (live.tools != null && live.tools !== sa.tools) { sa.tools = live.tools; changed = true }
        if (live.tool && live.tool !== sa.tool) { sa.tool = live.tool; changed = true }
      } else if ((sa.misses = (sa.misses || 0) + 1) >= 2) {
        sa.state = 'gone'
        sa.seconds = (Date.now() - sa.since) / 1000
        changed = true
      }
    }
    if (changed) { schedulePanel(); updatePet() }
  }
}

/** El chat del que se enseñan las tareas: el abierto si tiene algo; si no, uno de esta conexión con Hermes trabajando. */
function taskChat() {
  const has = c => c && ((c.todos && c.todos.items.length) || busy(c) || c.subagents.size)
  const cur = currentChat()
  if (has(cur)) { return cur }
  const working = [...S.chats.values()].filter(c => c.conn === S.active && (busy(c) || liveSubs(c)))
  return working.find(c => busy(c) && c.todos && c.todos.items.length) || working.find(c => busy(c)) || working[0] || null
}

/** Las tareas en su orden, cada subtarea debajo de la suya (sangrada). */
function todoRows(items) {
  const ids = new Set(items.map(t => t.id))
  const kids = new Map()
  for (const t of items) {
    if (t.parent && t.parent !== t.id && ids.has(t.parent)) { kids.set(t.parent, [...(kids.get(t.parent) || []), t]) }
  }
  const out = []
  const seen = new Set()
  const walk = (t, depth) => {
    if (seen.has(t) || depth > 6) { return }
    seen.add(t)
    out.push({ t, depth })
    for (const k of kids.get(t.id) || []) { walk(k, depth + 1) }
  }
  for (const t of items) { if (!t.parent || !ids.has(t.parent)) { walk(t, 0) } }
  for (const t of items) { if (!seen.has(t)) { out.push({ t, depth: 0 }) } }
  return out
}

function panelTasksCard() {
  const ch = taskChat()
  const items = ch && ch.todos ? ch.todos.items : []
  const counted = items.filter(t => t.status !== 'cancelled')
  const done = counted.filter(t => t.status === 'completed').length
  const head = el('h4', {}, el('span', { text: 'Tareas' }), counted.length ? el('span', { class: 'sp-count', title: `${done} de ${counted.length} hechas`, text: `${done}/${counted.length}` }) : null)
  if (!ch) {
    // Lo que Hermes hace fuera de esta ventana no trae su plan: un clic lo abre aquí y entonces sí.
    const other = remoteBusy(S.active).map(a => listedRow(S.active, a.id)).find(Boolean)
    return el('section', { class: 'sp-card' }, head, other
      ? el('button', { class: 'sp-hint', 'data-focus': 'tasks-other', text: `Hermes está trabajando en «${other.title || 'un chat'}». Ábrelo para ver su plan y su progreso.`, onclick: () => openChat(S.active, other.id) })
      : el('p', { class: 'sp-hint', text: `Nada en marcha. Cuando ${WHO(S.active)} trabaje en algo, aquí verás su plan, lo que está haciendo${S.active === 'claude' ? ', sus tareas en segundo plano' : ''} y cuánto lleva.` }))
  }
  const running = busy(ch)
  const parts = [head]
  if (ch !== currentChat()) {
    parts.push(el('button', { class: 'sp-where', 'data-focus': 'tasks-where', title: 'Abrir este chat', text: `En «${ch.title || 'otro chat'}»`, onclick: () => openChat(ch.conn, ch.sid) }))
  }
  if (counted.length) {
    parts.push(el('div', { class: 'sp-progress', role: 'progressbar', 'aria-label': 'Tareas hechas', 'aria-valuemin': '0', 'aria-valuemax': String(counted.length), 'aria-valuenow': String(done) },
      el('i', { style: `width:${Math.round(done / counted.length * 100)}%` })))
  }
  if (items.length) {
    parts.push(el('ul', { class: 'sp-todo' }, ...todoRows(items).map(({ t, depth }) => el('li', {
      class: t.status + (running && t.status === 'in_progress' ? ' live' : ''),
      style: depth ? `padding-left:${depth * 14}px` : null,
      title: TODO_NAME[t.status] || ''
    }, el('span', { class: 'i', text: TODO_ICON[t.status] || '○' }), el('span', { class: 't', text: t.content })))))
    const waiting = liveSubs(ch)
    if (!running && waiting) { parts.push(el('p', { class: 'sp-note', text: `Esperando a ${waiting === 1 ? 'un subagente' : waiting + ' subagentes'}.` })) }
    else if (!running && done < counted.length) { parts.push(el('p', { class: 'sp-note', text: 'Se quedó con pasos sin hacer.' })) }
  }
  if (running) {
    const L = ch.live && !ch.live.done ? ch.live : null
    const status = L ? L.status : 'Trabajando'
    const tools = L ? L.blocks.filter(b => b.type === 'tool') : []
    const since = L && L.status === COMPACT_TEXT && L.compactAt ? L.compactAt : 0
    parts.push(el('div', { class: 'sp-now' + (items.length ? '' : ' solo') }, el('span', { class: 'spin' }), el('span', { class: 't', title: status, text: status }),
      since ? el('span', { class: 'w', title: 'Lo que lleva resumiendo', 'data-span': since, text: span(Date.now() - since) })
        : tools.length ? el('span', { class: 'w', title: 'Herramientas usadas en esta respuesta', text: `${tools.length} herr.` }) : null))
    for (const b of tools.filter(b => !b.done).slice(-4)) {
      parts.push(el('div', { class: 'sp-run running' }, el('span', { class: 'i', text: '⟳' }),
        el('span', { class: 't' }, el('b', { text: b.name || 'herramienta' }), b.args ? el('span', { class: 'd', title: b.args, text: b.args }) : null),
        b.startedAt ? el('span', { class: 'w', 'data-span': b.startedAt, text: span(Date.now() - b.startedAt) }) : null))
    }
  }
  const subs = [...ch.subagents.values()].sort((a, b) => (a.index || 0) - (b.index || 0))
  if (subs.length) {
    parts.push(el('div', { class: 'sp-sub-h', text: `${ch.conn === 'claude' ? 'Tareas en segundo plano' : 'Subagentes'} · ${subs.filter(x => x.state === 'done').length}/${subs.length}` }))
    for (const sa of subs) {
      const what = sa.state === 'running' ? (sa.tool ? `usando ${sa.tool}` : sa.text || 'trabajando')
        : { queued: 'en cola', failed: 'falló', stopped: 'parado', gone: 'terminó' }[sa.state] || 'hecho'
      const goal = sa.goal || `Subagente ${(sa.index || 0) + 1}`
      parts.push(el('div', { class: 'sp-run ' + sa.state }, el('span', { class: 'i', text: SUB_ICON[sa.state] || '○' }),
        el('span', { class: 't' }, el('b', { title: goal, text: goal }), el('span', { class: 'd', text: what + (sa.tools ? ` · ${sa.tools} herr.` : '') })),
        sa.state === 'running' ? el('span', { class: 'w', 'data-span': sa.since, text: span(Date.now() - sa.since) })
          : sa.seconds != null ? el('span', { class: 'w', text: span(sa.seconds * 1000) }) : null))
    }
  }
  if (!items.length && !running && !subs.length) { parts.push(el('p', { class: 'sp-hint', text: 'Nada en marcha.' })) }
  return el('section', { class: 'sp-card' }, ...parts)
}

// ── Anchos ajustables: la lista de chats y el panel derecho ──────────────────────────────────
// Se arrastra su raya (o flechas con el foco en ella; Inicio, Intro o doble clic: el ancho de
// siempre). Mismos límites que settings.js. Al chat le quedan siempre al menos MAIN_MIN píxeles:
// con la ventana estrecha cede primero el panel (hasta su mínimo) y después la lista, sin tocar lo
// guardado; así lo que se ve al soltar una raya es lo que queda.
const MAIN_MIN = 420
const WIDTHS = {
  side: { key: 'sideWidth', def: 286, min: 240, max: 520, css: '--side-w', box: '#sidebar', dir: 1 },
  panel: { key: 'panelWidth', def: 300, min: 240, max: 680, css: '--panel-w', box: '#side-panel', dir: -1 }
}
// Con la lista a la derecha (Diseño), cada raya crece hacia el otro lado.
const dirOf = d => d.dir * (layout().swap ? -1 : 1)
const widthOf = d => { const v = S.settings && S.settings.window ? S.settings.window[d.key] : null; return Number.isFinite(v) ? v : d.def }
// ≤ 900 px el CSS esconde el panel y las rayas y fija la lista: ahí no se ajusta nada.
const narrow = () => innerWidth <= 900
const panelShown = () => panelOn() && !narrow()

/** Los anchos que caben: los guardados, o encogidos (primero el panel) para dejar MAIN_MIN al chat. */
function fittedWidths(side = widthOf(WIDTHS.side), panel = widthOf(WIDTHS.panel)) {
  const room = Math.max(0, innerWidth - MAIN_MIN)
  if (!panelShown()) { return { side: Math.max(WIDTHS.side.min, Math.min(side, room)), panel } }
  if (side + panel > room) { panel = Math.max(WIDTHS.panel.min, room - side) }
  if (side + panel > room) { side = Math.max(WIDTHS.side.min, room - panel) }
  return { side, panel }
}

function applyWidths() {
  const fit = fittedWidths()
  for (const [name, d] of Object.entries(WIDTHS)) {
    $('#app').style.setProperty(d.css, fit[name] + 'px')
    const h = document.querySelector(`.resizer[data-side="${name}"]`)
    if (h) { h.setAttribute('aria-valuenow', String(fit[name])); h.setAttribute('aria-valuemin', String(d.min)); h.setAttribute('aria-valuemax', String(d.max)) }
  }
}

function wireResizers() {
  for (const h of document.querySelectorAll('.resizer')) {
    const name = h.dataset.side
    const d = WIDTHS[name]
    if (!d) { continue }
    // Lo más que puede crecer ahora sin quitar sitio a la otra columna: su máximo, o lo que deje
    // al chat con MAIN_MIN. La otra no se mueve mientras se arrastra.
    const ceiling = () => {
      const other = name === 'side' ? (panelShown() ? $('#side-panel').getBoundingClientRect().width : 0) : $('#sidebar').getBoundingClientRect().width
      return Math.max(d.min, Math.min(d.max, Math.floor(innerWidth - MAIN_MIN - other)))
    }
    const show = (px, top = ceiling()) => {
      const v = Math.round(Math.min(top, Math.max(d.min, px)))
      $('#app').style.setProperty(d.css, v + 'px')
      h.setAttribute('aria-valuenow', String(v))
      // Con la ventana justa, al estrechar la lista el panel recupera su ancho a la vez (no de golpe al soltar).
      if (name === 'side' && panelShown()) { $('#app').style.setProperty(WIDTHS.panel.css, fittedWidths(v).panel + 'px') }
      return v
    }
    const save = v => saveSetting({ window: { [d.key]: v } }).then(applyWidths)
    h.addEventListener('pointerdown', e => {
      if (e.button !== 0 || narrow()) { return }
      e.preventDefault()
      try { h.setPointerCapture(e.pointerId) } catch {}
      // Desde el ancho que se ve (con la ventana estrecha puede ser menor que el guardado).
      const startX = e.clientX
      const startW = $(d.box).getBoundingClientRect().width
      const top = ceiling()
      let last = null
      h.classList.add('active')
      document.body.classList.add('resizing')
      const move = ev => { last = show(startW + dirOf(d) * (ev.clientX - startX), top) }
      const end = () => {
        h.removeEventListener('pointermove', move)
        h.removeEventListener('pointerup', end)
        h.removeEventListener('pointercancel', end)
        h.classList.remove('active')
        document.body.classList.remove('resizing')
        // Solo si se movió de verdad: un intento de ensanchar que no cabía no guarda el ancho apretado.
        if (last !== null && last !== Math.round(startW) && last !== widthOf(d)) { save(last) }
      }
      h.addEventListener('pointermove', move)
      h.addEventListener('pointerup', end)
      h.addEventListener('pointercancel', end)
    })
    h.addEventListener('dblclick', () => { if (!narrow()) { show(d.def); save(null) } })
    h.addEventListener('keydown', e => {
      if (narrow()) { return }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const step = (e.shiftKey ? 48 : 16) * (e.key === 'ArrowRight' ? 1 : -1) * dirOf(d)
        const before = Math.round($(d.box).getBoundingClientRect().width)
        const v = show(before + step)
        if (v !== before) { save(v) }
      } else if (e.key === 'Home' || e.key === 'Enter') {
        e.preventDefault()
        show(d.def)
        save(null)
      }
    })
  }
  let fitRaf = 0
  addEventListener('resize', () => { if (!fitRaf) { fitRaf = requestAnimationFrame(() => { fitRaf = 0; applyWidths() }) } })
}

// ── Tu uso ───────────────────────────────────────────────────────────────────────────────────
async function openUsage(conn = S.active) {
  const d = $('#usage-dialog')
  for (const b of document.querySelectorAll('#usage-tabs button')) { b.classList.toggle('active', b.dataset.conn === conn) }
  const body = $('#usage-body')
  body.replaceChildren(el('p', { class: 'muted', text: 'Calculando…' }))
  if (!d.open) { d.showModal() }
  // Al cambiar de pestaña rápido, solo se pinta la última que se pidió.
  const seq = openUsage.seq = (openUsage.seq || 0) + 1
  try {
    const u = await call(api.usage, conn)
    if (seq !== openUsage.seq) { return }
    const max = Math.max(1, ...u.days.map(x => x.chats))
    const bars = el('div', { class: 'u-bars' }, ...u.days.map(x => el('div', { class: 'u-bar', title: `${x.date}: ${x.chats} chats` }, el('div', { style: `height:${Math.round(x.chats / max * 100)}%` }))))
    const active = u.days.filter(x => x.chats).length
    body.replaceChildren(
      el('div', { class: 'u-cards' },
        el('div', { class: 'u-card' }, el('b', { text: String(u.chats) }), el('span', { text: 'chats en total' })),
        el('div', { class: 'u-card' }, el('b', { text: String(u.messages) }), el('span', { text: 'mensajes' })),
        el('div', { class: 'u-card' }, el('b', { text: kfmt(u.input) }), el('span', { text: 'tokens leídos' })),
        el('div', { class: 'u-card' }, el('b', { text: kfmt(u.output) }), el('span', { text: 'tokens escritos' }))),
      el('h4', { text: `Chats por día (últimos 30 días · ${active} días con uso)` }), bars,
      el('h4', { text: 'Por modelo (de más a menos tokens)', title: modelsHow(u) }),
      el('table', { class: 'u-table' },
        el('tr', {}, el('th', { text: 'Modelo' }), el('th', { text: 'Tokens' }), el('th', { text: 'Leídos' }), el('th', { text: 'Escritos' })),
        ...u.models.slice(0, 15).map(m => {
          const aux = tasksLine(m.tasks)
          return el('tr', {},
            el('td', { title: m.model }, modelName(m.model), aux ? el('span', { class: 'u-sub', text: `incluye ${aux}` }) : null),
            el('td', { text: kfmt(tokensOf(m)) }), el('td', { text: kfmt(m.input) }), el('td', { text: kfmt(m.output) }))
        })),
      ...(u.models.length > 15 ? [el('p', { class: 'muted small', text: u.models.length === 16 ? 'Y 1 modelo más, con menos tokens.' : `Y ${u.models.length - 15} modelos más, con menos tokens.` })] : []),
      el('p', { class: 'muted small', text: u.modelsFrom === 'hermes'
        ? 'Por modelo: el último año, con las estadísticas de ese Hermes (cuentan también resumir la memoria, poner títulos…). Lo demás, con tus chats guardados allí. No sale nada de tu red.'
        : 'Calculado con tus chats guardados en ese Hermes; no sale nada de tu red.' }))
  } catch (e) {
    if (seq === openUsage.seq) { body.replaceChildren(el('p', { class: 'error', text: `No pude calcularlo: ${e.message}` })) }
  }
}

// ── Actualizaciones ──────────────────────────────────────────────────────────────────────────
// La versión nueva que hay (si la hay): la barra del chat y Ajustes → Acerca de enseñan el mismo botón.
let pendingVersion = null
let updating = false

/** Los dos botones (la barra y el de Ajustes): los dos «Descargando…» mientras se instala. */
function updateButtons() {
  for (const b of document.querySelectorAll('#update-bar .btn-primary, #upd-install')) {
    b.disabled = updating
    b.textContent = updating ? 'Descargando…' : b.id === 'upd-install' ? `Actualizar a ${pendingVersion} y reiniciar` : 'Actualizar y reiniciar'
  }
}

/** Descarga e instala la versión nueva (desde la barra o desde Ajustes). */
async function installUpdate(onError) {
  if (updating) { return }
  updating = true
  updateButtons()
  try {
    // «Ahora no» al aviso de las consolas abiertas: los botones vuelven a estar listos.
    if (await call(api.updateInstall) === false) { updating = false; updateButtons() }
  } catch (err) {
    updating = false
    updateButtons()
    onError(`No pude actualizar: ${err.message}`)
  }
}

function showUpdate(version, notes) {
  pendingVersion = version
  const b = $('#update-bar')
  b.replaceChildren(el('div', { class: 'grow' }, el('strong', { text: `Hay una versión nueva de Pedila (${version}). ` }), el('span', { class: 'muted', text: notes || '' })),
    el('button', { class: 'btn-primary', text: 'Actualizar y reiniciar', onclick: () => installUpdate(showToastLine) }))
  b.hidden = false
  updateInstallButton()
  updateButtons()
}

/** El botón de Ajustes → Acerca de: solo cuando hay una versión nueva. */
function updateInstallButton() {
  const btn = $('#upd-install')
  btn.hidden = !pendingVersion
  updateButtons()
}

function renderSnippetSettings() {
  const box = $('#snip-list')
  const list = S.settings.snippets || []
  box.replaceChildren(...list.map((x, i) => el('div', { class: 'snip-row' },
    el('div', { class: 'grow' }, el('div', { class: 'n', text: '/' + x.name }), el('div', { class: 'muted small', text: x.text })),
    el('button', { class: 'btn-ghost', text: 'Editar', onclick: async () => {
      const name = await askBox({ title: 'Nombre de la frase', value: x.name, ok: 'Siguiente' })
      if (!name) { return }
      const text = await askBox({ title: `Texto de «${name}»`, value: x.text, ok: 'Guardar' })
      if (!text) { return }
      const next = list.slice(); next[i] = { name, text }
      await saveSetting({ snippets: next })
      renderSnippetSettings()
    } }),
    el('button', { class: 'btn-ghost danger', text: 'Quitar', onclick: async () => { await saveSetting({ snippets: list.filter((_, j) => j !== i) }); renderSnippetSettings() } }))))
  if (!list.length) { box.append(el('p', { class: 'muted small', text: 'No tienes frases guardadas.' })) }
}

function wireExtras() {
  document.addEventListener('click', e => { const m = $('#popup'); if (!m.hidden && !m.contains(e.target)) { closePopup() } })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePopup(); closeSnippets() } })
  $('#chat-actions').addEventListener('click', e => { const ch = currentChat(); if (ch) { const b = e.currentTarget.getBoundingClientRect(); e.stopPropagation(); openChatMenu(ch.conn, ch.sid, b.left - 150, b.bottom + 4) } })
  $('#ctx-new').addEventListener('click', () => {
    const ch = currentChat()
    const title = ch ? ch.title : ''
    newChatView()
    $('#input').value = `Sigamos con lo que hablábamos en el chat «${title}». Si te hace falta el contexto, búscalo en tus sesiones anteriores.`
    autoGrow()
    updateComposer()
  })
  $('#ctx-hide').addEventListener('click', () => { const ch = currentChat(); if (ch) { S.ctxHidden.add(key(ch.conn, ch.sid)) } setTopbar() })
  $('#readonly-pill').addEventListener('click', () => { S.readOnly = !S.readOnly; updateExtrasPills() })
  $('#reason-pill').addEventListener('click', e => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const ch = currentChat()
    const who = WHO(S.current.conn)
    const eff = currentEffort()
    // Con un chat de Hermes ya empezado no hay «el predeterminado» (Hermes no tiene cómo volver a él).
    const options = REASONING.filter(([v]) => !(ch && v === '' && S.current.conn !== 'claude'))
    const mark = v => (eff.own ? v === eff.value : v === '') ? '✓ ' : ''
    const items = options.map(([v, name]) => [`${mark(v)}${v ? name : `el de ${who === 'Claude' ? 'tu Claude' : 'Hermes'}${eff.base ? ' (' + eff.base + ')' : ''}`}`, () => setReasoning(v)])
    // Ultracode va con el esfuerzo en Claude Code (/effort ultracode).
    if (S.current.conn === 'claude') { items.push([`${eff.ultracode ? '✓ ' : ''}⚡ Ultracode`, () => setUltracode(!eff.ultracode)]) }
    showPopup(items, r.left, r.top - Math.min(items.length * 34 + 16, 400))
  })
  $('#attach-btn').addEventListener('click', () => $('#file-input').click())
  $('#file-input').addEventListener('change', e => { addImages([...e.target.files]); e.target.value = '' })
  const input = $('#input')
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData && e.clipboardData.files ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'))
    if (files.length) { e.preventDefault(); addImages(files) }
  })
  const comp = $('#composer')
  comp.addEventListener('dragover', e => { e.preventDefault(); comp.classList.add('drop') })
  comp.addEventListener('dragleave', () => comp.classList.remove('drop'))
  comp.addEventListener('drop', e => { e.preventDefault(); comp.classList.remove('drop'); addImages([...e.dataTransfer.files]) })
  input.addEventListener('input', updateSnippets)
  input.addEventListener('keydown', e => {
    const list = snippetMatches()
    if (list && list.length && !$('#snip-menu').hidden && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); e.stopImmediatePropagation(); useSnippet(list[0]) }
  }, true)
  let ft = null
  $('#search').addEventListener('input', e => {
    clearTimeout(ft)
    const q = e.target.value.trim()
    const conn = S.active
    if (q.length < 3) { S.found[conn] = []; return }
    ft = setTimeout(async () => {
      try { S.found[conn] = await call(api.search, conn, q) } catch { S.found[conn] = [] }
      if (S.search.trim() === q) { renderList() }
    }, 400)
  })
  $('#open-usage').addEventListener('click', () => openUsage())
  $('#panel-toggle').addEventListener('click', () => saveSetting({ window: { sidePanel: !panelOn() } }).then(applyPanel))
  $('#term-close').addEventListener('click', () => terms.closeActive())
  wireResizers()
  // Al acabar una respuesta se recalcula el uso; además, cada 2 minutos.
  setInterval(() => { if (panelOn()) { loadPanelUsage(S.active, true) } }, 120000)
  // Los relojes del panel enseñan segundos: se ponen al día cada segundo (solo su texto).
  setInterval(tickPanel, 1000)
  setInterval(() => { if (panelOn()) { reconcileSubagents() } }, 10000)
  // Mientras se pulsa algo del panel no se rehace (el clic acabaría en un botón que ya no existe).
  $('#panel-body').addEventListener('pointerdown', () => { P.hold = true })
  // Lo mismo en el chat: al pulsar un grupo de herramientas mientras Claude o Hermes escriben.
  $('#messages').addEventListener('pointerdown', () => { liveHold = true })
  const release = () => {
    if (P.hold) { P.hold = false; if (P.held) { P.held = false; schedulePanel() } }
    if (liveHold) {
      liveHold = false
      if (liveHeldFull) { liveHeldFull = false; liveHeld = false; setTimeout(() => renderChat(nearBottom()), 0) } else if (liveHeld) { liveHeld = false; setTimeout(scheduleLive, 0) }
    }
  }
  addEventListener('pointerup', release, true)
  addEventListener('pointercancel', release, true)
  addEventListener('blur', release)
  for (const b of document.querySelectorAll('#usage-tabs button')) { b.addEventListener('click', () => openUsage(b.dataset.conn)) }
  $('#usage-close').addEventListener('click', () => $('#usage-dialog').close())
  $('#archived-close').addEventListener('click', () => $('#archived-dialog').close())
  $('#snip-add').addEventListener('click', async () => {
    const name = await askBox({ title: 'Nombre de la frase (lo que escribirás después de «/»)', value: '', ok: 'Siguiente' })
    if (!name) { return }
    const text = await askBox({ title: `Texto de «${name}»`, value: '', ok: 'Guardar' })
    if (!text) { return }
    await saveSetting({ snippets: [...(S.settings.snippets || []), { name, text }] })
    renderSnippetSettings()
  })
  $('#upd-save').addEventListener('click', () => saveSetting({ updates: { url: $('#upd-url').value.trim() } }))
  $('#upd-check').addEventListener('click', async () => {
    const st = $('#upd-status')
    st.textContent = 'Buscando…'
    try {
      const r = await call(api.updateCheck)
      st.textContent = !r ? 'Falta la dirección de actualizaciones.' : r.available ? `Hay una versión nueva: ${r.version}.` : `Tienes la última (${S.version}).`
      if (r && r.available) { showUpdate(r.version, r.notes) }
    } catch (e) { st.textContent = `No pude comprobarlo: ${e.message}` }
  })
  // Actualizar desde aquí mismo, sin cerrar Ajustes para ir a la barra del chat.
  $('#upd-install').addEventListener('click', () => installUpdate(text => { $('#upd-status').textContent = text }))
}

// ── Claude Code como chat ────────────────────────────────────────────────────────────────────
// Pedila abre tu `claude` directamente; aquí solo se elige la carpeta del chat nuevo, se enseña tu
// cuota del plan y se puede pasar una conversación a una consola.
const baseName = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''

function claudeDirs() {
  const seen = new Set()
  const out = []
  const add = d => { const k = String(d || '').toLowerCase(); if (d && !seen.has(k)) { seen.add(k); out.push(d) } }
  add(S.claudeDir)
  for (const d of (S.settings && S.settings.terminals && S.settings.terminals.dirs) || []) { add(d) }
  for (const r of S.sessions.claude || []) { add(r.cwd) }
  return out.slice(0, 14)
}

function updateDirPill() {
  const b = $('#dir-pill')
  const show = S.current.conn === 'claude' && !S.current.sid && shown('dir')
  b.hidden = !show
  if (!show) { return }
  b.textContent = `📁 ${baseName(S.claudeDir) || 'tu carpeta'}`
  b.title = `Claude trabajará en: ${S.claudeDir || 'tu carpeta personal'} (pulsa para cambiarla)`
}

async function setClaudeDir(dir) {
  S.claudeDir = dir
  const dirs = [dir, ...((S.settings.terminals && S.settings.terminals.dirs) || []).filter(d => d.toLowerCase() !== dir.toLowerCase())].slice(0, 10)
  await saveSetting({ terminals: { dirs } })
  updateComposer()
  renderChat()
}

function openDirMenu(e) {
  e.stopPropagation()
  const r = e.currentTarget.getBoundingClientRect()
  const items = claudeDirs().map(d => [`${d === S.claudeDir ? '✓ ' : ''}${baseName(d)} — ${d}`, () => setClaudeDir(d)])
  items.push(['📂 Elegir otra carpeta…', async () => {
    const dir = await call(api.termPickDir, S.claudeDir).catch(() => null)
    if (dir) { setClaudeDir(dir) }
  }])
  showPopup(items, r.left, r.top - Math.min(items.length * 34 + 16, 420))
}
$('#dir-pill').addEventListener('click', openDirMenu)

async function chatToConsole(sid) {
  try {
    const info = await call(api.mutate, 'claude', sid, 'console')
    terms.adopt(info)
  } catch (e) {
    askBox({ title: 'No pude abrirla en una consola', text: e.message, ok: 'Vale' })
  }
}

/** Tu cuota del plan de Claude, tal como la manda Claude Code con cada respuesta. */
function claudePlanCard() {
  const L = S.claudeLimits
  const names = { five_hour: 'Ventana de 5 h', seven_day: 'Semana', seven_day_opus: 'Semana · Opus', seven_day_sonnet: 'Semana · Sonnet' }
  const head = el('div', { class: 'q-head' }, el('b', { text: 'Claude' }))
  const rows = []
  const wins = L && L.unifiedWindows && typeof L.unifiedWindows === 'object' ? Object.entries(L.unifiedWindows).filter(([, w]) => w && typeof w.utilization === 'number') : []
  if (wins.length) { head.append(el('span', { class: 'q-big', text: `${Math.round(100 - Math.max(...wins.map(([, w]) => w.utilization * 100)))} %`, title: 'Lo que te queda de la ventana más gastada' })) }
  for (const [id, w] of wins) {
    const pct = w.utilization * 100
    rows.push(quotaMetric({ label: names[id] || id, value: `${Math.round(pct)} % usado`, pct, note: w.resetsAt ? resetText(w.resetsAt * 1000) : '' }))
  }
  if (L && L.status && L.status !== 'allowed') { rows.push(el('div', { class: 'q-line warn', text: 'Claude dice que has llegado al límite: espera a que se reinicie.' })) }
  if (!wins.length) { rows.push(el('div', { class: 'q-line muted', text: 'Se rellena con tu primer mensaje a Claude desde Pedila (Claude Code manda tu cuota con cada respuesta).' })) }
  return el('section', { class: 'sp-card' },
    el('h4', {}, el('span', { class: 'grow', text: 'Tu plan de Claude' }), L && L.at ? el('span', { class: 'q-ago', text: ago(L.at), title: `Leído: ${full(L.at)}` }) : null),
    el('div', { class: 'q-prov' }, head, ...rows))
}

// ── Diseño: orden y visibilidad de todo (Ajustes → Diseño, o arrastrando en su sitio) ─────────
const LAY_DEFAULT = {
  conns: ['local', 'server', 'claude'], connsHidden: [], modes: ['chats', 'terms'], modesHidden: [],
  cards: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones', 'consolas'],
  cardsChats: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'],
  cardsTerms: ['consolas', 'cuotas', 'conexiones'], swap: false, show: {}
}
function layout() {
  const l = S.settings && S.settings.layout
  return l && Array.isArray(l.cards) ? l : LAY_DEFAULT
}
const shown = k => layout().show[k] !== false
const CARDS = {
  ahora: { name: 'Ahora', make: () => panelNowCard() },
  tareas: { name: 'Tareas', make: () => panelTasksCard() },
  chat: { name: 'Este chat', make: () => panelChatCard() },
  uso: { name: 'Uso', make: () => panelUsageCard() },
  cuotas: { name: 'Cuotas de tus APIs / tu plan de Claude', make: () => panelQuotasCard() },
  modelos: { name: 'Modelos más usados', make: () => panelModelsCard() },
  conexiones: { name: 'Conexiones', make: () => panelConnsCard() },
  consolas: { name: 'Consolas abiertas', make: () => terms.panelCard() }
}
const MODE_NAMES = { chats: '💬 Chats', terms: '▣ Consolas' }
const SHOW_NAMES = {
  attach: '📎 Adjuntar imágenes', dir: '📁 Carpeta (chats de Claude)', model: 'Modelo', reason: '🧠 Esfuerzo',
  readonly: '🔒 Solo consultar', hint: 'Texto de ayuda «Enter para enviar»', suggestions: 'Sugerencias en el chat nuevo',
  search: 'Buscador de chats', version: 'Número de versión abajo', usageButton: 'Botón 📊 Tu uso'
}

async function saveLayout(patch) {
  await saveSetting({ layout: { ...layout(), ...patch } })
}

/** Aplica el diseño guardado: lado, orden de los modos y lo que se esconde. */
function applyLayout() {
  const L = layout()
  $('#app').classList.toggle('swap', Boolean(L.swap))
  const ms = $('#mode-switch')
  for (const m of L.modes) { const b = ms.querySelector(`button[data-mode="${m}"]`); if (b) { ms.append(b) } }
  for (const b of ms.querySelectorAll('button')) { b.hidden = L.modesHidden.includes(b.dataset.mode) }
  ms.hidden = L.modes.filter(m => !L.modesHidden.includes(m)).length < 2
  if (L.modesHidden.includes(terms.mode)) { terms.setMode(L.modes.find(m => !L.modesHidden.includes(m)) || 'chats') }
  $('#attach-btn').hidden = !shown('attach')
  $('#model-pill').hidden = !shown('model')
  $('#reason-pill').hidden = !shown('reason')
  $('#readonly-pill').hidden = !shown('readonly')
  $('#composer-hint').hidden = !shown('hint')
  $('.suggestions').hidden = !shown('suggestions')
  $('.search-wrap').classList.toggle('lay-off', !shown('search'))
  $('#version').hidden = !shown('version')
  $('#open-usage').hidden = !shown('usageButton')
  updateDirPill()
  renderConnSwitch()
  schedulePanel()
}

/**
 * Ordenar arrastrando (con el ratón; no usa el arrastre del navegador, que no se lleva bien con
 * los botones). `items`: los hijos que se mueven; `handle`: de dónde se coge (o todo el hijo);
 * `done(ids)`: el orden nuevo, con el data-id de cada uno.
 */
function sortable(box, { items, handle = null, horizontal = false, onStart = null, done }) {
  box.addEventListener('pointerdown', e => {
    if (e.button !== 0) { return }
    const grip = handle ? e.target.closest(handle) : e.target
    const it = grip && grip.closest(items)
    if (!it || !box.contains(it) || e.target.closest('input, select, textarea, a, .sp-link, summary')) { return }
    const x0 = e.clientX
    const y0 = e.clientY
    let dragging = false
    const move = ev => {
      if (!dragging) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 6) { return }
        dragging = true
        it.classList.add('dragging')
        document.body.classList.add('sorting')
        if (onStart) { onStart() }
      }
      ev.preventDefault()
      const others = [...box.querySelectorAll(items)].filter(o => o !== it && !o.hidden)
      for (const o of others) {
        const r = o.getBoundingClientRect()
        const inside = horizontal ? ev.clientX >= r.left && ev.clientX <= r.right : ev.clientY >= r.top && ev.clientY <= r.bottom
        if (!inside) { continue }
        const before = horizontal ? ev.clientX < r.left + r.width / 2 : ev.clientY < r.top + r.height / 2
        o.parentNode.insertBefore(it, before ? o : o.nextSibling)
        break
      }
    }
    const up = () => {
      removeEventListener('pointermove', move, true)
      removeEventListener('pointerup', up, true)
      removeEventListener('pointercancel', up, true)
      if (!dragging) { return }
      it.classList.remove('dragging')
      document.body.classList.remove('sorting')
      // El clic que llega justo al soltar no debe abrir nada (si no llega, el bloqueo se quita solo).
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
      addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => removeEventListener('click', swallow, true), 250)
      done([...box.querySelectorAll(items)].map(o => o.dataset.id || o.dataset.card || o.dataset.conn || o.dataset.mode))
    }
    addEventListener('pointermove', move, true)
    addEventListener('pointerup', up, true)
    addEventListener('pointercancel', up, true)
  })
}

/** Junta el orden visible con el completo: los que no se veían conservan su sitio relativo. */
function mergeOrder(full, visibleOrder) {
  const vis = new Set(visibleOrder)
  const queue = visibleOrder.slice()
  return full.map(id => (vis.has(id) ? queue.shift() : id))
}

function wireLayout() {
  sortable($('#conn-switch'), { items: 'button', horizontal: true, done: ids => saveLayout({ conns: mergeOrder(layout().conns, ids) }) })
  sortable($('#mode-switch'), { items: 'button', horizontal: true, done: ids => saveLayout({ modes: mergeOrder(layout().modes, ids) }) })
  sortable($('#panel-body'), {
    items: '.sp-card', handle: '.drag-handle',
    onStart: () => { P.dragging = true },
    done: ids => { P.dragging = false; saveLayout({ cards: mergeOrder(layout().cards, ids) }) }
  })
  addEventListener('pointerup', () => { if (P.dragging) { setTimeout(() => { P.dragging = false; schedulePanel() }, 0) } }, true)
  for (const b of document.querySelectorAll('#lay-swap button')) { b.addEventListener('click', () => saveLayout({ swap: b.dataset.v === 'true' })) }
  $('#lay-reset').addEventListener('click', async () => {
    const ok = await askBox({ title: '¿Volver al diseño de siempre?', text: 'Se recolocan las pestañas, las tarjetas y los botones como vienen de fábrica. No cambia nada más.', ok: 'Sí, volver' })
    if (ok) { await saveSetting({ layout: JSON.parse(JSON.stringify({ ...LAY_DEFAULT, show: {} })) }) }
  })
}

/** Una fila de Ajustes → Diseño: se arrastra por ⠿ o se mueve con ↑ ↓; a la derecha, sus interruptores. */
function layRow(id, name, list, key, toggles) {
  const i = list.indexOf(id)
  const move = d => { const o = list.slice(); o.splice(i, 1); o.splice(i + d, 0, id); saveLayout({ [key]: o }) }
  return el('div', { class: 'lay-row', 'data-id': id },
    el('span', { class: 'lay-grip', text: '⠿', title: 'Arrastra para cambiar de sitio' }),
    el('span', { class: 'lay-name', text: name }),
    el('button', { class: 'icon-mini', text: '↑', title: 'Subir', disabled: i <= 0, onclick: () => move(-1) }),
    el('button', { class: 'icon-mini', text: '↓', title: 'Bajar', disabled: i >= list.length - 1, onclick: () => move(1) }),
    ...toggles.map(([label, on, fn]) => el('label', { class: 'lay-tog' }, el('input', { type: 'checkbox', checked: on, onchange: e => fn(e.target.checked) }), el('span', { text: label }))))
}

function renderLayoutSettings() {
  const L = layout()
  for (const b of document.querySelectorAll('#lay-swap button')) { b.classList.toggle('active', String(Boolean(L.swap)) === b.dataset.v) }
  const toggleIn = (key, id) => on => { const set = new Set(L[key]); if (on) { set.add(id) } else { set.delete(id) } saveLayout({ [key]: [...set] }) }
  $('#lay-modes').replaceChildren(...L.modes.map(m => layRow(m, MODE_NAMES[m], L.modes, 'modes', [['Mostrar', !L.modesHidden.includes(m), on => toggleIn('modesHidden', m)(!on)]])))
  $('#lay-conns').replaceChildren(...L.conns.map(c => layRow(c, CONN_NAMES[c], L.conns, 'conns', [['Mostrar', !L.connsHidden.includes(c), on => toggleIn('connsHidden', c)(!on)]])))
  $('#lay-cards').replaceChildren(...L.cards.map(id => layRow(id, CARDS[id].name, L.cards, 'cards', [
    ['En chats', L.cardsChats.includes(id), toggleIn('cardsChats', id)],
    ['En consolas', L.cardsTerms.includes(id), toggleIn('cardsTerms', id)]
  ])))
  $('#lay-show').replaceChildren(...Object.entries(SHOW_NAMES).map(([k, name]) => el('label', { class: 'toggle' },
    el('input', { type: 'checkbox', checked: shown(k), onchange: e => saveLayout({ show: { ...L.show, [k]: e.target.checked } }) }), el('span', { text: name }))))
}

for (const [box, key] of [['#lay-modes', 'modes'], ['#lay-conns', 'conns'], ['#lay-cards', 'cards']]) {
  sortable($(box), { items: '.lay-row', handle: '.lay-grip', done: ids => saveLayout({ [key]: ids }) })
}

// ── Chats activos: un distintivo en la lista ─────────────────────────────────────────────────
/**
 * «trabajando» si ese chat está respondiendo (aquí, en una consola o en otra ventana de Claude
 * Code); «abierto» si está abierto en algún sitio pero esperando; «en Pedila» si lo tiene abierto
 * Pedila como chat. Las conversaciones abiertas las dice `claude agents --json`.
 */
function activeBadge(conn, r, running) {
  const open = conn === 'claude' ? S.claudeOpen.get(r.id) : null
  // Un chat de Pedila también sale en `claude agents` (su Claude lo lleva el anfitrión): no es «otra ventana».
  // De esos, Pedila ya sabe si trabajan (lo de `claude agents` llega con hasta 5 s de retraso).
  const mine = conn === 'claude' && r.active
  const other = open && !(mine && !open.term) ? open : null
  const busy = running || (other && other.status === 'busy')
  let text = ''
  let title = ''
  if (busy) {
    text = 'trabajando'
    title = running ? 'Respondiendo ahora en Pedila' : other.term ? 'Respondiendo ahora en una consola de Pedila' : 'Respondiendo ahora en otra ventana de Claude Code'
  } else if (other) {
    text = 'abierto'
    title = open.term ? 'Abierto en una consola de Pedila' : 'Abierto en otra ventana de Claude Code (si lo sigues aquí, ciérralo allí antes)'
  } else if (conn === 'claude' && r.active) {
    text = 'en Pedila'
    title = 'Abierto en Pedila como chat'
  }
  if (!text) { return null }
  return el('span', { class: 'live-badge' + (busy ? ' busy' : ''), title }, busy ? el('i') : null, text)
}

let claudeWatched = null
/** Con la lista de Claude a la vista, Pedila mira cada 5 s qué conversaciones están abiertas. */
function watchClaudeList() {
  const on = S.active === 'claude' && terms.mode !== 'terms'
  if (on === claudeWatched) { return }
  claudeWatched = on
  call(api.termAgents, on, 'chats').then(list => onClaudeAgents(list || [])).catch(() => {})
}

let claudeOpenSig = ''
function onClaudeAgents(list) {
  const m = new Map()
  for (const a of list || []) { if (a && a.sessionId) { m.set(a.sessionId, { status: a.status, term: a.term || null }) } }
  const sig = [...m].map(([k, v]) => `${k}:${v.status}:${v.term || ''}`).sort().join('|')
  if (sig === claudeOpenSig) { return }
  claudeOpenSig = sig
  S.claudeOpen = m
  if (S.active === 'claude') { renderList() }
}

// ── Modelo y razonamiento de un chat ya empezado ─────────────────────────────────────────────
/**
 * El esfuerzo que se ve en el botón: { value, own, base, ultracode }. own = elegido aquí para este
 * chat (o para el chat nuevo); si no, value es con el que trabaja (el de la última respuesta, o el
 * de «Opciones de Claude») y base el predeterminado.
 */
function currentEffort() {
  const ch = currentChat()
  const isClaude = S.current.conn === 'claude'
  if (!ch) {
    const base = isClaude ? (S.claudeDefaults && S.claudeDefaults.effective) || '' : ''
    return { value: S.reasoning || base, own: Boolean(S.reasoning), base, ultracode: isClaude && S.claudeDefaults ? S.claudeDefaults.ultracode : false }
  }
  if (ch.reasoningSet) { return { value: ch.reasoningSet, own: true, base: ch.effortBase || '', ultracode: Boolean(ch.ultracode) } }
  return { value: ch.effortNow || '', own: false, base: ch.effortBase || ch.effortNow || '', ultracode: Boolean(ch.ultracode) }
}

async function setUltracode(on) {
  const ch = currentChat()
  try {
    const r = await call(api.chatOptions, 'claude', ch ? ch.sid : '-', { ultracode: on })
    if (ch) { ch.ultracode = on } else if (S.claudeDefaults) { S.claudeDefaults.ultracode = on }
    updateExtrasPills()
    showNote(`Ultracode ${on ? 'activado' : 'desactivado'}${ch ? ' en este chat' : ''}${r && r.applied === 'next' ? ' (desde tu próximo mensaje)' : ''}.`)
  } catch (e) { showNote(`No pude cambiar Ultracode: ${e.message}`, true) }
}

async function setReasoning(v) {
  const ch = currentChat()
  if (!ch) {
    S.reasoning = v
    updateExtrasPills()
    call(api.settings, { chat: { reasoning: v } }).catch(() => {})
    return
  }
  try {
    const r = await call(api.chatOptions, ch.conn, ch.sid, { reasoning: v })
    ch.reasoningSet = v
    if (!v) { ch.effortNow = ch.effortBase || '' }
    updateExtrasPills()
    const name = v ? effortName(v) : 'el predeterminado'
    showNote(`Esfuerzo de este chat: ${name}${r && r.applied === 'next' ? ' (desde tu próximo mensaje)' : ''}.`)
  } catch (e) { showNote(`No pude cambiar el esfuerzo: ${e.message}`, true) }
}

/** Lo elegido antes para un chat de Claude (modelo y esfuerzo), para los botones. */
async function loadChatOptions(ch) {
  if (ch.conn !== 'claude' || ch.optsLoaded) { return }
  ch.optsLoaded = true
  try {
    const o = await call(api.chatOptions, ch.conn, ch.sid)
    if (o && o.effort) { ch.reasoningSet = o.effort }
    if (o && o.effective) { ch.effortNow = o.effective }
    ch.effortBase = (S.claudeDefaults && S.claudeDefaults.effective) || ''
    if (o) { ch.ultracode = Boolean(o.ultracode) }
    if (o && o.model && !ch.model) { ch.model = o.model }
    if (currentChat() === ch) { updateExtrasPills(); updateModelPill() }
  } catch {}
}

/** Un aviso corto encima del recuadro de escribir (el texto de ayuda vuelve a los 6 s). */
function showNote(text, bad = false) {
  const h = $('#composer-hint')
  h.textContent = text
  h.classList.toggle('error', bad)
  h.hidden = false
  clearTimeout(toastT)
  toastT = setTimeout(() => { h.textContent = 'Enter para enviar · Mayús+Enter, salto de línea'; h.classList.remove('error'); h.hidden = !shown('hint') }, 6000)
}

// Un error de la pantalla queda en el registro de Pedila (si no, un botón que falla no deja rastro).
addEventListener('error', e => { try { api.logError && api.logError(`${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`) } catch {} })
addEventListener('unhandledrejection', e => { try { api.logError && api.logError('promesa: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)) } catch {} })
