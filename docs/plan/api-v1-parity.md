# API v1 Parity Plan — "Everything the Mac console can do, the phone can do"

Goal: give `/api/v1` (the frozen, mobile-facing surface) a 1:1 mapping of the internal `/api` console surface, so the iOS app can reach full web-console capability. This document is the full inventory: every internal endpoint, its v1 equivalent (or gap), a cloud-replica feasibility class, and a wave-by-wave implementation plan.

## Executive summary

- Internal console REST surface: **267 endpoints across 46 route files** (plus 16 WebSocket RPC methods that have no REST twin).
- Existing v1 surface: **29 endpoints** (api-v1.ts 16, session-stream 2, session-launch 2, session-control 4, events 1, stt 1, media 1, setup 2) — roughly **11% coverage**, concentrated on chat, task read/write, session talk/launch/control, notes CRUD, and the events feed.
- Gap classes: **A** = local/git-synced data, implement directly on both boxes; **B** = needs primary-box live state, relay over the established `/bridge` `session.control`-style narrow commands; **C** = primary-only, v1 answers directly on the primary and returns `503 bridge_offline`-style degradation (or explicit `501 not_supported_cloud`) on the replica; **D** = deliberately excluded from mobile (dangerous, dev-only, or meaningless off-box) — every D row states why.
- Proposed waves: **Wave 1 ≈ 38 endpoints (effort L)** — the high-frequency console actions (task field edits/pin/star/reorder/delete, session terminate/restart/retry/archive/permission, conversation manage, search, memory, notifications). **Wave 2 ≈ 52 endpoints (effort L)** — routines/cron, config read, usage, favorites, projects, focus tiers, file browsing, session controls/side-questions. **Wave 3 ≈ 58 endpoints (effort M)** — long tail (agents, commands, skills write, calendar, timeline, incidents, heartbeat, repositories). **Explicit D-class exclusions ≈ 45 endpoints.**
- A surprising finding: the iOS app **already calls four non-v1 internal endpoints** (`/api/favorites`, `/api/favorites/notes`, `/api/notes-v2/search`, `/api/notes-v2/attachment`) — the frozen-contract boundary has already leaked; Wave 1 should formalize these as v1 endpoints and migrate the app.

## Method

- Internal surface enumerated from `src/web/routes/*.ts` (`router.<method>(path)`), mount prefixes from `src/web/server.ts:800-879`.
- Web-UI usage attributed via `web/src/api/*` call layer (coarse-grained).
- v1 baseline: `src/web/routes/api-v1.ts`, `session-{stream,launch,control}-v1.ts`, `events-v1.ts`, `stt-v1.ts`, `media-v1.ts`, `setup.ts`, contract doc `docs/reference/api-v1.md`.
- v1 is frozen: **additive only**. Existing v1 endpoint shapes never change; every new endpoint uses the `{ "error": { "code", "message" } }` error shape.

## Legend

- **v1?**: ✅ = exists, ◐ = partial equivalent exists (noted), ✗ = none.
- **Class**: A local data / B bridge relay / C primary-only / D excluded.
- **Wave**: 1, 2, 3, or `—` (excluded / already shipped).
- **Status (2026-08): all three waves are SHIPPED.** A `1`/`2`/`3` in a Wave column now reads as "implemented in that wave"; the sole in-flight exception during Wave 3 was calendar, which was excluded instead (see its section). Final tallies: "Final coverage record" at the bottom.

---

## Gap matrix

