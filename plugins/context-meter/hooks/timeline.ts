import type { TurnUsage } from 'claude-code'

import type { ContextMeterLoss, ContextMeterTtl } from '../types'
import { hitRate } from './ledger'
import { costAt, requestCost } from './pricing'

/** How many lines the file keeps: the oldest go first. */
export const MAX_LINES = 5000

/** A tool the loop ran after its previous request, and how long it took. */
export type ToolTime = { name: string; ms: number }

/**
 * One request as the timeline records it: numbers, ids and names only (the model, the tool names,
 * the agent's type; an MCP tool's or a custom agent's are the names given to them), never the text
 * of a prompt, a response, a tool's input or its output.
 */
export type TimelineInput = {
  at: number
  session: string
  agent?: { id: string; type: string }
  usage: TurnUsage
  ttl: ContextMeterTtl
  isTtlInferred: boolean
  loss?: ContextMeterLoss
  tools: ToolTime[]
}

const round = (n: number, digits: number) => Number(n.toFixed(digits))

/** `2026-11-03T18:14:02.123+01:00`: local time with its offset. */
export function isoLocal (ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, len = 2) => String(Math.abs(n)).padStart(len, '0')
  const offset = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** The JSON line for one request (see TimelineInput); `cost` at list prices at `ttl`, absent for a model the price table lacks. */
export function lineOf (input: TimelineInput): string {
  const { usage } = input
  const counts = { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }
  const hit = hitRate(counts)
  const price = requestCost(usage)
  const pick = (parts: { write5m: number; write1h: number } | undefined) =>
    parts === undefined ? undefined : round(input.ttl === '1h' ? parts.write1h : parts.write5m, 6)
  const loss = input.loss
  return JSON.stringify({
    schema: 1,
    at: isoLocal(input.at),
    session: input.session,
    scope: input.agent === undefined ? 'main' : 'agent',
    ...(input.agent === undefined ? {} : { agent: input.agent.id, agentType: input.agent.type }),
    model: usage.model,
    ...counts,
    ...(hit === null ? {} : { hit: round(hit, 4) }),
    ttl: input.ttl,
    ...(input.isTtlInferred ? { ttlInferred: true } : {}),
    ...(price === null ? {} : { cost: round(costAt(price, input.ttl), 6) }),
    ...(loss === undefined ? {} : {
      loss: {
        cause: loss.cause,
        lost: loss.lost,
        gapMs: loss.gap,
        ...(typeof loss.rewrite === 'object' ? { rewrite: pick(loss.rewrite) } : {}),
        ...(typeof loss.cost === 'object' ? { extra: pick(loss.cost) } : {}),
      },
    }),
    ...(input.tools.length === 0 ? {} : { tools: input.tools.map(tool => ({ name: tool.name, ms: Math.round(tool.ms) })) }),
  })
}

/** The file's lines with `line` added, the oldest past MAX_LINES dropped. */
export const withLine = (lines: readonly string[], line: string): string[] => [...lines, line].slice(-MAX_LINES)

/** A session's timeline beside its transcript: `<dir>/<session>.jsonl` → `<dir>/<session>/context-meter.jsonl`. */
export const timelineOf = (sessionPath: string): string | undefined =>
  sessionPath.endsWith('.jsonl') ? `${sessionPath.slice(0, -'.jsonl'.length)}/context-meter.jsonl` : undefined

/** The session id a transcript's file name carries: `<dir>/<id>.jsonl`. */
export const sessionOf = (sessionPath: string): string =>
  sessionPath.slice(sessionPath.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
