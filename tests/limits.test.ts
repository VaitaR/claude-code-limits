import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { activityOf, agentLines, fmtAgo, fmtAt, fmtCacheLeft, fmtElapsed, fmtLeft, gaugeCells, modelLabel, hasReset, lastContextOf, lastPromptOf, lastRequestAt, mergeLimits, newestLimits, parseQuota, parseConfig, polledAtOf, usageReplyLimits, parseCostSplit, promptLine, quotaLevel, splitLines } from '../hooks/core'

// The type lib is es2023 alone; the test runtime has timers.
declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

// A terminal runs a hover's rows on as one line, joined by ` · `: there a row is a part of that line.
const hoverRow = (surface: string, re: RegExp) =>
  surface === 'terminal' ? new RegExp(`(?:^| · )${re.source.replace(/^\^|\$$/g, '')}(?: · |$)`) : re

// ---------------------------------------------------------------- pure behaviour

test('config is read leniently: bad values fall back to defaults', () => {
  expect(parseConfig({})).toEqual({ palette: 'theme', costCommand: [], cacheTtlMs: 3_600_000, quotaPollMs: 0 })
  expect(parseConfig({ palette: 'pastel', costCommand: '  python3   /x/cost.py ', cacheTtl: '5m', quotaPoll: '15m' })).toEqual({
    palette: 'pastel',
    costCommand: ['python3', '/x/cost.py'],
    cacheTtlMs: 300_000,
    quotaPollMs: 900_000,
  })
  expect(parseConfig({ palette: 7, costCommand: null, cacheTtl: 'forever', quotaPoll: '1s' })).toEqual(parseConfig({}))
})

test('a quota colours by what is used', () => {
  expect([quotaLevel(10), quotaLevel(70), quotaLevel(95)]).toEqual(['ok', 'warn', 'hot'])
})

test('a moment reads as wall time today, with the weekday further out', () => {
  const now = new Date(2026, 9, 10, 12, 0).getTime()
  expect(fmtAt(new Date(2026, 9, 10, 18, 40).getTime(), now)).toBe('18:40')
  expect(fmtAt(new Date(2026, 9, 15, 14, 5).getTime(), now)).toBe('Thu 14:05')
})

test('an age reads as time elapsed', () => {
  expect([fmtAgo(59_000), fmtAgo(5 * 60_000), fmtAgo(65 * 60_000), fmtAgo((51 * 60 + 2) * 60_000)]).toEqual(['just now', '5m ago', '1h05m ago', '2d03h ago'])
})

test('a reading without a window keeps the last one, past its reset too', () => {
  const h5 = { kind: 'five_hour', pct: 6, resetsAt: 5_000 }
  const d7 = { kind: 'seven_day', pct: 46, resetsAt: 9_000 }
  expect(mergeLimits([h5, d7], [])).toEqual([h5, d7])
  expect(mergeLimits([h5, d7], [{ ...d7, pct: 47 }])).toEqual([h5, { ...d7, pct: 47 }]) // order holds
  expect([hasReset(h5, 6_000), hasReset(d7, 6_000), hasReset({ ...d7, resetsAt: null }, 6_000)]).toEqual([true, false, false])
})

test('the newest reading of each window wins across sessions, a reset one included', () => {
  const h5 = { kind: 'five_hour', pct: 6, resetsAt: 5_000, at: 100 }
  const d7 = { kind: 'seven_day', pct: 46, resetsAt: 9_000, at: 100 }
  const other = [{ ...h5, pct: 30, at: 200 }, { ...d7, pct: 40, at: 50 }]
  expect(newestLimits([d7, h5], other)).toEqual([other[0], d7]) // per window, ranked 5h first
  const next = { kind: 'five_hour', pct: 2, resetsAt: 20_000, at: 6_000 }
  expect(newestLimits([h5], [next])).toEqual([next]) // the new window's reading replaces the reset one
  expect(newestLimits([{ kind: 'five_hour', pct: 1 }], [h5])).toEqual([h5]) // a reading without `at` loses
})

test('the shared quota file is read leniently', () => {
  const ok = { kind: 'five_hour', pct: 6, resetsAt: 5_000, at: 100 }
  expect(parseQuota(JSON.stringify({ limits: [ok, { kind: 'seven_day', pct: 'x', at: 1 }, { kind: 'x', pct: 1 }] }))).toEqual([ok])
  expect(parseQuota(JSON.stringify({ limits: [{ ...ok, resetsAt: undefined }] }))).toEqual([{ ...ok, resetsAt: null }])
  expect(parseQuota('not json')).toEqual([])
  expect(parseQuota('[]')).toEqual([])
})

