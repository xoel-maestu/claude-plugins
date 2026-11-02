import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, RenderViewport, Timer } from 'claude-code'

import type { SubMeterReading, SubMeterWindow } from '../types'

import { cardOf, cardText } from './card'
import type { Tone } from './card'
import { BETWEEN, SEPARATOR, columns, contextWidth, fit, split, tidy } from './fit'
import type { Hides, Piece } from './fit'
import { isStale, newer, percentAt, readingOf, resetIn, shown, until, windowsOf } from './limits'
import type { Display } from './limits'

const reading = atom({ plugin: 'sub-meter', key: 'reading' } as const, null as SubMeterReading)
const hides = atom({ plugin: 'sub-meter', key: 'hides' } as const, null as Hides | null)
const turn = atom({ plugin: 'sub-meter', key: 'turn' } as const, 0)
const tick = atom({ plugin: 'sub-meter', key: 'tick' } as const, 0)
// The time the hover card is drawn for: written by the tick only when the card's text changes.
const drawnAt = atom({ plugin: 'sub-meter', key: 'now' } as const, 0)

// The `$.store` key every session writes its reading to and reads the others' from.
const STORED = 'reading'
const SYNC_MS = 8000
// The terminal footer's row, as context-meter counts it: 2 columns of padding at each end, 2 between
// the hint and what is drawn at the right, and the permission mode label (`⏵⏵ accept edits on ·`).
const FOOTER = 4 + 2 + 20
const KEY = 'sub-meter'
// The hover group the meter (in SessionMode) and its card (in AbovePrompt) share; context-meter has its own.
const SCOPE = 'sub-meter'
const CONTEXT_KEY = 'context-meter'
const DISPLAYS: readonly Display[] = ['rotate', 'both', 'session', 'week']

type Language = 'en' | 'es'
const LABELS: Record<Language, Record<SubMeterWindow['kind'], string>> = {
  en: { five_hour: '5h', seven_day: 'week' },
  es: { five_hour: '5h', seven_day: 'semana' },
}

// Transient, rebuilt by every load: the timers, this session's start (the origin of its readings),
// whether it is interactive, and the hint line's width as last drawn on the terminal.
let syncTimer: Timer | undefined
let rotateTimer: Timer | undefined
let origin = 0
let isInteractive = true
let hintWidth = 0
// This session's own reading: whether it had rate limits, and whether a response came without any
// (an API key, say), after which no reading is drawn or taken from the store.
let isOwnSeen = false
let isOff = false
// The card's text as last drawn, so the tick writes `drawnAt` only when it changes.
let drawnText: string | null = null
let language: Language = 'en'
// The settings, from the load.
let display: Display = 'rotate'
let seconds = 8
let hidden: Hides = { cycle: true, interrupt: true }

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
  if (typeof node === 'string') return columns(node)
  if (node.type === 'engine') return columns(modes.join(' & '))
  const props = (node.props ?? {}) as { position?: string; display?: string }
  if (props.position === 'absolute' || props.display === 'none') return 0
  const children = (node.children ?? []) as RenderNode[]
  return children.reduce((sum, child) => sum + widthOfNode(child, modes), 0)
}

const isSeparator = (node: RenderNode | undefined) =>
  typeof node === 'object' && node !== null && node.type === 'Text' && (node.children ?? []).join('') === SEPARATOR

/**
 * The Box keyed `key` taken out of a drawing, with the separator drawn after it, and what is left;
 * nothing taken when the drawing holds no such Box.
 */
function takeOut (node: RenderNode | undefined, key: string): { taken?: RenderNode; rest: RenderNode | undefined } {
  if (node === undefined || node === null || typeof node === 'string' || node.type !== 'Box') return { rest: node }
  if (node.props?.key === key) return { taken: node, rest: undefined }
  const children = (node.children ?? []) as RenderNode[]
  for (const [i, child] of children.entries()) {
    const { taken, rest } = takeOut(child, key)
    if (taken === undefined) continue
    const after = children.slice(i + 1)
    const kept = [...children.slice(0, i), ...(rest === undefined ? [] : [rest]), ...(isSeparator(after[0]) ? after.slice(1) : after)]
    return { taken, rest: { ...node, children: kept } }
  }
  return { rest: node }
}

/** Columns the footer leaves at its right end on the terminal; no limit elsewhere. */
function roomOf (e: { surface: string; viewport?: RenderViewport }) {
  if (e.surface !== 'terminal' || e.viewport === undefined) return Infinity
  return e.viewport.columns - FOOTER - (hintWidth > 0 ? 1 + hintWidth : 0)
}

