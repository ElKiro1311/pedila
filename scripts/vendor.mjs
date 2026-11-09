// Copia las librerías de la pantalla (Markdown y su limpiador) a src/shell/vendor.
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'src', 'shell', 'vendor')
fs.mkdirSync(out, { recursive: true })
const files = [
  ['node_modules/marked/lib/marked.umd.js', 'marked.umd.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js']
]
for (const [from, to] of files) {
  const src = path.join(root, from)
  if (!fs.existsSync(src)) { throw new Error('falta ' + from) }
  fs.copyFileSync(src, path.join(out, to))
  console.log('copiado', to)
}
