// Mod tests, run against the engine itself: `claude plugin test .`. Every figure is synthetic.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, Register, SessionContextUsage, SessionMessage, TurnUsage } from 'claude-code'

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
    /** How long the model takes to answer a step, on the mock clock. */
    stepMs: 0,
    /** The agents `$.agent.list()` names. */
    agentList: [] as { id: string; type: string; name?: string; description: string; status: string }[],
  }
  const clock = mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test-session' }) as never)
  // A compaction reports its summarizer's own request, as core does.
  on('session.compact', () => ({ messages: [summary], usage: { input_tokens: 3000, output_tokens: 2000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 } }) as never)
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
    if (live.stepMs > 0) await clock.advance(live.stepMs)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: live.usage }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: live.agentList }) as never)
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

test('shows the fill as a bar, the bar in the theme claude color below warnAt, the figure plain', async ($, on) => {
  world(on, fill(30))
  await startSession($)
  const ui = await footer($)
  expect(await row(ui)).toEqual(['ctx ', '━━', '──── ', '30%'])
  expect(await ui.find({ type: 'Text', text: '━━' })).toMatchObject({ props: { color: 'claude' } })
  const figure = (await ui.find({ type: 'Text', text: '30%' })) as { props?: Record<string, unknown> }
  expect(figure.props?.color).toBeUndefined()
  expect(figure.props?.dimColor).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'ctx ' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ key: 'context-meter' })).toBeDefined()
})

test("the ctx prefix warns of the main thread's cache: the warning color in the TTL's last tenth (30 s of 5m), the error color once expired; the row keeps its width", async ($, on) => {
  const w = world(on, fill(30))
  await startSession($)
  await measure($, 30)
  const ui = await footer($)
  const prefix = async () => ((await ui.find({ type: 'Text', text: 'ctx ' })) as { props?: Record<string, unknown> }).props
  // No cache yet: dim.
  expect(await prefix()).toMatchObject({ dimColor: true })
  await respond($, w, counts(5, 0, 50_000, 10))
  const before = await row(ui)
  await w.clock.advance(4 * MIN)
  expect(await prefix()).toMatchObject({ dimColor: true })
  await w.clock.advance(32_000)
  expect(await prefix()).toMatchObject({ color: 'warning' })
  expect(await row(ui)).toEqual(before)
  await w.clock.advance(30_000)
  expect(await prefix()).toMatchObject({ color: 'error' })
  // A new request: alive again.
  await respond($, w, counts(5, 50_000, 0, 10))
  await w.clock.advance(2000)
  expect(await prefix()).toMatchObject({ dimColor: true })
})

test('the alert clears with /clear; a stale one kept in $.state is replaced at the first tick', async ($, on) => {
  // $.state holds 'expired' from before a reload, until the plugin writes the alert.
  const written: unknown[] = []
  on('state.get', ($, e, next) => (e as { key: string }).key === 'alert' && written.length === 0 ? { value: { value: 'expired', version: 1 } } as never : next(e))
  on('state.set', ($, e, next) => {
    if ((e as { key: string }).key === 'alert') written.push((e as { value?: unknown }).value)
    return next(e)
  })
  const w = world(on, fill(30))
  await startSession($)
  await measure($, 30)
  const prefixOf = async (ui: Awaited<ReturnType<typeof footer>>) => ((await ui.find({ type: 'Text', text: 'ctx ' })) as { props?: Record<string, unknown> }).props
  expect(await prefixOf(await footer($))).toMatchObject({ color: 'error' })
  // With no cache now, the first tick writes none.
  await w.clock.advance(2000)
  expect(written.length > 0 && written.every(value => value === null)).toBe(true)
  expect(await prefixOf(await footer($))).toMatchObject({ dimColor: true })
  const ui = await footer($)
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(6 * MIN)
  expect(await prefixOf(ui)).toMatchObject({ color: 'error' })
  await $.session.end({ reason: 'clear' } as never)
  await runCommand($)
  await w.clock.advance(2000)
  expect(await prefixOf(ui)).toMatchObject({ dimColor: true })
})

test('a 1h TTL warns in its last 6 minutes; the short form warns too', { options: { cacheTtl: '1h' } }, async ($, on) => {
  const w = world(on, fill(30))
  await startSession($)
  await measure($, 30)
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(53 * MIN)
  const narrow = await footer($, 40)
  const prefix = async () => ((await narrow.find({ type: 'Text', text: 'ctx ' })) as { props?: Record<string, unknown> } | undefined)?.props
  expect(await prefix()).toMatchObject({ dimColor: true })
  await w.clock.advance(MIN + 2000)
  expect(await prefix()).toMatchObject({ color: 'warning' })
})

test('with cacheAlert off the prefix stays dim', { options: { cacheAlert: false } }, async ($, on) => {
  const w = world(on, fill(30))
  await startSession($)
  await measure($, 30)
  const ui = await footer($)
  await respond($, w, counts(5, 0, 50_000, 10))
  await w.clock.advance(6 * MIN)
  expect(await ui.find({ type: 'Text', text: 'ctx ' })).toMatchObject({ props: { dimColor: true } })
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
  // A Button draws its label (`plain`: the label alone, as the row lays it out).
  const text = (node: unknown): string =>
    typeof node === 'string' ? node
      : (node as Node | null)?.type === 'Button' ? String(((node as Node).props as { label?: unknown } | undefined)?.label ?? '')
      : ((node as Node | null)?.children ?? []).map(text).join('')
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
  // The main thread's card is framed in the theme's accent, as its bar is.
  expect(box?.props).toMatchObject({ width: 40, height: 5, borderStyle: 'round', borderColor: 'claude' })
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
const cacheLines = async ($: Engine) => {
  const rows = await commandLines($)
  const at = rows.findIndex(row => /^Cach[eé]  /.test(row))
  const end = rows.indexOf('', at)
  return rows.slice(at, end === -1 ? undefined : end)
}

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
    'Cache hit      97% of input read from cache · last request 99% ↑4',
    'Cost           ≈ $0.8000 at list prices (session, all agents)',
  ])
})

test("the last request's hit rate against the one before: a model switch is named, not compared; a narrow band shortens, then drops it", async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(0, 90_000, 10_000, 100))
  await respond($, w, counts(0, 0, 100_000, 100, 'model-b'))
  expect((await tokenLines($)).find(line => line.startsWith('Cache hit'))).toBe('Cache hit      45% of input read from cache · last request 0% (model switch)')
  await respond($, w, counts(0, 60_000, 40_000, 100, 'model-b'))
  const hitAt = async (columns: number) => (await cardIn(await band($, columns))).rows.find(row => row.includes('Cache hit'))?.trim()
  expect(await hitAt(115)).toBe('Cache hit      50% of input read from cache · last request 60% ↑60')
  expect(await hitAt(62)).toBe('Cache hit      50% of input read from cache · 60% ↑60')
  expect(await hitAt(50)).toBe('Cache hit      50% of input read from cache')
  // After /clear the first request has none before it.
  await $.session.end({ reason: 'clear' } as never)
  await respond($, w, counts(0, 60_000, 40_000, 100, 'model-b'))
  expect((await tokenLines($)).find(line => line.startsWith('Cache hit'))).toBe('Cache hit      60% of input read from cache')
})

