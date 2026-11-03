// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { trendOf } from './trend'

const request = (input: number, cacheRead: number, cacheWrite: number, model = 'model-a') =>
  ({ input, cacheRead, cacheWrite, output: 10, model })

test('up and down in whole points against the request before, on one model', () => {
  expect(trendOf(request(0, 92, 8), request(0, 88, 12))).toEqual({ kind: 'steady', percent: 92, delta: 4 })
  expect(trendOf(request(0, 60, 40), request(0, 88, 12))).toEqual({ kind: 'steady', percent: 60, delta: -28 })
  expect(trendOf(request(0, 50, 50), request(0, 50, 50))).toEqual({ kind: 'steady', percent: 50, delta: 0 })
})

test('another model: a switch, no change counted, even after a request with no input; no comparable earlier request: none', () => {
  expect(trendOf(request(0, 10, 90, 'model-b'), request(0, 90, 10))).toEqual({ kind: 'switch', percent: 10 })
  expect(trendOf(request(0, 10, 90, 'model-b'), request(0, 0, 0))).toEqual({ kind: 'switch', percent: 10 })
  expect(trendOf(request(0, 90, 10))).toBeNull()
  expect(trendOf(request(0, 90, 10), request(0, 0, 0))).toBeNull()
})

test('a last request that sent no input has no trend', () => {
  expect(trendOf(request(0, 0, 0), request(0, 90, 10))).toBeNull()
})
