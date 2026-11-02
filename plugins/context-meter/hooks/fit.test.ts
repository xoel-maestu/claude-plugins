// Pure logic, run with `claude plugin test .`: no engine involved.
import { expect, test } from 'claude-code/testing'

import { BUDGET, barOf, fit, label, widthOf } from './fit'

test('the label is the rounded percentage, with ~ for an estimate', () => {
  expect(label(62.4, false)).toBe('62%')
  expect(label(61.6, true)).toBe('~62%')
  expect(label(100, false)).toBe('100%')
})

test('the widest form is exactly the budget of 14 columns', () => {
  expect(BUDGET).toBe(14)
  for (const text of ['5%', '62%', '~62%', '100%', '~100%']) expect(widthOf('bar', text)).toBe(14)
  expect(widthOf('short', '62%')).toBe(7) // ctx 62%
  expect(widthOf('bare', '62%')).toBe(3) // 62%
})

test('picks the widest form that fits the room', () => {
  expect(fit(200, '62%')).toBe('bar')
  expect(fit(14, '62%')).toBe('bar')
  expect(fit(13, '62%')).toBe('short')
  expect(fit(7, '62%')).toBe('short')
  expect(fit(6, '62%')).toBe('bare')
  expect(fit(3, '62%')).toBe('bare')
  expect(fit(2, '62%')).toBeNull()
})

test('an estimate needs one more column in the narrow forms', () => {
  expect(fit(7, '~62%')).toBe('bare')
  expect(fit(8, '~62%')).toBe('short')
  expect(fit(3, '~62%')).toBeNull()
})

test('the bar fills the cells left inside the budget, rounded, clamped to 0..100', () => {
  // 'ctx ' + cells + ' 62%' = 14, so 6 cells
  expect(barOf(62, '62%')).toEqual({ filled: 4, empty: 2 })
  expect(barOf(0, '0%')).toEqual({ filled: 0, empty: 7 })
  expect(barOf(130, '130%')).toEqual({ filled: 5, empty: 0 })
  expect(barOf(-5, '0%')).toEqual({ filled: 0, empty: 7 })
})
