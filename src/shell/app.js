// Hermes Panel: la pantalla. Sin Node; habla con el proceso principal por window.hp (preload).
import { Pet, loadSheet } from './pet.js'

const demo = new URLSearchParams(location.search).get('demo') === '1'
const api = demo ? (await import('./demo.js')).demoApi : window.hp
const $ = sel => document.querySelector(sel)
const PET_URL = 'assets/pets/default/sprite.png'
const CONN_NAMES = { local: 'Este PC', server: 'Servidor' }
const CHOICE_LABELS = { once: 'Permitir una vez', session: 'Permitir en este chat', always: 'Permitir siempre', deny: 'Denegar' }

// ── Estado ───────────────────────────────────────────────────────────────────────────────────
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
  search: ''
}

const key = (conn, sid) => `${conn}|${sid}`

function chat(conn, sid) {
  const k = key(conn, sid)
  if (!S.chats.has(k)) {
    S.chats.set(k, { conn, sid, title: '', transcript: [], loaded: false, live: null, running: false, prompts: new Map(), model: '', usage: null })
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

function md(text) {
  const html = window.marked.parse(String(text || ''), { gfm: true, breaks: true })
  return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] })
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

function kfmt(n) {
  if (!n) { return '0' }
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(n)
}

// ── Aspecto ──────────────────────────────────────────────────────────────────────────────────
function applyLook() {
  const L = S.settings.look
  const mode = L.theme === 'system' ? (S.dark ? 'dark' : 'light') : L.theme
  document.documentElement.dataset.mode = mode
  document.documentElement.dataset.accent = L.accent
  document.documentElement.style.setProperty('--scale', String(L.textSize / 100))
  $('#pet-stage').hidden = !S.settings.pet.visible
  $('#pet').className = S.settings.pet.size === 'normal' ? '' : S.settings.pet.size
}

// ── Conexiones ───────────────────────────────────────────────────────────────────────────────
function renderConnSwitch() {
  for (const b of document.querySelectorAll('#conn-switch button')) {
    const c = b.dataset.conn
    b.classList.toggle('active', c === S.active)
    const dot = b.querySelector('.dot')
    dot.className = 'dot ' + S.conns[c].state
    b.title = connLabel(c)
  }
}

function connLabel(c) {
  const st = S.conns[c]
  const what = { ready: 'conectado', connecting: 'conectando…', offline: 'sin conexión', login: 'falta iniciar sesión', setup: 'falta su dirección', error: 'error', off: 'apagado' }[st.state] || st.state
  return `${CONN_NAMES[c]}: ${what}${st.detail && st.state !== 'ready' ? ' — ' + st.detail : ''}`
}

function renderBanner() {
  const b = $('#banner')
  const st = S.conns[S.active]
  b.className = ''
  b.replaceChildren()
  if (st.state === 'login') {
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
    }
  } catch (e) {
    S.listError[conn] = e.needLogin ? 'login' : S.conns[conn].state === 'setup' ? 'setup' : e.message
  }
  S.listLoaded[conn] = true
  if (conn === S.active) { renderList() }
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
  if (!rows.length) {
    nav.append(el('div', { class: 'list-empty', text: q ? 'Ningún chat coincide.' : 'Todavía no hay chats aquí. Escribe algo para empezar.' }))
    return
  }
  let group = null
  for (const r of rows) {
    const g = groupOf(r.ms)
    if (g !== group) { group = g; nav.append(el('div', { class: 'group-label', text: g })) }
    const ch = chat(conn, r.id)
    const running = ch.running || (ch.live && !ch.live.done)
    const row = el('button', { class: 'chat-row' + (S.current.conn === conn && S.current.sid === r.id ? ' active' : ''), title: r.title },
      el('div', { class: 't' }, running ? el('span', { class: 'run' }) : null, el('span', { text: r.title })),
      r.preview ? el('div', { class: 'p', text: r.preview }) : null)
    row.addEventListener('click', () => openChat(conn, r.id))
    nav.append(row)
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────────────────────
function setTopbar() {
  const ch = currentChat()
  $('#chat-title').textContent = ch ? (ch.title || 'Chat') : 'Nuevo chat'
  const bits = [CONN_NAMES[S.current.conn]]
  if (ch && ch.model) { bits.push(ch.model) }
  if (ch && ch.usage && ch.usage.used && ch.usage.max) { bits.push(`contexto ${kfmt(ch.usage.used)} / ${kfmt(ch.usage.max)}`) }
  $('#chat-meta').textContent = bits.join(' · ')
  document.title = ch && ch.title ? `${ch.title} · Hermes Panel` : 'Hermes Panel'
}

function newChatView() {
  S.current = { conn: S.active, sid: null }
  call(api.viewing, S.active, null, '').catch(() => {})
  setTopbar()
  renderChat()
  renderList()
  updateComposer()
  updateModelPill()
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
    const turns = await call(api.transcript, conn, sid)
    ch.transcript = turns
    ch.loaded = true
  } catch (e) {
    ch.loaded = true
    ch.loadError = e.message
  }
  if (S.current.sid === sid) { renderChat(true) }
  const row = S.sessions[conn].find(r => r.id === sid)
  if (row && row.model && !ch.model) { ch.model = row.model; setTopbar() }
  // Si el chat está cargado en el gateway (quizá respondiendo desde Hermes Desktop), me engancho
  // para recibir sus eventos en vivo y sus permisos pendientes.
  if ((row && row.active) || ch.running || (ch.live && !ch.live.done)) {
    call(api.attach, conn, sid).then(r => { ch.running = r.running; if (!r.running && ch.live && ch.live.done) { ch.live = null } updateComposer(); renderList() }).catch(() => {})
  }
  $('#input').focus()
}

