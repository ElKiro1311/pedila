'use strict'
// Puente mínimo entre la pantalla (sandbox, sin Node) y el proceso principal.
const { contextBridge, ipcRenderer } = require('electron')

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
  exportChat: (name, markdown) => call('hp:export', name, markdown),
  showFile: file => call('hp:show-file', file),
  updateCheck: () => call('hp:update-check'),
  updateInstall: () => call('hp:update-install'),
  petsSearch: params => call('hp:pets-search', params || {}),
  petsInstalled: () => call('hp:pets-installed'),
  petUse: slug => call('hp:pet-use', slug),
  openLogs: () => call('hp:open-logs'),
  testNotify: () => call('hp:test-notify'),
  onEvent: cb => {
    const h = (_e, evt) => cb(evt)
    ipcRenderer.on('hp:event', h)
    return () => ipcRenderer.removeListener('hp:event', h)
  }
})
