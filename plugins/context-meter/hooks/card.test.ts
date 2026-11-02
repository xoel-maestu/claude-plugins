// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { cardOf, cardText, tokens } from './card'
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

test('with requests the card adds the last one, the session and the hit rate, as wide as they need', () => {
  const card = cardOf(WITH_TOKENS, 'en', 115)!
  expect(card.content).toBe(78)
  expect(card.width).toBe(82)
  expect(trimmed(card)).toEqual([
    ...CONTEXT_ROWS,
    '━'.repeat(48) + '─'.repeat(30),
    'Autocompact at ~167k',
    'Last request   in 1.2k   cache read 118k   cache write 5.1k   out 2.4k',
    'Session        in 31k    cache read 2.1M   cache write 160k   out 88k    $4.12',
    'Cache hit      92%',
  ])
  expect(lines(card).every(line => line.length === 78)).toBe(true)
  expect(card.height).toBe(8)
})

test('the token rows: labels plain, the names of the counts dim, the figures plain', () => {
  const last = cardOf(WITH_TOKENS, 'en', 115)!.rows[3]!
  expect(last.slice(0, 3)).toEqual([
    { text: 'Last request   ', tone: 'plain' },
    { text: 'in ', tone: 'dim' },
    // A figure carries the spaces up to the next column.
    { text: '1.2k   ', tone: 'plain' },
  ])
})

test('where the full rows do not fit, each splits in two, then the names shorten; nothing wraps', () => {
  // 60 columns: a band of 55, 51 inside the border.
  const split = cardOf(WITH_TOKENS, 'en', 55)!
  expect(split.width).toBe(53)
  expect(trimmed(split).slice(3)).toEqual([
    'Last request   in 1.2k   out 2.4k',
    '               cache read 118k   cache write 5.1k',
    'Session        in 31k    out 88k    $4.12',
    '               cache read 2.1M   cache write 160k',
    'Cache hit      92%',
  ])
  expect(lines(split).every(line => line.length === split.content)).toBe(true)

  const short = cardOf(WITH_TOKENS, 'en', 44)!
  expect(short.width).toBe(42)
  expect(trimmed(short).slice(3)).toEqual([
    'Last        in 1.2k   out 2.4k',
    '            c.read 118k   c.write 5.1k',
    'Session     in 31k    out 88k    $4.12',
    '            c.read 2.1M   c.write 160k',
    'Cache hit   92%',
  ])

  // Narrower still: the shortest form, cut at the border, one line a row.
  const cut = cardOf(WITH_TOKENS, 'en', 30)!
  expect(cut.width).toBe(30)
  expect(lines(cut).every(line => line.length === 26)).toBe(true)
  expect(lines(cut)[3]).toBe('Last        in 1.2k   out ')
})

test('no request yet: no token rows, no zeros', () => {
  const card = cardOf({ ...WITH_TOKENS, ledger: { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 } }, 'en', 115)!
  expect(card.width).toBe(40)
  expect(trimmed(card)).toHaveLength(3)
})

test('without a cost the session row ends at its counts; with nothing sent there is no hit rate', () => {
  const noCost = trimmed(cardOf({ ...WITH_TOKENS, cost: null }, 'en', 115))
  expect(noCost[4]).toBe('Session        in 31k    cache read 2.1M   cache write 160k   out 88k')
  const zero = { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }
  const noHit = trimmed(cardOf({ ...WITH_TOKENS, ledger: { last: { ...zero, model: 'model-a', at: 1 }, total: zero, requests: 1 } }, 'en', 115))
  expect(noHit.some(line => line.startsWith('Cache hit'))).toBe(false)
  expect(noHit.at(-1)).toBe('Session        in 0   cache read 0   cache write 0   out 10   $4.12')
})

test('the token rows in Spanish', () => {
  expect(trimmed(cardOf(WITH_TOKENS, 'es', 115)).slice(3)).toEqual([
    'Última petición    entrada 1.2k   caché leída 118k   caché escrita 5.1k   salida 2.4k',
    'Sesión             entrada 31k    caché leída 2.1M   caché escrita 160k   salida 88k    $4.12',
    'Acierto de caché   92%',
  ])
  expect(trimmed(cardOf(WITH_TOKENS, 'es', 44)).slice(3, 5)).toEqual([
    'Última    ent. 1.2k   sal. 2.4k',
    '          c.leída 118k   c.escrita 5.1k',
  ])
})

test('as text the token rows come whole, at their widest', () => {
  expect(cardText(WITH_TOKENS, 'en').split('\n').slice(3)).toEqual([
    'Last request   in 1.2k   cache read 118k   cache write 5.1k   out 2.4k',
    'Session        in 31k    cache read 2.1M   cache write 160k   out 88k    $4.12',
    'Cache hit      92%',
  ])
})
