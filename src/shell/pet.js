// Codux (petdex.dev): hoja de 8×9 cuadros de 192×208 con las filas de Petdex/Codex.
// El número de cuadros de cada fila se cuenta mirando la transparencia, así que vale cualquier
// mascota de Petdex con la misma geometría.
export const ROWS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']
const FW = 192
const FH = 208
const PER_FRAME = { idle: 230, waiting: 240, review: 200, running: 150, 'running-left': 120, 'running-right': 120, waving: 170, jumping: 150, failed: 190 }

const sheets = new Map()

function loadSheet(url) {
  if (!sheets.has(url)) {
    sheets.set(url, new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ img, counts: countFrames(img) })
      img.onerror = () => reject(new Error('no pude cargar la mascota'))
      img.src = url
    }))
  }
  return sheets.get(url)
}

function countFrames(img) {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const cols = Math.floor(img.width / FW)
  const rows = Math.floor(img.height / FH)
  const counts = []
  for (let r = 0; r < rows; r++) {
    let n = 0
    for (let col = 0; col < cols; col++) {
      const d = g.getImageData(col * FW, r * FH, FW, FH).data
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
    this.then = null
    this.sheet = null
    this.running = false
  }

  async load(url) {
    this.sheet = await loadSheet(url)
    this.draw()
    this.start()
  }

  /** Estado de fondo (lo que hace Hermes ahora); las animaciones de un momento vuelven a él. */
  setBase(state) {
    if (!ROWS.includes(state)) { state = 'idle' }
    this.base = state
    if (this.loops === Infinity && this.state !== state) { this.play(state) }
  }

  /** Animación de un momento (saludar, saltar, fallar) durante `loops` vueltas. */
  flash(state, loops = 2) {
    this.play(state, loops)
  }

  play(state, loops = Infinity) {
    if (!ROWS.includes(state)) { state = 'idle' }
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

  count() {
    if (!this.sheet) { return 1 }
    const row = Math.max(0, ROWS.indexOf(this.state))
    return this.sheet.counts[row] || 1
  }

  draw() {
    if (!this.sheet) { return }
    const row = Math.max(0, ROWS.indexOf(this.state))
    this.g.clearRect(0, 0, FW, FH)
    this.g.drawImage(this.sheet.img, this.frame * FW, row * FH, FW, FH, 0, 0, FW, FH)
  }
}
