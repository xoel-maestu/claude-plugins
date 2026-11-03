import type { AgentInfo, TurnUsage } from 'claude-code'

import type { ContextMeterAgents, ContextMeterTtl } from '../types'
import { EMPTY as NO_CACHE, observe, observeTtl } from './cache'
import type { TtlSetting } from './cache'
import type { Counts } from './ledger'
import { NO_COST, familyOf, plusCost, requestCost } from './pricing'

export type Agents = ContextMeterAgents
export type Agent = Agents['agents'][number]

/** How many agents keep a row; an older one leaves its tokens in the total. */
export const KEPT = 50

const ZERO: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** No subagent request yet. */
export const EMPTY: Agents = { agents: [], total: ZERO, requests: 0, count: 0 }

const plus = (a: Counts, b: Counts): Counts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const countsOf = (usage: TurnUsage): Counts => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
})

/** An agent's own totals: the four counts summed over its requests. */
export const totalOf = (agent: Agent): Counts =>
  ({ input: agent.input, output: agent.output, cacheRead: agent.cacheRead, cacheWrite: agent.cacheWrite })

/**
 * What a row is called: the agent's name when it has one (what SendMessage addresses), else the
 * Agent call's description of its task (a few words, which tells two agents of one type apart),
 * else its type.
 */
export const labelOf = (info: Partial<Pick<AgentInfo, 'name' | 'type' | 'description'>>): string =>
  info.name || info.description?.trim() || info.type || 'agent'

/** `claude-haiku-5-5` → `haiku 5.5`, `claude-sonnet-4-5-20250929` → `sonnet 4.5`; another id as it is. */
export const modelName = (id: string): string => familyOf(id) ?? id

/**
 * A subagent's response to a request sent at `at`: added to its row (its last request, totals,
 * cost at list prices, and its own prompt cache, checked for a loss as the main thread's is) and to
 * the total. A new agent's cache takes the TTL another agent's transcript last showed, else 5m, as
 * an inference. Rows are ordered by their last request's start, newest first; past KEPT rows the
 * oldest goes, and the total and the count keep it.
 */
export function add (
  state: Agents,
  info: Pick<AgentInfo, 'id'> & Partial<Pick<AgentInfo, 'name' | 'type' | 'description' | 'parentId'>>,
  usage: TurnUsage,
  at: number,
  isSubscription: boolean,
  setting: TtlSetting,
): Agents {
  const counts = countsOf(usage)
  const before = state.agents.find(agent => agent.id === info.id)
  const price = requestCost(usage)
  // Until its transcript shows one, an agent's TTL is inferred: another agent's, else 5m (subagents
  // have been seen writing 5m entries on a subscription whose main thread writes 1h ones).
  const cacheBefore = before?.cache ?? { ...NO_CACHE, storedTtl: state.lastTtl ?? '5m' }
  const row: Agent = {
    id: info.id,
    ...(info.parentId === undefined ? {} : { parentId: info.parentId }),
    label: labelOf(info),
    model: usage.model,
    ...plus(before === undefined ? ZERO : totalOf(before), counts),
    requests: (before?.requests ?? 0) + 1,
    at,
    last: counts,
    cache: observe(cacheBefore, usage, at, isSubscription, setting),
    cost: price === null ? (before?.cost ?? NO_COST) : plusCost(before?.cost ?? NO_COST, price),
    isUnpriced: (before?.isUnpriced ?? false) || price === null,
  }
  return {
    ...state,
    agents: [row, ...state.agents.filter(agent => agent.id !== info.id)].sort((a, b) => b.at - a.at).slice(0, KEPT),
    total: plus(state.total, counts),
    requests: state.requests + 1,
    count: state.count + (before === undefined ? 1 : 0),
  }
}

/** The TTL an agent's transcript shows for its last cache write: its own, and the inference for agents to come. */
export function seeTtl (state: Agents, id: string, ttl: ContextMeterTtl): Agents {
  const agent = state.agents.find(row => row.id === id)
  if (agent === undefined || (agent.cache.observedTtl === ttl && state.lastTtl === ttl)) return state
  return {
    ...state,
    lastTtl: ttl,
    agents: state.agents.map(row => row.id === id ? { ...row, cache: observeTtl(row.cache, ttl) }
      // The others without a TTL of their own take it as their inference.
      : row.cache.observedTtl === undefined ? { ...row, cache: { ...row.cache, storedTtl: ttl } } : row),
  }
}

/** The main thread's counts and the subagents' together. */
export const withMain = (state: Agents, main: Counts): Counts => plus(state.total, main)

/** The agents of the session that began at `startedAt`: these if they are its, none otherwise (/clear); the TTL inference is kept. */
export const since = (state: Agents, startedAt: number): Agents =>
  state.startedAt === startedAt ? state : { ...EMPTY, startedAt, ...(state.lastTtl === undefined ? {} : { lastTtl: state.lastTtl }) }

/** The agents a loop spawned: the main thread's (`parentId` undefined) or that agent's, newest first. */
export const childrenOf = (state: Agents, parentId?: string): Agent[] =>
  state.agents.filter(agent => agent.parentId === parentId)

/** Every agent under a loop, at any depth: the main thread's are all of them. */
export function descendantsOf (state: Agents, parentId?: string): Agent[] {
  if (parentId === undefined) return state.agents
  const out: Agent[] = []
  for (let queue = childrenOf(state, parentId); queue.length > 0;) {
    const next = queue.shift()!
    if (out.includes(next)) continue
    out.push(next)
    queue.push(...childrenOf(state, next.id))
  }
  return out
}

/** The agents from the main thread's child down to `id`, itself last; empty when it has no row. */
export function pathOf (state: Agents, id: string): Agent[] {
  const path: Agent[] = []
  for (let at = state.agents.find(agent => agent.id === id); at !== undefined && !path.includes(at);) {
    path.unshift(at)
    at = at.parentId === undefined ? undefined : state.agents.find(agent => agent.id === at!.parentId)
  }
  return path
}

/** The counts summed over agents. */
export const sumOf = (rows: readonly Agent[]): Counts => rows.reduce((sum, row) => plus(sum, totalOf(row)), ZERO)
