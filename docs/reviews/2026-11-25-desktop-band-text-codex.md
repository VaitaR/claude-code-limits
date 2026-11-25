---
artifact_id: "2026-11-25-desktop-band-text-codex"
date: "2026-11-25"
producer: "codex"
run_kind: "codex-adversarial"
stage: null
verdict: "APPROVE"
branch: "fix/desktop-band-text"
base_ref: "origin/main"
base_sha: "86b14fe5b0758415506aa6bfa4b7ef4d362ce605"
head_sha: "da4bd628e2fc7db4f0a01aad9ddb9ed8babedeff"
base_ref_source: "sole-candidate"
worktree_dirty: false
tree_sha: "635092a5fbff2625450c8836f39c93e49bd76345"
tree_exclude: []
redactions: 0
pr: null
pr_link: null
session_id: null
agent_transcript_path: null
repo_root_source: "explicit_repo_arg"
files_reviewed:
  - "hooks/register.tsx"
findings:
  - id: "F1"
    severity: "P2"
    file: "hooks/register.tsx"
    line: 462
    end_line: 463
    claim: "A terminal countdown fault freezes healthy countdowns — . If the terminal’s `band-reset-five_hour` client faults while the cache is warm, the `ui.fault` handler records the entire surface at line 442. The engine’s redraw then replaces the healthy cache client with a text snapshot at lines 542–546, but starts no redraw timer for the terminal. In an idle session with quota polling off and unchanged quota readings, that snapshot can keep showing a warm cache after its TTL expires"
    fingerprint: "6f6d3b1091e0"
    disposition: "accepted"
    disposition_note: "fixed in 03b999c"
  - id: "F2"
    severity: "P2"
    file: "hooks/register.tsx"
    line: 459
    end_line: 463
    claim: "Hot reload does not restore countdown clients — . After a terminal countdown fault is recorded at line 442, the session atom survives a plugin hot reload. The new module reads the old fault marker and still omits the client, contrary to `CHANGELOG.md:5`’s “until reload.”"
    fingerprint: "17eb6d793b2a"
    disposition: "accepted"
    disposition_note: "fixed in 03b999c"
  - id: "F3"
    severity: "P3"
    file: "hooks/register.tsx"
    line: 440
    end_line: 442
    claim: "The new fault-event data source is undocumented — . On a countdown fault, the hook reads the module path and surface from `ui.fault`. The governing instructions require new data sources to be listed in the README’s “What it can reach” table, which does not list this event"
    fingerprint: "677feddceab3"
    disposition: "accepted"
    disposition_note: "fixed in 03b999c"
---

# codex review — fix/desktop-band-text

> Captured automatically by `tools/hooks/review_capture.py` (agent-skills). The report below is the reviewer's verbatim output; the frontmatter above is parsed from it. Set each finding's `disposition` when you action it.

## Report (verbatim)

[P2] A terminal countdown fault freezes healthy countdowns — hooks/register.tsx:462–463. If the terminal’s `band-reset-five_hour` client faults while the cache is warm, the `ui.fault` handler records the entire surface at line 442. The engine’s redraw then replaces the healthy cache client with a text snapshot at lines 542–546, but starts no redraw timer for the terminal. In an idle session with quota polling off and unchanged quota readings, that snapshot can keep showing a warm cache after its TTL expires.

[P2] Hot reload does not restore countdown clients — hooks/register.tsx:459–463. After a terminal countdown fault is recorded at line 442, the session atom survives a plugin hot reload. The new module reads the old fault marker and still omits the client, contrary to `CHANGELOG.md:5`’s “until reload.”

[P3] The new fault-event data source is undocumented — hooks/register.tsx:440–442. On a countdown fault, the hook reads the module path and surface from `ui.fault`. The governing instructions require new data sources to be listed in the README’s “What it can reach” table, which does not list this event.

## Design

- hooks/register.tsx:442,463 — The fault handler and renderer repeat stored-list normalization instead of using the existing `listOf` helper in `hooks/core.ts:30`.

## Files reviewed

- `.claude-plugin/plugin.json` — reviewed: release version bump and unchanged plugin identity.
- `CHANGELOG.md` — reviewed: desktop redraw and fault-recovery claims against the implementation.
- `hooks/register.tsx` — reviewed: fault dispatch, state lifetime, redraw scheduling, and countdown selection.
- `tests/limits.test.ts` — reviewed: desktop cache assertion and the test’s mount and clock sequence.
- `types/index.d.ts` — reviewed: fault-state shape and its documented lifetime.

VERDICT: YES
