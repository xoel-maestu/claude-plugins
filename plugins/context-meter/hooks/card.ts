import type { ContextMeterFill } from '../types'

import { split } from './fit'

export type Language = 'en' | 'es'

const MIN_BAR = 30

const WORDS = {
  en: { context: 'Context', compact: 'autocompact at', none: 'No context figure yet.' },
  es: { context: 'Contexto', compact: 'autocompacta en', none: 'Todavía no hay cifra de contexto.' },
} as const

/** `950`, `124.3k`, `200k`, `2.1M`: one decimal, a trailing `.0` dropped. */
export function tokens (n: number): string {
  const one = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  if (n >= 1_000_000) return `${one(n / 1_000_000)}M`
  if (n >= 1000) return `${one(n / 1000)}k`
  return String(Math.round(n))
}

export type Card = { line: string; percent: number; bar: { filled: number; empty: number } }

/** The hover card: one line of figures and a bar as wide as the line (30 cells at least). */
export function cardOf (fill: ContextMeterFill, compactAt: number | null, language: Language): Card | null {
  if (fill === null) return null
  const words = WORDS[language]
  const mark = fill.isEstimate ? '~' : ''
  const parts: string[] = [words.context]
  if (fill.tokens !== undefined) parts.push(`${mark}${tokens(fill.tokens)} / ${tokens(fill.window)}`)
  parts.push(`${mark}${Math.round(fill.percent)}%`)
  let line = parts.join('  ')
  if (compactAt !== null) line += `   ${words.compact} ~${tokens(compactAt)}`
  return { line, percent: fill.percent, bar: split(fill.percent, Math.max(MIN_BAR, line.length)) }
}

/** The card as plain text, for /context-meter. */
export function cardText (fill: ContextMeterFill, compactAt: number | null, language: Language): string {
  const card = cardOf(fill, compactAt, language)
  if (card === null) return WORDS[language].none
  return `${card.line}\n${'━'.repeat(card.bar.filled)}${'─'.repeat(card.bar.empty)}`
}
