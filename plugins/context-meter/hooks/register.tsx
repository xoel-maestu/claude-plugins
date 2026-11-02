import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, RenderViewport, SessionContextUsage, SessionCost, Timer, TurnUsage } from 'claude-code'

import type { ContextMeterFill } from '../types'

import { EMPTY as NO_CACHE, cleared, markCompact, observe, observeTtl, readSubscription, seed, since as cacheSince, ttlInfo } from './cache'
import type { TtlSetting } from './cache'
import { cacheStatus, cardOf, cardText } from './card'
import type { CardView, Language, Tone } from './card'
import { barOf, fit, label } from './fit'
import { EMPTY, add, since } from './ledger'
import { MAX_READ, TAIL, completeLines, lastResponse } from './transcript'

const fill = atom({ plugin: 'context-meter', key: 'fill' } as const, null as ContextMeterFill)
const compactAt = atom({ plugin: 'context-meter', key: 'compactAt' } as const, null as number | null)
// In $.state, so a reload of the plugin keeps the session's counts.
const ledger = atom({ plugin: 'context-meter', key: 'ledger' } as const, EMPTY)
const cost = atom({ plugin: 'context-meter', key: 'cost' } as const, null as number | null)
const cache = atom({ plugin: 'context-meter', key: 'cache' } as const, NO_CACHE)
// The time the card's countdown is drawn for: written by the tick only when the cache line changes.
const drawnAt = atom({ plugin: 'context-meter', key: 'now' } as const, 0)

const SYNC_MS = 2000
// `$.store` keys: the TTL last observed and the last subscription reading, for the next session.
const STORED_TTL = 'lastTtl'
const STORED_SUBSCRIPTION = 'isSubscription'
const SEPARATOR = ' · '
// The terminal footer's row: 2 columns of padding at each end, 2 between the hint and what is drawn
// at the right, and the permission mode label at the left (`⏵⏵ accept edits on ·`, 20 columns).
const FOOTER = 4 + 2 + 20
// The hover group the meter (in SessionMode) and its card (in AbovePrompt) share: a pointer on
// either lights both, so the card shows while the meter or the card itself is under it.
const SCOPE = 'context-meter'

// Transient, rebuilt by every load: the timer, one count at a time, the window the autocompact
// point was read for and whether it is to be read again, the stretch (bumped by every figure,
// compaction and /clear, so a count that began before one is stale), the stretch last estimated,
// and the hint line's width as last drawn on the terminal.
let timer: Timer | undefined
let ttlSetting: TtlSetting = 'auto'
let drawnStatus = ''
// Whether the cache has a request to show; while it has none the tick reads nothing.
let hasCache = false
// Whether the cache already counts the session as a subscription (rate limits seen).
let isSubscriptionSeen = false
// The main session's transcript, from the classic hook events' `transcript_path`, and its size when
// last read at a turn's end: a file the same size is not read again.
let transcriptPath: string | undefined
let transcriptSize = -1
// Whether the turn that ended last still waits for its last response in the transcript: the host
// writes the transcript after the Stop event, so the read at a turn's end may come before it.
let isTranscriptDue = false
let isCounting = false
let countedWindow = 0
let isCompactAtStale = true
let stretch = 0
let estimatedIn = -1
let hintWidth = 0

/** Columns a text takes: one per character, none for a variation selector. */
const widthOf = (text: string) => [...text.replace(/[︎️]/g, '')].length

/** Whether a drawing shows nothing on the row. The engine's own node draws `modes`, counted apart. */
function isBlank (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null) return true
  if (typeof node === 'string') return node.trim() === ''
  if (node.type === 'engine') return true
  return (node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isBlank)
}

/** Columns a drawing takes on the row; what is placed out of the flow (absolute or hidden) takes none. */
function widthOfNode (node: RenderNode | undefined, modes: readonly string[]): number {
  if (node === undefined || node === null) return 0
  if (typeof node === 'string') return widthOf(node)
  if (node.type === 'engine') return widthOf(modes.join(' & '))
  const props = (node.props ?? {}) as { position?: string; display?: string }
  if (props.position === 'absolute' || props.display === 'none') return 0
  const children = (node.children ?? []) as RenderNode[]
  return children.reduce((sum, child) => sum + widthOfNode(child, modes), 0)
}

