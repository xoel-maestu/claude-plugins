// Mod tests, run against the engine itself: `claude plugin test .`. Every figure is synthetic.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextUsage, SessionMessage, TurnUsage } from 'claude-code'

import { clockTime } from './card'

const WINDOW = 200_000

const fill = (percent?: number): SessionContextUsage =>
  percent === undefined ? { window: WINDOW } : { window: WINDOW, tokens: (WINDOW * percent) / 100, percent }

const summary: SessionMessage = { role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }

type Breakdown = { percentage: number; totalTokens: number; threshold?: number; raw?: number } | null

/**
 * Everything beneath the mod: the session's usage, the summary breakdown it counts (null when there
 * is none), how many counts were asked, the commands registered and what the engine draws. `hold`,
 * when set, keeps a count waiting until it resolves; `onCount` hears a count begin.
 */
function world (on: On, context: SessionContextUsage = fill(), breakdown: Breakdown = null) {
  const live = {
    context,
    breakdown,
    counts: 0,
    hold: undefined as Promise<void> | undefined,
    // Holds the plain usage call too, as a slow host would.
    plainHold: undefined as Promise<void> | undefined,
    onCount: () => {},
    // The session start and cost the usage call reports, and the counts the next model response carries.
    startedAt: 0,
    cost: undefined as { usd: number } | undefined,
    usage: null as TurnUsage | null,
    // Rate-limit windows: a subscription has some, an API key none.
    rateLimits: [] as never[],
  }
  const clock = mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test-session' }) as never)
  on('session.compact', () => ({ messages: [summary] }) as never)
  on('config.set', ($, e) => ({ value: e.value }))
  on('command.register', () => ({ value: { command: 'context-meter' } }) as never)
  on('session.usage', async ($, e) => {
    if (e.breakdown === undefined) await live.plainHold
    if (e.breakdown === undefined) return { value: { startedAt: live.startedAt, context: live.context, rateLimits: live.rateLimits, cost: live.cost } }
    live.counts += 1
    live.onCount()
    const b = live.breakdown
    await live.hold
    const counted = b === null ? undefined : {
      percentage: b.percentage,
      totalTokens: b.totalTokens,
      rawMaxTokens: b.raw ?? WINDOW,
      isAutoCompactEnabled: b.threshold !== undefined,
      autoCompactThreshold: b.threshold,
    }
    return { value: { startedAt: live.startedAt, context: { ...live.context, breakdown: counted }, rateLimits: live.rateLimits, cost: live.cost } as never }
  })
  // The model's response to a request: no text, the counts in live.usage.
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: live.usage }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // The engine's own node: a keyed Box when it has mode labels, its bare node otherwise.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if ('hint' in e.props) return <Text>{e.props.hint}</Text>
    const modes = 'modes' in e.props ? e.props.modes : []
    return modes.length > 0 ? <Box key="engine" /> : ({ type: 'engine', ref: 0 } as const)
  })
  return { live, clock }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const measure = ($: Engine, percent?: number) =>
  $.session.measure({ context: fill(percent), rateLimits: [], changed: ['context'] })
const footer = ($: Engine, columns?: number, modes: string[] = []) =>
  $.ui.mount({
    plugin: 'context-meter',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes },
    viewport: columns === undefined ? undefined : { columns, rows: 30 },
  })
const hint = ($: Engine, text: string) =>
  $.ui.mount({ plugin: 'context-meter', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: text } })

// A slash command typed at the prompt; the kit fills nothing of the input for a test.
const runCommand = ($: Engine) =>
  $.command.run({ command: 'context-meter', args: '', origin: { kind: 'composer' } } as never)
type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | null | undefined
/** The texts drawn on the row, in order, leaving out the card placed out of the flow. */
function onRow (node: Drawn): string[] {
  if (node === null || node === undefined) return []
  if (typeof node === 'string') return [node]
  if (node.props?.position === 'absolute') return []
  if (node.type === 'Text') return [(node.children ?? []).join('')]
  return (node.children ?? []).flatMap(child => onRow(child as Drawn))
}
const row = async (ui: { drawn: () => Promise<unknown> }) => onRow((await ui.drawn()) as Drawn)

