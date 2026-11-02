# context-meter

The context window fill at the bottom right of the Claude Code prompt footer:

```
ctx ━━━━── 62%
```

Hover the meter to open a card with the detail; `/context-meter` prints the same rows as text.

```
╭──────────────────────────────────────────────────────────────────────╮
│ Context   124.3k / 200k   62%                                        │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━────────────────────────── │
│ Autocompact at ~167k                                                 │
│                Input    Cache read   Cache write   Uncached   Output │
│ Last request   51.5k    50.2k        1.3k          4          776    │
│ Session        200.5k   165.9k       34.6k         10         1.2k   │
│ Cache hit      83% of input read from cache                          │
│ Cost           ≈ $4.12 at list prices (session, all agents)          │
│ Cache          active until 04:12 (in 41m, TTL 1h)                   │
│ Cache losses   02:14  −112k  idle 1h07m > TTL                        │
│                01:02  −98k   /compact                                │
│                00:40  −50k   model changed                           │
│                00:10  −20k   invalidated (prompt or tools changed)   │
╰──────────────────────────────────────────────────────────────────────╯
```

Where the band is narrower, the table drops its Uncached column, then Cache write (60 columns):

```
               Input    Cache read   Output
Last request   51.5k    50.2k        776
Session        200.5k   165.9k       1.2k
```

The headers always show. On a band too narrow for even Input, Cache read and Output (under about 47 columns) the table, the hit row and the cost row are left out; numbers are never cut. The cache rows stay, cut at the border where they run long.

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
- **Last request** and **Session**: the main thread's last response and its sum over the session, as the API counted them. **Input** is all the input: **Cache read** (served by the prompt cache), **Cache write** (written to it) and **Uncached** (the API's `input_tokens`). **Output** is the response. **Cost** is on its own row: the whole session's cost with all agents (`$.session.usage().cost.usd`, subagents included), while the token rows count the main thread only. It is a client-side estimate at API list prices, not a bill ([Claude Code costs](https://code.claude.com/docs/en/costs.md)): on a subscription (rate limits seen) it reads `≈ $0.004 at API list prices (not billed on your plan)`, since it is not what the plan charges; otherwise `≈ $4.12 at list prices (session, all agents)`. Two decimals from a cent (an amount that rounds to one, `0.00999`, reads `$0.01`); under a cent from the first significant digit (`$0.004`, `$0.0004`). Whether the session is a subscription is kept across `/clear` and stored in `$.store` (`isSubscription`, the last reading), so a new or resumed session uses it until its own reading arrives: rate limits seen (subscription), or none by its second main-thread response (API key; once seen, rate limits stand for the session). Where the band is narrow the tail shortens to `(not billed)` or `(estimate)`, and where even that does not fit only the amount stays; a word is never cut. The row is left out when the host reports no cost, a cost of 0 or a non-finite one. **Cache hit** is cache read over Input for the session. Before the first response these rows are left out, never shown as zeros.
- **Cache** and **Cache losses**: see below.
- The counts live in `$.state` (`ledger`), so a reload of the plugin keeps them. They count from the session's start (`$.session.usage().startedAt`): `/clear` empties them, and a ledger written for another start is dropped.
- Where the row is short the meter drops its bar (`ctx 62%`), then its prefix (`62%`), then itself. It takes 14 columns at most.

## Options (`/config`)

| Option | Default | |
| --- | --- | --- |
| `warnAt` | 50 | percentage for the warning color |
| `dangerAt` | 75 | percentage for the error color |
| `language` | `en` | `en` or `es`, for the card and `/context-meter` |
| `cacheTtl` | `auto` | `auto`, `5m` or `1h`: the prompt cache lifetime the countdown and the idle cause use; `auto` reads it from the session transcript |

## Cache losses and TTL

