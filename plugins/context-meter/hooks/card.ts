import type { ContextMeterFill } from '../types'

import { split } from './fit'
import { hitRate } from './ledger'
import type { Counts, Ledger } from './ledger'

export type Language = 'en' | 'es'

/** The card's width, border included, without token rows; with them it widens to what they need. */
export const CARD_WIDTH = 40
/** A border column and a padding column at each side. */
const FRAME = 4
const GAP = '   '

/** Names of the token rows and counts: in full, and short for a narrow band. */
type Names = { last: string; session: string; hit: string; cost: string; scope: string; input: string; cacheRead: string; cacheWrite: string; output: string }

const WORDS = {
  en: {
    context: 'Context',
    compact: 'Autocompact at',
    none: 'No context figure yet.',
    full: { last: 'Last request', session: 'Session', hit: 'Cache hit', cost: 'Cost', scope: '(session, all agents)', input: 'in', cacheRead: 'cache read', cacheWrite: 'cache write', output: 'out' },
    short: { last: 'Last', session: 'Session', hit: 'Cache hit', cost: 'Cost', scope: '(all agents)', input: 'in', cacheRead: 'c.read', cacheWrite: 'c.write', output: 'out' },
  },
  es: {
    context: 'Contexto',
    compact: 'Autocompacta en',
    none: 'Todavía no hay cifra de contexto.',
    full: { last: 'Última petición', session: 'Sesión', hit: 'Acierto de caché', cost: 'Coste', scope: '(sesión, todos los agentes)', input: 'entrada', cacheRead: 'caché leída', cacheWrite: 'caché escrita', output: 'salida' },
    short: { last: 'Última', session: 'Sesión', hit: 'Acierto', cost: 'Coste', scope: '(todos los agentes)', input: 'ent.', cacheRead: 'c.leída', cacheWrite: 'c.escrita', output: 'sal.' },
  },
} as const satisfies Record<string, { full: Names; short: Names } & Record<string, unknown>>