test('the model switch in Spanish', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(0, 90_000, 10_000, 100))
  await respond($, w, counts(0, 0, 100_000, 100, 'model-b'))
  expect((await tokenLines($)).find(line => line.startsWith('Acierto'))).toBe('Acierto de caché    45% de la entrada leída de caché · última petición 0% (cambio de modelo)')
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
    'Cache hit      0% of input read from cache · last request 0% =',
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

// Core sends a compaction's summarizer request through session.compact alone, never as a turn.step
// (seen in a real session, Claude Code 2.1.317). This pins the plugin's side: the usage that
// session.compact reports is not added.
test("a compaction's own summarizer request adds nothing to the tokens", async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(1000, 100_000, 4000, 2000))
  const before = await tokenLines($)
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  expect(await tokenLines($)).toEqual(before)
})

/** The subagent rows /context-meter prints: from the Agents header to the end. */
const agentLines = async ($: Engine) => {
  const rows = await commandLines($)
  const at = rows.findIndex(line => /^Agent(s|es) \(/.test(line))
  if (at === -1) return []
  const end = rows.indexOf('', at)
  return rows.slice(at, end === -1 ? undefined : end)
}

test("a subagent's responses fill its row; a fork no list names counts nowhere; main is unchanged", async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [
    { id: 'a1', type: 'Explore', description: 'Count files', status: 'running' },
    { id: 'a2', type: 'general-purpose', name: 'reviewer', description: 'Review', status: 'running' },
  ]
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  const main = await tokenLines($)
  await respond($, w, counts(2, 4846, 12_795, 166, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(2, 17_641, 1335, 148, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(10, 0, 9000, 50, 'claude-sonnet-5-5'), 'a2')
  await respond($, w, counts(5000, 5000, 5000, 5000), 'memory-fork')
  expect(await tokenLines($)).toEqual(main)
  expect(await agentLines($)).toEqual([
    'Agents (2)         Requests   Input   Cache read   Cache write   Uncached   Output   Cache hit   Model',
    'reviewer           1          9k      0            9k            10         50       0%          sonnet 5.5',
    'Count files        2          36.6k   22.5k        14.1k         4          314      61%         haiku 5.5',
    'Subagents total    3          45.6k   22.5k        23.1k         14         364      49%',
    'Main + subagents   4          55.6k   31.5k        24.1k         14         464      57%',
  ])
})

test('a name past 24 characters ends in …', async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [{ id: 'a1', type: 'Explore', description: 'Count every TypeScript file in hooks', status: 'running' }]
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(2, 4846, 12_795, 166, 'claude-haiku-5-5'), 'a1')
  expect((await agentLines($))[1]).toMatch(/^Count every TypeScript … +1 /)
})

test('a reload keeps the agents in $.state; a new session start empties them', async ($, on) => {
  // What the plugin wrote before the reload, for this session's start.
  on('state.get', ($, e, next) => (e as { key: string }).key === 'agents'
    ? { value: { value: {
        startedAt: 0,
        agents: [{ id: 'a1', label: 'Explore', model: 'claude-haiku-5-5', input: 2, output: 166, cacheRead: 4846, cacheWrite: 12_795, requests: 1, at: 1 }],
        total: { input: 2, output: 166, cacheRead: 4846, cacheWrite: 12_795 },
        requests: 1,
        count: 1,
      }, version: 3 } }
    : next(e))
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  expect((await agentLines($))[1]).toMatch(/^Explore +1 +17.6k +4.8k +12.8k +2 +166 +27% +haiku 5.5$/)
})

test('a session started anew (another start) empties the agents', async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [{ id: 'a1', type: 'Explore', description: '', status: 'running' }]
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(1, 0, 0, 1), 'a1')
  w.live.startedAt = 99
  await startSession($)
  expect(await agentLines($)).toEqual([])
})

test('an agent once named keeps counting after the list drops it', async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [{ id: 'a1', type: 'Explore', description: '', status: 'running' }]
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(1, 0, 0, 1), 'a1')
  w.live.agentList = []
  await respond($, w, counts(1, 0, 0, 1), 'a1')
  expect((await agentLines($))[1]).toMatch(/^Explore +2 /)
})

const twoAgents = (w: ReturnType<typeof world>) => {
  w.live.agentList = [
    { id: 'a1', type: 'Explore', description: 'Count files', status: 'running' },
    { id: 'a2', type: 'general-purpose', name: 'reviewer', description: 'Review', status: 'running' },
  ]
}
const feedAgents = async ($: Engine, w: ReturnType<typeof world>) => {
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(2, 4846, 12_795, 166, 'claude-haiku-5-5'), 'a1')
  await w.clock.advance(MIN)
  await respond($, w, counts(2, 0, 30_000, 148, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(10, 0, 9000, 50, 'claude-sonnet-5-5'), 'a2')
}
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'context-meter', args, origin: { kind: 'composer' } } as never)

test("/context-meter <n> or <name>: that agent's card, with its own rows, cost and cache", async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await feedAgents($, w)
  const lines = ((await run($, '2')).text ?? '').split('\n')
  expect(lines).toEqual([
    'Main › Count files · haiku 5.5',
    // Its last request's input over Haiku 5.5's window: not the session's model (model-a here), so the
    // host reports none and the docs' 1M is marked inferred.
    'Context   30k / 1M?   3%?',
    '━━' + '─'.repeat(76),
    '               Input   Cache read   Cache write   Uncached   Output',
    'Last request   30k     0            30k           2          148',
    'Session        47.6k   4.8k         42.8k         4          314',
    'Cache hit      10% of input read from cache · last request 0% ↓27',
    // Haiku 5.5 up to 100k: (4 × 0.10 + 4,846 × 0.01 + 314 × 0.50 + 42,795 × 0.125) / 1e6 = $0.00556.
    'Cost           ≈ $0.0056 at API list prices, from its token counts',
    // Uncached, its 47,645 input tokens would cost $0.0048; with 42,795 written at 5m they cost $0.0054.
    'Cache saved    ≈ −$0.0006 (13% more than without the cache)',
    `Cache          active until ${clockTime(MIN + 5 * MIN)} (in 5m, TTL 5m?)`,
    // Getting the 17,641 lost tokens back: written again at 5m instead of read, (0.125 − 0.01) per MTok.
    `Cache losses   ${clockTime(MIN)}  −17.6k  ≈ $0.0020  invalidated (prompt or tools changed)`,
  ])
  expect(((await run($, 'review')).text ?? '').split('\n')[0]).toBe('Main › reviewer · sonnet 5.5')
  expect((await run($, 'nobody')).text).toBe('No agent of this session matches "nobody".')
})

test('a press on an agent row shows its card; Main goes back; a transcript in view shows its agent', async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await measure($, 62)
  await feedAgents($, w)
  await runCommand($)
  const ui = await band($, 115)
  const first = async () => (await cardIn(ui)).rows[0]!.trim()
  expect(await first()).toMatch(/^Context /)
  await ui.press({ key: 'agent:a1' })
  expect(await first()).toBe('Main › Count files · haiku 5.5')
  await ui.press({ key: 'main' })
  expect(await first()).toMatch(/^Context /)
  const viewing = await $.ui.mount({
    plugin: 'context-meter', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 115, scroll: { offset: 0, bodyRows: 30 }, view: { agentId: 'a2' } },
    viewport: { columns: 120, rows: 30 },
  })
  expect((await cardIn(viewing)).rows[0]!.trim()).toBe('Main › reviewer · sonnet 5.5')
})

