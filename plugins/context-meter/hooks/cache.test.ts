// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

import { EMPTY, FIVE_MINUTES, HISTORY, HOUR, alertOf, cleared, expiringFor, markCompact, observe, observeTtl, readSubscription, seed, since, statusOf, ttlInfo, ttlOf } from './cache'
import type { Cache } from './cache'

const MIN = 60_000
const usage = (cacheRead: number, cacheWrite: number, model = 'model-a'): TurnUsage =>
  ({ input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 100, model })

/** A cache whose previous request had a prefix of `prefix` tokens at `at`. */
const after = (prefix: number, at = 0, model = 'model-a', extra: Partial<Cache> = {}): Cache =>
  ({ ...EMPTY, startedAt: 0, last: { prefix, model, at }, ...extra })

test('the first request sets the prefix and records no loss', () => {
  const one = observe(EMPTY, usage(0, 40_000), 1000, false, 'auto')
  expect(one.last).toEqual({ prefix: 40_000, model: 'model-a', at: 1000 })
  expect(one.losses).toEqual([])
})

test('a read short of the previous prefix is a loss of the prefix less what was read', () => {
  const next = observe(after(100_000), usage(20_000, 90_000), MIN, false, 'auto')
  expect(next.losses).toEqual([{ at: MIN, lost: 80_000, cause: 'invalidated', gap: MIN }])
  expect(next.last).toEqual({ prefix: 110_000, model: 'model-a', at: MIN })
})

test('the P − 1024 rule: 1024 tokens not read back is no loss, a token more is', () => {
  expect(observe(after(100_000), usage(100_000, 2000), MIN, false, 'auto').losses).toEqual([])
  expect(observe(after(100_000), usage(98_976, 2000), MIN, false, 'auto').losses).toEqual([])
  expect(observe(after(100_000), usage(98_975, 2000), MIN, false, 'auto').losses).toEqual([{ at: MIN, lost: 1025, cause: 'invalidated', gap: MIN }])
})

test('a partial loss counts: after /compact the system prompt and tools are read, the conversation is written', () => {
  // A real session: read 31.9k + written 17.4k, then after /compact read 29.3k and written 21.2k.
  const next = observe(markCompact(after(31_900 + 17_400)), usage(29_300, 21_200), MIN, false, 'auto')
  expect(next.losses).toEqual([{ at: MIN, lost: 20_000, cause: 'compact', gap: MIN }])
})

test('the 1024 threshold: a prefix of 1024 tokens or fewer loses nothing', () => {
  expect(observe(after(1024), usage(0, 2000), MIN, false, 'auto').losses).toEqual([])
  expect(observe(after(1025), usage(0, 2000), MIN, false, 'auto').losses).toEqual([{ at: MIN, lost: 1025, cause: 'invalidated', gap: MIN }])
})

test('causes, first match: a compaction, then the model, then the TTL, then invalidated', () => {
  const long = 2 * HOUR
  // Compacted, another model and past the TTL: compact wins.
  const compacted = observe(markCompact(after(100_000)), usage(0, 30_000, 'model-b'), long, false, 'auto')
  expect(compacted.losses[0]!.cause).toBe('compact')
  // The compaction is used up by the request after it.
  expect(compacted.isCompactPending).toBe(false)
  expect(observe(after(100_000), usage(0, 30_000, 'model-b'), long, false, 'auto').losses[0]!.cause).toBe('model')
  const expired = observe(after(100_000), usage(0, 30_000), long, false, 'auto').losses[0]!
  expect(expired).toEqual({ at: long, lost: 100_000, cause: 'expired', gap: long })
  // Within the TTL, same model, no compaction.
  expect(observe(after(100_000), usage(0, 30_000), 4 * MIN, false, 'auto').losses[0]!.cause).toBe('invalidated')
})

test('a compaction marked with no loss after it is used up all the same', () => {
  const next = observe(markCompact(after(100_000)), usage(100_000, 10_000), MIN, false, 'auto')
  expect(next.losses).toEqual([])
  expect(next.isCompactPending).toBe(false)
})

