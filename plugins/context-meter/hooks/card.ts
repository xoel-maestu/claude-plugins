import type { ContextMeterFill } from '../types'

import { FIVE_MINUTES, HISTORY, HOUR, statusOf } from './cache'
import type { Cache, Loss } from './cache'
import { split } from './fit'
import { hitRate } from './ledger'
import type { Counts, Ledger } from './ledger'

export type Language = 'en' | 'es'

/** The card's width, border included, without token rows; with them it widens to what they need. */
export const CARD_WIDTH = 40
/** How many losses the card shows; /context-meter prints the whole history. */
export const CARD_LOSSES = 5
/** A border column and a padding column at each side. */
const FRAME = 4
const GAP = '   '

/** The table's columns: Input is cache read, cache write and uncached together. */
type Column = 'input' | 'cacheRead' | 'cacheWrite' | 'uncached' | 'output'
/** The table's columns, widest first: Uncached goes first where the band is narrow, then Cache write. */
const LAYOUTS: Column[][] = [
  ['input', 'cacheRead', 'cacheWrite', 'uncached', 'output'],
  ['input', 'cacheRead', 'cacheWrite', 'output'],
  ['input', 'cacheRead', 'output'],
]

type Words = {
  context: string
  compact: string
  none: string
  last: string
  session: string
  hit: string
  hitText: string
  cost: string
  scope: string
  scopeShort: string
  columns: Record<Column, string>
  cache: string
  losses: string
  noLosses: string
  clearedAt: string
  active: (until: string, left: string, ttl: string) => string
  expired: (ago: string) => string
  noCache: string
  causes: Record<Exclude<Loss['cause'], 'expired'>, string> & { expired: (gap: string) => string }
  /** Where the full form does not fit: the expiry and the TTL, and each cause in a word or two. */
  activeShort: (until: string, ttl: string) => string
  causesShort: Record<Exclude<Loss['cause'], 'expired'>, string> & { expired: (gap: string) => string }
}

const WORDS: Record<Language, Words> = {
  en: {
    context: 'Context',
    compact: 'Autocompact at',
    none: 'No context figure yet.',
    last: 'Last request',
    session: 'Session',
    hit: 'Cache hit',
    hitText: 'of input read from cache',
    cost: 'Cost',
    scope: '(session, all agents)',
    scopeShort: '(all agents)',
    columns: { input: 'Input', cacheRead: 'Cache read', cacheWrite: 'Cache write', uncached: 'Uncached', output: 'Output' },
    cache: 'Cache',
    losses: 'Cache losses',
    noLosses: 'No cache losses this session',
    clearedAt: 'Cleared at',
    active: (until, left, ttl) => `active until ${until} (in ${left}, TTL ${ttl})`,
    expired: ago => `expired ${ago} ago`,
    noCache: 'no cache yet',
    causes: { compact: '/compact', model: 'model changed', expired: gap => `idle ${gap} > TTL`, invalidated: 'invalidated (prompt or tools changed)' },
    activeShort: (until, ttl) => `until ${until} (TTL ${ttl})`,
    causesShort: { compact: '/compact', model: 'model changed', expired: gap => `idle ${gap}`, invalidated: 'invalidated' },
  },
  es: {
    context: 'Contexto',
    compact: 'Autocompacta en',
    none: 'Todavía no hay cifra de contexto.',
    last: 'Última petición',
    session: 'Sesión',
    hit: 'Acierto de caché',
    hitText: 'de la entrada leída de caché',
    cost: 'Coste',
    scope: '(sesión, todos los agentes)',
    scopeShort: '(todos los agentes)',
    columns: { input: 'Entrada', cacheRead: 'Caché leída', cacheWrite: 'Caché escrita', uncached: 'Sin caché', output: 'Salida' },
    cache: 'Caché',
    losses: 'Pérdidas de caché',
    noLosses: 'Sin pérdidas de caché en esta sesión',
    clearedAt: 'Borrada a las',
    active: (until, left, ttl) => `activa hasta las ${until} (en ${left}, TTL ${ttl})`,
    expired: ago => `caducada hace ${ago}`,
    noCache: 'sin caché todavía',
    causes: { compact: '/compact', model: 'cambio de modelo', expired: gap => `inactiva ${gap} > TTL`, invalidated: 'invalidada (cambió el prompt o las herramientas)' },
    activeShort: (until, ttl) => `hasta las ${until} (TTL ${ttl})`,
    causesShort: { compact: '/compact', model: 'cambio de modelo', expired: gap => `inactiva ${gap}`, invalidated: 'invalidada' },
  },
}

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
/** A row while the card is laid out: its last cell may carry a shorter form for a narrow band. */
type Draft = (Cell & { short?: string })[]

