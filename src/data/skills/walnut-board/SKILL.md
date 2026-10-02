---
name: walnut-board
description: >-
  Keep a Board for a task that leads other tasks: one HTML page the user reads instead
  of your chat, with a section per area of work, a status strip, the owning tasks as
  live chips, a chat thread per section that reaches you, and marks the user leaves
  for you. Use when your task has workers (subtasks), when a job runs over days, when
  the user says "board", "track this", "where are we", "what needs me", or asks you
  to stop reporting in chat. Owns the board format, the walnut-* components, the
  board_* operations and the update discipline.
---

# Board

A leader's chat is noise: every worker that stops, every check, every question lands in
one scroll the user cannot follow. The Board is the standing surface instead. The user
opens the **Board** tab on your session (next to Files and Changed), reads the state of
every area, types a question under the section it belongs to, and leaves marks. You keep
the board current; Walnut keeps the chat threads, the marks and the task state live.

Born 2026-10-01 from a leader that ran 40 tickets through a hand-made HTML file: sections
by root cause, a status strip, per-section chat, red dots, personal marks. What that file
could not do, Walnut now does: the user's questions reach you, marks are readable by you,
task chips show live state.

## 1. The operations

| Operation | What |
|---|---|
| `board_get {task?}` | The board html, every thread's messages, every mark, and the live state of each task the board names. Read it before every edit. |
| `board_set {task?, html}` | Write the whole board. First version, or a rebuild. |
| `board_edit {task?, edits: [{old, new}]}` | Replace exact strings. Each `old` must occur ONCE in the current html, or nothing is written and the error names the edit. This is the normal way to update. |
| `board_post {task?, thread, text}` | Your answer or note in a section's thread. |

`task` defaults to your own task. A worker updating its leader's board passes the leader's
id (your prompt names it). Humans and any task in the leader's tree may write; nobody else.

A board is one page per leader. Never fork a second one; rewrite in place.

## 2. The components

Walnut renders the board in a sandboxed frame with these elements made live. Everything
else is your own HTML, CSS and script.

| Element | Renders | Notes |
|---|---|---|
| `<walnut-task id="TASK_ID">` | A chip with the task's live phase and title; click goes to the task | `compact` shows the title only. Always name a task through this element, never a bare id in text |
| `<walnut-thread id="area-a" title="Area A">` | That section's chat: composer, messages newest first, unread badge | `task="TASK_ID"` tells you which task a question is about. One thread per section; a thread at the bottom of the page is useless, the user cannot tell which issue it belongs to |
| `<walnut-mark id="area-a">` | The user's mark (Revisit, Reviewed, Waiting on others) and a note, saved in Walnut | You read them in `board_get` under `marks`. Put one in every section |
| `<walnut-strip>` | Counts of sections by status, click to filter | Counts elements carrying `data-status="decide|wip|wait|done"`; `labels="decide:Needs you,…"` renames |
| `<walnut-unread>` | Total unread messages across threads | Put it in the header |

Thread and mark ids are stable names (`[A-Za-z0-9][A-Za-z0-9._:-]*`, up to 128 chars). Renaming
one orphans its messages and marks, so pick them once per section.

## 3. The shape of a good board

Start from the template in section 6, keep its `<style>`, replace the sections.

- **Sections are areas of work, not buckets.** A root cause, a workstream, a decision. No
  "all new items" section, no "other" section. A new item goes into the section whose cause
  it shares; a new cause gets a new section.
- **Every section carries `data-status`**: `decide` (needs the user), `wip` (a task is on it),
  `wait` (waiting on someone else), `done`. The strip reads it.
- **Every section has**: one line of what it is; the facts (a small grid: cause, mitigation,
  fix, what needs the user); the owning tasks as `<walnut-task>` chips, each with one line of
  what it is doing and why; a `<walnut-thread>`; a `<walnut-mark>`.
- **Header**: title, when you last checked, `<walnut-strip>`, `<walnut-unread>`.
- **Footer**: a "Live check" table (item, live status, meaning, owning task, time of the
  check). Anything you claim on the board, you checked live first.
- Write the board in the language the user speaks to you; identifiers, ids, log lines and
  commands verbatim. Real HTML boxes and arrows for a diagram, never ASCII art in `<pre>`.

## 4. The discipline

