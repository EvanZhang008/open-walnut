---
name: walnut-board
description: >-
  Keep a Board for a task that leads other tasks: one HTML page the user reads instead
  of your chat, with an overview, one section per area of work (a board project) whose
  status Walnut keeps, the owning tasks as live chips, points the user ticks as read,
  decisions as numbered choices, a chat thread per section that reaches you, the
  user's notes, and reminders. Use when your task has workers (subtasks), when a job runs over days,
  when the user says "board", "track this", "where are we", "what needs me", or asks
  you to stop reporting in chat. Owns the board format, the walnut-* components, the
  board_* operations and the rules for writing a board.
---

# Board

A leader's chat is noise: every worker that stops, every check, every question lands in
one scroll the user cannot follow. The Board is the standing surface instead. The user
opens the **Board** tab on your session (next to Files and Changed), reads the state of
every area, ticks what they have read, answers decisions, sets a project's status, types
a question under the section it belongs to, and leaves notes. You keep the board current;
Walnut keeps the threads, the notes, the statuses, the read ticks, the answers, the
reminders and the task state live.

Born 2026-10-01 from a leader that ran 40 tickets through a hand-made HTML file: sections
by root cause, a status strip, per-section chat, red dots, personal marks. What that file
could not do, Walnut now does: the user's questions, answers and status picks reach you,
notes and read ticks are readable by you, task chips and section status show live state.

## 1. The operations