test("an agent's TTL comes from its own transcript beside the session's", async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  const AGENT = '/synthetic/session/subagents/agent-a1.jsonl'
  const lines: string[] = []
  const text = () => lines.map(line => line + '\n').join('')
  on('fs.stat', ($, e) => ({ value: { kind: e.path === AGENT ? 'file' : 'other', size: e.path === AGENT ? text().length : 0, mtimeMs: 0, isLink: false } }) as never)
  on('fs.read', () => ({ value: text() }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: text(), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('classic.SessionStart', () => ({}))
  on('classic.SubagentStop', () => ({}))
  await startSession($)
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/synthetic/session.jsonl' } as never)
  await respond($, w, counts(0, 9000, 1000, 100))
  // A stop before the agent has a row reads nothing yet.
  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: AGENT } as never)
  // The step comes before its entry is written; the stop then reads it.
  await respond($, w, counts(2, 0, 30_000, 10, 'claude-haiku-5-5'), 'a1')
  expect(((await run($, '1')).text ?? '').split('\n').find(line => line.startsWith('Cache  '))).toMatch(/TTL 5m\?\)$/)
  lines.push(JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a1', message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000, cache_creation: { ephemeral_1h_input_tokens: 30_000 } } } }))
  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: AGENT } as never)
  const cacheRow = ((await run($, '1')).text ?? '').split('\n').find(line => line.startsWith('Cache  '))
  expect(cacheRow).toMatch(/TTL 1h\)$/)
})

test("an agent with no agents of its own has no Agents section; one off the price table reads ≥", async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await feedAgents($, w)
  await respond($, w, counts(1, 1, 1, 1, 'unknown-model'), 'a2')
  const lines = ((await run($, '1')).text ?? '').split('\n')
  expect(lines.some(line => /^Agents \(/.test(line))).toBe(false)
  expect(lines.find(line => line.startsWith('Cost'))).toMatch(/^Cost +≥ \$/)
})

test("a subagent's own subagents: listed in its card, not the main thread's; Overall is the loop and all under it; colors by depth", async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [
    { id: 'p', type: 'general-purpose', name: 'lead', description: '', status: 'running' },
    { id: 'c', type: 'Explore', name: 'scout', description: '', status: 'running', parentId: 'p' } as never,
    { id: 'g', type: 'Explore', name: 'deep', description: '', status: 'running', parentId: 'c' } as never,
  ]
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(10, 0, 1000, 10, 'claude-sonnet-5-5'), 'p')
  await respond($, w, counts(20, 0, 2000, 20, 'claude-haiku-5-5'), 'c')
  await respond($, w, counts(40, 0, 4000, 40, 'claude-haiku-5-5'), 'g')
  const flat = (text?: string) => (text ?? '').split('\n').map(line => line.replace(/ +/g, ' '))
  const main = flat((await run($, '')).text)
  // The main thread lists the agent it spawned; All agents and Overall count every agent under it.
  expect(main.filter(line => /^(lead|scout|deep|Subagents total|Main \+ subagents) /.test(line))).toEqual([
    'lead 1 1k 0 1k 10 10 0% sonnet 5.5',
    'Subagents total 3 7.1k 0 7k 70 70 0%',
    'Main + subagents 4 17.1k 9k 8k 70 170 53%',
  ])
  const lead = flat((await run($, 'lead')).text)
  expect(lead[0]).toBe('Main › lead · sonnet 5.5')
  expect(lead.filter(line => /^(scout|deep|Subagents total|This agent \+ subagents) /.test(line))).toEqual([
    'scout 1 2k 0 2k 20 20 0% haiku 5.5',
    'Subagents total 2 6.1k 0 6k 60 60 0%',
    'This agent + subagents 3 7.1k 0 7k 70 70 0%',
  ])
  expect(flat((await run($, 'deep')).text)[0]).toBe('Main › lead › scout › deep · haiku 5.5')
  const ui = await band($, 115)
  const border = async () => ((await cardIn(ui)).box?.props as { borderColor?: string }).borderColor
  expect(await border()).toBe('claude')
  await ui.press({ key: 'agent:p' })
  expect(await border()).toBe('ide')
  await ui.press({ key: 'agent:c' })
  expect(await border()).toBe('merged')
  // The path is pressable: back to lead.
  await ui.press({ key: 'agent:p' })
  expect((await cardIn(ui)).rows[0]!.trim()).toBe('Main › lead · sonnet 5.5')
})

test('a transcript in view of an agent the card has no row for shows the main card; /clear drops the pick', async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await measure($, 62)
  await feedAgents($, w)
  await runCommand($)
  const mountWith = (view: { agentId?: string }) => $.ui.mount({
    plugin: 'context-meter', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 115, scroll: { offset: 0, bodyRows: 30 }, view },
    viewport: { columns: 120, rows: 30 },
  })
  expect((await cardIn(await mountWith({ agentId: 'nobody' }))).rows[0]!.trim()).toMatch(/^Context /)
  const ui = await band($, 115)
  await ui.press({ key: 'agent:a1' })
  expect((await cardIn(ui)).rows[0]!.trim()).toMatch(/^Main › /)
  await $.session.end({ reason: 'clear' } as never)
  await runCommand($)
  expect((await cardIn(await band($, 115))).rows[0]!.trim()).toMatch(/^Context /)
})

test('a press while an agent transcript is in view moves the view', async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  const views: unknown[] = []
  on('ui.view', ($, e) => { views.push(e); return { value: {} } as never })
  await startSession($)
  await measure($, 62)
  await feedAgents($, w)
  await runCommand($)
  const ui = await $.ui.mount({
    plugin: 'context-meter', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 115, scroll: { offset: 0, bodyRows: 30 }, view: { agentId: 'a2' } },
    viewport: { columns: 120, rows: 30 },
  })
  await ui.press({ key: 'main' })
  expect(views).toEqual([{}])
})

test("an agent on the session's model takes the host's window, unmarked", async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(2, 0, 30_000, 10), 'a1')
  // model-a answers the main thread too: the host's 200k window, not a table's.
  expect(((await run($, '1')).text ?? '').split('\n')[1]).toBe('Context   30k / 200k   15%')
})

/** The Models rows /context-meter prints, from its header to the end of the section. */
const modelLines = async ($: Engine, args = '') => {
  const rows = ((await run($, args)).text ?? '').split('\n')
  const at = rows.findIndex(line => /^(Models|Modelos) /.test(line))
  if (at === -1) return []
  const end = rows.indexOf('', at)
  return rows.slice(at, end === -1 ? undefined : end).map(line => line.replace(/ +/g, ' '))
}

