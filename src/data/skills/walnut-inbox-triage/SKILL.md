---
name: walnut-inbox-triage
description: >-
  The procedure for ONE Inbox Triage run: what to read, which notes to update,
  and what to ask. Use only when launched as the Inbox Triage agent with a batch
  of new mail and Slack items. Not for one message, not for triaging tasks (that
  is the `triage` skill), not for general mail or Slack questions.
---

# One triage run

One batch, worked once, then stop.

## Order

1. Read `notes/Walnut/Triage/State.md` (its body rides the batch when present).
2. Read only what the batch omits: `mail_read`, `slack_*`, `task_search`,
   `task_list`.
3. Match each item to a project and tasks that already exist.
4. Update the project's tracking note: `project_tracking_get`, then
   `project_tracking_ensure` if it has none.
5. Ask the tasks affected: `task_send` with `expect_reply`.
6. Write the letters (below).
7. Then rewrite `State.md`, append a line to
   `notes/Walnut/Triage/Runs/<YYYY-MM>.md`, and `memory_write` what lasts (a
   sender's meaning, a channel → project route, a preference).

## Letters (`human_inbox_send`)

- **One** summary: `review`, with `task_refs` for every task you touched.
- **Three** decisions at most: `action_required`, each with buttons —
  `Make a task` / `Reply for me` / `Unsubscribe` / `Ignore`. No buttons is
  refused, and so is a 4th: fold the rest into the summary, and do not retry.
- A tap comes back into THIS run, even hours later. Act, then `human_inbox_reply`.
  `Reply for me` means a DRAFT plus `mail_request_send`, never a send.
- Withdraw a decision an earlier run left behind once its item is handled.

## The notes

- `notes/Walnut/Triage/State.md` — rewrite every run: `## Awaiting` (rq-/lt- ids),
  `## Watching`, `## Recently handled`, `## Notes for next run`.
- `notes/Walnut/Triage/Runs/<YYYY-MM>.md` — append one line per run.
- `notes/Projects/<P>/Tracking.md` — per item: `## Status`, `## Workstreams`,
  `## Open questions`, `## Log`. A `## Workstreams` edit needs the `content_hash`
  from a `note_read` in THIS run, or it is refused. A `## Log` append targets the
  heading anchor.

## Never

- Never send mail, post to Slack, mark anything read, or unsubscribe yourself:
  ask with `mail_request_send`, `slack_request_post`, `mail_unsubscribe_request`.
  Your run instructions say what `assist` adds; those three never change.
- Never invent a project, and never create a task for something the user has not
  shown they care about; if you are unsure, say so in the summary.
- Never re-handle an item under `## Recently handled`.