test('shows the fill as a bar, dim below warnAt', async ($, on) => {
  world(on, fill(30))
  await startSession($)
  const ui = await footer($)
  expect(await row(ui)).toEqual(['ctx ', '━━', '──── ', '30%'])
  expect(await ui.find({ type: 'Text', text: '30%' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ key: 'context-meter' })).toBeDefined()
})

test('warning from 50%, error from 75%', async ($, on) => {
  world(on, fill(10))
  await startSession($)
  await measure($, 62)
  const warn = await footer($)
  expect(await row(warn)).toEqual(['ctx ', '━━━━', '── ', '62%'])
  expect(await warn.find({ type: 'Text', text: '62%' })).toMatchObject({ props: { color: 'warning' } })
  expect(await warn.find({ type: 'Text', text: '━━━━' })).toMatchObject({ props: { color: 'warning' } })
  await measure($, 82)
  expect(await (await footer($)).find({ type: 'Text', text: '82%' })).toMatchObject({ props: { color: 'error' } })
})

test('takes its thresholds from the settings', { options: { warnAt: 40, dangerAt: 60 } }, async ($, on) => {
  world(on, fill(45))
  await startSession($)
  expect(await (await footer($)).find({ type: 'Text', text: '45%' })).toMatchObject({ props: { color: 'warning' } })
  await measure($, 60)
  expect(await (await footer($)).find({ type: 'Text', text: '60%' })).toMatchObject({ props: { color: 'error' } })
})

test('a warnAt above dangerAt is swapped, so the warning color stays', { options: { warnAt: 80, dangerAt: 60 } }, async ($, on) => {
  world(on, fill(65))
  await startSession($)
  expect(await (await footer($)).find({ type: 'Text', text: '65%' })).toMatchObject({ props: { color: 'warning' } })
  await measure($, 80)
  expect(await (await footer($)).find({ type: 'Text', text: '80%' })).toMatchObject({ props: { color: 'error' } })
})

test('at 200, 120 and 80 columns with the usual hint the bar fits', async ($, on) => {
  world(on, fill(62))
  await startSession($)
  await hint($, '? for shortcuts')
  for (const columns of [200, 120, 80]) expect(await row(await footer($, columns))).toEqual(['ctx ', '━━━━', '── ', '62%'])
})

test('at 80 columns a long hint takes the bar, then the prefix, then the meter', async ($, on) => {
  world(on, fill(62))
  await startSession($)
  // 80 - 26 for the footer - 1 before the hint leaves 53 - hint for the meter.
  await hint($, 'x'.repeat(39)) // 14 left
  expect(await row(await footer($, 80))).toEqual(['ctx ', '━━━━', '── ', '62%'])
  await hint($, 'x'.repeat(40)) // 13 left
  expect(await row(await footer($, 80))).toEqual(['ctx ', '62%'])
  await hint($, 'x'.repeat(47)) // 6 left
  expect(await row(await footer($, 80))).toEqual(['62%'])
  await hint($, 'x'.repeat(51)) // 2 left
  const none = await footer($, 80)
  expect(await none.find({ key: 'context-meter' })).toBeUndefined()
})

test('estimates with ~ from the breakdown while the engine has no figure', async ($, on) => {
  const w = world(on, fill(), { percentage: 16, totalTokens: 32_000 })
  await startSession($)
  await w.clock.advance(2000)
  expect(await row(await footer($))).toEqual(['ctx ', '━', '──── ', '~16%'])
  // Counted once for the stretch, not on every check.
  await w.clock.advance(10_000)
  expect(w.live.counts).toBe(1)
})

test('the next response replaces the estimate', async ($, on) => {
  world(on, fill(), { percentage: 16, totalTokens: 32_000 })
  await startSession($)
  await measure($, 17)
  expect(await row(await footer($))).toEqual(['ctx ', '━', '───── ', '17%'])
})

