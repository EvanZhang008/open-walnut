---
name: walnut
description: >-
  Walnut is the user's personal AI for tasks, projects, memory, notes, coding
  sessions, and search. Use for ANY question about Walnut itself or the data it
  holds: server status, mode, or version; which task or session produced a
  given commit; what is on the user's plate; creating, updating, completing,
  searching, or recalling tasks, memory, and notes; handing finished work back
  for human review; sending the human a letter (human inbox) when work finishes
  or a decision is needed. Triggers: "add a task", "put that on my list", "what's on
  my plate", "did I write anything about X", "which task/session did X". Read
  this BEFORE guessing subcommands, running --help, inspecting files, or
  reaching for git: those guess, this gives the exact call. Works through the
  `walnut` CLI over Bash (the same `walnut` command works inside managed sessions on any host), or the
  Walnut MCP tools when mounted.
---

# Walnut (tasks, search, sessions)

Walnut is the user's task + knowledge hub. **Tasks are the atom**:
`Project → Task → Subtask`. Project is the only grouping layer; a task with no
project lives in the **Inbox**. Two ways in — use whichever is available:

- **CLI** (`walnut`, alias `open-walnut`) over Bash — always available.
- **MCP tools** (`task_create`, `task_list`, …) — available when the Walnut MCP
  server is mounted in this session. Prefer these when present: structured
  results, no shell quoting.

## Start here: one command answers "what can I call?"

**Any Walnut question is an operation call. Never guess a subcommand, and never
answer from `git` or a file read a question about the user's tasks, sessions, or
commits.** The catalog below is generated from the live registry, so the op names
in it always exist:

```bash
walnut tools list                          # every op, with a one-line purpose
walnut tools help search                   # one op's exact arguments
walnut tools call walnut_status '{}'       # run it (~0.2s — every data command is this fast)
walnut tools call <op> @/tmp/args.json     # read the payload from a file (required over ~128KB)
walnut tools call <op> -                    # read the payload from stdin
```

Measured cost of skipping this (2026-08-19 A/B): asked for the server mode, an
agent ran `walnut --help`, guessed, and answered `mode=stdio` — wrong, and it had
actually invoked the MCP server. `walnut tools call walnut_status '{}'` returns
`{"mode":"LIVE","version":"0.3.2"}` in one call. When in doubt, `tools list`.

Batch several calls into ONE Bash invocation so you pay one round of tool
overhead instead of three:

```bash
walnut tools call walnut_status '{}'; walnut tools call project_list '{}'; walnut tools call search '{"q":"registry","limit":3}'
```

Every op is also an HTTP route on the local server (`search` → `GET /search`,
`task_list` → `GET /api/tasks` (server-root, the canonical composable query),
`task_create` → `POST /tasks`, `walnut_status` →
`GET /status`; `tools help <op>` prints the exact one), so
`curl -s http://127.0.0.1:3456/api/v1/...` works too — no auth on the primary
box. The CLI is the primary surface; both run the same registry, so they never
disagree.

### Recipes for the questions that get answered wrong

| Question | Do this |
|---|---|
| Which task/session produced commit `<sha>`? | `walnut tools call search '{"q":"<sha>"}'` — indexed commit SHAs resolve to the owning task AND session (`matchField: commit_sha`); take the FIRST hit, a commit can appear in forks. **Do NOT use `git log`**: the mapping lives in Walnut's index, not in the repo. |
| Is the server up / which version? | `walnut tools call walnut_status '{}'` |
| What did session `<id>` do? | `walnut tools call session_transcript '{"id":"<id>"}'` |
| Review the pinned board | `walnut tools call task_list '{"working_set":true}'` returns the WHOLE board (no default limit). Its `board` field carries the server's own per-tier counts: compare your bucketing against them before reporting numbers, and never report a result whose `truncated` is true as the full picture. |
| State of many tasks at once | `walnut tools call task_get_bulk '{"ids":["...","..."],"fields":["title","phase","progress"]}'`: one call, up to 50 ids, only the fields you name. `progress` is the note's status bullets ([DONE]/[WIP]/[WAIT]/[TODO]/[BLOCKED]) without the multi-KB Work Log. Do NOT loop `task_get`. |
| Find anything by words | `walnut tools call search '{"q":"..."}'` — searches tasks, memory, and session transcripts together. Add `"types":"session"` only when you specifically want transcripts. |
| First search empty or wrong | Re-query in the OTHER language before giving up: the data is bilingual (Chinese titles on English work and vice versa) and search bridges zh↔en only weakly. "task 消失" misses the task titled "remove the task one by one"; "tasks disappear one by one" finds it. Translate the key phrase, keep proper nouns as-is. |