test('a cost split reads costCommand output and names the costliest agents', () => {
  const out = JSON.stringify({
    total_usd: 5.85, main_usd: 5.75, unpriced_calls: 0,
    agents: [
      { agent_type: 'Explore', description: 'Count hooks in the mod', usd: 0.06 },
      { agent_type: 'Explore', description: 'Count tests', usd: 0.04 },
      { agent_type: 'Plan', description: '', usd: 0.03 },
    ],
  })
  const sp = parseCostSplit(out, 7)
  expect(sp?.agents.length).toBe(3)
  expect(splitLines(sp!, 2)).toEqual(['$5.75 main', '$0.06 Explore · count hooks in the mod', '$0.04 Explore · count tests', '$0.03 +1 more'])
  expect(splitLines({ ...sp!, agents: [], unpriced: 2 })).toEqual(['$5.75 main', '2 calls unpriced'])
  expect(parseCostSplit('{"error": "no transcript"}', 7)).toBe(null)
  expect(parseCostSplit('not json', 7)).toBe(null)
})

test('a running agent reads as its model, elapsed time and latest tool call', () => {
  expect(['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-20250514', 'claude-opus-5-5[1m]', 'haiku', 'gpt-x'].map(modelLabel)).toEqual(['Sonnet 5.5', 'Haiku 4.5', 'Opus 4', 'Opus 5.5', 'Haiku', 'gpt-x'])
  expect([45_400, 119_000, 3_720_000].map(fmtElapsed)).toEqual(['45s', '1m59s', '1h02m'])
  expect([
    activityOf('Bash', { command: 'npm test', description: 'Run the tests' }),
    activityOf('Bash', { command: 'ls' }),
    activityOf('Read', { file_path: '/w/hooks/core.ts' }),
    activityOf('Grep', { pattern: 'fmtAt' }),
    activityOf('TodoWrite', { todos: [] }),
  ]).toEqual(['Bash(Run the tests)', 'Bash(ls)', 'Read(core.ts)', 'Grep(fmtAt)', 'TodoWrite'])
  const a = { id: 'a', type: 'Explore', description: 'map', model: 'claude-sonnet-5-5', startedAt: 1_000, tokens: 156_000, tools: 48, activity: 'Bash(ls)' }
  expect(agentLines([a, { id: 'b', type: 'Plan' }], 120_000)).toEqual(['2 subagents running', 'Explore · map', '1m59s · Sonnet 5.5 · 156k ctx · 48 tools · Bash(ls)', 'Plan'])
  expect(agentLines([a, a, a], 120_000, 1).slice(-1)).toEqual(['+2 more'])
})

test('a gauge shows one cell for any use, none for zero', () => {
  expect([gaugeCells(4, 6), gaugeCells(0, 6), gaugeCells(50, 6), gaugeCells(100, 6), gaugeCells(140, 6)]).toEqual([1, 0, 3, 6, 6])
})

test('reset countdowns read in days, hours or minutes', () => {
  expect([fmtLeft(48 * 3_600_000), fmtLeft(2 * 3_600_000 + 5 * 60_000), fmtLeft(45 * 60_000)]).toEqual(['2d00h', '2h05m', '45m'])
})

test('the cache reads in minutes, then seconds in its last minute', () => {
  expect([59 * 60_000 + 5, 61_000, 59_500, 42_000, 400, 0].map(fmtCacheLeft)).toEqual(['59m', '1m', '59s', '42s', '1s', 'cold'])
})

const row = (o: Record<string, unknown>) => JSON.stringify(o)
const reply = (id: string, ts: string, extra: Record<string, unknown> = {}) =>
  row({ type: 'assistant', isSidechain: false, timestamp: ts, message: { id, usage: { input_tokens: 1 } }, ...extra })

test('a restarted process reads the main loop\'s last context from the transcript', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000, output_tokens: 1_000 }
  const main = row({ type: 'assistant', isSidechain: false, message: { id: 'm1', usage } })
  const side = row({ type: 'assistant', isSidechain: true, message: { id: 's1', usage: { input_tokens: 7 } } })
  expect(lastContextOf(['x', main, side].join('\n'))).toBe(96_010) // a subagent's row is skipped
  expect(lastContextOf(['x', main, row({ type: 'system', subtype: 'compact_boundary' })].join('\n'))).toBe(null)
  expect(lastContextOf(main)).toBe(null) // a tail's first line is cut
})