/** Keeps a reading this session took: in `$.state` for the meter and in `$.store` for the other sessions. */
async function remember ($: EngineInterface, rateLimits: Parameters<typeof windowsOf>[0]) {
  const windows = windowsOf(rateLimits)
  if (windows.length === 0) return
  isOwnSeen = true
  isOff = false
  const next = { windows, at: await $.clock.now(), origin }
  await update($, reading, () => next)
  await $.store.set(STORED, next).catch(() => {})
}

/**
 * A response of this session came without the two windows before it ever had them: no subscription
 * here. The reading goes, from the meter and from the store, so no session keeps showing it.
 */
async function forget ($: EngineInterface) {
  isOff = true
  if ((await read($, reading)) !== null) await update($, reading, () => null)
  await $.store.delete(STORED).catch(() => {})
}

/**
 * Takes the stored reading when another session's is newer; a failed read keeps the one on screen.
 * A reading whose windows are all past their reset goes: nothing it says holds.
 */
async function syncFromStore ($: EngineInterface) {
  const [current, now] = await Promise.all([read($, reading), $.clock.now()])
  if (isOff) return
  const stored = readingOf(await $.store.get(STORED).catch(() => undefined))
  const next = newer(current, isStale(stored, now) ? null : stored)
  if (isStale(next, now)) await update($, reading, () => null)
  else if (next !== current) await update($, reading, () => next)
}

/** The card's tick: the time it is drawn for is written only when its text changes (once a minute at most). */
async function refreshCard ($: EngineInterface) {
  const [held, now] = await Promise.all([read($, reading), $.clock.now()])
  const text = cardText({ reading: held, now, origin }, language)
  if (text === drawnText) return
  drawnText = text
  await update($, drawnAt, () => now)
}

/** Publishes which hint parts are dropped, for context-meter, when it changed (a reload may change it). */
async function publishHides ($: EngineInterface) {
  const held = await read($, hides)
  if (held?.cycle !== hidden.cycle || held?.interrupt !== hidden.interrupt) await update($, hides, () => hidden)
}

/** The 8 s re-read of the store, which also redraws the countdown, and the rotation. Interactive sessions only. */
function startTimers ($: EngineInterface) {
  if (!isInteractive) return
  syncTimer ??= $.clock.every(SYNC_MS, async () => {
    await syncFromStore($)
    await publishHides($)
    await refreshCard($)
    if ((await read($, reading)) !== null) await update($, tick, n => n + 1)
  })
  if (display === 'rotate') {
    rotateTimer ??= $.clock.every(seconds * 1000, async () => {
      if (((await read($, reading))?.windows.length ?? 0) >= 2) await update($, turn, n => n + 1)
    })
  }
}

function stopTimers () {
  syncTimer?.cancel()
  rotateTimer?.cancel()
  syncTimer = undefined
  rotateTimer = undefined
}

