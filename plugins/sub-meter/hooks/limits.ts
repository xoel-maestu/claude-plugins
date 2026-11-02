import type { SubMeterReading, SubMeterWindow } from '../types'

/** What the meter shows: the two windows in turn, side by side, or one of them. */
export type Display = 'rotate' | 'both' | 'session' | 'week'

const KINDS: readonly SubMeterWindow['kind'][] = ['five_hour', 'seven_day']

/** The 5-hour and weekly windows, in that order, from the engine's rate limits; other kinds are left out. */
export function windowsOf (rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): SubMeterWindow[] {
  return KINDS.flatMap(kind => {
    const found = rateLimits.find(limit => limit.kind === kind)
    if (found === undefined) return []
    return [found.resetsAt === undefined
      ? { kind, percentUsed: found.percentUsed }
      : { kind, percentUsed: found.percentUsed, resetsAt: found.resetsAt }]
  })
}

/** Milliseconds until the window resets; undefined when unknown or already past. */
export function resetIn (window: SubMeterWindow, now: number): number | undefined {
  if (window.resetsAt === undefined) return undefined
  const left = Date.parse(window.resetsAt) - now
  return Number.isFinite(left) && left > 0 ? left : undefined
}

/** The percentage used; a window past its reset is at 0. */
export function percentAt (window: SubMeterWindow, now: number): number {
  const isPast = window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now
  return isPast ? 0 : window.percentUsed
}

/** `42m`, `3h 5m`, `2d 4h`: a time left, at least a minute. */
export function until (ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const isWindow = (value: unknown): value is SubMeterWindow => {
  const w = value as SubMeterWindow | null
  return typeof w === 'object' && w !== null && KINDS.includes(w.kind) && typeof w.percentUsed === 'number' &&
    (w.resetsAt === undefined || typeof w.resetsAt === 'string')
}

/** A reading as `$.store` gave it back, or null when it is not one. */
export function readingOf (value: unknown): SubMeterReading {
  const r = value as NonNullable<SubMeterReading> | null
  if (typeof r !== 'object' || r === null || typeof r.at !== 'number' || !Array.isArray(r.windows)) return null
  if (r.windows.length === 0 || !r.windows.every(isWindow)) return null
  return { windows: r.windows, at: r.at, origin: typeof r.origin === 'number' ? r.origin : 0 }
}

/** The newer of two readings; the current one when the other is no reading or not newer. */
export function newer (current: SubMeterReading, other: SubMeterReading): SubMeterReading {
  if (other === null) return current
  return current === null || other.at > current.at ? other : current
}

/** The windows drawn: both, the one the rotation is on, or the one chosen; with a single window, that one. */
export function shown (windows: readonly SubMeterWindow[], display: Display, turn: number): SubMeterWindow[] {
  if (display === 'both' || windows.length < 2) return [...windows]
  if (display === 'rotate') return [windows[turn % windows.length]!]
  const kind = display === 'session' ? 'five_hour' : 'seven_day'
  return windows.filter(w => w.kind === kind)
}
