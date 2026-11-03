// Pure logic, run with `claude plugin test .`: synthetic figures only.
import { expect, test } from 'claude-code/testing'

import { EMPTY, KEPT, add as addRaw, childrenOf, descendantsOf, labelOf, modelName, pathOf, seeTtl, since, sumOf, withMain } from './agents'
import { costAt } from './pricing'

const add = (state: Parameters<typeof addRaw>[0], info: Parameters<typeof addRaw>[1], u: Parameters<typeof addRaw>[2], at: number) =>
  addRaw(state, info, u, at, true, 'auto')

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
  expect(state.agents.map(({ cache, cost, ...rest }) => rest)).toEqual([
    { id: 'a2', label: 'reviewer', model: 'claude-sonnet-5-5', input: 10, output: 50, cacheRead: 0, cacheWrite: 9000, requests: 1, at: 3000,
      last: { input: 10, output: 50, cacheRead: 0, cacheWrite: 9000 }, isUnpriced: false },
    { id: 'a1', label: 'Explore', model: 'claude-haiku-5-5', input: 4, output: 314, cacheRead: 22_487, cacheWrite: 14_130, requests: 2, at: 2000,
      last: { input: 2, output: 148, cacheRead: 17_641, cacheWrite: 1335 }, isUnpriced: false },
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
  expect(modelName('claude-3-5-sonnet-20241022')).toBe('sonnet 3.5')
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

test("each agent's cost at list prices, its writes at the TTL its transcript shows", () => {
  let state = add(EMPTY, explore, usage(2, 4846, 12_795, 166), 1000)
  state = add(state, explore, usage(2, 17_641, 1335, 148), 2000)
  const cost = state.agents[0]!.cost
  // Haiku 5.5 up to 100k: input 0.10, 5m write 0.125, 1h write 0.20, read 0.01, output 0.50 per MTok.
  const base = (4 * 0.1 + 22_487 * 0.01 + 314 * 0.5) / 1e6
  expect(Math.abs(costAt(cost, '5m') - (base + 14_130 * 0.125 / 1e6)) < 1e-12).toBe(true)
  expect(Math.abs(costAt(cost, '1h') - (base + 14_130 * 0.2 / 1e6)) < 1e-12).toBe(true)
  expect(add(EMPTY, explore, usage(1, 1, 1, 1, 'other-model'), 1).agents[0]!.isUnpriced).toBe(true)
})

test("each agent's own cache: a loss when its prefix is not read back", () => {
  let state = add(EMPTY, explore, usage(2, 0, 30_000, 10), 0)
  state = add(state, explore, usage(2, 0, 30_000, 10), 60_000)
  expect(state.agents[0]!.cache.losses).toEqual([{ at: 60_000, lost: 30_000, cause: 'invalidated', gap: 60_000 }])
})

test("an agent's transcript TTL is its own, and the inference for the agents after it", () => {
  let state = add(EMPTY, explore, usage(2, 0, 30_000, 10), 0)
  state = seeTtl(state, 'a1', '5m')
  expect(state.agents[0]!.cache.observedTtl).toBe('5m')
  state = add(state, { id: 'a2', type: 'Plan' }, usage(2, 0, 30_000, 10), 10)
  expect(state.agents[0]!.cache).toMatchObject({ storedTtl: '5m' })
  expect(state.agents[0]!.cache.observedTtl).toBeUndefined()
  expect(seeTtl(state, 'unknown', '1h')).toBe(state)
})

test('a new agent infers 5m until a transcript shows a TTL; the inference survives a new session start', () => {
  const state = add(EMPTY, explore, usage(2, 0, 30_000, 10), 0)
  expect(state.agents[0]!.cache.storedTtl).toBe('5m')
  const seen = seeTtl(add(state, { id: 'a2', type: 'Plan' }, usage(2, 0, 30_000, 10), 1), 'a1', '1h')
  // a2 has no TTL of its own: it takes a1's as its inference.
  expect(seen.agents.find(row => row.id === 'a2')!.cache.storedTtl).toBe('1h')
  expect(since(seen, 99).lastTtl).toBe('1h')
})

test('the tree: children by parent, descendants at any depth, the path from the main thread', () => {
  let state = add(EMPTY, { id: 'a', type: 'Plan' }, usage(1, 0, 0, 1), 1)
  state = add(state, { id: 'b', type: 'Explore', parentId: 'a' }, usage(2, 0, 0, 1), 2)
  state = add(state, { id: 'c', type: 'Explore', parentId: 'b' }, usage(4, 0, 0, 1), 3)
  state = add(state, { id: 'd', type: 'Explore' }, usage(8, 0, 0, 1), 4)
  expect(childrenOf(state).map(row => row.id)).toEqual(['d', 'a'])
  expect(childrenOf(state, 'a').map(row => row.id)).toEqual(['b'])
  expect(descendantsOf(state, 'a').map(row => row.id)).toEqual(['b', 'c'])
  expect(descendantsOf(state).length).toBe(4)
  expect(pathOf(state, 'c').map(row => row.id)).toEqual(['a', 'b', 'c'])
  expect(pathOf(state, 'x')).toEqual([])
  expect(sumOf(descendantsOf(state, 'a')).input).toBe(6)
})
