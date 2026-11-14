# Recorded incident stream fixtures

Real chats stay local. These JSONL files contain only canonical placeholders, public control
values and synthetic identities. `tests/core/incident-replay-privacy.test.ts` checks every file
under this directory, including nested files, against the strict shape schema. The developer
utilities and exact commands are in `scripts/incident-replay/README.md`.

| Fixture | Origin | Replay boundary |
|---|---|---|
| `question-turn.shape.jsonl` | A recorded Claude Code turn, filtered to adapter and lifecycle events without reordering | AskUserQuestion, answer, result, idle |
| `permission-interrupt.shape.jsonl` | A recorded Claude Code turn, from its init through its cancelled command | Bash permission, CLI withdrawal, interrupted result |
| `completed-turn.shape.jsonl` | The init, final model reply, result and idle from a recorded six-turn Claude Code run (3,610 output tokens) | Restart after output but before result delivery |
| `incident-d-backgrounded-grep.shape.jsonl` | The existing sanitized production incident, reconverted to canonical shape-only data | A detached command with no terminal event after foreground completion |
| `usage-limit.synthetic.shape.jsonl` | Explicitly synthetic variation of the recorded completed turn | Usage-limit stop and recovery. Not evidence of a recorded limit incident |

`tests/core/incident-replay.test.ts` retains the fold/reconcile incident checks and compares the
historical tail fold with the daemon's incremental fold. `tests/e2e/incident-replay.test.ts` adds
real adapter, server, persisted session/task status, request settlement and notice delivery.
Only the provider transport, model control responses, and storage paths are substituted.

The restart case is a regression fence for "Snapshot-only turn completion must hand back the
task" in `docs/decision/task-session-status.md`. Removing idle handback from the projection in
an isolated clone makes that case fail with `IN_PROGRESS` instead of `NEED_ACTION`.

The optional local tests read `WALNUT_LOCAL_REPLAYS_DIR` (otherwise
`~/.local/state/open-walnut/incident-replays`). They normalize recordings only in memory, never print their
words, and skip when no recordings are present. GitHub always runs the public shape fixtures.

Permission state is computed by executing the actual control branches of both daemon twins and
the shared FIFO-response branch. The test supplies their IO only, not another permission reducer.
The usage-limit recovery exercises the real waiter's Continue now path and a subsequent turn,
not its wall-clock timer.

A usage-limit recording was not available when this set was created. The synthetic fixture is
named as such. Codex and ACP recordings are not yet included: their provider framing and journal
replay need separate schema work, not a claim that Claude's stream covers them.
