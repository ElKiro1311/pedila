'use strict'
// Ajustes en %APPDATA%\Hermes Panel\settings.json. Guardado atómico (tmp + rename); al cargar se
// quitan las claves desconocidas, los valores se ajustan a su rango y un archivo ilegible se
// renombra a .broken y se usan los valores por defecto.
const fs = require('node:fs')
const path = require('node:path')

const ACCENTS = ['violeta', 'turquesa', 'ambar', 'rosa', 'azul']
const THEMES = ['system', 'dark', 'light']
const PET_SIZES = ['pequena', 'normal', 'grande']
// La mascota que trae la app (Codux, de petdex.dev); las demás se eligen del catálogo de Petdex.
const DEFAULT_PET = 'code-default'
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/

function defaults() {
  return {
    schema: 1,
    look: { theme: 'system', accent: 'violeta', textSize: 100 },
    // Direcciones del `hermes dashboard` de tu servidor (se rellenan en Ajustes → Servidor).
    server: { urls: [], enabled: true },
    local: { enabled: true },
    lastConnection: 'local',
    models: { local: null, server: null },
    notify: { enabled: true, done: true, needs: true, failed: true, minDurationSec: 10, sound: true },
    pet: { visible: true, size: 'normal', slug: DEFAULT_PET },
    window: { bounds: null, maximized: false, closeToTray: true, openAtLogin: false },
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
  const look = isObj(raw.look) ? raw.look : {}
  s.look.theme = pick(look.theme, THEMES, d.look.theme)
  s.look.accent = pick(look.accent, ACCENTS, d.look.accent)
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
  for (const k of ['enabled', 'done', 'needs', 'failed', 'sound']) { s.notify[k] = bool(n[k], d.notify[k]) }
  s.notify.minDurationSec = clampInt(n.minDurationSec, 0, 3600, d.notify.minDurationSec)
  const pet = isObj(raw.pet) ? raw.pet : {}
  s.pet.visible = bool(pet.visible, true)
  s.pet.size = pick(pet.size, PET_SIZES, 'normal')
  s.pet.slug = typeof pet.slug === 'string' && SLUG.test(pet.slug) ? pet.slug : DEFAULT_PET
  const w = isObj(raw.window) ? raw.window : {}
  const b = isObj(w.bounds) ? w.bounds : null
  s.window.bounds = b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 600 && b.height >= 420
    ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null
  s.window.maximized = bool(w.maximized, false)
  s.window.closeToTray = bool(w.closeToTray, true)
  s.window.openAtLogin = bool(w.openAtLogin, false)
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
    for (const key of ['look', 'server', 'notify', 'pet', 'window', 'models']) {
      if (isObj(partial[key])) { next[key] = { ...next[key], ...partial[key] } }
    }
    if (partial.lastConnection !== undefined) { next.lastConnection = partial.lastConnection }
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

module.exports = { Settings, sanitize, defaults, ACCENTS, THEMES, PET_SIZES, DEFAULT_PET, SLUG }