test('Models: a row per model under the loop, the most requests first, summing to Overall; none with one model', async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  expect(await modelLines($)).toEqual([])
  await respond($, w, counts(2, 4846, 12_795, 166, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(2, 0, 30_000, 148, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(10, 0, 9000, 50, 'claude-sonnet-5-5'), 'a2')
  expect(await modelLines($)).toEqual([
    // Cost at list prices, writes at 5m (agents) and the main thread's TTL; model-a is not in the price table.
    'Models Requests Input Cache read Cache write Uncached Output Cache hit Cost',
    'haiku 5.5 2 47.6k 4.8k 42.8k 4 314 10% $0.0056',
    // A tie in requests goes by name.
    'model-a 1 10k 9k 1k 0 100 90% –',
    'sonnet 5.5 1 9k 0 9k 10 50 0% $0.0230',
  ])
  // An agent's card: only its own model, so no section.
  expect(await modelLines($, '1')).toEqual([])
})

test("an agent that changed model counts each under its own", async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(1, 0, 1000, 1, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(1, 0, 2000, 1, 'claude-sonnet-5-5'), 'a1')
  expect((await modelLines($, '1')).slice(1)).toEqual([
    'haiku 5.5 1 1k 0 1k 1 1 0% $0.0001',
    'sonnet 5.5 1 2k 0 2k 1 1 0% $0.0050',
  ])
})

test('a ledger kept from before models were tallied shows no Models section rather than short rows', async ($, on) => {
  on('state.get', ($, e, next) => (e as { key: string }).key === 'ledger'
    ? { value: { value: { startedAt: 0, last: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1, model: 'model-a', at: 1 }, total: { input: 9, cacheRead: 9, cacheWrite: 9, output: 9 }, requests: 9 }, version: 3 } }
    : next(e))
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await respond($, w, counts(1, 0, 1000, 1, 'claude-haiku-5-5'), 'a1')
  expect(await modelLines($)).toEqual([])
})

test("ids of one model are one row; an agent's card sums the models under it; the band drops Models' columns, then the section", async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [
    { id: 'p', type: 'general-purpose', name: 'lead', description: '', status: 'running' },
    { id: 'c', type: 'Explore', name: 'scout', description: '', status: 'running', parentId: 'p' } as never,
  ]
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(1, 0, 1000, 1, 'claude-sonnet-4-5'), 'p')
  await respond($, w, counts(1, 0, 1000, 1, 'claude-sonnet-4-5-20250929'), 'p')
  await respond($, w, counts(1, 0, 2000, 1, 'claude-haiku-5-5'), 'c')
  expect((await modelLines($, 'lead')).slice(1)).toEqual([
    'sonnet 4.5 2 2k 0 2k 2 2 0% $0.0075',
    'haiku 5.5 1 2k 0 2k 1 1 0% $0.0003',
  ])
  const header = async (columns: number) =>
    (await cardIn(await band($, columns))).rows.find(row => row.includes('Models'))?.trim().replace(/ +/g, ' ')
  expect(await header(115)).toBe('Models Requests Input Cache read Cache write Uncached Output Cache hit Cost')
  expect(await header(60)).toBe('Models Input Cache read Cache hit Cost')
  expect(await header(20)).toBeUndefined()
})

test("what the cache saved over the session on the main card: main and agents, each thread's writes at its TTL; Spanish; gone where narrow", async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  await startSession($)
  await measure($, 62)
  // Sonnet 5.5 on the main thread (1h inferred on a subscription), Haiku 5.5 in a1 (5m inferred).
  await respond($, w, counts(10, 0, 100_000, 100, 'claude-sonnet-5-5'))
  await respond($, w, counts(10, 100_000, 1000, 100, 'claude-sonnet-5-5'))
  await respond($, w, counts(2, 0, 20_000, 10, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(2, 20_000, 500, 10, 'claude-haiku-5-5'), 'a1')
  // Uncached: 201,020 × 2 + 40,504 × 0.10 = 406,090.4 µ$. Cost: main 20 × 2 + 100,000 × 0.10 + 101,000 × 4
  // = 414,040, a1 2,762.9: 416,802.9 µ$. Saved: −10,712.5 µ$, 3% more.
  const row = async (args = '') => ((await run($, args)).text ?? '').split('\n').find(line => line.startsWith('Cache saved'))
  expect(await row()).toBe('Cache saved    ≈ −$0.0107 (3% more than without the cache)')
  // a1 alone: uncached 40,504 × 0.10 = 4,050.4 µ$, cost 0.4 + 200 + 2,562.5 = 2,762.9 µ$: saved 1,287.5 µ$, 32%.
  expect(await row('1')).toBe('Cache saved    ≈ $0.0013 (32% less than without the cache)')
  const narrow = (await cardIn(await band($, 55))).rows.find(line => line.includes('Cache saved'))
  expect(narrow?.trim()).toBe('Cache saved    ≈ −$0.0107')
})

test("two agents on different TTLs: each one's writes at its own on the main card", async ($, on) => {
  // Each agent's transcript: a1 wrote at 5m, a2 at 1h.
  const entry = (id: string, key: string) => JSON.stringify({ type: 'assistant', isSidechain: true, agentId: id, message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000, cache_creation: { [key]: 50_000 } } } }) + '\n'
  const files: Record<string, string> = {
    '/synthetic/session/subagents/agent-a1.jsonl': entry('a1', 'ephemeral_5m_input_tokens'),
    '/synthetic/session/subagents/agent-a2.jsonl': entry('a2', 'ephemeral_1h_input_tokens'),
  }
  on('fs.stat', ($, e) => ({ value: { kind: files[e.path] === undefined ? 'other' : 'file', size: files[e.path]?.length ?? 0, mtimeMs: 0, isLink: false } }) as never)
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }) as never)
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: files[e.argv.at(-1)!] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('classic.SubagentStop', () => ({}))
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await respond($, w, counts(10, 0, 0, 100, 'claude-sonnet-5-5'))
  await respond($, w, counts(2, 0, 50_000, 10, 'claude-haiku-5-5'), 'a1')
  await respond($, w, counts(2, 0, 50_000, 10, 'claude-haiku-5-5'), 'a2')
  for (const id of ['a1', 'a2']) {
    await $.classic.SubagentStop({ stop_hook_active: false, agent_id: id, agent_type: 'Explore', agent_transcript_path: `/synthetic/session/subagents/agent-${id}.jsonl` } as never)
  }
  // Uncached: 10 × 2 + 100,004 × 0.10 = 10,020.4 µ$. Cost: 20 + a1 (0.2 + 50,000 × 0.125) + a2 (0.2 + 50,000 × 0.20) = 16,270.4 µ$.
  const row = ((await run($, '')).text ?? '').split('\n').find(text => text.startsWith('Cache saved'))
  expect(row).toBe('Cache saved    ≈ −$0.0063 (62% more than without the cache)')
})

test("Haiku 5.5's long-prompt rates price what the cache saved too", async ($, on) => {
  const w = world(on, fill(62))
  twoAgents(w)
  await startSession($)
  await respond($, w, counts(10, 0, 0, 100, 'claude-sonnet-5-5'))
  // 150,002 input tokens: over 100,000, so 0.50 input, 0.05 read.
  await respond($, w, counts(2, 150_000, 0, 10, 'claude-haiku-5-5'), 'a1')
  const row = ((await run($, '1')).text ?? '').split('\n').find(text => text.startsWith('Cache saved'))
  // Uncached 150,002 × 0.50 = 75,001 µ$; cost 2 × 0.50 + 150,000 × 0.05 = 7,501 µ$: saved 67,500 µ$, 90%.
  expect(row).toBe('Cache saved    ≈ $0.0675 (90% less than without the cache)')
})

