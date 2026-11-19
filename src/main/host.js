'use strict'
// Anfitrión de los chats de Claude: un programa pequeño aparte (PedilaHost.exe) que mantiene vivo
// cada `claude` aunque Pedila se cierre o se actualice. Pedila se conecta a él por una tubería con
// nombre; él guarda en un archivo todo lo que dice Claude, así que al volver Pedila se reengancha y
// repasa lo que pasó mientras tanto. Se compila la primera vez con el csc.exe que trae .NET
// Framework en Windows (nada que descargar ni instalar) y vive en los datos de Pedila, fuera de la
// carpeta del programa, para que el instalador no lo cierre al actualizar.
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

// C# 5 (el csc de .NET Framework 4 no entiende nada más nuevo).
const SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

// Pedila: mantiene vivo un claude aunque Pedila se cierre. Uso:
//   PedilaHost <tubería> <registro> <carpeta> --args <exe> [argumentos…]
//   PedilaHost <tubería> <registro> <carpeta> --raw <exe> <línea de argumentos>
static class PedilaHost {
  static Process proc;
  static StreamWriter stdin;
  static FileStream log;
  static string logPath;
  static StreamWriter client;
  static readonly object gate = new object();
  static readonly object inGate = new object();
  static long turnStart;
  static string pipeName;
  static volatile bool done;
  static DateTime lastOut = DateTime.UtcNow;
  static DateTime lastClient = DateTime.UtcNow;
  static readonly UTF8Encoding utf8 = new UTF8Encoding(false);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pattr, IntPtr tattr, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);

  static int Main(string[] a) {
    bool clean = a.Length > 0 && a[0] == "--clean";
    if (clean) { var b = new string[a.Length - 1]; Array.Copy(a, 1, b, 0, b.Length); a = b; }
    if (a.Length < 5) { return 2; }
    // Node lanza los procesos dejándoles heredar todo lo heredable de Pedila (sockets, tuberías…), y
    // este proceso lo mantendría abierto aunque Pedila se cierre. Me relanzo sin heredar nada y me voy.
    if (!clean && Relaunch(a)) { return 0; }
    pipeName = a[0];
    logPath = a[1];
    string cwd = a[2], mode = a[3], exe = a[4];
    string args;
    if (mode == "--raw") { args = a.Length > 5 ? a[5] : ""; }
    else {
      var parts = new List<string>();
      for (int i = 5; i < a.Length; i++) { parts.Add(Quote(a[i])); }
      args = string.Join(" ", parts.ToArray());
    }
    log = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
    turnStart = log.Length;
    var psi = new ProcessStartInfo(exe, args);
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.WorkingDirectory = cwd;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.StandardOutputEncoding = utf8;
    psi.StandardErrorEncoding = utf8;
    try { proc = Process.Start(psi); }
    catch (Exception e) { Emit("{\"type\":\"pedila_host\",\"event\":\"exit\",\"code\":-1,\"error\":\"" + Esc(e.Message) + "\"}"); return 1; }
    stdin = new StreamWriter(proc.StandardInput.BaseStream, utf8);
    stdin.AutoFlush = true;
    var outT = new Thread(ReadOut); outT.IsBackground = true; outT.Start();
    var errT = new Thread(ReadErr); errT.IsBackground = true; errT.Start();
    var srvT = new Thread(Serve); srvT.IsBackground = true; srvT.Start();
    var dogT = new Thread(Watchdog); dogT.IsBackground = true; dogT.Start();
    proc.WaitForExit();
    outT.Join(5000);
    Emit("{\"type\":\"pedila_host\",\"event\":\"exit\",\"code\":" + proc.ExitCode + "}");
    done = true;
    Thread.Sleep(400);
    return 0;
  }

  // Cada línea de claude: al registro (para repasarla al volver) y a Pedila si está conectado.
  static void Emit(string line) {
    var b = utf8.GetBytes(line + "\n");
    lock (gate) {
      try { log.Write(b, 0, b.Length); log.Flush(); } catch { }
      if (line.Contains("\"type\":\"result\"")) { turnStart = log.Length; }
      if (client != null) {
        try { client.Write(line); client.Write('\n'); client.Flush(); } catch { client = null; }
      }
    }
  }

  // Solo al registro (no se le devuelve a Pedila lo que ella misma mandó).
  static void LogOnly(string line) {
    var b = utf8.GetBytes(line + "\n");
    lock (gate) { try { log.Write(b, 0, b.Length); log.Flush(); } catch { } }
  }

  static void ReadOut() {
    try { string l; while ((l = proc.StandardOutput.ReadLine()) != null) { lastOut = DateTime.UtcNow; Emit(l); } } catch { }
  }

  static void ReadErr() {
    try {
      using (var f = new FileStream(logPath + ".err", FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
        string l;
        while ((l = proc.StandardError.ReadLine()) != null) { var b = utf8.GetBytes(l + "\n"); f.Write(b, 0, b.Length); f.Flush(); }
      }
    } catch { }
  }

  // La tubería: solo para este usuario. Un Pedila a la vez; al volver, otro.
  static void Serve() {
    while (!done) {
      NamedPipeServerStream s = null;
      try {
        var sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        s = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, sec);
      } catch { Thread.Sleep(1000); continue; }
      try {
        s.WaitForConnection();
        var w = new StreamWriter(s, utf8);
        lock (gate) {
          w.Write("{\"type\":\"pedila_host\",\"event\":\"hello\",\"pid\":" + proc.Id + ",\"hostPid\":" + Process.GetCurrentProcess().Id + ",\"turnStart\":" + turnStart + ",\"logEnd\":" + log.Length + "}\n");
          w.Flush();
          client = w;
        }
        lastClient = DateTime.UtcNow;
        var r = new StreamReader(s, utf8);
        string line;
        while ((line = r.ReadLine()) != null) {
          lastClient = DateTime.UtcNow;
          if (line.StartsWith("{\"type\":\"pedila_host_cmd\"")) {
            if (line.Contains("\"cmd\":\"close\"")) { lock (inGate) { try { stdin.Close(); } catch { } } }
            else if (line.Contains("\"cmd\":\"kill\"")) { try { proc.Kill(); } catch { } }
            continue;
          }
          // Lo que manda Pedila también queda apuntado (al volver sabe, p. ej., qué permisos ya contestó).
          if (line.StartsWith("{")) { LogOnly("{\"type\":\"pedila_in\",\"m\":" + line + "}"); }
          lock (inGate) { try { stdin.Write(line); stdin.Write('\n'); } catch { } }
        }
      } catch { }
      lock (gate) { client = null; }
      lastClient = DateTime.UtcNow;
      try { s.Dispose(); } catch { }
    }
  }

  // Si Pedila no vuelve en 6 horas y claude lleva 30 min callado, se cierra (claude termina lo suyo).
  static void Watchdog() {
    while (!done) {
      Thread.Sleep(60000);
      bool alone;
      lock (gate) { alone = client == null; }
      if (alone && (DateTime.UtcNow - lastClient).TotalHours > 6 && (DateTime.UtcNow - lastOut).TotalMinutes > 30) {
        lock (inGate) { try { stdin.Close(); } catch { } }
      }
    }
  }

  // Otra copia de mí con los mismos argumentos, sin heredar nada, fuera del grupo de procesos y,
  // si se puede, fuera del trabajo (job) de quien me lanzó. Si no sale, sigo yo (como antes).
  static bool Relaunch(string[] a) {
    try {
      string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
      var cmd = new StringBuilder("\"" + exe + "\" --clean");
      foreach (var x in a) { cmd.Append(' ').Append(Quote(x)); }
      var si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      si.dwFlags = 1; // STARTF_USESHOWWINDOW
      si.wShowWindow = 0; // SW_HIDE
      PROCESS_INFORMATION pi;
      const uint DETACHED = 0x8, NEW_GROUP = 0x200, BREAKAWAY = 0x1000000;
      bool ok = CreateProcess(exe, new StringBuilder(cmd.ToString()), IntPtr.Zero, IntPtr.Zero, false, DETACHED | NEW_GROUP | BREAKAWAY, IntPtr.Zero, null, ref si, out pi);
      if (!ok) { ok = CreateProcess(exe, new StringBuilder(cmd.ToString()), IntPtr.Zero, IntPtr.Zero, false, DETACHED | NEW_GROUP, IntPtr.Zero, null, ref si, out pi); }
      if (!ok) { return false; }
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      return true;
    } catch { return false; }
  }

  // Reglas de CommandLineToArgvW para pasar cada argumento tal cual.
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) { return a; }
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\', bs * 2);
    sb.Append('"');
    return sb.ToString();
  }

  static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " "); }
}
`

const VERSION = crypto.createHash('sha256').update(SOURCE).digest('hex').slice(0, 10)

function cscPath() {
  const win = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  for (const fw of ['Framework64', 'Framework']) {
    const f = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe')
    if (fs.existsSync(f)) { return f }
  }
  return null
}

/** El anfitrión listo para usar (lo compila la primera vez), o null si no se puede (sin .NET). */
function hostExe(dir, log) {
  if (process.platform !== 'win32') { return null }
  const exe = path.join(dir, `PedilaHost-${VERSION}.exe`)
  if (fs.existsSync(exe)) { return exe }
  const csc = cscPath()
  if (!csc) { if (log) { log.warn('[claude] sin csc.exe de .NET: los chats de Claude no sobrevivirán a cerrar Pedila') } return null }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const src = path.join(dir, `PedilaHost-${VERSION}.cs`)
    fs.writeFileSync(src, SOURCE)
    const tmp = exe + '.tmp.exe'
    execFileSync(csc, ['/nologo', '/target:exe', '/optimize+', '/out:' + tmp, src], { windowsHide: true, timeout: 60000, stdio: 'pipe' })
    fs.renameSync(tmp, exe)
    try { fs.unlinkSync(src) } catch {}
    // Versiones viejas del anfitrión (las que no estén en uso).
    for (const f of fs.readdirSync(dir)) { if (/^PedilaHost-[0-9a-f]+\.exe$/.test(f) && f !== path.basename(exe)) { try { fs.unlinkSync(path.join(dir, f)) } catch {} } }
    if (log) { log.info(`[claude] anfitrión de chats compilado: ${path.basename(exe)}`) }
    return exe
  } catch (e) {
    if (log) { log.warn('[claude] no pude compilar el anfitrión de chats:', String(e.stderr || e.message).slice(0, 400)) }
    return null
  }
}

const pipeName = sid => `pedila-claude-${sid}`
const pipePath = sid => `\\\\.\\pipe\\${pipeName(sid)}`

/** Arranca el anfitrión de un chat, separado de Pedila (sigue vivo si Pedila se cierra). Devuelve el
 *  pid del primer paso: el anfitrión de verdad es la copia limpia que lanza él (su pid llega en «hello»). */
function startHost(exe, { sid, logFile, cwd, cmd, args, raw, env }) {
  const argv = [pipeName(sid), logFile, cwd, raw ? '--raw' : '--args', cmd, ...(raw ? [raw] : args)]
  const child = spawn(exe, argv, { cwd, env, detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
  return child.pid
}

/** Se conecta a la tubería del anfitrión de un chat (reintenta hasta `ms`). */
function connectHost(sid, ms = 15000) {
  const until = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(pipePath(sid))
      sock.once('connect', () => { sock.removeAllListeners('error'); resolve(sock) })
      sock.once('error', e => {
        sock.destroy()
        if (Date.now() > until) { reject(new Error('el anfitrión del chat no responde: ' + e.code)) } else { setTimeout(tryOnce, 150) }
      })
    }
    tryOnce()
  })
}

/** ¿Hay un anfitrión vivo para este chat? (sin esperar) */
function hostAlive(sid) {
  return new Promise(resolve => {
    const sock = net.connect(pipePath(sid))
    const done = v => { sock.removeAllListeners(); resolve(v) }
    sock.once('connect', () => done(sock))
    sock.once('error', () => { sock.destroy(); done(null) })
  })
}

/** Las líneas del registro entre dos posiciones (lo que pasó mientras Pedila no estaba). */
function readLog(file, from, to) {
  const len = Math.max(0, Math.min(to, from + 64 * 1024 * 1024) - from)
  if (!len) { return [] }
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(len)
    fs.readSync(fd, b, 0, len, from)
    return b.toString('utf8').split('\n').filter(Boolean)
  } finally { fs.closeSync(fd) }
}

module.exports = { hostExe, startHost, connectHost, hostAlive, readLog, pipeName, VERSION, SOURCE }
