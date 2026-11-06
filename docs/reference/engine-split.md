# The engine split: share new tasks between coding engines

New task work can take turns between coding engines instead of all running on one. Turn it
on in Settings, Sessions, "Share new tasks" (check two or more entries: an engine, or an engine on a
model added there, such as Claude Code on sonnet; its switch turns the split off in one step and back
on with the entries kept, `engine_split_off: true`), or in `config.yaml`:

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
skipped (Claude Code always can). Settings offers a model only on an engine that takes one per
entry (Claude Code), with the models Claude Code lists as suggestions; a model outside that list (one
your proxy serves) is kept as typed, with a note to check the name. Reviewer subtasks (a subtask whose title starts with
"Review", "Reviewer", "Verifier", "Verify:" or "Verification:") take no turn: they count toward their parent's work. A model on an ACP entry is ignored; set `engines.<id>.model` instead.

The pick is kept on the task (`engine_pick`) and in `WALNUT_HOME/cache/engine-split.json`,
and the start's outcome names it with the shares it saw. A start that waited (the queue, a
workspace) or is tried again runs on that pick, as long as the split still lists it; a pick
whose entry was since removed is made again. A pick counts from the moment it is made, so a
start refused after it (a host that went away) still took its turn.

## Comparing them

Settings, Usage & Costs, "Engines compared" (`GET /api/usage/engines?start&end&project&split`):
per engine and model line (Claude Code on Opus and on Sonnet apart; a task whose usage names no
line joins its engine's one line when there is only one), the tasks finished in the period, still open, assigned by the
split, median time to done, median and total cost, median tokens, review subtasks per task and their cost (counts, never ranked: fewer reviews is not better work)
(subtasks whose title starts with "Review", "Reviewer", "Verifier", "Verify:" or "Verification:"; a top-level task so named is work of its own),
the share of finished tasks a reviewer on another company's model checked (Claude work reviewed by a
GPT model or the other way round: its usage's model, else its session's), the reviewer score
(function, UX and UI out of 10: a reviewer gives it as `score` on its reply or its `task_complete`,
kept on its task as `review_score`, also when the host answered it while the server was away (the
host journals it with the reply); a score out of 0 to 10 is refused with 400, never dropped; per task,
each company's latest score, the lower on each, a reviewer of no known company counting on its own;
per column, the median of each over the finished tasks scored on all three, with how many those are,
ranked by the lowest of the three; the verdict says when too few are scored to rank;
each task in the list shows its own and which companies gave it), the
user's messages per task, reopens after completion, and tasks whose session had an error. A
task counts under the engine and model that carried most of its cost (dollars first,
tokens only for a tie); counting only the split's tasks, it counts under the engine the split
assigned it, and "Moved to another engine" counts those whose cost mostly ran elsewhere (another
engine, another company's model, or for an entry naming a model line, another known line). Per task,
the model line that carried the most cost names its column, never the first model by name (an Opus
task with a small Haiku subagent is Opus work). A
task with no usage recorded (or only requests with no token counts) has an unknown cost and
tokens, never a zero, and a start that failed counts as an error even after a later start
succeeded. A task counts in the period of the day it first finished, reopened or not, so its rework
stays with the work it reopened; one that never finished, by the day it started.

A line above the table names who is ahead where (fastest, cheapest, fewest reopens, and so on),
from the same marks as the bold values, or says why no one is yet. Counting only the split's tasks, each split entry is its own column, so two entries of one engine and family
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