test('estimates again after a compaction', async ($, on) => {
  world(on, fill(82), { percentage: 12, totalTokens: 24_000 })
  await startSession($)
  await measure($)
  expect(await (await footer($)).find({ type: 'Text', text: '~12%' })).toBeDefined()
})

test('shows nothing with neither a figure nor a breakdown', async ($, on) => {
  const w = world(on, fill(), null)
  await startSession($)
  await w.clock.advance(10_000)
  expect(await (await footer($)).find({ key: 'context-meter' })).toBeUndefined()
  // Counted once for the stretch even with nothing to show; a compaction opens a new one.
  expect(w.live.counts).toBe(1)
  await measure($, 30)
  await measure($)
  await w.clock.advance(10_000)
  expect(w.live.counts).toBe(2)
})

test('a figure that arrives while counting is not replaced by the estimate', async ($, on) => {
  const w = world(on, fill(), { percentage: 16, totalTokens: 32_000 })
  await startSession($)
  let release = () => {}
  w.live.hold = new Promise(resolve => { release = resolve })
  const counting = new Promise<void>(resolve => { w.live.onCount = resolve })
  const pending = runCommand($)
  // The response lands while the count is out.
  await counting
  w.live.context = fill(17)
  await measure($, 17)
  release()
  await pending
  expect(await row(await footer($))).toEqual(['ctx ', '━', '───── ', '17%'])
})

test('the estimate is measured against the context window, as the figure is', async ($, on) => {
  // A compaction window of 160k: the breakdown says 20%, the meter shows 32k over 200k.
  world(on, fill(), { percentage: 20, totalTokens: 32_000, raw: 160_000 })
  await startSession($)
  const result = await runCommand($)
  expect(result.text?.split('\n')[0]).toBe('Context   ~32k / 200k   ~16%')
})

test('reads the autocompact point again after a compaction', async ($, on) => {
  const w = world(on, fill(), { percentage: 16, totalTokens: 32_000, threshold: 167_000 })
  await startSession($)
  await w.clock.advance(2000)
  w.live.breakdown = { percentage: 6, totalTokens: 12_000, threshold: 150_000 }
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await w.clock.advance(2000)
  expect((await runCommand($)).text?.split('\n')).toEqual(['Context   ~12k / 200k   ~6%', '━'.repeat(2) + '─'.repeat(34), 'Autocompact at ~150k'])
})

test('reads the autocompact point again after /clear', async ($, on) => {
  const w = world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  await measure($, 62)
  w.live.breakdown = { percentage: 60, totalTokens: 120_000, threshold: 150_000 }
  await $.session.end({ reason: 'clear' } as never)
  await measure($, 62)
  expect((await runCommand($)).text?.split('\n').slice(0, 3)).toEqual(['Context   124k / 200k   62%', '━'.repeat(22) + '─'.repeat(14), 'Autocompact at ~150k'])
})

test('reads the autocompact point again when autocompact is switched in /config', async ($, on) => {
  const w = world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  await measure($, 62)
  w.live.breakdown = { percentage: 60, totalTokens: 120_000 }
  await $.config.set({ key: 'autoCompact', value: false, previous: true, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } } as never)
  await w.clock.advance(2000)
  expect((await runCommand($)).text?.split('\n')).toEqual(['Context   124k / 200k   62%', '━'.repeat(22) + '─'.repeat(14)])
})

type Node = { type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
/** The hidden Box a drawing reveals on hover (the card's holder), if any. */
function placedIn (node: unknown): Node | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const n = node as Node
  if (n.props?.display === 'none') return n
  for (const child of n.children ?? []) {
    const found = placedIn(child)
    if (found !== undefined) return found
  }
  return undefined
}
/** The card the band draws: the hidden holder, the bordered Box in it, and its rows as text. */
async function cardIn (ui: { drawn: () => Promise<unknown> }) {
  const holder = placedIn(await ui.drawn())
  const box = holder?.children?.[0] as Node | undefined
  const text = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as Node | null)?.children ?? []).map(text).join('')
  return { holder, box, rows: (box?.children ?? []).map(text) }
}

