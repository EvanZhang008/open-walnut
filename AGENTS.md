# Open Walnut: Personal AI

> **ACP reference implementation:** https://github.com/agentclientprotocol/claude-agent-acp (public).
> **References**: [ARCHITECTURE.md](./ARCHITECTURE.md) | per-directory `AGENTS.md` files are
> concise quick-references; the **deep implementation details live in skills** (auto-discovered,
> load on demand): `walnut-core-internals` (src/core/),
> `walnut-web-frontend` (web/src/), `walnut-testing` (tests/), `walnut-ops` (incidents + src/logging/).
> Load the matching skill before non-trivial work in that area.
> **Important docs:** browse [`docs/`](./docs/README.md) first; model work starts with
> [Claude model configuration](./docs/reference/claude-model-configuration.md).
> **This file holds only what every session needs before it touches anything** (40 KB cap,
> `tests/docs/agents-md-size.test.ts`). Each rule below is one line with a pointer to its full
> text, incident dates and ratchet tests. Put new detail in the pointed file, never here.

## Ownership: You Are the CTO

**Act as the CTO of this repo: proactive, decisive, and accountable for the outcome.**
Don't wait to be told the obvious next step or stop to ask which way to go when the
intent is clear. Weigh the trade-offs (UX, maintainability, performance, blast radius,
root cause vs. band-aid), pick the option you'd defend in a design review, and state the
call and the reasoning as you go. When a choice is genuinely the user's (irreversible, a
real product fork, or it contradicts a stated preference) surface it with a
recommendation; otherwise pick the obvious option and proceed. Fix root causes, not
symptoms. Verify your own work (build + real-UI E2E) before claiming it's done. Default to
finishing the whole job.

**Done means live on prod, and you saw it there.** A change is finished only when it is
committed, deployed to the live server on :3456, and you opened live prod yourself and
watched it work (the real UI for a UI change, a read-only check for the rest). After the
review, commit and deploy on your own; never end with "committed, not deployed, say deploy".
The shared tree almost always holds other agents' uncommitted work, so deploy the commit, not
the tree: `bash scripts/deploy-committed.sh` builds the committed HEAD in a clean clone and
serves it (queued, at most one restart per 10 minutes, skipped when prod already serves it).
Never wait for the tree to be clean, and never stash, revert or commit their files to get
there. If a deploy guard refuses (type-check, smoke boot, cooldown), fix what it names or
report it as the blocker. Scope the commit to your own changes only, and run the usual
pre-commit sensitive-content scan. Push still only happens on request. How the deploy works:
`docs/reference/production-server.md`.

## CRITICAL: Open Source Repository

**PUBLIC repo. Every commit is visible to the internet.**

No company-internal names, personal info, internal URLs, credentials, or internal processes. Generic descriptions only. Internal plugins go in `~/.open-walnut/plugins/` (never committed). **When in doubt, leave it out.**

## Every feature works for anyone who installs it

