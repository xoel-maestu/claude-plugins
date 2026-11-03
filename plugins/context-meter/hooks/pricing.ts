import type { TurnUsage } from 'claude-code'

import type { ContextMeterTtl } from '../types'

/** US dollars per million tokens: base input, cache writes by TTL, cache reads, output. */
export type Rates = { input: number; write5m: number; write1h: number; read: number; output: number }

const rates = (input: number, write5m: number, write1h: number, read: number, output: number): Rates =>
  ({ input, write5m, write1h, read, output })

/**
 * Anthropic's published API list prices, by `<family> <version>`, as the pricing page gives them
 * (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-03). Haiku 5.5 is priced by
 * prompt length: `long` applies when a request's input (uncached, cache read and cache write) is
 * over 100,000 tokens.
 */
const TABLE: Record<string, Rates | { short: Rates; long: Rates }> = {
  'fable 5.1': rates(10, 12.5, 20, 0.25, 50),
  'mythos 5.1': rates(10, 12.5, 20, 0.25, 50),
  'fable 5': rates(10, 12.5, 20, 1, 50),
  'mythos 5': rates(10, 12.5, 20, 1, 50),
  'opus 5.5': rates(4, 5, 8, 0.2, 20),
  'opus 5': rates(5, 6.25, 10, 0.5, 25),
  'opus 4.8': rates(5, 6.25, 10, 0.5, 25),
  'opus 4.7': rates(5, 6.25, 10, 0.5, 25),
  'opus 4.6': rates(5, 6.25, 10, 0.5, 25),
  'opus 4.5': rates(5, 6.25, 10, 0.5, 25),
  'opus 4.1': rates(15, 18.75, 30, 1.5, 75),
  'opus 4': rates(15, 18.75, 30, 1.5, 75),
  'sonnet 5.5': rates(2, 2.5, 4, 0.1, 10),
  'sonnet 5': rates(2, 2.5, 4, 0.2, 10),
  'sonnet 4.6': rates(3, 3.75, 6, 0.3, 15),
  'sonnet 4.5': rates(3, 3.75, 6, 0.3, 15),
  'sonnet 4': rates(3, 3.75, 6, 0.3, 15),
  'haiku 5.5': { short: rates(0.1, 0.125, 0.2, 0.01, 0.5), long: rates(0.5, 0.625, 1, 0.05, 2.5) },
  'haiku 4.5': rates(1, 1.25, 2, 0.1, 5),
  'haiku 3.5': rates(0.8, 1, 1.6, 0.08, 4),
}

/** Haiku 5.5's long-prompt rates apply above this many input tokens. */
export const LONG_PROMPT = 100_000

/** `claude-haiku-5-5` → `haiku 5.5`, `claude-sonnet-4-5-20250929` → `sonnet 4.5`, `claude-3-5-haiku-20241022` → `haiku 3.5`; null for another id. */
export function familyOf (id: string): string | null {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id)
  if (match !== null) return `${match[1]} ${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`
  // The older form puts the version first: `claude-3-5-haiku-20241022`.
  const older = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?(?:\[.*\])?$/.exec(id)
  if (older !== null) return `${older[3]} ${older[1]}${older[2] === undefined ? '' : `.${older[2]}`}`
  return null
}

/** The rates for `model` on a request with `promptTokens` of input; null for a model the table lacks. */
export function priceOf (model: string, promptTokens: number): Rates | null {
  const family = familyOf(model)
  const entry = family === null ? undefined : TABLE[family]
  if (entry === undefined) return null
  return 'short' in entry ? (promptTokens > LONG_PROMPT ? entry.long : entry.short) : entry
}

/**
 * A cost in US dollars in parts: what does not depend on the TTL, and the cache writes at each
 * TTL; and, for what the cache saved, the output's part of `base` and what all the input would have
 * cost uncached (`plain`). The last two are absent in parts kept before they were counted.
 */
export type CostParts = { base: number; write5m: number; write1h: number; output?: number; plain?: number }

export const NO_COST: CostParts = { base: 0, write5m: 0, write1h: 0, output: 0, plain: 0 }

/**
 * One request's cost at list prices, in parts (its writes priced at both TTLs, for the one its
 * transcript shows to be picked later); null for a model the table lacks. Not the Batch API, fast
 * mode or `inference_geo` rates.
 */
export function requestCost (usage: TurnUsage): CostParts | null {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const rate = priceOf(usage.model, prompt)
  if (rate === null) return null
  return {
    base: (usage.input_tokens * rate.input + usage.cache_read_input_tokens * rate.read + usage.output_tokens * rate.output) / 1e6,
    write5m: (usage.cache_creation_input_tokens * rate.write5m) / 1e6,
    write1h: (usage.cache_creation_input_tokens * rate.write1h) / 1e6,
    output: (usage.output_tokens * rate.output) / 1e6,
    plain: (prompt * rate.input) / 1e6,
  }
}

export const plusCost = (a: CostParts, b: CostParts): CostParts => ({
  base: a.base + b.base,
  write5m: a.write5m + b.write5m,
  write1h: a.write1h + b.write1h,
  // A part kept before these were counted makes the sum's unknown too.
  ...(a.output === undefined || b.output === undefined ? {} : { output: a.output + b.output }),
  ...(a.plain === undefined || b.plain === undefined ? {} : { plain: a.plain + b.plain }),
})

/**
 * What the cache saved on input at `ttl`: what all the input would have cost uncached, less what it
 * cost (cache reads, cache writes at `ttl`, uncached); negative when the writes cost more than the
 * reads saved. Null for parts kept before this was counted.
 */
export function savedAt (parts: CostParts, ttl: ContextMeterTtl): { saved: number; plain: number } | null {
  if (parts.plain === undefined || parts.output === undefined) return null
  return { saved: parts.plain - (costAt(parts, ttl) - parts.output), plain: parts.plain }
}

/** The cost with the writes at `ttl`. */
export const costAt = (parts: CostParts, ttl: ContextMeterTtl): number => parts.base + (ttl === '1h' ? parts.write1h : parts.write5m)

/**
 * The context window of `model` in tokens, from Anthropic's context windows page
 * (https://platform.claude.com/docs/en/build-with-claude/context-windows, read 2026-11-03): 1M for
 * the models it lists, 200k for the others; null for an id that is not a Claude model's.
 */
export function windowOf (model: string): number | null {
  const family = familyOf(model)
  if (family === null) return null
  return MILLION.has(family) ? 1_000_000 : 200_000
}

const MILLION = new Set([
  'fable 5.1', 'mythos 5.1', 'fable 5', 'mythos 5', 'opus 5.5', 'opus 5', 'opus 4.8', 'opus 4.7', 'opus 4.6',
  'sonnet 5.5', 'sonnet 5', 'sonnet 4.6', 'haiku 5.5',
])
