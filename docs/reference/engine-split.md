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

Each entry's share is its weight. The start takes the entry with the fewest picks in the last
14 days per unit of weight (ties go to the earlier entry), so weights 1 and 1 alternate and
2 and 1 give the first two of every three. Only entries that can run where the start goes
are offered: an ACP engine the launch host has not reported installed is skipped (Claude
Code always can). A model on an ACP entry is ignored; set `engines.<id>.model` instead.

The pick is kept on the task (`engine_pick`) and in `WALNUT_HOME/cache/engine-split.json`,
and the start's outcome names it with the shares it saw. A start that waited (the queue, a
workspace) or is tried again runs on that pick, as long as the split still lists it; a pick
whose entry was since removed is made again. A pick counts from the moment it is made, so a
start refused after it (a host that went away) still took its turn.

## Comparing them

Settings, Usage & Costs, "Engines compared" (`GET /api/usage/engines?start&end&project&split`):
per engine and model family, the tasks finished in the period, still open, assigned by the
split, median time to done, median and total cost, median tokens, review subtasks per task
(subtasks with "review" in the title; a top-level task so named is work of its own), the
user's messages per task, reopens after completion, and tasks whose session had an error. A
task counts under the engine and model that carried most of its cost.

`split=1` counts only the tasks the split assigned, the fair test (a lead may have picked an
engine by hand for the rest). `split=auto`, the card's default, does so while the split is on
and has assigned at least 10 tasks in the period, else counts every task; the answer says
which (`splitOnly`) and how many the split assigned (`splitTasks`). Code: `src/core/agents/engine-split.ts`,
`src/core/usage/engine-compare.ts`.