test('the cache saved in Spanish; none with a model off the price table', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(10, 0, 100_000, 100, 'claude-sonnet-5-5'))
  await respond($, w, counts(10, 100_000, 0, 100, 'claude-sonnet-5-5'))
  const rows = ((await run($, '')).text ?? '').split('\n')
  expect(rows.find(line => line.startsWith('Ahorro'))).toMatch(/^Ahorro de caché +≈ \$0\.\d{4} \(un \d+% menos que sin caché\)$/)
  await respond($, w, counts(1, 1, 1, 1))
  expect(((await run($, '')).text ?? '').split('\n').some(line => line.startsWith('Ahorro'))).toBe(false)
})

test('no subagent: no Agents section', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(1, 1, 1, 1), 'unlisted')
  expect(await agentLines($)).toEqual([])
})

test('the card lists the 5 most recent agents, /context-meter every one; /clear empties them', async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, type: `type-${i}`, description: '', status: 'completed' }))
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(0, 9000, 1000, 100))
  for (let i = 0; i < 7; i++) {
    await w.clock.advance(1000)
    await respond($, w, counts(1, 0, 0, 1), `a${i}`)
  }
  // The band does not wait for the recordings; the command does.
  await runCommand($)
  const { rows } = await cardIn(await band($, 115))
  const labels = rows.map(row => row.slice(1, 12).trim()).filter(text => /^type-|^Agents/.test(text))
  expect(labels).toEqual(['Agents (7)', 'type-6', 'type-5', 'type-4', 'type-3', 'type-2'])
  expect((await agentLines($)).filter(line => line.startsWith('type-'))).toHaveLength(7)
  await $.session.end({ reason: 'clear' } as never)
  expect(await agentLines($)).toEqual([])
})

test('a narrow band drops Model, Uncached, Cache write, Output, Requests, then Cache read from the agents table', async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [{ id: 'a1', type: 'Explore', description: '', status: 'running' }]
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(2, 4846, 12_795, 166, 'claude-haiku-5-5'), 'a1')
  await runCommand($)
  const headerAt = async (columns: number) => {
    const { rows } = await cardIn(await band($, columns))
    return rows.find(row => row.includes('Agents (1)'))?.trim().replace(/ +/g, ' ')
  }
  expect(await headerAt(110)).toBe('Agents (1) Requests Input Cache read Cache write Uncached Output Cache hit Model')
  expect(await headerAt(100)).toBe('Agents (1) Requests Input Cache read Cache write Uncached Output Cache hit')
  expect(await headerAt(90)).toBe('Agents (1) Requests Input Cache read Cache write Output Cache hit')
  expect(await headerAt(80)).toBe('Agents (1) Requests Input Cache read Output Cache hit')
  expect(await headerAt(65)).toBe('Agents (1) Requests Input Cache read Cache hit')
  expect(await headerAt(55)).toBe('Agents (1) Input Cache read Cache hit')
  expect(await headerAt(45)).toBe('Agents (1) Input Cache hit')
  // Where not even Input and Cache hit fit, the section goes rather than cut a figure.
  expect(await headerAt(35)).toBeUndefined()
})

test('the agents section in Spanish', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, fill(62))
  w.live.agentList = [{ id: 'a1', type: 'Explore', description: '', status: 'running' }]
  await startSession($)
  await respond($, w, counts(0, 9000, 1000, 100))
  await respond($, w, counts(2, 4846, 12_795, 166, 'claude-haiku-5-5'), 'a1')
  expect((await agentLines($)).map(line => line.replace(/ +/g, ' '))).toEqual([
    'Agentes (1) Peticiones Entrada Caché leída Caché escrita Sin caché Salida Acierto Modelo',
    'Explore 1 17.6k 4.8k 12.8k 2 166 27% haiku 5.5',
    'Total subagentes 1 17.6k 4.8k 12.8k 2 166 27%',
    'Principal + subagentes 2 27.6k 13.8k 13.8k 2 266 50%',
  ])
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
    ' Cache hit      92% of input read from cache · last request 91% ↓4',
    ' Cost           ≈ $4.12 at list prices (session, all agents)',
    ` Cache          active until ${clockTime(5 * MIN)} (in 5m, TTL 5m?)`,
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
    ' Cost           ≈ $4.12 (estimate)',
    ` Cache          active until ${clockTime(5 * MIN)} (in 5m, TTL 5m?)`,
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
    ' Acierto de caché    92% de la entrada leída de caché · última petición 91% ↓4',
    ' Coste               ≈ $4.12 a precio de lista (sesión, todos los agentes)',
    ` Caché               activa hasta las ${clockTime(5 * MIN)} (en 5m, TTL 5m?)`,
    ' Sin pérdidas de caché en esta sesión',
  ])
})

const MIN = 60_000
const HOUR = 60 * MIN

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
    `Cache          active until ${clockTime(70 * MIN + 5 * MIN)} (in 5m, TTL 5m?)`,
    `Cache losses   ${at(70)}  −70k   idle 1h07m > TTL`,
    `               ${at(3)}  −80k   model changed`,
    `               ${at(2)}  −90k   /compact`,
    `               ${at(1)}  −100k  invalidated (prompt or tools changed)`,
  ])
})

/** How many times the plugin wrote the countdown's time to $.state. */
const countWrites = (on: On) => {
  const writes = { now: 0, cache: 0 }
  on('state.set', ($, e, next) => {
    const key = (e as { key: string }).key
    if (key === 'now' || key === 'cache') writes[key] += 1
    return next(e)
  })
  return writes
}

test('the countdown is drawn once a minute, never each second', async ($, on) => {
  const writes = countWrites(on)
  const w = world(on, fill(62))
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(5, 0, 50_000, 10))
  const status = async () => (await cardIn(await band($))).rows.find(row => row.startsWith(' Cache  '))?.trimEnd()
  // A subscription: 1h, the line the same through each minute.
  await w.clock.advance(2000)
  expect(await status()).toBe(` Cache          active until ${clockTime(HOUR)} (in 59m, TTL 1h?)`)
  const before = writes.now
  await w.clock.advance(50_000)
  expect(writes.now).toBe(before)
  await w.clock.advance(10_000)
  expect(await status()).toBe(` Cache          active until ${clockTime(HOUR)} (in 58m, TTL 1h?)`)
  expect(writes.now).toBe(before + 1)
  // Ten minutes: ten writes, not three hundred.
  await w.clock.advance(10 * MIN)
  expect(writes.now).toBe(before + 11)
})

test('with no cache (before the first request, after /clear) the tick reads nothing', async ($, on) => {
  let reads = 0
  on('state.get', ($, e, next) => {
    if ((e as { key: string }).key === 'cache') reads += 1
    return next(e)
  })
  const w = world(on, fill(62))
  await startSession($)
  await measure($, 62)
  let before = reads
  await w.clock.advance(MIN)
  expect(reads).toBe(before)
  await respond($, w, counts(5, 0, 50_000, 10))
  await $.session.end({ reason: 'clear' } as never)
  await measure($, 62)
  await w.clock.advance(2000)
  before = reads
  await w.clock.advance(MIN)
  expect(reads).toBe(before)
})

test('without rate limits the cache lives 5m and then reads as expired', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(5, 0, 50_000, 10))
  const status = async () => (await cardIn(await band($))).rows.find(row => row.startsWith(' Cache  '))?.trimEnd()
  await w.clock.advance(4 * MIN + 30_000)
  expect(await status()).toBe(` Cache          active until ${clockTime(5 * MIN)} (in <1m, TTL 5m?)`)
  await w.clock.advance(40_000)
  expect(await status()).toBe(' Cache          expired <1m ago')
  await w.clock.advance(MIN)
  expect(await status()).toBe(' Cache          expired 1m ago')
})

