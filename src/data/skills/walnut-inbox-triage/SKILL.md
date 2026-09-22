---
name: walnut-inbox-triage
description: >-
  The procedure for ONE Inbox Triage run: what to read, which notes to update,
  and what to ask. Use only when you were launched as the Inbox Triage agent and
  handed a batch of new mail and Slack items. Not for reading one message, not
  for triaging tasks (that is the `triage` skill), not for general questions
  about mail or Slack.
---

# One triage run

You were handed a batch. Work through it once, then stop.

## Order

1. Read `notes/Walnut/Triage/State.md` (its body rides the batch when it exists).
2. Read only what the batch does not already tell you: `mail_read`, `slack_*`,
   `task_search`, `task_list`.
3. Match each item to a project and the tasks that already exist. Items that
   match nothing existing are reported, not filed.
4. Update the project's tracking note (`project_tracking_get`, then
   `project_tracking_ensure` if it has none yet).
5. Ask the tasks that are affected: `task_send` with `expect_reply`.
6. Write **at most one** summary letter and **at most three** decision letters
   (`human_inbox_send`). A fourth is refused — fold the rest into the summary.
7. Before you finish: rewrite `State.md`, append one line to
   `notes/Walnut/Triage/Runs/<YYYY-MM>.md`, and `memory_write` anything durable
   you learned (a sender's meaning, a channel → project route, a stated
   preference).

## The notes

| Note | Holds | Write |
|---|---|---|
| `notes/Walnut/Triage/State.md` | `## Awaiting` (rq-/lt- ids), `## Watching`, `## Recently handled`, `## Notes for next run` | rewrite each run |
| `notes/Walnut/Triage/Runs/<YYYY-MM>.md` | one line per run | append |
| `notes/Projects/<P>/Tracking.md` | `## Status`, `## Workstreams`, `## Open questions`, `## Log` | per item |

Concurrency rules, both enforced: a `## Workstreams` edit needs the
`content_hash` from a `note_read` you did in THIS run (an edit without it is
refused, and you re-read and retry once). A `## Log` append targets the heading
anchor and needs no read.

## Never

- Never send mail, post to Slack, mark anything read, or unsubscribe yourself.
  Ask: `mail_request_send`, `slack_request_post`, `mail_unsubscribe_request`.
  In `assist` mode you may create and update tasks and notes directly; sending
  and posting still go through approval.
- Never invent a project, and never create a task for something the user has not
  shown they care about. A thing you are unsure about belongs in the summary.
- Never re-handle an item listed under `## Recently handled`.
