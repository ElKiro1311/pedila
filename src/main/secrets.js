'use strict'
// Cifrado con safeStorage (DPAPI en Windows), API asíncrona: la síncrona está obsoleta en
// Electron 45 y desaparece en la 46.
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
