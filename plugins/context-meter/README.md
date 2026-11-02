# context-meter

A Claude Code plugin that shows how full the context window is, at the bottom right of the prompt footer. Hover the meter for a card with the token breakdown, the prompt cache state and the session cost. `/context-meter` prints the same card as text.

## What it shows

The meter in the footer (here beside [sub-meter](../sub-meter), captured at 120 columns):

```text
⏵⏵ auto mode on · ← 5 agents                                                ctx ─────── 5% · 5h ━━━━━━━━── 83% ↻ 40m
```

The card, with the pointer on the meter:

```text
╭──────────────────────────────────────────────────────────────────────╮
│ Context   49.4k / 1M   5%                                            │
│ ━━━───────────────────────────────────────────────────────────────── │
│ Autocompact at ~967k                                                 │
│                Input   Cache read   Cache write   Uncached   Output  │
│ Last request   49.4k   34.2k        15.1k         2          4       │
│ Session        49.4k   34.2k        15.1k         2          4       │
│ Cache hit      69% of input read from cache                          │
│ Cost           ≈ $0.003 at API list prices (not billed on your plan) │
│ Cache          active until 06:20 (in 59m, TTL 1h)                   │
│ No cache losses this session                                         │
╰──────────────────────────────────────────────────────────────────────╯
```

- **Context**: tokens in the window over the model's window size, and the percentage. It is the figure Claude Code itself reports (the one the status line reads). Before the first response of a session, or after a resume, `/compact` or a rewind, the meter shows an estimate from the local context breakdown, marked with `~`, until the next response.
- **Autocompact at**: the point where auto-compaction starts. The row is left out when auto-compaction is off.
- **Last request** and **Session**: the main thread's tokens for its last response and summed over the session. **Input** is all the input, split into **Cache read**, **Cache write** and **Uncached**; **Output** is the response. Subagents are not counted here.
- **Cache hit**: the share of the session's input read from the prompt cache.
- **Cost**: the session's cost with all agents, as `/cost` reports it. It is an estimate at API list prices. On a subscription the row says it is not billed on your plan.
- **Cache**: when the prompt cache expires (`active until 06:20 (in 59m, TTL 1h)`, `expired 3m ago`, `no cache yet`).
- **Cache losses**: the last requests that did not read the previous cached prefix back, with the tokens lost and the cause: `/compact`, `model changed`, `idle <pause> > TTL`, or `invalidated (prompt or tools changed)`. The card shows the five newest; `/context-meter` shows ten. `/clear` starts the history over.

Colors: below `warnAt` the bar uses the theme's accent color; from `warnAt` the bar and the percentage use the warning color, and from `dangerAt` the error color.

When the footer is short the meter drops its bar (`ctx 5%`), then the `ctx` prefix (`5%`), then hides. It never wraps to a second line. When the band above the prompt is narrow, the card drops table columns (Uncached, then Cache write) and shortens its text; numbers and words are never cut.

## Install

```
/plugin marketplace add xoel-maestu/claude-plugins
/plugin install context-meter@xoel-plugins
```

The hover card needs a terminal with mouse reporting. `/context-meter` works in any terminal.

## Options

Set them in `/config`.

| Option | Default | Description |
| --- | --- | --- |
| `warnAt` | `50` | Context percentage from which the meter uses the warning color (1 to 100). |
| `dangerAt` | `75` | Context percentage from which the meter uses the error color (1 to 100). |
| `language` | `en` | Language of the card and of `/context-meter`: `en` or `es`. |
| `cacheTtl` | `auto` | Prompt cache lifetime used for the countdown and for idle losses: `auto`, `5m` or `1h`. |

With `cacheTtl` set to `auto`, the plugin reads the TTL of the last cache write from the session transcript. Until it has seen one it infers it (1h on a subscription, 5m otherwise) and marks it with `?`, as in `TTL 1h?`.

## How it works

- The meter is drawn in the footer row (`SessionMode`). The card is drawn in the band above the prompt (`AbovePrompt`), hidden until the pointer is on the meter or on the card. Both join one hover group, so no code runs on hover.
- The figure comes from `$.session.usage()`, read after each response and every 2 seconds, which catches resumes and rewinds.
- Token counts come from the `turn.step` hook, main thread only (requests with no `agentId`). They are kept in plugin state, so reloading the plugin keeps them, and `/clear` resets them.
- A request is a cache loss when the previous request's cached prefix (cache read plus cache write) is over 1024 tokens and this request reads back more than 1024 tokens less than it.
- The TTL is read from the end of the transcript file (the last 256 KiB, with `tail`; the whole file up to 4 MiB where `tail` is not available), only when the file has changed.
- The last TTL seen and whether the session is on a subscription are kept in the plugin store, so the next session starts with them.

With [sub-meter](../sub-meter) installed, the two meters share the footer row in the same order whichever loads first, and context-meter keeps its bar only while the row still has room for sub-meter.

## Development

```
claude --plugin-dir plugins/context-meter
claude plugin validate plugins/context-meter
claude plugin test plugins/context-meter
tsc -p plugins/context-meter
```

`tsc` compiles against `.claude-plugin/types/`, which Claude Code writes when it loads the plugin with `--plugin-dir`. Those files are not committed, so CI runs `validate` and `test` but not `tsc`.

## Credits

Inspired by [midudev/better-claude](https://github.com/midudev/better-claude) (MIT). The code is written from scratch.

## License

[MIT](../../LICENSE) © 2026 Xoel García Maestu
