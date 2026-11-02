import type { ContextMeterTtl } from '../types'

/** `$.fs.read` rejects a file over 4 MiB: the whole-file fallback skips a transcript past it. */
export const MAX_READ = 4 * 1024 * 1024
/** The bytes read from the transcript's end with `tail -c`: many responses' worth of JSONL. */
export const TAIL = 256 * 1024

/**
 * The complete lines of a file's last bytes: when the file is longer than what was read, the first
 * line may be cut and is dropped.
 */
export function completeLines (tail: string, isCut: boolean): string {
  if (!isCut) return tail
  const first = tail.indexOf('\n')
  return first === -1 ? '' : tail.slice(first + 1)
}

type Entry = {
  type?: unknown
  isSidechain?: unknown
  agentId?: unknown
  message?: { usage?: { cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } } }
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * The TTL the last main-thread response of a session transcript (JSONL) wrote its cache with: `1h`
 * when it wrote 1h tokens, `5m` when it wrote 5m tokens, null when it wrote none (a pure read) or
 * there is no such response. Read from the end, line by line; a line that is not JSON, not an
 * assistant entry, a sidechain's (a subagent's) or without `usage.cache_creation` is skipped.
 */
export function lastTtl (text: string): ContextMeterTtl | null {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    end = start - 1
    // Cheap checks before parsing: most lines are not usage entries.
    if (!line.includes('"cache_creation"') || !line.includes('"assistant"')) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object' || entry.type !== 'assistant') continue
    if (entry.isSidechain === true || (typeof entry.agentId === 'string' && entry.agentId !== '')) continue
    const creation = entry.message?.usage?.cache_creation
    if (creation === undefined || creation === null || typeof creation !== 'object') continue
    if (count(creation.ephemeral_1h_input_tokens) > 0) return '1h'
    if (count(creation.ephemeral_5m_input_tokens) > 0) return '5m'
    return null
  }
  return null
}
