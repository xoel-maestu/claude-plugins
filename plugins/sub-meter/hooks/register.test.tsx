// Mod tests, run against the engine itself: `claude plugin test .`. Every figure is synthetic.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, Register, SessionRateLimit } from 'claude-code'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// The clock starts at 0; the 5-hour window resets in 2h 10m, the weekly one in 3d 18h.
const FIVE: SessionRateLimit = { kind: 'five_hour', percentUsed: 31, resetsAt: new Date(2 * HOUR + 10 * MINUTE).toISOString() }
const WEEK: SessionRateLimit = { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(90 * HOUR).toISOString() }

/** Everything beneath the mods: the session's usage, an in-memory store, the clock and the engine's own drawing. */
function world (on: On, rateLimits: SessionRateLimit[] = [FIVE, WEEK], store: Record<string, unknown> = {}) {
  const live = { rateLimits, percent: 62 as number | undefined }
  const clock = mock.clock(on, { now: 0 })
  // The store every session shares: a test writes it as another session would.
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test-session' }) as never)
  on('command.register', () => ({ value: { command: 'sub-meter' } }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: live.percent === undefined ? { window: 200_000 } : { window: 200_000, tokens: 2000 * live.percent, percent: live.percent },
      rateLimits: live.rateLimits,
    },
  }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // The engine's own node; the hint line as a Text, so a rewrite shows.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    if ('hint' in e.props) return <Text>{e.props.hint}</Text>
    return { type: 'engine', ref: 0 } as const
  })
  return { live, clock }
}

const startSession = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: '/project', surface: 'terminal', isInteractive })
const measure = ($: Engine, rateLimits: SessionRateLimit[]) =>
  $.session.measure({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] })
const footer = ($: Engine, columns?: number, modes: string[] = []) =>
  $.ui.mount({
    plugin: 'sub-meter',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes },
    viewport: columns === undefined ? undefined : { columns, rows: 30 },
  })
const hint = ($: Engine, text: string, isWorking = false) =>
  $.ui.mount({ plugin: 'sub-meter', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking, hint: text } })
const runCommand = ($: Engine) =>
  $.command.run({ command: 'sub-meter', args: '', origin: { kind: 'composer' } } as never)

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | null | undefined
/** The row as text, leaving out what is placed out of the flow or hidden; the engine's node draws `modes`. */
function onRow (node: Drawn, modes: readonly string[]): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (node.type === 'engine') return modes.join(' & ')
  if (node.props?.position === 'absolute' || node.props?.display === 'none') return ''
  return (node.children ?? []).map(child => onRow(child as Drawn, modes)).join('')
}
const row = async (ui: { drawn: () => Promise<unknown> }, modes: readonly string[] = []) => onRow((await ui.drawn()) as Drawn, modes)

const BAR = (filled: number) => '━'.repeat(filled) + '─'.repeat(10 - filled)

test('shows the 5-hour window first: bar, percentage and the time to its reset', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($, 200)
  expect(await row(ui)).toBe(`5h ${BAR(3)} 31% ↻ 2h 10m`)
  expect(await ui.find({ key: 'sub-meter' })).toBeDefined()
})

test('colors: claude below 75%, warning from 75%, error from 90%; labels, empty cells and reset dim, percentage plain', async ($, on) => {
  world(on, [{ ...FIVE, percentUsed: 30 }])
  await startSession($)
  let ui = await footer($, 200)
  expect(await ui.find({ type: 'Text', text: '━━━' })).toMatchObject({ props: { color: 'claude' } })
  expect(await ui.find({ type: 'Text', text: '5h ' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: '─────── ' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: ' ↻ 2h 10m' })).toMatchObject({ props: { dimColor: true } })
  const percent = (await ui.find({ type: 'Text', text: '30%' })) as { props?: Record<string, unknown> }
  expect(percent.props?.color).toBeUndefined()
  expect(percent.props?.dimColor).toBeUndefined()
  await measure($, [{ ...FIVE, percentUsed: 75 }])
  ui = await footer($, 200)
  expect(await ui.find({ type: 'Text', text: '━━━━━━━━' })).toMatchObject({ props: { color: 'warning' } })
  await measure($, [{ ...FIVE, percentUsed: 90 }])
  ui = await footer($, 200)
  expect(await ui.find({ type: 'Text', text: '━━━━━━━━━' })).toMatchObject({ props: { color: 'error' } })
})

