// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { EMPTY, KEPT, add, labelOf, modelName, since, withMain } from './agents'

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number, model = 'claude-haiku-5-5') =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output, model })
const explore = { id: 'a1', type: 'Explore' }

test('no agent yet: no rows, zero totals', () => {
  expect(EMPTY).toEqual({ agents: [], total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, requests: 0, count: 0 })
})

test("each agent's requests add up in its own row and in the total", () => {
  let state = add(EMPTY, explore, usage(2, 4846, 12_795, 166), 1000)
  state = add(state, explore, usage(2, 17_641, 1335, 148), 2000)
  state = add(state, { id: 'a2', type: 'general-purpose', name: 'reviewer' }, usage(10, 0, 9000, 50, 'claude-sonnet-5-5'), 3000)
  expect(state.agents).toEqual([
    { id: 'a2', label: 'reviewer', model: 'claude-sonnet-5-5', input: 10, output: 50, cacheRead: 0, cacheWrite: 9000, requests: 1, at: 3000 },
    { id: 'a1', label: 'Explore', model: 'claude-haiku-5-5', input: 4, output: 314, cacheRead: 22_487, cacheWrite: 14_130, requests: 2, at: 2000 },
  ])
  expect(state.total).toEqual({ input: 14, output: 364, cacheRead: 22_487, cacheWrite: 23_130 })
  expect(state.requests).toBe(3)
  expect(state.count).toBe(2)
})

test('the most recently active agent comes first', () => {
  let state = add(EMPTY, explore, usage(1, 0, 0, 1), 1000)
  state = add(state, { id: 'a2', type: 'Plan' }, usage(1, 0, 0, 1), 2000)
  state = add(state, explore, usage(1, 0, 0, 1), 3000)
  expect(state.agents.map(agent => agent.id)).toEqual(['a1', 'a2'])
})

test(`past ${KEPT} agents the oldest row goes, its tokens stay in the total and the count`, () => {
  let state = EMPTY
  for (let i = 0; i <= KEPT; i++) state = add(state, { id: `a${i}`, type: 'Explore' }, usage(1, 0, 0, 1), i)
  expect(state.agents).toHaveLength(KEPT)
  expect(state.agents.at(-1)!.id).toBe('a1')
  expect(state.count).toBe(KEPT + 1)
  expect(state.total.input).toBe(KEPT + 1)
})

test('the label: the name, else the description, else the type', () => {
  expect(labelOf({ type: 'general-purpose', name: 'reviewer', description: 'Review the diff' })).toBe('reviewer')
  expect(labelOf({ type: 'Explore', description: ' Count .ts files ' })).toBe('Count .ts files')
  expect(labelOf({ type: 'Explore', description: '' })).toBe('Explore')
  expect(labelOf({ type: '' })).toBe('agent')
})

test('rows are ordered by their last request start: a long request that ends last keeps its place', () => {
  let state = add(EMPTY, explore, usage(1, 0, 0, 1), 1000)
  state = add(state, { id: 'a2', type: 'Plan' }, usage(1, 0, 0, 1), 3000)
  // a1's second request started at 2000, before a2's, and is recorded after it.
  state = add(state, explore, usage(1, 0, 0, 1), 2000)
  expect(state.agents.map(agent => agent.id)).toEqual(['a2', 'a1'])
})

test('the model in short: family and version, without the prefix or a date', () => {
  expect(modelName('claude-haiku-5-5')).toBe('haiku 5.5')
  expect(modelName('claude-opus-5-5')).toBe('opus 5.5')
  expect(modelName('claude-sonnet-4-5-20250929')).toBe('sonnet 4.5')
  expect(modelName('claude-opus-4-1')).toBe('opus 4.1')
  expect(modelName('claude-fable-5-1[1m]')).toBe('fable 5.1')
  expect(modelName('claude-sonnet-4-20250514')).toBe('sonnet 4')
  expect(modelName('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022')
  expect(modelName('some-other-model')).toBe('some-other-model')
})

test('with the main thread: the counts of both together', () => {
  const state = add(EMPTY, explore, usage(10, 900, 100, 5), 1)
  expect(withMain(state, { input: 0, output: 1, cacheRead: 9000, cacheWrite: 1000 })).toEqual({ input: 10, output: 6, cacheRead: 9900, cacheWrite: 1100 })
})

test('a new session start empties it; the same start keeps it', () => {
  const state = { ...add(EMPTY, explore, usage(1, 0, 0, 1), 1), startedAt: 5 }
  expect(since(state, 5)).toBe(state)
  expect(since(state, 6)).toEqual({ ...EMPTY, startedAt: 6 })
})
