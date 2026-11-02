/**
 * A window as the meter draws it: `5h ━━━━━━──── 58% ↻ 2h 10m`. `reset` is the time left, empty
 * when unknown or past.
 */
export type Piece = { label: string; percent: string; reset: string }

/** The meter's three forms, widest first: with the bar, with the reset time, the label and percentage alone. */
export type Form = 'bar' | 'reset' | 'bare'

export const CELLS = 10
/** Between two windows, with display set to both. */
export const BETWEEN = ' | '
const FORMS: readonly Form[] = ['bar', 'reset', 'bare']

/** Columns a text takes: one per character, none for a variation selector. */
export const columns = (text: string) => [...text.replace(/[\uFE0E\uFE0F]/g, '')].length

const pieceWidth = (form: Form, p: Piece) =>
  columns(p.label) + 1 + columns(p.percent) +
  (form === 'bar' ? CELLS + 1 : 0) +
  (form !== 'bare' && p.reset !== '' ? 3 + columns(p.reset) : 0)

export function widthOf (form: Form, pieces: readonly Piece[]): number {
  return pieces.reduce((sum, p) => sum + pieceWidth(form, p), (pieces.length - 1) * BETWEEN.length)
}

/** The widest form that fits in `room` columns; null when not even the bare one fits. */
export const fit = (room: number, pieces: readonly Piece[]): Form | null =>
  FORMS.find(form => widthOf(form, pieces) <= room) ?? null

/** `cells` split into filled and empty for `percent`, rounded, clamped to 0..100. */
export function split (percent: number, cells = CELLS): { filled: number; empty: number } {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * cells)
  return { filled, empty: cells - filled }
}

// context-meter's rule, so the two meters share the row the same way whichever wraps the other
// (see its fit.ts and register.tsx): at most 14 columns; beside this meter it keeps its bar only
// with room for the bar, a separator and this meter's least form, counted as 8 columns.
export const CONTEXT_BUDGET = 14
export const LEAST = 8
export const SEPARATOR = ' · '

/**
 * Columns context-meter takes beside this meter for its fill (`62%`, `~62%` for an estimate) in a
 * row of `room` columns; 0 when it has no fill or not even its percentage fits.
 */
export function contextWidth (room: number, fill: { percent: number; isEstimate: boolean } | null | undefined): number {
  if (fill === null || fill === undefined) return 0
  const text = `${fill.isEstimate ? '~' : ''}${Math.round(fill.percent)}%`
  if (room >= CONTEXT_BUDGET + SEPARATOR.length + LEAST) return CONTEXT_BUDGET
  if (room >= 4 + text.length) return 4 + text.length
  return room >= text.length ? text.length : 0
}

/** Which parts of the hint line are dropped. */
export type Hides = { cycle: boolean; interrupt: boolean }

const CYCLE = /\([^()]* to cycle\)/g
const INTERRUPT = /esc to interrupt/g

/**
 * The hint line without the parts dropped, and without the empty parts and separators they leave;
 * the line as it came when it holds none of them. Dropping again changes nothing.
 */
export function tidy (hint: string, hides: Hides): string {
  let line = hint
  if (hides.cycle) line = line.replace(CYCLE, ' · ')
  if (hides.interrupt) line = line.replace(INTERRUPT, ' · ')
  if (line === hint) return hint
  return line.split('·').map(part => part.trim()).filter(Boolean).join(' · ')
}
