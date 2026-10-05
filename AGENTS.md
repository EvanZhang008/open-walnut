# Open Walnut — Personal AI

> **ACP reference implementation:** https://github.com/agentclientprotocol/claude-agent-acp (public).
> **References**: [ARCHITECTURE.md](./ARCHITECTURE.md) | per-directory `AGENTS.md` files are
> concise quick-references; the **deep implementation details live in skills** (auto-discovered,
> load on demand): `walnut-core-internals` (src/core/),
> `walnut-web-frontend` (web/src/), `walnut-testing` (tests/), `walnut-ops` (incidents + src/logging/).
> Load the matching skill before non-trivial work in that area.
> **Important docs:** browse [`docs/`](./docs/README.md) first; model work starts with
> [Claude model configuration](./docs/reference/claude-model-configuration.md).

## Ownership: You Are the CTO

**Act as the CTO of this repo — proactive, decisive, and accountable for the outcome.**
Don't wait to be told the obvious next step or stop to ask which way to go when the
intent is clear. Make good, thoughtful decisions: weigh all the trade-offs (UX,
maintainability, performance, blast radius, root-cause vs. band-aid), pick the option
you'd defend in a design review, and state the call + the reasoning as you go. When a
choice is genuinely the user's to make (irreversible, a real product fork, or it
contradicts a stated preference) surface it with a recommendation — otherwise pick the
obvious option and proceed. Fix root causes, not symptoms. Verify your own work
(build + real-UI E2E) before claiming it's done. Default to finishing the whole job.

**Done means live on prod, and you saw it there.** A change is finished only when it is
committed, deployed to the live server on :3456, and you opened live prod yourself and
watched it work (the real UI for a UI change, a read-only check for the rest). After the
review, commit and deploy on your own; don't stop and wait to be asked. The shared tree
almost always holds other agents' uncommitted work, so deploy the commit, not the tree:
`bash scripts/deploy-committed.sh` builds the committed HEAD in a clean clone and serves
it as this checkout. Never wait for the tree to be clean, and never stash, revert or commit
their files to get there. If a deploy guard refuses (type-check, smoke boot, cooldown), fix
what it names or report it as the blocker. Never end with "committed, not deployed, say
deploy". Scope the commit to your own changes only (never sweep up other agents'
uncommitted files), and run the usual pre-commit sensitive-content scan. Push still only
happens on request.

## CRITICAL: Open Source Repository

**PUBLIC repo. Every commit is visible to the internet.**

No company-internal names, personal info, internal URLs, credentials, or internal processes. Generic descriptions only. Internal plugins go in `~/.open-walnut/plugins/` (never committed). **When in doubt, leave it out.**

## Multi-Agent Safety

- **NEVER** delete/revert other agents' changes or switch branches unless asked
- No `git stash`, no `git worktree` ops unless explicitly requested
- On "push": `git pull --rebase` OK. On "commit": scope to your changes only
- If build fails, retry — another agent may be mid-commit
- Bug investigations: read npm dep source + all related code before concluding
- Code style: brief comments for tricky logic; files under ~500 LOC

## Production Server Safety

**Port 3456 = PRODUCTION. NEVER kill, restart, or interfere with it by hand: the deploy
scripts below are the only way to replace it.**

### Never block the web server (each rule = a shipped outage)

