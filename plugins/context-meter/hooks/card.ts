import type { ContextMeterFill, ContextMeterTtl as Ttl } from '../types'

import { KEPT, childrenOf, descendantsOf, modelName, sumOf, totalOf } from './agents'
import type { Agent, Agents } from './agents'
import { FIVE_MINUTES, HISTORY, HOUR, statusOf } from './cache'
import type { Cache, Loss } from './cache'
import { split } from './fit'
import { hitRate } from './ledger'
import type { Counts, Ledger, Models } from './ledger'
import { plusModels } from './ledger'
import { costAt, savedAt } from './pricing'
import { trendOf } from './trend'

export type Language = 'en' | 'es'

/** The card's width, border included, without token rows; with them it widens to what they need. */
export const CARD_WIDTH = 40
/** How many losses the card shows; /context-meter prints the whole history. */
export const CARD_LOSSES = 5
/** How many subagents the card lists, most recently active first; /context-meter lists every kept one. */
export const CARD_AGENTS = 5
/** An agent's label longer than this is cut, with `…`: it is a name, not a figure. */
const AGENT_LABEL = 24
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

/** The subagents table's columns: the token table's, then Cache hit (the share of input read from cache) and Model. */
type AgentColumn = 'requests' | Column | 'hit' | 'model' | 'cost'
/** Widest first, dropping as the token table does: Model, Uncached, Cache write, Output, Requests, Cache read. */
const AGENT_LAYOUTS: AgentColumn[][] = [
  ['requests', 'input', 'cacheRead', 'cacheWrite', 'uncached', 'output', 'hit', 'model'],
  ['requests', 'input', 'cacheRead', 'cacheWrite', 'uncached', 'output', 'hit'],
  ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'hit'],
  ['requests', 'input', 'cacheRead', 'output', 'hit'],
  ['requests', 'input', 'cacheRead', 'hit'],
  ['input', 'cacheRead', 'hit'],
  ['input', 'hit'],
]