test('the cache lives from the start of the request, not its end, and a pause is counted between starts', async ($, on) => {
  // Anthropic's prompt caching docs: the lifetime counts from the start of the request that writes or reads the entry.
  const w = world(on, fill(62))
  await startSession($)
  await measure($, 62)
  w.live.stepMs = 2 * MIN
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toBe(`Cache          active until ${clockTime(5 * MIN)} (in 3m, TTL 5m?)`)
  // 4 minutes after the first response ends, 6 after it started: past a 5 minute TTL.
  w.live.stepMs = 0
  await w.clock.advance(4 * MIN)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[1]).toMatch(/^Cache losses   \d\d:\d\d  −50k  idle 6m > TTL$/)
})

test('rate limits that show up after the first request make the TTL 1h, for the request already made', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toBe(`Cache          active until ${clockTime(5 * MIN)} (in 5m, TTL 5m?)`)
  // The subscription's windows arrive with a later usage read, not with a request.
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  await w.clock.advance(2000)
  expect((await cacheLines($))[0]).toBe(`Cache          active until ${clockTime(HOUR)} (in 59m, TTL 1h?)`)
  // Once seen it stays, even if a later read has none.
  w.live.rateLimits = []
  await w.clock.advance(2000)
  await respond($, w, counts(5, 50_000, 0, 10))
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\?\)$/)
})

test('cacheTtl 5m stands on a subscription', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const w = world(on, fill(62))
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toBe(`Cache          active until ${clockTime(5 * MIN)} (in 5m, TTL 5m)`)
  await w.clock.advance(6 * MIN)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[1]).toMatch(/idle 6m > TTL$/)
})

test('cacheTtl 1h: no expiry within the hour, the time left in h and minutes', { options: { cacheTtl: '1h' } }, async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toBe(`Cache          active until ${clockTime(HOUR)} (in 1h00m, TTL 1h)`)
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
  expect(await cacheLines($)).toEqual([`Cache          active until ${clockTime(6 * MIN + HOUR)} (in 1h00m, TTL 1h?)`, 'No cache losses this session'])
})

test('a hit 5m 30s after the previous request started, 3m 30s after it ended, shows the 1h TTL', async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  w.live.stepMs = 2 * MIN
  await respond($, w, counts(5, 0, 50_000, 10))
  w.live.stepMs = 0
  await w.clock.advance(3 * MIN + 30_000)
  await respond($, w, counts(5, 50_000, 1000, 10))
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\?\)$/)
})

test("each loss's cost in a column, aligned; a narrow band keeps the cost and shortens the cause", async ($, on) => {
  const w = world(on, fill(62))
  await startSession($)
  await measure($, 62)
  await respond($, w, counts(5, 0, 100_000, 10, 'claude-sonnet-5-5'))
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 20_000, 80_000, 10, 'claude-sonnet-5-5'))
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 8000, 2000, 10, 'claude-sonnet-5-5'))
  // 5m (no rate limits): 80,000 rewritten × 2.40 = $0.192; the compaction lost 92,000 but wrote 2,000: × 2.40 = $0.0048.
  expect((await cacheLines($)).slice(1)).toEqual([
    `Cache losses   ${clockTime(2 * MIN)}  −92k  ≈ $0.0048  /compact`,
    `               ${clockTime(MIN)}  −80k  ≈ $0.1920  invalidated (prompt or tools changed)`,
  ])
  const narrow = (await cardIn(await band($, 60))).rows.filter(row => row.includes('≈ $0.'))
  expect(narrow.map(row => row.trim().replace(/ +/g, ' '))).toContain(`${clockTime(MIN)} −80k ≈ $0.1920 invalidated`)
})

test('a loss with no cost (a model off the price table) leaves its cell blank, the causes aligned; the cost follows the TTL the transcript shows later', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  await startWithTranscript($)
  await respond($, w, counts(5, 0, 100_000, 10, 'claude-sonnet-5-5'))
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 20_000, 80_000, 10, 'claude-sonnet-5-5'))
  await w.clock.advance(MIN)
  await respond($, w, counts(5, 0, 100_000, 10, 'other-model'))
  expect((await cacheLines($)).slice(1)).toEqual([
    `Cache losses   ${clockTime(2 * MIN)}  −100k             model changed`,
    `               ${clockTime(MIN)}  −80k   ≈ $0.1920  invalidated (prompt or tools changed)`,
  ])
  // The transcript then shows the writes were 1h: the loss is priced at it, 80,000 × 3.90.
  file.lines.push(entry(0, 100_000))
  await stop($)
  expect((await cacheLines($))[2]).toBe(`               ${clockTime(MIN)}  −80k   ≈ $0.3120  invalidated (prompt or tools changed)`)
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
    `Caché               activa hasta las ${clockTime(15 * MIN)} (en 5m, TTL 5m?)`,
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
    `Cache          active until ${clockTime(HOUR)} (in 1h00m, TTL 1h?)`,
    `Cache losses   ${clockTime(0)}  −112k  idle 1h07m > TTL`,
  ])
})

// The session transcript the classic hook events point at, served by fs hooks beneath the mod.
// Synthetic JSONL: usage fields only, no message text.
const TRANSCRIPT = '/synthetic/session.jsonl'
/** A main-thread response's entry: `m5` and `h1` tokens written to the cache, `cacheRead` read from it. */
const entry = (m5: number, h1: number, extra: Record<string, unknown> = {}, cacheRead = 0) => JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  message: { usage: { cache_read_input_tokens: cacheRead, cache_creation_input_tokens: m5 + h1, cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 } } },
  ...extra,
})
/**
 * A transcript beneath the mod: its lines, how often it was read whole and by `tail`, a size the stat
 * may report instead, and whether `tail` runs (false: it cannot start, as on Windows).
 */
function transcript (on: On) {
  const file = { lines: [] as string[], reads: 0, tails: 0, size: undefined as number | undefined, hasTail: true, argv: [] as readonly string[] }
  const text = () => file.lines.map(line => line + '\n').join('')
  on('fs.stat', ($, e) => (e.path === TRANSCRIPT
    ? { value: { kind: 'file', size: file.size ?? text().length, mtimeMs: 0, isLink: false } }
    : { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }) as never)
  // No settings hook beneath: each classic event answers nothing of its own.
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  on('fs.read', ($, e) => {
    if (e.path !== TRANSCRIPT) throw new Error('ENOENT')
    file.reads += 1
    return { value: text() } as never
  })
  on('process.run', ($, e) => {
    file.argv = e.argv
    if (!file.hasTail) throw new Error('ENOENT: tail')
    file.tails += 1
    const all = text()
    const cut = Number(e.argv[2])
    return { value: { exitCode: 0, stdout: all.slice(Math.max(0, all.length - cut)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  return file
}
const startWithTranscript = async ($: Engine) => {
  await startSession($)
  await $.classic.SessionStart({ source: 'startup', transcript_path: TRANSCRIPT } as never)
}
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false, transcript_path: TRANSCRIPT } as never)

test('the TTL the transcript records for the last main-thread write is shown without ?', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  await startWithTranscript($)
  file.lines.push(entry(0, 50_000))
  await respond($, w, counts(5, 0, 50_000, 10))
  await stop($)
  // No rate limits: the inference would say 5m?; the transcript says 1h.
  expect((await cacheLines($))[0]).toBe(`Cache          active until ${clockTime(HOUR)} (in 1h00m, TTL 1h)`)
  // A pure read keeps it; a subagent's 5m write in the file changes nothing.
  file.lines.push(entry(0, 0), entry(9000, 0, { isSidechain: true }), 'not json')
  await respond($, w, counts(5, 50_000, 0, 10))
  await stop($)
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\)$/)
  // A later 5m write (usage credits, say) turns it 5m.
  file.lines.push(entry(800, 0))
  await respond($, w, counts(5, 50_000, 800, 10))
  await stop($)
  expect((await cacheLines($))[0]).toMatch(/TTL 5m\)$/)
})

