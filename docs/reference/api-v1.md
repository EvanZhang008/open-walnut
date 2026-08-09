# Walnut API v1 — Frozen REST+SSE Contract

The `/api/v1` facade is the stable, mobile-facing API surface (the iOS app's
contract). It is **frozen**: changes are additive-only — existing fields,
status codes, and SSE event names never change meaning or disappear.

- Base URL: `http://<host>:3456/api/v1` (LAN) or `https://<your-domain>/api/v1` (cloud).
- Every response carries the header `X-Walnut-API: 1`.
- All timestamps are ISO-8601 strings (UTC).

## Authentication

All endpoints require `Authorization: Bearer <token>` unless the server runs in
trusted-LAN mode and the request comes from a private network (in which case
auth is bypassed — same policy as the rest of `/api`).

- **Cloud mode** (`WALNUT_CLOUD_MODE=1`): a **device token** obtained through the
  one-time claim flow. See the claim endpoints (implemented in `src/web/routes/setup.ts`):
  - `GET /api/v1/setup/status` → `{ claimed: boolean }` (public)
  - `POST /api/v1/setup/claim` `{ setupToken, deviceName }` → `{ deviceName, token }` (public, one-shot)
- **LAN mode**: a config.yaml `api_keys[]` entry works for non-private-network callers.

Auth failures return `401`; repeated failures are rate-limited per IP (`429`).

## Error shape

All v1 errors use one shape (plus optional endpoint-specific extras):

