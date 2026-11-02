// Transcript parsing, run with `claude plugin test .`: synthetic JSONL lines only.
import { expect, test } from 'claude-code/testing'

import { lastTtl } from './transcript'

/** A main-thread (or, with `extra`, another) assistant entry writing `m5` and `h1` tokens to the cache. */
const assistant = (m5: number, h1: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  message: { role: 'assistant', usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: m5 + h1, cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 }, output_tokens: 10 } },
  ...extra,
})
const user = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'synthetic' } })
const jsonl = (...lines: string[]) => lines.join('\n') + '\n'

test('the last main-thread entry that wrote 1h tokens reads 1h', () => {
  expect(lastTtl(jsonl(user, assistant(500, 0), user, assistant(0, 17_000)))).toBe('1h')
})

test('the last main-thread entry that wrote 5m tokens reads 5m', () => {
  expect(lastTtl(jsonl(assistant(0, 17_000), user, assistant(1200, 0)))).toBe('5m')
})

test('both 5m and 1h written reads 1h', () => {
  expect(lastTtl(jsonl(assistant(300, 400)))).toBe('1h')
})

test('a pure read (nothing written) gives null, so the previous TTL is kept', () => {
  expect(lastTtl(jsonl(assistant(0, 17_000), assistant(0, 0)))).toBeNull()
})

test('malformed lines, other entry types and a missing trailing newline are skipped', () => {
  const text = [assistant(0, 9000), '{"type":"assistant","message":{"usage":{"cache_creation":', 'not json', user, '{"type":"api-request"}'].join('\n')
  expect(lastTtl(text)).toBe('1h')
  expect(lastTtl(assistant(800, 0))).toBe('5m')
  expect(lastTtl('')).toBeNull()
  expect(lastTtl('\n\n')).toBeNull()
})

test("a sidechain's (a subagent's) entry is ignored", () => {
  expect(lastTtl(jsonl(assistant(0, 17_000), assistant(1500, 0, { isSidechain: true })))).toBe('1h')
  expect(lastTtl(jsonl(assistant(0, 17_000), assistant(1500, 0, { agentId: 'a1' })))).toBe('1h')
  expect(lastTtl(jsonl(assistant(1500, 0, { isSidechain: true })))).toBeNull()
})

test('an assistant entry without the cache_creation breakdown is skipped', () => {
  const old = JSON.stringify({ type: 'assistant', message: { usage: { cache_creation_input_tokens: 50 } }, note: '"cache_creation"' })
  expect(lastTtl(jsonl(assistant(700, 0), old))).toBe('5m')
})