let liveRaf = 0
function scheduleLive() {
  if (liveRaf) { return }
  liveRaf = requestAnimationFrame(() => { liveRaf = 0; renderLiveOnly() })
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
  const ch = currentChat()
  const msgs = $('#messages')
  msgs.replaceChildren()
  const empty = !ch || (ch.loaded && !ch.transcript.length && !ch.live && !ch.loadError)
  $('#welcome').hidden = !(empty || !ch)
  $('#welcome-where').textContent = `Vas a hablar con el Hermes de ${S.current.conn === 'server' ? 'tu servidor' : 'este PC'}.`
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
  if (!old || !ch.live) { renderChat(stick); return }
  old.replaceWith(renderLiveTurn(ch))
  if (stick) { toBottom() }
}

function whoRow() {
  return el('div', { class: 'who' }, el('img', { src: 'assets/tray@2x.png', alt: '' }), el('span', { text: 'Hermes' }))
}

function renderBlocks(blocks) {
  const out = []
  for (const b of blocks) {
    if (b.type === 'text') {
      const d = el('div', { class: 'md' })
      d.innerHTML = md(b.text)
      decorate(d)
      out.push(d)
    } else if (b.type === 'tool') {
      out.push(renderTool(b))
    }
  }
  return out
}

function renderTool(b) {
  const st = b.done ? el('span', { class: 'st ok', text: b.seconds ? `✓ ${b.seconds.toFixed(1)} s` : '✓' }) : el('span', { class: 'st' }, el('span', { class: 'spin' }), b.percent ? ` ${b.percent} %` : '')
  const body = el('div', { class: 'body', hidden: true, text: b.summary || b.message || (b.done ? 'Sin resumen.' : 'En marcha…') })
  const head = el('div', { class: 'head' }, el('span', { text: '🔧' }), el('span', { class: 'name', text: b.name || 'herramienta' }), el('span', { class: 'args', text: b.args || '' }), st)
  head.addEventListener('click', () => { body.hidden = !body.hidden })
  return el('div', { class: 'tool' }, head, body)
}

function renderReasoning(text, live) {
  if (!text) { return null }
  const d = el('details', { class: 'reasoning' }, el('summary', { text: live ? 'Razonando…' : 'Razonamiento' }), el('div', { class: 'rtext', text }))
  return d
}

function renderTurn(t) {
  if (t.role === 'user') { return el('div', { class: 'msg user' }, el('div', { class: 'bubble', text: t.text })) }
  return el('div', { class: 'msg assistant' }, whoRow(), renderReasoning(t.reasoning, false), renderBlocks(t.blocks))
}

function renderLiveTurn(ch) {
  const L = ch.live
  const node = el('div', { class: 'msg assistant', id: 'live-turn' }, whoRow(), renderReasoning(L.reasoning, !L.done), renderBlocks(L.blocks))
  if (!L.done) {
    const status = L.status || (L.blocks.length ? 'Escribiendo' : 'Pensando')
    node.append(el('div', { class: 'status-line' }, el('span', { class: 'spin' }), el('span', { class: 'dots', text: status })))
  }
  if (L.error) { node.append(el('div', { class: 'turn-error', text: L.error })) }
  if (L.note) { node.append(el('div', { class: 'turn-note', text: L.note })) }
  return node
}

