'use strict'
// Pedila's own pet: the messenger. Run with Electron: `npx electron scripts/make-pet.js`.
//
// With `--from <folder> [--names a,b,…]` it prepares the master drawings first: takes the poses made on a green
// background (sorted by name; by default, all of POSES in that order), removes the green, crops them and saves them in
// docs/pet/<pose>.png.
// It always builds, from docs/pet, the animated sheet in src/assets/pets/pedila/sprite.webp with Petdex's format (192×208
// frames; 8 columns × 9 rows: idle, running-right, running-left, waving, jumping, failed, waiting, running, review). Each
// row animates one or two poses with small movements (breathing, bouncing, leaning, jumping).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// The run is a 4-phase cycle: stride, step with the knee up, stride, step.
const POSES = ['still', 'run-1', 'run-2', 'run-3', 'run-4', 'wave', 'jump', 'sad', 'ask', 'read']
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const masters = path.join(root, 'docs', 'pet')
  const out = path.join(root, 'src', 'assets', 'pets', 'pedila')
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<meta charset=utf-8><body></body>')
  const js = code => win.webContents.executeJavaScript(code)
  const png = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
  const save = (file, dataUrl) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))

  const from = arg('--from')
  if (from) {
    const files = fs.readdirSync(from).filter(f => /\.png$/i.test(f)).sort()
    const names = arg('--names') ? arg('--names').split(',') : POSES
    if (names.some(n => !POSES.includes(n))) { throw new Error('unknown pose in --names') }
    if (files.length !== names.length) { throw new Error(`${names.length} images are needed in ${from}`) }
    fs.mkdirSync(masters, { recursive: true })
    for (let k = 0; k < files.length; k++) {
      // Removes the green: the more green dominates red and blue, the more transparent; on the edges the green that is
      // left is taken away (despill). Then it crops to what can be seen and leaves it 480 px tall.
      const url = await js(`(async () => {
        const i = new Image(); i.src = ${JSON.stringify(png(path.join(from, files[k])))}; await i.decode()
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
      save(path.join(masters, `${names[k]}.png`), url)
    }
    console.log('docs/pet ready')
  }

  const srcs = Object.fromEntries(POSES.map(p => [p, png(path.join(masters, `${p}.png`))]))
  const sheet = await js(`(async () => {
    const S = ${JSON.stringify(srcs)}, FW = 192, FH = 208, COLS = 8, ROWS = 9, BASE = 202
    const img = {}
    for (const [k, v] of Object.entries(S)) { const i = new Image(); i.src = v; await i.decode(); img[k] = i }
    // Wave: the raised hand (top left, outside the hair) is turned from the wrist so that it comes and goes. Coordinates in
    // pixels of the master drawing docs/pet/wave.png (286×480).
    const HAND = { x: 0, y: 60, w: 56, h: 70, px: 50, py: 122 }
    const waveWith = ang => {
      const i = img.wave, c = document.createElement('canvas'); c.width = i.width; c.height = i.height
      const g = c.getContext('2d'); g.drawImage(i, 0, 0); g.clearRect(HAND.x, HAND.y, HAND.w, HAND.h)
      g.save(); g.translate(HAND.px, HAND.py); g.rotate(ang * Math.PI / 180); g.translate(-HAND.px, -HAND.py)
      g.drawImage(i, HAND.x, HAND.y, HAND.w, HAND.h, HAND.x, HAND.y, HAND.w, HAND.h); g.restore()
      return c
    }
    const HAND_ANG = [4, 20, 4, -14, 4, 20, 4, -14]
    HAND_ANG.forEach((a, k) => { img['wave-' + k] = waveWith(a) })
    // Height of each pose in the frame, so that the girl has the same size in all of them (sitting or running takes less
    // height than standing). If one doesn't fit across, that one is reduced.
    const HEIGHT = { still: 186, ask: 186, read: 186, wave: 176, 'run-1': 150, 'run-2': 168, 'run-3': 150, 'run-4': 168, jump: 150, sad: 122 }
    const c = document.createElement('canvas'); c.width = FW * COLS; c.height = FH * ROWS
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'
    // Draws the pose in the frame (col, row) standing on the ground: dy raises, rot turns from the feet, sy squashes or
    // stretches vertically, flip makes it look the other way.
    const put = (col, row, pose, { dx = 0, dy = 0, rot = 0, sy = 1, flip = false } = {}) => {
      const i = img[pose]
      let s = (HEIGHT[pose] || HEIGHT[pose.replace(/-\\d+$/, '')]) / i.height; if (i.width * s > FW - 6) { s = (FW - 6) / i.width }; if (i.height * s > FH - 8) { s = (FH - 8) / i.height }
      const w = i.width * s, h = i.height * s * sy
      g.save(); g.beginPath(); g.rect(col * FW, row * FH, FW, FH); g.clip()
      g.translate(col * FW + FW / 2 + dx, row * FH + BASE - dy)
      g.rotate(rot * Math.PI / 180); if (flip) { g.scale(-1, 1) }
      g.drawImage(i, -w / 2, -h, w, h); g.restore()
    }
    const loop = (n, f) => Array.from({ length: 8 }, (_, k) => f(Math.sin(k / 8 * Math.PI * 2), k))
    const rows = {
      idle: loop(8, s => ['still', { sy: 1 + 0.012 * s, dy: 1 + s }]),
      // Two rounds of the cycle: in the strides it stays on the ground; in the step, with the knee up, it goes up a little
      // and moves to the right (its crop is narrower and it was off from the body).
      'running-right': loop(8, (s, k) => ['run-' + (k % 4 + 1), { dy: k % 2 ? 3 : 0, dx: k % 2 ? 12 : 0, rot: 1.5 }]),
      'running-left': loop(8, (s, k) => ['run-' + (k % 4 + 1), { dy: k % 2 ? 3 : 0, dx: k % 2 ? -12 : 0, rot: -1.5, flip: true }]),
      // Two swings of the hand per round; the body hardly moves.
      waving: loop(8, (s, k) => ['wave-' + k, { rot: 0.8 * s, dy: 1 + Math.abs(s) }]),
      jumping: [0, 14, 26, 32, 32, 26, 14, 0].map((y, k) => [k === 0 || k === 7 ? 'still' : 'jump', { dy: y, sy: k === 0 || k === 7 ? 0.94 : 1 }]),
      // Sad: breathes deep and slowly, sinking the shoulders (no sideways trembling).
      failed: loop(8, s => ['sad', { sy: 1 - 0.02 * (1 + s) / 2, dy: 0 }]),
      // Waiting: tilts a little and makes soft hops, like someone asking.
      waiting: loop(8, s => ['ask', { rot: 1.2 * s, dy: 1 + Math.abs(s) * 2 }]),
      running: loop(8, (s, k) => ['run-' + (k % 4 + 1), { dy: k % 2 ? 3 : 0, dx: k % 2 ? 12 : 0, rot: 1.5 }]),
      review: loop(8, s => ['read', { rot: 1.2 * s, sy: 1 + 0.01 * s }])
    }
    Object.values(rows).forEach((frames, r) => frames.forEach(([pose, o], col) => put(col, r, pose, o)))
    return c.toDataURL('image/webp', 0.92) })()`)
  fs.mkdirSync(out, { recursive: true })
  save(path.join(out, 'sprite.webp'), sheet)
  fs.writeFileSync(path.join(out, 'pet.json'), JSON.stringify({
    slug: 'pedila', displayName: 'Pedila', kind: 'character', submittedBy: '', own: true, spritesheetPath: 'sprite.webp'
  }, null, 2) + '\n')
  console.log(`pet ready: src/assets/pets/pedila/sprite.webp (${Math.round(fs.statSync(path.join(out, 'sprite.webp')).size / 1024)} KB)`)
  app.quit()
}).catch(e => { console.error(e); app.exit(1) })