test('the cache clock is seeded from the request that fed the last main-loop response', () => {
  const tail = [
    '{"cut line',
    reply('m1', '2026-10-09T03:00:00.000Z'),
    row({ type: 'user', timestamp: '2026-10-09T03:05:00.000Z' }),
    row({ type: 'attachment', timestamp: '2026-10-09T03:05:01.000Z' }),
    reply('m2', '2026-10-09T03:05:20.000Z'),
    reply('m2', '2026-10-09T03:05:40.000Z'),
    reply('s1', '2026-10-09T03:06:00.000Z', { isSidechain: true }),
    row({ type: 'last-prompt' }),
  ].join('\n')
  expect(lastRequestAt(tail)).toBe(Date.parse('2026-10-09T03:05:01.000Z'))
  expect(lastRequestAt(tail + '\n' + row({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-09T03:07:00.000Z' }))).toBe(null)
  expect(lastRequestAt('')).toBe(null)
})

test('the last prompt reads as one line, from the newest last-prompt row of a transcript tail', () => {
  expect(promptLine('  fix the\n\n  flaky   test ')).toBe('fix the flaky test')
  expect(promptLine('x'.repeat(5000)).length).toBe(1000)
  const tail = ['{"cut', row({ type: 'last-prompt', lastPrompt: 'first' }), row({ type: 'user' }), row({ type: 'last-prompt', lastPrompt: 'second\nline' }), '{"type":"last-prompt","lastPr'].join('\n')
  expect(lastPromptOf(tail)).toBe('second line')
  expect(lastPromptOf(['x', row({ type: 'user' })].join('\n'))).toBe(null)
})

// ---------------------------------------------------------------- drawing

const engine = (on: On) => {
  mock.clock(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

let spawnN = 0
const spawn = (subagentType: string, description: string) => ({
  prompt: description,
  description,
  subagentType,
  tool_use_id: `tu${++spawnN}`,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

const band = (bodyColumns: number, hasSurvey = false, isWorking = false) => ({
  plugin: 'limits',
  component: 'AbovePrompt' as const,
  props: { hasSurvey, isWorking, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view: {} },
})

test('the band shows quotas, context and cache, running agents at the right, and the status line stays clear', async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const sent: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    sent.push(e.text)
    return { value: undefined }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  const H = 3_600_000
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 120_000, window: 200_000, percent: 60 },
      cost: { usd: 1 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(clock.now() + 4 * H).toISOString() },
        { kind: 'seven_day', percentUsed: 92 },
      ],
    },
  }))
  on('session.repo', () => ({ value: { root: '/w/r', remote: null, internal: false, name: null } }))
  on('process.run', (_$, e) => ({ value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: e.argv.includes('status') ? '## main\n M a.py\n' : '' } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'b1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'B1' })
  await $.agent.spawn(spawn('Explore', 'map'))
  expect(sent.filter(t => t !== undefined)).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [40, 120]) {
      const ui = await $.ui.mount({ ...band(cols), surface })
      for (const text of [/^5h $/, /^ 34%$/, /^ ↻$/, /^7d $/, /^ 92%$/, /^ctx $/, /^ 60%$/, /^━━━━$/, /^━━$/, /^cache $/, /^○ cold$/, /^◐ Explore$/,
        /^5h · 34% used, 66% left · resets \d\d:\d\d · read \d\d:\d\d$/, /^7d · 92% used, 8% left · read \d\d:\d\d$/, /^ctx · 120k of 200k tokens$/, /^cache · cold: the next prompt rewrites it$/,
        /^\$1\.00$/, /^session \$1\.00 at API prices, subagents included$/]) {
        expect([surface, cols, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, cols, String(text), expect.anything()])
      }
      // Running agents are a segment that wraps whole: squeezed at the right edge they read as `◐…`.
      expect([surface, cols, (await ui.find({ text: /^◐ Explore$/ }))?.props?.wrap]).toEqual([surface, cols, undefined])
      expect([surface, cols, await ui.find({ text: hoverRow(surface, /^1 subagent running$/) })]).toEqual([surface, cols, expect.anything()])
      // The reset clock is a Client on surfaces that have one, plain text otherwise.
      expect([surface, cols, (await ui.find({ key: 'band-reset-five_hour' })) ?? (await ui.find({ text: /^[34]h[0-5][0-9]m$/ }))]).toEqual([surface, cols, expect.anything()])
      // Shown elsewhere in the app, so not here.
      for (const text of [/Opus/, /^main$/, /⏰/, /▰|▱/, /│/]) expect([surface, cols, String(text), await ui.find({ text })]).toEqual([surface, cols, String(text), undefined])
      await ui.unmount()
    }
  }
})

test('the band shows a live cache as a dot and minutes, cold once the TTL passes', async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never
  })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'bypassPermissions' } as never)
  for await (const _ of $.turn.step({ turnId: 'T1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })) void _
  await clock.advance(12 * 60_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    expect([surface, await ui.find({ text: /^○ cold$/ })]).toEqual([surface, undefined])
    expect([surface, (await ui.find({ key: 'band-cache' })) ?? (await ui.find({ text: /^● 48m$/ }))]).toEqual([surface, expect.anything()])
    expect([surface, await ui.find({ text: /^cache · warm until \d\d:\d\d \(1h TTL\)$/ })]).toEqual([surface, expect.anything()])
    await ui.unmount()
    // While a turn runs, its requests keep the cache warm: no countdown.
    const working = await $.ui.mount({ ...band(120, false, true), surface })
    expect([surface, await working.find({ text: /^● live$/ }), await working.find({ key: 'band-cache' }), await working.find({ text: /^● 48m$/ })]).toEqual([surface, expect.anything(), undefined, undefined])
    await working.unmount()
  }
  await clock.advance(60 * 60_000)
  await $.classic.UserPromptSubmit({ prompt: 'again', permission_mode: 'bypassPermissions' } as never) // any write redraws
  const ui = await $.ui.mount({ ...band(120), surface: 'terminal' })
  expect((await ui.find({ text: /^○ cold$/ })) ?? (await ui.find({ key: 'band-cache' }))).toBeDefined()
  await ui.unmount()
})

test('a measurement without rate limits leaves the band quotas in place', async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const H = 3_600_000
  const ctx = { tokens: 120_000, window: 200_000, percent: 60 }
  await $.session.measure({ context: ctx, rateLimits: [{ kind: 'five_hour', percentUsed: 6, resetsAt: new Date(clock.now() + 4 * H).toISOString() }, { kind: 'seven_day', percentUsed: 46 }], changed: ['context', 'rateLimits'] })
  await $.session.measure({ context: ctx, rateLimits: [], changed: ['rateLimits'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    for (const text of [/^5h $/, /^ 6%$/, /^7d $/, /^ 46%$/]) expect([surface, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, String(text), expect.anything()])
    await ui.unmount()
  }
})

test('the band shows the session cost, and its hover adds what the last turn cost', async ($, on) => {
  engine(on)
  let usd = 2
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, cost: { usd }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.turn.start({ text: 'go', turnId: 'C1' })
  usd = 2.84
  await $.session.measure({ context: { tokens: 1_000, window: 200_000, percent: 1 }, cost: { usd }, rateLimits: [], changed: ['cost'] })
  await $.turn.complete({ turnId: 'C1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    expect([surface, await ui.find({ text: /^\$2\.84$/ })]).toEqual([surface, expect.anything()])
    for (const text of [/^session \$2\.84 at API prices, subagents included$/, /^\+\$0\.84 last turn$/]) expect([surface, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, String(text), expect.anything()])
    await ui.unmount()
  }
})

test('with a cost command, the cost hover splits the session by main thread and subagent', { options: { costCommand: 'python3 /x/cost.py' } }, async ($, on) => {
  engine(on)
  const argvs: string[][] = []
  on('session.id', () => ({ value: 'S-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, cost: { usd: 5.85 }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    const stdout = e.argv[0] === 'python3' ? JSON.stringify({ total_usd: 5.85, main_usd: 5.75, unpriced_calls: 0, agents: [{ agent_type: 'Explore', description: 'map', usd: 0.1 }] }) : ''
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout } }
  })
  await $.session.measure({ context: { tokens: 1_000, window: 200_000, percent: 1 }, cost: { usd: 5.85 }, rateLimits: [], changed: ['cost'] })
  await $.turn.start({ text: 'go', turnId: 'K1' })
  await $.turn.complete({ turnId: 'K1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  for (let i = 0; i < 20 && argvs.length === 0; i++) await Promise.resolve()
  expect(argvs).toContainEqual(['python3', '/x/cost.py', 'S-1'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    for (const text of [/^session \$5\.85 at API prices$/, /^\$5\.75 main$/, /^\$0\.10 Explore · map$/]) expect([surface, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, String(text), expect.anything()])
    await ui.unmount()
  }
})

const SPLIT = JSON.stringify({ total_usd: 5.85, main_usd: 5.75, unpriced_calls: 0, agents: [{ agent_type: 'Explore', description: 'map', usd: 0.1 }] })

test('an end that lands while the cost command runs queues one more run', { options: { costCommand: 'python3 /x/cost.py' } }, async ($, on) => {
  engine(on)
  on('session.id', () => ({ value: 'S-1' }))
  let runs = 0
  let release = () => {}
  on('process.run', async (_$, e) => {
    if (e.argv[0] !== 'python3') return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: '' } }
    runs++
    if (runs === 1) await new Promise<void>(r => (release = r))
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: SPLIT } }
  })
  await $.turn.start({ text: 'go', turnId: 'Q1' })
  await $.turn.complete({ turnId: 'Q1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  for (let i = 0; i < 20 && runs === 0; i++) await new Promise(r => setTimeout(r, 0))
  await $.turn.start({ text: 'go', turnId: 'Q2' })
  await $.turn.complete({ turnId: 'Q2', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  expect(runs).toBe(1)
  release()
  for (let i = 0; i < 20 && runs < 2; i++) await new Promise(r => setTimeout(r, 0))
  expect(runs).toBe(2)
})

test('a clear drops the previous session cost split', { options: { costCommand: 'python3 /x/cost.py' } }, async ($, on) => {
  engine(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'S-1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, cost: { usd: 5.85 }, rateLimits: [] } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  let runs = 0
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'python3') runs++
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: e.argv[0] === 'python3' ? SPLIT : '' } }
  })
  await $.session.measure({ context: { tokens: 1_000, window: 200_000, percent: 1 }, cost: { usd: 5.85 }, rateLimits: [], changed: ['cost'] })
  await $.turn.start({ text: 'go', turnId: 'K1' })
  await $.turn.complete({ turnId: 'K1', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  for (let i = 0; i < 20 && runs === 0; i++) await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
  const before = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await before.find({ text: /^\$5\.75 main$/ })).toBeDefined()
  await before.unmount()
  await $.session.end({ reason: 'clear', sessionId: 'S-1' } as never)
  const after = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await after.find({ text: /^\$5\.75 main$/ })).toBeUndefined()
  await after.unmount()
})


test('a survey holds the band', async ($, on) => {
  engine(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
  for (const [hasSurvey, isEngine] of [[true, true], [false, false]] as const) {
    const ui = await $.ui.mount({ ...band(120, hasSurvey), surface: 'desktop' })
    expect([hasSurvey, (await ui.find({ text: /^engine$/ })) !== undefined]).toEqual([hasSurvey, isEngine])
    expect([hasSurvey, (await ui.find({ text: /^cache $/ })) !== undefined]).toEqual([hasSurvey, !isEngine])
    await ui.unmount()
  }
})

test('a subagent leaves the band when it ends', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `r${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'R1' })
  await $.agent.spawn(spawn('Explore', 'map the dags folder'))
  await $.agent.spawn(spawn('general-purpose', 'finished already'))
  await $.turn.complete({ turnId: 'R1', agentId: 'r2', reason: 'answer', answer: 'ok', durationMs: 1 } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    expect([surface, await ui.find({ text: /^◐ Explore$/ })]).toEqual([surface, expect.anything()])
    expect([surface, await ui.find({ text: /general-purpose/ })]).toEqual([surface, undefined])
    await ui.unmount()
  }
})

test('several running subagents read as a count, named in the hover', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `m${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'M1' })
  for (const t of ['Explore', 'Plan', 'ship-verifier']) await $.agent.spawn(spawn(t, `${t} task`))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    for (const text of [/^◐ 3 agents$/, /^3 subagents running$/, /^Explore · Explore task$/, /^Plan · Plan task$/, /^ship-verifier · ship-verifier task$/, /^0s · Sonnet 5\.5$/]) expect([surface, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, String(text), expect.anything()])
    // A terminal clips a hover to the band's rows: there it is one line.
    if (surface === 'terminal') expect(await ui.find({ text: /^3 subagents running · Explore · Explore task · 0s · Sonnet 5\.5 · Plan · Plan task · / })).toBeDefined()
    await ui.unmount()
  }
})