const band = ($: Engine, bodyColumns = 115, hasSurvey = false) =>
  $.ui.mount({
    plugin: 'context-meter',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 30, bodyColumns, scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: bodyColumns + 5, rows: 30 },
  })

test('the footer draws no card: the meter alone, joined to the hover group', async ($, on) => {
  world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  await measure($, 62)
  const ui = await footer($, 120)
  const drawn = (await ui.drawn()) as Node
  expect(placedIn(drawn)).toBeUndefined()
  // The tree keeps a hover beside the props.
  expect(drawn.children?.[0]).toMatchObject({ props: { key: 'context-meter' }, hover: { scope: 'context-meter' } })
})

test('every cell the footer drawing holds is on the row, as a plugin above it would count', async ($, on) => {
  world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  await measure($, 62)
  // A plain walk of every Text, as sub-meter measures what is beneath it: no card in the sum.
  const all = (node: unknown): number => {
    if (typeof node === 'string') return [...node].length
    if (node === null || typeof node !== 'object') return 0
    return ((node as Node).children ?? []).reduce((sum: number, child) => sum + all(child), 0)
  }
  expect(all(await (await footer($, 120)).drawn())).toBe(14)
})

test('the hover card, in the band: last in the flow, right-aligned, hidden until the group lights, three rows', async ($, on) => {
  world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  await measure($, 62)
  const ui = await band($)
  const drawn = (await ui.drawn()) as Node
  const { holder, box, rows } = await cardIn(ui)
  // The holder: the last in the flow, as wide as the band, pushing the card to its right end.
  expect(drawn.children?.at(-1)).toEqual(holder)
  expect(holder?.props).toMatchObject({ width: 115, justifyContent: 'flex-end', display: 'none' })
  expect(holder?.hover).toEqual({ scope: 'context-meter', display: 'flex' })
  expect(box?.props).toMatchObject({ width: 40, height: 5, borderStyle: 'round', borderDimColor: true })
  expect(box?.props?.position).toBeUndefined()
  // Each row is the content (36) with a column of padding at each side: the border's inside.
  expect(rows).toEqual([
    ' ' + 'Context   124k / 200k   62%'.padEnd(36) + ' ',
    ' ' + '━'.repeat(22) + '─'.repeat(14) + ' ',
    ' ' + 'Autocompact at ~167k'.padEnd(36) + ' ',
  ])
})

test('the band keeps what is beneath it first in the flow, the card hidden after it', async ($, on) => {
  // Beneath: another plugin's line in the band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{'other plugin'}</Text>
  })
  world(on, fill(62))
  await startSession($)
  await measure($, 62)
  const drawn = (await (await band($)).drawn()) as Node
  expect(drawn.children).toHaveLength(2)
  expect(drawn.children?.[0]).toMatchObject({ type: 'Text', children: ['other plugin'] })
  // The rest is the card's holder, hidden (no row) until the hover group lights.
  const holder = drawn.children?.[1] as Node
  expect(holder.props).toMatchObject({ display: 'none' })
  expect(holder.children).toHaveLength(1)
})

test('with no figure the band is passed through as it came, so it gets no blank row', async ($, on) => {
  world(on, fill(), null)
  await startSession($)
  const drawn = await (await band($)).drawn()
  expect(placedIn(drawn)).toBeUndefined()
  expect(drawn).toEqual({ type: 'engine', ref: 0 })
})

test('the band yields to a survey', async ($, on) => {
  world(on, fill(62))
  await startSession($)
  await measure($, 62)
  expect(placedIn(await (await band($, 115, true)).drawn())).toBeUndefined()
})

test('the card leaves out the autocompact row when the breakdown has none, a row shorter', async ($, on) => {
  world(on, fill(62), null)
  await startSession($)
  await measure($, 62)
  const { box, rows } = await cardIn(await band($))
  expect(box?.props).toMatchObject({ height: 4 })
  expect(rows.map(row => row.trim())).toEqual(['Context   124k / 200k   62%', '━'.repeat(22) + '─'.repeat(14)])
})

