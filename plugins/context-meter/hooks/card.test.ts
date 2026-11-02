// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { cacheStatus, cardOf, cardText, clockTime, minutes, span, tokens } from './card'
import type { Card } from './card'

test('token counts use k and M with one decimal, dropping a trailing .0', () => {
  expect(tokens(950)).toBe('950')
  expect(tokens(124_300)).toBe('124.3k')
  expect(tokens(200_000)).toBe('200k')
  expect(tokens(999_940)).toBe('999.9k')
  expect(tokens(2_100_000)).toBe('2.1M')
  expect(tokens(1_000_000)).toBe('1M')
  // Rounded up to a thousand k, it reads as M.
  expect(tokens(999_960)).toBe('1M')
})

const FILL = { percent: 62, tokens: 124_300, window: 200_000, isEstimate: false }
const lines = (card: Card | null) => card!.rows.map(row => row.map(cell => cell.text).join(''))

test('the card: figures, a bar as wide as the content and the autocompact point, 40 columns wide', () => {
  const card = cardOf({ fill: FILL, compactAt: 167_000 }, 'en')!
  expect(card.width).toBe(40)
  expect(card.content).toBe(36)
  expect(lines(card).map(line => line.trimEnd())).toEqual([
    'Context   124.3k / 200k   62%',
    '━'.repeat(22) + '─'.repeat(14),
    'Autocompact at ~167k',
  ])
  // Every row fills the content, so each takes one line and covers what lies beneath.
  expect(lines(card).every(line => line.length === 36)).toBe(true)
  expect(card.height).toBe(5)
})

test('the figures take the meter tone, the label plain, the empty bar and the autocompact row dim', () => {
  const [figures, bar, compact] = cardOf({ fill: FILL, compactAt: 167_000 }, 'en')!.rows
  expect(figures!.map(cell => cell.tone)).toEqual(['plain', 'meter', 'meter', 'plain'])
  expect(bar!.map(cell => cell.tone)).toEqual(['meter', 'dim'])
  expect(compact![0]!.tone).toBe('dim')
})

test('without an autocompact point the row is left out and the card is a row shorter', () => {
  const card = cardOf({ fill: FILL, compactAt: null }, 'en')!
  expect(card.rows).toHaveLength(2)
  expect(card.height).toBe(4)
})

test('an estimate marks its figures with ~', () => {
  expect(lines(cardOf({ fill: { ...FILL, isEstimate: true }, compactAt: null }, 'en'))[0]!.trimEnd()).toBe('Context   ~124.3k / 200k   ~62%')
})

test('a short row narrows the card and cuts what does not fit', () => {
  const card = cardOf({ fill: FILL, compactAt: 167_000 }, 'en', 24)!
  expect(card.width).toBe(24)
  expect(lines(card)).toEqual(['Context   124.3k / 2', '━'.repeat(12) + '─'.repeat(8), 'Autocompact at ~167k'])
  expect(cardOf({ fill: FILL, compactAt: null }, 'en', 80)!.width).toBe(40)
})

test('Spanish reads the same figures', () => {
  expect(lines(cardOf({ fill: FILL, compactAt: 167_000 }, 'es')).map(line => line.trimEnd()))
    .toEqual(['Contexto   124.3k / 200k   62%', '━'.repeat(22) + '─'.repeat(14), 'Autocompacta en ~167k'])
})

test('no fill, no card', () => {
  expect(cardOf({ fill: null, compactAt: 167_000 }, 'en')).toBeNull()
})

test('as text: the rows, or a plain sentence without a figure', () => {
  expect(cardText({ fill: FILL, compactAt: 167_000 }, 'en'))
    .toBe('Context   124.3k / 200k   62%\n' + '━'.repeat(22) + '─'.repeat(14) + '\nAutocompact at ~167k')
  expect(cardText({ fill: FILL, compactAt: null }, 'en')).toBe('Context   124.3k / 200k   62%\n' + '━'.repeat(22) + '─'.repeat(14))
  expect(cardText({ fill: null, compactAt: null }, 'en')).toBe('No context figure yet.')
  expect(cardText({ fill: null, compactAt: null }, 'es')).toBe('Todavía no hay cifra de contexto.')
})

const LEDGER = {
  startedAt: 0,
  last: { input: 1200, cacheRead: 118_000, cacheWrite: 5100, output: 2400, model: 'model-a', at: 1000 },
  total: { input: 31_000, cacheRead: 2_100_000, cacheWrite: 160_000, output: 88_000 },
  requests: 14,
}
const WITH_TOKENS = { fill: FILL, compactAt: 167_000, ledger: LEDGER, cost: 4.123 }
const CONTEXT_ROWS = ['Context   124.3k / 200k   62%']
const trimmed = (card: Card | null) => lines(card).map(line => line.trimEnd())