type Words = {
  context: string
  compact: string
  none: string
  last: string
  session: string
  hit: string
  hitText: string
  lastHit: string
  modelSwitch: string
  saved: string
  savedShare: (percent: number) => string
  savedMore: (percent: number) => string
  cost: string
  /** After the amount: on a subscription it is not billed, otherwise it is an estimate. */
  costTail: Record<'subscription' | 'list' | 'agent', { full: string; short: string }>
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
  agents: (count: number) => string
  agentColumns: Record<AgentColumn, string>
  allAgents: string
  /** The loop and every agent under it: the main thread's card, an agent's. */
  overall: { main: string; agent: string }
  models: string
  mainCrumb: string
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
    lastHit: 'last request',
    modelSwitch: 'model switch',
    saved: 'Cache saved',
    savedShare: percent => `(${percent}% less than without the cache)`,
    savedMore: percent => `(${percent}% more than without the cache)`,
    cost: 'Cost',
    costTail: {
      subscription: { full: 'at API list prices (not billed on your plan)', short: '(not billed)' },
      list: { full: 'at list prices (session, all agents)', short: '(estimate)' },
      agent: { full: 'at API list prices, from its token counts', short: '(estimate)' },
    },
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
    agents: count => `Agents (${count})`,
    agentColumns: { requests: 'Requests', input: 'Input', cacheRead: 'Cache read', cacheWrite: 'Cache write', uncached: 'Uncached', output: 'Output', hit: 'Cache hit', model: 'Model', cost: 'Cost' },
    allAgents: 'Subagents total',
    overall: { main: 'Main + subagents', agent: 'This agent + subagents' },
    models: 'Models',
    mainCrumb: 'Main',
  },
  es: {
    context: 'Contexto',
    compact: 'Autocompacta en',
    none: 'Todavía no hay cifra de contexto.',
    last: 'Última petición',
    session: 'Sesión',
    hit: 'Acierto de caché',
    hitText: 'de la entrada leída de caché',
    lastHit: 'última petición',
    modelSwitch: 'cambio de modelo',
    saved: 'Ahorro de caché',
    savedShare: percent => `(un ${percent}% menos que sin caché)`,
    savedMore: percent => `(un ${percent}% más que sin caché)`,
    cost: 'Coste',
    costTail: {
      subscription: { full: 'a precio de lista de la API (no se factura en tu plan)', short: '(no se factura)' },
      list: { full: 'a precio de lista (sesión, todos los agentes)', short: '(estimación)' },
      agent: { full: 'a precio de lista de la API, según sus tokens', short: '(estimación)' },
    },
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
    agents: count => `Agentes (${count})`,
    agentColumns: { requests: 'Peticiones', input: 'Entrada', cacheRead: 'Caché leída', cacheWrite: 'Caché escrita', uncached: 'Sin caché', output: 'Salida', hit: 'Acierto', model: 'Modelo', cost: 'Coste' },
    allAgents: 'Total subagentes',
    overall: { main: 'Principal + subagentes', agent: 'Este agente + subagentes' },
    models: 'Modelos',
    mainCrumb: 'Principal',
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

/**
 * How a piece of a row is drawn: in the meter's color (warning, error; the theme's text below them),
 * as the bar (the meter's color, the theme's `claude` below them), as the theme's text, or dim.
 */
export type Tone = 'meter' | 'bar' | 'plain' | 'dim'
/** `press`: the cell is a button; `main` shows the main thread, `agent:<id>` that agent. */
export type Cell = { text: string; tone: Tone; press?: string }
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
/** `depth`: 0 for the main thread's card, 1 for a subagent's, 2 for its subagent's, and so on. */
export type Card = { width: number; content: number; height: number; rows: Row[]; depth: number }

/** A row cut or padded with spaces to `width` columns: one line, every cell written. */
function fitRow (row: Row, width: number): Row {
  const out: Row = []
  let left = width
  for (const cell of row) {
    if (left <= 0) break
    const text = cell.text.slice(0, left)
    out.push({ ...cell, text })
    left -= text.length
  }
  if (left > 0) out.push({ text: ' '.repeat(left), tone: 'plain' })
  return out
}

/**
 * What the card shows: the fill, the autocompact point, the main thread's ledger, the session's cost
 * in USD, and the main thread's cache with its TTL in force (`isTtlInferred` when guessed, not set
 * or observed) and the time the countdown is drawn for.
 */
export type CardView = {
  fill: ContextMeterFill
  compactAt: number | null
  ledger?: Ledger
  cost?: number | null
  cache?: Cache
  ttl?: number
  isTtlInferred?: boolean
  now?: number
  agents?: Agents
  /** The `cacheTtl` setting: an explicit TTL prices every write. */
  ttlSetting?: 'auto' | Ttl
  /**
   * The agent the card shows instead of the main thread: the agents from the main thread's child
   * down to it (it last), its cache's TTL in force and its model's context window.
   */
  selected?: { path: Agent[]; ttl: number; isTtlInferred: boolean; window: number | null; isWindowInferred?: boolean }
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
  Math.max(...[words.last, words.session, words.hit, words.cost, words.saved, words.cache, words.losses].map(text => text.length)) + GAP.length

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

/** `1h`, `5m`; with `?` when inferred rather than set or observed. */
const ttlLabel = (ttl: number, isInferred = false) =>
  (ttl >= HOUR ? `${ttl / HOUR}h` : `${ttl / 60_000}m`) + (isInferred ? '?' : '')

/**
 * The cache line: active until the expiry time, with the whole minutes left and the TTL; expired and
 * how many minutes ago; or no cache yet. It changes at most once a minute.
 */
export function cacheStatus (cache: Cache, ttl: number, now: number, language: Language, isTtlInferred = false): string {
  const words = WORDS[language]
  const status = statusOf(cache, ttl, now)
  if (status.kind === 'active') return words.active(clockTime(cache.last!.at + ttl), minutes(status.left), ttlLabel(ttl, isTtlInferred))
  if (status.kind === 'expired') return words.expired(minutes(status.ago))
  return words.noCache
}

/**
 * The cache rows: its status, then the losses, newest first (at most `maxLosses`), after the /clear
 * marker when there is one; with no loss, a sentence saying so.
 */
function cacheRows (cache: Cache, ttl: number, isTtlInferred: boolean, now: number, words: Words, language: Language, labelWidth: number, maxLosses: number): Draft[] {
  const label = (text: string): Cell => ({ text: text.padEnd(labelWidth), tone: 'plain' })
  const status = statusOf(cache, ttl, now)
  const short = status.kind === 'active' ? words.activeShort(clockTime(cache.last!.at + ttl), ttlLabel(ttl, isTtlInferred)) : undefined
  const rows: Draft[] = [[label(words.cache), { text: cacheStatus(cache, ttl, now, language, isTtlInferred), tone: 'plain', short }]]
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
  // What getting each back cost, in a column before the cause: written again instead of read.
  const costs = losses.map(loss => (typeof loss.cost !== 'object' || loss.cost === null ? '' : `≈ ${usdText(ttl >= HOUR ? loss.cost.write1h : loss.cost.write5m)}`))
  const costWidth = Math.max(0, ...costs.map(text => text.length))
  const lines: Draft[] = losses.map((loss, i) => [
    { text: `${clockTime(loss.at)}  `, tone: 'dim' },
    { text: `${lost[i]!.padEnd(lostWidth)}  `, tone: 'plain' },
    ...(costWidth === 0 ? [] : [{ text: `${costs[i]!.padEnd(costWidth)}  `, tone: 'plain' as const }]),
    loss.cause === 'expired'
      ? { text: words.causes.expired(span(loss.gap)), tone: 'plain', short: words.causesShort.expired(span(loss.gap)) }
      : { text: words.causes[loss.cause], tone: 'plain', short: words.causesShort[loss.cause] },
  ])
  if (marker !== undefined) lines.unshift(marker)
  return [...rows, ...lines.map((line, i): Draft => [label(i === 0 ? words.losses : ''), ...line])]
}

const plusCounts = (a: Counts, b: Counts): Counts =>
  ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })

