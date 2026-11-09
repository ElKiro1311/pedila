// Modo demostración (solo en desarrollo, HERMES_PANEL_DEMO=1): datos inventados para revisar el
// diseño sin tocar ningún Hermes ni mostrar chats de verdad.
const listeners = new Set()
const emit = evt => setTimeout(() => { for (const l of listeners) { l(evt) } }, 0)
const ok = value => Promise.resolve({ ok: true, value })
const now = Date.now()
let settings = {
  schema: 1,
  look: { theme: 'system', accent: 'violeta', textSize: 100 },
  server: { urls: ['http://192.168.1.50:9119'], enabled: true },
  local: { enabled: true },
  lastConnection: 'local',
  notify: { enabled: true, done: true, needs: true, failed: true, minDurationSec: 10, sound: true },
  pet: { visible: true, size: 'normal' },
  window: { bounds: null, maximized: false, closeToTray: true, openAtLogin: false },
  serverSignedIn: false
}
const sessions = {
  local: [
    { id: 'd1', title: 'Receta de lentejas para 4', preview: 'Te propongo una receta sencilla…', lastActive: now - 3 * 60e3, messages: 6, model: 'qwen3-32b', running: false },
    { id: 'd2', title: 'Plan de copias de seguridad', preview: 'Revisé tus discos y…', lastActive: now - 26 * 3600e3, messages: 12, model: 'qwen3-32b', running: false },
    { id: 'd3', title: 'Comparar dos monitores', preview: 'El de 240 Hz te conviene si…', lastActive: now - 4 * 86400e3, messages: 4, model: 'gemma-3-27b', running: false }
  ],
  server: []
}
const transcript = [
  { role: 'user', text: '¿Me das una receta de lentejas para 4 personas?' },
  { role: 'assistant', reasoning: 'El usuario quiere una receta sencilla. Busco una versión clásica española.', blocks: [
    { type: 'tool', name: 'web_search', args: 'receta lentejas estofadas 4 personas', done: true, summary: '5 resultados', seconds: 2.4 },
    { type: 'text', text: '¡Claro! **Lentejas estofadas** para 4:\n\n| Ingrediente | Cantidad |\n|---|---|\n| Lentejas pardinas | 400 g |\n| Chorizo | 1 |\n| Zanahoria | 2 |\n\n1. Sofríe la cebolla y el pimiento.\n2. Añade las lentejas y cubre con agua.\n3. Cuece **35 minutos** a fuego medio.\n\n```bash\n# temporizador\nsleep 2100 && echo "¡Lentejas listas!"\n```' }
  ] }
]

const DEMO_PET = { slug: 'code-default', name: 'codux', author: 'duxphp', kind: 'object', url: 'assets/pets/default/sprite.png', bundled: true }
const DEMO_CATALOG = [
  { slug: 'code-default', name: 'codux', kind: 'object', author: 'duxphp' },
  { slug: 'torty', name: 'Torty', kind: 'creature', author: 'petdex' },
  { slug: 'pan-chan', name: 'Pan-chan', kind: 'character', author: 'petdex' },
  { slug: 'you', name: 'You', kind: 'character', author: 'petdex' }
].map(p => ({ ...p, installed: p.slug === 'code-default', preview: `https://assets.petdex.dev/pets/${p.slug}/preview.webp` }))

