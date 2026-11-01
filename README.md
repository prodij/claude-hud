# hud

A quiet heads-up display for Claude Code. It stays out of the way until something needs you.

- **Status chip** under the prompt: a context dial (`◑ 42%`), your branch, commits ahead and uncommitted changes.
- **Band** above the prompt once context passes 85%, with a meter and token counts.
- **Toasts** when context crosses 80% and 90%, and when a subagent finishes or stops.
- **Guard** that refuses risky Bash commands (destructive SQL, a production AWS profile, force pushes, `rm -rf` on `/` or `~`) and tells Claude to hand the command to you instead.
- **`/hud` pane** with four tabs:
  - **Context**: window usage, what is using it (messages, tools, MCP servers), and plan limits and cost.
  - **Where**: repository, branch, sync with upstream, changes, and the active `AWS_PROFILE`.
  - **Agents**: subagents this session, running and finished.
  - **Guard**: what was blocked and the rules.

Press `1` to `4` to switch tabs and `r` to refresh the breakdown.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install hud --marketplace prodij/claude-hud
```

Answer `y` to add the marketplace, then pick the user scope. From a shell:

```bash
claude plugin install hud --marketplace prodij/claude-hud
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `prodij/claude-hud`, then Add plugin.

Needs a recent Claude Code with function-hook plugins (built and tested on 2.1.309).

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