## CLI reference

```bash
walnut add "Fix the flaky auth test" --project marina --due 2026-08-20 --priority important
walnut tasks --status todo                 # todo | in_progress | done
walnut tasks --project marina              # pass --project "" for the Inbox
walnut done 9f3a                           # complete a task (id or unique prefix)
walnut recall "auth fixture"               # search tasks + memory
walnut projects                            # projects with task/session counts
walnut sessions                            # the user's other coding sessions
```

Add `--json` to ANY command for machine-readable output — parse that instead of
scraping the human table. `add` returns the created task; `done`
returns the completed task (both include `id` and `title`). Priorities:
`immediate | important | backlog | none`. Dates: `YYYY-MM-DD`.

<!-- ops-catalog:begin (generated by scripts/generate-ops-docs.mjs, do not edit inside) -->

## Operations catalog

Prefer the named operations below. Their schemas are the current source of truth for exact arguments.

| Op | What | Args |
|---|---|---|
| `task_list` | List / query Walnut tasks (read) | status? (todo\|in_progress\|done): Legacy 3-state: todo \| in_progress \| done; completion? (string): Comma list of todo \| in_progress \| complete (in_progress includes AGENT_COMPLETE); phases? (string): Comma list of exact phases: TODO \| IN_PROGRESS \| AGENT_COMPLETE \| COMPLETE; project? (string): Project name (exact, case-insensitive); "" for the Inbox; projects? (string): Comma list of project names; priorities? (string): Comma list of immediate \| important \| backlog \| none; source? (string): Task source (exact), e.g. "local"; sprint? (string): Sprint name (exact); tag? (string): Exact tag match (single); tags_any? (string): Comma list : match tasks carrying ANY of these tags; tags_all? (string): Comma list : match tasks carrying ALL of these tags; pinned? (boolean): Filter pinned/unpinned tasks; focus_tier? (string): Comma list of pin tiers: focus \| satellite \| backlog \| wait \| a custom ct_* id. Only pinned tasks match; satellite = pinned with no stored tier; working_set? (boolean): Shortcut: the WHOLE pinned board (all tiers, completed pins included) sorted by pin_order : no default limit, so the board is never silently cut; unread? (boolean): Tasks with agent output the human has not opened yet; blocked? (boolean): Tasks blocked/unblocked by incomplete dependencies; parent_task_id? (string): Children of this parent task (exact id); group_id? (string): Members of a virtual group (exact id, e.g. "g_xxx"); q? (string): Case-insensitive substring on the task title; ids? (string): Comma list of exact task ids : fetch a specific set in one call; time_basis? (created\|updated\|created_or_updated\|due\|completed): Which timestamp the window filters: created \| updated \| created_or_updated \| due \| completed; last_hours? (integer): Relative window: the last N hours; last_days? (integer): Relative window: the last N days; time_from? (string): Absolute window start (inclusive), ISO-8601 or YYYY-MM-DD; time_until? (string): Absolute window end (exclusive), ISO-8601 or YYYY-MM-DD; sort? (updated_desc\|created_desc\|completed_desc\|priority\|title_asc\|pin_order): Result order (default updated_desc; working_set defaults to pin_order); limit? (integer): Max rows (1-200), applied after sort. Default 50, EXCEPT working_set=true which returns the whole board unless you pass a limit; fields? (list\|full, default "list"): list = slim rows (default); full = every field including note (heavy : combine with ids or a small limit) |
| `task_get` | Get one Walnut task (read) | id (string): Task id or a unique id prefix |
| `task_get_bulk` | Get many Walnut tasks with chosen fields (read) | ids (array<string>): Task ids (exact, or a unique id prefix) : 1 to 50 per call; fields? (array<string>): Fields to return: title \| status \| phase \| project \| priority \| tags \| start_date \| due_date \| end_date \| created_at \| updated_at \| completed_at \| pinned \| focus_tier \| pin_order \| unread \| blocked_by \| last_session_update \| summary \| note \| progress \| dates. Omit for the triage default (title, status, phase, project, priority, due_date, updated_at, pinned, focus_tier, unread, summary) |
| `task_create` | Create a Walnut task (write) | title (string): Task title (required); project? (string): Project name; omit or "" for the Inbox; priority? (immediate\|important\|backlog\|none): immediate \| important \| backlog \| none; due_date? (string): YYYY-MM-DD or a full ISO-8601 datetime; description? (string): Longer body text (write-only); pinned? (boolean): Join the pinned board (default true). false keeps the task off the board; focus_tier? (string): Pin tier the task is born into (implies pinned): focus \| satellite \| backlog \| wait \| a registered ct_* id. Omit for Satellite; unknown tiers are rejected, not silently downgraded |
| `task_update` | Update a Walnut task (write) | id (string): Task id or a unique id prefix; status? (todo\|in_progress\|done): Legacy status: todo \| in_progress \| done; phase? (TODO\|IN_PROGRESS\|AGENT_COMPLETE\|COMPLETE): Task lifecycle phase; priority? (immediate\|important\|backlog\|none); due_date? (string): ISO-8601 date/datetime, or "" to clear; start_date? (string): ISO-8601 date/datetime, or "" to clear; project? (string): Project name; "" = Inbox; title? (string): New title (non-empty, <= 500 chars); description? (string): Replaces the description (write-only); tags? (array<string>): FULL replacement of the task tags |
| `task_complete` | Complete a Walnut task (write) | id (string): Task id or a unique id prefix |
| `task_merge` | Merge duplicate Walnut tasks (write, local-only) | survivor_id (string): Task id (or unique prefix) that survives the merge; victim_ids (array<string>): Duplicate task ids to merge into the survivor and delete |
| `task_delete` | Delete a Walnut task (write, local-only) | id (string): Task id or a unique id prefix; force? (boolean): Stop the task's active sessions and delete anyway |
| `search` | Search Walnut (read) | q (string): Search query; types? (string): Comma-separated subset of: task,memory,session (default: all three); limit? (integer): Max results (default 20) |
| `project_list` | List Walnut projects (read) | (none) |
| `session_list` | List Walnut coding sessions (read) | status? (running\|idle\|stopped\|error): Filter by process status |
| `walnut_status` | Walnut server status (read) | (none) |
| `session_transcript` | Read a session transcript (read) | id (string): Session id; fresh? (boolean): Force a live transcript read (primary box only) |
| `memory_read` | Read Walnut memory (MEMORY.md / USER.md) (read) | doc (global\|user): Which memory document |
| `memory_write` | Write Walnut memory (MEMORY.md / USER.md) (write) | doc (global\|user): Which memory document; content (string): Complete new document content |
| `note_read` | Read a note (read) | path (string): Vault-relative note path |
| `note_write` | Create or update a note (write) | path (string): Vault-relative note path; content (string): Full markdown content; expectedHash? (string): contentHash from note_read (update only) |
| `note_search` | Search notes (read) | q (string): Search query; mode? (hybrid\|string\|semantic): Search mode (default hybrid); limit? (integer): Max results (default 30) |
| `api` | Call any Walnut API endpoint (write) | method (GET\|POST\|PUT\|PATCH\|DELETE): HTTP method; path (string): Absolute API path starting with /api/; body? (object): JSON body for write methods |
| `delegate` | Delegate tracked work (write, primary-only) | taskId? (string): Exact task id or unique prefix to reuse; omit to create a new task; message (string): Initial instruction sent to the coding session; cwd? (string): Absolute working directory; required only when creating a new task; title? (string): New task title; used only when taskId is omitted; project? (string): New task project; omit or use "" for Inbox; host? (string): Execution host alias; omit for the primary box; model? (string): Session model id or provider model value; mode? (plan\|default\|dontAsk\|accept\|auto\|bypass): Session permission mode; engine? (claude\|codex): Coding agent engine; default claude |
| `task_start` | Start or resume a task session (write, primary-only) | id (string): Task id or unique prefix; resume? (boolean): Reuse a running or idle session when available; default false; prompt? (string): Initial or follow-up instruction |
| `session_send` | Send a session message (write) | id (string): Session id; text (string): Message text; messageId? (string): Stable id for retry deduplication |
| `skill_read` | Read a Walnut skill (read) | dirName (string): Skill directory name |
| `project_metadata_get` | Get project settings (read) | name (string): Project name; Inbox has no metadata row |
| `project_metadata_update` | Update project settings (write, primary-only) | name (string): Project name; Inbox has no metadata row; default_cwd? (string\|null): Absolute default working directory; null clears it; default_host? (string\|null): Default execution host alias; null clears it |
| `task_pin_set` | Pin or unpin a task (write) | id (string): Task id or unique prefix; pinned (boolean): true to pin; false to unpin |
| `task_focus_tier_set` | Set a pinned task focus tier (write) | id (string): Pinned task id or unique prefix; tier (string): focus, satellite, backlog, wait, or a custom tier id |
| `human_inbox_send` | Send the human a letter (write) | subject (string): One line the human reads first, like an email subject; type (completion\|action_required\|review\|info): completion \| action_required \| review \| info; markdown? (string): Letter body as markdown (exactly one of markdown \| html); html? (string): Letter body as self-contained HTML, no scripts (inline styles only). The one body that may carry inline media as data: URIs : a chart image, an audio digest as <audio controls src="data:audio/mpeg;base64,...">, or a clip as <video controls src="data:video/mp4;base64,...">. Up to 24MB (about a 35-minute podcast); remote URLs are blocked. A payload this big cannot ride argv: pass it with `walnut tools call human_inbox_send @/path/payload.json`.; text? (string): Short plain-text preview for the envelope row and the phone push; actions? (array<object>): action_required only: the options rendered as buttons; task_refs? (array<string>): Task ids this letter is about; rendered as clickable pills; pin? (boolean): Pin it to the top of the inbox (digests, standing reports) |
| `human_inbox_reply` | Reply in a letter thread (write) | letter (string): Letter id from human_inbox_send (lt-...); text (string): Your reply as plain text (always required: it is the thread line); markdown? (string): Optional richer body rendered under the reply; html? (string): Optional self-contained HTML body, no scripts |

