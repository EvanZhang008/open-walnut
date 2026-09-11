# Remove the main agent: every conversation with Walnut is a task-backed session

## Outcome

What shipped went further than this plan: `src/agent/` is gone, not kept. The plan assumed the in-process agent loop would survive for its eight non-chat users (P3 says "`src/agent/` stays", and the kept-verbatim table lists it), and each of those users was moved instead. Every AI turn Walnut runs is now a Claude Code CLI session: the Ask Walnut chat, a routine's isolated job (`walnut-agent` executor), an agent a `run_agent` hook dispatches, heartbeat, and cron. Action agents (`initProcessor.targetAgent`) are dropped, and a stored job that still names one is recorded as a failed run naming the `claude-code` executor as the replacement.

The single model calls that never needed a tool loop moved to `src/model/` (`sendMessage` / `sendMessageStream`, the provider registry, the model catalog, the protocol adapters). They serve Settings, voice transcription, session titles, quick parses, working-memory updates, compaction summaries, and the overview maintainer. The one in-process tool loop left is `runMicroAgent` (`src/model/micro-agent.ts`), used only by the routine watcher executor with read-only Walnut ops plus allowlisted plugin tools, because a watcher runs hundreds of times a day and cannot pay a CLI spawn per tick.

Also different from the plan: `config.agent.provider` is gone as designed, and so are the in-process-only keys `agent.cache`, `agent.model`, `agent.session_summarizer_agent`, `agent.session_triage_agent`, and `agent.background_review`; dream consolidation and `src/core/dream.ts` are deleted rather than replaced; `walnut chat` is deleted (the REPL is `claude`, the one-shot is `walnut tools call`); and a cloud replica with the primary unreachable answers an iOS chat turn with an SSE `error` frame instead of any degraded local answer.

Read the rest of this document as the plan it was, not as a description of the code.

## Executive summary

