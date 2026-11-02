import type { SubMeterReading, SubMeterWindow } from '../types'

import { columns, split } from './fit'
import { isStale, percentAt, resetIn, until } from './limits'
import { paceOf } from './pace'

export type Language = 'en' | 'es'

/** How a piece of a row is drawn: the theme's text, dim, or a theme color (the filled bar). */
export type Tone = 'plain' | 'dim' | 'claude' | 'warning' | 'error'
export type Cell = { text: string; tone: Tone }
export type Row = Cell[]
/** A row's tail: its full text, then a shorter one for a narrow band. */
type Tail = { full: string; short: string }

/** The card's rows inside a rounded border; `width` counts the border and padding, `content` does not. */
export type Card = { width: number; content: number; height: number; rows: Row[] }

/** What the card shows: the reading, the time it is drawn for, and this session's origin. */
export type CardView = { reading: SubMeterReading; now: number; origin: number }

/** The bar's cells; where the band is short it gives up to half of them before a tail shortens. */
export const BAR = 20
const LEAST_BAR = BAR / 2
/** A border column and a padding column at each side. */
const FRAME = 4
/** The label column: the labels and a gap. */
const LABEL = 8
const GAP = '   '

type Say = (day: string | undefined, hm: string) => string
/** `04:40`, `Thu 21:00`: the short form of a reset time. */
const bare: Say = (day, hm) => (day === undefined ? hm : `${day} ${hm}`)

type Words = {
  title: string
  labels: Record<SubMeterWindow['kind'], string>
  /** The window as a pace sentence names it. */
  names: Record<SubMeterWindow['kind'], string>
  pace: string
  read: string
  days: readonly string[]
  /** A local time and its weekday when not today, as a reset and as a pace sentence say it. */
  resetTime: Say
  paceTime: Say
  resets: (time: string, left: string) => string
  reset: string
  reaches: (name: string, time: string) => string
  notReaching: (name: string) => string
  /** Before a pace sentence, dropped where the band is short. */
  atThisPace: string
  ago: (ago: string, isThis: boolean) => Tail
}

