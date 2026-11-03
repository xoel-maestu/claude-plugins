import { hitRate } from './ledger'
import type { Counts } from './ledger'

/**
 * The last request's cache hit rate against the request before it in the same loop: `steady` with
 * the change in whole points (between the rounded rates the card shows) when one model answered
 * both, `switch` when the model changed (another model's cache is not comparable). Null when there
 * is no request before it, when the last sent no input, or when the one before sent none on the
 * same model.
 */
export type Trend =
  | { kind: 'steady'; percent: number; delta: number }
  | { kind: 'switch'; percent: number }

type Request = Counts & { model: string }

export function trendOf (last: Request, previous?: Request): Trend | null {
  const hit = hitRate(last)
  if (hit === null || previous === undefined) return null
  const percent = Math.round(hit * 100)
  if (previous.model !== last.model) return { kind: 'switch', percent }
  const before = hitRate(previous)
  return before === null ? null : { kind: 'steady', percent, delta: percent - Math.round(before * 100) }
}