const hitText = (counts: Counts) => {
  const hit = hitRate(counts)
  return hit === null ? '–' : `${Math.round(hit * 100)}%`
}

const cut = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, width - 1)}…`)

/**
 * A loop's subagents section: a header (`Agents (n)`, every agent the loop spawned) over the
 * columns, a row per agent it spawned (at most `maxAgents`, most recently active first), the total
 * over every agent under it at any depth, and Overall: the loop and those agents together. In the widest of the layouts that
 * fits `room`; none where none fits.
 */
type Section = {
  /** The loop's own agents, newest first, and how many it spawned in all. */
  children: Agent[]
  count: number
  /** Every agent under the loop, summed, and their requests. */
  total: Counts
  requests: number
  /** The loop's own counts and requests: with `total`, Overall. */
  self: Counts
  selfRequests: number
  /** The main thread's section, not an agent's. */
  isMain: boolean
}

type Line = { label: string; press?: string; values: Partial<Record<AgentColumn, string>> }

const valuesOf = (counts: Counts, requests: number, model?: string): Line['values'] => ({
  requests: String(requests),
  input: tokens(valueOf(counts, 'input')),
  cacheRead: tokens(counts.cacheRead),
  cacheWrite: tokens(counts.cacheWrite),
  uncached: tokens(counts.input),
  output: tokens(counts.output),
  hit: hitText(counts),
  ...(model === undefined ? {} : { model: modelName(model) }),
})

/**
 * A section's table: a header (`title` over the column names) and its lines, in the widest of
 * `layouts` that fits `room`; none where none fits.
 */
function tableSection (title: string, lines: Line[], words: Words, room: number, labelWidth: number, layouts: AgentColumn[][]): Row[] {
  const width = Math.max(labelWidth, ...[title, ...lines.map(line => line.label)].map(text => text.length + GAP.length))
  for (const columns of layouts) {
    const widths = columns.map(column => Math.max(words.agentColumns[column].length, ...lines.map(line => (line.values[column] ?? '').length)))
    const cells = (texts: string[], tone: Tone): Cell[] =>
      texts.map((text, i) => ({ text: i < texts.length - 1 ? text.padEnd(widths[i]!) + GAP : text, tone }))
    const rows: Row[] = [
      [{ text: title.padEnd(width), tone: 'plain' }, ...cells(columns.map(column => words.agentColumns[column]), 'dim')],
      ...lines.map((line): Row => [
        // A pressable label is a button of its own text; the padding after it is not.
        ...(line.press === undefined
          ? [{ text: line.label.padEnd(width), tone: 'plain' as const }]
          : [{ text: line.label, tone: 'plain' as const, press: line.press }, { text: ' '.repeat(width - line.label.length), tone: 'plain' as const }]),
        ...cells(columns.map(column => line.values[column] ?? ''), 'plain'),
      ]),
    ]
    const trimmed = rows.map(row => {
      // A row's blank trailing cells (the totals have no model) are not drawn.
      const out = [...row]
      while (out.length > 1 && out.at(-1)!.text.trim() === '') out.pop()
      const tail = out.at(-1)!
      out[out.length - 1] = { ...tail, text: tail.text.trimEnd() }
      return out
    })
    if (Math.max(...trimmed.map(widthOfRow)) <= room) return trimmed
  }
  return []
}

function agentRows (section: Section, words: Words, room: number, labelWidth: number, maxAgents: number): Row[] {
  const shown = section.children.slice(0, maxAgents)
  const lines: Line[] = [
    ...shown.map(agent => ({ label: cut(agent.label, AGENT_LABEL), press: `agent:${agent.id}`, values: valuesOf(agent, agent.requests, agent.model) })),
    { label: words.allAgents, values: valuesOf(section.total, section.requests) },
    { label: section.isMain ? words.overall.main : words.overall.agent, values: valuesOf(plusCounts(section.total, section.self), section.requests + section.selfRequests) },
  ]
  return tableSection(words.agents(section.count), lines, words, room, labelWidth, AGENT_LAYOUTS)
}

/** The models table's layouts, widest first: the row is the model; Cost stays to the last but one. */
const MODEL_LAYOUTS: AgentColumn[][] = [
  ['requests', 'input', 'cacheRead', 'cacheWrite', 'uncached', 'output', 'hit', 'cost'],
  ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'hit', 'cost'],
  ['requests', 'input', 'cacheRead', 'output', 'hit', 'cost'],
  ['requests', 'input', 'cacheRead', 'hit', 'cost'],
  ['input', 'cacheRead', 'hit', 'cost'],
  ['input', 'hit', 'cost'],
  ['input', 'hit'],
]

/** `a` less `b`, by model: a row with no request left goes. Costs subtract part by part. */
function minusModels (a: Models, b: Models): Models {
  const out: Models = {}
  for (const [model, row] of Object.entries(a)) {
    const less = b[model]
    if (less === undefined) { out[model] = row; continue }
    const requests = row.requests - less.requests
    if (requests <= 0) continue
    const cost = row.cost === undefined || less.cost === undefined ? undefined : {
      base: row.cost.base - less.cost.base,
      write5m: row.cost.write5m - less.cost.write5m,
      write1h: row.cost.write1h - less.cost.write1h,
      ...(row.cost.output === undefined || less.cost.output === undefined ? {} : { output: row.cost.output - less.cost.output }),
      ...(row.cost.plain === undefined || less.cost.plain === undefined ? {} : { plain: row.cost.plain - less.cost.plain }),
    }
    out[model] = {
      input: row.input - less.input, output: row.output - less.output, cacheRead: row.cacheRead - less.cacheRead,
      cacheWrite: row.cacheWrite - less.cacheWrite, requests, ...(cost === undefined ? {} : { cost }),
      ...(row.isUnpriced === true ? { isUnpriced: true } : {}),
    }
  }
  return out
}

/** Tallies by model and the TTL their cache writes are priced at. */
type ModelSource = { models: Models; ttl: Ttl }

/**
 * A loop's models section: a row per model that answered in it or under it, the most requests
 * first, with the same columns as the agents table and the cost at list prices (each source's
 * writes at its TTL; `≥` when a request's model is not in the price table). Only where more than
 * one model answered.
 */
function modelRows (sources: ModelSource[], words: Words, room: number, labelWidth: number): Row[] {
  // Ids of one model (with and without a date) are one row, under the name the card shows.
  const byName: Models = {}
  const dollars = new Map<string, number>()
  for (const { models, ttl } of sources) {
    for (const [model, row] of Object.entries(models)) {
      const name = modelName(model)
      Object.assign(byName, plusModels(byName, { [name]: row }))
      dollars.set(name, (dollars.get(name) ?? 0) + costAt(row.cost ?? { base: 0, write5m: 0, write1h: 0 }, ttl))
    }
  }
  const entries = Object.entries(byName).sort(([a, x], [b, y]) => y.requests - x.requests || a.localeCompare(b))
  if (entries.length < 2) return []
  const lines = entries.map(([name, row]): Line => ({
    label: name,
    // A model the price table lacks: no cost of its own (`–`), else `≥` what the priced requests cost.
    values: { ...valuesOf(row, row.requests), cost: (dollars.get(name) ?? 0) === 0 && row.isUnpriced === true ? '–' : `${row.isUnpriced === true ? '≥' : ''}${usdText(dollars.get(name) ?? 0)}` },
  }))
  return tableSection(words.models, lines, words, room, labelWidth, MODEL_LAYOUTS)
}

/**
 * `$4.12` from a dollar; under it four decimals, as `/cost` prints them (`$0.1707`, `$0.0059`);
 * under a hundredth of a cent from the first significant digit (`$0.00004`).
 */
export function usdText (usd: number): string {
  if (!(usd > 0)) return '$0'
  // Rounded first, so an amount that rounds up (0.99999) reads in the wider form.
  if (Number(usd.toFixed(2)) >= 1) return `$${usd.toFixed(2)}`
  if (Number(usd.toFixed(4)) >= 0.0001) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(Math.max(5, -Math.floor(Math.log10(usd))))}`
}