/** The row as it fits `width`: whole, else with its last cell's short form, else without that cell. */
function shorten (row: Draft, width: number): Row {
  if (widthOfRow(row) <= width) return row
  const tail = row.at(-1)
  if (tail?.short === undefined) return row
  const short = [...row.slice(0, -1), { text: tail.short, tone: tail.tone }]
  return widthOfRow(short) <= width ? short : row.slice(0, -1)
}

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

/**
 * What the card shows: the fill, the autocompact point, the main thread's ledger, the session's cost
 * in USD, and the main thread's cache with its TTL in force and the time the countdown is drawn for.
 */
export type CardView = {
  fill: ContextMeterFill
  compactAt: number | null
  ledger?: Ledger
  cost?: number | null
  cache?: Cache
  ttl?: number
  now?: number
}

const widthOfRow = (row: Row) => row.reduce((sum, cell) => sum + cell.text.length, 0)
const pad2 = (n: number) => String(n).padStart(2, '0')

/** Input in all: cache read, cache write and uncached (the API's `input_tokens`). */
function valueOf (counts: Counts, column: Column): number {
  if (column === 'input') return counts.cacheRead + counts.cacheWrite + counts.input
  if (column === 'uncached') return counts.input
  return counts[column]
}

/** The label column: as wide as the longest label of the card's sections, and a gap. */
const labelWidthOf = (words: Words) =>
  Math.max(...[words.last, words.session, words.hit, words.cost, words.cache, words.losses].map(text => text.length)) + GAP.length

/**
 * The token table in `columns`: a dim header row, then the last request and the session, each figure
 * under its header, columns as wide as their widest cell.
 */
function tableRows (last: Counts, total: Counts, words: Words, columns: Column[], labelWidth: number): Row[] {
  const widths = columns.map(column =>
    Math.max(words.columns[column].length, tokens(valueOf(last, column)).length, tokens(valueOf(total, column)).length))
  const cells = (texts: string[], tone: Tone): Cell[] =>
    texts.map((text, i) => ({ text: i < texts.length - 1 ? text.padEnd(widths[i]!) + GAP : text, tone }))
  const figures = (counts: Counts) => columns.map(column => tokens(valueOf(counts, column)))
  return [
    [{ text: ' '.repeat(labelWidth), tone: 'plain' }, ...cells(columns.map(column => words.columns[column]), 'dim')],
    [{ text: words.last.padEnd(labelWidth), tone: 'plain' }, ...cells(figures(last), 'plain')],
    [{ text: words.session.padEnd(labelWidth), tone: 'plain' }, ...cells(figures(total), 'plain')],
  ]
}

