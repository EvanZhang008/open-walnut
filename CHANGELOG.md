# Changelog

All notable changes to Open Walnut are documented here. This project follows
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include
breaking changes).

## [0.3.0] — 2026-07-16

Walnut goes mobile. **71 commits** since 0.2.0 add a native iOS companion app and the
self-hosted cloud relay that powers it, plus a hardened cloud-exposed surface and a
rebuilt single-timeline session chat.

### Highlights

- **Native iOS companion app** — a SwiftUI app (TestFlight beta) to check tasks, browse
  sessions, and read/edit notes from your phone, with Apple Notes / Apple Reminders-style
  interfaces, QR-code pairing (scan from the console, zero typing), and a live view of any
  machine's Claude Code session with in-app chat.
- **Self-hosted cloud companion** — an optional EC2 relay (AWS CDK infra included) with
  device auth and a versioned `/api/v1` facade that bridges your phone to your machines over
  HTTPS, including a git smart-HTTP endpoint so data-repo sync runs over 443.
- **Single-timeline session chat** — session chat is now one append-only timeline of blocks
  (system events and tool-failure state included), replacing the previous multi-stream view.
- **Hardened cloud surface** — the cloud-exposed bridge tightens CORS and secret exposure,
  with authoritative session-status reconciliation across the direct-connect bridge.

### Added

#### iOS companion app
- Native SwiftUI companion app with a primary-side auto-sync loop.
- QR-code pairing — scan from the web console to connect, no manual tokens.
- Sessions tab: browse and open any machine's session, with transcript tails and a live
  talk / conversation view.
- Tasks tab (Apple Reminders style) and Apple Notes-class WYSIWYG note editing (in-place
  table editing, Format drawer, floating glass accessory bar, keyboard avoidance).
- In-app log capture + auto-upload for TestFlight debugging.

#### Cloud companion & sync
- EC2 cloud companion: CDK infrastructure, device auth, and a read-only `/api/v1` facade.
- Git smart-HTTP endpoint for data-repo sync over 443; task projection export and
  read-only `GET /api/v1/tasks`.
- Cloud direct-connect bridge with authoritative session-status reconciliation.

#### Sessions & focus
- Read-only session projection and a Sessions tab in the task panel.
- Focus Bar state derived from tasks with UI-preferences sync; whole-group drag with a
  floating stacked preview and target-tier highlight.
- ACP-dialect id threading (msgId / messageIds / seq) and a stream-convergence sentinel
  with post-compact usage re-seed.

#### Memory & skills
- Bounded global memory with a unified skill system.

### Changed
- Session chat rebuilt as a single append-only timeline of blocks.
- Default-model config dropped — "Auto" now means no `--model` flag.
- History view delivers system events and tool-failure state; CLI-injected
  task-notification echoes are hidden from the main chat.

### Fixed
- **Security:** hardened the cloud-exposed surface (bridge, CORS, secret exposure) and
  scrubbed PII test fixtures and an internal proxy codename.
- iOS chat freeze after the first reply (stall watchdogs + queued SSE event); 90s bridge
  flap eliminated for fast conversation open.
- Idle-debt conservation so a late companion idle can't complete the next turn.
- Atomic JSON writes rename within the target dir (fixes `EXDEV` on Linux tmpfs).
- Cloud mode no longer lazy-inits the QMD store on search/index-status; per-note semantic
  embedding gated off in cloud mode.
- README star-chart embed fix.

## [0.2.0] — 2026-06-25

The first major update since the initial release: **503 commits** that turn Walnut
from a task-and-session dashboard into a full AI-native workspace — a Notion/Obsidian-class
notes vault, a resilient remote-session daemon, live workflow visualization, per-session
diff review, and zero-config onboarding.

### Highlights

- **Notes vault** — a Notion/Obsidian-class multi-file notes system with a TipTap WYSIWYG
  editor, wiki-links, tables, image paste, attachments, slash commands, and hybrid
  (semantic + keyword) search. The agent reads and writes your notes as first-class context.
- **Per-session diff review** — a GitHub-style "Changed" view for every session: review
  exactly what the agent changed, leave line-range comments, and reply inline.
- **Live workflow visualization** — dynamic multi-agent workflows render as a real-time
  phase flow-graph with per-subagent drill-in and full transcripts; reconstructed on reload.
- **Resilient remote-session daemon** — a new transport architecture (bun binary + SSH
  tunnel + FIFO) keeps remote Claude Code sessions alive across tunnel/daemon crashes,
  with chunked auto-deploy that survives corporate SSH proxies.
- **Zero-config onboarding** — unified credential resolver auto-detects Bedrock/Anthropic
  credentials from config, `settings.json`, env, and `~/.aws`; three setup paths get you
  running out of the box.
- **Multi-conversation agents** — each agent now has multiple independent conversations
  (fresh context per tab) with automatic knowledge distillation into agent memory.

### Added

#### Notes & Knowledge
- Notion/Obsidian-class notes editor: WYSIWYG (TipTap), wiki-links, tables, image paste,
  per-line Tab indent, paste-URL-as-hyperlink, and file attachments.