### tasks.ts (`/api/tasks`) — 27 endpoints — source: task store (SQLite-backed JSON) — Class A throughout

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/` | task lists everywhere | R | ◐ `GET /v1/tasks` (slim projection, no filters/pagination parity) | 1 (extend additively: `project=`, `tag=`, `q=` filters) |
| GET `/meta/tags` | tag filter chips | R | ✗ | 2 |
| GET `/meta/sprints` | sprint filter | R | ✗ | 3 |
| GET `/enriched` | dashboard task cards | R | ✗ (compose client-side from /tasks + /sessions) | 3 |
| GET `/groups` | task groups UI | R | ✗ | 2 |
| POST `/quick-parse` | NL quick-add parse | W (stateless) | ✗ | 2 |
| GET `/:id` | task detail view | R | ✗ (list projection only; detail carries full description/notes/deps) | 1 |
| POST `/` | quick add | W | ✅ `POST /v1/tasks` | — |
| PATCH `/reorder` | drag reorder | W | ✗ | 1 |
| POST `/batch/phase` | multi-select complete | W | ✗ | 1 |
| POST `/batch/delete` | multi-select delete | W | ✗ | 1 |
| POST `/groups` | create group | W | ✗ | 2 |
| POST `/groups/:groupId/add` | group membership | W | ✗ | 2 |
| POST `/groups/remove` | group membership | W | ✗ | 2 |
| PATCH `/groups/:groupId` | rename group | W | ✗ | 2 |
| PATCH `/groups/:groupId/hidden` | collapse group | W | ✗ | 2 |
| PATCH `/:id` | inline edits | W | ✅ `PATCH /v1/tasks/:id` (subset: status/priority/due_date/project/title/description — missing start_date, tags, phase) | 1 (additive fields) |
| POST `/:id/complete` | check-off | W | ◐ via PATCH status | — (PATCH covers it) |
| POST `/:id/toggle-complete` | check-off | W | ◐ via PATCH status | — |
| POST `/:id/star` | star toggle | W | ✗ | 1 |
| DELETE `/:id` | delete task | W | ✗ | 1 |
| POST `/:id/notes` | append timestamped note | W | ✗ | 1 |
| PUT `/:id/note` | edit human note | W | ✗ | 1 |
| PUT `/:id/description` | edit description | W | ✗ (PATCH description is write-only; PUT + readback needed) | 1 |
| PUT `/:id/summary` | edit summary | W | ✗ | 1 |
| PUT `/:id/depends-on` | dependency editor | W | ✗ | 1 |

Replica note: all task writes ride the existing task outbox → git-sync → primary path already proven by `POST/PATCH /v1/tasks`.

### sessions.ts (`/api/sessions`) — 38 endpoints — source: session tracker + daemon/CLI — Class B unless noted

| Method+Path | Web UI use | R/W | v1? | Class | Wave |
|---|---|---|---|---|---|
| GET `/working-dirs` | launcher suggestions | R | ✅ `GET /v1/sessions/launch-options` (dirs) | B | — |
| POST `/working-dirs/recompile` | dev tool: rebuild dir cache | W | ✗ | D — dev-only maintenance action, meaningless on a phone | — |
| GET `/list-dirs` | path picker (browse a host dir) | R | ✗ | B | 2 |
| POST `/quick-start` | Quick Start launcher | W | ✅ `POST /v1/sessions` | B | — |
| GET `/` | session columns | R | ◐ `GET /v1/sessions` (slim projection) | A (projection) | — |
| GET `/recent` | recent sessions | R | ◐ (filter client-side) | A | 3 |
| GET `/summaries` | session summaries | R | ◐ (`description` in projection) | A | 3 |
| GET `/host-model-catalogs` | model picker warm cache | R | ◐ per-session `model-options` | B | — |
| GET `/status` | poll statuses | R | ✅ events feed / projection | A | — |
| GET `/task/:taskId` | task→session link | R | ◐ (client-side via projection `task_id`) | A | — |
| GET `/:sessionId/vscode-uri` | "open in VS Code" | R | ✗ | D — desktop-only deep link, no phone target | — |
| GET `/:sessionId` | session detail | R | ◐ projection row only | A | 1 (detail: full description, queue, model/effort/mode, host, cwd) |
| GET `/:sessionId/controls` | provider controls (mode, Codex controls) | R | ✗ | B | 2 |
| POST `/:sessionId/controls` | apply control (mode switch) | W | ✗ | B | 2 |
| PATCH `/:sessionId` | rename / archive / human note / mode | W | ✗ | B | 1 |
| GET `/:sessionId/history` | chat timeline (rich blocks) | R | ◐ `transcript` (slim tail) + `stream` SSE | B | 1 (paged rich history: blocks with tool detail/results, subagent lanes) |
| GET `/:sessionId/subagent/:agentId/history` | subagent lane expand | R | ✗ | B | 2 |
| GET `/:sessionId/workflow` | plan/workflow view | R | ✗ | B | 2 |
| GET `/:sessionId/changes` | Changed-files tab | R | ✗ | B | 1 |
| GET `/:sessionId/plan` | plan card | R | ✗ | B | 2 |
| POST `/:sessionId/execute-continue` | "Continue" button | W | ✗ | B | 1 |
| POST `/:sessionId/permission` | permission prompt respond | W | ✗ | B | 1 — top mobile use case (approve/deny from phone) |
| POST `/:sessionId/effort` | effort switch | W | ✅ v1 | B | — |
| POST `/:sessionId/model` | model switch | W | ✅ v1 | B | — |
| GET `/:sessionId/model-catalog` | picker catalog | R | ✅ `model-options` | B | — |
| GET `/:sessionId/models` | legacy catalog | R | ✅ `model-options` | B | — |
| GET `/:sessionId/settings` | session settings sheet | R | ✗ | B | 2 |
| GET `/:sessionId/side-questions` | side-question drawer | R | ✗ | B | 2 |
| POST `/:sessionId/side-question` | ask side question | W | ✗ | B | 2 |
| POST `/:sessionId/side-question/:id/promote` | promote to main | W | ✗ | B | 2 |
| DELETE `/:sessionId/side-question/:id` | discard | W | ✗ | B | 2 |
| POST `/:sessionId/execute-compact` | manual compaction | W | ✗ | B | 2 |
| POST `/:sessionId/execute` | send message (web path) | W | ✅ `POST /v1/sessions/:id/messages` | B | — |
| POST `/:sessionId/retry` | retry failed turn | W | ✗ | B | 1 |
| POST `/:sessionId/restart` | restart dead CLI | W | ✗ | B | 1 — pairs with the documented "wake it from your desktop" gap; closes it |
| POST `/:sessionId/terminate` | stop session | W | ✗ | B | 1 |
| POST `/:sessionId/fork` | fork session | W | ✅ v1 | B | — |

Replica note: all Wave-1/2 B rows reuse the `session.control` relay pattern (narrow allowlisted daemon command, primary runs the same core, verbatim error passthrough). `restart`/`terminate`/`retry`/`permission` need one new allowlisted relay command family, not per-endpoint plumbing.

### api-v1.ts + conversations.ts + chat-history.ts: Personal AI chat

| Method+Path | Web UI use | R/W | v1? | Class | Wave |
|---|---|---|---|---|---|
| GET `/api/agents/:agentId/conversations` | thread list | R | ✅ `GET /v1/conversations` | A | — |
| POST `/api/agents/:agentId/conversations` | new thread | W | ✅ | A | — |
| PUT `/api/agents/:agentId/conversations/active` | switch active thread | W | ✗ | A | 2 (or client-local; server active-pointer matters for cron/notification routing) |
| PATCH `/api/agents/:agentId/conversations/:cid` | rename thread | W | ✗ | A | 1 |
| DELETE `/api/agents/:agentId/conversations/:cid` | delete thread | W | ✗ | A | 1 |
| GET `/api/chat/history` | load messages | R | ✅ `GET /v1/conversations/:id/messages` | A | — |
| GET `/api/chat/stats` | context % indicator | R | ✗ | A | 2 |
| GET `/api/chat/triage` | triage feed (dev) | R | ✗ | D — developer diagnostics view | — |
| POST `/api/chat/clear` | clear conversation | W | ✗ | A | 2 |
| POST `/api/chat/compact` | manual compaction | W | ✗ | A | 3 |
| WS `chat` / `chat:stop` / `chat:answer-question` | send / stop / answer form | W | ◐ send=✅ `POST messages`; **stop=✗; answer-question=✗** | A | 1 (`POST /v1/conversations/:id/stop`, `POST /v1/conversations/:id/answer`) |

### agents.ts (`/api/agents`) — 9 endpoints — Class A (config files)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/meta/tools` | agent editor | R | ✗ | 3 |
| GET `/meta/skills` | agent editor | R | ✗ | 3 |
| GET `/meta/models` | agent editor | R | ✗ | 3 |
| GET `/` | agent list | R | ✅ `GET /v1/agents` (slim) | — |
| GET `/:id` | agent detail/editor | R | ✗ | 3 |
| POST `/` | create agent | W | ✗ | 3 |
| PATCH `/:id` | edit agent | W | ✗ | 3 |
| DELETE `/:id` | delete agent | W | ✗ | 3 |
| POST `/:id/clone` | clone agent | W | ✗ | 3 |

