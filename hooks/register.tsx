import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { LastPrompt, Running, Usage } from '../types'
import {
  DEFAULT_USAGE,
  PALETTES,
  activityOf,
  agentLines,
  contextOf,
  contextTokens,
  fmtAt,
  fmtCacheLeft,
  fmtLeft,
  fmtUsd,
  gaugeCells,
  kTokens,
  lastPromptOf,
  lastRequestAt,
  limitLabel,
  limitsOf,
  listOf,
  mergeLimits,
  normalize,
  parseConfig,
  parseCostSplit,
  plural,
  promptLine,
  quotaLevel,
  shorten,
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
const lastPrompt = atom({ plugin: 'limits', key: 'lastPrompt' } as const, null)

// Every read goes through these, so a value saved under an older shape still reads.
async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, usage))
}
async function getRunning($: EngineInterface): Promise<Running[]> {
  return listOf<Running>(await read($, running))
}
/** Changes one running agent; an id not in the list (spawned before a reload) changes nothing. */
async function touch($: EngineInterface, id: string, f: (a: Running) => Running) {
  await update($, running, list => listOf<Running>(list).map(a => (a.id === id ? f(a) : a)))
}
async function getLastPrompt($: EngineInterface): Promise<LastPrompt | null> {
  const p = (await read($, lastPrompt)) as Partial<LastPrompt> | null
  return p && typeof p.text === 'string' && p.text ? { text: p.text, at: typeof p.at === 'number' ? p.at : null } : null
}
const PROMPT_MIN = 40
const PROMPT_FLOOR = 12
const numOr = <T,>(v: unknown, d: T): number | T => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/**
 * A module loaded mid-session (a reload, a resume, a later install) has seen no request and no prompt:
 * the cache clock starts from the transcript's last main-loop request, and the last prompt is the one
 * Claude Code recorded there. The transcript is found by session id, so no project-folder naming is
 * assumed; only its tail is read.
 */
