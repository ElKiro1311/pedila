'use strict'
// Genera los iconos a partir del primer cuadro de la mascota predeterminada (fila «idle»).
// Se ejecuta con Electron: `npx electron scripts/make-icon.js`.
//   src/assets/icon.png       256×256, la mascota entera (app, ventana, instalador)
//   src/assets/tray.png       16×16, la cabeza (bandeja)  + tray@2x.png 32×32
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const FW = 192
const FH = 208

function bbox(bmp, w, h, y0 = 0, y1 = h) {
  let minX = w; let minY = h; let maxX = -1; let maxY = -1
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      if (bmp[(y * w + x) * 4 + 3] > 24) {
        if (x < minX) { minX = x }
        if (x > maxX) { maxX = x }
        if (y < minY) { minY = y }
        if (y > maxY) { maxY = y }
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

function square(bmp, w, box, marginRatio) {
  const side = Math.ceil(Math.max(box.w, box.h) * (1 + marginRatio))
  const out = Buffer.alloc(side * side * 4)
  const ox = Math.floor((side - box.w) / 2)
  const oy = Math.floor((side - box.h) / 2)
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const si = ((box.y + y) * w + (box.x + x)) * 4
      const di = ((oy + y) * side + (ox + x)) * 4
      bmp.copy(out, di, si, si + 4)
    }
  }
  return nativeImage.createFromBitmap(out, { width: side, height: side })
}

app.whenReady().then(() => {
  const root = path.join(__dirname, '..')
  const assets = path.join(root, 'src', 'assets')
  // nativeImage lee PNG (no WebP): la mascota predeterminada debe ser PNG, como Codux.
  const sheet = nativeImage.createFromPath(path.join(assets, 'pets', 'default', 'sprite.png'))
  if (sheet.isEmpty()) { throw new Error('falta src/assets/pets/default/sprite.png: ejecuta antes node scripts/fetch-pet.mjs') }
  const frame = sheet.crop({ x: 0, y: 0, width: FW, height: FH })
  const bmp = frame.toBitmap()
  const body = bbox(bmp, FW, FH)
  const icon = square(bmp, FW, body, 0.12).resize({ width: 256, height: 256, quality: 'best' })
  fs.writeFileSync(path.join(assets, 'icon.png'), icon.toPNG())
  // La cabeza (la pantalla con «>_») ocupa más o menos la mitad de arriba del personaje.
  const headBottom = body.y + Math.round(body.h * 0.5)
  const head = bbox(bmp, FW, FH, body.y, headBottom)
  const headImg = square(bmp, FW, head, 0.06)
  fs.writeFileSync(path.join(assets, 'tray.png'), headImg.resize({ width: 16, height: 16, quality: 'best' }).toPNG())
  fs.writeFileSync(path.join(assets, 'tray@2x.png'), headImg.resize({ width: 32, height: 32, quality: 'best' }).toPNG())
  console.log('iconos generados: cuerpo', JSON.stringify(body), 'cabeza', JSON.stringify(head))
  app.quit()
})
