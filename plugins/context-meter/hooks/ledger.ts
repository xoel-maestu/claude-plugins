import type { TurnUsage } from 'claude-code'

import type { ContextMeterCounts, ContextMeterLedger } from '../types'
import { NO_COST, plusCost, requestCost } from './pricing'

export type Counts = ContextMeterCounts
export type Ledger = ContextMeterLedger
export type Models = NonNullable<ContextMeterLedger['models']>

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
    models: addModel(state.models ?? {}, usage),
  }
}

/**
 * The counts by model: the response's counts added to its model's row, a request more, and its
 * cost at list prices in parts (the writes at both TTLs); `isUnpriced` once a request of a model
 * the price table lacks was left out of the cost.
 */
export function addModel (models: Models, usage: TurnUsage): Models {
  const model = usage.model
  const row = models[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
  const price = requestCost(usage)
  return {
    ...models,
    [model]: {
      input: row.input + usage.input_tokens,
      output: row.output + usage.output_tokens,
      cacheRead: row.cacheRead + usage.cache_read_input_tokens,
      cacheWrite: row.cacheWrite + usage.cache_creation_input_tokens,
      requests: row.requests + 1,
      cost: price === null ? row.cost ?? NO_COST : plusCost(row.cost ?? NO_COST, price),
      ...(price === null || row.isUnpriced === true ? { isUnpriced: true } : {}),
    },
  }
}

/** Two sets of rows by model, summed. */
export function plusModels (a: Models, b: Models): Models {
  const out: Models = { ...a }
  for (const [model, row] of Object.entries(b)) {
    const before = out[model]
    out[model] = before === undefined ? row : {
      input: before.input + row.input,
      output: before.output + row.output,
      cacheRead: before.cacheRead + row.cacheRead,
      cacheWrite: before.cacheWrite + row.cacheWrite,
      requests: before.requests + row.requests,
      cost: plusCost(before.cost ?? NO_COST, row.cost ?? NO_COST),
      ...(before.isUnpriced === true || row.isUnpriced === true ? { isUnpriced: true } : {}),
    }
  }
  return out
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
