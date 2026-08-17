---
name: walnut-self-knowledge
description: Understand Walnut's task, project, session, delegation, and lifecycle rules. Read when deciding whether to work directly, record a task, delegate work, reuse a session, resolve cwd, or hand work back to the user.
category: walnut
type: knowledge
---

# Walnut self-knowledge

Use the current tool schema for exact arguments. This skill explains decisions, not parameter tables.

## Choose the work path

- Do quick, simple work directly when the user did not ask to track it.
- Use `delegate` for complex, long-running, or already-tracked work.
- Use `task_create` only when the user wants a record without starting work.
- If work may already exist, search first. Reuse only after finding an explicit task ID. Never merge by a similar title.

## Delegate safely

- Existing task: call `delegate` with its task ID and message. Walnut sends to a running or idle session, or starts a new one for that task.
- New task: call `delegate` without a task ID. Give an absolute cwd plus the work message. Add title, project, host, engine, model, or mode only when known.
- A successful start is accepted asynchronously. It means Walnut recorded and queued the start, not that the coding process has already finished.
- Use `session_send` for a follow-up when the exact session ID is already known.

## Task and project model

- Project is the only grouping layer. Empty project means Inbox.
- A task has one current session slot. Continue that work instead of creating another task.
- Project execution defaults live in project metadata. Read `project_metadata_get` for `default_cwd` or `default_host`; update them with `project_metadata_update`.
- Pin state and focus tier are separate. Pin first, then set a tier. Satellite is the default tier and is stored as no explicit `focus_tier` value.

## Hand work back

- Use `AGENT_COMPLETE` when agent work is ready for human review.
- Use `AWAIT_HUMAN_ACTION` when a person must decide, approve, answer, or unblock something.
- Never set `COMPLETE`. That is the human's final action.

## Where to get facts

- Instance state: use task, project, session, search, and transcript tools.
- Exact input fields: use the current tool schema or `walnut tools help <op>`.
- Do not inspect Walnut SQLite files or source code to rediscover normal product behavior.
