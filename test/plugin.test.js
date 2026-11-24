'use strict'
// Hermes's "pedila" plugin (Python): its tests are in test/plugin/test_quotas_core.py and are launched
// here with the Python that Hermes brings (it has httpx and fastapi). Without Hermes on this PC, they're
// skipped.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function hermesPython() {
  const tools = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools')
  let dirs = []
  try { dirs = fs.readdirSync(tools).filter(d => /^python-/i.test(d)).sort().reverse() } catch { return null }
  for (const d of dirs) {
    const exe = path.join(tools, d, 'python.exe')
    if (fs.existsSync(exe)) { return exe }
  }
  return null
}

const py = hermesPython()

test("Hermes plugin: the quotas' calculation (Python)", { skip: py ? false : "without Hermes's Python on this PC" }, () => {
  const r = spawnSync(py, ['-I', '-B', '-X', 'utf8', path.join(__dirname, 'plugin', 'test_quotas_core.py')], { encoding: 'utf8', timeout: 120000, windowsHide: true })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  assert.equal(r.status, 0, out.slice(-4000))
  assert.match(out, /\nOK/)
})
