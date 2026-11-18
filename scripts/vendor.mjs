// Copia las librerías de la pantalla (Markdown, su limpiador y xterm.js) a src/shell/vendor.
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'src', 'shell', 'vendor')
fs.mkdirSync(out, { recursive: true })
const files = [
  ['node_modules/marked/lib/marked.umd.js', 'marked.umd.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
  // Terminales: xterm.js y sus complementos (ajustar al tamaño y enlaces).
  ['node_modules/@xterm/xterm/lib/xterm.mjs', 'xterm.mjs'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs'],
  ['node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs', 'addon-web-links.mjs']
]
for (const [from, to] of files) {
  const src = path.join(root, from)
  if (!fs.existsSync(src)) { throw new Error('falta ' + from) }
  fs.copyFileSync(src, path.join(out, to))
  console.log('copiado', to)
}
