# context-meter

The context window fill at the bottom right of the Claude Code prompt footer:

```
ctx ━━━━── 62%
```

Hover the meter to open a card with the detail; `/context-meter` prints the same rows as text.

```
╭──────────────────────────────────────╮
│ Context   124.3k / 200k   62%        │
│ ━━━━━━━━━━━━━━━━━━━━━━────────────── │
│ Autocompact at ~167k                 │
╰──────────────────────────────────────╯
```

## Install

```
/plugin install context-meter --marketplace xoel-maestu/claude-plugins
```

## What it shows

- The figure is the engine's own (`$.session.usage().context`), the one the status line reads.
- Before the first response of a window (fresh, resumed, compacted or rewound session) there is no figure: the meter counts the window once with the local summary breakdown (no requests) and marks it with `~` until the next response. The estimate is the breakdown's tokens over the model's window, the same denominator as the figure.
- The autocompact point comes from the same breakdown, read again with every estimate, when the window changes, and after a start, `/clear`, a compaction or an autocompact switch in `/config`; when auto-compaction is off or unknown its row is left out and the card is a row shorter.
- The figure is read again every 2 s (a free call), to catch resumes and rewinds.
- Colors: dim below `warnAt`, theme `warning` from `warnAt`, theme `error` from `dangerAt` (given the wrong way round, the two are swapped).
- Where the row is short the meter drops its bar (`ctx 62%`), then its prefix (`62%`), then itself. It takes 14 columns at most.

## Options (`/config`)

| Option | Default | |
| --- | --- | --- |
| `warnAt` | 50 | percentage for the warning color |
| `dangerAt` | 75 | percentage for the error color |
| `language` | `en` | `en` or `es`, for the card and `/context-meter` |

## How the card is drawn

The card is a `Box` inside the meter's keyed Box (`key="context-meter"`) in `SessionMode`: a rounded, dim border, 40 columns wide (less on a terminal narrower than 44), placed `position="absolute"` with `right={0}` and `top` at minus its height, so its bottom border sits on the row above the meter. It is drawn `display="none"` and revealed with `hover={{ display: 'flex' }}`; no hook runs on hover, and out of the flow it takes no width on the row.

`cardOf` builds it as a list of rows (each a list of pieces with a tone: the meter's color, plain or dim) and derives the height from them; a later section is one more row. Each row is padded with spaces to the content width and the horizontal padding is drawn as spaces too, so every cell inside the border is written over what lies beneath: the theme has no background key to paint the Box with.

If the footer clips the card, the fallback is to draw it in `AbovePrompt`, right aligned, and join the meter and the card with a shared `hover.scope`. Not done yet: pending a check in a real session.

## Development

```
claude --plugin-dir plugins/context-meter
claude plugin validate plugins/context-meter
tsc -p plugins/context-meter
claude plugin test plugins/context-meter
```

`tsc -p` reads `.claude-plugin/types/`, which the engine writes when it loads the folder with `--plugin-dir`.

Inspired by the `SessionMode` pattern of [midudev/better-claude](https://github.com/midudev/better-claude) (MIT); the code is written from scratch.
