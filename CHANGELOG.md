# Changelog

## 0.6.1

- In a terminal, a segment's hover is no longer painted over by the segments to its right, and is one line, since a terminal shows a hover only within the band's rows. A hover too long for its place moves left to fit, and follows its segment onto a wrapped row.

## 0.6.0

First release as `limits`: one line above the prompt with the 5h/7d quotas and their resets, context against the compaction window with compactions, the prompt cache (`● live` during a turn, then minutes left), the session cost at API prices, and running subagents. Hovering a segment shows its details; with `costCommand`, the cost hover splits the session by main thread and subagent.

Earlier versions were the `watch` dashboard, a fork of [claude-flightdeck](https://github.com/scasella/claude-flightdeck); this release keeps only its band.