Walnut drops the "main agent" (the Personal AI lane, its conversations, and its private chat history). The only way to talk to Walnut becomes an **Ask Walnut session**: an ordinary claude-code session that carries the Walnut persona profile, is bound to a task flagged `walnut_agent: true`, and lives under the `Ask Walnut` project. The home page keeps a chat slot, but that slot is now the regular `SessionPanel` over the selected Ask Walnut task, with one addition: a ≡ button leading its title row opens a drawer of the asks to switch between (a search box on top, `New chat` at the bottom, the Claude app's sidebar shape). Proactive work (routines, heartbeat, future triggers) starts an ad hoc session instead of writing into a hidden conversation. Memory stops depending on a long-lived agent: every session appends observations, and a scheduled consolidation session distills them into `MEMORY.md` and `USER.md` under the existing budgets.

Why this is smaller than it looks: on the current engine the chat slot already renders `SessionChatHistory` (the same timeline component `SessionPanel` uses), the server already translates lane turns into the frozen iOS `/api/v1/conversations` shape, and the iOS app already ships a full native session view (`SessionConversationView` over `/api/v1/sessions/*`). Two inventory findings drive the memory part: automatic consolidation (`background-review`) is wired only to the in-process chat branch and therefore never fires on the claude-code engine today, and every session already appends a summary to the daily log through the `on-stop` hook.

The pain this removes: tracing a main-agent conversation required promoting it to a task by hand. Now every conversation is born a task (amber title, needs-action header, pin, archive, search all included).

## Target shape

```
Before                                        After
────────────────────────────────────────      ────────────────────────────────────────
main agent: lane + conversation +             no main agent. Everything is task + session.
chat-history (182 'general' hardcodes)

chat slot = hidden lane session,              chat slot = SessionPanel over the newest
no task, promote-to-task by hand              Ask Walnut task; a ≡ drawer to switch;
                                              New chat = Ask Walnut composer in the slot
conversation list (own store)         →       task list filtered by walnut_agent
cron / heartbeat / triage → main conv →       ad hoc session (routine executor) or the
                                              notification feed
memory consolidation inside the        →      scheduled consolidation session; every
main agent's turn loop                        session appends observations
```

## Decisions (approved)

1. Console agents (mentor, note-agent, custom) move to the same task-backed model: the quick-start `walnutAgent` flag generalizes to an `agentId`, each agent gets its own project (for example `Ask Mentor`), and `consoleAgentProfile` is kept as is. Keeping the lane alive only for them was rejected because the removal would not be complete. Pulled forward from P3 into P1 (2026-09-08) once the user pointed out that removing the old agent tab bar had left Mentor and Note Assistant unreachable on the web; their old lane conversations still wait for the P3 migration.
2. Consolidation cadence: nightly, and only when the day had at least five sessions (the retired dream loop's gate), not every N turns.
3. Existing lane conversations migrate once: each becomes an archived Ask Walnut task that points at the existing session record and its CLI transcript. No dual-track compatibility on the web. The iOS `/api/v1/conversations` shim keeps serving already-installed builds.

## Phases

### P1: front stage, the chat slot becomes an Ask Walnut session view

Scope is the web console only. The lane infrastructure stays alive underneath (iOS and console agents still use it), so P1 is a surface swap with no data migration.

- New `AskWalnutSlot` replaces both chat implementations in `MainPage.tsx` (the in-process `ChatPanel` branch and the lane `SessionChatHistory` branch). It derives its list from the task store (tasks born as asks, `walnut_agent === true`, plus tasks filed under the `Ask Walnut` project; newest created first), resolves each task's newest session from the session list, and renders the regular `SessionPanel` for the selected task in embedded mode. Embedded keeps every window control a column has (×, popout, fullscreen, locate) and hides only lock; the × hides the slot the way a column's × closes the column.
- The one addition to the panel is a ≡ button leading its title row (user direction, 2026-09-07: "just reuse the regular panel, add a Claude-style switcher top-left"; then "keep the ×, expand must behave like every other panel, do not build new concepts"). It slides a drawer in from the left over the panel: a search box that filters the list as you type, the asks with the current one marked, a live status dot and a last-touched stamp, `New chat` pinned to the bottom, and two small links under it (`Context`, `Fix Walnut`). Deliberately no `+ Task`, `+ Session`, `Find sessions` or `Hide` rows: there is one concept (a task, with or without a session) and one creation surface (the draft column), ⌘⇧O is the session finder, and the panel's × is the hide. `Promote to task`, engine badge, engine switch, and the chat stats pill are removed (obsolete or already superseded on the session path).
- `New chat` renders `DraftSessionPanel` inside the slot with a synthetic walnut draft (the same Ask Walnut tab users already know: copy, one-tap seeds, composer, model pill locked to claude). Start calls `quickStartSession({ walnutAgent: true })` directly, shows a pending state in the slot, and selects the new task as soon as the response carries `taskId` and `sessionId`. No session column is opened for slot launches.
- The drawer's title is the agent switcher (decision 1, landed in P1). Every console agent from the registry (Walnut first, then Mentor, Note Assistant, config-defined ones; background-only agents such as the screenshot tracker are not offered) has its own list of asks and its own composer: the title opens an inline list of the agents with their descriptions, picking one re-filters the drawer and re-targets `New chat`, and the slot moves to that agent's newest conversation (or its composer when it has none). A launch under another agent sends `agentId`; the server resolves the persona with `buildLaneProfile(config, agentId)`, files the task under `Ask <name>` (rule in `src/core/sessions/ask-agent.ts`, client twin `askProjectFor` in `ask-walnut-slot-model.ts`), titles it the same until auto-titling names it, and stamps `task.agent_id` (absent for Walnut). The stamp is what keeps two agents' lists apart when their tasks share a project by hand; the persona drift repair and fork inheritance read it too. The drawer follows the ask on show after a reload (task stamp first, project second), and the agent on show persists per window so an empty Mentor composer survives a reload.
- Selected task id persists in `sessionStorage`; a missing or archived selection falls back to the newest task; no tasks at all shows the `New` composer.
- `GET /api/context` accepts `sessionId` so the context inspector shows the selected session's real launch profile.
- Focus Dock label `Main Chat` becomes `Ask Walnut`.
- Known gaps until P3: old lane conversations are not visible on the web (their transcripts stay on disk and iOS still reaches them); the in-process engine's `user_ask` tool has no web answer surface any more (the popover lived in the removed chat composer; P3 removes that engine's chat branch); a slot Retry after a launch that failed once the server had already created the task creates a second task (the session columns' Retry has the same shape).

Verification: Playwright against the real UI (chromium and webkit, the Mac app is a WKWebView): empty state shows the composer and an empty drawer, a launch streams the mock reply inside a `SessionPanel` (with ×, popout and fullscreen present and lock absent) and lists one current row in the drawer, `New chat` then a second launch yields two rows (newest on top), picking a row switches history, selection survives a reload, the × hides the slot and the dock brings it back, expand-to-fullscreen covers the page rather than the slot, the drawer's search filters by title, `Fix Walnut` still opens a pre-armed draft, the title switches agents (Mentor's list is empty, its composer is named and described, a launch from it is filed under `Ask Mentor` with `agent_id: mentor`, Walnut's list never shows it, going back brings Walnut's newest conversation back, a reload on Mentor stays on Mentor), mobile width (390px) keeps the drawer and composer inside the viewport. Server side, `tests/e2e/quick-start-walnut-agent.test.ts` pins the per-agent launch, the general default, the three rejections (unknown, background-only, `agentId` without `walnutAgent`) writing nothing, and the drift repair rebuilding the launched persona rather than the Personal AI.

### P2: proactive senders stop targeting a conversation

- Cron `main-agent` executor: stored jobs migrate to the `claude-code` executor with `walnutAgent: true` (an ad hoc Ask Walnut session per run, cwd `WALNUT_HOME`). The executor type is retired from the routine draft prompt and the compat mapping keeps reading old store files.
- Heartbeat: same ad hoc session shape; a silent "all clear" beat writes only to the notification feed.
- Triage `notify_mode` main-agent branch: deleted (default `off`, and the triage subagent already writes `summary`, `note`, and `phase` on the task itself). The UI-only notification path stays.
- Every remaining `chatHistory.addNotification` (session results, subagent results, cron prompts) writes to the notification feed instead.
- The inert `'main-agent'` bus destination is removed from the 18 emit sites; the `main-ai` subscriber that fans session streams to the browser is renamed `session-stream` (it is load bearing and unrelated to the main agent).

### P3: back stage, delete the lane

- One-shot migration: for every session record with a `lane` key, create an archived Ask Walnut task (title from the conversation index, `walnut_agent: true`, project `Ask Walnut`), bind the record's `taskId`, and drop the `lane` field. Conversation index files stay on disk for the iOS shim to read titles from.
- Console agents: quick-start takes `agentId`; `buildLaneProfile` is renamed `buildWalnutProfile` and keeps both branches; NotesChat and the plugin chat view render a session view over their agent's project.
- Deletions: `personal-ai-lane.ts` except the profile and memory builders and `refreshWalnutSessionProfile` (moved to `walnut-profile.ts`), `lane-turn.ts`, `lane-fork.ts`, `lane-orphan-recovery.ts` (the stranded-answer failure mode no longer exists), `chat-turn-relay.ts` (sessions have their own replica relay), `background-compaction.ts` (the CLI compacts its own transcript), the `chat` and `chat:stop` and `chat:answer-question` RPCs, the in-process chat branches in `server.ts`, all lane exemptions (session list, search, QMD sync, reaper), `getSessionByLane`, `SessionRecord.lane`.
- `chat-history.ts` shrinks to what still has a reader: nothing on the web once notifications live in the feed. It is kept only behind the iOS shim (P4) and removed when that shim retires.
- `src/agent/` stays: subagent runner, the one-shot CLI chat, dream, cron isolated jobs, action agents, and the working-memory fork still use `runAgentLoop`. Only the chat-turn branches go.
- `resolveAgentEngineProvider` and `config.agent.provider` are removed; every call site becomes unconditional.

### P4: iOS

- Server: expose `walnut_agent` on the v1 projected task and session shapes. Nothing else is new.
- Client: the Chat tab lists Ask Walnut sessions and opens them in `SessionConversationView`; `New` uses the existing launch-by-chatting view with the walnut profile.
- The `/api/v1/conversations/*` and `/api/v1/chat/*` endpoints stay as a shim for installed builds: conversations are projected from Ask Walnut tasks, `POST .../messages` sends into the task's session, the SSE channel is fed from the session stream (the shape `runApiV1LaneTurn` already produces), `stop` maps to session interrupt, `answer` to the session's question channel, `clear` archives the session and starts a fresh one on the same task, `compact` sends the CLI's own `/compact`.

## Memory design: observe, then distill

Two layers, one rule: sessions append, only the consolidation pass rewrites.

```
Capture (every session, including coding sessions)
  automatic: on-stop hook → memory/daily/<date>.md          (already live for every session)
  explicit:  memory_observe MCP op (new) → same daily log,   append-only, O_APPEND, no lock needed
             tagged [observation], stamped with the session id
                          │  git-tracked, indexed by search, injected on demand only
                          ▼
Distill (the only machine writer of MEMORY.md / USER.md)
  a routine (claude-code executor, cwd WALNUT_HOME, walnut profile) runs nightly when the day
  had ≥ 5 sessions; it reads recent daily logs, observations, and the memory telemetry evidence,
  then writes through the budgeted store (8,000 / 4,000 char caps, file lock, injection screen,
  pre-write backup), prunes stale entries, and promotes repeated how-tos into skills
                          ▼
Read (unchanged shape)
  every Ask Walnut session's persona carries MEMORY.md + USER.md; daily logs are pointed at, not injected
```

Three repairs the inventory found, done alongside:

- Expose `memory_manage` (add, replace, remove, batch) as an MCP op and retire `memory_write` for sessions. `memory_write` is a whole-file replace with no lock, no budget, no injection screen, and no `expectedHash`, so two sessions writing at once silently clobber each other and none of the over-budget "consolidate first" machinery is reachable from a session.
- `buildLaneMemoryContext` reads the two files raw; it moves to `renderForPrompt` so the budget header and the prompt-time injection screen apply on the session engine too.
- git-sync merges per file with commit-time last-writer-wins for markdown. Appends are safe; whole-file rewrites go through the store's file lock, and the consolidation routine runs only on the primary host to avoid cross-machine clobbering.

Deferred idea, kept compatible: a proposal queue where sessions file memory proposals and the consolidation session merges them like pull requests. The observe channel is the same shape, so tightening later costs nothing now.

## What is deleted, kept, and shimmed

| Bucket | Items |
|---|---|
| Deleted outright | `lane-orphan-recovery.ts` (572 lines), `chat-turn-relay.ts` (695 lines), `background-compaction.ts`, the `chat` RPC lane compat branch, the triage main-agent branch, `'main-agent'` bus destinations, every lane exemption predicate |
| Kept verbatim | `buildLaneProfile` (renamed), `buildLaneMemoryContext`, `refreshWalnutSessionProfile`, `personalAiProfile`, `consoleAgentProfile`, `walnutMcpProfile`, `SessionChatHistory`, `useSessionSend`, the whole `quickStartSession({ walnutAgent })` path, `src/agent/` for its eight non-chat users |
| Shimmed | `/api/v1/conversations/*` and `/api/v1/chat/*` for installed iOS builds |

## Risks

- `MainPage.tsx` is over 3,000 lines; P1 removes two chat implementations from it. Mitigation: the slot is a separate component, the removal is verified by real-UI Playwright in two browser engines, and the lane server code stays untouched until P3.
- The consolidation session writes memory unattended. Mitigation: it writes only through the budgeted store (backup before write, injection screen, breaker after three failed consolidations) and its output shows up in the Memory page's telemetry view.
- Old cron jobs of executor type `main-agent` must keep firing after P2. Mitigation: the compat reader maps them at load time and a test pins the mapping.