/** `950`, `124.3k`, `200k`, `2.1M`: one decimal, a trailing `.0` dropped. */
export function tokens (n: number): string {
  const one = (value: number) => value.toFixed(1).replace(/\.0$/, '')
  // From what rounds to a thousand k, so 999,960 reads 1M and not 1000k.
  if (n >= 999_950) return `${one(n / 1_000_000)}M`
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

/** What the card shows: the fill, the autocompact point, the main thread's ledger and the session's cost in USD. */
export type CardView = {
  fill: ContextMeterFill
  compactAt: number | null
  ledger?: Ledger
  cost?: number | null
}

const COUNTS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
type Count = typeof COUNTS[number]
/** The counts on one line: all four, or split in two (in and out, then the cache). */
const ONE_LINE: Count[][] = [['input', 'cacheRead', 'cacheWrite', 'output']]
const TWO_LINES: Count[][] = [['input', 'output'], ['cacheRead', 'cacheWrite']]

const widthOfRow = (row: Row) => row.reduce((sum, cell) => sum + cell.text.length, 0)

/**
 * The Last request and Session rows, aligned in columns, and the cache hit row: one form of them.
 * Each count is its dim name and its plain figure.
 */
function tokenRows (last: Counts, total: Counts, names: Names, groups: Count[][]): Row[] {
  const hit = hitRate(total)
  const labelWidth = labelWidthOf(names, hit !== null)
  const field = (counts: Counts, count: Count) => `${names[count]} ${tokens(counts[count])}`
  const rowsOf = (label: string, counts: Counts): Row[] => groups.map((group, g) => {
    const row: Row = [{ text: (g === 0 ? label : '').padEnd(labelWidth), tone: 'plain' }]
    group.forEach((count, i) => {
      // Padded to the widest of the column, so the two rows' counts line up.
      const width = Math.max(field(last, count).length, field(total, count).length)
      const pad = i < group.length - 1 ? ' '.repeat(width - field(counts, count).length) + GAP : ''
      row.push({ text: `${names[count]} `, tone: 'dim' }, { text: tokens(counts[count]) + pad, tone: 'plain' })
    })
    return row
  })
  const rows = [...rowsOf(names.last, last), ...rowsOf(names.session, total)]
  if (hit !== null) rows.push([{ text: names.hit.padEnd(labelWidth), tone: 'plain' }, { text: `${Math.round(hit * 100)}%`, tone: 'plain' }])
  return rows
}

const labelWidthOf = (names: Names, hasHit: boolean) =>
  Math.max(names.last.length, names.session.length, names.cost.length, hasHit ? names.hit.length : 0) + GAP.length

/** The cost row: the whole session's cost, subagents included, with its scope said dim. */
function costRow (usd: number, names: Names, scope: string, hasHit: boolean): Row {
  return [
    { text: names.cost.padEnd(labelWidthOf(names, hasHit)), tone: 'plain' },
    { text: `$${usd.toFixed(2)} `, tone: 'plain' },
    { text: scope, tone: 'dim' },
  ]
}

/**
 * The card for `view`, at most `width` columns wide border included. Without token rows it is 40
 * wide; with them, as wide as their widest form that fits, from one line each in full to two lines
 * each with short names; where even that does not fit, the token rows are left out. The cost row
 * (only for a cost above zero: a subscription reports 0) takes its full or short scope, or is left
 * out where neither fits. Null with no fill.
 */
export function cardOf (view: CardView, language: Language, width = Infinity): Card | null {
  const { fill, compactAt, ledger, cost = null } = view
  if (fill === null) return null
  const words = WORDS[language]
  const mark = fill.isEstimate ? '~' : ''
  const room = Math.max(1, width - FRAME)

  const last = ledger?.last
  const forms: [Names, Row[]][] = last === undefined ? [] : [
    [words.full, tokenRows(last, ledger!.total, words.full, ONE_LINE)],
    [words.short, tokenRows(last, ledger!.total, words.short, ONE_LINE)],
    [words.full, tokenRows(last, ledger!.total, words.full, TWO_LINES)],
    [words.short, tokenRows(last, ledger!.total, words.short, TWO_LINES)],
  ]
  const formWidth = (form: Row[]) => Math.max(...form.map(widthOfRow))
  const chosen = forms.find(([, form]) => formWidth(form) <= room)
  const tokenForm = chosen?.[1] ?? []
  const content = Math.min(room, Math.max(CARD_WIDTH - FRAME, tokenForm.length > 0 ? formWidth(tokenForm) : 0))

  const figures: Row = [{ text: words.context, tone: 'plain' }]
  if (fill.tokens !== undefined) figures.push({ text: `${GAP}${mark}${tokens(fill.tokens)} / ${tokens(fill.window)}`, tone: 'meter' })
  figures.push({ text: `${GAP}${mark}${Math.round(fill.percent)}%`, tone: 'meter' })

  const bar = split(fill.percent, content)
  const rows: Row[] = [figures, [{ text: '━'.repeat(bar.filled), tone: 'meter' }, { text: '─'.repeat(bar.empty), tone: 'dim' }]]
  if (compactAt !== null) rows.push([{ text: `${words.compact} ~${tokens(compactAt)}`, tone: 'dim' }])
  rows.push(...tokenForm)
  if (chosen !== undefined && cost !== null && cost > 0) {
    const hasHit = hitRate(ledger!.total) !== null
    const fits = [words.full.scope, words.short.scope].map(scope => costRow(cost, chosen[0], scope, hasHit)).find(row => widthOfRow(row) <= content)
    if (fits !== undefined) rows.push(fits)
  }

  const fitted = rows.map(row => fitRow(row, content))
  return { width: content + FRAME, content, height: fitted.length + 2, rows: fitted }
}

/** The card's rows as plain text, for /context-meter: at its widest, the token rows in full. */
export function cardText (view: CardView, language: Language): string {
  const card = cardOf(view, language)
  if (card === null) return WORDS[language].none
  return card.rows.map(row => row.map(cell => cell.text).join('').trimEnd()).join('\n')
}
