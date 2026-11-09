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
  send: (conn, sid, text) => call('hp:send', conn, sid, text),
  stop: (conn, sid) => call('hp:stop', conn, sid),
  answer: (conn, key, value) => call('hp:answer', conn, key, value),
  models: conn => call('hp:models', conn),
  login: (user, pass) => call('hp:login', user, pass),
  logout: () => call('hp:logout'),
  retry: conn => call('hp:retry', conn),
  settings: patch => call('hp:settings', patch || null),
  viewing: (conn, sid, title) => call('hp:viewing', conn, sid, title || ''),
  openLogs: () => call('hp:open-logs'),
  testNotify: () => call('hp:test-notify'),
  onEvent: cb => {
    const h = (_e, evt) => cb(evt)
    ipcRenderer.on('hp:event', h)
    return () => ipcRenderer.removeListener('hp:event', h)
  }
})