test('the card narrows to a narrow band and takes the meter color past warnAt', async ($, on) => {
  world(on, fill(62), null)
  await startSession($)
  await measure($, 62)
  const { box } = await cardIn(await band($, 30))
  expect(box?.props).toMatchObject({ width: 30 })
  expect(JSON.stringify(box)).toContain('"color":"warning"')
})

test('the card in Spanish', { options: { language: 'es' } }, async ($, on) => {
  world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  await measure($, 62)
  const { rows } = await cardIn(await band($))
  expect(rows.map(row => row.trim())).toEqual(['Contexto   124k / 200k   62%', '━'.repeat(22) + '─'.repeat(14), 'Autocompacta en ~167k'])
})

test('/context-meter prints the card as text, or says there is no figure', async ($, on) => {
  const w = world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  const result = await runCommand($)
  expect(result.text).toBe('Context   124k / 200k   62%\n' + '━'.repeat(22) + '─'.repeat(14) + '\nAutocompact at ~167k')
  w.live.context = fill()
  w.live.breakdown = null
  await $.session.end({ reason: 'clear' } as never)
  expect((await runCommand($)).text).toBe('No context figure yet.')
})

test("keeps another plugin's drawing beneath, after the meter, and counts its width", async ($, on) => {
  // Beneath the meter: another plugin's part of the row.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{'⏵ other plugin'}</Text>
  })
  world(on, fill(62))
  await startSession($)
  expect(await row(await footer($, 120))).toEqual(['ctx ', '━━━━', '── ', '62%', ' · ', '⏵ other plugin'])
  // 60 - 26 = 34, less 14 beneath and 3 between: 17 left, the bar fits; at 50, 7: the short form.
  expect(await row(await footer($, 60))).toEqual(['ctx ', '━━━━', '── ', '62%', ' · ', '⏵ other plugin'])
  expect(await row(await footer($, 50))).toEqual(['ctx ', '62%', ' · ', '⏵ other plugin'])
  expect(await row(await footer($, 40))).toEqual(['⏵ other plugin'])
})

test("keeps the engine's mode labels after the meter", async ($, on) => {
  world(on, fill(62))
  await startSession($)
  const ui = await footer($, 120, ['focus'])
  const drawn = (await ui.drawn()) as { children?: unknown[] }
  expect(drawn.children?.at(-1)).toMatchObject({ props: { key: 'engine' } })
  expect(await row(ui)).toEqual(['ctx ', '━━━━', '── ', '62%', ' · '])
})

const counts = (input: number, cacheRead: number, cacheWrite: number, output: number, model = 'model-a'): TurnUsage =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, model })

/** One model request, the main thread's or, with `agentId`, another loop's: its stream read to the end. */
async function respond ($: Engine, w: ReturnType<typeof world>, usage: TurnUsage | null, agentId?: string) {
  w.live.usage = usage
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'model-a', messageCount: 2, ...(agentId === undefined ? {} : { agentId }) })
  // Read to the end: the chunks (none here), then the result as the generator's return value.
  let read = await stream.next()
  while (read.done !== true) read = await stream.next()
  return read.value
}
const commandLines = async ($: Engine) => ((await runCommand($)).text ?? '').split('\n').slice(2)
/** The token rows /context-meter prints: what comes before the cache rows. */
const tokenLines = async ($: Engine) => {
  const rows = await commandLines($)
  const at = rows.findIndex(line => /^Cach[eé]  /.test(line))
  return at === -1 ? rows : rows.slice(0, at)
}
/** The cache rows /context-meter prints. */
const cacheLines = async ($: Engine) => (await commandLines($)).filter((line, i, all) => i >= all.findIndex(row => /^Cach[eé]  /.test(row)))

