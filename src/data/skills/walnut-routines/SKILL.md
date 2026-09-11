---
name: walnut-routines
description: >-
  Create and manage routines — scheduled automations that run on a trigger
  (cron / interval / one-shot) with a pluggable executor (main-agent,
  walnut-agent, or claude-code, each a Claude Code session, local or remote host).
  Use when the user says "every morning", "every weekday", "remind me daily",
  "schedule", "routine", "automate this", "run X at Y time", or wants to set up
  a recurring job / virtual employee.
---

# Routines

A routine = **trigger + executor**. You manage them through the `/api/v1/routines`
endpoints, reached with the `api` operation (there is no named routine op yet). Your job
is the same as the UI's "Draft routine" flow: turn the user's natural-language request
into a fully-specified routine, confirm the interpretation briefly, then create it.

## Executor types (where the routine runs)

Every executor that thinks runs a `claude` session; they differ in whose session it is.

| type | when to choose | config |
|---|---|---|
| `main-agent` | "tell me / remind me / message me": send the instructions into the user's Ask Walnut conversation, so the answer lands where they are already reading | `{ instructions }` |
| `walnut-agent` | standalone research/summary with no repo: starts a FRESH Personal AI session with its own task under project "Routines", watchable in the session panel | `{ instructions, model?, timeoutSeconds? }` |
| `claude-code` | coding/repo work, "run in <dir>", "on <host>": starts a coding session in that directory (the default choice in the UI form) | `{ instructions, cwd (required), host? (omit = local), model? }` |

A `walnut-agent` run is fire-and-forget: the routine is "ok" once its session started, so its
summary names what was started, never the model's conclusion. Pick `main-agent` when the user
must read an answer, `walnut-agent` when the work should live on the board as its own session.

- `host` must be one of the configured host aliases (check `~/.open-walnut/config.yaml` hosts, or omit for local).
- Write `instructions` as a clear briefing — numbered steps for multi-part work,
  like a task you'd hand a capable assistant. The executor gets ONLY this text.

## Schedule (trigger) shapes

```
{ "kind": "cron",  "expr": "<5-field cron>", "tz": "<IANA tz>" }   // recurring (preferred)
{ "kind": "every", "everyMs": <number> }                            // simple interval
{ "kind": "at",    "at": "<ISO datetime>" }                         // one-shot
```

Interpretation rules:
- Interpret times in the **user's timezone** and always set `tz` on cron schedules.
- "weekdays" → dow `1-5`; "weekends" → `0,6`; "every morning" → 9:00 unless told otherwise.
- Examples: weekdays 9am → `0 9 * * 1-5`; daily 7:30am → `30 7 * * *`;
  Mondays 5pm → `0 17 * * 1`; hourly at :15 → `15 * * * *`.

## Calls

Create:
```
walnut tools call api '{"method":"POST","path":"/api/v1/routines","body":{
  "name":"Weekday PR summary",
  "schedule":{"kind":"cron","expr":"0 9 * * 1-5","tz":"America/Los_Angeles"},
  "executor":{"type":"claude-code","config":{"instructions":"1. List open PRs…\n2. …","cwd":"/path/to/repo"}}
}}'
```

The rest, same shape:

| what | call |
|---|---|
| list | `GET /api/v1/routines?includeDisabled=true` |
| read one | `GET /api/v1/routines/{id}` |
| change | `PATCH /api/v1/routines/{id}` with the changed fields |
| enable / disable | `POST /api/v1/routines/{id}/toggle` |
| run now | `POST /api/v1/routines/{id}/run` |
| delete | `DELETE /api/v1/routines/{id}` |
| what executors and hosts exist | `GET /api/v1/routines/executors` |
| scheduler health | `GET /api/v1/routines/status` |

## Workflow

1. Extract: what to do (instructions), when (schedule), where (executor + cwd/host).
2. If the request implies repo work but gives no directory, ask for the cwd —
   don't guess a path.
3. Create with `POST /api/v1/routines`, then confirm to the user with the
   plain-English schedule ("Weekdays at 9:00 AM") and the routine id.
4. The routine appears in the Routines panel on the homepage; `claude-code` and
   `walnut-agent` runs both create a task under project "Routines" and a visible
   session, so the user can open one and read what happened.