Use `walnut tools help <op>` or `wn tools help <op>` for the full live description. Use the generic `api` operation only when no named operation exists.

<!-- ops-catalog:end -->

## Ref emission (IMPORTANT)

After creating or completing a task, the tool result carries a **`ref`** string
that looks like `<task-ref id="…" label="…"/>`. **Paste that string verbatim
into your reply to the user.** Walnut's UI renders it as a clickable pill that
opens the task; without it the user gets a bare id they cannot click. Copy the
exact characters you were given — never re-format the tag. If the output has no
`ref` field, build the tag yourself from the returned `id` and `title`.

Example reply after creating a task:

> Logged it: <task-ref id="t_7d41c0a9" label="Fix the flaky auth test"/> — due
> Aug 20, in the `marina` project.

Do the same after completing one. Only emit the tag in natural-language text,
never inside a tool argument or a code block.

## When to use it

- Quick work with no tracking request: do it directly.
- Work that should start now: use `delegate`. Pass an explicit task ID to reuse; otherwise give an absolute cwd and create new work.
- Tracking only, with no work started: use `task_create`.
- Before reusing anything: search first and obtain the exact task ID. Never merge by a similar title.
- You need context the repo does not have: use `search`.

## When to send a letter (human inbox)

A **letter** is a document the human reads later in their inbox (web console and
phone). Send one when what you have is worth reading after this session scrolls
away: long-running work that just finished, a nightly or daily digest, a real
fork in the road, a heads-up worth keeping. Do NOT send progress pings or
anything the user is already watching live.

