# limits

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code 2.1.287+](https://img.shields.io/badge/Claude%20Code-2.1.287%2B%20mod-d97757.svg)](https://claude.com/blog/claude-code-mods)

**Before you send the next prompt, know how much room you have left**: quota, context, prompt cache and money. A Claude Code mod that puts them on one line above the prompt, in the terminal and the desktop app, with details on hover.

```
5h ━━━━━━ 45% ↻ 3h25m  7d ━━━━━━ 17% ↻ 4d20h  ctx ━━━━━━ 74% ⟲3  cache ● 55m  $31.86  ◐ Explore
```

| Segment | Shows | Hover |
| --- | --- | --- |
| `5h`, `7d` | the rate-limit windows your plan reports, as gauges, and the time to each reset | used and left, the reset as wall time |
| `ctx` | context against the window Claude Code compacts at; `⟲N` after compactions | tokens of the window, compactions |
| `cache` | `● live` while a turn runs, then the minutes the prompt cache has left, `○ cold` once it expired | when it goes (or went) cold, the TTL |
| cost | the session's cost at API prices, subagents included | what the last turn cost; with `costCommand`, the main thread and each subagent a row apiece |
| `◐` | subagents running now: the type of one, the count of several | their types |

The line stays neutral while all is well: amber and red mark only a quota, the context or the cache that needs attention. Model, branch and the like are left to the rest of the app.

## Install

Inside Claude Code (2.1.287 or later):

```
/plugin marketplace add VaitaR/claude-code-limits
/plugin install limits@claude-code-limits
/reload-plugins
```

Or load it from a clone, for one session:

```sh
git clone https://github.com/VaitaR/claude-code-limits
claude --plugin-dir ./claude-code-limits
```

Mods are an early-access Claude Code feature and their API can change between releases.

## Configure

In `/config`, or under `pluginConfigs["limits"].options` in `settings.json`:

| Option | Default | Meaning |
| --- | --- | --- |
| `cacheTtl` | `1h` | the main loop's prompt-cache lifetime: `1h` with extended caching, `5m` otherwise |
| `palette` | `theme` | `pastel` uses fixed colours tuned for dark terminals |
| `costCommand` | empty | a command printing a session's cost split as JSON, the session id appended; the cost hover then names the main thread and each subagent |

`costCommand` must print one JSON object:

```json
{ "total_usd": 5.85, "main_usd": 5.75, "unpriced_calls": 0,
  "agents": [{ "agent_type": "Explore", "description": "map the repo", "usd": 0.1 }] }
```

It runs at session start, at each main turn's end and at each subagent's end, one run at a time, with a 15 s timeout. A failure keeps the last split.

## Make it yours

The plugin ships a skill, `customize-limits`: ask Claude to change a threshold, a colour or the gauge width, hide a segment, add one, or wire a `costCommand`, and it knows where each lives and how to test the change.

## What it can reach

Every hook passes its event on unchanged: it never denies, rewrites or delays anything.

| It reads | Through |
| --- | --- |
| context, cost and rate-limit readings | `session.measure`, `$.session.usage()` |
| when the main loop's requests are sent and answered | `turn.step` |
| compactions | `session.compact` |
| subagent spawns and ends (type only) | `agent.spawn`, `turn.complete` |
| the tail of this session's transcript, once, when loaded mid-session, to start the cache clock | `sh -c tail -c 400000 ~/.claude/projects/*/<session id>.jsonl` |
| your `costCommand`'s output, if you set one | `$.process.run` |

It makes no network requests and calls no model. State lives in session atoms and ends with the session.

## What is inferred, not measured

- **The cache clock** starts when the main loop's last answered request was sent and runs for `cacheTtl`. The engine reports no TTL, so a wrong `cacheTtl` gives a wrong clock.
- **Quotas are account-wide.** Parallel sessions spend the same windows; the band shows the last reading any response carried. A reading without a window keeps the previous one until it resets.
- **Cost is the engine's API-price figure.** On a subscription it is what the session would cost at API prices, not a bill.

## Develop

```sh
claude --plugin-dir .            # load it; edits hot-reload
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .       # after the first load, which writes .claude-plugin/types/
```

| File | Holds |
| --- | --- |
| [`hooks/register.tsx`](hooks/register.tsx) | the event hooks and the band |
| [`hooks/core.ts`](hooks/core.ts) | config, formatting and readings as pure functions |
| [`hooks/countdown.tsx`](hooks/countdown.tsx) | a surface module: the reset and cache countdowns tick on the surface's own clock |
| [`types/index.d.ts`](types/index.d.ts) | the state contract |
| [`skills/customize-limits/`](skills/customize-limits/SKILL.md) | the skill for tuning and extending the band |

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). Started as a fork of [claude-flightdeck](https://github.com/scasella/claude-flightdeck) by Stephen Casella.
