import type { AgentInfo, TurnUsage } from 'claude-code'

import type { ContextMeterAgents } from '../types'
import type { Counts } from './ledger'

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

/**
 * What a row is called: the agent's name when it has one (what SendMessage addresses), else the
 * Agent call's description of its task (a few words, which tells two agents of one type apart),
 * else its type.
 */
export const labelOf = (info: Partial<Pick<AgentInfo, 'name' | 'type' | 'description'>>): string =>
  info.name || info.description?.trim() || info.type || 'agent'

/** `claude-haiku-5-5` → `haiku 5.5`, `claude-sonnet-4-5-20250929` → `sonnet 4.5`; another id as it is. */
export function modelName (id: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id)
  if (match === null) return id
  return `${match[1]} ${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`
}

/**
 * A subagent's response at `at` (its request's start): added to its row and to the total. Rows are
 * ordered by their last request's start, newest first; past KEPT rows the oldest goes, and the
 * total and the count keep it.
 */
export function add (state: Agents, info: Pick<AgentInfo, 'id'> & Partial<Pick<AgentInfo, 'name' | 'type' | 'description'>>, usage: TurnUsage, at: number): Agents {
  const counts = countsOf(usage)
  const before = state.agents.find(agent => agent.id === info.id)
  const row: Agent = {
    id: info.id,
    label: labelOf(info),
    model: usage.model,
    ...plus(before ?? ZERO, counts),
    requests: (before?.requests ?? 0) + 1,
    at,
  }
  return {
    ...state,
    agents: [row, ...state.agents.filter(agent => agent.id !== info.id)].sort((a, b) => b.at - a.at).slice(0, KEPT),
    total: plus(state.total, counts),
    requests: state.requests + 1,
    count: state.count + (before === undefined ? 1 : 0),
  }
}

/** The main thread's counts and the subagents' together. */
export const withMain = (state: Agents, main: Counts): Counts => plus(state.total, main)

/** The agents of the session that began at `startedAt`: these if they are its, none otherwise (/clear). */
export const since = (state: Agents, startedAt: number): Agents =>
  state.startedAt === startedAt ? state : { ...EMPTY, startedAt }