test('rotate switches window every rotateSeconds (8 by default)', async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(await row(await footer($, 200))).toBe(`5h ${BAR(3)} 31% ↻ 2h 10m`)
  await w.clock.advance(8000)
  expect(await row(await footer($, 200))).toBe(`week ${BAR(1)} 12% ↻ 3d 18h`)
  await w.clock.advance(8000)
  expect(await row(await footer($, 200))).toMatch(/^5h /)
})

test('rotateSeconds sets the switch', { options: { rotateSeconds: 3 } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(3000)
  expect(await row(await footer($, 200))).toMatch(/^week /)
})

test('display both: the two windows side by side', { options: { display: 'both' } }, async ($, on) => {
  world(on)
  await startSession($)
  expect(await row(await footer($, 200))).toBe(`5h ${BAR(3)} 31% ↻ 2h 10m | week ${BAR(1)} 12% ↻ 3d 18h`)
})

test('display session shows the 5-hour window only', { options: { display: 'session' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(16_000)
  expect(await row(await footer($, 200))).toMatch(/^5h /)
})

test('display week shows the weekly window only', { options: { display: 'week' } }, async ($, on) => {
  world(on)
  await startSession($)
  expect(await row(await footer($, 200))).toMatch(/^week /)
})

test('labels in Spanish: 5h and semana', { options: { display: 'both', language: 'es' } }, async ($, on) => {
  world(on)
  await startSession($)
  expect(await row(await footer($, 200))).toBe(`5h ${BAR(3)} 31% ↻ 2h 10m | semana ${BAR(1)} 12% ↻ 3d 18h`)
})

test('a window past its reset shows 0% and no reset time', { options: { display: 'session' } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(2 * HOUR + 10 * MINUTE)
  expect(await row(await footer($, 200))).toBe(`5h ${BAR(0)} 0%`)
})

test('a reading with every window past its reset is not drawn, and goes for context-meter too', async ($, on) => {
  // What context-meter reads: the last value written to this plugin's `reading`.
  let held: unknown
  on('state.set', ($, e, next) => {
    const { key, value } = e as { key: string; value: unknown }
    if (key === 'reading') held = value
    return next(e)
  })
  const w = world(on, [FIVE])
  await startSession($)
  const ui = await footer($, 200)
  await w.clock.advance(2 * HOUR + 10 * MINUTE)
  expect(await row(ui)).toBe('')
  expect(held).toBeNull()
})

test('a stored reading past its reset is not taken by a new session', async ($, on) => {
  world(on, [], { reading: { windows: [{ ...FIVE, resetsAt: new Date(-MINUTE).toISOString() }], at: -HOUR, origin: 99 } })
  await startSession($)
  expect(await row(await footer($, 200))).toBe('')
})

/** One main-thread response (or, with `agentId`, another loop's): a model request's stream read to the end. */
async function respond ($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'model-a', messageCount: 2, ...(agentId === undefined ? {} : { agentId }) })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
}
const FILL = { window: 200_000, tokens: 2000, percent: 1 }
/** The world with a store that can delete, and a model that answers with token counts. */
function deletingWorld (on: On, store: Record<string, unknown>) {
  on('store.delete', ($, e) => {
    delete store[(e as { key: string }).key]
    return { value: undefined } as never
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: 10, output_tokens: 5, model: 'model-a' } as never }
  })
  return world(on, [], store)
}

test('a resumed session with a fill and no rate limits before any response keeps the reading and the store', async ($, on) => {
  const stored = { windows: [{ ...WEEK, percentUsed: 20 }], at: 5, origin: 99 }
  const store: Record<string, unknown> = { reading: stored }
  deletingWorld(on, store)
  await startSession($)
  const ui = await footer($, 200)
  // The fill restored from the transcript, no response yet; split measures too.
  await $.session.measure({ context: FILL, rateLimits: [], changed: ['context'] })
  await $.session.measure({ context: FILL, rateLimits: [], changed: ['rateLimits'] })
  expect(await row(ui)).toMatch(/^week /)
  expect(store.reading).toEqual(stored)
})