// Input is cache read, cache write and uncached: 124.3k for the last request, 2.3M for the session.
const TABLE = [
  '               Input    Cache read   Cache write   Uncached   Output',
  'Last request   124.3k   118k         5.1k          1.2k       2.4k',
  'Session        2.3M     2.1M         160k          31k        88k',
  'Cache hit      92% of input read from cache',
  'Cost           $4.12 (session, all agents)',
]

test('with requests the card adds the token table, the hit rate and the cost, as wide as they need', () => {
  const card = cardOf(WITH_TOKENS, 'en', 115)!
  expect(card.content).toBe(68)
  expect(card.width).toBe(72)
  expect(trimmed(card)).toEqual([...CONTEXT_ROWS, '━'.repeat(42) + '─'.repeat(26), 'Autocompact at ~167k', ...TABLE])
  expect(lines(card).every(line => line.length === 68)).toBe(true)
  expect(card.height).toBe(10)
})

test('the table: headers dim, labels and figures plain, each column as wide as its widest cell', () => {
  const [header, last] = cardOf(WITH_TOKENS, 'en', 115)!.rows.slice(3)
  expect(header!.slice(0, 3)).toEqual([
    { text: ' '.repeat(15), tone: 'plain' },
    { text: 'Input    ', tone: 'dim' },
    { text: 'Cache read   ', tone: 'dim' },
  ])
  expect(last!.slice(0, 3)).toEqual([
    { text: 'Last request   ', tone: 'plain' },
    { text: '124.3k   ', tone: 'plain' },
    { text: '118k         ', tone: 'plain' },
  ])
})

test('where the band is narrow, Uncached goes first, then Cache write; nothing wraps', () => {
  // 68 inside the border needs 72; at 70 Uncached goes.
  const four = cardOf(WITH_TOKENS, 'en', 70)!
  expect(trimmed(four).slice(3, 6)).toEqual([
    '               Input    Cache read   Cache write   Output',
    'Last request   124.3k   118k         5.1k          2.4k',
    'Session        2.3M     2.1M         160k          88k',
  ])
  // 60 columns: a band of 55, 51 inside the border.
  const three = cardOf(WITH_TOKENS, 'en', 55)!
  expect(three.width).toBe(47)
  expect(trimmed(three).slice(3)).toEqual([
    '               Input    Cache read   Output',
    'Last request   124.3k   118k         2.4k',
    'Session        2.3M     2.1M         88k',
    'Cache hit      92% of input read from cache',
    'Cost           $4.12 (session, all agents)',
  ])
  expect(lines(three).every(line => line.length === three.content)).toBe(true)

  // Narrower still: no layout fits, so the table, the hit rate and the cost are left out, no number cut.
  const cut = cardOf(WITH_TOKENS, 'en', 44)!
  expect(cut.width).toBe(40)
  expect(trimmed(cut)).toEqual(['Context   124.3k / 200k   62%', '━'.repeat(22) + '─'.repeat(14), 'Autocompact at ~167k'])
})

test('the cost row takes its short scope where the full one does not fit', () => {
  const view = { ...WITH_TOKENS, cost: 1234.5 }
  // 43 inside the border: the three-column table, the cost scope shortened.
  expect(trimmed(cardOf(view, 'en', 47)).at(-1)).toBe('Cost           $1234.50 (all agents)')
})

test('a cost of zero (a subscription) or none gives no cost row', () => {
  for (const cost of [0, null, undefined]) {
    const rows = trimmed(cardOf({ ...WITH_TOKENS, cost }, 'en', 115))
    expect(rows.at(-1)).toBe('Cache hit      92% of input read from cache')
    expect(rows.some(line => line.includes('$'))).toBe(false)
  }
})

test('no request yet: no token rows, no zeros', () => {
  const card = cardOf({ ...WITH_TOKENS, ledger: { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 } }, 'en', 115)!
  expect(card.width).toBe(40)
  expect(trimmed(card)).toHaveLength(3)
})

test('with nothing sent there is no hit rate', () => {
  const zero = { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }
  const noHit = trimmed(cardOf({ ...WITH_TOKENS, ledger: { last: { ...zero, model: 'model-a', at: 1 }, total: zero, requests: 1 } }, 'en', 115))
  expect(noHit.some(line => line.startsWith('Cache hit'))).toBe(false)
  expect(noHit.slice(-2)).toEqual(['Session        0       0            0             0          10', 'Cost           $4.12 (session, all agents)'])
})

