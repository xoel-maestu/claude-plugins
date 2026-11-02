// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { cardOf, cardText, tokens } from './card'

test('token counts use k and M with one decimal, dropping a trailing .0', () => {
  expect(tokens(950)).toBe('950')
  expect(tokens(124_300)).toBe('124.3k')
  expect(tokens(200_000)).toBe('200k')
  expect(tokens(999_940)).toBe('999.9k')
  expect(tokens(2_100_000)).toBe('2.1M')
  expect(tokens(1_000_000)).toBe('1M')
})

const FILL = { percent: 62, tokens: 124_300, window: 200_000, isEstimate: false }

test('the card line reads tokens over window, the percentage and the autocompact point', () => {
  const card = cardOf(FILL, 167_000, 'en')
  expect(card?.line).toBe('Context  124.3k / 200k  62%   autocompact at ~167k')
  expect(card?.bar.filled + card!.bar.empty).toBe(card!.line.length)
})

test('without an autocompact point the part is left out', () => {
  expect(cardOf(FILL, null, 'en')?.line).toBe('Context  124.3k / 200k  62%')
})

test('an estimate marks its figures with ~', () => {
  expect(cardOf({ ...FILL, isEstimate: true }, null, 'en')?.line).toBe('Context  ~124.3k / 200k  ~62%')
})

test('the bar is at least 30 cells wide', () => {
  const card = cardOf(FILL, null, 'en')!
  expect(card.bar.filled + card.bar.empty).toBe(30)
  expect(card.bar.filled).toBe(19)
})

test('Spanish reads the same figures', () => {
  expect(cardOf(FILL, 167_000, 'es')?.line).toBe('Contexto  124.3k / 200k  62%   autocompacta en ~167k')
})

test('no fill, no card', () => {
  expect(cardOf(null, 167_000, 'en')).toBeNull()
})

test('as text: the line and the bar, or a plain sentence without a figure', () => {
  expect(cardText(FILL, null, 'en')).toBe('Context  124.3k / 200k  62%\n' + '━'.repeat(19) + '─'.repeat(11))
  expect(cardText(null, null, 'en')).toBe('No context figure yet.')
  expect(cardText(null, null, 'es')).toBe('Todavía no hay cifra de contexto.')
})