- Multi-file notes page with an Obsidian-like folder tree, drag-to-move, breadcrumbs,
  and in-tree reveal/locate.
- Hybrid notes search (semantic + keyword) with relevance bands.
- Slash-command panel in notes — `/task` inserts clickable task references.
- Global notes section with autosave; unified Markdown editor shell across all surfaces.
- Notes context injected into the main agent + a context inspector UI.
- Repository environment memory layer and working-memory scratchpad.

#### Sessions
- Per-session **Changed view**: GitHub-style diff, line-range drag comments, persistence,
  and three compare modes with an explanatory schematic.
- **Dynamic-workflow visualization**: live phase flow-graph, per-subagent drill-in,
  collapsible/full-screen panel, transcript lazy-loading, and reload reconstruction.
- Resilient remote-session daemon: bun-based transport, source-deploy fallback, graceful
  upgrade, and chunked auto-deploy for SSH-proxy environments.
- Embedded terminal in the session panel (persisted via `dtach`).
- VS Code-style file explorer + file intelligence (Edit diff view, clickable paths, FileViewer).
- Quick Start session panel, instant session switching (client-side history + stream cache),
  session retry, and `/session` command with fuzzy path picker and live SSH auto-complete.
- Two-panel session layout by default, draggable divider, panel count selector, pin-to-right.

#### Tasks & Focus
- 3-tier pinned system — **Focus / Next / Satellite** (+ Wait tier) with drag-to-pin/reorder.
- Lightweight virtual task groups (fork + manual multi-select + agent tool).
- Fork-in-Walnut with multi-level child task nesting and AI-generated fork titles.
- `HUMAN_VERIFIED` and `POST_WORK_COMPLETED` task phases; phase pickers with ⚡ indicators.
- Sprint as a first-class citizen (query filter, REST API, interactive picker).
- Quick Add, date pills/pickers, focus-override, cross-source task migration.

#### Agent & Models
- Multi-conversation per agent + on-demand agent creation + memory distillation.
- Opus 4.8 added and set as the default model; catalog-driven model resolution with
  adaptive thinking support and per-provider model catalogs.
- New agent tools: `ask_question`, `pin_task`, `files_glob`/`files_grep`, unified `files_*`
  URI-addressed tool group.
- Execution / Plan mode toggle in the main chat; Claude Code Teams tab UI.
- Skills page — browse, search, edit, enable/disable skills (local + remote discovery).

#### Onboarding, Settings & Providers
- Zero-config onboarding via a unified credential resolver (Bedrock auto-detect).
- AI Providers settings with a catalog UI, active selector, provider adapters, Ollama
  dynamic models, and Tavily web-search support.
- Auto-save settings sections (manual Save removed).

#### Voice & Observability
- Speech-to-Text with a mic button on all text inputs; system-audio capture; whisper-server
  daemon engine with VAD, prompt biasing, and an expanded model catalog.
- Forensic observability layer: wide-event recorder, invariant engine, auto-incidents,
  and session self-report.
- In-app notification store, toaster, and error bridge.

### Changed
- Renamed brand from **Walnut** to **Open Walnut**.
- Consolidated task-row actions into a kebab menu; unified pill-style action buttons and SVG icons.
- Simplified `TodoPanel` (View dropdown + status dots) and session-panel headers.
- URL state sync — UI layout encoded into the URL for deep linking.

### Performance
- Real-token compaction gate fixes the "context never converges / hits 1M" failure.
- Lazy-load subagent content (fixes 40s session loading); CSS-promotion full-screen with
  zero re-mount.
- Event-bus interest set skips global subscribers on high-frequency events (fixes event-loop
  starvation); write-invalidated read cache + slimmer task payloads (15s timeouts → tens of ms).
- Async task operations with optimistic updates; deferred Markdown serialization.

### Fixed
- 246 fixes spanning session status correctness (false-zombie kills, fake `session:error`,
  mid-turn QUEUED stalls, premature idle completion), notes flicker/drag duplication,
  daemon reconnection and replay, STT mic detection, and many UI papercuts.

## [0.1.0] — 2026-03-08

First public release — a personal AI butler powered by Claude.

- Claude Code Web UI: spawn, monitor, and chat with sessions from a real-time dashboard.
- 4-layer task hierarchy (Category → Project → Task → Subtask) with a 7-phase lifecycle.
- AI agent with 30+ tools (tasks, memory, sessions, search, cron, coding).
- Persistent memory system (SQLite FTS5 + BGE-M3 embeddings).
- Multi-session orchestration, local-first storage, self-hosted, CLI + Web, heartbeat,
  cron jobs, plugin system, and git-sync.

[0.3.0]: https://github.com/EvanZhang008/open-walnut/releases/tag/v0.3.0
[0.2.0]: https://github.com/EvanZhang008/open-walnut/releases/tag/v0.2.0
[0.1.0]: https://github.com/EvanZhang008/open-walnut/releases/tag/v0.1.0
