'use strict'
// Makes the app's icons from docs/icon.png (the master icon, made with a local AI and cropped).
// Run with Electron: `npx electron scripts/make-icon.js`.
//   src/assets/icon.png      256×256 (app, window, installer)
//   src/assets/tray.png      16×16 (tray) + tray@2x.png 32×32
// With `--from <image> [--crop x,side] [--banner <image>]` it prepares the masters first: crops the icon's rounded square
// (transparent corners) and saves the banner as JPEG; encoding again removes the metadata.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const docs = path.join(root, 'docs')
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<meta charset=utf-8><body></body>')
  const run = async (b64, fn) => win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = 'data:image/png;base64,${b64}'; await img.decode(); ${fn}
  })()`)
  const save = (file, dataUrl) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))

  const from = arg('--from')
  if (from) {
    // `--crop x,side` (in pixels of 1024) picks the square to use; the default, 74,876, removes the light frame of an
    // image that already brings its rounded square. The corners become transparent.
    const [rx, rw] = (arg('--crop') || '74,876').split(',').map(Number)
    const out = await run(fs.readFileSync(from).toString('base64'), `
      const s = img.width / 1024, x = ${rx} * s, w = ${rw} * s, n = 512, r = 118
      const c = document.createElement('canvas'); c.width = n; c.height = n
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'
      g.beginPath(); g.roundRect(0, 0, n, n, r); g.clip()
      g.drawImage(img, x, x, w, w, 0, 0, n, n)
      return c.toDataURL('image/png')`)
    save(path.join(docs, 'icon.png'), out)
    console.log('docs/icon.png ready')
  }
  const banner = arg('--banner')
  if (banner) {
    const out = await run(fs.readFileSync(banner).toString('base64'), `
      const w = 1280, h = Math.round(img.height * 1280 / img.width)
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h)
      return c.toDataURL('image/jpeg', 0.86)`)
    save(path.join(docs, 'banner.jpg'), out)
    console.log('docs/banner.jpg ready')
  }

  const pngs = await run(fs.readFileSync(path.join(docs, 'icon.png')).toString('base64'), `
    const out = {}
    for (const n of [256, 32, 16]) {
      const c = document.createElement('canvas'); c.width = n; c.height = n
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, n, n)
      out[n] = c.toDataURL('image/png')
    }
    return out`)
  const assets = path.join(root, 'src', 'assets')
  fs.mkdirSync(assets, { recursive: true })
  save(path.join(assets, 'icon.png'), pngs[256])
  save(path.join(assets, 'tray@2x.png'), pngs[32])
  save(path.join(assets, 'tray.png'), pngs[16])
  console.log('icons made from docs/icon.png')
  app.quit()
}).catch(e => { console.error(e); app.exit(1) })
