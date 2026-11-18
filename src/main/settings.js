'use strict'
// Ajustes en %APPDATA%\Pedila\settings.json. Guardado atómico (tmp + rename); al cargar se
// quitan las claves desconocidas, los valores se ajustan a su rango y un archivo ilegible se
// renombra a .broken y se usan los valores por defecto.
const fs = require('node:fs')
const path = require('node:path')

// 'tema' = el color del tema elegido; los demás lo sustituyen.
const ACCENTS = ['tema', 'oro', 'violeta', 'turquesa', 'ambar', 'rosa', 'azul']
// Paletas de color; cada una tiene modo claro y oscuro. «clasico» es la de las versiones 0.x anteriores.
const PALETTES = ['mensajera', 'clasico', 'egeo', 'anfora', 'olivo', 'claude']
// Modo: el del sistema, oscuro o claro.
const THEMES = ['system', 'dark', 'light']
const PET_SIZES = ['pequena', 'normal', 'grande']
// La mascota que trae la app: Pedila, la mensajera (dibujo propio); las demás se eligen del catálogo de Petdex.
const DEFAULT_PET = 'pedila'
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/
// Anchos que se pueden dar a la lista de chats y al panel derecho (la pantalla usa los mismos).
const SIDE_WIDTH = [240, 520]
const PANEL_WIDTH = [240, 680]

// Lo que se puede ordenar u ocultar (la pantalla usa los mismos nombres).
const LAYOUT_CONNS = ['local', 'server', 'claude']
const LAYOUT_MODES = ['chats', 'terms']
const LAYOUT_CARDS = ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones', 'consolas']
const LAYOUT_SHOW = ['attach', 'dir', 'model', 'reason', 'readonly', 'hint', 'suggestions', 'search', 'version', 'usageButton']

function defaultLayout() {
  return {
    conns: LAYOUT_CONNS.slice(),
    connsHidden: [],
    modes: LAYOUT_MODES.slice(),
    modesHidden: [],
    cards: LAYOUT_CARDS.slice(),
    cardsChats: ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones'],
    cardsTerms: ['consolas', 'cuotas', 'conexiones'],
    swap: false,
    show: Object.fromEntries(LAYOUT_SHOW.map(k => [k, true]))
  }
}

/** Una lista con solo nombres conocidos, sin repetir y, si es un orden, con todos (los que falten al final). */
function idList(v, known, complete) {
  const out = Array.isArray(v) ? [...new Set(v.filter(x => known.includes(x)))] : []
  if (complete) { for (const k of known) { if (!out.includes(k)) { out.push(k) } } }
  return out
}

function sanitizeLayout(raw) {
  const d = defaultLayout()
  if (!isObj(raw)) { return d }
  const l = {
    conns: idList(raw.conns, LAYOUT_CONNS, true),
    connsHidden: idList(raw.connsHidden, LAYOUT_CONNS, false),
    modes: idList(raw.modes, LAYOUT_MODES, true),
    modesHidden: idList(raw.modesHidden, LAYOUT_MODES, false),
    cards: idList(raw.cards, LAYOUT_CARDS, true),
    cardsChats: Array.isArray(raw.cardsChats) ? idList(raw.cardsChats, LAYOUT_CARDS, false) : d.cardsChats,
    cardsTerms: Array.isArray(raw.cardsTerms) ? idList(raw.cardsTerms, LAYOUT_CARDS, false) : d.cardsTerms,
    swap: bool(raw.swap, false),
    show: {}
  }
  // Siempre queda al menos un modo y una conexión a la vista.
  if (l.modesHidden.length >= LAYOUT_MODES.length) { l.modesHidden = [] }
  if (l.connsHidden.length >= LAYOUT_CONNS.length) { l.connsHidden = [] }
  const show = isObj(raw.show) ? raw.show : {}
  for (const k of LAYOUT_SHOW) { l.show[k] = bool(show[k], true) }
  return l
}

