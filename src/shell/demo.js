// Demo mode (only in development, PEDILA_DEMO=1): made-up data to review the design without touching any
// Hermes or showing real chats.
const listeners = new Set()
const emit = evt => setTimeout(() => { for (const l of listeners) { l(evt) } }, 0)
const ok = value => Promise.resolve({ ok: true, value })
const now = Date.now()
let settings = {
  schema: 1,
  language: 'auto',
  look: { palette: 'mensajera', theme: 'system', accent: 'tema', textSize: 100 },
  server: { urls: ['http://192.168.1.50:9119'], enabled: true },
  local: { enabled: true },
  lastConnection: 'local',
  notify: { enabled: true, done: true, needs: true, failed: true, minDurationSec: 10, sound: true },
  pet: { visible: true, size: 'normal', slug: 'pedila' },
  window: { bounds: null, maximized: false, closeToTray: true, openAtLogin: false },
  updates: { url: '', auto: true, autoInstall: true },
  hermes: { autoUpdate: true },
  serverSignedIn: false
}
const sessions = {
  local: [
    { id: 'd1', title: 'Lentil recipe for 4', preview: "Here's a simple recipe…", lastActive: now - 3 * 60e3, messages: 6, model: 'qwen3-32b', running: false },
    { id: 'd2', title: 'Backup plan', preview: 'I checked your disks and…', lastActive: now - 26 * 3600e3, messages: 12, model: 'qwen3-32b', running: false },
    { id: 'd3', title: 'Compare two monitors', preview: 'The 240 Hz one is for you if…', lastActive: now - 4 * 86400e3, messages: 4, model: 'gemma-3-27b', running: false }
  ],
  server: []
}
const transcript = [
  { role: 'user', text: 'Can you give me a lentil recipe for 4 people?' },
  { role: 'assistant', reasoning: "The user wants a simple recipe. I'll look for a classic Spanish version.", blocks: [
    { type: 'tool', name: 'web_search', args: 'lentil stew recipe 4 people', input: { query: 'lentil stew recipe 4 people' }, done: true, summary: '5 results', output: "1. Grandma's lentil stew — example.com\n2. Lentils with chorizo — example.org\n3. …", seconds: 2.4 },
    { type: 'tool', name: 'terminal', args: 'ls recipes/', input: { command: 'ls recipes/' }, done: true, error: true, output: "ls: cannot access 'recipes/': No such file or directory\n(finished with code 2)", seconds: 0.2 },
    { type: 'tool', name: 'write_file', args: 'recipes/lentils.md', input: { path: 'C:\\Users\\demo\\recipes\\lentils.md', content: '# Lentil stew\n\n- 400 g of lentils\n- 1 chorizo\n- 2 carrots\n' }, done: true, output: 'Written: 5 lines', seconds: 0.1 },
    { type: 'tool', name: 'patch', args: 'recipes/lentils.md', input: { path: 'C:\\Users\\demo\\recipes\\lentils.md', old_string: '- 1 chorizo', new_string: '- 1 chorizo (or none, for the vegetarian version)' }, done: true, output: 'Change applied', seconds: 0.1 },
    { type: 'text', text: 'Sure! **Lentil stew** for 4:\n\n| Ingredient | Amount |\n|---|---|\n| Brown lentils | 400 g |\n| Chorizo | 1 |\n| Carrots | 2 |\n\n1. Fry the onion and the pepper gently.\n2. Add the lentils and cover with water.\n3. Cook for **35 minutes** over medium heat.\n\n```bash\n# timer\nsleep 2100 && echo "Lentils ready!"\n```' }
  ] },
  { role: 'user', text: 'Draw me a picture of the dish.' },
  { role: 'assistant', blocks: [
    { type: 'tool', name: 'image_generate', args: 'a steaming bowl of Spanish lentil stew', done: true, summary: 'image ready', seconds: 30.4 },
    { type: 'text', text: 'Here you are:\n\nMEDIA:C:\\Users\\demo\\AppData\\Local\\hermes\\cache\\generated\\images\\lentils.png\n\nA steaming plate of lentils.' }
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
  init: () => ok({ version: '0.2.0', demo: true, hour12: true, pet: DEMO_PET, dark: matchMedia('(prefers-color-scheme: dark)').matches, settings, connections: [{ id: 'local', name: 'This PC', state: 'ready', detail: '' }, { id: 'server', name: 'Server', state: 'login', detail: '' }] }),
  sessions: conn => (conn === 'server' ? Promise.resolve({ ok: false, error: 'You need to sign in', needLogin: true }) : ok(sessions[conn])),
  transcript: (conn, sid) => {
    // As in Hermes: reading a stored chat also brings out its last task list.
    if (sid === 'd1') { emit({ conn, sid, kind: 'todos', history: true, revision: 3, todos: [{ id: '1', content: 'Look for a classic lentil recipe', status: 'completed' }, { id: '2', content: 'Adjust the amounts for 4 people', status: 'completed' }, { id: '3', content: 'Draw the dish', status: 'completed' }] }) }
    return ok(sid === 'd1' ? transcript : [])
  },
  attach: () => ok({ running: false }),
  newChat: () => ok({ sid: 'd' + Math.floor(Math.random() * 1e6) }),
  send: (conn, sid, text) => {
    const plan = (a, b, c) => ({ kind: 'todos', revision: a === 'completed' ? (c === 'completed' ? 4 : 2) : 1, todos: [
      { id: '1', content: "Check the disks' free space", status: a },
      { id: '2', content: 'Go over the biggest folders', status: b },
      { id: '2a', content: 'Old backups', status: b, parent: '2' },
      { id: '3', content: 'Sum up how everything is', status: c }
    ] })
    demoApi._plan = plan
    const steps = [
      [200, { kind: 'turn-start' }],
      [350, plan('in_progress', 'pending', 'pending')],
      [500, { kind: 'reasoning', text: "I'll look at the state of the system before answering. " }],
      [700, { kind: 'subagent', phase: 'start', id: 's1', goal: 'Look for big files on the disks', index: 0, count: 2 }],
      [750, { kind: 'subagent', phase: 'spawn_requested', id: 's2', goal: 'Check the backups', index: 1, count: 2 }],
      [800, { kind: 'subagent', phase: 'tool', id: 's1', goal: 'Look for big files on the disks', index: 0, count: 2, tool: 'terminal', tools: 2 }],
      [900, { kind: 'tool', phase: 'start', id: 't1', name: 'terminal', args: 'df -h /' }],
      [1600, { kind: 'prompt', key: 'l:demo', promptKind: 'approval', command: 'df -h /', description: "Read the disks' free space", choices: ['once', 'session', 'always', 'deny'] }]
    ]
    for (const [ms, e] of steps) { setTimeout(() => emit({ conn, sid, ...e }), ms) }
    demoApi._pending = { conn, sid, text }
    return ok({ status: 'streaming' })
  },
  stop: (conn, sid) => { emit({ conn, sid, kind: 'complete', text: '', outcome: 'interrupted' }); return ok({ status: 'interrupted' }) },
  answer: (conn, key) => {
    const p = demoApi._pending || {}
    emit({ conn, kind: 'prompt-done', key, sid: p.sid })
    const reply = 'Your disks are fine: **2.1 TB free** out of 8 TB. Nothing to worry about for now.'
    let t = 300
    setTimeout(() => emit({ conn, sid: p.sid, kind: 'tool', phase: 'complete', id: 't1', name: 'terminal', summary: 'Filesystem Size Used Avail Use% / 8.0T 5.9T 2.1T 74%', seconds: 0.4 }), t)
    const plan = demoApi._plan
    if (plan) {
      setTimeout(() => emit({ conn, sid: p.sid, ...plan('completed', 'in_progress', 'pending') }), t + 20)
      setTimeout(() => emit({ conn, sid: p.sid, kind: 'subagent', phase: 'complete', id: 's1', goal: 'Look for big files on the disks', index: 0, count: 2, status: 'completed', tools: 3, seconds: 4.2 }), t + 40)
      setTimeout(() => emit({ conn, sid: p.sid, kind: 'subagent', phase: 'start', id: 's2', goal: 'Check the backups', index: 1, count: 2 }), t + 60)
      setTimeout(() => emit({ conn, sid: p.sid, kind: 'subagent', phase: 'complete', id: 's2', goal: 'Check the backups', index: 1, count: 2, status: 'completed', tools: 1, seconds: 1.5 }), t + 900)
      setTimeout(() => emit({ conn, sid: p.sid, ...plan('completed', 'completed', 'completed') }), t + 950)
      t += 1000
    }
    for (const word of reply.split(/(?<= )/)) { t += 60; setTimeout(() => emit({ conn, sid: p.sid, kind: 'delta', text: word }), t) }
    setTimeout(() => emit({ conn, sid: p.sid, kind: 'usage', used: 13425, max: 98304 }), t + 50)
    setTimeout(() => emit({ conn, sid: p.sid, kind: 'complete', text: reply, outcome: 'completed', ms: 4000 }), t + 120)
    return ok({ ok: true })
  },
  models: () => ok({ current: { model: 'qwen3-32b', provider: 'home' }, providers: [{ id: 'home', name: 'My server', local: true, models: [{ id: 'qwen3-32b', name: 'qwen3-32b' }, { id: 'gemma-3-27b', name: 'gemma-3-27b' }] }] }),
  login: () => ok({ ok: false, error: "There's no signing in in the demo." }),
  logout: () => ok(true),
  retry: () => ok(true),
  settings: patch => {
    if (patch) { for (const [k, v] of Object.entries(patch)) { settings[k] = typeof v === 'object' && !Array.isArray(v) ? { ...settings[k], ...v } : v } }
    return ok(settings)
  },
  viewing: () => ok(true),
  petsSearch: ({ q = '', kind = '' } = {}) => { const items = DEMO_CATALOG.filter(p => (!kind || p.kind === kind) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))); return ok({ total: items.length, all: DEMO_CATALOG.length, kinds: { character: 2, creature: 1, object: 1 }, items }) },
  petsInstalled: () => ok([DEMO_PET]),
  petUse: slug => (slug === 'pedila' ? ok(DEMO_PET) : Promise.resolve({ ok: false, error: "Pets aren't downloaded in the demo." })),
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
  // Sample quotas: "This PC" with the plugin installed (OpenRouter and OpenCode Go); the server without
  // it.
  quotas: conn => ok(conn === 'local'
    ? { state: 'ok', outdated: false, onDisk: '', restart: false, paid: ['openrouter', 'opencode-go'], data: { version: '1.2.0', shell: '1.2.0', fetchedAt: new Date(now - 40e3).toISOString(), providers: [
      { kind: 'openrouter', name: 'OpenRouter', ok: true, error: '', noApi: false, balance: 7.42, creditsTotal: 10, creditsUsed: 2.58, freeTier: false, keyLimit: { limit: 5, remaining: 3.9, reset: 'daily' }, keyUsage: { total: 2.58, day: 1.1, week: 1.9, month: 2.58 }, spent: { day: { tokens: 412000, calls: 37, cost: 1.08 }, week: { tokens: 1650000, calls: 140, cost: 1.87 }, month: { tokens: 2310000, calls: 201, cost: 2.55 } } },
      { kind: 'venice', name: 'Venice', ok: true, error: '', noApi: false, usd: 0.099, bundled: 58.51, diem: 0, tier: 'paid', nextEpoch: new Date(now + 61 * 60e3).toISOString(), access: true, keyExpires: null, modelLimits: [{ model: 'venice-uncensored', rpm: 50, rpd: 0, tpm: 1000000 }], spent: { day: { tokens: 2090000, calls: 12, cost: 0 }, week: { tokens: 2120000, calls: 14, cost: 0 }, month: { tokens: 3170000, calls: 20, cost: 0 } } },
      { kind: 'opencode-go', name: 'OpenCode Go', ok: true, error: '', noApi: false, account: { id: 'a1', n: 1, of: 2, active: true, resting: false, until: null, hidden: 0 }, plan: 'go', unpriced: [], catalog: true, windows: [{ id: 'rolling', label: '5 h', percent: 2, estimate: 2.5351, cost: 2.53, tokens: 680000, calls: 94, resetsAt: new Date(now + 95 * 60e3).toISOString() }, { id: 'weekly', label: 'week', percent: 1, estimate: 1.014, cost: 2.53, tokens: 680000, calls: 94, resetsAt: new Date(now + 4 * 86400e3).toISOString() }, { id: 'monthly', label: 'month', percent: 0, estimate: 0.507, cost: 2.53, tokens: 680000, calls: 94, resetsAt: new Date(now + 19 * 86400e3).toISOString() }], spent: { day: { tokens: 680000, calls: 94, cost: 2.53 }, week: { tokens: 680000, calls: 94, cost: 2.53 }, month: { tokens: 680000, calls: 94, cost: 2.53 } } },
      // A second key for the same API, in reserve (`hermes auth add`).
      { kind: 'opencode-go', name: 'OpenCode Go · spare', ok: true, error: '', noApi: false, account: { id: 'b2', n: 2, of: 2, active: false, resting: false, until: null, hidden: 0 }, plan: null, unpriced: [], catalog: null, spent: null, windows: [{ id: 'rolling', label: '5 h', percent: 0, estimate: null, resetsAt: new Date(now + 5 * 3600e3).toISOString() }, { id: 'weekly', label: 'week', percent: 12, estimate: null, resetsAt: new Date(now + 4 * 86400e3).toISOString() }, { id: 'monthly', label: 'month', percent: 41, estimate: null, resetsAt: new Date(now + 9 * 86400e3).toISOString() }] }
    ] } }
    : { state: 'missing', paid: ['venice'] }),
  quotasUpdate: () => ok({ ok: true, restart: false }),
  hermesWorking: () => ok(false),
  hermesRestart: () => new Promise(r => setTimeout(() => r({ ok: true, value: true }), 600)),
  quotasInstall: () => ok({ ok: false, scan: 'caution', findings: ['Reads environment variables with keys (to ask for the balance).', 'Makes network requests to openrouter.ai and api.venice.ai.'] }),
  media: () => ok('assets/icon.png'),
  usage: () => ok({ chats: 3, messages: 22, input: 5120000, output: 98000, today: { chats: 2, messages: 8, input: 1062000, output: 28000 }, week: { chats: 9, messages: 40, input: 4210000, output: 105000 }, last: { at: now - 3 * 60e3, id: 'd1', title: 'Lentil recipe for 4' }, days: Array.from({ length: 30 }, (_, i) => ({ date: `day ${i + 1}`, chats: i % 4, messages: i % 4 * 3, input: i % 4 * 9000, output: i % 4 * 700 })), models: [{ model: 'qwen3-32b', input: 2900000, output: 410000, tasks: [{ task: 'compression', tokens: 820000 }, { task: 'title_generation', tokens: 4100 }] }, { model: 'gemma-3-27b', input: 1150000, output: 64000, tasks: [] }, { model: '/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf', input: 66000, output: 34000, tasks: [{ task: 'vision', tokens: 100000 }] }, { model: 'qwen3-8b', input: 3000, output: 400, tasks: [] }], modelsFrom: 'hermes' }),
  exportChat: () => ok({ saved: false }),
  // In the demo, "Check for updates" finds a sample version (it installs nothing).
  updateCheck: () => ok({ available: true, version: '0.99.0-beta', notes: 'Sample version of the demo mode.' }),
  updateInstall: () => new Promise(r => setTimeout(() => r({ ok: true, value: false }), 600)),
  openLogs: () => ok(true),
  testNotify: () => ok(true),
  // Sample Hermes versions: the PC's can update itself; the server's runs in Docker.
  hermesUpdates: () => ok({
    local: { version: '0.23.0', latest: '0.23.2', available: true, canApply: true, method: 'git', checkedAt: now, busy: false, why: 'watching', applying: null, lastResult: null },
    server: { version: '0.23.1', latest: '0.23.2', available: true, canApply: false, method: 'managed-runtime', checkedAt: now, busy: false, why: 'server', applying: null, lastResult: null }
  }),
  hermesCheck: conn => demoApi.hermesUpdates().then(r => ({ ok: true, value: r.value[conn] })),
  hermesUpdate: () => Promise.resolve({ ok: false, error: 'Nothing is updated in the demo.' }),
  uiState: () => ok(true),
  // Changing the model or the effort of a chat already started: in the demo it's simply accepted.
  chatOptions: (conn, sid, o) => ok(o ? { applied: 'now', model: o.model || null, effort: o.reasoning || null } : { model: null, effort: null }),
  onEvent: cb => { listeners.add(cb); return () => listeners.delete(cb) }
}
