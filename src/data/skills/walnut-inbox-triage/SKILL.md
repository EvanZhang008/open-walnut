---
name: walnut-inbox-triage
description: >-
  The procedure for ONE Inbox Triage run: what to read, which notes to update,
  and what to ask. Use only when launched as the Inbox Triage agent with a batch
  of new mail and Slack items. Not for one message, not for triaging tasks (the
  `walnut-triage` skill), not for general mail or Slack questions.
---

# One triage run

One batch, worked once, then stop.

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
5. Letters (`human_inbox_send`): **at most one** summary (`review`, `task_refs`
   for every task touched), only for a decision or an item the user must know;
   handovers, notes and mark-read alone send none. At most **three**
   `action_required`, each with buttons (`Make a task` / `Reply for me` /
   `Unsubscribe` / `Ignore`); a 4th is refused: fold it into the summary. A tap
   returns to THIS run; act, then `human_inbox_reply`. `Reply for me` = a draft
   plus `mail_request_send`. Withdraw an earlier run's decision once handled.
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
