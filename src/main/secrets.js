'use strict'
// Encryption with safeStorage (DPAPI on Windows), asynchronous API: the synchronous one is obsolete in
// Electron 45 and goes away in 46.
const { safeStorage } = require('electron')

async function encrypt(obj) {
  const buf = await safeStorage.encryptStringAsync(JSON.stringify(obj))
  return buf.toString('base64')
}

async function decrypt(b64) {
  const out = await safeStorage.decryptStringAsync(Buffer.from(b64, 'base64'))
  return JSON.parse(out.result)
}

module.exports = { encrypt, decrypt }
