'use strict'
// One connection with a Hermes ("This PC" or "Server"). It speaks the gateway's two protocols:
// - canonical (gateway.ready brings session_authority: true; Hermes 0.23 on the PC): create with
// request_id, submit with submission_id, and stop/permissions/questions with execution_generation;
// permissions and questions arrive as approval.request / clarify.request events;
// - classic (Hermes 0.22 on the server): permissions and questions arrive as requests from the server
// ('approval', 'clarify') that are answered in the request itself.
// Towards the interface everything goes out in a single format ({kind, conn, sid, …}) and with the chat's
// STORED id (the one in the list), even though the live id travels on the socket.
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const { RpcSocket } = require('./rpc')
const { modelUsageFrom, newer } = require('./extras')
const { tr } = require('./i18n')

const BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000]
// Hermes's statistics by model: the last year, refreshed every 5 min at most (working them out costs
// Hermes); if that Hermes doesn't have them, they aren't asked for again for 30 min, and after a passing
// failure, for 2 min.
const MODEL_STATS_DAYS = 365
const MODEL_STATS_TTL = 5 * 60000
const MODEL_STATS_MISSING_TTL = 30 * 60000
const MODEL_STATS_FAIL_PAUSE = 2 * 60000
const COLS = 100

const str = v => (typeof v === 'string' ? v : '')
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// The Hermes plugin that reads the quotas (the hermes-plugin/pedila folder of this repository).
const QUOTA_PLUGIN = 'pedila'
const QUOTA_PLUGIN_SOURCE = 'ElKiro1311/pedila/hermes-plugin/pedila'
const QUOTA_KINDS = ['openrouter', 'venice', 'opencode-go', 'opencode-zen', 'deepseek', 'openference']
// The plugin version this Pedila knows how to show in full (1.4.0: the models used with
// each API; 1.3.0: DeepSeek and Openference; 1.2.0: every key of a provider, and OpenCode Go with decimals). With an earlier one, updating it is offered. From 1.2.0 on its calculation reloads by itself
// (without restarting Hermes).
const QUOTA_PLUGIN_WANT = '1.4.0'
const QUOTA_PLANS = ['go', 'go-teams', 'go-plus']
const INSTALL_TIMEOUT = 180000

/** Which paid API it is, by its address? (the same rules as the plugin). */
function paidKindOf(u) {
  try {
    const p = new URL(String(u || ''))
    const h = p.hostname.toLowerCase()
    if (h === 'openrouter.ai' || h.endsWith('.openrouter.ai')) { return 'openrouter' }
    if (h === 'api.venice.ai' || h.endsWith('.venice.ai')) { return 'venice' }
    if (h === 'opencode.ai' || h.endsWith('.opencode.ai')) { return p.pathname.toLowerCase().includes('/go') ? 'opencode-go' : 'opencode-zen' }
    if (h === 'api.deepseek.com') { return 'deepseek' }
    if (h === 'api.openference.com') { return 'openference' }
  } catch {}
  return null
}

/** Hermes gives its own providers without an address: they're known by their name. */
function paidKindOfProvider(pv) {
  const url = pv.api_url || pv.base_url
  if (url) { return paidKindOf(url) }
  const slug = str(pv.slug).toLowerCase()
  return pv.authenticated !== false && pv.is_user_defined !== true && ['openrouter', 'opencode-go', 'opencode-zen', 'deepseek'].includes(slug) ? slug : null
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isoOf = v => (typeof v === 'string' && v && Number.isFinite(Date.parse(v)) ? v : null)

/** The plugin's answer, cleaned up: only the fields and types the screen knows how to paint. */
function quotaData(j) {
  const spentOf = s => {
    if (!s || typeof s !== 'object') { return null }
    const n = v => Math.max(0, num(v) || 0)
    // `models` = model by model (plugin 1.4.0); null with an earlier one.
    const one = p => {
      p = p && typeof p === 'object' ? p : {}
      const models = Array.isArray(p.models)
        ? p.models.filter(m => m && typeof m === 'object' && str(m.model)).slice(0, 12)
          .map(m => ({ model: cut(m.model, 80), tokens: n(m.tokens), input: n(m.input), output: n(m.output), cache: n(m.cache), calls: n(m.calls), cost: n(m.cost) }))
        : null
      const others = models && p.others && typeof p.others === 'object' && n(p.others.models) ? { models: Math.round(n(p.others.models)), tokens: n(p.others.tokens) } : null
      return { tokens: num(p.tokens) || 0, calls: num(p.calls) || 0, cost: num(p.cost) || 0, cache: n(p.cache), models, others }
    }
    return { day: one(s.day), week: one(s.week), month: one(s.month) }
  }
  // One of several keys of the same API (Hermes's credential pool): which one, whether Hermes uses it now
  // (null = they take turns) and until when it's resting.
  const accountOf = a => (a && typeof a === 'object' && num(a.of) > 1
    ? { id: cut(str(a.id), 20), n: Math.max(1, Math.round(num(a.n) || 1)), of: Math.round(a.of), active: typeof a.active === 'boolean' ? a.active : null, resting: a.resting === true, until: isoOf(a.until), hidden: Math.max(0, Math.round(num(a.hidden) || 0)) }
    : null)
  const providers = (Array.isArray(j.providers) ? j.providers : []).filter(p => p && QUOTA_KINDS.includes(p.kind)).slice(0, 30).map(p => {
    const o = { kind: p.kind, name: cut(str(p.name) || p.kind, 40), ok: p.ok !== false, error: p.ok === false ? cut(str(p.error) || tr("couldn't be read"), 200) : '', noApi: Boolean(p.no_api), spent: spentOf(p.spent), spentAll: spentOf(p.spent_all), account: accountOf(p.account) }
    if (p.kind === 'openrouter') {
      const kl = p.key_limit && typeof p.key_limit === 'object' ? p.key_limit : null
      const ku = p.key_usage && typeof p.key_usage === 'object' ? p.key_usage : {}
      Object.assign(o, {
        balance: num(p.balance), creditsTotal: num(p.credits_total), creditsUsed: num(p.credits_used),
        freeTier: typeof p.free_tier === 'boolean' ? p.free_tier : null,
        keyLimit: kl && num(kl.limit) ? { limit: num(kl.limit), remaining: num(kl.remaining), reset: ['daily', 'weekly', 'monthly'].includes(kl.reset) ? kl.reset : null } : null,
        keyUsage: { total: num(ku.total), day: num(ku.day), week: num(ku.week), month: num(ku.month) }
      })
    } else if (p.kind === 'venice') {
      Object.assign(o, {
        usd: num(p.usd), diem: num(p.diem), bundled: num(p.bundled), tier: cut(str(p.tier), 30),
        access: typeof p.access === 'boolean' ? p.access : null, nextEpoch: isoOf(p.next_epoch), keyExpires: isoOf(p.key_expires),
        modelLimits: (Array.isArray(p.model_limits) ? p.model_limits : []).slice(0, 12).filter(m => m && typeof m.model === 'string')
          .map(m => ({ model: cut(m.model, 80), rpm: num(m.rpm), rpd: num(m.rpd), tpm: num(m.tpm) }))
      })
    } else if (p.kind === 'opencode-go') {
      const pct = v => (num(v) === null ? null : Math.max(0, Math.min(100, num(v))))
      const count = v => (num(v) === null ? null : Math.max(0, num(v)))
      // percent = what OpenCode says (whole, rounded down); estimate = with decimals (plugin 1.1.0).
      o.windows = (Array.isArray(p.windows) ? p.windows : []).slice(0, 4).filter(w => w && num(w.percent) !== null)
        .map(w => ({
          id: cut(str(w.id), 20), label: cut(str(w.label), 20), percent: pct(w.percent), resetsAt: isoOf(w.resets_at),
          estimate: pct(w.estimate), cost: count(w.cost), tokens: count(w.tokens), calls: count(w.calls)
        }))
      o.plan = QUOTA_PLANS.includes(p.plan) ? p.plan : null
      o.unpriced = (Array.isArray(p.unpriced) ? p.unpriced : []).filter(x => typeof x === 'string' && x).slice(0, 8).map(x => cut(x, 80))
      o.catalog = typeof p.catalog === 'boolean' ? p.catalog : null
    } else if (p.kind === 'deepseek') {
      o.balances = (Array.isArray(p.balances) ? p.balances : []).filter(b => b && num(b.total) !== null).slice(0, 4)
        .map(b => ({ currency: ['USD', 'CNY'].includes(b.currency) ? b.currency : '', total: num(b.total), granted: num(b.granted), toppedUp: num(b.topped_up) }))
      o.available = typeof p.available === 'boolean' ? p.available : null
    } else if (p.kind === 'openference') {
      const count = v => (num(v) === null ? null : Math.max(0, num(v)))
      const au = p.account_usage && typeof p.account_usage === 'object' ? p.account_usage : {}
      Object.assign(o, {
        balance: num(p.balance), creditsTotal: num(p.credits_total), planName: cut(str(p.plan_name), 30),
        subscribed: p.subscribed === true, expiresAt: isoOf(p.expires_at), active: typeof p.active === 'boolean' ? p.active : null,
        windows: (Array.isArray(p.windows) ? p.windows : []).filter(w => w && num(w.percent) !== null).slice(0, 4)
          .map(w => ({
            id: cut(str(w.id), 20), percent: Math.max(0, Math.min(100, num(w.percent))), resetsAt: isoOf(w.resets_at), hours: num(w.hours),
            used: count(w.used), limit: count(w.limit), unit: w.unit === 'tokens' ? 'tokens' : 'requests'
          })),
        usage: { requests: count(au.requests), tokens: count(au.tokens), cost: count(au.cost) },
        freeModels: (Array.isArray(p.free_models) ? p.free_models : []).filter(m => m && typeof m.model === 'string' && m.model).slice(0, 12)
          .map(m => ({ model: cut(m.model, 80), until: /^\d{4}-\d{2}-\d{2}$/.test(str(m.until)) ? isoOf(m.until) : null }))
      })
    }
    return o
  })
  return { version: cut(str(j.version), 20), shell: cut(str(j.shell), 20), shellStale: j.shell_stale === true, fetchedAt: isoOf(j.fetched_at), providers }
}

/** Is the plugin that Hermes has older than the one this Pedila knows how to show? */
function quotaPluginOutdated(version) {
  return !version || newer(QUOTA_PLUGIN_WANT, version)
}

/** Did Hermes's security scan stop it? What it found, for the person to decide (null if it wasn't that). */
function scanOf(j, detail) {
  if (!j.scan_blocked && !/security scan blocked/i.test(detail)) { return null }
  const report = str(j.scan_verdict) || detail
  const lines = Array.isArray(j.scan_findings)
    ? j.scan_findings.map(f => (typeof f === 'string' ? f : str(f && (f.message || f.description || f.rule || f.pattern))))
    : detail.split(/\r?\n/).slice(1)
  return {
    ok: false,
    scan: /dangerous/i.test(report) ? 'dangerous' : 'caution',
    findings: lines.map(x => x.trim()).filter(x => x && !/^review the findings|scanning can be configured/i.test(x)).slice(0, 12).map(x => cut(x, 300))
  }
}

/** Is the provider's address on your network (or on this machine)? Then the model is local. */
function isLocalUrl(u) {
  try {
    const h = new URL(String(u || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!h) { return false }
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h === '::1') { return true }
    const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
    if (!m) { return false }
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
  } catch { return false }
}

function contentText(c) {
  if (typeof c === 'string') { return c }
  if (Array.isArray(c)) {
    return c.map(p => (typeof p === 'string' ? p : p && p.type === 'text' ? str(p.text) : p && /image/.test(p.type || '') ? tr('[image]') : '')).filter(Boolean).join('\n')
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') { return c.text }
  return ''
}

function argsSummary(args, argsText) {
  if (args && typeof args === 'object') {
    const first = ['command', 'query', 'url', 'path', 'file_path', 'prompt', 'pattern', 'code', 'name']
      .map(k => args[k]).find(v => typeof v === 'string' && v.trim())
    if (first) { return cut(first.replace(/\s+/g, ' ').trim(), 140) }
    try { return cut(JSON.stringify(args), 140) } catch {}
  }
  return cut(str(argsText).replace(/\s+/g, ' ').trim(), 140)
}

// ── Hermes's task list (its todo_list tool, like Claude Code's) ─────────────────────────────────
const TODO_TOOLS = new Set(['todo_list', 'todo'])
const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled']

/**
 * {todos, revision} cleaned up for the interface, or null (an empty list without a revision = there's no
 * plan).
 */
function todoSnapshot(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.todos)) { return null }
  const todos = v.todos.filter(t => t && typeof t === 'object').slice(0, 256).map(t => ({
    id: cut(str(t.id) || String(t.id ?? '') || '?', 80),
    content: cut(str(t.content).replace(/\s+/g, ' ').trim(), 400),
    status: TODO_STATUSES.includes(t.status) ? t.status : 'pending',
    parent: cut(str(t.parent), 80)
  })).filter(t => t.content)
  const n = Number(v.revision)
  const revision = Number.isFinite(n) ? n : null
  if (!todos.length && !revision) { return null }
  return { todos, revision }
}

