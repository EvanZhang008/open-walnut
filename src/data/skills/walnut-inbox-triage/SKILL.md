---
name: walnut-inbox-triage
description: >-
  One Inbox Triage batch: reads, notes, decisions. Only for the Inbox Triage
  agent. Not for single messages, mail/Slack questions or task triage
  (the `walnut-triage` skill).
---

# One triage run

One batch, then stop.

1. Read `notes/Walnut/Triage/State.md` (its body rides the batch).
2. Read what the batch omits: `mail_list`, `mail_thread`, `slack_*`, `task_search`.
3. Match each item to a project and its tasks; update the tracking note
   (`project_tracking_get`, `project_tracking_ensure` if none).
4. Each item is one of:
   - **A task owns it** (a build failure mail, the task fixing that build):
     `task_send` it there, `expect_reply: false`, with sender, date, subject,
     message id and what it asks. That task carries on (and asks the user if
     it must); no letter for it.
   - **Needs the user**: homework first. Read the thread, search related mail,
     tasks and notes, `mail_draft` the likely reply. The letter says what you
     found, what you propose, and which button does it.
   - **Noise** (newsletter, ad, a notice asking nothing): mark it read if your
     run rules allow.
   - **FYI**: one line in the summary.
5. `human_inbox_send`: at most **one** `review` summary, only when needed.
   No handover FYIs. `task_refs`: touched tasks. Each email gets `items`:
   exact `source.account/message`, cached summary/display, fixed `mark_read`,
   `find_task`, `create_task` actions. No op target/goal/label/args. Ask-mode
   email work belongs there, not whole-letter buttons. Counts are snapshots;
   groups/omissions are not items. At most **three** `action_required` AI
   decisions; fold a 4th into the summary. Their taps ask THIS run, not ops.
   `human_inbox_reply` may add items with letter-wide unique IDs.
   `Reply for me` = draft + `mail_request_send`. Withdraw handled decisions.
6. Rewrite `State.md` (`## Awaiting`, `## Watching`, `## Recently handled`,
   `## Notes for next run`), append to `notes/Walnut/Triage/Runs/<YYYY-MM>.md`,
   `memory_write` what lasts.

`notes/Projects/<P>/Tracking.md` edits to `## Workstreams` need the
`content_hash` of a `note_read` in this run; `## Log` appends use the anchor.

## Never

- Send mail, post to Slack or unsubscribe yourself: ask with
  `mail_request_send`, `slack_request_post`, `mail_unsubscribe_request`.
- Mark mail read beyond your run rules, or Slack read at all.
- Delete, archive or move mail: no tool does it; do not ask.
- Invent a project or a task; re-handle an item under `## Recently handled`.