### notes.ts + notes-v2.ts (`/api/notes`, `/api/notes-v2`) — 26 endpoints — Class A (git-synced vault)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| notes.ts GET/PUT `/global` | global scratch note | R/W | ✗ | 2 |
| GET `/notes-v2/` | tree | R | ✅ `GET /v1/notes` | — |
| GET `/notes-v2/attachment` | inline attachments | R | ✗ — **iOS already calls the internal path** | 1 (formalize as `GET /v1/notes/attachment`) |
| POST `/notes-v2/reveal` | Finder/VS Code reveal | W | ✗ | D — desktop-only action (route itself rejects cloud mode) | 
| POST `/notes-v2/attachment` | upload attachment | W | ✗ — iOS calls internal path | 1 |
| GET `/notes-v2/content/*path` | read note | R | ✅ | — |
| PUT `/notes-v2/content/*path` | write note | W | ✅ | — |
| DELETE `/notes-v2/content/*path` | delete note | W | ✅ `DELETE /v1/notes/*path` | — |
| DELETE `/notes-v2/attachment/*path` | delete attachment | W | ✗ | 2 |
| DELETE `/notes-v2/folder/*path` | delete folder | W | ✗ | 2 |
| POST `/notes-v2/move` | move/rename | W | ✗ | 1 |
| GET `/notes-v2/search` | notes search | R | ✗ — **iOS already calls the internal path** | 1 (`GET /v1/notes/search`) |
| GET `/notes-v2/backlinks/*path` | backlinks panel | R | ✗ | 2 |
| GET `/notes-v2/links/*path` | outlinks | R | ✗ | 2 |
| POST `/notes-v2/folder` | create folder | W | ✗ | 1 |
| GET `/notes-v2/list` | flat list | R | ◐ tree covers it | 3 |
| GET `/notes-v2/tags` | tag browser | R | ✗ | 2 |
| GET `/notes-v2/tags/:tag/notes` | tag browser | R | ✗ | 2 |
| POST `/notes-v2/tags/rename` | tag rename | W | ✗ | 3 |
| GET `/notes-v2/index/status` | index health (dev) | R | ✗ | D — index maintenance is a server admin concern | — |
| POST `/notes-v2/index/{rebuild,stamp-ids,merge-ids}` (3) | index maintenance | W | ✗ | D — same reason | — |

