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

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      fill: ContextMeterFill
      /** Token count at which auto-compaction runs, from the summary breakdown; null when unknown or off. */
      compactAt: number | null
    }
  }
}
