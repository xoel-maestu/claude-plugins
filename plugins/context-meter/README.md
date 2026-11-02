# context-meter

The context window fill at the bottom right of the Claude Code prompt footer:

```
ctx ━━━━── 62%
```

Hover the meter to open a card with the detail; `/context-meter` prints the same card as text.

```
Context  124.3k / 200k  62%   autocompact at ~167k
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────
```

## Install

```
/plugin install context-meter --marketplace xoel-maestu/claude-plugins
```

## What it shows

- The figure is the engine's own (`$.session.usage().context`), the one the status line reads.
- Before the first response of a window (fresh, resumed, compacted or rewound session) there is no figure: the meter counts the window once with the local summary breakdown (no requests) and marks it with `~` until the next response.
- The autocompact point comes from the same breakdown; when auto-compaction is off or unknown the part is left out.
- The figure is read again every 2 s (a free call), to catch resumes and rewinds.
- Colors: dim below `warnAt`, theme `warning` from `warnAt`, theme `error` from `dangerAt`.
- Where the row is short the meter drops its bar (`ctx 62%`), then its prefix (`62%`), then itself. It takes 14 columns at most.

## Options (`/config`)

| Option | Default | |
| --- | --- | --- |
| `warnAt` | 50 | percentage for the warning color |
| `dangerAt` | 75 | percentage for the error color |
| `language` | `en` | `en` or `es`, for the card and `/context-meter` |

## How the card is drawn

The card is a `Box` inside the meter's keyed Box (`key="context-meter"`) in `SessionMode`, placed `position="absolute"` with `top={-2}` and `right={0}`, drawn `display="none"` and revealed with `hover={{ display: 'flex' }}`. No hook runs on hover.

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