test('each main-thread response is the last request and adds to the session', async ($, on) => {
  const w = world(on, fill(62))
  w.live.cost = { usd: 0.5 }
  await startSession($)
  await respond($, w, counts(1000, 100_000, 4000, 2000))
  w.live.cost = { usd: 0.8 }
  const result = await respond($, w, counts(200, 104_000, 1000, 500))
  // The response goes on as it came.
  expect(result).toMatchObject({ stopReason: 'end_turn', usage: { input_tokens: 200 } })
  expect(await tokenLines($)).toEqual([
    '               Input    Cache read   Cache write   Uncached   Output',
    'Last request   105.2k   104k         1k            200        500',
    'Session        210.2k   204k         5k            1.2k       2.5k',
    'Cache hit      97% of input read from cache',
    'Cost           $0.80 (session, all agents)',
  ])
})

test('a step returns without waiting for the recording; two quick steps count once each', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  let release = () => {}
  w.live.plainHold = new Promise(resolve => { release = resolve })
  const late = Symbol('late')
  // A step that waits for the held usage call never settles; one that does not, settles in a few ticks.
  const ticks = async () => { for (let i = 0; i < 1000; i++) await Promise.resolve(); return late }
  const within = <T,>(p: Promise<T>) => Promise.race([p, ticks()])
  expect(await within(respond($, w, counts(1000, 0, 0, 10)))).not.toBe(late)
  expect(await within(respond($, w, counts(2000, 0, 0, 20)))).not.toBe(late)
  release()
  w.live.plainHold = undefined
  expect(await tokenLines($)).toEqual([
    '               Input   Cache read   Cache write   Uncached   Output',
    'Last request   2k      0            0             2k         20',
    'Session        3k      0            0             3k         30',
    'Cache hit      0% of input read from cache',
  ])
})

test("another loop's response (a subagent, a fork of the engine) changes nothing", async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(1000, 100_000, 4000, 2000))
  const before = await tokenLines($)
  await respond($, w, counts(9000, 9000, 9000, 9000), 'agent-1')
  expect(await tokenLines($)).toEqual(before)
  expect(before[1]).toMatch(/^Last request   105k +100k +4k +1k +2k$/)
})

test('a response without usage counts nothing; before any response there are no token rows', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, null)
  expect((await runCommand($)).text).toBe('Context   124k / 200k   62%\n' + '━'.repeat(22) + '─'.repeat(14))
  // No cost row of its own either, without a request.
  w.live.cost = { usd: 1 }
  expect((await runCommand($)).text?.includes('$')).toBe(false)
})

test('/clear empties the ledger, and a new session start is counted from zero', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(1000, 100_000, 4000, 2000))
  await $.session.end({ reason: 'clear' } as never)
  await measure($, 62)
  expect(await tokenLines($)).toEqual([])
  await respond($, w, counts(1000, 100_000, 4000, 2000))
  // The engine moves the start with /clear: what came before it is not added.
  w.live.startedAt = 60_000
  await respond($, w, counts(10, 20, 30, 40))
  expect((await tokenLines($))[2]).toBe('Session        60      20           30            10         40')
})

test('a reload keeps the counts in $.state', async ($, on) => {
  // What the plugin wrote before the reload, for this session's start.
  on('state.get', ($, e, next) => (e as { key: string }).key === 'ledger'
    ? { value: { value: {
        startedAt: 0,
        last: { input: 1200, cacheRead: 118_000, cacheWrite: 5100, output: 2400, model: 'model-a', at: 1 },
        total: { input: 31_000, cacheRead: 2_100_000, cacheWrite: 160_000, output: 88_000 },
        requests: 14,
      }, version: 3 } }
    : next(e))
  world(on, fill(62))
  await startSession($)
  expect(await tokenLines($)).toEqual([
    '               Input    Cache read   Cache write   Uncached   Output',
    'Last request   124.3k   118k         5.1k          1.2k       2.4k',
    'Session        2.3M     2.1M         160k          31k        88k',
    'Cache hit      92% of input read from cache',
  ])
})

const withRequests = async ($: Engine, on: On) => {
  const w = world(on, fill(62))
  w.live.cost = { usd: 4.12 }
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(1200, 118_000, 5100, 2400))
  w.live.usage = counts(29_800, 1_982_000, 154_900, 85_600)
  await respond($, w, w.live.usage)
}

