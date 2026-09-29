---
name: walnut-trigger
description: >-
  Watch something with a small script and act when it changes: write a check the
  daemon runs every few minutes, and get a prompt delivered into this session
  when it fires. Use when the user says "tell me when", "let me know if",
  "watch for", "keep an eye on", "as soon as X happens", "poll until", or wants
  to be pinged on new mail / PR comments / build results / a file appearing.
  Also when the user says "snooze until", "wait until", "park this until",
  "come back to this when": trigger_create with wait_until then snoozes the task
  on the trigger, with no red dot until it fires.
---

# Trigger

A trigger is a **check script + an interval + a prompt + a description**. The daemon on the host
runs the script; when it says something happened, Walnut delivers the prompt into
a session (the same conversation, resumed if it has gone quiet; a new session on
the same task only if none can be resumed). You write the script, test it, arm it.
Nothing polls inside your session.

## The contract

The script reads ONE JSON object on stdin and prints ONE JSON object as the
**LAST line of stdout**. Log freely above that line.

```
stdin :  {"state": <what you printed last run, or null>, "lastFireAt": "<ISO>|null", "now": "<ISO>"}
stdout:  {"fire": true, "items": [{"id": "PR-123#c9", "title": "..."}], "input": "...", "state": {"cursor": "..."}}
         {"fire": false, "state": {"cursor": "..."}}
```

- **`items` vs a bare fire.** With `items`, the daemon dedups on `id`: only ids it
  has never delivered count, so a run whose ids are all known is quiet. Use it
  whenever the thing you watch has identity (a comment, a message, a file, a
  build). With **no** `items`, `fire: true` fires EVERY time it is true, so only
  do that when the script itself decided "this is new".
- **`input` vs `state`.** `input` is the script talking to the AI **this run**
  (max 8 KB, free text). `state` is the script talking to its **next run** (a
  cursor, stored verbatim, handed back on stdin). They are never merged, and
  `state` is never shown to the AI.
- **Errors.** Non-zero exit, a timeout, no JSON on the last line, or over 64 KB
  of stdout is a check error. Five in a row disable the trigger and notify.
- **Limits.** 30s timeout (max 300), 24 fires/day, one run at a time, never
  faster than every 10s.

## Templates

Write the script under `~/.open-walnut/triggers/<slug>/check.sh`, `chmod +x` not
required (it runs through `sh -c`).

```bash
#!/usr/bin/env bash
# bash + jq: new comments on a PR
set -euo pipefail
STDIN=$(cat)             # {"state":...,"lastFireAt":...,"now":...}
CURSOR=$(printf '%s' "$STDIN" | jq -r '.state.cursor // ""')
gh pr view 123 --json comments \
  | jq -c --arg cursor "$CURSOR" '
      [ .comments[] | select(.createdAt > $cursor) ] as $new
      | { fire: ($new | length > 0),
          items: [ $new[] | { id: (.url), title: (.author.login + ": " + (.body[0:80])) } ],
          state: { cursor: ([ $cursor, (.comments[-1].createdAt // $cursor) ] | max) } }'
```

```javascript
// node: a file appeared in a directory
const fs = require('fs');
const dir = process.env.HOME + '/Downloads';
let stdin = ''; process.stdin.on('data', (c) => stdin += c).on('end', () => {
  const seen = new Set((JSON.parse(stdin || '{}').state?.seen) ?? []);
  const now = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'));
  const fresh = now.filter((f) => !seen.has(f));
  console.log(JSON.stringify({
    fire: fresh.length > 0,
    items: fresh.map((f) => ({ id: f, title: f })),
    state: { seen: now.slice(-500) },
  }));
});
```

## Credentials

