'use strict'
// Genera los iconos a partir del logo original docs/logo.svg (la sandalia alada).
// Se ejecuta con Electron: `npx electron scripts/make-icon.js`.
//   src/assets/icon.png      256×256 (app, ventana, instalador)
//   src/assets/tray.png      16×16 (bandeja) + tray@2x.png 32×32
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..')
  const svg = fs.readFileSync(path.join(root, 'docs', 'logo.svg'), 'utf8')
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<meta charset=utf-8><body></body>')
  const pngs = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}
    await img.decode()
    const out = {}
    for (const n of [256, 32, 16]) {
      const c = document.createElement('canvas')
      c.width = n
      c.height = n
      const g = c.getContext('2d')
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, n, n)
      out[n] = c.toDataURL('image/png')
    }
    return out
  })()`)
  const assets = path.join(root, 'src', 'assets')
  const save = (name, url) => fs.writeFileSync(path.join(assets, name), Buffer.from(url.split(',')[1], 'base64'))
  save('icon.png', pngs[256])
  save('tray@2x.png', pngs[32])
  save('tray.png', pngs[16])
  console.log('iconos generados desde docs/logo.svg')
  app.quit()
})
