// Short formats for the panel: tokens (1.2K, 1.09M…) and times ("3:41 PM", "25 min ago").
// No dependencies other than the language, so that the tests can load it as is.

import { tr, locale } from './i18n.mjs'

const UNITS = ['', 'K', 'M', 'B']

/** Decimal rounding without the floating-point errors of `x * 100` (1.005 → 1.01). */
function round(v, d) {
  return d ? Number(Math.round(Number(v + 'e' + d)) + 'e-' + d) : Math.round(v)
}

/**
 * Tokens, short, with 3 digits at most and no extra zeros: 950 · 1.2K · 12.3K · 123K · 1M · 1.09M · 43.2M ·
 * 1.5B. Past 999.5 it goes up a unit (never "1000K"). The B is the one models use ("27B"): a thousand
 * million.
 */
export function kfmt(n) {
  n = Number(n)
  if (!Number.isFinite(n) || n === 0) { return '0' }
  if (n < 0) { return '-' + kfmt(-n) }
  let u = 0
  let v = n
  while (v >= 1000 && u < UNITS.length - 1) { v /= 1000; u++ }
  let d = u === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0
  let r = round(v, d)
  if (r >= 1000 && u < UNITS.length - 1) { v = r / 1000; u++; d = 2; r = round(v, d) }
  const s = r.toFixed(d)
  return (s.includes('.') ? s.replace(/\.?0+$/, '') : s) + UNITS[u]
}

// ── Models ───────────────────────────────────────────────────────────────────────────────────

/** A model's tokens in the usage summary: read + written. */
export function tokensOf(m) {
  return (Number(m && m.input) || 0) + (Number(m && m.output) || 0)
}

/**
 * A model's name, to show it. Some servers (llama.cpp) answer with the path of the file and Hermes stores it
 * as is: "/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf" is shown as "Qwen3-VL-8B-Instruct-Q4_K_M". Names with a
 * provider ("deepseek/deepseek-v4.1") aren't touched.
 */
export function modelName(model) {
  const s = String(model || '')
  const f = s.match(/[\\/]([^\\/]+)\.(?:gguf|ggml|bin|safetensors)$/i)
  return f ? f[1] : s
}

// The auxiliary tasks of Hermes 0.23 that it stores in session_model_usage: the auxiliary.* ones in its
// config.yaml and the ones recorded by its background review, /btw, goals and plugins.
const TASKS = {
  compression: 'summarizing memory',
  title_generation: 'writing titles',
  vision: 'looking at images',
  image_generation: 'creating images',
  approval: 'approving commands',
  background_review: 'reviewing memory and skills',
  side_question: 'side questions (/btw)',
  plugin_side_question: 'plugin questions',
  goal_judge: 'checking goals',
  review: 'reviews',
  mcp: 'MCP tools',
  memory_query_rewrite: 'searching memory',
  curator: 'sorting skills',
  tts_audio_tags: 'voice',
  voice_chat: 'voice',
  group_router: 'group chats',
  triage_specifier: 'kanban',
  kanban_decomposer: 'kanban',
  kanban_estimator: 'kanban',
  profile_describer: 'describing profiles',
  other: 'other'
}

/**
 * One of Hermes's auxiliary tasks in words: "compression" → "summarizing memory". Plugin ones carry their
 * name after ":" ("plugin_side_question:<plugin>"); the part in front is the one translated.
 */
export function taskName(task) {
  const t = String(task || '')
  const key = t.split(':')[0]
  return Object.hasOwn(TASKS, key) ? tr(TASKS[key]) : t.replace(/_/g, ' ') || tr('other')
}