Keep tokens out of `run`. The command line is stored with the routine (it syncs
with the rest of Walnut's data), shows on the Routines card and in
`trigger_list`, and a failing `curl -v` echoes headers into the error text.
Read a token inside the script file instead (from the environment, a keychain,
or a file only that host has), and never paste one inline as `curl -H
'Authorization: Bearer ...'` in `run`.

## Order of operations

1. **Write the script** to `~/.open-walnut/triggers/<slug>/check.sh`.
2. **Test until it parses**: `walnut tools call trigger_test '{"run":"bash ~/.open-walnut/triggers/<slug>/check.sh"}'`.
   Keep going until `parsed` is non-null. `wouldFire: false` with `parsed` set is a
   working check with nothing to report: that is a pass, not a failure.
3. **Tell the user in ONE line** what will be watched and how often, before arming it.
4. **Arm it**: `walnut tools call trigger_create '{"run":"bash ~/.open-walnut/triggers/<slug>/check.sh","every":"5m","prompt":"...","description":"..."}'`.
   `description` is required (see below).
   `session` defaults to `"this"`, so the fire lands in this conversation (resumed
   if it has gone quiet by then). `cwd` and `host` default to this session's.
5. **Report the id and the cadence.** Then stop; do not poll the trigger yourself.

Default cadence when the user gave none: **every 5 minutes**. Never poll faster
than 10s, and prefer a slower interval for anything hitting a network API.

## Prompt writing

The prompt is what a session receives WITH the items. Write it as an
instruction, not a notification: "Read each new comment; change the code where it
asks, then reply on the PR" beats "there are new comments". The fire already
carries the items as JSON, so do not ask the model to go re-fetch them.

## Description writing

The description is for the USER, on the task's trigger card, where the rest is a
name and `bash …/check.sh @ host`. Without it nobody can tell what fires the
trigger. One or two plain sentences, 600 characters at most, covering three things:

1. **What is watched**, naming the real source: the PR number, the channel, the
   folder, the build.
2. **When it fires**: the condition, and the cadence when it matters.
3. **What the session does** when it fires.

- Good: "Checks PR 123 for new review comments every 5 minutes. When one arrives,
  the session makes the requested change and replies on the PR."
- Good: "Watches ~/Downloads for new PDF invoices. Each new one is filed into the
  Finance notes with its amount and due date."
- Bad: "Runs check.sh" (says nothing), "PR watcher" (that is a name), or the
  script explained line by line.

Write it in the language you use with the user.

## Snooze until something happens (park the task on the trigger)

When the user says "snooze this task until X" or "wait until X" about the task
this session works on, the task should go quiet until X happens, then come back
to them. The task menu's "Start / Snooze until › Something happens…" starts that
message for them as `/walnut-trigger Snooze this task until: X`. Do the steps
above (script, test, one line to the user), and arm it with `wait_until`, the
condition in the user's words. That one call creates the trigger and snoozes the
task on it before its first check runs:

```
walnut tools call trigger_create '{"run":"bash ~/.open-walnut/triggers/<slug>/check.sh","every":"5m","prompt":"...","description":"...","wait_until":"CR 1234 is approved","wait_ttl":"3d"}'
```

- `wait_until` is one line in the user's words; it is shown on the task.
- `wait_ttl` is the backstop (default 7 days, "90m" / "12h" / "3d", up to 30
  days): if the trigger has not fired by then, the task comes back to the user
  anyway, in case the check never works. Size it to when the user would want to
  hear that it has not happened yet: a build or a deploy, hours; a review or a
  reply, a few days; a date, just past it. Tell the user the backstop in the
  same one line.
- The task stays **To Do** and visible. What changes: when your turn ends it does
  NOT go to Need Action and gets no red dot. Do not set it to Need Action
  yourself afterwards: that ends the wait.
- Make the check fire ONCE per event: give each event an item id (the CR's
  state + revision, the message id), so an unchanged state is quiet.
- Write the `prompt` for the moment it fires: "Check what changed on CR 1234 and
  tell the user what it means and the next step."
- When it fires, the message carries a note: the wait is over and the task goes
  back to the user as Need Action when that turn ends. If the event does not need
  the user yet (an acknowledgement, an intermediate stage), keep waiting with
  `task_wait` and the SAME `routine_id`, then end the turn: the trigger keeps what
  it has seen, and the backstop stays where it was unless you pass `ttl`.
  `walnut tools call task_wait '{"condition":"CR 1234 is approved","routine_id":"<id>"}'`
- A message from the user does NOT end the wait: answer it, and the task goes
  back to its quiet To Do when the turn ends (the user sees "still snoozed" with
  an Unsnooze button). If the message changes the plan ("don't wait", "wait for
  X instead"), call `task_stop_waiting` (it also deletes the trigger), then arm
  the new one if there is one.
- Ask one short question when the condition is ambiguous (which CR, which
  channel, a time that already passed) instead of guessing; you usually know
  from the conversation.

## Managing them

- `trigger_list`: every trigger with its description, interval, host, and last
  check (fired with an item count / quiet with a reason / the error).
- `trigger_delete '{"id":"..."}'`: stop it. The script file stays on disk.
- The Routines page shows the same thing with an enable toggle, which is the
  kill switch.