test('two main-thread responses without rate limits hide the reading in this session only; the store is kept', async ($, on) => {
  const stored = { windows: [{ ...WEEK, percentUsed: 20 }], at: 5, origin: 99 }
  const store: Record<string, unknown> = { reading: stored }
  const w = deletingWorld(on, store)
  await startSession($)
  const ui = await footer($, 200)
  await respond($)
  // Another loop's response does not count.
  await respond($, 'agent-1')
  await $.session.measure({ context: FILL, rateLimits: [], changed: ['context'] })
  expect(await row(ui)).toMatch(/^week /)
  await respond($)
  await $.session.measure({ context: FILL, rateLimits: [], changed: ['context'] })
  expect(await row(ui)).toBe('')
  expect(store.reading).toEqual(stored)
  expect((await runCommand($)).text).toBe('No subscription usage in this session (no rate limits).')
  // Another session's reading is not taken here afterwards.
  store.reading = { windows: [{ ...WEEK, percentUsed: 30 }], at: 9000, origin: 99 }
  await w.clock.advance(8000)
  expect(await row(ui)).toBe('')
})

test('a subscription whose rate limits arrive in a later measure keeps its reading', async ($, on) => {
  const store: Record<string, unknown> = {}
  deletingWorld(on, store)
  await startSession($)
  const ui = await footer($, 200)
  await respond($)
  await $.session.measure({ context: FILL, rateLimits: [], changed: ['context'] })
  await measure($, [FIVE, WEEK])
  await respond($)
  await $.session.measure({ context: FILL, rateLimits: [], changed: ['context'] })
  expect(await row(ui)).toMatch(/^5h /)
  expect(store.reading).toBeDefined()
})

test('once this session had rate limits, a later response without them keeps the reading', async ($, on) => {
  world(on)
  await startSession($)
  await $.session.measure({ context: { window: 200_000, tokens: 2000, percent: 1 }, rateLimits: [], changed: ['context'] })
  expect(await row(await footer($, 200))).toMatch(/^5h /)
})

test('the countdown is drawn again every 8 s', async ($, on) => {
  const w = world(on, [FIVE])
  await startSession($)
  const ui = await footer($, 200)
  await w.clock.advance(10 * MINUTE + 8000)
  // 2h 10m less 10m 8s, rounded to the minute.
  expect(await row(ui)).toBe(`5h ${BAR(3)} 31% ↻ 2h 0m`)
})

test('no subscription (no rate limits): draws nothing, passes the row on', async ($, on) => {
  world(on, [])
  await startSession($)
  const ui = await footer($, 200)
  expect(await ui.find({ key: 'sub-meter' })).toBeUndefined()
  expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
})

test('other kinds are ignored: a spend limit alone draws nothing', async ($, on) => {
  world(on, [{ kind: 'spend_limit', percentUsed: 40 }])
  await startSession($)
  expect(await (await footer($, 200)).find({ key: 'sub-meter' })).toBeUndefined()
})

test('the reading from session.measure replaces the one from the start, and is stored with its time', async ($, on) => {
  const store: Record<string, unknown> = {}
  const w = world(on, [FIVE], store)
  await startSession($)
  await w.clock.advance(1000)
  await measure($, [{ ...FIVE, percentUsed: 44 }])
  expect(await row(await footer($, 200))).toMatch(/ 44% /)
  expect(store.reading).toMatchObject({ windows: [{ kind: 'five_hour', percentUsed: 44 }], at: 1000, origin: 0 })
})

test('a new session shows the stored reading before its first response', async ($, on) => {
  world(on, [], { reading: { windows: [{ ...WEEK, percentUsed: 20 }], at: 5, origin: 99 } })
  await startSession($)
  expect(await row(await footer($, 200))).toBe(`week ${BAR(2)} 20% ↻ 3d 18h`)
})

test("another session's newer reading shows within 8 s; an older one is ignored", async ($, on) => {
  const store: Record<string, unknown> = {}
  const w = world(on, [FIVE], store)
  await startSession($)
  // Another session writes the store.
  store.reading = { windows: [{ ...FIVE, percentUsed: 52 }], at: 3000, origin: 7 }
  await w.clock.advance(8000)
  expect(await row(await footer($, 200))).toMatch(/ 52% /)
  store.reading = { windows: [{ ...FIVE, percentUsed: 10 }], at: 1000, origin: 7 }
  await w.clock.advance(8000)
  expect(await row(await footer($, 200))).toMatch(/ 52% /)
})

