import type { TurnUsage } from 'claude-code'

import { priceOf } from './pricing'

import type { ContextMeterCache, ContextMeterLoss, ContextMeterTtl } from '../types'

export type Cache = ContextMeterCache
export type Loss = ContextMeterLoss
export type TtlSetting = 'auto' | '5m' | '1h'

export const FIVE_MINUTES = 5 * 60_000
export const HOUR = 60 * 60_000
/**
 * A prefix of this many tokens or fewer is not counted, nor a shortfall this size or smaller: a
 * noise floor, not the API's rule. The smallest cacheable prompt is per model, 512 to 4,096 tokens
 * (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, read 2026-11-03).
 */
export const THRESHOLD = 1024
/** How many losses the history keeps. */
export const HISTORY = 10

/** No request yet. */
export const EMPTY: Cache = { isCompactPending: false, isSubscription: false, isLongSeen: false, losses: [] }

export type Ttl = ContextMeterTtl

const msOf = (ttl: Ttl) => (ttl === '1h' ? HOUR : FIVE_MINUTES)

/**
 * The TTL in force and whether it is inferred: the setting when explicit; else the TTL the
 * transcript showed the last cache write used; else inferred: the TTL an earlier session last
 * observed (from `$.store`), else (1h on a subscription or once a hit
 * past a 5 minute pause showed it, 5m otherwise).
 */
export function ttlInfo (cache: Cache, setting: TtlSetting): { ttl: number; isInferred: boolean } {
  if (setting !== 'auto') return { ttl: msOf(setting), isInferred: false }
  if (cache.observedTtl !== undefined) return { ttl: msOf(cache.observedTtl), isInferred: false }
  if (cache.storedTtl !== undefined) return { ttl: msOf(cache.storedTtl), isInferred: true }
  return { ttl: cache.isSubscription || cache.isLongSeen ? HOUR : FIVE_MINUTES, isInferred: true }
}

/** The TTL in force, in milliseconds (see ttlInfo). */
export const ttlOf = (cache: Cache, setting: TtlSetting): number => ttlInfo(cache, setting).ttl

/** The TTL the transcript showed for the last main-thread cache write; null (a pure read) keeps the one before. */
export const observeTtl = (cache: Cache, ttl: Ttl | null): Cache =>
  ttl === null || cache.observedTtl === ttl ? cache : { ...cache, observedTtl: ttl }

/**
 * A main-thread response to a request sent at `at` (the cache is timed from a request's start):
 * a loss when the previous prefix was over 1024 tokens and more than 1024 of its tokens were not read back (a normal request reads the whole previous prefix, so a
 * partial loss, such as a compaction that keeps the system prompt and tools, counts too), with the
 * first cause that holds (a compaction since, another model, a pause past the TTL, else
 * invalidated). `isSubscription` says the session has rate limits.
 */
export function observe (cache: Cache, usage: TurnUsage, at: number, isSubscription: boolean, setting: TtlSetting): Cache {
  const base = isSubscription ? { ...cache, isSubscription: true, isSubscriptionKnown: true } : cache
  const read = usage.cache_read_input_tokens
  const next: Cache = {
    ...base,
    last: { prefix: read + usage.cache_creation_input_tokens, model: usage.model, at },
    isCompactPending: false,
  }
  const previous = cache.last
  if (previous === undefined || previous.prefix <= THRESHOLD) return next

  const gap = at - previous.at
  if (previous.prefix - read <= THRESHOLD) {
    // A hit (the previous prefix read back) past 5 minutes: the cache lives an hour.
    return gap > FIVE_MINUTES ? { ...next, isLongSeen: true } : next
  }
  const cause: Loss['cause'] = cache.isCompactPending ? 'compact'
    : usage.model !== previous.model ? 'model'
    : gap > ttlOf(base, setting) ? 'expired'
    : 'invalidated'
  const lost = previous.prefix - read
  // Getting them back: the lost tokens this request wrote again (a compaction or a shorter prompt
  // writes fewer than it lost) cost the write rate instead of the read rate, at the answering
  // model's rates. Kept at both TTLs: the card prices them at the one in force, as it does all writes.
  const rate = priceOf(usage.model, usage.input_tokens + read + usage.cache_creation_input_tokens)
  const rewritten = Math.min(lost, usage.cache_creation_input_tokens)
  const loss: Loss = {
    at, lost, cause, gap,
    ...(rate === null ? {} : { cost: { write5m: (rewritten * (rate.write5m - rate.read)) / 1e6, write1h: (rewritten * (rate.write1h - rate.read)) / 1e6 } }),
  }
  return { ...next, losses: [loss, ...cache.losses].slice(0, HISTORY) }
}

