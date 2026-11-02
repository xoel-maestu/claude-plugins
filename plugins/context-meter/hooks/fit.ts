/** The meter's three forms, widest first: `ctx ━━━━── 62%`, `ctx 62%`, `62%`. */
export type Form = 'bar' | 'short' | 'bare'

/** The most columns the meter takes, in its widest form. */
export const BUDGET = 14

const PREFIX = 'ctx '
const FORMS: readonly Form[] = ['bar', 'short', 'bare']

/** `62%`, or `~62%` for an estimate. */
export const label = (percent: number, isEstimate: boolean) =>
  `${isEstimate ? '~' : ''}${Math.round(percent)}%`

/** Bar cells left inside the budget once the prefix, a space and the label are counted. */
const cellsFor = (text: string) => BUDGET - PREFIX.length - 1 - text.length

export function widthOf (form: Form, text: string): number {
  if (form === 'bar') return BUDGET
  if (form === 'short') return PREFIX.length + text.length
  return text.length
}

/** sub-meter's least form (`5h 31%`), counted as 8 columns: beside it the bar needs room for it too. */
export const SUB_LEAST = 8

/**
 * The widest form that fits in `room` columns; null when not even the label fits. `reserve` columns
 * more are needed for the bar (a separator and sub-meter's least form, when it draws beside it).
 */
export const fit = (room: number, text: string, reserve = 0): Form | null =>
  FORMS.find(form => widthOf(form, text) + (form === 'bar' ? reserve : 0) <= room) ?? null

/** Which parts of the hint line sub-meter drops. */
export type Hides = { cycle: boolean; interrupt: boolean }

const CYCLE = /\([^()]* to cycle\)/g
const INTERRUPT = /esc to interrupt/g

/**
 * The hint line as sub-meter draws it (the same rule as its `tidy`): without the parts dropped and
 * the empty parts and separators they leave. Dropping again changes nothing.
 */
export function tidy (hint: string, hides: Hides): string {
  let line = hint
  if (hides.cycle) line = line.replace(CYCLE, ' · ')
  if (hides.interrupt) line = line.replace(INTERRUPT, ' · ')
  if (line === hint) return hint
  return line.split('·').map(part => part.trim()).filter(Boolean).join(' · ')
}

/** How many of the bar's cells are filled for `percent`, and how many are left. */
export function barOf (percent: number, text: string): { filled: number; empty: number } {
  return split(percent, cellsFor(text))
}

/** `cells` split into filled and empty for `percent`, rounded, clamped to 0..100. */
export function split (percent: number, cells: number): { filled: number; empty: number } {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * cells)
  return { filled, empty: cells - filled }
}