test('hides "(shift+tab to cycle)" and "esc to interrupt" by default and measures the line as drawn', async ($, on) => {
  world(on)
  await startSession($)
  expect(await row(await hint($, '(shift+tab to cycle) · ? for shortcuts'))).toBe('? for shortcuts')
  expect(await row(await hint($, 'esc to interrupt · ctrl+t to hide tasks', true))).toBe('ctrl+t to hide tasks')
  // 80 - 26 - 1 - 20 = 33 columns: the bar fits (26); with the line as it came (39) it would not.
  expect(await row(await footer($, 80))).toBe(`5h ${BAR(3)} 31% ↻ 2h 10m`)
})

test('hideCycleHint and hideInterruptHint off keep the line', { options: { hideCycleHint: false, hideInterruptHint: false } }, async ($, on) => {
  world(on)
  await startSession($)
  expect(await row(await hint($, '(shift+tab to cycle) · ? for shortcuts'))).toBe('(shift+tab to cycle) · ? for shortcuts')
  expect(await row(await hint($, 'esc to interrupt', true))).toBe('esc to interrupt')
})

test('a narrow footer gives up the bar, then the reset time, then the meter; never wraps', async ($, on) => {
  world(on)
  await startSession($)
  await hint($, '? for shortcuts') // 26 + 16 columns of footer and hint
  expect(await row(await footer($, 42 + 26))).toBe(`5h ${BAR(3)} 31% ↻ 2h 10m`)
  expect(await row(await footer($, 42 + 25))).toBe('5h 31% ↻ 2h 10m')
  expect(await row(await footer($, 42 + 14))).toBe('5h 31%')
  expect(await row(await footer($, 42 + 5))).toBe('')
})

test('counts what is beneath, without what is hidden or out of the flow', async ($, on) => {
  // Another plugin's drawing beneath: a label on the row and a hidden card.
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
  world(on)
  await startSession($)
  await hint($, '? for shortcuts')
  // 68 - 42 - 7 - 3 = 16 left: the reset form (15).
  expect(await row(await footer($, 68))).toBe('5h 31% ↻ 2h 10m · ⏵ other')
})

test('/sub-meter prints the card as text', async ($, on) => {
  const w = world(on)
  await startSession($)
  await w.clock.advance(10 * MINUTE)
  const lines = (await runCommand($)).text!.split('\n')
  expect(lines[0]).toBe('Subscription')
  expect(lines[1]).toMatch(/^5h {6}━{6}─{14}  31% {3}resets \d\d:\d\d \(in 2h 0m\)$/)
  expect(lines[2]).toMatch(/^Week {4}━{2}─{18}  12% {3}resets \w{3} \d\d:\d\d \(in 3d 17h\)$/)
  // 31% in 3h: 100% after the reset. 12% in 3d 6h 10m: the same.
  expect(lines.slice(3)).toEqual([
    "Pace    at this pace, 5h won't reach 100% before reset",
    "        at this pace, the week won't reach 100% before reset",
    'Read    10m ago (this session)',
  ])
})

test('/sub-meter in Spanish, with a window past its reset', { options: { language: 'es' } }, async ($, on) => {
  const w = world(on, [FIVE, WEEK])
  await startSession($)
  await w.clock.advance(3 * HOUR)
  const lines = (await runCommand($)).text!.split('\n')
  expect(lines[0]).toBe('Suscripción')
  expect(lines[1]).toBe(`5h      ${'─'.repeat(20)}   0%   reiniciada`)
  expect(lines.at(-1)).toBe('Leído   hace 3h00m (esta sesión)')
})

test('/sub-meter without a subscription says so', async ($, on) => {
  world(on, [])
  await startSession($)
  expect((await runCommand($)).text).toBe('No subscription usage in this session (no rate limits).')
})

