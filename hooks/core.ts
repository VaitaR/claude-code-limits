// Pure data: defaults, config, formatting. Nothing here touches `$`, so every behaviour is testable directly.
import type { CostSplit, Running, Usage } from '../types'

// ---------------------------------------------------------------- defaults

export const DEFAULT_USAGE: Usage = {
  pct: null,
  tokens: null,
  window: 0,
  costUsd: null,
  limits: [],
  compactions: 0,
  compactWindow: null,
}

/** Context against the window Claude Code compacts at, not the model's whole window. */
export const contextOf = (u: Usage) => {
  const limit = u.compactWindow ?? u.window
  const pct = u.tokens !== null && limit > 0 ? (u.tokens / limit) * 100 : u.pct
  return { limit, pct }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A stored object merged over its defaults, so a value saved under an older shape still reads. */
export const normalize = <T extends object>(def: T, stored: unknown): T =>
  isObject(stored) ? ({ ...def, ...stored } as T) : def

/** A stored list, or empty when what is stored is not a list. */
export const listOf = <T>(stored: unknown): T[] => (Array.isArray(stored) ? (stored as T[]) : [])

// ---------------------------------------------------------------- config

export type Config = {
  palette: Palette
  /** argv the session id is appended to; it prints the JSON the README describes. Empty: no split. */
  costCommand: string[]
  /** The prompt cache's lifetime: the engine reports no 5m/1h split, so the person names theirs. */
  cacheTtlMs: number
  /** How often one session of the config directory asks the server for the quota; 0: never. */
  quotaPollMs: number
}

/** The plugin's `/config` values, read leniently: anything malformed falls back to the default. */
export const parseConfig = (o: Readonly<Record<string, unknown>>): Config => {
  const str = (k: string, d: string) => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : d)
  return {
    palette: str('palette', 'theme') === 'pastel' ? 'pastel' : 'theme',
    costCommand: str('costCommand', '').trim().split(/\s+/).filter(Boolean),
    cacheTtlMs: str('cacheTtl', '1h') === '5m' ? 300_000 : 3_600_000,
    quotaPollMs: ({ '5m': 300_000, '15m': 900_000 } as Record<string, number>)[str('quotaPoll', 'off')] ?? 0,
  }
}

// ---------------------------------------------------------------- palette

export type Palette = 'theme' | 'pastel'
export type Colors = Record<'agent' | 'amber' | 'warn' | 'dim' | 'faint' | 'text', string>

/**
 * `theme` names the person's own theme colours (they follow light, dark and colour-blind themes);
 * `pastel` is fixed hex tuned for dark terminals.
 */
export const PALETTES: Record<Palette, Colors> = {
  theme: { agent: 'suggestion', amber: 'warning', warn: 'error', dim: 'inactive', faint: 'subtle', text: 'text' },
  pastel: { agent: '#93c5fd', amber: '#fcd34d', warn: '#fca5a5', dim: '#6b7280', faint: '#3f4654', text: '#e5e7eb' },
}

// ---------------------------------------------------------------- formatting

export const shorten = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return n <= 0 ? '' : one.length > n ? `${one.slice(0, Math.max(0, n - 1)).trimEnd()}…` : one
}

export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** `1 call`, `2 calls`. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const fmtUsd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`)

/** Filled cells of a `width`-cell gauge; never none while anything is used: 4% of a quota is not 0%. */
export const gaugeCells = (pct: number, width: number) => {
  const round = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return pct > 0 ? Math.max(1, round) : round
}

/** Colour band of a quota by what is used so far. */
export const quotaLevel = (pct: number): 'ok' | 'warn' | 'hot' => (pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : 'ok')

/** `2h05m`, `45m`; with days, `2d00h`. */
export const fmtLeft = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d${String(h).padStart(2, '0')}h`
  return h > 0 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/** The cache in whole minutes, then seconds in its last minute: the moment to send one more prompt. */
export const fmtCacheLeft = (ms: number) =>
  ms <= 0 ? 'cold' : ms < 60_000 ? `${Math.min(59, Math.ceil(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m`

/** How long ago: `just now`, `5m ago`, `1h05m ago`, `2d03h ago`. */
export const fmtAgo = (ms: number) => (ms < 60_000 ? 'just now' : `${fmtLeft(ms)} ago`)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A moment as local wall time: `18:40` within a day of `now`, `Thu 14:00` further out. */
export const fmtAt = (ms: number, now: number) => {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return Math.abs(ms - now) < 86_400_000 ? hm : `${DAYS[d.getDay()]} ${hm}`
}

// ---------------------------------------------------------------- rate limits

type Limit = Usage['limits'][number]
const LIMIT_ORDER = ['five_hour', 'seven_day']

/** `readAt`: when the response carrying the reading arrived, so readings of several sessions can be ordered. */
export const limitsOf = (rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[], readAt?: number): Limit[] =>
  rateLimits.map(r => {
    const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    return { kind: r.kind, pct: r.percentUsed, resetsAt: Number.isFinite(at) ? at : null, ...(readAt !== undefined ? { at: readAt } : {}) }
  })

