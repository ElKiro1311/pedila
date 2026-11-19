// Modo demostración (solo en desarrollo, PEDILA_DEMO=1): datos inventados para revisar el
// diseño sin tocar ningún Hermes ni mostrar chats de verdad.
const listeners = new Set()
const emit = evt => setTimeout(() => { for (const l of listeners) { l(evt) } }, 0)
const ok = value => Promise.resolve({ ok: true, value })
const now = Date.now()
let settings = {
  schema: 1,
  look: { palette: 'mensajera', theme: 'system', accent: 'tema', textSize: 100 },
  server: { urls: ['http://192.168.1.50:9119'], enabled: true },
  local: { enabled: true },
  lastConnection: 'local',
  notify: { enabled: true, done: true, needs: true, failed: true, minDurationSec: 10, sound: true },
  pet: { visible: true, size: 'normal', slug: 'pedila' },
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
    { type: 'tool', name: 'web_search', args: 'receta lentejas estofadas 4 personas', input: { query: 'receta lentejas estofadas 4 personas' }, done: true, summary: '5 resultados', output: '1. Lentejas estofadas de la abuela — recetasdeescandalo.com\n2. Lentejas con chorizo — directoalpaladar.com\n3. …', seconds: 2.4 },
    { type: 'tool', name: 'terminal', args: 'ls recetas/', input: { command: 'ls recetas/' }, done: true, error: true, output: "ls: no se puede acceder a 'recetas/': No existe el archivo o el directorio\n(terminó con el código 2)", seconds: 0.2 },
    { type: 'tool', name: 'write_file', args: 'recetas/lentejas.md', input: { path: 'C:\\Users\\demo\\recetas\\lentejas.md', content: '# Lentejas estofadas\n\n- 400 g de lentejas\n- 1 chorizo\n- 2 zanahorias\n' }, done: true, output: 'Escrito: 5 líneas', seconds: 0.1 },
    { type: 'tool', name: 'patch', args: 'recetas/lentejas.md', input: { path: 'C:\\Users\\demo\\recetas\\lentejas.md', old_string: '- 1 chorizo', new_string: '- 1 chorizo (o sin él, para la versión vegetal)' }, done: true, output: 'Cambio aplicado', seconds: 0.1 },
    { type: 'text', text: '¡Claro! **Lentejas estofadas** para 4:\n\n| Ingrediente | Cantidad |\n|---|---|\n| Lentejas pardinas | 400 g |\n| Chorizo | 1 |\n| Zanahoria | 2 |\n\n1. Sofríe la cebolla y el pimiento.\n2. Añade las lentejas y cubre con agua.\n3. Cuece **35 minutos** a fuego medio.\n\n```bash\n# temporizador\nsleep 2100 && echo "¡Lentejas listas!"\n```' }
  ] },
  { role: 'user', text: 'Hazme un dibujo del plato.' },
  { role: 'assistant', blocks: [
    { type: 'tool', name: 'image_generate', args: 'a steaming bowl of Spanish lentil stew', done: true, summary: 'imagen lista', seconds: 30.4 },
    { type: 'text', text: 'Aquí tienes:\n\nMEDIA:C:\\Users\\demo\\AppData\\Local\\hermes\\cache\\generated\\images\\lentejas.png\n\nUn plato de lentejas humeante.' }
  ] }
]

const DEMO_PET = { slug: 'pedila', name: 'Pedila', author: '', kind: 'character', url: 'assets/pets/pedila/sprite.webp', bundled: true, own: true }
const DEMO_CATALOG = [
  { slug: 'code-default', name: 'codux', kind: 'object', author: 'duxphp' },
  { slug: 'torty', name: 'Torty', kind: 'creature', author: 'petdex' },
  { slug: 'pan-chan', name: 'Pan-chan', kind: 'character', author: 'petdex' },
  { slug: 'you', name: 'You', kind: 'character', author: 'petdex' }
].map(p => ({ ...p, installed: false, preview: `https://assets.petdex.dev/pets/${p.slug}/preview.webp` }))

