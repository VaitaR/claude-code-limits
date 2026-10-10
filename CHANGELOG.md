# Changelog

## 0.7.1

- The cache counts down in seconds through its last minute, `● 42s`, where it showed `<1m`.

## 0.7.0

- The band ends with your last prompt, `❯ …`: in the room the line has left and cut with `…`, or on a row of its own when less than 40 cells remain and the band has a row to spare; without one it keeps to what is left, or is left out, so the band is never folded away. Its hover shows when it was sent and the prompt in full. Only your own prompts count, never a task notification, a peer session or another plugin's. A reloaded or resumed session shows the last prompt Claude Code recorded in its transcript.

## 0.6.1

- In a terminal, a segment's hover is no longer painted over by the segments to its right, and is one line, since a terminal shows a hover only within the band's rows. A hover too long for its place moves left to fit, and follows its segment onto a wrapped row.

## 0.6.0

First release as `limits`: one line above the prompt with the 5h/7d quotas and their resets, context against the compaction window with compactions, the prompt cache (`● live` during a turn, then minutes left), the session cost at API prices, and running subagents. Hovering a segment shows its details; with `costCommand`, the cost hover splits the session by main thread and subagent.

Earlier versions were the `watch` dashboard, a fork of [claude-flightdeck](https://github.com/scasella/claude-flightdeck); this release keeps only its band.