/** Columns the footer leaves at its right end on the terminal; no limit elsewhere. */
function roomOf (e: { surface: string; viewport?: RenderViewport }) {
  if (e.surface !== 'terminal' || e.viewport === undefined) return Infinity
  return e.viewport.columns - FOOTER - (hintWidth > 0 ? 1 + hintWidth : 0)
}

const same = (a: ContextMeterFill, b: ContextMeterFill) => JSON.stringify(a) === JSON.stringify(b)

/** Writes the fill only when it changed, so an equal reading redraws nothing. */
async function show ($: EngineInterface, next: ContextMeterFill) {
  if (!same(await read($, fill), next)) await update($, fill, () => next)
}

/**
 * The breakdown's tokens over the model's window, as the figure and the status line measure: the
 * breakdown's own percentage is over the compaction window, which may be smaller.
 */
const estimateOf = (tokens: number, window: number): ContextMeterFill =>
  ({ percent: Math.round((tokens / window) * 100), tokens, window, isEstimate: true })

/**
 * Takes the engine's figure when it has one. While it has none (no response yet in this window: a
 * fresh, resumed, compacted or rewound session) it counts the window once with the local summary
 * breakdown and keeps that estimate until the next response. The same count gives the autocompact
 * point, read again with every estimate, when the window changes, and after a start, a /clear, a
 * compaction or an autocompact switch in /config. `canCount` false only takes a figure.
 */
async function sync ($: EngineInterface, context: SessionContextUsage, canCount: boolean) {
  const hasFigure = context.percent !== undefined
  if (hasFigure) {
    stretch += 1
    await show($, { percent: context.percent!, tokens: context.tokens, window: context.window, isEstimate: false })
  }
  // Once per stretch without a figure, whether or not the count gives a breakdown.
  const needsEstimate = !hasFigure && estimatedIn !== stretch
  const needsCompactAt = isCompactAtStale || countedWindow !== context.window
  if (!canCount || isCounting || !(needsEstimate || needsCompactAt)) return

  isCounting = true
  const countedIn = stretch
  // Cleared before the count, so a change that comes in while counting asks for the next one.
  isCompactAtStale = false
  let isCounted = false
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    isCounted = true
    countedWindow = context.window
    const threshold = breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold ?? null : null
    if ((await read($, compactAt)) !== threshold) await update($, compactAt, () => threshold)
    // A figure that came in while counting stands: the estimate is dropped.
    if (needsEstimate && stretch === countedIn) {
      estimatedIn = countedIn
      await show($, breakdown
        ? estimateOf(breakdown.totalTokens, context.window)
        : null)
    }
  } finally {
    isCounting = false
    if (!isCounted) isCompactAtStale = true
  }
}

/** Writes the session's cost only when it changed. */
async function showCost ($: EngineInterface, next: SessionCost | undefined) {
  const usd = next?.usd ?? null
  if ((await read($, cost)) !== usd) await update($, cost, () => usd)
}

/** Empties the ledger and the cache when they count from another session start than the live one (/clear, another session). */
async function keepSession ($: EngineInterface, startedAt: number) {
  const [kept, cached] = await Promise.all([read($, ledger), read($, cache)])
  if (since(kept, startedAt) !== kept) await update($, ledger, () => ({ ...EMPTY, startedAt }))
  const current = cacheSince(cached, startedAt)
  if (current !== cached) await update($, cache, state => cacheSince(state, startedAt))
  hasCache = current.last !== undefined
}

/** Takes the main session's transcript path from a classic hook event; a subagent's is not its. */
function seeTranscript (e: { transcript_path?: string; agent_id?: string }) {
  if (e.agent_id !== undefined || typeof e.transcript_path !== 'string' || e.transcript_path === '') return
  if (e.transcript_path !== transcriptPath) transcriptSize = -1
  transcriptPath = e.transcript_path
}

/**
 * The transcript's last complete lines: `tail -c` through `$.process.run` (the path one argv
 * element, no shell), so a long session copies only its end; where that cannot run (no `tail`, as
 * on Windows, or it fails) the whole file through `$.fs.read`, up to 4 MiB. Undefined when neither works.
 */
async function readTail ($: EngineInterface, path: string, size: number): Promise<string | undefined> {
  const run = await $.process.run(['tail', '-c', String(TAIL), path], { timeoutMs: 5000 }).catch(() => undefined)
  if (run !== undefined && run.exitCode === 0 && !run.isStdoutTruncated) return completeLines(run.stdout, size > TAIL)
  if (size > MAX_READ) return undefined
  return await $.fs.read(path).catch(() => undefined) as string | undefined
}

