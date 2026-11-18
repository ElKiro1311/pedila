// Pedila: modo «Terminales». Pestañas con consolas de verdad (Claude Code, Hermes, Antigravity,
// PowerShell) dibujadas con xterm.js; los programas viven en el proceso principal (node-pty).
import { Terminal } from './vendor/xterm.mjs'
import { FitAddon } from './vendor/addon-fit.mjs'
import { WebLinksAddon } from './vendor/addon-web-links.mjs'

// ︎: que ✳ salga como letra y no como emoji de color.
const KIND_ICON = { claude: '✳︎', hermes: '☿︎', agy: '◭', shell: '›_' }
const KIND_HINT = {
  claude: 'Claude Code con tu cuenta, tal cual en la consola.',
  hermes: 'Hermes Agent en modo consola.',
  agy: 'Antigravity CLI de Google.',
  shell: 'Una consola normal de PowerShell.'
}
// Cascadia Mono (viene con Windows Terminal) y, para los iconos de los temas de consola (oh-my-posh,
// la barra de estado de Claude), las Nerd Fonts más comunes: el navegador busca cada letra en orden.
const TERM_FONTS = ['Cascadia Mono', 'JetBrainsMono NFM', 'JetBrainsMono Nerd Font Mono', 'CaskaydiaMono NFM', 'CaskaydiaCove Nerd Font Mono', 'MesloLGM Nerd Font Mono', 'Hack Nerd Font Mono', 'FiraCode Nerd Font Mono', 'Symbols Nerd Font Mono', 'Consolas', 'Segoe UI Symbol', 'monospace'].map(f => (f === 'monospace' ? f : `"${f}"`)).join(', ')
const base = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** Crea el modo Terminales. `ctx`: utilidades de app.js (api, call, el, $, showPopup, askBox, onChange). */
export function createTerms(ctx) {
  const { api, call, el, $ } = ctx
  const T = {
    mode: 'chats',
    ready: false,
    tools: [],
    dirs: [],
    home: '',
    restore: [],
    tabs: new Map(), // id → { info, term, fit, pane, bar, unread, userTitle }
    order: [],
    active: null,
    agents: [],
    newKind: 'claude',
    newDir: '',
    newCont: false
  }
  try { T.newKind = localStorage.getItem('pedila.term.kind') || 'claude' } catch {}

  // ── Aspecto de las terminales (siguen el tema de Pedila) ──
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() }
  function xtermTheme() {
    const light = document.documentElement.dataset.mode === 'light'
    const bg = cssVar('--term-bg') || (light ? '#fbfbf8' : '#0b0b0d')
    const fg = cssVar('--text') || (light ? '#18181a' : '#e8e8ea')
    const accent = cssVar('--accent') || '#c9a227'
    return light
      ? { background: bg, foreground: fg, cursor: accent, cursorAccent: bg, selectionBackground: 'rgba(156,116,25,.28)', black: '#1d1d22', red: '#c4302b', green: '#2f8a3b', yellow: '#9a6b00', blue: '#2361c7', magenta: '#9b3fb0', cyan: '#127f8c', white: '#6b6b70', brightBlack: '#56565c', brightRed: '#d9443e', brightGreen: '#3a9c47', brightYellow: '#b07c00', brightBlue: '#3274db', brightMagenta: '#ad4fc2', brightCyan: '#18929f', brightWhite: '#2a2a2e' }
      : { background: bg, foreground: fg, cursor: accent, cursorAccent: bg, selectionBackground: 'rgba(201,162,39,.30)', black: '#1b1b1f', red: '#f05f5f', green: '#5fd38d', yellow: '#e5c35a', blue: '#6aa8ff', magenta: '#d38cf0', cyan: '#4fd3d3', white: '#d6d6da', brightBlack: '#6d6d75', brightRed: '#ff7a7a', brightGreen: '#7ee6a6', brightYellow: '#f5d77a', brightBlue: '#8cbcff', brightMagenta: '#e3a8f7', brightCyan: '#74e6e6', brightWhite: '#ffffff' }
  }
  function fontSize() {
    const s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale')) || 1
    return Math.round(13.5 * s * 2) / 2
  }
  function applyLook() {
    for (const tab of T.tabs.values()) {
      tab.term.options.theme = xtermTheme()
      tab.term.options.fontSize = fontSize()
    }
    fitAll()
  }

  // ── Pestañas ──
  function makeTab(info) {
    const pane = el('div', { class: 'term-pane', 'data-id': info.id })
    const host = el('div', { class: 'term-host' })
    const bar = el('div', { class: 'term-exit', hidden: true })
    pane.append(host, bar)
    $('#term-panes').append(pane)
    const term = new Terminal({
      fontFamily: TERM_FONTS,
      fontSize: fontSize(),
      lineHeight: 1.12,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: false,
      macOptionIsMeta: false,
      windowsPty: { backend: 'conpty' },
      // Enlaces de los programas (OSC 8): al navegador, sin la pregunta en inglés de xterm.
      linkHandler: { activate: (_e, uri) => { window.open(uri) }, allowNonHttpProtocols: false },
      theme: xtermTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Los enlaces se abren en el navegador (la ventana de Pedila no navega a ningún sitio).
    term.loadAddon(new WebLinksAddon((_e, uri) => { window.open(uri) }))
    term.open(host)
    term.attachCustomKeyEventHandler(e => onKey(e, tab))
    term.onData(d => { if (tab.info.alive && !tab.replaying) { api.termInput(tab.info.id, d) } })
    term.onTitleChange(t => {
      // Claude pone delante un símbolo (✳, o uno que gira mientras trabaja): ya va el icono de la pestaña.
      const clean = String(t || '').replace(/[\u0000-\u001f]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
      if (!clean || clean === tab.info.title || /\\(claude|hermes|agy|pwsh|powershell)(\.exe)?$/i.test(clean)) { return }
      tab.info.title = clean
      clearTimeout(tab.titleT)
      tab.titleT = setTimeout(() => call(api.termTitle, info.id, clean).catch(() => {}), 1500)
      renderSide()
      if (T.active === info.id) { ctx.onTopbar() }
    })
    const tab = { info, term, fit, pane, bar, unread: false, userTitle: info.userTitle || '', replaying: false, closing: false }
    T.tabs.set(info.id, tab)
    if (!T.order.includes(info.id)) { T.order.push(info.id) }
    if (info.buffer) { tab.replaying = true; term.write(info.buffer, () => { tab.replaying = false }) }
    if (!info.alive) { showExit(tab) }
    return tab
  }

  function onKey(e, tab) {
    if (e.type !== 'keydown') { return true }
    const k = e.key.toLowerCase()
    // Copiar con Ctrl+C solo si hay algo seleccionado (si no, Ctrl+C va al programa: interrumpir).
    if ((e.ctrlKey && !e.altKey && k === 'c' && tab.term.hasSelection()) || (e.ctrlKey && e.shiftKey && k === 'c')) {
      const s = tab.term.getSelection()
      if (s) { navigator.clipboard.writeText(s).catch(() => {}) }
      tab.term.clearSelection()
      return false
    }
    // Pegar: lo hace el navegador (evento paste), xterm no debe mandar ^V.
    if (e.ctrlKey && !e.altKey && k === 'v') { return false }
    // Atajos de Pedila que siguen funcionando dentro de la terminal.
    if (e.ctrlKey && e.shiftKey && k === 't') { return false }
    if (e.ctrlKey && k === 'tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); return false }
    if (e.ctrlKey && e.shiftKey && k === 'w') { e.preventDefault(); closeTab(tab.info.id); return false }
    if (e.ctrlKey && k === ',') { return false }
    return true
  }

  function cycle(dir) {
    if (!T.order.length) { return }
    const i = Math.max(0, T.order.indexOf(T.active))
    activate(T.order[(i + dir + T.order.length) % T.order.length])
  }

  function showExit(tab) {
    const i = tab.info
    const bar = tab.bar
    bar.replaceChildren()
    bar.append(el('span', { class: 'grow', text: `${i.label} terminó${i.code !== null && i.code !== undefined ? ` (código ${i.code})` : ''}.` }))
    if (i.kind === 'claude' && i.sessionId) {
      bar.append(el('button', { class: 'btn-primary', text: 'Retomar la conversación', onclick: () => reopen(tab, { resume: i.sessionId }) }))
    }
    bar.append(el('button', { class: 'btn-ghost', text: 'Abrir de nuevo', onclick: () => reopen(tab, {}) }),
      el('button', { class: 'btn-ghost', text: 'Cerrar pestaña', onclick: () => closeTab(i.id) }))
    bar.hidden = false
    requestAnimationFrame(() => fitTab(tab))
  }

  async function reopen(tab, extra) {
    if (tab.reopening) { return }
    tab.reopening = true
    for (const b of tab.bar.querySelectorAll('button')) { b.disabled = true }
    const at = T.order.indexOf(tab.info.id)
    const t = await open({ kind: tab.info.kind, cwd: tab.info.cwd, ...extra }, at)
    if (t) { await closeTab(tab.info.id, { silent: true }) } else {
      tab.reopening = false
      for (const b of tab.bar.querySelectorAll('button')) { b.disabled = false }
    }
  }

  function activate(id) {
    if (!T.tabs.has(id)) { return }
    T.active = id
    for (const [tid, tab] of T.tabs) { tab.pane.classList.toggle('active', tid === id) }
    const tab = T.tabs.get(id)
    tab.unread = false
    $('#term-empty').hidden = true
    requestAnimationFrame(() => { fitTab(tab); tab.term.focus() })
    call(api.viewing, 'term', id, tab.userTitle || tab.info.title).catch(() => {})
    renderSide()
    ctx.onTopbar()
  }

  function fitTab(tab) {
    if (!tab.pane.isConnected || tab.pane.offsetWidth < 40 || tab.pane.offsetHeight < 40) { return }
    try { tab.fit.fit() } catch { return }
    const { cols, rows } = tab.term
    if (tab.info.alive && (cols !== tab.cols || rows !== tab.rows)) {
      tab.cols = cols
      tab.rows = rows
      api.termResize(tab.info.id, cols, rows)
    }
  }
  function fitAll() { if (T.mode === 'terms') { for (const tab of T.tabs.values()) { fitTab(tab) } } }

  /** Abre un programa en una pestaña nueva (en la posición `at` si se da). */
  async function open(opts, at = -1) {
    const size = guessSize()
    let info
    try {
      info = await call(api.termOpen, { ...opts, cols: size.cols, rows: size.rows })
    } catch (e) {
      ctx.toast(e.message)
      return null
    }
    const tab = makeTab(info)
    if (at >= 0) { T.order.splice(T.order.indexOf(info.id), 1); T.order.splice(at, 0, info.id) }
    if (!T.dirs.includes(info.cwd)) { T.dirs = [info.cwd, ...T.dirs].slice(0, 10) }
    activate(info.id)
    return tab
  }

  // Tamaño aproximado antes de existir la terminal (luego se ajusta al de verdad).
  function guessSize() {
    const box = $('#term-panes')
    const w = box.clientWidth || 900
    const h = box.clientHeight || 600
    const fs = fontSize()
    return { cols: Math.max(40, Math.floor((w - 16) / (fs * 0.6))), rows: Math.max(10, Math.floor((h - 12) / (fs * 1.25))) }
  }

  async function closeTab(id, { silent = false } = {}) {
    const tab = T.tabs.get(id)
    if (!tab || tab.closing) { return }
    tab.closing = true
    if (!silent && tab.info.alive && tab.info.status === 'busy') {
      const ok = await ctx.askBox({ title: 'Claude está trabajando en esta pestaña', text: 'Si la cierras, se corta lo que está haciendo. La conversación se podrá retomar después.', ok: 'Cerrar igualmente', danger: true })
      if (!ok) { tab.closing = false; return }
    }
    await call(api.termClose, id).catch(() => {})
    tab.term.dispose()
    tab.pane.remove()
    T.tabs.delete(id)
    const i = T.order.indexOf(id)
    if (i >= 0) { T.order.splice(i, 1) }
    if (T.active === id) {
      T.active = null
      const next = T.order[Math.min(i, T.order.length - 1)]
      if (next) { activate(next) } else { showEmpty() }
    }
    renderSide()
    ctx.onTopbar()
  }

  function showEmpty() {
    $('#term-empty').hidden = false
    const box = $('#term-empty-tools')
    box.replaceChildren(...T.tools.map(t => el('button', {
      class: 'term-big' + (t.available ? '' : ' off'),
      disabled: !t.available,
      title: t.available ? KIND_HINT[t.kind] : `No encuentro ${t.label} en este PC.`,
      onclick: () => { T.newKind = t.kind; openNewDialog() }
    }, el('span', { class: 'ti ' + t.kind, text: KIND_ICON[t.kind] }), el('b', { text: t.label }), el('small', { class: 'muted', text: t.available ? KIND_HINT[t.kind] : 'No instalado' }))))
  }

  // ── Diálogo «Nueva terminal» ──
  function openNewDialog() {
    if (T.mode !== 'terms') { setMode('terms') }
    const d = $('#term-new-dialog')
    if (d.open) { return }
    if (!T.newDir) { T.newDir = T.dirs[0] || T.home }
    const avail = T.tools.filter(t => t.available)
    if (!avail.some(t => t.kind === T.newKind) && avail[0]) { T.newKind = avail[0].kind }
    renderNewDialog()
    d.showModal()
    $('#tn-open').focus()
  }

  function renderNewDialog() {
    const kinds = $('#tn-kinds')
    kinds.replaceChildren(...T.tools.map(t => el('button', {
      class: 'tn-kind' + (t.kind === T.newKind ? ' active' : ''),
      disabled: !t.available,
      title: t.available ? KIND_HINT[t.kind] : `No encuentro ${t.label} en este PC.`,
      onclick: () => { T.newKind = t.kind; renderNewDialog() }
    }, el('span', { class: 'ti ' + t.kind, text: KIND_ICON[t.kind] }), el('span', { text: t.label }))))
    const sel = $('#tn-dir')
    const dirs = [...new Set([T.newDir, ...T.dirs, T.home].filter(Boolean))]
    sel.replaceChildren(...dirs.map(dd => el('option', { value: dd, text: dd, selected: dd === T.newDir })))
    $('#tn-cont-row').hidden = T.newKind !== 'claude'
    $('#tn-cont').checked = T.newCont
  }

  function wireNewDialog() {
    const d = $('#term-new-dialog')
    $('#tn-dir').addEventListener('change', e => { T.newDir = e.target.value })
    $('#tn-cont').addEventListener('change', e => { T.newCont = e.target.checked })
    $('#tn-pick').addEventListener('click', async () => {
      const dir = await call(api.termPickDir, T.newDir).catch(() => null)
      if (dir) { T.newDir = dir; renderNewDialog() }
    })
    $('#tn-cancel').addEventListener('click', () => d.close())
    $('#tn-form').addEventListener('submit', async e => {
      e.preventDefault()
      d.close()
      try { localStorage.setItem('pedila.term.kind', T.newKind) } catch {}
      await open({ kind: T.newKind, cwd: T.newDir, cont: T.newKind === 'claude' && T.newCont })
    })
  }

  // ── Barra lateral ──
  function statusOf(info) {
    if (!info.alive) { return ['exit', 'terminó'] }
    if (info.kind === 'claude' && info.status === 'busy') { return ['busy', 'trabajando…'] }
    if (info.kind === 'claude' && info.status === 'waiting') { return ['wait', 'te espera'] }
    return ['idle', '']
  }

  function renderSide() {
    if (!T.ready) { return }
    const box = $('#term-list')
    const rows = []
    if (T.restore.length) {
      const n = T.restore.length
      rows.push(el('div', { class: 'term-restore' },
        el('div', { text: n === 1 ? 'Quedó 1 terminal abierta la última vez.' : `Quedaron ${n} terminales abiertas la última vez.` }),
        el('div', { class: 'muted small', text: T.restore.map(r => `${KIND_ICON[r.kind] || ''} ${r.title || base(r.cwd)}`).join(' · ') }),
        el('div', { class: 'row-buttons' },
          el('button', { class: 'btn-primary', text: 'Reabrirlas', onclick: restoreAll }),
          el('button', { class: 'btn-ghost', text: 'Descartar', onclick: () => { T.restore = []; call(api.termRestore, 'dismiss').catch(() => {}); renderSide() } }))))
    }
    if (T.order.length) {
      rows.push(el('div', { class: 'group-label', text: 'Abiertas en Pedila' }))
      for (const id of T.order) {
        const tab = T.tabs.get(id)
        if (!tab) { continue }
        const i = tab.info
        const [st, stText] = statusOf(i)
        const title = tab.userTitle || i.title || i.label
        rows.push(el('div', { class: 'chat-row-wrap' },
          el('button', {
            class: 'chat-row term-row' + (id === T.active ? ' active' : ''),
            title: `${i.label} · ${i.cwd}`,
            onclick: () => activate(id),
            oncontextmenu: ev => { ev.preventDefault(); tabMenu(id, ev.clientX, ev.clientY) },
            onauxclick: ev => { if (ev.button === 1) { ev.preventDefault(); closeTab(id) } }
          },
          el('div', { class: 't' }, el('span', { class: 'ti small ' + i.kind, text: KIND_ICON[i.kind] }), el('span', { text: title }), st === 'busy' ? el('i', { class: 'run' }) : null, tab.unread && id !== T.active ? el('i', { class: 'unread' }) : null),
          el('div', { class: 'p' }, el('span', { text: base(i.cwd) }), stText ? el('span', { class: 'st ' + st, text: ' · ' + stText }) : null)),
          el('button', { class: 'row-more', title: 'Cerrar (Ctrl+Mayús+W)', 'aria-label': 'Cerrar terminal', text: '✕', onclick: ev => { ev.stopPropagation(); closeTab(id) } })))
      }
    }
    const outside = T.agents.filter(a => !a.term && a.kind === 'interactive')
    if (outside.length) {
      rows.push(el('div', { class: 'group-label', text: 'Claude Code en otras ventanas' }))
      for (const a of outside) {
        rows.push(el('button', {
          class: 'chat-row term-row outside',
          title: `${a.cwd}\nConversación ${a.sessionId}\nPulsa para traerla a una pestaña de Pedila.`,
          onclick: () => adoptOutside(a)
        },
        el('div', { class: 't' }, el('span', { class: 'ti small claude', text: KIND_ICON.claude }), el('span', { text: a.name || 'Claude Code' }), a.status === 'busy' ? el('i', { class: 'run' }) : null),
        el('div', { class: 'p', text: `${base(a.cwd)} · ${a.status === 'busy' ? 'trabajando…' : 'en espera'}` })))
      }
    }
    if (!rows.length) { rows.push(el('div', { class: 'list-empty', text: 'No hay consolas abiertas. Pulsa «Nueva consola» para abrir Claude Code, Hermes o PowerShell tal cual dentro de Pedila.' })) }
    box.replaceChildren(...rows)
    ctx.onChange()
  }

  function tabMenu(id, x, y) {
    const tab = T.tabs.get(id)
    if (!tab) { return }
    const items = [
      ['✏️ Renombrar', async () => {
        const v = await ctx.askBox({ title: 'Nombre de la pestaña', value: tab.userTitle || tab.info.title || tab.info.label, ok: 'Guardar' })
        if (v) { tab.userTitle = v; call(api.termTitle, id, v, true).catch(() => {}); renderSide(); ctx.onTopbar() }
      }],
      ['📁 Abrir la carpeta', () => call(api.showFile, tab.info.cwd).catch(() => {})]
    ]
    if (tab.info.kind === 'claude' && tab.info.sessionId) {
      items.push(['📋 Copiar el id de la conversación', () => navigator.clipboard.writeText(tab.info.sessionId).catch(() => {})])
    }
    items.push(['✕ Cerrar', () => closeTab(id), 'danger'])
    ctx.showPopup(items, x, y)
  }

  async function adoptOutside(a) {
    const ok = await ctx.askBox({
      title: 'Traer esta conversación a Pedila',
      text: `Se abrirá «${a.name || 'Claude Code'}» (${a.cwd}) en una pestaña nueva con «claude --resume». Cierra antes la otra ventana: si sigue abierta, la misma conversación quedaría en dos sitios a la vez.${a.status === 'busy' ? ' Ahora mismo está trabajando: mejor espera a que termine.' : ''}`,
      ok: 'Traer aquí'
    })
    if (ok) { await open({ kind: 'claude', cwd: a.cwd, resume: a.sessionId }) }
  }

  async function restoreAll() {
    const list = await call(api.termRestore, 'take').catch(() => [])
    T.restore = []
    renderSide()
    for (const r of list) {
      await open(r.kind === 'claude' && r.sessionId ? { kind: 'claude', cwd: r.cwd, resume: r.sessionId } : { kind: r.kind, cwd: r.cwd })
    }
  }

  // ── Modo ──
  function setMode(mode, { save = true } = {}) {
    T.mode = mode === 'terms' ? 'terms' : 'chats'
    $('#app').classList.toggle('mode-terms', T.mode === 'terms')
    for (const b of document.querySelectorAll('#mode-switch button')) { b.classList.toggle('active', b.dataset.mode === T.mode) }
    if (save) { call(api.settings, { terminals: { mode: T.mode } }).catch(() => {}) }
    call(api.termAgents, T.mode === 'terms').then(list => { T.agents = list || []; renderSide() }).catch(() => {})
    if (T.mode === 'chats') { ctx.onChatsMode && ctx.onChatsMode() }
    if (T.mode === 'terms') {
      if (T.active && T.tabs.has(T.active)) { activate(T.active) } else if (T.order.length) { activate(T.order[0]) } else { showEmpty(); call(api.viewing, 'term', null, '').catch(() => {}) }
    }
    ctx.onTopbar()
    ctx.onChange()
  }

  // ── Eventos del proceso principal ──
  function onEvent(evt) {
    switch (evt.kind) {
      case 'term-data': {
        const tab = T.tabs.get(evt.id)
        if (!tab) { return true }
        tab.term.write(evt.data)
        if (evt.id !== T.active || T.mode !== 'terms') {
          if (!tab.unread) { tab.unread = true; renderSide() }
        }
        return true
      }
      case 'term-exit': {
        const tab = T.tabs.get(evt.id)
        if (tab) { tab.info.alive = false; tab.info.code = evt.code; tab.info.status = null; showExit(tab); renderSide(); ctx.onTopbar() }
        return true
      }
      case 'terms': {
        for (const i of evt.list || []) {
          const tab = T.tabs.get(i.id)
          if (tab) { Object.assign(tab.info, { sessionId: i.sessionId, status: i.status, alive: i.alive, code: i.code }) }
        }
        renderSide()
        ctx.onTopbar()
        return true
      }
      case 'claude-agents':
        T.agents = evt.agents || []
        renderSide()
        return true
      case 'focus-term':
        setMode('terms')
        if (evt.id) { activate(evt.id) }
        return true
    }
    return false
  }

  async function init(settings) {
    let info
    try { info = await call(api.termInfo) } catch { info = { tools: [], dirs: [], home: '', restore: [], list: [] } }
    T.tools = info.tools || []
    T.dirs = info.dirs || []
    T.home = info.home || ''
    T.restore = info.restore || []
    for (const i of info.list || []) { makeTab(i) }
    T.ready = true
    wireNewDialog()
    for (const b of document.querySelectorAll('#mode-switch button')) { b.addEventListener('click', () => setMode(b.dataset.mode)) }
    $('#new-term').addEventListener('click', openNewDialog)
    new ResizeObserver(() => fitAll()).observe($('#term-panes'))
    // Soltar archivos en la terminal escribe su ruta (como en Windows Terminal).
    const panes = $('#term-panes')
    panes.addEventListener('dragover', e => { e.preventDefault() })
    panes.addEventListener('drop', e => {
      e.preventDefault()
      const tab = T.tabs.get(T.active)
      const files = [...(e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [])].map(f => { try { return api.pathOf ? api.pathOf(f) : '' } catch { return '' } }).filter(Boolean)
      if (tab && tab.info.alive && files.length) { api.termInput(tab.info.id, files.map(p => (/\s/.test(p) ? `"${p}"` : p)).join(' ')) }
    })
    renderSide()
    setMode(settings && settings.terminals ? settings.terminals.mode : 'chats', { save: false })
  }

  /** Una pestaña que abrió el proceso principal (p. ej. «Seguir en una consola» desde un chat). */
  function adoptTab(info) {
    if (!info || T.tabs.has(info.id)) { return }
    makeTab(info)
    setMode('terms')
    activate(info.id)
  }

  return {
    init,
    adopt: adoptTab,
    onEvent,
    applyLook,
    setMode,
    openNewDialog,
    get mode() { return T.mode },
    /** Lo que se enseña arriba: título y carpeta de la pestaña activa. */
    topbar() {
      const tab = T.tabs.get(T.active)
      if (!tab) { return { title: 'Consolas', meta: T.order.length ? '' : 'Claude Code, Hermes y consolas tal cual, dentro de Pedila' } }
      const i = tab.info
      const [, stText] = statusOf(i)
      return { title: tab.userTitle || i.title || i.label, meta: [i.label, i.cwd, stText].filter(Boolean).join(' · ') }
    },
    /** Para la mascota y el panel: cuántas pestañas de Claude están trabajando. */
    busyCount() { return [...T.tabs.values()].filter(t => t.info.alive && t.info.status === 'busy').length },
    /** Tarjeta del panel derecho con las sesiones de Claude Code (las de Pedila y las de fuera). */
    panelCard() {
      const mine = [...T.tabs.values()].filter(t => t.info.alive)
      const outside = T.agents.filter(a => !a.term && a.kind === 'interactive')
      const busy = mine.filter(t => t.info.status === 'busy').length + outside.filter(a => a.status === 'busy').length
      const rows = [
        ...mine.map(t => el('div', { class: 'sp-conn', title: t.info.cwd }, el('span', { class: 'dot ' + (t.info.status === 'busy' ? 'connecting' : 'ready') }), el('span', { text: `${KIND_ICON[t.info.kind]} ${t.userTitle || t.info.title || t.info.label}` }), el('span', { class: 's', text: statusOf(t.info)[1] || base(t.info.cwd) }))),
        ...outside.map(a => el('div', { class: 'sp-conn', title: a.cwd }, el('span', { class: 'dot ' + (a.status === 'busy' ? 'connecting' : 'off') }), el('span', { text: `${KIND_ICON.claude} ${a.name || 'Claude Code'}` }), el('span', { class: 's', text: `fuera · ${a.status === 'busy' ? 'trabajando…' : 'en espera'}` })))
      ]
      return el('section', { class: 'sp-card' },
        el('h4', {}, el('span', { class: 'grow', text: 'Consolas' }), el('span', { class: 'muted', text: busy ? `${busy} trabajando` : '' })),
        rows.length ? rows : el('div', { class: 'muted small', text: 'Ninguna abierta.' }))
    }
  }
}
