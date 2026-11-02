import type { TurnUsage } from 'claude-code'

import type { ContextMeterCounts, ContextMeterLedger } from '../types'

export type Counts = ContextMeterCounts
export type Ledger = ContextMeterLedger

/** No request yet: no last one, every total zero. */
export const EMPTY: Ledger = { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0 }

/** A main-thread response's counts at `at`: the last request, and added to the session totals. */
export function add (state: Ledger, usage: TurnUsage, at: number): Ledger {
  const counts: Counts = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
  const { total } = state
  return {
    ...state,
    last: { ...counts, model: usage.model, at },
    total: {
      input: total.input + counts.input,
      output: total.output + counts.output,
      cacheRead: total.cacheRead + counts.cacheRead,
      cacheWrite: total.cacheWrite + counts.cacheWrite,
    },
    requests: state.requests + 1,
  }
}

/** The share of the input the cache served: read over read, written and uncached; null when nothing was sent. */
export function hitRate (counts: Counts): number | null {
  const sent = counts.input + counts.cacheRead + counts.cacheWrite
  return sent === 0 ? null : counts.cacheRead / sent
}

/** The ledger for the session that began at `startedAt`: this one if it is that session's, a new one otherwise (/clear). */
export function since (state: Ledger, startedAt: number): Ledger {
  return state.startedAt === startedAt ? state : { ...EMPTY, startedAt }
}
