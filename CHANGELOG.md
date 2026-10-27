# Changelog

## 0.12.0

- `quotaLog`: a file each `quotaPoll` answer is appended to as one JSON line (`at`, `source`, then `pct` and `resetsAt` per window), to match the quota against your own cost and token data. Empty by default.
- The shared quota file keeps only the 5h and 7d windows: an `extra_usage` reading that a 0.11.0 poll put into a session no longer comes back to the file.

## 0.11.1

- A session no longer passes an old quota reading off as the latest: the engine hands a session its last reading again at every measurement and to a restarted process, and each was stamped as read just now, so an idle or restarted session could overwrite every band with a figure from days before (a 7d quota shown at 10% while it stood at 81%). A reading now counts as new only when it changed after a response.
- `quotaPoll` reads only the 5h and 7d windows from the server's answer, not `extra_usage`.

## 0.11.0

- `quotaPoll` (`off` by default; `5m` or `15m`): one session per config directory asks the server for the 5h/7d quota, as `/usage` does, so the band stays current while every session is idle and counts use from claude.ai or another machine. It is the mod's only network request, sent with the session's claude.ai login, which the mod never sees.

## 0.10.0

- A quota whose window reset while every session sat idle stays on the band as an empty `0%` gauge, its hover giving the reset time and the figure before it, instead of disappearing until the next response.

## 0.9.0

- Quotas are shared by every session of one config directory: an idle or restarted session shows the latest 5h/7d reading any session received, and the hover says when it was read.
- A quota whose window reset since its reading is no longer drawn with the old figure.
- A restarted session (the desktop app stops a hidden idle session's process) shows the context of its last response from the transcript instead of an empty band.

## 0.8.0

- The running-agents hover shows each subagent's task, how long it has run, its model, its last request's context, its tool calls so far and the latest one, like the desktop app's agent cards.

## 0.7.5

- The band keeps a blank row under itself in a terminal, and a hover shows there below its segment: nothing jumps when the pointer moves on, and the details are where you look.

## 0.7.4

- A terminal hover is a row of its own under the band and covers nothing; only a band with no row to spare still draws it over the segment's row.

## 0.7.3

- A terminal hover takes its segment's whole row: shifted left to fit, it sat flush on the segments beside it.

## 0.7.2

- A short last prompt such as `❯ ping` shows: one under 12 cells was left out even with room to spare.

## 0.7.1

- The cache counts down in seconds through its last minute, `● 42s`, where it showed `<1m`.

## 0.7.0

- The band ends with your last prompt, `❯ …`: in the room the line has left and cut with `…`, or on a row of its own when less than 40 cells remain and the band has a row to spare; without one it keeps to what is left, or is left out, so the band is never folded away. Its hover shows when it was sent and the prompt in full. Only your own prompts count, never a task notification, a peer session or another plugin's. A reloaded or resumed session shows the last prompt Claude Code recorded in its transcript.

## 0.6.1

- In a terminal, a segment's hover is no longer painted over by the segments to its right, and is one line, since a terminal shows a hover only within the band's rows. A hover too long for its place moves left to fit, and follows its segment onto a wrapped row.

## 0.6.0

First release as `limits`: one line above the prompt with the 5h/7d quotas and their resets, context against the compaction window with compactions, the prompt cache (`● live` during a turn, then minutes left), the session cost at API prices, and running subagents. Hovering a segment shows its details; with `costCommand`, the cost hover splits the session by main thread and subagent.

Earlier versions were the `watch` dashboard, a fork of [claude-flightdeck](https://github.com/scasella/claude-flightdeck); this release keeps only its band.
