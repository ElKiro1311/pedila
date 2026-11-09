'use strict'
// Pedila: proceso principal. Ventana con su propio protocolo app://, bandeja, avisos de
// Windows y dos conexiones con Hermes («Este PC» y «Servidor»).
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, protocol, net, nativeTheme, shell, nativeImage, session, screen, globalShortcut, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const log = require('./log')
const { Settings } = require('./settings')
const secrets = require('./secrets')
const { LocalTransport } = require('./local')
const { RemoteTransport } = require('./remote')
const { Connection } = require('./connection')
const notify = require('./notify')
const { Pets } = require('./pets')
const extras = require('./extras')

const APP_ID = 'org.pedila.app'
const TOAST_CLSID = '{6B1E3C2A-9F4D-4E7B-A1C5-3D8F2B6E9A41}'
const SRC = path.join(__dirname, '..')
const ROOTS = { shell: path.join(SRC, 'shell'), assets: path.join(SRC, 'assets') }
const SHELL_URL = 'app://shell/index.html'
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://assets.petdex.dev; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' }

app.setName('Pedila')
// Mudanza desde «Hermes Panel» (nombre anterior): se copia la carpeta entera, incluido «Local State»,
// que guarda la clave con la que safeStorage cifró la sesión del servidor. La vieja se deja como copia.
if (!process.env.PEDILA_DATA) {
  try {
    const appData = app.getPath('appData')
    const oldDir = path.join(appData, 'Hermes Panel')
    const newDir = path.join(appData, 'Pedila')
    if (fs.existsSync(path.join(oldDir, 'settings.json')) && !fs.existsSync(newDir)) {
      fs.cpSync(oldDir, newDir, { recursive: true, filter: src => !/[\\/](Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|logs)([\\/]|$)/.test(src) })
      const f = path.join(newDir, 'settings.json')
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j.updates && typeof j.updates.url === 'string') { j.updates.url = j.updates.url.replace(/[/]hermes-panel$/, '/pedila') }
      fs.writeFileSync(f, JSON.stringify(j, null, 2))
    }
  } catch {}
}
app.setAppUserModelId(APP_ID)
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Solo en desarrollo y a propósito: puerto de depuración para mis pruebas (nunca en el instalable).
if (!app.isPackaged && /^\d{4,5}$/.test(process.env.PEDILA_CDP || '')) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PEDILA_CDP)
}
// Solo en desarrollo: otra carpeta de datos (ajustes, sesión, mascotas) para probar sin tocar la
// de verdad; también deja abrir esta copia junto a la app instalada.
if (!app.isPackaged && process.env.PEDILA_DATA) {
  app.setPath('userData', process.env.PEDILA_DATA)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function main() {
  let win = null
  let tray = null
  let quitting = false
  let settings = null
  let viewing = { conn: null, sid: null, title: '' }
  let pets = null
  const conns = {}
  const titles = new Map() // `${conn}:${sid}` → título conocido (para los avisos)
  const startHidden = process.argv.includes('--oculto')
  const demo = !app.isPackaged && process.env.PEDILA_DEMO === '1'

  app.on('second-instance', () => showWindow())

  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e, url) => { if (!url.startsWith('app://shell/')) { e.preventDefault() } })
    wc.on('will-redirect', (e, url) => { if (!url.startsWith('app://shell/')) { e.preventDefault() } })
    wc.on('will-attach-webview', e => e.preventDefault())
    wc.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
  })

  app.whenReady().then(async () => {
    log.init(path.join(app.getPath('userData'), 'logs'))
    log.info(`Pedila ${app.getVersion()} · Electron ${process.versions.electron} · empaquetada=${app.isPackaged}`)
    settings = new Settings(app.getPath('userData'))
    settings.load()
    nativeTheme.themeSource = settings.data.look.theme
    try { app.setToastActivatorCLSID(TOAST_CLSID) } catch {}
    fixStartMenuShortcut()

    // Ningún permiso web salvo copiar al portapapeles (botón «Copiar» de los bloques de código).
    const allowed = perm => perm === 'clipboard-sanitized-write'
    for (const s of [session.defaultSession]) {
      s.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed(perm)))
      s.setPermissionCheckHandler((_wc, perm) => allowed(perm))
    }

    pets = new Pets({ dataDir: app.getPath('userData'), bundledDir: path.join(ROOTS.assets, 'pets', 'pedila'), log })
    ensureDefaultPet()
    protocol.handle('app', serveApp)

    const remote = new RemoteTransport({ settings, secrets, log })
    await remote.init()
    conns.local = new Connection({ id: 'local', name: 'Este PC', transport: new LocalTransport({ log }), log })
    conns.server = new Connection({ id: 'server', name: 'Servidor', transport: remote, log })
    for (const c of Object.values(conns)) {
      c.on('ui', evt => onConnEvent(evt))
    }

    registerIpc(remote)
    applyShortcut()
    setTimeout(() => autoCheckUpdate(), 20000)
    setInterval(() => autoCheckUpdate(), 6 * 60 * 60 * 1000)
    createWindow()
    createTray()
    Notification.handleActivation?.(() => showWindow())

    if (!demo) {
      if (settings.data.local.enabled) { conns.local.start() }
      if (settings.data.server.enabled) { conns.server.start() }
    }
  })

  app.on('will-quit', () => { try { globalShortcut.unregisterAll() } catch {} })

  app.on('before-quit', () => {
    quitting = true
    for (const c of Object.values(conns)) { try { c.stop() } catch {} }
  })

  app.on('window-all-closed', () => { /* vive en la bandeja */ })

  // ── app:// ─────────────────────────────────────────────────────────────────────────────────
  async function serveApp(req) {
    const u = new URL(req.url)
    if (u.hostname !== 'shell') { return new Response('no', { status: 404 }) }
    // Todo sale del mismo origen (app://shell): las imágenes de /assets/ también, para que la
    // política de seguridad las admita y el lienzo de la mascota se pueda leer.
    let rel
    try { rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html' } catch { return new Response('no', { status: 400 }) }
    let root = ROOTS.shell
    let file
    if (rel.startsWith('pets/')) {
      // Mascotas descargadas de Petdex (en los datos del usuario).
      file = pets && pets.fileFor(rel)
      if (!file) { return new Response('no', { status: 404 }) }
    } else {
      if (rel.startsWith('assets/')) { root = ROOTS.assets; rel = rel.slice('assets/'.length) }
      file = path.normalize(path.join(root, rel))
      if (!file.startsWith(root + path.sep)) { return new Response('no', { status: 403 }) }
    }
    try {
      const res = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers({ 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' })
      if (file.endsWith('.html')) { headers.set('Content-Security-Policy', CSP) }
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('no', { status: 404 })
    }
  }

  // ── Ventana ────────────────────────────────────────────────────────────────────────────────
  function isDark() {
    return nativeTheme.shouldUseDarkColors
  }

  // Fondo de cada tema [oscuro, claro]: el de la ventana mientras carga y el de la barra de título.
  const WINDOW_BG = { mensajera: ['#0e0e0f', '#f4f3ef'], clasico: ['#14141a', '#f4f4f8'], egeo: ['#0b1120', '#eef2f8'], anfora: ['#120d0b', '#f6ede3'], olivo: ['#0f120e', '#f2f4ee'] }
  function windowBg() {
    const pair = WINDOW_BG[settings.data.look.palette] || WINDOW_BG.mensajera
    return isDark() ? pair[0] : pair[1]
  }

  function overlay() {
    return { color: windowBg(), symbolColor: isDark() ? '#e6e6ee' : '#26262e', height: 40 }
  }

  function onScreen(b) {
    if (!b) { return null }
    const d = screen.getDisplayMatching(b)
    const wa = d && d.workArea
    if (!wa) { return null }
    const visible = b.x < wa.x + wa.width - 80 && b.x + b.width > wa.x + 80 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 60
    return visible ? b : null
  }

  function createWindow() {
    const w = settings.data.window
    const b = onScreen(w.bounds)
    win = new BrowserWindow({
      width: b ? b.width : 1180,
      height: b ? b.height : 780,
      ...(b ? { x: b.x, y: b.y } : {}),
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'Pedila',
      icon: path.join(ROOTS.assets, 'icon.png'),
      backgroundColor: windowBg(),
      titleBarStyle: 'hidden',
      titleBarOverlay: overlay(),
      webPreferences: {
        preload: path.join(SRC, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true
      }
    })
    if (w.maximized) { win.maximize() }
    win.loadURL(demo ? SHELL_URL + '?demo=1' : SHELL_URL)
    win.once('ready-to-show', () => { if (!startHidden) { win.show() } })
    let saveT = null
    const saveBounds = () => {
      clearTimeout(saveT)
      saveT = setTimeout(() => {
        if (!win || win.isDestroyed()) { return }
        const maximized = win.isMaximized()
        settings.patch({ window: { maximized, ...(maximized || win.isMinimized() ? {} : { bounds: win.getBounds() }) } })
      }, 600)
    }
    win.on('resize', saveBounds)
    win.on('move', saveBounds)
    win.on('close', e => {
      if (!quitting && settings.data.window.closeToTray) {
        e.preventDefault()
        win.hide()
      }
    })
    win.on('focus', () => { try { win.flashFrame(false); setBadge(false) } catch {} })
    win.on('closed', () => { win = null })
    nativeTheme.on('updated', () => {
      if (win && !win.isDestroyed()) {
        try { win.setTitleBarOverlay(overlay()) } catch {}
        send({ kind: 'theme', dark: isDark() })
      }
    })
  }

  function showWindow() {
    if (!win) { createWindow() }
    if (win.isMinimized()) { win.restore() }
    win.show()
    win.focus()
  }

  function send(evt) {
    if (win && !win.isDestroyed()) { win.webContents.send('hp:event', evt) }
  }

  // ── Bandeja ────────────────────────────────────────────────────────────────────────────────
  function createTray() {
    const img = nativeImage.createFromPath(path.join(ROOTS.assets, 'tray.png'))
    tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(path.join(ROOTS.assets, 'icon.png')).resize({ width: 16, height: 16 }) : img)
    tray.setToolTip('Pedila')
    tray.on('click', () => showWindow())
    refreshTray()
  }

  function refreshTray() {
    if (!tray) { return }
    const label = c => ({ ready: 'conectado', connecting: 'conectando…', offline: 'sin conexión', login: 'falta iniciar sesión', error: 'error', off: 'apagado' })[c.state] || c.state
    const lines = Object.values(conns).map(c => `${c.name}: ${label(c)}`)
    tray.setToolTip(['Pedila', ...lines].join('\n'))
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir Pedila', click: () => showWindow() },
      { label: 'Nuevo chat', click: () => { showWindow(); send({ kind: 'new-chat' }) } },
      { type: 'separator' },
      ...Object.values(conns).map(c => ({ label: `${c.name}: ${label(c)}`, enabled: false })),
      { type: 'separator' },
      { label: 'Salir', click: () => { quitting = true; app.quit() } }
    ]))
  }

  // ── Eventos de las conexiones ──────────────────────────────────────────────────────────────
  function onConnEvent(evt) {
    send(evt)
    if (evt.kind === 'conn') { refreshTray() }
    if (evt.kind === 'title' && evt.sid) { titles.set(`${evt.conn}:${evt.sid}`, evt.title) }
    const c = conns[evt.conn]
    const focusedOnChat = Boolean(win && win.isVisible() && win.isFocused() && viewing.conn === evt.conn && viewing.sid === evt.sid)
    const chatTitle = titles.get(`${evt.conn}:${evt.sid}`) || (viewing.conn === evt.conn && viewing.sid === evt.sid ? viewing.title : '')
    const where = c ? c.name : ''
    const open = () => { showWindow(); send({ kind: 'focus-chat', conn: evt.conn, sid: evt.sid }) }
    if (evt.kind === 'complete' && settings.data.notify.badge && !focusedOnChat && win && !win.isFocused()) { setBadge(true) }
    if (evt.kind === 'complete') {
      const failed = evt.outcome && !['completed', 'complete', ''].includes(evt.outcome)
      const kind = failed ? 'failed' : 'done'
      if (notify.decide(kind, { notify: settings.data.notify, focusedOnChat, ms: evt.ms })) {
        alertUser(failed ? `Hermes no terminó · ${where}` : `Hermes terminó · ${where}`,
          (chatTitle ? `${chatTitle}: ` : '') + (evt.text || (failed ? `Resultado: ${evt.outcome}` : 'Respuesta lista')).replace(/\s+/g, ' '), open)
      }
    } else if (evt.kind === 'prompt') {
      if (notify.decide('needs', { notify: settings.data.notify, focusedOnChat })) {
        const approval = evt.promptKind === 'approval'
        const what = approval ? (evt.command || evt.description || 'Quiere tu permiso') : (evt.questions && evt.questions[0] ? evt.questions[0].question : 'Espera tu respuesta')
        alertUser(approval ? `Hermes te necesita · ${where}` : `Hermes te pregunta · ${where}`, (chatTitle ? `${chatTitle}: ` : '') + what, open)
      }
    } else if (evt.kind === 'error') {
      if (notify.decide('failed', { notify: settings.data.notify, focusedOnChat })) {
        alertUser(`Hermes tuvo un problema · ${where}`, evt.message, open)
      }
    }
  }

  /** Aviso de Windows y, además, el botón de la barra de tareas parpadea hasta que vuelves:
   *  así te enteras aunque tengas las notificaciones de Windows apagadas. */
  function alertUser(title, body, onClick) {
    notify.show({ Notification, log, icon: path.join(ROOTS.assets, 'icon.png'), silent: !settings.data.notify.sound, onClick, title, body })
    if (win && !win.isDestroyed() && !win.isFocused()) {
      win.flashFrame(true)
      log.info('parpadeo en la barra de tareas')
    }
  }

  // Punto en el icono de la barra de tareas: hay una respuesta que no has visto.
  let dot = null
  function setBadge(on) {
    if (!win || win.isDestroyed()) { return }
    if (on && !dot) {
      const n = 16
      const buf = Buffer.alloc(n * n * 4)
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const d = Math.hypot(x - 7.5, y - 7.5)
          const i = (y * n + x) * 4
          if (d <= 7.5) { buf[i] = d > 6 ? 255 : 0x6c; buf[i + 1] = d > 6 ? 255 : 0x5c; buf[i + 2] = d > 6 ? 255 : 0xf0; buf[i + 3] = 255 }
        }
      }
      dot = nativeImage.createFromBitmap(buf, { width: n, height: n })
    }
    try { win.setOverlayIcon(on ? dot : null, on ? 'Respuesta nueva de Hermes' : '') } catch {}
  }

  // Atajo global: Ctrl+Alt+H muestra la app (lista para escribir) o la esconde.
  function applyShortcut() {
    try { globalShortcut.unregister('CommandOrControl+Alt+H') } catch {}
    if (!settings.data.shortcut.enabled) { return }
    const ok = globalShortcut.register('CommandOrControl+Alt+H', () => {
      if (win && win.isVisible() && win.isFocused()) { win.hide(); return }
      showWindow()
      send({ kind: 'focus-input' })
    })
    if (!ok) { log.warn('el atajo Ctrl+Alt+H ya lo usa otra app') }
  }

  // Pedila viaja en el instalador; si la mascota elegida es de Petdex y falta (datos copiados de otro
  // PC, por ejemplo), se vuelve a bajar.
  async function ensureDefaultPet() {
    if (pets.installed().some(p => p.slug === settings.data.pet.slug)) { return }
    try {
      const pet = await pets.install(settings.data.pet.slug)
      log.info(`[mascotas] descargada la mascota predeterminada: ${pet.slug}`)
      send({ kind: 'pet', pet })
    } catch (e) {
      log.warn('[mascotas] no pude bajar la mascota predeterminada:', e.message)
    }
  }

  const REPO = (() => {
    try {
      const m = String(require('../../package.json').repository || '').match(/github\.com[/:]([\w.-]+[/][\w.-]+?)(?:\.git)?$/)
      return m ? m[1] : ''
    } catch { return '' }
  })()

  let pendingUpdate = null
  async function autoCheckUpdate(manual = false) {
    const u = settings.data.updates
    if (!u.auto && !manual) { return null }
    try {
      const r = await extras.checkUpdate(u.url, app.getVersion(), REPO)
      if (r.available) {
        pendingUpdate = r
        send({ kind: 'update', version: r.version, notes: r.notes })
        log.info(`[actualizar] hay versión nueva: ${r.version}`)
      }
      return r
    } catch (e) {
      if (manual) { throw e }
      log.warn('[actualizar]', e.message)
      return null
    }
  }

  // ── IPC ────────────────────────────────────────────────────────────────────────────────────
  function registerIpc(remote) {
    const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
      const url = e.senderFrame && e.senderFrame.url
      if (!url || !url.startsWith('app://shell/')) { throw new Error('origen no permitido') }
      try {
        return { ok: true, value: await fn(...args) }
      } catch (err) {
        if (!err.needLogin && !err.setup) { log.warn(`[ipc ${ch}]`, err.message) }
        return { ok: false, error: err.message || String(err), needLogin: Boolean(err.needLogin), setup: Boolean(err.setup) }
      }
    })
    const connOf = id => {
      const c = conns[id]
      if (!c) { throw new Error('conexión desconocida') }
      return c
    }
    const sidOf = s => {
      if (typeof s !== 'string' || !s || s.length > 200) { throw new Error('chat no válido') }
      return s
    }
    handle('hp:init', async () => ({
      version: app.getVersion(),
      demo,
      dark: isDark(),
      toastsOff: await windowsToastsOff(),
      pet: pets.resolve(settings.data.pet.slug),
      settings: settings.publicView(),
      connections: Object.values(conns).map(c => c.publicState())
    }))
    handle('hp:sessions', id => connOf(id).listSessions())
    handle('hp:transcript', (id, sid) => connOf(id).transcript(sidOf(sid)))
    handle('hp:attach', async (id, sid) => {
      const r = await connOf(id).attach(sidOf(sid))
      return { running: Boolean(r.running) }
    })
    handle('hp:new', (id, opts) => {
      const o = opts && typeof opts === 'object' ? opts : {}
      return connOf(id).newChat({ model: typeof o.model === 'string' ? o.model.slice(0, 200) : undefined, provider: typeof o.provider === 'string' ? o.provider.slice(0, 200) : undefined, reasoning: ['low', 'medium', 'high'].includes(o.reasoning) ? o.reasoning : undefined })
    })
    handle('hp:send', async (id, sid, text, attachments) => {
      if (typeof text !== 'string' || !text.trim() || text.length > 200000) { throw new Error('mensaje vacío o demasiado largo') }
      const files = Array.isArray(attachments) ? attachments.slice(0, 6).filter(a => a && typeof a.path === 'string' && typeof a.mime === 'string' && a.mime.startsWith('image/')) : []
      const r = await connOf(id).send(sidOf(sid), text, files)
      return { status: r && r.status ? String(r.status) : 'ok' }
    })
    handle('hp:stop', (id, sid) => connOf(id).interrupt(sidOf(sid)).then(r => ({ status: r && r.status })))
    handle('hp:answer', (id, key, value) => {
      if (typeof key !== 'string' || key.length > 300) { throw new Error('petición no válida') }
      return connOf(id).answer(key, value)
    })
    handle('hp:models', id => connOf(id).modelOptions())
    handle('hp:archived', id => connOf(id).archived())
    handle('hp:search', (id, q) => {
      if (typeof q !== 'string' || q.trim().length < 2) { return [] }
      return connOf(id).search(q.trim().slice(0, 200))
    })
    handle('hp:mutate', (id, sid, op, value) => {
      const c = connOf(id)
      sidOf(sid)
      if (op === 'rename') { if (typeof value !== 'string' || !value.trim()) { throw new Error('nombre vacío') } return c.rename(sid, value.trim().slice(0, 200)) }
      if (op === 'pin') { return c.setPinned(sid, Boolean(value)) }
      if (op === 'archive') { return c.setArchived(sid, Boolean(value)) }
      if (op === 'delete') { return c.remove(sid) }
      throw new Error('operación desconocida')
    })
    handle('hp:attach-image', (id, sid, b64, name) => {
      if (typeof b64 !== 'string' || b64.length > 15 * 1024 * 1024 * 1.4) { throw new Error('imagen demasiado grande (máximo 15 MB)') }
      return connOf(id).attachImage(sidOf(sid), b64, typeof name === 'string' ? name.replace(/[^\w. -]/g, '_').slice(0, 80) : 'imagen.png')
    })
    handle('hp:usage', async id => extras.usageStats(await connOf(id).allSessions(2000, 'include')))
    handle('hp:export', async (name, markdown) => {
      if (typeof markdown !== 'string' || markdown.length > 20 * 1024 * 1024) { throw new Error('nada que exportar') }
      const base = (typeof name === 'string' && name ? name : 'chat').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'chat'
      const r = await dialog.showSaveDialog(win, { title: 'Exportar el chat', defaultPath: path.join(app.getPath('documents'), base + '.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (r.canceled || !r.filePath) { return { saved: false } }
      fs.writeFileSync(r.filePath, markdown, 'utf8')
      return { saved: true, file: r.filePath }
    })
    handle('hp:show-file', file => { if (typeof file === 'string') { shell.showItemInFolder(file) } return true })
    handle('hp:update-check', () => autoCheckUpdate(true))
    handle('hp:update-install', async () => {
      const u = settings.data.updates
      const info = pendingUpdate || await extras.checkUpdate(u.url, app.getVersion(), REPO)
      if (!info || !info.available) { throw new Error('no hay versión nueva') }
      await extras.installUpdate(info, log)
      setTimeout(() => { quitting = true; app.quit() }, 600)
      return true
    })
    handle('hp:login', async (user, pass) => {
      if (typeof user !== 'string' || typeof pass !== 'string' || !user || !pass || user.length > 200 || pass.length > 500) { throw new Error('Escribe usuario y contraseña') }
      const r = await remote.login(user, pass)
      if (r.ok) {
        log.info('[servidor] sesión iniciada')
        conns.server.setState('connecting')
        conns.server.retryNow()
        if (conns.server.stopped) { conns.server.start() }
      }
      return r
    })
    handle('hp:logout', async () => {
      await remote.logout()
      conns.server.stop()
      conns.server.setState('login', 'Sesión cerrada')
      conns.server.stopped = false
      return true
    })
    handle('hp:retry', id => { connOf(id).retryNow(); return true })
    handle('hp:settings', patch => {
      if (patch) {
        const before = JSON.stringify(settings.data.server.urls)
        settings.patch(patch)
        nativeTheme.themeSource = settings.data.look.theme
        if (patch.look && win && !win.isDestroyed()) { try { win.setTitleBarOverlay(overlay()); win.setBackgroundColor(windowBg()) } catch {} }
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: settings.data.window.openAtLogin, args: ['--oculto'] })
        }
        if (JSON.stringify(settings.data.server.urls) !== before) { remote.invalidate(); conns.server.retryNow() }
        if (patch.shortcut) { applyShortcut() }
      }
      return settings.publicView()
    })
    handle('hp:viewing', (id, sid, title) => {
      viewing = { conn: typeof id === 'string' ? id : null, sid: typeof sid === 'string' ? sid : null, title: typeof title === 'string' ? title.slice(0, 120) : '' }
      if (viewing.conn && viewing.sid && viewing.title) { titles.set(`${viewing.conn}:${viewing.sid}`, viewing.title) }
      return true
    })
    handle('hp:pets-search', params => {
      const p = params && typeof params === 'object' ? params : {}
      return pets.search({ q: typeof p.q === 'string' ? p.q.slice(0, 100) : '', kind: typeof p.kind === 'string' ? p.kind.slice(0, 40) : '', offset: Number(p.offset) || 0, limit: Number(p.limit) || 30 })
    })
    handle('hp:pets-installed', () => pets.installed())
    handle('hp:pet-use', async slug => {
      if (typeof slug !== 'string') { throw new Error('mascota no válida') }
      const pet = await pets.install(slug)
      settings.patch({ pet: { slug: pet.slug } })
      return pet
    })
    handle('hp:open-logs', () => shell.openPath(log.dir() || app.getPath('userData')))
    handle('hp:test-notify', () => {
      notify.show({ Notification, log, icon: path.join(ROOTS.assets, 'icon.png'), silent: !settings.data.notify.sound, title: 'Pedila', body: 'Así se verán los avisos cuando Hermes termine o te necesite.', onClick: () => showWindow() })
      return Notification.isSupported()
    })
  }

  // ── Utilidades ─────────────────────────────────────────────────────────────────────────────
  /** ¿Tiene Windows apagado el interruptor general de notificaciones? (solo lectura del registro) */
  function windowsToastsOff() {
    if (process.platform !== 'win32') { return Promise.resolve(false) }
    return new Promise(resolve => {
      require('node:child_process').execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', '/v', 'ToastEnabled'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        if (err) { return resolve(false) }
        resolve(/ToastEnabled\s+REG_DWORD\s+0x0\b/i.test(String(out)))
      })
    })
  }

  function openExternal(url) {
    try {
      const u = new URL(url)
      if (['http:', 'https:', 'mailto:'].includes(u.protocol)) { shell.openExternal(u.toString()) }
    } catch {}
  }

  // Los avisos de Windows necesitan el AUMID y el CLSID en el acceso directo del menú Inicio.
  function fixStartMenuShortcut() {
    if (!app.isPackaged || process.platform !== 'win32') { return }
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Pedila.lnk')
    try {
      if (!fs.existsSync(lnk)) { return }
      const cur = shell.readShortcutLink(lnk)
      if (cur.appUserModelId !== APP_ID || (cur.toastActivatorClsid || '').toUpperCase() !== TOAST_CLSID) {
        shell.writeShortcutLink(lnk, 'update', { appUserModelId: APP_ID, toastActivatorClsid: TOAST_CLSID })
        log.info('acceso directo del menú Inicio corregido para los avisos')
      }
    } catch (e) {
      log.warn('no pude revisar el acceso directo:', e.message)
    }
  }
}