### memory.ts (`/api/memory`) — 8 endpoints — Class A (files, git-synced)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/browse` | memory browser | R | ✗ | 1 |
| GET `/global` / PUT `/global` | edit MEMORY.md | R/W | ✗ | 1 |
| GET `/user` / PUT `/user` | edit user memory | R/W | ✗ | 1 |
| GET `/telemetry` | memory health (dev) | R | ✗ | 3 |
| GET `/` | memory list | R | ✗ | 1 |
| POST `/daily-log/compact` | compact daily log | W | ✗ | 3 |

### search.ts + qmd.ts (`/api/search`, `/api/qmd`)

| Method+Path | Web UI use | R/W | v1? | Class | Wave |
|---|---|---|---|---|---|
| GET `/api/search` | global search bar (tasks/memory/sessions) | R | ✗ | A on primary; C on replica until the qmd index syncs (start C: primary-direct, `501` on replica) | 1 |
| GET `/api/qmd/status` | search settings | R | ✗ | C | 3 |
| POST `/api/qmd/download` | install search binary | W | ✗ | D — host software management | — |
| POST `/api/qmd/reindex` | rebuild index | W | ✗ | D — admin maintenance | — |
| POST `/api/qmd/rebuild-history` | rebuild history index | W | ✗ | D — admin maintenance | — |

### notifications.ts (`/api/notifications`) — 3 endpoints — Class A (durable store; replica gap: store lives on primary, so B-relay or ride git-sync — recommend relay, notifications are latency-sensitive)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/` | notification center | R | ✗ (push exists via APNs, but no pull feed) | 1 |
| POST `/mark-read` | badge clear | W | ✗ | 1 |
| POST `/dismiss` | dismiss | W | ✗ | 1 |

### cron.ts (`/api/routines`, alias `/api/cron`) — 11 endpoints — Class A config + B for run-now