```json
{ "error": { "code": "not_found", "message": "Conversation not found: conv-…" } }
```

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Missing/invalid parameter |
| `not_found` | 404 | Unknown conversation / note |
| `conflict` | 409 | Note hash mismatch / note already exists |
| `turn_active` | 409 | A turn is already running on this conversation |
| `images_need_daemon_upgrade` | 400 | Session-talk images sent via the cloud companion to a host whose daemon predates `image.save` — self-heals on the next primary-box reconnect (auto-deploy) |
| `image_upload_failed` | 400 | Session-talk image save failed on the session's host (daemon refused the payload or the write errored) |
| `session_launch_needs_upgrade` | 400 | Session creation via the cloud companion when the primary's daemon predates the `session.launch` relay — self-heals on the next primary-box reconnect (auto-deploy) |
| `session_control_needs_upgrade` | 400 | Any `session.control`-relayed action (model/effort/fork/lifecycle/notifications) via the cloud companion when the primary's daemon OR server predates that action — self-heals on the next primary-box upgrade/reconnect |
| `bridge_offline` | 503 | Cloud companion has no live bridge to the needed host (or the primary's server is disconnected from its daemon) |
| `not_supported_cloud` | 501 | The endpoint cannot run on a cloud REPLICA at all (e.g. global search needs the primary's semantic index) |
| `cron_owner` | 409 | `POST /sessions/:id/terminate` refused: the session owns armed recurring crons — delete them first or pass `force: true` |
| `too_large` | 413 | Note content exceeds 2 MB (or an attachment upload exceeds its cap) |
| `internal` | 500 | Unhandled server error |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/status` | Server mode/version/time/sync info |
| GET | `/api/v1/agents` | Console agents available for chat |
| GET | `/api/v1/conversations?limit=&agentId=` | List conversations, most-recent first |
| POST | `/api/v1/conversations` | Create a conversation |
| GET | `/api/v1/conversations/:id/messages?limit=&before=&agentId=` | Read normalized messages |
| POST | `/api/v1/conversations/:id/messages` | Send a message (starts an agent turn) |
| GET | `/api/v1/conversations/:id/stream?agentId=` | SSE stream of the current turn |
| GET | `/api/v1/sessions/launch-options` | Hosts + frequent dirs for creating a session (cloud relays to the primary) |
| POST | `/api/v1/sessions` | Create a Claude Code session on a chosen host/path (cloud relays to the primary) |
| PATCH | `/api/v1/tasks/:id` | Update task fields (status/priority/due_date/project/title/description) |
| GET | `/api/v1/sessions/:id/model-options` | Selectable models + current model/effort for the picker (cloud relays to the primary) |
| POST | `/api/v1/sessions/:id/model` | Switch the session's model (cloud relays to the primary) |
| POST | `/api/v1/sessions/:id/effort` | Switch the session's reasoning effort (cloud relays to the primary) |
| POST | `/api/v1/sessions/:id/fork` | Fork a session to another/new task (cloud relays to the primary) |
| GET | `/api/v1/events` | SSE live feed of slim task + session updates (snapshot frame on connect) |
| GET | `/api/v1/notes` | Notes file tree |
| GET | `/api/v1/notes/content/*path` | Read a note |
| PUT | `/api/v1/notes/content/*path` | Update a note (optimistic locking) |
| POST | `/api/v1/notes` | Create a note |
| DELETE | `/api/v1/notes/*path` | Delete a note |
| GET | `/api/v1/tasks/:id` | Full task detail (description/note readback + deps) |
| DELETE | `/api/v1/tasks/:id?force=true` | Delete a task (409 on active sessions unless forced) |
| POST | `/api/v1/tasks/:id/star` | Toggle star |
| POST | `/api/v1/tasks/:id/notes` | Append a timestamped note entry |
| PUT | `/api/v1/tasks/:id/note` | Replace the whole note |
| PUT | `/api/v1/tasks/:id/description` | Set the description |
| PUT | `/api/v1/tasks/:id/summary` | Set the summary |
| PUT | `/api/v1/tasks/:id/depends-on` | Replace dependencies |
| PATCH | `/api/v1/tasks/reorder` | Reorder tasks within one project group |
| POST | `/api/v1/tasks/batch/phase` | Set the phase of many tasks (partial success) |
| POST | `/api/v1/tasks/batch/delete` | Delete many tasks (partial success) |
| GET | `/api/v1/focus/tasks` | Pinned tasks + tier split |
| POST | `/api/v1/focus/tasks/:id` | Pin a task |
| DELETE | `/api/v1/focus/tasks/:id` | Unpin a task |
| PUT | `/api/v1/focus/reorder` | Reorder pins (returns the full tier snapshot) |
| PUT | `/api/v1/focus/tasks/:id/tier` | Move a pinned task between tiers |
| GET | `/api/v1/focus/tiers` | Custom tier registry |
| GET | `/api/v1/sessions/:id` | Session detail + pending permission prompts (cloud relays) |
| PATCH | `/api/v1/sessions/:id` | Rename/archive/mode/human_note (cloud relays) |
| POST | `/api/v1/sessions/:id/terminate` | Kill the CLI process (cloud relays) |
| POST | `/api/v1/sessions/:id/restart` | Respawn a fresh CLI — wakes a dead session (cloud relays) |
| POST | `/api/v1/sessions/:id/retry` | Retry a failed/stopped session (cloud relays) |
| POST | `/api/v1/sessions/:id/permission` | Answer a CLI tool-permission prompt (cloud relays) |
| POST | `/api/v1/sessions/:id/execute-continue` | Execute a completed plan with bypass (cloud relays) |
| GET | `/api/v1/sessions/:id/changes` | Changed-files data for the session (cloud relays) |
| GET | `/api/v1/sessions/:id/history` | Full rich-block history, tail-windowed (cloud relays) |
| PATCH | `/api/v1/conversations/:id` | Rename/pin a butler conversation |
| DELETE | `/api/v1/conversations/:id` | Delete a conversation (main is protected) |
| POST | `/api/v1/conversations/:id/stop` | Stop the agent's active turn(s) |
| POST | `/api/v1/conversations/:id/answer` | Answer a pending structured question |
| GET | `/api/v1/search` | Global search: tasks/memory/sessions (501 on REPLICA) |
| GET | `/api/v1/notes/search` | Hybrid notes search (string leg only on REPLICA) |
| GET | `/api/v1/memory/browse` | Memory source tree (metadata only) |
| GET | `/api/v1/memory?category=` | List memory entries |
| GET/PUT | `/api/v1/memory/global` | Read/write MEMORY.md |
| GET/PUT | `/api/v1/memory/user` | Read/write USER.md |
| GET | `/api/v1/notifications` | Notification feed + unread count (cloud relays) |
| POST | `/api/v1/notifications/mark-read` | Mark some/all read (cloud relays) |
| POST | `/api/v1/notifications/dismiss` | Dismiss some/all (cloud relays) |
| GET | `/api/v1/favorites` | Favorite projects + notes |
| POST/DELETE | `/api/v1/favorites/notes` | Add/remove a note favorite |
| GET/POST | `/api/v1/notes/attachment` | Read / paste-upload a vault attachment |
| POST | `/api/v1/notes/move` | Rename/move a note or attachment |
| POST | `/api/v1/notes/folder` | Create a vault folder |

### GET /api/v1/status

```json
{
  "mode": "LIVE",          // "LIVE" = primary instance; "REPLICA" = cloud companion
  "cloud": false,           // WALNUT_CLOUD_MODE flag
  "version": "0.2.0",
  "serverTime": "2026-07-08T12:00:00.000Z",
  "lastSyncAt": "2026-07-08T11:59:30.000Z"   // omitted when git-sync unavailable
}
```

`mode` is `REPLICA` on a cloud box today; when the reverse-WS bridge to the
primary lands (Phase 2), a bridged cloud box will report `LIVE`.

### GET /api/v1/agents

Console agents the client can chat with (additive):

```json
[
  { "id": "general",    "name": "Walnut",         "isMain": true },
  { "id": "mentor",     "name": "Mentor",         "description": "…", "isMain": false },
  { "id": "note-agent", "name": "Note Assistant", "description": "…", "isMain": false }
]
```

`isMain: true` marks the primary butler (receives notifications & cron). All
conversation endpoints accept an optional `agentId` (query param on GETs, body
field on POSTs); **absent → `general`**, so pre-agent clients keep working
unchanged. Unknown/non-console agent ids → `404 not_found`.

### GET /api/v1/conversations?limit=50&agentId=general

Array, most-recent first:

```json
[ { "id": "conv-…", "title": "Weekend Travel", "updatedAt": "…", "messageCount": 12 } ]
```

`title` is omitted while a conversation is still untitled. `limit` defaults to 50 (max 200).

### POST /api/v1/conversations

Body (optional): `{ "title": "My thread", "agentId": "general" }` → `201 { "id": "conv-…" }`

### GET /api/v1/conversations/:id/messages?limit=50&before=<cursor>

Returns the most recent `limit` messages, **oldest-first**, normalized for mobile:

```json
[
  { "id": "m41", "role": "user",      "text": "hi",          "createdAt": "…" },
  { "id": "m42", "role": "assistant", "text": "Read",        "createdAt": "…", "kind": "tool" },
  { "id": "m43", "role": "assistant", "text": "thinking…",   "createdAt": "…", "kind": "thinking" },
  { "id": "m44", "role": "assistant", "text": "Hello there", "createdAt": "…" }
]
```

- `kind: "tool"` — a tool call; `text` is the tool name. Additive: `detail`
  (one-line input summary, e.g. `"ls docs/"`) and `resultPreview` (≤700 char
  clipped output) when available — clients render a collapsed
  `Bash — ls docs/` row that expands to the output.
- `kind: "thinking"` — a reasoning step; `text` is a short (≤160 char) excerpt.
- `kind: "notification"` — a system-generated card (additive); `source` says
  which system produced it (`"session-error"`, `"agent-error"`, `"cron"`,
  `"compaction"`, …). Render as a distinct card, not a chat bubble. Noisy
  developer categories (`triage`, `session` results, `subagent` results,
  `heartbeat` all-clears) are **filtered out server-side**, matching the web
  console's default visibility. `<task-ref/>`/`<session-ref/>` XML is resolved
  to plain labels before text reaches this API.
- No `kind` — a plain chat message.
- Paging: pass the **first** (oldest) message's `id` of the current page as
  `before` to fetch the previous page. Cursors are positional and ephemeral —
  history compaction can rewrite them, so on a suspicious result just re-fetch
  the tail (no `before`).
- `404` with `code: "not_found"` for an unknown conversation id.

### POST /api/v1/conversations/:id/messages

Body: `{ "text": "your message", "agentId": "general", "images"? }` (`agentId`
and `images` optional).

`images` (additive) attaches image content blocks to the turn:

```json
"images": [ { "data": "<raw base64>", "mediaType": "image/png" } ]
```

- Up to 5 images; allowed `mediaType`: `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`. Invalid/extra entries are silently dropped; oversized images are
  server-side compressed for the model.
- When at least one valid image is present, `text` may be empty (the model still
  receives the images). With no images, an empty `text` is still `400 bad_request`
  — behavior for old clients that never send `images` is unchanged.
- Images are stored to disk and referenced by path in persisted history (the
  transcript stays small); they are NOT echoed back on the messages endpoint.

- `202 { "turnId": "…" }` — accepted; the turn runs asynchronously. Watch the
  SSE stream for progress and the final text.
- `409 { "error": { "code": "turn_active", … } }` — a turn is already running
  on this conversation; wait for its `message-end` and retry.

Turns share the exact same per-agent serialization queue as the web UI's
WebSocket chat — a REST turn and a WS turn can never interleave on one
conversation, and turns fired from mobile also stream into the web UI.

### GET /api/v1/conversations/:id/stream (SSE)

`Content-Type: text/event-stream`. Events (each has a monotonic numeric `id:`):

| Event | Data | Meaning |
|---|---|---|
| `message-start` | `{ "turnId" }` | A turn began |
| `queued` | `{ "turnId", "position" }` | Turn accepted but waiting behind another turn on the shared agent queue (additive, may precede `message-start` by minutes) |
| `text-delta` | `{ "delta" }` | Streaming assistant text chunk |
| `tool` | `{ "name" }` | The agent invoked a tool |
| `thinking` | `{}` | The agent is reasoning (render a spinner) |
| `message-end` | `{ "turnId", "fullText" }` | Turn finished; `fullText` = complete reply |
| `error` | `{ "message" }` | Turn failed |

- A `: ping` comment is sent every 25 s — treat it as keep-alive noise.
- **Replay**: the server keeps a ring buffer of the current turn's events.
  Connecting mid-turn (no `Last-Event-ID`) replays the whole current turn from
  `message-start`. Reconnecting with the `Last-Event-ID` header (or a
  `?lastEventId=` query param, for clients that can't set headers) replays only
  events after that id. Event ids are monotonically increasing across turns.
- The stream stays open across turns; you may keep one connection per open
  conversation screen.

### Notes

- `GET /api/v1/notes` → `{ "tree": [ { "name", "path", "type": "file"|"folder", "kind"?: "note"|"attachment", "children"? } ] }`
- `GET /api/v1/notes/content/Folder/Note` → `{ "content", "contentHash", "updatedAt" }`
  (the `.md` extension is implied; `404` if missing)
- `PUT /api/v1/notes/content/Folder/Note` body `{ "content", "expectedHash"? }`
  - `200 { "contentHash", "updatedAt" }` — written; use the returned hash as the
    next `expectedHash`. (The server may stamp a frontmatter id into new notes,
    so always adopt the returned hash rather than hashing locally.)
  - `409 { "error": { "code": "conflict", … }, "serverHash", "serverContent" }` —
    the note changed under you; merge against `serverContent` and retry with
    `expectedHash: serverHash`.
  - Omitting `expectedHash` = last-write-wins.
- `POST /api/v1/notes` body `{ "path": "Folder/Note", "content"? }`
  → `201 { "path", "contentHash", "updatedAt" }`; `409` if the note already exists.
- `DELETE /api/v1/notes/Folder/Note` → `{ "ok": true }`; `404` if missing.

Notes v1 shares storage and semantics (path safety, id stamping, index
reconcile, `NOTES_UPDATED` events) with the web UI's `/api/notes-v2`.

### Tasks

- `GET /api/v1/tasks?status=todo|in_progress|done` →
  `{ "tasks": [ProjectedTask], "syncedAt": "<ISO>" }`
- `ProjectedTask`: `{ id, title, status, phase, priority, project,
  due_date?, start_date?, created_at, updated_at, completed_at?, starred?,
  pinned?, tags?, summary? }` — `summary` is truncated to ~500 chars.
  `category` was removed in projection v2 (2026-08); `project` is the single
  grouping layer (`""` = Inbox).
  `start_date` (added 2026-07) is the "when to begin" time that defers a task
  out of the web Now view; additive and optional, so older clients ignore it.
- Scope: all open tasks + tasks completed in the last 14 days (older
  completions are excluded from the projection).
- Provenance: `syncedAt` is when the primary box exported the snapshot. On the
  cloud companion the data rides the periodic git sync, so it can lag by up to
  a sync cycle; treat it as read-only replica data.
- `503 { "error": { "code": "unavailable" } }` — projection not synced yet
  (fresh companion before its first git pull).
- `POST /api/v1/tasks` (additive, 2026-08) body `{ "title", "project"?,
  "priority"?, "due_date"?, "description"? }` → `201 { "task": ProjectedTask }`.
  Same creation semantics as the web quick-add: omitted/empty `project` =
  config default → Inbox; a new project name auto-creates its registry row;
  `priority` one of `immediate|important|backlog|none` (default from config).
  `description` is write-only: it is stored on the task but NOT returned in the
  slim ProjectedTask shape (which carries `summary`, a different field) — don't
  expect to read it back from `POST`'s response or `GET /tasks`.
  Errors: `400 bad_request` (missing title / bad priority / bad due_date),
  `409 conflict` (project source conflict).
  Works on BOTH boxes (2026-08: the REPLICA's former `503 not_supported_cloud`
  gate was removed — the cloud companion writes to its local store and the
  task outbox syncs it back to the primary). On a REPLICA the new task shows
  up in `GET /tasks` only after the outbox→primary→projection round trip
  (up to a couple of git-sync cycles); render the `201` response optimistically.
- `PATCH /api/v1/tasks/:id` (additive, 2026-08) body — any subset of
  `{ "status"?, "priority"?, "due_date"?, "project"?, "title"?, "description"? }`
  → `200 { "task": ProjectedTask }` (the updated task in the same slim shape).
  - `status`: `todo` | `in_progress` | `done` (the server derives `phase` from
    it — a human-initiated `PATCH` may reopen a terminal task, same policy as
    the web UI).
  - `priority`: `immediate|important|backlog|none`; `due_date`: ISO-8601
    (`YYYY-MM-DD` or full datetime) or `""` to clear; `project`: any project
    name (`""` = Inbox; a new name auto-creates its registry row); `title`:
    non-empty, ≤500 chars (trimmed); `description`: write-only, same caveat
    as `POST /tasks` (not present in the ProjectedTask response).
  - At least one field is required (`400 bad_request` on an empty body).
  - Errors: `400 bad_request` (invalid value / no fields / ambiguous id
    prefix), `404 not_found` (unknown task id), `409 conflict` (project
    source conflict / blocked by active child tasks).
  - Works on BOTH boxes: on a REPLICA the update lands in the local store and
    a task-outbox op rides git-sync back to the primary (LWW-guarded there);
    the `200` response is the locally-updated row — render it optimistically,
    same as `POST /tasks`.
  - Additive fields (Wave 1, 2026-08): `start_date` (ISO date/datetime or `""`
    to clear — same gate as `due_date`) and `tags` (array of strings — a FULL
    replace of the task's tags; `[]` clears them).
- `GET /api/v1/tasks` additive filters (Wave 1, 2026-08): `project=` (exact,
  case-insensitive; `""` = Inbox), `tag=` (exact member match), `q=`
  (case-insensitive substring on the title). Combinable with `status=`.

### Task actions (additive, Wave 1 2026-08) — detail / delete / field setters / batch / focus

All Class A: same task-manager core as the web console; on a cloud REPLICA
each mutation writes the local store and a task-outbox op rides git-sync back
to the primary (no bridge). Task ids accept unique prefixes; an ambiguous
prefix → `400 bad_request`, unknown → `404 not_found`.

- `GET /api/v1/tasks/:id` → `200 { "task": {…} }` — the FULL task row
  (including `description`, `note`, `summary`, `session_ids` — this is the
  description/note **readback** the slim list omits), decorated with:
  `is_blocked` + `resolved_dependencies` (when `depends_on` is set),
  `dependents`, `children`, `parent` (each a slim `{ id, title, phase, … }`).
- `DELETE /api/v1/tasks/:id[?force=true]` → `204`. With active sessions:
  `409 conflict` + `active_session_ids` unless `force=true` (query or body),
  which stops the sessions first, then deletes.
- `POST /api/v1/tasks/:id/star` → `200 { "task", "starred" }` (toggle).
- `POST /api/v1/tasks/:id/notes` body `{ "content" }` → `200 { "task" }` —
  appends a timestamped note entry.
- `PUT /api/v1/tasks/:id/note` | `/description` | `/summary` body
  `{ "content" }` → `200 { "task" }` — replaces that field.
- `PUT /api/v1/tasks/:id/depends-on` body `{ "depends_on": [ids] }` →
  `200 { "task" }`; a cycle → `409 conflict` + `task_id`/`dep_id`.
- `PATCH /api/v1/tasks/reorder` body `{ "project", "taskIds" }` →
  `200 { "ok": true }` — permutes the given tasks within ONE project group
  (`project: ""` = Inbox; it's a type check, not a truthiness check).
- `POST /api/v1/tasks/batch/phase` body `{ "task_ids", "phase" }` →
  `200 { "changed": [Task], "failed": [{id, ok, error}], "syncFailed" }` —
  PARTIAL SUCCESS by design: one blocked task never voids the rest. `phase`
  is a task phase (`TODO`…`COMPLETE`). `syncFailed` rows DID change locally
  (only the external push failed) — don't roll them back client-side.
- `POST /api/v1/tasks/batch/delete` body `{ "task_ids", "force"? }` →
  `200 { "deleted": [Task], "failed": [{id, ok, error}] }` — same
  partial-success contract (POST, not DELETE, because the ids ride the body).
- Focus bar (pin state lives on the task):
  - `GET /api/v1/focus/tasks` → `TierResult`: `{ "pinned_tasks": [ids],
    "focus_tasks", "satellite_tasks", "backlog_tasks", "wait_tasks",
    "custom_tier_tasks": { "<ct_id>": [ids] } }`.
  - `POST /api/v1/focus/tasks/:id` → `200 { "pinned_tasks" }` (idempotent;
    pinning a completed task → `409 conflict`).
  - `DELETE /api/v1/focus/tasks/:id` → `200 { "pinned_tasks" }` (idempotent).
  - `PUT /api/v1/focus/reorder` body `{ "task_ids" }` → the FULL `TierResult`
    (never a pinned-only payload — clients apply it as a lossless snapshot).
  - `PUT /api/v1/focus/tasks/:id/tier` body `{ "tier" }` → `TierResult`.
    `tier` ∈ `focus|satellite|backlog|wait` or a registered `ct_*` id;
    anything else → `400 bad_request`.
  - `GET /api/v1/focus/tiers` → `{ "tiers": [ { "id": "ct_…", "label" } ] }`.

### Sessions (read-only)

- `GET /api/v1/sessions?status=running|idle|stopped|error` →
  `{ "sessions": [ProjectedSession], "syncedAt": "<ISO>" }`
- `ProjectedSession`: `{ id, title?, task_id?, task_title?,
  project?, host, process_status, model?, mode?, started_at, last_active_at,
  message_count, cwd?, pinned?, focus_tier?, description? }` — `host` is `""`
  for sessions on the primary box, otherwise the host alias; `pinned` /
  `focus_tier` mirror the owning task's pin state at export time;
  `description` is truncated to ~300 chars.
- `focus_tier` values: `"focus"`, `"backlog"` (built-in since 2026-08),
  `"wait"`, a custom tier id (`ct_` + 8 alphanumerics — user-defined tiers,
  added 2026-08), or absent (= Satellite, the default bucket). Clients that
  only understand the built-ins should treat any unrecognized value as
  Satellite.
- Scope: all live sessions + sessions stopped in the last 14 days, newest
  first, capped at 500. System sessions (triage/cron/hooks) and archived
  sessions are excluded.
- Provenance/laggy-replica semantics identical to `/tasks` (`syncedAt`,
  `503 unavailable` on a fresh companion).
- `GET /api/v1/sessions/:id/transcript?fresh=1` →
  `{ "sessionId", "exportedAt", "truncated", "messages": [ { role, text,
  timestamp, kind?, detail?, resultPreview?, agent? } ] }` — a slim transcript
  tail (last ~100 entries; text capped at 4 KB/row; `kind: "tool"` rows carry
  the tool name, plus additive `detail` (input summary) / `resultPreview`
  (clipped output) when available). `agent` (additive, 2026-08) appears on
  `Task`/`Agent` tool rows and names the delegated subagent (team agent name,
  the tool input's `name`, or its `subagent_type`) — render it as a badge on
  the delegation row; the subagent's own transcript is not inlined. The primary
  box exports tails for every session it can reach — local from disk, remote
  over its SSH channel — so this works for sessions on ANY machine without
  the phone talking to that machine. `404 not_found` when no tail was
  exported yet. A just-created session still in its pre-spawn window
  (`awaiting_spawn`, no pid) answers `200` with `messages: []` on the primary
  box — fast and unambiguous, instead of a 404 the client would have to
  interpret as "poll again".
- `fresh=1` (additive): the PRIMARY box reads the session's history **right
  now** instead of serving the (60s-throttled) sweep file — poll this every
  few seconds for a live session view. On a cloud companion `fresh=1` reads
  the live stream over the daemon bridge when that session's host is
  connected (see below), and gracefully falls back to the exported file
  otherwise. `exportedAt` tells you which one you got.

### Session talk (additive) — send into + stream out of a session

Each execution host's daemon dials OUT to the cloud companion over
`wss://<domain>/bridge` (authenticated with a machine token), so the phone
can talk to live sessions even when the primary box is asleep. On the
primary box the same endpoints serve directly — no bridge involved.

- `POST /api/v1/sessions/:id/messages` body `{ "text": "...", "images"? }` →
  `202 { "messageId" }`. The message is delivered into the running CLI
  session (mid-turn sends are fine — the session reads them between turns).
  - `images` (additive) — same shape/limits as the conversation endpoint
    (`[ { "data": "<raw base64>", "mediaType": "image/png" } ]`, ≤5, png/jpeg/
    gif/webp). Each image is saved to disk and the message is prefixed with
    `[Images attached — use the Read tool to view them]` plus the file paths,
    so the CLI reads them with its Read tool (remote hosts: the files are
    uploaded and paths rewritten automatically). On the cloud companion the
    images are saved on the SESSION'S HOST over the daemon bridge via the
    narrow `image.save` command (mediaType allowlist, 10MB decoded cap,
    daemon-owned directory, generated filename). `text` may be empty when
    images are present; with no images an empty `text` is still
    `400 bad_request` (unchanged for old clients).
  - `404 not_found` — unknown session.
  - `400 { "error": { "code": "images_need_daemon_upgrade" } }` — (cloud only)
    the session's host runs a daemon that predates `image.save`. The daemon
    auto-upgrades on the next primary-box reconnect; retry later or send from
    the primary box.
  - `400 { "error": { "code": "image_upload_failed" } }` — (cloud only) an
    image save failed on the session's host; nothing was sent (images are
    never silently dropped).
  - `409 { "error": { "code": "session_dead" } }` — the CLI process is not
    running (idle-reaped). Waking a dead session stays a primary-box action;
    show "wake it from your desktop".
  - `503 { "error": { "code": "bridge_offline" } }` — no live bridge to that
    session's host (cloud only). Disable the composer; keep polling.
- `GET /api/v1/sessions/:id/stream` — SSE (same framing as conversation
  streams: monotonic `id:`, `Last-Event-ID` replay, `:` pings). Events:
  - `snapshot { blocks, isStreaming, completedLen, processStatus }` — sent
    once on attach (primary box only; carries no id).
  - `turn-start {}` — a new turn began (resets the replay window).
  - `text-delta { delta }` / `thinking { delta }` — main-lane streaming text.
  - `tool { name, toolUseId, detail? }` / `tool-result { toolUseId }` —
    `detail` (additive) is the one-line input summary.
  - `status { processStatus }` — running | idle | stopped | error.
  - `turn-end {}` — refetch the transcript here to reconcile.
  - `error { message }`
  - `bridge-online {}` / `bridge-offline {}` (cloud only) — sent on attach
    and whenever the daemon bridge for this session's host comes/goes; on
    offline fall back to `fresh=1` polling and disable the composer.
  - `404 not_found` on servers without this endpoint — fall back to polling.
- `/api/v1/status` additive field (cloud only):
  `bridgeHosts: [ { hostAlias, since } ]` — hosts with a live daemon bridge.
  A session is talkable when its `ProjectedSession.host` (`""` maps to the
  primary's local daemon `__local__`) has an entry here.

### Session launch (additive) — create a session from mobile

Creation reuses the web Quick Start core (task create/reuse →
`SESSION_START` → session-runner spawns the CLI locally or on the chosen
host's SSH daemon). Works on BOTH boxes:

- **Primary box**: validation + quick-start run directly.
- **Cloud companion (REPLICA)**: session records live on the primary, so both
  endpoints relay over the `/bridge` WS via the narrow `session.launch`
  daemon command (allowlisted alongside `image.save`; the raw spawn command
  stays OFF the bridge). The primary's daemon forwards the request up to its
  connected walnut server, which runs the exact same validation +
  quick-start chain and replies. The chosen `host` may be any enabled
  `config.hosts` alias — the primary handles it exactly like a local
  request, so the bridge hop always targets the primary's daemon
  (`__local__`) regardless of where the session will run.
  - Failure ladder (mirrors the session-images one):
    `400 session_launch_needs_upgrade` — the primary's daemon predates the
    relay (self-heals on the next primary reconnect via auto-deploy);
    `503 bridge_offline` — no live bridge, or the primary's server is
    disconnected from its daemon; validation errors from the primary surface
    verbatim with their original code/status (`bad_request`/`not_found`/…).
  - Older cloud servers answer `503 not_supported_cloud`; clients should
    treat that as "update the cloud companion".

- `GET /api/v1/sessions/launch-options` →
  `{ "hosts": [ { "alias", "label" } ], "dirs": [ { "cwd", "host",
  "hostLabel"?, "lastUsed", "count" } ] }`
  - `hosts`: where a session can run — the primary box first
    (`alias: ""`, matching `ProjectedSession.host` semantics) plus every
    enabled `config.hosts` entry (SSH remotes, including a cloud EC2 box you
    added as a host).
  - `dirs`: the user's frequent working directories (same store as the web
    launcher's suggestions), best first, capped at 30. `host` is `""` for
    local paths.
- `POST /api/v1/sessions` body `{ "cwd", "host"?, "message"?, "taskId"?,
  "model"?, "mode"? }` → `201 { "sessionId", "taskId", "title" }`
  - `cwd` (required): absolute working path on the chosen host (must start
    with `/`; relative paths are `400 bad_request`).
  - `host`: `""`/absent = the primary box; otherwise an enabled alias from
    `launch-options` (unknown/disabled → `400 bad_request`).
  - `message`: optional first turn; empty/absent spawns the CLI idle.
  - `taskId`: link the session to an existing task instead of creating one
    (unknown id → `404 not_found`). Absent: a task is created and
    auto-organized, exactly like a web Quick Start.
  - `model` / `mode`: same accepted values as the web quick-start route
    (`bypass`/`accept`/`default`/`plan`; alias or catalog model ids).
  - `201` means **accepted, not spawned**: the CLI spawn is asynchronous, so
    a typo'd path or an unreachable SSH host still returns 201 and surfaces
    later as session `error` status. The record is pre-seeded, so the
    returned `sessionId` immediately works with the stream/messages AND
    transcript endpoints — the transcript answers `200 messages: []` during
    the pre-spawn window (see above), then fills in as turns complete.

### Session control (additive, 2026-08) — model / effort / fork / model-options

Semantics are identical to the web console's session controls: both surfaces
call the same shared core (`src/core/sessions/session-controls.ts`). Works on
BOTH boxes:

- **Primary box**: the core runs directly.
- **Cloud companion (REPLICA)**: session records + live CLIs live on the
  primary, so every endpoint relays over the `/bridge` WS via the narrow
  `session.control` daemon command (allowlisted alongside `session.launch`).
  The primary's daemon forwards the request up to its connected walnut server,
  which runs the same core and replies. Failure ladder mirrors session launch:
  `400 session_control_needs_upgrade` — the primary's daemon predates the
  relay (self-heals on the next primary reconnect via auto-deploy);
  `503 bridge_offline` — no live bridge, or the primary's server is
  disconnected from its daemon; validation errors from the primary surface
  verbatim with their original code/status.

- `GET /api/v1/sessions/:id/model-options` →
  `{ "models": [ { "id", "label", "supportsEffort"?, "supportedEffortLevels"? } ],
  "current", "currentEffort" }`
  - `models`: the session's selectable catalog (live CLI catalog when the
    session is alive → the host's last-known catalog → the static registry on
    a first install). Each row's `id` is what the picker must send back to
    `POST .../model`. `supportedEffortLevels` (when present) drives the effort
    buttons per model.
  - `current`: the active row's `id` (falls back to the raw runtime model
    string when it isn't in the catalog); `null` when unknown.
  - `currentEffort`: the record's requested effort (`low|medium|high|xhigh|max`)
    or `null`.
  - `404 not_found` for an unknown session id.
- `POST /api/v1/sessions/:id/model` body `{ "model" }` →
  `200 { "model", "cliModel", "appliedLive", "effectiveModel"? }`
  - `model`: a catalog `id` from `model-options` or a legacy alias
    (`opus`, `sonnet-1m`, …). Garbage → `400 bad_request`.
  - `appliedLive: true` = the running CLI switched now (no respawn);
    `false` = persisted only — a dead/idle-reaped session picks the model up
    on its next `--resume` spawn. `effectiveModel` is the CLI's read-back
    truth when available (may differ if the CLI substituted the value).
  - Codex/ACP sessions answer `{ "applied": true, "model" }` instead
    (`409 conflict` when the switch fails).
- `POST /api/v1/sessions/:id/effort` body `{ "effort" }` →
  `200 { "effort", "appliedLive", "effectiveEffort"?, "overridden" }`
  - `effort`: `low|medium|high|xhigh|max`. A level the model doesn't support →
    `409 conflict` (the picker should grey those out using
    `supportedEffortLevels` from `model-options`).
  - `overridden: true` = the CLI is actually using a DIFFERENT level than
    requested (env override / model downgrade), per the read-back.
- `POST /api/v1/sessions/:id/fork` body `{ "task_id"?, "create_child_task"?,
  "child_title"?, "message"?, "title"?, "model"? }` →
  `201 { "status": "pending", "sourceSessionId", "sessionId", "taskId",
  "title", "childTaskCreated"?, "host"? }`
  - Exactly one of `task_id` (fork onto an existing task) or
    `create_child_task: true` (create a sibling task, auto-grouped with the
    source task) is required.
  - `message`: the fork's first request (defaults to "Continue working on:
    <task title>"); `title`: session title override; `model`: model override
    (defaults to the parent's exact model).
  - `201` means **accepted, not spawned** (same contract as `POST /sessions`):
    the fork record is pre-seeded, so the returned `sessionId` immediately
    works with the transcript/stream/messages endpoints.
  - Errors: `400 bad_request` (neither/both target fields; source session has
    no cwd/task), `404 not_found` (unknown source session / target task),
    `409 conflict` (target task already has a session — the response carries
    `existing_session_id`; or a Codex source session, which cannot fork).

### Session lifecycle (additive, Wave 1 2026-08) — detail / patch / terminate / restart / retry / permission / execute-continue / changes / history

Same shared core as the web console (`src/core/sessions/session-lifecycle.ts`).
All Class B on a cloud REPLICA: each endpoint relays over the `/bridge` WS as a
new action on the existing `session.control` daemon command (the daemon
forwards actions opaquely, so no daemon upgrade is needed; an old PRIMARY
server that predates an action answers `400 session_control_needs_upgrade`).
Failure ladder and error passthrough identical to the session-control section
above. All paths `404 not_found` for an unknown session, `400 bad_request` for
an id outside `[A-Za-z0-9_-]`.

- `GET /api/v1/sessions/:id` → `200 { "session": SessionRecord,
  "pendingPermissions": [ { "requestId", "toolName"?, "input"?, "reason"? } ] }`
  — the full liveness-corrected record plus any live tool-permission prompts
  (pair each with `POST …/permission`).
- `PATCH /api/v1/sessions/:id` body — any subset of `{ "title" (≤500 chars),
  "archived" (boolean), "mode" ("default"|"plan"|"bypass"|"accept"),
  "human_note" (≤50000 chars) }` → `200 { "session" }`. At least one field
  required. Archiving clears the owning task's session slots; archiving a
  terminal-state session is tolerated; a live mode switch that the CLI rejects
  → `409 conflict`.
- `POST /api/v1/sessions/:id/terminate` body `{ "force"? }` →
  `200 { "status": "terminated", "sessionId", "tookMs"? }` — kills the running
  CLI, no respawn, pending queue preserved. If the session owns armed
  recurring crons → `409` `{ "error": { "code": "cron_owner", … } }` unless
  `force: true` (killing it would NOT stop the crons — they'd fire into any
  other session sharing the directory).
- `POST /api/v1/sessions/:id/restart` → `200 { "status": "restarted",
  "sessionId", "pendingMessages" }` — respawns a fresh `claude -p --resume` so
  the session re-initializes (reloads CLAUDE.md/skills/MCP; **this is how the
  phone wakes an idle-reaped/dead session**). In-flight messages are reverted
  to pending and re-delivered. Archived session → `400 bad_request`.
- `POST /api/v1/sessions/:id/retry` → one of
  `200 { "status": "reconnected", "sessionId" }` (process was alive — error
  state cleared), `200 { "status": "resuming", "sessionId",
  "restoredMessages"? }` (dead process — resumed via the queue), or
  `200 { "status": "pending", "taskId", "oldSessionId" }` (never initialized —
  archived + a new session started on the task). Only `error`/`stopped`
  sessions are retryable (`400` otherwise; `400` when no task is linked).
- `POST /api/v1/sessions/:id/permission` body `{ "requestId", "allow",
  "message"? }` → `200 { "status": "resolved", "requestId", "allow" }` —
  answers a live CLI tool prompt (`message` = optional deny reason).
  `404 not_found` when the request is gone/already resolved or no live
  session holds it.
- `POST /api/v1/sessions/:id/execute-continue` → `200 { "status": "started",
  "sessionId" }` — resumes a completed plan session with bypass permissions
  ("Continue" on a finished plan). Non-plan session → `400 bad_request`.
- `GET /api/v1/sessions/:id/changes?base=&scope=&light=1&refresh=1` →
  `200` the same payload as the web Changed tab: `{ "groups": [ { files:
  [ { path, before, after, … } ] } ], … }`. `base` ∈ `session` (default) |
  `uncommitted` | `previous` | `remote`; `scope` ∈ `session` (default) |
  `all`; `light=1` strips `before`/`after` content (names/roots only — sized
  for a phone list); `refresh=1` bypasses the cache. Unreachable host / git
  failure → `502` with the underlying message.
- `GET /api/v1/sessions/:id/history?tail=N` → `200 { "messages": [rich
  blocks], "total", "forkedFromSessionId"?, "forkBoundaryIndex"?,
  "historyUnavailable"? }` — the FULL rich-block history (tool detail +
  results, subagent-lane markers, fork-ancestor prefix in chain order),
  tail-windowed (`tail` ≤ 2000). This supersedes `transcript`'s slim 100-row
  tail for full parity chat rendering; `transcript` remains frozen and
  untouched. Snapshot API: no delta cursors — live rendering rides the SSE
  stream. Rows whose content can still change carry `unsettled: true`. When
  the JSONL/journal is unreachable, `200` with `messages: []` +
  `historyUnavailable` (a human-readable reason) rather than an error.

### Butler conversation management (additive, Wave 1 2026-08)

Class A everywhere (the REPLICA runs its own butler). `agentId` is accepted
like the other conversation endpoints (absent → `general`).

- `PATCH /api/v1/conversations/:id` body `{ "title"? | "pinned"? }` →
  `200 { "conversation" }`. At least one field required.
- `DELETE /api/v1/conversations/:id` → `204`. The MAIN conversation (receives
  notifications + cron) is never deletable → `409 conflict`.
- `POST /api/v1/conversations/:id/stop` → `200 { "stopped": N,
  "questionCancelled": boolean }` — aborts ALL of the agent's active turns
  (WS- and REST-initiated; REST clients have no per-socket identity, and for
  a single-user butler that is what "stop" means) and cancels any pending
  structured question. Harmless no-op (`stopped: 0`) when nothing is running.
- `POST /api/v1/conversations/:id/answer` body `{ "answers": { "<header>":
  "<value>", … } }` → `200 { "ok": true }` — answers a pending structured
  question (the `user_ask` tool), unblocking the agent's turn. Mirrors the
  web `chat:answer-question`: the answers are persisted as a user entry and
  broadcast live. No pending question → `409 conflict`.

### Search, memory, notifications, favorites (additive, Wave 1 2026-08)

- `GET /api/v1/search?q=&types=task,memory,session&limit=` →
  `200 { "results": [ { type, id?, title, snippet?, score, … } ] }` — the
  console's global search (string + semantic legs). **REPLICA: `501
  not_supported_cloud`** (the semantic index lives on the primary only).
- `GET /api/v1/notes/search?q=&mode=hybrid|string|semantic&limit=&all=1` →
  `200 { "results": [ { id, path, title, snippet, matchType, … } ],
  "folders"?, "degraded"? }` — the notes panel's hybrid search. Works on BOTH
  boxes: the semantic leg self-disables on a REPLICA (string/FTS answers;
  `degraded: "semantic-unavailable"` may appear). Snippets carry
  `<mark>…</mark>` highlights.
- Memory (Class A — files ride git-sync, so a REPLICA reads/writes its local
  copy):
  - `GET /api/v1/memory/browse` → `{ "tree": { global, user, daily, projects,
    sessions, knowledge, repos, topics, compaction, special } }` (metadata
    only: `{ path, title, updatedAt }` rows).
  - `GET /api/v1/memory?category=project|session|knowledge` → `{ "memories" }`.
  - `GET /api/v1/memory/global` | `/memory/user` → `200 { "memory": { path,
    title, category, content, createdAt, updatedAt } }`; `404 not_found` when
    the file doesn't exist yet.
  - `PUT /api/v1/memory/global` | `/memory/user` body `{ "content" }` →
    `200 { "ok": true, "updatedAt" }` — human-edit provenance (telemetry +
    immediate prompt-snapshot refresh, same as the web editor).
- Notifications (Class B — the durable store lives on the primary; a REPLICA
  relays via the `session.control` command's `server.*` actions, same failure
  ladder as session lifecycle):
  - `GET /api/v1/notifications` → `{ "feed": [ { id, kind, severity, title,
    body?, timestamp, read, … } ], "unreadCount" }` (bodies clipped to 600
    chars).
  - `POST /api/v1/notifications/mark-read` body `{ "ids"? }` →
    `{ "unreadCount" }` (no ids = mark ALL read).
  - `POST /api/v1/notifications/dismiss` body `{ "ids"?, "dedupKeys"? }` →
    `{ "unreadCount", "removed" }` (no filter = dismiss ALL).
- Favorites (Class A, config-backed — these formalize paths the iOS app
  previously called out-of-contract on `/api/favorites`):
  - `GET /api/v1/favorites` → `{ "projects": [names], "notes": [paths] }`.
  - `POST /api/v1/favorites/notes` body `{ "path" }` → `{ "notes" }`
    (idempotent add). `DELETE /api/v1/favorites/notes` (body or `?path=`) →
    `{ "notes" }`.
- Notes utilities (Class A — formalizing the `/api/notes-v2` paths iOS
  already calls; same vault semantics):
  - `GET /api/v1/notes/attachment?path=` → attachment bytes with correct
    `Content-Type` (png/jpg/gif/webp/pdf inline; Office formats download).
    Accepts a vault-relative path or a bare `![[name]]` target. No SVG.
    `404 not_found` / `400 bad_request` in the frozen shape.
  - `POST /api/v1/notes/attachment` body `{ "notePath", "data": "<base64>",
    "mediaType" }` → `200 { "ok", "path", "name" }` — saves a pasted image
    into `_attachment/` beside the note; the returned `path` is the
    `![[…]]` embed target. >10 MB base64 → `413 too_large`.
  - `POST /api/v1/notes/move` body `{ "from", "to" }` → `{ "ok": true }` —
    rename/move a note or attachment (id-keyed links survive).
    Destination exists → `409 conflict`; source missing → `404 not_found`.
  - `POST /api/v1/notes/folder` body `{ "path" }` → `{ "ok": true }`.

### GET /api/v1/events (SSE, additive, 2026-08) — live task + session feed

One long-lived SSE stream that pushes slim updates so the app can keep its task list and session list current without polling. Works on BOTH boxes; auth is the standard Bearer.

**Frames, in order:**

1. `event: snapshot` — sent once per connection, immediately on attach. `data: { "sessions": [ProjectedSession…], "tasks": [ProjectedTask…] }` — the exact same row shapes as `GET /api/v1/sessions` and `GET /api/v1/tasks`. Carries **no SSE id** (it is per-connection state, never part of replay). Treat it as a full replace of both lists.
2. Live events (each with an SSE `id`; **no server-side replay** — the snapshot on (re)connect is the sole catch-up mechanism):
   - `event: session-upsert` — `data:` one `ProjectedSession` row (`id`, `title`?, `task_id`?, `task_title`?, `project`?, `host`, `process_status`, `model`?, `mode`?, `started_at`, `last_active_at`, `message_count`, `cwd`?, `pinned`?, `focus_tier`?, `description`?; absent fields are omitted, not null). Merge by `id` (insert when new).
   - `event: task-upsert` — `data:` one `ProjectedTask` row (same shape as `GET /tasks` rows). Merge by `id`.
   - `event: task-delete` — `data: { "id" }`. Remove the row.
3. `: ping` comment every ~25s (heartbeat; ignore).

**Client contract:** on (re)connect, apply the snapshot as a full replace, then apply live events incrementally. This feed keeps **no replay ring** and ignores `Last-Event-ID` — replaying pre-snapshot history would regress the fresh snapshot (a completed task flipping back to todo). Clients need no replay logic; every gap heals on the next snapshot.

**Data sources (why events can lag or thin out):**

- **Primary box**: fed directly off the internal event bus (session lifecycle/status + task create/update/delete) — effectively real-time.
- **Cloud companion (REPLICA)**: task events for the replica's OWN mutations are local (real-time); session events arrive relayed from the primary (primary bus → primary's daemon → `/bridge` WS → this feed). When the bridge is down or the primary's daemon predates the relay, the stream stays open but degrades to **snapshot + heartbeats** — no error frame; the app's normal pull endpoints keep working. The snapshot's session half on cloud comes from the git-synced projection (may lag 1–3 min; see the sessions section).

Session events are lifecycle/status-grade only (started/ended/status/result/error). Per-token streaming rides the per-session `GET /sessions/:id/stream`, never this feed. `session-upsert` frames are coalesced per session (~250ms): rapid status flaps produce one frame carrying the latest authoritative row.

**Known gap (cloud):** primary task changes that arrive on the replica via git-sync import (`addTasksBulk`/`updateTasksBulk`) do not emit bus events, so they produce no real-time `task-upsert` on the cloud feed — they converge on the next reconnect snapshot (or the app's pull paths).

### GET /api/v1/media?path=/absolute/file.png[&session=sid] (additive)

Image bytes for pictures referenced in chats/transcripts by absolute path
(agent screenshots, attached photos). Resolution order: the serving box's own
disk → the session's exec host (SSH daemon channel on the primary; the
`/bridge` WS on a cloud companion, via the narrow `fs.readImage` daemon
command) → a previously-fetched cache. So the same URL works on LAN and
through the cloud companion.

- Extension allowlist png/jpg/jpeg/gif/webp (no SVG), absolute paths only,
  no `..`, 50 MB cap. Auth: standard Bearer.
- `200` image bytes with correct `Content-Type`; `404 not_found` when no
  source can produce the file; `400 bad_request` for disallowed paths/types.

### POST /api/v1/client-logs

Mobile apps push their structured log buffer for server-side debugging
(TestFlight builds can't be attached to with a debugger). Additive endpoint.

Body: `{ "device": "Evan's iPhone", "appVersion": "1.0.0", "os": "iOS 26",
"lines": [ { "ts", "level", "subsystem", "message", …meta } ] }`

- `200 { "ok": true, "received": N }` — lines appended as JSON-lines to
  `/tmp/open-walnut/ios-client/<device>-<date>.log` on the receiving box.
- `400 bad_request` — `lines` missing/empty. `413 too_large` — per-device/day
  quota (20 MB) exhausted.
- Max 5000 lines per call; each line is stamped with `device`/`appVersion`/`os`.

## curl examples

```bash
BASE=https://walnut.example.com/api/v1
TOK=<device token>
AUTH="Authorization: Bearer $TOK"

curl -s -H "$AUTH" $BASE/status
curl -s -H "$AUTH" "$BASE/conversations?limit=20"
CONV=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{}' $BASE/conversations | jq -r .id)
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text":"hello walnut"}' $BASE/conversations/$CONV/messages
curl -sN -H "$AUTH" $BASE/conversations/$CONV/stream          # watch the turn stream
curl -s -H "$AUTH" "$BASE/conversations/$CONV/messages?limit=50"

curl -s -H "$AUTH" "$BASE/tasks?status=todo"

curl -s -H "$AUTH" $BASE/notes
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"path":"Mobile/Test","content":"# Hi"}' $BASE/notes
curl -s -H "$AUTH" $BASE/notes/content/Mobile/Test
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"content":"# Hi v2","expectedHash":"<hash from GET>"}' $BASE/notes/content/Mobile/Test
curl -s -X DELETE -H "$AUTH" $BASE/notes/Mobile/Test
```

## iOS client notes

- **SSE parsing**: use `URLSession` with a streaming delegate (or an SSE
  library). Frames are `id:` / `event:` / `data:` lines terminated by a blank
  line; ignore lines starting with `:` (pings). Persist the last seen `id` and
  send it as `Last-Event-ID` on reconnect.
- **Send flow**: POST the message → on `202`, rely on the already-open SSE
  stream; on `409 turn_active`, disable the send button until `message-end`.
- **Offline edits (notes)**: keep `contentHash` with each cached note; PUT with
  `expectedHash`, and on `409` diff against `serverContent`.