- **Before writing a status, re-pull the live state.** `task_get_bulk {"ids":[…],"fields":["title","phase","summary","progress","last_session_update"]}` for every task the board names, plus whatever external state the section tracks. A task's summary lags; a board that says "waiting for review" while the review is done loses the user's trust at once.
- **Edit small.** One `board_edit` pass per change, several edits in one call when they belong together. Rebuild with `board_set` only when the structure changes.
- **A user's question in a thread is three writes**: your answer with `board_post`, the change it caused in that section's facts or status with `board_edit`, and one line about it in your chat reply (Walnut writes your task's note and work log from your session; there is no op for it). Walnut delivers the question into your session with the thread and the task it is about; answer in the thread, not only in chat.
- **Marks are the user talking to you without typing.** Read `marks` on every `board_get`: "Revisit" means the section is not done for them, "Waiting on others" means stop asking.
- **A worker's area belongs to the worker.** When a thread's question is about a task you lead, hand it over with `task_send` and show that task's live chip and last step in the section; do not investigate it yourself.
- **Keep the board current, not complete.** The user reads it between your turns. Update it when a worker reports, when a decision lands, when you learn something that changes a status, and at the end of every turn that changed anything.

## 5. Starting one

1. `board_get` to see whether a board exists.
2. Take the template below, fill the header and one section per area you lead, with the real `<walnut-task>` ids from `task_list` or your `open_items`.
3. `board_set {"html": …}`. Tell the user in one line that the Board tab is up and that they can ask under any section.
4. From then on, `board_edit` and `board_post`.

## 6. Template

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
  main { max-width:1100px; margin:0 auto; padding:16px 20px 60px; }
  details.cat { background:var(--card); border:1px solid var(--line); border-radius:12px; margin:10px 0; overflow:hidden; }
  details.cat > summary { list-style:none; cursor:pointer; padding:12px 16px; display:flex; gap:12px; align-items:center; }
  details.cat > summary::-webkit-details-marker { display:none; }
  details.cat > summary .no { width:32px; height:32px; border-radius:9px; color:#fff; display:grid; place-items:center; font-weight:700; flex:none; }
  details.cat[data-status="decide"] .no { background:var(--decide); }
  details.cat[data-status="wip"] .no { background:var(--wip); }
  details.cat[data-status="wait"] .no { background:var(--wait); }
  details.cat[data-status="done"] .no { background:var(--done); }
  details.cat > summary h3 { margin:0; font-size:15px; }
  details.cat > summary .one { color:var(--mute); font-size:13px; }
  .body { padding:0 16px 16px; display:grid; gap:12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
  .cell { border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .cell h4 { margin:0 0 4px; font-size:12px; color:var(--mute); text-transform:uppercase; letter-spacing:.04em; }
  .owners { display:grid; gap:6px; }
  .owners li { list-style:none; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; border-bottom:1px solid var(--line); padding:6px 8px; vertical-align:top; }
</style>
</head>
<body>
<header>
  <h1>Campaign name</h1>
  <div class="sub">Last checked 2026-10-01 18:40Z · <walnut-unread></walnut-unread></div>
  <walnut-strip></walnut-strip>
</header>
<main>

<details class="cat" data-status="decide" open>
  <summary><span class="no">A</span><div><h3>Area A: what this is in one line</h3><div class="one">Why it matters, in one more line</div></div></summary>
  <div class="body">
    <div class="grid">
      <div class="cell"><h4>Cause</h4>What is actually happening and the evidence.</div>
      <div class="cell"><h4>Mitigation</h4>What stops the bleeding now, and its state.</div>
      <div class="cell"><h4>Fix</h4>The real fix, who owns it, where it stands.</div>
      <div class="cell"><h4>Needs you</h4>The decision, with the recommended answer.</div>
    </div>
    <ul class="owners">
      <li><walnut-task id="TASK_ID_1"></walnut-task> What it is doing and why.</li>
    </ul>
    <walnut-thread id="area-a" title="Area A" task="TASK_ID_1"></walnut-thread>
    <walnut-mark id="area-a"></walnut-mark>
  </div>
</details>

<h2>Live check</h2>
<table>
  <tr><th>Item</th><th>Live status</th><th>Meaning</th><th>Owner</th><th>Checked</th></tr>
  <tr><td>Change 123</td><td>OPEN, 1 approval</td><td>Fix for area A waits on review</td><td><walnut-task id="TASK_ID_1" compact></walnut-task></td><td>18:40Z</td></tr>
</table>

</main>
</body>
</html>
```