- **No sync blocking on the event loop** (`execSync`, sync native-addon calls, multi-MB parse): one call freezes EVERY route. Child process + timeout + cached value instead (`setImmediate` doesn't help). Ratchet: `tests/core/event-loop-blocking-ratchet.test.ts`.
- **Every route touching daemon/SSH/network/whale files needs a deadline** — answer degraded (204/stale), never hang: one pinned response starves the browser's 6-connection pool → app-wide fake 15s timeouts.

```bash
bash scripts/deploy-committed.sh  # Deploy the committed HEAD (clean clone) → restart 3456
npm run dev:prod        # Build the working tree as it is → restart 3456
npm run dev:ephemeral   # Ephemeral server (random port, temp data, auto-cleans)

# Verify the deploy script itself WITHOUT deploying: runs every guard, then stops
# before build / server kill / launch. WALNUT_DEVPROD_PORT is honoured only here.
WALNUT_DEVPROD_DRY_RUN=1 WALNUT_DEVPROD_PORT=35999 TMPDIR=/tmp/dry bash scripts/dev-prod.sh
```

### Live verification runs on an ephemeral server, never on :3456

Anything that creates tasks, sessions, notes or cron jobs to prove a change works (a real-CLI
turn, a Playwright click path, a `curl` or `walnut tools call` against the API) runs on
`npm run dev:ephemeral`. Reading :3456 is fine; writing to it for a test is not: every probe
task an agent made there stayed on the user's board (a 2026-09-23 audit found dozens).

The launcher prints `{pid, port, tmpDir, daemonDir, pausedCronJobs, removedPushTokens}`. The
server is isolated by construction, so nothing it does reaches the real Walnut:

- its own data copy and its own local daemon in `daemonDir` (its logs are there too);
- its own op executor and every local session it launches talk to it, never the :3456 default
  (`OPEN_WALNUT_API_URL`, see `src/lib/self-api-root.ts`);
- the copied cron jobs are paused (jobs created there still run), the copied Board reminders
  never fire (ones set there do), the copied phone push tokens
  are removed, no plugin syncs tasks (installed ones included), and there is no cloud bridge
  push and no heartbeat;
- shared remote hosts stay off unless it is started with `WALNUT_EPHEMERAL_REMOTE_HOSTS=1`,
  because a remote daemon hands relayed work to whichever server it sees first;
- search is keyword only: no isolated server (an ephemeral child, the test runner, any data
  home in a temp dir) loads the embedding model, about 2.2 GB per worker lane plus a full
  re-embed of the copied data (`src/core/search/semantic-default.ts`). Test semantic search
  with `WALNUT_SEARCH_V2_SEMANTIC=1`.

Plugins still load with the copied settings, so a test that sends mail or a chat message
through one sends it for real.

**Testing a task sync plugin.** No plugin syncs tasks on a test server, so tasks made there stay
local, which is what almost every test wants. To test a sync plugin against its real service
(Microsoft To Do, or one the user installed), start the server with
`WALNUT_ALLOW_REMOTE_SYNC_IN_TEST=1 npm run dev:ephemeral`. It then writes to the user's real
account, and the real Walnut pulls those items back onto the user's board. Change only tasks you
created there: the copied tasks are linked to real items, so editing, completing or deleting one
changes the real item. Before you finish, clean up: delete each item you created from the test
server while sync is still on (that removes it from the real service too), then check the real
board and delete any copy it already pulled in. Removing your own leftovers is the one write to
:3456 a test may make. Report what you removed.

**dev-prod.sh must stay portable.** Issue #11: the server log was pinned to `/private/tmp`,
a macOS-only path, so a Linux deploy killed the live server and then failed to start its
replacement. Two rules it now encodes: prove every external prerequisite (a writable log)
BEFORE the first destructive step, and never assume a macOS-only tool (listener detection
probes `lsof` → `ss` → `fuser`, and refuses to run when none exists rather than failing
open and starting a second server against the same data dir). Ratchets:
`tests/scripts/dev-prod-portability.test.ts` (the dry run executes the whole script, on
Linux too, in CI's quick tier) and `tests/scripts/cross-platform-ratchet.test.ts`.

**Deploys smoke-test before killing prod, and roll back on failure.** dev-prod.sh boots the
freshly built dist ONCE in full isolation (temp data dir + temp daemon dir + probe port) and
requires it to serve `/api/config` BEFORE touching the running server — a dist that hangs in
module init (2026-08-22/23 outages) now fails the deploy while prod keeps serving. After a
successful readiness check the dist is snapshotted as last-known-good; a post-kill readiness
failure re-launches that snapshot instead of leaving :3456 dark. Knobs:
`WALNUT_DEVPROD_SMOKE_SECS` (default 120), `WALNUT_DEVPROD_SKIP_SMOKE=1`,
`WALNUT_DEVPROD_LKG_DIR`. Ratchets: `tests/scripts/dev-prod-smoke-rollback.test.ts`.

**A deploy must not pull the floor out from under an open window.** Every deploy re-hashes and
WIPES `dist/web/static/assets`, so a window that was open before it still runs the old entry
bundle and 404s the first time it reaches for a chunk it had not loaded yet. That fetch happens
inside a click (opening a `.go` file asks for its CodeMirror grammar), `vite:preloadError` fires,
and `stale-assets.ts` reloads the page ON TOP of the click — the 2026-09-03 Mac app report,
"I click a path, the page flashes, nothing opens; the second click works". The Mac app is the
only surface that hits this, because its window is the one that lives across every deploy (its own
page-process recycle deliberately waits for the user to go idle). Two answers, in
`src/web/static-mirror.ts` + `web/src/utils/stale-assets.ts`: the durable asset mirror now keeps
ONE DIRECTORY PER BUILD (`<mirror>/gens/<entryHash>/`, newest served first, all of them mounted as
fallthrough static roots), so a replaced build's chunks stay fetchable; and a window whose bundle no
longer matches the server's reloads itself only while HIDDEN for 20s, never with unsaved text, never
on an unknown. A name no build ever had still 404s — the client's reload recovery needs that to stay
loud. Two traps the mirror's shape encodes: eviction counts BUILDS (keep the newest 6, floor 2, then
72h / 512MB), never file mtimes, because `cpSync` stamps copy time and an mtime clock deletes a
build's chunks in the very refresh that makes them previous; and eviction NEVER consults the primary,
because the failure this mirror exists for (a deploy stage swept from under a live server) removes
FILES while the directory still lists, and a pruner diffing against that would delete almost
everything including the mirror's own `index.html`. Ratchets:
`tests/web/static-mirror-{retention,previous-build}.test.ts`,
`tests/web/stale-build-upgrade.test.ts`, `tests/e2e/browser/stale-build-no-flash.spec.ts`.
Note when testing: the Playwright fixture serves the SPA through Vite in DEV mode, so it has NO
hashed chunks — the hashed half can only be pinned against a real `startServer({dev:false})`.

**⚠️ Launch dev:prod from a non-niced shell.** A server started from a niced parent (e.g. a
background agent session) inherits the positive nice and gets scheduler-starved under machine
load — HTTP latency spikes that look like app bugs. The server logs an error at startup and
exposes `processNice` in `GET /api/config` when this happens; fix = restart from a normal shell.

**The deploy runs the server at app priority, the agents stay below it.** dev-prod.sh loads the
server as a launchd job from a plist with `ProcessType` Interactive (base priority 31), because a
bare `launchctl submit` job is launchd's Standard type, which macOS schedules in the utility band
(priority 20) together with every agent build and test on the Mac. The same plist sets
`WALNUT_DAEMON_QOS_CLAMP=1`, and only then does the server start its background children under
`taskpolicy -c utility` (`src/lib/background-qos.ts`): the local daemon and so every agent
session, the embedding model workers, the git backups and the history compaction keep the band
they had. Still in the server's band: the model adapter's own `claude -p` turns (one call path
carries the Personal AI chat and background titles alike, and nothing on the call says which),
the warm search-agent CLI, and one-shot setup at boot. A server started any other way (a terminal, the Mac app, the submit fallback) clamps
nothing, so its children inherit its band. `WALNUT_DEVPROD_PROCESS_TYPE=Standard` restores the
plain submit. The job lives in one launchd domain (gui/<uid> from a GUI login, user/<uid> over
ssh), and every look at it goes through `launchctl print|bootout <domain>/<label>`. Check with
`ps -o pri= -p <pid>` (31 server, 20 daemon).

**⚠️ NEVER wrap `npm run dev:prod` in a bare `launchctl submit`.** `launchctl submit` jobs are
KeepAlive — the script exits, launchd re-runs it, forever. dev-prod.sh is a one-shot deploy, so
this becomes a kill-server-every-10s loop (2026-07-25 incident: 7 back-to-back restarts, one of
which killed a healthy mid-compaction CLI session). If you must deploy from a niced shell, use a
one-shot wrapper with a done-marker (`[ -f /tmp/<marker> ] && exit 0; …; touch /tmp/<marker>`)
so re-runs are no-ops. dev-prod.sh also has its own storm breaker now: a <120s cooldown after a
successful deploy (exit 0 no-op) and a refusal to kill a listener younger than 120s
(`WALNUT_DEVPROD_FORCE=1` overrides both for intentional rapid redeploys).

### Isolated sandbox for onboarding / provider testing / demos

`scripts/walnut-sandbox.sh` spins up a fully isolated Walnut on **:3457** (`env -i` + throwaway
HOME + isolated data/daemon dir) to test any credential or record onboarding — **never touches
prod 3456** (the script refuses to act on 3456). Docker-free (Docker may be locked down in some managed environments).

```bash
scripts/walnut-sandbox.sh clean                  # no creds → first-run onboarding banner
scripts/walnut-sandbox.sh token   [region]       # use host AWS_BEARER_TOKEN_BEDROCK
scripts/walnut-sandbox.sh keys    [region]       # use host AWS access keys
scripts/walnut-sandbox.sh profile <name> [region]# use a ~/.aws profile (incl. credential_process)
scripts/walnut-sandbox.sh test  '{...}'          # POST /api/config/test-connection (real round-trip)
scripts/walnut-sandbox.sh chat  "msg"            # one message to the Personal AI → prints its reply
scripts/walnut-sandbox.sh record out.mp4         # record the onboarding chain (needs a bearer token)
scripts/walnut-sandbox.sh status | stop          # health | stop+wipe
```

- **HOME differs by mode (subtle):** `clean`/`token`/`keys` use a **fake HOME** (hides `~/.aws`,
  `~/.claude`); `profile` uses the **real HOME** + `~/.toolbox/bin` on PATH so `credential_process`
  (e.g. `ada`) can resolve. Token would otherwise win over a profile, so token isn't injected in profile mode.
- `chat`/`record` use `scripts/walnut-sandbox-chat.mjs` / `onboarding-chain.mjs` (WS RPC + CDP recorder).
- **Rebuild gotcha:** the sandbox runs `dist/cli.js`; `web:build`/`build` DO recompile the server
  via `tsup`, but if you edit server code and forget to rebuild, the sandbox runs STALE server logic.
  A `400 invalid beta flag` on `chat` while `test` passes is the classic symptom of a stale `dist`
  (an old build that still sent the removed `extended-cache-ttl` beta). Rebuild (`npx tsup`) and re-run.
- **Verified-good provider behavior (do NOT "fix"):** Walnut does NOT send `extended-cache-ttl`
  to Bedrock — sending it answers `400 invalid beta flag`, and the 1h cache is GA anyway
  (`cache_control.ttl:'1h'` rides through verbatim; see `EXTENDED_CACHE_TTL_BETA` in
  `src/model/providers/defaults.ts`). opus-4-8 uses `thinking:{type:'adaptive'}` + the
  `interleaved-thinking` beta. This combo + a `~/.aws` profile is confirmed working end-to-end.

## What Is Walnut

Personal AI: tasks + knowledge + AI sessions. **Tasks are the atom.** `Project → Folder → Task → Subtask`. A folder (`task.group_id`) is optional and belongs to exactly one project; a task with no project lives in the **Inbox** (`project = ''`). Event Bus connects everything. See [ARCHITECTURE.md](./ARCHITECTURE.md).

### Key Rules for Implementation

- **Parse harness-owned data the harness's official way — never invent Walnut-side bookkeeping on top of a file Walnut doesn't own.** If the CLI/agent already defines the format's semantics (e.g. transcript JSONL is a `parentUuid` tree and the CLI chain-walks to the active leaf), port that exact logic. Offsets/fingerprints/side records reinterpreting someone else's file go stale the moment the owner writes in a way Walnut didn't initiate. Walnut-invented logic belongs only in Walnut-owned formats (stream capture, ACP journal).
- `task_create` takes an optional `project`; an unknown name auto-creates the registry row (`task_projects`, source `'local'`). Inbox (`''`) has no registry row and can never be claimed by a sync provider
- **Work created from inside a task lands beside it** (`src/core/sessions/caller-placement.ts`, enforced in `POST /api/v1/tasks` from the `x-walnut-caller-sid` header): the caller's project and its folder (a new one holding both when it has none; a SUBFOLDER of it holding both when the folder also holds work that is not the caller or its subtasks, so the folder tree follows the subtask tree, and the board draws it nested), the caller's board tier (a Focus task's subtask is born in Focus; `pinned`/`focus_tier` in the body win), plus the caller's cwd when the caller runs on the project's default host. Whatever a session files is that session's task's SUBTASK (`parent_task_id`; a Worker pill on the board that leads back to the parent, and a `Leader · N` pill on the parent that counts and lists only the OPEN subtasks wherever they live, gone when none is open), in its project, in another one, and from a Personal AI ask too; a subtask in another project takes that project's source and renders as a top-level row there (nesting stays inside one project). Explicit `project` / `group_id` win; a folder never follows work into another project; only WORKER callers are placed from (the Personal AI's asks, born `walnut_agent` or filed under an `Ask …` project, keep the old defaults for project, folder, tier and cwd and get the parent link alone; humans and replicas keep the old defaults entirely). `GET /api/v1/me` says who the caller is and where it stands.
  A start from a worker takes the caller's host + cwd as ONE pair when the task has no place of its own, and `task_list` from a worker defaults to the folder ring (project when no folder).
  Server brakes, never prompt-only (`src/core/sessions/subtask-limits.ts`): a session's subtask sits at most 3 levels below a top-level task (`409 subtask_too_deep`), and a worker runs at most 8 subtasks at once (`409 too_many_running_subtasks`). The human and an ask are never limited.
  **A session's task title is a few words** (`src/core/sessions/task-title-brake.ts`, in `POST` and `PATCH /api/v1/tasks`): over 60 characters from any session caller, the title is cut to its head at once (the long form becomes the description when the create had none) and refined in the background by the fast model with the session-title recipe, written only while the task still wears the cut. Humans and the phone (no caller header) are never touched. The prompts also pin two words: a "subagent" is Claude Code's Agent tool, a "subtask" is a Walnut task (2026-09-30: "use a subagent" was answered with a Walnut subtask carrying a 140-char title).
  **A subtask is a teammate, not a step**: it owns one area with a clear goal; one per ask (the session asks the user before splitting), and more work in its area goes to it with `task_send`. Prompt, `task_create` description and skill say so; the nudge is server-side: every create that makes a subtask returns the caller's other open subtasks in `placement.open_subtasks`, and the op outcome names them (2026-10-01: one "use a subtask" ask became one task per sentence, then a fourth for the third one's follow-up).
  **A leader adopts, and keeps a Board.** An existing task becomes a worker through `PATCH /api/v1/tasks/:id { parent_task_id }` (`task_update`; `""` releases; on the board, the Leader flyout's "Adopt…" and the task kebab's Team row, collapsed by default (2026-10-05: rare, so one row that expands on click), holding "Adopt a worker…", "Release a worker…" (a leader lets one go; it keeps running) and "Leave leader"): the server checks the parent exists, is not the task or one of its descendants, and, for a session caller, that the adopted SUBTREE still fits `MAX_SUBTASK_DEPTH`; humans are never limited; project and folder stay put; the adopted task's session is told through `walnut-notify` only when it is MID-TURN, where the notice rides along for free; an idle one is never woken for bookkeeping (2026-10-02: five idle workers each woke to say "this is only a notice"), it reads the link from its task when it next runs (its prompt line about its leader is built at spawn). Every task may carry a **Board** (`src/core/boards/`, `src/web/routes/board-v1.ts`, ops `board_get/set/edit/post/post_delete/project_set/remind`, skill `walnut-board`, the `Board` tab beside Files and Changed): one HTML document the leader writes and any task in its tree may edit (exact-string `edits`, each `old` once, all or none; a version for optimistic writes), stored at `WALNUT_HOME/boards/<taskId>.json` with the chat threads and the user's marks beside it, rendered in a sandboxed `allow-scripts` iframe (no same-origin, CSP) with Walnut's runtime upgrading `<walnut-task>` (live chip), `<walnut-thread>` (a human's message is stored and delivered to the task's session like a human `task_send`; the session answers with `board_post`), `<walnut-mark>` (the user's note), `<walnut-strip>` and `<walnut-unread>`; beside the html Walnut also keeps the board's projects (one area of the board each, not a Walnut project; their status, set with `board_project_set` or picked by the user on the `<walnut-project>` pill, recolors every `data-project` element; a session's write keeps the user's pick unless it passes `override_user`, 409 `status_set_by_user` otherwise), the user's read ticks on `<walnut-check>` points (the server hashes each point's html, so an edited point comes back unread), the user's answers to `<walnut-choice>` (an option, their own words from the same docked composer as a thread's, or both, delivered to the session as one message like a thread message), reminders on a choice or a thread (a server clock, `board-reminders.ts`, modelled on `task-wait-until.ts`), and the sections the user has seen; ticks, answers and seen sections are human-only (`403 human_only`). A team shares ONE board (`resolveTeamBoardTask`: the nearest ancestor with a board, else the root; `?team=1`, `/board/owner`, and every `board_*` op's default); `board:changed` carries a top-level `taskId`. The leader hears about the Board at spawn when it has open subtasks and in every `task_create` outcome that lists its team (2026-10-01: a user could not follow 40 workers through the leader's chat and had the leader hand-write exactly this page as a local file, whose chat never reached the AI and whose marks it could not read).
- **The inbox is for what needs the user** (2026-10-05, the user: notifications only when asked, "only the most important information"). Walnut's own letters are decisions (a mail send approval, an unsubscribe) or reports the user set up (the mail digest); a park writes none. Every agent-facing text says the same rule (session prompt `session-context.ts`, `human_inbox_send` description, the `walnut` and `walnut-trigger` skills): a letter only when the session is blocked on the user's decision, something needs their review, or the user asked for it (a digest or report they set up, "tell me when X"). Never progress, a finished step, a park or an FYI: the task's state and its session show those, and every letter buzzes the phone.
- **A parent always hears when its child stops** (`session-request-watch` in `src/core/session-hooks/builtins.ts`): a pending reply request is settled with a Walnut notice when the child's task lands NEED_ACTION or COMPLETE (a COMPLETE set mid-turn waits for that turn's end, so a reply later in the turn still wins), and the notice quotes the child's last message (≤4000 chars, framed as data) plus the tool calls it made after that message (the result usually sits there: completing a task ends its turn on the spot, before any closing words), so a child that forgot to reply still hands its result over. **Never to the session whose own API call made the edge**: the phase event carries `actorSid` (the `x-walnut-caller-sid` of the PATCH or complete), a request that session holds is settled without a notice, and a parent whose session acted gets no subtask notice (2026-10-02: a leader completed 16 workers and was woken 16 times to read the summaries it had just read).
  **A parent hears about its subtasks by their STATE, not by who talked to them** (`src/core/sessions/subtask-notices.ts`, same edges, same hook): whether or not it holds a request, a parent's session gets a `kind="notification"` envelope (no `request` attribute, `outcome` = `stopped` | `completed` | `error` | `blocked` | `waiting`) when a direct subtask's turn ends with the task still open (the body names who started that turn: the user, the parent's message, a trigger, another task), completes, errors, waits on a human prompt, or parks itself. 2026-09-30: a child's one request was answered, so its parent heard nothing more and lost it. One voice per edge (the request fallback speaks for a parent that is an asker; a child that answered its parent within 10 min is not reported "stopped", and its completion carries no quote); one message per parent per 3s burst, several envelopes inside; a newer `stopped`/`blocked`/`waiting` for the same child replaces the one still queued (stable id `sn-<child>-<kind>`); a COMPLETE parent or one with no session hears nothing; direct parent only; the child hears nothing back, so there is no loop. Delivery is the reply's path (`deliverToSession`, source `walnut-notify`, never reopening): a busy parent gets it mid-turn; a parent whose turn is over (idle, its task in NEED_ACTION) is woken only for `completed` and `error`, and a STOPPED parent session is never woken (2026-10-01: a task that had finished its own work was woken, and billed, every time the daily digest it once filed ended a trigger turn; a blocked worker needs the user, not its leader). It reads the rest when it next runs (`open_items`, `task_get`, its Board's live chips), and a reply it waits for (the request fallback) still wakes it. **A parent completes with its subtasks still open** (2026-10-04 user call: a leader whose worker was a recurring daily job could not be closed at all; the old `409 active_children` guard is gone, for humans and sessions alike). The subtasks are not touched: they keep running and keep their parent link, and `POST /api/v1/tasks/:id/complete` lists them in `open_subtasks`. A COMPLETE parent hears nothing more from them until it is reopened, and a reopen restores it all: no state notices (also not one in the 3s window), and the ones already queued for it are dropped at completion; no request fallback (a Walnut notice never goes into a COMPLETE asker's session); its pending asks to them become `withdrawn` (`quietCompletedParent`; `restoreWithdrawnAsks` puts them back on reopen); a reminder a session set on its Board waits; and a subtask's own `task_send` or reply to it is refused with `409 parent_complete` (`session-send-core.ts`, mirrored by the daemon's offline host), because a peer message would reopen it. Anyone else's message still reopens a completed task.
- **A teammate's message is the user's** (envelope notes in `src/core/peers/envelope-kit.ts`, line 7 of `src/core/sessions/session-context.ts`, `src/core/sessions/worker-question.ts`): every task works for the same user, so a peer note or a reply is the user's request and a decision it passes on is the user's; no envelope, prompt, skill or help text may say otherwise. A worker's `AskUserQuestion` goes to its leader as a `task_send` with `expect_reply`, never to the user's screen, and the CLI gets a deny that says where the question went; it stays with the user only when the leader is COMPLETE, has no session, or refuses the send. A leader's message to a worker waiting on a question is dispatched at once and closes it (`deliverToSession` `fromLeader`); a tool permission prompt still holds every message but the user's. 2026-10-05: the old "carries no user authorization" notes made a worker ask the user again for a go its leader had relayed, and the leader's follow-ups sat behind that prompt for an hour.
- **Right after a compaction, a session reads back what is still open** (`src/core/sessions/open-items.ts`): every Claude Code session is spawned with the CLI's own SessionStart hook (matcher `compact`, `src/providers/compact-open-items-hook.ts`, in the same `--settings` arg as the env), which runs `walnut tools call open_items '{"hook":"compact"}'` and puts the task's unfinished direct subtasks and its pending reply requests (both ways) into context, with no extra turn. A summary is the model's own writing: on 2026-09-30 one dropped a subtask still waiting on a review, and the parent then treated that work as nobody's. Nothing open = nothing injected; the command never fails (no error row); `WALNUT_COMPACT_OPEN_ITEMS=0` turns it off.
- Phase: `TODO` → … → `NEED_ACTION` → … → `COMPLETE` (an agent may set any phase, COMPLETE included: a parent that checked its subtasks' work may close them). A new message from a human or a peer task into a completed task's session reopens it to `IN_PROGRESS` (`session:input` with an allowlisted send source is the one path past the terminal guard, see `sendSourceReopensTerminal`); late results, hints and automated sends (auto-continue, routines, hooks) never do. `WAITING` (`src/core/phase.ts` `HELD_PHASES`, timer in `src/core/task-wait-until.ts`) parks a task until something happens: it stays in its board tier (the `wait` tier, labelled Parked, is a shelf, not a state) but leaves the default task list and tier cards (`showWaiting` in `TodoPanel`, revealed by "Show waiting" or a WAITING phase filter; search always finds it); nothing of the turn that set it moves it, whoever set it (its output, its end, a session error, the reconciler, a background agent coming back inside it: that `{running}` keeps the turn's `turnStartedAt` and is skipped as `held-this-turn`; a turn-start with no generation, the 30s snapshot pull, is never a new turn: `held-reconcile`, both in `applySessionPhase`), except a prompt that blocks on the human (NEED_ACTION); ANY new turn (a trigger fire, a human, a peer, the `wait_until` clock, which wakes the session with a `kind="trigger"` note or hands a sessionless task back as NEED_ACTION) moves it to `IN_PROGRESS`; a move into WAITING that names no `wait_until` gets `defaultWaitUntil()` = 3 days out (`DEFAULT_WAIT_DAYS`, `src/core/types.ts`), `""` asks for no clock; `trigger_create` on the caller's own task parks it by default (`wait:false` while work remains, `wait:true` for another task, `wait_until` takes ISO or `"6h"`/`"3d"`, parsed in `src/core/task-wait-clock.ts`; 2026-10-04: a session asked the user to "make a trigger" for a review it could watch itself, and the session prompt now says waiting is the session's job), and a park sends NO letter, whoever makes it (the 2026-10-04 receipt, one inbox letter per park, became one per re-park after every fire and was removed 2026-10-05; a stray `wait_report` is ignored); a background writer (sync pull, `internal`) may only COMPLETE it (`heldPhaseBlocks`), and a sync plugin whose manifest lacks `phases: ["WAITING"]` sees it as TODO (`src/core/plugins/legacy-phase-sync.ts`), so an older plugin never ends a wait by mapping a remote step back
- **NEVER force-kill Claude Code processes** — bypasses on-stop hook
- **Sessions render in TWO surfaces, both on the Homepage (`/`): the session columns
  (`SessionPanel`) and the chat slot.** The dedicated `/sessions` page was removed (2026-07-25);
  the route is now a redirect shim that reroutes `/sessions?id=…` deep links to the home session
  columns. The chat spot is the Ask Walnut slot (`AskWalnutSlot`): it hosts an embedded
  `SessionPanel` for the selected ask (every window control a column has, incl. the × which
  hides the slot; only lock is absent), and a `DraftSessionPanel` in its New state. The slot
  adds ONE control to the regular panel: a ≡ button leading the header's title row
  (`headerLeading`) that opens a drawer with a search box filtering the asks (tasks born
  `walnut_agent` OR filed under the agent's `Ask …` project), `New chat`, and two links
  (`Context`, `Fix Walnut`); tests reach those through `openAskWalnutDrawer(page)` in
  `tests/e2e/browser/draft-helpers.ts`. The drawer's TITLE is the agent switcher: every
  console agent (Walnut, Mentor, Note Assistant, config-defined) has its own list of asks and
  its own composer; a launch under another agent sends `agentId`, the server files the task
  under `Ask <name>` and stamps `task.agent_id` (rule in `src/core/sessions/ask-agent.ts`,
  client twin `askProjectFor` in `ask-walnut-slot-model.ts`; the persona comes from
  `buildLaneProfile(config, agentId)`). Deliberately NO `+ Task`/`+ Session`/finder/hide rows:
  the draft column is the one task-creation surface (a task with no session is a plain todo),
  ⌘⇧O is the session finder, the panel's × hides the slot. Consequence
  for tests: a Playwright locator for `.session-panel` or `.draft-session-panel` on `/` must be
  scoped to `.main-page-session-column` (see `REAL_PANEL` / `DRAFT_PANEL` in
  `tests/e2e/browser/draft-helpers.ts`) or pinned by `data-session-id`. The slot's panel sits
  earlier in the DOM, so an unscoped `.first()` grabs the wrong one. Tasks also have two
  surfaces: the Homepage `TodoPanel` (primary) and `/tasks` →
  `DashboardPage`/`TaskList`/`TaskCard` (secondary). Default to the Homepage panels for any
  Task/Session work, demos, and recordings.
- Concurrency: `tasks.json`/`sessions.json` use in-process + cross-process file locks
- **Skill discovery has TWO scopes — don't collapse them** (`src/core/skill-loader.ts`). The
  Personal AI's injected index (`buildSkillsPrompt` → `getPromptSearchDirs()`) covers workspace
  `skills/` + `~/.open-walnut/skills/` + shipped `dist/data/skills/` — deliberately **NOT**
  `~/.claude/skills/`, which is the Claude Code CLI's own store. The CLI discovers those
  deploy/close-session/plan skills natively when needed, so injecting them again would duplicate
  its own context. Management/`skill_view` scope
  (`getSearchDirs()`) still covers all four, so a claude skill stays listable and readable.
  Opt back in with `WALNUT_PERSONAL_AI_CLAUDE_SKILLS=1`. Measured: excluding them cut the Skills
  prompt section from 10.2K → 3.9K tokens (77 → 34 entries).

### Design Principle: host-local work belongs to the DAEMON, not the server

**Every host does its own work through its daemon; the walnut server stays a lightweight
coordinator.** If a computation only touches files/processes on ONE host (parsing that host's
session JSONLs, reading file contents, running git), it runs IN THE DAEMON on that host, and
only the (small) result crosses the tunnel — never the raw bytes, and never "N RPCs per file".
Ship data to the server on demand, at the granularity the UI actually consumes (a list, ONE
file's diff), not wholesale.

**The same split applies to RUNNING things, not just reading them: the server is the API, storage,
delivery and UI plane; a clock, a poll loop, a check script, anything that executes on a host, runs
in that host's daemon (precedent: walnut-trigger, `docs/plan/walnut-trigger.md`). Offload to the
daemon whenever the work can live there.**

Why (each learned the hard way): raw-bytes-over-tunnel hits the WS frame kills and the 32MB
read ceiling (whale JSONLs); per-file RPC fan-out floods the daemon socket and starves its
command timeout; and parse work on the server burns the ONE event loop every route shares.
The daemon has local fs + git + CPU right next to the data — a whale parse that took 40-80s
of chunked tunnel reads is seconds host-local.

Precedents: `git.diff` (daemon runs the whole diff host-side), `changes.compute`/`changes.file`
(daemon parses session JSONLs + reads contents host-side, returns a light list / one file),
snapshot-v1 (daemon folds its own stream files), `fs.resolvePath` (path-resolve-v1: the daemon
runs the whole layered path search on its own tree). When adding a feature that reads
session/host data, default to a daemon command + a thin server relay; only fall back to
DaemonFileReader byte-shuttling when the daemon genuinely can't own the work (e.g. cross-host
aggregation). Capability-gate new commands (`daemon-capabilities.ts`) so old daemons degrade to
the fallback path instead of erroring.

**Corollary — a search over host data is host work too, and a per-item RPC loop is the
anti-pattern.** The old path resolver lived on the SERVER and probed the daemon with ~2
`fs.stat` calls per ancestor level (~18 round trips on a deep path). It routinely spent its
whole 10s budget on latency, then returned a path that didn't exist, which surfaced as a raw
`ENOENT: scandir` in the Files tree. `fs.resolvePath` (`src/providers/path-resolve-core.ts`) is
the same logic moved next to the data: one RPC, and it can use signals the server never had
(the session transcript, `git ls-files --recurse-submodules`). Two rules it encodes: bound the
CANDIDATE SET, not just the clock (an unbounded suffix list burns the budget on tails that
can't match), and batch — every needle rides ONE `ls-files` call per repo root.

**Order search scopes by cost, not by completeness.** `git ls-files --recurse-submodules` is
the complete answer, and on a monorepo of 2,606 initialized submodules it costs **1.24s
regardless of outcome** — while the same pathspec against the superproject index alone costs
**45ms**, and a parallel fan-out over just the submodules under cwd costs **20ms**. Since a
path the model mentioned is almost always inside the subtree the session is working in, the
resolver tries superproject → submodules-under-cwd → submodules-under-cwd's-parent →
everything, returning at the first hit: 2.3s became **~85ms** on the real repo. Two things make
this safe to generalize: read `.gitmodules` as TEXT (~2ms; `git submodule status` stats every
submodule and takes seconds at that scale), and skip the whole submodule question outright when
`.gitmodules` is absent — an ordinary repo spawns exactly ONE `git ls-files` and never touches
the submodule path at all.

**A confident wrong answer is worse than an error.** Trimming leading segments is what lets
`repo/src/x.ts` find `src/x.ts`; taken to its limit it also let `no/such/thing.ts` "find" an
unrelated `other/thing.ts` and report `resolved: true`, so the user opened the wrong file
believing it was right. `MIN_NEEDLE_SEGMENTS` keeps at least one directory of context for any
multi-segment reference (a bare `Makefile` is exempt — there is no context to preserve).

**Parse a path reference before guarding or searching it** (`src/providers/path-ref-parse.ts`,
shared by the resolver and both HTTP edges). A path in prose arrives decorated: `` `a.ts` ``,
`a.ts:42`, `a.ts#L10-L20`, `a.ts(42,7)`, a trailing sentence period, Windows separators. Each
one used to become part of the name being searched for, so the file was missed; the position is
now parsed out and returned (`line`/`column`/`endLine`) instead. Two traps this file encodes:
check traversal SEGMENT-wise, not by substring (`mod..old/thing.ts` is an ordinary filename that
a substring check rejects outright), and note that any rule which can DELETE a `..` must run
after every rule that can CREATE one — trailing-noise trimming turned `a/b/..` into a clean-
looking `a/b` and laundered an escape past the safety check. A generated matrix pins that
invariant.

**Never answer a path question with an errno.** `/api/files/list` accepts optional
`cwd`/`sessionId` and, when the requested path can't be listed, resolves and retries, flagging
a stand-in via `requestedPath`. A dead-end error message in a file tree is a bug, not a
diagnosis: degrade to the nearest existing directory plus "couldn't find X".

### Remote Session Daemon (resilience model)

**Topology:** walnut (Mac) ←ssh tunnel→ daemon (remote bun binary) ←spawn→ `claude -p` CLI. Goal: tunnel/daemon crashes don't lose sessions.

**Remote files:** `/tmp/open-walnut/sessions.json` (registry), `/tmp/open-walnut-streams/<sid>.{pipe,jsonl,pgid}`. JSONL is source of truth.

**CLI lifecycle (READ THIS — easy to get wrong):**
- `claude -p --input-format stream-json` is **LONG-RUNNING**, NOT per-turn. One CLI process stays alive across many messages, reading new input from its FIFO stdin between turns. (Evidence: a session with 39 messages had only 4 spawns.)
- The daemon holds the FIFO open with `O_RDWR` (`daemon-standalone.ts`) so the pipe survives between turns. Process is reaped only by the **idle timer** (`SESSION_IDLE_KILL_MS = 2h`, 5-min warning) or a real death (ENXIO / pid gone / crash) — never "turn ended".
- `isTurnCompleteExit()` does NOT mean turns exit. It only runs *inside* `reapSession()` to normalize the exit code *when a death already happened*, deciding if the last JSONL `result` line was a clean turn-end vs a crash.
- `--resume <sid>` is the **fallback** path (FIFO write failed / process really died), not the normal send path. Normal send = write the live FIFO.

**Delivery paths (where mid-turn injection breaks):** A send to a session walnut thinks is "processing" (`activeProcessing`) goes through `injectMidTurn` (gated on `targetSession.hasPipe`); otherwise `processNext` (writes the FIFO directly, no hasPipe gate). Pitfall: `RemoteSessionManager._hasPipe` is set `true` only in `start()` — `attach()` (used when reconnecting to an already-alive CLI after a daemon restart) returns `alive:true` but historically left `_hasPipe=false`, so `injectMidTurn` falsely reported "no FIFO pipe" and queued the message until the turn ended (25–55s grey stall). Keep `_hasPipe` in sync with daemon-authoritative liveness, not with spawn-vs-attach.

**The server never signals a CLI pid; orphans end through the owning daemon.** A pid in a session
record proves nothing about which daemon spawned the process: on 2026-09-26 an ephemeral test server
over a hand-copied production `sessions.sqlite` SIGTERM'd the user's live CLIs from its orphan sweep.
Every server path that ends a CLI now sends the owning daemon's `stop` (`src/core/sessions/owner-stop.ts`),
and every such stop names the asking Walnut (`home`, capability `owner-home-v1`, `stop-provenance.ts`): the
daemon refuses one for a session its spawn journal records for another Walnut. Orphans use reason
`'orphan'` (capability `orphan-stop-v1`, fail-closed on old daemons), which the daemon honours only for a
process in its own registry (the pid it holds, a matching `.pgid` file in its own streams dir written at
spawn by it or by the daemon it took the session over from, a first spawn-journal line naming the asking
data dir) that nothing keeps alive. Ephemeral servers clear every
inherited pid at boot, refuse to boot on the production data dir, send `strict` stops (only sessions the
journal names them for), and send no stop at all to a daemon without `owner-home-v1`. Ratchet:
`tests/core/signal-call-ratchet.test.ts`.

**Daemon restart:** old `cleanup()` leaves CLI alive. New daemon reconciles sessions.json then scans `.pgid` files — scan MUST skip sids already adopted (`if (sessions.has(sid)) continue`). All death paths funnel into `reapSession()` in `daemon-core.ts`; it calls `isTurnCompleteExit()` to normalize code to 0 when JSONL tail shows clean turn completion (otherwise every turn-end shows "exit -1" in UI).

**Keep in sync:** `daemon-standalone.ts` (bun binary) + `daemon-source.ts` (JS fallback). Build: `bash scripts/build-daemon.sh`.

**Auto-deploy (use this):** `DaemonConnection` compares local `.version` vs remote `binary --version`; if differs, gzips + chunks binary into 1MB pieces, each via separate SSH connection (bypasses proxies that kill >5MB transfers), retries 2x per chunk, falls back to 44KB source deploy if chunked binary fails. Just `npm run build && bash scripts/build-daemon.sh && npm run dev:prod` — next UI send to that host auto-upgrades (old CLI processes survive via Phase C).

**Never scp manually** — some corporate SSH proxies kills large transfers. That's exactly what the chunked auto-deploy solves.

### CLI scheduled tasks (crons) are DIRECTORY-scoped, not session-scoped

Upstream docs say "session-scoped". They are wrong, and a 2026-08-09 incident here proved it: session A's recurring cron fired *inside session B* (same cwd) as a bare user message, running a multi-hour unattended job under `bypassPermissions` with zero provenance. Behavior model, established by controlled experiment (CLI 2.1.224):

| `durable` | Where it lives | Creator killed | Creator `--resume`d |
|---|---|---|---|
| `false` (CLI default) | in-memory | job dies, **no** other session can adopt it | **REVIVES** from history replay and immediately fires anything overdue |
| `true` | `{cwd}/.claude/scheduled_tasks.json` | the current **directory** lock holder (`scheduled_tasks.lock`) ADOPTS and executes it | creator reclaims it |

Consequences to keep in mind: killing a process is *never* a reliable way to stop a cron (only `CronDelete` is); recurring tasks auto-expire after 7 days; a creator schedules its own tasks without holding the lock (the lock only gates adopting *foreign* tasks); `CLAUDE_CODE_DISABLE_CRON=1` stops a bystander from ever adopting.

**Walnut can enforce `durable:false` — OPT-IN, delivered as daemon hooks (hooks-v1)**. Default posture is ZERO hooks: a generic install denies nothing, injects nothing, and never rewrites the user's `scheduled_tasks.json`. Two ways to opt in: (a) config sugar `session.cron_policy: 'session-only'` compiles the built-in rule set, or (b) install the self-contained template `src/data/hook-templates/session-only-cron.yaml` into `~/.open-walnut/hooks/` and edit freely (your file wins over the sugar by id). The server compiles `~/.open-walnut/hooks/*.yaml` with `runtime: daemon` into ONE rules JSON (`src/core/hooks/daemon-hooks.ts`) and pushes it via the `hooks.configure` RPC (NOT bridge-reachable; hash-skipped no-ops) at connect + hot on config change — no daemon restart needed on `hooks-v1` daemons; older daemons fall back to `WALNUT_ENFORCE_SESSION_CRON=1` set at spawn. The daemon interprets rules (never executes pushed code) at four points (`src/providers/daemon-core.ts` `evalDaemonHookRules`), in order of how much they can be argued with: (1) `cron.create` → `deny` the durable `CronCreate` at the `can_use_tool` intercept; (2) `cron.created` → `inject` a fixed "CronDelete + recreate non-durable" correction for bypass sessions which never ask — **advisory, and a live CLI verifiably refused it** on 2026-08-11, reasoning that an automated message is not user authorization (correct reasoning, which is why it can't be the guarantee); (3) `cron.fire` (foreign) → `evict` the orphaned row from disk — a foreign fire proves nobody in this process will ever CronDelete it, and eviction is the only thing that ends the hourly hijack loop (2026-08-13: 22 fires); (4) `session.reap` → `strip-own-rows` from `scheduled_tasks.json` — the model has no say, and death is exactly when a durable row becomes adoptable. Foreign fires always get a `scheduled_task_fire` stream marker for the HUMAN (observation), but deliberately NO model-visible message (the old injected warning burned a turn + context per fire and stopped nothing). Idle reapers treat a cron-armed session as long-lived (`hasDiskCronInterest`, 7d), and terminating one needs `force:true` (409 `cron_owner`). `WALNUT_ALLOW_DURABLE_CRON=1` on the daemon is the emergency kill-all override — better yet use crontab/launchd starting its own dedicated session for cross-session jobs.

**Debugging send/delivery latency (quick refs):**
- Both local (`__local__`) AND remote sessions go through the daemon / `RemoteSessionManager`. There is no separate "local" transport — don't assume a stall is SSH-specific.
- Logs: structured JSON at `/tmp/open-walnut/open-walnut-<date>.log` — but **timestamps are UTC** while the **filename is local date**, so a UTC-morning event lands in the *previous* local-day file. Filter by the UTC prefix, not the filename date.
- Daemon's own logs: `/tmp/open-walnut/daemon-d-*.log` (JSON). `state_transition` + `reconcile-adopt` show the long-running process being re-adopted across daemon restarts (proof of long-running CLI).
- Measure end-to-end honestly: `browser [send] dispatching` and `web session message via RPC` share the **same server-logger clock**, so pair them by `sessionId` (not by external `date`/bash time). Stages: `dispatching`→`session message via RPC`→`message enqueued`→`messages batched`→`message delivered`. The `deliveryMs` field only covers enqueue→delivered, so it *misses* any pre-enqueue event-loop lag.
- `scripts/walnut-logs.sh diagnose [sid] | busstorm [sid] | trace <sid> | pipe <sid> | session <sid> | delivery [sid] | slow [ms] | daemon <sid>` — see the log-toolkit section below. **For "send is slow", start with `diagnose <sid>` — it auto-labels the cause (Bug D mid-turn stall / event-loop starvation / slow resume).**

### Subsystem Map

The product is FOUR surfaces sharing one core: the **web console** (Mac,
:3456), the **iOS app** (`ios-native/`, SwiftUI, talks the frozen `/api/v1`),
the **cloud companion** (an EC2 instance you deploy, `WALNUT_CLOUD_MODE=1`
REPLICA — same codebase, proxies to daemons over the `/bridge` WS), and the
**session daemon** (bun/node twins deployed to every exec host — Mac local +
remote dev boxes — owning `claude` CLI processes so they survive tunnel/Mac
death).

| Subsystem | Entry point | Details |
|---|---|---|
| Model calls (providers, catalog) | `src/model/` | `sendMessage` + provider adapters |
| Core (tasks/sessions data) | `src/core/` | skill `walnut-core-internals` + [src/core/AGENTS.md](./src/core/AGENTS.md) |
| Sessions (local + SSH) | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Session daemon (twins) | `src/providers/daemon-standalone.ts` + `daemon-source.ts` | "Remote Session Daemon" section above |
| Web GUI | `src/web/`, `web/src/` | skill `walnut-web-frontend` + [web/src/AGENTS.md](./web/src/AGENTS.md) |
| iOS app | `ios-native/` (xcodegen; `project.yml`) | frozen contract [API v1](./docs/reference/api-v1.md) |
| Cloud companion | `src/web/ws/bridge-registry.ts`, `scripts/cloud/setup.sh` | infra: `infra/` (CDK); deploy = bundle→S3→SSM |
| Voice input (STT) | `src/core/stt/`, `src/web/routes/stt-v1.ts` | routes primary/bridge/openai by reachability |
| Memory & search | `src/core/memory-*.ts`, `src/core/search/`, `src/lib/hybrid-search/` | [hybrid-search README](./src/lib/hybrid-search/README.md) |
| Event bus | `src/core/event-bus.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Subagents | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Cron | `src/core/cron/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Plugins | `src/core/integration-*.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Chat history | `src/core/chat-history.ts` | skill `walnut-core-internals` |
| Usage tracking | `src/core/usage/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Git sync (data hub) | `src/integrations/git-sync.ts` | Mac ⇄ EC2 data plane; secrets NEVER ride it; every git spawn takes `gitChildEnv()` (`src/lib/git-env.ts`), because an inherited `GIT_DIR` outranks `cwd` and git exports one while running hooks |
| Logging & ops | `src/logging/` | skill `walnut-ops` + [src/logging/AGENTS.md](./src/logging/AGENTS.md) |
| Testing | `tests/` | skill `walnut-testing` + [tests/AGENTS.md](./tests/AGENTS.md) |

## Development

```bash
npm run build                 # Build server → dist/
cd web && npx vite build      # Build React SPA
cd web && npx vite            # Frontend hot reload (:5173, proxies to :3456)
npm run test:quick            # ⭐ DEFAULT — 306 pure-logic files, ~51s
npm test                      # Everything, sequential tiers (~10 min)
```

### Test pipeline: run the cheap layer, not the whole suite

Full details: [Testing pipeline](./docs/reference/testing-pipeline.md).

| Layer | Command | Time | When |
|---|---|---|---|
| L1 quick | `npm run test:quick` | ~51s | every code change |
| L2 focus | `npm run test:focus <path>` | 0.3–30s | one module |
| L3 pre-commit | `npm run test:pre-commit` | 1–6 min | before a larger commit — maps your diff → affected tiers |
| L4 CI | GitHub Actions, automatic | free | every push/PR |
| L5 live | `npm run test:live:cloud` / `test:live:daemon` | ~25s / ~2min | cross-machine feature sign-off — zero mocks, real cloud→bridge→CLI; asserts the CLI's actual reply. Mock-green ≠ working (2026-08-07: live layer's first run caught a spawn race no mock can reproduce) |

**The baseline is ONE known failure, not 118** (`d0ae758b` drove it from 121 to 1 by fixing root causes; `tests/setup/known-failures.json` is the record). Judge your change with `npm run test:baseline` — it fails ONLY on failures absent from that file. Never judge from the raw aggregate count, and never wave a pile of red away as "the baseline": at a baseline of 1, extra failures are your regression, another agent's uncommitted `src/` work in this shared worktree, or concurrency noise (fails in a 3-way parallel run, passes alone). Attribute before acting: re-run the file alone, and diff `git show HEAD:<file>` against the worktree to see whose change moved it. When you legitimately fix or add known failures, `npm run test:baseline:record`.

**CI failed?** `scripts/ci-status.sh brief` distils the run into the few real error lines; fix locally (free) rather than running an AI inside CI (paid).

⚠️ **Never raise the local worker budget** (`tests/setup/worker-budget.ts`, **1 worker**). Test fan-out hard-crashed this Mac twice in July 2026 AND again 2026-08-05 at 2 workers (concurrent agent sessions + real spawned servers/daemons live outside the V8 heap cap). Want faster? Use L1 or L2.

## E2E-First Development

**开发开始时必须实际调用 `/plan-develop-test-verify-review-commit`，不能只复述流程。** 若当前环境没有该 skill，明确说明并执行本节的等价验收要求，不假称已经调用。仅修改文档或配置时按实际影响验证，不为无 UI 改动启动浏览器。

**写代码前先列验收场景，主 agent 对最终结果负责。** 测试必须覆盖目标界面的真实使用路径与数据密度，以及相关的边界、并发、失败和恢复路径；不适用项说明原因。Mac app 的网页问题必须验证 WebKit，不能只测 Chromium。

**主 agent 必须亲自完成关键操作与证据检查。** 子 agent 可以协助，但其报告、简单文本样例、类型检查、测试进程已启动或部署成功，都不能代替用户流程验收。修复后重跑原始复现与相关回归，并确认验收的是最终构建；还有失败、未测关键场景或后台测试未结束时，只报告进度或阻塞，不能宣布完成。工具无法显示截图时明确说明，不把 DOM 检查说成肉眼审图。

- Bug fix: Playwright repro → fix → verify same flow → commit
- Feature: define E2E scenarios → implement → build → Playwright verify → commit
- Test UI changes as a real user with Playwright; for load bugs, test `/` and the reported URL 5× and report worst full-load time/errors.
- **NEVER** commit UI changes without Playwright verification
- **NEVER** use `page.goto()` — use real UI clicks (SPA navigation)
- Use `/verify` after implementation

### Playwright runs are machine-wide serialized (don't fight the gate)

Every browser worker is a whole Chromium (~385 MB measured). With several agent
sessions each running `npx playwright test`, this used to sum to dozens of browsers
and wedge the Mac (2026-07-25: load avg **225** on 14 cores, 1210 processes) — which
then surfaced as "Walnut is slow" and as runs dying with `Timed out waiting 30000ms
from config.webServer`. Concurrent runs were never safe anyway: specs hardcode
`localhost:3457`, and `reuseExistingServer` makes run #2 attach to run #1's fixture
server, so they share one dataset and the first to finish kills the other's server.

`playwright.config.ts` now engages a gate at config-load time (`tests/e2e/browser/pw-gate.ts`):

- **Exclusive lease on :3457** — a second run *queues* instead of interleaving. Seeing
  `[pw-concurrency] another Playwright run holds :3457 … Queuing` is correct behavior,
  not a hang. It self-heals (dead holder / 45-min TTL) and fails open.
- **`workers` capped at 4** (was `undefined` = half the cores = 7). Override with `PW_WORKERS`.
- **Orphan sweep** — reaps a fixture server left by a SIGKILLed run before
  `reuseExistingServer` can silently attach to it.
- **Overload wait** — if something else already saturates the box (concurrent vitest,
  Xcode, simulators), it waits rather than piling on. `PW_IGNORE_LOAD=1` skips it.

```bash
scripts/pw-cleanup.sh status   # browsers / fixture server / isolated daemons / leases
scripts/pw-cleanup.sh clean    # reap orphans + stale leases (skips live runs, never :3456)
```

**When a Playwright run fails on timeouts, check the load first** (`scripts/pw-cleanup.sh
status`). At load 486 every spec failed on `page.waitForLoadState` — those are starvation
artifacts, not product bugs. Fixture cold boot is ~20 s idle but ~70 s at load 133, so
`webServer.timeout` is 120 s.

**Never use `npx tsx` in a test hot path** — tsx is now a real devDependency; use
`./node_modules/.bin/tsx`. A bare `npx tsx --version` measured **88 s** on this machine,
which alone exceeded the old 30 s webServer budget.

## Testing

Every feature needs 1+ real E2E test through `startServer({ port: 0, dev: true })`. Only mock the Claude CLI. See [tests/AGENTS.md](./tests/AGENTS.md).

## Conventions

Plans: architecture diagrams first → UX scenarios → pseudocode. No detailed implementation code in plans.

### Menus & overlays (web UI) — hard rules

**Before touching any dropdown/menu/flyout in `web/src/`, read ["Menus & overlays — hard rules"](./web/src/AGENTS.md#menus--overlays--hard-rules).** Every rule there is a shipped incident. The one-line version: menus never overflow the viewport (always place via `useMenuPlacement`); unbounded content becomes its own portalled flyout, never inline growth; no native `<select>` inside styled menus; menu portals need `onPointerDown` stopPropagation or dnd-kit drags the row; outside-click closers must exempt child portals.

### Frontend logging: `import { log } from '@/utils/log'`

Use the structured logger (`log.info('subsystem', 'message', { sessionId, taskId })`) — never raw `console.log`. IDs must be **full, never truncated** so `grep <sessionId>` traces across browser + server. The logger routes through `console.log`/`warn`/`error` which the browser-logger monkey-patch forwards to `/tmp/open-walnut/`. Never use `console.debug` (invisible to forwarder).

### Where logs land (browser crashes included)

| What | Where |
|---|---|
| Server structured JSON (+ forwarded browser console) | `/tmp/open-walnut/open-walnut-<date>.log` — filter browser lines with `jq 'select(.subsystem=="browser")'` or `open-walnut logs -s browser` |
| Every HTTP request (method/path/status/ms/reqId) | same file, `subsystem=web` (request-logger middleware) |
| Uncaught JS exceptions / unhandled rejections / React render crashes | forwarded as `subsystem=browser` `[uncaught]` / `[unhandledrejection]` / `[react]` / `[error-boundary]` entries. Delivery: WS RPC when connected; REST `POST /api/browser-logs` fallback when WS is down (e.g. crash before mount) |
| Daemon logs | `/tmp/open-walnut/daemon-d-*.log` |
| Server exit trace | `/tmp/open-walnut-exit.log` |

**"Blank page" triage:** grep the local-date AND previous-day files (UTC timestamps vs local filename!) for `error-boundary`, `\[react\]`, `\[uncaught\]`, and `JSON parse failed`. A repeated crash self-heals via `web/src/utils/crash-recovery.ts` (clears sessionStorage → then walnut localStorage keys + skips one prefs merge); the heals also log `[crash-recovery]`.

## Log investigation toolkit: `scripts/walnut-logs.sh`

One entry point for digging through Walnut logs (structured JSON at `/tmp/open-walnut/open-walnut-<date>.log`). Needs `jq`.

```bash
scripts/walnut-logs.sh diagnose [sid] [mins]  # ⭐⭐ START HERE for "message is slow": auto-labels each send's cause
scripts/walnut-logs.sh busstorm [sid] [mins]  # ⭐ streaming fan-out per subscriber (verify interest-set / spot a storm)
scripts/walnut-logs.sh trace <sid>       # per-message timeline dispatch→RPC→enqueue→route→delivered + Δms/hasPipe/path
scripts/walnut-logs.sh pipe <sid>        # hasPipe / lifecycle transitions — why a send was queued
scripts/walnut-logs.sh session <sid>     # full timeline for a session
scripts/walnut-logs.sh delivery [sid]    # message enqueue→delivered latency (deliveryMs)
scripts/walnut-logs.sh slow [ms]         # deliveries slower than ms (default 3000) — find lag
scripts/walnut-logs.sh daemon <sid>      # which daemon-d-*.log serves a sid
scripts/walnut-logs.sh jsonl <sid>       # tail the session's CLI .jsonl stream
scripts/walnut-logs.sh file <substr>     # ⭐ ONE timeline for ONE file: reads + writes + refusals + the editor's decisions
scripts/walnut-logs.sh stalls [mins]     # ⭐ "the server froze": stall flight records (verdict, loop CPU vs hold, GC, paging) + kept CPU profiles
scripts/walnut-logs.sh req <id> | task <id> | errors [n] | tail [n]
```

**When the whole server froze, run `stalls` before anything else.** The stall flight recorder
(`src/core/stall-recorder.ts`) keeps a CPU profile of every hold of 2 s or more and tags it with a
verdict; `node scripts/stall-profile-summary.mjs` (newest profile, or a path) prints the functions
the loop was in during the hold, with file:line. `cpu` means Walnut code held the loop, also on a
busy machine: when the kept profile shows code on the thread for most of the hold (`profileHold`,
with its top frames) or the thread burned a stall's worth of CPU in it, the verdict is `cpu` and
`loadStretched: true` says the load made it longer. Fix that code first. Trust the profile's
functions only for `cpu` or `gc`: profiles sample on a wall clock, so a `starved` thread (runnable,
not run, and with little of its own to run: the loop thread ran a few ms of the hold) is sampled
wherever it stopped. `starved`, or `paging`/`off-cpu` with a large `decompressions` or `swapins`
count, is the machine (CPU load, memory) rather than a Walnut code path.

**"Who overwrote my file?" starts with `file <path-substring>`.** Every read logs `file read`
(status 200/304, the hash the client now holds, the token it quoted, `track`, size, ms), every
write logs `file write` (writer user/live/merge, origin, hash before/after, the token presented,
size before/after, `shrankBy`), and every refusal logs `file write refused` with a `reason` that
matters: `stale-lock` is the guard working (two writers raced, the editor will merge), while
`unlocked-machine-write` means a client bug reached the server and should be ZERO. The browser side
logs `[file-editor] buffer installed` (which path replaced the buffer, the generation, the lock
before and after) and `[file-editor] live write sending` (`armedMs`, `armedGen` vs `currentGen`), so
the causal chain reads in order: a read teaches the editor a hash, the lock advances, a write goes
out under it. That chain is exactly what the 2026-09-05 stale-write-back incident had to be
reconstructed by hand from three message shapes across two files. A `live`/`merge` write with a
large `shrankBy` is that bug's signature.

**When a user reports "message send is slow", run `diagnose <sid>` first.** It pairs each message's enqueue→route→delivered by `messageId` and prints a labelled cause per message + p50/p90, so you don't hand-grep. Labels it distinguishes (these are the known distinct root causes — don't conflate them):
- **BUG D: mid-turn stall** — `injectMidTurn` on a stale `hasPipe=False` (remote sessions). The felt 30–50s QUEUED. Fixed by delegating to processNext; if this label reappears, the fix regressed.
- **EVENT-LOOP STARVATION** — dispatch→enqueue blocked. Was caused by streaming fan-out to global subscribers; fixed by the event-bus `interest` set. Cross-check with `busstorm`.
- **SLOW RESUME** — CLI dead, cold `--resume` path (inherently slower, not a bug).
- **SLOW DELIVER / STUCK** — catch-alls; fall back to `trace`/`pipe` for the timeline.

Both `diagnose` and `busstorm` default to a **30-min window** (so old historical stalls don't masquerade as "happening now"); pass a 3rd arg `mins` (e.g. `120`, or `0` for all-time) to widen it. Timestamps are UTC.

Message-send latency is logged as `message delivered {deliveryMs, path, messageId}` at every delivery point (`path` = stdin / mid-turn / resume). `messageId` (`qm-…`) is the cross-layer request id — grep it to trace one message end-to-end.

## Debugging the Claude Code CLI (stuck / silent sessions)

When a session goes `idle` with no output, gets stuck mid-turn, or the CLI appears hung, check **Claude Code's own trace log**. Walnut passes `--debug` to every `claude -p` spawn by default, so this log is always available.

```bash
WALNUT_CLAUDE_DEBUG=0 npm run dev:prod    # opt out if you need to
```

The flag is added in `src/providers/claude-code-session.ts`. Works for both local and remote (daemon) sessions; args are forwarded through the daemon unchanged.

**Where logs land:**

| Session type | Path |
|---|---|
| Local | `~/.claude/debug/<claude-session-id>.txt` |
| Remote (daemon on clouddev etc.) | `~/.claude/debug/<claude-session-id>.txt` **on the remote host** |

A `latest` symlink in the same dir always points at the most recent file.

```bash
tail -F ~/.claude/debug/latest                         # follow local
ssh clouddev tail -F '~/.claude/debug/latest'          # follow remote
```

**Verbosity knobs** (also env vars — export before `npm run dev:prod`; for remote, set them where the daemon was started):

- `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` — include high-volume diagnostics (statusLine, shell, cwd, stdout/stderr). Default is `debug`, which filters those out.
- `CLAUDE_CODE_DEBUG_LOGS_DIR=/some/path` — override the `~/.claude/debug/` directory.
- `OTEL_LOG_TOOL_DETAILS=1` — capture full tool input/output in OTEL spans (separate from the `--debug` file).

**CLI flags** the fork supports (in case you want to invoke `claude` manually to repro):

- `--debug` / `-d` — enable debug mode (what Walnut injects)
- `--debug-file <path>` — write to a specific file (implicitly enables debug)
- `--debug-to-stderr` / `-d2e` — write debug to stderr instead of a file

The implementation lives in the fork at `~/workplace/myCode/claude-code-fork/claude-code-source-code/src/utils/debug.ts` — `logForDebugging()` is called throughout the CLI. All flags are already compiled into `fork-2.1.88`; no rebuild required.

### The "malware reminder" on every file read

If you're seeing `<system-reminder>Whenever you read a file, you should consider whether it would be considered malware…</system-reminder>` appended to every `Read` tool result, that's **not Walnut** — it's `@anthropic-ai/claude-agent-sdk`'s `CYBER_RISK_MITIGATION_REMINDER`. The SDK injects it unless the active main-loop model is in a hardcoded exempt set. Upstream only lists `claude-opus-4-6`; newer models (4.7, Sonnet, …) get the reminder on every read, eating context.

We maintain a `patch-package` patch at `patches/@anthropic-ai+claude-agent-sdk+<version>.patch` that **disables the reminder for all models** — it rewrites the ternary `X4z()?j4z:""` in the minified bundle to just `""`, so no file read ever appends the reminder regardless of main-loop model. It reapplies automatically on `npm install` via `postinstall`. When bumping the SDK version: re-apply the edit to `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (grep for `considered malware` to locate the template literal, then find and rewrite the ternary that conditionally appends it) and regenerate with `npx patch-package @anthropic-ai/claude-agent-sdk`.