test('a running subagent\'s hover shows its time, model, context, tool count and latest tool call', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'w1' }))
  on('tool.call', () => ({ ref: 0, result: {}, text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    const usage = { model: 'claude-haiku-4-5-20251001', input_tokens: 2_000, output_tokens: 1_000, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 150_000 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage } as never
  })
  await $.turn.start({ text: 'go', turnId: 'W1' })
  await $.agent.spawn(spawn('Explore', 'Map repo RPC client implementations'))
  for await (const _ of $.turn.step({ turnId: 'WA', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'w1' })) void _
  await $.tool.call({ tool: 'Read', file_path: '/w/hooks/core.ts', agentId: 'w1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'rg -n rpc', description: 'Find RPC clients', agentId: 'w1' } as never)
  // The main loop's own calls are not the agent's.
  await $.tool.call({ tool: 'Read', file_path: '/w/README.md' } as never)
  await clock.advance(119_000)
  await $.turn.start({ text: 'again', turnId: 'W2' }) // any write redraws
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(160), surface })
    for (const text of [/^Explore · Map repo RPC client implementations$/, /^1m59s · Haiku 4\.5 · 156k ctx · 2 tools · Bash\(Find RPC clients\)$/]) {
      expect([surface, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, String(text), expect.anything()])
    }
    await ui.unmount()
  }
})

