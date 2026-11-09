'use strict'
// Genera los iconos de la app desde docs/icono.png (icono maestro, generado con IA local y recortado).
// Se ejecuta con Electron: `npx electron scripts/make-icon.js`.
//   src/assets/icon.png      256×256 (app, ventana, instalador)
//   src/assets/tray.png      16×16 (bandeja) + tray@2x.png 32×32
// Con `--desde <imagen> [--banner <imagen>]` prepara antes los maestros: recorta el cuadrado redondeado
// del icono (esquinas transparentes) y guarda el banner como JPEG; volver a codificar quita los metadatos.
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

  const desde = arg('--desde')
  if (desde) {
    // El cuadrado redondeado ocupa ~70..955 de 1024: se recorta sin el marco claro y con esquinas transparentes.
    const out = await run(fs.readFileSync(desde).toString('base64'), `
      const s = img.width / 1024, x = 74 * s, w = 876 * s, n = 512, r = 118
      const c = document.createElement('canvas'); c.width = n; c.height = n
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'
      g.beginPath(); g.roundRect(0, 0, n, n, r); g.clip()
      g.drawImage(img, x, x, w, w, 0, 0, n, n)
      return c.toDataURL('image/png')`)
    save(path.join(docs, 'icono.png'), out)
    console.log('docs/icono.png listo')
  }
  const banner = arg('--banner')
  if (banner) {
    const out = await run(fs.readFileSync(banner).toString('base64'), `
      const w = 1280, h = Math.round(img.height * 1280 / img.width)
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h)
      return c.toDataURL('image/jpeg', 0.86)`)
    save(path.join(docs, 'banner.jpg'), out)
    console.log('docs/banner.jpg listo')
  }

  const pngs = await run(fs.readFileSync(path.join(docs, 'icono.png')).toString('base64'), `
    const out = {}
    for (const n of [256, 32, 16]) {
      const c = document.createElement('canvas'); c.width = n; c.height = n
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, n, n)
      out[n] = c.toDataURL('image/png')
    }
    return out`)
  const assets = path.join(root, 'src', 'assets')
  save(path.join(assets, 'icon.png'), pngs[256])
  save(path.join(assets, 'tray@2x.png'), pngs[32])
  save(path.join(assets, 'tray.png'), pngs[16])
  console.log('iconos generados desde docs/icono.png')
  app.quit()
})
