// Descarga la mascota predeterminada desde Petdex (petdex.dev) a src/assets/pets/default/.
// El arte es de sus autores y no se guarda en el repositorio: se baja al preparar la app.
//   node scripts/fetch-pet.mjs                 # Codux (slug code-default)
//   node scripts/fetch-pet.mjs <slug> --force  # otra mascota, o volver a bajarla
import fs from 'node:fs'
import path from 'node:path'

const MANIFEST = 'https://petdex.dev/api/manifest'
const args = process.argv.slice(2)
const force = args.includes('--force')
const slug = args.find(a => !a.startsWith('--')) || 'code-default'
const out = path.resolve(import.meta.dirname, '..', 'src', 'assets', 'pets', 'default')
const metaFile = path.join(out, 'pet.json')

if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(slug)) { throw new Error('slug no válido') }
if (!force && fs.existsSync(metaFile)) {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  if (meta.slug === slug && fs.existsSync(path.join(out, meta.spritesheetPath || ''))) {
    console.log(`mascota predeterminada ya presente: ${meta.displayName} (${slug})`)
    process.exit(0)
  }
}

const res = await fetch(MANIFEST, { headers: { 'User-Agent': 'hermes-panel-petdex' }, signal: AbortSignal.timeout(60000) })
if (!res.ok) { throw new Error(`Petdex respondió ${res.status}`) }
const manifest = await res.json()
const entry = (manifest.pets || []).find(p => p.slug === slug)
if (!entry) { throw new Error(`«${slug}» no está en el catálogo de Petdex`) }
const url = new URL(entry.spritesheetUrl)
if (url.protocol !== 'https:' || !(url.hostname === 'petdex.dev' || url.hostname.endsWith('.petdex.dev'))) { throw new Error('la hoja no está en petdex.dev') }
const sheet = await fetch(url, { headers: { 'User-Agent': 'hermes-panel-petdex' }, signal: AbortSignal.timeout(120000) })
if (!sheet.ok) { throw new Error(`no pude bajar la hoja (${sheet.status})`) }
const buf = Buffer.from(await sheet.arrayBuffer())
const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const isWebp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
if (!isPng && !isWebp) { throw new Error('la hoja no es PNG ni WebP') }
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const file = isPng ? 'sprite.png' : 'sprite.webp'
fs.writeFileSync(path.join(out, file), buf)
fs.writeFileSync(metaFile, JSON.stringify({
  slug,
  displayName: entry.displayName,
  kind: entry.kind,
  submittedBy: entry.submittedBy,
  spritesheetPath: file,
  source: entry.spritesheetUrl
}, null, 2) + '\n')
console.log(`mascota predeterminada: ${entry.displayName} (${slug}), ${file}, ${(buf.length / 1024).toFixed(0)} KB`)