test('a mod loaded mid-session starts the cache clock from the transcript, not cold', async ($, on) => {
  const clock = mock.clock(on)
  const sent = Date.parse('2026-10-09T03:05:01.000Z')
  await clock.advance(sent + 10 * 60_000)
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => { throw new Error('no usage') })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.repo', () => ({ value: null }))
  on('session.id', () => ({ value: 'abc-123' }))
  let argv: readonly string[] = []
  on('process.run', (_$, e) => {
    argv = e.argv
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: ['x', row({ type: 'user', timestamp: '2026-10-09T03:05:01.000Z' }), reply('m2', '2026-10-09T03:05:20.000Z')].join('\n') } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  expect(argv.at(-1)).toBe('abc-123') // the id goes in as an argument, never into the script
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    expect(await ui.find({ text: /^○ cold$/ })).toBeUndefined()
    expect((await ui.find({ key: 'band-cache' })) ?? (await ui.find({ text: /^● 50m$/ }))).toBeDefined()
    expect(await ui.find({ text: /^cache $/ })).toBeDefined()
    await ui.unmount()
  }
})

const submit = (text: string, origin: { kind: string; asUser?: true; name?: string }) =>
  ({ text, wait: false, origin }) as never

test('the band shows the person\'s last prompt, not a notification or another plugin\'s', async ($, on) => {
  engine(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.submit(submit('fix the\n flaky test in   core.ts', { kind: 'composer' }))
  await $.prompt.submit(submit('<task-notification>agent done</task-notification>', { kind: 'task-notification' }))
  await $.prompt.submit(submit('from a plugin', { kind: 'plugin', name: 'other' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [40, 120]) {
      const ui = await $.ui.mount({ ...band(cols), surface })
      expect([surface, cols, await ui.find({ text: /^❯ fix the flaky test in core\.ts$/ })]).toEqual([surface, cols, expect.anything()])
      for (const text of [/^last prompt$/, /^just now · fix the flaky test in core\.ts$/]) expect([surface, cols, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, cols, String(text), expect.anything()])
      for (const text of [/notification/, /from a plugin/]) expect([surface, String(text), await ui.find({ text })]).toEqual([surface, String(text), undefined])
      await ui.unmount()
    }
  }
  await $.prompt.submit(submit('typed on the phone', { kind: 'bridge' }))
  const phone = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await phone.find({ text: /^❯ typed on the phone$/ })).toBeDefined()
  // Every prompt is listed newest first, its age as elapsed time.
  for (const text of [/^last 2 prompts$/, /^just now · typed on the phone$/, /^just now · fix the flaky test in core\.ts$/]) expect([String(text), await phone.find({ text })]).toEqual([String(text), expect.anything()])
  await phone.unmount()
  await $.session.end({ reason: 'clear', sessionId: 'S-1' } as never)
  const cleared = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await cleared.find({ text: /^❯ / })).toBeUndefined()
  await cleared.unmount()
})

