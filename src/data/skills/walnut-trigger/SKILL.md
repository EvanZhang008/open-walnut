---
name: walnut-trigger
description: >-
  Watch something with a small script and act when it changes: write a check the
  daemon runs every few minutes, and get a prompt delivered into this session
  when it fires. Use when the user says "tell me when", "let me know if",
  "watch for", "keep an eye on", "as soon as X happens", "poll until", or wants
  to be pinged on new mail / PR comments / build results / a file appearing.
  Also when the user says "snooze until", "wait until", "park this until",
  "come back to this when". Use it on your own, without being asked, whenever
  the rest of the work waits on something outside the session (a review, a
  merge, a deploy, a build, a reply): creating the trigger parks the task as
  Waiting, and the fire brings it back.
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
- **Limits.** 30s timeout (max 300), one run at a time, never faster than
  every 10s, and a fire budget: `maxFiresPerDay` (default 24) fires in a burst,
  refilling at that many per 24 hours, so a spent budget gives back one fire
  every 24h / cap (an hour at the default). A fire the budget holds back is late,
  not lost: the daemon keeps your previous `state` cursor and the next allowed
  check reports the same items again, in one fire with everything newer. One
  fire carries at most 200 new items; with more, the cursor is kept too and the
  next check carries the rest. Keep stdout under 64 KB even after a long hold:
  print the oldest items first, at most a few hundred, and move the cursor only
  to the last one you printed.
- **Pick the budget for the source.** A busy source checked often (a chat
  channel, a mailbox) can fire on most checks, so set `maxFiresPerDay` to the
  checks per day it runs: 288 for every 5 minutes, 96 for every 15. Keep the
  default for things that change a few times a day (a PR, a build). `0` = no
  limit. The user can change it later on the Routines page (Edit, "Fires per
  day"), and Walnut tells them the first time each day the budget holds a fire.

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
   This also **parks this task as Waiting** (see "Waiting is the default"
   below). Pass `"wait":false` while you still have work to do here.
5. **Report the id and the cadence.** Then stop; do not poll the trigger yourself.

Default cadence when the user gave none: **every 5 minutes**. Never poll faster
than 10s, and prefer a slower interval for anything hitting a network API.

## Prompt writing

The prompt is what a session receives WITH the items. Write it as an
instruction, not a notification: "Read each new comment; change the code where it
asks, then reply on the PR" beats "there are new comments". The fire already
carries the items as JSON, so do not ask the model to go re-fetch them.

When the user asked to be told ("tell me when X", "let me know if"), say so in
the prompt: "send the user a letter (human_inbox_send) saying X happened". That
letter is one they asked for. Without that ask, a fire sends no letter.

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

## Waiting is the default

A trigger exists because something is not done yet, so `trigger_create` on this
session's own task **parks the task as Waiting** in the same call:

- The task leaves the user's default task list (it keeps its board section; the
  user reveals it with "Show waiting") and the end of your turn does not hand it
  back.
- No letter goes to the user's inbox: a park is not news, and the inbox is
  only for what needs them. End the turn with one line saying what the task
  waits on; the user reads it in this session, and the task's trigger card
  says what is watched.
- The next message into this session (the fire, the user, a peer task) moves it
  to In Progress on its own; that turn ends as Need Action like any other.
- Nothing else in THIS turn moves it: not your further output, a background
  agent coming back, or the turn's end. So if you find, later in the same turn,
  that the user is needed after all, take it back yourself:
  `task_update '{"id":"<this task's id>","phase":"NEED_ACTION"}'`.

**Use it on your own.** When the rest of the work waits on something outside
this session (a review, a merge, a deploy, a build, a CI run, a reply from a
person), do not ask the user to watch it or to "make a trigger": write the
check, arm it, and end the turn. That is what keeps their list short. Ask one
short question only when you genuinely cannot tell what to watch (which PR,
which channel).

**But not while work remains.** If you or the user still have work on this
task (more changes to make, the user is mid-conversation with you about it),
pass `"wait":false`: the trigger is armed and the task stays where it is. Park
it later, once only the wait is left, as the LAST call of that turn:

```
walnut tools call task_update '{"id":"<this task's id>","phase":"WAITING"}'
```

**`wait_until`** is the clock. Without it the task comes back by itself 3 days
from now, whether or not anything happened: Walnut wakes this session with a
note and the task returns the normal way. Pass an ISO datetime or a duration
from now (`"6h"`, `"2d"`) when the user named a time ("by Friday either way",
"give it a week") or the thing has a natural deadline. Pass `"wait_until":""`
only when the user explicitly wants no time limit.

- A trigger on ANOTHER task does not park it unless you pass `"wait":true`.
  A completed task is never parked.
- Make the check fire ONCE per event: give each event an item id (the PR's
  state + revision, the message id), so an unchanged state is quiet.
- Write the `prompt` for the moment it fires: "Check what changed on PR 123 and
  do the next step: make requested changes, merge when approved, tell the user
  only what needs them."
- When it fires and the event does not need the user (an acknowledgement, an
  intermediate stage, a change you can make yourself), handle it, then park
  again as the last call with `task_update` WAITING, and send no letter. The
  trigger keeps polling and keeps what it has seen. Write to the user's inbox
  only when the event needs them (a decision, a blocker) or they asked to hear
  about it.
- When the work it watched is done, `trigger_delete` it, so it stops firing.
- When the user writes to this session meanwhile, the task is In Progress again;
  answer them. If the plan still holds, park it again as your last call. If the
  plan changed ("don't wait", "wait for X instead"), `trigger_delete` the old
  trigger and arm the new one if there is one.
- The task menu's "Start / Snooze until › Something happens…" starts this for
  the user as `/walnut-trigger Snooze this task until: X`.

## Managing them

- `trigger_list`: every trigger with its description, interval, host, state
  (`armed`, `paused` with `pausedAt`, `stopped` after 5 failed checks in a row),
  and last check (fired with an item count / quiet with a reason / the error).
- `trigger_pause '{"id":"..."}'`: stop checking for now. The trigger stays on
  its task marked Paused, with a Resume button. Use it for "pause that", "stop
  for a while"; delete only when the user wants it gone.
- `trigger_resume '{"id":"..."}'`: turn it back on. It picks up where it left
  off: whatever appeared while it was paused arrives as ONE fire on the first
  check (a few seconds after resume; up to 200 items, the rest on the next
  check), ids it delivered in the last 30 days are not delivered again, and the
  fire budget still applies (a spent budget delivers the backlog on a later
  check, never drops it). After about 30 days paused it may have forgotten
  what it saw and start over like a new trigger. Resuming a stopped trigger
  retries its check; fix the script first, since one more failure stops it
  again.
- `trigger_delete '{"id":"..."}'`: remove it for good. The script file stays on
  disk.
- The task's TRIGGER pill and the Routines page show the same thing, with Pause
  and Resume.
