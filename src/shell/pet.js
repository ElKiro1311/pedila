// Mascotas de Petdex: hojas de cuadros de 192×208.
//  - Actual (Codex, 8 columnas × 9 filas): idle, running-right, running-left, waving, jumping,
//    failed, waiting, running, review.
//  - Antigua (9 columnas × 8 filas): idle, wave, run, failed, review, jump, extra1, extra2.
// El número de cuadros de cada fila se cuenta mirando la transparencia; la cuadrícula se deduce
// de la hoja (gridOf).
export const STATES = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
const CODEX_ROWS = STATES
const LEGACY_ROWS = ['idle', 'wave', 'run', 'failed', 'review', 'jump', 'extra1', 'extra2']
// Para cada estado, los nombres de fila que valen, por orden de preferencia.
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
const PER_FRAME = { idle: 230, waiting: 240, review: 200, running: 110, 'running-left': 110, 'running-right': 110, waving: 170, jumping: 150, failed: 190 }

const sheets = new Map()

/**
 * La cuadrícula de una hoja. Lo normal son cuadros de 192×208 (8×9, o 8×11 con filas de más, o
 * 9×8 en las antiguas). Algunas hojas de Petdex tienen otro tamaño de cuadro (1856×2272, por
 * ejemplo): entonces vale la cuadrícula de 8×9 o 9×8 cuya proporción es la de 192:208, como hace
 * la web de Petdex al escalar la hoja entera.
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

/** Carga una hoja y cuenta sus cuadros. Rechaza las que no tienen la geometría de Petdex. */
export function loadSheet(url) {
  if (!sheets.has(url)) {
    const p = new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const grid = gridOf(img.width, img.height)
        if (!grid) {
          reject(new Error(`no tiene el formato de Petdex (${img.width}×${img.height})`))
          return
        }
        resolve({ img, ...grid, names: grid.rows >= 9 ? CODEX_ROWS : LEGACY_ROWS, counts: countFrames(img, grid) })
      }
      img.onerror = () => reject(new Error('no pude cargar la mascota'))
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

  /** Carga (o cambia) la hoja. Si falla, se queda con la anterior y lanza el error. */
  async load(url) {
    const sheet = await loadSheet(url)
    this.sheet = sheet
    this.frame = 0
    this.acc = 0
    this.draw()
    this.start()
    return sheet
  }

  /** Estado de fondo (lo que hace Hermes ahora); las animaciones de un momento vuelven a él. */
  setBase(state) {
    if (!STATES.includes(state)) { state = 'idle' }
    this.base = state
    if (this.loops === Infinity && this.state !== state) { this.play(state) }
  }

  /** Animación de un momento (saludar, saltar, fallar) durante `loops` vueltas. */
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
