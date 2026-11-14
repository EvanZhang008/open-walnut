---
name: walnut-inbox-triage
description: >-
  One Inbox Triage batch of Slack messages: reads, notes, decisions. Only for
  the Inbox Triage agent. Not for mail (the mail router owns it), single
  messages, Slack questions or task triage (the `walnut-triage` skill).
---

# One triage run

One batch, then stop. The batch is Slack only: new mail goes to the mail
router, never to this run.

1. Read `notes/Walnut/Triage/State.md` (its body rides the batch).
2. Read what the batch omits: `slack_*`, `task_search`.
3. Match each item to a project and its tasks; update the tracking note
   (`project_tracking_get`, `project_tracking_ensure` if none).
4. Each item is one of:
   - **A rule matches it** (the batch lists rules and matches):
     `triage_route` it. No letter.
   - **A task owns it**: `task_send` it there, `expect_reply: false`, with
     sender, conversation, time, a link and what it asks. No letter for it.
   - **Needs the user**: homework first. Read the thread, search related
     tasks and notes, write the likely reply. The letter says what you found,
     what you propose, and which button does it.
   - **FYI**: one line in the summary.
5. `human_inbox_send`: at most **one** `review` summary, only when needed.
   No handover FYIs. `task_refs`: touched tasks. Walnut adds Talk to CEO /
   New task to each item. At most **three** `action_required` AI decisions;
   fold a 4th into the summary. Their taps ask THIS run, not ops.
   `human_inbox_reply` may add items with letter-wide unique IDs.
   `Reply for me` = `slack_request_post`. Withdraw handled decisions.
6. Rewrite `State.md` (`## Awaiting`, `## Watching`, `## Recently handled`,
   `## Notes for next run`), append to `notes/Walnut/Triage/Runs/<YYYY-MM>.md`,
   `memory_write` what lasts.

`notes/Projects/<P>/Tracking.md` edits to `## Workstreams` need the
`content_hash` of a `note_read` in this run; `## Log` appends use the anchor.

## Never

- Post to Slack yourself: ask with `slack_request_post`.
- Mark Slack read, or touch mail at all.
- Invent a project or task (none from a message); redo `## Recently handled`.