/**
 * The cost row: the whole session's cost at list prices, subagents included, then dim what it is
 * (not billed on a subscription, an estimate otherwise), in full or short where narrow, or left out.
 */
function costRow (usd: number, isSubscription: boolean, words: Words, labelWidth: number, isAgent = false, isLowerBound = false): Draft {
  const tail = words.costTail[isSubscription ? 'subscription' : isAgent ? 'agent' : 'list']
  return [
    { text: words.cost.padEnd(labelWidth), tone: 'plain' },
    // `≥`: some requests were of a model the price table lacks.
    { text: `${isLowerBound ? '≥' : '≈'} ${usdText(usd)}`, tone: 'plain' },
    { text: ` ${tail.full}`, tone: 'dim', short: ` ${tail.short}` },
  ]
}

/**
 * The card for `view`, at most `width` columns wide border included. Without more rows it is 40
 * wide; with them it widens to what they need. The token table takes the widest of its layouts that
 * fits (all five columns, then without Uncached, then without Cache write too); where none fits the
 * table, the hit row and the cost row are left out, so no number is cut. The cost row (only for a
 * cost above zero) widens the card to its full form where it can, else takes its short tail, else
 * shows the amount alone. The cache rows come last, at most `maxLosses` losses, cut at the border
 * where the band is short. Null with no fill.
 */