/**
 * The TTL the last main-thread cache write used, from the session transcript's end: read at the end
 * of each main turn and, until the transcript holds that turn's last response (the one the ledger
 * last counted), again on each 2 s resync, each time only when its size changed. A pure read keeps
 * the TTL before it; a failed read changes nothing. A new TTL is stored for the next session.
 */
async function readTranscript ($: EngineInterface) {
  const path = transcriptPath
  if (path === undefined || !isTranscriptDue) return
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stat.size === transcriptSize) return
  const text = await readTail($, path, stat.size)
  if (text === undefined || path !== transcriptPath) return
  transcriptSize = stat.size
  const found = lastResponse(text)
  const last = (await read($, ledger)).last
  // No request to wait for, or the transcript has it: done until the next turn ends.
  if (last === undefined || (found !== null && found.cacheRead === last.cacheRead && found.cacheWrite === last.cacheWrite)) {
    isTranscriptDue = false
  }
  // An earlier response's TTL stands until this turn's is written.
  const ttl = found?.ttl ?? null
  if (ttl === null) return
  const cached = await read($, cache)
  if (observeTtl(cached, ttl) !== cached) await update($, cache, state => observeTtl(state, ttl))
  if (cached.observedTtl !== ttl) await $.store.set(STORED_TTL, ttl).catch(() => {})
}

/** This session's subscription reading: into the cache, and stored for the next session when it changed. */
async function readSubscriptionOf ($: EngineInterface, isSubscription: boolean) {
  const cached = await read($, cache)
  // Rate limits once seen this session stand, even if a later read has none.
  if (!isSubscription && cached.isSubscriptionKnown === true && cached.isSubscription) return
  if (readSubscription(cached, isSubscription) === cached) return
  await update($, cache, state => readSubscription(state, isSubscription))
  await $.store.set(STORED_SUBSCRIPTION, isSubscription).catch(() => {})
}

/** What earlier sessions stored: the cache takes it as inference (see `seed`). */
async function seedFromStore ($: EngineInterface) {
  const [ttl, isSubscription] = await Promise.all([
    $.store.get(STORED_TTL).catch(() => undefined),
    $.store.get(STORED_SUBSCRIPTION).catch(() => undefined),
  ])
  const cached = await read($, cache)
  if (seed(cached, { ttl, isSubscription }) !== cached) await update($, cache, state => seed(state, { ttl, isSubscription }))
}

/** The recordings of main-thread responses, one after another. */
let recording: Promise<void> = Promise.resolve()

/** Queued after the recordings before it, so a compaction or a /clear lands between the right requests. */
const enqueue = (work: () => Promise<unknown>) => { recording = recording.then(work).then(() => {}, () => {}) }

/** A main-thread response: its counts become the last request and add to the session; the cache checks it for a loss. */
async function record ($: EngineInterface, usage: TurnUsage) {
  const [{ startedAt, cost: spent, rateLimits }, now] = await Promise.all([$.session.usage(), $.clock.now()])
  const before = since(await read($, ledger), startedAt)
  await update($, ledger, state => add(since(state, startedAt), usage, now))
  await update($, cache, state => observe(cacheSince(state, startedAt), usage, now, rateLimits.length > 0, ttlSetting))
  hasCache = true
  if (rateLimits.length > 0) isSubscriptionSeen = true
  // Rate limits say a subscription; none by a second response say an API key (the first may come
  // before the host has any).
  if (rateLimits.length > 0 || before.requests > 0) await readSubscriptionOf($, rateLimits.length > 0)
  await showCost($, spent)
}

/**
 * Rate limits from any usage read mark the session a subscription: the first request may come before
 * the host has any, and the TTL in force (worked out when drawn) then turns 1h for it too.
 */
function seeRateLimits ($: EngineInterface, rateLimits: readonly unknown[]) {
  if (rateLimits.length === 0 || isSubscriptionSeen) return
  isSubscriptionSeen = true
  enqueue(() => readSubscriptionOf($, true))
}

/** Everything the card shows; `now` is the time the countdown is drawn for, the tick's unless given. */
async function viewOf ($: EngineInterface, now?: number): Promise<CardView> {
  const [shown, threshold, counted, spent, cached, tick] = await Promise.all([
    read($, fill), read($, compactAt), read($, ledger), read($, cost), read($, cache), read($, drawnAt),
  ])
  const { ttl, isInferred } = ttlInfo(cached, ttlSetting)
  return { fill: shown, compactAt: threshold, ledger: counted, cost: spent, cache: cached, ttl, isTtlInferred: isInferred, now: now ?? tick }
}

