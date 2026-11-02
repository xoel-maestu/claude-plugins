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

The meter is drawn in `SessionMode` (the footer row); the card is drawn in `AbovePrompt` (the band above the prompt). A card placed above the meter inside `SessionMode` was clipped in a real session (Claude Code 2.1.316, main screen): the footer lets about four rows rise above the meter's row, so the top border was lost and the rest sat over the prompt's border.

In `AbovePrompt` the hook returns what is beneath it (`next(e)`: the engine's node, another plugin's drawing) first and untouched, then an anchor `Box` as wide as the band (`e.props.bodyColumns`) and `height={0}`, so it adds no row. The card hangs from that anchor with `position="absolute"`, `bottom={0}` and `right={0}`: its bottom border is the band's last row, right above the prompt's top border, and its right edge is the band's. Out of the flow it moves nothing. With no figure, or while a survey holds the band, the hook returns `next(e)` as it came, so the band gets no row of its own. The card is a rounded, dim border, 40 columns wide, or as wide as the band where it is narrower. The anchor is a Box of its own because an engine node may not sit under a Box that sets a width.

The two sites are tied by a hover group: the meter's Box has `hover={{ scope: 'context-meter' }}` and the card is drawn `display="none"` with `hover={{ scope: 'context-meter', display: 'flex' }}`. Per the API, every element a plugin draws under one `scope`, in any site, lights while any of them is hovered, reveals included, so the card shows while the pointer is on the meter or on the card itself. No hook runs on hover. Since the card is no longer in the footer, a plugin drawn above the meter that sums what lies beneath it in `SessionMode` counts the meter alone.

`cardOf` builds the card as a list of rows (each a list of pieces with a tone: the meter's color, plain or dim) and derives the height from them; a later section is one more row. Each row is padded with spaces to the content width and the horizontal padding is drawn as spaces too, so every cell inside the border is written over what lies beneath: the theme has no background key to paint the Box with.

The band's body ends five columns before the terminal's edge (the engine keeps them for its `[-]` mark), and the footer's meter two before it, so the card's right edge sits three columns left of the meter's.

## Development

```
claude --plugin-dir plugins/context-meter
claude plugin validate plugins/context-meter
tsc -p plugins/context-meter
claude plugin test plugins/context-meter
```

`tsc -p` reads `.claude-plugin/types/`, which the engine writes when it loads the folder with `--plugin-dir`.

Inspired by the `SessionMode` pattern of [midudev/better-claude](https://github.com/midudev/better-claude) (MIT); the code is written from scratch.
