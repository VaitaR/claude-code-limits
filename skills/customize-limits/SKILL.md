---
name: customize-limits
description: "Configure or modify the limits mod (the quota/context/cache/cost line above the Claude Code prompt): set options, wire a costCommand for per-subagent cost, change thresholds, colours or gauge width, hide a segment, add a new segment, and test the change. Use when someone asks to tune, extend, restyle or debug the limits band."
---

# Customize the limits band

Work in a clone loaded with `claude --plugin-dir <clone>`: edits to `hooks/` hot-reload when Claude's turn
ends, so change, end the turn, look. An installed copy is overwritten by the next update.

## Configure without code

Options go in `/config`, or in `settings.json` under `pluginConfigs["limits"].options`:

| Option | Default | Effect |
| --- | --- | --- |
| `cacheTtl` | `1h` | `5m` if the account has no extended prompt caching; a wrong value gives a wrong cache clock |
| `palette` | `theme` | `pastel` for fixed hex colours on dark terminals |
| `costCommand` | empty | argv (whitespace-split) the session id is appended to; enables the per-subagent cost hover |

### costCommand

The command gets the session id as its last argument and must print one JSON object on stdout, exit 0:

```json
{ "total_usd": 5.85, "main_usd": 5.75, "unpriced_calls": 0,
  "agents": [{ "agent_type": "Explore", "description": "map the repo", "usd": 0.1 }] }
```

- `total_usd` is required; without it the output is ignored. `agents` is shown costliest first as given.
- Transcripts are `~/.claude/projects/<project>/<session_id>.jsonl`, subagents in
  `<session_id>/subagents/agent-<id>.jsonl` with `agent-<id>.meta.json` (`agentType`, `description`).
- Price each assistant record's `message.usage` once per `requestId` (a streamed reply writes several
  records with one id); count records whose model has no price in `unpriced_calls`.
- It runs at session start, each main turn's end and each subagent's end, one at a time, 15 s timeout.
  A failure keeps the last split, so test it by hand first: `<command> <session id> | python3 -m json.tool`.

## Where things are

| Want to change | Place |
| --- | --- |
| what a segment shows, its order, its hover rows | the `ui.render` hook for `AbovePrompt` in `hooks/register.tsx`: one `add(key, node, detail)` per segment, drawn in call order |
| quota colour thresholds (70% amber, 90% red) | `quotaLevel` in `hooks/core.ts` |
| context colour thresholds (60% amber, 80% red) | the `meter('ctx', …)` call in `register.tsx` |
| gauge width (6 cells) | `gaugeCells(pct, 6)` and `6 - filled` in `meter` |
| colours | `PALETTES` in `core.ts`: `theme` names theme keys, `pastel` is hex |
| how a value is formatted | the `fmt*` functions in `core.ts` |
| what state is kept | the atoms at the top of `register.tsx`, typed in `types/index.d.ts` |

To hide a segment, skip its `add(…)` call. Keep the band one line: a new field must earn its width, and
details belong in `detail`, the rows its hover shows.

## Add a segment

1. **Data.** If the value is not already in state, store it from the hook that sees it: declare an atom
   (`atom({ plugin: 'limits', key: 'x' } as const, default)`), add the key to `PluginState['limits']` in
   `types/index.d.ts`, write it with `update($, x, …)`. Hooks must pass their event on: `return next(e)`.
2. **Logic.** Put formatting and thresholds in `core.ts` as pure functions, with a test.
3. **Draw.** In the `AbovePrompt` hook, read the atom in the `Promise.all` and call
   `add('my-key', <Text …>…</Text>, ['first hover row', 'more rows'], 'the segment as plain text')`.
4. **Test** (below), then end the turn and look at it at a narrow and a wide window.

## Test

```sh
claude plugin test .          # tests/limits.test.ts
claude plugin validate .      # what the hooks reach and call
npx -p typescript tsc -p .    # after a first load has written .claude-plugin/types/
```

A band test mounts the drawing: `await $.ui.mount({ plugin: 'limits', component: 'AbovePrompt', props, surface })`,
then `ui.find({ text: /…/ })` or `ui.find({ key })`. Follow the existing tests for the props and the engine stubs.

## Traps

- **Tests check the element tree, never the paint.** Whether the line fits, or a hover is cut, shows only
  in the app. The desktop app sets text in a proportional font, so widths counted in characters are
  approximate: put the important part of a row first (the amount before the description).
- **A hover box needs an explicit width.** Unsized, it takes its segment's width and truncates.
- **A terminal paints in tree order and clips a hover to the band's rows.** A hover drawn inside its segment
  lay under the segments after it. So in a terminal the hovers are one row each, drawn after every segment at
  the cell the band's wrap gives them, and lit through `hover.scope`. A new segment passes its text as
  `add`'s last argument: that is how its width, and every later hover's place, is known. Check a hover change
  in a real terminal: `tmux send-keys -l $'\e[<35;COL;ROWM'` moves the pointer, `tmux capture-pane -p` reads it.
- **Never declare a variable named `on`** (or `$`, `next`) inside `register`: the module fails to load.
- **Engine stubs in a test are registered before the first `$` call**, and must return the fields the
  event requires (a `session.end` stub returns `{ sessionId }`); the error message names the missing one.
- **`ui.find` returns the nearest element carrying the text**, which may be its enclosing `Box`.
- **Rate limits are account-wide**: parallel sessions share them, so a per-session quota cannot be derived.
