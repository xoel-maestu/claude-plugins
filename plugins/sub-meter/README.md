# sub-meter

A Claude Code plugin that shows your subscription usage at the bottom right of the prompt footer: the 5-hour and weekly windows, each with its percentage and the time to reset. Hover the meter for a card with the reset times, the pace and how old the reading is. `/sub-meter` prints the same card as text.

It shows nothing when the session has no subscription rate limits (an API key, for example).

## What it shows

The meter in the footer (here beside [context-meter](../context-meter), captured at 120 columns), showing the weekly window and then the 5-hour window:

```text
⏵⏵ auto mode on · ← 5 agents                                           ctx ─────── 5% · week ━━──────── 20% ↻ 3d 15h
⏵⏵ auto mode on · ← 5 agents                                                ctx ─────── 5% · 5h ━━━━━━━━── 83% ↻ 40m
```

The card, with the pointer on the meter:

```text
╭──────────────────────────────────────────────────────────────────╮
│ Subscription                                                     │
│ 5h      ━━━━━━━━━━━━━━━━━───  83%   resets 06:00 (in 40m)        │
│ Week    ━━━━────────────────  20%   resets Thu 21:00 (in 3d 15h) │
│ Pace    at this pace, 5h won't reach 100% before reset           │
│         at this pace, the week won't reach 100% before reset     │
│ Read    <1m ago (this session)                                   │
╰──────────────────────────────────────────────────────────────────╯
```

- **5h** and **Week**: the usage of each window, and when it resets, as a local time (with the weekday when it is not today) and as time left. A window past its reset shows 0%.
- **Pace**: at the rate used so far in the window, when it reaches 100%, or that it won't before the reset. A window that started less than 10 minutes ago, or is at 0%, gets no pace row.
- **Read**: how long ago the reading was taken, and whether by this session or another one.

Colors: the bar uses the theme's accent color, the warning color from 75% and the error color from 90%.

The reading is shared between sessions: each open session checks the plugin store every 8 seconds and takes a newer reading, and a new session shows the last reading before its first response. A reading whose windows have all reset is not shown.

When the footer is short the meter drops its bar, then the reset time, then hides. It never wraps to a second line. To make room, it also removes `(shift+tab to cycle)` and `esc to interrupt` from the hint line (see the options).

## Install

```
/plugin marketplace add xoel-maestu/claude-plugins
/plugin install sub-meter@xoel-plugins
```

This plugin replaces the sub-meter of [midudev/better-claude](https://github.com/midudev/better-claude). Both use the name `sub-meter` and the command `/sub-meter`, so keep only one of them enabled.

The hover card needs a terminal with mouse reporting. `/sub-meter` works in any terminal.

## Uninstall

```
/plugin uninstall sub-meter@xoel-plugins
```

## Options

Set them in `/config`.

| Option | Default | Description |
| --- | --- | --- |
| `display` | `rotate` | `rotate`: the 5-hour and weekly windows in turn. `both`: side by side. `session`: the 5-hour window only. `week`: the weekly window only. |
| `rotateSeconds` | `8` | Seconds each window shows with `display` set to `rotate` (at least 1). |
| `hideCycleHint` | `true` | Remove `(shift+tab to cycle)` from the hint line. |
| `hideInterruptHint` | `true` | Remove `esc to interrupt` from the hint line while Claude works. |
| `language` | `en` | Language of the labels and of `/sub-meter`: `en` or `es`. |

## How it works

- The windows (`five_hour` and `seven_day`) come from the `session.measure` hook and, at start, from `$.session.usage().rateLimits`. Other limit kinds are ignored.
- The reading is kept in the plugin store with the time it was taken, which is how other sessions pick it up.
- The meter is drawn in the footer row (`SessionMode`). The card is drawn in the band above the prompt (`AbovePrompt`), hidden until the pointer is on the meter or on the card. Both join one hover group, so no code runs on hover.
- If a session gets two main-thread responses without rate limits before it ever had them, the meter hides in that session. The stored reading is left alone for other sessions.

### Beside context-meter

With [context-meter](../context-meter) installed, the row reads `ctx … · 5h … · <the footer's own items>` whichever plugin loads first. As the row narrows, parts go in this order: sub-meter's bar, its reset time, context-meter's bar, sub-meter, the `ctx` prefix, context-meter. With the usual hint line, by terminal width:

```text
200  ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m
120  ctx ━━━━── 62% · 5h ━━━─────── 31% ↻ 2h 10m
 80  ctx ━━━━── 62% · 5h 31% ↻ 2h 10m
 70  ctx ━━━━── 62% · 5h 31%
 66  ctx 62% · 5h 31%
 57  ctx 62%
 48  62%
```

This table is asserted by the tests, not captured from a terminal.

## Development

```
claude --plugin-dir plugins/sub-meter
claude plugin validate plugins/sub-meter
claude plugin test plugins/sub-meter
tsc -p plugins/sub-meter
```

`tsc` compiles against `.claude-plugin/types/`, which Claude Code writes when it loads the plugin with `--plugin-dir`. Those files are not committed, so CI runs `validate` and `test` but not `tsc`.

## Credits

Inspired by the sub-meter of [midudev/better-claude](https://github.com/midudev/better-claude) (MIT). The code is written from scratch.

## License

[MIT](../../LICENSE) © 2026 Xoel García Maestu
