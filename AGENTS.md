# limits — agent contract

A Claude Code mod: one line above the prompt with quota, context, prompt cache, cost, running
subagents and the last prompt. Read before changing anything:

| File | For |
| --- | --- |
| [README.md](README.md) | what the user sees and is promised: segments, options, the `costCommand` contract, what the mod can reach |
| [skills/customize-limits/SKILL.md](skills/customize-limits/SKILL.md) | where each threshold, colour and segment lives, how to add a segment, the rendering traps |
| [CONTRIBUTING.md](CONTRIBUTING.md) | ground rules: observe only, one line, behaviour in `core.ts` |
| [BACKLOG.md](BACKLOG.md) | open work |

## Setup

- Load once with `claude --plugin-dir .`: that writes `.claude-plugin/types/` (gitignored), which
  `tsc` and the editor need. The types are the installed Claude Code's mod API and the only reference
  for it; `rg` skips them as gitignored, so search with `rg --no-ignore`.
- This repo commits as `andrey.shivalin@gmail.com` (repo-local `user.email`). Never commit with
  another address: the history is meant to go public.

## Done means

1. The three checks in [CONTRIBUTING.md](CONTRIBUTING.md) "Before a pull request" all pass, tsc
   with zero errors (tests included). Validate's one warning, that the root `CLAUDE.md` is not loaded
   as context, is expected: it is for agents working in this checkout, not for the plugin's users.
2. A drawing change is seen live. Tests read the element tree, never the paint: overlap, clipping
   and wrap show only on a real surface.
   - **Terminal**, scriptable: `tmux new-session -d -s lim -x 112 -y 30 "claude --plugin-dir ."`
     (plain `claude` where settings already load this checkout),
     send a prompt (`tmux send-keys -t lim -l "…"` then `tmux send-keys -t lim C-m`), hover a
     segment with an SGR mouse move `tmux send-keys -t lim -l $'\e[<35;COL;ROWM'` (1-based cell),
     read the band with `tmux capture-pane -t lim -p`. Repeat at `-x 60` for the wrapped band.
   - **Desktop app**: not scriptable. Ask the owner for a screenshot; say it is unverified until then.
3. A user-visible change bumps `version` in `.claude-plugin/plugin.json` and adds a `CHANGELOG.md`
   entry on top. Users install from `main` through the marketplace, so every push to `main` is a
   release: keep it green.
4. Run `gitleaks dir .` before a push.

## Invariants

- **`limits` is one name in four places**: `plugin.json` `name`, the atoms' `plugin`, the
  `PluginState` key in `types/index.d.ts`, users' `pluginConfigs["limits"]`. Renaming drops every
  user's settings and session state.
- **The `costCommand` JSON is a public contract** (README). Add optional fields only; a renamed or
  required field breaks users' scripts silently, since a bad output just keeps the last split.
- **The README's "What it can reach" table lists every source the mod reads data from** (lifecycle
  hooks and `$.clock`/`$.session.id` are left out). A new source updates the table in the same change;
  `claude plugin validate .` prints every hook and call to compare against.
- **No private names in the repo**: it is public-bound. The owner's own cost script and setup stay out.
- **Media in `docs/media/` are real captures**, never mock-ups. Re-shoot them when the band's look
  changes: capture with `tmux capture-pane -e -p > x.ans`, crop the lines, then
  `python3 tools/media/ans2html.py x.ans x.html` and
  `uv run --with playwright python tools/media/shot.py x.html`. Crop out the owner's status line
  and any private prompt text. `demo.gif` is re-shot with `tools/media/record.py` then `gif.py`
  (usage in each). The desktop capture comes from the owner.

## Needs the owner

Making the repo public, a listing PR to another repo, and anything sent outside this checkout.
