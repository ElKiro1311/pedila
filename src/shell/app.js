// Pedila: the screen. No Node; it talks to the main process through window.hp (preload).
import { Pet, loadSheet } from './pet.js'
import { describeTool, groupSummary, failedText } from './tools.mjs'
import { tr, setLang, getLang, locale, translateDom } from './i18n.mjs'
import { keyState, pluginNotice, quotaTotal, usedOf, localUse, nextPeak, NEARLY } from './quotas.mjs'
import { kfmt, setHour12, hhmm, full, clock, dayLabel, span, ago, tokensOf, modelName, tasksLine, usd, money, nextUtcReset, dayAhead, pct1, pctShort, trunc1 } from './fmt.mjs'

const demo = new URLSearchParams(location.search).get('demo') === '1'
const api = demo ? (await import('./demo.js')).demoApi : window.hp
// The language, before anything is painted (the page is written in English).
setLang(window.hp ? window.hp.lang : 'en')
document.documentElement.lang = getLang()
translateDom(document.body)
const $ = sel => document.querySelector(sel)
const CONN_NAMES = { local: tr('This PC'), server: tr('Server') }
const CONN_STATES = { ready: tr('connected'), connecting: tr('connecting…'), offline: tr('not connected'), login: tr('not signed in'), setup: tr('no address set'), missing: tr('Hermes not installed'), updating: tr('updating Hermes…'), error: 'error', off: tr('off') }
const NEED_LOGIN = ['You need to sign in', "You need to sign in to the server's Hermes"]
const CHOICE_LABELS = { once: tr('Allow once'), session: tr('Allow in this chat'), always: tr('Always allow'), deny: tr('Deny') }

// ── State ────────────────────────────────────────────────────────────────────────────────────
const S = {
  settings: null,
  dark: true,
  version: '',
  conns: { local: { state: 'off', detail: '' }, server: { state: 'off', detail: '' } },
  active: 'local',
  sessions: { local: [], server: [] },
  listLoaded: { local: false, server: false },
  listError: { local: '', server: '' },
  current: { conn: 'local', sid: null },
  chats: new Map(),
  modelChoice: { local: null, server: null },
  models: { local: null, server: null },
  search: '',
  found: { local: [], server: [] },
  // Hermes versions of each connection (the main process sends them).
  hermesUpd: {},
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

// ── Utilities ────────────────────────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) { continue }
    if (k === 'class') { n.className = v } else if (k === 'text') { n.textContent = v } else if (k.startsWith('on')) { n.addEventListener(k.slice(2), v) } else { n.setAttribute(k, v === true ? '' : v) }
  }
  for (const kid of kids.flat()) { if (kid !== null && kid !== undefined && kid !== false) { n.append(kid) } }
  return n
}