const rank = (k: string) => (LIMIT_ORDER.includes(k) ? LIMIT_ORDER.indexOf(k) : LIMIT_ORDER.length)
const byRank = (a: Limit, b: Limit) => rank(a.kind) - rank(b.kind)
const live = (l: Limit, now: number) => l.resetsAt == null || l.resetsAt > now

/**
 * A reading without a window keeps the last one: some responses carry no rate-limit headers, and an empty
 * reading would otherwise blank the quotas until the next one that does. Past its reset it is kept too, so
 * an idle band still shows the window, as reset.
 */
export const mergeLimits = (prev: readonly Limit[], next: readonly Limit[]): Limit[] => {
  const seen = new Set(next.map(l => l.kind))
  return [...next, ...prev.filter(l => !seen.has(l.kind))].sort(byRank)
}

/** Past its reset a reading says nothing about the new window but that no session here has read it yet. */
export const hasReset = (l: Limit, now: number) => !live(l, now)

/**
 * Quotas are account-wide, so the latest reading of any session is the right one: per window, the reading
 * read last wins (one without `at` loses to any with it). A reading of the new window is always read later.
 */
export const newestLimits = (a: readonly Limit[], b: readonly Limit[]): Limit[] => {
  const best = new Map<string, Limit>()
  for (const l of [...a, ...b]) {
    const prev = best.get(l.kind)
    if (!prev || (l.at ?? 0) > (prev.at ?? 0)) best.set(l.kind, l)
  }
  return [...best.values()].sort(byRank)
}

/** The shared quota file's readings, read leniently: a malformed file or entry is no reading. */
export const parseQuota = (text: string): Limit[] => {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return []
  }
  const list = isObject(o) && Array.isArray(o.limits) ? o.limits : []
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  return list.flatMap((l: unknown) =>
    isObject(l) && typeof l.kind === 'string' && num(l.pct) && num(l.at)
      ? [{ kind: l.kind, pct: l.pct as number, resetsAt: num(l.resetsAt) ? (l.resetsAt as number) : null, at: l.at as number }]
      : [],
  )
}

/** When a session last asked the server for the quota, from the shared file; 0 when none has. */
export const polledAtOf = (text: string): number => {
  try {
    const o: unknown = JSON.parse(text)
    return isObject(o) && typeof o.polledAt === 'number' && Number.isFinite(o.polledAt) ? o.polledAt : 0
  } catch {
    return 0
  }
}

/**
 * The server's quota answer (`GET /api/oauth/usage`, what `/usage` shows): per window
 * `{ utilization: 0-100, resets_at: ISO }`, null for a window the plan lacks. Undocumented, so read
 * leniently: anything else is no reading.
 */
export const usageReplyLimits = (text: string, readAt: number): Limit[] => {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return []
  }
  if (!isObject(o)) return []
  return Object.entries(o)
    .flatMap(([kind, w]) => {
      if (!isObject(w) || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return []
      const at = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
      return [{ kind, pct: w.utilization, resetsAt: Number.isFinite(at) ? at : null, at: readAt }]
    })
    .sort(byRank)
}

/** A rate-limit window's short name: `five_hour` → `5h`, `seven_day_opus` → `7d opus`. */
export const limitLabel = (kind: string) =>
  kind
    .replace(/five[_ -]?hours?/i, '5h')
    .replace(/seven[_ -]?days?/i, '7d')
    .replace(/[_-]+/g, ' ')
    .trim()

// ---------------------------------------------------------------- cost split

/** A `costCommand` answer, read leniently: anything without a total is no split. */
export const parseCostSplit = (stdout: string, at: number): CostSplit | null => {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(stdout)
  } catch {
    return null
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (typeof o?.total_usd !== 'number') return null
  return {
    at,
    totalUsd: num(o.total_usd),
    mainUsd: num(o.main_usd),
    unpriced: num(o.unpriced_calls),
    agents: listOf<Record<string, unknown>>(o.agents).map(a => ({
      type: String(a.agent_type ?? 'agent'),
      description: String(a.description ?? ''),
      usd: num(a.usd),
    })),
  }
}

/**
 * One row per part: the main thread, the costliest agents by name, the rest summed, then unpriced calls.
 * The amount leads: the desktop sets rows in a proportional font, so a row sized by its character count
 * can still be truncated, and that must cut the description, never the amount.
 */
export const splitLines = (s: CostSplit, max = 6) => {
  const named = s.agents.slice(0, max).map(a => `${fmtUsd(a.usd)} ${a.type}${a.description ? ` · ${shorten(a.description.toLowerCase(), 28)}` : ''}`)
  const rest = s.agents.slice(max)
  const more = rest.length > 0 ? [`${fmtUsd(rest.reduce((n, a) => n + a.usd, 0))} +${rest.length} more`] : []
  const miss = s.unpriced > 0 ? [`${plural(s.unpriced, 'call')} unpriced`] : []
  return [`${fmtUsd(s.mainUsd)} main`, ...named, ...more, ...miss]
}

