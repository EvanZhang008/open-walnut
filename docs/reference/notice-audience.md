# Who sees a notice: the person, or Walnut Health

One rule decides it for every notice in Walnut, in one file:
`src/core/notifications/audience.ts` (`audienceOf`). The server and the web app read the same
file (the web app through the `@open-walnut/notice-audience` alias), so they can never decide
differently. The answer is derived from the record each time, never stored, so a record an
older version wrote is classified by today's rule. A card written before `needsYou` existed keeps
its person by the key its producer has always used (`LEGACY_PERSON_KEYS`: a plugin sign-in, a
mail sign-in, disk critical, sync safe mode, a found host, an interrupted chat), so an upgrade
never moves an open sign-in card into Walnut Health. `GET /api/notifications` and
`/api/v1/notifications` carry the answer as `audience` on each record.

- **user**: a toast in the corner stack and a row in the bell.
- **health**: Settings › Walnut Health › Background errors only. Never a toast, never in the
  bell. Grouped by category, with how many times, first and last seen, the raw details behind
  each row, and "Fix with agent" where Walnut's source can be worked on.

The rule (2026-11-17, the user: only the errors he needs to see reach him, the rest goes to
Walnut Health, where whoever investigates finds them):

- Asks, letters, reminders and automation receipts are the person's.
- An error is the person's only when it names why it needs them (`needsYou`, a closed list):
  `sign-in` (sign in again or finish setup), `disk-full` (writes stop), `sync-stopped` (data
  sync stopped and waits for a person), `own-action` (an action they took failed for good),
  `plugin-asks` (a plugin's `error()` with `needsYou: true`).
- Every other error is Walnut Health's: it is Walnut's to retry or fix.

Both kinds live in the same store (`notifications.json`) and share one lifecycle (recovery,
expiry, dismissal; see [notification-lifecycle.md](./notification-lifecycle.md)). Past the store's
200-record cap, Walnut Health's records go first (ended ones, then open ones past its newest 50),
so a storm of background errors never pushes out a pending ask, a letter or a sign-in card.
The cloud companion's cards carry their reason to the Mac. `occurrences` counts every occurrence the producer reported
(Walnut Health's number); `count` stays the bell's "came back after a recovery" fold.

## Every source, classified

Server (`tests/core/notifications/notice-audience.test.ts` lists every writer of the store and
every reason; a new one fails there):

| Source | Goes to |
|---|---|
| Any `log.error` / `log.fatal` line (the log bridge) | Walnut Health |
| A session or subagent error, a delivery failure, a context-full hold, a hand-back | Walnut Health (the session's own panel shows it where it happened) |
| A route that answered 5xx | Log only (no record at all) |
| Data backup, git auto-commit, repo size, compaction, keep-awake, send-path canary | Walnut Health |
| Data sync safe mode (sync stopped on a suspicious mass change) | Person (`sync-stopped`) |
| Data disk critically full; the disk-space health alarm | Person (`disk-full`) |
| Data disk filling up (warning) | Walnut Health |
| Any other health alarm Walnut could not fix itself | Walnut Health (its alarm row too) |
| A plugin that needs a sign-in or setup (sync and connection notices) | Person (`sign-in`) |
| A plugin sync or full reconcile that keeps failing | Walnut Health |
| A plugin's `notifications.error()` | Walnut Health, or the person with `needsYou: true` (a plugin written before this option existed: Walnut Health) |
| A plugin handler that threw | Walnut Health |
| Mail: an account whose sign-in stopped working | Person (`needsYou: true`) |
| A found host the person said Connect to that cannot be added or connected | Person (`own-action`) |
| A phone app freeze or crash report | Walnut Health (category "Phone app") |
| A chat message of the person's that a restart left unanswered | Person (`own-action`: only they can resend it) |
| Permission asks, letters, plugin reminders | Person |
| Routine receipts (cron, watcher, missed runs, a parked task woke), skill and hook receipts | Person (feed only: they never toast, except a hook the person set to notify) |

Web app (`tests/web/notice-single-exit.test.ts` lists every site; a new one fails there):

| Source | Goes to |
|---|---|
| `notify()` with `kind: 'operation-error'` from a page (17 files) | Person: each answers an action they took (`own-action` is stamped by notify) |
| The task store's operation error (`showOperationError`, 9 files) | Person: a task change they made |
| An app dialog (`useAlert`, 10 files) | Person: an action they took; its message goes through `operationErrorWords` |
| The agent's credentials failed (`agent:error`, auth) | Person (`sign-in`) |
| Any other agent turn failure (`agent:error`) | Its chat only; the server logs it (Walnut Health) |
| A host problem toast (`kind: 'host'`) | Person: a machine their work runs on cannot be used, with Retry |
| Workspace cleanup and setup notices, sort hints, Undo | Person: they answer the person's own action |
| A system notification (`new Notification`) | Person: asks only (permission, a question, an approval) |
| A native `alert()` | Never (only the dialog's own fallback outside its provider) |

iOS (`ios-native/`) reads no notification feed: its banners and alerts answer the person's own
action on the phone, and its freeze and crash reports reach the server as above. The Mac app's
system notifications (`desktop/NotificationBridge.swift`) are approvals only. The session daemon
raises nothing itself; what it reports reaches the server's log or a session's error, both
Walnut Health's.

## Adding a notice

- A new error is Walnut Health's by default. Give it a `needsYou` reason only when the person
  must act and nothing else can fix it, and add the file to the test's list with why.
- A new reason is a decision: add it to `NEEDS_YOU_REASONS` with one line on what it means.
- Never call a toast or a native alert from a page for a request nobody clicked: let it retry
  (`web/src/api/background-retry.ts`) and log it.