function defaults() {
  return {
    schema: 1,
    look: { palette: 'mensajera', theme: 'system', accent: 'tema', textSize: 100 },
    // Direcciones del `hermes dashboard` de tu servidor (se rellenan en Ajustes → Servidor).
    server: { urls: [], enabled: true },
    local: { enabled: true },
    lastConnection: 'local',
    models: { local: null, server: null, claude: null },
    notify: { enabled: true, done: true, needs: true, failed: true, minDurationSec: 10, sound: true, chime: true, badge: true },
    // Nivel de razonamiento de los chats nuevos: '' = el que tenga Hermes.
    chat: { reasoning: '' },
    // Frases rápidas que se insertan escribiendo «/» al principio.
    snippets: [
      { name: 'Resume', text: 'Resúmeme lo anterior en 5 puntos cortos.' },
      { name: 'Explica fácil', text: 'Explícamelo como si no supiera nada del tema, paso a paso.' },
      { name: 'Revisa', text: 'Revisa lo que hiciste y dime si algo puede fallar.' }
    ],
    shortcut: { enabled: true },
    // Dirección de una carpeta con version.json para buscar versiones nuevas ('' = no buscar).
    updates: { url: '', auto: true },
    pet: { visible: true, size: 'normal', slug: DEFAULT_PET },
    // sidePanel: el panel derecho con el uso y los parámetros. sideWidth / panelWidth: el ancho de la
    // lista de chats y del panel en píxeles, ajustado arrastrando su raya (null = el de siempre).
    window: { bounds: null, maximized: false, closeToTray: true, openAtLogin: false, sidePanel: true, sideWidth: null, panelWidth: null },
    // Terminales dentro de Pedila: el modo que se ve (chats de Hermes o terminales), las carpetas
    // usadas hace poco y las terminales que quedaron abiertas al salir (para ofrecer reabrirlas).
    // claudeArgs: opciones que se añaden siempre al abrir Claude Code (por ejemplo «--effort max»).
    terminals: { mode: 'chats', dirs: [], restore: [], claudeArgs: '' },
    // Diseño: orden y visibilidad de las pestañas, los modos, las tarjetas del panel (en cada modo)
    // y los botones; swap = lista de chats a la derecha y panel a la izquierda.
    layout: defaultLayout(),
    secrets: { server: null }
  }
}

const TERM_KINDS = ['claude', 'hermes', 'agy', 'shell']
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const okDir = v => typeof v === 'string' && v.length > 1 && v.length <= 400 && !/[\0\r\n]/.test(v)

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const pick = (v, list, d) => (list.includes(v) ? v : d)
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const clampInt = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)

function validUrl(u) {
  try {
    const p = new URL(u)
    return (p.protocol === 'http:' || p.protocol === 'https:') && !p.username && !p.password ? p.origin : null
  } catch { return null }
}

