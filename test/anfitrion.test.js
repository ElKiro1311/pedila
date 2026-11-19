'use strict'
// El anfitrión de los chats de Claude (PedilaHost): mantiene vivo el proceso aunque Pedila se vaya,
// guarda lo que dice y, al volver, Pedila repasa lo que pasó. Se prueba con un eco de Node.
// Solo en Windows con el csc de .NET (en otro sitio se salta).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const h = require('../src/main/host')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedila-host-'))
const exe = process.platform === 'win32' ? h.hostExe(dir, null) : null
const SID = '55555555-2222-4333-8444-' + String(process.pid).padStart(12, '0').slice(-12)
const ECHO = "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);process.stdout.write(JSON.stringify({type:'eco',l})+'\\n');if(l==='fin')process.stdout.write(JSON.stringify({type:'result',ok:1})+'\\n')}});process.stdin.on('end',()=>process.exit(0))"

function reader(sock) {
  let buf = ''
  const out = []
  const waiters = []
  sock.setEncoding('utf8')
  sock.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1); while (waiters.length) { waiters.shift()() } }
  })
  return () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sin respuesta')), 8000)
    const take = () => { clearTimeout(t); resolve(JSON.parse(out.shift())) }
    if (out.length) { take() } else { waiters.push(take) }
  })
}

test('anfitrión: el proceso sigue vivo sin Pedila y al volver se repasa lo que pasó', { skip: !exe && 'sin Windows/.NET' }, async () => {
  const logFile = path.join(dir, SID + '.jsonl')
  const firstPid = h.startHost(exe, { sid: SID, logFile, cwd: dir, cmd: process.execPath, args: ['-e', ECHO], env: process.env })
  let sock = await h.connectHost(SID, 15000)
  let next = reader(sock)
  const hello0 = await next()
  assert.equal(hello0.event, 'hello')
  // El anfitrión de verdad es la copia limpia (sin nada heredado de Pedila), no el proceso que lanzó Node.
  const hostPid = hello0.hostPid
  assert.notEqual(hostPid, firstPid)
  sock.write('hola "con comillas" y ñ\n')
  assert.deepEqual(await next(), { type: 'eco', l: 'hola "con comillas" y ñ' })
  sock.write('fin\n')
  await next()
  assert.equal((await next()).type, 'result')
  sock.write('tras el resultado\n')
  await next()
  // Lo que manda Pedila (JSON) también queda en el registro, antes de lo que conteste claude.
  const resp = JSON.stringify({ type: 'control_response', response: { request_id: 'r1' } })
  sock.write(resp + '\n')
  await next()
  // Pedila se va: el anfitrión sigue vivo.
  sock.destroy()
  await new Promise(r => setTimeout(r, 400))
  assert.doesNotThrow(() => process.kill(hostPid, 0))
  // Pedila vuelve: «hola» dice desde dónde repasar (lo de después del último resultado).
  sock = await h.hostAlive(SID)
  assert.ok(sock)
  next = reader(sock)
  const hello = await next()
  assert.deepEqual(h.readLog(logFile, hello.turnStart, hello.logEnd).map(l => JSON.parse(l)).map(x => x.type === 'pedila_in' ? 'in:' + x.m.response.request_id : x.l), ['tras el resultado', 'in:r1', resp])
  // Cerrar: claude (aquí el eco) termina y el anfitrión avisa y se va.
  sock.write(JSON.stringify({ type: 'pedila_host_cmd', cmd: 'close' }) + '\n')
  assert.deepEqual(await next(), { type: 'pedila_host', event: 'exit', code: 0 })
  await new Promise(r => setTimeout(r, 900))
  assert.throws(() => process.kill(hostPid, 0))
  assert.equal(await h.hostAlive(SID), null)
})

// Reglas de CommandLineToArgvW (como Quote() del anfitrión).
const q = a => (a.length && !/[ \t"]/.test(a)) ? a : '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'

test('anfitrión: no se queda con nada heredado de quien lo lanzó (sockets, tuberías…)', { skip: !exe && 'sin Windows/.NET' }, async () => {
  // Quien lanza (aquí PowerShell; en la vida real, Node) deja heredar una tubería; si el anfitrión
  // se la quedara, el otro extremo nunca vería el final (pasó con el puerto de depuración de Pedila).
  const sid = '55555555-3333-4333-8444-' + String(process.pid).padStart(12, '0').slice(-12)
  const logFile = path.join(dir, sid + '.jsonl')
  const ps1 = path.join(dir, 'heredar.ps1')
  fs.writeFileSync(ps1, [
    "$srv = New-Object System.IO.Pipes.AnonymousPipeServerStream([System.IO.Pipes.PipeDirection]::In, [System.IO.HandleInheritability]::Inheritable)",
    '$psi = New-Object System.Diagnostics.ProcessStartInfo($env:H_EXE, $env:H_ARGS)',
    '$psi.UseShellExecute = $false',
    '$psi.CreateNoWindow = $true',
    '$p = [System.Diagnostics.Process]::Start($psi)',
    '$srv.DisposeLocalCopyOfClientHandle()',
    '$buf = New-Object byte[] 1',
    '$t = $srv.ReadAsync($buf, 0, 1)',
    "try { if ($t.Wait(8000)) { 'CERRADA' } else { 'ABIERTA' } } catch { 'CERRADA' }"
  ].join('\r\n'))
  const args = [h.pipeName(sid), logFile, dir, '--args', process.execPath, '-e', ECHO].map(q).join(' ')
  const out = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    env: { ...process.env, H_EXE: exe, H_ARGS: args }, encoding: 'utf8', timeout: 30000, windowsHide: true
  })
  // Cerrar el anfitrión de esta prueba pase lo que pase.
  const sock = await h.connectHost(sid, 15000)
  const next = reader(sock)
  assert.equal((await next()).event, 'hello')
  sock.write(JSON.stringify({ type: 'pedila_host_cmd', cmd: 'close' }) + '\n')
  assert.deepEqual(await next(), { type: 'pedila_host', event: 'exit', code: 0 })
  assert.equal(out.trim(), 'CERRADA')
})

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