| Method+Path | Web UI use | R/W | v1? | Class | Wave |
|---|---|---|---|---|---|
| GET `/` | routines list | R | ✗ | A | 2 |
| GET `/actions` | action catalog | R | ✗ | A | 2 |
| GET `/status` | engine status | R | ✗ | C | 2 |
| GET `/executors` | executor list | R | ✗ | A | 2 |
| POST `/draft` | NL → routine draft (LLM) | W | ✗ | B (needs primary's model creds) | 3 |
| GET `/:id` | routine detail | R | ✗ | A | 2 |
| POST `/` | create routine | W | ✗ | A/B | 2 |
| PATCH `/:id` | edit routine | W | ✗ | A/B | 2 |
| DELETE `/:id` | delete routine | W | ✗ | A/B | 2 |
| POST `/:id/toggle` | enable/disable | W | ✗ | A/B | 2 — high-value mobile action |
| POST `/:id/run` | run now | W | ✗ | B | 2 |

### config.ts (`/api/config`) — 7 endpoints

| Method+Path | Web UI use | R/W | v1? | Class | Wave |
|---|---|---|---|---|---|
| GET `/` | settings screen | R | ✗ | C (redacted read-only projection only) | 2 |
| POST `/test-connection` | onboarding | W | ✗ | D — credential onboarding stays desktop | — |
| GET `/aws-profiles` | onboarding | R | ✗ | D — same | — |
| GET `/credential-trace` | debugging | R | ✗ | D — leaks credential provenance | — |
| GET `/providers` | settings | R | ✗ | C | 3 |
| POST `/test-provider` | settings | W | ✗ | D | — |
| PUT `/` | write config | W | ✗ | D — full config write from a phone is a foot-gun; per-feature endpoints (routines toggle, focus tiers) cover the safe subset | — |

### usage.ts (`/api/usage`) — 8 endpoints — Class C (usage DB lives on primary; small read-only relay acceptable later, start primary-direct)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/overview` `/summary` `/daily` `/by-source` `/by-model` `/by-agent` `/recent` `/pricing` | usage dashboard | R | ✗ | 2 (one composite `GET /v1/usage/overview` first; rest 3) |

### projects.ts + ordering.ts + favorites.ts + focus.ts — Class A

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/api/projects` | project pickers/boards | R | ✗ | 2 |
| POST `/api/projects` | create project | W | ✗ | 2 |
| PATCH `/api/projects/:name` | rename | W | ✗ | 2 |
| DELETE `/api/projects/:name` | cascade delete | W | ✗ | 2 |
| GET/PUT `/api/projects/:name/metadata` | project memory page | R/W | ✗ | 3 |
| POST `/api/projects/:name/summary/regenerate` | AI summary | W | ✗ | 3 (B: needs model creds) |
| GET `/api/ordering` / PUT `/api/ordering/projects` | project order | R/W | ✗ | 2 |
| GET `/api/favorites` | favorites strip | R | ✗ — **iOS already calls internal path** | 1 (formalize `GET /v1/favorites`) |
| POST/DELETE `/api/favorites/projects/:name` | fav project | W | ✗ | 2 |
| POST/DELETE `/api/favorites/notes` | fav note | W | ✗ — iOS calls internal path | 1 |
| GET `/api/focus/tasks` | pinned bar | R | ◐ (`pinned`/`focus_tier` in projections, read-only) | 1 |
| POST/DELETE `/api/focus/tasks/:id` | pin/unpin | W | ✗ | 1 |
| PUT `/api/focus/reorder` | pin order | W | ✗ | 1 |
| PUT `/api/focus/tasks/:id/tier` | move tier | W | ✗ | 1 |
| GET `/api/focus/tiers` | tier defs | R | ✗ | 1 |
| POST/PUT/DELETE `/api/focus/tiers*` (3) | custom tier CRUD | W | ✗ | 2 |

### files.ts + file-content.ts + local-image.ts + images.ts — Class B (daemon fs channel already exists)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/api/files/list` | session file explorer | R | ✗ | 2 |
| GET `/api/files/resolve-path` | path linkifier | R | ✗ | 2 |
| POST `/api/files/record-dir` / GET `/recent-dirs` | launcher history | W/R | ◐ launch-options `dirs` | 3 |
| GET `/api/file-content` | file viewer overlay | R | ✗ | 1 — needed the moment mobile renders clickable paths in transcripts |
| GET `/api/local-image` | transcript images | R | ✅ `GET /v1/media` | — |
| POST `/api/images/upload` | chat image attach | W | ✅ inline `images[]` on both message endpoints | — |
| GET `/api/images/:filename` | render uploaded image | R | ◐ `GET /v1/media?path=` covers by absolute path | — |

### skills.ts + commands.ts + slash-commands.ts — Class A (files) / B (remote palette)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/api/skills` / GET `/:dirName` | skills manager | R | ✗ | 2 |
| POST/PUT/PATCH/DELETE `/api/skills*` (4) | skills editing | W | ✗ | 3 |
| GET `/:dirName/references`, `/:dirName/references/:file` | skill refs | R | ✗ | 3 |
| GET `/api/commands` + CRUD (5) | command templates | R/W | ✗ | 3 |
| GET `/api/slash-commands?host=` | composer palette | R | ✗ | 2 (B for remote hosts) |

### calendar.ts (`/api/calendar`) — 7 endpoints — Class D (DECIDED Wave 3: iOS uses native EventKit; excluded from v1)

| Method+Path | Web UI use | R/W | v1? | Wave |
|---|---|---|---|---|
| GET `/events`, GET `/sources` | calendar view | R | ✗ | — (excluded) |
| PUT `/sources/eventkit`, POST `/refresh` | calendar settings | W | ✗ | — (excluded) |
| PATCH/POST/DELETE `/events*` (3) | event edit | W | ✗ | — (excluded) |

Decision (Wave 3, 2026-08): the phone already holds its own system calendar permission and EventKit gives it the SAME calendars natively (read/write, offline, with OS-level UI). Routing calendar traffic Mac-ward through v1 would be a strictly worse copy — an extra network hop, a replica that can never answer (EventKit is macOS-process-local, so every replica response would be 501), and a second write path racing the phone's native one. All 7 endpoints move to the exclusion table; iOS integrates EventKit directly.

### timeline.ts + heartbeat.ts + dashboard.ts + context-inspector.ts + incidents.ts + bug-report.ts

| Method+Path | Web UI use | R/W | v1? | Class | Wave |
|---|---|---|---|---|---|
| GET `/api/timeline`, `/dates`, `/images/:date/:file` | Life Tracker view | R | ✗ | C (local files) | 3 |
| POST `/api/timeline/toggle` | enable tracker cron | W | ✗ | C | 3 |
| GET `/api/heartbeat`, `/checklist` | heartbeat status | R | ✗ | C | 3 |
| POST `/api/heartbeat/trigger`, PUT `/checklist` | heartbeat ops | W | ✗ | C | 3 |
| GET `/api/dashboard` | home aggregates | R | ✗ | C — aggregation of local stores; phone composes from v1 lists instead; explicit non-goal | — |
| GET `/api/context` | context inspector (dev) | R | ✗ | D — developer debugging surface | — |
| GET `/api/incidents` + 3 more | forensics panel | R/W | ✗ | D — incident forensics is an operator/desktop workflow | — |
| GET `/api/bug-report` | diagnostics bundle | R | ✗ | D — bundle names hosts + credential provenance; keep off mobile | — |

### stt.ts + stt-v1.ts + audio.ts

| Method+Path | Web UI use | R/W | v1? | Class | Wave |
|---|---|---|---|---|---|
| POST `/api/stt/transcribe` | web mic | W | ✅ `POST /v1/stt/transcribe` | B (routes primary/bridge/openai) | — |
| GET `/api/stt/vocab` / POST `/vocab` | custom vocabulary | R/W | ✗ | A | 3 |
| GET `/api/stt/status` `/detect` `/recordings` + model mgmt (9) | STT setup/admin | R/W | ✗ | D — host model management is desktop admin | — |
| audio.ts all 6 (`/api/audio/*`) | Mac system-audio capture | R/W | ✗ | D — records the MAC's audio; phone has its own mic path via stt | — |

### Infrastructure / auth / device plumbing — Class D or already v1

| Method+Path | Purpose | Disposition |
|---|---|---|
| setup.ts GET `/v1/setup/status`, POST `/v1/setup/claim` | device claim | already v1 ✅ |
| POST `/v1/devices/self` | device self-report | already v1 ✅ |
| devices.ts GET/POST/DELETE `/api/devices*` (3) | device admin + QR mint | D — pairing administration stays on the console (security boundary) |
| auth.ts `/api/auth/keys` (3) | API key CRUD | D — key management from a phone defeats the token model |
| push.ts `/api/push/*` (3) | push token registry | D as-is (legacy surface); iOS push registration should be folded into `POST /v1/devices/self` additively if mobile push tokens move here |
| git-http.ts (3) | git-sync data plane (`/git/data`, not under `/api`) | D — machine-to-machine channel |
| browser-logs.ts POST (1) | browser console forwarder | D — `POST /v1/client-logs` is the mobile equivalent ✅ |
| client-evidence.ts POST (1) | web divergence recorder | D — web-client-specific forensics |
| plugin-sources.ts (5) | plugin install/update | D — code installation from mobile is out of scope |
| integrations.ts GET ×2 | plugin metadata/settings | C, Wave 3 read-only |
| repositories.ts (4) | repo YAML profiles | A, Wave 3 |
| ui-prefs.ts GET/PUT | web layout persistence | D — web-layout-specific keys; iOS keeps its own prefs (a future shared-prefs namespace would be a NEW design, not parity) |
| system.ts GET `/api/system/health` | health probe | ◐ `GET /v1/status` covers mobile's need — no action |
| events-v1/media-v1/session-*-v1 | v1 plumbing | already v1 ✅ |

### WebSocket RPC methods without REST twins (16)

`chat`, `chat:stop`, `chat:answer-question`, `session:start/send/get-queue/edit-queued/delete-queued`, `session:stream-subscribe`, `session:team-*` (4), `auth`, `set-interest`, `browser:logs`.

- Covered by v1 already: `chat` (POST messages), `session:start` (POST /sessions), `session:send` (POST /sessions/:id/messages), streaming (SSE).
- Wave 1: `chat:stop`, `chat:answer-question` (Personal AI form answers; mobile currently cannot answer agent questions at all).
- Wave 2: queue management (`session:get-queue`/`edit-queued`/`delete-queued`) as `GET/PATCH/DELETE /v1/sessions/:id/queue*` — the web's queued-message editing.
- Wave 3: team-agent subscriptions (fold into the session SSE stream as additive events).

---

## Wave plan

### Wave 1 — high-frequency console actions (~38 endpoints, effort L, ~2–3 sessions of work)

Theme: everything a user does daily on the console that the phone cannot do today.

1. **Tasks (13)**: `GET /v1/tasks/:id`, `DELETE /v1/tasks/:id`, `POST /v1/tasks/:id/star`, `PUT note|description|summary|depends-on` (4), `POST /v1/tasks/:id/notes`, `PATCH /v1/tasks/reorder`, `POST /v1/tasks/batch/phase|delete` (2), additive PATCH fields (`start_date`, `tags`), additive GET filters. Class A; replica via existing outbox.
2. **Focus/pin (6)**: pin/unpin/reorder/tier-move + tier list read. Class A.
3. **Session control (7)**: `PATCH /v1/sessions/:id` (title/archive/mode/human_note), `POST terminate|restart|retry|permission|execute-continue` (5), `GET /v1/sessions/:id/changes`. Class B — one new `session.control` relay command family. `permission` and `restart` are the two single highest-value mobile actions (approve a tool prompt / wake a dead session from the phone — the latter removes a documented v1 gap).
4. **Rich history (1)**: `GET /v1/sessions/:id/history` (paged rich blocks; supersedes transcript's 100-row tail for full parity chat rendering). Class B.
5. **Personal AI chat manage (4)**: PATCH/DELETE conversation, `POST /v1/conversations/:id/stop`, `POST /v1/conversations/:id/answer`. Class A.
6. **Search (2)**: `GET /v1/search` (tasks/memory/sessions), `GET /v1/notes/search`. Class C-then-A on replica.
7. **Memory (5)**: browse/list + global/user read/write. Class A.
8. **Notifications (3)**: feed + mark-read + dismiss. Class B relay (store on primary) or projection export — decide at design time; recommend relay for freshness.
9. **Formalize the iOS contract leaks (4→v1)**: `GET /v1/favorites`, `POST/DELETE /v1/favorites/notes`, `GET/POST /v1/notes/attachment`, plus `POST /v1/notes/move` + `POST /v1/notes/folder` while touching notes.

### Wave 2 — secondary frequency (~52 endpoints, effort L)

Routines/cron (11), config read-only projection (1), usage overview (1 composite), favorites projects (2), projects CRUD + ordering (6), focus tier CRUD (3), task groups + meta/tags + quick-parse (8), files list/resolve + file-content (3), slash-commands palette (1), skills read (2), session controls GET/POST + settings + side-questions (7) + subagent history + workflow + plan (3) + execute-compact (1) + queue RPC→REST (3), notes global/backlinks/links/tags/attachment-delete/folder-delete (7), conversations active pointer + chat stats/clear (3).

### Wave 3 — long tail (SHIPPED 2026-08 — 59 endpoints implemented, calendar's 7 excluded)

Shipped: agents meta ×3 + detail/create/patch/delete/clone ×5 (8), commands (5), skills write + references (6), repositories (4), integrations read (2), routines NL draft (1 — confirmed a thin core passthrough, one LLM call; replica relays `server.routines.draft`), timeline (4), heartbeat + checklist (4), memory telemetry + compact (2), usage detail breakdowns + pricing (7), config providers read (1), qmd status (1), stt vocab (2), chat compact (1), notes list/tags-rename (2), sessions recent/summaries (2), tasks enriched/sprints (2), files record-dir/recent-dirs (2), project metadata GET/PUT + summary regenerate (3), plus a fix for a latent Wave-2 route-shadowing bug (`/tasks/groups` was swallowed by `GET /tasks/:id`).

Decisions recorded during implementation:
- **calendar (7) → excluded** (see the calendar.ts section above — iOS uses native EventKit).
- **`key_hint` stripped** from `GET /v1/config/providers` — even a last-4 key fragment doesn't belong at the paired-device trust level (test-pinned).
- **skills scope rule**: v1 writes only the Walnut-managed skills dir; the Claude CLI's own global store is read-only through v1 (`403 forbidden` on update/delete; enable/disable allowed since it only touches Walnut's settings file).
- **agent writes = 501 on a replica**: agent definitions live in the machine-local config.yaml (never git-synced), so replica writes would silently diverge.
- **stt vocab `path` field dropped** from the v1 response (absolute host path).

### Explicitly excluded (Class D, ~52 endpoints — restated reasons)

Dev/admin maintenance (`working-dirs/recompile`, notes index ops, qmd download/reindex/rebuild, stt model management, plugin-sources), desktop-only actions (`vscode-uri`, notes `reveal`, audio capture of the Mac), **calendar (7 — iOS uses native EventKit; see the calendar.ts section)**, security boundaries (auth key CRUD, device admin/QR mint, config write/test/credential-trace, bug-report bundle), web-client-specific plumbing (browser-logs, client-evidence, ui-prefs), machine-to-machine channels (git-http), developer diagnostics (context inspector, chat triage, incidents forensics), and `dashboard` (phone composes its home from v1 lists — a server aggregate would duplicate the events feed).

---

## Final coverage record (all three waves shipped, 2026-08)

| Bucket | Endpoints | Notes |
|---|---|---|
| Internal console surface (baseline) | 267 | 46 route files, enumerated in the gap matrix |
| Already v1 before the plan | 29 | chat, task R/W, session talk/launch/control, notes CRUD, events |
| Wave 1 shipped | ~40 | task edits/batch, focus, session control + rich history, Personal AI manage, search, memory, notifications, iOS leak formalization |
| Wave 2 shipped | ~52 | routines, config read, usage overview, projects + ordering + favorites, focus tiers, groups, files, slash-commands, skills read, session controls/side-questions/queue, notes extras, conversations active + chat stats/clear |
| Wave 3 shipped | 59 | this wave — see above |
| **Total v1 surface** | **~180 endpoints** | ~67% of the internal surface, 100% of the phone-meaningful surface |
| Excluded (Class D, deliberate) | ~52 | dangerous / desktop-only / web-plumbing / calendar→EventKit — every row states why |
| Remaining (unplanned) | ~35 | rows the matrix maps to an existing v1 equivalent (◐/✅ dispositions) or WS-only plumbing; no open TODO rows remain |

Every Wave-3 endpoint's replica class is documented per-row in `docs/reference/api-v1.md` (the contract doc); the plan is now a historical record.

---

## 1:1 naming and shape conventions (make implementation mechanical)

1. **Path rule**: `/api/<segment>` → `/api/v1/<segment>` verbatim, including verbs-as-subpaths (`/api/tasks/:id/star` → `/api/v1/tasks/:id/star`). Exceptions only where v1 already claimed the name with a different shape — then the new endpoint keeps the internal subpath and the OLD v1 endpoint stays frozen (e.g. rich history lands at `/v1/sessions/:id/history`; `transcript` remains untouched).
2. **Canonical names win**: internal aliases are not duplicated — `/api/routines` (not `/api/cron`) maps to `/v1/routines`; `/api/notes-v2/*` maps to `/v1/notes/*` (v1 already established that namespace).
3. **Methods and status codes**: preserve the internal method; success shapes copy the internal response body unless it leaks internals (hosts, absolute paths outside the session cwd, credentials) — then project a slim shape and document it in `docs/reference/api-v1.md`.
4. **Errors**: always `{ "error": { "code", "message" } }` with the existing code vocabulary (`bad_request`, `not_found`, `conflict`, `turn_active`, `bridge_offline`, `too_large`, `internal`); add `not_supported_cloud` (501) for C-class endpoints on a replica and reuse the `*_needs_upgrade` ladder for new relay commands.
5. **Frozen contract**: additive only. New optional fields OK; never rename/remove/retype an existing v1 field; new endpoints must tolerate absent optional params (old clients).
6. **Pagination**: list endpoints take `limit` (+ documented max) and a `before` opaque cursor, matching the conversations pattern.
7. **Replica behavior is part of each endpoint's contract**: every new endpoint documents its class (A local write + outbox echo, B relay + failure ladder, C `501/503` on replica) in the api-v1.md row.
8. **Relay discipline**: B-class endpoints go through narrow, allowlisted daemon commands (the `session.launch`/`session.control` pattern); never a generic "proxy any path" bridge command.
9. **Doc discipline**: every wave lands with its `docs/reference/api-v1.md` additions in the same commit; the doc is the contract.

## Verification plan (per wave)

- Unit/integration: each new v1 route gets a `startServer({ port: 0 })` test hitting the endpoint against the real store (mock only the CLI), asserting both the success shape and the error-shape vocabulary.
- Replica: B/C endpoints get a cloud-mode test (`WALNUT_CLOUD_MODE=1`) asserting the relay call or the explicit `501/503`, mirroring the existing session-launch relay tests.
- Live (L5): one cross-machine sign-off per wave exercising a representative relay endpoint end-to-end (phone-shaped curl → cloud → bridge → primary → daemon).
