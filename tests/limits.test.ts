import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fmtAt, fmtCacheLeft, fmtLeft, gaugeCells, lastPromptOf, lastRequestAt, mergeLimits, parseConfig, parseCostSplit, promptLine, quotaLevel, splitLines } from '../hooks/core'

// The type lib is es2023 alone; the test runtime has timers.
declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

// A terminal runs a hover's rows on as one line, joined by ` · `: there a row is a part of that line.
const hoverRow = (surface: string, re: RegExp) =>
  surface === 'terminal' ? new RegExp(`(?:^| · )${re.source.replace(/^\^|\$$/g, '')}(?: · |$)`) : re

// ---------------------------------------------------------------- pure behaviour

test('config is read leniently: bad values fall back to defaults', () => {
  expect(parseConfig({})).toEqual({ palette: 'theme', costCommand: [], cacheTtlMs: 3_600_000 })
  expect(parseConfig({ palette: 'pastel', costCommand: '  python3   /x/cost.py ', cacheTtl: '5m' })).toEqual({
    palette: 'pastel',
    costCommand: ['python3', '/x/cost.py'],
    cacheTtlMs: 300_000,
  })
  expect(parseConfig({ palette: 7, costCommand: null, cacheTtl: 'forever' })).toEqual(parseConfig({}))
})

test('a quota colours by what is used', () => {
  expect([quotaLevel(10), quotaLevel(70), quotaLevel(95)]).toEqual(['ok', 'warn', 'hot'])
})

test('a moment reads as wall time today, with the weekday further out', () => {
  const now = new Date(2026, 9, 10, 12, 0).getTime()
  expect(fmtAt(new Date(2026, 9, 10, 18, 40).getTime(), now)).toBe('18:40')
  expect(fmtAt(new Date(2026, 9, 15, 14, 5).getTime(), now)).toBe('Thu 14:05')
})

test('a reading without a window keeps the last one until it resets', () => {
  const h5 = { kind: 'five_hour', pct: 6, resetsAt: 5_000 }
  const d7 = { kind: 'seven_day', pct: 46, resetsAt: 9_000 }
  expect(mergeLimits([h5, d7], [], 1_000)).toEqual([h5, d7])
  expect(mergeLimits([h5, d7], [{ ...d7, pct: 47 }], 1_000)).toEqual([h5, { ...d7, pct: 47 }]) // order holds
  expect(mergeLimits([h5, d7], [], 6_000)).toEqual([d7]) // the 5h window reset: its old reading is gone
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
        /^5h · 34% used, 66% left · resets \d\d:\d\d$/, /^7d · 92% used, 8% left$/, /^ctx · 120k of 200k tokens$/, /^cache · cold: the next prompt rewrites it$/,
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
  for (const t of ['Explore', 'Plan', 'ship-verifier']) await $.agent.spawn(spawn(t, 'x'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(120), surface })
    for (const text of [/^◐ 3 agents$/, /^3 subagents running$/, /^Explore$/, /^Plan$/, /^ship-verifier$/]) expect([surface, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, String(text), expect.anything()])
    // A terminal clips a hover to the band's rows: there it is one line.
    if (surface === 'terminal') expect(await ui.find({ text: /^3 subagents running · Explore · Plan · ship-verifier$/ })).toBeDefined()
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
      for (const text of [/^last prompt · sent \d\d:\d\d$/, /^fix the flaky test in core\.ts$/]) expect([surface, cols, String(text), await ui.find({ text: hoverRow(surface, text) })]).toEqual([surface, cols, String(text), expect.anything()])
      for (const text of [/notification/, /from a plugin/]) expect([surface, String(text), await ui.find({ text })]).toEqual([surface, String(text), undefined])
      await ui.unmount()
    }
  }
  await $.prompt.submit(submit('typed on the phone', { kind: 'bridge' }))
  const phone = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await phone.find({ text: /^❯ typed on the phone$/ })).toBeDefined()
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
    expect([surface, await ui.find({ text: hoverRow(surface, /^last prompt$/) })]).toEqual([surface, expect.anything()])
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
  // `cache ○ cold` at column 0, `❯ ping` at 14; the prompt's hover (31 cells) is shifted left to fit 40.
  const prompt = 'last prompt · sent 00:00 · ping'.length
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