test('the band card at 120 columns: the table in full, the cache rows after it', async ($, on) => {
  await withRequests($, on)
  const { box, rows } = await cardIn(await band($, 115))
  expect(box?.props).toMatchObject({ width: 71, height: 11 })
  expect(rows.map(row => row.trimEnd())).toEqual([
    ' Context   124k / 200k   62%',
    ' ' + '━'.repeat(42) + '─'.repeat(25),
    '                Input   Cache read   Cache write   Uncached   Output',
    ' Last request   2.2M    2M           154.9k        29.8k      85.6k',
    ' Session        2.3M    2.1M         160k          31k        88k',
    ' Cache hit      92% of input read from cache',
    ' Cost           $4.12 (session, all agents)',
    ' Cache          active, expires in 05:00 (TTL 5m)',
    ' No cache losses this session',
  ])
})

test('the band card at 60 columns: Uncached and Cache write left out, none wrapping', async ($, on) => {
  await withRequests($, on)
  const { box, rows } = await cardIn(await band($, 55))
  const width = box?.props?.width as number
  expect(width).toBeLessThanOrEqual(55)
  expect(rows.every(row => row.length === width - 2)).toBe(true)
  expect(rows.slice(2).map(row => row.trimEnd())).toEqual([
    '                Input   Cache read   Output',
    ' Last request   2.2M    2M           85.6k',
    ' Session        2.3M    2.1M         88k',
    ' Cache hit      92% of input read from cache',
    ' Cost           $4.12 (session, all agents)',
    ' Cache          active, expires in 05:00 (TTL 5m)',
    ' No cache losses this session',
  ])
})

test('the token rows in Spanish', { options: { language: 'es' } }, async ($, on) => {
  await withRequests($, on)
  const { rows } = await cardIn(await band($, 115))
  expect(rows.slice(2).map(row => row.trimEnd())).toEqual([
    '                     Entrada   Caché leída   Caché escrita   Sin caché   Salida',
    ' Última petición     2.2M      2M            154.9k          29.8k       85.6k',
    ' Sesión              2.3M      2.1M          160k            31k         88k',
    ' Acierto de caché    92% de la entrada leída de caché',
    ' Coste               $4.12 (sesión, todos los agentes)',
    ' Caché               activa, expira en 05:00 (TTL 5m)',
    ' Sin pérdidas de caché en esta sesión',
  ])
})

const MIN = 60_000

test('a loss per cause: a compaction, another model, a pause past the TTL, else invalidated', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(5, 0, 100_000, 10))
  // A main-thread /compact; the precompute one and a subagent's are not counted.
  await $.session.compact({ trigger: 'precompute', messages: [summary] } as never)
  await $.session.compact({ trigger: 'manual', agentId: 'agent-1', messages: [summary] } as never)
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 0, 90_000, 10))
  expect((await cacheLines($))[1]).toMatch(/^Cache losses   \d\d:\d\d  −100k  invalidated \(prompt or tools changed\)$/)
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 0, 80_000, 10))
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 0, 70_000, 10, 'model-b'))
  // Past the 5m TTL of a session without rate limits.
  await w.clock.advance(67 * MIN)
  await respond($, w, counts(5, 0, 60_000, 10, 'model-b'))
  const at = (minutes: number) => clockTime(minutes * MIN)
  expect(await cacheLines($)).toEqual([
    'Cache          active, expires in 05:00 (TTL 5m)',
    `Cache losses   ${at(70)}  −70k   idle 1h07m > TTL`,
    `               ${at(3)}  −80k   model changed`,
    `               ${at(2)}  −90k   /compact`,
    `               ${at(1)}  −100k  invalidated (prompt or tools changed)`,
  ])
})

test('the countdown runs down each second and turns to expired', async ($, on) => {
  const w = world(on, fill(62))
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(5, 0, 50_000, 10))
  const status = async () => (await cardIn(await band($))).rows.find(row => row.startsWith(' Cache  '))?.trimEnd()
  // A subscription: 1h, drawn again each second.
  await w.clock.advance(1000)
  expect(await status()).toBe(' Cache          active, expires in 59:59 (TTL 1h)')
  await w.clock.advance(1000)
  expect(await status()).toBe(' Cache          active, expires in 59:58 (TTL 1h)')
})

