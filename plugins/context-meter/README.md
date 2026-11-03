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
- **Cache hit**: the share of the session's input read from the prompt cache, then the last request's own share against the request before it: `↑4` and `↓28` in points, `=` unchanged, `(model switch)` when another model answered it (another model's cache is not comparable). Left out when there is no request before it to compare with (none, or one that sent no input on the same model); shortened to `· 92% ↑4` where the band is narrow, then dropped.
- **Cost**: the session's cost with all agents, as `/cost` reports it, to four decimals under a dollar as `/cost` prints it. It is an estimate at API list prices. On a subscription the row says it is not billed on your plan.
- **Cache saved**: what the prompt cache saved on input at API list prices. A cache write costs more than sending the tokens uncached (1.25× the base input rate at 5m, 2× at 1h) and a read far less (0.1×, 0.05× on Opus 5.5 and Sonnet 5.5, 0.025× on Fable 5.1 and Mythos 5.1), so a prefix pays off once it is read back. The row is what all the input would have cost uncached (at the base input rate), less what it cost (cache reads, cache writes at each thread's TTL, uncached input), and that as a share of the uncached cost (`68% less than without the cache`). It is negative (`12% more than without the cache`) when the writes cost more than the reads saved, and left out when it rounds to nothing. The main thread's card covers the requests the plugin sees (the main thread's and every agent's), an agent's card the agent alone. Claude Code's own requests are not in it, nor in Models: a compaction's summary, titles and suggestions. The Cost row, Claude Code's own figure, includes them. It is left out when a model is not in the price table (the figure would be partial).
- **Cache**: when the prompt cache expires (`active until 06:20 (in 59m, TTL 1h)`, `expired 3m ago`, `no cache yet`).
- **Cache losses**: the last requests that did not read the previous cached prefix back, with the tokens lost, what getting them back cost at the answering model's list prices, and the cause. `rewrite` is what writing the lost tokens again cost in all (rewritten × the write rate of the TTL in force; a compaction writes fewer than it lost); `extra` is what that cost beyond reading them, had the cache held (rewritten × (write rate − read rate)): what the loss cost. Where the band is too narrow for a loss line, every line keeps only `extra`, so the columns stay aligned; a cause shortens only on a line that does not fit. The causes: `/compact`, `model changed`, `idle <pause> > TTL`, or `invalidated (prompt or tools changed)`. The card shows the five newest; `/context-meter` shows ten. `/clear` starts the history over.
- **Agents**: one row per subagent or teammate of the session, the most recently active first (five in the card, up to 50 in `/context-meter`), named by its name, else the task description the Agent call gave it, else its type: its requests, input (split into cache read, cache write and uncached, as in the table above), output, cache hit and the model of its last response. **Subagents total** sums every subagent under the card's loop, at any depth, and **Main + subagents** (in an agent's card, **This agent + subagents**) adds the loop itself. The section shows only when a subagent has answered; the engine's own forks (memory, for example) are not in it.
- **Models**: when more than one model answered in the card's loop or under it, one row per model with the same columns as Agents, the most requests first, and its **Cost** at API list prices, worked out from its token counts with each thread's cache writes at that thread's TTL (`–` for a model the price table lacks). A model is counted under the model that answered each request, so an agent that switched models counts under both. Counts kept by an earlier version, which did not tally models, leave the section out until a new session.
- **An agent's card**: click an agent's name in the card to see the same card for it alone: its context, last request and session, cache hit, cost, its prompt cache (TTL and expiry), its cache losses, and the agents it spawned when it spawned any. A path at the top (`Main › lead › scout`) goes back up; each step is pressable. The main thread's card is framed in the theme's accent color, a subagent's in another, a subagent's subagent in a third. While an agent's transcript is open (from the tasks list) the card shows that agent, and a click moves the view. `/context-meter 2` or `/context-meter reviewer` prints an agent's card, by its place in the main card's list or by name (any agent, at any depth). A card picked with a click stays until `Main` is pressed or a new message is sent.
  - An agent's **cost** is worked out from its token counts at Anthropic's published [API list prices](https://platform.claude.com/docs/en/about-claude/pricing) (read 2026-11-03), with Haiku 5.5's higher rates for prompts over 100,000 tokens and each cache write at the agent's TTL. It is not the Batch API, fast mode or `inference_geo` rates. A model the table lacks is left out, and the amount then reads `≥`.
  - An agent's **TTL** is read from its own transcript (`<session>/subagents/agent-<id>.jsonl`). Until it shows one, it is inferred (`?`): the TTL another agent's transcript last showed, else 5m. Subagents have been seen writing 5-minute entries on a subscription whose main thread writes 1-hour ones.

Colors: below `warnAt` the bar uses the theme's accent color; from `warnAt` the bar and the percentage use the warning color, and from `dangerAt` the error color. The `ctx` prefix warns of the main thread's prompt cache: the warning color in the last tenth of its TTL (at least 30 seconds: the last 30 s of 5m, the last 6 minutes of 1h), the error color once it has expired, so the next message will write the cache anew. Without the prefix (a short footer) there is no alert; `cacheAlert` turns it off.

When the footer is short the meter drops its bar (`ctx 5%`), then the `ctx` prefix (`5%`), then hides. It never wraps to a second line. When the band above the prompt is narrow, the card drops table columns (Uncached, then Cache write; in Agents: Model, Uncached, Cache write, Output, Requests, then Cache read) and shortens its text; numbers and words are never cut. An agent's name longer than 24 characters ends in `…`.

## Where each figure comes from

Every figure is read from Claude Code where Claude Code reports it, so it follows any change Anthropic makes without an update of this plugin:

| Figure | Source |
| --- | --- |
| Tokens (every count, main thread and agents) | The API's usage on each response (`turn.step`) |
| Context and window of the main thread, autocompact point | `$.session.usage()`, the status line's figures |
| Cost of the session | `$.session.usage().cost`, as `/cost` reports it |
| Cache TTL (main thread and each agent) | The `cache_creation` split of the last write in the session's or the agent's own transcript |

Claude Code reports neither a model's context window other than the session model's, nor the cost of a single response. Where an agent needs one of those, the plugin falls back to Anthropic's published tables, read 2026-11-03, and marks the figure as inferred:

| Figure | Fallback |
| --- | --- |
| Window of an agent on another model than the session's | [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows): 1M for the models listed there, 200k for the others; shown with `?` |
| Cost of an agent, cost by model, what the cache saved | [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), applied to the token counts. `/cost` shows a cost by model, but Claude Code gives plugins no field for it: only running `/cost`, which writes its output into the transcript each time. These costs leave out Claude Code's own requests (titles, suggestions), which `/cost` includes |
| TTL of an agent whose transcript shows none yet | Another agent's, else 5m; shown with `?` |

A per-agent cost taken as the change in the session's cost around each of its responses was tried and dropped: Claude Code's own requests (titles, suggestions) land between them and are invisible to plugins, so they were charged to whichever agent answered next.

## Timeline

With `timeline` on, every request (the main thread's and each agent's) adds one JSON line to `context-meter.jsonl` in the session's folder, beside its transcript (`~/.claude/projects/<project>/<session>/context-meter.jsonl`, under `CLAUDE_CONFIG_DIR` where that is set). Lines are added as requests finish (sort by `at` for the order they were sent). The file keeps the newest 5,000 lines and stays with the session's folder; one that exists but cannot be read (over 4 MiB) is left alone. A line holds numbers, ids and names only: the model, the tool names and the agent's type, which for an MCP tool or a custom agent are the names given to them. Never the text of a prompt, a response, or a tool's input or output:

| Field | |
| --- | --- |
| `schema` | `1` |
| `at` | When the request started, local time with its offset |
| `session` | The session id (the transcript's file name) |
| `scope`, `agent`, `agentType` | `main`, or `agent` with the agent's id and type |
| `model` | The model that answered |
| `input`, `cacheRead`, `cacheWrite`, `output` | The API's token counts (`input` is the uncached part) |
| `hit` | Cache read over all the input, 0 to 1 |
| `ttl`, `ttlInferred` | The cache TTL in force, and whether it was inferred |
| `cost` | The request at API list prices, its writes at `ttl` (absent for a model the price table lacks) |
| `loss` | A cache loss: `cause`, `lost` tokens, `gapMs` since the request before, `rewrite` and `extra` in US dollars |
| `tools` | The tools the loop ran before this request, since its previous one: `name` and `ms` |

```bash
F=~/.claude/projects/<project>/<session>/context-meter.jsonl
# Hit rate per request, main thread
jq -r 'select(.scope == "main") | [.at, .hit, .cacheRead, .cacheWrite] | @tsv' "$F"
# Tokens and cost by agent
jq -s 'map(select(.scope == "agent")) | group_by(.agent) | map({agent: .[0].agent, type: .[0].agentType, requests: length, cacheWrite: (map(.cacheWrite) | add), cost: (map(.cost // 0) | add)})' "$F"
```

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
| `timeline` | `false` | Write one JSON line per request to the session's folder (see Timeline). |
| `cacheAlert` | `true` | Color the `ctx` prefix as the main thread's prompt cache nears expiry and once it has expired. |
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

Several 1.1 features (the subagents' and models' tables, the hit-rate trend, the footer's TTL alert, what the cache saved, the timeline) take their ideas from [zhumengzhu/opencode-cache-hit](https://github.com/zhumengzhu/opencode-cache-hit) (MIT), a plugin for OpenCode. No code is taken from it.

Inspired by [midudev/better-claude](https://github.com/midudev/better-claude) (MIT). A few small helpers are adapted from it.

## License

[MIT](../../LICENSE) © 2026 Xoel García Maestu