test('a mod loaded mid-session shows the last prompt the transcript recorded', async ($, on) => {
  engine(on)
  on('session.usage', () => { throw new Error('no usage') })
  on('session.id', () => ({ value: 'abc-123' }))
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: ['x', row({ type: 'last-prompt', lastPrompt: 'map the repo' })].join('\n') } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    expect([surface, await ui.find({ text: /^❯ map the repo$/ })]).toEqual([surface, expect.anything()])
    expect([surface, await ui.find({ text: hoverRow(surface, /^earlier · map the repo$/) })]).toEqual([surface, expect.anything()])
    await ui.unmount()
  }
})

test('the last prompt never makes the band taller than it may be', async ($, on) => {
  engine(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.submit(submit('a prompt long enough to want a row of its own in a narrow band', { kind: 'composer' }))
  const at = (cols: number, maxRows: number) => ({ ...band(cols), props: { ...band(cols).props, maxRows }, surface: 'terminal' as const })
  // `cache ○ cold` is the only other segment here: 12 cells and a gap of 2.
  for (const [cols, maxRows, width] of [[40, 10, 38], [40, 1, 24], [26, 1, undefined]] as const) {
    const ui = await $.ui.mount(at(cols, maxRows))
    expect([cols, maxRows, (await ui.find({ key: 'band-prompt' }))?.props?.width]).toEqual([cols, maxRows, width])
    await ui.unmount()
  }
})

test('a terminal hover sits in a kept row under its segment, or with none to spare covers the segment\'s row', async ($, on) => {
  engine(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.submit(submit('ping', { kind: 'composer' }))
  // `cache ○ cold` at column 0, `❯ ping` at 14; the prompt's hover (29 cells) is shifted left to fit 40.
  const prompt = 'last prompt · just now · ping'.length
  for (const [maxRows, row, cache, ping] of [
    // The cache's 41 cells are capped at the band's 40.
    [10, true, [0, 0, 40], [0, 40 - prompt, prompt]],
    [1, false, [0, 0, 40], [0, 0, 40]],
  ] as const) {
    const ui = await $.ui.mount({ ...band(40), props: { ...band(40).props, maxRows }, surface: 'terminal' })
    const at = async (key: string) => {
      const p = (await ui.find({ key }))?.props
      return [p?.top, p?.left, p?.width]
    }
    expect([maxRows, (await ui.find({ key: 'hover-row' })) !== undefined, await at('hover-cache'), await at('hover-prompt')]).toEqual([maxRows, row, cache, ping])
    await ui.unmount()
  }
})

test('a short prompt shows whole, even in less room than a cut one needs', async ($, on) => {
  engine(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.submit(submit('ping', { kind: 'composer' }))
  // 26 columns leave 10 cells after `cache ○ cold`: under PROMPT_FLOOR, but `❯ ping` takes 6.
  for (const cols of [120, 26]) {
    const ui = await $.ui.mount({ ...band(cols), props: { ...band(cols).props, maxRows: 1 }, surface: 'terminal' })
    expect([cols, (await ui.find({ key: 'band-prompt' }))?.props?.width, await ui.find({ text: /^❯ ping$/ })]).toEqual([cols, 6, expect.anything()])
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- shared quota

/** A config directory's quota file, as `fs.read`/`fs.write` see it. */
const quotaFile = (on: On, initial?: string) => {
  const file = { text: initial, writes: 0 }
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.read', (_$, e) => {
    if (e.path !== '/h/.claude/state/limits/quota.json' || file.text === undefined) throw new Error('ENOENT')
    return { value: file.text }
  })
  on('fs.write', (_$, e) => {
    if (e.path === '/h/.claude/state/limits/quota.json') {
      file.text = e.text
      file.writes++
    }
    return { value: undefined }
  })
  return file
}

test('a session with no reading of its own shows the latest one another session wrote', async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  const H = 3_600_000
  const at = clock.now() - 10 * 60_000
  quotaFile(on, JSON.stringify({ limits: [{ kind: 'five_hour', pct: 41, resetsAt: clock.now() + H, at }, { kind: 'seven_day', pct: 12, resetsAt: clock.now() - 1, at }] }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 'abc-123' }))
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ text: /^ 41%$/ })).toBeDefined()
  expect(await ui.find({ text: /^7d $/ })).toBeDefined() // its window reset since: drawn as reset, not stale
  expect(await ui.find({ text: /^ 12%$/ })).toBeUndefined()
  await ui.unmount()
})

