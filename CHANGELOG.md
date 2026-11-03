# Changelog

## Unreleased

### context-meter

- A Cache saved row: what the prompt cache saved on input at API list prices, and as a share of the input's uncached cost; negative when the writes cost more. The whole session on the main card, the agent alone on an agent's.
- The footer's `ctx` prefix takes the warning color in the last tenth of the main thread's cache TTL (at least 30 seconds) and the error color once it has expired; `cacheAlert` turns it off.
- The Cache hit row adds the last request's hit rate and its change against the request before it (`↑4`, `↓28`, `=`, or `(model switch)`), in every card.
- An Agents section in the card and in `/context-meter`: a row per subagent (requests, input, cache read, cache write, uncached, output, cache hit, model), the total over every subagent, and the main thread and the subagents together. Shown once a subagent has answered; the engine's own forks are left out.
- An agent's own card, the same as the main thread's: click its row (or open its transcript from the tasks list) to see its context, last request, session, cache hit, cost at API list prices, prompt cache TTL and expiry, cache losses, and the agents it spawned; `/context-meter <n|name>` prints it. A path at the top goes back up. Its TTL comes from its own transcript.
- A Models section in each card: a row per model that answered in that loop or under it, with its cost at API list prices, shown when there is more than one.
- The agents table's totals are named for what they sum: Subagents total, and Main + subagents (This agent + subagents in an agent's card).
- The card's frame is colored by depth: the theme's accent for the main thread, other colors for subagents and their subagents.
- Costs under a dollar show four decimals, as `/cost` prints them.
- The cache countdown and the idle time of a loss are timed from the start of each request instead of its end, as Anthropic's prompt caching docs time a cache entry. A long response no longer pushes the expiry later than it is. The first request after upgrading measures its idle time from the end of the last request recorded by 1.0.0.
- The README states which caching rules come from Anthropic's docs and which are the plugin's own (the 1024-token noise floor), and that a compaction's summarizer request is not counted.

## 1.0.0 (2026-11-02)

First public release of both plugins in the `xoel-plugins` marketplace.

### context-meter

- Context window fill at the bottom right of the prompt footer, with a bar and a percentage colored by the `warnAt` and `dangerAt` thresholds.
- An estimate, marked with `~`, before the first response of a fresh, resumed, compacted or rewound session.
- A hover card in the band above the prompt, and `/context-meter` to print it as text: tokens over the window, the autocompact point, the main thread's last request and session totals (input, cache read, cache write, uncached, output), the cache hit rate and the session cost at API list prices.
- Prompt cache tracking: the expiry countdown, the TTL read from the session transcript (or set with `cacheTtl`), and a history of cache losses with their cause.
- Narrow layouts: the meter and the card shrink without wrapping or cutting numbers.
- English and Spanish (`language`).

### sub-meter

- The 5-hour and weekly subscription windows at the bottom right of the prompt footer, with a bar, the percentage and the time to reset; `display` shows them in turn, side by side or one only.
- A hover card in the band above the prompt, and `/sub-meter` to print it as text: reset times, pace projections and the age of the reading.
- The reading is shared between open sessions through the plugin store.
- Hides without a subscription; optionally drops `(shift+tab to cycle)` and `esc to interrupt` from the hint line to make room.
- Shares the footer row with context-meter in a fixed order.
- English and Spanish (`language`).
