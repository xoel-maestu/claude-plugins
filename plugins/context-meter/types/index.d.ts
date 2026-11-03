/**
 * The context window fill the meter shows: the engine's figure from the last response, or, while it
 * has none (a fresh, resumed, compacted or rewound session), an estimate from the local breakdown
 * (`isEstimate`). `tokens` is absent when the source gives only a percentage. null when there is neither.
 */
export type ContextMeterFill = {
  percent: number
  tokens?: number
  window: number
  isEstimate: boolean
} | null

/** The four token counts of a response, or their sum over the session, as the API reports them. */
export type ContextMeterCounts = {
  /** Uncached input. */
  input: number
  output: number
  /** Input the prompt cache served. */
  cacheRead: number
  /** Input written to the prompt cache. */
  cacheWrite: number
}

/**
 * The main thread's requests this session: the last response's counts, its model and when it came
 * (`at`, `$.clock.now()` milliseconds), the totals and how many. `startedAt` is the session start
 * (`$.session.usage().startedAt`) the ledger counts from: a new one (/clear) starts it over.
 */
export type ContextMeterLedger = {
  startedAt?: number
  last?: ContextMeterCounts & { model: string; at: number }
  /** The request before the last, for the hit rate's trend. */
  previous?: ContextMeterCounts & { model: string; at: number }
  total: ContextMeterCounts
  requests: number
  /** The counts and requests by the model that answered; absent in a ledger written before it was kept. */
  models?: Record<string, ContextMeterModel>
}

/**
 * The subagents' requests this session (loops `$.agent.list()` names; the engine's own forks are
 * not counted): a row per agent, most recently active first (at most 50), with its label (name, else
 * task description, else type), the model of its last response, when that request started, its
 * totals, its last request, its own prompt cache (losses included), its cost at list prices in parts
 * (`isUnpriced` when a request's model was not in the price table); the totals over every agent,
 * how many requests and agents, and the TTL an agent's transcript last showed. `startedAt` as in
 * the ledger.
 */
export type ContextMeterAgents = {
  startedAt?: number
  agents: (ContextMeterCounts & {
    id: string
    /** The agent that spawned it; absent when the main thread did. */
    parentId?: string
    label: string
    model: string
    requests: number
    at: number
    last: ContextMeterCounts
    /** The request before the last, and its model, for the hit rate's trend. */
    previous?: ContextMeterCounts & { model: string }
    cache: ContextMeterCache
    cost: { base: number; write5m: number; write1h: number; output?: number; plain?: number }
    isUnpriced: boolean
    /** Its counts and requests by the model that answered. */
    models?: Record<string, ContextMeterModel>
  })[]
  total: ContextMeterCounts
  requests: number
  count: number
  /** Every agent's counts and requests by the model that answered, past the kept rows too. */
  models?: Record<string, ContextMeterModel>
  lastTtl?: ContextMeterTtl
}

/** One model's counts and requests, and their cost at list prices in parts (`isUnpriced`: a request was of a model the price table lacks). */
export type ContextMeterModel = ContextMeterCounts & {
  requests: number
  cost?: { base: number; write5m: number; write1h: number; output?: number; plain?: number }
  isUnpriced?: boolean
}

/** A cache loss: when, the tokens of the previous prefix not read back, the first cause that held, and the pause before it (ms). */
export type ContextMeterLoss = {
  at: number
  lost: number
  cause: 'compact' | 'model' | 'expired' | 'invalidated'
  gap: number
  /**
   * What the loss cost (`extra` on the card), at list prices, at each TTL: the lost tokens the
   * request wrote again, at the write rate less the read rate they would have cost had the cache
   * held, at the answering model's rates. Absent for a model the price table lacks or a loss kept
   * before this was counted.
   */
  cost?: { write5m: number; write1h: number }
  /** What writing those tokens again cost in all, at each TTL (`cost` is that less reading them). */
  rewrite?: { write5m: number; write1h: number }
}

/** A prompt cache lifetime. */
export type ContextMeterTtl = '5m' | '1h'

/**
 * The main thread's prompt cache this session: the previous request's cached prefix (cache read
 * plus cache write), model and time; whether a main-thread compaction came since; whether the
 * session has rate limits (a subscription) and whether a hit past a 5 minute pause showed a 1h TTL;
 * the TTL the last main-thread cache write used, as the session transcript records it
 * (`observedTtl`, absent until one is read; kept across /clear); the 10 newest losses, newest first; when /clear
 * started it over. `startedAt` as in the ledger.
 */
export type ContextMeterCache = {
  startedAt?: number
  last?: { prefix: number; model: string; at: number }
  isCompactPending: boolean
  isSubscription: boolean
  isLongSeen: boolean
  observedTtl?: ContextMeterTtl
  /** The TTL an earlier session last observed, from `$.store`: an inference until this session observes one. */
  storedTtl?: ContextMeterTtl
  /** Whether `isSubscription` is this session's own reading rather than the stored one. */
  isSubscriptionKnown?: boolean
  losses: ContextMeterLoss[]
  clearedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      fill: ContextMeterFill
      /** Token count at which auto-compaction runs, from the summary breakdown; null when unknown or off. */
      compactAt: number | null
      /** The main thread's token counts this session; survives a reload, /clear empties it. */
      ledger: ContextMeterLedger
      /** The subagents' token counts this session; survives a reload, /clear empties it. */
      agents: ContextMeterAgents
      /** What the session has cost in US dollars (`$.session.usage().cost.usd`); null when the host has no figure. */
      cost: number | null
      /** The main thread's prompt cache and its losses; survives a reload, /clear starts it over. */
      cache: ContextMeterCache
      /** The time the card's cache countdown was last drawn for; written only when that line changes. */
      now: number
      /** The main thread's cache as the footer warns of it; null with no cache. Written only when it changes. */
      alert: 'fresh' | 'expiring' | 'expired' | null
    }
  }
}