/**
 * The countdown's tick, on the 2 s resync: the cache line is worked out and the time written only when
 * the line changes (at most once a minute), so the band redraws no more than its text does; no hook
 * runs on hover, so the card cannot know whether it is shown.
 */
async function tick ($: EngineInterface) {
  if (!hasCache) return
  const [cached, now] = await Promise.all([read($, cache), $.clock.now()])
  const { ttl, isInferred } = ttlInfo(cached, ttlSetting)
  const line = cacheStatus(cached, ttl, now, 'en', isInferred)
  if (line === drawnStatus) return
  drawnStatus = line
  await update($, drawnAt, () => now)
}

/** The 2 s resync: the plain usage call is free and catches resumes and rewinds, which raise no measure. */
function startTimer ($: EngineInterface) {
  timer ??= $.clock.every(SYNC_MS, async () => {
    const usage = await $.session.usage()
    await showCost($, usage.cost)
    seeRateLimits($, usage.rateLimits)
    if (isTranscriptDue) enqueue(() => readTranscript($))
    await recording
    await sync($, usage.context, true)
    await tick($)
  })
}

function stopTimers () {
  timer?.cancel()
  timer = undefined
}

export const register: Register = (on, options) => {
  const warnSetting = typeof options.warnAt === 'number' ? options.warnAt : 50
  const dangerSetting = typeof options.dangerAt === 'number' ? options.dangerAt : 75
  // Given the wrong way round the two are swapped, so the warning color still has its band.
  const warnAt = Math.min(warnSetting, dangerSetting)
  const dangerAt = Math.max(warnSetting, dangerSetting)
  const language: Language = options.language === 'es' ? 'es' : 'en'
  ttlSetting = options.cacheTtl === '5m' || options.cacheTtl === '1h' ? options.cacheTtl : 'auto'
  const colorFor = (percent: number) => (percent >= dangerAt ? 'error' : percent >= warnAt ? 'warning' : undefined)

  stopTimers()
  drawnStatus = ''
  hasCache = false
  isSubscriptionSeen = false
  recording = Promise.resolve()
  isCounting = false
  countedWindow = 0
  isCompactAtStale = true
  stretch = 0
  estimatedIn = -1
  hintWidth = 0
  transcriptPath = undefined
  transcriptSize = -1
  isTranscriptDue = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-meter',
      description: language === 'es' ? 'Muestra el llenado de la ventana de contexto' : 'Show the context window fill',
    })
    // Counting would hold up the start: the first count waits for the first check.
    isCompactAtStale = true
    const usage = await $.session.usage()
    await keepSession($, usage.startedAt)
    await seedFromStore($)
    await showCost($, usage.cost)
    await sync($, usage.context, false)
    startTimer($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // A /clear raises no session.start after it: the timer goes on and the next check estimates anew.
      stretch += 1
      isCompactAtStale = true
      await update($, fill, () => null)
      // The counts start over; the next response takes the new session start.
      await update($, ledger, () => EMPTY)
      enqueue(async () => {
        const now = await $.clock.now()
        // The TTL setting and the billing do not change with /clear: those readings are kept.
        await update($, cache, state => cleared(now, state))
        hasCache = false
      })
    } else {
      stopTimers()
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    startTimer($)
    seeRateLimits($, e.rateLimits)
    if (e.changed.includes('cost')) await showCost($, e.cost)
    if (e.changed.includes('context')) await sync($, e.context, true)
    return next(e)
  })

  // Each response of the main thread feeds the ledger. A step with an agentId is another loop's
  // (a subagent, a teammate, a workflow agent, or the engine's own forks: compaction, memory) and
  // counts nothing. The stream is passed on untouched; the counts are read from its result.
  // The result goes back at once: the recording runs after it, chained so steps add in order.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId === undefined && usage !== null) {
      enqueue(() => record($, usage))
    }
    return result
  })

  // The classic hook events carry the transcript's path: the start (a /clear's new file too) and each
  // prompt give it; the end of a main-thread turn reads the transcript, and the resync reads it again
  // until the turn's last response is written there (the host writes it after Stop).
  on('classic.SessionStart', async ($, e, next) => {
    seeTranscript(e)
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    seeTranscript(e)
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    seeTranscript(e)
    if (e.agent_id === undefined) {
      isTranscriptDue = true
      enqueue(() => readTranscript($))
    }
    return next(e)
  })

  // A compaction of the main conversation opens a new stretch: the next check estimates anew. The
  // cache hears it after the requests already queued, so the next request's loss is the compaction's.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && result.messages !== undefined) {
      stretch += 1
      isCompactAtStale = true
      enqueue(() => update($, cache, markCompact))
    }
    return result
  })

  // Autocompact switched in /config moves or drops the point: the next check reads it again.
  on('config.set', { key: 'autoCompact' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) isCompactAtStale = true
    return result
  })

  on('command.run', { command: 'context-meter' }, async $ => {
    // The responses already in are counted before the card is printed.
    await recording
    const usage = await $.session.usage()
    await keepSession($, usage.startedAt)
    await showCost($, usage.cost)
    await sync($, usage.context, true)
    return { text: cardText(await viewOf($, await $.clock.now()), language) }
  })

  // The hint line beside the mode label: its width says how much of the row is left. Drawn as it is.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.surface === 'terminal') {
      const width = widthOf(e.props.hint)
      if (width !== hintWidth) {
        hintWidth = width
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  // Bottom right of the footer: the meter, then whatever is beneath it (the engine's mode labels,
  // another plugin's drawing). Where the row is short it drops its bar, then its prefix, then itself.
  // The card is not drawn here: the footer clips what rises above it to about four rows.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [shown, beneath] = await Promise.all([read($, fill), next(e)])
    if (shown === null) return beneath

    const text = label(shown.percent, shown.isEstimate)
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)
    const room = roomOf(e) - (hasBeneath ? widthOfNode(beneath, e.props.modes) + SEPARATOR.length : 0)
    const form = fit(room, text)
    if (form === null) return beneath

    const { Box, Text } = $.ui.resolve(e)
    const color = colorFor(shown.percent)
    const bar = barOf(shown.percent, text)

    return (
      <Box flexDirection="row">
        <Box key="context-meter" flexDirection="row" hover={{ scope: SCOPE }}>
          {form !== 'bare' ? <Text dimColor>ctx </Text> : null}
          {form === 'bar' ? <Text color={color ?? 'claude'}>{'━'.repeat(bar.filled)}</Text> : null}
          {form === 'bar' ? <Text dimColor>{'─'.repeat(bar.empty) + ' '}</Text> : null}
          <Text color={color}>{text}</Text>
        </Box>
        {hasBeneath ? <Text dimColor>{SEPARATOR}</Text> : null}
        {beneath}
      </Box>
    )
  })

  // The hover card, in the band above the prompt: placed out of the flow at the band's bottom right,
  // so its bottom border sits on the row above the prompt's top border and it moves nothing of what
  // the band holds. Hidden until the meter's group is hovered. With nothing to show, the band is
  // left as it was, so it gets no row of its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [view, beneath] = await Promise.all([viewOf($), next(e)])
    const shown = view.fill
    if (shown === null || e.props.hasSurvey) return beneath
    const card = cardOf(view, language, e.props.bodyColumns)
    if (card === null) return beneath

    const { Box, Text } = $.ui.resolve(e)
    const color = colorFor(shown.percent)
    const toneProps = (tone: Tone) =>
      tone === 'meter' ? { color } : tone === 'bar' ? { color: color ?? 'claude' } : tone === 'dim' ? { dimColor: true } : {}

    // The card sits in the flow, after what the band holds, in a holder as wide as the band that
    // pushes it to the right end. The holder is hidden (no row) until the hover group lights: a
    // card floated out of the flow is clipped by the band on the terminal (seen in a real session),
    // so the card takes its rows while shown. An engine node may not sit under a Box that sets a
    // width, so the holder is apart from it. The padding is drawn as spaces in each row.
    return (
      <Box flexDirection="column">
        {beneath}
        <Box
          width={e.props.bodyColumns} justifyContent="flex-end"
          display="none" hover={{ scope: SCOPE, display: 'flex' }}
        >
          <Box
            width={card.width} height={card.height}
            flexDirection="column" borderStyle="round" borderDimColor
          >
            {card.rows.map(cells => (
              <Box flexDirection="row">
                <Text> </Text>
                {cells.map(cell => <Text {...toneProps(cell.tone)}>{cell.text}</Text>)}
                <Text> </Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    )
  })
}