export const demoApi = {
  init: () => ok({ version: '0.2.0', demo: true, hour12: true, pet: DEMO_PET, dark: matchMedia('(prefers-color-scheme: dark)').matches, settings, connections: [{ id: 'local', name: 'Este PC', state: 'ready', detail: '' }, { id: 'server', name: 'Servidor', state: 'login', detail: '' }] }),
  sessions: conn => (conn === 'server' ? Promise.resolve({ ok: false, error: 'Hay que iniciar sesión', needLogin: true }) : ok(sessions[conn])),
  transcript: (conn, sid) => {
    // Como en Hermes: al leer un chat guardado sale también su última lista de tareas.
    if (sid === 'd1') { emit({ conn, sid, kind: 'todos', history: true, revision: 3, todos: [{ id: '1', content: 'Buscar una receta clásica de lentejas', status: 'completed' }, { id: '2', content: 'Ajustar las cantidades para 4 personas', status: 'completed' }, { id: '3', content: 'Dibujar el plato', status: 'completed' }] }) }
    return ok(sid === 'd1' ? transcript : [])
  },
  attach: () => ok({ running: false }),
  newChat: () => ok({ sid: 'd' + Math.floor(Math.random() * 1e6) }),
  send: (conn, sid, text) => {
    const plan = (a, b, c) => ({ kind: 'todos', revision: a === 'completed' ? (c === 'completed' ? 4 : 2) : 1, todos: [
      { id: '1', content: 'Mirar el espacio libre de los discos', status: a },
      { id: '2', content: 'Revisar las carpetas que más ocupan', status: b },
      { id: '2a', content: 'Copias de seguridad antiguas', status: b, parent: '2' },
      { id: '3', content: 'Resumirte cómo está todo', status: c }
    ] })
    demoApi._plan = plan
    const steps = [
      [200, { kind: 'turn-start' }],
      [350, plan('in_progress', 'pending', 'pending')],
      [500, { kind: 'reasoning', text: 'Voy a mirar el estado del sistema antes de responder. ' }],
      [700, { kind: 'subagent', phase: 'start', id: 's1', goal: 'Buscar archivos grandes en los discos', index: 0, count: 2 }],
      [750, { kind: 'subagent', phase: 'spawn_requested', id: 's2', goal: 'Comprobar las copias de seguridad', index: 1, count: 2 }],
      [800, { kind: 'subagent', phase: 'tool', id: 's1', goal: 'Buscar archivos grandes en los discos', index: 0, count: 2, tool: 'terminal', tools: 2 }],
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
    const plan = demoApi._plan
    if (plan) {
      setTimeout(() => emit({ conn, sid: p.sid, ...plan('completed', 'in_progress', 'pending') }), t + 20)
      setTimeout(() => emit({ conn, sid: p.sid, kind: 'subagent', phase: 'complete', id: 's1', goal: 'Buscar archivos grandes en los discos', index: 0, count: 2, status: 'completed', tools: 3, seconds: 4.2 }), t + 40)
      setTimeout(() => emit({ conn, sid: p.sid, kind: 'subagent', phase: 'start', id: 's2', goal: 'Comprobar las copias de seguridad', index: 1, count: 2 }), t + 60)
      setTimeout(() => emit({ conn, sid: p.sid, kind: 'subagent', phase: 'complete', id: 's2', goal: 'Comprobar las copias de seguridad', index: 1, count: 2, status: 'completed', tools: 1, seconds: 1.5 }), t + 900)
      setTimeout(() => emit({ conn, sid: p.sid, ...plan('completed', 'completed', 'completed') }), t + 950)
      t += 1000
    }
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
  petUse: slug => (slug === 'pedila' ? ok(DEMO_PET) : Promise.resolve({ ok: false, error: 'En la demostración no se descargan mascotas.' })),
  archived: () => ok([]),
  search: (conn, q) => ok(sessions[conn].filter(s => s.preview.toLowerCase().includes(q.toLowerCase())).map(s => ({ id: s.id, snippet: s.preview, role: 'assistant' }))),
  mutate: (conn, sid, op, value) => {
    const list = sessions[conn]
    const i = list.findIndex(s => s.id === sid)
    if (op === 'delete' || op === 'archive') { if (i >= 0) { list.splice(i, 1) } } else if (i >= 0 && op === 'pin') { list[i].pinned = value } else if (i >= 0 && op === 'rename') { list[i].title = value }
    return ok({ ok: true })
  },
  attachImage: () => ok({ ok: true }),
  subagents: () => ok(null),
  // Cuotas de ejemplo: «Este PC» con el complemento puesto (OpenRouter y OpenCode Go); el servidor sin él.
  quotas: conn => ok(conn === 'local'
    ? { state: 'ok', paid: ['openrouter', 'opencode-go'], data: { version: '1.0.0', fetchedAt: new Date(now - 40e3).toISOString(), providers: [
      { kind: 'openrouter', name: 'OpenRouter', ok: true, error: '', noApi: false, balance: 7.42, creditsTotal: 10, creditsUsed: 2.58, freeTier: false, keyLimit: { limit: 5, remaining: 3.9, reset: 'daily' }, keyUsage: { total: 2.58, day: 1.1, week: 1.9, month: 2.58 }, spent: { day: { tokens: 412000, calls: 37, cost: 1.08 }, week: { tokens: 1650000, calls: 140, cost: 1.87 }, month: { tokens: 2310000, calls: 201, cost: 2.55 } } },
      { kind: 'venice', name: 'Venice', ok: true, error: '', noApi: false, usd: 0.099, bundled: 58.51, diem: 0, tier: 'paid', nextEpoch: new Date(now + 61 * 60e3).toISOString(), access: true, keyExpires: null, modelLimits: [{ model: 'venice-uncensored', rpm: 50, rpd: 0, tpm: 1000000 }], spent: { day: { tokens: 2090000, calls: 12, cost: 0 }, week: { tokens: 2120000, calls: 14, cost: 0 }, month: { tokens: 3170000, calls: 20, cost: 0 } } },
      { kind: 'opencode-go', name: 'OpenCode Go', ok: true, error: '', noApi: false, windows: [{ id: 'rolling', label: '5 h', percent: 64, resetsAt: new Date(now + 95 * 60e3).toISOString() }, { id: 'weekly', label: 'semana', percent: 31, resetsAt: new Date(now + 4 * 86400e3).toISOString() }, { id: 'monthly', label: 'mes', percent: 12, resetsAt: new Date(now + 19 * 86400e3).toISOString() }], spent: { day: { tokens: 980000, calls: 61, cost: 0 }, week: { tokens: 3100000, calls: 240, cost: 0 }, month: { tokens: 5200000, calls: 410, cost: 0 } } }
    ] } }
    : { state: 'missing', paid: ['venice'] }),
  quotasInstall: () => ok({ ok: false, scan: 'caution', findings: ['Lee variables de entorno con claves (para preguntar el saldo).', 'Hace peticiones de red a openrouter.ai y api.venice.ai.'] }),
  media: () => ok('assets/icon.png'),
  usage: () => ok({ chats: 3, messages: 22, input: 5120000, output: 98000, today: { chats: 2, messages: 8, input: 1062000, output: 28000 }, week: { chats: 9, messages: 40, input: 4210000, output: 105000 }, last: { at: now - 3 * 60e3, id: 'd1', title: 'Receta de lentejas para 4' }, days: Array.from({ length: 30 }, (_, i) => ({ date: `día ${i + 1}`, chats: i % 4, messages: i % 4 * 3, input: i % 4 * 9000, output: i % 4 * 700 })), models: [{ model: 'qwen3-32b', input: 2900000, output: 410000, tasks: [{ task: 'compression', tokens: 820000 }, { task: 'title_generation', tokens: 4100 }] }, { model: 'gemma-3-27b', input: 1150000, output: 64000, tasks: [] }, { model: '/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf', input: 66000, output: 34000, tasks: [{ task: 'vision', tokens: 100000 }] }, { model: 'qwen3-8b', input: 3000, output: 400, tasks: [] }], modelsFrom: 'hermes' }),
  exportChat: () => ok({ saved: false }),
  // En la demostración «Buscar actualizaciones» encuentra una versión de muestra (no instala nada).
  updateCheck: () => ok({ available: true, version: '0.99.0-beta', notes: 'Versión de muestra del modo demostración.' }),
  updateInstall: () => new Promise(r => setTimeout(() => r({ ok: true, value: false }), 600)),
  openLogs: () => ok(true),
  testNotify: () => ok(true),
  // Cambiar el modelo o el esfuerzo de un chat empezado: en la demostración se acepta sin más.
  chatOptions: (conn, sid, o) => ok(o ? { applied: 'now', model: o.model || null, effort: o.reasoning || null } : { model: null, effort: null }),
  onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb) }
}
