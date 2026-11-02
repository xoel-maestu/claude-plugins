// Pure logic, run with `claude plugin test .`: no engine involved. Every figure is synthetic.
import { expect, test } from 'claude-code/testing'

import { paceOf } from './pace'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (ms: number) => new Date(ms).toISOString()

// A 5-hour window that resets at 5h: at `now` it has run for `now` milliseconds.
const five = (percentUsed: number) => ({ kind: 'five_hour' as const, percentUsed, resetsAt: at(5 * HOUR) })

test('no pace in the first 10 minutes of a window', () => {
  expect(paceOf(five(20), 9 * MINUTE)).toBeNull()
  expect(paceOf(five(20), 10 * MINUTE)).not.toBeNull()
})

test('no pace at 0%, without a reset time, or past the reset', () => {
  expect(paceOf(five(0), 2 * HOUR)).toBeNull()
  expect(paceOf({ kind: 'five_hour', percentUsed: 20 }, 2 * HOUR)).toBeNull()
  expect(paceOf(five(20), 5 * HOUR)).toBeNull()
})

test("won't reach 100% before the reset", () => {
  // 30% in 2h: 100% at 6h40m, after the reset at 5h.
  expect(paceOf(five(30), 2 * HOUR)).toEqual({ isReaching: false })
  // Exactly at the reset counts as not before it.
  expect(paceOf(five(40), 2 * HOUR)).toEqual({ isReaching: false })
})

test('reaches 100% before the reset: the time it does', () => {
  // 50% in 2h: 25% an hour, the other 50% in 2h.
  expect(paceOf(five(50), 2 * HOUR)).toEqual({ isReaching: true, at: 4 * HOUR })
})

test('the weekly window lasts 7 days', () => {
  const week = { kind: 'seven_day' as const, percentUsed: 60, resetsAt: at(7 * DAY) }
  // 60% in 3 days: 20% a day, 100% two days later.
  expect(paceOf(week, 3 * DAY)).toEqual({ isReaching: true, at: 5 * DAY })
  expect(paceOf({ ...week, percentUsed: 30 }, 3 * DAY)).toEqual({ isReaching: false })
})
