# Contributing

Issues and pull requests are welcome.

## Before a pull request

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```

All three must pass. The type check needs `.claude-plugin/types/`, which Claude Code writes the first time it loads the mod.

## Ground rules

- **Real data only.** Every figure on the band comes from a session event or reading. If something is inferred, say so in the README's "What is inferred" section.
- **Observe, don't act.** Hooks pass their events on unchanged; the band never denies, rewrites or delays anything.
- **One line.** A new field has to earn its width; details go in a segment's hover.
- **Behaviour in `hooks/core.ts`.** Formatting and readings are pure functions with tests. `register.tsx` wires them to events and draws.
- **Narrow bands.** Check a drawing change at 40 and 120 columns, on the terminal and desktop surfaces.

When you report a bug, include `claude --version`.