test('a session\'s own reading goes to the shared file, unless the file holds a newer one', async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  const H = 3_600_000
  const file = quotaFile(on)
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const ctx = { tokens: 1_000, window: 200_000, percent: 1 }
  const resetsAt = new Date(clock.now() + H).toISOString()
  await $.session.measure({ context: ctx, rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt }], changed: ['rateLimits'] })
  await new Promise(r => setTimeout(r, 0))
  expect(parseQuota(file.text ?? '')).toEqual([{ kind: 'five_hour', pct: 20, resetsAt: Date.parse(resetsAt), at: clock.now() }])
  // Another session reads later and higher; ours, older, must not overwrite it.
  file.text = JSON.stringify({ limits: [{ kind: 'five_hour', pct: 35, resetsAt: Date.parse(resetsAt), at: clock.now() + 1 }] })
  const writes = file.writes
  await $.session.measure({ context: ctx, rateLimits: [], changed: ['context'] })
  await new Promise(r => setTimeout(r, 0))
  expect(file.writes).toBe(writes)
})

/** The poll is a chain of reads, a claim, a request and a sync: a few turns of the loop. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}

test('the server\'s quota answer is read leniently, a window the plan lacks dropped', () => {
  const reply = { seven_day: { utilization: 81, resets_at: '2026-10-30T07:00:00Z' }, five_hour: { utilization: 8, resets_at: '2026-10-28T02:30:00Z' }, seven_day_opus: null, extra_usage: { is_enabled: false } }
  expect(usageReplyLimits(JSON.stringify(reply), 5)).toEqual([
    { kind: 'five_hour', pct: 8, resetsAt: Date.parse('2026-10-28T02:30:00Z'), at: 5 },
    { kind: 'seven_day', pct: 81, resetsAt: Date.parse('2026-10-30T07:00:00Z'), at: 5 },
  ])
  expect(usageReplyLimits(JSON.stringify({ five_hour: { utilization: 3, resets_at: null } }), 5)).toEqual([{ kind: 'five_hour', pct: 3, resetsAt: null, at: 5 }])
  expect(usageReplyLimits('<html>', 5)).toEqual([])
  expect(usageReplyLimits('[]', 5)).toEqual([])
  expect(polledAtOf(JSON.stringify({ limits: [], polledAt: 7 }))).toBe(7)
  expect(polledAtOf(JSON.stringify({ limits: [] }))).toBe(0)
  expect(polledAtOf('x')).toBe(0)
})

test('with quotaPoll, one session per period asks the server and the band shows its answer', { options: { quotaPoll: '5m' } }, async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  const H = 3_600_000
  const file = quotaFile(on)
  const fetched: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 'abc-123' }))
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  const resetsAt = new Date(clock.now() + H).toISOString()
  on('http.fetch', (_$, e) => {
    fetched.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ five_hour: { utilization: 44, resets_at: resetsAt }, seven_day: null }) } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await settle()
  expect(fetched).toEqual(['https://api.anthropic.com/api/oauth/usage'])
  expect(parseQuota(file.text ?? '')).toEqual([{ kind: 'five_hour', pct: 44, resetsAt: Date.parse(resetsAt), at: clock.now() }])
  expect(polledAtOf(file.text ?? '')).toBe(clock.now())
  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ text: /^ 44%$/ })).toBeDefined()
  await ui.unmount()
  // Another session's start inside the period finds the claim and does not ask again.
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await settle()
  expect(fetched.length).toBe(1)
  await clock.advance(5 * 60_000)
  await settle()
  expect(fetched.length).toBe(2)
})

test('without quotaPoll the mod never asks the server', async ($, on) => {
  mock.clock(on)
  quotaFile(on)
  let fetched = 0
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 'abc-123' }))
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', () => (fetched++, { value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  expect(fetched).toBe(0)
})

test('a restarted process shows the context its transcript last recorded', async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  quotaFile(on)
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 'abc-123' }))
  const usage = { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 0 }
  const out = ['x', row({ type: 'assistant', isSidechain: false, timestamp: '2026-10-09T03:05:01.000Z', message: { id: 'm1', usage } })].join('\n')
  on('process.run', () => ({ value: { exitCode: 0, stderr: '', stdout: out, isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ text: /^ctx $/ })).toBeDefined()
  expect(await ui.find({ text: /^ 50%$/ })).toBeDefined()
  await ui.unmount()
})

test('a quota whose window reset while the session sat idle stays drawn, as reset', async ($, on) => {
  const clock = mock.clock(on)
  await clock.advance(60_000)
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const ctx = { tokens: 1_000, window: 200_000, percent: 1 }
  const resetsAt = new Date(clock.now() + 60_000).toISOString()
  await $.session.measure({ context: ctx, rateLimits: [{ kind: 'five_hour', percentUsed: 88, resetsAt }, { kind: 'seven_day', percentUsed: 12 }], changed: ['rateLimits'] })
  await clock.advance(2 * 60_000)
  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ text: /^ 88%$/ })).toBeUndefined()
  expect(await ui.find({ text: /^5h $/ })).toBeDefined()
  expect(await ui.find({ text: /^ 0%$/ })).toBeDefined()
  expect(await ui.find({ text: /88% before the reset/ })).toBeDefined()
  expect(await ui.find({ text: /^ 12%$/ })).toBeDefined()
  await ui.unmount()
})