function sanitize(raw) {
  const d = defaults()
  if (!isObj(raw)) { return d }
  const s = d
  const look = isObj(raw.look) ? raw.look : {}
  // Ajustes de antes de la 0.5 (sin paleta): pasan al tema y la mascota nuevos, como una instalación nueva.
  const upgrade = isObj(raw.look) && look.palette === undefined
  s.look.palette = pick(look.palette, PALETTES, d.look.palette)
  s.look.theme = pick(look.theme, THEMES, d.look.theme)
  s.look.accent = upgrade ? 'tema' : pick(look.accent, ACCENTS, d.look.accent)
  s.look.textSize = clampInt(look.textSize, 80, 140, d.look.textSize)
  const server = isObj(raw.server) ? raw.server : {}
  const urls = Array.isArray(server.urls) ? server.urls.map(validUrl).filter(Boolean).slice(0, 4) : []
  s.server.urls = urls.length ? [...new Set(urls)] : d.server.urls
  s.server.enabled = bool(server.enabled, true)
  s.local.enabled = bool(isObj(raw.local) ? raw.local.enabled : undefined, true)
  s.lastConnection = pick(raw.lastConnection, ['local', 'server', 'claude'], 'local')
  const models = isObj(raw.models) ? raw.models : {}
  for (const c of ['local', 'server', 'claude']) {
    const m = models[c]
    s.models[c] = isObj(m) && typeof m.model === 'string' && m.model && m.model.length <= 200 && typeof m.provider === 'string' && m.provider.length <= 100
      ? { model: m.model, provider: m.provider, local: Boolean(m.local) } : null
  }
  const n = isObj(raw.notify) ? raw.notify : {}
  for (const k of ['enabled', 'done', 'needs', 'failed', 'sound', 'chime', 'badge']) { s.notify[k] = bool(n[k], d.notify[k]) }
  const chat = isObj(raw.chat) ? raw.chat : {}
  s.chat.reasoning = pick(chat.reasoning, ['', 'low', 'medium', 'high'], '')
  if (Array.isArray(raw.snippets)) {
    s.snippets = raw.snippets.filter(x => isObj(x) && typeof x.name === 'string' && typeof x.text === 'string' && x.name.trim() && x.text.trim())
      .slice(0, 60).map(x => ({ name: x.name.trim().slice(0, 40), text: x.text.slice(0, 4000) }))
  }
  s.shortcut.enabled = bool(isObj(raw.shortcut) ? raw.shortcut.enabled : undefined, true)
  const up = isObj(raw.updates) ? raw.updates : {}
  s.updates.url = typeof up.url === 'string' && up.url ? (validUrl(up.url) ? up.url.replace(/[/]+$/, '') : '') : ''
  s.updates.auto = bool(up.auto, true)
  s.notify.minDurationSec = clampInt(n.minDurationSec, 0, 3600, d.notify.minDurationSec)
  const pet = isObj(raw.pet) ? raw.pet : {}
  s.pet.visible = bool(pet.visible, true)
  s.pet.size = pick(pet.size, PET_SIZES, 'normal')
  s.pet.slug = typeof pet.slug === 'string' && SLUG.test(pet.slug) && !(upgrade && pet.slug === 'code-default') ? pet.slug : DEFAULT_PET
  const w = isObj(raw.window) ? raw.window : {}
  const b = isObj(w.bounds) ? w.bounds : null
  s.window.bounds = b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 600 && b.height >= 420
    ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null
  s.window.maximized = bool(w.maximized, false)
  s.window.closeToTray = bool(w.closeToTray, true)
  s.window.openAtLogin = bool(w.openAtLogin, false)
  s.window.sidePanel = bool(w.sidePanel, true)
  s.window.sideWidth = clampInt(w.sideWidth, SIDE_WIDTH[0], SIDE_WIDTH[1], null)
  s.window.panelWidth = clampInt(w.panelWidth, PANEL_WIDTH[0], PANEL_WIDTH[1], null)
  const te = isObj(raw.terminals) ? raw.terminals : {}
  s.terminals.mode = pick(te.mode, ['chats', 'terms'], 'chats')
  s.terminals.claudeArgs = typeof te.claudeArgs === 'string' && te.claudeArgs.length <= 400 && !/[\0\r\n]/.test(te.claudeArgs) ? te.claudeArgs.trim() : ''
  s.terminals.dirs = Array.isArray(te.dirs) ? [...new Set(te.dirs.filter(okDir))].slice(0, 10) : []
  s.terminals.restore = Array.isArray(te.restore)
    ? te.restore.filter(x => isObj(x) && TERM_KINDS.includes(x.kind) && okDir(x.cwd)).slice(0, 24).map(x => ({
      kind: x.kind,
      cwd: x.cwd,
      sessionId: x.kind === 'claude' && typeof x.sessionId === 'string' && SESSION_ID.test(x.sessionId) ? x.sessionId : null,
      title: typeof x.title === 'string' ? x.title.slice(0, 80) : ''
    }))
    : []
  s.layout = sanitizeLayout(raw.layout)
  const sec = isObj(raw.secrets) ? raw.secrets : {}
  s.secrets.server = typeof sec.server === 'string' && sec.server.length < 20000 ? sec.server : null
  return s
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json')
    this.data = defaults()
  }

  load() {
    try {
      this.data = sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.renameSync(this.file, this.file + '.broken') } catch {}
      }
      this.data = defaults()
    }
    return this.data
  }

  save() {
    const tmp = this.file + '.tmp'
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  /** Aplica un parche parcial de la interfaz (nunca toca `secrets`). */
  patch(partial) {
    if (!isObj(partial)) { return this.data }
    const next = JSON.parse(JSON.stringify(this.data))
    for (const key of ['look', 'server', 'notify', 'pet', 'window', 'models', 'chat', 'shortcut', 'updates', 'terminals', 'layout']) {
      if (isObj(partial[key])) { next[key] = { ...next[key], ...partial[key] } }
    }
    if (partial.lastConnection !== undefined) { next.lastConnection = partial.lastConnection }
    if (Array.isArray(partial.snippets)) { next.snippets = partial.snippets }
    next.secrets = this.data.secrets
    this.data = sanitize(next)
    this.save()
    return this.data
  }

  /** Lo que la interfaz puede ver (sin secretos). */
  publicView() {
    const { secrets, ...rest } = this.data
    return { ...JSON.parse(JSON.stringify(rest)), serverSignedIn: Boolean(secrets.server) }
  }
}

module.exports = { Settings, sanitize, defaults, defaultLayout, LAYOUT_CARDS, ACCENTS, PALETTES, THEMES, PET_SIZES, DEFAULT_PET, SLUG, SIDE_WIDTH, PANEL_WIDTH }
