# sub-meter

Subscription usage at the bottom right of the Claude Code prompt footer: the 5-hour and weekly windows, with a hover card that adds the reset times, the pace and how old the reading is.

```
5h ━━━─────── 31% ↻ 2h 10m
```

Beside [context-meter](../context-meter), the context meter comes first:

```
ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m
```

With the pointer on the meter, a card opens in the band above the prompt, at its right end:

```
Subscription
5h      ━━━━━━━━━━━━━━──────  68%   resets 04:40 (in 2h 10m)
Week    ━━──────────────────  12%   resets Thu 21:00 (in 3d 18h)
Pace    at this pace, 5h reaches 100% at 03:50
        at this pace, the week won't reach 100% before reset
Read    <1m ago (another session)
```

`/sub-meter` prints the same rows as text, for a terminal without mouse reporting.

This sub-meter replaces the sub-meter of [midudev/better-claude](https://github.com/midudev/better-claude): both are named `sub-meter` and register `/sub-meter`, so install one or the other, not both.

## Install

```
/plugin install sub-meter --marketplace xoel-maestu/claude-plugins
```

## Behaviour

Parity with the sub-meter of [midudev/better-claude](https://github.com/midudev/better-claude): each point is a test in `hooks/*.test.ts(x)` or, where it needs a real session, a manual check.

- [x] 5-hour (`five_hour`) and weekly (`seven_day`) windows, read from `session.measure` and, at start, from `$.session.usage().rateLimits`; other kinds (a gateway's `spend_limit`) are ignored. Tests: `keeps the 5-hour and weekly windows…`, `other kinds are ignored…`, `the reading from session.measure replaces…`.
- [x] The reading is kept in `$.store` (`reading`: the windows, the time it was taken and the session that took it, by its `startedAt`); every open session reads it again every 8 s and takes it when it is newer, so a reading in one session shows in the others. A new session shows the stored reading before its first response. A failed read keeps the reading on screen. Tests: `a new session shows the stored reading…`, `another session's newer reading shows within 8 s…`, `a stored reading is taken only when well formed`. Manual: two sessions open share a reading within 8 s.
- [x] `display`: `rotate` (default), `both`, `session`, `week`; with a single window, every mode shows it. `rotateSeconds` (default 8, at least 1). Tests: `rotate switches window…`, `rotateSeconds sets the switch`, `display both…`, `display session…`, `display week…`, `rotate, both, session and week…`.
- [x] Bar (10 cells), percentage and `↻` with the time to the reset (`42m`, `2h 10m`, `3d 18h`); a window past its reset shows 0% and no reset time. The countdown is drawn again every 8 s. Tests: `shows the 5-hour window first…`, `a window past its reset…`, `the countdown is drawn again every 8 s`.
- [x] Colors: the filled bar in the theme's `claude` color (Anthropic orange), `warning` from 75%, `error` from 90%; the empty cells, the labels and the reset time dim; the percentage plain. Test: `colors: …`.
- [x] `hideCycleHint` and `hideInterruptHint` (both on by default) rewrite `PromptHint` without `(shift+tab to cycle)` and `esc to interrupt`; the meter measures the line as drawn. Tests: `hides "(shift+tab to cycle)"…`, `hideCycleHint and hideInterruptHint off…`, `drops the cycle and interrupt hints…`.
- [x] No subscription (no rate limits): draws nothing and passes the row on. Test: `no subscription…`.
- [x] Narrow footer: gives up the bar, then the reset time, then itself; never a second line. What is beneath that is hidden or placed out of the flow takes no room. Tests: `a narrow footer gives up…`, `counts what is beneath…`, `gives up the bar, then the reset time, then itself`. Manual: at 80 columns, no wrap.
- [x] Labels `5h` and `week` (Spanish, `language: es`: `5h` and `semana`). Test: `labels in Spanish…`.
- [x] `/sub-meter` prints the card as text. Tests: `/sub-meter prints the card as text`, `/sub-meter in Spanish…`, `/sub-meter without a subscription…`.
- [ ] Manual, real session: with `sub-meter@better-claude` off, the figures match what it showed and the status line.

The hint parts are dropped whether or not the session has a subscription, as in the original.

Beyond the original:

- A reading whose windows are all past their reset is not drawn, nor taken from the store, and leaves `$.state`, so context-meter keeps no room for it. Tests: `a reading with every window past its reset…`, `a stored reading past its reset…`.
- A session whose response comes without the two windows, before it ever had them (it is on an API key, say), drops the reading from the meter and from `$.store` and takes none from the store for the rest of the session; otherwise the last subscription reading would show there for good. A response is told by the measure carrying a context fill; the start, with no response yet, keeps the stored reading. Once the session had rate limits, a later measure without them changes nothing. Tests: `a response without rate limits, none seen before…`, `once this session had rate limits…`.

## The card

- **5h** and **Week** (Spanish **5h**, **Semana**): a 20-cell bar in the theme's `claude` color (`warning` from 75%, `error` from 90%, the empty cells dim), the percentage, and the reset as a local time, with the weekday when it is not today, and the time left (`se reinicia a las 04:40 (en 2h 10m)`, `el jue a las 21:00`). A window past its reset shows 0% and `reset` (`reiniciada`).
- **Pace** (**Ritmo**), from `hooks/pace.ts`, one row per window that has one: the window has run `elapsed = duration − (reset − now)` (5 h, 7 days); with `elapsed` under 10 minutes or 0% there is no row. At the pace so far (`percent / elapsed`) the window reaches 100% at `now + (100 − percent) / pace`: `at this pace, 5h reaches 100% at 03:55` (`a este ritmo, 5h llega al 100% a las 03:55`), with the weekday when not today; at or after the reset, `… won't reach 100% before reset` (`… no llega al 100% antes del reinicio`). Both windows get a row: each is short, and the band has the rows.
- **Read** (**Leído**): how long ago the reading was taken and whether by this session or another (`<1m ago (another session)`, `hace 3m (esta sesión)`), in whole minutes.
- The labels dim, the rest plain, in a rounded dim border.
- A narrow band: the bars give up to half their cells, then the reset tails shorten to `↻ 04:40`, then go, then the bars go; a pace or read row drops its opening (`at this pace, `, `(another session)`), then goes. No word or number is cut and no row wraps.
- Every text in the card changes at most once a minute. The 8 s tick works the card out and writes the time it is drawn for (`$.state` `now`) only when the text changes, so the band redraws only then.

It is drawn as context-meter draws its card (see its README, "How the card is drawn"): the meter's Box joins the hover group `sub-meter` (`hover={{ scope: 'sub-meter' }}`), and the card is drawn in `AbovePrompt` after what is beneath it (`next(e)`, kept whole: the engine's node, context-meter's card), in a holder as wide as the band, `justifyContent="flex-end"`, `display="none"` and `hover={{ scope: 'sub-meter', display: 'flex' }}`. The two plugins' groups differ, so each card opens with its own meter. With no reading to show, or while a survey holds the band, the band is passed on as it came. Tests: `the hover card, in the band…`, `beside context-meter's card…` (both orders).

## Beside context-meter

Both meters draw in `SessionMode`, each in a Box with its own `key` (`context-meter`, `sub-meter`), and the row is the same whichever plugin wraps the other: `ctx … · 5h … · <the engine's modes and other plugins>`.

- When context-meter's Box is beneath (context-meter is the inner one), sub-meter takes it out, with its separator, and draws it first.
- When sub-meter's Box is beneath, context-meter draws itself before it.
- Room: the terminal's width less the footer (26 columns), the hint line as sub-meter draws it and whatever else is beneath (not the other meter; hidden and out-of-flow nodes count nothing). context-meter takes 14 columns at most and keeps its bar only while the room holds it, a separator and sub-meter's least form (counted as 8 columns). sub-meter takes what is left after context-meter.
- Each needs to know the other's part even when it is the inner one and cannot see it, so each reads the other's `$.state` (any plugin may read any value): sub-meter reads context-meter's `fill` and works out its width by context-meter's rule (`contextWidth` in `hooks/fit.ts`); context-meter reads sub-meter's `reading` (drawn or not) and `hides` (which hint parts are dropped, so both measure the same hint line; context-meter applies the same `tidy`).

As the row narrows, in this order: sub-meter's bar goes, then its reset time, then context-meter's bar, then sub-meter, then context-meter's `ctx` prefix, then context-meter. With the usual hint (`? for shortcuts` once the cycle hint is dropped):

```
200  ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m
120  ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m
 80  ctx ━━━━── 62% · 5h 31% ↻ 2h 10m
 70  ctx ━━━━── 62% · 5h 31%
 66  ctx 62% · 5h 31%
 57  ctx 62%
 48  62%
```

The test kit loads no module from outside the plugin's folder, and an inline plugin is a single function, so each plugin's tests load a simulation of the other (its node shape and its `$.state` exactly) in both orders and assert this table.

## Options (`/config`)

| Option | Default | |
| --- | --- | --- |
| `display` | `rotate` | `rotate`, `both`, `session` or `week` |
| `rotateSeconds` | 8 | seconds per window with `rotate` (at least 1) |
| `hideCycleHint` | on | drop `(shift+tab to cycle)` from the hint line |
| `hideInterruptHint` | on | drop `esc to interrupt` from the hint line |
| `language` | `en` | `en` or `es`, for the labels and `/sub-meter` |

## Development

```
claude --plugin-dir plugins/sub-meter
claude plugin validate plugins/sub-meter
tsc -p plugins/sub-meter
claude plugin test plugins/sub-meter
```

`tsc -p` reads `.claude-plugin/types/`, which the engine writes when it loads the folder with `--plugin-dir`.

## Credits

Inspired by [midudev/better-claude](https://github.com/midudev/better-claude) (MIT); the code is written from scratch.

## License

MIT © Xoel García Maestu
