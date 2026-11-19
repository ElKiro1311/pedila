'use strict'
// Puente mínimo entre la pantalla (sandbox, sin Node) y el proceso principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args)

contextBridge.exposeInMainWorld('hp', {
  init: () => call('hp:init'),
  sessions: conn => call('hp:sessions', conn),
  transcript: (conn, sid) => call('hp:transcript', conn, sid),
  attach: (conn, sid) => call('hp:attach', conn, sid),
  newChat: (conn, opts) => call('hp:new', conn, opts || {}),
  send: (conn, sid, text, attachments) => call('hp:send', conn, sid, text, attachments || []),
  stop: (conn, sid) => call('hp:stop', conn, sid),
  answer: (conn, key, value) => call('hp:answer', conn, key, value),
  models: conn => call('hp:models', conn),
  login: (user, pass) => call('hp:login', user, pass),
  logout: () => call('hp:logout'),
  retry: conn => call('hp:retry', conn),
  settings: patch => call('hp:settings', patch || null),
  viewing: (conn, sid, title) => call('hp:viewing', conn, sid, title || ''),
  archived: conn => call('hp:archived', conn),
  search: (conn, q) => call('hp:search', conn, q),
  mutate: (conn, sid, op, value) => call('hp:mutate', conn, sid, op, value),
  attachImage: (conn, sid, b64, name) => call('hp:attach-image', conn, sid, b64, name),
  usage: conn => call('hp:usage', conn),
  subagents: (conn, sid) => call('hp:subagents', conn, sid),
  chatOptions: (conn, sid, opts) => call('hp:chat-options', conn, sid, opts || null),
  quotas: (conn, fresh) => call('hp:quotas', conn, Boolean(fresh)),
  quotasInstall: (conn, force) => call('hp:quotas-install', conn, Boolean(force)),
  media: (conn, file) => call('hp:media', conn, file),
  exportChat: (name, markdown) => call('hp:export', name, markdown),
  showFile: file => call('hp:show-file', file),
  updateCheck: () => call('hp:update-check'),
  updateInstall: () => call('hp:update-install'),
  petsSearch: params => call('hp:pets-search', params || {}),
  petsInstalled: () => call('hp:pets-installed'),
  petUse: slug => call('hp:pet-use', slug),
  openLogs: () => call('hp:open-logs'),
  testNotify: () => call('hp:test-notify'),
  // Terminales (Claude Code, Hermes, Antigravity, PowerShell dentro de Pedila).
  termInfo: () => call('hp:term-info'),
  termOpen: opts => call('hp:term-open', opts || {}),
  termClose: id => call('hp:term-close', id),
  termTitle: (id, title, byUser) => call('hp:term-title', id, title, Boolean(byUser)),
  termPickDir: start => call('hp:term-pick-dir', start || ''),
  termForgetDir: dir => call('hp:term-forget-dir', dir),
  termAgents: (watch, reason) => call('hp:term-agents', Boolean(watch), reason === 'chats' ? 'chats' : 'consolas'),
  termRestore: action => call('hp:term-restore', action),
  termInput: (id, data) => ipcRenderer.send('hp:term-input', id, data),
  termResize: (id, cols, rows) => ipcRenderer.send('hp:term-resize', id, cols, rows),
  pathOf: file => webUtils.getPathForFile(file),
  onEvent: cb => {
    const h = (_e, evt) => cb(evt)
    ipcRenderer.on('hp:event', h)
    return () => ipcRenderer.removeListener('hp:event', h)
  }
})