| `type` | Send when |
|---|---|
| `completion` | the work is finished, here is the result |
| `action_required` | you are blocked on a human decision; put the options in `actions` |
| `review` | a report or artifact needs human eyes |
| `info` | worth keeping, nothing needed |

The whole writing bar: **one phone screen**. Background in one or two sentences,
then the point. Self-contained, so the reader never has to open the session.
Long artifacts (full reports, diffs, logs) stay on disk and appear as a path or
link in the letter, never as the body. If you need something, that ask is the
most visible thing in the letter, carried in `actions`, not buried in prose. The
sender line (session, task, project, host) is stamped by the server, so never
write it yourself.

```bash
walnut tools call human_inbox_send '{"subject":"Sync freeze: root cause found","type":"action_required","markdown":"The freeze is a stale lock left by an interrupted rebase, not the network.\n\n- **A** self-heal on startup (safe, ~1 day)\n- **B** fail loudly and let the human clear it (1 hour)\n\nRecommend A.","text":"Root cause found; pick A (self-heal) or B (fail loud).","actions":[{"id":"a","label":"Self-heal on startup","description":"Recommended"},{"id":"b","label":"Fail loudly"}]}'
```

Body is `markdown` OR `html`, exactly one. Markdown is capped at 200KB; `html` gets 24MB so a letter can carry inline media: a data-URI image, an audio digest as `<audio src="data:audio/mpeg;base64,…">`, or a clip as `<video src="data:video/mp4;base64,…">`. 24MB is roughly a 35-minute podcast. No scripts, no remote subresources: both readers block them.