test('without rate limits the cache lives 5m and then reads as expired', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(5, 0, 50_000, 10))
  const status = async () => (await cardIn(await band($))).rows.find(row => row.startsWith(' Cache  '))?.trimEnd()
  await w.clock.advance(4 * MIN + 30_000)
  expect(await status()).toBe(' Cache          active, expires in 00:30 (TTL 5m)')
  await w.clock.advance(MIN + 40_000)
  expect(await status()).toBe(' Cache          expired 1m ago')
})

test('cacheTtl 5m stands on a subscription', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const w = world(on, fill(62))
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toBe('Cache          active, expires in 05:00 (TTL 5m)')
  await w.clock.advance(6 * MIN)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[1]).toMatch(/idle 6m > TTL$/)
})

test('cacheTtl 1h: no expiry within the hour, counted in h:mm:ss', { options: { cacheTtl: '1h' } }, async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toBe('Cache          active, expires in 1:00:00 (TTL 1h)')
  await w.clock.advance(30 * MIN)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[1]).toMatch(/invalidated/)
})

test('auto TTL switches to 1h after a hit past a 5 minute pause', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(6 * MIN)
  await respond($, w, counts(5, 50_000, 1000, 10))
  expect(await cacheLines($)).toEqual(['Cache          active, expires in 1:00:00 (TTL 1h)', 'No cache losses this session'])
})

test('the card shows the 5 newest losses, /context-meter all 10', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await measure($, 62)
  for (let i = 0; i < 13; i++) {
    await w.clock.advance(MIN)
    await respond($, w, counts(5, 0, 10_000 + i * 1000, 10))
  }
  const { rows } = await cardIn(await band($))
  expect(rows.filter(row => row.includes('−'))).toHaveLength(5)
  const printed = await cacheLines($)
  expect(printed.filter(line => line.includes('−'))).toHaveLength(10)
  // Newest first: the last request lost the 21k written before it.
  expect(printed[1]).toMatch(/−21k/)
})

test('/clear starts the cache over with a marker as the first history line', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(MIN)
  await $.session.end({ reason: 'clear' } as never)
  await measure($, 62)
  expect(await cacheLines($)).toEqual(['Cache          no cache yet', `Cleared at ${clockTime(2 * MIN)}`, 'No cache losses this session'])
  // The first request after it has no previous prefix: no loss.
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 0, 40_000, 10))
  expect((await cacheLines($)).slice(1)).toEqual([
    `Cache losses   Cleared at ${clockTime(2 * MIN)}`,
    `               ${clockTime(3 * MIN)}  −50k  invalidated (prompt or tools changed)`,
  ])
})

test('the cache rows in Spanish', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(10 * MIN)
  await respond($, w, counts(5, 0, 40_000, 10))
  expect(await cacheLines($)).toEqual([
    'Caché               activa, expira en 05:00 (TTL 5m)',
    `Pérdidas de caché   ${clockTime(10 * MIN)}  −50k  inactiva 10m > TTL`,
  ])
})

test('a reload keeps the cache and its losses in $.state', async ($, on) => {
  on('state.get', ($, e, next) => (e as { key: string }).key === 'cache'
    ? { value: { value: {
        startedAt: 0,
        last: { prefix: 60_000, model: 'model-a', at: 0 },
        isCompactPending: false,
        isSubscription: false,
        isLongSeen: true,
        losses: [{ at: 0, lost: 112_000, cause: 'expired', gap: 67 * MIN }],
      }, version: 3 } }
    : next(e))
  world(on, fill(62))
  await startSession($)
  expect(await cacheLines($)).toEqual([
    'Cache          active, expires in 1:00:00 (TTL 1h)',
    `Cache losses   ${clockTime(0)}  −112k  idle 1h07m > TTL`,
  ])
})