Each main-thread request is compared with the one before it. The previous cached prefix is `P = cache read + cache write` of that request. A normal request reads the whole previous prefix back (`cache read ≥ P`), so a request is a loss when `P > 1024` and `P − cache read > 1024`; it lost `P − cache read` tokens. A partial loss counts: after `/compact` the system prompt and tools are still read back while the rewritten conversation is written again. The cause is the first that holds:

1. `/compact`: a compaction of the main conversation (`session.compact` with no `agentId`, not the `precompute` one) came since the previous request.
2. `model changed`: the request's model differs from the previous one's.
3. `idle <pause> > TTL`: the pause since the previous request is longer than the TTL in force.
4. `invalidated (prompt or tools changed)`: none of these; the system prompt, the tools or another part of the prefix changed.

Where the band is too narrow for a cause, its short form is used (`/compact`, `model changed`, `idle 1h07m`, `invalidated`); where even that does not fit, the cause is left out. A word is never cut.

The history keeps the 10 newest losses, newest first; the card shows the 5 newest and `/context-meter` all 10. `/clear` starts the cache over and its time shows as the first history line (`Cleared at 14:05`); it is not a loss.

The TTL, first that holds:

1. `cacheTtl` set to `5m` or `1h`.
2. Observed: the TTL the last main-thread cache write used, as the session transcript records it. Claude Code asks for the 1h TTL only on a Claude subscription within the plan's included usage and only for the main conversation (subagents and compaction get 5m); an API key, usage credits and cloud providers get 5m; environment variables and settings (`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl`, `ENABLE_PROMPT_CACHING_1H`) override it ([prompt caching](https://code.claude.com/docs/en/prompt-caching.md)). So no setting the plugin can see tells it for sure; the response's usage does. Each main-thread assistant entry of the transcript (JSONL) has `message.usage.cache_creation` with `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`: 1h tokens written mean 1h, 5m tokens mean 5m, none (a pure read) keeps the TTL observed before. Entries with `isSidechain` (a subagent's) or an `agentId`, other entry types and malformed lines are skipped.
3. Inferred, shown with `?` (`TTL 1h?`): the TTL an earlier session last observed, stored in `$.store` (`lastTtl`), until this session's transcript confirms one; without it, 1h when the session has rate limits (a subscription: seen on any usage read, the 2 s resync included, so a first request made before the host reports them turns 1h too), 5m otherwise, and 1h for the rest of the session once a request reads the cache back (a hit: `cache read ≥ P − 1024`) after a pause of more than 5 minutes.

The transcript's path comes from the classic hook events' `transcript_path` (`classic.SessionStart`, a `/clear`'s new file included, `classic.UserPromptSubmit` and `classic.Stop`, the main thread's only: an event with `agent_id` is a subagent's). The file is read once per main-thread turn, at its end (`classic.Stop`, by when the turn's last response is written), and only when its `$.fs.stat` size changed. Only its end is read: `$.process.run(['tail', '-c', '262144', path])` (the path one argv element, no shell), the first line dropped when the file is longer, since it may be cut; it is scanned from its end for the last main-thread entry. Where `tail` cannot run or fails (Windows, say) the whole file is read with `$.fs.read`, which takes files up to 4 MiB; past that the TTL last observed stands. The observed TTL lives in the cache's `$.state` (`observedTtl`) and is kept across `/clear` (the TTL setting does not change with it) until a new observation replaces it; each new one is stored in `$.store` (`lastTtl`) for the next session.

The cache expires at the last main-thread request's time plus the TTL: `active until 04:12 (in 41m, TTL 1h)` (the expiry as a local time, then whole minutes left, `in <1m` in the last minute), `expired 3m ago` (`<1m`, then minutes, `1h07m` from an hour), or `no cache yet`. Where the band is narrow the active line reads `until 04:12 (TTL 1h)`.

The cache is fed from the same queued recording as the token counts, after `turn.step` returns, and compactions and `/clear` go in the same queue, so each lands between the right requests. It lives in `$.state` (`cache`), so a reload keeps the losses and the TTL.

The countdown: no hook runs on hover, so the card cannot know when it is shown. The cache line changes at most once a minute, so it needs no timer of its own: the 2 s resync works out the line and writes the time it is drawn for (`$.state` key `now`) only when the text changes, about once a minute. With no cache (before the first request, after `/clear`) it reads nothing. Only the band hook reads that key, so only it redraws, and while the card is hidden the redraw changes no cell.

## How the card is drawn

The meter is drawn in `SessionMode` (the footer row); the card is drawn in `AbovePrompt` (the band above the prompt). A card placed above the meter inside `SessionMode` was clipped in a real session (Claude Code 2.1.316, main screen): the footer lets about four rows rise above the meter's row, so the top border was lost and the rest sat over the prompt's border.

In `AbovePrompt` the hook returns what is beneath it (`next(e)`: the engine's node, another plugin's drawing) first and untouched, then a holder `Box` as wide as the band (`e.props.bodyColumns`) that pushes the card to its right end. The holder is `display="none"` and joins the hover group with `hover={{ scope: 'context-meter', display: 'flex' }}`, so it takes no row until the pointer is on the meter or on the card; while shown, the card takes its rows above the prompt and the transcript moves up by that much. A card floated out of the flow (`position="absolute"`) in the band was clipped whole in a real session, so the card stays in the flow. With no figure, or while a survey holds the band, the hook returns `next(e)` as it came. The card is a rounded, dim border, 40 columns wide before the first response; with more rows it widens to what they need, up to the band: the token table takes the widest of its layouts that fits (five columns, four, three) or is left out, and the cache rows are cut at the border, so no row wraps. The holder is a Box of its own because an engine node may not sit under a Box that sets a width.

The two sites are tied by a hover group: the meter's Box has `hover={{ scope: 'context-meter' }}` and the card is drawn `display="none"` with `hover={{ scope: 'context-meter', display: 'flex' }}`. Per the API, every element a plugin draws under one `scope`, in any site, lights while any of them is hovered, reveals included, so the card shows while the pointer is on the meter or on the card itself. No hook runs on hover. Since the card is no longer in the footer, a plugin drawn above the meter that sums what lies beneath it in `SessionMode` counts the meter alone.

`cardOf` builds the card as a list of rows (each a list of pieces with a tone: the meter's color, plain or dim) and derives the height from them; a later section is one more row. Each row is padded with spaces to the content width and the horizontal padding is drawn as spaces too, so every cell inside the border is written over what lies beneath: the theme has no background key to paint the Box with.

The band's body ends five columns before the terminal's edge (the engine keeps them for its `[-]` mark), and the footer's meter two before it, so the card's right edge sits three columns left of the meter's.

## Which requests count

`turn.step` fires for every model request of a turn, the main thread's and every other loop's. Its input carries `agentId`, the loop the request is made in: absent on the main thread, set for a subagent, a teammate, a workflow agent and the engine's own forks (compaction, memory), which carry ids `$.agent.list()` does not name (`TurnStepInput.agentId` and `AgentLoop.agentId` in the API types). The hook is a streaming one: it passes the stream on untouched (`yield* next(e)`) and returns the result at once; the recording of `usage` into the ledger runs after it, chained so quick steps add in order, and `/context-meter` waits for it. It records only when `e.agentId` is undefined and `usage` is not null (a request that got no response). The cost line is the session's whole cost as `/cost` gives it, subagents included.

## Development

```
claude --plugin-dir plugins/context-meter
claude plugin validate plugins/context-meter
tsc -p plugins/context-meter
claude plugin test plugins/context-meter
```

`tsc -p` reads `.claude-plugin/types/`, which the engine writes when it loads the folder with `--plugin-dir`.

Inspired by the `SessionMode` pattern of [midudev/better-claude](https://github.com/midudev/better-claude) (MIT); the code is written from scratch.