The cap is not a policy, it is the transport. The body travels inline inside the letter JSON, and on the phone that JSON crosses one WebSocket frame whose ceiling is enforced by closing the socket, so there is real headroom to respect. Media bigger than the cap should not be inlined: put the file on disk and link it in the letter.

**A body that big cannot ride the command line.** One argv entry is capped at 128KB on Linux, and the failure happens inside `execve` ("Argument list too long") before Walnut sees the call at all. Write the JSON to a file and pass it by descriptor:

```bash
walnut tools call human_inbox_send @/tmp/digest.json      # read the file
walnut tools call human_inbox_send - < /tmp/digest.json   # read stdin
```

When the human answers or replies, it arrives in this session as a message;
answer into the same thread:

```bash
walnut tools call human_inbox_reply '{"letter":"<letter-id>","text":"..."}'
```

## Safety

- **Read before write.** Search or list first; duplicates are the most common damage an agent does here.
- **Say where the work stands.** Use `task_update phase=AGENT_COMPLETE` when it is done and ready to look at, and `COMPLETE` when it is finished. A blocked or parked task is just `TODO`. There is no human-vs-agent restriction on any phase.
- **Never bulk-delete.** Delete a task only when the user explicitly asked for that specific deletion.
- **Do not reopen or re-prioritize the user's tasks unprompted.** Changing
  `status`, `priority`, or `project` is the user's call unless they asked.
- One task per unit of work, with a title a human can scan later. Put detail in
  `description`, not in the title.
- A missing/unreachable server is not an error to work around: a tool that says
  *Walnut server not running* means the user must start it
  (`open-walnut web`) — report that instead of retrying in a loop.