| Operation | What |
|---|---|
| `board_get {task?}` | The board html, every thread's messages, the user's notes (`marks`), the projects and their status (`status_by: "human"` is the user's pick), which points the user read (and which changed since), the user's answers, the reminders, and the live state of each task the board names. Read it before every edit. |
| `board_set {task?, html}` | Write the whole board. First version, or a rebuild. |
| `board_edit {task?, edits: [{old, new}]}` | Replace exact strings. Each `old` must occur ONCE in the current html, or nothing is written and the error names the edit. This is the normal way to update. |
| `board_post {task?, thread, text}` | Your answer or note in a section's thread. One message per post. The outcome names the new message id. |
| `board_post_delete {task?, thread, id}` | Delete one of your own posts (a wrong or outdated answer). The user can delete any post from the Board tab. |
| `board_project_set {task?, id, title?, status?, tasks?, delete?, override_user?}` | A project's status (`decide`, `wip`, `wait`, `done`, or `""` to clear), title and tasks. The page recolors on its own. A status the user picked stays theirs: changing or removing it is refused unless you pass `override_user: true`. |
| `board_remind {task?, target, at, note?}` | A reminder on a choice or a thread (`at` is an ISO time, `""` clears). |

**A team shares one board**: the nearest ancestor that has a board, else the root
leader's. Every `board_*` call defaults to it, so a worker updates the shared board
without naming the leader, and the outcome says when the board is the leader's. Pass
`task` only to reach another board. Humans and any task in the leader's tree may write;
nobody else.

A board is one page per team. Never fork a second one; rewrite in place.

## 2. The components

Walnut renders the board in a sandboxed frame with these elements made live. Everything
else is your own HTML, CSS and script.

| Element | Renders | Notes |
|---|---|---|
| `<walnut-task id="TASK_ID">` | A chip with the task's live phase and title; click opens the task | `compact` shows the title only. Always name a task through this element, never a bare id in text |
| `data-project="ID"` on a section | Walnut sets the element's `data-status` from that project's status | So your CSS and `<walnut-strip>` recolor and recount when `board_project_set` runs. Put it on the section, not also on its overview row |
| `<walnut-project id="ID">` | A status pill and the project's tasks as compact live chips. The user clicks the pill to pick a status | Put it in the section's heading and in the overview row. The user's pick is stored as theirs and delivered to your session |
| `<walnut-check id="ID">text</walnut-check>` | A point the user ticks as read | Walnut hashes the text: when you edit it, it comes back unread with a "changed" hint. Every fact, cause, fix and to-do is one |
| `<walnut-choice id="ID" title="…" options="a:Label,b:Label" recommended="a" task="TASK_ID">` | Numbered option buttons, the recommended one tagged | The user's pick is stored and delivered to your session. `options` is `key:Label` pairs split by commas, so a label holds no comma. Gets a Remind me control |
| `<walnut-thread id="area-a" title="Area A">` | That section's conversation: messages oldest first, the composer below (typed or by voice), unread badge | `task="TASK_ID"` tells you which task a question is about. Messages render light markdown. Gets a Remind me control. One thread per section; a thread at the bottom of the page is useless, the user cannot tell which issue it belongs to |
| `<walnut-mark id="area-a">` | The user's note for you: an "Add note" button until it has text, saved in Walnut | A light note left after a glance; not delivered, you read it in `board_get` under `marks`. The status is `<walnut-project>`'s, not the note's |
| `<walnut-strip>` | Counts of sections by status, click to filter | Counts elements carrying `data-status="decide|wip|wait|done"`; `labels="decide:Needs you,…"` renames |
| `<walnut-unread>` | Total unread messages and due reminders | Put it in the header |

Ids (`[A-Za-z0-9][A-Za-z0-9._:-]*`, up to 128 chars) are stable names. Renaming one
orphans its messages, notes, ticks and answers, so pick them once.

A **board project** is one area on this board: one cause or one ticket. It is NOT a
Walnut project (the `project` field of a task); the two never mix.

## 3. What the user needs from a board

1. **Ask the user as little as possible.** Decide low-impact things yourself and record the decision on the board. Ask only for production or cloud writes and deletions, messages to other teams, money, customer-facing actions, and design choices that change who gets paged.
2. **Never ask the user to resolve or close something whose work is not finished.** List it as a to-do with its trigger ("after change 123 deploys").
3. **Every ask and every point explains itself in plain words**: what the thing is (an id alone is unreadable), the options, what happens either way, your recommendation, the link.
4. **Every reference is a link with a plain label**: a change, a ticket, a task chip, a doc, a pipeline, a chat thread.
5. **Sections are areas of work, not buckets.** Each section is one board project: one cause or one ticket, never a bundle. There is no "all new items" and no "other" project. A new item goes into the project whose cause it shares; a new cause gets a new project.
6. **Every fact, cause, fix and to-do is its own `<walnut-check>` point.** The user ticks what they read; a point you edit comes back unread on its own.
7. **Decisions are `<walnut-choice>`** with numbered options and the recommended one marked. Explain the options in the points above it; keep each label short.
8. **Project status lives in Walnut** (`board_project_set`, or the user's pick on the pill), never in hand-edited html. `data-status` in your html is only the starting value. One status per project, one source: what the user picked is the status.

## 4. The layout

- **An overview first**: one row per project with its status (`<walnut-project>`, which the user can change there), the latest update, the next step, what needs the user, and the user's note (`<walnut-mark>`) in that row, where they look first.
- **Then the projects stacked top to bottom, like an article.** No side-by-side grids unless the content really is a comparison.
- **Each project opens with** overview, latest update, needs you (the choice), to do, done; long details folded in `<details>`; the thread at its end.
- **Put the user's note in the overview row or at the bottom of a section**, never beside the text.
- **A section you changed shows the user a red dot on its own.** You do nothing for it.
- **A choice the user answered leaves the needs-you list by itself**: give the overview row of a decision `data-choice="<choice id>"`.
- **Header**: title, when you last checked, `<walnut-strip>`, `<walnut-unread>`.
- Write the board in the language the user speaks to you; identifiers, ids, log lines and commands verbatim. Real HTML boxes and arrows for a diagram, never ASCII art in `<pre>`.

## 5. The discipline

- **Before writing a status, re-pull the live state.** `task_get_bulk {"ids":[…],"fields":["title","phase","summary","progress","last_session_update"]}` for every task the board names, plus whatever external state the project tracks. A task's summary lags; a board that says "waiting for review" while the review is done loses the user's trust at once.
- **Edit small.** One `board_edit` pass per change, several edits in one call when they belong together. Rebuild with `board_set` only when the structure changes.
- **A user's question in a thread is three writes**: your answer with `board_post`, the change it caused in that section's points or status with `board_edit` / `board_project_set`, and one line about it in your chat reply (Walnut writes your task's note and work log from your session; there is no op for it). Walnut delivers the question into your session with the thread and the task it is about; answer in the thread, not only in chat.
- **A thread is a conversation.** One message per post: never paste a history as one blob, post it message by message. Light markdown. The user answers in the thread's own composer (typed or by voice), never in your chat.
- **Statuses, notes, read ticks and choices are the user talking to you without typing.** A status the user picks arrives in your session like a choice answer: "Waiting on others" or "Done" means stop asking about it, "Needs you" means they want it raised. It stays theirs; do not move it back on your next `board_project_set` unless the work itself moved, and then say why in the section. Read notes on every `board_get`. A changed point they had read needs nothing from you, they see it unread. A choice answer also arrives in your session: act on it, then update that section.
- **When the user says "later", set a reminder** (`board_remind`, or they use the Remind me control). When it comes due Walnut tells you in your session and the board shows it due; raise that item with the user again.
- **A worker's area belongs to the worker.** When a thread's question is about a task you lead, hand it over with `task_send` and show that task's live chip and last step in the section; do not investigate it yourself.
- **Keep the board current, not complete.** The user reads it between your turns. Update it when a worker reports, when a decision lands, when you learn something that changes a status, and at the end of every turn that changed anything.

## 6. Starting one

1. `board_get` to see whether your team has a board.
2. Take the template below, fill the header, one overview row and one section per area you lead, with the real `<walnut-task>` ids from `task_list` or your `open_items`.
3. `board_set {"html": …}`, then `board_project_set` for each project's status and tasks. Tell the user in one line that the Board tab is up and that they can ask under any section.
4. From then on, `board_edit`, `board_project_set` and `board_post`.

## 7. Template

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Board</title>
<style>
  :root { --ink:#1f2430; --mute:#5b6472; --line:#e5e8ee; --bg:#f3f4f7; --card:#fff;
          --decide:#d13400; --wip:#2f6feb; --wait:#b45309; --done:#15803d; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 -apple-system,"Segoe UI",sans-serif; }
  header { position:sticky; top:0; z-index:5; background:var(--card); border-bottom:1px solid var(--line); padding:12px 20px; }
  header h1 { margin:0; font-size:18px; }
  header .sub { color:var(--mute); font-size:12.5px; margin:2px 0 10px; }
  main { max-width:960px; margin:0 auto; padding:16px 20px 60px; }
  h2 { font-size:15px; margin:22px 0 8px; }
  table { border-collapse:collapse; width:100%; font-size:13px; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  th, td { text-align:left; border-bottom:1px solid var(--line); padding:6px 8px; vertical-align:top; }
  section.project { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--line); border-radius:12px; margin:14px 0; padding:4px 16px 14px; }
  section.project[data-status="decide"] { border-left-color:var(--decide); }
  section.project[data-status="wip"] { border-left-color:var(--wip); }
  section.project[data-status="wait"] { border-left-color:var(--wait); }
  section.project[data-status="done"] { border-left-color:var(--done); }
  section.project h3 { margin:12px 0 4px; font-size:15px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  section.project h4 { margin:14px 0 4px; font-size:12px; color:var(--mute); text-transform:uppercase; letter-spacing:.04em; }
  ul.points { margin:0; padding:0; list-style:none; display:grid; gap:4px; }
  details { margin-top:10px; }
</style>
</head>
<body>
<header>
  <h1>Campaign name</h1>
  <div class="sub">Last checked 2026-10-01 18:40Z · <walnut-unread></walnut-unread></div>
  <walnut-strip></walnut-strip>
</header>
<main>

<h2>Overview</h2>
<table>
  <tr><th>Project</th><th>Status</th><th>Latest update</th><th>Next step</th><th>Needs you</th><th>Your note</th></tr>
  <tr data-choice="area-a-purge">
    <td><a href="#area-a">Area A: cached settings outlive a change</a></td>
    <td><walnut-project id="area-a"></walnut-project></td>
    <td>The fix is merged and deploying.</td>
    <td>Purge the cache after change 123 deploys.</td>
    <td>When to purge (in the section).</td>
    <td><walnut-mark id="area-a"></walnut-mark></td>
  </tr>
</table>

<section class="project" id="area-a" data-project="area-a" data-status="decide">
  <h3>Area A: cached settings outlive a change <walnut-project id="area-a"></walnut-project></h3>

  <h4>Overview</h4>
  <ul class="points">
    <li><walnut-check id="area-a-cause">Every host keeps a copy of the settings for 24 hours, so a change takes a day to reach all of them.</walnut-check></li>
  </ul>

  <h4>Latest update</h4>
  <ul class="points">
    <li><walnut-check id="area-a-fix">The fix, <a href="LINK">change 123: keep the copy 5 minutes instead</a>, is merged and deploying (<a href="LINK">pipeline</a>).</walnut-check></li>
  </ul>

  <h4>Needs you</h4>
  <ul class="points">
    <li><walnut-check id="area-a-options">Waiting for the deploy has no risk, but old copies live up to 24 more hours. Purging now refreshes every host at once and slows reads for about a minute. I recommend waiting.</walnut-check></li>
  </ul>
  <walnut-choice id="area-a-purge" title="When to purge the cache" task="TASK_ID_1"
    options="wait:Wait for change 123 to deploy,now:Purge now" recommended="wait"></walnut-choice>

  <h4>To do</h4>
  <ul class="points">
    <li><walnut-check id="area-a-todo-purge">After change 123 deploys: purge the cache and confirm the hit rate recovers.</walnut-check></li>
  </ul>

  <h4>Done</h4>
  <ul class="points">
    <li><walnut-check id="area-a-done-cause"><walnut-task id="TASK_ID_1" compact></walnut-task> found the cause and wrote the fix.</walnut-check></li>
  </ul>

  <details><summary>Details</summary>
    <p>The evidence, the log lines and the timeline, for when the user wants them.</p>
  </details>

  <walnut-thread id="area-a" title="Area A" task="TASK_ID_1"></walnut-thread>
</section>

</main>
</body>
</html>
```
