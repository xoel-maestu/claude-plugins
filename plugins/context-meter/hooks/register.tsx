import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, RenderNode, RenderViewport, SessionContextUsage, SessionCost, Timer, TurnUsage } from 'claude-code'

import type { ContextMeterFill, ContextMeterTtl } from '../types'

import { EMPTY as NO_CACHE, alertOf, cleared, markCompact, observe, observeTtl, readSubscription, seed, since as cacheSince, ttlInfo } from './cache'
import type { Alert, Cache, TtlSetting } from './cache'
import { cacheStatus, cardOf, cardText } from './card'
import type { CardView, Language, Tone } from './card'
import { SUB_LEAST, barOf, fit, label, tidy } from './fit'
import type { Hides } from './fit'
import { EMPTY as NO_AGENTS, add as addAgent, pathOf, seeTtl, since as agentsSince } from './agents'
import { windowOf } from './pricing'
import { EMPTY, add, since } from './ledger'
import { MAX_READ, TAIL, agentTranscriptOf, completeLines, lastResponse } from './transcript'

const fill = atom({ plugin: 'context-meter', key: 'fill' } as const, null as ContextMeterFill)
const compactAt = atom({ plugin: 'context-meter', key: 'compactAt' } as const, null as number | null)
// In $.state, so a reload of the plugin keeps the session's counts.
const ledger = atom({ plugin: 'context-meter', key: 'ledger' } as const, EMPTY)
const cost = atom({ plugin: 'context-meter', key: 'cost' } as const, null as number | null)
const cache = atom({ plugin: 'context-meter', key: 'cache' } as const, NO_CACHE)
const agents = atom({ plugin: 'context-meter', key: 'agents' } as const, NO_AGENTS)
// The time the card's countdown is drawn for: written by the tick only when the cache line changes.
const drawnAt = atom({ plugin: 'context-meter', key: 'now' } as const, 0)
// The main thread's cache as the footer warns of it: written by the tick only when it changes.
const alert = atom({ plugin: 'context-meter', key: 'alert' } as const, null as Alert | null)

const SYNC_MS = 2000
// `$.store` keys: the TTL last observed and the last subscription reading, for the next session.
const STORED_TTL = 'lastTtl'
const STORED_SUBSCRIPTION = 'isSubscription'
// The TTL a subagent's transcript last showed: the inference for the next session's agents.
const STORED_AGENT_TTL = 'lastAgentTtl'
const SEPARATOR = ' · '
// The terminal footer's row: 2 columns of padding at each end, 2 between the hint and what is drawn
// at the right, and the permission mode label at the left (`⏵⏵ accept edits on ·`, 20 columns).
const FOOTER = 4 + 2 + 20
// The hover group the meter (in SessionMode) and its card (in AbovePrompt) share: a pointer on
// either lights both, so the card shows while the meter or the card itself is under it.
const SCOPE = 'context-meter'
// sub-meter's meter Box in the footer; beside it this meter stays first (see the SessionMode hook).
const SUB_KEY = 'sub-meter'
// The card's border and bar by depth in the agent tree: the main thread in the theme's own accent,
// a subagent and a subagent's subagent in two others, deeper ones as the last.
const DEPTH_COLORS = ['claude', 'ide', 'merged', 'planMode'] as const

// Transient, rebuilt by every load: the timer, one count at a time, the window the autocompact
// point was read for and whether it is to be read again, the stretch (bumped by every figure,
// compaction and /clear, so a count that began before one is stale), the stretch last estimated,
// and the hint line's width as last drawn on the terminal.
let timer: Timer | undefined
let ttlSetting: TtlSetting = 'auto'
let drawnStatus = ''
/** The alert last written; undefined until the first tick writes one (a reload may keep a stale one in $.state). */
let drawnAlert: Alert | null | undefined
/** Whether the footer warns of the cache's expiry (the `cacheAlert` setting). */
let isAlertOn = true
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

