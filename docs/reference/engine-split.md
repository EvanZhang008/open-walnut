# The engine split: share new tasks between coding engines

New task work can take turns between coding engines instead of all running on one. Turn it
on in Settings, Sessions, "Share new tasks" (check two or more engines), or in `config.yaml`:

```yaml
defaults:
  engine_split:
    - engine: claude
    - engine: codex
      weight: 1
    # Claude Code on another company's model, served through your own proxy:
    - engine: claude
      model: gpt-6.1-sol
```

## Which starts it picks for

A task start that names no engine, model or effort, for ordinary work: not Main, a VP or a
lead, not a Personal AI ask, not a routine's run, not a plugin's own task, and not a start
that continues, moves or recovers a session. A task that already has a conversation keeps
its engine. Naming `engine` (or a Claude `model` or `effort`) on `task_create` / `task_start`
is the per-task override.

## How it picks

Each entry's share is its weight. The picks of the last 14 days are replayed in order: each
pick hands every entry its share of one turn and takes one turn from the entry picked, and
the start takes the entry owed the most (ties go to the earlier entry). Weights 1 and 1
alternate; 2 and 1 give the first two of every three. No entry runs more than two turns
behind or ahead, so an entry added later, or one a host could not run for a while, catches
up with a short run of a few starts and then takes turns. Only entries that can run where
the start goes are offered: an ACP engine the launch host has not reported installed is
skipped (Claude Code always can). Reviewer subtasks (a subtask whose title starts with
"Review" or "Reviewer") take no turn: they count toward their parent's work. A model on an ACP entry is ignored; set `engines.<id>.model` instead.

The pick is kept on the task (`engine_pick`) and in `WALNUT_HOME/cache/engine-split.json`,
and the start's outcome names it with the shares it saw. A start that waited (the queue, a
workspace) or is tried again runs on that pick, as long as the split still lists it; a pick
whose entry was since removed is made again. A pick counts from the moment it is made, so a
start refused after it (a host that went away) still took its turn.

## Comparing them

Settings, Usage & Costs, "Engines compared" (`GET /api/usage/engines?start&end&project&split`):
per engine and model family, the tasks finished in the period, still open, assigned by the
split, median time to done, median and total cost, median tokens, review subtasks per task
(subtasks whose title starts with "Review" or "Reviewer"; a top-level task so named is work of its own), the
user's messages per task, reopens after completion, and tasks whose session had an error. A
task counts under the engine and model family that carried most of its cost (dollars first,
tokens only for a tie); counting only the split's tasks, it counts under the engine the split
assigned it, and "Moved to another engine" counts those whose cost mostly ran elsewhere. A
task with no usage recorded (or only requests with no token counts) has an unknown cost and
tokens, never a zero, and a start that failed counts as an error even after a later start
succeeded. A task counts in the period of the day it first finished, reopened or not, so its rework
stays with the work it reopened; one that never finished, by the day it started.

In that view each split entry is its own column, so two entries of one engine and family
(Claude Code and Claude Code on Sonnet) are compared side by side. A closed task that never
ran a turn (its start failed, on any engine) is neither finished nor open: it counts as not
started, as an error, and at a known cost of $0.

Time runs from when the work began to the first finish. The work begins at the earliest start of
a session that did work: Walnut keeps, once, when each session's first model turn ran
(`firstTurnAt` on the session record, from its first turn speed, prompt cache facts or an ACP turn's
context), so a CLI that died before its first reply and was resumed under the same id after a
reopen is timed from that turn. A session with no sign of a turn that died in error did no work;
an older record with no sign either way counts from its start. Every time a task completes is
kept (`completions` on the task, its earliest 8), so a close that came before the work began is no
finish: neither its date, its time nor its reopen counts, and the first completion after is.

`split=1` counts only the tasks the split assigned, the fair test (a lead may have picked an
engine by hand for the rest). `split=auto`, the card's default, does so while the split is on
and has assigned at least 10 tasks in the period, else counts every task; the answer says
which (`splitOnly`) and how many the split assigned (`splitTasks`). Code: `src/core/agents/engine-split.ts`,
`src/core/usage/engine-compare.ts`.