// Hermes delivers images (image_generate, screenshots…) with a "MEDIA:<path>" line. That line is replaced
// by a placeholder that fillMedia fills with the image, asked from that connection's gateway.
const MEDIA_LINE = /^[ \t]*`?MEDIA:[ \t]*(\S[^\n`]*?\.(?:png|jpe?g|gif|webp|bmp))`?[ \t]*$/gim

function md(text) {
  const src = String(text || '').replace(MEDIA_LINE, (_, p) => `\n\n<div class="media-img" data-media="${encodeURIComponent(p.trim())}"></div>\n\n`)
  const html = window.marked.parse(src, { gfm: true, breaks: true })
  return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] })
}

// Images already fetched, by connection and path: a promise while it arrives, then the data URL (or null
// if it failed; the failure is forgotten after 30 s, to try again). So repaints of the live chat don't ask
// for them again.
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
        // In a tool's details, if it can't be shown, it isn't (no error).
        if (box.dataset.quiet !== undefined) { box.remove(); return }
        box.classList.add('fail')
        box.textContent = tr("🖼 Couldn't load the image {0}", name)
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
    box.textContent = tr('Loading image…')
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

/** The image in full screen; a click or Esc closes it. */
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
    const b = el('button', { class: 'copy', text: tr('Copy') })
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText).then(() => { b.textContent = tr('Copied') ; setTimeout(() => { b.textContent = tr('Copy') }, 1200) }).catch(() => { b.textContent = tr("Couldn't copy") })
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
  if (!ms) { return tr('Older') }
  const d = new Date(ms)
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= start) { return tr('Today') }
  if (ms >= start - 86400000) { return tr('Yesterday') }
  if (ms >= start - 6 * 86400000) { return tr('Last 7 days') }
  if (d.getFullYear() === now.getFullYear()) { return d.toLocaleDateString(locale(), { month: 'long' }).replace(/^\w/, c => c.toUpperCase()) }
  return String(d.getFullYear())
}

// ── Look ─────────────────────────────────────────────────────────────────────────────────────
// Themes (palettes). The first one is the default; "Classic" is the one of the first versions.
const PALETTES = [
  { id: 'mensajera', name: tr('Messenger'), desc: tr('Ink, grays and gold, like Pedila.'), pet: true },
  { id: 'clasico', name: tr('Classic'), desc: tr('The original: cool grays and violet.') },
  { id: 'egeo', name: tr('Aegean'), desc: tr('Night-sea blue and gold.') },
  { id: 'anfora', name: tr('Amphora'), desc: tr('Black and terracotta, like Greek pottery.') },
  { id: 'olivo', name: tr('Olive'), desc: tr('Calm olive-grove greens.') },
  { id: 'claude', name: 'Claude', desc: tr('Slate, ivory and terracotta, like Claude.') }
]

function lookMode() {
  const L = S.settings.look
  return L.theme === 'system' ? (S.dark ? 'dark' : 'light') : L.theme
}

/** The cards of the theme menu: each one is painted with its palette, in the current mode. */
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
          el('span', { class: 'theme-name' }, p.name, p.id === PALETTES[0].id ? el('em', {}, tr('default')) : null),
          el('span', { class: 'theme-desc' }, p.desc),
          el('span', { class: 'theme-dots' }, el('span', { style: 'background: var(--bg)' }), el('span', { style: 'background: var(--surface-2)' }), el('span', { style: 'background: var(--text)' }), el('span', { style: 'background: var(--accent)' }))))
      // Choosing a theme goes back to its accent color.
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
  applyLayout()
}

// ── Connections ──────────────────────────────────────────────────────────────────────────────
/**
 * The Hermes this person has: the one on this PC if it's installed, and the server's if they set its address
 * in Settings. The others aren't shown (no tab, card or tray entry). With none, "This PC" stays, with the
 * notice on how to start.
 */
function visibleConns() {
  const v = []
  if (S.conns.local && S.conns.local.state !== 'missing') { v.push('local') }
  if (S.settings && S.settings.server && Array.isArray(S.settings.server.urls) && S.settings.server.urls.length) { v.push('server') }
  // The order and what is hidden, from Settings → Layout (if you hide everything, the first one you have
  // stays).
  const L = layout()
  const shown = L.conns.filter(c => v.includes(c) && !L.connsHidden.includes(c))
  return shown.length ? shown : (v.length ? [v[0]] : ['local'])
}

function renderConnSwitch() {
  schedulePanel()
  const vis = visibleConns()
  // With a single Hermes there's nothing to choose: the whole switch is hidden.
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

/** Hermes closes for a few seconds so as to load a new plugin (the connection's state is the one of updating). */
const restarting = st => st.state === 'updating' && st.detail === 'restarting'
const stateText = st => (restarting(st) ? tr('restarting Hermes…') : CONN_STATES[st.state] || st.state)

function connLabel(c) {
  const st = S.conns[c]
  return `${CONN_NAMES[c]}: ${stateText(st)}${st.detail && st.state !== 'ready' && !restarting(st) ? ' — ' + st.detail : ''}`
}

function renderBanner() {
  const b = $('#banner')
  const st = S.conns[S.active]
  b.className = ''
  b.replaceChildren()
  if (st.state === 'missing') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: tr("Can't find Hermes on this PC. ") }), el('span', { class: 'muted', text: tr('Install it here or, if your Hermes is on another computer, put its address in Settings → Server.') })),
      el('button', { class: 'btn-primary', text: tr('Open Settings'), onclick: () => openSettings('server') }))
  } else if (st.state === 'login') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: tr("You're not signed in to the server's Hermes. ") }), el('span', { class: 'muted', text: st.detail && !NEED_LOGIN.some(x => st.detail === tr(x)) ? st.detail : tr('Use the username and password of its web page.') })),
      el('button', { class: 'btn-primary', text: tr('Sign in'), onclick: openLogin }))
  } else if (st.state === 'setup') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: tr("Your server's address is missing. ") }), el('span', { class: 'muted', text: tr('Put it in Settings → Server (the address of its Hermes web page, for example http://192.168.1.50:9119).') })),
      el('button', { class: 'btn-primary', text: tr('Open Settings'), onclick: () => openSettings('server') }))
  } else if (st.state === 'offline' || st.state === 'error') {
    b.className = st.state
    b.append(el('div', { class: 'grow' }, el('strong', { text: tr('Not connected to {0}. ', CONN_NAMES[S.active]) }), el('span', { class: 'muted', text: st.detail || '' })),
      el('button', { class: 'btn-ghost', text: tr('Try again'), onclick: () => call(api.retry, S.active).catch(() => {}) }))
  } else if (restarting(st)) {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: tr("Restarting this PC's Hermes. ") }), el('span', { class: 'muted', text: tr("It takes a few seconds; Pedila reconnects by itself when it's done.") })))
  } else if (st.state === 'updating') {
    b.className = 'login'
    b.append(el('div', { class: 'grow' }, el('strong', { text: tr("Updating this PC's Hermes") + (st.detail ? ` (${st.detail})` : '') + '. ' }), el('span', { class: 'muted', text: tr("It takes a few minutes; Pedila reconnects by itself when it's done.") })))
  } else if (st.state === 'connecting' && st.detail) {
    b.append(el('div', { class: 'grow muted', text: tr('Connecting to {0}… {1}', CONN_NAMES[S.active], st.detail) }))
  } else {
    b.hidden = true
    return
  }
  b.hidden = false
}

async function switchConn(c) {
  if (S.active === c) { return }
  S.active = c
  renderConnSwitch()
  renderBanner()
  newChatView()
  call(api.settings, { lastConnection: c }).catch(() => {})
  await loadSessions(c)
}

// ── Chat list ────────────────────────────────────────────────────────────────────────────────
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
    }
  } catch (e) {
    S.listError[conn] = e.needLogin ? 'login' : S.conns[conn].state === 'setup' ? 'setup' : e.message
  }
  S.listLoaded[conn] = true
  if (conn === S.active) { renderList() }
  // The panel uses the list (the chat's messages, opening the last task).
  schedulePanel()
}

function renderList() {
  const nav = $('#chat-list')
  nav.replaceChildren()
  const conn = S.active
  if (S.listError[conn] === 'login') {
    nav.append(el('div', { class: 'list-empty', text: tr("Sign in to see the server's chats.") }))
    return
  }
  if (S.listError[conn] === 'setup') {
    nav.append(el('div', { class: 'list-empty', text: tr("Put your server's address in Settings → Server to see its chats.") }))
    return
  }
  if (S.listError[conn]) {
    nav.append(el('div', { class: 'list-empty', text: tr("Couldn't load the chats: {0}", S.listError[conn]) }))
    return
  }
  if (!S.listLoaded[conn]) {
    nav.append(el('div', { class: 'list-empty', text: tr('Loading chats…') }))
    return
  }
  const q = S.search.trim().toLowerCase()
  const rows = S.sessions[conn]
    .map(r => ({ ...r, title: chat(conn, r.id).title || r.title, ms: toMs(r.lastActive) }))
    .filter(r => !q || r.title.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q))
    .sort((a, b) => b.ms - a.ms)
  if (!rows.length && !(q.length >= 3 && S.found[conn].length)) {
    nav.append(el('div', { class: 'list-empty', text: q ? (q.length >= 3 ? tr('No chat matches (still searching their contents…).') : tr('No chat matches.')) : tr('No chats here yet. Type something to start.') }))
    if (!q) { nav.append(el('button', { class: 'archived-link', text: tr('🗄 See archived chats'), onclick: () => openArchived() })) }
    return
  }
  let group = null
  const pinned = rows.filter(r => r.pinned)
  if (pinned.length) { nav.append(el('div', { class: 'group-label', text: tr('📌 Pinned') })); for (const r of pinned) { nav.append(chatRow(conn, r)) } }
  for (const r of rows.filter(x => !x.pinned)) {
    const g = groupOf(r.ms)
    if (g !== group) { group = g; nav.append(el('div', { class: 'group-label', text: g })) }
    nav.append(chatRow(conn, r))
  }
  if (q.length >= 3 && S.found[conn].length) {
    nav.append(el('div', { class: 'group-label', text: tr('🔎 In their contents') }))
    for (const h of S.found[conn].slice(0, 30)) {
      const known = S.sessions[conn].find(x => x.id === h.id)
      const row = el('button', { class: 'chat-row found', title: h.snippet },
        el('div', { class: 't' }, el('span', { text: (known && (chat(conn, h.id).title || known.title)) || 'Chat' })),
        el('div', { class: 'p', text: h.snippet }))
      row.addEventListener('click', () => openChat(conn, h.id))
      nav.append(row)
    }
  }
  nav.append(el('button', { class: 'archived-link', text: tr('🗄 See archived chats'), onclick: () => openArchived() }))
}

function chatRow(conn, r) {
  const ch = chat(conn, r.id)
  const running = ch.running || (ch.live && !ch.live.done)
  const row = el('button', { class: 'chat-row' + (S.current.conn === conn && S.current.sid === r.id ? ' active' : ''), title: r.title },
    el('div', { class: 't' }, running ? el('span', { class: 'run' }) : null, el('span', { text: r.title }), activeBadge(conn, r, running)),
    r.preview ? el('div', { class: 'p', text: r.preview }) : null)
  row.addEventListener('click', () => openChat(conn, r.id))
  row.addEventListener('contextmenu', e => { e.preventDefault(); openChatMenu(conn, r.id, e.clientX, e.clientY) })
  const more = el('button', { class: 'row-more', title: tr('More options'), 'aria-label': tr('More options'), text: '⋯' })
  more.addEventListener('click', e => { e.stopPropagation(); const b = more.getBoundingClientRect(); openChatMenu(conn, r.id, b.right, b.bottom) })
  return el('div', { class: 'chat-row-wrap' }, row, more)
}

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────
function setTopbar() {
  const ch = currentChat()
  $('#chat-title').textContent = ch ? (ch.title || 'Chat') : tr('New chat')
  const bits = [CONN_NAMES[S.current.conn]]
  if (ch && ch.model) { bits.push(ch.model) }
  if (ch && ch.usage && ch.usage.used && ch.usage.max) { bits.push(tr('context {0} / {1}', kfmt(ch.usage.used), kfmt(ch.usage.max))) }
  $('#chat-meta').textContent = bits.join(' · ')
  $('#chat-actions').hidden = !ch
  const pct = ch && ch.usage && ch.usage.used && ch.usage.max ? Math.min(100, Math.round(ch.usage.used / ch.usage.max * 100)) : 0
  const bar = $('#ctx-bar')
  bar.hidden = !pct
  bar.firstElementChild.style.width = pct + '%'
  bar.classList.toggle('warn', pct >= 80)
  bar.title = pct ? tr('Chat memory: {0}% (at 85%, Hermes summarizes the older part)', pct) : ''
  const warn = $('#ctx-warn')
  warn.hidden = !(ch && pct >= 80 && !S.ctxHidden.has(key(ch.conn, ch.sid)))
  if (!warn.hidden) { $('#ctx-warn-text').textContent = tr("This chat is at {0}% of its memory. If you're changing the subject, better go on in a new one.", pct) }
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
  setTopbar()
  renderList()
  call(api.viewing, conn, sid, ch.title).catch(() => {})
  renderChat()
  updateComposer()
  updateModelPill()
  try {
    ch.transcript = await call(api.transcript, conn, sid)
    ch.loaded = true
  } catch (e) {
    ch.loaded = true
    ch.loadError = e.message
  }
  if (S.current.sid === sid) { renderChat(true) }
  const row = S.sessions[conn].find(r => r.id === sid)
  if (row && row.model && !ch.model) { ch.model = row.model; setTopbar(); updateModelPill() }
  // If the chat is loaded in the gateway (maybe answering from Hermes Desktop), attach to it to get its
  // live events and its pending permissions.
  if ((row && row.active) || ch.running || (ch.live && !ch.live.done)) {
    call(api.attach, conn, sid).then(r => {
      ch.running = r.running
      if (!r.running && ch.live && ch.live.done) { ch.live = null; if (currentChat() === ch) { renderChat(false) } }
      // Working without the screen having seen the turn start (reattached when Pedila opened).
      if (r.running && (!ch.live || ch.live.done)) { ch.resumed = true }
      updateComposer()
      renderList()
    }).catch(() => {})
  }
  $('#input').focus()
}

let liveRaf = 0
// While something in the chat is being pressed, the live turn isn't repainted (the click would land on a
// button that no longer exists); it is repainted on release.
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
  $('#welcome-where').textContent = tr("You're about to talk to the Hermes on {0}.", S.current.conn === 'server' ? tr('your server') : tr('this PC'))
  if (!ch) { return }
  if (!ch.loaded && !ch.live) { msgs.append(el('div', { class: 'status-line' }, el('span', { class: 'spin' }), el('span', { text: tr('Loading the chat…') }))) }
  if (ch.loadError) { msgs.append(el('div', { class: 'turn-error', text: tr("Couldn't load the chat: {0}", ch.loadError) })) }
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
  return el('div', { class: 'who' }, el('img', { src: 'assets/tray@2x.png', alt: '' }), el('span', { text: 'Hermes' }))
}

function renderBlocks(blocks) {
  const out = []
  // Consecutive tools (with no text in between) go together in a collapsible group, as in Claude Code.
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

// ── Tools, as in Claude Code ─────────────────────────────────────────────────────────────────
// Each group is one line ("Ran 2 commands, read a.png · +12 −3 · 1 failed") that opens; inside, each tool
// with its title, what it was given (the command, the code, the change) and what it returned. What is open
// is remembered while the window lasts (also when repainting live).
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
  const head = el('button', { class: 'tg-head', 'data-k': gk, 'aria-expanded': String(open), title: open ? tr('Click to collapse') : tr('Click to see what it did') },
    el('span', { class: 'tg-chev', text: '›' }),
    sum.running ? el('span', { class: 'spin' }) : null,
    el('span', { class: 'tg-text', text: sum.text }),
    sum.add || sum.del ? el('span', { class: 'tg-diff' }, sum.add ? el('span', { class: 'add', text: `+${sum.add}` }) : null, sum.del ? el('span', { class: 'del', text: `−${sum.del}` }) : null) : null,
    sum.failed ? el('span', { class: 'tg-fail', text: single ? tr('Failed') : failedText(sum.failed) }) : null,
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
    b.error ? el('span', { class: 'tg-fail', text: tr('Failed') }) : null,
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

/** The inside of a tool: what it was given, what it returned and its images. */
function toolDetails(b) {
  const d = describeTool(b)
  const parts = []
  if (d.box && d.box.text) { parts.push(toolBox(d.box, keyOf(b) + ':in')) }
  if (!b.done) {
    parts.push(el('div', { class: 'tout-label' }, el('span', { class: 'spin' }), el('span', { text: b.message ? ` ${b.message}${b.percent ? ` (${b.percent} %)` : ''}` : tr(' Running…') })))
  } else {
    const out = typeof b.output === 'string' ? b.output : (b.summary || '')
    if (out.trim()) {
      parts.push(el('div', { class: 'tout-label' + (b.error ? ' fail' : ''), text: b.error ? tr('Failed:') : tr('Result:') }))
      parts.push(el('pre', { class: 'tbox out' + (b.error ? ' err' : ''), 'data-k': keyOf(b) + ':out', text: out }))
    } else if (b.error || !((Array.isArray(b.images) && b.images.length) || b.image)) {
      parts.push(el('div', { class: 'tout-label muted', text: b.error ? tr('It failed without saying why.') : tr('No result to show.') }))
    }
  }
  const thumbs = []
  for (const im of Array.isArray(b.images) ? b.images : []) { thumbs.push(thumbOf(im.url, im.name || tr('image'))) }
  // The image Hermes returned, by its path.
  if (b.image) { thumbs.push(el('div', { class: 'media-img', 'data-quiet': '', 'data-media': encodeURIComponent(b.image) })) }
  if (thumbs.length) {
    const box = el('div', { class: 'thumbs' }, ...thumbs)
    fillMedia(box, S.current.conn)
    parts.push(box)
  }
  return el('div', { class: 'tdetails' }, ...parts)
}

/** The box with what it was given: "$ command", code, changes in green and red, a path or JSON. */
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

/** Thumbnail of an image (data:); a click shows it big. */
function thumbOf(url, name) {
  const img = el('img', { src: url, alt: name, title: name, loading: 'lazy' })
  const b = el('button', { class: 'thumb', title: tr('{0} (click to enlarge)', name), onclick: e => { e.stopPropagation(); openImage(url, name) } }, img)
  return b
}

function renderReasoning(text, live) {
  if (!text) { return null }
  const d = el('details', { class: 'reasoning' }, el('summary', { text: live ? tr('Reasoning…') : tr('Reasoning process') }), el('div', { class: 'rtext', text }))
  return d
}

function renderTurn(t) {
  if (t.role === 'user') {
    const images = Array.isArray(t.images) ? t.images : []
    const n = images.length
    let thumbs = null
    if (n) {
      thumbs = el('div', { class: 'thumbs' }, ...images.map(im => thumbOf(im.url, im.name || tr('image'))))
      fillMedia(thumbs, S.current.conn)
    }
    return el('div', { class: 'msg user' }, el('div', { class: 'bubble' + (n ? ' with-images' : '') },
      thumbs, t.text ? el('div', { class: 'btext', text: t.text }) : null))
  }
  // What Hermes writes as if it were yours (memory summaries, notices): a collapsible note.
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
  const copy = el('button', { class: 'mini', text: tr('Copy') })
  copy.addEventListener('click', () => navigator.clipboard.writeText(text).then(() => { copy.textContent = tr('Copied'); setTimeout(() => { copy.textContent = tr('Copy') }, 1200) }).catch(() => {}))
  return el('div', { class: 'turn-actions' }, text ? copy : null, t.stats ? el('span', { class: 'muted small', text: statsText(t.stats) }) : null)
}

function renderLiveTurn(ch) {
  const L = ch.live
  const node = el('div', { class: 'msg assistant', id: 'live-turn' }, whoRow(), renderReasoning(L.reasoning, !L.done), renderBlocks(L.blocks))
  node._live = L
  if (!L.done) {
    const status = L.status || (L.blocks.length ? tr('Writing') : tr('Thinking'))
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
      el('h4', { text: tr('Hermes asks for your permission') }),
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
    card.append(el('h4', { text: q.question || tr('Hermes has a question') }))
    const actions = el('div', { class: 'actions' })
    for (const choice of q.choices || []) {
      actions.append(el('button', { text: choice, onclick: () => {
        answers[q.qid] = choice
        if (qs.length === 1) { answerPrompt(ch, k, demoOr(answers, choice), actions) } else { for (const b of actions.children) { b.classList.toggle('yes', b.textContent === choice) } }
      } }))
    }
    if ((q.choices || []).length) { card.append(actions) }
    const input = el('input', { placeholder: (q.choices || []).length ? tr('Or another answer…') : tr('Your answer…') })
    input.addEventListener('input', () => { answers[q.qid] = input.value })
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && qs.length === 1 && input.value.trim()) { answerPrompt(ch, k, { [q.qid]: input.value.trim() }, card) } })
    card.append(el('div', { class: 'free' }, input, qs.length === 1 ? el('button', { class: 'btn-ghost', text: tr('Answer'), onclick: () => { if (input.value.trim()) { answerPrompt(ch, k, { [q.qid]: input.value.trim() }, card) } } }) : null))
  }
  if (qs.length > 1) {
    card.append(el('div', { class: 'actions' }, el('button', { class: 'yes', text: tr('Send answers'), onclick: () => answerPrompt(ch, k, answers, card) })))
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
    if (ch.live && !ch.live.done) { ch.live.status = tr('Going on') }
  } catch (e) {
    for (const b of container.querySelectorAll('button')) { b.disabled = false }
    alertInChat(tr("Couldn't send the answer: {0}", e.message))
  }
  if (currentChat() === ch) { renderChat(nearBottom()) }
  updatePet()
}

function alertInChat(text) {
  const ch = currentChat()
  if (ch && ch.live) { ch.live.error = text; scheduleLive() } else { $('#messages').append(el('div', { class: 'turn-error', text })) }
}

// ── Writing and sending ──────────────────────────────────────────────────────────────────────
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
    b.title = tr('Stop')
    b.disabled = false
  } else {
    b.classList.remove('stop')
    b.textContent = '➤'
    b.title = running ? tr('Send (it will be queued)') : tr('Send')
    b.disabled = !hasText
  }
  $('#input').placeholder = S.current.sid ? tr('Message Hermes…') : tr('Message Hermes ({0})…', CONN_NAMES[S.current.conn])
  if (typeof updateExtrasPills === 'function') { updateExtrasPills() }
  reportDraft()
}

// With something typed and not sent (or an image ready), Pedila doesn't restart by itself to update.
let draftSent = null
function reportDraft() {
  const draft = $('#input').value.trim().length > 0 || S.attach.length > 0
  if (draft === draftSent) { return }
  draftSent = draft
  if (api.uiState) { call(api.uiState, { draft }).catch(() => { draftSent = null }) }
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
  if (!text && S.attach.length) { text = tr('Look at the image.') }
  if (!text) { return }
  const conn = S.current.conn
  // While Hermes updates, the message wouldn't arrive: it stays in the box.
  if (S.conns[conn] && S.conns[conn].state === 'updating') {
    showToastLine(restarting(S.conns[conn]) ? tr('Hermes is restarting: your message is still here; send it once it reconnects.') : tr('Hermes is updating: your message is still here; send it once it reconnects.'))
    return
  }
  closeSnippets()
  const images = S.attach.splice(0)
  renderAttach()
  let sid = S.current.sid
  $('#input').value = ''
  autoGrow()
  if (!sid) {
    $('#send').disabled = true
    try {
      const choice = S.modelChoice[conn]
      const r = await call(api.newChat, conn, { ...(choice ? { model: choice.model, provider: choice.provider } : {}), ...(S.reasoning ? { reasoning: S.reasoning } : {}) })
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
      showToastLine(e.needLogin ? tr("You're not signed in to the server.") : tr("Couldn't create the chat: {0}", e.message))
      if (e.needLogin) { openLogin() }
      return
    }
  }
  const c = chat(conn, sid)
  // With Hermes already working the message is queued: the running task keeps counting from before.
  if (!busy(c)) { c.turnAt = Date.now() }
  if (c.live && c.live.done) { c.transcript.push(liveToTurn(c.live)); c.live = null }
  // Your images show in your message (thumbnails that open big).
  const mine = { role: 'user', text, ...(images.length ? { images: images.map(i => ({ url: i.url, name: i.name })) } : {}) }
  c.transcript.push(mine)
  if (!c.live) { c.live = { blocks: [], reasoning: '', status: tr('Sending'), done: false, startedAt: Date.now() } }
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
    if (r && r.status === 'queued' && c.live && !c.live.done && c.live.blocks.length) { c.live.note = tr('Your message is queued: Hermes will read it when it finishes.') }
    if (c.live && c.live.status === tr('Sending')) { c.live.status = tr('Thinking') }
    scheduleLive()
  } catch (e) {
    // It didn't arrive: what was typed (and its images) goes back to the box, unless you've already typed
    // something else.
    const back = !$('#input').value.trim() && !S.attach.length
    if (back) {
      const i = c.transcript.lastIndexOf(mine)
      if (i >= 0) { c.transcript.splice(i, 1) }
      $('#input').value = text
      S.attach.push(...images)
      renderAttach()
      autoGrow()
    }
    if (c.live) { c.live.error = e.needLogin ? tr("You're not signed in to the server.") : tr("Couldn't send it: {0}{1}", e.message, back ? tr(' (your message is still in the box)') : ''); c.live.done = true }
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
    if (ch.live) { ch.live.status = tr('Stopping') }
    scheduleLive()
  } catch (e) {
    showToastLine(tr("Couldn't stop: {0}", e.message))
  }
}

/** A tool of the last turn of the history that has no result yet (or null). */
function pendingPastTool(ch, id) {
  const last = ch.transcript[ch.transcript.length - 1]
  if (!last || last.role !== 'assistant' || !Array.isArray(last.blocks)) { return null }
  return last.blocks.find(b => b.type === 'tool' && b.id === id && !b.done) || null
}

/** What the "tool finished" event brings: result, whether it failed, the change and the images. */
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
  toastT = setTimeout(() => { h.textContent = tr('Enter to send · Shift+Enter for a new line'); h.classList.remove('error') }, 6000)
}

// ── Models ───────────────────────────────────────────────────────────────────────────────────
function updateModelPill() {
  const p = $('#model-pill')
  const ch = currentChat()
  if (ch) {
    p.textContent = ch.model ? tr('Model: {0}', ch.model) : tr("The chat's model")
    p.disabled = false
    p.title = tr("Change this chat's model (from your next message on)")
    return
  }
  const conn = S.current.conn
  const choice = S.modelChoice[conn]
  const opts = S.models[conn]
  if (choice) {
    p.textContent = tr('Model: {0}{1}', choice.model, choice.local === false ? ' ☁' : '')
  } else if (opts && opts.current.model) {
    p.textContent = tr('Model: default ({0}{1})', opts.current.model, opts.current.local ? '' : ' ☁')
  } else {
    p.textContent = tr('Model: default')
  }
  p.disabled = false
  p.title = choice && choice.local === false || (!choice && opts && !opts.current.local)
    ? tr('Careful: this model is in the cloud, not on your network. Click to choose another one.')
    : tr('Model for this new chat')
}

/**
 * On opening a new chat: if that Hermes's default is in the cloud and there are models on your network, it
 * proposes the first local one (it isn't saved until you choose it).
 */
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
  menu.replaceChildren(el('div', { class: 'mh', text: tr('Loading models…') }))
  placeMenu(menu)
  menu.hidden = false
  try {
    S.models[conn] = await call(api.models, conn)
  } catch (e) {
    menu.replaceChildren(el('div', { class: 'mh', text: tr("Couldn't read the models: {0}", e.message) }))
    return
  }
  const opts = S.models[conn]
  let showCloud = Boolean(S.modelChoice[conn] && S.modelChoice[conn].local === false)
  let filter = ''
  const pick = async choice => {
    menu.hidden = true
    const sid = S.current.sid
    if (sid) {
      const ch = chat(conn, sid)
      try {
        const opts = { model: choice ? choice.model : null, ...(choice && choice.provider ? { provider: choice.provider } : {}) }
        let r = await call(api.chatOptions, conn, sid, opts)
        // Hermes asks for confirmation for some models (cost, privacy, large context): its warning and, if
        // you say yes, the same change with its code.
        if (r && r.needsConfirm) {
          const yes = await askBox({ title: tr('Switch to {0}?', r.model || (choice ? choice.model : tr('that model'))), text: r.message || tr('Hermes asks you to confirm this model.'), ok: tr('Switch') })
          if (!yes) { return }
          r = await call(api.chatOptions, conn, sid, { ...opts, confirm: r.confirm })
          if (r && r.needsConfirm) { showNote(tr('Hermes asked for confirmation again: try once more.'), true); return }
        }
        if (r && r.model) { ch.model = r.model } else if (choice) { ch.model = choice.model }
        updateModelPill()
        setTopbar()
        showNote(tr("This chat's model: {0}{1}.", choice ? choice.model : tr('the default one'), r && r.applied === 'next' ? tr(' (from your next message on)') : ''))
      } catch (e) { showNote(tr("Couldn't change the model: {0}", e.message), true) }
      return
    }
    S.modelChoice[conn] = choice
    updateModelPill()
    call(api.settings, { models: { [conn]: choice ? { model: choice.model, provider: choice.provider, local: choice.local } : null } }).catch(() => {})
  }
  const search = el('input', { class: 'menu-search', placeholder: tr('Search models…'), spellcheck: 'false' })
  const list = el('div')
  const draw = () => {
    list.replaceChildren()
    const q = filter.trim().toLowerCase()
    const local = opts.providers.filter(pv => pv.local)
    const cloud = opts.providers.filter(pv => !pv.local)
    const cur = opts.current
    if (!q) {
      list.append(el('button', { class: S.modelChoice[conn] ? '' : 'active', text: tr("This Hermes's default{0}", cur.model ? ` (${cur.model}${cur.local ? '' : ' ☁'})` : ''), onclick: () => pick(null) }))
    }
    const group = (pv, cloudy) => {
      const models = pv.models.filter(m => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
      if (!models.length) { return }
      list.append(el('div', { class: 'mh', text: `${pv.name || pv.id}${cloudy ? tr(' · in the cloud ☁') : tr(' · on your network')}` }))
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
        list.append(el('button', { class: 'more', text: tr('☁ Also show the cloud models ({0})', cloudCount), onclick: e => { e.stopPropagation(); showCloud = true; draw() } }))
      }
    }
    if (!list.children.length) { list.append(el('div', { class: 'mh', text: tr('No model matches.') })) }
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

// ── Events from the main process ─────────────────────────────────────────────────────────────
function onEvent(evt) {
  switch (evt.kind) {
    case 'conn': {
      const prev = S.conns[evt.conn].state
      S.conns[evt.conn] = { state: evt.state, detail: evt.detail || '' }
      renderConnSwitch()
      if (evt.conn === S.active) { renderBanner() }
      if (evt.state === 'ready' && prev !== 'ready') { loadSessions(evt.conn); ensureModelDefault(evt.conn) }
      // A connection that comes back may be another Hermes (a restart, another session): new quotas.
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
      // The other chats that were working: the new socket no longer follows them (connect() forgets the
      // attachments) and their end would never arrive. They are attached again: if they're still going, it
      // will arrive; if they already finished, they stop counting as "running". What was already written
      // is read again when they're opened.
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
        // With work running outside this window, look soon whether it has finished (every 10 s at most).
        if (remoteBusy(evt.conn).length && Date.now() - P.at[evt.conn] > 10000) { loadPanelUsage(evt.conn, true) }
      }
      return
    case 'theme':
      S.dark = evt.dark
      applyLook()
      return
    case 'new-chat':
      newChatView()
      return
    case 'focus-chat':
      if (evt.sid) { openChat(evt.conn, evt.sid) }
      return
    case 'pet':
      if (evt.pet) { applyPet(evt.pet, { greet: true }).then(() => { $('#pet-stage').hidden = !S.settings.pet.visible }).catch(() => {}) }
      return
    case 'focus-input':
      $('#input').focus()
      return
    case 'update':
      showUpdate(evt.version, evt.notes)
      return
    case 'hermes-updates':
      S.hermesUpd = evt.view || {}
      schedulePanel()
      if ($('#settings-dialog').open) { renderHermesUpd() }
      return
    case 'settings':
      // A setting changed outside Settings (for example "Start with Windows" in the tray).
      if (evt.settings) { S.settings = evt.settings; if ($('#settings-dialog').open) { renderSettings() } }
      return
    default:
      break
  }
  if (!evt.sid) { return }
  const ch = chat(evt.conn, evt.sid)
  const isCur = currentChat() === ch
  let fullRender = false // something in the history changed, not just the live turn
  const ensureLive = () => {
    if (!ch.live || ch.live.done) {
      if (ch.live && ch.live.done) { ch.transcript.push(liveToTurn(ch.live)) }
      ch.live = { blocks: [], reasoning: '', status: tr('Thinking'), done: false, startedAt: Date.now() }
    }
    return ch.live
  }
  switch (evt.kind) {
    case 'turn-start': {
      const L = ensureLive()
      L.status = tr('Thinking')
      ch.running = true
      // When the task started (if it was sent from here it's already set, with the time it was sent).
      if (!ch.turnAt) { ch.turnAt = Date.now() }
      for (const [id, sa] of ch.subagents) { if (sa.state !== 'running' && sa.state !== 'queued') { ch.subagents.delete(id) } }
      break
    }
    case 'delta': {
      const L = ensureLive()
      const last = L.blocks[L.blocks.length - 1]
      if (!L.firstAt) { L.firstAt = Date.now() }
      if (last && last.type === 'text' && !L.cut) { last.text += evt.text } else { L.blocks.push({ type: 'text', text: evt.text }); L.cut = false }
      L.status = tr('Writing')
      break
    }
    case 'segment':
      if (ch.live) { ch.live.cut = true }
      break
    case 'reasoning': {
      const L = ensureLive()
      L.reasoning = evt.full ? evt.text : L.reasoning + evt.text
      L.status = tr('Reasoning')
      break
    }
    case 'thinking':
      if (ch.live && !ch.live.done && evt.text) { ch.live.status = tr('Thinking') }
      break
    case 'status':
      if (evt.text && busy(ch) && (!ch.live || ch.live.done)) { ensureLive() }
      if (ch.live && !ch.live.done && evt.text) {
        // When the older part of the chat is being summarized (it can take minutes), say so in plain words
        // and count the time.
        const text = evt.statusKind === 'compacting' ? COMPACT_TEXT : evt.text.replace(/[.…]+$/, '')
        if (text === COMPACT_TEXT && ch.live.status !== COMPACT_TEXT) { ch.live.compactAt = Date.now() }
        ch.live.status = text
      }
      break
    case 'tool': {
      // The one already in the history without an ending (a turn that started before the screen followed
      // it, e.g. reattached when Pedila opened): it's completed there, not repeated live.
      const inLive = ch.live && !ch.live.done && ch.live.blocks.some(x => x.type === 'tool' && x.id === evt.id)
      const past = evt.id && !inLive ? pendingPastTool(ch, evt.id) : null
      if (past) {
        if (evt.phase === 'complete') { toolDone(past, evt) }
        if (evt.input && typeof evt.input === 'object') { past.input = evt.input }
        if (ch.live && !ch.live.done) { ch.live.status = evt.phase === 'complete' ? tr('Thinking') : tr('Using {0}', past.name) }
        ch.resumed = true
        fullRender = true
        break
      }
      const L = ensureLive()
      let b = L.blocks.find(x => x.type === 'tool' && x.id && x.id === evt.id)
      // "Preparing" (tool.generating) and "running" (tool.start) may come with different ids: the block
      // being prepared with the same name is reused.
      if (!b && evt.phase === 'start') { b = L.blocks.find(x => x.type === 'tool' && x.generating && !x.done && x.name === evt.name) }
      if (!b) {
        b = { type: 'tool', id: evt.id, name: evt.name, args: evt.args || '', done: false, generating: evt.phase === 'generating', startedAt: Date.now() }
        L.blocks.push(b)
        L.cut = true
      }
      if (evt.phase === 'start') { if (b.generating) { b.startedAt = Date.now() } b.generating = false; if (evt.id) { b.id = evt.id } }
      if (evt.args) { b.args = evt.args }
      if (evt.name) { b.name = evt.name }
      // The details for the collapsible group: what it was given, what it returned, whether it failed, a
      // file's change and the image (by its path).
      if (evt.input && typeof evt.input === 'object') { b.input = evt.input }
      if (evt.phase === 'progress') { b.percent = evt.percent; b.message = evt.message }
      if (evt.phase === 'complete') { toolDone(b, evt) }
      L.status = evt.phase === 'complete' ? tr('Thinking') : tr('Using {0}', b.name)
      break
    }
    case 'complete': {
      const L = ensureLive()
      if (!L.blocks.some(b => b.type === 'text') && evt.text) { L.blocks.push({ type: 'text', text: evt.text }) }
      if (!L.reasoning && evt.reasoning) { L.reasoning = evt.reasoning }
      for (const b of L.blocks) { if (b.type === 'tool') { b.done = true } }
      L.done = true
      ch.running = false
      ch.turnAt = 0
      // The exact time it ended (the panel merges it with the last activity Hermes gives).
      ch.doneAt = Date.now()
      P.done[evt.conn] = { at: ch.doneAt, sid: evt.sid }
      {
        const out = evt.out || (ch.usage && ch.usage.out && ch.usage.outStart !== undefined ? ch.usage.out - ch.usage.outStart : 0)
        const streamMs = L.firstAt ? Date.now() - L.firstAt : 0
        L.stats = { ms: evt.ms || (L.startedAt ? Date.now() - L.startedAt : null), tps: out && streamMs > 500 ? out / (streamMs / 1000) : null }
      }
      if (ch.resumed) {
        // The turn started without the screen in front (or the chat was come back to halfway): when it
        // ends it's read whole from the file, as a single answer (if another turn starts from here
        // meanwhile, that one wins).
        ch.resumed = false
        setTimeout(() => {
          call(api.transcript, evt.conn, evt.sid).then(t => {
            // With an error or a note ("Stopped.") it stays as it is: reading it again would erase it.
            if (ch.live !== L || ch.running || L.error || L.note) { return }
            // The turn's duration stays (the file doesn't keep it).
            const last = t[t.length - 1]
            if (last && last.role === 'assistant' && L.stats) { last.stats = L.stats }
            ch.transcript = t
            ch.live = null
            if (currentChat() === ch) { renderChat(nearBottom()) }
          }).catch(() => {})
        }, 400)
      }
      if (S.settings.notify.chime && (!document.hasFocus() || !isCur)) { chime() }
      if (evt.outcome && !['completed', 'complete'].includes(evt.outcome)) {
        const stopped = ['interrupted', 'cancelled', 'canceled'].includes(evt.outcome)
        L.note = stopped ? tr('Stopped.') : tr('It ended like this: {0}', evt.outcome)
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
      // When sending to a chat that isn't attached, the attachment says "idle" before starting: the
      // sending time stays.
      if (!evt.running && !busy(ch)) { ch.turnAt = 0 }
      break
    case 'todos': {
      // The whole list. Live events and the snapshot on attaching always win (Hermes may number from 1
      // again after a restart or after an hour idle); the one read from the history only wins if it isn't
      // older or if the chat isn't working.
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
      if (ch.live && !ch.live.done) { ch.live.note = tr('The connection dropped while Hermes was working. The chat will be reloaded when it reconnects.') }
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
  // The panel: when an answer ends, usage is worked out again (Hermes takes a while to store the tokens).
  if (evt.kind === 'complete') { setTimeout(() => loadPanelUsage(evt.conn, true), 1500) }
  schedulePanel()
}

// ── Pet ──────────────────────────────────────────────────────────────────────────────────────
const pet = new Pet($('#pet'))
const welcomePet = new Pet($('#welcome-pet'))
const settingsPet = new Pet($('#settings-pet'))
const PEDILA_SHEET = 'assets/pets/pedila/sprite.webp'
const DEFAULT_PET = { slug: 'pedila', name: 'Pedila', author: '', kind: 'character', url: PEDILA_SHEET, bundled: true, own: true }
const KIND_NAMES = { character: tr('character'), creature: tr('creature'), object: tr('object') }
const petName = p => { const n = (p && p.name) || tr('pet'); return n.charAt(0).toUpperCase() + n.slice(1) }
const petBy = p => (p && p.own ? tr('the messenger, drawn for Pedila') : p && p.author ? tr('by {0} on Petdex', p.author) : tr('from Petdex'))

function updatePet() {
  let base = 'idle'
  const all = [...S.chats.values()]
  const relevant = all.filter(c => c.conn === S.active || c === currentChat())
  if (all.some(c => c.prompts.size)) { base = 'waiting' } else if (relevant.some(c => c.live && !c.live.done && c.live.blocks.some(b => b.type === 'tool' && !b.done))) { base = 'review' } else if (relevant.some(c => (c.live && !c.live.done) || c.running)) { base = 'running' }
  pet.setBase(base)
  const name = petName(S.pet)
  const what = { idle: tr('{0} is calm', name), waiting: tr('Hermes needs you'), review: tr('Hermes is using tools'), running: tr('Hermes is working') }[base]
  $('#pet').title = what
}

function renderPetLabels() {
  const p = S.pet || DEFAULT_PET
  $('#settings-pet-name').textContent = petName(p)
  $('#settings-pet-by').textContent = petBy(p) + (p.kind ? ` · ${KIND_NAMES[p.kind] || p.kind}` : '')
  $('#about-pet').textContent = tr('Pet: {0}, {1}.', petName(p), petBy(p))
  updatePet()
}

/** Puts the pet in the bar, the welcome screen and Settings. If its sheet is no good, throws the error. */
async function applyPet(info, { greet = false } = {}) {
  await pet.load(info.url)
  S.pet = info
  welcomePet.load(info.url).catch(() => {})
  settingsPet.load(info.url).catch(() => {})
  renderPetLabels()
  if (greet) { pet.flash('waving', 3) }
}

// Picker: "Your pets" (the app's and the ones you've used) and the Petdex catalog.
const PP = { tab: 'petdex', q: '', kind: '', items: [], total: 0, sel: null, seq: 0, kinds: null }

function stripFor(item, cls = '') {
  const d = el('div', { class: `strip ${cls}`.trim() })
  const fail = text => { d.classList.add('missing'); d.textContent = text }
  if (item.url) {
    // A full sheet that was saved: its "idle" row is animated.
    loadSheet(item.url).then(sh => {
      d.style.setProperty('--cols', String(sh.cols))
      d.style.setProperty('--rows', String(sh.rows))
      d.style.backgroundImage = `url("${item.url}")`
    }).catch(() => fail(tr("can't be shown")))
  } else if (item.preview) {
    // Petdex preview: a strip of 6 frames (its own website uses it).
    const probe = new Image()
    probe.onload = () => { d.style.backgroundImage = `url("${item.preview}")` }
    probe.onerror = () => fail(tr('no preview'))
    probe.src = item.preview
  }
  return d
}

function petCard(item) {
  const current = S.pet && S.pet.slug === item.slug
  const card = el('button', { class: 'pet-card' + (PP.sel && PP.sel.slug === item.slug ? ' sel' : ''), title: `${petName(item)} — ${petBy(item)}`, 'data-slug': item.slug },
    stripFor(item),
    el('div', { class: 'n', text: petName(item) }),
    el('div', { class: 'a', text: item.author ? tr('by {0}', item.author) : '' }),
    current ? el('div', { class: 'badge', text: tr('The one you have') }) : item.installed ? el('div', { class: 'badge', text: tr('Saved') }) : null)
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
  $('#pp-use').textContent = current ? tr('Already your pet') : tr('Use this pet')
}

function ppStatus(text, retry = false) {
  const s = $('#pp-status')
  s.replaceChildren()
  s.hidden = !text
  if (text) { s.append(text) }
  if (retry) { s.append(' ', el('button', { class: 'btn-ghost', text: tr('Try again'), onclick: () => loadPetPage(true) })) }
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
      ppStatus(mine.length > 1 ? '' : tr('The pets you choose from the Petdex catalog will appear here.'))
    } catch (e) {
      if (seq === PP.seq) { ppStatus(tr("Couldn't read your pets: {0}", e.message)) }
    }
    return
  }
  ppStatus(PP.items.length ? '' : tr('Loading the Petdex catalog…'))
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
    $('#pp-count').textContent = tr('{0} of {1}', PP.items.length, r.total)
    ppStatus(r.total ? '' : tr('No pet matches.'))
  } catch (e) {
    if (seq === PP.seq) { ppStatus(e.message, true) }
  }
}

async function usePet() {
  const item = PP.sel
  if (!item || (S.pet && S.pet.slug === item.slug)) { return }
  const btn = $('#pp-use')
  btn.disabled = true
  btn.textContent = item.url ? tr('Changing…') : tr('Downloading…')
  const prev = S.pet
  try {
    const info = await call(api.petUse, item.slug)
    try {
      await applyPet(info, { greet: true })
    } catch (e) {
      // The sheet doesn't have Petdex's geometry: back to the previous one.
      if (prev) { await call(api.petUse, prev.slug).catch(() => {}) }
      throw new Error(tr('{0} {1}; you still have {2}', petName(item), e.message, petName(prev)))
    }
    $('#pet-dialog').close()
  } catch (e) {
    ppStatus(tr("Couldn't change the pet: {0}", e.message))
    btn.disabled = false
    btn.textContent = tr('Use this pet')
  }
}

function openPetPicker() {
  PP.sel = null
  $('#pp-sel-name').textContent = tr('Choose one')
  $('#pp-sel-by').textContent = ''
  $('#pp-sel-strip').replaceWith(Object.assign(el('div', { class: 'strip big missing' }), { id: 'pp-sel-strip' }))
  $('#pp-use').disabled = true
  $('#pp-use').textContent = tr('Use this pet')
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

// ── Signing in ───────────────────────────────────────────────────────────────────────────────
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
  btn.textContent = tr('Logging in…')
  try {
    const r = await call(api.login, user, pass)
    if (r && r.ok) {
      $('#login-dialog').close()
      S.listError.server = ''
      S.settings.serverSignedIn = true
      if (Q.login.server || Q.installed.server) { Q.login.server = false; Q.err.server = ''; Q.at.server = 0; setTimeout(() => loadQuotas('server', true), 1500) }
      if (S.active === 'server') { S.listLoaded.server = false; renderList(); loadSessions('server') }
    } else {
      $('#login-error').textContent = (r && r.error) || tr("Couldn't log in.")
      $('#login-error').hidden = false
    }
  } catch (err) {
    $('#login-error').textContent = err.message
    $('#login-error').hidden = false
  } finally {
    $('#login-pass').value = ''
    btn.disabled = false
    btn.textContent = tr('Log in')
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────
function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj)
}

function patchFor(p, v) {
  const [a, b] = p.split('.')
  return { [a]: b === undefined ? v : { [b]: v } }
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
  $('#srv-session').textContent = st.serverSignedIn ? tr('Signed in to the server (the session is stored encrypted).') : tr('Not signed in to the server.')
  $('#srv-logout').disabled = !st.serverSignedIn
  $('#about-version').textContent = S.version
  renderThemeGrid()
  renderPetLabels()
  renderSnippetSettings()
  $('#upd-url').value = (st.updates && st.updates.url) || ''
  renderLayoutSettings()
  renderHermesUpd()
}

async function saveSetting(patch) {
  try {
    const before = JSON.stringify(S.settings && S.settings.server ? S.settings.server.urls : [])
    S.settings = await call(api.settings, patch)
    // Another server address = maybe another Hermes: its quotas are asked for again.
    if (JSON.stringify(S.settings.server.urls) !== before) { forgetQuotas('server', true) }
    if (S.settings.lang && S.settings.lang !== getLang()) { reloadForLanguage(); return }
    applyLook()
    renderSettings()
    renderConnSwitch()
  } catch (e) {
    showToastLine(tr("Couldn't save the setting: {0}", e.message))
  }
}

/** Another language: the page loads again, with what was typed and not sent, and goes back to Settings. */
function reloadForLanguage() {
  try { sessionStorage.setItem('pedila.reload', JSON.stringify({ draft: $('#input').value, section: 'appearance' })) } catch {}
  location.reload()
}

function afterReload() {
  try {
    const r = JSON.parse(sessionStorage.getItem('pedila.reload') || 'null')
    sessionStorage.removeItem('pedila.reload')
    if (!r) { return }
    $('#input').value = String(r.draft || '')
    autoGrow()
    openSettings(r.section)
  } catch {}
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
  $('#test-notify').addEventListener('click', () => call(api.testNotify).catch(() => {}))
  $('#open-logs').addEventListener('click', () => call(api.openLogs).catch(() => {}))
}

// ── Startup ──────────────────────────────────────────────────────────────────────────────────
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
  S.modelChoice = { local: init.settings.models?.local || null, server: init.settings.models?.server || null }
  applyLook()
  renderConnSwitch()
  renderBanner()
  newChatView()
  api.onEvent(onEvent)
  wireLayout()
  applyLayout()
  wireSettings()
  wirePetPicker()
  wireExtras()
  S.reasoning = init.settings.chat?.reasoning || ''
  // Hermes versions the main process may already know (later they come with the events).
  try { S.hermesUpd = (await call(api.hermesUpdates)) || {} } catch { S.hermesUpd = {} }
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
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChatView() }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings() }
    if (e.key === 'Escape') { $('#model-menu').hidden = true }
  })
  const petEl = $('#pet')
  petEl.addEventListener('click', () => pet.flash('waving', 2))
  petEl.addEventListener('mouseenter', () => { if (pet.base === 'idle') { pet.flash('waving', 1) } })

  if (init.pet) {
    await applyPet(init.pet).catch(() => {})
  } else {
    // First time: the pet is being downloaded from Petdex; it appears as soon as it arrives.
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
  afterReload()
  updateComposer()
  updateExtrasPills()
  if (!S.current.sid) { renderChat() }
}

start().catch(e => {
  document.body.append(el('pre', { class: 'error', text: tr("Couldn't start the screen: ") + e.message }))
})

// ── Managing chats: menu, rename, pin, archive, delete, export ───────────────────────────────
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
    [tr('✏️ Rename'), () => renameChat(conn, sid)],
    [r.pinned ? tr('📌 Unpin') : tr('📌 Pin to the top'), () => mutateChat(conn, sid, 'pin', !r.pinned)],
    [tr('🗄 Archive'), () => mutateChat(conn, sid, 'archive', true)],
    [tr('⬇️ Export to Markdown'), () => exportChat(conn, sid)],
    [tr('🗑 Delete…'), () => deleteChat(conn, sid), 'danger']
  ], x, y)
}

// There's only one box for asking: the questions go one by one, each when the one before has its answer.
let asking = Promise.resolve()
function askBox(question) {
  const answer = asking.then(() => askNow(question))
  asking = answer.catch(() => {})
  return answer
}

function askNow({ title, text = '', value = null, ok = tr('OK'), danger = false }) {
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
    const no = value === null ? false : null
    const done = v => {
      d.removeEventListener('close', closed)
      okBtn.onclick = null
      $('#ask-cancel').onclick = null
      if (d.open) { d.close() }
      resolve(v)
    }
    // Closed with Esc. The event comes a frame later: if the box is open again, it's the one of the question before.
    const closed = () => { if (!d.open) { done(no) } }
    okBtn.onclick = () => done(value === null ? true : input.value.trim() || null)
    $('#ask-cancel').onclick = () => done(no)
    d.addEventListener('close', closed)
    d.showModal()
    if (value !== null) { input.focus(); input.select() } else { okBtn.focus() }
  })
}

async function renameChat(conn, sid) {
  const r = rowOf(conn, sid)
  const title = await askBox({ title: tr('Rename the chat'), value: chat(conn, sid).title || r.title, ok: tr('Save') })
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
  const yes = await askBox({ title: tr('Delete this chat?'), text: tr("“{0}” will disappear from Pedila and from Hermes Desktop, with all its messages. This can't be undone. (If you only want it out of the way, “Archive” is better.)", title), ok: tr('Delete'), danger: true })
  if (yes) { await mutateChat(conn, sid, 'delete') }
}

async function mutateChat(conn, sid, op, value) {
  try {
    await call(api.mutate, conn, sid, op, value)
  } catch (e) {
    showToastLine(tr("It didn't work: {0}", e.message))
    return false
  }
  const rows = S.sessions[conn]
  const r = rows.find(x => x.id === sid)
  if (op === 'delete' || (op === 'archive' && value)) {
    S.sessions[conn] = rows.filter(x => x.id !== sid)
    if (op === 'delete') { S.chats.delete(key(conn, sid)) }
    if (S.current.conn === conn && S.current.sid === sid) { newChatView() }
    showToastLine(op === 'delete' ? tr('Chat deleted.') : tr("Chat archived. You'll find it in “See archived chats”."))
  } else if (r && op === 'pin') {
    r.pinned = Boolean(value)
  }
  renderList()
  reloadSessionsSoon(conn)
  return true
}

function chatMarkdown(conn, sid) {
  const ch = chat(conn, sid)
  const lines = [`# ${ch.title || 'Chat'}`, '', tr('_Exported from Pedila · {0}{1} · {2}_', CONN_NAMES[conn], ch.model ? ' · ' + ch.model : '', new Date().toLocaleString(locale())), '']
  const turns = [...ch.transcript, ...(ch.live && ch.live.done ? [liveToTurn(ch.live)] : [])]
  for (const t of turns) {
    if (t.role === 'note') { lines.push(`> ℹ ${t.title}`, ''); continue }
    if (t.role === 'user') { lines.push(tr('## You'), '', t.text + (t.images && t.images.length ? `\n\n_(${t.images.length === 1 ? tr('one image') : t.images.length + tr(' images')})_` : ''), ''); continue }
    lines.push('## Hermes', '')
    for (const b of t.blocks) {
      if (b.type === 'text') { lines.push(b.text, ''); continue }
      const d = describeTool(b)
      lines.push(`> 🔧 ${d.title.replace(/`/g, "'")}${b.error ? tr(' — **failed**') : ''}`, '')
    }
  }
  return lines.join('\n')
}

async function exportChat(conn, sid) {
  const ch = chat(conn, sid)
  try {
    if (!ch.loaded) { ch.transcript = await call(api.transcript, conn, sid); ch.loaded = true }
    const r = await call(api.exportChat, ch.title || rowOf(conn, sid).title, chatMarkdown(conn, sid))
    if (r.saved) { showToastLine(tr('Saved to {0}', r.file)) }
  } catch (e) {
    showToastLine(tr("Couldn't export: {0}", e.message))
  }
}

async function openArchived() {
  const d = $('#archived-dialog')
  const list = $('#archived-list')
  const conn = S.active
  $('#archived-where').textContent = CONN_NAMES[conn]
  list.replaceChildren(el('p', { class: 'muted', text: tr('Loading…') }))
  d.showModal()
  try {
    const rows = await call(api.archived, conn)
    list.replaceChildren()
    if (!rows.length) { list.append(el('p', { class: 'muted', text: tr('There are no archived chats.') })); return }
    for (const r of rows) {
      const item = el('div', { class: 'arch-row' },
        el('div', { class: 'grow' }, el('div', { class: 'n', text: r.title }), el('div', { class: 'muted small', text: r.preview })),
        el('button', { class: 'btn-ghost', text: tr('Open'), onclick: () => { d.close(); openChat(conn, r.id) } }),
        el('button', { class: 'btn-ghost', text: tr('Unarchive'), onclick: async () => { if (await mutateChat(conn, r.id, 'archive', false)) { item.remove(); loadSessions(conn) } } }),
        el('button', { class: 'btn-ghost danger', text: tr('Delete'), onclick: async () => {
          const yes = await askBox({ title: tr('Delete this chat?'), text: tr('“{0}” will be deleted for good (from Hermes Desktop too).', r.title), ok: tr('Delete'), danger: true })
          if (yes && await mutateChat(conn, r.id, 'delete')) { item.remove() }
          if (!d.open) { d.showModal() }
        } }))
      list.append(item)
    }
  } catch (e) {
    list.replaceChildren(el('p', { class: 'error', text: tr("Couldn't read them: {0}", e.message) }))
  }
}

// ── Writing: images, read only, reasoning, phrases ───────────────────────────────────────────
const READ_ONLY_NOTE = tr('[Read-only mode: you can read, search and investigate, but do NOT change, delete, install or run anything that modifies files, programs or the system. If a change were needed, explain which one and ask me first.]')
const REASONING = [['', tr("Hermes's default")], ['low', tr('quick (low)')], ['medium', 'normal (medium)'], ['high', tr('deep (high)')], ['xhigh', tr('very deep (xhigh)')], ['max', tr('maximum (max)')]]
const effortName = v => (REASONING.find(r => r[0] === v) || [v, v])[1]

function updateExtrasPills() {
  const ro = $('#readonly-pill')
  ro.classList.toggle('on', S.readOnly)
  ro.title = S.readOnly ? tr("Read only: Hermes won't change anything (click to turn it off)") : tr('Click so that Hermes only reads and looks things up, without changing anything')
  const rp = $('#reason-pill')
  const ch = currentChat()
  rp.disabled = false
  const eff = currentEffort()
  const label = eff.value ? effortName(eff.value) + (eff.own ? '' : tr(" · Hermes's default")) : ch ? tr("the chat's") : tr("Hermes's default")
  rp.textContent = `🧠 ${label}`
  rp.title = ch ? tr('How much Hermes thinks in this chat (click to change it)') : tr('How much Hermes thinks in the new chat (click to change it)')
  schedulePanel()
}

function renderAttach() {
  const strip = $('#attach-strip')
  strip.replaceChildren(...S.attach.map((a, i) => el('div', { class: 'att' },
    el('img', { src: a.url, alt: a.name, title: tr('{0} (click to enlarge)', a.name), onclick: () => openImage(a.url, a.name) }),
    el('button', { class: 'att-x', text: '✕', title: tr('Remove'), onclick: () => { S.attach.splice(i, 1); renderAttach(); updateComposer() } }))))
  strip.hidden = !S.attach.length
  reportDraft()
}

async function addImages(files) {
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { showToastLine(tr('Only images can be attached (PNG, JPG, WebP or GIF).')); continue }
    if (file.size > 15 * 1024 * 1024) { showToastLine(tr('“{0}” is over 15 MB.', file.name)); continue }
    if (S.attach.length >= 6) { showToastLine(tr('6 images per message at most.')); break }
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) { bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)) }
    const ext = file.type.split('/')[1].replace('jpeg', 'jpg')
    const b64 = btoa(bin)
    // The thumbnail is a data: URL (the window's security policy doesn't let blob: load).
    S.attach.push({ name: file.name && file.name !== 'image.png' ? file.name : `screenshot-${Date.now()}.${ext}`, b64, url: `data:${file.type};base64,${b64}` })
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
  m.replaceChildren(el('div', { class: 'mh', text: tr('Quick phrases (Tab or click to use one)') }), ...list.map(x => el('button', { text: x.name, title: x.text, onclick: () => useSnippet(x) })))
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

// ── Sound when finished (made here, no files) ────────────────────────────────────────────────
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

// ── Right panel: usage and parameters ────────────────────────────────────────────────────────
// Like Claude Panel's cards: what's going on now, the open chat and usage, always in sight.
const P = { usage: { local: null, server: null }, at: { local: 0, server: 0 }, loading: { local: false, server: false }, done: { local: null, server: null }, raf: 0, day: '', view: '', hold: false, held: false, reconciling: false }
const panelOn = () => S.settings && S.settings.window && S.settings.window.sidePanel !== false
// Two views: 'simple' (everything in less space; for each quota, only how much of its total has been used) and
// 'advanced' (every detail).
const panelView = () => (S.settings && S.settings.window && S.settings.window.panelView === 'advanced' ? 'advanced' : 'simple')

function applyPanel() {
  const on = panelOn()
  const view = panelView()
  $('#app').classList.toggle('with-panel', on)
  $('#side-panel').classList.toggle('simple', view === 'simple')
  for (const b of document.querySelectorAll('#panel-view button')) {
    b.classList.toggle('active', b.dataset.v === view)
    b.setAttribute('aria-pressed', String(b.dataset.v === view))
  }
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

/** A connection's usage summary, once per minute at most (or when an answer ends). */
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
  // Also what Hermes does outside this window (Hermes Desktop, or started before Pedila opened).
  const remote = remoteBusy(S.active)
  if (all.some(c => c.prompts.size) || remote.some(a => a.status === 'waiting')) { return { cls: 'need', text: tr('Hermes needs you'), live, remote } }
  if (live.some(c => c.live && !c.live.done && c.live.blocks.some(b => b.type === 'tool' && !b.done))) { return { cls: 'busy', text: tr('Using tools'), live, remote } }
  if (live.length || remote.length) { return { cls: 'busy', text: tr('Working'), live, remote } }
  if (all.some(c => liveSubs(c))) { return { cls: 'busy', text: tr('Subagents working'), live, remote } }
  return { cls: 'idle', text: tr('Idle'), live, remote }
}

/** The open chat's numbers, or null (a new chat). */
function chatNumbers() {
  const ch = currentChat()
  if (!ch) { return null }
  const u = ch.usage || {}
  const max = u.max || ch.contextMax || 0
  const row = (S.sessions[ch.conn] || []).find(r => r.id === ch.sid) || {}
  const turns = [...(ch.transcript || []), ...(ch.live ? [ch.live] : [])]
  const last = [...(ch.transcript || [])].reverse().find(t => t.role === 'assistant' && t.stats)
  const e = currentEffort()
  return {
    used: u.used || 0,
    max,
    pct: u.used && max ? Math.min(100, Math.round(u.used / max * 100)) : 0,
    model: ch.model || '—',
    effort: e.value ? effortName(e.value) : '',
    provider: ch.provider || '',
    messages: String(row.messages || turns.length || 0),
    read: kfmt(row.inputTokens || 0),
    written: kfmt(row.outputTokens || u.out || 0),
    tools: String(turns.reduce((n, t) => n + ((t.blocks || []).filter(b => b.type === 'tool').length), 0)),
    last: last ? statsText(last.stats) || '—' : ''
  }
}

const MEMORY_HOW = tr('Chat memory: at 85%, Hermes summarizes the older part')

function panelChatCard() {
  const n = chatNumbers()
  if (!n) {
    return el('section', { class: 'sp-card' }, el('h4', { text: tr('This chat') }),
      el('p', { class: 'muted small', text: tr('New chat on {0}. Once it starts, its memory, tokens and speed show up here.', CONN_NAMES[S.current.conn]) }))
  }
  const ring = el('div', { class: 'sp-ring' + (n.pct >= 80 ? ' warn' : ''), style: `--p:${n.pct}`, title: MEMORY_HOW }, el('span', { text: n.max ? n.pct + '%' : '—' }))
  return el('section', { class: 'sp-card' }, el('h4', { text: tr('This chat') }),
    el('div', { class: 'sp-ctx' }, ring, el('div', { class: 'sp-ctx-txt' },
      el('b', { text: tr('Memory used') }),
      el('span', { class: 'muted', text: n.max ? tr('{0} of {1} tokens', kfmt(n.used), kfmt(n.max)) : tr('No data yet') }))),
    spKv([
      [tr('Model'), n.model],
      n.effort ? [tr('Effort'), n.effort] : null,
      n.provider ? [tr('Provider'), n.provider] : null,
      [tr('Messages'), n.messages],
      [tr('Tokens read'), n.read],
      [tr('Tokens written'), n.written],
      [tr('Tools'), n.tools],
      n.last ? [tr('Last answer'), n.last] : null
    ]))
}

/** The model the new chat will use, as the button below says it. */
const newChatModel = () => ($('#model-pill') ? $('#model-pill').textContent.replace(tr('Model: {0}', ''), '') : '') || '—'

function panelNowCard() {
  const now = hermesNow()
  return el('section', { class: 'sp-card' }, el('h4', { text: tr('Now') }),
    el('div', { class: 'sp-state' }, el('span', { class: 'dot ' + now.cls }), el('span', { text: now.text })),
    spKv([
      [tr('Chats running'), String(now.live.length + now.remote.length)],
      [tr('Read only'), S.readOnly ? tr('yes') : 'no'],
      // Reasoning and model are chosen when a chat starts; with one open, the model shows in "This chat".
      (() => { const e = currentEffort(); return [currentChat() ? tr('Effort (this chat)') : tr('Effort (new chat)'), e.value ? effortName(e.value) : tr("Hermes's default")] })(),
      !currentChat() ? [tr('Model (new chat)'), newChatModel()] : null
    ]))
}

/**
 * When Hermes last answered in that connection or, with Hermes working, since when it has been at it:
 * { busy, total (tasks running), at (0 = it isn't known), open (opens that chat, or null), title } or null.
 */
function lastActivity(conn, u) {
  const now = Date.now()
  const busyChats = [...S.chats.values()].filter(c => c.conn === conn && busy(c))
  const remote = remoteBusy(conn)
  const total = busyChats.length + remote.length
  if (total) {
    // Start: the sending or the beginning of the turn Pedila saw; if the chat was opened with Hermes
    // already working, your last stored message. For what was started outside this window Hermes doesn't
    // give the time.
    const starts = busyChats.map(c => c.turnAt || toMs([...(c.transcript || [])].reverse().find(t => t.role === 'user' && t.ts)?.ts)).filter(t => t > 0 && t <= now + 60000)
    const first = starts.length ? Math.min(...starts, now) : 0
    if (first) { return { busy: true, total, at: first, open: null, title: tr('Started: {0}', full(first)) } }
    // A click opens it here, and then it does show since when it has been working.
    const row = total === 1 && remote.length ? listedRow(conn, remote[0].id) : null
    const names = remote.map(a => a.title || (listedRow(conn, a.id) || {}).title).filter(Boolean)
    return { busy: true, total, at: 0, open: row ? () => openChat(conn, row.id) : null, title: row ? tr('Open “{0}”', row.title || tr('the chat')) : names.join(' · ') }
  }
  // The most recent of what Pedila saw finish (right away) and the last activity Hermes keeps (it also
  // counts what was done from Hermes Desktop or elsewhere, and survives restarts).
  const fromHermes = u && u.last && u.last.at ? u.last : null
  const mine = P.done[conn]
  const last = mine && (!fromHermes || mine.at >= fromHermes.at) ? { at: mine.at, id: mine.sid, title: (S.chats.get(key(conn, mine.sid)) || {}).title || '' } : fromHermes
  if (!last) { return null }
  const at = Math.min(last.at, now)
  // It only opens if the chat is in the list (not archived or deleted).
  const row = last.id ? listedRow(conn, last.id) : null
  const name = (row && row.title) || last.title || ''
  const open = row ? () => openChat(conn, row.id) : null
  return { busy: false, total: 0, at, open, title: `${open ? tr('Open “{0}”', name || tr('the chat')) : name || tr('Last answer')} · ${full(at)}` }
}

/** The first row of "Usage": lastActivity in two boxes. The time updates by itself (tickPanel), without repainting. */
function panelLastTiles(conn, u) {
  const a = lastActivity(conn, u)
  if (!a) { return [] }
  const box = (attrs, big, small) => el('div', { ...attrs, class: 'sp-num' + (attrs.class || '') }, el('b', typeof big === 'string' ? { text: big } : { 'data-span': big.since, text: span(Date.now() - big.since) }), el('span', { text: small }))
  const running = a.total > 1 ? tr('{0} tasks running', a.total) : tr('running')
  if (!a.at) { return [box({ class: ' sp-wide' + (a.open ? ' sp-go' : ''), title: a.title, ...opener(a.open, 'busy') }, tr('Working now'), a.total > 1 ? running : tr('one task running'))] }
  const day = dayLabel(a.at)
  const more = day ? ' · ' + day : ''
  return a.busy
    ? [box({ title: a.title }, hhmm(a.at), tr('task started{0}', more)), box({ title: tr('How long Hermes has been on this task') }, { since: a.at }, running)]
    : [box({ class: a.open ? ' sp-go' : '', title: a.title, ...opener(a.open, 'last') }, hhmm(a.at), tr('last answer{0}', more)), box({ title: tr("Time since Hermes's last answer") }, { since: a.at }, tr('since then'))]
}

// The chat only if it's in the list (not archived or deleted); rowOf gives a filler one.
const listedRow = (conn, id) => (S.sessions[conn] || []).find(r => r.id === id) || null

/** Attributes of a panel card that opens a chat, with the mouse or the keyboard. */
function opener(open, focus) {
  if (!open) { return {} }
  return { role: 'button', tabindex: '0', 'data-focus': focus, onclick: open, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } } }
}

/**
 * Chats Hermes is working in without this window following them (started in Hermes Desktop, or before Pedila
 * opened), according to the last `session.active_list` query. What this window follows wins, and what it saw
 * finish after that query no longer counts.
 */
function remoteBusy(conn) {
  const u = P.usage[conn]
  // Not connected, or with a query more than 3 minutes old, it isn't known: nothing is counted.
  if (!u || !Array.isArray(u.active) || !S.conns[conn] || S.conns[conn].state !== 'ready' || Date.now() - (u.activeAt || 0) > 180000) { return [] }
  return u.active.filter(a => {
    const ch = S.chats.get(key(conn, a.id))
    return !(ch && (busy(ch) || (ch.doneAt || 0) >= (u.activeAt || 0)))
  })
}

/**
 * Every second: the panel's clocks ("25 min", "40 s") up to date; on a day change it repaints (today →
 * yesterday).
 */
function tickPanel() {
  if (!panelOn()) { return }
  const d = new Date().toDateString()
  if (P.day && P.day !== d) { schedulePanel(); return }
  for (const n of document.querySelectorAll('#panel-body [data-span]')) { n.textContent = span(Date.now() - Number(n.dataset.span)) }
}

function usageHead(conn) {
  return el('h4', {}, el('span', { class: 'grow', text: tr('Usage · {0}', CONN_NAMES[conn]) }), el('button', { class: 'sp-link', text: tr('See all'), 'data-focus': 'usage-all', onclick: () => openUsage(conn) }))
}

function panelUsageCard() {
  const conn = S.active
  const u = P.usage[conn]
  loadPanelUsage(conn)
  const head = usageHead(conn)
  if (!u) { return el('section', { class: 'sp-card' }, head, el('p', { class: 'muted small', text: S.conns[conn] && S.conns[conn].state === 'ready' ? tr('Calculating…') : tr('Not connected.') })) }
  const days = u.days.slice(-14)
  const max = Math.max(1, ...days.map(d => d.chats))
  const today = u.today || { chats: 0, input: 0, output: 0 }
  const week = u.week || { chats: 0, input: 0, output: 0 }
  return el('section', { class: 'sp-card' }, head,
    el('div', { class: 'sp-nums' },
      ...panelLastTiles(conn, u),
      el('div', { class: 'sp-num' }, el('b', { text: String(today.chats) }), el('span', { text: tr('chats today') })),
      el('div', { class: 'sp-num' }, el('b', { text: kfmt(today.input + today.output) }), el('span', { text: tr('tokens today') })),
      el('div', { class: 'sp-num' }, el('b', { text: String(week.chats) }), el('span', { text: tr('chats in 7 days') })),
      el('div', { class: 'sp-num' }, el('b', { text: kfmt(week.input + week.output) }), el('span', { text: tr('tokens in 7 days') }))),
    el('div', { class: 'sp-spark', title: tr('Chats per day, last 14 days') }, ...days.map(d => el('div', { class: d.chats ? '' : 'zero', style: `height:${d.chats ? Math.max(8, Math.round(d.chats / max * 100)) : 4}%`, title: `${d.date}: ${d.chats} chats · ${kfmt(d.input + d.output)} tokens` }))),
    el('div', { class: 'sp-spark-l' }, el('span', { text: tr('14 days ago') }), el('span', { text: tr('today') })))
}

/** What the tokens per model count, for the help texts. */
function modelsHow(u) {
  return u && u.modelsFrom === 'hermes'
    ? tr("Tokens read + written by each model over the last year, according to Hermes's statistics: all its chats, and also what it spends on summarizing memory, writing titles or looking at images.")
    : tr('Tokens read + written by each model, adding up your chats.')
}

/** The cards shown in the panel's current view. */
const cardsOn = () => (panelView() === 'simple' ? layout().cardsSimple : layout().cardsChats)

/** What "Local AI" shows of a connection (see localUse), and what it's called. It asks for what it needs. */
function localNow(conn) {
  // It comes with the quotas, which ask every paid API: with their card hidden and once it's known, seldom.
  const q = Q.data[conn]
  const known = q && !Q.err[conn] && (Array.isArray(q.localModels) || (q.data && Array.isArray(q.data.local)))
  loadQuotas(conn, false, cardsOn().includes('cuotas') || !known ? 60000 : 15 * 60000)
  loadPanelUsage(conn)
  const use = localUse(Q.data[conn], P.usage[conn], m => modelName(m) !== m)
  if (!use) { return null }
  const name = use.blocks ? (use.blocks.length === 1 ? use.blocks[0].name : '') : use.name
  return { ...use, title: name ? tr('Local AI · {0}', name) : tr('Local AI') }
}

const LOCAL_HOW = tr('What Hermes has used of this AI according to its own records: tokens read + written, without the cache. Summaries, titles and images count too. A chat that lasts longer than this time counts in proportion, so it is approximate.')

/** The most used models of the AI on your own network (by tokens, not by chats): the paid ones' go with their quota. */
function panelLocalCard() {
  const conn = S.active
  const L = localNow(conn)
  if (!L) { return null }
  if (L.blocks) {
    return el('section', { class: 'sp-card' }, el('h4', { text: L.title }),
      ...L.blocks.map((b, i) => el('div', { class: 'q-prov' }, L.blocks.length > 1 ? el('div', { class: 'q-head' }, el('b', { text: b.name })) : null,
        usedBlock(b.spent, tr('Most used models'), '', `local-${i}`, LOCAL_HOW))))
  }
  const u = P.usage[conn]
  const top = L.models.slice(0, 6)
  const max = Math.max(1, ...top.map(tokensOf))
  return el('section', { class: 'sp-card' }, el('h4', { text: L.title }),
    el('div', { class: 'q-used-h', title: modelsHow(u) }, el('span', { class: 'grow', text: tr('Most used models') })),
    ...top.map(m => {
      const n = tokensOf(m)
      const aux = tasksLine(m.tasks)
      return modelRow({ name: modelName(m.model), tokens: n }, max, tr('{0}\n{1} tokens: {2} read · {3} written{4}', m.model, kfmt(n), kfmt(m.input), kfmt(m.output), aux ? tr('\nIncludes {0}', aux) : ''))
    }))
}

// ── Quotas of the paid APIs (OpenRouter, Venice, OpenCode, DeepSeek, Openference) ──────────────────────────────────
// The "pedila" plugin reads them inside Hermes (the keys don't leave it). The card only appears if that
// Hermes has one of those APIs: with the plugin, the ones that have a key; without it, a button to turn it
// on if Hermes has any set. If not, nothing shows.
const Q = { data: { local: null, server: null }, at: { local: 0, server: 0 }, loading: { local: false, server: false }, again: { local: false, server: false }, gen: { local: 0, server: 0 }, err: { local: '', server: '' }, login: { local: false, server: false }, note: { local: '', server: '' }, busy: { local: '', server: '' }, ask: { local: null, server: null }, installed: { local: false, server: false }, updated: { local: false, server: false }, updNote: { local: '', server: '' }, updAsk: { local: null, server: null }, restarted: { local: false, server: false }, host: { local: 0, server: 0 } }
const QUOTA_NAMES = { openrouter: 'OpenRouter', venice: 'Venice', 'opencode-go': 'OpenCode Go', 'opencode-zen': 'OpenCode Zen', deepseek: 'DeepSeek', openference: 'Openference' }
const RESET_NAMES = { daily: tr('daily'), weekly: tr('weekly'), monthly: tr('monthly') }
const PLAN_NAMES = { go: 'Go', 'go-plus': 'Go Plus', 'go-teams': 'Go Teams' }

/**
 * Forgets a connection's quotas (another address, another session…): they're asked for again. What's known of
 * its plugin's update stays, unless it's another Hermes (`other`).
 */
function forgetQuotas(conn, other = false) {
  Q.gen[conn]++ // whatever is arriving from before is no longer good
  Q.data[conn] = null
  Q.at[conn] = 0
  Q.err[conn] = ''
  Q.note[conn] = ''
  Q.ask[conn] = null
  Q.installed[conn] = false
  if (other) {
    Q.host[conn]++ // what's being installed or updated in the one from before doesn't count for this one
    Q.busy[conn] = ''
    Q.updated[conn] = false
    Q.restarted[conn] = false
    Q.updNote[conn] = ''
    Q.updAsk[conn] = null
  }
}

/** A connection's quotas, once per minute at most (or per `every` ms; or when ↻ is clicked). */
async function loadQuotas(conn, fresh = false, every = 60000) {
  if (Q.loading[conn]) { if (fresh) { Q.again[conn] = true } return }
  if (!fresh && (Date.now() - Q.at[conn] < every || Q.busy[conn] === 'updating')) { return }
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
    // Hermes already uses the new plugin (it reloaded by itself or was restarted): no more notices.
    if (r && r.state === 'ok' && !r.outdated) {
      Q.updated[conn] = false
      Q.updNote[conn] = ''
      Q.updAsk[conn] = null
    }
    if (r && r.state === 'ok' && !r.restart) { Q.restarted[conn] = false }
  } catch (e) {
    if (gen === Q.gen[conn]) { Q.err[conn] = e.message || String(e); Q.login[conn] = Boolean(e.needLogin) }
  } finally {
    if (gen === Q.gen[conn]) { Q.at[conn] = Date.now() }
    Q.loading[conn] = false
    schedulePanel()
    // Someone asked to read again meanwhile (↻ or right after installing): it's read again.
    if (Q.again[conn]) { Q.again[conn] = false; loadQuotas(conn, true) }
  }
}

/**
 * Changing a plugin makes Hermes load all of its plugins again: if it's working, the person decides whether to
 * go on (a long task may take hours).
 */
async function okWhileWorking(conn) {
  const working = await call(api.hermesWorking, conn).catch(() => null)
  return !working || askBox({
    title: tr('Hermes is working'),
    text: tr('When this plugin changes, Hermes loads all of its plugins again. It takes a couple of seconds, and meanwhile a tool of another plugin may fail. Go on anyway?'),
    ok: tr('Go on')
  })
}

async function installQuotas(conn, force = false) {
  if (Q.busy[conn]) { return }
  Q.busy[conn] = 'installing'
  const host = Q.host[conn]
  if (!await okWhileWorking(conn)) { if (host === Q.host[conn]) { Q.busy[conn] = ''; schedulePanel() } return }
  if (host !== Q.host[conn]) { return }
  Q.ask[conn] = null
  Q.note[conn] = ''
  Q.updNote[conn] = ''
  Q.updAsk[conn] = null
  schedulePanel()
  try {
    const r = await call(api.quotasInstall, conn, force)
    if (host !== Q.host[conn]) { return }
    Q.busy[conn] = ''
    if (!r.ok) {
      // Hermes's security scan raised an objection: it's shown and the person decides.
      if (r.scan) { Q.ask[conn] = { scan: r.scan, findings: r.findings || [] } } else { Q.note[conn] = r.error || tr("Couldn't turn the quotas on.") }
      schedulePanel()
      return
    }
    Q.installed[conn] = true
    if (r.restart) { Q.note[conn] = tr("Plugin installed. If the quotas don't show up in a moment, restart Hermes and click “I restarted it: check”.") }
    schedulePanel()
    await loadQuotas(conn, true)
  } catch (e) {
    if (host !== Q.host[conn]) { return }
    Q.busy[conn] = ''
    Q.note[conn] = tr("Couldn't turn the quotas on: {0}", e.message || e)
    // The wait may have been cut off while Hermes did install it: look again.
    loadQuotas(conn, true)
    schedulePanel()
  }
}

/**
 * Installs the quotas plugin's new version. If Hermes still has the old one loaded, the notice becomes "it will
 * be used when Hermes restarts". How it went stays on the card until it's tried again (reading the quotas
 * doesn't erase it).
 */
async function updateQuotas(conn, force = false) {
  if (Q.busy[conn]) { return }
  Q.busy[conn] = 'updating'
  const host = Q.host[conn]
  if (!await okWhileWorking(conn)) { if (host === Q.host[conn]) { Q.busy[conn] = ''; schedulePanel() } return }
  if (host !== Q.host[conn]) { return }
  Q.updAsk[conn] = null
  Q.updNote[conn] = ''
  schedulePanel()
  try {
    const r = await call(api.quotasUpdate, conn, force)
    if (host !== Q.host[conn]) { return }
    if (r.ok) {
      Q.restarted[conn] = false
      if (r.unchanged) { Q.updNote[conn] = tr("GitHub doesn't have the new version yet: try again later.") } else { Q.updated[conn] = true }
    } else if (r.scan) {
      // Hermes's security scan raised an objection: it's shown and the person decides.
      Q.updAsk[conn] = { scan: r.scan, findings: r.findings || [] }
    } else {
      Q.updNote[conn] = r.error || tr("Couldn't update the plugin.")
    }
  } catch (e) {
    if (host !== Q.host[conn]) { return }
    Q.updNote[conn] = tr("Couldn't update the plugin: {0}", e.message || e)
  } finally {
    if (host === Q.host[conn]) { Q.busy[conn] = '' }
    schedulePanel()
  }
  await loadQuotas(conn, true)
}

/** Restarts this PC's Hermes so that it loads the new plugin (only if it isn't working). */
async function restartForQuotas(conn) {
  if (conn !== 'local' || Q.busy[conn]) { return }
  const ok = await askBox({
    title: tr('Restart Hermes?'),
    text: tr("Hermes closes for a few seconds to load the new plugin, and Pedila reconnects by itself. If it's working on something now, it isn't restarted."),
    ok: tr('Restart')
  })
  if (!ok) { return }
  Q.busy[conn] = 'restarting'
  schedulePanel()
  try {
    await call(api.hermesRestart, conn)
    Q.restarted[conn] = true
  } catch (e) {
    showToastLine(tr("Couldn't restart Hermes: {0}", e.message || e))
  } finally {
    Q.busy[conn] = ''
    // It's read again as soon as the connection is ready again.
    Q.at[conn] = 0
    schedulePanel()
  }
}

function quotaBar(usedPct, warnAt = NEARLY) {
  const p = Math.max(0, Math.min(100, usedPct))
  // The width, with its decimal (and a minimum so that something shows if anything was spent).
  return el('div', { class: 'sp-bar q-bar' + (p >= warnAt ? ' warn' : '') }, el('i', { style: `width:${p > 0 ? Math.max(2, trunc1(p)) : 0}%` }))
}

/** "resets in 3 h 10 min (21:00)" or "resets tomorrow at 19:00". */
function resetText(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) { return '' }
  if (ms <= now) { return tr('resets now') }
  if (ms - now < 24 * 3600e3) { return tr('resets in {0} ({1})', span(ms - now), hhmm(ms)) }
  return tr('resets {0} at {1}', dayAhead(ms, now), hhmm(ms))
}

// The time the models used are shown for (the same one for every provider; remembered on this PC).
const SPAN_KEY = 'pedila.cuotas.periodo'
const SPANS = [['day', '24 h', tr('Last 24 hours')], ['week', '7 d', tr('Last 7 days')], ['month', '30 d', tr('Last 30 days')]]
let quotaSpan = null
function spanNow() {
  if (!quotaSpan) { try { quotaSpan = localStorage.getItem(SPAN_KEY) } catch {} }
  return SPANS.some(([id]) => id === quotaSpan) ? quotaSpan : (quotaSpan = 'week')
}
function setSpan(id, button) {
  quotaSpan = id
  try { localStorage.setItem(SPAN_KEY, id) } catch {}
  // The blocks above change their height too: the button that was clicked stays where it was.
  const key = button.getAttribute('data-focus')
  const top = button.getBoundingClientRect().top
  renderPanel()
  const body = $('#panel-body')
  const again = body.querySelector(`[data-focus="${key}"]`)
  if (again) { body.scrollTop += again.getBoundingClientRect().top - top }
}

// The lists ("Free models", "Limits per model") that are open: repainting the panel doesn't close them.
const openLists = new Set()
function quotaList(key, title, ...rows) {
  return el('details', { class: 'q-more', open: openLists.has(key), ontoggle: e => { if (e.target.isConnected) { openLists[e.target.open ? 'add' : 'delete'](key) } } }, el('summary', { text: title }), ...rows)
}
const requestsText = n => (Math.round(n) === 1 ? tr('1 request') : tr('{0} requests', kfmt(n)))

/** One model of a list: its name, its tokens and the bar (against the one that spent the most). */
function modelRow(m, max, title) {
  const n = m.tokens
  return el('div', { class: 'sp-model', title },
    el('span', { class: 'n', text: m.name }), el('span', { class: 'muted', text: `${kfmt(n)} tokens` }),
    el('div', { class: 'sp-bar' }, el('i', { style: `width:${n > 0 ? Math.max(2, Math.round(n / max * 100)) : 0}%` })))
}

/** The buttons to choose the time (24 h, 7 d, 30 d) the models used are shown for. */
function spanTabs(focus) {
  const id = spanNow()
  return el('span', { class: 'q-spans' }, ...SPANS.map(([k, text, title]) => el('button', { class: 'q-span' + (k === id ? ' on' : ''), text, title, 'aria-pressed': String(k === id), 'data-focus': `${focus}-${k}`, onclick: e => setSpan(k, e.currentTarget) })))
}

/** The models Hermes has used with an API and how many tokens each one. */
function spentBlocks(p) {
  const all = !p.spent && Boolean(p.spentAll)
  const sp = p.spent || p.spentAll
  const out = []
  if (sp && !sp.month.models) { out.push(spentLine(sp, all)) /* a plugin from before 1.4.0 */ } else if (sp) {
    out.push(usedBlock(sp, all ? tr('Models used (all the keys)') : tr('Models used'), '', `used-${p.kind}-${p.account ? p.account.n : 0}`))
  }
  // With several keys, what isn't in any of their lists (plugin 1.5.0).
  if (p.spentRest && p.spentRest.month.models) {
    out.push(usedBlock(p.spentRest, tr('With other keys, or not known which one'), tr("What was spent before the plugin noted down the key (from its version 1.5.0 on), by a part of Hermes that hasn't restarted since, or with a key that isn't in the list."), `rest-${p.kind}`))
  }
  return out
}

const API_HOW = tr('What Hermes has spent with this API according to its own records: tokens read + written, without the cache. Summaries, titles and images count too. A chat that lasts longer than this time counts in proportion, so it is approximate.')

/** A model used, in words (the help text of its row). */
const usedTitle = m => [m.model, tr('{0} read · {1} written · {2} in the cache', kfmt(m.input), kfmt(m.output), kfmt(m.cache)), requestsText(m.calls) + (m.cost > 0 ? ' · ' + usd(m.cost) : '')].join('\n')

function usedBlock(sp, name, why, focus, how = API_HOW) {
  if (!sp.month.models.length) { return null }
  const now = sp[spanNow()]
  const head = el('div', { class: 'q-used-h', title: why ? `${why}\n${how}` : how }, el('span', { class: 'grow', text: name }), spanTabs(focus))
  if (!now.models.length) { return el('div', { class: 'q-used' }, head, el('div', { class: 'q-line muted', text: tr('Nothing in this time.') })) }
  const rest = now.models.slice(6)
  const restN = rest.length + (now.others ? now.others.models : 0)
  const restTokens = rest.reduce((a, m) => a + m.tokens, 0) + (now.others ? now.others.tokens : 0)
  const max = Math.max(1, restTokens, ...now.models.map(m => m.tokens))
  const rows = now.models.slice(0, 6).map(m => modelRow({ name: modelName(m.model), tokens: m.tokens }, max, usedTitle(m)))
  if (restN) { rows.push(modelRow({ name: restN === 1 ? tr('1 more model') : tr('{0} more models', restN), tokens: restTokens }, max, rest.map(m => m.model).join('\n'))) }
  const total = [tr('In all: {0} tokens', kfmt(now.tokens)), now.cache > 0 ? tr('{0} in the cache', kfmt(now.cache)) : '', requestsText(now.calls), now.cost > 0 ? usd(now.cost) : ''].filter(Boolean).join(' · ')
  return el('div', { class: 'q-used' }, head, ...rows, el('div', { class: 'q-line muted', text: total }))
}

/** What Hermes spent, in one line (the plugin from before 1.4.0 doesn't tell the models apart). */
function spentLine(sp, all = false) {
  if (!sp) { return null }
  const part = (label, x) => `${label} ${kfmt(x.tokens)}${x.cost > 0 ? ' · ' + usd(x.cost) : ''}`
  const parts = [part('24 h', sp.day), part('7 d', sp.week), part('30 d', sp.month)]
  return el('div', { class: 'q-line muted', title: tr('What Hermes has spent with this API according to its own records: tokens read + written (and the cost, if Hermes knows it). Summaries, titles and images count too.') },
    all ? tr('Hermes spent (with all the keys): {0} · {1} · {2}', ...parts) : tr('Hermes spent: {0} · {1} · {2}', ...parts))
}

/** With several keys for the same API (Hermes's credential pool): what this one is doing. */
function keyChip(a, now) {
  const s = keyState(a, now)
  return s ? el('span', { class: 'q-chip' + (s.cls ? ' ' + s.cls : ''), text: s.text, title: s.title }) : null
}

/**
 * One of a provider's measures, with the same mold for all: name and value on one line, the bar of what's
 * been spent below and, if needed, a note (when it resets, since when it counts…).
 */
function quotaMetric({ label, value, pct = null, note = '', warn = false, title = '' }) {
  return el('div', { class: 'q-win', title },
    el('span', { text: label }), el('b', { class: warn ? 'warn' : '', text: value }),
    pct === null ? null : quotaBar(pct),
    note ? el('span', { class: 'q-line muted', text: note }) : null)
}

// For balances without a "total" (Venice), Pedila remembers the highest one it has seen since the last
// top-up and the bar shows what has been spent since then. If the balance goes up (a top-up or a new day),
// it starts counting again. Only on this PC (it's a visual aid, not the API's data).
// What the plugin says when it can't read a provider. Its 1.0.0 version said it in Spanish.
const PLUGIN_ES = {
  'la clave no vale o no tiene permiso para ver esto': "the key isn't valid or isn't allowed to see this",
  'el proveedor no tiene este dato': "the provider doesn't have this data",
  'el proveedor pide esperar (demasiadas consultas)': 'the provider asks to wait (too many queries)',
  'respuesta ilegible del proveedor': 'unreadable answer from the provider',
  'el proveedor tardó demasiado': 'the provider took too long',
  'no pude llegar al proveedor': "couldn't reach the provider",
  'fallo inesperado leyendo el proveedor': 'unexpected failure reading the provider'
}
function pluginText(s) {
  const m = /^(?:el proveedor respondió|the provider answered) (\d+)$/.exec(s)
  return m ? tr('the provider answered {0}', m[1]) : tr(PLUGIN_ES[s] || s)
}

const PEAKS_KEY = 'pedila.cuotas.picos'
let peaks = null
function observedUse(key, value, epoch = '') {
  if (typeof value !== 'number' || !Number.isFinite(value)) { return null }
  if (!peaks) { try { peaks = JSON.parse(localStorage.getItem(PEAKS_KEY) || '{}') || {} } catch { peaks = {} } }
  const r = nextPeak(peaks[key], value, epoch)
  if (r !== peaks[key]) {
    peaks[key] = r
    try { localStorage.setItem(PEAKS_KEY, JSON.stringify(peaks)) } catch {}
  }
  const spent = Math.max(0, r.max - value)
  return { pct: r.max > 0 ? spent / r.max * 100 : 0, spent, max: r.max, since: r.since, out: r.out || 0 }
}
const sinceText = (o, fmt) => (o.max <= 0 ? '' : o.spent > 0 ? tr('spent {0} of {1} since {2}', fmt(o.spent), fmt(o.max), clock(o.since)) : tr('nothing spent since {0}', clock(o.since)))
/** The last day of something ("2026-12-04", in UTC): "Dec 4", or "Dec 4, 2027" if it isn't this year. */
const lastDay = (iso, now = Date.now()) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...(Number(iso.slice(0, 4)) === new Date(now).getUTCFullYear() ? {} : { year: 'numeric' }) }).format(new Date(iso + 'T00:00:00Z')).replace(/\./g, '')
/** Where Pedila remembers the highest balance of an account (see observedUse). */
const peakKey = (p, conn) => `${conn}:${p.kind}:${p.name && p.name !== QUOTA_NAMES[p.kind] ? p.name + ':' : ''}`
const diemFmt = n => `${(n || 0).toLocaleString(locale(), { maximumFractionDigits: 2 })} DIEM`

const quotaName = p => p.name || QUOTA_NAMES[p.kind] || p.kind

/** What's known of a quota: its figure (`big`) and, in order, its measures ({ metric }), lines and lists. */
function quotaInfo(p, conn = S.active) {
  const now = Date.now()
  const info = { big: null, rows: [] }
  const big = (text, title) => { info.big = { text, title } }
  const metric = m => info.rows.push({ metric: m })
  const line = (text, cls = 'muted') => info.rows.push({ line: text, cls })
  const list = (key, title, lines) => info.rows.push({ list: title, key, lines })
  if (!p.ok) {
    line(tr("Couldn't read it: {0}", pluginText(p.error)), 'warn')
  } else if (p.kind === 'openrouter') {
    big(usd(p.balance), tr('Credit balance you have left on OpenRouter'))
    if (p.creditsTotal > 0 && p.creditsUsed !== null) {
      metric({ label: tr('Credits'), value: tr('{0} of {1}', usd(p.balance), usd(p.creditsTotal)), pct: p.creditsUsed / p.creditsTotal * 100, note: tr('spent {0} of what was bought', usd(p.creditsUsed)) })
    }
    if (p.keyLimit) {
      const used = p.keyLimit.remaining !== null ? p.keyLimit.limit - p.keyLimit.remaining : null
      const at = nextUtcReset(p.keyLimit.reset, now)
      metric({ label: tr('Key limit'), value: tr('{0} of {1}', usd(p.keyLimit.remaining), usd(p.keyLimit.limit)), pct: used !== null ? used / p.keyLimit.limit * 100 : null, note: p.keyLimit.reset ? `${RESET_NAMES[p.keyLimit.reset]}, ${resetText(at, now)}` : tr("doesn't reset") })
    }
    const ku = p.keyUsage || {}
    if (ku.total !== null && ku.total !== undefined) { line(tr('This key: today {0} · week {1} · month {2} · total {3}', usd(ku.day), usd(ku.week), usd(ku.month), usd(ku.total))) }
    if (p.freeTier) { line(tr('No credits bought: the “:free” models have a daily request limit that resets at 00:00 UTC.')) }
  } else if (p.kind === 'venice') {
    big(usd((p.usd || 0) + (p.bundled || 0)), tr('USD balance + credits included in your plan'))
    const epoch = p.nextEpoch ? Date.parse(p.nextEpoch) : NaN
    const k = peakKey(p, conn)
    if (p.bundled !== null && p.bundled !== undefined) {
      const o = observedUse(k + 'bundled', p.bundled)
      metric({ label: tr('Plan credits'), value: usd(p.bundled), pct: o ? o.pct : null, note: o ? sinceText(o, usd) : '', title: tr('The bar counts what was spent since the highest balance Pedila has seen (it starts over when you top up)') })
    }
    if (p.usd !== null && p.usd !== undefined) {
      const o = observedUse(k + 'usd', p.usd)
      metric({ label: tr('USD balance'), value: usd(p.usd), pct: o ? o.pct : null, note: o ? sinceText(o, usd) : '' })
    }
    if (p.diem !== null && p.diem !== undefined) {
      const o = observedUse(k + 'diem', p.diem, p.nextEpoch || '')
      metric({ label: tr("Today's DIEM"), value: diemFmt(p.diem), pct: o ? o.pct : null, note: Number.isFinite(epoch) ? resetText(epoch, now) : '', title: tr("1 DIEM = $1 of usage per day while you have it staked; what you don't spend doesn't accumulate") })
    }
    if (p.tier) { line(`Plan: ${p.tier}`) }
    if (p.access === false) { line(tr("No access: Venice doesn't let you use the API (not enough balance)."), 'warn') }
    if (p.keyExpires) { line(tr('The key expires on {0}', full(Date.parse(p.keyExpires)))) }
    if (p.modelLimits.length) {
      const fmtL = m => [m.rpm ? `${kfmt(m.rpm)}/min` : '', m.rpd ? tr('{0}/day', kfmt(m.rpd)) : '', m.tpm ? `${kfmt(m.tpm)} tokens/min` : ''].filter(Boolean).join(' · ')
      list(peakKey(p, conn) + 'limits', tr('Limits per model ({0})', p.modelLimits.length), p.modelLimits.map(m => ({ title: m.model, text: `${modelName(m.model)}: ${fmtL(m)}` })))
    }
  } else if (p.kind === 'opencode-go') {
    // OpenCode gives whole numbers rounded down (0% up to 1%). From plugin 1.1.0 on, `estimate` may come too
    // (with decimals, from Hermes's tokens and OpenCode's prices) in the windows where it agrees with that
    // whole number. It's shown with ONE decimal, cut off (never more than what was spent).
    const exactOf = w => w.estimate !== null && w.estimate !== undefined
    if (!p.windows.length) {
      line(tr("OpenCode didn't report your plan's usage."))
    } else {
      const most = p.windows.reduce((a, b) => (usedOf(b) > usedOf(a) ? b : a))
      big(exactOf(most) ? pct1(100 - usedOf(most)) : tr('{0}%', 100 - usedOf(most)), tr("What's left of the most used window"))
    }
    const label = { rolling: tr('5-hour window'), weekly: tr('Week'), monthly: tr('Month') }
    const plan = p.plan ? tr(' ({0} plan)', PLAN_NAMES[p.plan] || p.plan) : ''
    for (const w of p.windows) {
      const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      const exact = exactOf(w)
      const mine = w.cost > 0 ? tr('this Hermes: {0} · {1} tokens', usd(w.cost), kfmt(w.tokens)) : ''
      const note = [Number.isFinite(at) ? resetText(at, now) : '', mine].filter(Boolean).join(' · ')
      const title = exact
        ? tr("OpenCode says {0}%: it only gives whole numbers, rounded down. The decimal comes from the tokens this Hermes has spent and from the prices and each model's limit that OpenCode publishes{1}. If the same account is used from somewhere else, what OpenCode says wins.", Math.floor(w.percent), plan)
        : tr('OpenCode gives whole numbers rounded down: 0% is less than 1%.')
      metric({ label: label[w.id] || w.label, value: exact ? tr('{0} used', pct1(w.estimate)) : tr('{0}% used', Math.floor(w.percent)), pct: usedOf(w), note, title })
    }
    if (p.windows.some(exactOf) && p.unpriced && p.unpriced.length) { line(tr("Without a price on OpenCode, these don't count in the decimal: {0}.", p.unpriced.map(modelName).join(', '))) }
    if (p.catalog === false) { line(tr("Couldn't read OpenCode's prices: the whole numbers its API gives are shown.")) }
  } else if (p.kind === 'opencode-zen') {
    line(tr("OpenCode doesn't publish Zen's balance (check it on opencode.ai). What Hermes has spent with it is shown here."))
  } else if (p.kind === 'deepseek') {
    big(p.balances.map(b => money(b.total, b.currency)).join(' + ') || '—', tr('Balance you have left on DeepSeek'))
    for (const b of p.balances) {
      const fmt = n => money(n, b.currency)
      const o = observedUse(peakKey(p, conn) + (b.currency || 'balance').toLowerCase(), b.total)
      metric({ label: b.currency === 'CNY' ? tr('CNY balance') : tr('USD balance'), value: fmt(b.total), pct: o ? o.pct : null, note: o ? sinceText(o, fmt) : '', warn: p.available === false, title: tr('The bar counts what was spent since the highest balance Pedila has seen (it starts over when you top up)') })
      if (b.granted > 0) { line(tr('Granted: {0} · topped up: {1}', fmt(b.granted), fmt(b.toppedUp))) }
    }
    if (p.available === false) { line(tr("Not enough balance: DeepSeek doesn't answer until you top up (platform.deepseek.com)."), 'warn') }
  } else if (p.kind === 'openference') {
    const pctOf = w => Math.floor(w.percent)
    if (p.windows.length) {
      const most = p.windows.reduce((a, b) => (b.percent > a.percent ? b : a))
      big(tr('{0}%', 100 - pctOf(most)), tr("What's left of the most used window"))
    } else {
      big(usd(p.balance), tr('Credit balance you have left on Openference'))
    }
    const label = { rolling: w => (w.hours && w.hours !== 5 ? tr('{0}-hour window', w.hours) : tr('5-hour window')), weekly: () => tr('Week'), 'weekly-tokens': () => tr('Week (tokens)'), monthly: () => tr('Month') }
    for (const w of p.windows) {
      const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      const count = w.limit ? tr('{0} of {1}', kfmt(w.used || 0), kfmt(w.limit)) + (w.unit === 'tokens' ? ' tokens' : '') : ''
      metric({ label: label[w.id] ? label[w.id](w) : w.id, value: tr('{0}% used', pctOf(w)), pct: w.percent, note: [Number.isFinite(at) ? resetText(at, now) : '', count].filter(Boolean).join(' · ') })
    }
    if (p.balance !== null) {
      const bought = p.creditsTotal > 0 && p.balance <= p.creditsTotal
      const o = bought ? null : observedUse(peakKey(p, conn) + 'credits', p.balance)
      metric(bought
        ? { label: tr('Credits'), value: tr('{0} of {1}', usd(p.balance), usd(p.creditsTotal)), pct: (p.creditsTotal - p.balance) / p.creditsTotal * 100, note: tr('spent {0} of what was bought', usd(p.creditsTotal - p.balance)) }
        : { label: tr('Credits'), value: usd(p.balance), pct: o ? o.pct : null, note: o ? sinceText(o, usd) : '' })
    }
    if (p.planName) { line(`Plan: ${p.planName}` + (p.subscribed && p.expiresAt ? ' · ' + tr('until {0}', full(Date.parse(p.expiresAt))) : '')) }
    if (p.active === false) { line(tr("Openference says that the account isn't active."), 'warn') }
    if (!p.subscribed && p.balance !== null && p.balance <= 0) { line(tr('Without a plan or credits, at most the free models answer: Openference limits them per day and may ask for a credit balance for them too (it only says so when it happens).')) }
    if (p.freeModels.length) {
      list(peakKey(p, conn) + 'free', tr('Free models ({0})', p.freeModels.length), p.freeModels.map(m => ({ title: m.model, text: m.until ? tr('{0}: free until {1}', modelName(m.model), lastDay(m.until)) : modelName(m.model) })))
    }
    if (p.usage.requests) { line(tr('This account, in all (cache included): {0} requests · {1} tokens', kfmt(p.usage.requests), kfmt(p.usage.tokens || 0)) + (p.usage.cost > 0 ? ' · ' + usd(p.usage.cost) : '')) }
  }
  if (p.account && p.account.hidden) { line(tr("{0} more keys of this API aren't shown.", p.account.hidden)) }
  return info
}

function quotaBlock(p, conn = S.active) {
  const info = quotaInfo(p, conn)
  const head = el('div', { class: 'q-head' }, el('b', { text: quotaName(p) }), keyChip(p.account, Date.now()), info.big ? el('span', { class: 'q-big', ...info.big }) : null)
  const rows = info.rows.map(r => r.metric ? quotaMetric(r.metric)
    : r.list ? quotaList(r.key, r.list, ...r.lines.map(l => el('div', { class: 'q-line muted', ...l })))
      : el('div', { class: 'q-line ' + r.cls, text: r.line }))
  return el('div', { class: 'q-prov' }, head, ...rows, ...spentBlocks(p))
}

/**
 * A quota in the simple view: its name, the bar and how much of its total has been used. The rest is in its help
 * text; a shorter limit about to stop it, below.
 */
function quotaRow(p, conn = S.active) {
  const now = Date.now()
  const t = quotaTotal(p, (name, value, epoch) => observedUse(peakKey(p, conn) + name, value, epoch), now)
  const key = keyState(p.account, now)
  const info = quotaInfo(p, conn)
  const tip = [quotaName(p) + (key ? ` (${key.text})` : ''),
    ...info.rows.filter(r => !r.list).map(r => (r.metric ? `${r.metric.label}: ${r.metric.value}${r.metric.note ? ' · ' + r.metric.note : ''}` : r.line))].join('\n')
  const value = t.pct === null ? t.text : pctShort(t.pct)
  const bar = t.pct === null ? null : quotaBar(t.pct)
  const hot = t.warn || (t.pct !== null && t.pct >= NEARLY)
  const limit = t.tight && ({ key: tr('Key limit'), weekly: tr('Week'), 'weekly-tokens': tr('Week (tokens)'), monthly: tr('Month') }[t.tight.id] || `${t.tight.hours || 5} h`)
  const left = t.tight && t.tight.at ? t.tight.at - now : 0
  const back = left <= 0 ? '' : left < 24 * 3600e3 ? tr('resets in {0}', span(left)) : tr('resets {0}', dayAhead(t.tight.at, now))
  const tight = t.tight && tr('{0} at {1}', limit, pctShort(t.tight.pct)) + (back ? ' · ' + back : '')
  const off = key && (p.account.resting || p.account.active === false)
  return el('div', { class: 'qs-row' + (off ? ' off' : ''), title: tip },
    el('span', { class: 'n' }, key ? el('i', { class: 'qs-key ' + (off ? key.cls : 'on') }) : null, quotaName(p)),
    bar, el('b', { class: (hot ? 'warn' : '') + (bar ? '' : ' wide'), text: value }),
    tight ? el('span', { class: 'q-line warn qs-note', text: tight }) : null)
}


/** Hermes's security scan raised an objection when installing or updating the plugin: the person decides. */
function scanQuestion(conn, ask, go, done) {
  const no = el('button', { class: 'btn-ghost', text: ask.scan === 'dangerous' ? tr('Got it') : tr('Not now'), onclick: () => { done(); schedulePanel() } })
  const found = ask.findings.map(f => el('div', { class: 'q-line muted', text: '• ' + f }))
  if (ask.scan === 'dangerous') {
    return el('div', { class: 'q-ask' }, el('p', { class: 'small warn', text: tr("Hermes's security scan doesn't allow this plugin to be installed.") }), ...found, el('div', { class: 'q-actions' }, no))
  }
  return el('div', { class: 'q-ask' },
    el('p', { class: 'small', text: tr("Hermes's security scan asks for confirmation. That's expected: the plugin uses your keys, inside Hermes, to ask for the balance.") }),
    ...found, el('div', { class: 'q-actions' }, el('button', { class: 'btn-primary', text: tr('Install anyway'), disabled: Boolean(Q.busy[conn]), onclick: go }), no))
}

function panelQuotasCard(simple = false) {
  const conn = S.active
  loadQuotas(conn)
  const q = Q.data[conn]
  const title = tr('Quotas · {0}', CONN_NAMES[conn])
  const refresh = el('button', { class: 'sp-link', text: Q.loading[conn] ? '…' : '↻', title: tr('Read the quotas again'), 'aria-label': tr('Read the quotas again'), 'data-focus': 'quotas-refresh', onclick: () => loadQuotas(conn, true) })
  const noteText = Q.note[conn] || (q && q.state === 'missing' ? Q.updNote[conn] : '')
  const note = noteText ? el('div', { class: 'q-line warn', text: noteText }) : null
  const err = Q.err[conn] ? el('div', { class: 'q-line warn', text: tr("Couldn't read the quotas: {0}", Q.err[conn]) }) : null
  if (!q) {
    // The first reading failed: say so, with the option to try again (otherwise there's nothing to show).
    return err ? el('section', { class: 'sp-card' }, el('h4', {}, el('span', { class: 'grow', text: title }), refresh), err, Q.login[conn] ? loginAgain(conn) : null) : null
  }
  if (q.state === 'missing') {
    if (!Array.isArray(q.paid) || !q.paid.length) { return null }
    const names = q.paid.map(k => QUOTA_NAMES[k] || k).join(', ')
    const busy = Q.busy[conn]
    // An update that went through "remove and install" may have stopped halfway: its question comes out here.
    const ask = Q.ask[conn] || Q.updAsk[conn]
    const parts = [el('h4', { text: title }),
      el('p', { class: 'small', text: tr("This Hermes uses {0}. Pedila can show you what's left of each one: balance, limits, when they reset and what you've spent.", names) }),
      el('p', { class: 'muted small', text: tr("For that it installs a small Pedila plugin in Hermes: it reads the balance inside Hermes and only returns numbers, so your keys never leave it. It doesn't touch your chats or restart Hermes.") })]
    // When loading a plugin, a Hermes with username and password and no fixed "secret" closes its web
    // sessions.
    if (conn === 'server') { parts.push(el('p', { class: 'muted small', text: tr("Careful: when it loads it, the server's Hermes may close its web sessions (Pedila's too) and you'll have to sign in again once.") })) }
    if (ask) {
      parts.push(scanQuestion(conn, ask, () => installQuotas(conn, true), () => { Q.ask[conn] = null; Q.updAsk[conn] = null }))
    } else if (Q.installed[conn]) {
      parts.push(el('button', { class: 'btn-ghost', text: Q.loading[conn] ? tr('Checking…') : tr('I restarted it: check'), disabled: Q.loading[conn], onclick: () => loadQuotas(conn, true) }))
    } else {
      parts.push(el('button', { class: 'btn-primary', text: busy === 'installing' ? tr('Installing… (it may take a minute)') : busy === 'updating' ? tr('Updating… (it may take a minute)') : tr('Turn on quotas'), disabled: Boolean(busy), onclick: () => installQuotas(conn) }))
    }
    if (note) { parts.push(note) }
    if (err) { parts.push(err) }
    if (Q.login[conn]) { parts.push(loginAgain(conn)) }
    return el('section', { class: 'sp-card' }, ...parts)
  }
  const provs = q.data && Array.isArray(q.data.providers) ? q.data.providers : []
  // An old plugin doesn't know some of the APIs this Hermes has, or its local AI: then the card is only there to offer
  // the new one.
  const some = [q.paid, q.localModels].some(x => Array.isArray(x) && x.length)
  if (!provs.length && !(some && pluginNotice(q, { updated: Q.updated[conn], ask: Q.updAsk[conn] }))) { return null }
  const at = q.data.fetchedAt ? Date.parse(q.data.fetchedAt) : NaN
  return el('section', { class: 'sp-card' },
    el('h4', {}, el('span', { class: 'grow', text: title }),
      simple && !provs.length ? null : simple ? el('span', { class: 'q-ago', text: tr('used'), title: tr('How much of the total of each quota has been used.') + (Number.isFinite(at) ? '\n' + tr('Read at: {0}', full(at)) : '') })
        : Number.isFinite(at) ? el('span', { class: 'q-ago', text: ago(at), title: tr('Read at: {0}', full(at)) }) : null, refresh),
    ...(simple ? [el('div', { class: 'qs-list' }, ...provs.map(pv => quotaRow(pv, conn)))] : provs.map(pv => quotaBlock(pv, conn))),
    quotaUpdateRow(conn, q), note, err, Q.login[conn] ? loginAgain(conn) : null)
}

/** With an old plugin in that Hermes: the button to install the new one (and, if needed, restart). */
function quotaUpdateRow(conn, q) {
  const ask = Q.updAsk[conn]
  const notice = pluginNotice(q, { updated: Q.updated[conn], ask })
  if (!notice) { return null }
  const busy = Q.busy[conn]
  if (notice === 'restart') {
    // It's already on disk (Hermes says so), but it still has the old one loaded: it will use it when it restarts.
    if (conn !== 'local') {
      return el('p', { class: 'muted small', text: tr("Plugin updated. The server's Hermes will use it when it restarts.") })
    }
    return el('div', { class: 'q-ask' },
      el('p', { class: 'small', text: Q.restarted[conn] ? tr('Hermes restarted, but it still has the old plugin loaded. Its log may say why.') : tr("Plugin updated. Hermes will load it when it restarts: restart it when it isn't working.") }),
      el('div', { class: 'q-actions' }, el('button', { class: 'btn-primary', text: busy === 'restarting' ? tr('Restarting Hermes…') : tr('Restart Hermes now'), disabled: Boolean(busy), onclick: () => restartForQuotas(conn) })))
  }
  if (notice === 'ask') { return scanQuestion(conn, ask, () => updateQuotas(conn, true), () => { Q.updAsk[conn] = null }) }
  const parts = [el('p', { class: 'small', text: tr("There's a new quotas plugin: it shows which models you've used with each API, with each key and on your local AI, and it also reads DeepSeek and Openference.") })]
  // When loading a plugin, a Hermes with username and password and no fixed "secret" closes its web
  // sessions.
  if (conn === 'server') { parts.push(el('p', { class: 'muted small', text: tr("Careful: when it changes it, the server's Hermes may close its web sessions (Pedila's too) and you'll have to sign in again once.") })) }
  parts.push(el('div', { class: 'q-actions' }, el('button', { class: 'btn-ghost', text: busy === 'updating' ? tr('Updating… (it may take a minute)') : tr('Update plugin'), disabled: Boolean(busy), onclick: () => updateQuotas(conn) })))
  if (Q.updNote[conn]) { parts.push(el('div', { class: 'q-line warn', text: Q.updNote[conn] })) }
  return el('div', { class: 'q-ask' }, ...parts)
}

/** Hermes closed the session (for example, when loading the plugin): a button to sign in again. */
function loginAgain(conn) {
  if (conn !== 'server') { return null }
  return el('div', { class: 'q-actions' }, el('button', { class: 'btn-primary', text: tr('Sign in again'), onclick: () => openLogin() }))
}

function panelConnsCard() {
  return el('section', { class: 'sp-card' }, el('h4', { text: tr('Connections') }),
    ...visibleConns().filter(c => S.conns[c]).flatMap(c => {
      const st = S.conns[c]
      const what = stateText(st)
      const row = el('div', { class: 'sp-conn', title: connLabel(c) }, el('span', { class: 'dot ' + st.state }), el('span', { text: CONN_NAMES[c] }), el('span', { class: 's', text: st.state === 'ready' && st.detail ? `${what} · ${st.detail}` : what }))
      // Below, their Hermes's version and whether there's a new one (a click goes to Settings → About).
      const u = hermesUpdText(c)
      if (!u) { return [row] }
      return [row, el('button', { class: 'sp-hint sp-hermes' + (u.warn ? ' warn' : ''), 'data-focus': 'hermes-' + c, text: u.text, title: tr('Hermes versions: Settings → About'), onclick: () => openSettings('about') })]
    }))
}

/** A connection's Hermes version, for the card and Settings: { text, warn } or null. */
function hermesUpdText(c) {
  const u = S.hermesUpd && S.hermesUpd[c]
  if (!u || !u.version) { return null }
  const to = u.latest ? ` ${u.latest}` : ''
  const auto = ((S.settings && S.settings.hermes) || {}).autoUpdate !== false
  if (u.applying && u.applying.kind === 'restart') { return { text: tr('Restarting Hermes {0}…', u.version), warn: true } }
  if (u.applying) { return { text: tr('Updating Hermes {0} → {1}…', u.applying.from, u.applying.to || tr('the latest')), warn: true } }
  const r = u.lastResult
  if (u.available && r && !r.ok) { return { text: tr("Hermes {0} · couldn't be updated ({1}){2}", u.version, r.error, auto ? tr('; it will be tried again in a few hours') : ''), warn: true } }
  if (u.available && !u.canApply && c !== 'local') { return { text: tr("Hermes {0} · new version available{1}: it's updated from its server", u.version, to), warn: false } }
  // This PC's without a known method = it couldn't be asked (repeated after 15 min).
  if (u.available && !u.canApply && !u.method) { return { text: tr('Hermes {0} · new version available{1} (not known yet whether it can install itself; checking again in a few minutes)', u.version, to), warn: false } }
  if (u.available && !u.canApply) { return { text: tr('Hermes {0} · new version available{1}: update it with its installer or with Hermes Desktop', u.version, to), warn: true } }
  if (u.available && !auto) { return { text: tr('Hermes {0} · new version available{1}', u.version, to), warn: true } }
  if (u.available) { return { text: tr('Hermes {0} · new version available{1}: it will install itself after 10 min without Hermes or the PC being used', u.version, to), warn: false } }
  if (r && r.ok && Date.now() - r.at < 24 * 3600e3) { return { text: tr('Hermes {0} · updated {1}', u.version, ago(r.at)), warn: false } }
  return { text: tr('Hermes {0} · up to date', u.version), warn: false }
}

/** Settings → About → Hermes: each connection with its version and the buttons. */
function renderHermesUpd() {
  const box = $('#hermes-upd')
  if (!box) { return }
  box.replaceChildren(...visibleConns().filter(c => S.conns[c]).map(c => {
    const u = S.hermesUpd[c] || {}
    const t = hermesUpdText(c)
    const check = el('button', { class: 'btn-ghost', text: tr('Check now'), disabled: Boolean(u.applying), onclick: async e => {
      e.target.disabled = true
      e.target.textContent = tr('Looking for updates…')
      try { S.hermesUpd[c] = await call(api.hermesCheck, c) } catch (err) { showToastLine(tr("Couldn't look it up: {0}", err.message)) }
      renderHermesUpd()
      schedulePanel()
    } })
    const apply = u.available && u.canApply && !u.applying
      ? el('button', { class: 'btn-primary', text: u.latest ? tr('Update now to {0}', u.latest) : tr('Update now'), onclick: () => hermesUpdateNow(c) })
      : null
    return el('div', { class: 'hermes-upd-row' },
      el('div', { class: 'grow' }, el('b', { text: CONN_NAMES[c] }), el('div', { class: 'muted small' + (t && t.warn ? ' warn' : ''), text: t ? t.text : tr('Not connected: its version is unknown.') })),
      check, apply)
  }))
}

async function hermesUpdateNow(c) {
  const u = S.hermesUpd[c] || {}
  const ok = await askBox({
    title: u.latest ? tr('Update Hermes to {0}?', u.latest) : tr('Update Hermes?'),
    text: u.busy
      ? tr("Hermes is working right now: updating restarts it and cuts off whatever it's doing. If you can, wait until it finishes (it installs itself after 10 minutes without being used).")
      : tr("Hermes closes for a few minutes to update, and Pedila reconnects by itself when it's done."),
    ok: tr('Update'), danger: Boolean(u.busy)
  })
  if (!ok) { return }
  try { await call(api.hermesUpdate, c) } catch (e) { showToastLine(tr("Couldn't update Hermes: {0}", e.message)) }
}

function renderPanel() {
  if (!panelOn() || !S.settings) { return }
  const body = $('#panel-body')
  const view = panelView()
  const top = P.view === view ? body.scrollTop : 0 // the other view starts from the top
  P.view = view
  // With the focus on a card that can be clicked, repainting gives it back (keyboard).
  const focused = body.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null
  // The cards and their order come from Settings → Layout (each one says in which view it shows).
  const L = layout()
  const on = cardsOn()
  const cards = []
  for (const id of L.cards) {
    if (!on.includes(id) || !CARDS[id]) { continue }
    const c = view === 'simple' ? CARDS[id].simple() : CARDS[id].make()
    if (!c) { continue }
    c.dataset.card = id
    const h = c.querySelector('h4')
    if (h) { h.classList.add('drag-handle'); h.title = tr('Drag to move it') }
    cards.push(c)
  }
  body.replaceChildren(...cards)
  body.scrollTop = top
  P.day = new Date().toDateString()
  if (focused) { body.querySelector(`[data-focus="${focused}"]`)?.focus({ preventScroll: true }) }
}

// ── Tasks: Hermes's plan and what it's doing (as in Claude Code) ────────────────────────────
// The plan comes from its todo_list tool (todo.updated events, or the last stored result); the rest, from
// what already arrives of the turn: state, running tools and subagents.
const COMPACT_TEXT = tr("Summarizing the chat's memory")
const TODO_ICON = { completed: '✓', in_progress: '●', pending: '○', cancelled: '✕' }
const TODO_NAME = { completed: tr('Done'), in_progress: tr('In progress'), pending: tr('Pending'), cancelled: tr('Canceled') }
const SUB_ICON = { running: '⟳', queued: '○', done: '✓', failed: '✕', stopped: '■', gone: '–' }
const liveSubs = c => { let n = 0; for (const sa of c.subagents.values()) { if (sa.state === 'running' || sa.state === 'queued') { n++ } } return n }

/**
 * The subagents Pedila believes alive are checked every 10 s against the ones Hermes really has
 * (subagent.list): a child that never started, or whose end event was lost (a reconnection, a gateway
 * restart), stops showing as "working" forever. Two absences in a row = "finished".
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

/**
 * The chat whose tasks are shown: the open one if it has any; otherwise, one of this connection with Hermes
 * working.
 */
function taskChat() {
  const has = c => c && ((c.todos && c.todos.items.length) || busy(c) || c.subagents.size)
  const cur = currentChat()
  if (has(cur)) { return cur }
  const working = [...S.chats.values()].filter(c => c.conn === S.active && (busy(c) || liveSubs(c)))
  return working.find(c => busy(c) && c.todos && c.todos.items.length) || working.find(c => busy(c)) || working[0] || null
}

/** The tasks in their order, each subtask below its own (indented). */
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
  const head = el('h4', {}, el('span', { text: tr('Tasks') }), counted.length ? el('span', { class: 'sp-count', title: tr('{0} of {1} done', done, counted.length), text: `${done}/${counted.length}` }) : null)
  if (!ch) {
    // What Hermes does outside this window doesn't bring its plan: a click opens it here, and then it
    // does.
    const other = remoteBusy(S.active).map(a => listedRow(S.active, a.id)).find(Boolean)
    return el('section', { class: 'sp-card' }, head, other
      ? el('button', { class: 'sp-hint', 'data-focus': 'tasks-other', text: tr('Hermes is working in “{0}”. Open it to see its plan and its progress.', other.title || tr('a chat')), onclick: () => openChat(S.active, other.id) })
      : el('p', { class: 'sp-hint', text: tr("Nothing running. When Hermes works on something, its plan, what it's doing and how long it has been at it show up here.") }))
  }
  const running = busy(ch)
  const parts = [head]
  if (ch !== currentChat()) {
    parts.push(el('button', { class: 'sp-where', 'data-focus': 'tasks-where', title: tr('Open this chat'), text: tr('In “{0}”', ch.title || tr('another chat')), onclick: () => openChat(ch.conn, ch.sid) }))
  }
  if (counted.length) {
    parts.push(el('div', { class: 'sp-progress', role: 'progressbar', 'aria-label': tr('Tasks done'), 'aria-valuemin': '0', 'aria-valuemax': String(counted.length), 'aria-valuenow': String(done) },
      el('i', { style: `width:${Math.round(done / counted.length * 100)}%` })))
  }
  if (items.length) {
    parts.push(el('ul', { class: 'sp-todo' }, ...todoRows(items).map(({ t, depth }) => el('li', {
      class: t.status + (running && t.status === 'in_progress' ? ' live' : ''),
      style: depth ? `padding-left:${depth * 14}px` : null,
      title: TODO_NAME[t.status] || ''
    }, el('span', { class: 'i', text: TODO_ICON[t.status] || '○' }), el('span', { class: 't', text: t.content })))))
    const waiting = liveSubs(ch)
    if (!running && waiting) { parts.push(el('p', { class: 'sp-note', text: tr('Waiting for {0}.', waiting === 1 ? tr('a subagent') : waiting + tr(' subagents')) })) }
    else if (!running && done < counted.length) { parts.push(el('p', { class: 'sp-note', text: tr('Some steps were left undone.') })) }
  }
  if (running) {
    const L = ch.live && !ch.live.done ? ch.live : null
    const status = L ? L.status : tr('Working')
    const tools = L ? L.blocks.filter(b => b.type === 'tool') : []
    const since = L && L.status === COMPACT_TEXT && L.compactAt ? L.compactAt : 0
    parts.push(el('div', { class: 'sp-now' + (items.length ? '' : ' solo') }, el('span', { class: 'spin' }), el('span', { class: 't', title: status, text: status }),
      since ? el('span', { class: 'w', title: tr('How long it has been summarizing'), 'data-span': since, text: span(Date.now() - since) })
        : tools.length ? el('span', { class: 'w', title: tr('Tools used in this answer'), text: tr('{0} tools', tools.length) }) : null))
    for (const b of tools.filter(b => !b.done).slice(-4)) {
      parts.push(el('div', { class: 'sp-run running' }, el('span', { class: 'i', text: '⟳' }),
        el('span', { class: 't' }, el('b', { text: b.name || tr('tool') }), b.args ? el('span', { class: 'd', title: b.args, text: b.args }) : null),
        b.startedAt ? el('span', { class: 'w', 'data-span': b.startedAt, text: span(Date.now() - b.startedAt) }) : null))
    }
  }
  const subs = [...ch.subagents.values()].sort((a, b) => (a.index || 0) - (b.index || 0))
  if (subs.length) {
    parts.push(el('div', { class: 'sp-sub-h', text: tr('Subagents · {0}/{1}', subs.filter(x => x.state === 'done').length, subs.length) }))
    for (const sa of subs) {
      const what = sa.state === 'running' ? (sa.tool ? tr('using {0}', sa.tool) : sa.text || tr('working'))
        : { queued: tr('queued'), failed: tr('failed'), stopped: tr('stopped'), gone: tr('finished') }[sa.state] || tr('done')
      const goal = sa.goal || tr('Subagent {0}', (sa.index || 0) + 1)
      parts.push(el('div', { class: 'sp-run ' + sa.state }, el('span', { class: 'i', text: SUB_ICON[sa.state] || '○' }),
        el('span', { class: 't' }, el('b', { title: goal, text: goal }), el('span', { class: 'd', text: what + (sa.tools ? tr(' · {0} tools', sa.tools) : '') })),
        sa.state === 'running' ? el('span', { class: 'w', 'data-span': sa.since, text: span(Date.now() - sa.since) })
          : sa.seconds != null ? el('span', { class: 'w', text: span(sa.seconds * 1000) }) : null))
    }
  }
  if (!items.length && !running && !subs.length) { parts.push(el('p', { class: 'sp-hint', text: tr('Nothing running.') })) }
  return el('section', { class: 'sp-card' }, ...parts)
}

// ── The panel's simple view: the same cards, in less space ───────────────────────────────────
/**
 * One thing and its value, two to a line or on a line of its own (`wide`; with `wrap`, a value that doesn't fit next to
 * its name goes below). `value`: text, or pieces of a line.
 */
function fact(name, value, { wide = false, wrap = false, title = '', open = null, focus = '' } = {}) {
  return el('div', { class: 'sp-fact' + (wide || wrap ? ' wide' : '') + (wrap ? ' wrap' : '') + (open ? ' sp-go' : ''), title: title || (typeof value === 'string' ? `${name}: ${value}` : ''), ...opener(open, focus) },
    el('span', { class: 'k', text: name }), el('span', { class: 'v' }, value))
}

/** A card's title with its main thing on the right. */
const simpleHead = (name, ...right) => el('h4', {}, el('span', { text: name }), right.length ? el('span', { class: 'sp-side' }, ...right) : null)

/** How long since a moment, as "25 min ago" (it updates by itself, see tickPanel). */
function agoPieces(at) {
  const [before, after] = tr('{0} ago').split('{0}')
  return [before, el('span', { 'data-span': at, text: span(Date.now() - at) }), after]
}

function simpleNowCard() {
  const now = hermesNow()
  const open = currentChat()
  const e = currentEffort()
  const effort = e.value ? effortName(e.value) : tr("Hermes's default")
  // The default's name alone, without saying that it's the default (its help text does).
  const model = () => {
    const opts = S.models[S.current.conn]
    const m = S.modelChoice[S.current.conn] ? null : opts && opts.current.model ? opts.current : null
    return m ? modelName(m.model) + (m.local ? '' : ' ☁') : newChatModel()
  }
  return el('section', { class: 'sp-card' },
    simpleHead(tr('Now'), el('span', { class: 'sp-state' }, el('span', { class: 'dot ' + now.cls }), el('span', { text: now.text }))),
    el('div', { class: 'sp-facts' },
      fact(tr('Chats running'), String(now.live.length + now.remote.length)),
      fact(tr('Read only'), S.readOnly ? tr('yes') : 'no'),
      fact(tr('Effort'), effort, { wrap: true, title: `${open ? tr('Effort (this chat)') : tr('Effort (new chat)')}: ${effort}` }),
      open ? null : fact(tr('Model'), model(), { wrap: true, title: `${tr('Model (new chat)')}: ${newChatModel()}` })))
}

function simpleChatCard() {
  const n = chatNumbers()
  if (!n) { return el('section', { class: 'sp-card' }, simpleHead(tr('This chat'), el('span', { class: 'muted', text: tr('New chat') }))) }
  const tokens = n.max ? tr('{0} of {1} tokens', kfmt(n.used), kfmt(n.max)) : tr('No data yet')
  return el('section', { class: 'sp-card' },
    simpleHead(tr('This chat'), el('span', { class: 'muted', title: tr('Memory used'), text: tokens })),
    el('div', { class: 'qs-list one', title: `${tokens}\n${MEMORY_HOW}` }, el('div', { class: 'qs-row' },
      el('span', { class: 'n', text: tr('Memory used') }), quotaBar(n.pct), el('b', { class: n.pct >= NEARLY ? 'warn' : '', text: n.max ? tr('{0}%', n.pct) : '—' }))),
    el('div', { class: 'sp-facts' },
      fact(tr('Model'), n.model, { wrap: true }),
      n.provider ? fact(tr('Provider'), n.provider, { wrap: true }) : null,
      // The effort is already in "Now".
      n.effort && !layout().cardsSimple.includes('ahora') ? fact(tr('Effort'), n.effort) : null,
      fact(tr('Messages'), n.messages),
      fact(tr('Tools'), n.tools),
      fact(tr('Read'), n.read, { title: `${tr('Tokens read')}: ${n.read}` }),
      fact(tr('Written'), n.written, { title: `${tr('Tokens written')}: ${n.written}` }),
      n.last ? fact(tr('Last answer'), n.last, { wrap: true }) : null))
}

function simpleTasksCard() {
  const ch = taskChat()
  if (!ch) {
    const other = remoteBusy(S.active).map(a => listedRow(S.active, a.id)).find(Boolean)
    if (!other) { return el('section', { class: 'sp-card' }, simpleHead(tr('Tasks'), el('span', { class: 'muted', text: tr('Nothing running') }))) }
    return el('section', { class: 'sp-card' }, simpleHead(tr('Tasks')),
      el('button', { class: 'sp-hint one', 'data-focus': 'tasks-other', title: tr('Hermes is working in “{0}”. Open it to see its plan and its progress.', other.title || tr('a chat')), text: tr('In “{0}”', other.title || tr('another chat')), onclick: () => openChat(S.active, other.id) }))
  }
  const items = ch.todos ? ch.todos.items : []
  const counted = items.filter(t => t.status !== 'cancelled')
  const done = counted.filter(t => t.status === 'completed').length
  const running = busy(ch)
  const subs = [...ch.subagents.values()]
  const waiting = liveSubs(ch)
  const count = counted.length ? el('span', { class: 'sp-count', title: tr('{0} of {1} done', done, counted.length), text: `${done}/${counted.length}` }) : null
  const parts = [simpleHead(tr('Tasks'), ...(count ? [count] : !running && !subs.length ? [el('span', { class: 'muted', text: tr('Nothing running') })] : []))]
  if (ch !== currentChat()) {
    parts.push(el('button', { class: 'sp-where', 'data-focus': 'tasks-where', title: tr('Open this chat'), text: tr('In “{0}”', ch.title || tr('another chat')), onclick: () => openChat(ch.conn, ch.sid) }))
  }
  if (counted.length) {
    parts.push(el('div', { class: 'sp-progress', role: 'progressbar', 'aria-label': tr('Tasks done'), 'aria-valuemin': '0', 'aria-valuemax': String(counted.length), 'aria-valuenow': String(done) },
      el('i', { style: `width:${Math.round(done / counted.length * 100)}%` })))
  }
  // One line: the step it's on (the whole plan is in its help text) or how it was left.
  const step = running || waiting ? items.find(t => t.status === 'in_progress') : null
  const plan = todoRows(items).map(({ t, depth }) => `${'  '.repeat(depth)}${TODO_ICON[t.status] || '○'} ${t.content}`).join('\n')
  if (step) {
    parts.push(el('ul', { class: 'sp-todo one', title: plan }, el('li', { class: 'in_progress' + (running ? ' live' : '') }, el('span', { class: 'i', text: TODO_ICON.in_progress }), el('span', { class: 't', text: step.content }))))
  } else if (!running && !waiting && done < counted.length) {
    parts.push(el('div', { class: 'q-line muted', title: plan, text: tr('Some steps were left undone.') }))
  }
  if (running) {
    const L = ch.live && !ch.live.done ? ch.live : null
    const tools = L ? L.blocks.filter(b => b.type === 'tool') : []
    const tool = tools.filter(b => !b.done).at(-1)
    const since = tool ? tool.startedAt : L && L.status === COMPACT_TEXT ? L.compactAt : 0
    const what = tool ? [tool.name || tr('tool'), tool.args].filter(Boolean).join(' · ') : L ? L.status : tr('Working')
    parts.push(el('div', { class: 'sp-now solo', title: what }, el('span', { class: 'spin' }), el('span', { class: 't', text: what }),
      since ? el('span', { class: 'w', 'data-span': since, text: span(Date.now() - since) })
        : tools.length ? el('span', { class: 'w', title: tr('Tools used in this answer'), text: tr('{0} tools', tools.length) }) : null))
  }
  if (subs.length) {
    const list = subs.slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map(sa => `${SUB_ICON[sa.state] || '○'} ${sa.goal || tr('Subagent {0}', (sa.index || 0) + 1)}`).join('\n')
    parts.push(el('div', { class: 'q-line' + (waiting ? '' : ' muted'), title: list, text: tr('Subagents · {0}/{1}', subs.filter(x => x.state === 'done').length, subs.length) }))
  }
  return el('section', { class: 'sp-card' }, ...parts)
}

function simpleUsageCard() {
  const conn = S.active
  const u = P.usage[conn]
  loadPanelUsage(conn)
  const head = usageHead(conn)
  if (!u) { return el('section', { class: 'sp-card' }, head, el('div', { class: 'q-line muted', text: S.conns[conn] && S.conns[conn].state === 'ready' ? tr('Calculating…') : tr('Not connected.') })) }
  const a = lastActivity(conn, u)
  const day = a && a.at ? dayLabel(a.at) : ''
  const when = a && a.at ? (day ? `${day}, ${hhmm(a.at)}` : hhmm(a.at)) : ''
  const sum = x => { const n = x || { chats: 0, input: 0, output: 0 }; const t = kfmt(n.input + n.output); return n.chats === 1 ? tr('1 chat · {0} tokens', t) : tr('{0} chats · {1} tokens', n.chats, t) }
  return el('section', { class: 'sp-card' }, head,
    el('div', { class: 'sp-facts' },
      !a ? null : !a.at ? fact(tr('Working now'), a.total > 1 ? tr('{0} tasks running', a.total) : tr('one task running'), { wrap: true, title: a.title, open: a.open, focus: 'busy' })
        : a.busy ? fact(a.total > 1 ? tr('{0} tasks running', a.total) : tr('Task started'), [when + ' · ', el('span', { 'data-span': a.at, text: span(Date.now() - a.at) })], { wrap: true, title: a.title })
          : fact(tr('Last answer'), [when + ' · ', ...agoPieces(a.at)], { wrap: true, title: a.title, open: a.open, focus: 'last' }),
      fact(tr('Today'), sum(u.today), { wide: true }),
      fact(tr('7 days'), sum(u.week), { wide: true })))
}

function simpleLocalCard() {
  const conn = S.active
  const L = localNow(conn)
  if (!L) { return null }
  const row = (name, tokens, title) => fact(name, kfmt(tokens), { wide: true, title })
  if (!L.blocks) {
    return el('section', { class: 'sp-card' }, el('h4', { text: L.title }),
      el('div', { class: 'sp-facts', title: modelsHow(P.usage[conn]) }, ...L.models.slice(0, 3).map(m => row(modelName(m.model), tokensOf(m), tr('{0}\n{1} tokens: {2} read · {3} written{4}', m.model, kfmt(tokensOf(m)), kfmt(m.input), kfmt(m.output), '')))))
  }
  const id = spanNow()
  return el('section', { class: 'sp-card' },
    el('h4', {}, el('span', { class: 'grow', text: L.title, title: `${L.title}\n${LOCAL_HOW}` }), spanTabs('local')),
    ...L.blocks.map(b => {
      const now = b.spent[id]
      return el('div', { class: 'sp-facts' },
        L.blocks.length > 1 ? el('div', { class: 'sp-fact wide head' }, el('span', { class: 'k', text: b.name })) : null,
        ...(now.models.length ? now.models.slice(0, 3).map(m => row(modelName(m.model), m.tokens, `${usedTitle(m)}\n${tr('In all: {0} tokens', kfmt(m.tokens))}`)) : [el('div', { class: 'sp-fact wide' }, el('span', { class: 'k', text: tr('Nothing in this time.') }))]))
    }))
}

/** Each connection on a line: its state if it isn't connected; if it is, its Hermes's version and the new one, if any. */
function simpleConnsCard() {
  return el('section', { class: 'sp-card' }, simpleHead(tr('Connections')),
    el('div', { class: 'sp-facts' }, ...visibleConns().filter(c => S.conns[c]).map(c => {
      const st = S.conns[c]
      const h = (S.hermesUpd && S.hermesUpd[c]) || {}
      const u = hermesUpdText(c)
      const version = !u ? '' : h.applying ? u.text : `Hermes ${h.version}${h.available && h.latest ? ' → ' + h.latest : h.available ? ' → …' : ''}`
      const title = [connLabel(c) + (st.state === 'ready' && st.detail ? ` · ${st.detail}` : ''), u ? u.text : '', u ? tr('Hermes versions: Settings → About') : ''].filter(Boolean).join('\n')
      const says = version && (st.state === 'ready' || h.applying)
      const f = fact('', says ? version : stateText(st), { wrap: true, title, open: u ? () => openSettings('about') : null, focus: 'hermes-' + c })
      f.querySelector('.k').append(el('span', { class: 'dot ' + st.state }), CONN_NAMES[c])
      f.classList.toggle('warn', Boolean(says && u.warn))
      return f
    })))
}

// ── Adjustable widths: the chat list and the right panel ─────────────────────────────────────
// Their line is dragged (or arrow keys with the focus on it; Home, Enter or a double click: the default
// width). Same limits as settings.js. The chat always keeps at least MAIN_MIN pixels: in a narrow window
// the panel gives way first (down to its minimum) and then the list, without touching what is saved; so
// what is seen on releasing a line is what stays.
const MAIN_MIN = 420
const WIDTHS = {
  side: { key: 'sideWidth', def: 286, min: 240, max: 520, css: '--side-w', box: '#sidebar', dir: 1 },
  // (Each view of the panel has its width: the simple one needs little.)
  panel: { get key() { return panelView() === 'simple' ? 'panelWidthSimple' : 'panelWidth' }, def: 300, min: 240, max: 680, css: '--panel-w', box: '#side-panel', dir: -1 }
}
// With the list on the right (Layout), each line grows the other way.
const dirOf = d => d.dir * (layout().swap ? -1 : 1)
const widthOf = d => { const v = S.settings && S.settings.window ? S.settings.window[d.key] : null; return Number.isFinite(v) ? v : d.def }
// ≤ 900 px: the CSS hides the panel and the lines and fixes the list: nothing is adjusted there.
const narrow = () => innerWidth <= 900
const panelShown = () => panelOn() && !narrow()

/** The widths that fit: the saved ones, or shrunk (the panel first) to leave MAIN_MIN for the chat. */
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
    // The most it can grow now without taking room from the other column: its maximum, or whatever leaves
    // the chat MAIN_MIN. The other one doesn't move while dragging.
    const ceiling = () => {
      const other = name === 'side' ? (panelShown() ? $('#side-panel').getBoundingClientRect().width : 0) : $('#sidebar').getBoundingClientRect().width
      return Math.max(d.min, Math.min(d.max, Math.floor(innerWidth - MAIN_MIN - other)))
    }
    const show = (px, top = ceiling()) => {
      const v = Math.round(Math.min(top, Math.max(d.min, px)))
      $('#app').style.setProperty(d.css, v + 'px')
      h.setAttribute('aria-valuenow', String(v))
      // In a tight window, as the list narrows the panel gets its width back at the same time (not all at
      // once on release).
      if (name === 'side' && panelShown()) { $('#app').style.setProperty(WIDTHS.panel.css, fittedWidths(v).panel + 'px') }
      return v
    }
    const save = v => saveSetting({ window: { [d.key]: v } }).then(applyWidths)
    h.addEventListener('pointerdown', e => {
      if (e.button !== 0 || narrow()) { return }
      e.preventDefault()
      try { h.setPointerCapture(e.pointerId) } catch {}
      // From the width that is seen (in a narrow window it may be smaller than the saved one).
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
        // Only if it really moved: trying to widen what didn't fit doesn't save the squeezed width.
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

// ── Your usage ───────────────────────────────────────────────────────────────────────────────
async function openUsage(conn = S.active) {
  const d = $('#usage-dialog')
  for (const b of document.querySelectorAll('#usage-tabs button')) { b.classList.toggle('active', b.dataset.conn === conn) }
  const body = $('#usage-body')
  body.replaceChildren(el('p', { class: 'muted', text: tr('Calculating…') }))
  if (!d.open) { d.showModal() }
  // When switching tabs fast, only the last one asked for is painted.
  const seq = openUsage.seq = (openUsage.seq || 0) + 1
  try {
    const u = await call(api.usage, conn)
    if (seq !== openUsage.seq) { return }
    const max = Math.max(1, ...u.days.map(x => x.chats))
    const bars = el('div', { class: 'u-bars' }, ...u.days.map(x => el('div', { class: 'u-bar', title: `${x.date}: ${x.chats} chats` }, el('div', { style: `height:${Math.round(x.chats / max * 100)}%` }))))
    const active = u.days.filter(x => x.chats).length
    body.replaceChildren(
      el('div', { class: 'u-cards' },
        el('div', { class: 'u-card' }, el('b', { text: String(u.chats) }), el('span', { text: tr('chats in total') })),
        el('div', { class: 'u-card' }, el('b', { text: String(u.messages) }), el('span', { text: tr('messages') })),
        el('div', { class: 'u-card' }, el('b', { text: kfmt(u.input) }), el('span', { text: tr('tokens read') })),
        el('div', { class: 'u-card' }, el('b', { text: kfmt(u.output) }), el('span', { text: tr('tokens written') }))),
      el('h4', { text: tr('Chats per day (last 30 days · {0} days with use)', active) }), bars,
      el('h4', { text: tr('By model (most tokens first)'), title: modelsHow(u) }),
      el('table', { class: 'u-table' },
        el('tr', {}, el('th', { text: tr('Model') }), el('th', { text: 'Tokens' }), el('th', { text: tr('Read') }), el('th', { text: tr('Written') })),
        ...u.models.slice(0, 15).map(m => {
          const aux = tasksLine(m.tasks)
          return el('tr', {},
            el('td', { title: m.model }, modelName(m.model), aux ? el('span', { class: 'u-sub', text: tr('includes {0}', aux) }) : null),
            el('td', { text: kfmt(tokensOf(m)) }), el('td', { text: kfmt(m.input) }), el('td', { text: kfmt(m.output) }))
        })),
      ...(u.models.length > 15 ? [el('p', { class: 'muted small', text: u.models.length === 16 ? tr('And 1 more model, with fewer tokens.') : tr('And {0} more models, with fewer tokens.', u.models.length - 15) })] : []),
      el('p', { class: 'muted small', text: u.modelsFrom === 'hermes'
        ? tr("By model: the last year, from that Hermes's statistics (summarizing memory, writing titles… count too). Everything else, from your chats stored there. Nothing leaves your network.")
        : tr('Worked out from your chats stored in that Hermes; nothing leaves your network.') }))
  } catch (e) {
    if (seq === openUsage.seq) { body.replaceChildren(el('p', { class: 'error', text: tr("Couldn't work it out: {0}", e.message) })) }
  }
}

// ── Updates ──────────────────────────────────────────────────────────────────────────────────
// The new version there is (if any): the chat's bar and Settings → About show the same button.
let pendingVersion = null
let updating = false

/** The two buttons (the bar's and the one in Settings): both say "Downloading…" while it installs. */
function updateButtons() {
  for (const b of document.querySelectorAll('#update-bar .btn-primary, #upd-install')) {
    b.disabled = updating
    b.textContent = updating ? tr('Downloading…') : b.id === 'upd-install' ? tr('Update to {0} and restart', pendingVersion) : tr('Update and restart')
  }
}

/** Downloads and installs the new version (from the bar or from Settings). */
async function installUpdate(onError) {
  if (updating) { return }
  updating = true
  updateButtons()
  try {
    // If nothing was installed in the end, the buttons are ready again.
    if (await call(api.updateInstall) === false) { updating = false; updateButtons() }
  } catch (err) {
    updating = false
    updateButtons()
    onError(tr("Couldn't update: {0}", err.message))
  }
}

function showUpdate(version, notes) {
  pendingVersion = version
  const b = $('#update-bar')
  b.replaceChildren(el('div', { class: 'grow' }, el('strong', { text: tr("There's a new version of Pedila ({0}). ", version) }), el('span', { class: 'muted', text: notes || '' })),
    el('button', { class: 'btn-primary', text: tr('Update and restart'), onclick: () => installUpdate(showToastLine) }))
  b.hidden = false
  updateInstallButton()
  updateButtons()
}

/** The button in Settings → About: only when there's a new version. */
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
    el('button', { class: 'btn-ghost', text: tr('Edit'), onclick: async () => {
      const name = await askBox({ title: tr('Phrase name'), value: x.name, ok: tr('Next') })
      if (!name) { return }
      const text = await askBox({ title: tr('Text of “{0}”', name), value: x.text, ok: tr('Save') })
      if (!text) { return }
      const next = list.slice(); next[i] = { name, text }
      await saveSetting({ snippets: next })
      renderSnippetSettings()
    } }),
    el('button', { class: 'btn-ghost danger', text: tr('Remove'), onclick: async () => { await saveSetting({ snippets: list.filter((_, j) => j !== i) }); renderSnippetSettings() } }))))
  if (!list.length) { box.append(el('p', { class: 'muted small', text: tr('You have no saved phrases.') })) }
}

function wireExtras() {
  document.addEventListener('click', e => { const m = $('#popup'); if (!m.hidden && !m.contains(e.target)) { closePopup() } })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePopup(); closeSnippets() } })
  $('#chat-actions').addEventListener('click', e => { const ch = currentChat(); if (ch) { const b = e.currentTarget.getBoundingClientRect(); e.stopPropagation(); openChatMenu(ch.conn, ch.sid, b.left - 150, b.bottom + 4) } })
  $('#ctx-new').addEventListener('click', () => {
    const ch = currentChat()
    const title = ch ? ch.title : ''
    newChatView()
    $('#input').value = tr("Let's go on with what we were talking about in the chat “{0}”. If you need the context, look it up in your earlier sessions.", title)
    autoGrow()
    updateComposer()
  })
  $('#ctx-hide').addEventListener('click', () => { const ch = currentChat(); if (ch) { S.ctxHidden.add(key(ch.conn, ch.sid)) } setTopbar() })
  $('#readonly-pill').addEventListener('click', () => { S.readOnly = !S.readOnly; updateExtrasPills() })
  $('#reason-pill').addEventListener('click', e => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const ch = currentChat()
    const eff = currentEffort()
    // With a chat already started there's no "default" (Hermes has no way to go back to it).
    const options = REASONING.filter(([v]) => !(ch && v === ''))
    const mark = v => (eff.own ? v === eff.value : v === '') ? '✓ ' : ''
    const items = options.map(([v, name]) => [`${mark(v)}${v ? name : tr("Hermes's default")}`, () => setReasoning(v)])
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
  for (const b of document.querySelectorAll('#panel-view button')) {
    b.addEventListener('click', () => { if (b.dataset.v !== panelView()) { saveSetting({ window: { panelView: b.dataset.v } }) } })
  }
  wireResizers()
  // When an answer ends usage is worked out again; also, every 2 minutes.
  setInterval(() => { if (panelOn()) { loadPanelUsage(S.active, true) } }, 120000)
  // The panel's clocks show seconds: they're updated every second (only their text).
  setInterval(tickPanel, 1000)
  setInterval(() => { if (panelOn()) { reconcileSubagents() } }, 10000)
  // While something in the panel is being pressed it isn't rebuilt (the click would end on a button that
  // no longer exists).
  $('#panel-body').addEventListener('pointerdown', () => { P.hold = true })
  // The same in the chat: when clicking a group of tools while Hermes writes.
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
    const name = await askBox({ title: tr("Phrase name (what you'll type after “/”)"), value: '', ok: tr('Next') })
    if (!name) { return }
    const text = await askBox({ title: tr('Text of “{0}”', name), value: '', ok: tr('Save') })
    if (!text) { return }
    await saveSetting({ snippets: [...(S.settings.snippets || []), { name, text }] })
    renderSnippetSettings()
  })
  $('#upd-save').addEventListener('click', () => saveSetting({ updates: { url: $('#upd-url').value.trim() } }))
  $('#upd-check').addEventListener('click', async () => {
    const st = $('#upd-status')
    st.textContent = tr('Looking for updates…')
    try {
      const r = await call(api.updateCheck)
      st.textContent = !r ? tr('The updates address is missing.') : r.available ? tr("There's a new version: {0}.", r.version) : tr('You have the latest ({0}).', S.version)
      if (r && r.available) { showUpdate(r.version, r.notes) }
    } catch (e) { st.textContent = tr("Couldn't check it: {0}", e.message) }
  })
  // Update from right here, without closing Settings to go to the chat's bar.
  $('#upd-install').addEventListener('click', () => installUpdate(text => { $('#upd-status').textContent = text }))
}

// ── Layout: order and visibility of everything (Settings → Layout, or dragging in place) ──────
const LAY_DEFAULT = {
  conns: ['local', 'server'], connsHidden: [],
  cards: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'],
  cardsChats: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'],
  cardsSimple: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'],
  swap: false, show: {}
}
function layout() {
  const l = S.settings && S.settings.layout
  return l && Array.isArray(l.cards) ? l : LAY_DEFAULT
}
const shown = k => layout().show[k] !== false
const CARDS = {
  ahora: { name: tr('Now'), make: () => panelNowCard(), simple: () => simpleNowCard() },
  tareas: { name: tr('Tasks'), make: () => panelTasksCard(), simple: () => simpleTasksCard() },
  chat: { name: tr('This chat'), make: () => panelChatCard(), simple: () => simpleChatCard() },
  uso: { name: tr('Usage'), make: () => panelUsageCard(), simple: () => simpleUsageCard() },
  cuotas: { name: tr("Your APIs' quotas"), make: () => panelQuotasCard(), simple: () => panelQuotasCard(true) },
  modelos: { name: tr('Most used models of your local AI'), make: () => panelLocalCard(), simple: () => simpleLocalCard() },
  conexiones: { name: tr('Connections'), make: () => panelConnsCard(), simple: () => simpleConnsCard() }
}
const SHOW_NAMES = {
  attach: tr('📎 Attach images'), model: tr('Model'), reason: tr('🧠 Effort'),
  readonly: tr('🔒 Read only'), hint: tr('“Enter to send” hint'), suggestions: tr('Suggestions in the new chat'),
  search: tr('Chat search box'), version: tr('Version number at the bottom'), usageButton: tr('📊 Your usage button')
}

async function saveLayout(patch) {
  await saveSetting({ layout: { ...layout(), ...patch } })
}

/** Applies the saved layout: side and what is hidden. */
function applyLayout() {
  const L = layout()
  $('#app').classList.toggle('swap', Boolean(L.swap))
  $('#attach-btn').hidden = !shown('attach')
  $('#model-pill').hidden = !shown('model')
  $('#reason-pill').hidden = !shown('reason')
  $('#readonly-pill').hidden = !shown('readonly')
  $('#composer-hint').hidden = !shown('hint')
  $('.suggestions').hidden = !shown('suggestions')
  $('.search-wrap').classList.toggle('lay-off', !shown('search'))
  $('#version').hidden = !shown('version')
  $('#open-usage').hidden = !shown('usageButton')
  renderConnSwitch()
  schedulePanel()
}

/**
 * Sorting by dragging (with the mouse; it doesn't use the browser's drag and drop, which doesn't get along
 * with buttons). `items`: the children that move; `handle`: where it's grabbed (or the whole child);
 * `done(ids)`: the new order, with each one's data-id.
 */
function sortable(box, { items, handle = null, horizontal = false, onStart = null, done }) {
  box.addEventListener('pointerdown', e => {
    if (e.button !== 0) { return }
    const grip = handle ? e.target.closest(handle) : e.target
    const it = grip && grip.closest(items)
    if (!it || !box.contains(it) || e.target.closest('input, select, textarea, a, .sp-link, .q-span, summary')) { return }
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
      // The click that comes right on release must not open anything (if it doesn't come, the block goes
      // away by itself).
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
      addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => removeEventListener('click', swallow, true), 250)
      done([...box.querySelectorAll(items)].map(o => o.dataset.id || o.dataset.card || o.dataset.conn))
    }
    addEventListener('pointermove', move, true)
    addEventListener('pointerup', up, true)
    addEventListener('pointercancel', up, true)
  })
}

/** Merges the visible order with the full one: the ones not seen keep their relative place. */
function mergeOrder(full, visibleOrder) {
  const vis = new Set(visibleOrder)
  const queue = visibleOrder.slice()
  return full.map(id => (vis.has(id) ? queue.shift() : id))
}

function wireLayout() {
  sortable($('#conn-switch'), { items: 'button', horizontal: true, done: ids => saveLayout({ conns: mergeOrder(layout().conns, ids) }) })
  sortable($('#panel-body'), {
    items: '.sp-card', handle: '.drag-handle',
    onStart: () => { P.dragging = true },
    done: ids => { P.dragging = false; saveLayout({ cards: mergeOrder(layout().cards, ids) }) }
  })
  addEventListener('pointerup', () => { if (P.dragging) { setTimeout(() => { P.dragging = false; schedulePanel() }, 0) } }, true)
  for (const b of document.querySelectorAll('#lay-swap button')) { b.addEventListener('click', () => saveLayout({ swap: b.dataset.v === 'true' })) }
  $('#lay-reset').addEventListener('click', async () => {
    const ok = await askBox({ title: tr('Go back to the default layout?'), text: tr('The tabs, cards and buttons go back to how they come out of the box. Nothing else changes.'), ok: tr('Yes, go back') })
    if (ok) { await saveSetting({ layout: JSON.parse(JSON.stringify({ ...LAY_DEFAULT, show: {} })) }) }
  })
}

/** A row of Settings → Layout: dragged by ⠿ or moved with ↑ ↓; on the right, its switches. */
function layRow(id, name, list, key, toggles) {
  const i = list.indexOf(id)
  const move = d => { const o = list.slice(); o.splice(i, 1); o.splice(i + d, 0, id); saveLayout({ [key]: o }) }
  return el('div', { class: 'lay-row', 'data-id': id },
    el('span', { class: 'lay-grip', text: '⠿', title: tr('Drag to move it') }),
    el('span', { class: 'lay-name', text: name }),
    el('button', { class: 'icon-mini', text: '↑', title: tr('Move up'), disabled: i <= 0, onclick: () => move(-1) }),
    el('button', { class: 'icon-mini', text: '↓', title: tr('Move down'), disabled: i >= list.length - 1, onclick: () => move(1) }),
    ...toggles.map(([label, on, fn]) => el('label', { class: 'lay-tog' }, el('input', { type: 'checkbox', checked: on, onchange: e => fn(e.target.checked) }), el('span', { text: label }))))
}

function renderLayoutSettings() {
  const L = layout()
  for (const b of document.querySelectorAll('#lay-swap button')) { b.classList.toggle('active', String(Boolean(L.swap)) === b.dataset.v) }
  const toggleIn = (key, id) => on => { const set = new Set(L[key]); if (on) { set.add(id) } else { set.delete(id) } saveLayout({ [key]: [...set] }) }
  $('#lay-conns').replaceChildren(...L.conns.map(c => layRow(c, CONN_NAMES[c], L.conns, 'conns', [[tr('Show'), !L.connsHidden.includes(c), on => toggleIn('connsHidden', c)(!on)]])))
  $('#lay-cards').replaceChildren(...L.cards.map(id => layRow(id, CARDS[id].name, L.cards, 'cards', [
    [tr('Simple'), L.cardsSimple.includes(id), toggleIn('cardsSimple', id)],
    [tr('Advanced'), L.cardsChats.includes(id), toggleIn('cardsChats', id)]
  ])))
  $('#lay-show').replaceChildren(...Object.entries(SHOW_NAMES).map(([k, name]) => el('label', { class: 'toggle' },
    el('input', { type: 'checkbox', checked: shown(k), onchange: e => saveLayout({ show: { ...L.show, [k]: e.target.checked } }) }), el('span', { text: name }))))
}

for (const [box, key] of [['#lay-conns', 'conns'], ['#lay-cards', 'cards']]) {
  sortable($(box), { items: '.lay-row', handle: '.lay-grip', done: ids => saveLayout({ [key]: ids }) })
}

// ── Active chats: a badge in the list ────────────────────────────────────────────────────────
/** "working" if Hermes is answering in that chat right now. */
function activeBadge(conn, r, running) {
  if (!running) { return null }
  return el('span', { class: 'live-badge busy', title: tr('Hermes is working in this chat') }, el('i'), tr('working'))
}

// ── Model and reasoning of a chat already started ────────────────────────────────────────────
/**
 * The effort shown on the button: { value, own }. own = chosen here for this chat (or for the new chat);
 * otherwise, value is the one it works with (the one Hermes says for that chat).
 */
function currentEffort() {
  const ch = currentChat()
  if (!ch) { return { value: S.reasoning || '', own: Boolean(S.reasoning) } }
  if (ch.reasoningSet) { return { value: ch.reasoningSet, own: true } }
  return { value: ch.effortNow || '', own: false }
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
    if (!v) { ch.effortNow = '' }
    updateExtrasPills()
    const name = v ? effortName(v) : tr('the default one')
    showNote(tr("This chat's effort: {0}{1}.", name, r && r.applied === 'next' ? tr(' (from your next message on)') : ''))
  } catch (e) { showNote(tr("Couldn't change the effort: {0}", e.message), true) }
}

/** A short notice above the writing box (the hint text comes back after 6 s). */
function showNote(text, bad = false) {
  const h = $('#composer-hint')
  h.textContent = text
  h.classList.toggle('error', bad)
  h.hidden = false
  clearTimeout(toastT)
  toastT = setTimeout(() => { h.textContent = tr('Enter to send · Shift+Enter for a new line'); h.classList.remove('error'); h.hidden = !shown('hint') }, 6000)
}

// An error in the screen stays in Pedila's log (otherwise a button that fails leaves no trace).
addEventListener('error', e => { try { api.logError && api.logError(`${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`) } catch {} })
addEventListener('unhandledrejection', e => { try { api.logError && api.logError('promise: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)) } catch {} })