export const demoApi = {
  init: () => ok({ version: '0.2.0', demo: true, pet: DEMO_PET, dark: matchMedia('(prefers-color-scheme: dark)').matches, settings, connections: [{ id: 'local', name: 'Este PC', state: 'ready', detail: '' }, { id: 'server', name: 'Servidor', state: 'login', detail: '' }] }),
  sessions: conn => (conn === 'server' ? Promise.resolve({ ok: false, error: 'Hay que iniciar sesión', needLogin: true }) : ok(sessions[conn])),
  transcript: (_c, sid) => ok(sid === 'd1' ? transcript : []),
  attach: () => ok({ running: false }),
  newChat: () => ok({ sid: 'd' + Math.floor(Math.random() * 1e6) }),
  send: (conn, sid, text) => {
    const steps = [
      [200, { kind: 'turn-start' }],
      [500, { kind: 'reasoning', text: 'Voy a mirar el estado del sistema antes de responder. ' }],
      [900, { kind: 'tool', phase: 'start', id: 't1', name: 'terminal', args: 'df -h /' }],
      [1600, { kind: 'prompt', key: 'l:demo', promptKind: 'approval', command: 'df -h /', description: 'Leer el espacio libre de los discos', choices: ['once', 'session', 'always', 'deny'] }]
    ]
    for (const [ms, e] of steps) { setTimeout(() => emit({ conn, sid, ...e }), ms) }
    demoApi._pending = { conn, sid, text }
    return ok({ status: 'streaming' })
  },
  stop: (conn, sid) => { emit({ conn, sid, kind: 'complete', text: '', outcome: 'interrupted' }); return ok({ status: 'interrupted' }) },
  answer: (conn, key) => {
    const p = demoApi._pending || {}
    emit({ conn, kind: 'prompt-done', key, sid: p.sid })
    const reply = 'Tus discos están bien: **2,1 TB libres** de 8 TB. Nada de qué preocuparse por ahora.'
    let t = 300
    setTimeout(() => emit({ conn, sid: p.sid, kind: 'tool', phase: 'complete', id: 't1', name: 'terminal', summary: 'S.ficheros Tamaño Usados Disp Uso% / 8,0T 5,9T 2,1T 74%', seconds: 0.4 }), t)
    for (const word of reply.split(/(?<= )/)) { t += 60; setTimeout(() => emit({ conn, sid: p.sid, kind: 'delta', text: word }), t) }
    setTimeout(() => emit({ conn, sid: p.sid, kind: 'usage', used: 13425, max: 98304 }), t + 50)
    setTimeout(() => emit({ conn, sid: p.sid, kind: 'complete', text: reply, outcome: 'completed', ms: 4000 }), t + 120)
    return ok({ ok: true })
  },
  models: () => ok({ current: { model: 'qwen3-32b', provider: 'casa' }, providers: [{ id: 'casa', name: 'Mi servidor', local: true, models: [{ id: 'qwen3-32b', name: 'qwen3-32b' }, { id: 'gemma-3-27b', name: 'gemma-3-27b' }] }] }),
  login: () => ok({ ok: false, error: 'En la demostración no se inicia sesión.' }),
  logout: () => ok(true),
  retry: () => ok(true),
  settings: patch => {
    if (patch) { for (const [k, v] of Object.entries(patch)) { settings[k] = typeof v === 'object' && !Array.isArray(v) ? { ...settings[k], ...v } : v } }
    return ok(settings)
  },
  viewing: () => ok(true),
  petsSearch: ({ q = '', kind = '' } = {}) => { const items = DEMO_CATALOG.filter(p => (!kind || p.kind === kind) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))); return ok({ total: items.length, all: DEMO_CATALOG.length, kinds: { character: 2, creature: 1, object: 1 }, items }) },
  petsInstalled: () => ok([DEMO_PET]),
  petUse: slug => (slug === 'code-default' ? ok(DEMO_PET) : Promise.resolve({ ok: false, error: 'En la demostración no se descargan mascotas.' })),
  archived: () => ok([]),
  search: (conn, q) => ok(sessions[conn].filter(s => s.preview.toLowerCase().includes(q.toLowerCase())).map(s => ({ id: s.id, snippet: s.preview, role: 'assistant' }))),
  mutate: (conn, sid, op, value) => {
    const list = sessions[conn]
    const i = list.findIndex(s => s.id === sid)
    if (op === 'delete' || op === 'archive') { if (i >= 0) { list.splice(i, 1) } } else if (i >= 0 && op === 'pin') { list[i].pinned = value } else if (i >= 0 && op === 'rename') { list[i].title = value }
    return ok({ ok: true })
  },
  attachImage: () => ok({ ok: true }),
  usage: () => ok({ chats: 3, messages: 22, input: 120000, output: 8000, days: Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, chats: i % 4 })), models: [{ model: 'qwen3-32b', chats: 2, input: 90000, output: 6000 }] }),
  exportChat: () => ok({ saved: false }),
  showFile: () => ok(true),
  updateCheck: () => ok({ available: false }),
  updateInstall: () => ok(true),
  openLogs: () => ok(true),
  testNotify: () => ok(true),
  onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb) }
}