Walnut and its plugins ship to the public, so nothing may work only on the maintainer's machine
(2026-11-01: a Focus block's macOS Do Not Disturb, the network relay). Set it up for the user in
one click where the platform allows it; where it needs a step only they can take (a permission,
an OS setting, a port on their own server), walk them through it in place, showing the exact
screen, and check that it worked. Where the maintainer picked one way for himself (his own relay,
say), the other reasonable ways stay options for everyone else. Never depend on a file, shortcut or
setting that exists on one machine only.

**Walnut never sets an engine's own defaults.** The default model and settings of an underlying
agent (Claude Code, Codex and the rest) belong to that agent's own settings; Walnut only passes a
model someone chose and lists each engine's models, so it stays generic and works the same on every
platform.

## Experimental behavior

New behavior that changes what users see by default ships behind an experimental flag.
Add its id, name, description and default (`false`) to `src/core/experimental.ts`; Settings
shows one switch per entry. Only an explicit choice enables it. Keep today's behavior when
the flag is off. When the experiment ends, remove its switch or change its registry default.
Store overrides in `Config.experimental`, preserve unknown boolean flags for newer versions,
and keep automated preference writes in the test run's own copy.

## Existing users keep working and keep upgrading

Every change reaches people who already run an older Walnut. Before it lands, make sure:

- **It still works for them.** Data an older version wrote opens and reads the same, and a
  host, daemon, phone app or companion still on the older version keeps working with it.
- **They can upgrade.** The updater their OLD version already has (npm, the install script,
  Homebrew, the Mac app) takes them to the new one with no manual step.
- **They can go back.** The previous release still starts on data the new one wrote, or
  refuses with a clear message; it never corrupts it.

Prove it against the real published release, not only the new code
(`scripts/release-rehearsal/`). Keep the way across simple: one obvious path per install
kind, not a pile of special cases.

## Multi-Agent Safety

- **NEVER** delete/revert other agents' changes or switch branches unless asked
- No `git stash`, no `git worktree` ops unless explicitly requested
- On "push": `git pull --rebase` OK. On "commit": scope to your changes only
- If build fails, retry: another agent may be mid-commit
- Bug investigations: read npm dep source + all related code before concluding
- Code style: brief comments for tricky logic; files under ~500 LOC

## Production Server Safety

**Port 3456 = PRODUCTION. NEVER kill, restart, or interfere with it by hand: the deploy
scripts below are the only way to replace it.** Full detail (deploy internals, smoke boot and
rollback, plugin check, compiled file, asset mirror, priority, ephemeral isolation, test runs,
sandbox): `docs/reference/production-server.md`.

### Never block the web server (each rule = a shipped outage)

- **No sync blocking on the event loop** (`execSync`, sync native-addon calls, multi-MB parse): one call freezes EVERY route. Child process + timeout + cached value instead (`setImmediate` doesn't help). Ratchet: `tests/core/event-loop-blocking-ratchet.test.ts`.
- **Every route touching daemon/SSH/network/whale files needs a deadline**: answer degraded (204/stale), never hang: one pinned response starves the browser's 6-connection pool, giving app-wide fake 15s timeouts.

```bash
bash scripts/deploy-committed.sh  # Deploy the committed HEAD (clean clone), restart 3456
bun run dev:prod        # Build the working tree as it is, restart 3456
bun run dev:ephemeral   # Ephemeral server (random port, temp data, auto-cleans)
bun run dev:ephemeral -- --file [<walnut file>]   # the same, running a compiled file
WALNUT_DEVPROD_DRY_RUN=1 WALNUT_DEVPROD_PORT=35999 TMPDIR=/tmp/dry bash scripts/dev-prod.sh  # guards only
```

The full rehearsal of a real deploy away from production (`WALNUT_DEVPROD_REHEARSAL=1`) and its
cleanup are in `docs/reference/production-server.md`.

- **Live verification runs on an ephemeral server, never on :3456.** Anything that creates tasks, sessions, notes or cron jobs to prove a change runs on `bun run dev:ephemeral`; reading :3456 is fine. The ephemeral server is isolated by construction (own data copy, daemon, paused crons, no sync, no remote hosts, keyword search only).
- **A check that must write on :3456 runs as a test run** (`x-walnut-test-run: <label>`, `src/core/test-run.ts`): its objects stay off the user's board and are swept after 6 h; delete what you made anyway, never touch the user's own objects.
- **Testing a task sync plugin** needs `WALNUT_ALLOW_REMOTE_SYNC_IN_TEST=1` and writes to the user's real account: change only tasks you created, clean them up, report what you removed.
- **Deploys smoke-test, plugin-check and roll back.** dev-prod.sh proves prerequisites before the first destructive step, stays portable (Linux too), boots the new build in isolation before the kill and relaunches the last good build on failure.
- **Launch dev:prod from a non-niced shell**, and **NEVER wrap `bun run dev:prod` in a bare `launchctl submit`** (KeepAlive turns a one-shot deploy into a kill-the-server loop; 2026-07-25).
- **Onboarding, provider tests and demos** use `scripts/walnut-sandbox.sh` on :3457 (it refuses :3456).

## What Is Walnut

Personal AI: tasks + knowledge + AI sessions. **Tasks are the atom.** `Project → Folder → Task → Subtask`. A folder (`task.group_id`) is optional and belongs to exactly one project; a task with no project lives in the **Inbox** (`project = ''`). Event Bus connects everything. See [ARCHITECTURE.md](./ARCHITECTURE.md).

### Key Rules for Implementation

One line per rule; the full rule, its incident and its ratchet tests are in the file named.

Tasks and teams (`docs/reference/tasks-and-teams.md`):

- **Parse harness-owned data the harness's official way**: port the owner's own logic (the CLI's `parentUuid` chain walk); Walnut-invented bookkeeping only in Walnut-owned formats. (`docs/reference/session-lifecycle.md`)
- `task_create` takes an optional `project`; an unknown name auto-creates the registry row (`task_projects`, source `'local'`). Inbox (`''`) has no registry row and can never be claimed by a sync provider.
- **Work created from inside a task lands beside it** (`caller-placement.ts`): the caller's project, folder and tier, filed as its subtask; naming another project needs `project_reason`. (`docs/reference/tasks-and-teams.md`)
- **Server brakes, never prompt-only**: subtasks at most 3 levels deep, per-host start slots with an explicit wait, and a session's task title cut to a few words. (`docs/reference/tasks-and-teams.md`)
- **A subtask is a teammate, not a step** (one area, one per ask, more work goes to it with `task_send`); **a leader adopts and keeps a Board** (`src/core/boards/`). (`docs/reference/tasks-and-teams.md`)
- **A parent always hears when its child stops**, and about its subtasks by their STATE; a parent completes with subtasks still open; `team_stop` stops a whole team. (`docs/reference/tasks-and-teams.md`)
- **Phase** `TODO` → … → `NEED_ACTION` → … → `COMPLETE`; a person's or a peer's message reopens a completed task (late results, hints and automated sends never do); `WAITING` parks only on a wait outside Walnut and the user, with a 4 h default clock. (`docs/reference/tasks-and-teams.md`)

The user's status (`docs/reference/user-status.md`):

- **One status the user reads, the same everywhere** (`src/core/user-status.ts`): derived from the phase plus facts, stored as `user_status`; only a real ask is Needs you. (`docs/reference/user-status.md`)
- **A status change is pushed one level up, and a "needs you" says when it was checked** (`status-push.ts`, `needs-recheck.ts`). (`docs/reference/user-status.md`)
- **One decision shows once**: tasks of one team asking the same fold to one ask, a reworded ask keeps its decision id, and an answered ask stays answered. (`docs/reference/user-status.md`)

Hints (`docs/reference/message-hints.md`):

- **Walnut text that rides a message is a message hint, defined in ONE registry** (`src/core/hints/`); every send path calls `prepareHintedSend`. (`docs/reference/message-hints.md`)
- **Text Walnut adds to every message costs every session on every turn**: only when nothing else can carry it, a line or two, measured in bytes before landing. (`docs/reference/message-hints.md`)

The org and the inbox (`docs/reference/org-and-inbox.md`):

- **Main and every lead keep a Brief for the user**: three fixed sections, edited any time with `brief_read`/`brief_write`, refreshed while the user looks. (`docs/reference/org-and-inbox.md`)
- **Main and every lead keep Threads**: every request of the user is filed per subject; the node keeps each current and shows it to him only when it has something for him. (`docs/reference/org-and-inbox.md`)
- **A thread goes with its work** (`thread-follow.ts`) to the lead whose team now does it. (`docs/reference/org-and-inbox.md`)
- **Main and every VP never do the work themselves** (at most 3 look-only commands a turn, then hand on); Walnut reminds them and never refuses a call. (`docs/reference/org-and-inbox.md`)
- **Main and every VP start by themselves, and one switch turns the whole org off** (`org.enabled: false`). (`docs/reference/org-and-inbox.md`)
- **The inbox is for what needs the user**: a decision, a review, or a report he asked for; never progress, a park or an FYI. (`docs/reference/org-and-inbox.md`)
- **Every letter says who it is from, first** (`letter-origin.ts`); **Inbox Triage keeps standing routing rules** (`triage/routing-rules.ts`). (`docs/reference/org-and-inbox.md`)
- **One place per update**: a thread's news stays in its thread, never also a letter; **while the user is away**, what needs him goes to his inbox in one thread. (`docs/reference/org-and-inbox.md`)
- **The team charter: the task doing the work decides it** (`src/core/team-charter.ts`); only the user's own kinds go to him, checked through `user_kind`. (`docs/reference/org-and-inbox.md`)
- **`sentBy: "person"` is the user's own word, so only text a person typed carries it** (`send-frame.ts`); another session's mail is never a person's. (`docs/reference/org-and-inbox.md`)
- **Every human action is an agent action too**: no route refuses a session caller for being one; writes record `by`. Ratchet: `tests/core/agent-parity-ratchet.test.ts`. (`docs/reference/org-and-inbox.md`)

Sessions (`docs/reference/session-lifecycle.md`):

- **After a restart, Walnut resumes the work a restart interrupted, and only that** (`session-auto-recover.ts`, `restart-loss.ts`). (`docs/reference/session-lifecycle.md`)
- **A session never stays stuck on "Prompt is too long"**: Walnut compacts it and resends what got no answer. (`docs/reference/session-lifecycle.md`)
- **Right after a compaction, a session reads back what is still open** (SessionStart hook, `open_items`). (`docs/reference/session-lifecycle.md`)
- **A task keeps the user's unanswered messages, not its summary** (`user-asks.ts`). (`docs/reference/session-lifecycle.md`)
- **An op call whose answer is lost says what is known, and a resend runs it once** (call ids, `op_result`). (`docs/reference/session-lifecycle.md`)
- **A message to a host nothing reaches waits for that host, and says so**; **a host whose link keeps dropping reads unstable**. (`docs/reference/session-lifecycle.md`)
- **task_history reads short when asked** (`compact`, `limit`, `since`). (`docs/reference/session-lifecycle.md`)
- **A session hears where its task stands now when that moved**, and **a running session hears its default instructions that changed**. (`docs/reference/session-lifecycle.md`)
- **Every task has a working directory that survives reboots** (`WALNUT_TASK_DIR`); no clone or commit in a temp dir. (`docs/reference/session-lifecycle.md`)
- **A session whose working folder is gone keeps working** ("Continue in a new folder"; the old folder is never recreated). (`docs/reference/session-lifecycle.md`)

Machine guards (`docs/reference/agent-guards.md`):

- **NEVER force-kill Claude Code processes**: it bypasses the on-stop hook.
- **A CLI's command line carries paths, never content; nobody kills by pattern** (`pkill`, `killall` refused). (`docs/reference/agent-guards.md`)
- **Type checks never pile up**: a new `tsc`-style check is refused while the session's own one still runs, or the machine already runs one per 16 GB of memory. (`docs/reference/agent-guards.md`)
- **No agent makes sound or takes foreground input on the machine it works on** (no `say`/`afplay`, never change or unmute the volume, no `cliclick`-style input); test browsers and the Simulator stay silent and in the background. (`docs/reference/agent-guards.md`)

Web and core:

- **Sessions render in TWO surfaces, both on Home**: the session columns and the Ask Walnut slot; scope Playwright locators to `.main-page-session-column`. (`.claude/skills/walnut-web-frontend/SKILL.md`)
- Concurrency: `tasks.json`/`sessions.json` use in-process + cross-process file locks.
- **Skill discovery has TWO scopes**: the Personal AI's index leaves out `~/.claude/skills/`; management covers all. (`.claude/skills/walnut-core-internals/SKILL.md`)

### Design Principle: host-local work belongs to the DAEMON, not the server

Every host does its own work through its daemon; the server stays a lightweight coordinator
(API, storage, delivery, UI). Work that touches one host's files or processes, and anything that
runs on a host (a clock, a poll loop, a check script), runs in that host's daemon, and only the
small result crosses the tunnel, at the granularity the UI consumes. A host self-manages from its
read copy and goes to the leader only for what it cannot answer alone. Capability-gate new daemon
commands (`daemon-capabilities.ts`). Detail and the path resolver's rules:
`docs/reference/session-daemon.md`.

### The cloud companion is a replica with capabilities, nothing more

A server is the leader (the Mac) or a replica; the companion is a replica that turns on
capabilities (`src/core/capabilities.ts`). Never ask "am I the companion" in a feature or a client
(no new `WALNUT_CLOUD_MODE`, `isCompanion()`, `placement() === 'cloud'`): ask `isFollower()` / `role()`,
`leaderAnswers()` or `hasCapability(<name>)`; a new feature of one box is a new capability. Ratchet:
`tests/core/companion-is-a-replica-ratchet.test.ts` (counts only fall). Detail:
`docs/reference/session-daemon.md`.

### Remote Session Daemon (resilience model)

Topology: walnut (Mac) ←ssh tunnel→ daemon ←spawn→ `claude -p` CLI; the JSONL is the source of
truth. Rules every session must know (detail: `docs/reference/session-daemon.md`):

- `claude -p --input-format stream-json` is **LONG-RUNNING**, not per-turn; `--resume` is the fallback.
- The server never signals a CLI pid; orphans end through the owning daemon (`owner-stop.ts`).
- One CLI per session id on a host, whichever daemon asks (`cli-owner-core.ts`).
- A session's `walnut` call reaches only its own Walnut's server; a task whose host is gone is never stuck.
- A session's stdin FIFO is write-only (0200): nothing but its CLI may read it.
- **Keep in sync:** `daemon-standalone.ts` (bun binary) + `daemon-source.ts` (JS fallback). Build: `bash scripts/build-daemon.sh`. The daemon auto-deploys in chunks; **never scp manually**.

### CLI scheduled tasks (crons) are DIRECTORY-scoped, not session-scoped

A `durable:true` cron is adopted by any session in the same directory; killing a process never
stops a cron, only `CronDelete` does. Walnut's enforcement is opt-in daemon hooks
(`session.cron_policy: 'session-only'`). Detail: `docs/reference/session-daemon.md`.

### Subsystem Map

The product is FOUR surfaces sharing one core: the **web console** (Mac,
:3456), the **iOS app** (`ios-native/`, SwiftUI, talks the frozen `/api/v1`),
the **cloud companion** (an EC2 instance you deploy: a replica with capabilities, its daemons
dialing in over the `/bridge` WS), and the
**session daemon** (bun/node twins deployed to every exec host, Mac local +
remote dev boxes, owning `claude` CLI processes so they survive tunnel/Mac
death).

| Subsystem | Entry point | Details |
|---|---|---|
| Model calls (providers, catalog) | `src/model/` | `sendMessage` + provider adapters |
| Core (tasks/sessions data) | `src/core/` | skill `walnut-core-internals` + [src/core/AGENTS.md](./src/core/AGENTS.md) |
| Sessions (local + SSH) | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md), [session lifecycle](./docs/reference/session-lifecycle.md) |
| Session daemon (twins) | `src/providers/daemon-standalone.ts` + `daemon-source.ts` | [session daemon](./docs/reference/session-daemon.md) |
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
| Git sync (data hub) | `src/integrations/git-sync.ts` | Mac ⇄ EC2 data plane; secrets NEVER ride it ([cloud sync](./docs/reference/cloud-sync.md)) |
| Org, Brief, Threads, inbox | `src/core/org/`, `src/core/human-inbox/` | [org and inbox](./docs/reference/org-and-inbox.md), [user status](./docs/reference/user-status.md) |
| Logging & ops | `src/logging/` | skill `walnut-ops` + [src/logging/AGENTS.md](./src/logging/AGENTS.md) + [logs and debugging](./docs/reference/logs-and-debugging.md) |
| Testing | `tests/` | skill `walnut-testing` + [tests/AGENTS.md](./tests/AGENTS.md) |

## Development

```bash
bun install                   # Dependencies; git and bun 1.4.4+ are all a checkout needs
bun run build                 # Build server → dist/
cd web && bun x vite build    # Build React SPA
cd web && bun x vite          # Frontend hot reload (:5173, proxies to :3456)
bun run test                  # ⭐ DEFAULT (= test:local): the tests of your change, about a minute
bun run test:land             # what the land check runs: every test the change needs, a few minutes
bun run test:quick            # the whole quick tier, ~3,200 files
bun run test:ci               # Everything CI runs: quick, slow, e2e, frontend, one after another
```

### Test pipeline: run the cheap layer, not the whole suite

Full details: [Testing pipeline](./docs/reference/testing-pipeline.md).

| Layer | Command | Time | When |
|---|---|---|---|
| L0 local | `bun run test` (`test:local`) | about 1 min | every code change: the change's own tests, fast importers, scan tests |
| Land | `bun run test:land` | a few min | before a land (the land check runs it): every test the change needs, to the end |
| L1 quick | `bun run test:quick` | ~10 min at 8 workers | a change that reaches far; the push gate runs it |
| L2 focus | `bun run test:focus <path>` | 0.3 to 30s | one module |
| L3 pre-commit | `bun run test:pre-commit` | 1 to 6 min | before a larger commit: maps your diff → affected tiers |
| L4 CI | GitHub Actions, automatic | free | every push/PR |
| L5 live | `bun run test:live:cloud` / `test:live:daemon` | ~25s / ~2min | cross-machine feature sign-off: zero mocks, real cloud→bridge→CLI; asserts the CLI's actual reply. Mock-green ≠ working (2026-08-07: live layer's first run caught a spawn race no mock can reproduce) |

**The baseline is ONE known failure, not 118** (`d0ae758b` drove it from 121 to 1 by fixing root causes; `tests/setup/known-failures.json` is the record). Judge your change with `bun run test:baseline`: it fails ONLY on failures absent from that file. Never judge from the raw aggregate count, and never wave a pile of red away as "the baseline": at a baseline of 1, extra failures are your regression, another agent's uncommitted `src/` work in this shared worktree, or concurrency noise (fails in a 3-way parallel run, passes alone). Attribute before acting: re-run the file alone, and diff `git show HEAD:<file>` against the worktree to see whose change moved it. When you legitimately fix or add known failures, `bun run test:baseline:record`.

**CI failed?** `scripts/ci-status.sh brief` distils the run into the few real error lines; fix locally (free) rather than running an AI inside CI (paid).

⚠️ **Never raise the local worker budget** (`tests/setup/worker-budget.ts`, **1 worker**). Test fan-out hard-crashed this Mac twice in July 2026 AND again 2026-08-05 at 2 workers (concurrent agent sessions + real spawned servers/daemons live outside the V8 heap cap). Want faster? Use L1 or L2.

## E2E-First Development

**At the start of development, actually invoke `/plan-develop-test-verify-review-commit`; do not
just restate its steps.** If the skill is not available here, say so and meet this section's
acceptance bar instead; never claim it was invoked. A docs-only or config-only change is verified
by its real effect; do not start a browser for a change with no UI.

**List the acceptance scenarios before writing code; the main agent owns the final result.**
Tests cover the real usage path and data density of the target UI, plus the relevant edge,
concurrency, failure and recovery paths; say why any of them does not apply. Pick the browser
engine by what the bug is about (2026-11-12, the user: "why try it in webkit just in chrome is
fine"): Playwright in Chromium for everything, WebKit only for a bug that depends on the engine
(scrolling, painting, layout, focus, input, media).

**WebKit acceptance runs on a Linux dev host, never as a test run on the Mac** (2026-11-12: at load 358, five UI tasks sat in the Mac's :3457 queue waiting for WebKit). Browser checks run in Chromium; a bug in the Mac app's web pages that depends on the engine (scrolling, painting, layout, focus, input, media) is accepted with Playwright's WebKit (its Linux build of the same engine, headless: `PW_WEBKIT=1 bun x playwright test <spec> --project webkit`) on a Linux dev host, never the Mac a person uses. After the land, the Mac gets only a short read-only look at live prod in the Mac app: no fixture server, no test run. Only what Linux WebKit cannot show runs on the Mac, one at a time in its :3457 queue: the MediaRecorder specs (`stt-*`, `voice-*`, Linux WebKit has no MediaRecorder) and a layout that differs only in macOS fonts. A task's placement never keeps it on the Mac for WebKit.

**The main agent does the key steps and checks the evidence itself.** Subagents may help, but
their reports, a simple text sample, a type check, a test run that has only started, or a
successful deploy never replace walking the user's flow. After a fix, rerun the original repro
and the related regressions, and confirm you verified the final build. While anything still
fails, a key scenario is untested, or a background test is still running, report progress or the
blocker, never done. When a tool cannot show a screenshot, say so; never call a DOM check a visual
review.

**Testing and review scale with the change, not with the process** (2026-11-02, the user: "the review should be scale based on the actually scale of the code"; a one-minute `git revert` of a full-screen change then ran Chromium and Linux WebKit specs and a review agent for 30 minutes). Pick the tier before testing and name it in one line; any escalation trigger moves a change up, whatever its size:

| Tier | What counts | Run | Skip |
|---|---|---|---|
| Small | a revert to a state production already ran; CSS, copy, docs or config text only; a few dozen lines with no new branch or state | the one or two tests or specs that touch it, in Chromium (WebKit only when the bug depends on the engine, on a Linux dev host); the owner reads its own diff; deploy; a short video when it is visible | the full quick tier, `test:pre-commit`, other browser engines, a review agent, an HTML explainer |
| Medium | new logic in one area, a few files, no trigger | the affected test groups (`test:focus`, or `test:pre-commit` for its tiers) and the touched flow in Playwright in Chromium (WebKit only for an engine-dependent bug); one review agent on a mid-size model | the whole suite, a second engine unless the change is engine-specific |
| Large | any trigger, or a change across subsystems | the full flow below: scenario matrix, `test:pre-commit`, the engines the change reaches, an independent review on the strongest model | nothing |

Triggers: user data or storage formats, a migration, concurrency (locks, queues, ordering), security, permissions or credentials, an outward send, the session daemon or process lifecycle, the deploy or release scripts, the frozen `/api/v1` contract or older clients. A failing test in a lower tier is fixed and rerun alone; it moves the change up only when the failure shows the change reaches further than its tier said. A bug fix still adds its guard test in every tier.

- Bug fix: Playwright repro → fix → verify same flow → commit
- **A bug fix covers the whole class, with a guard test** (2026-10-29: three bugs reported fixed came back the same day; each first fix covered only the known case, a fixed list of note types, one of 29 components with the same render mistake). Name the class the bug belongs to, fix every member, and add a test that fails when a NEW member of the class appears (enumerate the members from the source, as the ratchets here do), not only one for the case that was reported.
- **A bug is fixed when it works on the data that showed it.** Against the real data of the report; a green test on a fixture is not that proof. A bug that depends on the engine (scrolling, painting, layout, focus, input, media) is checked in the user's own engine too: the Mac app's WKWebView (WebKit acceptance on a Linux dev host, then the read-only look at live prod in the app) or the phone build.
- Feature: define E2E scenarios → implement → build → Playwright verify → commit
- Test UI changes as a real user with Playwright; for load bugs, test `/` and the reported URL 5× and report worst full-load time/errors.
- **NEVER** commit UI changes without Playwright verification
- **NEVER** use `page.goto()`: use real UI clicks (SPA navigation)
- Use `/verify` after implementation

### Playwright runs are machine-wide serialized (don't fight the gate)

On the Mac this queue is only for the few specs Linux WebKit cannot run (above); every other
browser run, WebKit acceptance included, belongs on a Linux dev host.

`playwright.config.ts` takes an exclusive lease on :3457 (a second run queues: correct, not a
hang), caps workers at 4, sweeps orphan fixture servers, waits out an overloaded machine and
honours a machine hold (`~/.config/walnut/hold`). When a run fails on timeouts, check the load
first with `scripts/pw-cleanup.sh status`. Run a TypeScript script with `bun <file>`. Detail:
`docs/reference/testing-pipeline.md`.

## Testing

Every feature needs 1+ real E2E test through `startServer({ port: 0, dev: true })`. Only mock the Claude CLI. See [tests/AGENTS.md](./tests/AGENTS.md).

## Conventions

Plans: architecture diagrams first → UX scenarios → pseudocode. No detailed implementation code in plans.

### Menus & overlays (web UI): hard rules

**Before touching any dropdown/menu/flyout in `web/src/`, read ["Menus & overlays: hard rules"](./web/src/AGENTS.md#menus--overlays--hard-rules).** Every rule there is a shipped incident. The one-line version: menus never overflow the viewport (always place via `useMenuPlacement`); unbounded content becomes its own portalled flyout, never inline growth; no native `<select>` inside styled menus; menu portals need `onPointerDown` stopPropagation or dnd-kit drags the row; outside-click closers must exempt child portals.

### A page's view choice is kept: `usePageView` (web/src/utils/view-memory.ts)

A tab, filter, sort or show-this toggle is kept with `usePageView`/`usePageViewOf`, never a bare
`useState`; a plugin uses `walnut.ui.useView` and `walnut.ui.useDraft`. Ratchet:
`tests/web/view-memory-guard.test.ts`. Detail: `.claude/skills/walnut-web-frontend/SKILL.md`.

### Frontend logging: `import { log } from '@/utils/log'`

Use the structured logger (`log.info('subsystem', 'message', { sessionId, taskId })`), never raw
`console.log` and never `console.debug` (invisible to the forwarder). IDs must be **full, never
truncated**.

### Logs and debugging

Server and forwarded browser logs: `/tmp/open-walnut/open-walnut-<date>.log` (timestamps UTC,
filename local date). Start with `scripts/walnut-logs.sh diagnose <sid>` for a slow send,
`stalls` for a frozen server, `file <substr>` for an overwritten file. Every `claude -p` runs with
`--debug` by default (`~/.claude/debug/<id>.txt` on the session's host; `WALNUT_CLAUDE_DEBUG=0` opts out). Detail, blank-page triage and the
SDK malware-reminder patch: `docs/reference/logs-and-debugging.md`.
