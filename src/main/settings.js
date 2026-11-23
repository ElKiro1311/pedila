'use strict'
// Settings in %APPDATA%\Pedila\settings.json. Atomic saving (tmp + rename); on loading, unknown keys are
// removed, values are brought into their range and an unreadable file is renamed to .broken and the
// defaults are used.
const fs = require('node:fs')
const path = require('node:path')
const { tr } = require('./i18n')

// 'tema' = the chosen theme's color; the others replace it. (These names are saved in settings.json: they
// stay in Spanish.)
const ACCENTS = ['tema', 'oro', 'violeta', 'turquesa', 'ambar', 'rosa', 'azul']
// Color palettes; each one has a light and a dark mode. "clasico" is the one of the earlier 0.x versions.
const PALETTES = ['mensajera', 'clasico', 'egeo', 'anfora', 'olivo', 'claude']
// Mode: the system's, dark or light.
const THEMES = ['system', 'dark', 'light']
// 'auto' = the system's language. Settings saved before 0.16 have none: those versions were only in Spanish.
const LANGUAGES = ['auto', 'en', 'es']
const PET_SIZES = ['pequena', 'normal', 'grande']
// The pet the app brings: Pedila, the messenger (drawn for it); the others are chosen from the Petdex
// catalog.
const DEFAULT_PET = 'pedila'
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/
// Widths the chat list and the right panel can have (the screen uses the same ones).
const SIDE_WIDTH = [240, 520]
const PANEL_WIDTH = [240, 680]

// What can be ordered or hidden (the screen uses the same names).
const LAYOUT_CONNS = ['local', 'server']
const LAYOUT_CARDS = ['ahora', 'tareas', 'chat', 'uso', 'cuotas', 'modelos', 'conexiones']
const LAYOUT_SHOW = ['attach', 'model', 'reason', 'readonly', 'hint', 'suggestions', 'search', 'version', 'usageButton']

function defaultLayout() {
  return {
    conns: LAYOUT_CONNS.slice(),
    connsHidden: [],
    cards: LAYOUT_CARDS.slice(),
    // The cards that are shown (`cards` gives the order).
    cardsChats: LAYOUT_CARDS.slice(),
    swap: false,
    show: Object.fromEntries(LAYOUT_SHOW.map(k => [k, true]))
  }
}

/**
 * A list with only known names, no repeats and, if it's an order, with all of them (the missing ones at the
 * end).
 */
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
    cards: idList(raw.cards, LAYOUT_CARDS, true),
    cardsChats: Array.isArray(raw.cardsChats) ? idList(raw.cardsChats, LAYOUT_CARDS, false) : d.cardsChats,
    swap: bool(raw.swap, false),
    show: {}
  }
  // At least one connection always stays in sight.
  if (l.connsHidden.length >= LAYOUT_CONNS.length) { l.connsHidden = [] }
  const show = isObj(raw.show) ? raw.show : {}
  for (const k of LAYOUT_SHOW) { l.show[k] = bool(show[k], true) }
  return l
}

