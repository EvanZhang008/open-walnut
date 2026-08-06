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
| `bridge_offline` | 503 | Cloud companion has no live bridge to the needed host (or the primary's server is disconnected from its daemon) |
| `too_large` | 413 | Note content exceeds 2 MB |
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
| GET | `/api/v1/notes` | Notes file tree |
| GET | `/api/v1/notes/content/*path` | Read a note |
| PUT | `/api/v1/notes/content/*path` | Update a note (optimistic locking) |
| POST | `/api/v1/notes` | Create a note |
| DELETE | `/api/v1/notes/*path` | Delete a note |

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
  timestamp, kind?, detail?, resultPreview? } ] }` — a slim transcript tail
  (last ~100 entries; text capped at 4 KB/row; `kind: "tool"` rows carry the
  tool name, plus additive `detail` (input summary) / `resultPreview`
  (clipped output) when available). The primary
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