function renderPrompt(ch, k, p) {
  if (p.promptKind === 'approval') {
    const card = el('div', { class: 'prompt-card' },
      el('h4', { text: 'Hermes te pide permiso' }),
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
    card.append(el('h4', { text: q.question || 'Hermes te pregunta' }))
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
  $('#input').placeholder = S.current.sid ? 'Escribe a Hermes…' : `Escribe a Hermes (${CONN_NAMES[S.current.conn]})…`
}

function autoGrow() {
  const t = $('#input')
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px'
}

async function onSendClick() {
  const ch = currentChat()
  const text = $('#input').value.trim()
  if (!text && busy(ch)) { return stopTurn(ch) }
  if (!text) { return }
  const conn = S.current.conn
  let sid = S.current.sid
  $('#input').value = ''
  autoGrow()
  if (!sid) {
    $('#send').disabled = true
    try {
      const choice = S.modelChoice[conn]
      const r = await call(api.newChat, conn, choice ? { model: choice.model, provider: choice.provider } : {})
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
      autoGrow()
      updateComposer()
      showToastLine(e.needLogin ? 'Falta iniciar sesión en el servidor.' : `No pude crear el chat: ${e.message}`)
      if (e.needLogin) { openLogin() }
      return
    }
  }
  const c = chat(conn, sid)
  if (c.live && c.live.done) { c.transcript.push(liveToTurn(c.live)); c.live = null }
  c.transcript.push({ role: 'user', text })
  if (!c.live) { c.live = { blocks: [], reasoning: '', status: 'Enviando', done: false, startedAt: Date.now() } }
  c.running = true
  setTopbar()
  renderList()
  renderChat(true)
  updateComposer()
  updatePet()
  try {
    const r = await call(api.send, conn, sid, text)
    if (r && r.status === 'queued' && c.live && !c.live.done && c.live.blocks.length) { c.live.note = 'Tu mensaje va en cola: Hermes lo leerá al terminar.' }
    if (c.live && c.live.status === 'Enviando') { c.live.status = 'Pensando' }
    scheduleLive()
  } catch (e) {
    if (c.live) { c.live.error = e.needLogin ? 'Falta iniciar sesión en el servidor.' : `No se pudo enviar: ${e.message}`; c.live.done = true }
    c.running = false
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

function liveToTurn(L) {
  return { role: 'assistant', blocks: L.blocks.map(b => ({ ...b, done: true })), reasoning: L.reasoning }
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
    p.disabled = true
    p.title = 'Para cambiar de modelo, empieza un chat nuevo'
    return
  }
  const conn = S.current.conn
  const choice = S.modelChoice[conn]
  const opts = S.models[conn]
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
  let showCloud = Boolean(S.modelChoice[conn] && S.modelChoice[conn].local === false)
  let filter = ''
  const pick = choice => {
    S.modelChoice[conn] = choice
    menu.hidden = true
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
      list.append(el('button', { class: S.modelChoice[conn] ? '' : 'active', text: `Predeterminado de este Hermes${cur.model ? ` (${cur.model}${cur.local ? '' : ' ☁'})` : ''}`, onclick: () => pick(null) }))
    }
    const group = (pv, cloudy) => {
      const models = pv.models.filter(m => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
      if (!models.length) { return }
      list.append(el('div', { class: 'mh', text: `${pv.name || pv.id}${cloudy ? ' · en la nube ☁' : ' · en tu red'}` }))
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
  switch (evt.kind) {
    case 'conn': {
      const prev = S.conns[evt.conn].state
      S.conns[evt.conn] = { state: evt.state, detail: evt.detail || '' }
      renderConnSwitch()
      if (evt.conn === S.active) { renderBanner() }
      if (evt.state === 'ready' && prev !== 'ready') { loadSessions(evt.conn); ensureModelDefault(evt.conn) }
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
      return
    }
    case 'sessions-changed':
      if (evt.conn === S.active) { reloadSessionsSoon(evt.conn) }
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
    default:
      break
  }
  if (!evt.sid) { return }
  const ch = chat(evt.conn, evt.sid)
  const isCur = currentChat() === ch
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
      break
    }
    case 'delta': {
      const L = ensureLive()
      const last = L.blocks[L.blocks.length - 1]
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
      if (ch.live && !ch.live.done && evt.text) { ch.live.status = evt.text.replace(/[.…]+$/, '') }
      break
    case 'tool': {
      const L = ensureLive()
      let b = L.blocks.find(x => x.type === 'tool' && x.id && x.id === evt.id)
      // «Preparando» (tool.generating) y «en marcha» (tool.start) pueden llegar con ids distintos:
      // el bloque que se estaba preparando con el mismo nombre se reutiliza.
      if (!b && evt.phase === 'start') { b = L.blocks.find(x => x.type === 'tool' && x.generating && !x.done && x.name === evt.name) }
      if (!b) {
        b = { type: 'tool', id: evt.id, name: evt.name, args: evt.args || '', done: false, generating: evt.phase === 'generating' }
        L.blocks.push(b)
        L.cut = true
      }
      if (evt.phase === 'start') { b.generating = false; if (evt.id) { b.id = evt.id } }
      if (evt.args) { b.args = evt.args }
      if (evt.name) { b.name = evt.name }
      if (evt.phase === 'progress') { b.percent = evt.percent; b.message = evt.message }
      if (evt.phase === 'complete') { b.done = true; b.summary = evt.summary; b.seconds = evt.seconds }
      L.status = evt.phase === 'complete' ? 'Pensando' : `Usando ${b.name}`
      break
    }
    case 'complete': {
      const L = ensureLive()
      if (!L.blocks.some(b => b.type === 'text') && evt.text) { L.blocks.push({ type: 'text', text: evt.text }) }
      if (!L.reasoning && evt.reasoning) { L.reasoning = evt.reasoning }
      for (const b of L.blocks) { if (b.type === 'tool') { b.done = true } }
      L.done = true
      ch.running = false
      if (evt.outcome && !['completed', 'complete'].includes(evt.outcome)) {
        L.note = evt.outcome === 'interrupted' ? 'Parado.' : `Terminó así: ${evt.outcome}`
        pet.flash(evt.outcome === 'interrupted' ? 'waving' : 'failed', 2)
      } else {
        pet.flash('jumping', 2)
      }
      reloadSessionsSoon(evt.conn)
      break
    }
    case 'running':
      ch.running = evt.running
      if (!evt.running && ch.live && !ch.live.done && ch.live.blocks.length) { ch.live.done = true }
      break
    case 'info':
      if (evt.model) { ch.model = evt.model }
      break
    case 'usage':
      ch.usage = { used: evt.used, max: evt.max }
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
    if (['prompt', 'prompt-done', 'error', 'turn-lost', 'complete'].includes(evt.kind)) { renderChat(nearBottom()) } else if (['delta', 'reasoning', 'tool', 'status', 'thinking', 'turn-start', 'segment', 'running'].includes(evt.kind)) { scheduleLive() }
    if (['info', 'usage', 'title'].includes(evt.kind)) { setTopbar() }
    updateComposer()
  }
  if (['turn-start', 'complete', 'running', 'title'].includes(evt.kind)) { renderList() }
  updatePet()
}

// ── Mascota ──────────────────────────────────────────────────────────────────────────────────
const pet = new Pet($('#pet'))
const welcomePet = new Pet($('#welcome-pet'))
const settingsPet = new Pet($('#settings-pet'))
const DEFAULT_PET = { slug: 'code-default', name: 'codux', author: 'duxphp', kind: 'object', url: PET_URL, bundled: true }
const KIND_NAMES = { character: 'personaje', creature: 'criatura', object: 'objeto' }
const petName = p => { const n = (p && p.name) || 'mascota'; return n.charAt(0).toUpperCase() + n.slice(1) }
const petBy = p => (p && p.author ? `de ${p.author} en Petdex` : 'de Petdex')

function updatePet() {
  let base = 'idle'
  const all = [...S.chats.values()]
  const relevant = all.filter(c => c.conn === S.active || c === currentChat())
  if (all.some(c => c.prompts.size)) { base = 'waiting' } else if (relevant.some(c => c.live && !c.live.done && c.live.blocks.some(b => b.type === 'tool' && !b.done))) { base = 'review' } else if (relevant.some(c => (c.live && !c.live.done) || c.running)) { base = 'running' }
  pet.setBase(base)
  const name = petName(S.pet)
  const what = { idle: `${name} está tranquilo`, waiting: 'Hermes te necesita', review: 'Hermes está usando herramientas', running: 'Hermes está trabajando' }[base]
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
  renderPetLabels()
}

async function saveSetting(patch) {
  try {
    S.settings = await call(api.settings, patch)
    applyLook()
    renderSettings()
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
  $('#test-notify').addEventListener('click', () => call(api.testNotify).catch(() => {}))
  $('#open-logs').addEventListener('click', () => call(api.openLogs).catch(() => {}))
}

// ── Arranque ─────────────────────────────────────────────────────────────────────────────────
async function start() {
  const init = await call(api.init)
  S.settings = init.settings
  S.dark = init.dark
  S.version = init.version
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
  wireSettings()
  wirePetPicker()

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
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChatView() }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings() }
    if (e.key === 'Escape') { $('#model-menu').hidden = true }
  })
  const petEl = $('#pet')
  petEl.addEventListener('click', () => pet.flash('waving', 2))
  petEl.addEventListener('mouseenter', () => { if (pet.base === 'idle') { pet.flash('waving', 1) } })

  try {
    await applyPet(init.pet || DEFAULT_PET)
  } catch {
    await applyPet(DEFAULT_PET).catch(() => {})
  }
  pet.flash('waving', 2)
  welcomePet.setBase('idle')
  welcomePet.flash('waving', 3)
  setInterval(() => { if (!$('#welcome').hidden) { welcomePet.flash('waving', 1) } }, 15000)
  await loadSessions(S.active)
  const other = S.active === 'local' ? 'server' : 'local'
  loadSessions(other)
}

start().catch(e => {
  document.body.append(el('pre', { class: 'error', text: 'No pude arrancar la pantalla: ' + e.message }))
})