function defaults() {
  return {
    schema: 1,
    language: 'auto',
    look: { palette: 'mensajera', theme: 'system', accent: 'tema', textSize: 100 },
    // Addresses of your server's `hermes dashboard` (filled in in Settings → Server).
    server: { urls: [], enabled: true },
    local: { enabled: true },
    lastConnection: 'local',
    models: { local: null, server: null },
    notify: { enabled: true, done: true, needs: true, failed: true, minDurationSec: 10, sound: true, chime: true, badge: true },
    // Reasoning level of new chats: '' = the one Hermes has.
    chat: { reasoning: '' },
    // Quick phrases inserted by typing "/" at the beginning.
    snippets: [
      { name: tr('Summarize'), text: tr('Sum up what came before in 5 short points.') },
      { name: tr('Explain simply'), text: tr('Explain it to me as if I knew nothing about it, step by step.') },
      { name: tr('Review'), text: tr('Go over what you did and tell me whether anything could fail.') }
    ],
    shortcut: { enabled: true },
    // Address of a folder with version.json to look for new versions ('' = don't look).
    // autoInstall: install them by itself when Pedila has been unused for 10 min (and Hermes isn't
    // working).
    updates: { url: '', auto: true, autoInstall: true },
    // Hermes: update it by itself (the installations Hermes knows how to update) after 10 min unused.
    hermes: { autoUpdate: true },
    pet: { visible: true, size: 'normal', slug: DEFAULT_PET },
    // sidePanel: the right panel with usage and parameters. sideWidth / panelWidth: the width of the chat
    // list and of the panel in pixels, adjusted by dragging their line (null = the default).
    window: { bounds: null, maximized: false, closeToTray: true, openAtLogin: false, sidePanel: true, sideWidth: null, panelWidth: null },
    // Layout: order and visibility of the tabs, the panel's cards and the buttons; swap = chat list on the
    // right and panel on the left.
    layout: defaultLayout(),
    secrets: { server: null }
  }
}

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
  s.language = pick(raw.language, LANGUAGES, raw.language === undefined ? 'es' : 'auto')
  const look = isObj(raw.look) ? raw.look : {}
  // Settings from before 0.5 (without a palette): they move to the new theme and pet, like a new
  // installation.
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
  s.lastConnection = pick(raw.lastConnection, ['local', 'server'], 'local')
  const models = isObj(raw.models) ? raw.models : {}
  for (const c of ['local', 'server']) {
    const m = models[c]
    s.models[c] = isObj(m) && typeof m.model === 'string' && m.model && m.model.length <= 200 && typeof m.provider === 'string' && m.provider.length <= 100
      ? { model: m.model, provider: m.provider, local: Boolean(m.local) } : null
  }
  const n = isObj(raw.notify) ? raw.notify : {}
  for (const k of ['enabled', 'done', 'needs', 'failed', 'sound', 'chime', 'badge']) { s.notify[k] = bool(n[k], d.notify[k]) }
  const chat = isObj(raw.chat) ? raw.chat : {}
  // The same levels the 🧠 button offers (Hermes takes them all).
  s.chat.reasoning = pick(chat.reasoning, ['', 'low', 'medium', 'high', 'xhigh', 'max'], '')
  if (Array.isArray(raw.snippets)) {
    s.snippets = raw.snippets.filter(x => isObj(x) && typeof x.name === 'string' && typeof x.text === 'string' && x.name.trim() && x.text.trim())
      .slice(0, 60).map(x => ({ name: x.name.trim().slice(0, 40), text: x.text.slice(0, 4000) }))
  }
  s.shortcut.enabled = bool(isObj(raw.shortcut) ? raw.shortcut.enabled : undefined, true)
  const up = isObj(raw.updates) ? raw.updates : {}
  s.updates.url = typeof up.url === 'string' && up.url ? (validUrl(up.url) ? up.url.replace(/[/]+$/, '') : '') : ''
  s.updates.auto = bool(up.auto, true)
  s.updates.autoInstall = bool(up.autoInstall, true)
  s.hermes.autoUpdate = bool(isObj(raw.hermes) ? raw.hermes.autoUpdate : undefined, true)
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
      // Without the BOM some editors add (Notepad, PowerShell 5): otherwise the settings would be lost.
      this.data = sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')))
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

  /** Applies a partial patch from the interface (never touches `secrets`). */
  patch(partial) {
    if (!isObj(partial)) { return this.data }
    const next = JSON.parse(JSON.stringify(this.data))
    for (const key of ['look', 'server', 'notify', 'pet', 'window', 'models', 'chat', 'shortcut', 'updates', 'hermes', 'layout']) {
      if (isObj(partial[key])) { next[key] = { ...next[key], ...partial[key] } }
    }
    if (partial.lastConnection !== undefined) { next.lastConnection = partial.lastConnection }
    if (partial.language !== undefined) { next.language = partial.language }
    if (Array.isArray(partial.snippets)) { next.snippets = partial.snippets }
    next.secrets = this.data.secrets
    this.data = sanitize(next)
    this.save()
    return this.data
  }

  /** What the interface can see (no secrets). */
  publicView() {
    const { secrets, ...rest } = this.data
    return { ...JSON.parse(JSON.stringify(rest)), serverSignedIn: Boolean(secrets.server) }
  }
}

module.exports = { Settings, sanitize, defaults, defaultLayout, LAYOUT_CARDS, ACCENTS, PALETTES, THEMES, LANGUAGES, PET_SIZES, DEFAULT_PET, SLUG, SIDE_WIDTH, PANEL_WIDTH }