/** Is it a call to the task list? Also through `tool_call`, the tool finder's bridge. */
function isTodoCall(c) {
  const fn = c && c.function ? c.function : c || {}
  const name = str(fn.name || (c && c.name))
  if (TODO_TOOLS.has(name)) { return true }
  if (name !== 'tool_call') { return false }
  let args = fn.arguments ?? (c && c.args)
  try {
    if (typeof args === 'string') { args = JSON.parse(args) }
    let calls = args && (args.calls ?? (args.name ? [{ name: args.name }] : null))
    if (typeof calls === 'string') { calls = JSON.parse(calls) }
    if (calls && !Array.isArray(calls)) { calls = [calls] }
    return Array.isArray(calls) && calls.length === 1 && TODO_TOOLS.has(str(calls[0] && calls[0].name))
  } catch { return false }
}

/**
 * The task list of a stored chat: the most recent result of a call to the tool (as Hermes does on resuming).
 * A loose result without its call doesn't count.
 */
function todoStateOf(rows) {
  const ids = new Set()
  for (const r of rows) {
    if (!r || r.role !== 'assistant' || !Array.isArray(r.tool_calls)) { continue }
    for (const c of r.tool_calls) { if (c && (c.id || c.tool_call_id) && isTodoCall(c)) { ids.add(c.id || c.tool_call_id) } }
  }
  if (!ids.size) { return null }
  const newest = [...rows].filter(r => r && r.role === 'tool' && ids.has(r.tool_call_id)).sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
  // As Hermes does: the newest readable result wins, even if it's an empty list (then, no plan).
  for (const r of newest) {
    const text = contentText(r.content)
    if (!text.includes('"todos"') || text.length > 512000) { continue }
    let data
    try { data = JSON.parse(text) } catch { continue }
    return todoSnapshot(data)
  }
  return null
}

function toolCallsOf(row) {
  const calls = Array.isArray(row.tool_calls) ? row.tool_calls : []
  return calls.map(c => {
    const fn = c && c.function ? c.function : c || {}
    let args = fn.arguments ?? c.args
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = { _: args } } }
    return { id: c.id || c.tool_call_id || '', name: str(fn.name || c.name) || tr('tool'), args: argsSummary(args), input: boundInput(args) }
  })
}

// ── Tool details (as in Claude Code: what it was given and what it returned) ─────────────────
const MAX_FIELD = 6000 // each text given to a tool
const MAX_OUTPUT = 8000 // what it returned

/** A bounded copy of what a tool was given (long texts cut, no cycles). */
function boundInput(v, depth = 0, max = MAX_FIELD) {
  if (typeof v === 'string') { return v.length > max ? v.slice(0, max) + tr('\n… (cut short)') : v }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') { return v }
  if (depth > 4) { return '…' }
  if (Array.isArray(v)) { return v.slice(0, 60).map(x => boundInput(x, depth + 1, max)) }
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).slice(0, 40)) { out[k] = boundInput(v[k], depth + 1, max) }
    return out
  }
  return null
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const capText = s => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + tr('\n… (cut short)') : s)

/**
 * What a Hermes tool returned, to be read: { text, error }.
 * Hermes stores results as JSON; the terminal's brings output, exit_code and error.
 * Failure is decided as in Hermes (agent/display.py _detect_tool_failure), only by its shape.
 */
// The same rules as Hermes (agent/display.py _detect_tool_failure and
// agent/tool_result_classification.py): a failure by the shape of the JSON or, if it isn't JSON, by the
// text.
const FAILURE_MARKER = /"(?:error|failed)"(?!\s*:\s*(?:null|false|0|""|\[\]|\{\})\s*(?:[,}\]]|$))/gi
function hermesFailed(name, raw, data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // A file that was written or a patch that was really applied is never a failure.
    if (name === 'write_file' && !data.error && 'bytes_written' in data) { return false }
    if (name === 'patch' && !data.error && data.success === true) { return false }
    // A refusal by the harness (a repeated call) isn't a failure.
    if (data.guardrail_refusal === true) { return false }
    if (data.user_summary) { return true }
    if (name === 'terminal') { const ec = data.exit_code; return !(ec === undefined || ec === null || ec === 0) }
    const err = data.error || data.message
    if (err && (data.success === false || 'error' in data)) { return true }
    if (['failed', 'error'].includes(String(data.status || '').toLowerCase())) { return true }
    const items = data.results
    if (Array.isArray(items) && items.length && items.every(i => i && typeof i === 'object' && !Array.isArray(i)) && items.every(i => i.error)) { return true }
    return false
  }
  if (!raw) { return false }
  if (raw.startsWith('Error')) { return true }
  const head = raw.slice(0, 600)
  FAILURE_MARKER.lastIndex = 0
  let m
  while ((m = FAILURE_MARKER.exec(head))) { if (m.index < 500) { return true } }
  return false
}

