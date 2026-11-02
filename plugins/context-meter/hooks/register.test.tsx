// Mod tests, run against the engine itself: `claude plugin test .`. Every figure is synthetic.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextUsage, SessionMessage } from 'claude-code'

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
  const live = { context, breakdown, counts: 0, hold: undefined as Promise<void> | undefined, onCount: () => {} }
  const clock = mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test-session' }) as never)
  on('session.compact', () => ({ messages: [summary] }) as never)
  on('config.set', ($, e) => ({ value: e.value }))
  on('command.register', () => ({ value: { command: 'context-meter' } }) as never)
  on('session.usage', async ($, e) => {
    if (e.breakdown === undefined) return { value: { startedAt: 0, context: live.context, rateLimits: [] } }
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
    return { value: { startedAt: 0, context: { ...live.context, breakdown: counted }, rateLimits: [] } as never }
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
  expect((await runCommand($)).text?.split('\n')).toEqual(['Context   124k / 200k   62%', '━'.repeat(22) + '─'.repeat(14), 'Autocompact at ~150k'])
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
