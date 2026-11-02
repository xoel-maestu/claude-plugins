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
  total: ContextMeterCounts
  requests: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      fill: ContextMeterFill
      /** Token count at which auto-compaction runs, from the summary breakdown; null when unknown or off. */
      compactAt: number | null
      /** The main thread's token counts this session; survives a reload, /clear empties it. */
      ledger: ContextMeterLedger
      /** What the session has cost in US dollars (`$.session.usage().cost.usd`); null when the host has no figure. */
      cost: number | null
    }
  }
}
