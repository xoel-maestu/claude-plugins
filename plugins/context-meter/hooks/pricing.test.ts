// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

/** Equal to within a millionth of a cent: float sums of prices. */
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected) < 1e-8).toBe(true)

import { NO_COST, costAt, plusCost, priceOf, requestCost, windowOf } from './pricing'

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number, model: string) =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, model })

test('the published rates per million tokens, by model id', () => {
  expect(priceOf('claude-opus-5-5', 1000)).toEqual({ input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 })
  expect(priceOf('claude-sonnet-5-5', 1000)).toEqual({ input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 })
  expect(priceOf('claude-fable-5-1', 1000)).toEqual({ input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 })
  expect(priceOf('claude-sonnet-4-5-20250929', 1000)).toEqual({ input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 })
  expect(priceOf('claude-opus-4-1', 1000)).toEqual({ input: 15, write5m: 18.75, write1h: 30, read: 1.5, output: 75 })
  expect(priceOf('claude-fable-5-1[1m]', 1000)?.input).toBe(10)
  expect(priceOf('claude-3-5-haiku-20241022', 1000)).toEqual({ input: 0.8, write5m: 1, write1h: 1.6, read: 0.08, output: 4 })
  expect(priceOf('some-other-model', 1000)).toBeNull()
})

test('Haiku 5.5 is priced by prompt length: over 100,000 input tokens, the higher rates', () => {
  expect(priceOf('claude-haiku-5-5', 100_000)).toEqual({ input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 })
  expect(priceOf('claude-haiku-5-5', 100_001)).toEqual({ input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 })
})

test('a request: uncached, read, written at its TTL and output, each at its rate', () => {
  // 1,000,000 of each at Sonnet 5.5: 2 + 0.1 + 10, and the write at 2.5 (5m) or 4 (1h).
  const parts = requestCost(usage(1e6, 1e6, 1e6, 1e6, 'claude-sonnet-5-5'))!
  near(costAt(parts, '5m'), 14.6)
  near(costAt(parts, '1h'), 16.1)
  // Haiku 5.5 with 3 + 20,000 + 80,000 = 100,003 input tokens: the long-prompt row.
  near(costAt(requestCost(usage(3, 20_000, 80_000, 100, 'claude-haiku-5-5'))!, '5m'), (3 * 0.5 + 20_000 * 0.05 + 80_000 * 0.625 + 100 * 2.5) / 1e6)
  expect(requestCost(usage(1, 1, 1, 1, 'some-other-model'))).toBeNull()
})

test('parts add up', () => {
  expect(plusCost(NO_COST, { base: 1, write5m: 2, write1h: 3 })).toEqual({ base: 1, write5m: 2, write1h: 3 })
})

test('the context window by model: 1M for the models the docs list, 200k for the others', () => {
  expect(windowOf('claude-haiku-5-5')).toBe(1_000_000)
  expect(windowOf('claude-opus-4-6')).toBe(1_000_000)
  expect(windowOf('claude-sonnet-4-5-20250929')).toBe(200_000)
  expect(windowOf('claude-haiku-4-5')).toBe(200_000)
  expect(windowOf('other')).toBeNull()
})