const isSeparator = (node: RenderNode | undefined) =>
  typeof node === 'object' && node !== null && node.type === 'Text' && (node.children ?? []).join('') === SEPARATOR

/** A drawing without the Box keyed `key` and the separator drawn after it; as it came when it holds none. */
function without (node: RenderNode | undefined, key: string): RenderNode | undefined {
  if (node === undefined || node === null || typeof node === 'string' || node.type !== 'Box') return node
  if (node.props?.key === key) return undefined
  const children = (node.children ?? []) as RenderNode[]
  for (const [i, child] of children.entries()) {
    const rest = without(child, key)
    if (rest === child) continue
    const after = children.slice(i + 1)
    const kept = [...children.slice(0, i), ...(rest === undefined ? [] : [rest]), ...(isSeparator(after[0]) ? after.slice(1) : after)]
    return { ...node, children: kept }
  }
  return node
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

/** Empties the ledger, the agents and the cache when they count from another session start than the live one (/clear, another session). */
async function keepSession ($: EngineInterface, startedAt: number) {
  const [kept, cached, others] = await Promise.all([read($, ledger), read($, cache), read($, agents)])
  if (since(kept, startedAt) !== kept) await update($, ledger, () => ({ ...EMPTY, startedAt }))
  if (agentsSince(others, startedAt) !== others) await update($, agents, () => ({ ...NO_AGENTS, startedAt }))
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
  const run = await $.process.run(['tail', '-c', String(TAIL), '--', path], { timeoutMs: 5000 }).catch(() => undefined)
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
  const agentTtl = await $.store.get(STORED_AGENT_TTL).catch(() => undefined)
  if (agentTtl === '5m' || agentTtl === '1h') {
    const stored: ContextMeterTtl = agentTtl
    const others = await read($, agents)
    if (others.lastTtl === undefined) await update($, agents, state => (state.lastTtl === undefined ? { ...state, lastTtl: stored } : state))
  }
}

/** The recordings of main-thread responses, one after another. */
let recording: Promise<void> = Promise.resolve()
/** The agents `$.agent.list()` has named, by id: read once each. */
const seenAgents = new Map<string, AgentInfo>()
/** The size each agent's transcript had when last read. */
const agentTranscriptSizes = new Map<string, number>()
/** The agent the card shows, picked with a click on its row; undefined: the main thread. */
let selectedId: string | undefined

/** Queued after the recordings before it, so a compaction or a /clear lands between the right requests. */
const enqueue = (work: () => Promise<unknown>) => { recording = recording.then(work).then(() => {}, () => {}) }

/**
 * A main-thread response to a request sent at `at`: its counts become the last request and add to
 * the session; the cache checks it for a loss. The cache is timed from that start: Anthropic's
 * prompt caching docs count an entry's lifetime from the start of the request that writes or reads
 * it (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, read 2026-11-03).
 */
async function record ($: EngineInterface, usage: TurnUsage, at: number) {
  const { startedAt, cost: spent, rateLimits } = await $.session.usage()
  const before = since(await read($, ledger), startedAt)
  await update($, ledger, state => add(since(state, startedAt), usage, at))
  await update($, cache, state => observe(cacheSince(state, startedAt), usage, at, rateLimits.length > 0, ttlSetting))
  hasCache = true
  if (rateLimits.length > 0) isSubscriptionSeen = true
  // Rate limits say a subscription; none by a second response say an API key (the first may come
  // before the host has any).
  if (rateLimits.length > 0 || before.requests > 0) await readSubscriptionOf($, rateLimits.length > 0)
  await showCost($, spent)
}

/**
 * A subagent's response to a request sent at `at`: added to its row when `$.agent.list()` names the
 * loop. A loop it does not name is one of the engine's own forks (memory, a summarizer), not counted.
 */
async function recordAgent ($: EngineInterface, agentId: string, usage: TurnUsage, at: number) {
  const [{ startedAt, rateLimits }, main] = await Promise.all([$.session.usage(), read($, cache)])
  // The list is read only for an agent not seen yet: a known one stays counted once it is done.
  let info = seenAgents.get(agentId)
  if (info === undefined) {
    info = (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
    if (info === undefined) return
    seenAgents.set(agentId, info)
  }
  const isSubscription = rateLimits.length > 0 || main.isSubscription
  const known = info
  await update($, agents, state => addAgent(agentsSince(state, startedAt), known, usage, at, isSubscription, ttlSetting))
  const path = transcriptPath === undefined ? undefined : agentTranscriptOf(transcriptPath, agentId)
  if (path !== undefined) await readAgentTranscript($, agentId, path)
}

/**
 * The TTL an agent's last cache write used, from the end of its own transcript: read after its
 * responses and when it stops, each time only when the file's size changed. The host may write a
 * response there after its step, so a step reads the one before it; the stop reads the last.
 */
async function readAgentTranscript ($: EngineInterface, agentId: string, path: string) {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stat.size === agentTranscriptSizes.get(agentId)) return
  const before = await read($, agents)
  // An agent with no row yet is read again once it has one.
  if (!before.agents.some(agent => agent.id === agentId)) return
  const text = await readTail($, path, stat.size)
  if (text === undefined) return
  agentTranscriptSizes.set(agentId, stat.size)
  const ttl = lastResponse(text, agentId)?.ttl ?? null
  if (ttl === null) return
  const after = seeTtl(before, agentId, ttl)
  if (after === before) return
  await update($, agents, state => seeTtl(state, agentId, ttl))
  if (before.lastTtl !== ttl) await $.store.set(STORED_AGENT_TTL, ttl).catch(() => {})
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
async function viewOf ($: EngineInterface, now?: number, agentId?: string): Promise<CardView> {
  const [shown, threshold, counted, spent, cached, tick, others] = await Promise.all([
    read($, fill), read($, compactAt), read($, ledger), read($, cost), read($, cache), read($, drawnAt), read($, agents),
  ])
  const { ttl, isInferred } = ttlInfo(cached, ttlSetting)
  // A row written by an earlier build, without its own cache and cost, is not shown as a card.
  const path = agentId === undefined ? [] : pathOf(others, agentId)
  const picked = path.at(-1)
  const isCard = picked !== undefined && picked.cache !== undefined && picked.cost !== undefined
  // An agent on the session's model has the host's window. The host reports no other model's, so
  // an agent on another takes its model's from the docs' table, marked inferred.
  const isHostWindow = isCard && shown !== null && picked.model === counted.last?.model
  const window = !isCard ? null : isHostWindow ? shown!.window : windowOf(picked.model)
  const selected = !isCard ? undefined : { path, window, isWindowInferred: !isHostWindow, ...agentTtlOf(picked.cache) }
  return { fill: shown, compactAt: threshold, ledger: counted, cost: spent, cache: cached, ttl, isTtlInferred: isInferred, now: now ?? tick, agents: others, selected, ttlSetting }
}

/** What `/context-meter <agent>` says when no agent of the session matches. */
const noAgentText = (wanted: string, language: Language) =>
  language === 'es' ? `Ningún agente de esta sesión coincide con «${wanted}».` : `No agent of this session matches "${wanted}".`

/** An agent's cache TTL in force: the setting, else what its transcript showed, else the inference its cache holds. */
function agentTtlOf (agentCache: Cache): { ttl: number; isTtlInferred: boolean } {
  const { ttl, isInferred } = ttlInfo(agentCache, ttlSetting)
  return { ttl, isTtlInferred: isInferred }
}

/**
 * The countdown's tick, on the 2 s resync: the cache line is worked out and the time written only when
 * the line changes (at most once a minute), so the band redraws no more than its text does; no hook
 * runs on hover, so the card cannot know whether it is shown.
 */
async function tick ($: EngineInterface) {
  if (!hasCache) {
    if (drawnAlert !== null) {
      drawnAlert = null
      await update($, alert, () => null)
    }
    return
  }
  const [cached, now] = await Promise.all([read($, cache), $.clock.now()])
  const { ttl, isInferred } = ttlInfo(cached, ttlSetting)
  // The footer's alert, written only when it turns (the 2 s tick: at most 2 s late); none when off.
  const turned = isAlertOn ? alertOf(cached, ttl, now) : null
  if (turned !== drawnAlert) {
    drawnAlert = turned
    await update($, alert, () => turned)
  }
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
  isAlertOn = options.cacheAlert !== false
  const colorFor = (percent: number) => (percent >= dangerAt ? 'error' : percent >= warnAt ? 'warning' : undefined)

  stopTimers()
  drawnStatus = ''
  drawnAlert = undefined
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
  seenAgents.clear()
  agentTranscriptSizes.clear()
  selectedId = undefined
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
      enqueue(async () => {
        // The counts start over after the responses already queued; the next takes the new session start.
        await update($, ledger, () => EMPTY)
        await update($, agents, state => ({ ...NO_AGENTS, ...(state.lastTtl === undefined ? {} : { lastTtl: state.lastTtl }) }))
        selectedId = undefined
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

  // Each response of the main thread feeds the ledger. A step with an agentId is another loop's: a
  // subagent or a teammate (`$.agent.list()` names it) feeds the agents' rows; a workflow agent or the
  // engine's own forks (memory) carry ids no list names and count nothing. The stream is passed on untouched; the counts are read from its result.
  // The result goes back at once: the recording runs after it, chained so steps add in order.
  // A compaction's summarizer request is no step: it reaches only session.compact (seen in a real
  // session, Claude Code 2.1.317), so it never counts as the session's work.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    const agentId = e.agentId
    if (usage !== null) {
      enqueue(() => (agentId === undefined ? record($, usage, sentAt) : recordAgent($, agentId, usage, sentAt)))
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
  // A subagent's end: its transcript holds its last response, so its TTL is read once more.
  on('classic.SubagentStop', async ($, e, next) => {
    const agentId = e.agent_id
    const path = e.agent_transcript_path
    if (typeof agentId === 'string' && typeof path === 'string' && path !== '') {
      enqueue(() => readAgentTranscript($, agentId, path))
    }
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

  on('command.run', { command: 'context-meter' }, async ($, e) => {
    // The responses already in are counted before the card is printed.
    await recording
    const usage = await $.session.usage()
    await keepSession($, usage.startedAt)
    await showCost($, usage.cost)
    await sync($, usage.context, true)
    // `/context-meter 2` or `/context-meter reviewer`: that agent's card (the number as the card lists them).
    const wanted = String((e as { args?: unknown }).args ?? '').trim()
    let agentId: string | undefined
    if (wanted !== '') {
      const listed = (await read($, agents)).agents
      const byNumber = /^\d+$/.test(wanted) ? listed[Number(wanted) - 1] : undefined
      const byName = listed.find(agent => agent.label.toLowerCase() === wanted.toLowerCase()) ??
        listed.find(agent => agent.label.toLowerCase().startsWith(wanted.toLowerCase()))
      const found = byNumber ?? byName
      if (found === undefined) return { text: noAgentText(wanted, language) }
      agentId = found.id
    }
    return { text: cardText(await viewOf($, await $.clock.now(), agentId), language) }
  })

  // The hint line beside the mode label: its width says how much of the row is left. Drawn as it is.
  // sub-meter drops parts of it; where this hook is outer it sees the line before that, so it
  // measures the line as sub-meter draws it (its `hides`, absent without sub-meter).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface === 'terminal') {
      const held = await $.state.get({ plugin: 'sub-meter', key: 'hides' } as never).catch(() => undefined)
      const hides = (held as { value?: Hides | null } | undefined)?.value
      const width = widthOf(hides ? tidy(e.props.hint, hides) : e.props.hint)
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
  // Beside sub-meter (it has a reading) the meter stays first: drawn before sub-meter's Box when that
  // is beneath, taken out and put first by sub-meter when this one is beneath it. The room is counted
  // without sub-meter's meter, and the bar needs room for sub-meter's least form too, so the row is
  // the same whichever wraps the other.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [shown, beneath, sub, now, warned] = await Promise.all([
      read($, fill), next(e),
      $.state.get({ plugin: 'sub-meter', key: 'reading' } as never).catch(() => undefined),
      $.clock.now(),
      read($, alert),
    ])
    if (shown === null) return beneath

    const text = label(shown.percent, shown.isEstimate)
    const rest = without(beneath, SUB_KEY)
    const hasRest = e.props.modes.length > 0 || !isBlank(rest)
    const room = roomOf(e) - (hasRest ? widthOfNode(rest, e.props.modes) + SEPARATOR.length : 0)
    // sub-meter draws its reading while a window of it is not past its reset (one without a reset time never is).
    const windows = (sub as { value?: { windows?: { resetsAt?: unknown }[] } | null } | undefined)?.value?.windows ?? []
    const isSubOn = windows.some(w => typeof w.resetsAt !== 'string' || !(Date.parse(w.resetsAt) <= now))
    const form = fit(room, text, isSubOn ? SEPARATOR.length + SUB_LEAST : 0)
    if (form === null) return beneath

    const { Box, Text } = $.ui.resolve(e)
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)
    const color = colorFor(shown.percent)
    const bar = barOf(shown.percent, text)

    return (
      <Box flexDirection="row">
        <Box key="context-meter" flexDirection="row" hover={{ scope: SCOPE }}>
          {form === 'bare' ? null
            // The prefix warns of the main thread's cache expiry: the warning color in its last stretch, the error color once gone.
            : isAlertOn && warned === 'expiring' ? <Text color="warning">ctx </Text>
            : isAlertOn && warned === 'expired' ? <Text color="error">ctx </Text>
            : <Text dimColor>ctx </Text>}
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
    // The agent whose transcript is in view, else the one picked on the card, else the main thread.
    const [view, beneath] = await Promise.all([viewOf($, undefined, e.props.view?.agentId ?? selectedId), next(e)])
    const shown = view.fill
    if (shown === null || e.props.hasSurvey) return beneath
    const card = cardOf(view, language, e.props.bodyColumns)
    if (card === null) return beneath

    const { Box, Text, Button } = $.ui.resolve(e)
    const color = colorFor(shown.percent)
    // While an agent's transcript is in view the card follows the view, so a press moves the view;
    // otherwise it picks what the card shows.
    const viewed = e.props.view?.agentId
    const press = (target: string) => () => {
      const id = target === 'main' ? undefined : target.slice('agent:'.length)
      if (viewed !== undefined) {
        void $.ui.view(id === undefined ? {} : { agentId: id }).catch(() => undefined)
        return
      }
      selectedId = id
      $.ui.invalidate('ui.render')
    }
    const depthColor = DEPTH_COLORS[Math.min(card.depth, DEPTH_COLORS.length - 1)]
    const toneProps = (tone: Tone) =>
      tone === 'meter' ? { color } : tone === 'bar' ? { color: color ?? depthColor } : tone === 'dim' ? { dimColor: true } : {}

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
            flexDirection="column" borderStyle="round" borderColor={depthColor}
          >
            {card.rows.map(cells => (
              <Box flexDirection="row">
                <Text> </Text>
                {cells.map(cell => cell.press === undefined
                  ? <Text {...toneProps(cell.tone)}>{cell.text}</Text>
                  : <Button key={cell.press} plain onPress={press(cell.press)}>{cell.text}</Button>)}
                <Text> </Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    )
  })
}
