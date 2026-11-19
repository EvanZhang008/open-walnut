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
- A host problem (kind `host`) is judged like an error: the person's only when they must clear
  it (`HOST_SIGN_IN_KINDS`: a login of theirs, a changed host key, Claude Code signed out there;
  reason `sign-in`) or it answers their own Retry or Connect (`own-action`), by
  `hostProblemNeedsYou`. Every other one (a machine that is off or asleep, a network, a daemon
  that did not start) Walnut reconnects by itself: no toast, no bell row or dot, listed under
  Walnut Health › Background errors › Remote hosts with its full hint (2026-11-17, the user: a
  Mac that was not connected asked him to run `walnut net status`).
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
| A host's follower server that did not start (one item per host, recovered once it runs) | Walnut Health |
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
| Workspace cleanup and setup notices, sort hints, Undo | Person: they answer the person's own action |
| A host problem toast, bell row and bell dot (`kind: 'host'`) | Person only for a login or their own Retry; every other host problem: Walnut Health (Remote hosts) |
| A system notification (`postSystemNotice`, the one exit) | Person: asks and reminders only (permission, a question, an approval); held whole during quiet |
| A native `alert()` | Never (only the dialog's own fallback outside its provider) |

iOS (`ios-native/`) reads no notification feed: its banners and alerts answer the person's own
action on the phone, and its freeze and crash reports reach the server as above. The Mac app's
system notifications (`desktop/NotificationBridge.swift`) are approvals only. The session daemon
raises nothing itself; what it reports reaches the server's log or a session's error, both
Walnut Health's.

## Walnut Health looks into its own errors

Every minute `src/core/notifications/health-investigate.ts` counts, per category, Walnut
Health's open errors that keep happening (3 times or more, or open for 30 minutes) and reports
the gauge `health.errors{category=<slug>}`. The health monitor's built-in alarm `health.errors`
reads it: one alarm instance per category, so one category is one investigation however many
errors it holds, under the engine's own rules (one fix task per instance, the daily cap, the
delay before a new one, and `health_monitor.fix_tasks`: `record` files the task, `start` starts
an agent on it, `off` files none). The brief (`health-monitor/brief.ts`) lists the category's
errors and the rules: a safe step that can be undone (reconnect, restart a service, clear a
rebuildable cache, retry, a code fix landed the usual way) the agent takes alone and records; a
step on the person's data, credentials, permissions, money, someone else's machine, a deletion
or an outward send it does not take. Then, and when it cannot find a fix, it sets its task to
`NEED_ACTION` with "Possible problem: what, because why. My pick: the step", which is the only
way an investigation reaches the person (2026-11-17, the user: "if no risk just fix, if there
is an issue, then show as a potential error notification").

A remote host that stays down for a reason Walnut has to clear is looked into the same way:
`src/core/hosts/host-down-gauge.ts` reports `host.down{host=<alias>}` each minute, and the
built-in alarm `host.down` dials the host again after 30 minutes (auto-fix `host-reconnect`),
then opens one fix task for that host when that does not hold, with the host's own words in the
brief. Walnut Health's own errors take at most 3 of the day's 5 fix tasks, so a burst of
categories never leaves a disk or restart alarm without one.

## Once per problem until it heals

A problem the person sees toasts once, and not again while it lasts (2026-11-17, the user: "if
it show once don't show it so many times"). A host toasts once until it heals, however its cause
flips meanwhile (`web/src/utils/host-problem-toasts.ts`); the server's error that names a reason
toasts once per `dedupKey` until a recovery says it healed
(`web/src/contexts/notifications/toast-once.ts`). Both memories survive a reload. Healed and
broken again is a new time. The person's own click that fails is not held to it.

## Notices outside the window, and quiet

A system notification (a macOS notification posted by the Mac app, a web Notification) has one
exit, `web/src/contexts/notifications/system-notice.ts`; a push to the phone has one gate,
`src/core/push/quiet-hold.ts`. While quiet holds (a focus block, macOS Focus mirrored by Rhythm,
the person's own toggle) both hold everything, asks included, and send one notice when quiet
ends. See [notification-lifecycle.md](./notification-lifecycle.md) for quiet mode itself.
`tests/web/notice-single-exit.test.ts` fails on a system notification posted anywhere else and
on a kind of notice with no audience decided; `tests/core/notifications/notice-audience.test.ts`
on a push sender that skips the gate.

## Adding a notice

- A new error is Walnut Health's by default. Give it a `needsYou` reason only when the person
  must act and nothing else can fix it, and add the file to the test's list with why.
- A new reason is a decision: add it to `NEEDS_YOU_REASONS` with one line on what it means.
- Never call a toast or a native alert from a page for a request nobody clicked: let it retry
  (`web/src/api/background-retry.ts`) and log it.
