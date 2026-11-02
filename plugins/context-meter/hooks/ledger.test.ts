// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { EMPTY, add, hitRate, since } from './ledger'

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number, model = 'model-a') =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, model })

test('an empty ledger has no last request, zero totals and no requests', () => {
  expect(EMPTY).toEqual({ total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 })
  expect(EMPTY.last).toBeUndefined()
})

test('a request becomes the last one and is added to the totals', () => {
  const one = add(EMPTY, usage(1200, 118_000, 5100, 2400), 1000)
  expect(one.last).toEqual({ input: 1200, output: 2400, cacheRead: 118_000, cacheWrite: 5100, model: 'model-a', at: 1000 })
  expect(one.total).toEqual({ input: 1200, output: 2400, cacheRead: 118_000, cacheWrite: 5100 })
  expect(one.requests).toBe(1)

  const two = add(one, usage(300, 120_000, 800, 600, 'model-b'), 2000)
  expect(two.last).toEqual({ input: 300, output: 600, cacheRead: 120_000, cacheWrite: 800, model: 'model-b', at: 2000 })
  expect(two.total).toEqual({ input: 1500, output: 3000, cacheRead: 238_000, cacheWrite: 5900 })
  expect(two.requests).toBe(2)
})

test('adding leaves the ledger it was given as it was', () => {
  const one = add(EMPTY, usage(10, 20, 30, 40), 1)
  add(one, usage(1, 1, 1, 1), 2)
  expect(one.requests).toBe(1)
  expect(EMPTY.requests).toBe(0)
})

test('the cache hit rate: read over everything sent, none when nothing was sent', () => {
  expect(hitRate({ input: 1000, output: 5000, cacheRead: 96_000, cacheWrite: 3000 })).toBe(0.96)
  expect(hitRate({ input: 0, output: 5000, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  expect(hitRate(EMPTY.total)).toBeNull()
})

test('a new session start (/clear) begins a new ledger; the same one keeps it', () => {
  const kept = { ...add(EMPTY, usage(10, 20, 30, 40), 1), startedAt: 500 }
  expect(since(kept, 500)).toBe(kept)
  expect(since(kept, 900)).toEqual({ ...EMPTY, startedAt: 900 })
  // A ledger that never saw its start takes the one it is given and keeps nothing.
  expect(since(add(EMPTY, usage(1, 1, 1, 1), 1), 700)).toEqual({ ...EMPTY, startedAt: 700 })
})
