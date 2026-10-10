import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Running, Usage } from '../types'
import {
  DEFAULT_USAGE,
  PALETTES,
  contextOf,
  fmtAt,
  fmtCacheMin,
  fmtLeft,
  fmtUsd,
  gaugeCells,
  kTokens,
  lastRequestAt,
  limitLabel,
  limitsOf,
  listOf,
  mergeLimits,
  normalize,
  parseConfig,
  parseCostSplit,
  plural,
  quotaLevel,
  splitLines,
} from './core'
import type { Config } from './core'

// ---------------------------------------------------------------- state

const usage = atom({ plugin: 'limits', key: 'usage' } as const, DEFAULT_USAGE)
const cacheAt = atom({ plugin: 'limits', key: 'cacheAt' } as const, 0)
const running = atom({ plugin: 'limits', key: 'running' } as const, [])
const costAtStart = atom({ plugin: 'limits', key: 'costAtStart' } as const, null)
const lastTurnUsd = atom({ plugin: 'limits', key: 'lastTurnUsd' } as const, null)
const split = atom({ plugin: 'limits', key: 'split' } as const, null)

// Every read goes through these, so a value saved under an older shape still reads.
async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, usage))
}
async function getRunning($: EngineInterface): Promise<Running[]> {
  return listOf<Running>(await read($, running))
}
const numOr = <T,>(v: unknown, d: T): number | T => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/**
 * A module loaded mid-session (a reload, a later install) has seen no request: the cache clock starts
 * from the transcript's last main-loop request instead. The transcript is found by session id, so no
 * project-folder naming is assumed; only its tail is read.
 */
async function seedCache($: EngineInterface) {
  if (numOr(await read($, cacheAt), 0) > 0) return
  const id = await $.session.id().catch(() => null)
  if (!id || !/^[\w-]+$/.test(id)) return
  const out = await $.process
    .run(['sh', '-c', 'tail -c 400000 "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null', 'sh', id], { timeoutMs: 5000 })
    .then(r => r.stdout)
    .catch(() => '')
  const at = lastRequestAt(out)
  if (at) await update($, cacheAt, x => (numOr(x, 0) > 0 ? x : at))
}

/**
 * The window Claude Code compacts against: `autoCompactWindow` from settings, or the model's own limit.
 * A `summary` breakdown is estimated locally and sends no request.
 */
async function readCompactWindow($: EngineInterface) {
  const u = await $.session.usage({ breakdown: 'summary', columns: 40 }).catch(() => null)
  const raw = u?.context.breakdown?.rawMaxTokens
  if (raw) await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), compactWindow: raw }))
}

/**
 * One run at a time: a turn end and a subagent's end often land together. A request during a run
 * queues one more, since the running one may have read the transcript before that end was written.
 */
let splitRunning = false
let splitAgain = false

/** The session's cost by transcript, from the person's `costCommand`; a failure keeps the last split. */
async function refreshSplit($: EngineInterface, cfg: Config) {
  if (cfg.costCommand.length === 0) return
  if (splitRunning) {
    splitAgain = true
    return
  }
  splitRunning = true
  try {
    do {
      splitAgain = false
      const sid = await $.session.id().catch(() => null)
      if (!sid) return
      const r = await $.process.run([...cfg.costCommand, sid], { timeoutMs: 15_000 }).catch(() => null)
      const s = r && r.exitCode === 0 ? parseCostSplit(r.stdout, await $.clock.now()) : null
      if (s) await update($, split, () => s)
    } while (splitAgain)
  } finally {
    splitRunning = false
  }
}

/** The session's cost read fresh, not from the last measurement: the last turn's cost subtracts two of these. */
async function costNow($: EngineInterface): Promise<number | null> {
  const u = await $.session.usage().catch(() => null)
  return u?.cost?.usd ?? null
}

