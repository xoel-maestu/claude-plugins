import type { ContextMeterFill } from '../types'

import { split } from './fit'

export type Language = 'en' | 'es'

/** The card's width, border included, where the row has the room. */
export const CARD_WIDTH = 40
/** A border column and a padding column at each side. */
const FRAME = 4
const GAP = '   '

const WORDS = {
  en: { context: 'Context', compact: 'Autocompact at', none: 'No context figure yet.' },
  es: { context: 'Contexto', compact: 'Autocompacta en', none: 'Todavía no hay cifra de contexto.' },
} as const

/** `950`, `124.3k`, `200k`, `2.1M`: one decimal, a trailing `.0` dropped. */
export function tokens (n: number): string {
  const one = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  if (n >= 1_000_000) return `${one(n / 1_000_000)}M`
  if (n >= 1000) return `${one(n / 1000)}k`
  return String(Math.round(n))
}

/** How a piece of a row is drawn: in the meter's color, as the theme's text, or dim. */
export type Tone = 'meter' | 'plain' | 'dim'
export type Cell = { text: string; tone: Tone }
/** One row of the card: its pieces, left to right, together exactly as wide as the content. */
export type Row = Cell[]

/**
 * The hover card: its rows inside a rounded border, the width border included, the content width
 * and the height derived from the rows (one line each, and the two borders). A section is a row more.
 */
export type Card = { width: number; content: number; height: number; rows: Row[] }

/** A row cut or padded with spaces to `width` columns: one line, every cell written. */
function fitRow (row: Row, width: number): Row {
  const out: Row = []
  let left = width
  for (const cell of row) {
    if (left <= 0) break
    const text = cell.text.slice(0, left)
    out.push({ text, tone: cell.tone })
    left -= text.length
  }
  if (left > 0) out.push({ text: ' '.repeat(left), tone: 'plain' })
  return out
}

/** The card for `fill`, `width` columns wide border included (40, or less where the row is short). */
export function cardOf (fill: ContextMeterFill, compactAt: number | null, language: Language, width = CARD_WIDTH): Card | null {
  if (fill === null) return null
  const words = WORDS[language]
  const mark = fill.isEstimate ? '~' : ''
  const content = Math.max(1, Math.min(width, CARD_WIDTH) - FRAME)

  const figures: Row = [{ text: words.context, tone: 'plain' }]
  if (fill.tokens !== undefined) figures.push({ text: `${GAP}${mark}${tokens(fill.tokens)} / ${tokens(fill.window)}`, tone: 'meter' })
  figures.push({ text: `${GAP}${mark}${Math.round(fill.percent)}%`, tone: 'meter' })

  const bar = split(fill.percent, content)
  const rows: Row[] = [figures, [{ text: '━'.repeat(bar.filled), tone: 'meter' }, { text: '─'.repeat(bar.empty), tone: 'dim' }]]
  if (compactAt !== null) rows.push([{ text: `${words.compact} ~${tokens(compactAt)}`, tone: 'dim' }])

  const fitted = rows.map(row => fitRow(row, content))
  return { width: content + FRAME, content, height: fitted.length + 2, rows: fitted }
}

/** The card's rows as plain text, for /context-meter. */
export function cardText (fill: ContextMeterFill, compactAt: number | null, language: Language): string {
  const card = cardOf(fill, compactAt, language)
  if (card === null) return WORDS[language].none
  return card.rows.map(row => row.map(cell => cell.text).join('').trimEnd()).join('\n')
}
