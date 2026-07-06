---
name: walnut-routines
description: >-
  Create and manage routines — scheduled automations that run on a trigger
  (cron / interval / one-shot) with a pluggable executor (main-agent,
  walnut-agent, or claude-code session, local or remote host).
  Use when the user says "every morning", "every weekday", "remind me daily",
  "schedule", "routine", "automate this", "run X at Y time", or wants to set up
  a recurring job / virtual employee.
---

# Routines

A routine = **trigger + executor**. You manage them with the `cron_manage` and
`cron_list` tools. Your job is the same as the UI's "Draft routine" flow: turn
the user's natural-language request into a fully-specified routine, confirm the
interpretation briefly, then create it.

## Executor types (where the routine runs)

| type | when to choose | config |
|---|---|---|
| `main-agent` | "tell me / remind me / message me" — inject into this main conversation | `{ instructions }` |
| `walnut-agent` | standalone research/summary that reports back; no repo needed | `{ instructions, model?, timeoutSeconds? }` |
| `claude-code` | coding/repo work, "run in <dir>", "on <host>" — starts a real Claude Code session (shows up in the Sessions panel) | `{ instructions, cwd (required), host? (omit = local), model? }` |

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

## Tool calls

Create:
```
cron_manage action=add name="Weekday PR summary"
  schedule={"kind":"cron","expr":"0 9 * * 1-5","tz":"America/Los_Angeles"}
  executor={"type":"claude-code","config":{"instructions":"1. List open PRs...\n2. ...","cwd":"/path/to/repo"}}
```

Other actions: `update` (job_id + changed fields), `toggle`, `run` (manual
trigger now), `remove`, `status`. List everything: `cron_list include_disabled=true`.

## Workflow

1. Extract: what to do (instructions), when (schedule), where (executor + cwd/host).
2. If the request implies repo work but gives no directory, ask for the cwd —
   don't guess a path.
3. Create with `cron_manage action=add`, then confirm to the user with the
   plain-English schedule ("Weekdays at 9:00 AM") and the routine id.
4. The routine appears in the Routines panel on the homepage; claude-code runs
   create a task under project "Routines" and a visible session.