/** What a model spent on auxiliary tasks: "summarizing memory 1.86M · writing titles 2.3K". */
export function tasksLine(tasks) {
  const by = new Map()
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const name = taskName(t && t.task)
    by.set(name, (by.get(name) || 0) + (Number(t && t.tokens) || 0))
  }
  return [...by].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${kfmt(n)}`).join(' · ')
}

// ── Times ────────────────────────────────────────────────────────────────────────────────────
// 12 or 24 hours like Windows' clock (the main process reads it from the system on startup).
let hour12 = false
let timeFmt = null
let fullFmt = null
export function setHour12(v) { hour12 = Boolean(v); timeFmt = null; fullFmt = null }

const MIN = 60000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function startOfDay(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Just the time: "3:41 PM" or "15:41". */
export function hhmm(ms) {
  timeFmt = timeFmt || new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit', hour12 })
  return timeFmt.format(new Date(ms))
}

/** Full date and time, for the help texts: "Nov 15, 2026, 3:41 PM". */
export function full(ms) {
  fullFmt = fullFmt || new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short', hour12 })
  return fullFmt.format(new Date(ms))
}

/** The day, if it isn't today: '' (today), "yesterday", "Mon" (this week), "Nov 12" or "Nov 12, 2025". */
export function dayLabel(ms, now = Date.now()) {
  const today = startOfDay(now)
  const day = startOfDay(ms)
  if (day === today) { return '' }
  // Half a day of margin: with daylight saving changes a day lasts 23 or 25 hours.
  if (day === startOfDay(today - DAY / 2)) { return tr('yesterday') }
  if (day > today - 6.5 * DAY && day < today) { return new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(ms)).replace(/\.$/, '') }
  const opts = { day: 'numeric', month: 'short' }
  if (new Date(ms).getFullYear() !== new Date(now).getFullYear()) { opts.year = 'numeric' }
  return new Intl.DateTimeFormat(locale(), opts).format(new Date(ms)).replace(/\./g, '')
}

/** The time, with the day if it isn't today: "3:41 PM", "yesterday, 11:20 PM", "Mon, 9:05", "Nov 12, 9:05". */
export function clock(ms, now = Date.now()) {
  const d = dayLabel(ms, now)
  return d ? `${d}, ${hhmm(ms)}` : hhmm(ms)
}

/** A length of time, short: "40 s", "25 min", "1 h 53 min", "3 days". */
export function span(msLen) {
  const s = Math.max(0, Math.floor(msLen / 1000))
  if (s < 60) { return `${s} s` }
  const m = Math.floor(s / 60)
  if (m < 60) { return `${m} min` }
  const h = Math.floor(m / 60)
  if (h < 24) { return m % 60 ? `${h} h ${m % 60} min` : `${h} h` }
  const d = Math.floor(h / 24)
  return d === 1 ? tr('1 day') : tr('{0} days', d)
}

/** How long ago: "a moment ago" (less than a minute, or a clock somewhat ahead), "25 min ago"… */
export function ago(ms, now = Date.now()) {
  const diff = now - ms
  return diff < MIN ? tr('a moment ago') : tr('{0} ago', span(diff))
}

/** Money in dollars: "$9.91", "$0.093", "$0" (under a dollar, with 3 decimals). */
export function usd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) { return '—' }
  if (n === 0) { return '$0' }
  const a = Math.abs(n)
  const s = a >= 1000 ? Math.round(a).toLocaleString(locale()) : a >= 1 ? a.toFixed(2) : a >= 0.001 ? a.toFixed(3) : '<0.001'
  return (n < 0 ? '-$' : '$') + s
}

/**
 * When an OpenRouter limit starts again: "daily" at 00:00 UTC, "weekly" on Monday at 00:00 UTC and "monthly"
 * on the 1st at 00:00 UTC. null if it isn't known.
 */
export function nextUtcReset(kind, now = Date.now()) {
  const d = new Date(now)
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate()
  if (kind === 'daily') { return Date.UTC(y, mo, day + 1) }
  if (kind === 'weekly') { const dow = d.getUTCDay(); return Date.UTC(y, mo, day + ((8 - dow) % 7 || 7)) }
  if (kind === 'monthly') { return Date.UTC(y, mo + 1, 1) }
  return null
}

/** A day to come: "tomorrow", "on Sunday" (within a week) or "on Dec 7". */
export function dayAhead(ms, now = Date.now()) {
  const today = startOfDay(now)
  const day = startOfDay(ms)
  if (day <= today) { return tr('today') }
  if (day <= startOfDay(today + DAY * 1.5)) { return tr('tomorrow') }
  if (day < today + 6.5 * DAY) { return tr('on {0}', new Intl.DateTimeFormat(locale(), { weekday: 'long' }).format(new Date(ms))) }
  const opts = { day: 'numeric', month: 'short' }
  if (new Date(ms).getFullYear() !== new Date(now).getFullYear()) { opts.year = 'numeric' }
  return tr('on {0}', new Intl.DateTimeFormat(locale(), opts).format(new Date(ms)).replace(/\./g, ''))
}
