// Pure logic, run with `claude plugin test .`: no engine involved. Every figure is synthetic.
import { expect, test } from 'claude-code/testing'

import { newer, percentAt, readingOf, resetIn, shown, until, windowsOf } from './limits'

const HOUR = 3_600_000
const at = (ms: number) => new Date(ms).toISOString()
const five = { kind: 'five_hour' as const, percentUsed: 31, resetsAt: at(10 * HOUR) }
const week = { kind: 'seven_day' as const, percentUsed: 12, resetsAt: at(90 * HOUR) }

test('keeps the 5-hour and weekly windows, in that order, and no other kind', () => {
  expect(windowsOf([
    { kind: 'spend_limit', percentUsed: 50 },
    { kind: 'seven_day', percentUsed: 12, resetsAt: week.resetsAt },
    { kind: 'five_hour', percentUsed: 31, resetsAt: five.resetsAt },
  ])).toEqual([five, week])
  expect(windowsOf([])).toEqual([])
  expect(windowsOf([{ kind: 'five_hour', percentUsed: 7 }])).toEqual([{ kind: 'five_hour', percentUsed: 7 }])
})

test('a window past its reset is at 0% with no time left', () => {
  expect(percentAt(five, 9 * HOUR)).toBe(31)
  expect(resetIn(five, 8 * HOUR)).toBe(2 * HOUR)
  expect(percentAt(five, 10 * HOUR)).toBe(0)
  expect(resetIn(five, 10 * HOUR)).toBeUndefined()
  expect(percentAt({ kind: 'five_hour', percentUsed: 40 }, 99 * HOUR)).toBe(40)
  expect(resetIn({ kind: 'five_hour', percentUsed: 40 }, 0)).toBeUndefined()
})

test('the time left in minutes, hours and minutes, or days and hours', () => {
  expect(until(10_000)).toBe('1m')
  expect(until(42 * 60_000)).toBe('42m')
  expect(until(2 * HOUR + 10 * 60_000)).toBe('2h 10m')
  expect(until(3 * 24 * HOUR + 18 * HOUR)).toBe('3d 18h')
})

test('a stored reading is taken only when well formed', () => {
  expect(readingOf({ windows: [five], at: 5, origin: 1 })).toEqual({ windows: [five], at: 5, origin: 1 })
  expect(readingOf({ windows: [five], at: 5 })).toEqual({ windows: [five], at: 5, origin: 0 })
  expect(readingOf(undefined)).toBeNull()
  expect(readingOf({ windows: [], at: 5 })).toBeNull()
  expect(readingOf({ windows: [{ kind: 'monthly', percentUsed: 3 }], at: 5 })).toBeNull()
  expect(readingOf({ windows: [five] })).toBeNull()
})

test('the newer reading wins; no reading changes nothing', () => {
  const old = { windows: [five], at: 1, origin: 1 }
  const fresh = { windows: [week], at: 2, origin: 2 }
  expect(newer(old, fresh)).toBe(fresh)
  expect(newer(fresh, old)).toBe(fresh)
  expect(newer(old, null)).toBe(old)
  expect(newer(null, old)).toBe(old)
})

test('rotate, both, session and week; a single window shows in every mode', () => {
  expect(shown([five, week], 'rotate', 0)).toEqual([five])
  expect(shown([five, week], 'rotate', 1)).toEqual([week])
  expect(shown([five, week], 'rotate', 2)).toEqual([five])
  expect(shown([five, week], 'both', 0)).toEqual([five, week])
  expect(shown([five, week], 'session', 1)).toEqual([five])
  expect(shown([five, week], 'week', 0)).toEqual([week])
  expect(shown([week], 'session', 0)).toEqual([week])
  expect(shown([five], 'week', 0)).toEqual([five])
})
