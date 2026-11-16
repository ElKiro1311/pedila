// Formatos cortos para el panel: tokens (1.2K, 1.09M…) y horas («3:41 p. m.», «hace 25 min»).
// Sin dependencias, para que las pruebas lo puedan cargar tal cual.

const UNITS = ['', 'K', 'M', 'B']

/** Redondeo decimal sin los errores de coma flotante de `x * 100` (1.005 → 1.01). */
function round(v, d) {
  return d ? Number(Math.round(Number(v + 'e' + d)) + 'e-' + d) : Math.round(v)
}

/**
 * Tokens en corto, con 3 cifras como mucho y sin ceros de sobra:
 * 950 · 1.2K · 12.3K · 123K · 1M · 1.09M · 43.2M · 1.5B. Al pasar de 999.5 se sube de unidad
 * (nunca «1000K»). La B es la de los modelos («27B»): mil millones.
 */
export function kfmt(n) {
  n = Number(n)
  if (!Number.isFinite(n) || n === 0) { return '0' }
  if (n < 0) { return '-' + kfmt(-n) }
  let u = 0
  let v = n
  while (v >= 1000 && u < UNITS.length - 1) { v /= 1000; u++ }
  let d = u === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0
  let r = round(v, d)
  if (r >= 1000 && u < UNITS.length - 1) { v = r / 1000; u++; d = 2; r = round(v, d) }
  const s = r.toFixed(d)
  return (s.includes('.') ? s.replace(/\.?0+$/, '') : s) + UNITS[u]
}

// ── Modelos ──────────────────────────────────────────────────────────────────────────────────

/** Tokens de un modelo del resumen de uso: leídos + escritos. */
export function tokensOf(m) {
  return (Number(m && m.input) || 0) + (Number(m && m.output) || 0)
}

/**
 * El nombre de un modelo para enseñarlo. Algunos servidores (llama.cpp) contestan con la ruta del
 * archivo y Hermes la guarda tal cual: «/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf» se enseña como
 * «Qwen3-VL-8B-Instruct-Q4_K_M». Los nombres con proveedor («deepseek/deepseek-v4.1») no se tocan.
 */
export function modelName(model) {
  const s = String(model || '')
  const f = s.match(/[\\/]([^\\/]+)\.(?:gguf|ggml|bin|safetensors)$/i)
  return f ? f[1] : s
}

// Las tareas auxiliares de Hermes 0.23 que guarda en session_model_usage: las de auxiliary.* en su
// config.yaml y las que registran su repaso en segundo plano, /btw, los objetivos y los plugins.
const TASKS = {
  compression: 'resumir la memoria',
  title_generation: 'poner títulos',
  vision: 'ver imágenes',
  image_generation: 'crear imágenes',
  approval: 'aprobar órdenes',
  background_review: 'repasar memoria y skills',
  side_question: 'preguntas al margen (/btw)',
  plugin_side_question: 'preguntas de plugins',
  goal_judge: 'comprobar objetivos',
  review: 'revisiones',
  mcp: 'herramientas MCP',
  memory_query_rewrite: 'buscar en la memoria',
  curator: 'ordenar skills',
  tts_audio_tags: 'voz',
  voice_chat: 'voz',
  group_router: 'chats de grupo',
  triage_specifier: 'kanban',
  kanban_decomposer: 'kanban',
  kanban_estimator: 'kanban',
  profile_describer: 'describir perfiles',
  other: 'otras'
}

/**
 * Una tarea auxiliar de Hermes en palabras: «compression» → «resumir la memoria». Las de plugins
 * llevan su nombre tras «:» («plugin_side_question:<plugin>»); se traducen por la parte de delante.
 */
export function taskName(task) {
  const t = String(task || '')
  const key = t.split(':')[0]
  return Object.hasOwn(TASKS, key) ? TASKS[key] : t.replace(/_/g, ' ') || 'otras'
}

/** Lo que un modelo gastó en tareas auxiliares: «resumir la memoria 1.86M · poner títulos 2.3K». */
export function tasksLine(tasks) {
  const by = new Map()
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const name = taskName(t && t.task)
    by.set(name, (by.get(name) || 0) + (Number(t && t.tokens) || 0))
  }
  return [...by].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${kfmt(n)}`).join(' · ')
}

// ── Horas ────────────────────────────────────────────────────────────────────────────────────
// 12 o 24 horas como el reloj de Windows (el proceso principal lo lee del sistema al arrancar).
let hour12 = false
let timeFmt = null
let fullFmt = null
export function setHour12(v) { hour12 = Boolean(v); timeFmt = null; fullFmt = null }

const MIN = 60000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function startOfDay(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Solo la hora: «3:41 p. m.» o «15:41». */
export function hhmm(ms) {
  timeFmt = timeFmt || new Intl.DateTimeFormat('es', { hour: 'numeric', minute: '2-digit', hour12 })
  return timeFmt.format(new Date(ms))
}

/** Fecha y hora enteras, para los textos de ayuda: «15 nov 2026, 3:41 p. m.». */
export function full(ms) {
  fullFmt = fullFmt || new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', hour12 })
  return fullFmt.format(new Date(ms))
}

/** El día, si no es hoy: '' (hoy), «ayer», «lun» (esta semana), «12 nov» o «12 nov 2025». */
export function dayLabel(ms, now = Date.now()) {
  const today = startOfDay(now)
  const day = startOfDay(ms)
  if (day === today) { return '' }
  // Medio día de margen: con el cambio de hora un día dura 23 o 25 horas.
  if (day === startOfDay(today - DAY / 2)) { return 'ayer' }
  if (day > today - 6.5 * DAY && day < today) { return new Intl.DateTimeFormat('es', { weekday: 'short' }).format(new Date(ms)).replace(/\.$/, '') }
  const opts = { day: 'numeric', month: 'short' }
  if (new Date(ms).getFullYear() !== new Date(now).getFullYear()) { opts.year = 'numeric' }
  return new Intl.DateTimeFormat('es', opts).format(new Date(ms)).replace(/\./g, '')
}

/** La hora, con el día si no es hoy: «3:41 p. m.», «ayer, 11:20 p. m.», «lun, 9:05», «12 nov, 9:05». */
export function clock(ms, now = Date.now()) {
  const d = dayLabel(ms, now)
  return d ? `${d}, ${hhmm(ms)}` : hhmm(ms)
}

/** Un rato en corto: «40 s», «25 min», «1 h 53 min», «3 días». */
export function span(msLen) {
  const s = Math.max(0, Math.floor(msLen / 1000))
  if (s < 60) { return `${s} s` }
  const m = Math.floor(s / 60)
  if (m < 60) { return `${m} min` }
  const h = Math.floor(m / 60)
  if (h < 24) { return m % 60 ? `${h} h ${m % 60} min` : `${h} h` }
  const d = Math.floor(h / 24)
  return d === 1 ? '1 día' : `${d} días`
}

/** Cuánto hace: «hace un momento» (menos de un minuto, o un reloj algo adelantado), «hace 25 min»… */
export function ago(ms, now = Date.now()) {
  const diff = now - ms
  return diff < MIN ? 'hace un momento' : `hace ${span(diff)}`
}
