'use strict'
// Hermes Panel: proceso principal. Ventana con su propio protocolo app://, bandeja, avisos de
// Windows y dos conexiones con Hermes («Este PC» y «Servidor»).
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, protocol, net, nativeTheme, shell, nativeImage, session, screen } = require('electron')
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

const APP_ID = 'org.hermespanel.app'
const TOAST_CLSID = '{6B1E3C2A-9F4D-4E7B-A1C5-3D8F2B6E9A41}'
const SRC = path.join(__dirname, '..')
const ROOTS = { shell: path.join(SRC, 'shell'), assets: path.join(SRC, 'assets') }
const SHELL_URL = 'app://shell/index.html'
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://assets.petdex.dev; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' }

app.setName('Hermes Panel')
app.setAppUserModelId(APP_ID)
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Solo en desarrollo y a propósito: puerto de depuración para mis pruebas (nunca en el instalable).
if (!app.isPackaged && /^\d{4,5}$/.test(process.env.HERMES_PANEL_CDP || '')) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.HERMES_PANEL_CDP)
}
// Solo en desarrollo: otra carpeta de datos (ajustes, sesión, mascotas) para probar sin tocar la
// de verdad; también deja abrir esta copia junto a la app instalada.
if (!app.isPackaged && process.env.HERMES_PANEL_DATA) {
  app.setPath('userData', process.env.HERMES_PANEL_DATA)
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
  const demo = !app.isPackaged && process.env.HERMES_PANEL_DEMO === '1'

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
    log.info(`Hermes Panel ${app.getVersion()} · Electron ${process.versions.electron} · empaquetada=${app.isPackaged}`)
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

    pets = new Pets({ dataDir: app.getPath('userData'), bundledDir: path.join(ROOTS.assets, 'pets', 'default'), log })
    protocol.handle('app', serveApp)

    const remote = new RemoteTransport({ settings, secrets, log })
    await remote.init()
    conns.local = new Connection({ id: 'local', name: 'Este PC', transport: new LocalTransport({ log }), log })
    conns.server = new Connection({ id: 'server', name: 'Servidor', transport: remote, log })
    for (const c of Object.values(conns)) {
      c.on('ui', evt => onConnEvent(evt))
    }

    registerIpc(remote)
    createWindow()
    createTray()
    Notification.handleActivation?.(() => showWindow())

    if (!demo) {
      if (settings.data.local.enabled) { conns.local.start() }
      if (settings.data.server.enabled) { conns.server.start() }
    }
  })

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
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html'
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

  function overlay() {
    return isDark() ? { color: '#14141a', symbolColor: '#e6e6ee', height: 40 } : { color: '#f4f4f8', symbolColor: '#26262e', height: 40 }
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
      title: 'Hermes Panel',
      icon: path.join(ROOTS.assets, 'icon.png'),
      backgroundColor: isDark() ? '#14141a' : '#f4f4f8',
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
    win.on('focus', () => { try { win.flashFrame(false) } catch {} })
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
    tray.setToolTip('Hermes Panel')
    tray.on('click', () => showWindow())
    refreshTray()
  }

  function refreshTray() {
    if (!tray) { return }
    const label = c => ({ ready: 'conectado', connecting: 'conectando…', offline: 'sin conexión', login: 'falta iniciar sesión', error: 'error', off: 'apagado' })[c.state] || c.state
    const lines = Object.values(conns).map(c => `${c.name}: ${label(c)}`)
    tray.setToolTip(['Hermes Panel', ...lines].join('\n'))
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir Hermes Panel', click: () => showWindow() },
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

  // ── IPC ────────────────────────────────────────────────────────────────────────────────────
  function registerIpc(remote) {
    const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
      const url = e.senderFrame && e.senderFrame.url
      if (!url || !url.startsWith('app://shell/')) { throw new Error('origen no permitido') }
      try {
        return { ok: true, value: await fn(...args) }
      } catch (err) {
        if (!err.needLogin) { log.warn(`[ipc ${ch}]`, err.message) }
        return { ok: false, error: err.message || String(err), needLogin: Boolean(err.needLogin) }
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
      return connOf(id).newChat({ model: typeof o.model === 'string' ? o.model.slice(0, 200) : undefined, provider: typeof o.provider === 'string' ? o.provider.slice(0, 200) : undefined })
    })
    handle('hp:send', async (id, sid, text) => {
      if (typeof text !== 'string' || !text.trim() || text.length > 200000) { throw new Error('mensaje vacío o demasiado largo') }
      const r = await connOf(id).send(sidOf(sid), text)
      return { status: r && r.status ? String(r.status) : 'ok' }
    })
    handle('hp:stop', (id, sid) => connOf(id).interrupt(sidOf(sid)).then(r => ({ status: r && r.status })))
    handle('hp:answer', (id, key, value) => {
      if (typeof key !== 'string' || key.length > 300) { throw new Error('petición no válida') }
      return connOf(id).answer(key, value)
    })
    handle('hp:models', id => connOf(id).modelOptions())
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
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: settings.data.window.openAtLogin, args: ['--oculto'] })
        }
        if (JSON.stringify(settings.data.server.urls) !== before) { remote.invalidate(); conns.server.retryNow() }
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
      notify.show({ Notification, log, icon: path.join(ROOTS.assets, 'icon.png'), silent: !settings.data.notify.sound, title: 'Hermes Panel', body: 'Así se verán los avisos cuando Hermes termine o te necesite.', onClick: () => showWindow() })
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
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Hermes Panel.lnk')
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