test('the end of a turn reads the transcript, for a response written after its step', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  await startWithTranscript($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toMatch(/TTL 5m\?\)$/)
  file.lines.push(entry(0, 50_000))
  await stop($)
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\)$/)
})

test('the transcript is read once per turn, at its end, and again only when its size changed', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  await startWithTranscript($)
  file.lines.push(entry(0, 50_000))
  await respond($, w, counts(5, 0, 50_000, 10))
  await respond($, w, counts(5, 50_000, 0, 10))
  await runCommand($)
  // Not after each request: only the turn's end reads.
  expect(file.tails).toBe(0)
  await stop($)
  await stop($)
  await runCommand($)
  expect(file.tails).toBe(1)
  expect(file.reads).toBe(0)
  // The path is one argv element, no shell.
  expect(file.argv).toEqual(['tail', '-c', String(256 * 1024), '--', TRANSCRIPT])
})

test('past 4 MiB the tail still reads the TTL, its first cut line dropped', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  await startWithTranscript($)
  file.size = 50 * 1024 * 1024
  // A line far longer than the tail, cut at its start, then the last write.
  file.lines.push(entry(9000, 0, { pad: 'x'.repeat(300 * 1024) }).slice(0, -1) + '}', entry(0, 50_000))
  await respond($, w, counts(5, 0, 50_000, 10))
  await stop($)
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\)$/)
  expect(file.reads).toBe(0)
})

test('without tail the whole file is read, up to 4 MiB; past it the TTL last observed stands', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  file.hasTail = false
  await startWithTranscript($)
  file.lines.push(entry(0, 50_000))
  await respond($, w, counts(5, 0, 50_000, 10))
  await stop($)
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\)$/)
  expect(file.reads).toBe(1)
  file.size = 4 * 1024 * 1024 + 1
  file.lines.push(entry(800, 0))
  await respond($, w, counts(5, 50_000, 800, 10))
  await stop($)
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\)$/)
  expect(file.reads).toBe(1)
})

test('/clear keeps the observed TTL and the subscription reading', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  w.live.cost = { usd: 0.004 }
  await startWithTranscript($)
  file.lines.push(entry(800, 0))
  await respond($, w, counts(5, 0, 800, 10))
  await stop($)
  await $.session.end({ reason: 'clear' } as never)
  w.live.startedAt = 10
  w.live.rateLimits = []
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await cacheLines($))[0]).toMatch(/TTL 5m\)$/)
  expect((await tokenLines($)).at(-1)).toBe('Cost           ≈ $0.0040 at API list prices (not billed on your plan)')
})

test('a new session starts from the stored TTL (inferred) and subscription', async ($, on) => {
  const stored: Record<string, unknown> = { lastTtl: '1h', isSubscription: true }
  on('store.get', ($, e) => ({ value: stored[(e as { key: string }).key] }) as never)
  on('store.set', ($, e) => { const { key, value } = e as { key: string; value: unknown }; stored[key] = value; return { value: undefined } as never })
  const w = world(on, fill(62))
  const file = transcript(on)
  w.live.cost = { usd: 0.004 }
  await startWithTranscript($)
  await respond($, w, counts(5, 0, 50_000, 10))
  // No rate limits yet: the stored reading stands; the stored TTL is the inference.
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\?\)$/)
  expect((await tokenLines($)).at(-1)).toBe('Cost           ≈ $0.0040 at API list prices (not billed on your plan)')
  // This session's transcript confirms a TTL; it is stored.
  file.lines.push(entry(800, 0))
  await stop($)
  expect((await cacheLines($))[0]).toMatch(/TTL 5m\)$/)
  expect(stored.lastTtl).toBe('5m')
  // A second response still without rate limits is this session's own reading: an API key.
  await respond($, w, counts(5, 800, 0, 10))
  expect((await tokenLines($)).at(-1)).toMatch(/at list prices/)
  expect(stored.isSubscription).toBe(false)
})

test('an explicit cacheTtl beats the observed TTL', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  await startWithTranscript($)
  file.lines.push(entry(0, 50_000))
  await respond($, w, counts(5, 0, 50_000, 10))
  await stop($)
  expect((await cacheLines($))[0]).toBe(`Cache          active until ${clockTime(5 * MIN)} (in 5m, TTL 5m)`)
})

test("a subagent's classic event does not move the transcript path", async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  await startWithTranscript($)
  await $.classic.UserPromptSubmit({ prompt: 'synthetic', transcript_path: '/synthetic/other.jsonl', agent_id: 'a1' } as never)
  file.lines.push(entry(0, 50_000))
  await respond($, w, counts(5, 0, 50_000, 10))
  // A Stop without a path keeps the one it has.
  await $.classic.Stop({ stop_hook_active: false } as never)
  expect((await cacheLines($))[0]).toMatch(/TTL 1h\)$/)
})

test('on a subscription the cost reads at API list prices, not billed', async ($, on) => {
  const w = world(on, fill(62))
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  w.live.cost = { usd: 0.004 }
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await tokenLines($)).at(-1)).toBe('Cost           ≈ $0.0040 at API list prices (not billed on your plan)')
})

test('the subscription cost row in Spanish', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, fill(62))
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  w.live.cost = { usd: 0.004 }
  await startSession($)
  await respond($, w, counts(5, 0, 50_000, 10))
  expect((await tokenLines($)).at(-1)).toBe('Coste               ≈ $0.0040 a precio de lista de la API (no se factura en tu plan)')
})

test('the transcript written after Stop is read on the next resync: the band card shows TTL 1h without ?', async ($, on) => {
  const w = world(on, fill(62))
  const file = transcript(on)
  w.live.rateLimits = [{ window: 'five_hour' }] as never
  await startWithTranscript($)
  await measure($, 62)
  const ui = await band($)
  const status = async () => (await cardIn(ui)).rows.find(row => row.startsWith(' Cache  '))?.trimEnd()
  // A turn: the response comes in, the turn ends, and only then does the host write the response.
  file.lines.push(JSON.stringify({ type: 'user', isSidechain: false }))
  await respond($, w, counts(5, 0, 50_000, 10))
  await stop($)
  expect(await status()).toMatch(/TTL 1h\?\)$/)
  file.lines.push(entry(0, 50_000))
  await w.clock.advance(2000)
  expect(await status()).toMatch(/TTL 1h\)$/)
  // Once the turn's response is read, the resync reads no more until the next turn ends.
  const tails = file.tails
  file.lines.push(JSON.stringify({ type: 'system', isSidechain: false }))
  await w.clock.advance(10_000)
  expect(file.tails).toBe(tails)
})

