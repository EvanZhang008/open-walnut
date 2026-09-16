---
name: walnut-trigger
description: >-
  Watch something with a small script and act when it changes: write a check the
  daemon runs every few minutes, and get a prompt delivered into this session
  when it fires. Use when the user says "tell me when", "let me know if",
  "watch for", "keep an eye on", "as soon as X happens", "poll until", or wants
  to be pinged on new mail / PR comments / build results / a file appearing.
---

# Trigger

A trigger is a **check script + an interval + a prompt**. The daemon on the host
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
4. **Arm it**: `walnut tools call trigger_create '{"run":"bash ~/.open-walnut/triggers/<slug>/check.sh","every":"5m","prompt":"..."}'`.
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

## Managing them

- `trigger_list`: every trigger with its interval, host, and last check (fired
  with an item count / quiet with a reason / the error).
- `trigger_delete '{"id":"..."}'`: stop it. The script file stays on disk.
- The Routines page shows the same thing with an enable toggle, which is the
  kill switch.
