// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { MAX_LINES, isoLocal, lineOf, sessionOf, timelineOf, withLine } from './timeline'

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number, model = 'claude-sonnet-5-5') =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, model })

test('a main-thread line: counts, hit, TTL, cost at list prices, the loss with its rewrite and extra, the tools', () => {
  const line = JSON.parse(lineOf({
    at: Date.UTC(2026, 10, 3, 17, 14, 2, 123),
    session: 's1',
    usage: usage(2, 31_277, 18_511, 4),
    ttl: '1h',
    isTtlInferred: false,
    loss: { at: 0, lost: 17_593, cause: 'compact', gap: 30_000, cost: { write5m: 1, write1h: 0.0686127 }, rewrite: { write5m: 2, write1h: 0.070372 } },
    tools: [{ name: 'Bash', ms: 1200.4 }, { name: 'Read', ms: 3 }],
  }))
  expect(line).toMatchObject({
    schema: 1, session: 's1', scope: 'main', model: 'claude-sonnet-5-5',
    input: 2, cacheRead: 31_277, cacheWrite: 18_511, output: 4, hit: 0.6282, ttl: '1h',
    loss: { cause: 'compact', lost: 17_593, gapMs: 30_000, rewrite: 0.070372, extra: 0.068613 },
    tools: [{ name: 'Bash', ms: 1200 }, { name: 'Read', ms: 3 }],
  })
  // Sonnet 5.5 at 1h: 2 × 2 + 31,277 × 0.10 + 18,511 × 4 + 4 × 10 per MTok.
  expect(line.cost).toBe(Number(((4 + 3127.7 + 74_044 + 40) / 1e6).toFixed(6)))
  expect(line.ttlInferred).toBeUndefined()
  expect(line.agent).toBeUndefined()
})

test("an agent's line names its id and type; an inferred TTL says so; a model off the price table has no cost", () => {
  const line = JSON.parse(lineOf({ at: 0, session: 's1', agent: { id: 'a1', type: 'Explore' }, usage: usage(1, 0, 10, 1, 'other'), ttl: '5m', isTtlInferred: true, tools: [] }))
  expect(line).toMatchObject({ scope: 'agent', agent: 'a1', agentType: 'Explore', ttl: '5m', ttlInferred: true })
  expect(line.cost).toBeUndefined()
  expect(line.tools).toBeUndefined()
  expect(line.loss).toBeUndefined()
})

test('a line holds no text: only the fixed keys, and strings only for ids, names, the model, the TTL and the time', () => {
  const line = JSON.parse(lineOf({
    at: 0, session: 's1', agent: { id: 'a1', type: 'Explore' }, usage: usage(1, 2, 3, 4), ttl: '5m', isTtlInferred: false,
    loss: { at: 0, lost: 1, cause: 'model', gap: 1 }, tools: [{ name: 'Grep', ms: 1 }],
  }))
  const keys = new Set(['schema', 'at', 'session', 'scope', 'agent', 'agentType', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'hit', 'ttl', 'ttlInferred', 'cost', 'loss', 'tools'])
  expect(Object.keys(line).every(key => keys.has(key))).toBe(true)
  expect(Object.keys(line.loss)).toEqual(['cause', 'lost', 'gapMs'])
  expect(Object.keys(line.tools[0])).toEqual(['name', 'ms'])
})

test(`the file keeps the newest ${MAX_LINES} lines`, () => {
  const lines = Array.from({ length: MAX_LINES }, (_, i) => String(i))
  const next = withLine(lines, 'new')
  expect(next).toHaveLength(MAX_LINES)
  expect(next[0]).toBe('1')
  expect(next.at(-1)).toBe('new')
})

test('the timeline sits in the session folder beside the transcript; the session id is its name', () => {
  expect(timelineOf('/p/s1.jsonl')).toBe('/p/s1/context-meter.jsonl')
  expect(timelineOf('/p/s1')).toBeUndefined()
  expect(sessionOf('/p/abc-123.jsonl')).toBe('abc-123')
})

test('times are local with their offset', () => {
  expect(isoLocal(0)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000[+-]\d\d:\d\d$/)
})