test('the history keeps the 10 newest losses, newest first', () => {
  let cache = after(100_000)
  for (let i = 1; i <= 12; i++) cache = observe({ ...cache, last: { prefix: 100_000, model: 'model-a', at: 0 } }, usage(0, 100_000), i * MIN, false, 'auto')
  expect(HISTORY).toBe(10)
  expect(cache.losses).toHaveLength(10)
  expect(cache.losses.map(loss => loss.at / MIN)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
})

test('TTL auto: 1h on a subscription (rate limits), 5m otherwise; an explicit setting stands', () => {
  expect(ttlOf(EMPTY, 'auto')).toBe(FIVE_MINUTES)
  expect(ttlOf({ ...EMPTY, isSubscription: true }, 'auto')).toBe(HOUR)
  expect(ttlOf({ ...EMPTY, isSubscription: true }, '5m')).toBe(FIVE_MINUTES)
  expect(ttlOf(EMPTY, '1h')).toBe(HOUR)
  // The request tells whether the session has rate limits, and that sticks.
  const sub = observe(EMPTY, usage(0, 40_000), 0, true, 'auto')
  expect(ttlOf(sub, 'auto')).toBe(HOUR)
  expect(ttlOf(observe(sub, usage(40_000, 0), MIN, false, 'auto'), 'auto')).toBe(HOUR)
})

test('TTL auto switches to 1h after a hit past a 5 minute pause, for the rest of the session', () => {
  // A hit after 6 minutes: the cache outlived 5 minutes, so it is 1h.
  const hit = observe(after(100_000), usage(100_000, 1000), 6 * MIN, false, 'auto')
  expect(hit.losses).toEqual([])
  expect(hit.isLongSeen).toBe(true)
  expect(ttlOf(hit, 'auto')).toBe(HOUR)
  // A read short of the prefix by up to 1024 tokens is a hit too; by more it is a loss and says nothing.
  expect(observe(after(100_000), usage(98_976, 1000), 6 * MIN, false, 'auto').isLongSeen).toBe(true)
  expect(observe(after(100_000), usage(60_000, 1000), 6 * MIN, false, 'auto').isLongSeen).toBe(false)
  // A hit within 5 minutes says nothing.
  expect(observe(after(100_000), usage(100_000, 1000), 4 * MIN, false, 'auto').isLongSeen).toBe(false)
  // Under explicit 5m the setting stands.
  expect(ttlOf(hit, '5m')).toBe(FIVE_MINUTES)
  // With the switch, a pause of 10 minutes is no longer past the TTL.
  expect(observe(after(100_000, 0, 'model-a', { isLongSeen: true }), usage(0, 1000), 10 * MIN, false, 'auto').losses[0]!.cause).toBe('invalidated')
})

test('the expired cause follows the setting: past 5m under 5m, not past 1h under 1h', () => {
  expect(observe(after(100_000), usage(0, 1000), 6 * MIN, true, '5m').losses[0]!.cause).toBe('expired')
  expect(observe(after(100_000), usage(0, 1000), 30 * MIN, false, '1h').losses[0]!.cause).toBe('invalidated')
  expect(observe(after(100_000), usage(0, 1000), 61 * MIN, false, '1h').losses[0]!.cause).toBe('expired')
})

test('status: no cache yet, active with the time left, expired with how long ago', () => {
  expect(statusOf(EMPTY, HOUR, 0)).toEqual({ kind: 'none' })
  expect(statusOf(after(0, 0), HOUR, 0)).toEqual({ kind: 'none' })
  expect(statusOf(after(50_000, 0), HOUR, 10 * MIN)).toEqual({ kind: 'active', left: 50 * MIN })
  // A tick older than the request counts from the request: never more than the TTL left.
  expect(statusOf(after(50_000, 10 * MIN), HOUR, 0)).toEqual({ kind: 'active', left: HOUR })
  expect(statusOf(after(50_000, 0), FIVE_MINUTES, 8 * MIN)).toEqual({ kind: 'expired', ago: 3 * MIN })
  expect(statusOf(after(50_000, 0), FIVE_MINUTES, 5 * MIN)).toEqual({ kind: 'expired', ago: 0 })
})

test('/clear: everything starts over, with the time it happened as a marker', () => {
  const lost = observe(after(100_000), usage(0, 1000), MIN, true, 'auto')
  expect(cleared(5 * MIN)).toEqual({ ...EMPTY, clearedAt: 5 * MIN })
  // A cache for another session start is a /clear at that start.
  // What /clear does not change (the subscription reading here) is kept.
  expect(since(lost, 9 * MIN)).toEqual({ ...EMPTY, isSubscription: true, isSubscriptionKnown: true, startedAt: 9 * MIN, clearedAt: 9 * MIN })
  expect(since(lost, 0)).toBe(lost)
  // One that never saw its start takes it and keeps its marker.
  expect(since(cleared(5 * MIN), 6 * MIN)).toEqual({ ...EMPTY, startedAt: 6 * MIN, clearedAt: 5 * MIN })
  expect(since(EMPTY, 6 * MIN)).toEqual({ ...EMPTY, startedAt: 6 * MIN })
})

test('observing leaves the cache it was given as it was', () => {
  const before = after(100_000)
  observe(before, usage(0, 1000), MIN, true, 'auto')
  expect(before).toEqual(after(100_000))
})

test('TTL precedence: an explicit setting, then the observed TTL, then the inference (marked inferred)', () => {
  const subscription = { ...EMPTY, isSubscription: true }
  expect(ttlInfo(subscription, 'auto')).toEqual({ ttl: HOUR, isInferred: true })
  expect(ttlInfo(EMPTY, 'auto')).toEqual({ ttl: FIVE_MINUTES, isInferred: true })
  // Observed beats the inference both ways.
  expect(ttlInfo({ ...subscription, observedTtl: '5m' }, 'auto')).toEqual({ ttl: FIVE_MINUTES, isInferred: false })
  expect(ttlInfo({ ...EMPTY, observedTtl: '1h' }, 'auto')).toEqual({ ttl: HOUR, isInferred: false })
  // An explicit setting beats what was observed.
  expect(ttlInfo({ ...EMPTY, observedTtl: '1h' }, '5m')).toEqual({ ttl: FIVE_MINUTES, isInferred: false })
  expect(ttlInfo({ ...EMPTY, observedTtl: '5m' }, '1h')).toEqual({ ttl: HOUR, isInferred: false })
  expect(ttlOf({ ...EMPTY, observedTtl: '1h' }, 'auto')).toBe(HOUR)
})

test('an observed TTL is stored; a pure read (null) keeps the one before; /clear keeps it', () => {
  const seen = observeTtl(EMPTY, '1h')
  expect(seen.observedTtl).toBe('1h')
  expect(observeTtl(seen, null)).toBe(seen)
  expect(observeTtl(seen, '1h')).toBe(seen)
  expect(observeTtl(seen, '5m').observedTtl).toBe('5m')
  expect(cleared(5).observedTtl).toBeUndefined()
  expect(cleared(5, seen).observedTtl).toBe('1h')
  expect(since({ ...seen, startedAt: 0 }, 9).observedTtl).toBe('1h')
})

test('a stored TTL is the inference until one is observed; a stored subscription stands until read', () => {
  const stored = seed(EMPTY, { ttl: '1h', isSubscription: true })
  expect(ttlInfo(stored, 'auto')).toEqual({ ttl: HOUR, isInferred: true })
  expect(ttlInfo(seed(EMPTY, { ttl: '1h', isSubscription: false }), 'auto')).toEqual({ ttl: HOUR, isInferred: true })
  expect(ttlInfo(observeTtl(stored, '5m'), 'auto')).toEqual({ ttl: FIVE_MINUTES, isInferred: false })
  expect(stored.isSubscription).toBe(true)
  expect(seed(EMPTY, { ttl: 'x', isSubscription: 'yes' })).toBe(EMPTY)
  // This session's own reading replaces the stored one and a later seed leaves it.
  const read = readSubscription(stored, false)
  expect(read.isSubscription).toBe(false)
  expect(seed(read, { isSubscription: true }).isSubscription).toBe(false)
  expect(cleared(5, read)).toMatchObject({ isSubscription: false, isSubscriptionKnown: true, storedTtl: '1h' })
})

test('the observed TTL judges an idle loss: 6 minutes under an observed 1h is not expired', () => {
  const cache = after(100_000, 0, 'model-a', { observedTtl: '1h' })
  expect(observe(cache, usage(0, 100_000), 6 * MIN, false, 'auto').losses[0]?.cause).toBe('invalidated')
  expect(observe({ ...cache, observedTtl: '5m', isSubscription: true }, usage(0, 100_000), 6 * MIN, true, 'auto').losses[0]?.cause).toBe('expired')
})

test('the footer alert: fresh, then expiring in the last tenth of the TTL (at least 30 s), then expired', () => {
  const cache = { ...EMPTY, last: { prefix: 50_000, model: 'model-a', at: 0 } }
  const FIVE = 5 * 60_000
  expect(expiringFor(FIVE)).toBe(30_000)
  expect(expiringFor(60 * 60_000)).toBe(6 * 60_000)
  expect(alertOf(cache, FIVE, FIVE - 30_001)).toBe('fresh')
  expect(alertOf(cache, FIVE, FIVE - 30_000)).toBe('expiring')
  expect(alertOf(cache, FIVE, FIVE)).toBe('expired')
  expect(alertOf(EMPTY, FIVE, 0)).toBeNull()
  expect(alertOf({ ...cache, last: { ...cache.last, prefix: 0 } }, FIVE, 0)).toBeNull()
  // A clock behind the last request reads it as just made.
  expect(alertOf(cache, FIVE, -10_000)).toBe('fresh')
})

test("a loss's cost: the lost tokens written again at the TTL in force instead of read, at the answering model's rates", () => {
  const u = (read: number, write: number, model: string) =>
    ({ input_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 10, model })
  // Sonnet 5.5, 5m (no subscription): 80,000 lost × (2.50 − 0.10) per MTok = $0.192.
  let cache = observe(EMPTY, u(0, 100_000, 'claude-sonnet-5-5'), 0, false, 'auto')
  cache = observe(cache, u(20_000, 80_000, 'claude-sonnet-5-5'), 60_000, false, 'auto')
  expect(Math.abs(cache.losses[0]!.cost! - 80_000 * 2.4 / 1e6) < 1e-12).toBe(true)
  // 1h set: (4 − 0.10).
  let hour = observe(EMPTY, u(0, 100_000, 'claude-sonnet-5-5'), 0, false, '1h')
  hour = observe(hour, u(20_000, 80_000, 'claude-sonnet-5-5'), 60_000, false, '1h')
  expect(Math.abs(hour.losses[0]!.cost! - 80_000 * 3.9 / 1e6) < 1e-12).toBe(true)
  // A model the table lacks: no cost.
  let other = observe(EMPTY, u(0, 100_000, 'other'), 0, false, 'auto')
  other = observe(other, u(0, 100_000, 'other'), 60_000, false, 'auto')
  expect(other.losses[0]!.cost).toBeUndefined()
})