test('the token table in Spanish', () => {
  expect(trimmed(cardOf(WITH_TOKENS, 'es', 115)).slice(3)).toEqual([
    '                    Entrada   Caché leída   Caché escrita   Sin caché   Salida',
    'Última petición     124.3k    118k          5.1k            1.2k        2.4k',
    'Sesión              2.3M      2.1M          160k            31k         88k',
    'Acierto de caché    92% de la entrada leída de caché',
    'Coste               $4.12 (sesión, todos los agentes)',
  ])
  expect(trimmed(cardOf(WITH_TOKENS, 'es', 55)).slice(3, 4)).toEqual(['                    Entrada   Caché leída   Salida'])
})

test('as text the table comes whole, at its widest', () => {
  expect(cardText(WITH_TOKENS, 'en').split('\n').slice(3)).toEqual(TABLE)
})

const MIN = 60_000
const HOUR = 60 * MIN
const CACHE = {
  startedAt: 0,
  last: { prefix: 120_000, model: 'model-a', at: 0 },
  isCompactPending: false,
  isSubscription: true,
  isLongSeen: false,
  losses: [
    { at: 140 * MIN, lost: 112_000, cause: 'expired' as const, gap: 67 * MIN },
    { at: 62 * MIN, lost: 98_000, cause: 'compact' as const, gap: MIN },
    { at: 40 * MIN, lost: 50_000, cause: 'model' as const, gap: MIN },
    { at: 10 * MIN, lost: 20_000, cause: 'invalidated' as const, gap: MIN },
  ],
}
const WITH_CACHE = { ...WITH_TOKENS, cache: CACHE, ttl: HOUR, now: 18 * MIN + 50_000 }

test('times left in whole minutes, rounded down; pauses in s, m or h with minutes', () => {
  expect(minutes(41 * MIN + 59_000)).toBe('41m')
  expect(minutes(59_999)).toBe('<1m')
  expect(minutes(HOUR)).toBe('1h00m')
  expect(span(45_000)).toBe('45s')
  expect(span(7 * MIN + 59_000)).toBe('7m')
  expect(span(67 * MIN)).toBe('1h07m')
})

test('the cache line: active until the expiry with whole minutes left and the TTL, expired, or no cache yet', () => {
  expect(cacheStatus(CACHE, HOUR, 18 * MIN + 50_000, 'en')).toBe(`active until ${clockTime(HOUR)} (in 41m, TTL 1h)`)
  // The text changes once a minute: the same through the minute, then a minute less.
  expect(cacheStatus(CACHE, HOUR, 18 * MIN + 1_000, 'en')).toBe(`active until ${clockTime(HOUR)} (in 41m, TTL 1h)`)
  expect(cacheStatus(CACHE, HOUR, 19 * MIN, 'en')).toBe(`active until ${clockTime(HOUR)} (in 41m, TTL 1h)`)
  expect(cacheStatus(CACHE, HOUR, 19 * MIN + 1_000, 'en')).toBe(`active until ${clockTime(HOUR)} (in 40m, TTL 1h)`)
  expect(cacheStatus(CACHE, HOUR, HOUR - 30_000, 'en')).toBe(`active until ${clockTime(HOUR)} (in <1m, TTL 1h)`)
  expect(cacheStatus(CACHE, 5 * MIN, 5 * MIN + 30_000, 'en')).toBe('expired <1m ago')
  expect(cacheStatus(CACHE, 5 * MIN, 8 * MIN, 'en')).toBe('expired 3m ago')
  expect(cacheStatus(CACHE, 5 * MIN, 72 * MIN, 'en')).toBe('expired 1h07m ago')
  expect(cacheStatus({ ...CACHE, last: undefined }, HOUR, 0, 'en')).toBe('no cache yet')
  expect(cacheStatus(CACHE, HOUR, 18 * MIN + 50_000, 'es')).toBe(`activa hasta las ${clockTime(HOUR)} (en 41m, TTL 1h)`)
  expect(cacheStatus(CACHE, HOUR, HOUR - 30_000, 'es')).toBe(`activa hasta las ${clockTime(HOUR)} (en <1m, TTL 1h)`)
  expect(cacheStatus(CACHE, 5 * MIN, 8 * MIN, 'es')).toBe('caducada hace 3m')
  expect(cacheStatus({ ...CACHE, last: undefined }, HOUR, 0, 'es')).toBe('sin caché todavía')
})

