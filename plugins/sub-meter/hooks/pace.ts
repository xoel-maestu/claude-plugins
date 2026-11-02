import type { SubMeterWindow } from '../types'

const HOUR = 3_600_000
/** How long each window lasts. */
export const DURATIONS: Record<SubMeterWindow['kind'], number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
/** Before this much of the window has run, a projection says nothing. */
const LEAST_ELAPSED = 10 * 60_000

/** Where the window gets at its pace so far: to 100% at `at` (before the reset), or not before the reset. */
export type Pace = { isReaching: true; at: number } | { isReaching: false }

/**
 * The window's projection at a steady pace: `percent / elapsed` so far, with `elapsed` the duration
 * less the time to the reset. Null without a reset time, past it, at 0%, or in its first 10 minutes.
 */
export function paceOf (window: SubMeterWindow, now: number): Pace | null {
  if (window.resetsAt === undefined || window.percentUsed <= 0) return null
  const reset = Date.parse(window.resetsAt)
  if (!Number.isFinite(reset) || reset <= now) return null
  const elapsed = DURATIONS[window.kind] - (reset - now)
  if (elapsed < LEAST_ELAPSED) return null
  const full = now + ((100 - window.percentUsed) * elapsed) / window.percentUsed
  return full >= reset ? { isReaching: false } : { isReaching: true, at: full }
}
