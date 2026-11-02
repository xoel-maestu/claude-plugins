import type { TurnUsage } from 'claude-code'

import type { ContextMeterCache, ContextMeterLoss } from '../types'

export type Cache = ContextMeterCache
export type Loss = ContextMeterLoss
export type TtlSetting = 'auto' | '5m' | '1h'

export const FIVE_MINUTES = 5 * 60_000
export const HOUR = 60 * 60_000
/** A prefix of this many tokens or fewer is not counted: below the API's smallest cacheable prefix. */
export const THRESHOLD = 1024
/** How many losses the history keeps. */
export const HISTORY = 10

/** No request yet. */
export const EMPTY: Cache = { isCompactPending: false, isSubscription: false, isLongSeen: false, losses: [] }

/** The TTL in force: the setting, or under `auto` 1h on a subscription or once a hit showed it, 5m otherwise. */
export function ttlOf (cache: Cache, setting: TtlSetting): number {
  if (setting === '5m') return FIVE_MINUTES
  if (setting === '1h') return HOUR
  return cache.isSubscription || cache.isLongSeen ? HOUR : FIVE_MINUTES
}

/**
 * A main-thread response at `at`: a loss when the previous prefix was over 1024 tokens and less than
 * half of it was read back, with the first cause that holds (a compaction since, another model, a
 * pause past the TTL, else invalidated). `isSubscription` says the session has rate limits.
 */
export function observe (cache: Cache, usage: TurnUsage, at: number, isSubscription: boolean, setting: TtlSetting): Cache {
  const base = { ...cache, isSubscription: cache.isSubscription || isSubscription }
  const read = usage.cache_read_input_tokens
  const next: Cache = {
    ...base,
    last: { prefix: read + usage.cache_creation_input_tokens, model: usage.model, at },
    isCompactPending: false,
  }
  const previous = cache.last
  if (previous === undefined || previous.prefix <= THRESHOLD) return next

  const gap = at - previous.at
  if (read >= previous.prefix / 2) {
    // A hit past 5 minutes: the cache lives an hour.
    return gap > FIVE_MINUTES ? { ...next, isLongSeen: true } : next
  }
  const cause: Loss['cause'] = cache.isCompactPending ? 'compact'
    : usage.model !== previous.model ? 'model'
    : gap > ttlOf(base, setting) ? 'expired'
    : 'invalidated'
  const loss: Loss = { at, lost: previous.prefix - read, cause, gap }
  return { ...next, losses: [loss, ...cache.losses].slice(0, HISTORY) }
}

/** A main-thread compaction: the next request's loss, if any, is its. */
export const markCompact = (cache: Cache): Cache => ({ ...cache, isCompactPending: true })

/** /clear at `at`: everything starts over, the time kept as a marker. */
export const cleared = (at: number): Cache => ({ ...EMPTY, clearedAt: at })

/**
 * The cache for the session that began at `startedAt`: this one if it is that session's; one that
 * never saw its start takes it; another start is a /clear at that start.
 */
export function since (cache: Cache, startedAt: number): Cache {
  if (cache.startedAt === startedAt) return cache
  if (cache.startedAt === undefined) return { ...cache, startedAt }
  return { ...cleared(startedAt), startedAt }
}

export type Status = { kind: 'none' } | { kind: 'active'; left: number } | { kind: 'expired'; ago: number }

/** Whether the cache is still alive at `now` (never earlier than the last request), and for how long. */
export function statusOf (cache: Cache, ttl: number, now: number): Status {
  const last = cache.last
  if (last === undefined || last.prefix === 0) return { kind: 'none' }
  const elapsed = Math.max(now, last.at) - last.at
  return elapsed < ttl ? { kind: 'active', left: ttl - elapsed } : { kind: 'expired', ago: elapsed - ttl }
}