const WORDS: Record<Language, Words> = {
  en: {
    title: 'Subscription',
    labels: { five_hour: '5h', seven_day: 'Week' },
    names: { five_hour: '5h', seven_day: 'the week' },
    pace: 'Pace',
    read: 'Read',
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    resetTime: bare,
    paceTime: (day, hm) => (day === undefined ? `at ${hm}` : `at ${day} ${hm}`),
    resets: (time, left) => `resets ${time} (in ${left})`,
    reset: 'reset',
    reaches: (name, time) => `${name} reaches 100% ${time}`,
    notReaching: name => `${name} won't reach 100% before reset`,
    atThisPace: 'at this pace, ',
    ago: (ago, isThis) => ({ full: `${ago} ago (${isThis ? 'this' : 'another'} session)`, short: `${ago} ago` }),
  },
  es: {
    title: 'Suscripción',
    labels: { five_hour: '5h', seven_day: 'Semana' },
    names: { five_hour: '5h', seven_day: 'la semana' },
    pace: 'Ritmo',
    read: 'Leído',
    days: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    resetTime: (day, hm) => (day === undefined ? `a las ${hm}` : `el ${day} a las ${hm}`),
    paceTime: (day, hm) => (day === undefined ? `a las ${hm}` : `el ${day} a las ${hm}`),
    resets: (time, left) => `se reinicia ${time} (en ${left})`,
    reset: 'reiniciada',
    reaches: (name, time) => `${name} llega al 100% ${time}`,
    notReaching: name => `${name} no llega al 100% antes del reinicio`,
    atThisPace: 'a este ritmo, ',
    ago: (ago, isThis) => ({ full: `hace ${ago} (${isThis ? 'esta' : 'otra'} sesión)`, short: `hace ${ago}` }),
  },
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** A local time and, when it falls on another day than `now`, its weekday. */
function clockOf (at: number, now: number, words: Words, say: Say): string {
  const date = new Date(at)
  const day = date.toDateString() === new Date(now).toDateString() ? undefined : words.days[date.getDay()]
  return say(day, `${pad2(date.getHours())}:${pad2(date.getMinutes())}`)
}

/** `<1m`, `41m`, `1h07m`: how long ago, in whole minutes, so the text changes once a minute. */
export function ago (ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1m'
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${pad2(m % 60)}m`
}

const widthOfRow = (row: Row) => row.reduce((sum, cell) => sum + columns(cell.text), 0)
const label = (text: string): Cell => ({ text: text.padEnd(LABEL), tone: 'dim' })
const toneFor = (percent: number): Tone => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'claude')

/** A row with a label and a tail: the full tail where it fits `room`, else the short one, else no row. */
function tailed (text: string, tail: Tail, room: number): Row[] {
  for (const option of [tail.full, tail.short]) {
    const row: Row = [label(text), { text: option, tone: 'plain' }]
    if (widthOfRow(row) <= room) return [row]
  }
  return []
}

/**
 * The card for `view`, at most `width` columns wide border included: the title, a row per window
 * (bar, percentage, reset time and time left), a pace row per window that has a pace, and how old the
 * reading is. Where the band is short the window rows' bars give up to half their cells, then their
 * tails shorten (`↻ 04:40`), then go, then the bars go; a pace or read row shortens, then goes. No
 * word or number is cut. Null with no reading, a stale one, or no room for a window's percentage.
 */
export function cardOf (view: CardView, language: Language, width = Infinity): Card | null {
  const { reading, now, origin } = view
  if (reading === null || isStale(reading, now)) return null
  const words = WORDS[language]
  const room = width - FRAME

  const windows = reading.windows.map(w => {
    const percent = percentAt(w, now)
    const left = resetIn(w, now)
    const tail: Tail | null = left !== undefined
      ? { full: words.resets(clockOf(now + left, now, words, words.resetTime), until(left)), short: `↻ ${clockOf(now + left, now, words, bare)}` }
      : w.resetsAt !== undefined ? { full: words.reset, short: words.reset } : null
    return { w, percent, tail, figure: `${Math.round(percent)}%`.padStart(4) }
  })
  // The bar and the tails are chosen for every window row together, so the bars line up: the full
  // tails, else the short ones, with at least half the bar; else no tails, and the bar where it fits.
  const fixed = LABEL + 1 + 4
  if (room < LABEL + 4) return null
  const tailsOf = (level: 'full' | 'short' | 'none') =>
    windows.map(({ tail }) => (tail === null || level === 'none' ? '' : GAP + tail[level]))
  const level = (['full', 'short'] as const).find(l => room - fixed - Math.max(...tailsOf(l).map(columns)) >= LEAST_BAR) ?? 'none'
  const tails = tailsOf(level)
  const cells = Math.min(BAR, room - fixed - Math.max(...tails.map(columns)))
  const bar = cells >= LEAST_BAR ? cells : 0

  const rows: Row[] = []
  if (columns(words.title) <= room) rows.push([{ text: words.title, tone: 'plain' }])
  for (const [i, { w, percent, figure }] of windows.entries()) {
    const cells = split(percent, bar)
    const row: Row = [label(words.labels[w.kind])]
    if (bar > 0) row.push({ text: '━'.repeat(cells.filled), tone: toneFor(percent) }, { text: '─'.repeat(cells.empty), tone: 'dim' })
    row.push({ text: (bar > 0 ? ' ' : '') + figure, tone: 'plain' })
    if (tails[i] !== '') row.push({ text: tails[i]!, tone: 'plain' })
    rows.push(row)
  }
  const paces = reading.windows.flatMap(w => {
    const pace = paceOf(w, now)
    if (pace === null) return []
    const sentence = pace.isReaching
      ? words.reaches(words.names[w.kind], clockOf(pace.at, now, words, words.paceTime))
      : words.notReaching(words.names[w.kind])
    return [{ full: words.atThisPace + sentence, short: sentence }]
  })
  for (const [i, pace] of paces.entries()) rows.push(...tailed(i === 0 ? words.pace : '', pace, room))
  rows.push(...tailed(words.read, words.ago(ago(now - reading.at), reading.origin === origin), room))

  const content = Math.min(room, Math.max(...rows.map(widthOfRow)))
  const padded = rows.map(row => {
    const left = content - widthOfRow(row)
    return left > 0 ? [...row, { text: ' '.repeat(left), tone: 'plain' as const }] : row
  })
  return { width: content + FRAME, content, height: padded.length + 2, rows: padded }
}

/** The card's rows as plain text, for /sub-meter: at its widest. Null with no reading to show. */
export function cardText (view: CardView, language: Language): string | null {
  const card = cardOf(view, language)
  return card === null ? null : card.rows.map(row => row.map(cell => cell.text).join('').trimEnd()).join('\n')
}
