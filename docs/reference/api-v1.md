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
| PATCH | `/api/v1/tasks/:id` | Update task fields (status/priority/due_date/start_date/end_date/project/title/description) |
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
| POST | `/api/v1/tasks/:id/complete` | Complete a task (auto-unpins + awaits sync push; ≠ `PATCH status:done`) |
| POST | `/api/v1/tasks/:id/start` | Start/resume a session for an existing task (cwd resolved server-side; 501 on REPLICA) |
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
| PATCH | `/api/v1/conversations/:id` | Rename/pin a Personal AI conversation |
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
| GET | `/api/v1/routines?includeDisabled=` | List routines (cloud relays) |
| GET | `/api/v1/routines/actions` | Registered action catalog (cloud relays) |
| GET | `/api/v1/routines/status` | Scheduler status (cloud relays) |
| GET | `/api/v1/routines/executors` | Executor definitions + form options (cloud relays) |
| GET | `/api/v1/routines/:id` | One routine (cloud relays) |
| POST | `/api/v1/routines` | Create a routine (cloud relays) |
| PATCH | `/api/v1/routines/:id` | Edit a routine (cloud relays) |
| DELETE | `/api/v1/routines/:id` | Delete a routine — 404 on unknown id (cloud relays) |
| POST | `/api/v1/routines/:id/toggle` | Enable/disable (cloud relays) |
| POST | `/api/v1/routines/:id/run` | Run now, forced (cloud relays) |
| GET | `/api/v1/projects` | Project registry + counts + favorite flags + Inbox |
| POST | `/api/v1/projects` | Idempotent create (201 new / 200 existing) |
| PATCH | `/api/v1/projects/:name` | Rename, merge-on-collision (501 on REPLICA) |
| DELETE | `/api/v1/projects/:name?remote=1` | Delete; ?remote=1 = provider cascade (501 on REPLICA) |
| GET | `/api/v1/ordering` | Project display order |
| PUT | `/api/v1/ordering/projects` | Replace the project order |
| POST/DELETE | `/api/v1/favorites/projects/:name` | Add/remove a project favorite (case-insensitive) |
| GET | `/api/v1/tasks/meta/tags` | Unique task tags with counts |
| GET | `/api/v1/tasks/groups` | Virtual task groups (501 writes on REPLICA) |
| POST | `/api/v1/tasks/groups` | Create a group from ≥2 tasks (501 on REPLICA) |
| POST | `/api/v1/tasks/groups/:groupId/add` | Add tasks to a group (501 on REPLICA) |
| POST | `/api/v1/tasks/groups/remove` | Remove tasks from their group(s) (501 on REPLICA) |
| PATCH | `/api/v1/tasks/groups/:groupId` | Rename a group (501 on REPLICA) |
| PATCH | `/api/v1/tasks/groups/:groupId/hidden` | Show/hide a group in Focus (501 on REPLICA) |
| POST | `/api/v1/tasks/quick-parse` | NL → task metadata parse (works on both boxes) |
| POST | `/api/v1/focus/tiers` | Create a custom focus tier (501 on REPLICA) |
| PUT | `/api/v1/focus/tiers/:id` | Rename a custom tier (501 on REPLICA) |
| DELETE | `/api/v1/focus/tiers/:id` | Delete a custom tier, members → satellite (501 on REPLICA) |
| GET | `/api/v1/sessions/list-dirs` | Host directory listing for the path picker (cloud relays) |
| GET/POST | `/api/v1/sessions/:id/controls` | Provider-neutral controls read/apply (cloud relays) |
| GET | `/api/v1/sessions/:id/settings?details=1` | Requested vs applied settings snapshot (cloud relays) |
| GET | `/api/v1/sessions/:id/side-questions` | Side-question history (cloud relays) |
| POST | `/api/v1/sessions/:id/side-question` | Ask the live CLI a side question (cloud relays) |
| POST | `/api/v1/sessions/:id/side-question/:qid/promote` | Promote a Q&A to a task (cloud relays) |
| DELETE | `/api/v1/sessions/:id/side-question/:qid` | Remove a Q&A (cloud relays) |
| GET | `/api/v1/sessions/:id/workflow` | Dynamic-workflow progress; 204 = none (cloud relays) |
| GET | `/api/v1/sessions/:id/plan` | Plan content for a plan session (cloud relays) |
| GET | `/api/v1/sessions/:id/subagent/:agentId/history` | One subagent lane's history (cloud relays) |
| POST | `/api/v1/sessions/:id/execute-compact` | Execute a plan after a compact boundary (cloud relays) |
| GET | `/api/v1/sessions/:id/queue` | Queued messages (cloud relays) |
| PATCH | `/api/v1/sessions/:id/queue/:messageId` | Edit a queued message (cloud relays) |
| DELETE | `/api/v1/sessions/:id/queue/:messageId` | Delete a queued message (cloud relays) |
| GET | `/api/v1/files/list?path=&host=` | One directory level of a session file tree (cloud relays) |
| GET | `/api/v1/files/resolve-path?rel=&cwd=&host=` | Resolve a transcript-mentioned path (cloud relays) |
| GET | `/api/v1/file-content?path=&host=` | FileViewer text payload + `contentHash` (REPLICA: bounded bridge relay — 2MB cap 413, bridge down 503, old daemon 501) |
| PUT | `/api/v1/file-content` | Save a file edit; optimistic lock via `expectedHash` → 409 (REPLICA: 403/501) |
| GET | `/api/v1/config` | Read-only allowlist config projection + box diagnostics |
| GET | `/api/v1/usage/overview` | Usage aggregates under one filter (501 on REPLICA) |
| GET | `/api/v1/slash-commands?cwd=&host=&fresh=1` | Composer slash-command palette (cloud relays) |
| GET | `/api/v1/skills` | All skills, content stripped |
| GET | `/api/v1/skills/:dirName` | One skill with full content |
| GET/PUT | `/api/v1/notes/global` | Global scratchpad (optimistic locking) |
| GET | `/api/v1/notes/backlinks/*path` | Inbound links of a note |
| GET | `/api/v1/notes/links/*path` | Outbound links of a note |
| GET | `/api/v1/notes/tags` | All note tags, frequency-ranked |
| GET | `/api/v1/notes/tags/:tag/notes` | Notes carrying a tag |
| DELETE | `/api/v1/notes/attachment/*path` | Delete a binary attachment |
| DELETE | `/api/v1/notes/folder/*path` | Recursive folder delete (client must confirm) |
| PUT | `/api/v1/conversations/active` | Switch the Personal AI's active conversation pointer |
| GET | `/api/v1/chat/stats` | Conversation size stats (messages + token estimate) |
| POST | `/api/v1/chat/clear` | Clear a Personal AI conversation |
| POST | `/api/v1/chat/compact` | Fire-and-forget background compaction |
| GET | `/api/v1/agents/meta/tools\|skills\|models` | Agent-editor dropdown catalogs |
| GET | `/api/v1/agents/:id` | One agent definition (full editor payload) |
| POST | `/api/v1/agents` | Create a config agent (501 on REPLICA) |
| PATCH | `/api/v1/agents/:id` | Edit a config agent (501 on REPLICA) |
| DELETE | `/api/v1/agents/:id` | Delete a config agent (501 on REPLICA) |
| POST | `/api/v1/agents/:id/clone` | Clone any agent as a config agent (501 on REPLICA) |
| GET | `/api/v1/commands` | Command templates (user + builtin) |
| GET | `/api/v1/commands/:name` | One command with content |
| POST | `/api/v1/commands` | Create a user command |
| PUT | `/api/v1/commands/:name` | Edit a user command (builtins → 403) |
| DELETE | `/api/v1/commands/:name` | Delete a user command (builtins → 403) |
| POST | `/api/v1/skills` | Create a skill in the Walnut-managed dir |
| PUT | `/api/v1/skills/:dirName` | Rewrite SKILL.md (CLI-store skills → 403) |
| PATCH | `/api/v1/skills/:dirName` | Enable/disable a skill (any source) |
| DELETE | `/api/v1/skills/:dirName` | Delete a skill dir (CLI-store skills → 403) |
| GET | `/api/v1/skills/:dirName/references` | Reference files of a skill |
| GET | `/api/v1/skills/:dirName/references/:file` | One reference file's content |
| GET | `/api/v1/repositories` | Repository YAML profiles (parsed headers) |
| GET | `/api/v1/repositories/:name` | One profile's full YAML |
| POST | `/api/v1/repositories/:name` | Create/update a profile |
| DELETE | `/api/v1/repositories/:name` | Delete a profile |
| POST | `/api/v1/routines/draft` | NL → populated routine draft, one LLM call (cloud relays) |
| GET | `/api/v1/tasks/enriched` | Full task rows + computed fields (overdue) |
| GET | `/api/v1/tasks/meta/sprints` | Sprint names with task counts |
| GET | `/api/v1/sessions/recent?limit=` | Most-recent sessions, v1 projection shape |
| GET | `/api/v1/sessions/summaries?limit=` | Parsed session summary markdown files |
| GET | `/api/v1/notes/list` | Flat note list with ids ([[ autocomplete) |
| POST | `/api/v1/notes/tags/rename` | Rename a tag across carrying notes |
| GET | `/api/v1/memory/telemetry` | Memory-entry write-path evidence |
| POST | `/api/v1/memory/daily-log/compact` | Manual extractive daily-log compaction |
| GET/POST | `/api/v1/stt/vocab` | Read / add custom STT vocabulary words |
| POST | `/api/v1/files/record-dir` | Record an "@"-picker folder |
| GET | `/api/v1/files/recent-dirs` | Union of session + "@"-picker recents |
| GET | `/api/v1/usage/summary\|daily\|by-source\|by-model\|by-agent\|recent\|pricing` | Usage detail breakdowns (501 on REPLICA; pricing works everywhere) |
| GET | `/api/v1/config/providers` | Provider readiness, key hints stripped |
| GET | `/api/v1/qmd/status` | Semantic search index health (501 on REPLICA) |
| GET | `/api/v1/integrations` | Registered plugin display metadata |
| GET | `/api/v1/integrations/settings` | Plugin settings metadata, secrets masked |
| GET | `/api/v1/timeline?date=` | Life Tracker day timeline (501 on REPLICA) |
| GET | `/api/v1/timeline/dates` | Dates with capture data (501 on REPLICA) |
| GET | `/api/v1/timeline/images/:date/:file` | Thumbnail JPG (501 on REPLICA) |
| POST | `/api/v1/timeline/toggle` | Enable/disable the Life Tracker job (501 on REPLICA) |
| GET | `/api/v1/heartbeat` | Heartbeat runner status (501 on REPLICA) |
| POST | `/api/v1/heartbeat/trigger` | Manual heartbeat, debounced (501 on REPLICA) |
| GET/PUT | `/api/v1/heartbeat/checklist` | Read/write HEARTBEAT.md |
| GET | `/api/v1/projects/:name/metadata` | Project detail-pane payload |
| PUT | `/api/v1/projects/:name/metadata` | Merge project settings (501 on REPLICA) |
| POST | `/api/v1/projects/:name/summary/regenerate` | Rebuild the AI project summary (501 on REPLICA) |

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

`isMain: true` marks the primary Personal AI (receives notifications & cron). All
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

**Which engine answers (cloud companion).** A chat turn always runs on the
engine the PRIMARY box is configured for (`agent.provider`), even when the phone
is talking to the cloud replica: the replica relays the turn to the primary and
forwards the primary's stream back onto this conversation's SSE channel, because
the replica has no session runner and could otherwise only answer with its own
in-process fallback loop. Clients need no change for this.

Image turns relay too. The bytes travel on the image lane (the same narrow
host-side save a session attachment uses), and only the resulting host paths ride
the relay call, so the picture reaches the primary's model without a multi-MB
control frame. Nothing about the request shape changes for the client.

Degraded case: when the relay is unusable (bridge down, primary's server down, a
primary that predates the relay) or an attachment cannot be handed over (too
large, or the primary's host refuses it), the replica answers the WHOLE turn from
its own loop instead of failing, and stamps the additive `engine` field on the
terminal frame (`"walnut-agent-fallback"`). A turn is never relayed with only
some of its pictures. `engine` is informational only — ignore it unless you want
to show the degradation.

### GET /api/v1/conversations/:id/stream (SSE)

`Content-Type: text/event-stream`. Events (each has a monotonic numeric `id:`):

| Event | Data | Meaning |
|---|---|---|
| `message-start` | `{ "turnId" }` | A turn began |
| `queued` | `{ "turnId", "position" }` | Turn accepted but waiting behind another turn on the shared agent queue (additive, may precede `message-start` by minutes) |
| `text-delta` | `{ "delta" }` | Streaming assistant text chunk |
| `tool` | `{ "name" }` | The agent invoked a tool |
| `thinking` | `{}` | The agent is reasoning (render a spinner) |
| `message-end` | `{ "turnId", "fullText", "engine"? }` | Turn finished; `fullText` = complete reply |
| `error` | `{ "message", "engine"? }` | Turn failed |

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
  due_date?, start_date?, created_at, updated_at, completed_at?,
  pinned?, unread?, tags?, summary? }` — `summary` is truncated to ~500 chars.
  `category` was removed in projection v2 (2026-08); `project` is the single
  grouping layer (`""` = Inbox). `starred?` was removed in 2026-08 when the
  starred system was retired (pin + focus tier is the working set); it is an
  optional field, so a client that still decodes it just never sees it.
  `start_date` (added 2026-07) is the "when to begin" time that defers a task
  out of the web Now view; additive and optional, so older clients ignore it.
  `end_date` (added 2026-08) is where that working block ENDS: paired with
  `start_date` it gives the task a duration on the calendar surfaces, and it is
  independent of `due_date` (the deadline). Meaningless on its own, so the write
  endpoints refuse an `end_date` with no `start_date`.
  `unread` (added 2026-08-09) is the read/unread marker — present and `true` only
  when the agent produced output the human hasn't opened; omitted otherwise.
  Additive and optional. `PATCH /api/v1/tasks/:id` accepts `unread` to mark a
  task read from the phone.
- Scope: all open tasks + tasks completed in the last 14 days (older
  completions are excluded from the projection).
- Provenance: `syncedAt` is when the primary box exported the snapshot. On the
  cloud companion the data rides the periodic git sync, so it can lag by up to
  a sync cycle; treat it as read-only replica data.
- `503 { "error": { "code": "unavailable" } }` — projection not synced yet
  (fresh companion before its first git pull).
- `POST /api/v1/tasks` (additive, 2026-08) body `{ "title", "project"?,
  "priority"?, "due_date"?, "start_date"?, "end_date"?, "description"? }` →
  `201 { "task": ProjectedTask }`.
  Same creation semantics as the web quick-add: omitted/empty `project` =
  config default → Inbox; a new project name auto-creates its registry row;
  `priority` one of `immediate|important|backlog|none` (default from config).
  `start_date` / `end_date` (additive, 2026-08) let a client create a task
  already scheduled on the calendar (tapping a day, dragging a time range);
  both are ISO-8601 (`YYYY-MM-DD` or full datetime), and `""` or `null` means
  "no date" so a client can send the shape unconditionally.
  `description` is write-only: it is stored on the task but NOT returned in the
  slim ProjectedTask shape (which carries `summary`, a different field) — don't
  expect to read it back from `POST`'s response or `GET /tasks`.
  Errors: `400 bad_request` (missing title / bad priority / bad due_date /
  bad `start_date`/`end_date` / `end_date` before `start_date` / `end_date`
  with no `start_date`), `409 conflict` (project source conflict).
  Works on BOTH boxes (2026-08: the REPLICA's former `503 not_supported_cloud`
  gate was removed — the cloud companion writes to its local store and the
  task outbox syncs it back to the primary). On a REPLICA the new task shows
  up in `GET /tasks` only after the outbox→primary→projection round trip
  (up to a couple of git-sync cycles); render the `201` response optimistically.
- `PATCH /api/v1/tasks/:id` (additive, 2026-08) body — any subset of
  `{ "status"?, "priority"?, "due_date"?, "start_date"?, "end_date"?,
  "project"?, "title"?, "description"? }`
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
  - Calendar window (additive, 2026-08): `end_date` joins `start_date` as the
    end of the task's working block, so a client can move or resize a task on a
    calendar with one PATCH. Both accept an ISO-8601 value, and `""` **or**
    `null` to clear (`due_date`'s frozen gate still takes only `""`). Rules,
    checked against the task's EFFECTIVE state (request values overlaid on the
    stored row, so a PATCH may send just one half): an `end_date` with no
    `start_date` is `400 bad_request`, and an `end_date` earlier than the
    `start_date` is `400 bad_request` (equal is fine). Clearing `start_date`
    cascades an `end_date` clear rather than 400ing, since removing a task from
    the calendar is a legitimate intent and an end with no start is not a state
    worth keeping.
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
- `POST /api/v1/tasks/:id/complete` (additive, 2026-08) → `200 { "task" }` —
  full `completeTask()` semantics. NOT the same as `PATCH { status: "done" }`:
  this one also auto-unpins the task from the Focus bar (and compacts the
  remaining `pin_order`s) and AWAITS the external-sync push, so a
  plugin-backed task that failed to reach its remote store answers an error
  instead of a silent `200`. `409 conflict` + `active_children` when the task
  still has non-COMPLETE children. Added for the CLI's `open-walnut done`,
  which has always had these semantics.
- `POST /api/v1/tasks/:id/start` (additive, 2026-08) body
  `{ "resume"?: bool, "prompt"?: string }` →
  `200 { "action": "start"|"resume", "taskId", "title", "sessionId"?,
  "resume_missed"? }` — start (or resume) a session for an EXISTING task.
  Distinct from `POST /api/v1/sessions`, whose body requires an absolute
  `cwd`: this one names only a task and lets the session-runner resolve cwd
  from the task/project chain (`task.cwd` → parent chain → project
  `default_cwd` → project memory dir). `resume: true` sends `prompt` into an
  already-live (`running`/`idle`) session for the task and returns
  `action: "resume"` + its `sessionId`; with no live session it starts a new
  one and sets `resume_missed: true`. `200` means ACCEPTED, not spawned (the
  spawn is async in session-runner), same as `POST /sessions`.
  Class C: `501 not_supported_cloud` on a REPLICA (no session-runner there) —
  use `POST /api/v1/sessions`, which relays over the bridge.
  Added for the CLI's `open-walnut start <task_id>`.
- `POST /api/v1/tasks/:id/star` → `200 { "task", "starred": false }` — RETIRED
  no-op. The starred system was removed in 2026-08; the route stays mounted for
  this frozen contract, still resolves the id (unknown id → `404`), and still
  answers the documented shape so an older client's decoder keeps working. It
  writes nothing, and `starred` is always `false`.
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
  sessions are excluded. Lane-bound sessions (2026-08) — ones that back a
  persistent UI conversation surface rather than a user-launched session — are
  also excluded; no row shape changed, the list just never contains them.
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

- `POST /api/v1/sessions/:id/messages` body `{ "text": "...", "images"?, "messageId"? }` →
  `202 { "messageId" }`. The message is delivered into the running CLI
  session (mid-turn sends are fine — the session reads them between turns).
  - `messageId` (additive) — a client-supplied stable id (`qm-…`, ≤64 chars of
    `[A-Za-z0-9-]`) that makes the send IDEMPOTENT: a retry after a lost 202
    reuses the original id and collapses onto the already-queued/delivered
    message instead of sending twice. Omit it and the server mints one (the
    returned `messageId`). Malformed values are ignored (fresh id minted).
    Clients that retry SHOULD send the `messageId` from their first attempt.
  - Durability (cloud): sends land in the primary's persistent message queue
    (the same store desktop sends use) before delivery, so a daemon/CLI death
    mid-flight becomes delayed delivery — retry on `503`, never assume loss.
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
  "message"?, "optionId"?, "answers"? }` → `200 { "status": "resolved",
  "requestId", "allow" }` — answers a live CLI tool prompt (`message` =
  optional deny reason; `optionId` selects a specific provider option on ACP
  sessions). `answers` (optional, additive 2026-08) answers the CLI's
  `AskUserQuestion` tool: an object mapping each question's text to the chosen
  option label (or the user's own free text). It is merged into the tool's
  input, so the model receives the real answers — an `allow` without it tells
  the model the user answered nothing. Must be a flat object of string values
  (`400 bad_request` otherwise); ignored on ACP sessions, which have no
  `AskUserQuestion` tool. `404 not_found` when the request is
  gone/already resolved or no live session holds it.
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

### Personal AI conversation management (additive, Wave 1 2026-08)

Class A everywhere (the REPLICA runs its own Personal AI). `agentId` is accepted
like the other conversation endpoints (absent → `general`).

- `PATCH /api/v1/conversations/:id` body `{ "title"? | "pinned"? }` →
  `200 { "conversation" }`. At least one field required.
- `DELETE /api/v1/conversations/:id` → `204`. The MAIN conversation (receives
  notifications + cron) is never deletable → `409 conflict`.
- `POST /api/v1/conversations/:id/stop` → `200 { "stopped": N,
  "questionCancelled": boolean }` — aborts ALL of the agent's active turns
  (WS- and REST-initiated; REST clients have no per-socket identity, and for
  a single-user Personal AI that is what "stop" means) and cancels any pending
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

### Routines (additive, Wave 2 2026-08)

Full routine (cron) management. Class B everywhere: the PRIMARY's scheduler
is the single writer of the routine store, so a REPLICA relays every call
over the bridge via `server.routines.*` actions on the existing
`session.control` command (standard failure ladder:
`session_control_needs_upgrade` / `bridge_offline` / verbatim error
passthrough). The natural-language draft endpoint is deliberately NOT in v1
(Wave 3 — it is an LLM call).

- `GET /api/v1/routines?includeDisabled=true` → `200 { "jobs": [CronJob…] }`.
- `GET /api/v1/routines/actions` → `{ "actions" }` — the registered action
  catalog for building forms.
- `GET /api/v1/routines/status` → scheduler status (enabled, next wakeups).
- `GET /api/v1/routines/executors` → `{ "executors", "options": { hosts,
  models } }` — executor definitions + dropdown options.
- `GET /api/v1/routines/:id` → `{ "job" }`; unknown id → `404 not_found`.
- `POST /api/v1/routines` body = the normalized job shape (at minimum
  `schedule` + `payload`/`executor`) → `201 { "job" }`; invalid input →
  `400 bad_request`.
- `PATCH /api/v1/routines/:id` → `{ "job" }`.
- `DELETE /api/v1/routines/:id` → `204`; unknown id → `404 not_found`
  (unlike the tolerant legacy web route — a phone delete fails loudly).
- `POST /api/v1/routines/:id/toggle` → `{ "job" }` with `enabled` flipped.
- `POST /api/v1/routines/:id/run` → `{ "result" }` — forced immediate run.
- Engine still booting → `503 { error: { code: "internal", message:
  "Routines engine is not running" } }`.

### Projects, ordering, project favorites (additive, Wave 2 2026-08)

- `GET /api/v1/projects` → `200 { "projects": [ { name, source,
  order_index?, metadata?, favorite, counts: { todo, active, done } } ],
  "inbox": { "counts" } }`. Class A (the REPLICA reads its local store).
- `POST /api/v1/projects` body `{ "name", "source"? }` → idempotent create:
  `201 { name, source, created: true }` for a new row, `200 { …, created:
  false }` with the EXISTING row's source when the name is taken (a second
  caller can never steal a provider claim). Unknown source →
  `400 bad_request`; a source conflict → `409 conflict` with
  `project` / `intended_source` / `existing_source` extras.
- `PATCH /api/v1/projects/:name` body `{ "name" }` → rename
  (merge-on-collision, case-insensitive; favorites + ordering follow).
  **REPLICA: `501 not_supported_cloud`** — the registry has no replica
  write-back channel, so a local rename would be silently reverted by the
  next projection import.
- `DELETE /api/v1/projects/:name[?remote=1]` → drop the registry row; tasks
  fall back to the Inbox. A provider-claimed project refuses a plain DELETE
  (`409 conflict` + `cascade_available`); `?remote=1` opts into the
  irreversible provider cascade. **REPLICA: `501 not_supported_cloud`**
  (cascade needs the primary's provider plugins).
- `GET /api/v1/ordering` → `{ "projects": [names in display order] }`;
  `PUT /api/v1/ordering/projects` body `{ "order": [names] }` → same shape.
  Class A (config rides git-sync).
- `POST /api/v1/favorites/projects/:name` / `DELETE …/:name` →
  `{ "projects" }` — case-insensitive, idempotent; stored under the
  registry's canonical spelling. Completes the Wave-1 note-favorites pair.

### Task extras: tags, groups, quick-parse, focus tiers (additive, Wave 2 2026-08)

- `GET /api/v1/tasks/meta/tags` → `200 { "tags": [ { tag, count } ] }` —
  autocomplete catalog. Class A.
- Virtual task groups — **all writes answer `501 not_supported_cloud` on a
  REPLICA** (`group_id` and the group registry are not in the outbox update
  whitelist, so replica-local writes would silently revert; an honest error
  beats a silent revert):
  - `GET /api/v1/tasks/groups` → `{ "groups" }` (reads work on both boxes).
  - `POST /api/v1/tasks/groups` body `{ "task_ids": [≥2], "label"? }` →
    `201 { group_id, label, … }`. Unlike the web route, no async AI label
    refinement fires — mobile reads the response synchronously.
  - `POST /api/v1/tasks/groups/:groupId/add` body `{ "task_ids" }`.
  - `POST /api/v1/tasks/groups/remove` body `{ "task_ids" }` →
    `{ removed_ids, dissolved_group_ids }`.
  - `PATCH /api/v1/tasks/groups/:groupId` body `{ "label" }`;
    `PATCH …/:groupId/hidden` body `{ "hidden": boolean }`.
- `POST /api/v1/tasks/quick-parse` body `{ "text" (≤500 chars), "timeZone"
  (IANA) }` → the structured quick-task parse (title/dates/priority/tier/
  project hints). Stateless — works on BOTH boxes (the replica has its own
  model credentials). Invalid text/timezone → `400 bad_request`.
- Custom focus tiers (Wave 1 shipped the tier read + pin management; this
  completes CRUD — **`501 not_supported_cloud` on a REPLICA**, same
  outbox-whitelist reason as groups):
  - `POST /api/v1/focus/tiers` body `{ "label" }` → `201 { tier, tiers }`.
  - `PUT /api/v1/focus/tiers/:id` body `{ "label" }` → `{ tier, tiers }`.
  - `DELETE /api/v1/focus/tiers/:id` → `{ tiers, moved }` (members move to
    satellite). Built-in tiers → `400 bad_request`.

### Session extras (additive, Wave 2 2026-08) — controls / settings / side questions / workflow / plan / subagent history / execute-compact / queue / list-dirs

All Class B: session records + live CLIs live on the primary, so a REPLICA
relays each endpoint as a NEW action on the existing `session.control`
command (the daemon forwards action strings opaquely — no daemon upgrade
needed; an old primary answers `400 session_control_needs_upgrade`).

- `GET /api/v1/sessions/list-dirs?prefix=&host=&depth=` → `{ "dirs",
  "parent", "exists" }` — subdirectory autocomplete for the path picker
  (relays as the box-level `server.list-dirs` action).
- `GET /api/v1/sessions/:id/controls` → `{ "engine": "claude"|"codex",
  "controls": [ { id, name, type, currentValue, options } ] }` —
  provider-neutral selectable controls (the mode select for Claude sessions;
  the native control set for Codex/ACP sessions).
- `POST /api/v1/sessions/:id/controls` body `{ "id", "value" }` → the same
  payload with the control applied. Unknown control/value →
  `400 bad_request`; a live CLI that rejects the switch → `409 conflict`.
- `GET /api/v1/sessions/:id/settings?details=1` → `{ "live", "requested",
  "applied", "effective", "details"? }` — requested vs actually-applied
  model/effort/mode; `details=1` adds context usage + CLI binary version
  when the CLI is live.
- Side questions (ask the live CLI something WITHOUT injecting into its main
  conversation):
  - `GET /api/v1/sessions/:id/side-questions` → `{ "sideQuestions" }`.
  - `POST /api/v1/sessions/:id/side-question` body `{ "question" }` →
    `200 { "sideQuestion" }` — synchronous; the response carries the answer
    (can take tens of seconds). Dead/unreachable CLI → `502`.
  - `POST /api/v1/sessions/:id/side-question/:qid/promote` →
    `{ "taskId", "parentTaskId"? }` — Q&A becomes a (sub)task.
  - `DELETE /api/v1/sessions/:id/side-question/:qid` → `{ "status":
    "deleted" }`.
- `GET /api/v1/sessions/:id/workflow` → the dynamic-workflow progress
  payload, or **`204` when the session never ran a workflow**.
- `GET /api/v1/sessions/:id/plan` → `{ "content", "planFile"?,
  "sourceSessionId"? }`; no plan → `404 not_found`.
- `GET /api/v1/sessions/:id/subagent/:agentId/history?workflow=1` →
  `{ "messages" }` — one subagent lane's rich history.
- `POST /api/v1/sessions/:id/execute-compact` body `{ "task_id"?,
  "working_directory"?, "instructions"?, "mode"? }` → `{ "status":
  "started", … }` — execute a completed plan in the SAME session after
  injecting a compact boundary (pairs with Wave 1's execute-continue).
- Queued messages (REST twins of the web console's WS RPCs):
  - `GET /api/v1/sessions/:id/queue` → `{ "messages" }`; unknown session →
    `404`.
  - `PATCH /api/v1/sessions/:id/queue/:messageId` body `{ "text" }` →
    `{ "ok" }`; already processing/gone → `409 conflict`.
  - `DELETE /api/v1/sessions/:id/queue/:messageId` → `{ "ok" }`.

### File browsing (additive, Wave 2 2026-08) — list / resolve-path / file-content

Same sandbox guards as the web console (shared implementation): directory
traversal (`..`) rejected, absolute paths required, shell metacharacters
rejected, 4096-char cap.

- `GET /api/v1/files/list?path=/abs/dir&host=&showHidden=1[&cwd=&sessionId=]` →
  `{ "path", "selectedFile"?, "entries": [ { name, type: "dir"|"file",
    size?, hasChildren? } ], "requestedPath"?, "resolvedVia"? }` — one directory
  level (lazy tree), dirs before files. Entries carry `name` only (no `path`
  field) — join with the response's top-level `path` to build absolute child
  paths. REPLICA: relays as the box-level `server.files.list` action
  (names-only metadata).
  **Self-healing (additive, 2026-08):** passing `cwd` and/or `sessionId` makes a
  path that can't be listed resolve first (see resolve-path below) and the
  listing retry on what was found, so a partial or stale path shows files
  instead of an errno. `resolvedVia` names the layer that found it; when the
  answer is only a nearby STAND-IN, `requestedPath` echoes what was asked for so
  the client can say "couldn't find X, showing Y". Omit both parameters for the
  pre-2026-08 behavior (a missing path is a `400`).
- `GET /api/v1/files/resolve-path?rel=&cwd=&host=[&sessionId=]` →
  `{ "path", "resolved", "via"?, "degraded"?, "alternatives"?, "line"?, "column"?,
    "endLine"? }` — resolves a transcript-mentioned path (relative,
  package-relative, or an absolute one with a wrong prefix) against the session cwd.
  The target host runs a layered search: paths the session already opened (its
  transcript), the ancestor walk, the git index (submodules included, any depth),
  then a pruned `find`, then a case-insensitive retry. `via` reports which layer
  answered. Unresolvable → `resolved: false` with the nearest existing directory
  (`degraded: true`) so a click always lands somewhere. Passing `sessionId` enables
  the transcript layer, which is both the cheapest and the most accurate — always
  send it when known. REPLICA: relays as `server.files.resolve`.
  **`rel` may be DECORATED.** A path as written in prose is accepted as-is:
  wrapped (`` `a.ts` ``, `"a.ts"`, `<a.ts>`), carrying a position (`a.ts:42`,
  `a.ts:42:7`, `a.ts#L42`, `a.ts:10-20`, `a.ts(42,7)`, `a.ts, line 42`), trailing a
  sentence period or comma, or spelled with Windows separators. The position comes
  back as `line`/`column`/`endLine` — present even on a failed resolve, since the
  reference asked for it either way.
- `GET /api/v1/file-content?path=&host=` → `{ "content", "size",
  "truncated", "binary", "extension", "error"?, "contentHash"? }` — the
  FileViewer JSON payload (text, truncated at 512 KB, binary-detected). A
  missing file is a `200` with `error` set (the viewer contract), not a 404.
  `contentHash` is the optimistic-lock token for the write below; it is
  **absent for a truncated or binary read**, which is exactly what marks those
  files non-editable (hashing a served 512 KB prefix would let a save
  round-trip it back over the whole file and delete the tail).
  **REPLICA relay (2026-08):** content reads relay to the target host's
  daemon over the bridge via the narrow `fs.readBounded` command — NOT
  `fs.read`: the daemon enforces a **2 MB cap** and the path sandbox
  (traversal/absolute checks, realpath resolution, secret-path denylist:
  `~/.ssh`, `~/.aws`, key files, `.env`, `config.yaml`, …) HOST-SIDE.
  `host=''`/absent targets the primary box's daemon (`__local__`), except
  files already present in the replica's own safe `/tmp/open-walnut*` roots,
  which are served locally. Outcomes: over the cap → `413 too_large`; the
  host's bridge down or the read timing out (15 s deadline) →
  `503 bridge_offline`; a daemon that predates `fs.readBounded` →
  `501 not_supported_cloud` (self-heals via daemon auto-upgrade on the next
  primary reconnect); a host-side sandbox denial → `403
  not_supported_cloud`. Replica-LOCAL reads keep the safe-root confinement +
  secret-path denials (`403` mapped to `not_supported_cloud`).
  **`raw=1` (additive, 2026-08):** serve the file's BYTES with a real
  Content-Type instead of the JSON envelope — `text/html` for `.html`/`.htm`,
  `image/svg+xml` for `.svg`, media/PDF/image types stream byte-exact with
  Range support, everything else `text/plain`. `download=1` forces
  `Content-Disposition: attachment`. This is what the iOS app points its
  WKWebView at for HTML previews (same mechanism as the web console's
  preview iframe). Identical sandbox to the JSON path (one shared
  implementation); errors come back as plain-text bodies with the same
  status codes (404 missing, 502 remote transport).
- `PUT /api/v1/file-content` `{ path, host?, content, expectedHash? }` →
  `{ "ok", "size", "contentHash" }` — save an edit made in the Files-panel
  editor. Shares the read path's sandbox verbatim (one `assertPathAllowed` for
  both verbs), so a path the read refuses the write refuses identically.
  Additional write-only refusals, each because the editor could not have held
  the file faithfully: `409` + `{ code: "conflict", currentHash }` when
  `expectedHash` no longer matches disk (an agent, another tab, or a
  `git checkout` wrote first — the other writer's bytes are kept, never
  clobbered); `409` when the target is larger than the 512 KB read cap;
  `415` when the target reads as binary; `413` when the submitted content
  exceeds the cap; `404` when the parent directory does not exist (parents are
  never created — that's a typo, not an intent). Creating a NEW file is
  allowed: a missing target with no `expectedHash` is not a conflict.
  **REPLICA:** writes never ride the bridge either — `host=` answers `501
  not_supported_cloud`, and replica-LOCAL writes are refused outright
  (`403`), since the only roots a replica can read ARE its live session state.

### Console reads (additive, Wave 2 2026-08) — config / usage / slash-commands / skills

- `GET /api/v1/config` → `200 { "config", "cloud", "processNice",
  "memory" }`. The `config` object is a **whitelist-field projection** — the
  inverse of a redact-passthrough: only explicitly allowlisted fields ever
  appear (`user.name`, `defaults`, `provider.type/model/bedrock_region`,
  `agent` model fields, `hosts` as `{ label, enabled }` only, `session`
  timeout/modes). Credentials, API keys, host connection details, and any
  future secret-bearing field are structurally absent, not masked. Works on
  both boxes (`cloud: true` on a REPLICA). Read-only by design — config
  WRITE is desktop-only (Class D).
- `GET /api/v1/usage/overview?start=&end=&source=&model=&agent=&limit=` →
  every usage aggregate under one cross-filter. **REPLICA: `501
  not_supported_cloud`** (the usage DB lives on the primary).
- `GET /api/v1/slash-commands?cwd=&host=&fresh=1` → `{ "items",
  "degraded"? }` — the composer palette (skills + command templates +
  built-ins; remote hosts discovered over the daemon, cached per host).
  REPLICA: relays as the box-level `server.slash-commands` action.
- `GET /api/v1/skills` → `{ "skills" }` with `content` stripped;
  `GET /api/v1/skills/:dirName` → `{ "skill" }` with full content;
  unknown → `404 not_found`. Class A (skills ride git-sync). Skill WRITE
  is Wave 3.

### Notes extras (additive, Wave 2 2026-08) — global / links / tags / deletes

Class A everywhere (git-synced vault; the structural index rebuilds locally
on each box) — identical behavior on a REPLICA.

- `GET /api/v1/notes/global` → `{ "content", "contentHash" }` (empty string
  before first write). `PUT /api/v1/notes/global` body `{ "content",
  "expectedHash"? }` → `{ "ok", "contentHash" }`; a stale `expectedHash` →
  `409 conflict` + top-level `currentHash` so the client can rebase;
  >2 MB → `413 too_large`.
- `GET /api/v1/notes/backlinks/*path` → `{ "backlinks": [ { id, path,
  title, name, snippet, status, candidates? } ] }` — id-keyed inbound links
  incl. ambiguous edges.
- `GET /api/v1/notes/links/*path` → `{ "links": [ { dstId, dstName, status,
  title?, path? } ] }` — outbound links.
- `GET /api/v1/notes/tags` → `{ "tags": [ { tag, count } ] }`;
  `GET /api/v1/notes/tags/:tag/notes` → `{ "notes": [ { id, title, path,
  snippet, modified } ] }`.
- `DELETE /api/v1/notes/attachment/*path` → `{ "ok" }` — binary attachments
  only (`.md` paths → `400`; use the note delete).
- `DELETE /api/v1/notes/folder/*path` → `{ "ok", "deletedNotes" }` —
  **recursive and irreversible**; clients MUST gate it behind an explicit
  confirm (the web console uses a typed-confirm dialog). The vault root and
  traversal paths refuse with `400`.

### Personal AI additions (additive, Wave 2 2026-08): active pointer + chat stats/clear

Class A (the REPLICA runs its own Personal AI). `agentId` as usual (absent →
`general`).

- `PUT /api/v1/conversations/active` body `{ "conversationId", "agentId"? }`
  → `200 { "activeConversationId" }`. This is SERVER state, not client UI
  state: cron results and background notifications route into the active
  conversation.
- `GET /api/v1/chat/stats?agentId=&conversationId=` →
  `{ "apiMessageCount", "estimatedTokens", "systemTokens", "toolsTokens",
  "estimatedTotalTokens", "compacted", "contextWindow" }` — real
  conversation size (cached between turns). No `conversationId` = the active
  conversation.
- `POST /api/v1/chat/clear?agentId=&conversationId=` → `{ "ok": true }` —
  clears the conversation history.

### Library (additive, Wave 3 2026-08) — agents / commands / skills write / repositories

- Agents (definitions live in the primary's machine-local config.yaml, which
  never git-syncs — **every agent WRITE answers `501 not_supported_cloud` on
  a REPLICA**; reads answer with the replica's own registry):
  - `GET /api/v1/agents/meta/tools` → `{ "tools": [names] }`;
    `…/meta/skills` → `{ "skills": [{ dirName, name, description }] }`;
    `…/meta/models` → `{ "models": [ids] }` — the agent-editor dropdowns.
  - `GET /api/v1/agents/:id` → `{ "agent" }` — the FULL definition (the
    frozen `GET /v1/agents` list stays the slim chat-picker projection).
  - `POST /api/v1/agents` body `{ "id" (lowercase slug), "name", … }` →
    `201 { "agent" }`; duplicate id → `409 conflict`; a model outside
    `available_models` → `400`.
  - `PATCH /api/v1/agents/:id` → `{ "agent" }` (id/source immutable).
  - `DELETE /api/v1/agents/:id` → `204`; builtins refuse with `400`.
  - `POST /api/v1/agents/:id/clone` body `{ "id", "name"? }` →
    `201 { "agent" }` — clones ANY agent (incl. a builtin) as a config agent.
- Commands (markdown slash-command templates; git-synced dir — Class A):
  - `GET /api/v1/commands` → `{ "commands" }`; `GET …/:name` → `{ "command" }`.
  - `POST /api/v1/commands` body `{ "name", "content", "description"? }` →
    `201 { "command" }`; reserved/invalid names → `400`; duplicates → `409`.
  - `PUT …/:name` / `DELETE …/:name` — user commands only; builtins →
    `403 forbidden`.
- Skills write (read list/detail shipped in Wave 2). **Scope rule:** v1 only
  writes the WALNUT-managed skills dir (`~/.open-walnut/skills`, git-synced).
  The Claude CLI's own global store (`~/.claude/skills`) is READ-only through
  v1 — update/delete of a CLI-store skill answer `403 forbidden`, and create
  has no `target` parameter (always lands in the Walnut dir):
  - `POST /api/v1/skills` body `{ "dirName", "content", "category"? }` →
    `201 { "skill" }`; existing name anywhere → `409`.
  - `PUT /api/v1/skills/:dirName` body `{ "content" }` → `{ "skill" }`.
  - `PATCH /api/v1/skills/:dirName` body `{ "enabled": boolean }` →
    `{ "skill" }` — allowed for ANY source (it only writes Walnut's own
    skill-settings.json, never the skill's directory).
  - `DELETE /api/v1/skills/:dirName` → `204`.
  - `GET …/:dirName/references` → `{ "files": [{ name, size }] }`;
    `GET …/:dirName/references/:file` → `{ "content" }`.
- Repositories (YAML profiles; git-synced dir — Class A):
  - `GET /api/v1/repositories` → `{ "repositories": [{ slug, name,
    description, tech_stack, hosts, modified, size }] }`.
  - `GET /api/v1/repositories/:name` → `{ "slug", "content", "modified" }`.
  - `POST /api/v1/repositories/:name` body `{ "content" }` →
    `{ "ok", "status": "created"|"updated" }`; >100 KB → `413 too_large`;
    non-slug names (traversal probes) → `400`.
  - `DELETE /api/v1/repositories/:name` → `{ "ok": true }`.

### Console extras (additive, Wave 3 2026-08) — usage detail / providers / qmd / integrations / timeline / heartbeat

- Usage detail breakdowns (complete the Wave-2 composite `/usage/overview`;
  **`501 not_supported_cloud` on a REPLICA** — the usage DB lives on the
  primary — except `pricing`, which is a static table served everywhere):
  - `GET /api/v1/usage/summary` → all period summaries.
  - `GET /api/v1/usage/daily?days=30` → `{ "daily" }` time series.
  - `GET /api/v1/usage/by-source|by-model|by-agent?period=today|7d|30d|all`
    → `{ "sources"|"models"|"agents" }`.
  - `GET /api/v1/usage/recent?limit=50` → `{ "records" }`.
  - `GET /api/v1/usage/pricing` → `{ "models", "version" }`.
- `GET /api/v1/config/providers` → `{ "providers", "cloud" }` — provider
  readiness for the ANSWERING box (api/base_url/status/auto_detected/models/
  credential_source). Same builder as the desktop settings screen, with
  `key_hint` (last-4 of a key) **stripped**: even a key fragment doesn't
  belong at the paired-device trust level. Works on both boxes; the replica
  describes its own credentials.
- `GET /api/v1/qmd/status` → semantic-search index health (model, store
  stats, state machine, progress). **REPLICA: 501** (no QMD store on the
  companion). The maintenance actions (download/reindex) stay desktop-only.
- `GET /api/v1/integrations` → `[{ id, name, description, badge, … }]`;
  `GET /api/v1/integrations/settings` → per-plugin configSchema + uiHints +
  current values with secret-ish keys masked (`••••••`). Class A.
- Life Tracker timeline (**REPLICA: 501** — the capture dir holds screenshots
  of the primary Mac and is deliberately excluded from git-sync):
  - `GET /api/v1/timeline?date=YYYY-MM-DD` → `{ date, entries, summary,
    tracking }`; bad date → `400`.
  - `GET /api/v1/timeline/dates` → `{ "dates" }` newest first.
  - `GET /api/v1/timeline/images/:date/:file` → JPEG bytes (jpg/jpeg only,
    traversal rejected).
  - `POST /api/v1/timeline/toggle` → `{ "enabled", "jobId" }`; no tracker
    job yet → `404`.
- Heartbeat:
  - `GET /api/v1/heartbeat` → `{ enabled, state }` — **REPLICA: 501** (the
    runner lives on the primary; a replica answering "disabled" would lie).
  - `POST /api/v1/heartbeat/trigger` body `{ "context"? }` → `{ "ok" }`
    (debounced ~250ms). REPLICA: 501; not enabled → `400`.
  - `GET/PUT /api/v1/heartbeat/checklist` → `{ "content" }` / `{ "ok" }` —
    HEARTBEAT.md rides git-sync (Class A, both boxes).

### Long-tail additions (additive, Wave 3 2026-08) — folded into existing domains

- `POST /api/v1/routines/draft` body `{ "text" }` → `{ "draft" }` — natural
  language → fully-populated routine draft (ONE LLM call; the client prefills
  the create form, nothing is auto-created). Runs where the model credentials
  live: the primary answers directly, a REPLICA relays
  (`server.routines.draft`). Empty text → `400`; an unusable model output →
  `422` with the failure message (degrade to the manual form).
- `GET /api/v1/tasks/enriched` → `{ "tasks" }` — full task rows + computed
  `overdue`. `GET /api/v1/tasks/meta/sprints` → `{ "sprints": [{ name,
  count }] }`. Class A.
- `GET /api/v1/sessions/recent?limit=10` → `{ "sessions", "syncedAt" }` —
  most-recently-active sessions in the SAME slim projection shape as the
  frozen `GET /v1/sessions` (not the web's raw-record shape). Works on both
  boxes (projection file). `GET /api/v1/sessions/summaries?limit=10` →
  `{ "summaries" }` — parsed session summary markdown (Class A, git-synced).
- `GET /api/v1/notes/list` → `{ "notes": [{ id, title, path, name }] }` —
  flat list for `[[` autocomplete (file-walk fallback while the index is
  cold). `POST /api/v1/notes/tags/rename` body `{ "from", "to" }` →
  `{ "ok", "updated" }` — targeted rewrite of carrying notes (frontmatter +
  inline). Class A.
- `POST /api/v1/chat/compact?agentId=&conversationId=` → `{ "ok",
  "async": true }` or `{ "ok", "alreadyRunning": true }` — fire-and-forget
  background compaction. Class A (the replica compacts its own Personal AI).
- `GET /api/v1/memory/telemetry` → `{ "stores", "note" }` — write-path
  evidence per memory entry (age, revision churn, provenance).
  `POST /api/v1/memory/daily-log/compact` body `{ "date"?, "threshold"?,
  "summarizer": "extract" }` → compaction result; no log for the date →
  `404`; missing/unknown summarizer above threshold → `400`. Class A.
- `GET /api/v1/stt/vocab` → `{ "words" }` (the internal route's absolute
  `path` field is deliberately dropped); `POST /api/v1/stt/vocab` body
  `{ "word" }` → `{ "added", "word", "reason"? }` (case-insensitive dedup).
  Class A — each box serves its own git-synced vocab file.
- `POST /api/v1/files/record-dir` body `{ "path" (absolute), "host"? }` →
  `{ "status": "ok" }` — record an "@"-picker folder (separate store from
  session working dirs). `GET /api/v1/files/recent-dirs` → `{ "dirs":
  [{ cwd, host }] }` — the deduped union, most-recent first. Class A.
- `GET /api/v1/projects/:name/metadata` → `{ name, source, metadata,
  memorySummary, counts }` — the project detail-pane payload (works on both
  boxes). `PUT /api/v1/projects/:name/metadata` → merged settings blob;
  JSON `null` clears a key. **REPLICA: 501** (registry writes have no
  write-back channel). `POST /api/v1/projects/:name/summary/regenerate` →
  `{ "summary", "summary_task_count" }`; nothing to summarize → `422`.
  **REPLICA: 501**.

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

## Offline write matrix (REPLICA behavior contract, 2026-08)

This section is the contract the iOS optimistic-mutation layer relies on. It answers, per mutation family: what happens on the cloud REPLICA, what happens while the Mac (primary) is unreachable, and how the two stores converge afterward. General model:

- **Class A (local-store + outbox)**: the replica has a real local task store (seeded by the pushed projection). The mutation applies to that store, the route answers from it immediately, and a background op rides the `server.tasks.apply` bridge RPC to the primary; when the bridge is down the op banks in a durable disk queue (`cache/task-queue/`) and drains on reconnect, on the next successful RPC, and on a 60s sweep. Mac asleep or offline never blocks or fails the write.
- **Class B (synchronous relay)**: the mutation acts on state only the primary owns (a live CLI process, the cron engine, a registry with no write-back lane). The route relays over the bridge and waits; bridge down is an honest `503 bridge_offline`.
- **Class B+ (fast-accept relay)**: like B, but the payload is pure metadata the primary applies unconditionally, so when the bridge is down the intent is persisted in a durable queue (`cache/control-queue/`) and the route answers `200` with the optimistic row plus an additive `queued: true` marker.
- **Class C (refused on replica)**: `501 not_supported_cloud`.

Convergence rules (Class A):

- **Per-row LWW**: every op carries the row's `updated_at`; the primary skips an op older than its own row (a stale phone snapshot can never clobber a newer Mac edit). The projection import applies the same rule in the other direction. Later timestamp wins, both ways.
- **Field scoping (`touched`)**: an op names the fields the originating mutation actually set; the primary patches only those. Content the projection never ships to the replica (`description`, `note`, the full `summary`) can therefore never be blanked by an unrelated phone edit. A touched field absent from the snapshot is an explicit clear (e.g. unpin clears `pin_order`/`focus_tier`).
- **Note appends**: `POST /tasks/:id/notes` ships the appended entry (`append.note`); the primary concatenates onto its own note, so phone and Mac appends interleave without loss instead of last-writer-wins on the whole blob.
- **Order ops**: reorder (project rows) and pins-reorder carry the whole ordered id list with no per-row clock; latest arrival wins. After a replica-side reorder the projection import suppresses order-alignment for 15 minutes so a projection frame built before the primary applied it cannot re-impose the old order.
- **Deletes**: a replica delete leaves a 15-minute tombstone; the upsert-only projection import and the GET /tasks overlay both honor it, so a projection frame built pre-delete cannot resurrect the row. A delete the primary refuses (task has live sessions) is consumed, and the next projection push restores the row on the replica: the honest outcome.
- **Echo protection**: rows with a pending (queued, undelivered) op are skipped by the projection import, because the local write is newer than any projection by construction.
- **Duplicates/replays are safe**: ops are idempotent absolute snapshots with a replay-guard on `opId`; double delivery (RPC + queue flush) converges to the same state.

Per-family matrix:

| Mutation family | Replica behavior | Mac offline | Convergence |
|---|---|---|---|
| Task create (`POST /tasks`) | Class A: 201 with the created row from the local store | accepted; op queued | insert-by-same-id on the primary; project registry row auto-minted; primary recomputes `source` |
| Task PATCH (title/description/status/phase/priority/due_date/start_date/end_date/project/tags/unread) | Class A: 200 with the updated row | accepted; op queued | LWW + `touched` scoping; project move mints the registry row; status→phase derivation runs on the primary too. Both calendar dates are in the op update whitelist, and a `touched` date absent from the snapshot is the explicit clear, so a phone-side reschedule or "off the calendar" reaches the primary intact |
| Quick-parse (`POST /tasks/quick-parse`) | stateless LLM call on the replica's own credentials | works (no primary involved) | n/a |
| Task delete (single + batch) | Class A: 204 / per-task result | accepted; op queued | tombstone prevents projection resurrection; delete blocked by a live session is consumed (row comes back via projection) |
| Batch phase (`POST /tasks/batch/phase`) | Class A: 200 partial-success shape | accepted; one op per changed task | same as PATCH; COMPLETE additionally clears the pin fields |
| Complete (`POST /tasks/:id/complete`) | Class A: 200 | accepted; op queued | phase + auto-unpin travel as one scoped op; a later phone reopen (touched, human-vetted) un-completes the primary row |
| Notes append / note replace / description / summary (`/tasks/:id/notes`, `note`, `description`, `summary`) | Class A: 200 | accepted; op queued | append concatenates on the primary; replace/description/summary are `touched`-scoped LWW |
| Depends-on (`PUT /tasks/:id/depends-on`) | Class A: 200 (cycle-validated locally first) | accepted; op queued | re-validated on the primary (existence + cycles); a primary-side validation failure drops only that field |
| Tasks reorder (`PATCH /tasks/reorder`) | Class A: 200; local order updated | accepted; order op queued | whole-list, latest-arrival-wins; projection order alignment pauses 15 min after a local reorder |
| Focus pin / unpin (`POST`/`DELETE /focus/tasks/:id`) | Class A: 200 with `pinned_tasks` | accepted; op queued | pin fields travel as explicit sets/clears (`touched`) |
| Focus pins reorder (`PUT /focus/reorder`) | Class A: 200 full tier split | accepted; order op queued | `reorder-pins` op, latest-arrival-wins |
| Focus tier move (`PUT /focus/tasks/:id/tier`) | Class A: 200 | accepted; op queued | `focus_tier` scoped LWW; the custom-tier registry syncs replica-ward via the projection (`custom_tiers`), so replica-side validation matches the primary |
| Custom tier CRUD, task groups, project rename/delete | Class C: `501 not_supported_cloud` | n/a | registries are primary-owned with no write-back lane |
| Task detail readback (`GET /tasks/:id`) | local row; with a live bridge the primary's full row is fetched (5s budget) and served when not older than the local row | local row (description/note may be blank until the bridge returns) | read-only |
| Session PATCH (title / archived / human_note) | Class B+ fast-accept: synchronous relay first; bridge down → durable `cache/control-queue/` + `200 { session, queued: true }` | accepted and queued | drains on reconnect/60s sweep; primary validates at apply time (e.g. archive requires a stopped session); a rejection is dropped and the next projection push shows the truth |
| Session PATCH (`mode`) | Class B synchronous only | `503 bridge_offline` | mode reconfigures the live CLI (permission mode swap); only the primary can truthfully accept it |
| Session lifecycle: terminate / restart / retry / permission / execute-continue, model / effort / fork, session launch, messages into a session | Class B relays (messages ride their own durable `session.message` relay; see Session talk) | honest `503 bridge_offline` (messages: still accepted durably by the daemon lane when the daemon is reachable) | these act on a live process; fabricating acceptance would lie about the session's real state |
| Notes vault writes (create/update/delete, global notes, tag rename, folder/attachment deletes) | Class A-like: the vault is git-synced data; writes land locally | accepted | git-sync merge on reconnect; optimistic-lock hashes (`expectedHash`) protect against cross-box conflicts |

Freshness signals a client can rely on:

- `GET /api/v1/tasks` on a replica always reflects replica-local writes immediately (the response is built from the local store; the pushed projection only overlays rows the local store does not know). `syncedAt` still reports when the Mac's data last arrived: a stale `syncedAt` with fresh local writes means the Mac is asleep, not that the write was lost.
- The `GET /api/v1/events` feed emits `task-upsert` / `task-delete` for replica-local writes at write time (no round trip), and relays the primary's events when the bridge is up.

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