export const register: Register = (on, options) => {
  display = DISPLAYS.find(d => d === options.display) ?? 'rotate'
  seconds = typeof options.rotateSeconds === 'number' && options.rotateSeconds >= 1 ? options.rotateSeconds : 8
  hidden = { cycle: options.hideCycleHint !== false, interrupt: options.hideInterruptHint !== false }
  language = options.language === 'es' ? 'es' : 'en'
  const labels = LABELS[language]

  stopTimers()
  hintWidth = 0

  on('session.start', async ($, e, next) => {
    stopTimers()
    isInteractive = e.isInteractive
    isOwnSeen = false
    isOff = false
    await $.command.register({
      name: 'sub-meter',
      description: language === 'es' ? 'Muestra el uso de la suscripción' : 'Show the subscription usage',
    })
    await publishHides($)
    // The stored reading first, so a new session shows one before its first response.
    await syncFromStore($)
    const usage = await $.session.usage()
    origin = usage.startedAt
    await remember($, usage.rateLimits)
    await refreshCard($)
    startTimers($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear raises no session.start after it: the timers go on.
    if (e.reason !== 'clear') stopTimers()
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    startTimers($)
    if (e.changed.includes('rateLimits')) await remember($, e.rateLimits)
    // A fill means a response came in; without the windows, and none seen before, no subscription.
    if (!isOwnSeen && e.context.tokens !== undefined && windowsOf(e.rateLimits).length === 0) await forget($)
    await refreshCard($)
    return next(e)
  })

  on('command.run', { command: 'sub-meter' }, async $ => {
    await syncFromStore($)
    const [held, now] = await Promise.all([read($, reading), $.clock.now()])
    const text = cardText({ reading: held, now, origin }, language)
    return { text: text ?? (language === 'es' ? 'Sin uso de suscripción en esta sesión (sin límites de uso).' : 'No subscription usage in this session (no rate limits).') }
  })

  // The hint line beside the mode label, without the parts dropped; its width says how much of the
  // row is left. The engine still draws it.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    const hint = tidy(e.props.hint, hidden)
    if (e.surface === 'terminal') {
      const width = columns(hint)
      if (width !== hintWidth) {
        hintWidth = width
        $.ui.invalidate('ui.render')
      }
    }
    return hint === e.props.hint ? next(e) : next({ ...e, props: { ...e.props, hint } })
  })

  // Bottom right of the footer: context-meter's meter when it is beneath (taken out and put first),
  // this meter, then the rest beneath (the engine's mode labels, other plugins). Where the row is
  // short it gives up its bar, then the reset time, then itself; never a second line.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [held, index, , now, beneath, context] = await Promise.all([
      read($, reading), read($, turn), read($, tick), $.clock.now(), next(e),
      // context-meter's fill, for the room it takes when it is drawn after this meter.
      $.state.get({ plugin: 'context-meter', key: 'fill' } as never).catch(() => undefined),
    ])
    if (held === null || isStale(held, now)) return beneath

    const { taken, rest } = takeOut(beneath, CONTEXT_KEY)
    const hasRest = e.props.modes.length > 0 || !isBlank(rest)
    const room = roomOf(e) - (hasRest ? widthOfNode(rest, e.props.modes) + SEPARATOR.length : 0)
    const fill = (context as { value?: { percent: number; isEstimate: boolean } | null } | undefined)?.value
    const beside = taken !== undefined ? widthOfNode(taken, e.props.modes) : contextWidth(room, fill)
    const windows = shown(held.windows, display, index)
    const pieces: (Piece & { at: number })[] = windows.map(w => {
      const left = resetIn(w, now)
      const at = percentAt(w, now)
      return { label: labels[w.kind], percent: `${Math.round(at)}%`, reset: left === undefined ? '' : until(left), at }
    })
    const form = fit(room - (beside > 0 ? beside + SEPARATOR.length : 0), pieces)
    if (form === null) return beneath

    const { Box, Text } = $.ui.resolve(e)
    const colorFor = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'claude')
    return (
      <Box flexDirection="row">
        {taken ?? null}
        {taken !== undefined ? <Text dimColor>{SEPARATOR}</Text> : null}
        <Box key={KEY} flexDirection="row" hover={{ scope: SCOPE }}>
          {pieces.map((p, i) => {
            const bar = split(p.at)
            return (
              <Box flexDirection="row">
                {i > 0 ? <Text dimColor>{BETWEEN}</Text> : null}
                <Text dimColor>{p.label + ' '}</Text>
                {form === 'bar' ? <Text color={colorFor(p.at)}>{'━'.repeat(bar.filled)}</Text> : null}
                {form === 'bar' ? <Text dimColor>{'─'.repeat(bar.empty) + ' '}</Text> : null}
                <Text>{p.percent}</Text>
                {form !== 'bare' && p.reset !== '' ? <Text dimColor>{' ↻ ' + p.reset}</Text> : null}
              </Box>
            )
          })}
        </Box>
        {hasRest ? <Text dimColor>{SEPARATOR}</Text> : null}
        {rest ?? null}
      </Box>
    )
  })

  // The hover card, in the band above the prompt, as context-meter draws its own: in the flow after
  // what the band holds (another plugin's card too), in a holder as wide as the band that pushes it
  // to the right end, hidden (no row) until this meter's hover group lights. A card floated out of
  // the flow is clipped by the band on the terminal. Drawn for `drawnAt`, so it redraws only when its
  // text changes. With nothing to show the band is left as it came.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [held, now, beneath] = await Promise.all([read($, reading), read($, drawnAt), next(e)])
    if (e.props.hasSurvey) return beneath
    const card = cardOf({ reading: held, now, origin }, language, e.props.bodyColumns)
    if (card === null) return beneath

    const { Box, Text } = $.ui.resolve(e)
    const toneProps = (tone: Tone) => (tone === 'plain' ? {} : tone === 'dim' ? { dimColor: true } : { color: tone })
    return (
      <Box flexDirection="column">
        {beneath}
        <Box
          width={e.props.bodyColumns} justifyContent="flex-end"
          display="none" hover={{ scope: SCOPE, display: 'flex' }}
        >
          <Box width={card.width} height={card.height} flexDirection="column" borderStyle="round" borderDimColor>
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
