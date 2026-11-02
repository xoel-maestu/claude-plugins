/** One subscription window as the engine reported it: `percentUsed` 0 to 100, `resetsAt` an ISO 8601 time. */
export type SubMeterWindow = {
  kind: 'five_hour' | 'seven_day'
  percentUsed: number
  resetsAt?: string
}

/**
 * The last reading of the windows, from this session or another one: when it was taken (`at`,
 * `$.clock.now()` milliseconds) and by which session (`origin`, that session's `startedAt`).
 * null before any reading (off a subscription it stays null).
 */
export type SubMeterReading = {
  windows: SubMeterWindow[]
  at: number
  origin: number
} | null

/** Which parts of the hint line the meter drops; context-meter reads it to measure the same hint. */
export type SubMeterHides = {
  cycle: boolean
  interrupt: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'sub-meter': {
      /** The windows the meter shows; context-meter reads it to know the meter is drawn. */
      reading: SubMeterReading
      /** null until the first session start writes it. */
      hides: SubMeterHides | null
      /** Bumped by the rotation: which window `rotate` shows. */
      turn: number
      /** Bumped every 8 s, so the countdown is drawn again. */
      tick: number
    }
  }
}
