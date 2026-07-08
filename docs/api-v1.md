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
| `too_large` | 413 | Note content exceeds 2 MB |
| `internal` | 500 | Unhandled server error |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/status` | Server mode/version/time/sync info |
| GET | `/api/v1/conversations?limit=` | List conversations, most-recent first |
| POST | `/api/v1/conversations` | Create a conversation |
| GET | `/api/v1/conversations/:id/messages?limit=&before=` | Read normalized messages |
| POST | `/api/v1/conversations/:id/messages` | Send a message (starts an agent turn) |
| GET | `/api/v1/conversations/:id/stream` | SSE stream of the current turn |
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

### GET /api/v1/conversations?limit=50

Array, most-recent first:

```json
[ { "id": "conv-…", "title": "Weekend Travel", "updatedAt": "…", "messageCount": 12 } ]
```

`title` is omitted while a conversation is still untitled. `limit` defaults to 50 (max 200).

### POST /api/v1/conversations

Body (optional): `{ "title": "My thread" }` → `201 { "id": "conv-…" }`

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

- `kind: "tool"` — a tool call; `text` is the tool name.
- `kind: "thinking"` — a reasoning step; `text` is a short (≤160 char) excerpt.
- No `kind` — a plain chat message.
- Paging: pass the **first** (oldest) message's `id` of the current page as
  `before` to fetch the previous page. Cursors are positional and ephemeral —
  history compaction can rewrite them, so on a suspicious result just re-fetch
  the tail (no `before`).
- `404` with `code: "not_found"` for an unknown conversation id.

### POST /api/v1/conversations/:id/messages

Body: `{ "text": "your message" }`

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
