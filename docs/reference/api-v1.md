# Walnut API v1 — Frozen REST+SSE Contract

The `/api/v1` facade is the stable, mobile-facing API surface (the iOS app's
contract). It is **frozen**: changes are additive-only — existing fields,
status codes, and SSE event names never change meaning or disappear.

- Base URL: `http://<host>:3456/api/v1` (LAN) or `https://<your-domain>/api/v1` (cloud).
- Every response carries the header `X-Walnut-API: 1`.
- All timestamps are ISO-8601 strings (UTC).

## Authentication

All endpoints require `Authorization: Bearer <token>`, with one exception: on
a primary (non-cloud) server, a request from the same machine needs none. "Same
machine" means a direct loopback connection with no proxy header
(`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, `Via`), a loopback `Host`, and either no `Origin` or the
server's own (a loopback name on the port the request arrived on). A page from
another site or another local port gets `403`. Private-network callers are not
exempt: a phone on the same Wi-Fi sends the device token its pairing QR carried.
Same policy as the rest of `/api` and the `/ws` upgrade. A reverse proxy in
front of the server must send `X-Forwarded-For`; one that adds no proxy header
looks like a local client.

Primary-mode refusals carry a `code`: `not_paired` (no credential) or
`token_refused` (a credential that is wrong, revoked, or a daemon machine token).

- **Cloud mode** (`WALNUT_CLOUD_MODE=1`): a **device token** obtained through the
  one-time claim flow. See the claim endpoints (implemented in `src/web/routes/setup.ts`):
  - `GET /api/v1/setup/status` → `{ claimed: boolean }` (public)
  - `POST /api/v1/setup/claim` `{ setupToken, deviceName }` → `{ deviceName, token }` (public, one-shot)
- **Primary mode**: a device token minted on this machine (Settings > Phones &
  Cloud, or `walnut device add <name>`) or a config.yaml `api_keys[]` entry.
  Apple Health (`/health/*`) is the exception: it takes a device token only.

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
| `session_exists` | 409 | `POST /tasks/:id/start` refused: the task already has a live session (`existing_session_id`); message it with `POST /messages` |
| `subtask_too_deep` | 409 | `POST /tasks` from a session: the new task would be its subtask more than 3 levels below a top-level task. Nothing is created |
| `too_many_running_subtasks` | 409 | `POST /tasks/:id/start` from a worker session that already has 8 subtasks running (IN_PROGRESS or starting). Nothing is started |
| `host_not_ready` | 409 | `POST /sessions` refused before anything was written: the host is connected but its Claude Code cannot run the session (`kind`: `claude_missing`, `claude_needs_node`, `claude_error`, `claude_outdated`, `claude_not_logged_in`). Extras `kind`, `host`, `headline`, `hint`, and `allowOverride: true` for the two kinds `overrideReadiness` may skip |
| `host_unreachable` | 409 | `POST /sessions`: a fresh connect attempt to the host just failed; `kind`, `headline` and `hint` describe that attempt |
| `host_off` | 409 | `POST /sessions`: remote hosts are off on this test server (never dialled) |
| `host_removed` | 409 | `POST /sessions`: the `host` alias is not an enabled host in Settings (removed, disabled, or never configured) |
| `host_reconnecting` | 503 | `GET /sessions/:id/history`, `GET /sessions/:id/changes` and `GET /sessions/list-dirs`: the host is still connecting, or did not connect within 5 s of this request starting the dial. Nothing was read. Retry in a few seconds; the dial goes on without the request |
| `task_has_no_session` | 409 | `POST /messages` named a task with nothing running; start one with `POST /tasks/:id/start` |
| `ambiguous_target` | 400 | `POST /messages` handle matched several sessions/tasks (`candidates`); use a longer id |
| `unknown_target` | 404 | `POST /messages` handle matched no session, task, or title |
| `target_archived` \| `self_send` | 409 / 400 | `POST /messages` target is archived, or resolved to the calling session itself |
| `throttled` \| `queue_full` | 429 | Peer send rate budget (`retryAfterMs`) or the target's queue cap; do not retry in a loop |
| `unknown_request` \| `not_request_target` \| `origin_session_gone` | 404 / 403 / 410 | `in_reply_to` names no request, names one addressed to another session, or the asking session is gone |
| `parent_complete` | 409 | `POST /messages` (a send or an `in_reply_to`) from a subtask's session to its parent task, which is COMPLETE: a completed parent takes no messages from its subtasks (`parentTaskId`). Reopening the parent lifts it |
| `too_large` | 413 | Note content exceeds 2 MB (or an attachment upload exceeds its cap, or a `POST /health/sync` call exceeds 500 items or 192 KB: split it) |
| `bad_audio` | 422 | `POST /stt/transcribe`: this recording is undecodable (an m4a cut off before it was finalized), so re-uploading the same bytes cannot help. Additive: an older server answers `503 stt_unavailable` for the same case, and a client that treats 4xx as a verdict about the audio simply retires the recording sooner |
| `stt_unavailable` | 503 | `POST /stt/transcribe`: the service cannot answer right now (no engine configured, engine down, the companion could not reach the primary box and has no key of its own). The recording is worth keeping and retrying |
| `primary_unreachable` | 503 | `POST /time/heartbeats` did not persist the batch: the primary could not be reached, or it was reached and its day-file write did not land. Keep the batch queued and retry; sample `id`s make the retry a no-op for anything that did land |
| `primary_unreachable` (health) | 503 | Any `/health/*` call that could not be served by the primary (bridge down, its server down, a primary that predates the action, or a sync whose SQLite transaction did not commit). Nothing was stored; keep the batch and retry |
| `store_mismatch` | 409 | `POST /health/sync` named a `storeId` the primary no longer has (the health data was deleted). Extra `storeId` is the new id: clear every sync anchor and resync from scratch under it |
| `primary_timeout` | 504 | Cloud companion only: a write it carried to the primary got no answer in time. It may have been applied there; read before trying again |
| `internal` | 500 | Unhandled server error |

**On the cloud companion**, a call is answered by the primary while the primary
answers (its bridge is up, its heartbeat is fresh, and "Cloud companion takes
over" is on), so a route marked "501 on REPLICA" below answers as it does on the
primary. Otherwise the companion answers it as described. Every reply from the
companion says which box answered in `X-Walnut-Answered-By` (`primary` or
`companion`). Streams, message sends, conversations, device identity, byte
routes, health and places data, tasks and focus, session lists and transcripts,
and session launch are always the companion's. See `docs/plan/walnut-control-plane.md`, "One request
path on the companion".

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
| GET | `/api/v1/sessions/:id/model-options` | Selectable models + current model/effort for the picker (cloud relays to the primary, except a session the cloud runs itself) |
| POST | `/api/v1/sessions/:id/model` | Switch the session's model (cloud relays to the primary, except a session the cloud runs itself) |
| POST | `/api/v1/sessions/:id/effort` | Switch the session's reasoning effort (cloud relays to the primary, except a session the cloud runs itself) |
| POST | `/api/v1/sessions/:id/fork` | Fork a session to another/new task (cloud relays to the primary) |
| POST | `/api/v1/sessions/:id/background-tasks/:taskId/stop` | Stop one background agent / command / workflow; the turn keeps running (cloud relays to the primary) |
| GET | `/api/v1/events` | SSE live feed of slim task + session updates (snapshot frame on connect) |
| GET | `/api/v1/notes` | Notes file tree |
| GET | `/api/v1/notes/content/*path` | Read a note |
| PUT | `/api/v1/notes/content/*path` | Update a note (optimistic locking) |
| POST | `/api/v1/notes` | Create a note |
| DELETE | `/api/v1/notes/*path` | Delete a note |
| GET | `/api/v1/tasks/:id` | Full task detail (description/note readback + deps) |
| DELETE | `/api/v1/tasks/:id?force=true` | Delete a task (409 on active sessions unless forced) |
| POST | `/api/v1/tasks/:id/complete` | Complete a task (auto-unpins + awaits sync push; ≠ `PATCH status:done`) |
| POST | `/api/v1/tasks/:id/start` | Start a NEW session for an existing task (cwd resolved server-side; 409 when one is already live; 501 on REPLICA) |
| POST | `/api/v1/messages` | Send a message to any session by session/task/title handle (501 on REPLICA) |
| GET | `/api/v1/requests/:id` | Status of one `expect_reply` request (`rq-…`) |
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
| POST | `/api/v1/sessions/:id/retry` | Reconnect a failed/stopped session — never sends message text (cloud relays) |
| POST | `/api/v1/sessions/:id/recheck` | Re-probe the host and reconcile the record; no message, no spawn (cloud relays) |
| POST | `/api/v1/sessions/:id/permission` | Answer a CLI tool-permission prompt (cloud relays) |
| POST | `/api/v1/sessions/:id/execute-continue` | Execute a completed plan with bypass (cloud relays) |
| GET | `/api/v1/sessions/:id/changes` | Changed-files data for the session (cloud relays) |
| GET | `/api/v1/sessions/:id/history` | Full rich-block history, tail-windowed (cloud relays) |
| GET | `/api/v1/activity/detail?ref=&part=&offset=` | The FULL text behind one `tool`/`thinking` row (cloud relays) |
| PATCH | `/api/v1/conversations/:id` | Rename/pin a Personal AI conversation |
| DELETE | `/api/v1/conversations/:id` | Delete a conversation (main is protected) |
| POST | `/api/v1/conversations/:id/stop` | Stop the agent's active turn(s) |
| POST | `/api/v1/conversations/:id/answer` | Retired: always `409 conflict` (nothing can hold a question) |
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
| GET | `/api/v1/chat/engine` | The lane session id answering a conversation (read-only; never mints) |
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
| GET | `/api/v1/notes/resolve?ref=` | One note reference (id, path, or title) → its path |
| POST | `/api/v1/notes/tags/rename` | Rename a tag across carrying notes |
| GET | `/api/v1/memory/telemetry` | Memory-entry write-path evidence |
| POST | `/api/v1/memory/daily-log/compact` | Manual extractive daily-log compaction |
| POST | `/api/v1/stt/transcribe` | Transcribe base64 audio (primary engine, or cloud relay/OpenAI fallback) |
| GET/POST | `/api/v1/stt/vocab` | Read / add custom STT vocabulary words |
| POST | `/api/v1/files/record-dir` | Record an "@"-picker folder |
| GET | `/api/v1/files/recent-dirs` | Union of session + "@"-picker recents |
| GET | `/api/v1/usage/summary\|daily\|by-source\|by-model\|by-agent\|recent\|pricing` | Usage detail breakdowns (501 on REPLICA; pricing works everywhere) |
| GET | `/api/v1/config/providers` | Provider readiness, key hints stripped |
| GET | `/api/v1/qmd/status` | Search index health, frozen path name (501 on REPLICA) |
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
| POST | `/api/v1/time/heartbeats` | Bank human time-tracking samples (a REPLICA relays them to the primary) |
| POST | `/api/v1/health/sync` | Sync one batch of Apple Health samples, buckets or deletions (a REPLICA relays it) |
| GET | `/api/v1/health/status` | Health store id, pause state, coverage, per-type freshness, supported types |
| PUT | `/api/v1/health/settings` | `paused`, `sleepSourceOrder`, `categories`, `preferredUnits` |
| DELETE | `/api/v1/health/data` | Delete health data (all, or `categories`), rotate the store id, pause |

### GET /api/v1/status

```json
{
  "mode": "LIVE",          // "LIVE" = primary instance; "REPLICA" = cloud companion
  "cloud": false,           // WALNUT_CLOUD_MODE flag
  "version": "0.2.0",
  "serverTime": "2026-07-08T12:00:00.000Z",
  "capabilities": ["asks"],  // additive, 2026-09
  "lastSyncAt": "2026-07-08T11:59:30.000Z"   // omitted when git-sync unavailable
}
```

`mode` is `REPLICA` on a cloud box today; when the reverse-WS bridge to the
primary lands (Phase 2), a bridged cloud box will report `LIVE`.

`cloudChat` (additive, 2026-09, REPLICA only): `"available"` or `"unavailable"`.
It says whether the cloud companion can answer a chat turn by itself when the
primary is provably unreachable (see "When the primary cannot be reached, the
companion may answer itself" under `POST /api/v1/conversations/:id/messages`).
`"available"` means cloud exec is on, the `claude` CLI is installed, and the chat
working folder is usable, so a TEXT turn that provably never reached the primary
is answered on the companion. A picture turn, or a relay failure that may have
reached the primary, still ends in the `error` frame either way. The value is
computed by the same check a turn runs, so it agrees with what a turn sent right
now would do. The key is absent on the primary (`LIVE`), on a replica that
predates the field, and when the replica could not work it out; treat absent as
"unknown", not as either value.

`daemonTunnel` (additive, 2026-09, REPLICA only): `{ "enabled": true }`, or
`{ "enabled": false, "reason": "..." }` with a cloud exec reason (`not_enabled`,
`no_cwd_roots`, `cwd_roots_not_absolute`) or `config_unreadable`. Its presence
says the companion serves `/daemon-tunnel`, the WebSocket the paired Mac uses to
run its own sessions on the box (see "The Mac's sessions on the companion" in
[cloud-sync.md](./cloud-sync.md)). `enabled` follows `cloud.exec.enabled`. The
Mac reads it to show its "Cloud" host: absent means the companion is too old
("Cloud companion needs an update"), `enabled: false` means hosting is turned off.

`capabilities` (additive, 2026-09): the v1 features this server offers beyond
the frozen base, by name. Absent on a server that predates the field; treat that
as an empty list. `"asks"`: this server can serve `GET /api/v1/asks`. On a
REPLICA it means the companion relays the list; it does not promise that the
primary behind it can list or launch asks (a primary that predates the list
answers `400 session_control_needs_upgrade`). Whether New chat can launch an ask
is the `launch` field of the `GET /api/v1/asks` answer, which the primary
computes itself.

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

### GET /api/v1/asks?agentId=general&q=&limit=200 (additive, 2026-09)

One agent's asks, exactly as the web console's Ask Walnut drawer lists them. The
rules live in one module (`src/core/sessions/ask-list.ts`) that the drawer imports
too, so a client renders `asks` in the order given and never sorts, filters or
retitles them itself.

```json
{
  "agentId": "general",
  "project": "Ask Walnut",
  "total": 40,
  "launch": true,
  "asks": [
    { "id": "<task id>", "title": "Garden plan", "state": "idle",
      "activityAt": "2026-09-24T20:30:00.000Z", "createdAt": "2026-09-01T09:00:00.000Z",
      "sessionId": "<session id>", "phase": "NEED_ACTION" }
  ]
}
```

- **Membership**: a task born as this agent's ask (`walnut_agent` plus its
  `agent_id` stamp; no stamp means Walnut), wherever it is filed now, or any task
  filed under the agent's `Ask <name>` project (`project` in the answer).
- **Order**: newest `activityAt` first. `activityAt` is the later of the last
  message sent into the task's session (`last_session_update`) and the task's
  birth. An edit (rename, re-file, priority) does not move a row, and neither does
  a streaming reply. Ties: newer `createdAt`, then the id by code unit.
- **Printed time**: `activityAt` is also the stamp to print ("2d ago"), so the
  times read in order down the list. A client that holds rows in place while the
  list is on screen must hold what they print too, or a row continued since reads
  "just now" under "5mo ago": the web drawer prints each held row's stamp from
  when the list appeared, marks a row that came since as "New", and shows the
  real times in the true order on the next open.
- **`title`**: the task title, or the agent's project name while the task has none.
- **`state`**: `done` (the task is complete), `running` (its session is running a
  turn), `idle` (a session is attached and not running), `todo` (no session yet).
  Treat a value you do not know as a new state, not an error.
- `sessionId` is absent while the ask has no session; `unread: true` appears only
  when set.
- `q`: every whitespace-separated word must appear in the title, any case.
  `limit` defaults to 200; a larger one, however many digits it has, is capped at
  1000, and `total` counts the matches before `limit`. A `limit` that is not a
  whole number from 1 up (`0`, `-1`, `2.5`, `abc`, empty, or given twice) is
  `400 bad_request`, and so is an `agentId` or a `q` given twice.
- `launch: true`: this answer's server launches an ask from `POST /api/v1/sessions`
  `{ "walnutAgent": true }` (the phone's New chat, see Ask launch below). The
  primary sets it, so a replica relaying the list carries the Mac's own answer. A
  primary that predates the field omits it; read absent as "no".
- Unknown or non-console agent: `404 not_found`. Malformed `agentId`: `400 bad_request`.
- Cost: the server reads only the rows that could be an ask (the stamp, or a
  project that looks like `Ask <name>`) and applies the rule above to those, so a
  request stays cheap on a board of thousands of tasks.

REPLICA: Class B relay (`server.asks`). The pushed task projection carries neither
the ask stamp nor the activity stamp nor the session ids, so the replica never
computes a list of its own. Bridge down: `503 bridge_offline`. A primary that
predates the action: `400 session_control_needs_upgrade`. A server that predates
the endpoint answers a plain `404` whose `error` is a string, not the v1 envelope.
Clients read both of those last two as "not available on this server yet" and keep
what they had; `bridge_offline` is a real, temporary answer.

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
  (one-line input summary, e.g. `"ls docs/"`) and `resultPreview` (clipped
  output) when available — clients render a collapsed
  `Bash — ls docs/` row that expands to the output.
  - **How the caps read**: every clipped field is "N characters plus a
    one-character `…`", so the longest value a client can receive is N+1.
    `detail` and a `kind:"thinking"` `text` are N=160; `inputPreview` and
    `thinkingText` are N=2000; `resultPreview` is N=700. Size a buffer for N+1.
  - `inputPreview` (additive) — the tool INPUT for the expanded card's Input
    section: `key: value` lines in the input's own order, newlines preserved,
    ≤2000+`…` chars (each value ≤1000+`…` so one fat key cannot hide the
    others), with secrets masked as `[REDACTED]`. Present when the input has
    anything renderable. This is where the real value lives when `detail` shows
    something else: `detail` for a `Bash` call prefers the human `description`,
    so the command itself is only in `inputPreview`.
  - `agent` (additive) — on a `Task`/`Agent` row, the delegated subagent's
    label, so the row can read `Task — investigate the crash · reviewer`.
  - `isError: true` (additive, 2026-10) — the call's result came back as an
    error. Absent on a call that succeeded and on an older server. A client
    folding consecutive tool rows into one `Ran 3 commands ›` line counts these
    for its `N failed` badge, the way the web console does.
  - **Row order within one assistant message** (2026-10): `kind: "thinking"`
    rows first, then the message's text row, then its `kind: "tool"` rows. That
    is the order of one API message (the model reasons, says what it is about
    to do, and the message ends at the tool calls), and it is what lets a
    client fold the tool rows that follow a text row into one line with the
    next message's calls. Before 2026-10 the text row came AFTER the tool rows;
    a client must not assume either order for data served by a server it did
    not ship with.
  - `detail`, `inputPreview` and `resultPreview` are **all redacted** by one
    rule: recognised secret shapes (API keys, bearer tokens, AWS credentials,
    `password=`/`token=` pairs, URL userinfo, private-key blocks) come through
    as `[REDACTED]`. A tool's output leaks as readily as its input, and a
    `description` a model wrote can embed a secret just as a command can, so no
    preview field is exempt. `detail`'s **shape** is unchanged (still ≤160+`…`,
    still one line, still the same input key), but the masker is a pattern
    matcher and these fields are text a human reads, so it can also rewrite
    content that merely LOOKS like a credential: a `token=`/`password=` pair
    followed by six or more credential-shaped characters is masked whether or
    not it is one, and a `-----BEGIN … PRIVATE KEY-----` marker followed by ≥40
    base64 characters truncates the preview from that point. Treat every preview
    as lossy by construction (clipped, whitespace-folded, masked) — never as a
    faithful copy of the tool's own text.
- `kind: "thinking"` — a reasoning step; `text` is a short (≤160+`…`,
  whitespace folded onto one line) excerpt. `thinkingText` (additive) carries a
  fuller ≤2000+`…` excerpt with newlines kept, for a card that expands on tap.
- `detailRef` (additive, 2026-09): an **opaque** handle on this row's FULL text,
  fetched from `GET /api/v1/activity/detail?ref=<detailRef>`. Present **only when
  the excerpts above had to cut something**, so its presence is exactly the
  client's "offer a full-text affordance" predicate: no ref means the excerpt IS
  the whole thing, and a ref means there is more. Never parse it; pass it back
  verbatim (percent-encoded as a query value). Rows read out of the chat-history
  store instead of a CLI session (legacy conversations from before the lane
  engine) carry no ref, so a drawer must always be able to render the excerpt
  alone.
- `inFlight` (additive, 2026-09): `true` on every row of the turn that is
  **still running right now**, i.e. the rows after the last `role: "user"` row
  (the user row itself never carries it). Absent otherwise, which is also what an
  older server sends, so treat "absent" as "not in flight" and never as unknown.
  Read it before concluding a turn has ended: a lane transcript includes the
  model's INTERMEDIATE text, so "an assistant row exists after my message" is not
  a finished turn, and a client that assumed it was unlocked its composer mid-turn
  and rendered a tool that had not returned yet (no `resultPreview` on it, so the
  card read "No output"). The flag is released before the terminal `message-end`
  or `error` frame is sent, so a refetch triggered by that frame is already clean.
  A cloud replica returns the primary's rows verbatim, so the field means the same
  thing on either box.
- `answeredBy` (additive, 2026-09): `"cloud"` on the assistant text row (no
  `kind`) of a turn the cloud companion answered by itself while the primary was
  unreachable, so a reloaded conversation can still label that reply. It is set
  the same way before the hand-over (the companion's own banked copy) and after
  it (the turn the primary adopted), and it never appears on the user row, on a
  `kind` row, or on a reply the primary gave. A companion turn that failed has no
  assistant row at all. Absent on older servers, so treat absent as "answered by
  the primary". It matches the `answeredBy` on the live SSE frames.
- `kind: "notification"` — a system-generated card (additive); `source` says
  which system produced it (`"session-error"`, `"agent-error"`, `"cron"`,
  `"compaction"`, …). Render as a distinct card, not a chat bubble. Noisy
  developer categories (`triage`, `session` results, `subagent` results,
  `heartbeat` all-clears) are **filtered out server-side**, matching the web
  console's default visibility. `<task-ref/>`/`<session-ref/>` XML is resolved
  to plain labels before text reaches this API.
- No `kind` — a plain chat message.
- **The `tool` and `thinking` rows ride the DEFAULT read: there is no `rich=1`
  here, and adding one would be a regression.** The session transcript
  (`/sessions/:id/transcript`) gates its expanded-card fields behind `rich=1`
  because that route is polled every few seconds and its slim shape is also what
  the sweep pushes to the cloud under a 1 MB frame cap. This route has neither
  problem: it is read on open and once per turn end, and it already builds the
  whole conversation to page it. A flag here would mean a client that did not know
  to send it sees a turn's tools while the turn runs (the SSE `tool` frames) and
  loses them the moment it ends, which is the exact defect these rows exist to
  prevent.
- **Budget the page for them: `limit` counts ROWS, not turns.** They are most of
  the rows and most of the bytes. Measured on a real tool-heavy conversation, 41 of
  a 50-row page were `tool`/`thinking` rows (9 prose messages) and they carried 72%
  of a 52.9 KB payload; two lighter conversations measured 40% and 67%. A client
  that wants N prose messages on screen has to raise `limit` or page back.
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

**Where the turn runs (cloud companion).** A chat turn is answered by the
conversation's `claude` session on the PRIMARY box, even when the phone is talking
to the cloud replica: the replica relays the turn to the primary and forwards the
primary's stream back onto this conversation's SSE channel. It has to, because a
turn needs a session runner and the `claude` CLI, and the replica has neither.
Clients need no change for this.

Image turns relay too. The bytes travel on the image lane (the same narrow
host-side save a session attachment uses), and only the resulting host paths ride
the relay call, so the picture reaches the primary's model without a multi-MB
control frame. Nothing about the request shape changes for the client.

**When the primary cannot be reached, the companion may answer itself.** If the
relay PROVABLY never reached the primary (no live bridge to it, or a primary that
predates the relay) and the companion has cloud exec enabled with the `claude` CLI
installed, the companion answers the turn with its own `claude` session. The
stream is the same frames as a relayed turn, and `message-start`, `message-end`
and `error` carry the additive `"answeredBy": "cloud"` so a client can label the
reply (for example "answered from the cloud"). Clients that ignore the field keep
working. The reply's row in `GET /conversations/:id/messages` carries the same
`"answeredBy": "cloud"`, so the label survives a reload, and `GET /api/v1/status`
reports ahead of time whether the companion can answer at all (`cloudChat`).
That session is deliberately narrow: it has no Walnut tools, no shell
and no file editing, only reads inside its own working folder and web search. It
starts from the conversation history the companion already has, which is every
turn sent from the phone or the web chat. Turns typed into a session panel on
the Mac live only in that session on the Mac, so the companion does not see them.

The companion banks each such turn outside the synced data and hands it to the
primary once the bridge is back. The primary files it into the conversation
exactly once (by `turnId`, at its original time position), and its own session
for the conversation picks the turn up on its next reply. Until then the
companion's `GET /conversations/:id/messages` merges the banked turn into its
own copy of the conversation by time, once per `turnId`, so the reply stays
visible on the phone while it waits for the hand-over. When that copy is empty
but the conversation has messages (its history lives in a Mac session), the read
answers `503 primary_unreachable` rather than a page holding only the banked
turn, because a client that replaces its rows with that page would lose the rest.

In every other failure the turn ends with the SSE `error` frame carrying
"Walnut's primary is unreachable; the replica cannot answer on its own. Try again
when the primary is back.", sometimes followed by a short reason in parentheses,
so match on the prefix rather than the whole string. That covers a relay outcome
that may have reached the primary (a timeout after sending, for instance: a turn
that might already be running there is never answered a second time), a picture
turn, a companion without cloud exec or without the CLI, and an attachment that
cannot be handed over (too large, or the primary's host refuses it). Retry once
the primary is reachable; nothing is written for a turn that was neither relayed
nor answered. A turn is never relayed with only some of its pictures.
The additive `engine` field on the terminal frame reports which engine answered
(`"claude-code"`); it is informational only.

### GET /api/v1/conversations/:id/stream (SSE)

`Content-Type: text/event-stream`. Events (each has a monotonic numeric `id:`):

| Event | Data | Meaning |
|---|---|---|
| `message-start` | `{ "turnId", "answeredBy"? }` | A turn began. `answeredBy` (additive) is `"cloud"` only when the cloud companion answers the turn itself because the primary is unreachable; absent otherwise |
| `queued` | `{ "turnId", "position" }` | Turn accepted but waiting behind another turn on the shared agent queue (additive, may precede `message-start` by minutes). Also sent after `message-start` when the turn waits for an earlier, stalled turn on the same lane (see "A turn that stalls" below) |
| `text-delta` | `{ "delta" }` | Streaming assistant text chunk |
| `tool` | `{ "name", "toolUseId"?, "detail"?, "inputPreview"? }` | The agent invoked a tool. `detail` (additive) is the same one-line input summary the message rows carry (≤160+`…`, masked), so the activity line can read `Bash · ls docs/`; `inputPreview` (additive) is the same ≤2000-char masked `key: value` render the message rows carry, so an expanded live row shows what the tool was actually called with (`detail` prefers a Bash `description`, which is why the command itself needs this field); `toolUseId` (additive) pairs this frame with its `tool-result` |
| `tool-result` | `{ "toolUseId", "resultPreview"? }` | That tool finished (additive) — clears the activity line. `resultPreview` (additive) is the same ≤700+`…` masked excerpt the message row carries, so a finished live row can show its output before the transcript lands. Still no full output on this channel: the whole text is only reachable through the row's `detailRef` read. Only sent for a `toolUseId` whose `tool` frame this turn actually delivered, so an id you never saw open is never closed |
| `thinking` | `{ "delta"? }` | The agent is reasoning. `delta` (additive, optional) is the reasoning text — coalesced into ~120 ms batches, so treat it as an append, not one whole block. Clients that ignore it and just show a spinner keep working |
| `message-end` | `{ "turnId", "fullText", "engine"?, "answeredBy"? }` | Turn finished; `fullText` = complete reply. `answeredBy` as on `message-start` |
| `error` | `{ "message", "turnId"?, "laneStillRunning"?, "engine"?, "answeredBy"? }` | Turn failed. `answeredBy` as on `message-start`. `laneStillRunning: true` (additive) marks the stall notice of a turn that is not over (see below) |
| `message-late` | `{ "turnId", "fullText" }` | Additive. A stalled turn's answer arrived; always followed by a `message-end` with the same data (see below) |

- `tool`, `tool-result` and `thinking` arrive on **every** engine (a Personal AI
  CLI lane and a coding session alike), so an activity line can
  name what the agent is doing instead of blinking "Thinking…" for minutes.
  Subagent activity is deliberately NOT relayed: a delegated agent's own tool
  calls would overwrite the `Task` row the human needs to see.
- Nothing is emitted after a turn's `message-end` / `error`, with one
  exception: the stall notice below.
- **A turn that stalls while its lane keeps running** (no stream progress for
  15 minutes, the CLI still alive) is not over. Its frames:
  1. `error` `{ "message", "turnId", "laneStillRunning": true }`, the notice. The
     turn's guard is released, so the client may send its next message; that
     turn waits for this one on the lane and says so with `queued`. No error row
     is written. While it waits, the agent's other conversations are not held
     behind it.
  2. When the answer lands (the server waits up to 60 minutes), its row is
     written under this turn's `turnId`, then `message-late`
     `{ "turnId", "fullText" }` and `message-end` with the same data. The
     second one is the ordinary end frame, so a client that ignores
     `message-late` still ends the turn and refetches `GET .../messages`, which
     now holds the row.
  3. If a later turn is running on the conversation at that moment, the server
     then sends `message-start` `{ "turnId" }` for that later turn: a client that
     does not compare turn ids reads the late `message-end` as the end of the
     turn it is streaming, and this puts it back.

  If the lane dies or goes quiet again instead, the error row is written and no
  frame is sent (the notice already told the user). A lane that went quiet again
  (or ran past the 60 minutes) may still be in that turn, so the server
  interrupts it, and a turn waiting behind it is sent only once that turn has
  ended: it gets its own answer, never the stalled turn's. If the stalled turn
  has not ended 15 minutes after the interrupt, the waiting turn ends with an
  ordinary `error` and is not sent. A phone attached to the
  cloud replica gets the same sequence: the replica keeps listening for a
  stalled turn's answer after the notice, for up to 65 minutes. A stalled turn
  the replica did not relay (it was sent to the primary directly) sends its late
  frames only to clients on the primary; a phone that has since moved to the
  replica finds the answer in `GET .../messages`.
- **The live frames and the stored rows describe the same activity**, so a
  finished turn does not lose it: a `thinking` frame becomes a `kind:"thinking"`
  row and a `tool` frame becomes a `kind:"tool"` row on
  `GET /conversations/:id/messages` (same collapsed `text`, same `detail`), because
  both are read out of the CLI session's own transcript. A client may therefore
  render the live activity with the same row component it uses for history, and
  refetch at `message-end` instead of discarding what it drew.

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
  due_date?, start_date?, wait_until?, created_at, updated_at, completed_at?,
  pinned?, unread?, tags?, summary? }` — `summary` is truncated to ~500 chars.
  `phase` is one of `TODO`, `WAITING`, `IN_PROGRESS`, `NEED_ACTION`, `COMPLETE`.
  `WAITING` was added in 0.5.2 (a task parked until something happens; its
  `status` is `todo`); a client built before it should treat an unknown phase as
  `TODO`. `wait_until` (ISO datetime) is present only on a `WAITING` task that
  has a time at which the server wakes it by itself (1 day from the move into
  `WAITING` unless the writer named a time or asked for none).
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
  "priority"?, "due_date"?, "start_date"?, "end_date"?, "description"?,
  "pinned"?, "focus_tier"?, "group_id"?, "launch_cwd"?, "launch_host"? }` → `201 { "task": ProjectedTask,
  "placement": { "project", "group_id"?, "group_label"?, "folder_created",
  "inherited_from"?, "parent_task_id"?, "cwd"?, "tier"?, "title_shortened_from"?,
  "open_subtasks"?, "more_open_subtasks"?, "warning"? } }`.
  Same creation semantics as the web quick-add: omitted/empty `project` =
  config default → Inbox; a new project name auto-creates its registry row;
  **Caller placement (additive, 2026-09-23):** when the `x-walnut-caller-sid`
  header names a session running a regular task (a "worker", not a Personal AI
  ask), an omitted `project` means THAT task's project, and a task landing in
  the caller's project joins the caller's folder, or a new folder holding both
  when the caller has none (`folder_created: true`, announced as
  `task:groups-changed`). When the caller's folder also holds work that is not
  the caller or its subtasks, the new task gets a SUBFOLDER of it instead,
  holding the caller, the new task and the caller's subtasks already filed there
  (`folder_created: true`; the event carries `parent_id`), so the folder tree
  follows the subtask tree. The task records a cwd only for the host a later
  start from the board would use (the project's default host), so a cwd never
  pairs with the wrong machine: `launch_host` / `launch_cwd` say where the
  caller is about to start it (a create-and-start client sends them); a `launch_host`
  other than the default records nothing, a `launch_cwd` alone (absolute) is
  recorded, and with neither the caller's own cwd is recorded when the caller
  runs on the default host and it is not just the project's default directory.
  Both are hints: they never change where the task is filed, and a non-worker's
  are ignored. An explicit `project` (`""` =
  Inbox) or `group_id` (`""` = no folder) always wins, and a folder never
  follows work into another project. Whatever a session files is that session's
  task's SUBTASK (`parent_task_id` = the caller's task, reported as
  `placement.parent_task_id`; the web board marks it with a Sub pill that leads
  back to the parent), wherever it lands: another project too, and from a
  Personal AI ask as well. A subtask filed into another project takes that
  project's source, not its parent's. No header or an unknown id: the old
  defaults, unchanged. A worker's new task is also born in the caller's board
  tier (pinned plus its focus tier, or unpinned) unless the body names `pinned`
  or a `focus_tier`; `placement.tier` then says which (`focus`, `satellite`,
  `wait`, a custom `ct_*` id, or `unpinned`). An ask keeps the old
  defaults for project, folder, tier and cwd (its own `Ask …` project is never a
  place for the user's work) and only adds the parent link. `placement` says
  where the task landed, because ProjectedTask carries no folder; `warning`
  appears when an inherited folder, parent or custom tier could not be applied
  (the task is still created: an inherited tier that no longer exists falls back
  to Satellite). `group_id` must be a
  folder of the resulting project: malformed, unknown, or another project's
  folder answers `400 bad_request`, as does a relative `launch_cwd`. On a
  REPLICA the caller is never a worker (it has no session registry), and a
  non-empty `group_id` answers `501 not_supported_cloud`.
  Implementation: `src/core/sessions/caller-placement.ts`.
  Depth limit (additive, 2026-09-28): a session's subtask sits at most 3 levels
  below a top-level task; a create that would go deeper answers
  `409 subtask_too_deep` and files nothing (`src/core/sessions/subtask-limits.ts`).
  Creates with no caller (the board, the phone, the CLI) are never limited.
  Team list (additive, 2026-10-01): when the new task became the caller's
  subtask, `placement.open_subtasks` lists the caller's OTHER open subtasks as
  `{ id, title, phase }`, most recently touched first, at most 10
  (`placement.more_open_subtasks` counts the rest); absent when there are none.
  A subtask owns an area, so a session filing more work sees the team it already
  leads and sends work for one of those areas there instead.
  Title brake (additive, 2026-09-30): a title over 60 characters from a session
  caller is cut to its head, the long form is stored as the description when the
  body has none, and `placement.title_shortened_from` holds what was sent
  (`src/core/sessions/task-title-brake.ts`).
  `priority` one of `immediate|important|backlog|none` (default from config).
  `start_date` / `end_date` (additive, 2026-08) let a client create a task
  already scheduled on the calendar (tapping a day, dragging a time range);
  both are ISO-8601 (`YYYY-MM-DD` or full datetime), and `""` or `null` means
  "no date" so a client can send the shape unconditionally.
  `description` is write-only: it is stored on the task but NOT returned in the
  slim ProjectedTask shape (which carries `summary`, a different field) — don't
  expect to read it back from `POST`'s response or `GET /tasks`.
  `pinned` (boolean) decides whether the task joins the pinned board; omitted
  means `true` (a task a person creates should not be invisible), and `false`
  keeps it off the board.
  `focus_tier` (additive, 2026-08-27) is which pin tier the task is BORN into,
  written in the same store write as the pin — so a client never needs a second
  request to place a new task, and a failed follow-up can never drop it out of
  the tier the user picked. Accepted values: the built-ins `focus` |
  `satellite` | `wait`, or a registered custom tier id (`ct_*`,
  from `GET /api/v1/focus/tiers`); the retired `backlog` (2026-08 to 2026-10)
  is still accepted and lands in `wait`. `""` or `null` means "not specified" so a
  client can send the shape unconditionally. Three rules to code against:
  a tier IMPLIES `pinned`, so sending only `focus_tier` still lands the task on
  the board; `satellite` normalizes to pinned with NO stored tier (the response
  omits `focus_tier` entirely, exactly like an omitted-tier create), because
  that absence is how Satellite is stored; and an unknown tier is a `400`, never
  a silent downgrade to Satellite.
  Errors: `400 bad_request` (missing title / bad priority / bad due_date /
  bad `start_date`/`end_date` / `end_date` before `start_date` / `end_date`
  with no `start_date` / non-string or unknown `focus_tier` / `focus_tier`
  together with `pinned: false`, which is a contradiction rather than a
  half-honored pair), `409 conflict` (project source conflict).
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
    replace of the task's tags; `[]` clears them; stored as key:value, see Task extras).
  - Waiting (additive, 2026-09): `phase: "WAITING"` parks the task until
    something happens; it stays in its board tier. A message into its session
    (a trigger fire, a human, a peer) moves it to `IN_PROGRESS`, and that turn
    ends as `NEED_ACTION` as usual; a session turn that merely ends, a session
    error and a sync pull do not move it (a sync pull may only complete it).
    `wait_until` (ISO datetime, a duration from now like `"6h"` / `"3d"`
    (additive, 2026-10), or `""` / `null` for no clock) rides with
    `phase: "WAITING"` or onto a task already waiting (`400` otherwise): at that
    time the server wakes the task's session with a note, or hands the task back
    as `NEED_ACTION` + `unread` when it has no session. A move into `WAITING`
    that names no `wait_until` gets one 1 day out (`DEFAULT_WAIT_DAYS`), so a
    wait is never open-ended unless asked for. Any move out of `WAITING` clears
    `wait_until`.
  - A move into `WAITING` sends no letter, whoever makes it. The wait
    receipts of 2026-10-04 (one inbox letter per park a session made, opened by
    its `wait_report`, echoed back as `wait_receipt`) were removed on
    2026-10-05: a stray `wait_report` is ignored and the response no longer
    carries `wait_receipt`.
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
- Adopt (additive, 2026-10-01): `PATCH /api/v1/tasks/:id` also accepts
  `parent_task_id` (a task id or unique prefix; `""` releases). The task becomes
  that task's subtask (a Worker pill on the board, a Leader pill on the parent);
  project and folder do not move. Errors: `404 parent_not_found`, `400` for the
  task itself or an ambiguous prefix, `409 circular_parent` when the parent is a
  descendant of the task, and for a SESSION caller (`x-walnut-caller-sid`)
  `409 subtask_too_deep` when the adopted subtree would sit below level 3 of a
  top-level task; a human is never limited. When the parent changed, the response
  adds `placement: { parent_task_id, parent_title?, previous_parent_task_id? }`,
  and the adopted task's live session is told through a Walnut notification.

### Task board (additive, 2026-10-01): `/tasks/:id/board`

One HTML document per task, written by the task's session or any task in its
subtree through the `walnut` CLI (`board_get` / `board_set` / `board_edit` /
`board_post` / `board_post_delete` / `board_project_set` / `board_remind`, skill
`walnut-board`), read by the web console's Board tab. Walnut keeps beside the
html the chat threads, the user's marks, the board's projects, the user's read
ticks and answers, reminders, and the sections the user has seen. Reads work
everywhere; writes are primary-only (`501 not_supported_cloud` on a replica).
A session caller outside the board task's subtree gets `403 not_in_team`. Item
ids (thread, mark, project, check, choice, reminder target, section) are
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` (`400 bad_id` otherwise).

A **board project** is one area of this board (one cause, one ticket); it is
not a Walnut project (a task's `project` field).

A team shares ONE board: the board owner of a task is the task itself when it
has a board, else its nearest ancestor (`parent_task_id` chain) that has one,
else the root of its tree (a broken chain with no board answers the task
itself). The `board_*` ops default to the caller's team board.

- `GET /api/v1/tasks/:id/board[?team=1]` → `200 { "board_task_id",
  "board_task_title", "board": null | { "html", "version", "updated_at",
  "updated_by" }, "threads": { [thread]: Message[] }, "marks": { [id]: Mark },
  "projects": { [id]: Project }, "checks": { [id]: CheckState }, "choices": {
  [id]: Choice }, "reminders": { [target]: Reminder }, "section_seen": { [id]:
  Seen }, "refs": { "ref", "id", "title", "phase", "status" }[] }`. Without
  `team` the board is `:id`'s own; with `team=1` it is the team board owner's,
  and `board_task_id` / `board_task_title` name it (write to that id).
  `refs` are the tasks the html names in `<walnut-task id="…">` plus the tasks
  the projects hold.
  `Message = { id, author: "user" | "task:<id>", text, ts }`,
  `Mark = { state?, note?, updated_at }`,
  `Project = { title?, status?: "decide" | "wip" | "wait" | "done", tasks?:
  fullTaskId[], updated_at, updated_by }`,
  `CheckState = { hash, read, read_at?, changed? }` for EVERY
  `<walnut-check id>` on the page now (`hash` is the current one; `read` = the
  user read this exact version; `changed: true` = read once, edited since),
  `Choice = { option, label?, at }`,
  `Reminder = { at, set_at, set_by, note?, fired_at?, delivered_at?, attempts? }`
  (due when `fired_at` is set or `at` has passed),
  `Seen = { hash, at }`.
- `GET /api/v1/tasks/:id/board/owner` → `200 { "task_id", "title", "self",
  "has_board" }`: the team board owner, by the rule above.
- `PUT /api/v1/tasks/:id/board { "html", "version"? }` → `200 { "board" }`;
  a stale `version` → `409 board_version_conflict { version }`; html over 1 MiB
  → `413 board_too_large`.
- `POST /api/v1/tasks/:id/board/edits { "edits": [{ "old", "new" }], "version"? }`
  → `200 { "board" }`. Each `old` must occur exactly once in the current html
  (`409 board_edit_not_found { index }`, `409 board_edit_not_unique { index,
  count }`); edits apply in order, all or none; no board → `404 no_board`.
- `POST /api/v1/tasks/:id/board/threads/:thread { "text" }` → `201 { "message",
  "delivery" }`. Without a caller sid the author is `user` and the text is
  delivered to the task's session the way a human `task_send` is (a stopped
  session is woken, a COMPLETE task reopens); `delivery.state` is `queued`,
  `deferred` (parked behind a permission prompt) or `stored` (no live session;
  the session reads it with `board_get`). With a caller sid the author is
  `task:<callerTaskId>` and the message is stored only. The text renders as
  light markdown on the Board tab.
- `DELETE /api/v1/tasks/:id/board/threads/:thread/messages/:message` → `200 {
  "message" }` (the removed one; a thread left empty disappears from `threads`).
  Without a caller sid (a human) any message may go; a session may delete only
  a message whose author is its own `task:<id>` (`403 not_author`). Unknown
  thread or message → `404 message_not_found`; no board → `404 no_board`; a
  malformed thread or message id → `400 bad_id`. Emits `board:changed` kind
  `thread`.
- `PUT /api/v1/tasks/:id/board/marks/:mark { "note"?, "state"? }` → `200 { "mark" }`
  (both empty removes the mark → `"mark": null`). A mark is the user's note for
  the leader; `state` is still accepted from older pages, and a write without
  it drops a stored one (a project's status is the project's, below).
- `PUT /api/v1/tasks/:id/board/projects/:project { "title"?, "status"?,
  "tasks"?, "delete"?, "override_user"? }` → `200 { "project", "delivery"? }`.
  Any team member, and the user (the pill on the page). A project records who
  last changed its status and when (`status_by`, `status_at`). A status a human
  set is delivered to the board task's session like a choice answer
  (`delivery` as for a thread post). A session's write that would change or
  remove a status a human set answers `409 status_set_by_user { project, status,
  status_at }` unless it passes `override_user: true`; a write that leaves the
  status alone (title, tasks, the same status) goes through. A partial
  update: an absent field keeps its value, `""` (or `null`) clears it; `tasks`
  is a full replacement whose entries resolve to full task ids (unknown or
  ambiguous → `400 bad_task { task }`); a bad status → `400 bad_status`; a
  project left with no title, status and tasks, or `delete: true`, is removed
  (`"project": null`). Caps: 200 projects, 200 tasks each, a 200-char title
  (`400 too_many` / `400 bad_request`). Emits `board:changed` kind `project`.
- `PUT /api/v1/tasks/:id/board/checks/:check { "read": bool, "hash"? }` → `200
  { "check": null | { "hash", "read_at" }, "hash" }`. Humans only (any caller
  sid → `403 human_only`). `read: true` needs `hash` equal to the point's
  CURRENT hash, recomputed from the html under the write lock; otherwise `409
  check_changed { check, hash }` with the current one. A check id not on the
  page → `404 check_not_found`. `read: false` removes the tick. The server is the
  only place a hash is computed (sha1, first 12 hex, of the element's inner html
  with whitespace runs collapsed), so an edit of the point brings it back unread.
  At 2000 ticks, ticks on points no longer on the page are dropped first. Emits
  kind `check`.
- `PUT /api/v1/tasks/:id/board/choices/:choice { "option"?, "text"? }` → `200 {
  "choice", "delivery" }`. Humans only. An answer is an option, the user's own
  words (`text`, trimmed, up to 8 KiB like a thread message, else `413
  answer_too_long`), or both; at least one field is required (`400
  bad_request`). Each field given replaces that part and keeps the other, `""`
  takes that part back, and an answer left with neither is cleared. The stored
  `choice` is `{ option, label?, at, text?, text_at? }`, `option: ""` when the
  user answered in words alone. `options="key:Label,key:Label"` on the
  `<walnut-choice>` element (the format of walnut-project's `labels`); an option
  not among them → `400 bad_option { options }`; a choice id not on the page →
  `404 choice_not_found`. A changed answer is delivered to the board task's
  session like a human thread message, ONE message with the choice id, the pick
  (or "picking no option") and the words quoted (`delivery` as for a thread
  post); the same answer again → `delivery: { state: "skipped", reason:
  "unchanged" }` (no second delivery); clearing → `{ "choice": null, "delivery":
  { state: "skipped", reason: "cleared" } }`. Answering clears a DUE reminder on
  that choice in the same write. Emits kind `choice`.
- `PUT /api/v1/tasks/:id/board/reminders/:target { "at": ISO-8601 | null,
  "note"? }` → `200 { "reminder" }`. Any team member. One reminder per target (a
  `<walnut-choice>` or `<walnut-thread>` id; otherwise `404 target_not_found`);
  a new one replaces it; `null` (or `""`) clears, also for a target no longer on
  the page. `at` must be in the future and at most 90 days out (`400 bad_time`).
  A server clock (primary only) fires it: sets `fired_at`, emits kind
  `reminder`, and delivers a message to the board task's session; a failed
  delivery is retried 5 minutes apart, 3 attempts in all. The user's post in
  that thread clears a DUE reminder on it in the same write. Emits kind
  `reminder`.
- `PUT /api/v1/tasks/:id/board/seen/:section { "hash" }` → `200 { "seen": null |
  { "hash", "at" } }`. Humans only. The frame hashes the section's text; the
  server only stores it (`""` forgets it). At most 500 kept; the oldest goes
  first. Emits kind `seen`.
- `DELETE /api/v1/tasks/:id/board` → `204` (humans only; `403 human_only`).
- Kanban (additive, 2026-10-04). Every board GET also carries `lanes` (stored,
  `null` = still on the template), `lanes_effective` (the lanes to draw: stored,
  or the template the team's tags pick: `triage` when any task has a `ticket:`
  or `ticket-id:` tag, else `general`), `lanes_template`, `cards` (`{ [taskId]:
  Card }`), `team` (`{ id, phase, completed_at? }[]`: the owner's direct
  subtasks, open first, at most 500, old completions included), `kanban_seen`
  (the user's baseline or `null`) and `board_version`, also when `board` is
  `null`. `?fields=kanban` answers only `board_task_id`, `board_task_title`,
  `board_version` and those kanban keys (no html). `:id` below is the board's
  OWNER. Lane and card writes never bump `version`; the first one creates the
  board file (`html: ""`, version 0) and materializes the template. A `:task`
  outside the owner's tree → `404 not_in_team`; the owner itself → `400
  owner_is_not_a_card`; an unknown lane → `409 lane_not_found { lane, lanes }`;
  over a limit → `400 bad_request { max }` (12 lanes, 40-char names, 500 cards,
  300-char summary, 80-char waiting_on). A session moving a card the user
  placed → `409 status_set_by_user { task, lane, lane_at }` unless
  `override_user: true` (its lane is kept as `lane_suggested`); a session
  rewriting lanes the user set → the same 409. `if_unchanged_since` (the `*_at`
  the editor saw, `""` = none) on lanes and card writes → `409 changed_since {
  current, at, by }` when a later write landed.
  - `PUT /api/v1/tasks/:id/board/lanes { "lanes": [{ id?, name, kind }],
    "override_user"?, "if_unchanged_since"? }` → `200 { lanes, cards_unplaced }`:
    the whole table (no id = new `ln-` + 8 hex; an old id left out is deleted
    and its cards lose their explicit lane); no done lane → `400 needs_done_lane`.
  - `PUT /api/v1/tasks/:id/board/cards/:task { "lane"?, "summary"?,
    "waiting_on"?, "override_user"?, "if_unchanged_since"? }` → `200 { card,
    lane_effective }` (`""` clears a field; lane `""` = automatic placement).
  - `POST /api/v1/tasks/:id/board/cards/:task/move { "lane", "order": [ids],
    "rank_only"? }` → `200 { card, order }`: the explicit lane (not with
    `rank_only`) and the lane's order (ids not shown in that lane are ignored;
    a done lane keeps none).
  - `POST /api/v1/tasks/:id/board/cards { "title", "lane"?, "tags"? }` → `201 {
    task, card }`: a subtask of the owner in its project and folder, no session;
    a failed placement still answers 201 with `card: null, warning:
    "placement_failed"`. Humans only (`403 human_only`): a session files work
    with `task_create`, which places it and applies the subtask limits.
  - `POST /api/v1/tasks/:id/board/cards/:task/suggestion { "action": "accept" |
    "dismiss" }` → `200 { card, lane_effective }` (humans only; no suggestion →
    `404 no_suggestion`).
  - `PUT /api/v1/tasks/:id/board/kanban-seen { "cards"?: ids | "all",
    "snapshot"?: { [taskId]: { lane, summaryHash, outputAt?, unread? } },
    "visit_end"? }` → `200 { kanban_seen }` (humans only): snapshot entries win,
    listed ids without one are computed by the server; `"all"` or `visit_end`
    moves `at` to `previous_at`.
- Live: the console's WebSocket carries `board:changed { taskId, kind: "html" |
  "thread" | "mark" | "project" | "check" | "choice" | "reminder" | "seen" |
  "deleted" | "lanes" | "card", task?, kanban?, thread?, mark?, project?, check?,
  choice?, reminder?, section?, version }` with `taskId` at the top level
  (`task` = the card's task; `kanban: true` on a kanban seen write).

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
  instead of a silent `200`. Open subtasks never block it (since 2026-10-04;
  before that it answered `409 conflict` + `active_children`): they are not
  touched and keep running, and the body adds `open_subtasks`, up to 20
  `{ id, title, phase }` rows (`more_open_subtasks` counts the rest), only when
  there are any. A COMPLETE parent hears nothing more from them, and a
  subtask's own `POST /messages` to it answers `409 parent_complete`. Added
  for the CLI's `open-walnut done`, which has always had these semantics.
- `POST /api/v1/tasks/:id/start` (additive, 2026-08) body
  `{ "message"?, "cwd"?, "host"?, "model"?, "mode"?, "engine"?,
  "expect_reply"?: bool, "reply_timeout"?: number }` →
  `202 { "taskId", "title", "sessionId"?, "requestId"? }`: start a NEW
  session for an EXISTING task and send it the first message (the
  `session_start` op). Distinct from `POST /api/v1/sessions`, whose body
  requires an absolute `cwd`: this one names only a task and lets the
  session-runner resolve cwd from the task/project chain (`task.cwd` → parent
  chain → project `default_cwd` → project memory dir). `sessionId` is
  preassigned for the `claude` engine, so it comes back in this response;
  `codex` sessions derive their own id from the ACP adapter and answer without
  one. A task that already has a live (`running`/`idle`) session answers
  `409 session_exists` with `existing_session_id` as a TOP-LEVEL sibling of
  `error` (`{ "error": {...}, "existing_session_id": "..." }`): talk to it with
  `POST /api/v1/messages` instead of opening a second one. `expect_reply: true`
  registers a reply request against the caller session
  (`x-walnut-caller-sid`) and returns its `requestId`. When that caller is a
  worker session and the task belongs to its project, has no cwd of its own and
  the body names neither `cwd` nor `host`, the session starts on the caller's
  host in the caller's cwd, as one pair (additive, 2026-09-23). A worker caller
  that already has 8 subtasks running (IN_PROGRESS or starting, the task being
  started excluded) answers `409 too_many_running_subtasks` and nothing starts
  (additive, 2026-09-28); the human and a Personal AI ask are never limited.
  `202` means ACCEPTED,
  not spawned (the spawn is async in session-runner), same as `POST /sessions`.
  Class C: `501 not_supported_cloud` on a REPLICA (no session-runner there);
  use `POST /api/v1/sessions`, which relays over the bridge.
  Added for the CLI's `open-walnut start <task_id>`.
  **Breaking, 2026-08**: the old `{ "resume", "prompt" }` body and the
  `{ "action", "resume_missed" }` response fields are GONE. `resume` is not a
  start mode any more: sending into a live session is `POST /api/v1/messages`
  with the task id as `to`, which resolves the task's session itself.
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
    "custom_tier_tasks": { "<ct_id>": [ids] } }`. `backlog_tasks` is always
    `[]` since the Backlog tier was retired (2026-10, its rows moved to
    `wait`); the key stays so an older client keeps decoding.
  - `POST /api/v1/focus/tasks/:id` → `200 { "pinned_tasks" }` (idempotent;
    pinning a completed task → `409 conflict`).
  - `DELETE /api/v1/focus/tasks/:id` → `200 { "pinned_tasks" }` (idempotent).
  - `PUT /api/v1/focus/reorder` body `{ "task_ids" }` → the FULL `TierResult`
    (never a pinned-only payload — clients apply it as a lossless snapshot).
  - `PUT /api/v1/focus/tasks/:id/tier` body `{ "tier" }` → `TierResult`.
    `tier` ∈ `focus|satellite|wait` or a registered `ct_*` id (the retired
    `backlog` is accepted and lands in `wait`); anything else →
    `400 bad_request`.
  - `GET /api/v1/focus/tiers` → `{ "tiers": [ { "id": "ct_…", "label" } ] }`.
- Board order (additive, 2026-09). A client that draws a pinned tier must
  draw it in the console's order, which is ONE rule:
  `web/src/utils/pinned-tier-order.ts` (`orderPinnedTier`), twinned on iOS by
  `ios-native/Walnut/Views/Tasks/PinnedTierOrder.swift` and pinned for both by
  the shared fixture `tests/fixtures/pinned-tier-order/`. Its inputs are all
  server-side:
  - the tier's rows in the `TierResult` order (`pin_order` ascending),
    completed rows left out;
  - the tier's view mode (`project` = By project, `custom` = Custom order);
  - `projects` from `GET /api/v1/ordering`;
  - each row's folder, from the `member_ids` of `GET /api/v1/tasks/groups`.

  `custom` keeps pin order and gathers each folder at its first member.
  `project` groups the rows by project (the projects named in `ordering`
  first, in that order and case-insensitively, then the others where their
  first row appears), loose rows ahead of folder blocks. A new pin gets the
  highest `pin_order`, so it lands at the FOOT of its group. Date and search
  filters hide rows afterwards and never reorder what stays. A client that
  shows completed rows (iOS `show done`) still orders the open rows without
  them, draws each completed row in its pin place inside its own group, and
  puts a group that only completed rows have after the others.

### Sessions (read-only)

- `GET /api/v1/me` (additive, 2026-09-23) → who the `x-walnut-caller-sid`
  caller is and where it stands: `{ "kind": "human" }` (no header),
  `{ "kind": "external" }` (an id Walnut does not know), `{ "kind": "unknown" }`
  (a replica, which has no session registry), `{ "kind": "untracked", "session" }`
  (a session with no task), or `{ "kind": "ask" | "worker", "task": { id, title,
  project, group_id?, group_label? }, "session": { id, host, cwd? } }`. `ask` is a
  Personal AI conversation; only `worker` is placed from. Cheap by design (one
  registry lookup and one task read, no projection export), so an agent-facing
  list can ask it before every query.
  The `task_list` op does exactly that to apply its default folder ring.
- `GET /api/v1/me/open` (additive, 2026-09-30) → what is still open for the
  calling session's task: `{ "task"?: { id, title }, "subtasks": [{ id, title,
  phase }], "moreSubtasks", "waitingOn": [{ id, to, preview, createdAt }],
  "askedOfYou": [{ id, from, preview, createdAt }], "text" }`. Unfinished direct
  subtasks (at most 20, the rest counted), the session's reply requests still
  pending and the requests to it that it has not answered (at most 10 each).
  `text` is the short block the session reads right after a compaction, through
  the CLI's SessionStart hook (the `open_items` op in hook mode); `''` when
  nothing is open. A caller with no task gets empty lists and `''`.
- `GET /api/v1/sessions?status=running|idle|stopped|error&scope=folder|project|all` →
  `{ "sessions": [ProjectedSession], "you"?: ProjectedSession, "scope": "folder|project|all", "syncedAt": "<ISO>" }`
- `ProjectedSession`: `{ id, title?, task_id?, task_title?,
  project?, group_id?, group_label?, host, process_status, model?, mode?, started_at, last_active_at,
  message_count, cwd?, pinned?, focus_tier?, description? }` — `host` is `""`
  for sessions on the primary box, otherwise the host alias; `pinned` /
  `focus_tier` mirror the owning task's pin state at export time;
  `description` is truncated to ~300 chars; `group_id` / `group_label`
  (additive 2026-09) are the local-only FOLDER the owning task sits in, and a
  nested folder contributes its own label rather than the ancestor chain.
- `scope` + `you` (additive 2026-09) answer "which sessions are near me", for an
  agent that has to find the session it should message. The caller is identified
  by the `x-walnut-caller-sid` header (the same provenance header
  `POST /api/v1/messages` reads, set by the ops executor from
  `WALNUT_SESSION_ID`): when it resolves to a session, `you` is that session's
  own row, so a caller learns its own handle, project and folder in the same
  trip. `scope=folder` keeps the rows whose task sits in the caller's folder,
  `scope=project` the rows in its project, and `all` (the default, so every
  existing client is untouched) keeps everything. A caller with no folder gets
  the project ring instead of an empty list, and the response's `scope` is the
  ring actually applied, not the one asked for. A narrowing scope with no
  recognised session caller answers `400 bad_request` rather than a silently
  unfiltered list; an unknown scope word answers `400` too. The `status` filter
  composes with any scope, and `you` is resolved before it, so a status the
  caller itself does not match never erases the caller's own row.
- `focus_tier` values: `"focus"`, `"wait"`, a custom tier id (`ct_` + 8
  alphanumerics — user-defined tiers, added 2026-08), or absent (= Satellite,
  the default bucket). `"backlog"` (built-in 2026-08 to 2026-10) is never
  served any more: the server reads and writes it as `"wait"`. Clients that
  only understand the built-ins should treat any unrecognized value as
  Satellite.
- Scope: all live sessions + sessions stopped in the last 14 days, newest
  first, capped at 500. System sessions (triage/cron/hooks) and archived
  sessions are excluded. Lane-bound sessions (2026-08) — ones that back a
  persistent UI conversation surface rather than a user-launched session — are
  also excluded; no row shape changed, the list just never contains them.
- Provenance/laggy-replica semantics identical to `/tasks` (`syncedAt`,
  `503 unavailable` on a fresh companion).
- `GET /api/v1/sessions/:id/transcript?fresh=1&rich=1` →
  `{ "sessionId", "exportedAt", "truncated", "rich"?, "messages": [ { role, text,
  timestamp, kind?, detail?, resultPreview?, agent?, isError?, inputPreview?,
  thinkingText?, detailRef? } ] }`: a slim transcript tail (last ~100 entries; text
  capped at 4 KB/row, or 12 KB for a row that
  carries HTML, and the cut is made where it cannot leave half a tag behind so a
  rich reply is never truncated mid-attribute; `kind: "tool"` rows carry
  the tool name, plus additive `detail` (input summary) / `resultPreview`
  (clipped output) when available, and `kind: "thinking"` rows carry a
  one-line reasoning excerpt of ≤160+`…` chars). The heavier expanded-card fields
  (`inputPreview`, `thinkingText`) are OFF by default on this tail: it is pushed to
  the cloud companion under a 1 MB frame cap and polled while a session view is
  open, so it stays small. Ask for them with `rich=1` (below); they also ride
  `GET /api/v1/conversations/:id/messages`, which reads the same transcript
  unclipped. `agent` (additive, 2026-08) appears on
  `Task`/`Agent` tool rows and names the delegated subagent (team agent name,
  the tool input's `name`, or its `subagent_type`) — render it as a badge on
  the delegation row; the subagent's own transcript is not inlined. `isError:
  true` (additive, 2026-10) marks a tool row whose result came back as an error,
  on the slim tail too (a folded `Ran 3 commands · 1 failed` line needs it
  before any card is expanded). Rows of one message come as thinking, then the
  text, then the tool calls (see the `/conversations/:id/messages` notes on
  row order). The primary
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
- `rich=1` (additive, 2026-09): add the two expanded-card fields to the rows
  that can carry them. `kind: "tool"` rows gain `inputPreview` (the tool's INPUT
  rendered as `key: value` lines, ≤2000+`…` chars, secret-looking values masked;
  `detail` stays the collapsed ≤160 one-liner) and `kind: "thinking"` rows gain
  `thinkingText` (a fuller reasoning excerpt, ≤2000+`…` chars, newlines kept,
  clipped from the START of the block; `text` stays the collapsed ≤160 line).
  Nothing else about the response changes: same ~100-entry tail, same 4 KB row
  clip, same `truncated`. Parsed like `fresh`: **only the exact value `1` counts**,
  anything else (`rich=true`, `rich=0`, a bare `rich`) reads as absent.
  `kind: "tool"`/`kind: "thinking"` rows also gain `detailRef` when their excerpt
  had to cut something: it is the handle for `GET /api/v1/activity/detail` (below),
  so a drawer can show the whole reasoning block or tool output without this tail
  carrying it. Three things to know before wiring a client to it:
  - **A rich request is never answered with slim rows** (fixed 2026-09). On the
    primary, `rich=1` implies the same live read `fresh=1` asks for, because the
    sweep-exported file is written in the slim shape and can never carry the
    fields. Before the fix, `?rich=1` was answered from that file whenever it
    existed, so the SAME URL returned rich or slim rows depending on cache warmth
    (measured on a live box: 0 of 102 rows with `thinkingText` vs 39 of 106 with
    `fresh=1` added). The response now also carries **`rich: true|false`** on any
    request that asked for it, so the two cases that genuinely cannot produce the
    fields (a session whose history is unreadable, and a cloud replica) say so
    instead of looking empty. One thing that did NOT change: a plain read (no
    `rich`) still serves the exported file, and a rich request whose live build
    comes back empty still falls back to it. The file is the archive for a stopped
    session, and a rich request must not cost a caller the archive.
  - **Pairing it with `fresh=1` is still right.** They now mean the same thing on
    this box, so `fresh=1&rich=1` costs nothing extra, and a client that keeps its
    fast cached first phase (plain read, no `rich`) keeps it.
  - **Cost, so you can choose a cadence.** Measured on a 50-row page: raw p90
    36.8 → 54.3 KB, gzipped p90 13.8 → 17.8 KB, i.e. about +4 KB gzipped per
    read. Fine at open/foreground/turn-end cadence (tens of reads per session);
    if a client falls back to polling this every few seconds, that is ~48 KB/min
    over cellular, and dropping `rich` from the polling path alone is the
    reasonable answer. Server side it is cheap and reads nothing extra: the box
    does the same single transcript read either way, and the added work is row
    formatting only (measured +1.0 ms p50 on a normal session, +1.4 ms on a
    worst case where every field maxes its 2000-char cap, and below the noise
    floor on a session whose transcript is over 4 MB).
  - **Not on a cloud companion.** A replica has no session on disk: without
    `fresh` it serves the synced slim file, and with `fresh=1` it builds over
    the daemon bridge, which is a separate parser that emits no `thinking` rows
    at all and no `inputPreview`. `rich=1` is accepted there and answers
    `rich: false`.
- Paging (additive, 2026-10): `visible=<n>`, `before=<ISO timestamp>` and
  `since=<ISO timestamp>`. On a busy
  session the ~100-entry tail is almost all tool rows, so a client that folds a
  turn's tool calls into one line showed a few lines and nothing above them.
  - `visible=<n>` extends the slice back until it holds `n` rows a reader sees as
    text (a user message that is not injected, or assistant prose). It never
    returns fewer than the default tail and never more than 600 history entries;
    `n` above 200 counts as 200. Any value that is not a positive integer is
    ignored, not rejected.
  - `before=<ISO timestamp>` answers the page of rows strictly OLDER than that
    time, typically the `timestamp` of the oldest row the client holds. It
    combines with `visible`. `truncated: false` on that page means it reaches the
    start of the conversation. A page that begins inside a bounded read window
    (a transcript over 4 MB) is completed from a full read, and a transcript too
    large for the full read (over 32 MB) is read in 4 MB windows instead, so a
    whale pages all the way to its first message; one page reads at most four
    windows. A value that is not an ISO-8601 timestamp
    (`YYYY-MM-DDTHH:MM…`), or is longer than 40 characters, answers
    `400 invalid_before`; a read that fails
    answers `503 page_unavailable` (retryable).
  - `since=<ISO timestamp>` extends the slice back to the first entry at or after
    that time, typically the newest row the client holds, within the same
    600-entry bound. Send it on a refetch you will stitch onto rows you already
    have: a turn longer than the default tail pushes its own start out of a
    plain tail, and keeping "the rows older than the new tail" then leaves that
    turn's head as a hole. If the answer still does not reach back to your
    newest row, replace what you hold instead of stitching. A malformed value
    answers `400 invalid_since`.
  - A rich answer built live on the primary carries **`pageable: true`**, beside
    `rich`. That is the signal a client may ask for older pages; without it (an
    older server, a rich answer served from the exported file or from a cloud
    companion's own copy) show no "load earlier" control. A `before` read is
    never answered from the exported file, which holds the newest tail.
  - A cloud companion relays a rich or `before` read to the primary and answers
    with the primary's page, `pageable: true` included. When the primary cannot
    be reached, a newest read falls back to the companion's bridge tail or synced
    file (`rich: false`, no `pageable`; a client keeps whatever paging state it
    had), and `before` answers `503 page_unavailable` (retryable). An older
    companion answers `before` with `409 page_unavailable`.

### GET /api/v1/activity/detail (additive, 2026-09): the full text behind one row

The `kind: "tool"` and `kind: "thinking"` rows on both list reads carry
EXCERPTS, and they stay excerpts: they ride a ~100-row page a client refetches
at every turn end, where inlining whole reasoning blocks measured ~150 KB per
read. This endpoint is how a drawer shows the rest: one row, on the tap that
asks for it.

```
GET /api/v1/activity/detail?ref=<detailRef>[&part=reasoning|input|result][&offset=<n>]
```

- `ref` (required): the row's `detailRef`, verbatim and percent-encoded. It is
  **opaque**: it names a session, a message id and the slot inside that message,
  and that is deliberately not a row position (this tail slides, and the chat
  read's `m<n>` ids are its paging cursor space). No `agentId`, `sessionId` or
  conversation id is needed, which is what lets one endpoint serve both surfaces.

**The ref's stability contract**, because a client has to know when to stop trusting
one:

- It is derived from the CLI's own ids: the message id (the API `message.id`, else
  the JSONL line `uuid`, both written once and never rewritten) plus the slot inside
  that message (the reasoning, or the n-th tool call, in the order the message's
  content blocks are stored). Nothing positional, so appending turns, paging, or
  re-reading the same transcript never moves it.
- Only the PRIMARY mints refs and only the primary resolves them; a replica passes
  them through in both directions. So a row read on the LAN and tapped later through
  the cloud (or the reverse) resolves against the same box either way.
- What invalidates one: a rewind that deletes the message, a compaction that rewrites
  it, and a transcript so large (>4 MB) that the bounded read window no longer
  contains the message. A session that no longer exists does too.
- When a ref cannot be resolved the answer is **`410` with `code: "detail_gone"`**,
  and this route never answers `404`. That is the point: a `404` here means the
  server has no such route (a box older than this feature), and the two need
  different client behaviour: hide the affordance entirely, versus tell the user the
  text is no longer in the transcript. Never treat one as the other.
- `200` →

```json
{
  "version": 1,
  "kind": "thinking",
  "text": "…the whole reasoning block…",
  "textChars": 4380,
  "offset": 0,
  "truncated": false
}
```

  and for a tool row:

```json
{
  "version": 1,
  "kind": "tool",
  "toolName": "Bash",
  "input": "command: deploy --stage prod …\ndescription: Deploy",
  "inputChars": 4021,
  "result": "…the tool's output…",
  "resultChars": 3187,
  "offset": 0,
  "truncated": false
}
```

- One request returns every section the row has: `text` for a reasoning row,
  `input` and `result` (either may be absent) for a tool row.
- **`<name>Chars` is measured on the text as DELIVERED, after redaction.** Every count
  and offset on this route is in **UTF-16 code units** (what `String.prototype.length`
  and Swift's `String.utf16.count` return), never graphemes and never bytes, so a
  client must compare in that unit: a grapheme count (Swift's `String.count`) reads a
  COMPLETE section as clipped as soon as the text carries emoji or CRLF line endings.
  For a section that is not truncated it equals the length of the string in the same
  response exactly, so "showing the first N of M" has N === M and never promises
  characters that do not exist. (Redaction shrinks: `AKIA…` becomes `[REDACTED]`. A
  source-based count made a complete 6,838-character result claim 6,999 and a drawer
  offered 161 characters that no request could return.) For a section that IS
  truncated the number is the source-based estimate of the whole, because the
  remainder has not been redacted yet and so has no delivered length, so act on the
  truncation flag, never on arithmetic over this number.
- **Each section says whether it fell short: `textTruncated` / `inputTruncated` /
  `resultTruncated`** (additive; present only when `true`, absent means the section is
  whole). Read these, not the numbers: a section is incomplete whenever it carries
  less than the row's text, INCLUDING when no `<name>NextOffset` is offered because
  the remainder cannot be fetched at all, and including the one case arithmetic cannot
  see (a clipped `input`, whose `inputChars` is a lower bound and can equal the text
  it came with). A cursor, in turn, is only ever offered when asking for it would
  advance, so chasing `<name>NextOffset` can never loop.
- `truncated` (top level) is the OR of those flags: useful for "is anything missing
  here", useless for labelling a section, since it cannot say which one. It is kept
  because it shipped first.
- **Redaction is unchanged at full length.** Every section passes the same masker
  the previews use, so a credential sitting past the 700-character
  `resultPreview` (one the excerpt never even reached) still arrives as
  `[REDACTED]`. The drawer is not a raw dump.
- **Ceilings, stated plainly.** One response returns at most 200,000 characters
  per section; a longer section sets `<name>NextOffset` (and `truncated: true`),
  and the rest is fetched with `part=<that section>&offset=<that number>`.
  Offsets count SOURCE characters (positions before redaction, not indices into the
  delivered string), so pages join back with nothing dropped at the seam. `offset` and
  every `<name>NextOffset` count in those same UTF-16 code units and always land on a
  character boundary, so no page begins or ends inside an emoji (a cursor is never
  adjusted; an `offset` a caller invented mid-character moves forward to the next
  boundary). `offset` without `part` is a `400` (the same number means a different
  place in a tool's input than in its result). This 200,000 is the ONLY ceiling on a section: a long tool result
  reads to its end here, by re-reading that one row from the transcript, even though the
  row a LIST read carries keeps just the first 5,000 characters of it (a whole-transcript
  parse holds every row's result at once, which is a bound worth having there and
  pointless for one row). In the rare case where that re-read cannot happen (the message
  has slid out of a large transcript's bounded window, its host is unreachable, or the
  session's transcript is served from a stream snapshot rather than the canonical JSONL),
  the answer degrades to the retained prefix with `resultTruncated: true`, the true
  `resultChars`, and **no cursor**, because the rest genuinely cannot be fetched and a
  cursor there would advertise a page that answers with an empty string.
- Errors, all of which mean "keep showing the excerpt":
  - `400 bad_request`: a ref this server did not mint, an unknown `part`, or a
    bad/ambiguous `offset`.
  - `410 detail_gone`: the row can no longer be resolved (see the stability
    contract above). Terminal for that ref; never a neighbouring row's text.
  - `503 unavailable`: the transcript could not be read, because it timed out (10 s
    budget), the read failed outright (an unknown or unreachable host), or a replica's
    primary is offline. Retryable, and the only 5xx this route produces, because a read failure
    is a reachability fact about one session, not a fault of the server.
  - `404`: **not** produced by this route. It means the server predates the
    feature, in which case rows carry no `detailRef` either.
- A cloud companion CAN serve this route: it relays the read to the primary, which
  owns the transcript, as the box-level control action `server.activity.detail`
  (host `__local__`, sessionId `__server__`), and hands the primary's body back
  unchanged. A replica never resolves a ref locally, because it has neither the
  session record nor the JSONL. An offline bridge, and a primary too old to know the
  action, both answer `503`.

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
  - `404 not_found`: unknown session. On a replica that verdict belongs to the PRIMARY (the companion asks it over the `detail` relay for any session its bounded synced list does not carry), so a primary the companion cannot reach answers `503 bridge_offline` (retryable, same as any other unreachable hop) and never `404`; the same rule covers the session stream and the `fresh=1` transcript read.
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
    session's host (cloud only), for a send the replica could not bank (an
    image send). Retry with the same `messageId`; keep the composer enabled.
    A text send made while the bridge is down is banked instead:
    `202 { "messageId", "queued": true }`, delivered when the bridge returns.
    A `queued` 202 is therefore not proof the bridge is up.
- `GET /api/v1/sessions/:id/stream` — SSE (same framing as conversation
  streams: monotonic `id:`, `Last-Event-ID` replay, `:` pings). Events:
  - `snapshot { blocks, isStreaming, completedLen, processStatus }` — sent
    once on attach (primary box only; carries no id).
  - `turn-start {}` — a new turn began (resets the replay window). Only a
    turn's own start sends it: a status write the snapshot gate held back, or
    one replayed after a reconnect, never does, so a turn-end is not wiped by
    a stale `running` echo (2026-10).
  - `text-delta { delta }` / `thinking { delta }` — main-lane streaming text.
  - `tool { name, toolUseId, detail?, inputPreview? }` /
    `tool-result { toolUseId, resultPreview? }` — `detail` (additive) is the
    one-line input summary; `inputPreview` (≤2000 chars) and `resultPreview`
    (≤700 chars + `…`) are additive, masked excerpts, the same ones the
    message rows carry. The full text stays off this channel.
  - `status { processStatus }` — running | idle | stopped | error. Sent in
    status-revision order: a status older than one already sent on this
    stream is dropped, the rule the web console applies by `statusRevision`.
  - `turn-end {}` — refetch the transcript here to reconcile.
  - `error { message }`
  - `bridge-online {}` / `bridge-offline {}` (cloud only) — sent on attach
    (id-less) and whenever the daemon bridge for this session's host comes or
    goes (with an id, into the replay ring). A bridge redial takes about 1.3 s,
    so a client should show an outage only after continuous absence (the iOS
    page shows a "Reconnecting…" chip and starts `fresh=1` polling after 3 s,
    and a banner after 10 s) and never lock the composer for it.
  - Replay: the cloud replica's ring is never reset at a turn start (up to 512
    frames of turn-ends and bridge pairs), and a connect without
    `Last-Event-ID` replays all of it. Clients must resume with the newest
    applied id, must not re-apply a frame at or below it, and must coalesce
    the transcript refetches that `turn-end` / `bridge-online` trigger.
  - `404 not_found` on servers without this endpoint — fall back to polling.
- `/api/v1/status` additive field (cloud only):
  `bridgeHosts: [ { hostAlias, since } ]` — hosts with a live daemon bridge.
  A session is talkable when its `ProjectedSession.host` (`""` maps to the
  primary's local daemon `__local__`) has an entry here.

### Session messaging by handle (additive, 2026-08): `/messages` + `/requests/:id`

The agent-facing send surface, backing the `session_send` and `request_get`
operations. Distinct from `POST /api/v1/sessions/:id/messages` above, which is
the phone's per-session composer and needs an exact session id: this one
resolves a HANDLE, fences a session caller's words, and carries the reply
ledger. Both end up in the same persistent message queue.

- `POST /api/v1/messages` body
  `{ "to"?, "text", "expect_reply"?: bool, "reply_timeout"?: number,
  "in_reply_to"?, "messageId"? }` →
  `202 { "delivery", "targetSessionId", "targetTitle", "targetTaskId"?,
  "requestId"?, "repliedTo"?, "messageId"? }`.
  - `to` resolves in this order: exact session id, then a task id or unique
    task-id prefix (routing to that task's session), then a unique session-id
    prefix of 4 characters or more, then a unique case-insensitive title
    substring. A handle that matches both a task and a session at the same
    stage is ambiguous on purpose.
  - `delivery` is `queued` normally, or `deferred` when the target is parked on
    a human permission prompt: the message is enqueued WITHOUT dispatch and
    rides the next natural drain, so a send never answers someone's pending
    prompt. One exception: a message from the target's leader (the session of
    its parent task) to a target waiting on an `AskUserQuestion` is dispatched
    at once and closes the question, because a worker's questions are its
    leader's to answer.
  - The caller is stamped from the `x-walnut-caller-sid` header (provenance:
    who sent it). A session caller's text is delivered inside a fenced,
    labeled peer note, which the receiver treats as the user's request (every
    task works for the same user), and is rate limited per sender with a queue cap; the
    human's own CLI (no caller sid) sends plain text with no throttle.
  - `expect_reply: true` registers a reply request and returns its `requestId`
    (`rq-…`), and the delivered message gets a Walnut trailer naming the exact
    answer command. Session callers only: without a caller session there is
    nowhere to route the answer (`400 bad_request`). `reply_timeout` is in
    seconds, clamped to 60..86400, default 3600.
  - `in_reply_to: "rq-…"` IS the answer: `to` may be omitted because the
    request routes it back to the asker. Only the session the request was
    addressed to may close it (`403 not_request_target`); an unknown id is
    `404 unknown_request`. A reply that arrives after Walnut already notified
    the asker is still delivered, marked late.
  - `messageId` (`qm-…`) is the same idempotency id the per-session send takes.
  - Errors: `400 bad_request` (empty `text`, missing `to`, `expect_reply`
    without a session caller), `400 ambiguous_target` (with up to 5
    `candidates`), `404 unknown_target`, `409 task_has_no_session` (start one
    with `POST /tasks/:id/start`), `409 target_archived`, `400 self_send`,
    `429 throttled` (with `retryAfterMs`) or `429 queue_full`,
    `410 origin_session_gone` (the asking session is gone),
    `501 not_supported_cloud` on a REPLICA (sends need the primary's
    session-runner and daemons).
- `GET /api/v1/requests/:id` → `200 { "request": { "id", "fromSessionId",
  "toSessionId"?, "toTaskId"?, "preview", "status", "createdAt", "deadlineAt",
  "settledAt"?, "outcome"? } }`. `status` is `pending` | `replied` |
  `notified` | `expired` | `withdrawn` (since 2026-10-04: the asker's task
  completed, nobody was told, and reopening that task makes it `pending`
  again); `outcome` on a settled row is `completed` | `error` |
  `awaiting_human` | `timeout`. Malformed id is `400 bad_request`, unknown id
  `404 not_found`. This is a status read for `walnut wait rq-…`, not something
  a client should poll: replies and the fallback notification are pushed into
  the asking session on their own.

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
  - A momentary missing bridge is not treated as an answer (additive,
    2026-09). When the relay finds no socket at all and the cloud box saw the
    link drop within the last 30 seconds, it waits up to 8 seconds for the
    primary's daemon to redial and then retries the relay exactly once, so a
    routine teardown (measured at 1 to 3 seconds) produces a normal `201`
    instead of a failure. Only that one failure is retried: "no socket"
    proves the primary never saw the request, so the retry cannot create a
    duplicate session. A relay timeout, a transport error mid flight, or any
    non-ok reply from the primary is reported as it is, because the launch
    may already have run there.
  - A longer outage is answered immediately, with no wait: a primary that has
    been unreachable for minutes (a laptop asleep with its lid shut) is not
    mid-redial, and spending the budget would only delay the same answer. The
    code stays `503 bridge_offline` (frozen), and only the human message
    changes: it names how long the primary has been unreachable when the
    cloud box knows (for example "has been unreachable for 41 minutes. It may
    be asleep (open the lid) or offline."), which is what tells a user that a
    sleeping laptop, not a momentary blip, is the problem. A cloud box that
    just restarted has no such duration, keeps the plain wording rather than
    inventing one, and does not wait either. The message never claims a wait
    that did not happen.
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
  "model"?, "mode"?, "overrideReadiness"? }` → `201 { "sessionId", "taskId", "title" }`
  - `cwd` (required): absolute working path on the chosen host (must start
    with `/`; relative paths are `400 bad_request`).
  - `host`: `""`/absent = the primary box; otherwise an enabled alias from
    `launch-options` (unknown/disabled → `409 host_removed`, the same answer
    the web Start gives; servers before 2026-09 answered `400 bad_request`).
  - `message`: optional first turn; empty/absent spawns the CLI idle.
  - `taskId`: link the session to an existing task instead of creating one
    (unknown id → `404 not_found`); the task keeps its board tier. Absent: a
    task is created and auto-organized, exactly like a web draft launch, and
    born pinned in **Focus** (the web draft's default; servers before
    2026-10-03 filed it in Satellite). The body carries no tier: the page
    shows no tier control, so the tier is moved later on the board.
  - `model` / `mode`: same accepted values as the web quick-start route
    (`bypass`/`accept`/`default`/`plan`; alias or catalog model ids).
  - Remote host gate (additive, 2026-09): a launch on a host that cannot run
    a session is refused BEFORE any task or session is written, with
    `409 { "error": { "code", "message" }, "kind"?, "host", "headline", "hint", "allowOverride"? }`
    (the same body through the cloud companion's relay).
    `error.message` is the one sentence to show; `error.code` is one of
    `host_not_ready` (a readiness problem such as `claude_outdated`, named by
    `kind`), `host_unreachable` (a fresh connect attempt just failed; `kind`,
    `headline` and `hint` come from that attempt), `host_off` (remote hosts
    are off on this test server) or `host_removed` (the alias left Settings).
    `allowOverride: true` marks the two kinds an old or signed-out CLI may
    still survive (`claude_outdated`, `claude_not_logged_in`): send the same
    body again with `"overrideReadiness": true` to start anyway. Other kinds
    ignore the flag.
  - `201` means **accepted, not spawned**: the CLI spawn is asynchronous, so
    a typo'd path or an unreachable SSH host still returns 201 and surfaces
    later as session `error` status. The record is pre-seeded, so the
    returned `sessionId` immediately works with the stream/messages AND
    transcript endpoints — the transcript answers `200 messages: []` during
    the pre-spawn window (see above), then fills in as turns complete.
- Ask launch (additive, 2026-09): the phone's New chat. `POST /api/v1/sessions`
  body `{ "walnutAgent": true, "agentId"?, "message"?, "taskId"?, "model"? }`,
  with no `cwd` and no `host` → the same `201 { "sessionId", "taskId", "title" }`.
  - It creates the task the web console's Ask tab creates: filed under the
    agent's `Ask <name>` project (`Ask Walnut` when `agentId` is absent or
    `general`), stamped with `agent_id` for any other agent, born in Focus, and
    running in the server's own folder with that agent's persona. Once its
    session is up it is the top row of `GET /api/v1/asks` for that agent (the
    row's activity time is when the session linked, not when the POST answered).
  - `model` absent: the model last picked for an ask. A `model` here becomes
    that memory; `"default"` clears it.
  - `taskId`: continue an existing ask; its own agent stamp decides the persona.
  - A client `cwd` is ignored (the server owns an ask's folder).
  - `400 bad_request`, before anything is written: `agentId` without
    `walnutAgent`, an unknown agent, a `walnutAgent` that is not a boolean, or
    any `host` (an ask runs where the server runs).
  - REPLICA: relayed to the primary like any launch, fields intact. A primary
    that predates ask launches answers `400 bad_request` "cwd is required", so
    offer this only when the `GET /api/v1/asks` answer carries `"launch": true`.

### Session control (additive, 2026-08) — model / effort / fork / model-options

Semantics are identical to the web console's session controls: both surfaces
call the same shared core (`src/core/sessions/session-controls.ts`). Works on
BOTH boxes:

- **Primary box**: the core runs directly.
- **Cloud companion (REPLICA)**: session records + live CLIs live on the
  primary, so every endpoint relays over the `/bridge` WS via the narrow
  `session.control` daemon command (allowlisted alongside `session.launch`).
  The primary's daemon forwards the request up to its connected walnut server,
  which runs the same core and replies. The exception is model-options, model
  and effort for a session the companion runs itself (a cloud-exec session or
  its own chat lane): those are answered from the companion's own registry.
  Failure ladder mirrors session launch:
  `400 session_control_needs_upgrade` — the primary's daemon predates the
  relay (self-heals on the next primary reconnect via auto-deploy);
  `503 bridge_offline` — no live bridge, or the primary's server is
  disconnected from its daemon; validation errors from the primary surface
  verbatim with their original code/status.

- `GET /api/v1/sessions/:id/model-options` →
  `{ "models": [ { "id", "label", "resolvedModel"?, "supportsEffort"?, "supportedEffortLevels"? } ],
  "current", "currentEffort" }`
  - `models`: the session's selectable catalog (live CLI catalog when the
    session is alive → the host's last-known catalog → the static registry on
    a first install). Each row's `id` is what the picker must send back to
    `POST .../model`. `supportedEffortLevels` (when present) drives the effort
    buttons per model.
  - `resolvedModel` (additive, 2026-09): the canonical model id the row
    resolves to, when the catalog knows it. Alias rows only name a real model
    here (`default` and `opus` → `global.anthropic.claude-opus-5-5[1m]`,
    `haiku` → `global.anthropic.claude-haiku-4-5-20251001-v1:0`). Clients label
    rows with the web picker's rule (`catalogRowLabel`: the versioned name
    derived from `resolvedModel ?? id`, `Default (…)` for the `default` row,
    else `label`), so the phone reads "Opus 5.5 1M" where the Mac does. Absent
    on the static registry, on an old CLI, and on a primary that predates the
    field; a client then derives from `id` alone. A replica relays the
    primary's rows verbatim, so the field reaches the phone with a primary-only
    deploy.
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
- `POST /api/v1/sessions/:id/background-tasks/:taskId/stop` (additive,
  2026-09-28) → `200 { "sessionId", "taskId", "stopped", "status" }`: stop ONE
  background task (agent, shell command or workflow) through the CLI's
  `stop_task` control request. The turn and the session's other tasks keep
  running; the ledger row turns `stopped` through the usual
  `session:background-tasks` event, not this reply. `stopped: false` = the task
  had already ended (`status` says how; nothing was sent). Only an id in this
  session's own ledger is sent (task ids are unique per CLI process). Errors:
  `400 bad_request` (malformed id), `404 not_found` (unknown session, or no such
  task in its ledger), `409 conflict` (the session is not running, or the CLI
  refused or did not answer; the message carries its reason). A REPLICA relays
  it to the primary as the `background-task.stop` control action.

### Session lifecycle (additive, Wave 1 2026-08) — detail / patch / terminate / restart / retry / recheck / permission / execute-continue / changes / history

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
  - Optional (additive, 2026-09): `"thread_anchors"` (the whole anchor list,
    same rules as `PATCH /api/sessions/:id`) and `"thread_meta"`, a list of
    per-question entries `{ "headId", "status"?, "title"?, "titleSource"?,
    "titleState"?, "question"?, "takeaway"?, "takeawaySource"?,
    "takeawayState"?, "hidden"?, "suggestDismissed"?, "refinedAt"? }`.
    `thread_meta` is an UPSERT by `headId`, not a replace: listed fields
    overwrite, `null` clears a field, entries and fields you leave out stay as
    they are, and the server stamps `updatedAt` on every entry it changes.
    Limits: `headId` 1 to 128 chars, `status` one of
    `open|suggested|resolved|older`, `title` at most 120 chars, `takeaway` at
    most 280, at most 500 entries per body; `question` is cut to 400 chars
    without an error. Any other shape, an unknown enum value, `status: null`,
    or `thread_meta` together with `mode` answers `400 bad_request` and stores
    nothing. When anchors and meta ride one body, the anchors apply first. An
    entry whose `headId` has no anchor is dropped once it is 10 minutes old.
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
  state cleared), `200 { "status": "resumable", "sessionId" }` (dead process,
  conversation on disk, nothing queued — the record is relabelled back to a
  resumable `stopped` and **nothing is sent**), `200 { "status": "resuming",
  "sessionId", "restoredMessages"? }` (dead process **and** the queue already
  held the user's own message — that original text is what gets delivered), or
  `200 { "status": "pending", "taskId", "oldSessionId" }` (never initialized —
  archived + a new session started on the task). Only `error`/`stopped`
  sessions are retryable (`400` otherwise; `400` when no task is linked).
  Retry NEVER synthesizes message text: it used to enqueue a literal
  `"continue"` on the empty-queue path, which started a turn the human never
  asked for. A client that wants work to continue sends a real message.
- `POST /api/v1/sessions/:id/recheck` (additive 2026-09) →
  `200 { "sessionId", "checked", "reachable", "alive"?, "processStatus",
  "infraClaim", "reason"? }` — re-probes ONE session against its execution host
  and reconciles the record from the host's own snapshot. Read-only with respect
  to the session: no message, no spawn, never `--resume`. Use it when opening a
  session that sits in `error`, because a record can freeze on a stale
  "unable to reach remote host" long after the tunnel came back.
  `reachable` = the host has a live pooled daemon connection right now (reported
  even when `checked` is false, since that is exactly the fact a stale banner is
  lying about). `checked` = the daemon answered and its snapshot was applied.
  `infraClaim` = the record's cause is structurally infra (from `status_reason`,
  never a prose match), so a client can drop a stale sentence without pattern
  matching it. `reason` says why nothing was checked: `terminal_error` |
  `archived` | `no_pooled_connection` | `timeout` | `rpc_failed` | `no_snapshot`.
  Bounded to one 5s RPC over an ALREADY-POOLED connection — it never dials, so
  opening a panel cannot pay SSH connect costs. Cloud relays (Class B).
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

Class A everywhere: these endpoints only touch the conversation records, which each
box keeps locally, so a REPLICA renames, deletes, and stops against its own copies
(and a replica has no lane session to interrupt, so `stopped` is `0` there). Answering
a turn is a different matter, and always the primary's job. `agentId` is accepted
like the other conversation endpoints (absent → `general`).

- `PATCH /api/v1/conversations/:id` body `{ "title"? | "pinned"? }` →
  `200 { "conversation" }`. At least one field required.
- `DELETE /api/v1/conversations/:id` → `204`. The MAIN conversation (receives
  notifications + cron) is never deletable → `409 conflict`.
- `POST /api/v1/conversations/:id/stop` → `200 { "stopped": N,
  "questionCancelled": boolean }`: interrupts the conversation's lane session,
  which is what "stop" means for a single-user Personal AI (REST clients have no
  per-socket identity, so there is nothing narrower to stop). `stopped` is a
  NUMBER: `1` when a session was interrupted, `0` when there was nothing to
  interrupt. `questionCancelled` is always `false`. Both keys stay on the wire
  because installed iOS builds decode them as non-optional.
- `POST /api/v1/conversations/:id/answer` stays mounted and now always answers
  `409 { "error": { "code": "conflict", "message": "This conversation has no question to answer — send the text as an ordinary message instead" } }`.
  An unknown conversation id still answers `404 not_found` first, because the route
  resolves the conversation before refusing, exactly as before. Nothing can be
  pending any more: structured questions were raised by a tool that no longer
  exists. The route is kept because a v1 path never disappears, and because
  the installed iOS client already reads a 409 here as "the question is gone, keep
  my text" and deliberately does not report the answer as delivered, while a 404
  reads to it as a broken server.

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
- `POST /api/v1/routines/trigger` (the `trigger_create` op) body `{ run, every,
  prompt, description, session?, host?, cwd?, name?, timeoutSeconds?,
  maxFiresPerDay?, wait?, wait_until? }` → `201 { job, host,
  nextCheckAt: null, wait }`. `session` defaults to `"this"` (the calling
  session's task, from `x-walnut-caller-sid`).
  - Parking (additive, 2026-10): a trigger on the CALLER'S OWN task parks that
    task as `WAITING` by default; `wait: false` arms it without parking (work
    remains), `wait: true` parks a task named by id as well. `wait_until` is an
    ISO datetime or a duration from now (`"6h"`, `"3d"`), `""` for no clock;
    absent = the store's 3-day default. A park sends no letter (a stray
    `wait_report` is ignored). A bad `wait` or `wait_until` (unparseable or not
    in the future) is `400` and arms nothing.
  - `wait` = `{ parked, task_id, reason?, wait_until?, already_waiting?,
    error? }`. `reason` when not parked: `wait_false`,
    `other_task`, `complete` (a completed task is never parked), `not_written`
    (the park failed; the trigger stays armed and `error` says why). A task that
    was already waiting keeps its clock unless `wait_until` was passed.
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
  The order lives in the primary's config.yaml, which is machine-local (it
  does not ride git-sync). A REPLICA's `GET` therefore serves the copy the
  primary pushes on its task projection (`project_order`, additive 2026-09),
  and falls back to its own config only while the primary predates that
  field.
- `POST /api/v1/favorites/projects/:name` / `DELETE …/:name` →
  `{ "projects" }` — case-insensitive, idempotent; stored under the
  registry's canonical spelling. Completes the Wave-1 note-favorites pair.

### Task extras: tags, groups, quick-parse, focus tiers (additive, Wave 2 2026-08)

- `GET /api/v1/tasks/meta/tags` → `200 { "tags": [ { tag, count } ] }` —
  autocomplete catalog. Class A.
- Tag form (2026-10): every tag is a key:value pair (`ticket:V1234567890`, `sev:2`,
  `team:marina`); the key is lowercase letters, digits, `.`, `_`, `-`. Every write stores
  tags in that form, so a plain word sent by an older client is stored as the label
  `label:<word>`, and a filter (`tag`, `tags_any`, `tags_all`, `add_tags`, `remove_tags`)
  naming a plain word means that label. Two keys are Walnut's own and never stored:
  `created:<YYYY-MM-DD>` and `updated:<YYYY-MM-DD>`, the task's own dates in the server's
  local time. A filter naming one matches those dates; a write naming one stores the text
  as a label instead.
- Tag display (additive, 2026-09; `value` 2026-10): every tag is an ordinary tag
  (searched, filtered, edited); how it shows as a pill is a separate, display-only rule,
  per exact tag or per key (`ticket-id:*` covers every tag whose key is `ticket-id`).
  `shown` draws the whole tag, `value` only the text after the key (a ticket's id), and
  `hidden` no pill. Walnut's machine tags (`walnut:*`) never show; the user's rule wins over
  a plugin's default, and a plugin's over Walnut's defaults (labels read as their value,
  `created:` and `updated:` hidden); two plugins disagreeing take the quieter display
  (hidden, then value). Clients compile the rule list once and filter the pills they draw,
  and read it again on open; the web console also hears `task:tag-display-changed` on its
  socket (not on the v1 SSE feed). A client that knows only `shown` and `hidden` should
  draw `value` as `shown`.
- Tag links (additive, 2026-10): a tag or a key may also be a link, an http(s) URL with
  `{value}` where the tag's value goes (URL-encoded): a ticket plugin links `ticket:*` to
  its tracker, so the pill opens the ticket in a new tab (the Mac app hands it to the
  default browser) instead of opening the row. The user's link wins over a plugin's, the
  exact tag over its key, and the user's empty link `""` takes a plugin's away. A client
  that ignores `links` draws plain pills. The user sets links in Settings, Tasks, Tags;
  the iOS app draws the same pills (value only, hidden, linked) from this list.
  - `GET /api/v1/tasks/meta/tag-display` → `200 { "rules": [ { pattern, display:
    'shown'|'value'|'hidden', source: 'builtin'|'user'|'plugin'|'default', pluginId?,
    pluginName? } ], "links": [ { pattern, link, source: 'user'|'plugin', pluginId?,
    pluginName? } ] }`. `links` is absent on an older server. A REPLICA asks the primary
    (control action `server.tag-display`, 8s budget), because the user's rules live in the
    primary's config and plugin defaults in its memory; when the Mac cannot be reached, or
    predates the action, it answers its own list (Walnut's rules only), never an error.
  - `PUT /api/v1/tasks/meta/tag-display` body `{ "pattern", "display": 'shown' | 'value' |
    'hidden' | null }` sets (or, with `null`, removes) the user's rule for one tag or
    `<key>:*`; `{ "pattern", "link": "<template>" | "" | null }` sets the user's link the
    same way (both in one body set both). Answers `{ rules, links }`. A machine-tag pattern,
    a malformed one, or a link that is not an http(s) URL naming `{value}` →
    `400 bad_request`, and nothing is written. A REPLICA relays the change to the primary
    (`server.tag-display.set`, the primary's answer and errors verbatim); with the Mac out
    of reach it answers `503 bridge_offline` and keeps nothing (until 2026-10 it answered
    `501 not_supported_cloud`).
- Virtual task groups — **all writes answer `501 not_supported_cloud` on a
  REPLICA** (`group_id` and the group registry are not in the outbox update
  whitelist, so replica-local writes would silently revert; an honest error
  beats a silent revert):
  - `GET /api/v1/tasks/groups` → `{ "groups": [ { group_id, label, hidden,
    member_ids, project, parent_id? } ] }` (reads work on both boxes). A
    REPLICA's own rows carry no `group_id`, so it serves the listing the
    primary pushes on its task projection (`groups`, additive 2026-09,
    `member_ids` narrowed to the rows the projection ships), and falls back
    to its own store only while the primary predates that field.
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
    `404`. Each row's `status` is `pending`, `processing`, or `parked`.
    **`parked`** is the dead-letter state: delivery failed for a reason retrying
    cannot fix (the session's working directory was deleted, its record is gone)
    or the row went undelivered for over 7 days, so no automatic trigger will
    attempt it again. Parked rows carry `parkedAt` and a human-readable
    `parkedReason`; they stay listed so a client can offer Retry (re-send with
    the same id, which un-parks it) or Discard (`DELETE` below).
  - `PATCH /api/v1/sessions/:id/queue/:messageId` body `{ "text" }` →
    `{ "ok" }`; already processing/gone → `409 conflict`.
  - `DELETE /api/v1/sessions/:id/queue/:messageId` → `{ "ok" }`; works for a
    pending or parked row, `409 conflict` for one already in flight.

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
- `GET /api/v1/file-raw/<host>/<path...>[?download=1]` (additive, 2026-09): the
  PATH-shaped twin of `file-content?raw=1`, same bytes and same sandbox. Use this
  shape for HTML previews: a document's relative URLs resolve against its URL's
  path and drop the query, so from the query-shaped URL `<img src="diagram.png">`
  pointed at `/api/v1/diagram.png`; from `/api/v1/file-raw/local/Users/me/proj/index.html`
  it resolves to a sibling under this route. `<host>` is `local` or a host alias;
  the remainder is the file's absolute path (or `~/…` for remote), one
  percent-encoded segment per component. REPLICA: `302` to the query-shaped relay.
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

Class A: local conversation state on each box, not the answering engine. `agentId` as
usual (absent → `general`).

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
- `GET /api/v1/chat/engine?agentId=&conversationId=` →
  `{ "engine": "lane", "sessionId": string|null, "cwd"?, "host"?, "switchable"? }`
  — the id of the `claude` session (the "lane") answering this conversation.
  - `engine` is always `"lane"`: a chat turn runs in a real CLI session, so
    `sessionId` is a normal session id and the existing
    `/sessions/:id/model-options`, `/model`, `/effort`, and `/controls` endpoints
    all work on it (they resolve by session RECORD, so a lane session is not
    excluded the way it is from `GET /sessions`). This is how a client puts a
    model pill on the Personal AI chat. The field stays on the wire so a client can
    badge it; older servers may also answer `"in-process"`, which now means the
    same thing as no session (see the next bullet).
  - `sessionId: null` means the lane has no session YET (a conversation with no
    turn, or one whose lane was archived by `chat/clear`). **This endpoint never
    mints a lane** — minting is a side effect of sending, and opening a picker
    must not spawn a CLI. Clients render the model read-only (or hide the pill)
    until the first turn, or mint explicitly with
    `POST /api/v1/chat/engine/session`.
  - `host` is `""` for the primary box, matching `ProjectedSession.host`
    semantics. No `conversationId` = the active conversation.
  - On a cloud REPLICA this is the primary's answer, relayed; with the primary
    out of reach it is `503 primary_unreachable` (`retry: true`). One exception:
    when the request provably never reached the primary (no bridge after the
    reconnect grace, or a daemon with no server behind it) AND the replica answers
    chat turns itself (`cloudChat: "available"` on `GET /status`), the answer is
    the replica's OWN lane, the one the next text turn runs on (a picture turn is
    still refused while the primary is away): `host: "__cloud__"`
    and the additive `answeredBy: "cloud"`. Its `sessionId` works on
    `/sessions/:id/model-options`, `/model` and `/effort` on the replica itself,
    and `/sessions/:id/controls` reports its one fixed mode (`dontAsk`; any other
    value is `409 conflict`). `POST /api/v1/chat/engine/session` mints that lane
    under the same condition, up to `cloud.exec.max_sessions` live lanes; past
    that it answers `409 cloud_lane_capacity` (the conversation's first message
    still gets its lane). An old primary that does not know the engine action
    keeps the 503: that proves nothing about where a turn goes. The next re-ask
    after the primary is back returns the primary's lane again.
- `PUT /api/v1/chat/model?agentId=&conversationId=` →
  `409 { "error": { "code": "lane_engine", "sessionId" }, "sessionId" }` — the lane
  session owns model and effort, so switch them through
  `PUT /api/v1/sessions/:id/model|effort` on the `sessionId` this returns. A
  malformed body still answers `400 bad_request` first.

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
- `GET /api/v1/qmd/status` → search index health (model, per-kind doc counts,
  state machine, progress). **REPLICA: 501** (the companion holds no index).
  The maintenance actions (download/reindex) stay desktop-only. The path keeps
  its old name because it is frozen and the phone reads it; the payload is now
  built from the single hybrid index (`src/web/routes/search-index.ts`), whose
  canonical route is `/api/search-index/status`.
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
- `GET /api/v1/notes/resolve?ref=` → `{ "id", "path", "title", "matchedBy":
  "id" | "path" | "name" }` — one note REFERENCE to its vault path. `ref`
  accepts a frontmatter id (`n_…`, the first field of every notes-search hit),
  a vault-relative path (`.md` optional), or a bare title/basename resolved the
  way `[[wikilinks]]` are. Unknown → `404`; a title matching several notes →
  `409 conflict` listing the candidates (a confident wrong answer would hand
  back the wrong note to overwrite). Class A. This is what lets the notes
  operations (`note_read`, `note_edit`) take an id where they used to demand a
  path.
- `POST /api/v1/chat/compact?agentId=&conversationId=` → `{ "ok",
  "async": true }` or `{ "ok", "alreadyRunning": true }` — fire-and-forget
  background compaction. Class A: this compacts the stored conversation history
  each box holds, one model call and no tools, so either box can run it.
- `GET /api/v1/memory/telemetry` → `{ "stores", "note" }` — write-path
  evidence per memory entry (age, revision churn, provenance).
  `POST /api/v1/memory/daily-log/compact` body `{ "date"?, "threshold"?,
  "summarizer": "extract" }` → compaction result; no log for the date →
  `404`; missing/unknown summarizer above threshold → `400`. Class A.
- `POST /api/v1/stt/transcribe` body `{ "audio" (base64), "format", "language"? }` → `{ "text", "durationMs", "via": "primary" | "bridge" | "openai" }`. `format` is one of `webm`/`wav`/`mp3`/`ogg`/`mp4`/`m4a`/`flac`. Body cap 35 MB, audio string cap 25 MB base64 (both answer `413 too_large` in the frozen shape). On the cloud companion the audio is relayed to the primary box over the daemon bridge, falling back to the companion's own OpenAI key; audio too big for one bridge frame skips the relay entirely. Failures are `422 bad_audio` (the recording itself is undecodable) or `503 stt_unavailable` (try later). `error.message` is safe to show a user verbatim: an engine string is passed through only when it is provably plain prose (bounded length, ordinary sentence characters, no paths, URLs, JSON, hex, host:port, errno or pid tokens), and anything else is replaced by a generic sentence. Treat it as human copy, not as a diagnostic: the full engine text stays in the server log.
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

### Human inbox replies (additive, 2026-09): `clientId` and a recorded `delivery` per turn

`POST /api/v1/human-inbox/:id/human-reply` body `{ "text", "clientId"? }` → `{ letter, delivery }`, and `POST /api/v1/human-inbox/:id/answer` → `{ letter, delivery }`. The human turn is written to the letter thread BEFORE delivery to the origin session is tried, as before. Two additive fields make the outcome durable and a retry safe:

- **`thread[].delivery`** (human turns only) `{ "status", "reason"?, "sessionId"?, "at" }`: how far THIS turn got toward the origin session, so a reader can show it under the reply and still show it after the letter is reopened. It is written as `pending` in the same write that records the turn, and replaced by the attempt's outcome when the attempt ends: `queued` (handed to the session's message queue, which resumes a session that is not running), `deferred` (queued but held: the session waits on a permission prompt; the record is not updated when the prompt is resolved and the reply drains), `skipped` (saved only; `reason` `no_origin_session` or `origin_session_gone`), or `failed` (`reason` bounded to 200 characters). Absent on turns recorded before the field existed; a server from before `pending` existed leaves it absent until the attempt ends.
- **`clientId`** (human-reply only; 1 to 100 characters of `[A-Za-z0-9._:-]`, starting alphanumeric; anything else is `400 bad_request`): the client's id for the reply, stored as `thread[].clientId`. A repeat with the same id is the same reply: nothing is appended, and the answer is the recorded turn's delivery (a repeat that arrives while the first is still delivering waits for that attempt). Two exceptions deliver the same turn again: a recorded delivery of `failed` (the repeat IS the retry), and a `pending` one with no attempt running (the server died mid-delivery). Without `clientId` every call appends, as before. The response's `delivery` for a repeat carries no `messageId`.

**`202` with a pending delivery.** Both routes wait for the delivery for up to 10s (2s inside their 12s deadline). A delivery that takes longer is not cut short: the route answers `202` with the letter, whose turn carries `delivery.status: "pending"`, and `delivery: { "status": "pending" }`, and the outcome is written onto the turn when the attempt ends. A client shows the reply as on its way and re-reads the letter (`GET /api/v1/human-inbox/:id`) until the turn's `delivery` is final; there is no push for it. A `504 timeout` now means the turn may not be on record yet (the write itself outlasted the deadline), so a client treats it like any lost answer.

A lost answer (a timeout, a dropped connection) does not mean the reply was not recorded: the turn is written first, so it may be on record and delivered. Resending with the same `clientId` is always safe. Editing the words and sending them under a NEW id is not, because the agent would read both; a client re-reads the letter and matches `thread[].clientId` before it offers that. A replica's `503 bridge_offline` is sent both when nothing reached the primary (no bridge) and when the relayed request went out and then failed; only the first proves nothing was recorded.

REPLICA: relayed to the primary over `server.human-inbox.human-reply` (`clientId` included) and `server.human-inbox.answer`. The primary waits up to 7s for the delivery on a relayed call, so its `pending` answer reaches the replica inside the replica's own deadline, and the replica answers `202` for it.

### Human inbox on a replica while the primary is unreachable (additive, 2026-10)

A replica asks the primary first for `GET /api/v1/human-inbox`, `GET /api/v1/human-inbox/:id` and `POST /api/v1/human-inbox/:id/{read,pin,archive}`, as before. When the primary cannot be reached (no bridge, a relay timeout, a primary too old for the action), it no longer answers `503 bridge_offline`:

- **Reads** come from the replica's git-synced copy of the inbox, in the same shapes, plus `"servedFrom": "mirror"` (and, on the list, `"mirrorUpdatedAt"`, the copy's content clock). The copy is as new as the primary's last sync. A letter the copy does not hold, or a replica with no copy at all, still answers `503 bridge_offline`.
- **read / pin / archive** are answered `200 { letter, "queued": true }` with the change applied, kept by the replica, and shown in every later read from the copy. The replica replays them to the primary when the primary's bridge reconnects (and every 60s), with the moment the human made the change. The primary skips a replay that would undo something newer: a change older than that flag's last change on the primary, or a read or archive older than an agent turn on the letter. A replica with changes still queued serves the list from the copy, so a list never shows a change as lost; one letter is still asked of the primary, with the queued changes on top.
- **Letter records** carry `pinnedAt` and `archivedAt` (epoch ms, when the flag last changed; absent until it first moves), next to the existing `readAt`. They are what the primary compares a replay against.
- Answers (`answer`, `human-reply`), agent replies and new letters still need the primary and answer `503 bridge_offline` while it is away.

A client treats `queued` like any successful write and needs no change. Relay detail: the primary's `server.human-inbox.{read,pin,archive}` accepts `since` (epoch ms), and its answer also carries `storeUpdatedAt` (the index clock the write stamped) and `superseded: true` for a skipped replay. The replica keeps both for itself: it holds a change on top of its copy until the copy's clock reaches `storeUpdatedAt`, which covers a Mac that sleeps before its next sync.

### GET /api/v1/events (SSE, additive, 2026-08) — live task + session feed

One long-lived SSE stream that pushes slim updates so the app can keep its task list and session list current without polling. Works on BOTH boxes; auth is the standard Bearer.

**Frames, in order:**

1. `event: snapshot` — sent once per connection, immediately on attach. `data: { "sessions": [ProjectedSession…], "tasks": [ProjectedTask…] }` — the exact same row shapes as `GET /api/v1/sessions` and `GET /api/v1/tasks`. Carries **no SSE id** (it is per-connection state, never part of replay). Treat it as a full replace of both lists.
2. Live events (each with an SSE `id`; **no server-side replay** — the snapshot on (re)connect is the sole catch-up mechanism):
   - `event: session-upsert` — `data:` one `ProjectedSession` row (`id`, `title`?, `task_id`?, `task_title`?, `project`?, `group_id`?, `group_label`?, `host`, `process_status`, `model`?, `mode`?, `started_at`, `last_active_at`, `message_count`, `cwd`?, `pinned`?, `focus_tier`?, `description`?; absent fields are omitted, not null). Merge by `id` (insert when new).
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

### POST /api/v1/time/heartbeats (additive, 2026-08) — bank human time

The phone banks closed attention windows into the SAME time-tracking store the web console feeds, so one day's total covers both screens.

Body: `{ "samples": [ { "id"?, "ts", "durationMs", "kind", "taskId"?, "sessionId"?, "source"? } ] }`

- `ts`: ISO timestamp of the window's START. `durationMs`: its length (clamped at 10 min per sample; a non-positive or non-finite value drops that sample).
- `kind`: `session` | `triage` | `chat`. The `agent` lane is derived server-side and is never accepted from a client.
- `taskId` optional. `sessionId` optional: when a sample names a session but no task, the SERVER resolves the task from the session (the client is never the authority on that mapping).
- `source` optional, `web` | `ios`. On this endpoint an absent (or unrecognized) value means `ios`, since v1 is the mobile contract; an explicit `web` is honored. Absent `source` in the STORE always means web, which is what keeps every day file written before this field intact.
- `id` optional but STRONGLY recommended: a client-minted dedupe key, `<installId>-<seq>`, at most 64 chars of `[A-Za-z0-9._:-]` (must start alphanumeric). The server remembers accepted ids and skips a repeat, which is what makes retrying safe: every ack can be lost (a suspended background flush, a client-side timeout, a dropped connection), so a batch WILL arrive twice. A sample without an id is banked on every delivery, so a client that omits it double counts its own time on any retry. The id is never persisted: it does not appear in the stored record or in `/api/time/*` output. An id that fails the charset/length rule is ignored (the sample still banks, it just cannot be deduped).
- At most **200** samples per call. Anything past the 200th is DISCARDED and the call still answers `204`, so a client must send batches of at most 200 and keep the rest queued; the iOS queue's `maxBatch` is pinned to this number by a cross-language ratchet test.

Responses:

| Status | Meaning |
|---|---|
| `204` | The samples reached the primary's day file. Also the answer for an empty batch or one with nothing usable in it: telemetry never errors for junk, and asking a client to retry a sample that can never be accepted just loops, so "banked" and "dropped as invalid" are deliberately indistinguishable. |
| `503 { "error": { "code": "primary_unreachable", "message": "…" } }` | Nothing was persisted; keep the batch queued and retry. Emitted by BOTH boxes: on a REPLICA when the relay could not be served (bridge down, the primary's server down, or a primary that predates the action, which self-heals on its next deploy), and on the PRIMARY when the fold landed but the day-file write did not (a full or unwritable data dir, or a write still unfinished after 1s). One code for both, because they mean the same thing to a client. No failure here is ever a 4xx: that would make the client throw the samples away. |

REPLICA behavior (Class B relay, and NOT `501` like the internal `/api/time` family): the phone mostly talks to the cloud companion, so the batch is relayed to the primary over the existing `session.control` bridge lane (`server.time.heartbeats`) with a 10s budget. The primary is also the only box allowed to VALIDATE a batch, because a record's day key is the local day of its `ts` on whichever box sanitizes it: the replica runs UTC, so a replica-side bank would file the user's evening under tomorrow. The replica only bounds what crosses the bridge (sample count, the known fields, id sizes), since one oversized frame closes the socket every in-flight request shares.

**The day a sample lands on is the PRIMARY's local day**, computed from `ts` in the Mac's timezone. A phone in another timezone therefore files its time under the Mac's calendar day, which is the intended behavior (the panel answers "my Tuesday" for the box the user's data lives on). Near midnight the phone and the Mac can disagree about which day a window belongs to.

Where it shows up: `GET /api/time/summary` (web console). A day carries `iosMs` and the window carries `totalIosMs` when phone time is present (both omitted at zero). Per-task rows aggregate ACROSS sources: "time on this task" is one number and must not depend on which screen the user held.

### Apple Health (additive, 2026-09): `/health/sync`, `/health/status`, `/health/settings`, `/health/data`

The iPhone reads HealthKit itself and keeps the PRIMARY up to date, with nothing for the user to send; the PRIMARY keeps it in `~/.open-walnut/health/health.sqlite`. Walnut never sends the raw samples or that store off the Mac: git-sync ignores the directory, the S3 backup and test-server snapshots exclude it, logs carry counts only, and no route, op or relay serves them to a caller that is not on this Mac (the rule below). What an agent writes ABOUT the data (a chat reply, an inbox letter) is ordinary Walnut content and syncs like any other letter; the shipped routines are off by default and summarize rather than dump series. All four endpoints are Class B relays on a REPLICA (`server.health.sync|status|settings|delete` over `session.control`, 10s budget), and the replica stores nothing. The primary answers those relay actions only when they arrive through its own daemon (`__local__`, the one the replica's bridge uses), never through a remote exec host's daemon.

**Rule: health data is only available to callers on this Mac.** "On this Mac" is the caller's ORIGIN, not the socket. The server reaches its own API over loopback on behalf of callers that are elsewhere (an op that a remote host's session runs through the gateway, an action card clicked on a paired phone, a cloud bridge relay), and every such self-call carries `x-walnut-origin`: `__local__`, `host:<hostKey>`, or `remote-http` (a device token, an API key, or the bridge). Only server code writes it, and it can only lower trust: a loopback request is local only when it sends no such header or `__local__`, and a request from off this machine is `remote-http` whatever it sends. On the primary:

- `/api/v1/health/*` (sync, status, settings, data) answers this Mac and a paired phone's device token only. An API key gets `403 forbidden` (`message: "Apple Health accepts only this Mac and a paired phone's device token. An API key cannot read or change it."`), on a cloud replica as well; a daemon machine token is refused with `401 token_refused` before any route, as everywhere. A self-call made for a caller off this Mac gets `403 forbidden` too. Both refusals use the v1 error shape.
- `/api/health/*` (the agent reads) answers only a caller whose origin is this Mac. Everyone else gets `403 forbidden` with `message: "Health data is only available to sessions on this Mac"`, including a caller holding a valid device token or API key.
- The health ops (`health_*`, `day_review`) run only for a caller on this Mac, whatever the entry point: the gateway, `POST /api/v1/actions/invoke`, the plugin op route and its bridge relay, or another op calling them.
- `POST /api/v1/actions/invoke` refuses any `remote: 'deny'` or `localHostGateway` op with `403 local_only` unless the request comes from this Mac.
- The `api` passthrough, for a caller off this Mac, refuses every health path and every route that a `remote: 'deny'` op binds or declares (for example `DELETE /api/tasks/:id`, legacy or v1), after resolving dot segments, percent escapes, case, repeated slashes and a trailing slash. The set is read from the op registry, not kept by hand.
- A plugin's HTTP route runs for whoever requested it. An op it calls and a request it sends back to this server (`walnut.http.fetch` to a loopback name) carry that requester's origin, so a paired phone cannot read health through a plugin's route either.
- A trigger check is a command, and on this Mac it is a local caller. So a session on another exec host may test, arm or change a check only on its own host (`host` = its alias; with no host, `trigger_test` and `trigger_create` with `session: "this"` use the calling session's host, and anything else means this Mac). A check on this Mac or on a third host is refused before any daemon is asked, from `trigger_test`, `trigger_create`, `POST /routines/check-test`, `POST /routines/trigger`, `POST /routines` and a `PATCH /routines/:id` that changes a check's command, cwd or host (legacy `/api/routines` and `/api/cron` too). The REST routes answer `403`: v1 with `{ "error": { "code": "forbidden", "message" } }`, the legacy routes with `{ "error": message }`. `POST /api/v1/actions/invoke` answers `200` with `{ "ok": false, "error": { "code": "op_failed", "message" } }`. On the gateway, the named op and the `api` passthrough fail with code `internal`. Each entry point gives the same message. For a session on another host it names that session's own host; for a caller that cannot be identified it names no host.

A paired device or an API key can already start work on this Mac (a coding session, or a trigger check), so for those two the health rules only keep a script from reading health by accident.

- A daemon relays `session.control` actions (every `server.*` action and every session control) only for the Mac's own daemon, which is the path the cloud replica's bridge uses. A remote exec host's daemon gets `forbidden` for all of them, so a process on that host cannot run a routine, a check command, a chat turn, a task write or a letter through its daemon. A session there still reaches Walnut through the gateway (`walnut tools call`), which keeps each op's own remote policy.

What the rule does not cover: a session on a host you connect to Walnut can still, through ordinary ops on the gateway, start a session on this Mac (`task_create` or `task_start` naming this Mac, a task in a project whose default host is this Mac, or a routine whose agent runs here) and read files here through the `api` passthrough to the Files routes. Those reach every file on this Mac, the health store included. Connect only hosts you trust as much as the Mac itself.

`POST /api/v1/health/sync`, one type (raw) or one metric (buckets) per call. Catalog names below; every other HealthKit type uses a generic name (next list):

```json
{ "storeId": "hs-…", "device": { "installId": "…", "model": "iPhone", "os": "iOS 26" }, "tz": "America/New_York",
  "kind": "raw", "type": "sleep",
  "samples": [ { "uuid": "…", "start": "2026-09-20T23:10:00-04:00", "end": "2026-09-21T03:00:00-04:00", "code": 3,
                 "source": { "bundleId": "com.apple.health.…", "name": "Watch" }, "device": "Watch", "tz": "…", "meta": { "userEntered": true } } ],
  "deleted": [ "uuid", "…" ],
  "resync": { "phase": "begin", "windowStart": "2026-06-23T00:00:00Z", "generation": 7 },
  "preferredUnits": { "temperature": "degF", "distance": "mi", "energy": "kcal" } }
```

- `kind: "buckets"` carries `metric` and `buckets: [ { "start", "intervalSec": 300|3600|86400, "sum"|"avg", "min", "max", "count" } ]` (HealthKit statistics, already merged by the Health app).
- Instants are ISO-8601 with an offset (or epoch ms). Each sample's local date is computed in ITS OWN `tz` (else the batch `tz`), never the Mac's, and durations come from instants, so DST nights are their real length. A sleep sample belongs to the night of wake date D when its END falls in (D-1 18:00, D 18:00] of its own zone: one ending at exactly 18:00 is still D's.
- Values arrive in ONE canonical unit per metric and are stored as sent: count/min (heart rate, resting, walking, respiratory rate), ms (`hrv_sdnn`), % 0 to 100 (`spo2`), degC (`wrist_temp`), count (`steps`), m (`distance`), kcal (energy), min (exercise, stand, daylight, mindful, workout), dBASPL (audio), mL/(kg·min) (`vo2max`). Sleep uses the HKCategoryValueSleepAnalysis codes: inBed 0, asleepUnspecified 1, awake 2, asleepCore 3, asleepDeep 4, asleepREM 5. `GET /health/status` lists every accepted type under `supported`; a client must not send anything else.
- Caps: at most **500** items (samples + deleted + buckets) and **192 KB** serialized per call (`HEALTH_MAX_ITEMS_PER_SYNC`, `HEALTH_MAX_SYNC_BYTES` in `src/core/health/catalog.ts`). Over either cap answers `413 too_large` with `maxItems` and `maxBytes`: split the batch, keep the data.
- Raw rows are insert-or-ignore by `uuid` (a batch posted twice is a no-op); a `deleted` uuid removes its row; buckets are replaced by `(metric, start, intervalSec)`.
- Resync is mark and sweep per type or metric: `begin` marks every stored row at or after `windowStart` with `generation`, a re-sent row clears its mark, and `end` (same generation) deletes the rows still marked. Without an `end` nothing is swept; a new `begin` replaces an unfinished one. The answer echoes `resync: { phase, generation, marked | swept, stale? }`; `stale: true` means the `end` did not match the open resync and nothing was swept.
- An item that fails validation is dropped and counted in `rejected`; retrying it cannot help. A type the server does not support answers `unsupported: true` with every item rejected: do NOT advance that type's anchor.

Generic types (additive, 2026-10): every HealthKit type outside the catalog, under a name the server does not interpret (`HEALTH_MAX_TYPE_LENGTH`, `GENERIC_*` in `src/core/health/catalog.ts`). A server that understands them says so in `GET /health/status` (`supported.generic`); an older one answers `unsupported: true`.

- Names: `q.<Suffix>` = `HKQuantityTypeIdentifier<Suffix>` (`q.BodyMass`, `q.BloodPressureSystolic`, `q.DietaryProtein`), `c.<Suffix>` = `HKCategoryTypeIdentifier<Suffix>` (`c.MenstrualFlow`, `c.Headache`, `c.HighHeartRateEvent`), `x.<Name>` for other kinds: `x.Electrocardiogram`, `x.GAD7`, `x.PHQ9`, and the characteristics `x.BiologicalSex`, `x.BloodType`, `x.DateOfBirth`, `x.FitzpatrickSkinType`, `x.WheelchairUse`, `x.ActivityMoveMode`. A name matches `^[qcx]\.[A-Z][A-Za-z0-9]{1,62}$` and is at most 64 characters; a longer one is unsupported, never cut. A generic name for a type the catalog already stores (`supported.generic.covered`: `q.HeartRate`, `q.StepCount`, `c.SleepAnalysis`, …, 19 names) answers `unsupported: true`, so nothing is stored twice.
- Raw items have the catalog shape (`uuid`, `start`, `end`, `source`, `device`, `tz`, `meta`) with `value` and/or `code`, at least one: `value` finite with \|value\| ≤ 1e9, `code` an integer 0 to 99,999,999. There are no per-type ranges. A zero-length span (`start` equal to `end`) is fine; the 2-day span limit still applies, except to a characteristic, whose times only say when the phone read it (any pair inside the plausible window). Codes are HealthKit raw values: the `HKCategoryValue…` of a category type; for `x.Electrocardiogram` the `HKElectrocardiogram.Classification` raw value with `value` = average heart rate in count/min; for `x.GAD7` / `x.PHQ9` the score; for a characteristic its HealthKit enum raw value, with `x.DateOfBirth` as `yyyymmdd`.
- A characteristic re-sent under the same `uuid` REPLACES its row (a current value, not a sample): give each one a stable uuid such as `characteristic-BloodType`. Every other type stays insert-or-ignore by `uuid`.
- Batch-level `unit` (`^[A-Za-z0-9%/()*·._ ^-]{1,32}$`, HealthKit unit syntax: `kg`, `mg/dL`, `count/min`): REQUIRED on every `q.` call, raw or buckets; optional on `c.` / `x.`; ignored on catalog calls. Buckets (`kind: "buckets"`, `q.` only, any of the catalog intervals) also need batch-level `agg`: `sum` (cumulative, e.g. `q.FlightsClimbed`, `q.DietaryEnergyConsumed`) or `avg` (discrete); every bucket must carry the field `agg` names, each value with \|v\| ≤ 1e9. A generic call missing a field it needs (or with a malformed one) stores nothing and answers `refused: { field: "unit" | "agg", message }` with every item counted in `rejected`: a client bug, keep the anchor.
- Pinning: the first `unit` stored for a generic type is pinned (meta `unit:<type>`), and so is the first `agg` of its buckets (`agg:<type>`). A later call with a different one stores nothing, skips any `resync` in it (its `end` would sweep every row) and answers `200` with `unitMismatch: { type, field: "unit" | "agg", stored, sent }`; its items are NOT counted in `rejected`, and its `deleted` uuids still apply. Keep the anchor and send the data again in the stored unit.
- Every generic type belongs to the category `other` (settings and `DELETE /health/data`). A generic sync changes no derived night or day; it still announces `health:ingested` with its type and dates.

| Status | Meaning |
|---|---|
| `200 { accepted, inserted, deleted, storeId, paused, rejected?, unsupported?, categoryDisabled?, unitMismatch?, refused?, resync? }` | The SQLite transaction committed. `paused: true` means nothing new was stored (deletions still apply); `categoryDisabled: true` means that category is switched off in settings. The phone may forget the batch, except after `unsupported`, `unitMismatch` or `refused`: keep that anchor. |
| `409 store_mismatch` + `storeId` | The data was deleted and the store re-created. Clear every anchor and resync under the new `storeId`. |
| `413 too_large` | Over the per-call caps: split it. |
| `503 primary_unreachable` | Nothing stored. Keep the batch queued and retry. |

`GET /api/v1/health/status` → `{ connected, paused, storeId, lastUploadAt, coverage: { from, to }, types: [ { type, category, enabled, lastSampleAt, state: ok|stale|unknown_or_denied } ], sources, sleepSourceOrder, categories, units, preferredUnits, tz, devices, supported: { raw, buckets, generic: { prefixes: ["q","c","x"], maxTypeLength: 64, bucketPrefixes: ["q"], covered: [...] } } }`. `connected` is false once nothing has synced for 3 days; `lastUploadAt` is the last sync (the field name is frozen). `unknown_or_denied` means no sample in 14 days: iOS never tells an app about a denied read. Every stored generic type adds `{ type, category: "other", enabled, lastSampleAt, firstSampleAt, state: "ok", unit, kind: raw|buckets|both, agg? }` (listed only when it has rows, so never `stale`), and `units` carries its pinned unit. No per-type row count: status reads by index seeks only (it runs on every health question), and a count walks every row.

`PUT /api/v1/health/settings` with any of `{ "paused": bool, "sleepSourceOrder": [bundleId…] | null, "categories": ["sleep","heart","activity","vitals","workouts","mind","audio","other"], "preferredUnits": {…} }` → the settings view. A category list saved before `other` existed leaves `other` on. `sleepSourceOrder` overrides the default sleep source priority. The default follows Apple's Health doc (support.apple.com/108779, 2026-09-14: "When you add a new data source, it appears above all apps and devices that contribute data in Health"): manual entries first, then every source newest-added first, across devices and apps. HealthKit does not expose when a source was added, so Walnut uses the first time it saw the source (`sources[].firstSeenAt` in status), then the later first sample. Invalid shapes answer `400 bad_request`.

`DELETE /api/v1/health/data` with optional `{ "categories": [...] }` → `{ deleted: "all" | [...], storeId, paused: true, removed }`. Deleting `other` removes every generic row with its unit and agg pins. Any delete rotates the `storeId` and pauses syncing, so the phone's next sync answers `409 store_mismatch` instead of silently refilling what was removed. A full delete removes the database file itself.

Agent reads live on the primary's internal routes (`GET /api/health/status|sleep|daily|series|samples`, callers on this Mac only, 501 on a replica) behind the `health_status`, `health_sleep`, `health_daily`, `health_series`, `health_samples` and `day_review` ops. `health_series` takes a catalog metric or any `q.` type (raw samples fold to avg/min/max plus sum, buckets by the pinned `agg`; a covered name reads its catalog metric). `health_samples` (`GET /api/health/samples?type=&from=&to=&limit=`, limit 1 to 500, default 100, window at most 90 days, default the 90 days ending today) returns one raw type's rows newest first: `{ type, unit, tz, from, to, rows: [ { start, end, value, code, unit, source, device, tz, meta } ], truncated }`; a characteristic ignores the window. `day_review` takes `connected` from `health_status`, so a phone that stopped syncing reads as not connected with the date of its last sync, not as missing data. A session on the Mac itself may call them; every other caller is refused (the rule above). A sleep night reads `status: ok`, `in_bed_only` (In Bed samples only, as an iPhone without an Apple Watch records: bedtime, wake and `inBedMin` from the in-bed span, `asleepMin` null, plus a `caveat`), `no_main_night` (naps only) or `missing`. Sleep pieces form one night unless 60 min or more between them has no awake or in-bed record from the same source; recorded awake time inside the night counts as awake. Sleep split off that way but ending on the same wake date within 3 h of the night is reported, never joined: the night carries `unrecordedGaps: [ { side: before|after, start, end, min, unrecordedMin, otherSleepMin } ]` and a `caveat`, and that sleep stays under `naps`. Nothing in the samples tells a real wake from a recording gap (a flat Watch battery), and Apple documents no rule for joining across one, so the agent is told to say the recording has a gap rather than state that night's wake time as fact.

### Places (additive, 2026-10): `/places/sync`, `/places/status`, `/places/data`

Places is off until the user turns it on in the iPhone app (Settings, Places). From then on, and only from then on, iOS visit monitoring tells the app when the user arrives somewhere and leaves (it needs location access set to Always; iOS keeps its own location history to itself, so nothing earlier exists). The app looks up a name for each spot with Apple's geocoder and keeps the PRIMARY up to date; the PRIMARY keeps the visits in `~/.open-walnut/places/places.sqlite`. Same privacy rules as Apple Health: git-sync, the S3 backup and test-server snapshots exclude the directory, logs carry counts only (never a coordinate or a name), and every route and op is for callers on this Mac only, judged by origin (`/api/places/*` and `/api/v1/places/*` in any spelling are refused for a self-call made for someone off this Mac, with "Places data is only available to sessions on this Mac"). On a REPLICA every endpoint is a Class B relay (`server.places.sync|status|delete` over `session.control`, 10s budget) and the replica stores nothing. An API key is refused (`403`): this Mac or a paired device token only.

`POST /api/v1/places/sync` with `{ "tz": "<IANA zone>", "state": { "enabled": bool, "access": "always"|"when_in_use"|"denied"|"not_determined"|"restricted" }, "visits": [ { "id", "arrival"?, "departure"?, "lat", "lon", "accuracyM"?, "name"?, "address"? } ] }` → `{ accepted, inserted, updated, rejected }`. One visit arrives up to three times under the id the phone keeps (on arrival with no `departure`, on departure, and once its name is known); each is an upsert that never loses a field already stored. `arrival`/`departure` are ISO-8601 instants (either may be missing, not both; arrival ≤ departure); every visit in a call is read in that call's `tz`. An invalid item is counted in `rejected` and skipped. `state` alone (no visits) records where Places stands on the phone; a phone that never turned Places on leaves no store behind. At most 200 visits and 200 KB per call, else `413 too_large` (split). `503 primary_unreachable`: nothing stored, keep the visits queued. A Mac without this route answers `404`, and the phone keeps its queue.

`GET /api/v1/places/status` → `{ recording, phone: { enabled, access, reportedAt }, visitCount, firstVisitAt, lastVisitAt, lastUploadAt, tz, message? }`. `recording` is true when the phone has Places on with Always.

`DELETE /api/v1/places/data` → `{ removed }`: deletes the database file and its WAL files. The phone forgets its own copy and turns Places off.

Agent reads live on the primary's internal routes (`GET /api/places/status`, `GET /api/places/visits?last_days=&from=&to=&place=&limit=`, callers on this Mac only, 501 on a replica) behind the `places_status` and `places_visits` ops (skill `walnut-places`). Visits come back oldest first with local times in the zone of the visit, `durationMin`, and a `status` of `ended`, `ongoing` (the latest visit while the phone records: still there) or `departure_unknown` (iOS never reported the departure, and a later visit exists or recording stopped: no length is made up); `places` groups the same visits by name or within 150 m. At most 90 days per read. Every read carries a `message` for the agent when Places is off, lacks Always, or the phone has not checked in for 7 days (the phone checks in at least daily while it is used).

### Instance identity and routes (additive, 2026-09): `/instance`, `/routes`, tailnet direct access

A paired phone can reach the same Walnut at several addresses: the Mac on the Wi-Fi, the Mac over a tailnet (Tailscale, Headscale or Netbird, all in `100.64.0.0/10`), and the cloud companion. These two endpoints tell it which addresses its token works at, and let it check that an address leads to the box it expects.

`GET /api/v1/instance` needs no token, in both modes, and is GET only → `{ "instance": "<32 hex>", "mode": "LIVE" | "REPLICA" }` and nothing else. The id is 16 random bytes minted once per box and kept in that box's `auth.json` (machine-local, never synced), so it survives restarts and never moves to another box.

`GET /api/v1/routes` (device token) → `{ "routes": [ { "kind": "lan" | "tailnet" | "cloud", "origin": "http://192.168.1.20:3456", "label": "This network (Wi-Fi)", "instance": "<32 hex>" } ], "device": "<this pairing's name>" | null }`, best first (`lan`, `tailnet`, `cloud`). `instance` is the id of the box behind that origin; compare it with `/instance` there before trusting an address. Asking also makes the caller's token work on the other box ("adoption"): the box the phone is paired with copies the pairing's sha256 hash, never the token, into the other box's registry.

- On the primary: `lan` and `tailnet` on the port the request came in on, plus `cloud` once the companion has adopted the pairing.
- On a replica: `cloud` (this box), plus the primary's `lan` and `tailnet` once the primary has adopted the pairing over the bridge (`server.devices.adopt`).
- A caller with no device (an API key, the Mac's own console) gets the routes that need no adoption.
- Anything failing on the far side (no companion, a companion or primary on an older build, the bridge offline) leaves that route out. The answer is still `200`; ask again later.
- On the primary the answer also carries `tailscale: { installed, running, dnsName? }` (the same summary as the console's `GET /api/devices/tailscale`: `installed` = the Tailscale CLI is found, `running` = its backend runs, or with no answer from the CLI, this Mac has a tailnet address anyway), so the app can tell "set up Tailscale on your Mac first" from "install Tailscale on this phone". A replica forwards the summary the primary put in its adopt reply (`server.devices.adopt` over the bridge), so a phone that only reaches the cloud still gets it. Absent while the first check of the CLI is still running, when the bridge is down, and from a primary older than the field; treat a missing field as "no guidance".

Removing or re-pairing a device on either box removes its copy on the other one (`POST /api/devices/unadopt`, or `server.devices.revoke-by-hash` from a replica), in the background, so a revoked token stops working everywhere. While the other box is unreachable the removal is retried every minute for 30 minutes by the running server; a revoke made with the `walnut device` CLI does not reach the other box. The pairing that owns a companion's machine credentials (the Mac itself) is never copied or removed this way.

Box-to-box endpoints behind this (device token; a phone gets `403 phone_cannot_pair`; flat `{ error, code }` errors like the rest of `/api/devices`): `POST /api/devices/adopt` with `{ name, token_hash, id?, platform?, info? }` → `{ name, instance, adopted }`. The same hash again answers `adopted: false` and changes nothing; a name already taken by another pairing gets the first free `name-2`, `name-3` and so on, and an existing record is never replaced. `POST /api/devices/unadopt` with `{ token_hash }` → `{ name, instance, revoked }` (`name: null, revoked: false` when nothing had that hash).

Pairing a phone for the tailnet: `GET /api/devices` lists a `tailnet` entry in `targets` when this Mac has a tailnet address (`{ kind: "tailnet", origin: "http://100.x.y.z:3456", label: "Tailscale (anywhere this machine is on)" }`, or `Tailnet …` when the Tailscale CLI is not installed), and carries `tailscale: { installed, running, dnsName? }` for an install hint. The field is absent on a replica and while the first check of the CLI is still running. `POST /api/devices` with `target: "tailnet"` puts that origin in the QR's `server=`. Browser pages on a tailnet origin (a `100.64.0.0/10` address or a `*.ts.net` name) get the same CORS grant as private LAN origins; every request from them still needs a device token.

## Offline write matrix (REPLICA behavior contract, 2026-08)

This section is the contract the iOS optimistic-mutation layer relies on. It answers, per mutation family: what happens on the cloud REPLICA, what happens while the Mac (primary) is unreachable, and how the two stores converge afterward. General model:

- **Class A (local-store + outbox)**: the replica has a real local task store: an exact copy of the primary's (docs/plan/walnut-control-plane.md "The companion's copy of the tasks"; an older primary seeds it from the pushed projection instead). The mutation applies to that store, the route answers from it immediately, and a background op rides the `server.tasks.apply` bridge RPC to the primary; when the bridge is down the op banks in a durable disk queue (`cache/task-queue/`) and drains on reconnect, on the next successful RPC, and on a 60s sweep. Mac asleep or offline never blocks or fails the write.
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
| Task PATCH (title/description/status/phase/wait_until/priority/due_date/start_date/end_date/project/tags/unread) | Class A: 200 with the updated row | accepted; op queued | LWW + `touched` scoping; project move mints the registry row; status→phase derivation runs on the primary too. Both calendar dates are in the op update whitelist, and a `touched` date absent from the snapshot is the explicit clear, so a phone-side reschedule or "off the calendar" reaches the primary intact |
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
| Session lifecycle: terminate / restart / retry / recheck / permission / execute-continue, model / effort / fork, session launch, messages into a session | Class B relays (messages ride their own durable `session.message` relay; see Session talk) | honest `503 bridge_offline` (messages: still accepted durably by the daemon lane when the daemon is reachable) | these act on a live process; fabricating acceptance would lie about the session's real state |
| Start a session for a task (`POST /tasks/:id/start`), send by handle (`POST /messages`) | Class C: `501 not_supported_cloud` | n/a | both need the primary's session-runner, daemons, and request ledger; the phone's own lanes are `POST /sessions` and `POST /sessions/:id/messages`, which relay over the bridge |
| Notes vault writes (create/update/delete, global notes, tag rename, folder/attachment deletes) | Class A-like: the vault is git-synced data; writes land locally | accepted | git-sync merge on reconnect; optimistic-lock hashes (`expectedHash`) protect against cross-box conflicts |
| Time heartbeats (`POST /time/heartbeats`) | Class B relay: `204` only once the primary persisted the batch | `503 primary_unreachable`, so the client keeps the batch queued and retries | the primary is the single writer AND the only box that may assign a sample's local day; nothing is ever banked on the replica. Retries are safe because the primary dedupes on each sample's `id` (exactly-once in the rollup; a known-failed day-file write is retried, so the disk is at-least-once) |
| Apple Health (`POST /health/sync`, `GET /health/status`, `PUT /health/settings`, `DELETE /health/data`) | Class B relay: `200` only once the primary's SQLite transaction committed; `409 store_mismatch` and `413 too_large` pass through unchanged | `503 primary_unreachable`, so the phone keeps the batch queued and retries | the primary is the single writer and the replica keeps nothing (no store, no queue). Retries are safe: raw rows dedupe by HealthKit `uuid`, buckets replace by key, and resync sweeps only on a matching `end` |

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
