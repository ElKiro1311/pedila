'use strict'
// Mascotas: la que trae la app (src/assets/pets/default) y las que eliges del catálogo de Petdex
// (https://petdex.dev/api/manifest), que se guardan en %APPDATA%\Pedila\pets\<slug>\.
// Solo se descarga de petdex.dev (https), con tamaño máximo y comprobando que sea PNG o WebP.
const fs = require('node:fs')
const path = require('node:path')

const MANIFEST_URL = 'https://petdex.dev/api/manifest'
const UA = { 'User-Agent': 'pedila-petdex' }
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/
const MAX_SHEET = 15 * 1024 * 1024
const MEMORY_TTL = 60 * 60 * 1000
const DISK_TTL = 24 * 60 * 60 * 1000

function isPetdexUrl(u) {
  try {
    const x = new URL(u)
    return x.protocol === 'https:' && (x.hostname === 'petdex.dev' || x.hostname.endsWith('.petdex.dev'))
  } catch { return false }
}

function sheetType(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) { return 'png' }
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') { return 'webp' }
  return null
}

/** Quita acentos y pasa a minúsculas, para buscar «criatura» o «Pikachu» igual. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function compact(p) {
  return {
    slug: String(p.slug || ''),
    name: String(p.displayName || p.slug || ''),
    kind: String(p.kind || ''),
    author: String(p.submittedBy || ''),
    sheet: String(p.spritesheetUrl || '')
  }
}

class Pets {
  constructor({ dataDir, bundledDir, log }) {
    this.dir = path.join(dataDir, 'pets')
    this.cacheFile = path.join(dataDir, 'petdex', 'manifest.json')
    this.bundledDir = bundledDir
    this.log = log
    this.list = null
    this.loadedAt = 0
    this.pending = null
  }

  bundled() {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.bundledDir, 'pet.json'), 'utf8'))
      const file = meta.spritesheetPath || 'sprite.png'
      return { slug: meta.slug, name: meta.displayName || meta.slug, kind: meta.kind || '', author: meta.submittedBy || '', url: `assets/pets/default/${file}`, bundled: true }
    } catch {
      return null
    }
  }

  /** El catálogo: en memoria 1 h, en disco 24 h; si no hay red, vale la copia de disco aunque sea vieja. */
  async catalog(force = false) {
    if (this.list && !force && Date.now() - this.loadedAt < MEMORY_TTL) { return this.list }
    if (this.pending) { return this.pending }
    this.pending = (async () => {
      let disk = null
      try { disk = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) } catch {}
      if (!force && disk && Array.isArray(disk.pets) && Date.now() - (disk.savedAt || 0) < DISK_TTL) {
        return this.adopt(disk.pets)
      }
      try {
        const res = await fetch(MANIFEST_URL, { headers: UA, signal: AbortSignal.timeout(45000) })
        if (!res.ok) { throw new Error(`Petdex respondió ${res.status}`) }
        const json = await res.json()
        const pets = (Array.isArray(json.pets) ? json.pets : []).map(compact).filter(p => SLUG.test(p.slug) && isPetdexUrl(p.sheet))
        if (!pets.length) { throw new Error('el catálogo vino vacío') }
        fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
        fs.writeFileSync(this.cacheFile, JSON.stringify({ savedAt: Date.now(), pets }))
        this.log.info(`[mascotas] catálogo de Petdex: ${pets.length}`)
        return this.adopt(pets)
      } catch (e) {
        if (disk && Array.isArray(disk.pets)) {
          this.log.warn('[mascotas] sin red; uso el catálogo guardado:', e.message)
          return this.adopt(disk.pets)
        }
        throw new Error(`No pude abrir el catálogo de Petdex (${e.cause?.code || e.message})`)
      }
    })()
    try { return await this.pending } finally { this.pending = null }
  }

  adopt(pets) {
    this.list = pets
    this.loadedAt = Date.now()
    return pets
  }

  async search({ q = '', kind = '', offset = 0, limit = 30 } = {}) {
    const pets = await this.catalog()
    const mine = new Set(this.installed().map(p => p.slug))
    const kinds = {}
    for (const p of pets) { kinds[p.kind] = (kinds[p.kind] || 0) + 1 }
    const needle = fold(q).trim()
    const hits = pets.filter(p => (!kind || p.kind === kind) && (!needle || fold(p.name).includes(needle) || p.slug.includes(needle) || fold(p.author).includes(needle)))
    const start = Math.max(0, Number(offset) || 0)
    const n = Math.min(60, Math.max(1, Number(limit) || 30))
    return {
      total: hits.length,
      all: pets.length,
      kinds,
      items: hits.slice(start, start + n).map(p => ({
        slug: p.slug, name: p.name, kind: p.kind, author: p.author, installed: mine.has(p.slug),
        preview: `https://assets.petdex.dev/pets/${p.slug}/preview.webp`
      }))
    }
  }

  installed() {
    const out = []
    const b = this.bundled()
    if (b) { out.push(b) }
    let dirs = []
    try { dirs = fs.readdirSync(this.dir) } catch {}
    const extra = []
    for (const slug of dirs) {
      if (!SLUG.test(slug) || (b && slug === b.slug)) { continue }
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dir, slug, 'pet.json'), 'utf8'))
        const file = meta.spritesheetPath
        if (!/^sprite\.(png|webp)$/.test(file) || !fs.existsSync(path.join(this.dir, slug, file))) { continue }
        extra.push({ slug, name: meta.displayName || slug, kind: meta.kind || '', author: meta.submittedBy || '', url: `pets/${slug}/${file}`, installedAt: meta.installedAt || 0 })
      } catch {}
    }
    extra.sort((x, y) => y.installedAt - x.installedAt)
    return [...out, ...extra]
  }

  /** La mascota guardada con ese slug, o la que trae la app si no está. */
  resolve(slug) {
    const all = this.installed()
    return all.find(p => p.slug === slug) || all[0] || null
  }

  async install(slug) {
    if (!SLUG.test(slug)) { throw new Error('mascota no válida') }
    const have = this.installed().find(p => p.slug === slug)
    if (have) { return have }
    const entry = (await this.catalog()).find(p => p.slug === slug)
    if (!entry) { throw new Error('esa mascota ya no está en Petdex') }
    if (!isPetdexUrl(entry.sheet)) { throw new Error('la hoja de esa mascota no está en petdex.dev') }
    const res = await fetch(entry.sheet, { headers: UA, signal: AbortSignal.timeout(120000) })
    if (!res.ok) { throw new Error(`Petdex respondió ${res.status}`) }
    if (!isPetdexUrl(res.url)) { throw new Error('la descarga salió de petdex.dev') }
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MAX_SHEET) { throw new Error('la hoja es demasiado grande') }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_SHEET) { throw new Error('la hoja es demasiado grande') }
    const type = sheetType(buf)
    if (!type) { throw new Error('la hoja no es PNG ni WebP') }
    const dir = path.join(this.dir, slug)
    fs.mkdirSync(dir, { recursive: true })
    const file = `sprite.${type}`
    fs.writeFileSync(path.join(dir, file), buf)
    fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
      slug, displayName: entry.name, kind: entry.kind, submittedBy: entry.author,
      spritesheetPath: file, source: entry.sheet, installedAt: Date.now()
    }, null, 2))
    this.log.info(`[mascotas] guardada ${slug} (${(buf.length / 1024).toFixed(0)} KB)`)
    return this.installed().find(p => p.slug === slug)
  }

  /** Ruta del archivo para app://shell/pets/<slug>/<archivo>, o null si no es válida. */
  fileFor(rel) {
    const m = /^pets\/([a-z0-9][a-z0-9-]{0,100})\/(sprite\.(?:png|webp))$/.exec(rel)
    return m ? path.join(this.dir, m[1], m[2]) : null
  }
}

module.exports = { Pets, isPetdexUrl, sheetType, fold }