async function seedFromTranscript($: EngineInterface) {
  const needCache = numOr(await read($, cacheAt), 0) <= 0
  const needPrompt = (await getLastPrompt($)) === null
  if (!needCache && !needPrompt) return
  const id = await $.session.id().catch(() => null)
  if (!id || !/^[\w-]+$/.test(id)) return
  const out = await $.process
    .run(['sh', '-c', 'tail -c 400000 "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null', 'sh', id], { timeoutMs: 5000 })
    .then(r => r.stdout)
    .catch(() => '')
  const at = needCache ? lastRequestAt(out) : null
  if (at) await update($, cacheAt, x => (numOr(x, 0) > 0 ? x : at))
  const text = needPrompt ? lastPromptOf(out) : null
  if (text) await update($, lastPrompt, x => x ?? { text, at: null })
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
  await update($, lastPrompt, () => null)
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
    await Promise.all([seedFromTranscript($), readCompactWindow($)])
    void refreshSplit($, cfg).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetAll($)
    return next(e)
  })

  // The person's own words: typed, through Remote Control, from an SDK host such as the desktop app, or
  // sent by a plugin as theirs. A task's notification, a peer session or a schedule is not their prompt.
  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    const o = e.origin
    const own = o.kind === 'composer' || o.kind === 'bridge' || o.kind === 'sdk' || (o.kind === 'plugin' && o.asUser === true)
    const text = promptLine(e.text)
    // The prompt has entered by now: a failure here must not reach the person as an error on it.
    if (own && text && !('drop' in done)) {
      await $.clock
        .now()
        .then(at => update($, lastPrompt, () => ({ text, at })))
        .catch(() => undefined)
    }
    return done
  })

  on('turn.start', async ($, e, next) => {
    const cost = await costNow($)
    await update($, costAtStart, () => cost)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const sentAt = id ? 0 : await $.clock.now()
    const done = yield* next(e)
    const u = done.usage
    if (u && id) await touch($, id, a => ({ ...a, model: u.model || a.model, tokens: contextTokens(u) }))
    else if (u) await update($, cacheAt, () => sentAt)
    return done
  })

  // Counted when a call starts, so the activity is what the agent is doing now. A failed write must not
  // fail the agent's tool.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      await touch($, id, a => ({ ...a, tools: (a.tools ?? 0) + 1, activity: activityOf(e.tool, e as unknown as Record<string, unknown>) })).catch(
        () => undefined,
      )
    }
    return next(e)
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
    const agent: Running = {
      id: started.agentId,
      type: e.name ?? e.subagentType,
      description: e.description || undefined,
      model: started.model || undefined,
      startedAt: await $.clock.now(),
    }
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
    const [u, agents, cache, now, lastTurn, sp, lp] = await Promise.all([
      getUsage($),
      getRunning($),
      read($, cacheAt),
      $.clock.now(),
      read($, lastTurnUsd),
      read($, split),
      getLastPrompt($),
    ])
    const cx = contextOf(u)
    const sentAt = numOr(cache, 0)
    const last = numOr(lastTurn, null)
    const levelColor = { ok: C.text, warn: C.amber, hot: C.warn }
    // `plain` is the segment as text, for its width in a terminal's cells.
    const segments: { key: string; node: RenderChildren; detail: string[]; cells: number }[] = []
    const add = (key: string, node: RenderChildren, detail: string | string[], plain: string) =>
      segments.push({ key, node, detail: typeof detail === 'string' ? [detail] : detail, cells: [...plain].length })
    const gauge = (label: string, pct: number) => `${label} ${'━'.repeat(6)} ${Math.round(pct)}%`
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
        `${gauge(label, l.pct)}${l.resetsAt ? ` ↻${fmtLeft(l.resetsAt - now)}` : ''}`,
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
        `${gauge('ctx', cx.pct)}${u.compactions > 0 ? ` ⟲${u.compactions}` : ''}`,
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
          <els.Client key="band-cache" module="./countdown.tsx" props={{ until, now, kind: 'cache', color: C.text, warn: C.amber, hot: C.warn }} />
        ) : (
          <Text color={until - now <= 0 ? C.warn : until - now < 5 * 60_000 ? C.amber : C.text}>
            {until - now <= 0 ? '○ cold' : `● ${fmtCacheLeft(until - now)}`}
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
      `cache ${e.props.isWorking ? '● live' : sentAt <= 0 || until <= now ? '○ cold' : `● ${fmtCacheLeft(until - now)}`}`,
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
        fmtUsd(u.costUsd),
      )
    }

    // A segment like the rest, so a narrow band wraps it whole: squeezed at the right edge it read as `◐…`.
    if (agents.length > 0) {
      const label = agents.length === 1 ? `◐ ${agents[0]?.type}` : `◐ ${agents.length} agents`
      add(
        'agents',
        <Text color={C.agent}>{label}</Text>,
        agentLines(agents, now),
        label,
      )
    }

    const width = Math.max(20, e.props.bodyColumns)
    const hoverWidth = (rows: string[]) => Math.min(Math.max(...rows.map(l => l.length)) + 2, width)
    const card = (key: string, rows: string[]) =>
      rows.map((l, j) => (
        <Text key={`${key}-${j}`} color={j === 0 ? C.text : C.dim} wrap={key === 'prompt' && j > 0 ? 'wrap' : 'truncate'}>
          {l}
        </Text>
      ))

    // A terminal paints in tree order, so a hover drawn inside its segment lay under the segments after
    // it, and it clips a hover to the band's own rows, so none can sit above the band. There the band keeps
    // a blank row under its segments, and a hover is drawn in it under its segment, shifted left to fit:
    // laid over the band's row it sat flush on the neighbours' text, and revealed as a row in the flow it
    // made the band jump. With no row to spare under `maxRows` the hover covers its segment's whole row.
    // Both places come from the band's wrap (its cells are known in a terminal). The segment lights its
    // hover through a scope.
    const terminal = e.surface === 'terminal'
    const placed: { row: number; col: number }[] = []
    let row = 0
    let col = 0
    for (const s of segments) {
      const room = s.cells + 2
      if (col > 0 && col + room > width) {
        row += 1
        col = 0
      }
      placed.push({ row, col })
      col += room
    }

    // The last prompt takes what its row has left, cut with `…`; with less than PROMPT_MIN cells left it
    // starts a row of its own. Its cells are set here, not by its text, so it is placed last. A band
    // taller than `maxRows` is folded into an `n more` row, hiding every segment: the prompt then stays
    // in what its row has left, or is left out.
    const plain = lp ? `❯ ${lp.text}` : ''
    const full = [...plain].length
    if (lp && col > 0 && width - col - 2 < Math.min(full, PROMPT_MIN) && row + 2 <= e.props.maxRows) {
      row += 1
      col = 0
    }
    const cells = Math.min(full, width - col - 2)
    // PROMPT_FLOOR bounds a cut prompt; a short one that fits whole always shows.
    if (lp && cells >= Math.min(full, PROMPT_FLOOR)) {
      segments.push({
        key: 'prompt',
        node: (
          <Box key="band-prompt" width={cells}>
            <Text color={C.dim} wrap="truncate">
              {plain}
            </Text>
          </Box>
        ),
        detail: [lp.at !== null ? `last prompt · sent ${fmtAt(lp.at, now)}` : 'last prompt', shorten(lp.text, 400)],
        cells,
      })
      placed.push({ row, col })
    }
    const under = row + 2 <= e.props.maxRows

    return (
      <Box width={width} flexDirection={terminal ? 'column' : 'row'}>
        <Box flexWrap="wrap" flexShrink={1}>
          {/* The gap trails each segment: a wrapped row then starts flush, where a leading `│` read as a stray mark. */}
          {segments.map(s =>
            terminal ? (
              <Box key={s.key} marginRight={2} hover={{ scope: `limits-${s.key}` }}>
                {s.node}
              </Box>
            ) : (
              <Box key={s.key} marginRight={2}>
                {s.node}
                {/* Shown while the pointer is on the segment. Sized to its longest row: unsized, it took the
                    segment's width and truncated. */}
                <Box
                  position="absolute"
                  top={0}
                  left={0}
                  width={hoverWidth(s.detail)}
                  flexDirection="column"
                  display="none"
                  hover={{ display: 'flex' }}
                  backgroundColor={C.faint}
                  paddingX={1}
                >
                  {card(s.key, s.detail)}
                </Box>
              </Box>
            ),
          )}
        </Box>
        {terminal && under ? (
          <Box key="hover-row" height={1} width={width}>
            {segments.map((s, i) => {
              const line = s.detail.join(' · ')
              const w = Math.min([...line].length, width)
              return (
                <Box
                  key={`hover-${s.key}`}
                  position="absolute"
                  top={0}
                  left={Math.max(0, Math.min(placed[i]?.col ?? 0, width - w))}
                  width={w}
                  display="none"
                  hover={{ scope: `limits-${s.key}`, display: 'flex' }}
                >
                  <Text color={C.dim} wrap="truncate">
                    {line}
                  </Text>
                </Box>
              )
            })}
          </Box>
        ) : null}
        {terminal && !under
          ? segments.map((s, i) => (
                <Box
                  key={`hover-${s.key}`}
                  position="absolute"
                  top={placed[i]?.row ?? 0}
                  left={0}
                  width={width}
                  display="none"
                  hover={{ scope: `limits-${s.key}`, display: 'flex' }}
                  backgroundColor={C.faint}
                  paddingX={1}
                >
                  {card(s.key, [s.detail.join(' · ')])}
                </Box>
            ))
          : null}
      </Box>
    )
  })
}