/** `45s`, `7m`, `1h07m`: a pause or how long ago, rounded down. */
export function span (ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`
}

/** `14:05`, local time. */
export function clockTime (at: number): string {
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** `<1m`, `41m`, `1h07m`: whole minutes, rounded down, so the text changes once a minute. */
export function minutes (ms: number): string {
  return ms < 60_000 ? '<1m' : span(ms)
}

const ttlLabel = (ttl: number) => (ttl >= HOUR ? `${ttl / HOUR}h` : `${ttl / 60_000}m`)

/**
 * The cache line: active until the expiry time, with the whole minutes left and the TTL; expired and
 * how many minutes ago; or no cache yet. It changes at most once a minute.
 */
export function cacheStatus (cache: Cache, ttl: number, now: number, language: Language): string {
  const words = WORDS[language]
  const status = statusOf(cache, ttl, now)
  if (status.kind === 'active') return words.active(clockTime(cache.last!.at + ttl), minutes(status.left), ttlLabel(ttl))
  if (status.kind === 'expired') return words.expired(minutes(status.ago))
  return words.noCache
}

/**
 * The cache rows: its status, then the losses, newest first (at most `maxLosses`), after the /clear
 * marker when there is one; with no loss, a sentence saying so.
 */
function cacheRows (cache: Cache, ttl: number, now: number, words: Words, language: Language, labelWidth: number, maxLosses: number): Draft[] {
  const label = (text: string): Cell => ({ text: text.padEnd(labelWidth), tone: 'plain' })
  const status = statusOf(cache, ttl, now)
  const short = status.kind === 'active' ? words.activeShort(clockTime(cache.last!.at + ttl), ttlLabel(ttl)) : undefined
  const rows: Draft[] = [[label(words.cache), { text: cacheStatus(cache, ttl, now, language), tone: 'plain', short }]]
  const marker: Row | undefined = cache.clearedAt === undefined ? undefined
    : [{ text: `${words.clearedAt} ${clockTime(cache.clearedAt)}`, tone: 'dim' }]
  const losses = cache.losses.slice(0, maxLosses)
  if (losses.length === 0) {
    if (marker !== undefined) rows.push(marker)
    rows.push([{ text: words.noLosses, tone: 'plain' }])
    return rows
  }
  const lost = losses.map(loss => `−${tokens(loss.lost)}`)
  const lostWidth = Math.max(...lost.map(text => text.length))
  const lines: Draft[] = losses.map((loss, i) => [
    { text: `${clockTime(loss.at)}  `, tone: 'dim' },
    { text: `${lost[i]!.padEnd(lostWidth)}  `, tone: 'plain' },
    loss.cause === 'expired'
      ? { text: words.causes.expired(span(loss.gap)), tone: 'plain', short: words.causesShort.expired(span(loss.gap)) }
      : { text: words.causes[loss.cause], tone: 'plain', short: words.causesShort[loss.cause] },
  ])
  if (marker !== undefined) lines.unshift(marker)
  return [...rows, ...lines.map((line, i): Draft => [label(i === 0 ? words.losses : ''), ...line])]
}

/** The cost row: the whole session's cost, subagents included, with its scope said dim. */
function costRow (usd: number, words: Words, scope: string, labelWidth: number): Row {
  return [
    { text: words.cost.padEnd(labelWidth), tone: 'plain' },
    { text: `$${usd.toFixed(2)} `, tone: 'plain' },
    { text: scope, tone: 'dim' },
  ]
}

/**
 * The card for `view`, at most `width` columns wide border included. Without more rows it is 40
 * wide; with them it widens to what they need. The token table takes the widest of its layouts that
 * fits (all five columns, then without Uncached, then without Cache write too); where none fits the
 * table, the hit row and the cost row are left out, so no number is cut. The cost row (only for a
 * cost above zero: a subscription reports 0) takes its full or short scope, or is left out. The
 * cache rows come last, at most `maxLosses` losses, cut at the border where the band is short.
 * Null with no fill.
 */
export function cardOf (view: CardView, language: Language, width = Infinity, maxLosses = CARD_LOSSES): Card | null {
  const { fill, compactAt, ledger, cost = null, cache, ttl = FIVE_MINUTES, now = 0 } = view
  if (fill === null) return null
  const words = WORDS[language]
  const mark = fill.isEstimate ? '~' : ''
  const room = Math.max(1, width - FRAME)
  const labelWidth = labelWidthOf(words)

  const last = ledger?.last
  const table = last === undefined ? undefined : LAYOUTS
    .map(columns => tableRows(last, ledger!.total, words, columns, labelWidth))
    .find(rows => Math.max(...rows.map(widthOfRow)) <= room)
  const tokenRows: Row[] = table ?? []
  const hit = ledger === undefined ? null : hitRate(ledger.total)
  if (table !== undefined && hit !== null) {
    tokenRows.push([{ text: words.hit.padEnd(labelWidth), tone: 'plain' }, { text: `${Math.round(hit * 100)}% `, tone: 'plain' }, { text: words.hitText, tone: 'dim' }])
  }
  const hasCache = cache !== undefined && (cache.last !== undefined || cache.clearedAt !== undefined)
  const extra = hasCache ? cacheRows(cache!, ttl, now, words, language, labelWidth, maxLosses) : []
  const wanted = Math.max(0, ...tokenRows.map(widthOfRow), ...extra.map(widthOfRow))
  const content = Math.min(room, Math.max(CARD_WIDTH - FRAME, wanted))

  const figures: Row = [{ text: words.context, tone: 'plain' }]
  if (fill.tokens !== undefined) figures.push({ text: `${GAP}${mark}${tokens(fill.tokens)} / ${tokens(fill.window)}`, tone: 'meter' })
  figures.push({ text: `${GAP}${mark}${Math.round(fill.percent)}%`, tone: 'meter' })

  const bar = split(fill.percent, content)
  const rows: Row[] = [figures, [{ text: '━'.repeat(bar.filled), tone: 'meter' }, { text: '─'.repeat(bar.empty), tone: 'dim' }]]
  if (compactAt !== null) rows.push([{ text: `${words.compact} ~${tokens(compactAt)}`, tone: 'dim' }])
  rows.push(...tokenRows)
  if (table !== undefined && cost !== null && cost > 0) {
    const fits = [words.scope, words.scopeShort].map(scope => costRow(cost, words, scope, labelWidth)).find(row => widthOfRow(row) <= content)
    if (fits !== undefined) rows.push(fits)
  }
  rows.push(...extra.map(row => shorten(row, content)))

  const fitted = rows.map(row => fitRow(row, content))
  return { width: content + FRAME, content, height: fitted.length + 2, rows: fitted }
}

/** The card's rows as plain text, for /context-meter: at its widest, every loss of the history. */
export function cardText (view: CardView, language: Language): string {
  const card = cardOf(view, language, Infinity, HISTORY)
  if (card === null) return WORDS[language].none
  return card.rows.map(row => row.map(cell => cell.text).join('').trimEnd()).join('\n')
}