/** A main-thread compaction: the next request's loss, if any, is its. */
export const markCompact = (cache: Cache): Cache => ({ ...cache, isCompactPending: true })

/**
 * This session's own reading of whether it is a subscription: it replaces the stored one. Only
 * rate limits seen say true; their absence after a response or more says false.
 */
export const readSubscription = (cache: Cache, isSubscription: boolean): Cache =>
  cache.isSubscriptionKnown === true && cache.isSubscription === isSubscription
    ? cache
    : { ...cache, isSubscription, isSubscriptionKnown: true }

/**
 * What `$.store` kept from earlier sessions: the TTL last observed (inferred until this session's
 * transcript confirms one) and whether the session was a subscription (used until this session's
 * own reading arrives). Values of the wrong type are ignored.
 */
export function seed (cache: Cache, stored: { ttl?: unknown; isSubscription?: unknown }): Cache {
  let next = cache
  if ((stored.ttl === '5m' || stored.ttl === '1h') && cache.storedTtl !== stored.ttl) next = { ...next, storedTtl: stored.ttl }
  if (typeof stored.isSubscription === 'boolean' && cache.isSubscriptionKnown !== true && cache.isSubscription !== stored.isSubscription) {
    next = { ...next, isSubscription: stored.isSubscription }
  }
  return next
}

/**
 * /clear at `at`: the requests, losses and pause evidence start over, the time kept as a marker.
 * What /clear does not change is kept from `before`: the TTL setting's observed (and stored) TTL and
 * whether the session is a subscription.
 */
export const cleared = (at: number, before?: Cache): Cache => ({
  ...EMPTY,
  ...(before?.observedTtl !== undefined ? { observedTtl: before.observedTtl } : {}),
  ...(before?.storedTtl !== undefined ? { storedTtl: before.storedTtl } : {}),
  ...(before?.isSubscriptionKnown !== undefined ? { isSubscriptionKnown: before.isSubscriptionKnown } : {}),
  isSubscription: before?.isSubscription ?? false,
  clearedAt: at,
})

/**
 * The cache for the session that began at `startedAt`: this one if it is that session's; one that
 * never saw its start takes it; another start is a /clear at that start.
 */
export function since (cache: Cache, startedAt: number): Cache {
  if (cache.startedAt === startedAt) return cache
  if (cache.startedAt === undefined) return { ...cache, startedAt }
  return { ...cleared(startedAt, cache), startedAt }
}

export type Status = { kind: 'none' } | { kind: 'active'; left: number } | { kind: 'expired'; ago: number }

/** Whether the cache is still alive at `now` (never earlier than the last request), and for how long. */
export function statusOf (cache: Cache, ttl: number, now: number): Status {
  const last = cache.last
  if (last === undefined || last.prefix === 0) return { kind: 'none' }
  const elapsed = Math.max(now, last.at) - last.at
  return elapsed < ttl ? { kind: 'active', left: ttl - elapsed } : { kind: 'expired', ago: elapsed - ttl }
}

/** The main thread's cache as the footer warns of it: alive, in its last stretch, or gone. */
export type Alert = 'fresh' | 'expiring' | 'expired'

/** The last stretch the footer warns in: a tenth of the TTL, at least 30 seconds. */
export const expiringFor = (ttl: number): number => Math.max(ttl / 10, 30_000)

/** Whether the cache is alive, about to expire or expired at `now`; null with no cache. */
export function alertOf (cache: Cache, ttl: number, now: number): Alert | null {
  const status = statusOf(cache, ttl, now)
  if (status.kind === 'none') return null
  if (status.kind === 'expired') return 'expired'
  return status.left <= expiringFor(ttl) ? 'expiring' : 'fresh'
}
