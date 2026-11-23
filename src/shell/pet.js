// Petdex pets: sheets of 192×208 frames.
// - Current (Codex, 8 columns × 9 rows): idle, running-right, running-left, waving, jumping, failed,
// waiting, running, review.
// - Old (9 columns × 8 rows): idle, wave, run, failed, review, jump, extra1, extra2.
// The number of frames of each row is counted by looking at the transparency; the grid is worked out from
// the sheet (gridOf).
import { tr } from './i18n.mjs'

export const STATES = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
const CODEX_ROWS = STATES
const LEGACY_ROWS = ['idle', 'wave', 'run', 'failed', 'review', 'jump', 'extra1', 'extra2']
// For each state, the row names that will do, in order of preference.
const ALIASES = {
  idle: ['idle'],
  waving: ['waving', 'wave'],
  jumping: ['jumping', 'jump'],
  running: ['running', 'run'],
  'running-right': ['running-right', 'running', 'run'],
  'running-left': ['running-left', 'running', 'run'],
  failed: ['failed'],
  waiting: ['waiting', 'idle'],
  review: ['review']
}
export const FW = 192
export const FH = 208
const PER_FRAME = { idle: 230, waiting: 240, review: 200, running: 170, 'running-left': 170, 'running-right': 170, waving: 140, jumping: 150, failed: 260 }

const sheets = new Map()

/**
 * A sheet's grid. Normally frames are 192×208 (8×9, or 8×11 with extra rows, or 9×8 in the old ones). Some
 * Petdex sheets have another frame size (1856×2272, for example): then the 8×9 or 9×8 grid whose proportion
 * is 192:208 will do, as Petdex's website does by scaling the whole sheet.
 */
export function gridOf(w, h) {
  if (w % FW === 0 && h % FH === 0 && w / FW >= 4 && h / FH >= 8) { return { fw: FW, fh: FH, cols: w / FW, rows: h / FH } }
  for (const [cols, rows] of [[8, 9], [9, 8]]) {
    const fw = w / cols
    const fh = h / rows
    if (Math.abs(fw / fh - FW / FH) < 0.03) { return { fw, fh, cols, rows } }
  }
  return null
}

/** Loads a sheet and counts its frames. Refuses the ones without Petdex's geometry. */
export function loadSheet(url) {
  if (!sheets.has(url)) {
    const p = new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const grid = gridOf(img.width, img.height)
        if (!grid) {
          reject(new Error(tr("doesn't have the Petdex format ({0}×{1})", img.width, img.height)))
          return
        }
        resolve({ img, ...grid, names: grid.rows >= 9 ? CODEX_ROWS : LEGACY_ROWS, counts: countFrames(img, grid) })
      }
      img.onerror = () => reject(new Error(tr("couldn't load the pet")))
      img.src = url
    })
    p.catch(() => sheets.delete(url))
    sheets.set(url, p)
  }
  return sheets.get(url)
}

function countFrames(img, { fw, fh, cols, rows }) {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const counts = []
  for (let r = 0; r < rows; r++) {
    let n = 0
    for (let col = 0; col < cols; col++) {
      const d = g.getImageData(Math.floor(col * fw), Math.floor(r * fh), Math.max(1, Math.floor(fw)), Math.max(1, Math.floor(fh))).data
      let filled = false
      for (let i = 3; i < d.length; i += 16) { if (d[i] > 24) { filled = true; break } }
      if (filled) { n = col + 1 }
    }
    counts.push(Math.max(1, n))
  }
  return counts
}

export class Pet {
  constructor(canvas) {
    this.canvas = canvas
    this.g = canvas.getContext('2d')
    this.state = 'idle'
    this.base = 'idle'
    this.frame = 0
    this.acc = 0
    this.last = 0
    this.loops = Infinity
    this.sheet = null
    this.running = false
  }

  /** Loads (or changes) the sheet. If it fails, it keeps the previous one and throws the error. */
  async load(url) {
    const sheet = await loadSheet(url)
    this.sheet = sheet
    this.frame = 0
    this.acc = 0
    this.draw()
    this.start()
    return sheet
  }

  /** Background state (what Hermes is doing now); momentary animations come back to it. */
  setBase(state) {
    if (!STATES.includes(state)) { state = 'idle' }
    this.base = state
    if (this.loops === Infinity && this.state !== state) { this.play(state) }
  }

  /** A momentary animation (waving, jumping, failing) for `loops` rounds. */
  flash(state, loops = 2) {
    this.play(state, loops)
  }

  play(state, loops = Infinity) {
    if (!STATES.includes(state)) { state = 'idle' }
    this.state = state
    this.frame = 0
    this.acc = 0
    this.loops = loops
  }

  start() {
    if (this.running) { return }
    this.running = true
    const tick = ts => {
      if (!this.running) { return }
      if (!this.last) { this.last = ts }
      const dt = Math.min(500, ts - this.last)
      this.last = ts
      this.acc += dt
      const per = PER_FRAME[this.state] || 180
      let changed = false
      while (this.acc >= per) {
        this.acc -= per
        this.frame++
        changed = true
        if (this.frame >= this.count()) {
          this.frame = 0
          if (this.loops !== Infinity && --this.loops <= 0) {
            this.loops = Infinity
            this.state = this.base
          }
        }
      }
      if (changed) { this.draw() }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  stop() {
    this.running = false
  }

  row() {
    if (!this.sheet) { return 0 }
    for (const name of ALIASES[this.state] || [this.state]) {
      const i = this.sheet.names.indexOf(name)
      if (i >= 0 && i < this.sheet.rows) { return i }
    }
    return 0
  }

  count() {
    return this.sheet ? this.sheet.counts[this.row()] || 1 : 1
  }

  draw() {
    if (!this.sheet) { return }
    const { img, fw, fh } = this.sheet
    this.g.clearRect(0, 0, FW, FH)
    this.g.drawImage(img, this.frame * fw, this.row() * fh, fw, fh, 0, 0, FW, FH)
  }
}