type Node = { type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
const textOf = (node: unknown): string =>
  typeof node === 'string' ? node : ((node as Node | null)?.children ?? []).map(textOf).join('')
/** The holders a band drawing hides until a hover group lights, in the order drawn. */
function holdersIn (node: unknown): Node[] {
  if (node === null || typeof node !== 'object') return []
  const n = node as Node
  if (n.props?.display === 'none') return [n]
  return (n.children ?? []).flatMap(holdersIn)
}
/** This meter's card: its holder, the bordered Box in it and its rows as text. */
async function cardIn (ui: { drawn: () => Promise<unknown> }) {
  const holder = holdersIn(await ui.drawn()).find(h => h.hover?.scope === 'sub-meter')
  const box = holder?.children?.[0] as Node | undefined
  return { holder, box, rows: (box?.children ?? []).map(textOf) }
}
const band = ($: Engine, bodyColumns = 115, hasSurvey = false) =>
  $.ui.mount({
    plugin: 'sub-meter',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 30, bodyColumns, scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: bodyColumns + 5, rows: 30 },
  })

test('the meter joins its own hover group', async ($, on) => {
  world(on)
  await startSession($)
  const drawn = (await (await footer($, 200)).drawn()) as Node
  const meter = drawn.children?.find(child => (child as Node).props?.key === 'sub-meter')
  // The tree keeps a hover beside the props.
  expect(meter).toMatchObject({ hover: { scope: 'sub-meter' } })
})

test('the hover card, in the band: last in the flow, right-aligned, hidden until the group lights', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await band($)
  const drawn = (await ui.drawn()) as Node
  const { holder, box, rows } = await cardIn(ui)
  expect(drawn.children?.at(-1)).toEqual(holder)
  expect(holder?.props).toMatchObject({ width: 115, justifyContent: 'flex-end', display: 'none' })
  expect(holder?.hover).toEqual({ scope: 'sub-meter', display: 'flex' })
  expect(box?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
  expect(box?.props?.position).toBeUndefined()
  // The title, the two windows, a pace row each (neither reaches 100%) and the read row.
  expect(rows).toHaveLength(6)
  expect(rows[0]).toMatch(/^ Subscription +$/)
  expect(rows.at(-1)).toMatch(/^ Read {4}<1m ago \(this session\) +$/)
  expect(box?.props?.height).toBe(rows.length + 2)
  for (const r of rows) expect(r.length).toBe((box?.props?.width as number) - 2)
  // The bar in the theme's orange, the labels dim.
  expect(await ui.find({ type: 'Text', text: '5h      ' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: '━'.repeat(6) })).toMatchObject({ props: { color: 'claude' } })
})

test('a narrow band narrows the card: no row wider than the band, no word cut', async ($, on) => {
  world(on)
  await startSession($)
  const { box, rows } = await cardIn(await band($, 30))
  expect(box?.props?.width).toBeLessThanOrEqual(30)
  expect(rows.map(r => r.trim().split(/ +/).at(-1))).toEqual(['Subscription', '31%', '12%', 'ago'])
})

test('with no reading the band is passed through as it came; it yields to a survey', async ($, on) => {
  world(on, [])
  await startSession($)
  expect(await (await band($)).drawn()).toEqual({ type: 'engine', ref: 0 })
  await measure($, [FIVE])
  expect(holdersIn(await (await band($, 115, true)).drawn())).toEqual([])
})

test('the card is drawn again only when its text changes, not on every 8 s tick', async ($, on) => {
  let writes = 0
  on('state.set', ($, e, next) => {
    if ((e as { key: string }).key === 'now') writes += 1
    return next(e)
  })
  const w = world(on, [FIVE])
  await startSession($)
  const last = async () => (await cardIn(await band($))).rows.at(-1)?.trim()
  const before = writes
  await w.clock.advance(16_000)
  expect(writes).toBe(before)
  expect(await last()).toBe('Read    <1m ago (this session)')
  await w.clock.advance(48_000)
  expect(await last()).toBe('Read    1m ago (this session)')
  // Ten minutes of 8 s ticks: the time left and the age each change once a minute, not 75 writes.
  const start = writes
  await w.clock.advance(10 * MINUTE)
  expect(writes - start).toBeLessThanOrEqual(20)
})

// context-meter's band card, simulated as its register.tsx draws it: what is beneath first, then its
// hidden holder joined to its own hover group.
const contextCard: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {beneath}
        <Box width={e.props.bodyColumns} justifyContent="flex-end" display="none" hover={{ scope: 'context-meter', display: 'flex' }}>
          <Box borderStyle="round" borderDimColor><Text>context card</Text></Box>
        </Box>
      </Box>
    )
  })
}