// The shared row with sub-meter. The test kit loads no module from outside this folder, so sub-meter
// is simulated: its footer drawing exactly as its register.tsx draws it (context-meter's Box taken
// out and put first with its separator, its own keyed Box, then what is beneath), its reading and
// the hint parts it drops in `$.state`, and the hint line rewritten. Its text at each width is the
// one its own tests assert beside context-meter. Loaded outside this plugin (prepend) or inside it
// (append), the row is the same. Footer 26 + hint 16 ('? for shortcuts' once the cycle hint drops).
const SHARED: [number, string][] = [
  [200, 'ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m'],
  [120, 'ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m'],
  [80, 'ctx ━━━━── 62% · 5h 31% ↻ 2h 10m'],
  [70, 'ctx ━━━━── 62% · 5h 31%'],
  [66, 'ctx 62% · 5h 31%'],
  [57, 'ctx 62%'],
  [48, '62%'],
  [44, ''],
]

const subMeter: Register = on => {
  // An inline plugin runs in an environment of its own: what it uses is written inside it.
  const BAR = '━━━───────'
  const TEXTS: Record<number, string> = { 200: `5h ${BAR} 31% ↻ 2h 10m`, 120: `5h ${BAR} 31% ↻ 2h 10m`, 80: '5h 31% ↻ 2h 10m', 70: '5h 31%', 66: '5h 31%' }
  const SEP = ' · '
  on('session.start', async ($, e, next) => {
    await $.state.set({ plugin: 'sub-meter', key: 'reading' } as never, { windows: [{ kind: 'five_hour', percentUsed: 31 }], at: 0, origin: 0 } as never)
    await $.state.set({ plugin: 'sub-meter', key: 'hides' } as never, { cycle: true, interrupt: true } as never)
    return next(e)
  })
  on('ui.render', { component: 'PromptHint' }, ($, e, next) =>
    next({ ...e, props: { ...e.props, hint: e.props.hint.replace('(shift+tab to cycle) · ', '') } }))
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const beneath = await next(e)
    const text = TEXTS[e.viewport?.columns ?? 200]
    if (text === undefined) return beneath
    const { Box, Text } = $.ui.resolve(e)
    type Kid = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
    const kids = (typeof beneath === 'object' && beneath !== null && beneath.type === 'Box' ? beneath.children ?? [] : []) as Kid[]
    const hasContext = kids[0]?.props?.key === 'context-meter'
    const isSep = (k: Kid) => k?.type === 'Text' && (k.children ?? []).join('') === SEP
    const rest = hasContext ? kids.slice(1).filter(k => !isSep(k)) : [beneath]
    return (
      <Box flexDirection="row">
        {hasContext ? (kids[0] as never) : null}
        {hasContext ? <Text dimColor>{SEP}</Text> : null}
        <Box key="sub-meter" flexDirection="row"><Text>{text}</Text></Box>
        {e.props.modes.length > 0 ? <Text dimColor>{SEP}</Text> : null}
        {rest as never}
      </Box>
    )
  })
}

for (const tier of ['prepend', 'append'] as const) {
  test(`beside sub-meter (${tier === 'prepend' ? 'outside' : 'inside'} it): ctx first, the same row at every width`, { plugins: [{ name: 'sub-meter', tier, register: subMeter }] }, async ($, on) => {
    world(on, fill(62))
    await startSession($)
    await measure($, 62)
    await hint($, '(shift+tab to cycle) · ? for shortcuts')
    for (const [columns, expected] of SHARED) {
      expect(`${columns}: ${(await row(await footer($, columns))).join('')}`).toBe(`${columns}: ${expected}`)
    }
  })
}

test('alone, with the cycle hint it measures the hint as it came', async ($, on) => {
  world(on, fill(62))
  await startSession($)
  await hint($, '(shift+tab to cycle) · ? for shortcuts') // 38 columns: 80 - 26 - 39 = 15 left
  expect((await row(await footer($, 80))).join('')).toBe('ctx ━━━━── 62%')
  await hint($, '(shift+tab to cycle) · ? for shortcuts!') // 14 left
  expect((await row(await footer($, 80))).join('')).toBe('ctx ━━━━── 62%')
  await hint($, '(shift+tab to cycle) · ? for shortcuts!!') // 13 left
  expect((await row(await footer($, 80))).join('')).toBe('ctx 62%')
})

test("the card's bar is in the theme claude color below warnAt, its figures plain", async ($, on) => {
  world(on, fill(62), { percentage: 60, totalTokens: 120_000, threshold: 167_000 })
  await startSession($)
  await measure($, 30)
  const ui = await band($)
  const bar = (await ui.find({ type: 'Text', text: '━'.repeat(11) })) as { props?: Record<string, unknown> }
  expect(bar.props?.color).toBe('claude')
  const figure = (await ui.find({ type: 'Text', text: '   30%' })) as { props?: Record<string, unknown> } | undefined
  expect(figure).toBeDefined()
  expect(figure?.props?.color).toBeUndefined()
  expect(figure?.props?.dimColor).toBeUndefined()
})

test('counts what is beneath, without what is hidden or out of the flow', async ($, on) => {
  // Another plugin's drawing beneath: a label on the row, a hidden card and a placed one.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Text>⏵ other</Text>
        <Box display="none"><Text>{'x'.repeat(60)}</Text></Box>
        <Box position="absolute"><Text>{'y'.repeat(60)}</Text></Box>
      </Box>
    )
  })
  world(on, fill(62))
  await startSession($)
  await hint($, '? for shortcuts')
  // 66 - 42 - 7 - 3 = 14 left: the bar fits; one column less, it does not.
  expect((await row(await footer($, 66))).slice(0, 6)).toEqual(['ctx ', '━━━━', '── ', '62%', ' · ', '⏵ other'])
  expect((await row(await footer($, 65))).slice(0, 4)).toEqual(['ctx ', '62%', ' · ', '⏵ other'])
})

// sub-meter's reading as it keeps it in `$.state`: its 5-hour window resets at 1h, or reset a minute
// before the clock's start. An inline plugin runs in an environment of its own, so each is literal.
const liveReading: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.state.set({ plugin: 'sub-meter', key: 'reading' } as never, { windows: [{ kind: 'five_hour', percentUsed: 31, resetsAt: new Date(3_600_000).toISOString() }], at: 0, origin: 0 } as never)
    return next(e)
  })
}
const staleReading: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.state.set({ plugin: 'sub-meter', key: 'reading' } as never, { windows: [{ kind: 'five_hour', percentUsed: 31, resetsAt: new Date(-60_000).toISOString() }], at: 0, origin: 0 } as never)
    return next(e)
  })
}

test('room is kept for sub-meter while its reading holds', { plugins: [{ name: 'sub-meter', tier: 'prepend', register: liveReading }] }, async ($, on) => {
  world(on, fill(62))
  await startSession($)
  await hint($, '? for shortcuts')
  expect((await row(await footer($, 66))).join('')).toBe('ctx 62%')
})

test('no room is kept for a sub-meter reading past its reset, which sub-meter does not draw', { plugins: [{ name: 'sub-meter', tier: 'prepend', register: staleReading }] }, async ($, on) => {
  world(on, fill(62))
  await startSession($)
  await hint($, '? for shortcuts')
  expect((await row(await footer($, 66))).join('')).toBe('ctx ━━━━── 62%')
})