/** From a JSON cut short by Hermes ({"output": "<cut json>", "truncated": true}), the text inside. */
function innerText(s) {
  const m = /"(?:output|stdout|content|result|error)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s)
  if (!m) { return s }
  try { return JSON.parse('"' + m[1].replace(/\\$/, '') + '"') } catch { return m[1].replace(/\\n/g, '\n') }
}

function hermesToolOutput(name, result, isError) {
  const raw = typeof result === 'string' ? result : result === undefined || result === null ? '' : JSON.stringify(result)
  let data = null
  if (result && typeof result === 'object') { data = result } else if (/^\s*[{[]/.test(raw)) { try { data = JSON.parse(raw) } catch {} }
  const error = typeof isError === 'boolean' ? isError : hermesFailed(name, raw, data)
  let text = raw
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.truncated === true && (typeof data.output === 'string' || typeof data.error === 'string')) {
      // Cut short by Hermes: what's inside is usually another JSON; its text is taken out.
      text = innerText(str(data.output || data.error)) + tr('\n… (cut short by Hermes)')
    } else if (typeof data.output === 'string' || typeof data.stdout === 'string') {
      const bits = [str(data.output || data.stdout)]
      if (str(data.stderr)) { bits.push(str(data.stderr)) }
      if (data.error) { bits.push('Error: ' + (typeof data.error === 'string' ? data.error : JSON.stringify(data.error))) }
      if (data.exit_code !== undefined && data.exit_code !== null && data.exit_code !== 0) { bits.push(tr('(finished with code {0})', data.exit_code)) }
      text = bits.filter(Boolean).join('\n')
    } else if (data.user_summary) {
      text = str(data.user_summary)
    } else if (error && typeof data.error === 'string') {
      text = data.error
    } else if (typeof data.content === 'string') {
      text = data.content
    } else if (typeof data.result === 'string') {
      // MCP tools: {"result": text}.
      text = data.result
    } else {
      try { text = JSON.stringify(data, null, 2) } catch {}
    }
  }
  return { text: capText(text.replace(ANSI, '')), error }
}

/** Images that come inside a message (image_url parts with data:): [{url, name}]. */
function contentImages(c) {
  if (!Array.isArray(c)) { return [] }
  const out = []
  for (const p of c) {
    const url = p && (p.type === 'image_url' ? str(p.image_url && (p.image_url.url || p.image_url)) : p.type === 'image' && p.source && p.source.type === 'base64' ? `data:${str(p.source.media_type) || 'image/png'};base64,${str(p.source.data)}` : '')
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/.test(url) && url.length < 6 * 1024 * 1024) { out.push({ url, name: tr('image') }) }
    if (out.length >= 6) { break }
  }
  return out
}

