# claude-plugins

Two plugins for [Claude Code](https://code.claude.com) that put usage meters in the prompt footer, at the bottom right. They are published as the `xoel-plugins` marketplace.

| Plugin | What it shows |
| --- | --- |
| [context-meter](plugins/context-meter) | How full the context window is. Hover it for the token breakdown, the prompt cache state and the session cost; `/context-meter` prints the same as text. |
| [sub-meter](plugins/sub-meter) | Subscription usage: the 5-hour and weekly windows with the time to reset. Hover it for reset times and pace; `/sub-meter` prints the same as text. |

The two share the footer row, context first:

```text
⏵⏵ auto mode on · ← 5 agents                                           ctx ─────── 5% · week ━━──────── 20% ↻ 3d 15h
⏵⏵ auto mode on · ← 5 agents                                                ctx ─────── 5% · 5h ━━━━━━━━── 83% ↻ 40m
```

Both rows were captured in a 120-column terminal. sub-meter alternates between the weekly and the 5-hour window by default.

## Install

In Claude Code:

```
/plugin marketplace add xoel-maestu/claude-plugins
/plugin install context-meter@xoel-plugins
/plugin install sub-meter@xoel-plugins
```

Install either one or both. sub-meter replaces the sub-meter of [midudev/better-claude](https://github.com/midudev/better-claude): both use the name `sub-meter` and the command `/sub-meter`, so keep only one of them enabled.

Tested with Claude Code 2.1.316. The hover cards need a terminal with mouse reporting; the slash commands work everywhere.

## Uninstall

```
/plugin uninstall context-meter@xoel-plugins
/plugin uninstall sub-meter@xoel-plugins
/plugin marketplace remove xoel-plugins
```

## Development

```
claude --plugin-dir plugins/context-meter       # load a plugin from the working tree
claude plugin validate .                        # the marketplace manifest
claude plugin validate plugins/context-meter    # a plugin
claude plugin test plugins/context-meter        # its tests (hooks/*.test.ts, *.test.tsx)
```

CI (`.github/workflows/ci.yml`) runs `claude plugin validate` on the marketplace and `claude plugin validate` and `claude plugin test` on every folder under `plugins/`, with Claude Code installed from npm at a pinned version. Neither command needs a login.

CI does not run `tsc`. The type definitions a plugin compiles against (`.claude-plugin/types/`) are written by Claude Code when it loads the plugin with `--plugin-dir`, and they are not committed. To type-check locally, load the plugin once, then run `tsc -p plugins/<plugin>`.

## Credits

The idea of meters drawn in the prompt footer comes from [midudev/better-claude](https://github.com/midudev/better-claude) (MIT). A few small helpers are adapted from it.

## License

[MIT](LICENSE) © 2026 Xoel García Maestu