async function resetAll($: EngineInterface) {
  await update($, cacheAt, () => 0)
  await update($, running, () => [])
  await update($, costAtStart, () => null)
  await update($, lastTurnUsd, () => null)
  await update($, split, () => null)
  // The context gauge waits for the next measurement rather than showing the pre-clear fill.
  await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), pct: null, tokens: null, compactions: 0 }))
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const C = PALETTES[cfg.palette]

  on('session.start', async ($, e, next) => {
    // A host without usage (headless, an SDK host, a session not yet bound) just starts without it.
    const u = await $.session.usage().catch(() => null)
    if (u) {
      const at = await $.clock.now()
      await update($, usage, x => ({
        ...normalize(DEFAULT_USAGE, x),
        pct: u.context.percent ?? null,
        tokens: u.context.tokens ?? null,
        window: u.context.window,
        costUsd: u.cost?.usd ?? null,
        limits: mergeLimits(normalize(DEFAULT_USAGE, x).limits, limitsOf(u.rateLimits), at),
      }))
    }
    await Promise.all([seedCache($), readCompactWindow($)])
    void refreshSplit($, cfg).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetAll($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const cost = await costNow($)
    await update($, costAtStart, () => cost)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const sentAt = await $.clock.now()
    const done = yield* next(e)
    if (done.usage) await update($, cacheAt, () => sentAt)
    return done
  })

  on('session.measure', async ($, e, next) => {
    const before = await getUsage($)
    const at = await $.clock.now()
    await update($, usage, x => ({
      ...normalize(DEFAULT_USAGE, x),
      pct: e.context.percent ?? null,
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      costUsd: e.cost?.usd ?? null,
      limits: mergeLimits(normalize(DEFAULT_USAGE, x).limits, limitsOf(e.rateLimits), at),
    }))
    // A model switch changes the window; the compaction window follows it.
    if (before.window !== e.context.window) await readCompactWindow($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.trigger !== 'precompute') {
      await update($, usage, x => {
        const u = normalize(DEFAULT_USAGE, x)
        return { ...u, compactions: u.compactions + 1 }
      })
      // The compacted context is a new prefix: nothing of it is cached until the next request.
      await update($, cacheAt, () => 0)
    }
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const agent: Running = { id: started.agentId, type: e.name ?? e.subagentType }
    await update($, running, list => [...listOf<Running>(list).filter(a => a.id !== agent.id), agent].slice(-24))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    if (id) {
      await update($, running, list => listOf<Running>(list).filter(a => a.id !== id))
      // A subagent's transcript is final once it ends: price it while the main turn may still run.
      void refreshSplit($, cfg).catch(() => undefined)
      return done
    }
    const [start, cost] = await Promise.all([read($, costAtStart), costNow($)])
    const from = numOr(start, null)
    await update($, lastTurnUsd, () => (from !== null && cost !== null ? Math.max(0, cost - from) : null))
    void refreshSplit($, cfg).catch(() => undefined)
    return done
  })

  // ---------------------------------------------------------------- drawing

  // What the rest of the app does not show, on one line above the prompt: quotas, context, cache, cost,
  // running agents. Calm while all is well: colour marks only what needs attention. Hovering a segment
  // shows its details.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const hasClient = 'Client' in els
    const [u, agents, cache, now, lastTurn, sp] = await Promise.all([
      getUsage($),
      getRunning($),
      read($, cacheAt),
      $.clock.now(),
      read($, lastTurnUsd),
      read($, split),
    ])
    const cx = contextOf(u)
    const sentAt = numOr(cache, 0)
    const last = numOr(lastTurn, null)
    const levelColor = { ok: C.text, warn: C.amber, hot: C.warn }
    const segments: { key: string; node: RenderChildren; detail: string[] }[] = []
    const add = (key: string, node: RenderChildren, detail: string | string[]) => segments.push({ key, node, detail: typeof detail === 'string' ? [detail] : detail })
    // One glyph for both parts keeps every gauge the same width in a proportional font.
    const meter = (label: string, pct: number, color: string) => {
      const filled = gaugeCells(pct, 6)
      return [
        <Text dimColor>{`${label} `}</Text>,
        <Text color={color === C.text ? C.dim : color}>{'━'.repeat(filled)}</Text>,
        <Text color={C.faint}>{'━'.repeat(6 - filled)}</Text>,
        <Text color={color} bold>{` ${Math.round(pct)}%`}</Text>,
      ]
    }

    for (const l of u.limits.filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')) {
      const label = limitLabel(l.kind)
      add(
        `quota-${l.kind}`,
        <Box>
          {meter(label, l.pct, levelColor[quotaLevel(l.pct)])}
          {l.resetsAt ? <Text dimColor> ↻</Text> : null}
          {!l.resetsAt ? null : hasClient ? (
            <els.Client key={`band-reset-${l.kind}`} module="./countdown.tsx" props={{ until: l.resetsAt, now, kind: 'left', color: C.dim, warn: C.amber, hot: C.warn }} />
          ) : (
            <Text dimColor>{fmtLeft(l.resetsAt - now)}</Text>
          )}
        </Box>,
        `${label} · ${Math.round(l.pct)}% used, ${Math.round(100 - l.pct)}% left${l.resetsAt ? ` · resets ${fmtAt(l.resetsAt, now)}` : ''}`,
      )
    }
    if (cx.pct !== null) {
      add(
        'ctx',
        <Box>
          {meter('ctx', cx.pct, cx.pct >= 80 ? C.warn : cx.pct >= 60 ? C.amber : C.text)}
          {u.compactions > 0 ? <Text color={C.amber}>{` ⟲${u.compactions}`}</Text> : null}
        </Box>,
        `ctx · ${u.tokens !== null ? `${kTokens(u.tokens)} of ${kTokens(cx.limit)} tokens` : `${Math.round(cx.pct)}%`}${u.compactions > 0 ? ` · ${plural(u.compactions, 'compaction')}` : ''}`,
      )
    }
    const until = sentAt + cfg.cacheTtlMs
    const ttl = cfg.cacheTtlMs >= 3_600_000 ? '1h' : '5m'
    add(
      'cache',
      <Box>
        <Text dimColor>cache </Text>
        {e.props.isWorking ? (
          <Text color={C.text}>● live</Text>
        ) : sentAt <= 0 ? (
          <Text dimColor>○ cold</Text>
        ) : hasClient ? (
          <els.Client key="band-cache" module="./countdown.tsx" props={{ until, now, kind: 'cacheMin', color: C.text, warn: C.amber, hot: C.warn }} />
        ) : (
          <Text color={until - now <= 0 ? C.warn : until - now < 5 * 60_000 ? C.amber : C.text}>
            {until - now <= 0 ? '○ cold' : `● ${fmtCacheMin(until - now)}`}
          </Text>
        )}
      </Box>,
      // Every request of a running turn re-arms the cache; the countdown starts once the turn ends.
      e.props.isWorking
        ? 'cache · live: each request of this turn refreshes it'
        : sentAt <= 0
          ? 'cache · cold: the next prompt rewrites it'
          : until <= now
            ? `cache · cold since ${fmtAt(until, now)}: the next prompt rewrites it`
            : `cache · warm until ${fmtAt(until, now)} (${ttl} TTL)`,
    )

    // The engine prices every response of the session, its subagents' included; on a plan it is the API-price equivalent.
    if (u.costUsd !== null) {
      add(
        'cost',
        <Text color={C.text}>{fmtUsd(u.costUsd)}</Text>,
        [
          `session ${fmtUsd(u.costUsd)} at API prices${sp ? '' : ', subagents included'}`,
          ...(sp ? splitLines(sp) : []),
          ...(last !== null ? [`+${fmtUsd(last)} last turn`] : []),
        ],
      )
    }

    // A segment like the rest, so a narrow band wraps it whole: squeezed at the right edge it read as `◐…`.
    if (agents.length > 0) {
      add(
        'agents',
        <Text color={C.agent}>{agents.length === 1 ? `◐ ${agents[0]?.type}` : `◐ ${agents.length} agents`}</Text>,
        [
          `${plural(agents.length, 'subagent')} running`,
          ...agents.slice(0, 6).map(a => a.type),
          ...(agents.length > 6 ? [`+${agents.length - 6} more`] : []),
        ],
      )
    }

    return (
      <Box width={Math.max(20, e.props.bodyColumns)}>
        <Box flexWrap="wrap" flexShrink={1}>
          {/* The gap trails each segment: a wrapped row then starts flush, where a leading `│` read as a stray mark. */}
          {segments.map(s => (
            <Box key={s.key} marginRight={2}>
              {s.node}
              {/* Shown while the pointer is on the segment. Sized to its longest row: unsized, it took the
                  segment's width and truncated. A terminal clips the rows past the band's own. */}
              <Box
                position="absolute"
                top={0}
                left={0}
                width={Math.min(Math.max(...s.detail.map(l => l.length)) + 2, Math.max(20, e.props.bodyColumns))}
                flexDirection="column"
                display="none"
                hover={{ display: 'flex' }}
                backgroundColor={C.faint}
                paddingX={1}
              >
                {s.detail.map((l, j) => (
                  <Text key={`${s.key}-${j}`} color={j === 0 ? C.text : C.dim} wrap="truncate">
                    {l}
                  </Text>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
