// Pure logic, run with `claude plugin test .`: no engine involved.
import { expect, test } from 'claude-code/testing'

import { contextWidth, fit, split, tidy, widthOf } from './fit'

const five = { label: '5h', percent: '31%', reset: '2h 10m' }
const week = { label: 'week', percent: '12%', reset: '3d 18h' }

test('the widths of the three forms', () => {
  expect(widthOf('bar', [five])).toBe(26) // 5h ━━━━━━━━━━ 31% ↻ 2h 10m
  expect(widthOf('reset', [five])).toBe(15) // 5h 31% ↻ 2h 10m
  expect(widthOf('bare', [five])).toBe(6) // 5h 31%
  expect(widthOf('bare', [five, week])).toBe(6 + 3 + 8) // 5h 31% | week 12%
  expect(widthOf('reset', [{ ...five, reset: '' }])).toBe(6)
})

test('gives up the bar, then the reset time, then itself', () => {
  expect(fit(26, [five])).toBe('bar')
  expect(fit(25, [five])).toBe('reset')
  expect(fit(15, [five])).toBe('reset')
  expect(fit(14, [five])).toBe('bare')
  expect(fit(6, [five])).toBe('bare')
  expect(fit(5, [five])).toBeNull()
})

test('the bar has 10 cells, rounded and clamped', () => {
  expect(split(31)).toEqual({ filled: 3, empty: 7 })
  expect(split(0)).toEqual({ filled: 0, empty: 10 })
  expect(split(120)).toEqual({ filled: 10, empty: 0 })
})

test("context-meter's width beside this meter: its bar with room for 8 more, else its narrow forms", () => {
  const fill = { percent: 62, isEstimate: false }
  expect(contextWidth(25, fill)).toBe(14)
  expect(contextWidth(24, fill)).toBe(7) // ctx 62%
  expect(contextWidth(7, fill)).toBe(7)
  expect(contextWidth(6, fill)).toBe(3) // 62%
  expect(contextWidth(2, fill)).toBe(0)
  expect(contextWidth(24, { percent: 62, isEstimate: true })).toBe(8) // ctx ~62%
  expect(contextWidth(200, null)).toBe(0)
  expect(contextWidth(200, undefined)).toBe(0)
})

test('drops the cycle and interrupt hints and the separators they leave', () => {
  const both = { cycle: true, interrupt: true }
  expect(tidy('(shift+tab to cycle)', both)).toBe('')
  expect(tidy('esc to interrupt · ctrl+t to hide tasks', both)).toBe('ctrl+t to hide tasks')
  expect(tidy('? for shortcuts', both)).toBe('? for shortcuts')
  expect(tidy('esc to interrupt', { cycle: true, interrupt: false })).toBe('esc to interrupt')
  expect(tidy('(shift+tab to cycle) · ? for shortcuts', { cycle: false, interrupt: true })).toBe('(shift+tab to cycle) · ? for shortcuts')
  // Dropping again changes nothing.
  const once = tidy('(shift+tab to cycle) · esc to interrupt · ctrl+b to run in background', both)
  expect(once).toBe('ctrl+b to run in background')
  expect(tidy(once, both)).toBe(once)
})
