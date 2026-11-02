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
})

const FILL = { percent: 62, tokens: 124_300, window: 200_000, isEstimate: false }
const lines = (card: Card | null) => card!.rows.map(row => row.map(cell => cell.text).join(''))

test('the card: figures, a bar as wide as the content and the autocompact point, 40 columns wide', () => {
  const card = cardOf(FILL, 167_000, 'en')!
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
  const [figures, bar, compact] = cardOf(FILL, 167_000, 'en')!.rows
  expect(figures!.map(cell => cell.tone)).toEqual(['plain', 'meter', 'meter', 'plain'])
  expect(bar!.map(cell => cell.tone)).toEqual(['meter', 'dim'])
  expect(compact![0]!.tone).toBe('dim')
})

test('without an autocompact point the row is left out and the card is a row shorter', () => {
  const card = cardOf(FILL, null, 'en')!
  expect(card.rows).toHaveLength(2)
  expect(card.height).toBe(4)
})

test('an estimate marks its figures with ~', () => {
  expect(lines(cardOf({ ...FILL, isEstimate: true }, null, 'en'))[0]!.trimEnd()).toBe('Context   ~124.3k / 200k   ~62%')
})

test('a short row narrows the card and cuts what does not fit', () => {
  const card = cardOf(FILL, 167_000, 'en', 24)!
  expect(card.width).toBe(24)
  expect(lines(card)).toEqual(['Context   124.3k / 2', '━'.repeat(12) + '─'.repeat(8), 'Autocompact at ~167k'])
  expect(cardOf(FILL, null, 'en', 80)!.width).toBe(40)
})

test('Spanish reads the same figures', () => {
  expect(lines(cardOf(FILL, 167_000, 'es')).map(line => line.trimEnd()))
    .toEqual(['Contexto   124.3k / 200k   62%', '━'.repeat(22) + '─'.repeat(14), 'Autocompacta en ~167k'])
})

test('no fill, no card', () => {
  expect(cardOf(null, 167_000, 'en')).toBeNull()
})

test('as text: the rows, or a plain sentence without a figure', () => {
  expect(cardText(FILL, 167_000, 'en'))
    .toBe('Context   124.3k / 200k   62%\n' + '━'.repeat(22) + '─'.repeat(14) + '\nAutocompact at ~167k')
  expect(cardText(FILL, null, 'en')).toBe('Context   124.3k / 200k   62%\n' + '━'.repeat(22) + '─'.repeat(14))
  expect(cardText(null, null, 'en')).toBe('No context figure yet.')
  expect(cardText(null, null, 'es')).toBe('Todavía no hay cifra de contexto.')
})
