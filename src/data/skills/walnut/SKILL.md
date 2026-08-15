---
name: walnut
description: >-
  Use the user's Walnut Personal AI from inside a coding session: create, list,
  update, and complete tasks, search their memory/tasks/sessions, and emit
  clickable task refs. Use when the user says "add a task", "put that on my
  list", "mark it done", "what's on my plate", "did I write anything about X",
  or whenever finished work should be recorded in Walnut rather than only in
  chat. Works through the `walnut` CLI over Bash, or the `walnut` MCP tools
  when they are mounted.
---

# Walnut (tasks, search, sessions)

Walnut is the user's task + knowledge hub. **Tasks are the atom**:
`Project → Task → Subtask`. Project is the only grouping layer; a task with no
project lives in the **Inbox**. Two ways in — use whichever is available:

- **CLI** (`walnut`, alias `open-walnut`) over Bash — always available.
- **MCP tools** (`task_create`, `task_list`, …) — available when the Walnut MCP
  server is mounted in this session. Prefer these when present: structured
  results, no shell quoting.

## CLI reference

```bash
walnut add "Fix the flaky auth test" --project marina --due 2026-08-20 --priority important
walnut tasks --status todo                 # todo | in_progress | done
walnut tasks --project marina              # pass --project "" for the Inbox
walnut done 9f3a                           # id prefix is enough
walnut recall "auth fixture"               # search tasks + memory
walnut projects                            # projects with task/session counts
walnut sessions                            # the user's other coding sessions
```

Add `--json` to ANY command for machine-readable output — parse that instead of
scraping the human table; `add` and `done` return the created/updated task
(including its `id` and `title`). Priorities:
`immediate | important | backlog | none`. Dates: `YYYY-MM-DD`.

## MCP tools (when mounted)

| Tool | What it does |
|---|---|
| `task_list` | Filter by `status` / `project` / `tag` / `q` |
| `task_get` | Full task detail (description, note, deps) — id prefix ok |
| `task_create` | New task: `title`, `project?`, `priority?`, `due_date?`, `description?` |
| `task_update` | Patch any subset of fields (`tags` is a full replace) |
| `task_complete` | Mark done |
| `task_delete` | Permanent delete — only on an explicit request |
| `search` | Global search over tasks, memory, sessions |
| `project_list` / `session_list` / `walnut_status` | Reads |

A read-only mount exposes only the read tools; if a write tool is missing, say
so instead of shelling out around the restriction.

## Ref emission (IMPORTANT)

After creating or completing a task, the tool result carries a **`ref`** string
that looks like `<task-ref id="…" label="…"/>`. **Paste that string verbatim
into your reply to the user.** Walnut's UI renders it as a clickable pill that
opens the task; without it the user gets a bare id they cannot click. Copy the
exact characters you were given — never re-format the tag. If the output has no
`ref` field, build the tag yourself from the returned `id` and `title`.

Example reply after creating a task:

> Logged it: <task-ref id="t_7d41c0a9" label="Fix the flaky auth test"/> — due
> Aug 20, in the `marina` project.

Do the same after completing one. Only emit the tag in natural-language text,
never inside a tool argument or a code block.

## When to use it

- The user asks for something to be tracked, deferred, or remembered → create a task.
- You finished a piece of work the user is tracking → complete that task and cite the ref.
- Before you create anything: `task_list` / `walnut recall` first, so a
  near-duplicate becomes an update instead of a second row.
- You need context the repo does not have (a decision, a past note) → `search`.

## Safety

- **Read before write.** Search or list first; duplicates are the most common
  damage an agent does here.
- **Never bulk-delete.** Delete a task only when the user explicitly asked for
  that specific deletion. Completing (`task_complete` / `walnut done`) is
  almost always the right action — it keeps the history.
- **Do not reopen or re-prioritize the user's tasks unprompted.** Changing
  `status`, `priority`, or `project` is the user's call unless they asked.
- One task per unit of work, with a title a human can scan later. Put detail in
  `description`, not in the title.
- A missing/unreachable server is not an error to work around: a tool that says
  *Walnut server not running* means the user must start it
  (`open-walnut web`) — report that instead of retrying in a loop.