// "User" rows that Hermes really writes (memory summaries, notices of processes or subagents): they're
// shown as a collapsible note, not as a message of yours.
const NOTE_KINDS = { internal_notification: 'Hermes notice', process_complete: 'A process finished', async_delegation_complete: 'A subagent finished', model_switch: 'Model change' }
// Marks from agent/context_compressor.py: when compacting, Hermes joins the summary with a message of
// yours in the same row (in front, or with the message from before as "PRIOR CONTEXT").
const SUMMARY_END = '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
const PRIOR_HEAD = '[PRIOR CONTEXT — for reference only; not a new message]'
const PRIOR_DELIM = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]'
/** { summary, message } if the row brings a compaction summary; null if not. */
function splitCompaction(raw) {
  const i = raw.indexOf(SUMMARY_END)
  if (i >= 0) { return { summary: raw.slice(0, i).trim(), message: raw.slice(i + SUMMARY_END.length).trim() } }
  const j = raw.indexOf(PRIOR_DELIM)
  if (raw.startsWith(PRIOR_HEAD) && j >= 0) { return { summary: raw.slice(j + PRIOR_DELIM.length).trim(), message: raw.slice(PRIOR_HEAD.length, j).trim() } }
  if (/^\[CONTEXT COMPACTION/.test(raw)) { return { summary: raw, message: '' } }
  return null
}
const compactionNote = (r, text) => ({ role: 'note', kind: 'compaction', title: tr('Hermes summarized the earlier conversation so that it fits'), text, ts: r.timestamp || null })
function noteOf(r, text) {
  if (NOTE_KINDS[r.display_kind]) { return { role: 'note', kind: r.display_kind, title: tr(NOTE_KINDS[r.display_kind]), text, ts: r.timestamp || null } }
  return null
}

/** Stored rows of /api/sessions/{id}/messages → turns for the interface. */
const MAX_TRANSCRIPT_IMAGES = 8 * 1024 * 1024
function normalizeTranscript(rows) {
  const out = []
  let turn = null
  let imageBytes = 0
  const sorted = [...rows].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
  for (const r of sorted) {
    if (!r || r.active === false || r.display_kind === 'hidden') { continue }
    if (r.role === 'user') {
      turn = null
      const raw = contentText(r.content)
      const note = raw.trim() ? noteOf(r, raw) : null
      if (note) { out.push(note); continue }
      // What is shown is display_content if Hermes gives it (like Hermes Desktop): your message without
      // the wrapping (compaction summary, "OUT-OF-BAND USER MESSAGE"…).
      const hasDisplay = r.display_content !== undefined && r.display_content !== null
      const comp = splitCompaction(raw)
      if (comp && comp.summary) { out.push(compactionNote(r, comp.summary)) }
      const text = hasDisplay ? contentText(r.display_content) : comp ? comp.message : raw
      // Images: with a cap for the whole conversation (they're base64 and travel to the screen).
      let images = contentImages(hasDisplay ? r.display_content : r.content)
      const bytes = images.reduce((n, x) => n + x.url.length, 0)
      if (imageBytes + bytes > MAX_TRANSCRIPT_IMAGES) { images = [] } else { imageBytes += bytes }
      const shown = images.length ? text.replace(/^\[imagen\]\n?/gm, '').trim() : text
      if (shown.trim() || images.length) { out.push({ role: 'user', text: shown, ts: r.timestamp || null, ...(images.length ? { images } : {}) }) }
    } else if (r.role === 'assistant') {
      if (!turn) { turn = { role: 'assistant', blocks: [], reasoning: '', ts: r.timestamp || null }; out.push(turn) }
      const reasoning = str(r.reasoning || r.reasoning_content)
      if (reasoning) { turn.reasoning += (turn.reasoning ? '\n\n' : '') + reasoning }
      const text = contentText(r.content)
      if (text.trim()) { turn.blocks.push({ type: 'text', text }) }
      for (const c of toolCallsOf(r)) { turn.blocks.push({ type: 'tool', id: c.id, name: c.name, args: c.args, input: c.input, done: false }) }
    } else if (r.role === 'tool') {
      if (!turn) { continue }
      const b = turn.blocks.find(x => x.type === 'tool' && !x.done && (!r.tool_call_id || x.id === r.tool_call_id))
      if (b) {
        const o = hermesToolOutput(b.name, typeof r.content === 'string' ? r.content : contentText(r.content), null)
        b.done = true
        b.summary = cut(o.text.replace(/\s+/g, ' ').trim(), 160)
        b.output = o.text
        b.error = o.error
      }
    }
  }
  for (const t of out) { if (t.blocks) { for (const b of t.blocks) { if (b.type === 'tool') { b.done = true } } } }
  return out
}

function sessionRow(r) {
  return {
    id: r.id,
    title: str(r.title) || str(r.preview).slice(0, 60) || tr('Untitled chat'),
    preview: cut(str(r.preview).replace(/\s+/g, ' ').trim(), 120),
    lastActive: r.last_active || r.last_activity_at || r.started_at || null,
    messages: r.message_count || 0,
    model: str(r.model),
    // `is_active` = the chat is loaded in the gateway (not that it's answering now).
    active: Boolean(r.is_active),
    source: str(r.source),
    pinned: Boolean(r.pinned),
    archived: Boolean(r.archived),
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    startedAt: r.started_at || null
  }
}

class Connection extends EventEmitter {
  constructor({ id, name, transport, log, Socket = RpcSocket }) {
    super()
    this.Socket = Socket
    this.id = id
    this.name = name
    this.transport = transport
    this.log = log
    this.state = 'off'
    this.detail = ''
    this.canonical = false
    this.socket = null
    this.stopped = true
    this.connecting = false
    this.epoch = 0 // goes up when stopping or reconnecting: an attempt from before is no longer good
    this.origin = '' // where the open socket goes ("ws://192.168.1.50:9119")
    this.attempt = 0
    this.retryTimer = null
    this.live = new Map() // stored id → { liveId, generation, running }
    this.liveToStored = new Map()
    this.prompts = new Map() // key → { kind, sid, liveId, promptId?, serverRequestId?, generation? }
    this.turnStart = new Map()
    this.version = null
    this.modelStats = null // { at, models } of the last modelUsage() query
    this.modelStatsPending = null
    this.modelStatsFailAt = null // when the last one failed (a passing failure); null if it didn't
    this.modelStatsEpoch = 0 // goes up when the connection is lost: whatever arrives from before is no longer good
  }

  ui(evt) {
    this.emit('ui', { ...evt, conn: this.id })
  }

  setState(state, detail = '') {
    if (state === this.state && detail === this.detail) { return }
    // On reconnecting it may be another server, another session or a restarted Hermes: new statistics.
    if (state !== 'ready') { this.forgetModelStats() }
    this.state = state
    this.detail = detail
    this.log.info(`[${this.id}] state ${state}${detail ? ' · ' + detail : ''}`)
    this.ui({ kind: 'conn', state, detail })
    this.emit('state', state)
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.dropSocket()
    this.transport.dispose()
  }

  /** Closes what's open and leaves the attempt that's under way (if any) without effect. */
  dropSocket() {
    clearTimeout(this.retryTimer)
    this.epoch++
    this.connecting = false
    const sock = this.socket
    this.socket = null
    if (sock) { sock.close(1000, 'bye') }
  }

  /**
   * Connects again from scratch: another session or another address, so what's open is no longer good, even if
   * it's still there (Hermes doesn't check again the session of an open socket). If it's stopped, it stays so.
   */
  reconnect() {
    if (this.stopped) { return }
    this.dropSocket()
    for (const [sid] of this.turnStart) { this.ui({ kind: 'turn-lost', sid }) }
    this.turnStart.clear()
    this.attempt = 0
    this.transport.invalidate()
    this.setState('connecting')
    this.connect()
  }

  /** Its addresses changed: if it's connecting, or what's open goes to one that's no longer there, it starts again. */
  addressesChanged(urls) {
    const ws = u => { try { return new URL(u).origin.replace(/^http/, 'ws') } catch { return '' } }
    if (this.connecting || (this.socket && !urls.map(ws).includes(this.origin))) { this.reconnect(); return }
    this.transport.invalidate()
    this.forgetModelStats()
    this.retryNow()
  }

  /** Immediate retry (after signing in or on "Try again"). */
  retryNow() {
    clearTimeout(this.retryTimer)
    this.attempt = 0
    if (!this.stopped && !this.socket) { this.connect() }
  }

  async connect() {
    if (this.stopped || this.connecting || this.socket) { return }
    // No Hermes on this computer: it's looked for quietly (without going through "connecting", which would
    // make the tab show up for a moment every minute).
    if (this.state === 'missing' && this.transport.available && !this.transport.available()) {
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => this.connect(), 60000)
      return
    }
    this.connecting = true
    const epoch = this.epoch
    this.setState('connecting', this.state === 'offline' ? this.detail : '')
    try {
      const target = await this.transport.wsTarget()
      if (epoch !== this.epoch) { return }
      const sock = new this.Socket({ url: target.url, protocols: target.protocols, name: this.id, log: this.log })
      sock.on('event', ev => this.onEvent(ev))
      sock.on('request', rq => this.onServerRequest(sock, rq))
      sock.on('close', info => this.onClose(sock, info))
      const ready = await sock.open()
      if (this.stopped || epoch !== this.epoch) { sock.close(1000); return }
      this.socket = sock
      this.origin = new URL(target.url).origin
      this.canonical = ready.session_authority === true
      this.live.clear()
      this.liveToStored.clear()
      for (const key of [...this.prompts.keys()]) { this.dropPrompt(key) }
      try { await sock.request('client.capabilities', { server_requests: true }, 15000) } catch {}
      if (sock !== this.socket) { return } // it was closed or replaced meanwhile
      this.attempt = 0
      this.setState('ready', this.canonical ? 'new protocol' : 'classic protocol')
      this.ui({ kind: 'reconnected' })
      // Chats that are still working are followed again right away (on opening or updating Pedila): with
      // nobody watching, Hermes would cut off their background tasks after 5 min.
      this.reattachRunning().catch(e => this.log.warn(`[${this.id}] when reattaching:`, e.message))
    } catch (e) {
      if (epoch !== this.epoch) { return }
      if (e.needLogin) {
        this.setState('login', e.message)
      } else if (e.setup) {
        this.setState('setup', e.message)
      } else if (e.missing) {
        // This computer doesn't have that Hermes: the tab is hidden. It's looked for again every minute in
        // case it gets installed with Pedila open.
        this.setState('missing', e.message)
        clearTimeout(this.retryTimer)
        this.retryTimer = setTimeout(() => this.connect(), 60000)
      } else if (e.fatal) {
        this.setState('error', e.message)
      } else {
        this.log.warn(`[${this.id}] can't connect: ${e.message}`)
        this.setState('offline', e.message)
        this.transport.invalidate()
        this.scheduleRetry()
      }
    } finally {
      if (epoch === this.epoch) { this.connecting = false }
    }
  }

  onClose(sock, info) {
    if (sock !== this.socket) { return }
    this.socket = null
    this.log.warn(`[${this.id}] socket closed ${info.code} ${info.reason}`)
    for (const [sid] of this.turnStart) { this.ui({ kind: 'turn-lost', sid }) }
    this.turnStart.clear()
    if (this.stopped) { return }
    this.setState('offline', tr('The connection dropped; reconnecting…'))
    this.transport.invalidate()
    this.scheduleRetry(true)
  }

  scheduleRetry(fast = false) {
    clearTimeout(this.retryTimer)
    const ms = fast ? 700 : BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]
    this.retryTimer = setTimeout(() => this.connect(), ms)
  }

  waitReady(ms = 25000) {
    if (this.state === 'ready' && this.socket) { return Promise.resolve() }
    if (this.state === 'login') { return Promise.reject(Object.assign(new Error(this.detail || tr('You need to sign in')), { needLogin: true })) }
    if (this.state === 'error' || this.state === 'setup') { return Promise.reject(new Error(this.detail)) }
    if (!this.connecting && !this.socket) { this.retryNow() }
    // 'restarting' is a mark for the screen, not a text.
    const why = () => (this.state === 'updating' && this.detail === 'restarting' ? tr('restarting Hermes…') : this.detail)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off('state', on); reject(new Error(tr('Not connected to {0}{1}', this.name, why() ? ': ' + why() : ''))) }, ms)
      const on = s => {
        if (s === 'ready') { clearTimeout(t); this.off('state', on); resolve() }
        if (s === 'login' || s === 'error' || s === 'setup') { clearTimeout(t); this.off('state', on); reject(Object.assign(new Error(this.detail), { needLogin: s === 'login' })) }
      }
      this.on('state', on)
    })
  }

  async rpc(method, params, timeoutMs) {
    await this.waitReady()
    return this.socket.request(method, params, timeoutMs)
  }

  // ── Gateway events ─────────────────────────────────────────────────────────────────────────

  storedOf(liveId, payload) {
    return this.liveToStored.get(liveId) || (payload && str(payload.stored_session_id)) || liveId
  }

  bind(storedId, liveId, extra = {}) {
    const prev = this.live.get(storedId) || {}
    const rec = { ...prev, liveId, ...extra }
    this.live.set(storedId, rec)
    this.liveToStored.set(liveId, storedId)
    return rec
  }

  onEvent(ev) {
    const type = ev.type
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
    if (type === 'gateway.ready') { return }
    if (type === 'sessions.changed') { this.ui({ kind: 'sessions-changed' }); return }
    const liveId = ev.session_id
    if (!liveId) { return }
    const sid = this.storedOf(liveId, p)
    const rec = this.live.get(sid)
    const gen = typeof ev.execution_generation === 'number' ? ev.execution_generation : typeof p.execution_generation === 'number' ? p.execution_generation : null
    if (rec && gen !== null && gen >= (rec.generation ?? -1)) { rec.generation = gen }

    switch (type) {
      case 'session.info':
        if (p.stored_session_id && p.stored_session_id !== liveId && !this.liveToStored.has(liveId)) { this.bind(p.stored_session_id, liveId) }
        if (typeof p.running === 'boolean') {
          if (rec) { rec.running = p.running }
          this.ui({ kind: 'running', sid, running: p.running })
        }
        if (p.model || p.reasoning_effort) { this.ui({ kind: 'info', sid, model: str(p.model), provider: str(p.provider), contextMax: p.context_length || null, effort: str(p.reasoning_effort) }) }
        break
      case 'message.start':
        this.turnStart.set(sid, Date.now())
        this.ui({ kind: 'turn-start', sid })
        break
      case 'message.delta':
        if (typeof p.text === 'string' && p.text) { this.ui({ kind: 'delta', sid, text: p.text }) } else if (p.text === null) { this.ui({ kind: 'segment', sid }) }
        break
      case 'message.interim':
        if (!p.already_streamed && str(p.text)) { this.ui({ kind: 'delta', sid, text: p.text }) }
        this.ui({ kind: 'segment', sid })
        break
      case 'reasoning.delta':
        if (str(p.text)) { this.ui({ kind: 'reasoning', sid, text: p.text }) }
        break
      case 'reasoning.available':
        if (str(p.text)) { this.ui({ kind: 'reasoning', sid, text: p.text, full: true }) }
        break
      case 'thinking.delta':
        this.ui({ kind: 'thinking', sid, text: str(p.text) })
        break
      case 'status.update':
        if (str(p.text)) { this.ui({ kind: 'status', sid, text: cut(p.text, 160), statusKind: str(p.kind) }) }
        break
      case 'tool.generating':
        this.ui({ kind: 'tool', sid, phase: 'generating', id: str(p.tool_id), name: str(p.name) })
        break
      case 'tool.start':
        this.ui({ kind: 'tool', sid, phase: 'start', id: str(p.tool_id || p.tool_call_id), name: str(p.name || p.tool_name), args: argsSummary(p.args, p.args_text || p.preview || p.context), input: p.args && typeof p.args === 'object' ? boundInput(p.args) : null })
        break
      case 'tool.progress':
        this.ui({ kind: 'tool', sid, phase: 'progress', id: str(p.tool_id), name: str(p.name), percent: typeof p.percent === 'number' ? p.percent : null, message: str(p.message) })
        break
      case 'tool.complete': {
        // What it returned (result, or result_text in "verbose" mode), whether it failed, a file's change
        // already drawn (inline_diff) and the image it produced or looked at (image_path).
        const name = str(p.name || p.tool_name)
        const o = hermesToolOutput(name, p.result !== undefined ? p.result : p.result_text, typeof p.is_error === 'boolean' ? p.is_error : null)
        this.ui({
          kind: 'tool', sid, phase: 'complete', id: str(p.tool_id || p.tool_call_id), name,
          summary: cut(str(p.summary || p.result_text || o.text).replace(/\s+/g, ' ').trim(), 200),
          seconds: typeof p.duration_s === 'number' ? p.duration_s : null,
          output: o.text, error: o.error,
          diff: str(p.inline_diff) ? capText(str(p.inline_diff).replace(ANSI, '')) : '',
          image: str(p.image_path),
          ...(p.args && typeof p.args === 'object' ? { input: boundInput(p.args) } : {})
        })
        const st = Array.isArray(p.todos) ? todoSnapshot(p) : null
        if (st) { this.ui({ kind: 'todos', sid, ...st }) }
        break
      }
      case 'todo.updated': {
        // The whole list after each change; the revision lets late events be discarded.
        const st = todoSnapshot(p)
        if (st) { this.ui({ kind: 'todos', sid, ...st }) }
        break
      }
      case 'subagent.spawn_requested':
      case 'subagent.start':
      case 'subagent.progress':
      case 'subagent.tool':
      case 'subagent.complete':
        // The subagents (delegate_task); their reasoning and their text letter by letter aren't needed
        // here.
        this.ui({
          kind: 'subagent', sid, phase: type.slice(9),
          id: str(p.subagent_id) || `t${Number(p.task_index) || 0}`,
          goal: cut(str(p.goal).replace(/\s+/g, ' ').trim(), 200),
          index: Number(p.task_index) || 0,
          count: Number(p.task_count) || 1,
          status: str(p.status),
          tool: str(p.tool_name),
          text: cut(str(p.text).replace(/\s+/g, ' ').trim(), 160),
          tools: Number.isFinite(p.tool_count) ? p.tool_count : null,
          seconds: typeof p.duration_seconds === 'number' ? p.duration_seconds : null
        })
        break
      case 'message.complete': {
        const started = this.turnStart.get(sid)
        this.turnStart.delete(sid)
        const u = p.usage && typeof p.usage === 'object' ? p.usage : {}
        this.ui({ kind: 'complete', sid, text: str(p.text || p.content), status: str(p.status), outcome: str(p.outcome), reasoning: str(p.reasoning), ms: started ? Date.now() - started : null, out: Number(u.output || u.completion || 0) || null })
        break
      }
      case 'session.usage':
        this.ui({ kind: 'usage', sid, used: p.context_tokens || null, max: p.context_length || null, out: Number(p.output_tokens) || null })
        break
      case 'session.title':
        if (str(p.title)) { this.ui({ kind: 'title', sid, title: p.title }) }
        break
      case 'error':
        this.ui({ kind: 'error', sid, message: str(p.message) || tr('Hermes error') })
        break
      case 'approval.request':
        this.addPrompt(`c:${p.prompt_id}`, { kind: 'approval', sid, liveId, promptId: str(p.prompt_id), generation: typeof p.execution_generation === 'number' ? p.execution_generation : gen, command: str(p.command), description: str(p.description), choices: Array.isArray(p.choices) ? p.choices : ['once', 'deny'] })
        break
      case 'clarify.request':
        this.addPrompt(`c:${p.prompt_id}`, { kind: 'clarify', sid, liveId, promptId: str(p.prompt_id), generation: typeof p.execution_generation === 'number' ? p.execution_generation : gen, questions: [{ qid: str(p.prompt_id), question: str(p.question), choices: Array.isArray(p.choices) ? p.choices : [], multi: Boolean(p.multi_select) }] })
        break
      case 'approval.settled':
      case 'clarify.settled':
        if (p.prompt_id) { this.dropPrompt(`c:${p.prompt_id}`) }
        break
      case 'approval.cancelled':
        for (const rid of Array.isArray(p.request_ids) ? p.request_ids : []) { this.dropPrompt(`c:${rid}`); this.dropPrompt(`l:${rid}`) }
        break
      default:
        break
    }
  }

  onServerRequest(sock, rq) {
    const p = rq.params || {}
    if (rq.method === 'approval' || rq.method === 'clarify') {
      const liveId = str(p.session_id) || str(p.gateway_session_id)
      const sid = liveId ? this.storedOf(liveId, p) : null
      const key = `l:${p.request_id || rq.id}`
      if (rq.method === 'approval') {
        const choices = Array.isArray(p.choices) && p.choices.length ? p.choices
          : ['once', ...(p.allow_session === false ? [] : ['session']), ...(p.allow_permanent === false ? [] : ['always']), 'deny']
        this.addPrompt(key, { kind: 'approval', sid, liveId, serverRequestId: rq.id, sock, command: str(p.command), description: str(p.description), choices })
      } else {
        const qs = Array.isArray(p.questions) ? p.questions : []
        this.addPrompt(key, { kind: 'clarify', sid, liveId, serverRequestId: rq.id, sock, questions: qs.map(q => ({ qid: str(q.qid), question: str(q.question), choices: Array.isArray(q.choices) ? q.choices : [], multi: Boolean(q.multi_select) })) })
      }
      return
    }
    // The rest (sudo, secrets, tutorials, preview…) doesn't exist in this app: it's refused right away so
    // that Hermes doesn't wait until its deadline.
    sock.respondError(rq.id, -32601, 'not supported by Pedila')
  }

  addPrompt(key, prompt) {
    this.prompts.set(key, prompt)
    const { sock, kind, serverRequestId, liveId, generation, promptId, ...pub } = prompt
    this.ui({ ...pub, kind: 'prompt', promptKind: kind, key })
  }

  dropPrompt(key) {
    const pr = this.prompts.get(key)
    if (!pr) { return }
    this.prompts.delete(key)
    this.ui({ kind: 'prompt-done', key, sid: pr.sid })
  }

  // ── Actions ────────────────────────────────────────────────────────────────────────────────

  /** All the chats (100 at a time: the gateway doesn't take more per page). */
  async allSessions(max = 1000, archived = 'exclude') {
    const rows = []
    for (let off = 0; off < max; off += 100) {
      const r = await this.transport.fetchJson(`/api/sessions?limit=100&offset=${off}&min_messages=1&archived=${archived}`)
      if (r.status !== 200 || !r.json) { throw new Error(tr("Couldn't read the chat list ({0})", r.status)) }
      const page = r.json.sessions || []
      rows.push(...page)
      if (page.length < 100) { break }
    }
    return rows.filter(s => !s.hidden).map(sessionRow)
  }

  async listSessions() {
    return (await this.allSessions(300)).filter(s => !s.archived)
  }

  /**
   * Each model's tokens according to Hermes's own statistics (GET /api/analytics/usage, the ones of Hermes
   * Desktop's usage page): they count all its chats and also what its auxiliary tasks spend (summarizing
   * memory, writing titles, looking at images…), which the chat list doesn't bring. null if this Hermes
   * doesn't give them: the panel then adds up the chat list.
   * Only the first time is waited for. With a good stored value, that one is returned right away and, if
   * it's more than 5 min old, another one is asked for behind the scenes; if that fails, the stored one goes
   * on (so the order doesn't jump to the chat list's figures because of one stray failure).
   */
  async modelUsage(now = Date.now()) {
    const c = this.modelStats
    const fresh = Boolean(c) && now - c.at < (c.models ? MODEL_STATS_TTL : MODEL_STATS_MISSING_TTL)
    const resting = this.modelStatsFailAt !== null && now - this.modelStatsFailAt < MODEL_STATS_FAIL_PAUSE
    if (!fresh && !resting && !this.modelStatsPending) {
      // A single query at a time (the panel and "See all" may ask for it together).
      const p = this.loadModelStats(this.modelStatsEpoch, now)
      const clear = () => { if (this.modelStatsPending === p) { this.modelStatsPending = null } }
      p.then(clear, clear)
      this.modelStatsPending = p
    }
    if (c && c.models) { return c.models }
    if (fresh || resting || !this.modelStatsPending) { return null }
    return this.modelStatsPending
  }

  /**
   * Forgets the statistics by model, the query in progress and the pause: when the connection is lost or the
   * server's address changes (with the socket open, that doesn't go through setState).
   */
  forgetModelStats() {
    this.modelStats = null
    this.modelStatsPending = null
    this.modelStatsFailAt = null
    this.modelStatsEpoch++
  }

  async loadModelStats(epoch, now) {
    let r
    try {
      r = await this.transport.fetchJson(`/api/analytics/usage?days=${MODEL_STATS_DAYS}`)
    } catch (e) {
      if (epoch === this.modelStatsEpoch) { this.modelStatsFailAt = now }
      throw e
    }
    const models = r.status === 200 ? modelUsageFrom(r.json) : null
    // If the connection dropped meanwhile, the answer is from before: it isn't stored.
    if (epoch !== this.modelStatsEpoch) { return models }
    if (models || r.status === 200 || [404, 405, 422].includes(r.status)) {
      // What is good, or "this Hermes doesn't have them" (404, 405, 422 or a 200 without the list).
      this.modelStats = { at: now, models }
      this.modelStatsFailAt = null
    } else {
      // A passing failure (5xx…): go on with what's stored and don't retry for 2 min.
      this.modelStatsFailAt = now
    }
    return models
  }

  /**
   * The chats Hermes is working in right now, whoever started them (Pedila, Hermes Desktop…), without
   * attaching to them: `session.active_list`, the same thing Hermes Desktop's sidebar reads. In the classic
   * protocol `id` is the socket's and the stored one goes in `session_key`; in the new one both are the
   * stored one.
   */
  async activeList() {
    const r = await this.rpc('session.active_list', {}, 5000)
    return (Array.isArray(r && r.sessions) ? r.sessions : []).map(x => ({
      // First the chat this window already has attached to that id (after a compaction or with a chat of
      // several stretches, Hermes's id may not be the one of the list's row).
      id: this.liveToStored.get(str(x && x.id)) || str(x && x.session_key) || str(x && x.id),
      status: str(x && x.status),
      title: str(x && x.title)
    })).filter(x => x.id && ['working', 'waiting', 'starting'].includes(x.status))
  }

  /** Attaches to the chats Hermes is working in now (whoever started them). */
  async reattachRunning() {
    const list = await this.activeList()
    for (const x of list) {
      if (this.stopped || this.state !== 'ready') { return }
      if (this.live.has(x.id)) { continue }
      try {
        await this.attach(x.id)
        this.log.info(`[${this.id}] following the chat ${x.id.slice(0, 12)} ("${x.title.slice(0, 40)}"), which was working`)
      } catch (e) {
        this.log.warn(`[${this.id}] couldn't follow the chat ${x.id.slice(0, 12)}:`, e.message)
      }
    }
  }

  async archived() {
    return this.allSessions(1000, 'only')
  }

  /**
   * The subagents still alive in an attached chat (subagent.list, both protocols), to close in the panel the
   * ones that no longer exist even if their end event didn't arrive. null if it can't be known.
   */
  async subagents(sid) {
    const rec = this.live.get(sid)
    if (!rec || !rec.liveId || this.state !== 'ready' || !this.socket) { return null }
    const r = await this.socket.request('subagent.list', { session_id: rec.liveId }, 5000)
    if (!r || !Array.isArray(r.subagents)) { return null }
    return r.subagents.filter(x => x && x.subagent_id).map(x => ({
      id: str(x.subagent_id),
      status: str(x.status),
      tool: str(x.last_tool),
      tools: Number.isFinite(x.tool_count) ? x.tool_count : null
    }))
  }

  /** Search in the text of all the chats (the gateway's own). */
  async search(q) {
    const r = await this.transport.fetchJson(`/api/sessions/search?q=${encodeURIComponent(q)}`)
    if (r.status !== 200 || !r.json) { throw new Error(tr("Couldn't search ({0})", r.status)) }
    return (r.json.results || []).map(x => ({ id: str(x.session_id), snippet: cut(str(x.snippet).replace(/>>>|<<</g, '').replace(/\s+/g, ' ').trim(), 160), role: str(x.role), lastActive: x.last_active || x.session_started || null, model: str(x.model) })).filter(x => x.id)
  }

  /**
   * Protected changes to a stored chat (like Hermes Desktop): first /mutation-snapshot is read (revision and
   * generation) and the change carries that identity; without it, the gateway answers 409 and changes
   * nothing.
   */
  async mutate(sid, method, payload = {}) {
    const base = `/api/sessions/${encodeURIComponent(sid)}`
    const snap = await this.transport.fetchJson(`${base}/mutation-snapshot`)
    let identity = {}
    if (snap.status === 200 && snap.json && Number.isSafeInteger(snap.json.runtime_revision)) {
      if (!snap.json.exists && method === 'DELETE') { return { ok: true, gone: true } }
      identity = { request_id: crypto.randomUUID(), expected_revision: snap.json.runtime_revision }
      if (snap.json.exists && Number.isSafeInteger(snap.json.runtime_generation)) { identity.expected_generation = snap.json.runtime_generation }
    } else if (snap.status === 404 && method === 'DELETE') {
      return { ok: true, gone: true }
    }
    const r = method === 'DELETE'
      ? await this.transport.fetchJson(`${base}${Object.keys(identity).length ? '?' + new URLSearchParams(Object.entries(identity).map(([k, v]) => [k, String(v)])) : ''}`, { method })
      : await this.transport.fetchJson(base, { method, body: { ...payload, ...identity } })
    if (r.status >= 300) {
      const why = r.json && (r.json.detail || r.json.error || r.json.message)
      throw new Error(tr("Hermes didn't accept the change ({0}{1})", r.status, why ? ': ' + (typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 120) : ''))
    }
    if (method === 'DELETE') {
      const live = this.live.get(sid)
      if (live) { this.liveToStored.delete(live.liveId); this.live.delete(sid) }
    }
    return { ok: true }
  }

  rename(sid, title) { return this.mutate(sid, 'PATCH', { title }) }
  setPinned(sid, pinned) { return this.mutate(sid, 'PATCH', { pinned }) }
  setArchived(sid, archived) { return this.mutate(sid, 'PATCH', archived ? { archived, pinned: false } : { archived }) }
  remove(sid) { return this.mutate(sid, 'DELETE') }

  /** Uploads an image for that chat's next message (image.attach_bytes, in both protocols). */
  async attachImage(sid, base64, filename) {
    const rec = await this.attach(sid)
    const r = await this.socket.request('image.attach_bytes', { session_id: rec.liveId, content_base64: base64, filename }, 120000)
    return { path: str(r && r.path), mime: str(r && (r.mime || r.mime_type)) }
  }

  /**
   * An image Hermes named with "MEDIA:<path>" (image_generate, screenshots…). The path belongs to the
   * machine where Hermes runs, so it's asked from its gateway: GET /api/media only serves images from its
   * media folders (images, screenshots, cache) and returns it as a data URL.
   */
  async media(file) {
    const r = await this.transport.fetchJson(`/api/media?path=${encodeURIComponent(file)}`)
    const url = r.json && r.json.data_url
    if (r.status !== 200 || typeof url !== 'string' || !/^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(url)) {
      throw new Error(r.status === 403 ? tr("the image is outside Hermes's folders") : r.status === 404 ? tr('the image no longer exists') : tr("couldn't fetch the image ({0})", r.status))
    }
    return url
  }

  /**
   * What's left of this Hermes's paid APIs (OpenRouter, Venice, OpenCode, DeepSeek, Openference), read by the "pedila" plugin that
   * runs inside Hermes: the keys don't leave it, only numbers arrive.
   * { state: 'ok', data } · { state: 'missing' } if the plugin isn't there (or isn't turned on).
   */
  async quotas(fresh = false) {
    const r = await this.transport.fetchJson(`/api/plugins/${QUOTA_PLUGIN}/cuotas${fresh ? '?fresh=1' : ''}`)
    if ([403, 404, 405].includes(r.status) || (r.status === 200 && !(r.json && r.json.plugin === QUOTA_PLUGIN))) { return { state: 'missing' } }
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.providers)) { throw new Error(tr("Hermes didn't give the quotas ({0})", r.status)) }
    const data = quotaData(r.json)
    const outdated = quotaPluginOutdated(data.version)
    // The new one may already be on disk, waiting for Hermes to restart ('' = this Hermes can't say). And what
    // reloads by itself may be up to date with a fixed part from before (shellStale).
    const onDisk = outdated ? await this.quotaPluginOnDisk().catch(() => '') : ''
    return { state: 'ok', data, outdated, onDisk, restart: data.shellStale || (Boolean(onDisk) && !quotaPluginOutdated(onDisk)) }
  }

  /** The version of the plugin that Hermes has on disk (its manifest.json), which may not be the one it has loaded. */
  async quotaPluginOnDisk(transport = this.transport) {
    const r = await transport.fetchJson('/api/dashboard/plugins')
    const p = (Array.isArray(r.json) ? r.json : []).find(x => x && x.name === QUOTA_PLUGIN)
    return p ? cut(str(p.version), 20) : ''
  }

  /**
   * Installs the plugin's new version with Hermes's own update route: it downloads it again from where it was
   * installed, scans it and swaps the folder in one go (if something fails, nothing changes). With a plugin
   * 1.2.0 or newer, Hermes uses the new calculation right away; with an earlier one, it will load it when it
   * restarts (its old route stays mounted until then). `force` = go on despite a "caution" of the scan.
   * → { ok: true, unchanged } (unchanged = what's on disk is still an old one: GitHub has nothing newer) or what
   * the scan says. Everything goes to the same Hermes, even if the server's address is changed meanwhile.
   */
  async updateQuotaPlugin(force = false) {
    const transport = this.transport.pinned ? await this.transport.pinned() : this.transport
    const r = await transport.fetchJson(`/api/dashboard/agent-plugins/${QUOTA_PLUGIN}/update`, { method: 'POST', body: force ? { force: true } : {}, timeoutMs: INSTALL_TIMEOUT })
    const j = r.json || {}
    const detail = str(j.detail) || str(j.error)
    let done = null
    if (r.status === 200 && j.ok) {
      done = { ok: true, unchanged: Boolean(j.unchanged) }
    } else {
      const scan = scanOf(j, detail)
      if (scan) { return scan }
      // A Hermes without that route, or that doesn't know where the plugin came from (an old installation, or
      // copied by hand): it's removed and installed again.
      if (r.status !== 404 && r.status !== 405 && !/not a git checkout|cannot pull updates|was not found under/i.test(detail)) {
        throw new Error(cut(detail || tr("Hermes didn't update the plugin ({0})", r.status), 300))
      }
      done = await this.reinstallQuotaPlugin(force, transport)
      if (!done.ok) { return done }
    }
    // What counts is what's on disk: the update may have brought a version that isn't the one wanted yet.
    const onDisk = await this.quotaPluginOnDisk(transport).catch(() => '')
    return { ok: true, unchanged: onDisk ? quotaPluginOutdated(onDisk) : Boolean(done.unchanged) }
  }

  async reinstallQuotaPlugin(force, transport) {
    const d = await transport.fetchJson(`/api/dashboard/agent-plugins/${QUOTA_PLUGIN}`, { method: 'DELETE', timeoutMs: 60000 })
    const detail = str(d.json && (d.json.detail || d.json.error))
    if (d.status !== 200 && !/not found/i.test(detail)) {
      if (d.status === 404 || d.status === 405) { throw new Error(tr("this Hermes can't remove plugins from outside (update it)")) }
      throw new Error(cut(detail || tr("Hermes didn't remove the old version ({0})", d.status), 300))
    }
    return this.installQuotaPlugin(force, transport, true)
  }

  /**
   * Installs and turns on the "pedila" plugin in this Hermes with its own install route (the one of the
   * "Install" button on its plugins page), without restarting it. If Hermes's security scan raises an
   * objection, it's returned for the person to decide (`force` = install anyway). `again` = it was just removed in
   * order to update it: finding it already there isn't having updated it.
   */
  async installQuotaPlugin(force = false, transport = this.transport, again = false) {
    // Installing clones the repository and scans it: it may take quite a bit longer than a query.
    const r = await transport.fetchJson('/api/dashboard/agent-plugins/install', { method: 'POST', body: { identifier: QUOTA_PLUGIN_SOURCE, enable: true, force: Boolean(force) }, timeoutMs: INSTALL_TIMEOUT })
    const j = r.json || {}
    if (r.status === 200 && j.ok) { return { ok: true, restart: Boolean(j.restart_required) } }
    const detail = str(j.detail) || str(j.error)
    // Hermes's security scan stopped the installation (the route returns it as a 400 with the report).
    const scan = scanOf(j, detail)
    if (scan) { return scan }
    // It was already installed (for example, from an earlier attempt) but not turned on: it's turned on.
    if (!again && /already exists|already installed/i.test(detail)) {
      const e = await transport.fetchJson(`/api/dashboard/agent-plugins/${QUOTA_PLUGIN}/enable`, { method: 'POST', body: {} })
      if (e.status === 200) { return { ok: true, restart: Boolean(e.json && e.json.restart_required) } }
      throw new Error(cut(str(e.json && (e.json.detail || e.json.error)) || tr("Hermes didn't turn it on ({0})", e.status), 300))
    }
    if (r.status === 404 || r.status === 405) { throw new Error(tr("this Hermes can't install plugins from outside (update it)")) }
    throw new Error(cut(detail || tr('Hermes answered {0}', r.status), 300))
  }

  async transcript(sid) {
    const r = await this.transport.fetchJson(`/api/sessions/${encodeURIComponent(sid)}/messages?limit=400&order=latest`)
    if (r.status === 404) { return [] }
    if (r.status !== 200 || !r.json) { throw new Error(tr("Couldn't read the chat ({0})", r.status)) }
    const rows = Array.isArray(r.json.messages) ? r.json.messages : []
    // Its task list, if Hermes made one (for the panel, even if the chat is no longer running).
    const todos = todoStateOf(rows)
    if (todos) { this.ui({ kind: 'todos', sid, history: true, ...todos }) }
    return normalizeTranscript(rows)
  }

  async modelOptions() {
    const r = await this.rpc('model.options', {}, 30000)
    const providers = (Array.isArray(r && r.providers) ? r.providers : []).map(pv => ({
      id: str(pv.slug || pv.id || pv.provider || pv.name),
      name: str(pv.name || pv.label || pv.slug || pv.id),
      local: isLocalUrl(pv.api_url || pv.base_url),
      paid: paidKindOfProvider(pv),
      models: (Array.isArray(pv.models) ? pv.models : []).map(m => (typeof m === 'string' ? { id: m, name: m } : { id: str(m.id || m.model || m.name), name: str(m.name || m.label || m.id || m.model) })).filter(m => m.id)
    })).filter(pv => pv.id && pv.models.length)
    const curProvider = str(r && r.provider)
    const cur = providers.find(pv => pv.id.toLowerCase() === curProvider.toLowerCase())
    return {
      // The paid APIs that Hermes has set (to offer turning their quotas on).
      paid: [...new Set(providers.map(pv => pv.paid).filter(Boolean))],
      current: { model: str(r && r.model), provider: curProvider, local: Boolean(cur && cur.local) },
      providers: [...providers.filter(pv => pv.local), ...providers.filter(pv => !pv.local)]
    }
  }

  /** Attaches the chat to the socket (resume) to be able to write and to get its live events. */
  async attach(sid) {
    await this.waitReady()
    const rec = this.live.get(sid)
    if (rec && rec.liveId) { return rec }
    const params = this.canonical ? { session_id: sid } : { session_id: sid, cols: COLS }
    const snap = await this.socket.request('session.resume', params, 90000)
    const liveId = str(snap && snap.session_id) || sid
    const out = this.bind(sid, liveId, {
      generation: typeof (snap && snap.execution_generation) === 'number' ? snap.execution_generation : (snap && snap.info && snap.info.execution_generation) ?? null,
      running: Boolean(snap && (snap.running || (snap.info && snap.info.running)))
    })
    if (snap && snap.stored_session_id && snap.stored_session_id !== sid) { this.liveToStored.set(liveId, sid) }
    // Permissions and questions that were already waiting (new protocol: they're in the snapshot).
    for (const pr of Array.isArray(snap && snap.prompts) ? snap.prompts : []) {
      this.onEvent({ type: `${pr.kind}.request`, session_id: liveId, payload: pr })
    }
    // Classic protocol: the requests that were still open come back inside the answer (`open_requests`),
    // as Hermes Desktop's json-rpc-channel.ts hands them over again.
    for (const rq of Array.isArray(snap && snap.open_requests) ? snap.open_requests : []) {
      if (rq && rq.id !== undefined && typeof rq.method === 'string') { this.onServerRequest(this.socket, { id: rq.id, method: rq.method, params: rq.params || {} }) }
    }
    // The chat's task list (both protocols send it on resuming).
    const todos = todoSnapshot(snap && snap.todo_state)
    if (todos) { this.ui({ kind: 'todos', sid, ...todos }) }
    this.ui({ kind: 'running', sid, running: out.running })
    return out
  }

  async newChat({ model, provider, reasoning } = {}) {
    await this.waitReady()
    const params = this.canonical
      ? { request_id: crypto.randomUUID(), source: 'gui' }
      : { source: 'gui', cols: COLS }
    if (model) { params.model = model }
    if (model && provider) { params.provider = provider }
    if (reasoning) { params[this.canonical ? 'reasoning' : 'reasoning_effort'] = reasoning }
    const snap = await this.socket.request('session.create', params, 90000)
    const liveId = str(snap.session_id)
    const stored = str(snap.stored_session_id) || liveId
    this.bind(stored, liveId, { generation: typeof snap.execution_generation === 'number' ? snap.execution_generation : null, running: false })
    return { sid: stored }
  }

  async send(sid, text, attachments = []) {
    const rec = await this.attach(sid)
    const params = this.canonical
      ? { session_id: rec.liveId, text, submission_id: crypto.randomUUID() }
      : { session_id: rec.liveId, text }
    // New protocol: uploaded images are named in the submit; in the classic one they were already queued.
    const files = attachments.filter(a => a && a.path && a.mime)
    if (this.canonical && files.length) { params.attachments = files.map(a => ({ path: a.path, mime: a.mime })) }
    return this.socket.request('prompt.submit', params, 120000)
  }

  /**
   * Changing the model or the reasoning of a chat already started, with Hermes's own commands (`/model
   * <model> --provider <p> --session` and `/reasoning <level>`) through slash.exec. Hermes refuses them
   * while the chat is answering.
   */
  async setChatOptions(sid, { model, provider, reasoning, confirm } = {}) {
    const rec = await this.attach(sid)
    // New protocol: `session.mutate` (operation 'model' / 'reasoning'), the same as Hermes Desktop's
    // picker; there `slash.exec /model` is refused. A model Hermes wants you to confirm (cost, privacy,
    // large context) comes back as { needsConfirm, confirm, message } and is repeated with that `confirm`.
    if (this.canonical) {
      if (model !== undefined) {
        const payload = model === null ? { model: 'reset' } : { model, ...(provider ? { provider } : {}) }
        if (confirm) { payload.confirm = confirm }
        const r = await this.policyMutate(sid, rec, 'model', payload)
        if (r && r.status === 'confirmation_required') {
          return { needsConfirm: true, confirm: str(r.confirm), message: str(r.confirm_message), model: str(r.target_model), provider: str(r.target_provider) }
        }
        if (model) { this.ui({ kind: 'info', sid, model, provider: provider || '' }) }
      }
      if (reasoning !== undefined) { await this.policyMutate(sid, rec, 'reasoning', { effort: reasoning || null }) }
      return { applied: 'now', model: model || null, effort: reasoning || null }
    }
    const run = async command => {
      let r
      try {
        r = await this.rpc('slash.exec', { session_id: rec.liveId, command }, 60000)
      } catch (e) {
        if (/32601|method not found|unknown method|unsupported/i.test(e.message || '')) { throw new Error(tr("This Hermes doesn't let you change it in a chat that has already started (start a new one).")) }
        if (/busy|in progress|running/i.test(e.message || '')) { throw new Error(tr('Hermes is answering in this chat: change it when it finishes.')) }
        throw e
      }
      if (r && (r.type === 'error' || r.error)) { throw new Error(str(r.message || r.output || r.error) || tr("Hermes didn't accept the change")) }
      return r
    }
    if (model !== undefined) { await run(model === null ? '/model reset --session' : `/model ${model}${provider ? ' --provider ' + provider : ''} --session`) }
    if (reasoning !== undefined && reasoning) { await run(`/reasoning ${reasoning}`) }
    if (model) { this.ui({ kind: 'info', sid, model, provider: provider || '' }) }
    return { applied: 'now', model: model || null, effort: reasoning || null }
  }

  /**
   * A change to a chat's configuration through `session.mutate`, with Hermes's fences (the current revision
   * and generation, from /mutation-snapshot). If another change slipped in between, it's repeated once with
   * the new ones.
   */
  async policyMutate(sid, rec, operation, payload) {
    for (let attempt = 0; ; attempt++) {
      const snap = await this.transport.fetchJson(`/api/sessions/${encodeURIComponent(sid)}/mutation-snapshot`)
      if (snap.status !== 200 || !snap.json || snap.json.exists === false) { throw new Error(tr("Can't find that chat in Hermes")) }
      try {
        return await this.rpc('session.mutate', {
          session_id: rec.liveId,
          request_id: crypto.randomUUID(),
          expected_revision: snap.json.runtime_revision,
          expected_generation: snap.json.runtime_generation,
          operation,
          payload
        }, 90000)
      } catch (e) {
        const why = `${e.message || ''} ${JSON.stringify(e.data || {})}`
        if (attempt === 0 && /revision_conflict|stale_generation/i.test(why)) { continue }
        if (/busy|lease|turn_active|in_progress/i.test(why)) { throw new Error(tr('Hermes is answering in this chat: change it when it finishes.')) }
        throw e
      }
    }
  }

  chatOptions() { return { model: null, effort: null } }

  async interrupt(sid) {
    const rec = this.live.get(sid)
    if (!rec || !this.socket) { return { ok: false } }
    const params = { session_id: rec.liveId }
    if (this.canonical) {
      if (typeof rec.generation !== 'number') { throw new Error(tr("The turn to stop isn't known yet; try again in a second")) }
      params.execution_generation = rec.generation
    }
    return this.socket.request('session.interrupt', params, 30000)
  }

  async answer(key, value) {
    const pr = this.prompts.get(key)
    if (!pr) { return { ok: false, gone: true } }
    if (pr.kind === 'approval' && !(Array.isArray(pr.choices) ? pr.choices : ['once', 'deny']).includes(value)) { throw new Error(tr('invalid permission answer')) }
    if (pr.kind === 'clarify' && !(typeof value === 'string' || (value && typeof value === 'object'))) { throw new Error(tr('invalid answer')) }
    if (pr.serverRequestId !== undefined) {
      const result = pr.kind === 'approval' ? { choice: value } : { answers: value, outcome: 'submitted' }
      pr.sock.respond(pr.serverRequestId, result)
      this.dropPrompt(key)
      return { ok: true }
    }
    const rec = this.live.get(pr.sid) || {}
    const generation = typeof pr.generation === 'number' ? pr.generation : rec.generation
    const params = { session_id: pr.liveId, execution_generation: generation, prompt_id: pr.promptId }
    if (pr.kind === 'approval') { params.choice = value } else { params.answer = typeof value === 'string' ? value : Object.values(value || {})[0] ?? '' }
    await this.rpc(pr.kind === 'approval' ? 'approval.respond' : 'clarify.respond', params, 30000)
    this.dropPrompt(key)
    return { ok: true }
  }

  publicState() {
    return { id: this.id, name: this.name, state: this.state, detail: this.detail, canonical: this.canonical }
  }
}

module.exports = { quotaData, quotaPluginOutdated, QUOTA_PLUGIN_WANT, paidKindOf, paidKindOfProvider, Connection, normalizeTranscript, sessionRow, argsSummary, boundInput, hermesToolOutput, hermesFailed, splitCompaction, contentImages, isLocalUrl, todoSnapshot, todoStateOf, isTodoCall }
