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
- **Cost**: the session's cost with all agents, as `/cost` reports it, to four decimals under a dollar as `/cost` prints it. It is an estimate at API list prices. On a subscription the row says it is not billed on your plan.
- **Cache**: when the prompt cache expires (`active until 06:20 (in 59m, TTL 1h)`, `expired 3m ago`, `no cache yet`).
- **Cache losses**: the last requests that did not read the previous cached prefix back, with the tokens lost and the cause: `/compact`, `model changed`, `idle <pause> > TTL`, or `invalidated (prompt or tools changed)`. The card shows the five newest; `/context-meter` shows ten. `/clear` starts the history over.
- **Agents**: one row per subagent or teammate of the session, the most recently active first (five in the card, up to 50 in `/context-meter`), named by its name, else the task description the Agent call gave it, else its type: its requests, input (split into cache read, cache write and uncached, as in the table above), output, cache hit and the model of its last response. **All agents** sums every subagent, and **Overall** sums the main thread and the subagents together. The section shows only when a subagent has answered; the engine's own forks (memory, for example) are not in it.
- **An agent's card**: click an agent's name in the card to see the same rows for it alone: its last request and session, cache hit, cost, its prompt cache (TTL and expiry) and its cache losses; `‹ Main` goes back. While an agent's transcript is open (from the tasks list) the card shows that agent, and a click moves the view. `/context-meter 2` or `/context-meter reviewer` prints an agent's card, by its place in the list or by name.
  - An agent's **cost** is worked out from its token counts at Anthropic's published [API list prices](https://platform.claude.com/docs/en/about-claude/pricing) (read 2026-11-03), with Haiku 5.5's higher rates for prompts over 100,000 tokens and each cache write at the agent's TTL. It is not the Batch API, fast mode or `inference_geo` rates. A model the table lacks is left out, and the amount then reads `≥`.
  - An agent's **TTL** is read from its own transcript (`<session>/subagents/agent-<id>.jsonl`). Until it shows one, it is inferred (`?`): the TTL another agent's transcript last showed, else 5m. Subagents have been seen writing 5-minute entries on a subscription whose main thread writes 1-hour ones.

Colors: below `warnAt` the bar uses the theme's accent color; from `warnAt` the bar and the percentage use the warning color, and from `dangerAt` the error color.

When the footer is short the meter drops its bar (`ctx 5%`), then the `ctx` prefix (`5%`), then hides. It never wraps to a second line. When the band above the prompt is narrow, the card drops table columns (Uncached, then Cache write; in Agents: Model, Uncached, Cache write, Output, Requests, then Cache read) and shortens its text; numbers and words are never cut. An agent's name longer than 24 characters ends in `…`.

## Install

```
/plugin marketplace add xoel-maestu/claude-plugins
/plugin install context-meter@xoel-plugins
```

The hover card needs a terminal with mouse reporting. `/context-meter` works in any terminal.

## Uninstall

```
/plugin uninstall context-meter@xoel-plugins
```

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
- Token counts come from the `turn.step` hook: requests with no `agentId` are the main thread's; one whose `agentId` `$.agent.list()` names is a subagent's; any other is the engine's own and is not counted. Up to 50 agents keep a row; an older one stays in the totals. They are kept in plugin state, so reloading the plugin keeps them, and `/clear` resets them. A compaction's own summarizer request is not a `turn.step`, so it is never counted as the session's work.
- Input is uncached input plus cache read plus cache write, and the hit rate is cache read over that input: the total input of Anthropic's [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
- The cache is timed from the start of each main-thread request, as those docs time it: an entry lives for its TTL from the start of the request that wrote or read it, and each read starts it over. The idle time behind an `idle` loss is counted between request starts.
- A request is a cache loss when the previous request's cached prefix (cache read plus cache write) is over 1024 tokens and this request reads back more than 1024 tokens less than it. The 1024 is a noise floor chosen by this plugin, not an API rule: the smallest cacheable prompt is 512 to 4,096 tokens depending on the model.
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

Inspired by [midudev/better-claude](https://github.com/midudev/better-claude) (MIT). A few small helpers are adapted from it.

## License

[MIT](../../LICENSE) © 2026 Xoel García Maestu