export function cardOf (view: CardView, language: Language, width = Infinity, maxLosses = CARD_LOSSES, maxAgents = CARD_AGENTS): Card | null {
  const { agents, selected, now = 0 } = view
  if (view.fill === null) return null
  // An agent shown: its own rows where the main thread's go, its context over its model's window,
  // no autocompact point (the host gives none for an agent).
  const agent = selected?.path.at(-1)
  const fill: NonNullable<ContextMeterFill> = agent === undefined ? view.fill : (() => {
    const used = agent.last.input + agent.last.cacheRead + agent.last.cacheWrite
    const window = selected!.window ?? view.fill.window
    return { tokens: used, window, percent: Math.min(100, (used / window) * 100), isEstimate: false }
  })()
  const compactAt = agent === undefined ? view.compactAt : null
  const ledger: Ledger | undefined = agent === undefined ? view.ledger
    : { last: { ...agent.last, model: agent.model, at: agent.at }, total: totalOf(agent), requests: agent.requests }
  const cache = agent === undefined ? view.cache : agent.cache
  const ttl = selected?.ttl ?? view.ttl ?? FIVE_MINUTES
  const isTtlInferred = selected?.isTtlInferred ?? view.isTtlInferred ?? false
  const cost = agent === undefined ? view.cost ?? null : costAt(agent.cost, ttl >= HOUR ? '1h' : '5m')
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
  // The session's hit rate, then the last request's against the one before it (`↑4`, `↓28`, `=`),
  // shortened where the band is narrow, else left out.
  let hitRow: Draft | undefined
  if (table !== undefined && hit !== null) {
    hitRow = [{ text: words.hit.padEnd(labelWidth), tone: 'plain' }, { text: `${Math.round(hit * 100)}% `, tone: 'plain' }, { text: words.hitText, tone: 'dim' }]
    const trend = trendOf(last!, agent === undefined ? ledger!.previous : agent.previous)
    // With no request before it to compare with, the last one adds nothing to the session's rate.
    if (trend !== null) {
      const change = trend.kind === 'steady' ? (trend.delta > 0 ? ` ↑${trend.delta}` : trend.delta < 0 ? ` ↓${-trend.delta}` : ' =') : ''
      const full = `${words.lastHit} ${trend.percent}%${trend.kind === 'switch' ? ` (${words.modelSwitch})` : change}`
      hitRow.push({ text: ` · ${full}`, tone: 'plain', short: ` · ${trend.percent}%${change}` })
    }
  }
  const hasCache = cache !== undefined && (cache.last !== undefined || cache.clearedAt !== undefined)
  const extra = hasCache ? cacheRows(cache!, ttl, isTtlInferred, now, words, language, labelWidth, maxLosses) : []
  const costDraft = table !== undefined && cost !== null && Number.isFinite(cost) && cost > 0
    ? costRow(cost, (agent === undefined ? cache : view.cache)?.isSubscription === true, words, labelWidth, agent !== undefined, agent?.isUnpriced === true)
    : undefined
  const children = agents === undefined ? [] : childrenOf(agents, agent?.id)
  const below = agents === undefined ? [] : descendantsOf(agents, agent?.id)
  // The main thread's totals cover agents past the kept rows too; an agent's, the rows under it.
  const section: Section | undefined = agents === undefined || children.length === 0 ? undefined : {
    children,
    count: agent === undefined ? agents.count - agents.agents.filter(row => row.parentId !== undefined).length : children.length,
    total: agent === undefined ? agents.total : sumOf(below),
    requests: agent === undefined ? agents.requests : below.reduce((sum, row) => sum + row.requests, 0),
    self: ledger?.total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    selfRequests: ledger?.requests ?? 0,
    isMain: agent === undefined,
  }
  const agentSection = section === undefined ? [] : agentRows(section, words, room, labelWidth, maxAgents)
  // Every model that answered in this loop or under it: the main thread's agents' from their
  // session-wide tally (past the kept rows), an agent's from the rows under it.
  // Each source's writes are priced at its own TTL: the loop's, each agent's under it (the main
  // thread's agents past the kept rows at the TTL agents were last seen writing).
  const ttlKey = (ms: number): Ttl => (ms >= HOUR ? '1h' : '5m')
  const agentTtl = (row: Agent): Ttl => view.ttlSetting !== undefined && view.ttlSetting !== 'auto' ? view.ttlSetting
    : row.cache?.observedTtl ?? row.cache?.storedTtl ?? '5m'
  // On the main thread's card: each kept agent at its own TTL, and what the session-wide tally holds
  // beyond the kept rows (agents past the 50 kept) at the TTL agents were last seen writing.
  const kept = agent === undefined ? agents?.agents ?? [] : below
  const beyond = agent === undefined ? minusModels(agents?.models ?? {}, kept.reduce((sum, row) => plusModels(sum, row.models ?? {}), {} as Models)) : {}
  const sources: ModelSource[] = [
    { models: (agent === undefined ? view.ledger?.models : agent.models) ?? {}, ttl: ttlKey(ttl) },
    ...kept.map(row => ({ models: row.models ?? {}, ttl: agentTtl(row) })),
    ...(Object.keys(beyond).length === 0 ? [] : [{ models: beyond, ttl: view.ttlSetting !== undefined && view.ttlSetting !== 'auto' ? view.ttlSetting : agents?.lastTtl ?? '5m' }]),
  ]
  // Counts kept from before models were tallied leave the rows short of the loop's requests: then none.
  const loopRequests = (ledger?.requests ?? 0) + (agent === undefined ? agents?.requests ?? 0 : below.reduce((sum, row) => sum + row.requests, 0))
  const tallied = sources.reduce((sum, source) => sum + Object.values(source.models).reduce((n, row) => n + row.requests, 0), 0)
  const modelSection = tallied === loopRequests ? modelRows(sources, words, room, labelWidth) : []
  // What the cache saved, at list prices, over what the Cost row covers: the whole session on the
  // main thread's card, the agent alone on an agent's. None where a part was kept before this was
  // counted or a model is not in the price table.
  const savedRow = ((): Draft | undefined => {
    // The agent alone on its card: its own tallies must be whole; the main card's are the loop's.
    const scope = agent === undefined ? sources : sources.slice(0, 1)
    const whole = agent === undefined ? tallied === loopRequests
      : Object.values(scope[0]!.models).reduce((n, row) => n + row.requests, 0) === agent.requests
    if (table === undefined || !whole) return undefined
    let saved = 0
    let plain = 0
    for (const { models, ttl: priced } of scope) {
      for (const row of Object.values(models)) {
        // A model the price table lacks, or a tally kept with no cost, would leave the figure partial: then none.
        if (row.isUnpriced === true || row.cost === undefined) return undefined
        const part = savedAt(row.cost, priced)
        if (part === null) return undefined
        saved += part.saved
        plain += part.plain
      }
    }
    // Nothing to show where it rounds to nothing.
    if (!(plain > 0) || Math.abs(saved) < 0.00005) return undefined
    const percent = Math.round((Math.abs(saved) / plain) * 100)
    return [
      { text: words.saved.padEnd(labelWidth), tone: 'plain' },
      { text: `≈ ${saved < 0 ? '−' : ''}${usdText(Math.abs(saved))}`, tone: 'plain' },
      { text: ` ${saved < 0 ? words.savedMore(percent) : words.savedShare(percent)}`, tone: 'dim', short: '' },
    ]
  })()
  const wanted = Math.max(0, ...tokenRows.map(widthOfRow), ...(hitRow === undefined ? [] : [widthOfRow(hitRow)]), ...(costDraft === undefined ? [] : [widthOfRow(costDraft)]), ...(savedRow === undefined ? [] : [widthOfRow(savedRow)]), ...extra.map(widthOfRow), ...agentSection.map(widthOfRow), ...modelSection.map(widthOfRow))
  const content = Math.min(room, Math.max(CARD_WIDTH - FRAME, wanted))

  const rows: Row[] = []
  if (agent !== undefined) {
    // Where the card is in the tree: Main › … › this agent, each step before it pressable.
    const crumbs: Draft = [{ text: words.mainCrumb, tone: 'plain', press: 'main' }]
    for (const step of selected!.path.slice(0, -1)) {
      crumbs.push({ text: ' › ', tone: 'dim' }, { text: cut(step.label, AGENT_LABEL), tone: 'plain', press: `agent:${step.id}` })
    }
    crumbs.push({ text: ' › ', tone: 'dim' }, { text: `${cut(agent.label, AGENT_LABEL)} · ${modelName(agent.model)}`, tone: 'meter' })
    rows.push(shorten(crumbs, content))
  }
  const figures: Row = [{ text: words.context, tone: 'plain' }]
  // `?`: the window is not the host's (an agent on another model): it comes from the docs' table.
  const guess = selected?.isWindowInferred === true ? '?' : ''
  if (fill.tokens !== undefined) figures.push({ text: `${GAP}${mark}${tokens(fill.tokens)} / ${tokens(fill.window)}${guess}`, tone: 'meter' })
  figures.push({ text: `${GAP}${mark}${Math.round(fill.percent)}%${guess}`, tone: 'meter' })
  const bar = split(fill.percent, content)
  rows.push(figures, [{ text: '━'.repeat(bar.filled), tone: 'bar' }, { text: '─'.repeat(bar.empty), tone: 'dim' }])
  if (compactAt !== null) rows.push([{ text: `${words.compact} ~${tokens(compactAt)}`, tone: 'dim' }])
  rows.push(...tokenRows)
  if (hitRow !== undefined) rows.push(shorten(hitRow, content))
  if (costDraft !== undefined) {
    // The amount always fits where the table does: only its tail shortens or goes.
    rows.push(shorten(costDraft, content))
  }
  if (savedRow !== undefined) rows.push(shorten(savedRow, content))
  rows.push(...extra.map(row => shorten(row, content)))
  if (agentSection.length > 0) rows.push([], ...agentSection)
  if (modelSection.length > 0) rows.push([], ...modelSection)

  const fitted = rows.map(row => fitRow(row, content))
  return { width: content + FRAME, content, height: fitted.length + 2, rows: fitted, depth: selected?.path.length ?? 0 }
}

/** The card's rows as plain text, for /context-meter: at its widest, every loss of the history. */
export function cardText (view: CardView, language: Language): string {
  const card = cardOf(view, language, Infinity, HISTORY, KEPT)
  if (card === null) return WORDS[language].none
  return card.rows.map(row => row.map(cell => cell.text).join('').trimEnd()).join('\n')
}