test('the cache rows after the table: the status, then the losses newest first, each cause said', () => {
  expect(trimmed(cardOf(WITH_CACHE, 'en', 115)).slice(8)).toEqual([
    `Cache          active until ${clockTime(HOUR)} (in 41m, TTL 1h)`,
    `Cache losses   ${clockTime(140 * MIN)}  −112k  idle 1h07m > TTL`,
    `               ${clockTime(62 * MIN)}  −98k   /compact`,
    `               ${clockTime(40 * MIN)}  −50k   model changed`,
    `               ${clockTime(10 * MIN)}  −20k   invalidated (prompt or tools changed)`,
  ])
  expect(trimmed(cardOf(WITH_CACHE, 'es', 115)).slice(8)).toEqual([
    `Caché               activa hasta las ${clockTime(HOUR)} (en 41m, TTL 1h)`,
    `Pérdidas de caché   ${clockTime(140 * MIN)}  −112k  inactiva 1h07m > TTL`,
    `                    ${clockTime(62 * MIN)}  −98k   /compact`,
    `                    ${clockTime(40 * MIN)}  −50k   cambio de modelo`,
    `                    ${clockTime(10 * MIN)}  −20k   invalidada (cambió el prompt o las herramientas)`,
  ])
})

test('the card shows the 5 newest losses, the text all of them; a short band shortens the causes, never cutting a word', () => {
  const many = { ...CACHE, losses: Array.from({ length: 10 }, (_, i) => ({ at: (10 - i) * MIN, lost: 10_000 + i, cause: 'invalidated' as const, gap: MIN })) }
  const view = { ...WITH_CACHE, cache: many }
  expect(trimmed(cardOf(view, 'en', 115)).filter(line => line.includes('−'))).toHaveLength(5)
  expect(cardText(view, 'en').split('\n').filter(line => line.includes('−'))).toHaveLength(10)
  const narrow = cardOf(WITH_CACHE, 'en', 55)!
  expect(lines(narrow).every(line => line.length === narrow.content)).toBe(true)
  expect(trimmed(narrow).slice(-4)).toEqual([
    `Cache losses   ${clockTime(140 * MIN)}  −112k  idle 1h07m > TTL`,
    `               ${clockTime(62 * MIN)}  −98k   /compact`,
    `               ${clockTime(40 * MIN)}  −50k   model changed`,
    `               ${clockTime(10 * MIN)}  −20k   invalidated`,
  ])
  // Narrower: idle keeps its short form; a cause whose short form does not fit is left out whole.
  const narrower = trimmed(cardOf(WITH_CACHE, 'en', 44)).slice(-5)
  expect(narrower).toEqual([
    `Cache          until ${clockTime(HOUR)} (TTL 1h)`,
    `Cache losses   ${clockTime(140 * MIN)}  −112k  idle 1h07m`,
    `               ${clockTime(62 * MIN)}  −98k   /compact`,
    `               ${clockTime(40 * MIN)}  −50k`,
    `               ${clockTime(10 * MIN)}  −20k   invalidated`,
  ])
  const es = trimmed(cardOf(WITH_CACHE, 'es', 55)).slice(-4)
  expect(es).toEqual([
    `Pérdidas de caché   ${clockTime(140 * MIN)}  −112k  inactiva 1h07m`,
    `                    ${clockTime(62 * MIN)}  −98k   /compact`,
    `                    ${clockTime(40 * MIN)}  −50k   cambio de modelo`,
    `                    ${clockTime(10 * MIN)}  −20k   invalidada`,
  ])
})

test('no losses: a sentence; after /clear the marker comes first', () => {
  const none = { ...WITH_CACHE, cache: { ...CACHE, losses: [] } }
  expect(trimmed(cardOf(none, 'en', 115)).slice(8)).toEqual([`Cache          active until ${clockTime(HOUR)} (in 41m, TTL 1h)`, 'No cache losses this session'])
  expect(trimmed(cardOf(none, 'es', 115)).slice(8)).toEqual([`Caché               activa hasta las ${clockTime(HOUR)} (en 41m, TTL 1h)`, 'Sin pérdidas de caché en esta sesión'])
  const afterClear = { ...WITH_CACHE, cache: { ...CACHE, clearedAt: 5 * MIN } }
  expect(trimmed(cardOf(afterClear, 'en', 115)).slice(9, 11)).toEqual([
    `Cache losses   Cleared at ${clockTime(5 * MIN)}`,
    `               ${clockTime(140 * MIN)}  −112k  idle 1h07m > TTL`,
  ])
  expect(trimmed(cardOf({ ...afterClear, cache: { ...CACHE, losses: [], clearedAt: 5 * MIN } }, 'es', 115)).slice(9))
    .toEqual([`Borrada a las ${clockTime(5 * MIN)}`, 'Sin pérdidas de caché en esta sesión'])
})
