'use strict'
// La mascota propia de Pedila: la mensajera. Se ejecuta con Electron: `npx electron scripts/make-pet.js`.
//
// Con `--desde <carpeta> [--nombres a,b,…]` prepara antes los dibujos maestros: toma las poses generadas
// sobre fondo verde (ordenadas por nombre; por defecto, todas las de POSES en ese orden), quita el verde,
// recorta y las guarda en docs/mascota/<pose>.png.
// Siempre monta, desde docs/mascota, la hoja animada en src/assets/pets/pedila/sprite.webp con el
// formato de Petdex (cuadros de 192×208; 8 columnas × 9 filas: idle, running-right, running-left,
// waving, jumping, failed, waiting, running, review). Cada fila anima una o dos poses con pequeños
// movimientos (respirar, botar, inclinarse, saltar).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// La carrera es un ciclo de 4 fases: zancada, paso con la rodilla arriba, zancada, paso.
const POSES = ['quieta', 'correr-1', 'correr-2', 'correr-3', 'correr-4', 'saludo', 'salto', 'triste', 'pregunta', 'lee']
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const masters = path.join(root, 'docs', 'mascota')
  const out = path.join(root, 'src', 'assets', 'pets', 'pedila')
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<meta charset=utf-8><body></body>')
  const js = code => win.webContents.executeJavaScript(code)
  const png = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
  const save = (file, dataUrl) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))

  const desde = arg('--desde')
  if (desde) {
    const files = fs.readdirSync(desde).filter(f => /\.png$/i.test(f)).sort()
    const nombres = arg('--nombres') ? arg('--nombres').split(',') : POSES
    if (nombres.some(n => !POSES.includes(n))) { throw new Error('pose desconocida en --nombres') }
    if (files.length !== nombres.length) { throw new Error(`hacen falta ${nombres.length} imágenes en ${desde}`) }
    fs.mkdirSync(masters, { recursive: true })
    for (let k = 0; k < files.length; k++) {
      // Quita el verde: cuanto más domina el verde sobre rojo y azul, más transparente; en los bordes
      // se le resta el verde que queda (despill). Después recorta a lo que se ve y deja 480 px de alto.
      const url = await js(`(async () => {
        const i = new Image(); i.src = ${JSON.stringify(png(path.join(desde, files[k])))}; await i.decode()
        const c = document.createElement('canvas'); c.width = i.width; c.height = i.height
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(i, 0, 0)
        const im = g.getImageData(0, 0, c.width, c.height), d = im.data
        let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0
        for (let p = 0; p < d.length; p += 4) {
          const r = d[p], gr = d[p + 1], b = d[p + 2], m = Math.max(r, b), k = gr - m
          if (k > 50) { d[p + 3] = 0 } else if (k > 12) { d[p + 3] = Math.round(255 * (50 - k) / 38); d[p + 1] = m }
          if (d[p + 3] > 24) { const q = p / 4, x = q % c.width, y = (q - x) / c.width; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
        }
        g.putImageData(im, 0, 0)
        const w = x1 - x0 + 1, h = y1 - y0 + 1, s = Math.min(1, 480 / h)
        const o = document.createElement('canvas'); o.width = Math.round(w * s); o.height = Math.round(h * s)
        const og = o.getContext('2d'); og.imageSmoothingQuality = 'high'; og.drawImage(c, x0, y0, w, h, 0, 0, o.width, o.height)
        return o.toDataURL('image/png') })()`)
      save(path.join(masters, `${nombres[k]}.png`), url)
    }
    console.log('docs/mascota listo')
  }

  const srcs = Object.fromEntries(POSES.map(p => [p, png(path.join(masters, `${p}.png`))]))
  const sheet = await js(`(async () => {
    const S = ${JSON.stringify(srcs)}, FW = 192, FH = 208, COLS = 8, ROWS = 9, BASE = 202
    const img = {}
    for (const [k, v] of Object.entries(S)) { const i = new Image(); i.src = v; await i.decode(); img[k] = i }
    // Saludo: la mano levantada (arriba a la izquierda, fuera del pelo) se gira desde la muñeca para que
    // vaya y venga. Coordenadas en píxeles del dibujo maestro docs/mascota/saludo.png (286×480).
    const MANO = { x: 0, y: 60, w: 56, h: 70, px: 50, py: 122 }
    const saludoCon = ang => {
      const i = img.saludo, c = document.createElement('canvas'); c.width = i.width; c.height = i.height
      const g = c.getContext('2d'); g.drawImage(i, 0, 0); g.clearRect(MANO.x, MANO.y, MANO.w, MANO.h)
      g.save(); g.translate(MANO.px, MANO.py); g.rotate(ang * Math.PI / 180); g.translate(-MANO.px, -MANO.py)
      g.drawImage(i, MANO.x, MANO.y, MANO.w, MANO.h, MANO.x, MANO.y, MANO.w, MANO.h); g.restore()
      return c
    }
    const MANO_ANG = [4, 20, 4, -14, 4, 20, 4, -14]
    MANO_ANG.forEach((a, k) => { img['saludo-' + k] = saludoCon(a) })
    // Alto de cada pose en el cuadro, para que la chica tenga el mismo tamaño en todas (sentada o
    // corriendo ocupa menos alto que de pie). Si alguna no cabe de ancho, se reduce esa.
    const ALTO = { quieta: 186, pregunta: 186, lee: 186, saludo: 176, 'correr-1': 150, 'correr-2': 168, 'correr-3': 150, 'correr-4': 168, salto: 150, triste: 122 }
    const c = document.createElement('canvas'); c.width = FW * COLS; c.height = FH * ROWS
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'
    // Dibuja la pose en el cuadro (col, fila) apoyada en el suelo: dy sube, rot gira desde los pies,
    // sy aplasta o estira en vertical, flip la pone mirando al otro lado.
    const put = (col, row, pose, { dx = 0, dy = 0, rot = 0, sy = 1, flip = false } = {}) => {
      const i = img[pose]
      let s = (ALTO[pose] || ALTO[pose.replace(/-\\d+$/, '')]) / i.height; if (i.width * s > FW - 6) { s = (FW - 6) / i.width }; if (i.height * s > FH - 8) { s = (FH - 8) / i.height }
      const w = i.width * s, h = i.height * s * sy
      g.save(); g.beginPath(); g.rect(col * FW, row * FH, FW, FH); g.clip()
      g.translate(col * FW + FW / 2 + dx, row * FH + BASE - dy)
      g.rotate(rot * Math.PI / 180); if (flip) { g.scale(-1, 1) }
      g.drawImage(i, -w / 2, -h, w, h); g.restore()
    }
    const wave = (n, f) => Array.from({ length: 8 }, (_, k) => f(Math.sin(k / 8 * Math.PI * 2), k))
    const rows = {
      idle: wave(8, s => ['quieta', { sy: 1 + 0.012 * s, dy: 1 + s }]),
      // Dos vueltas al ciclo: en las zancadas va pegada al suelo; en el paso, con la rodilla arriba, sube un poco
      // y se corre a la derecha (su recorte es más estrecho y quedaba desplazada respecto al cuerpo).
      'running-right': wave(8, (s, k) => ['correr-' + (k % 4 + 1), { dy: k % 2 ? 3 : 0, dx: k % 2 ? 12 : 0, rot: 1.5 }]),
      'running-left': wave(8, (s, k) => ['correr-' + (k % 4 + 1), { dy: k % 2 ? 3 : 0, dx: k % 2 ? -12 : 0, rot: -1.5, flip: true }]),
      // Dos vaivenes de la mano por vuelta; el cuerpo apenas se mueve.
      waving: wave(8, (s, k) => ['saludo-' + k, { rot: 0.8 * s, dy: 1 + Math.abs(s) }]),
      jumping: [0, 14, 26, 32, 32, 26, 14, 0].map((y, k) => [k === 0 || k === 7 ? 'quieta' : 'salto', { dy: y, sy: k === 0 || k === 7 ? 0.94 : 1 }]),
      // Triste: respira hondo y despacio, hundiendo los hombros (sin temblar de lado).
      failed: wave(8, s => ['triste', { sy: 1 - 0.02 * (1 + s) / 2, dy: 0 }]),
      // Esperando: ladea un poco y da saltitos suaves, como quien pregunta.
      waiting: wave(8, s => ['pregunta', { rot: 1.2 * s, dy: 1 + Math.abs(s) * 2 }]),
      running: wave(8, (s, k) => ['correr-' + (k % 4 + 1), { dy: k % 2 ? 3 : 0, dx: k % 2 ? 12 : 0, rot: 1.5 }]),
      review: wave(8, s => ['lee', { rot: 1.2 * s, sy: 1 + 0.01 * s }])
    }
    Object.values(rows).forEach((frames, r) => frames.forEach(([pose, o], col) => put(col, r, pose, o)))
    return c.toDataURL('image/webp', 0.92) })()`)
  fs.mkdirSync(out, { recursive: true })
  save(path.join(out, 'sprite.webp'), sheet)
  fs.writeFileSync(path.join(out, 'pet.json'), JSON.stringify({
    slug: 'pedila', displayName: 'Pedila', kind: 'character', submittedBy: '', own: true, spritesheetPath: 'sprite.webp'
  }, null, 2) + '\n')
  console.log(`mascota lista: src/assets/pets/pedila/sprite.webp (${Math.round(fs.statSync(path.join(out, 'sprite.webp')).size / 1024)} KB)`)
  app.quit()
}).catch(e => { console.error(e); app.exit(1) })
