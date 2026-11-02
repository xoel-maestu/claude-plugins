# sub-meter

Subscription usage at the bottom right of the Claude Code prompt footer: the 5-hour and weekly windows.

```
5h ━━━─────── 31% ↻ 2h 10m
```

Beside [context-meter](../context-meter), the context meter comes first:

```
ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m
```

`/sub-meter` prints the windows as text:

```
5h      31%   resets in 2h 10m
week    12%   resets in 3d 18h
```

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
- [x] `/sub-meter` prints the windows as text. Tests: `/sub-meter prints the windows`, `/sub-meter in Spanish…`, `/sub-meter without a subscription…`.
- [ ] Manual, real session: with `sub-meter@better-claude` off, the figures match what it showed and the status line.

The hint parts are dropped whether or not the session has a subscription, as in the original. The hover card is for a later version.

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

Behaviour modelled on the sub-meter of [midudev/better-claude](https://github.com/midudev/better-claude) (MIT); the code is written from scratch.

## License

MIT © Xoel García Maestu
