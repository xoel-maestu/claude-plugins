import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, RenderViewport, SessionContextUsage, Timer } from 'claude-code'

import type { ContextMeterFill } from '../types'

import { cardOf, cardText } from './card'
import type { Language } from './card'
import { barOf, fit, label } from './fit'

const fill = atom({ plugin: 'context-meter', key: 'fill' } as const, null as ContextMeterFill)
const compactAt = atom({ plugin: 'context-meter', key: 'compactAt' } as const, null as number | null)

const SYNC_MS = 2000
const SEPARATOR = ' · '
// The terminal footer's row: 2 columns of padding at each end, 2 between the hint and what is drawn
// at the right, and the permission mode label at the left (`⏵⏵ accept edits on ·`, 20 columns).
const FOOTER = 4 + 2 + 20

// Transient, rebuilt by every load: the timer, one count at a time, the window the autocompact
// point was read for, and the hint line's width as last drawn on the terminal.
let timer: Timer | undefined
let isCounting = false
let countedWindow = 0
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

/** Columns a drawing takes on the row; a card placed out of the flow (absolute or hidden) takes none. */
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
 * point, read again when the window changes. `canCount` false only takes a figure.
 */
async function sync ($: EngineInterface, context: SessionContextUsage, canCount: boolean) {
  const hasFigure = context.percent !== undefined
  if (hasFigure) {
    await show($, { percent: context.percent!, tokens: context.tokens, window: context.window, isEstimate: false })
  }
  const current = await read($, fill)
  const needsEstimate = !hasFigure && current?.isEstimate !== true
  const needsCompactAt = countedWindow !== context.window
  if (!canCount || isCounting || !(needsEstimate || needsCompactAt)) return

  isCounting = true
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    countedWindow = context.window
    const threshold = breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold ?? null : null
    if ((await read($, compactAt)) !== threshold) await update($, compactAt, () => threshold)
    if (needsEstimate) {
      await show($, breakdown
        ? estimateOf(breakdown.totalTokens, context.window)
        : null)
    }
  } finally {
    isCounting = false
  }
}

/** The 2 s resync: the plain usage call is free and catches resumes and rewinds, which raise no measure. */
function startTimer ($: EngineInterface) {
  timer ??= $.clock.every(SYNC_MS, async () => { await sync($, (await $.session.usage()).context, true) })
}

export const register: Register = (on, options) => {
  const warnSetting = typeof options.warnAt === 'number' ? options.warnAt : 50
  const dangerSetting = typeof options.dangerAt === 'number' ? options.dangerAt : 75
  // Given the wrong way round the two are swapped, so the warning color still has its band.
  const warnAt = Math.min(warnSetting, dangerSetting)
  const dangerAt = Math.max(warnSetting, dangerSetting)
  const language: Language = options.language === 'es' ? 'es' : 'en'
  const colorFor = (percent: number) => (percent >= dangerAt ? 'error' : percent >= warnAt ? 'warning' : undefined)

  timer?.cancel()
  timer = undefined
  isCounting = false
  countedWindow = 0
  hintWidth = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-meter',
      description: language === 'es' ? 'Muestra el llenado de la ventana de contexto' : 'Show the context window fill',
    })
    // Counting would hold up the start: the first count waits for the first check.
    await sync($, (await $.session.usage()).context, false)
    startTimer($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // A /clear raises no session.start after it: the timer goes on and the next check estimates anew.
      await update($, fill, () => null)
    } else {
      timer?.cancel()
      timer = undefined
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    startTimer($)
    if (e.changed.includes('context')) await sync($, e.context, true)
    return next(e)
  })

  on('command.run', { command: 'context-meter' }, async $ => {
    await sync($, (await $.session.usage()).context, true)
    return { text: cardText(await read($, fill), await read($, compactAt), language) }
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
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [shown, threshold, beneath] = await Promise.all([read($, fill), read($, compactAt), next(e)])
    if (shown === null) return beneath

    const text = label(shown.percent, shown.isEstimate)
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)
    const room = roomOf(e) - (hasBeneath ? widthOfNode(beneath, e.props.modes) + SEPARATOR.length : 0)
    const form = fit(room, text)
    if (form === null) return beneath

    const { Box, Text } = $.ui.resolve(e)
    const color = colorFor(shown.percent)
    const isDim = color === undefined
    const bar = barOf(shown.percent, text)
    const card = cardOf(shown, threshold, language)
    const cardWidth = card === null ? 0 : card.bar.filled + card.bar.empty

    return (
      <Box flexDirection="row">
        <Box key="context-meter" flexDirection="row">
          {form !== 'bare' ? <Text dimColor>ctx </Text> : null}
          {form === 'bar' ? <Text color={color} dimColor={isDim}>{'━'.repeat(bar.filled)}</Text> : null}
          {form === 'bar' ? <Text dimColor>{'─'.repeat(bar.empty) + ' '}</Text> : null}
          <Text color={color} dimColor={isDim}>{text}</Text>
          {card === null ? null : (
            // The card: over the rows above the meter, its right edge on the meter's, shown while hovered.
            <Box position="absolute" top={-2} right={0} width={cardWidth} flexDirection="column" display="none" hover={{ display: 'flex' }}>
              <Text>{card.line.padEnd(cardWidth)}</Text>
              <Box flexDirection="row">
                <Text color={color} dimColor={isDim}>{'━'.repeat(card.bar.filled)}</Text>
                <Text dimColor>{'─'.repeat(card.bar.empty)}</Text>
              </Box>
            </Box>
          )}
        </Box>
        {hasBeneath ? <Text dimColor>{SEPARATOR}</Text> : null}
        {beneath}
      </Box>
    )
  })
}