for (const tier of ['prepend', 'append'] as const) {
  test(`beside context-meter's card (${tier === 'prepend' ? 'outside' : 'inside'} it): both cards, each in its own group`, { plugins: [{ name: 'context-meter', tier, register: contextCard }] }, async ($, on) => {
    world(on)
    await startSession($)
    const drawn = await (await band($)).drawn()
    const holders = holdersIn(drawn)
    expect(holders.map(h => h.hover?.scope).sort()).toEqual(['context-meter', 'sub-meter'])
    expect(textOf(holders.find(h => h.hover?.scope === 'context-meter'))).toBe('context card')
    expect(textOf(holders.find(h => h.hover?.scope === 'sub-meter'))).toMatch(/^ Subscription/)
    // The engine's own band is kept, once.
    expect(JSON.stringify(drawn).split('"type":"engine"').length - 1).toBe(1)
  })
}

// The shared row with context-meter. The test kit loads no module from outside this folder, so
// context-meter is simulated: its footer drawing exactly as its register.tsx draws it (its keyed Box
// with `ctx `, the bar and the percentage, a separator, then what is beneath) and its fill in
// `$.state`. Its form at each width is the one its own tests assert beside sub-meter, loaded in
// either order; here this meter must give the same row with it outside (prepend) or inside (append).
// Footer 26 + hint 16 ('? for shortcuts' once the cycle hint is dropped).
const SHRINKING: [number, 'bar' | 'short' | 'bare' | null, string][] = [
  [200, 'bar', `ctx ━━━━── 62% · 5h ${BAR(3)} 31% ↻ 2h 10m`],
  [120, 'bar', `ctx ━━━━── 62% · 5h ${BAR(3)} 31% ↻ 2h 10m`],
  [80, 'bar', 'ctx ━━━━── 62% · 5h 31% ↻ 2h 10m'],
  [70, 'bar', 'ctx ━━━━── 62% · 5h 31%'],
  [66, 'short', 'ctx 62% · 5h 31%'],
  [57, 'short', 'ctx 62%'],
  [48, 'bare', '62%'],
  [44, null, ''],
]

const contextMeter: Register = on => {
  // An inline plugin runs in an environment of its own: what it uses is written inside it.
  const FORMS: Record<number, 'bar' | 'short' | 'bare' | null> = { 200: 'bar', 120: 'bar', 80: 'bar', 70: 'bar', 66: 'short', 57: 'short', 48: 'bare', 44: null }
  on('session.start', async ($, e, next) => {
    await $.state.set({ plugin: 'context-meter', key: 'fill' } as never, { percent: 62, tokens: 124_000, window: 200_000, isEstimate: false } as never)
    return next(e)
  })
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const beneath = await next(e)
    const form = FORMS[e.viewport?.columns ?? 200]
    if (form === null || form === undefined) return beneath
    const { Box, Text } = $.ui.resolve(e)
    // A separator only before something on the row: the engine's labels or sub-meter's drawing.
    const hasBeneath = e.props.modes.length > 0 || (typeof beneath === 'object' && beneath !== null && beneath.type === 'Box')
    return (
      <Box flexDirection="row">
        <Box key="context-meter" flexDirection="row" hover={{ scope: 'context-meter' }}>
          {form !== 'bare' ? <Text dimColor>ctx </Text> : null}
          {form === 'bar' ? <Text color="claude">━━━━</Text> : null}
          {form === 'bar' ? <Text dimColor>── </Text> : null}
          <Text>62%</Text>
        </Box>
        {hasBeneath ? <Text dimColor> · </Text> : null}
        {beneath}
      </Box>
    )
  })
}

for (const tier of ['prepend', 'append'] as const) {
  test(`beside context-meter (${tier === 'prepend' ? 'outside' : 'inside'} it): ctx first, the same row at every width`, { plugins: [{ name: 'context-meter', tier, register: contextMeter }] }, async ($, on) => {
    world(on)
    await startSession($)
    await hint($, '(shift+tab to cycle) · ? for shortcuts')
    for (const [columns, , expected] of SHRINKING) expect(`${columns}: ${await row(await footer($, columns))}`).toBe(`${columns}: ${expected}`)
    // The engine's mode labels stay last.
    expect(await row(await footer($, 200, ['plan mode on']), ['plan mode on'])).toBe(`ctx ━━━━── 62% · 5h ${BAR(3)} 31% ↻ 2h 10m · plan mode on`)
  })
}