// ---------------------------------------------------------------- running agents

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** `claude-sonnet-5-5` → `Sonnet 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`; an alias capitalised; any other id as given. */
export const modelLabel = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  if (m?.[1] && m[2]) return `${cap(m[1].toLowerCase())} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return /^[a-z]+$/.test(id) ? cap(id) : id
}

/** `45s`, `1m59s`, `1h02m`. */
export const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** A tool call as Claude Code shows one: `Bash(run the tests)`, `Read(core.ts)`, `Grep(fmtAt)`; the tool alone when no argument names it. */
export const activityOf = (tool: string, args: Readonly<Record<string, unknown>>) => {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const file = s('file_path') || s('notebook_path')
  const what =
    tool === 'Bash'
      ? s('description') || s('command')
      : file
        ? (file.split('/').filter(Boolean).pop() ?? file)
        : s('description') || s('pattern') || s('query') || s('url') || s('path')
  return what ? `${tool}(${shorten(what, 40)})` : tool
}

/** A request's context: what it sent plus what it got back, as the desktop app's agent card counts tokens. */
export const contextTokens = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

/**
 * Two rows per agent: what it is doing, then how far it got. Each part is left out until its event has
 * been seen, so an agent spawned before a reload reads as its type alone.
 */
export const agentLines = (agents: readonly Running[], now: number, max = 4) => {
  const rows = agents.slice(0, max).flatMap(a => {
    const facts = [
      typeof a.startedAt === 'number' ? fmtElapsed(now - a.startedAt) : '',
      a.model ? modelLabel(a.model) : '',
      a.tokens ? `${kTokens(a.tokens)} ctx` : '',
      a.tools ? plural(a.tools, 'tool') : '',
      a.activity ?? '',
    ].filter(Boolean)
    return [`${a.type}${a.description ? ` · ${shorten(a.description, 48)}` : ''}`, ...(facts.length > 0 ? [facts.join(' · ')] : [])]
  })
  return [`${plural(agents.length, 'subagent')} running`, ...rows, ...(agents.length > max ? [`+${agents.length - max} more`] : [])]
}

// ---------------------------------------------------------------- cache clock

type Row = { type?: string; subtype?: string; isSidechain?: boolean; timestamp?: string; message?: { id?: string; usage?: unknown } }

/**
 * When the main loop's last answered request was sent, read from the tail of the session's transcript:
 * the last timed row before the last main-loop response (its own first row when none precedes it). The first
 * line of a tail is cut and skipped. null when no response is there or a compaction came after it.
 */
export const lastRequestAt = (tail: string): number | null => {
  const rows: Row[] = []
  for (const line of tail.split('\n').slice(1)) {
    try {
      rows.push(JSON.parse(line) as Row)
    } catch {
      // a cut or blank line
    }
  }
  const main = rows.filter(r => !r.isSidechain)
  let last = -1
  for (let i = main.length - 1; i >= 0; i--) {
    const r = main[i]
    if (r?.subtype === 'compact_boundary') return null
    if (r?.type === 'assistant' && r.message?.usage && r.message.id) {
      last = i
      break
    }
  }
  if (last < 0) return null
  const id = main[last]?.message?.id
  let first = last
  while (first > 0 && main[first - 1]?.type === 'assistant' && main[first - 1]?.message?.id === id) first--
  // The request went out after the last row written before its response: a tool result, a prompt, an attachment.
  const before = main.slice(0, first).filter(r => r.timestamp).pop()
  const at = Date.parse((before ?? main[first])?.timestamp ?? '')
  return Number.isFinite(at) ? at : null
}

/**
 * The main loop's context at its last response, read from the transcript's tail like `lastRequestAt`: what a
 * restarted process shows until its first response. null when no response is there or a compaction came after it.
 */
export const lastContextOf = (tail: string): number | null => {
  const lines = tail.split('\n').slice(1)
  for (let i = lines.length - 1; i >= 0; i--) {
    let r: Row
    try {
      r = JSON.parse(lines[i] ?? '') as Row
    } catch {
      continue
    }
    if (r.isSidechain) continue
    if (r.subtype === 'compact_boundary') return null
    const u = r.type === 'assistant' ? (r.message?.usage as Record<string, unknown> | undefined) : undefined
    if (u && typeof u.input_tokens === 'number') {
      const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
      return contextTokens({
        input_tokens: n('input_tokens'),
        output_tokens: n('output_tokens'),
        cache_read_input_tokens: n('cache_read_input_tokens'),
        cache_creation_input_tokens: n('cache_creation_input_tokens'),
      })
    }
  }
  return null
}

// ---------------------------------------------------------------- last prompt

/** A prompt as one line: line breaks and runs of spaces read as one space; a long paste keeps its head. */
export const promptLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 1000)

/** The person's last prompt as Claude Code records it in the transcript's `last-prompt` rows; null when the tail has none. */
export const lastPromptOf = (tail: string): string | null => {
  const lines = tail.split('\n').slice(1)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"last-prompt"')) continue
    try {
      const r = JSON.parse(line) as { type?: string; lastPrompt?: unknown }
      if (r.type === 'last-prompt' && typeof r.lastPrompt === 'string') return promptLine(r.lastPrompt) || null
    } catch {
      // a cut line
    }
  }
  return null
}
