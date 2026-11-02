// Pure logic, run with `claude plugin test .`: no engine involved. Every figure is synthetic.
import { expect, test } from 'claude-code/testing'

import { ago, cardOf, cardText } from './card'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// Local times, so the clock texts read the same in any time zone: Monday 2 November 2026, 02:30.
const NOW = new Date(2026, 10, 2, 2, 30).getTime()
const at = (ms: number) => new Date(ms).toISOString()
// The 5-hour window resets at 04:40 (in 2h 10m); the weekly one on Thursday at 21:00 (in 3d 18h).
const five = (percentUsed: number) => ({ kind: 'five_hour' as const, percentUsed, resetsAt: at(new Date(2026, 10, 2, 4, 40).getTime()) })
const week = (percentUsed: number) => ({ kind: 'seven_day' as const, percentUsed, resetsAt: at(new Date(2026, 10, 5, 21, 0).getTime()) })
const reading = (percents = [68, 12], origin = 7) => ({ windows: [five(percents[0]!), week(percents[1]!)], at: NOW - 12_000, origin })
const bar = (filled: number, cells = 20) => '━'.repeat(filled) + '─'.repeat(cells - filled)

test('the card at its widest: windows, pace for each, how old the reading is', () => {
  expect(cardText({ reading: reading(), now: NOW, origin: 0 }, 'en')).toBe([
    'Subscription',
    `5h      ${bar(14)}  68%   resets 04:40 (in 2h 10m)`,
    `Week    ${bar(2)}  12%   resets Thu 21:00 (in 3d 18h)`,
    // 68% in 2h 50m: the other 32% in 80 minutes. 12% in 3d 5h 30m: far past the reset.
    'Pace    at this pace, 5h reaches 100% at 03:50',
    "        at this pace, the week won't reach 100% before reset",
    'Read    <1m ago (another session)',
  ].join('\n'))
})

test('in Spanish, a pace that reaches 100% on another day, a reading of this session', () => {
  // 50% in 3d 5h 30m: the other 50% by Thursday at 08:00.
  expect(cardText({ reading: reading([68, 50], 0), now: NOW, origin: 0 }, 'es')).toBe([
    'Suscripción',
    `5h      ${bar(14)}  68%   se reinicia a las 04:40 (en 2h 10m)`,
    `Semana  ${bar(10)}  50%   se reinicia el jue a las 21:00 (en 3d 18h)`,
    'Ritmo   a este ritmo, 5h llega al 100% a las 03:50',
    '        a este ritmo, la semana llega al 100% el jue a las 08:00',
    'Leído   hace <1m (esta sesión)',
  ].join('\n'))
})

test('a window past its reset shows 0% and reset, and no pace; a stale reading shows no card', () => {
  const later = NOW + 3 * HOUR
  const text = cardText({ reading: reading(), now: later, origin: 0 }, 'en')!.split('\n')
  expect(text[1]).toBe(`5h      ${bar(0)}   0%   reset`)
  expect(text.filter(row => row.includes('5h reaches') || row.includes("5h won't"))).toEqual([])
  expect(text.at(-1)).toBe('Read    3h00m ago (another session)')
  expect(cardOf({ reading: reading(), now: NOW + 4 * 24 * HOUR, origin: 0 }, 'en')).toBeNull()
  expect(cardOf({ reading: null, now: NOW, origin: 0 }, 'en')).toBeNull()
})

const rowsAt = (width: number, language: 'en' | 'es' = 'en') => {
  const card = cardOf({ reading: reading(), now: NOW, origin: 0 }, language, width)!
  // Every row is exactly the content's width, and the card no wider than the band.
  for (const row of card.rows) expect(row.map(cell => cell.text).join('').length).toBe(card.content)
  expect(card.width).toBeLessThanOrEqual(width)
  expect(card.height).toBe(card.rows.length + 2)
  return card.rows.map(row => row.map(cell => cell.text).join('').trimEnd())
}

test('at 60 columns the bars give up cells, then the tails shorten; a long pace line drops its opening', () => {
  expect(rowsAt(60)).toEqual([
    'Subscription',
    `5h      ${bar(8, 12)}  68%   resets 04:40 (in 2h 10m)`,
    `Week    ${bar(1, 12)}  12%   resets Thu 21:00 (in 3d 18h)`,
    'Pace    at this pace, 5h reaches 100% at 03:50',
    "        the week won't reach 100% before reset",
    'Read    <1m ago (another session)',
  ])
  expect(rowsAt(60, 'es')).toEqual([
    'Suscripción',
    `5h      ${bar(14)}  68%   ↻ 04:40`,
    `Semana  ${bar(2)}  12%   ↻ jue 21:00`,
    'Ritmo   a este ritmo, 5h llega al 100% a las 03:50',
    '        la semana no llega al 100% antes del reinicio',
    'Leído   hace <1m (otra sesión)',
  ])
})

test('at 30 columns: no tails, a shorter bar, rows that do not fit left out, no word cut', () => {
  expect(rowsAt(30)).toEqual([
    'Subscription',
    `5h      ${bar(9, 13)}  68%`,
    `Week    ${bar(2, 13)}  12%`,
    'Read    <1m ago',
  ])
  // Below half a bar it goes; with no room for a percentage, no card.
  expect(rowsAt(24)).toEqual(['Subscription', '5h       68%', 'Week     12%', 'Read    <1m ago'])
  expect(cardOf({ reading: reading(), now: NOW, origin: 0 }, 'en', 15)).toBeNull()
})

test('the bar is colored by the percentage, the labels and empty cells dim', () => {
  const tones = (percent: number) => cardOf({ reading: reading([percent, 12]), now: NOW, origin: 0 }, 'en')!.rows[1]!.map(cell => cell.tone)
  expect(tones(68)).toEqual(['dim', 'claude', 'dim', 'plain', 'plain', 'plain'])
  expect(tones(75)[1]).toBe('warning')
  expect(tones(90)[1]).toBe('error')
})

test('how long ago, in whole minutes', () => {
  expect(ago(12_000)).toBe('<1m')
  expect(ago(-5)).toBe('<1m')
  expect(ago(59 * MINUTE + 59_000)).toBe('59m')
  expect(ago(67 * MINUTE)).toBe('1h07m')
})
