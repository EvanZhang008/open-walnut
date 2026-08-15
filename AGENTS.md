# Open Walnut — Personal AI

> **ACP reference implementation:** https://github.com/agentclientprotocol/claude-agent-acp (public).
> **References**: [ARCHITECTURE.md](./ARCHITECTURE.md) | per-directory `AGENTS.md` files are
> concise quick-references; the **deep implementation details live in skills** (auto-discovered,
> load on demand): `walnut-core-internals` (src/core/), `walnut-agent-loop` (src/agent/),
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

**Commit automatically after the loop.** Once the full dev loop is done (implement →
build → deploy → real-UI verification passed), commit the change yourself — don't stop
and wait to be asked. Scope the commit to your own changes only (never sweep up other
agents' uncommitted files), and run the usual pre-commit sensitive-content scan. Push
still only happens on request.

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

**Port 3456 = PRODUCTION. NEVER kill, restart, or interfere.**

### Never block the web server (each rule = a shipped outage)

- **No sync blocking on the event loop** (`execSync`, sync native-addon calls, multi-MB parse): one call freezes EVERY route. Child process + timeout + cached value instead (`setImmediate` doesn't help). Ratchet: `tests/core/event-loop-blocking-ratchet.test.ts`.
- **Every route touching daemon/SSH/network/whale files needs a deadline** — answer degraded (204/stale), never hang: one pinned response starves the browser's 6-connection pool → app-wide fake 15s timeouts.

```bash
npm run dev:prod        # Build all → restart 3456 with latest code
npm run dev:ephemeral   # Ephemeral server (random port, temp data, auto-cleans)
```

**⚠️ Launch dev:prod from a non-niced shell.** A server started from a niced parent (e.g. a
background agent session) inherits the positive nice and gets scheduler-starved under machine
load — HTTP latency spikes that look like app bugs. The server logs an error at startup and
exposes `processNice` in `GET /api/config` when this happens; fix = restart from a normal shell.

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
- **Verified-good provider behavior (do NOT "fix"):** the Personal AI does NOT send `extended-cache-ttl`
  to Bedrock — the 1h cache is GA and rides `cache_control.ttl:'1h'` directly (`src/agent/cache.ts`,
  `DEFAULT_TTL='1h'`). opus-4-8 uses `thinking:{type:'adaptive'}` + the `interleaved-thinking` beta.
  This combo + a `~/.aws` profile is confirmed working end-to-end against real Bedrock.

## What Is Walnut

Personal AI: tasks + knowledge + AI sessions. **Tasks are the atom.** `Project → Task → Subtask` — Project is the single grouping layer; a task with no project lives in the **Inbox** (`project = ''`). Event Bus connects everything. See [ARCHITECTURE.md](./ARCHITECTURE.md).

### Key Rules for Implementation

- `task_create` takes an optional `project`; an unknown name auto-creates the registry row (`task_projects`, source `'local'`). Inbox (`''`) has no registry row and can never be claimed by a sync provider
- Phase: `TODO` → … → `AGENT_COMPLETE` → … → `COMPLETE` (agent sets AGENT_COMPLETE, human marks COMPLETE)
- **NEVER force-kill Claude Code processes** — bypasses on-stop hook
- **Sessions have ONE surface: the Homepage (`/`) session columns (`SessionPanel`).** The
  dedicated `/sessions` page was removed (2026-07-25); the route is now a redirect shim that
  reroutes `/sessions?id=…` deep links to the home session columns. Tasks still have two
  surfaces — the Homepage `TodoPanel` (primary) and `/tasks` →
  `DashboardPage`/`TaskList`/`TaskCard` (secondary). Default to the Homepage panel for any
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

Why (each learned the hard way): raw-bytes-over-tunnel hits the WS frame kills and the 32MB
read ceiling (whale JSONLs); per-file RPC fan-out floods the daemon socket and starves its
command timeout; and parse work on the server burns the ONE event loop every route shares.
The daemon has local fs + git + CPU right next to the data — a whale parse that took 40-80s
of chunked tunnel reads is seconds host-local.

Precedents: `git.diff` (daemon runs the whole diff host-side), `changes.compute`/`changes.file`
(daemon parses session JSONLs + reads contents host-side, returns a light list / one file),
snapshot-v1 (daemon folds its own stream files). When adding a feature that reads session/host
data, default to a daemon command + a thin server relay; only fall back to DaemonFileReader
byte-shuttling when the daemon genuinely can't own the work (e.g. cross-host aggregation).
Capability-gate new commands (`daemon-capabilities.ts`) so old daemons degrade to the fallback
path instead of erroring.

### Remote Session Daemon (resilience model)

**Topology:** walnut (Mac) ←ssh tunnel→ daemon (remote bun binary) ←spawn→ `claude -p` CLI. Goal: tunnel/daemon crashes don't lose sessions.

**Remote files:** `/tmp/open-walnut/sessions.json` (registry), `/tmp/open-walnut-streams/<sid>.{pipe,jsonl,pgid}`. JSONL is source of truth.

**CLI lifecycle (READ THIS — easy to get wrong):**
- `claude -p --input-format stream-json` is **LONG-RUNNING**, NOT per-turn. One CLI process stays alive across many messages, reading new input from its FIFO stdin between turns. (Evidence: a session with 39 messages had only 4 spawns.)
- The daemon holds the FIFO open with `O_RDWR` (`daemon-standalone.ts`) so the pipe survives between turns. Process is reaped only by the **idle timer** (`SESSION_IDLE_KILL_MS = 2h`, 5-min warning) or a real death (ENXIO / pid gone / crash) — never "turn ended".
- `isTurnCompleteExit()` does NOT mean turns exit. It only runs *inside* `reapSession()` to normalize the exit code *when a death already happened*, deciding if the last JSONL `result` line was a clean turn-end vs a crash.
- `--resume <sid>` is the **fallback** path (FIFO write failed / process really died), not the normal send path. Normal send = write the live FIFO.

**Delivery paths (where mid-turn injection breaks):** A send to a session walnut thinks is "processing" (`activeProcessing`) goes through `injectMidTurn` (gated on `targetSession.hasPipe`); otherwise `processNext` (writes the FIFO directly, no hasPipe gate). Pitfall: `RemoteSessionManager._hasPipe` is set `true` only in `start()` — `attach()` (used when reconnecting to an already-alive CLI after a daemon restart) returns `alive:true` but historically left `_hasPipe=false`, so `injectMidTurn` falsely reported "no FIFO pipe" and queued the message until the turn ended (25–55s grey stall). Keep `_hasPipe` in sync with daemon-authoritative liveness, not with spawn-vs-attach.

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
| Agent loop & tools | `src/agent/` | skill `walnut-agent-loop` + [src/agent/AGENTS.md](./src/agent/AGENTS.md) |
| Core (tasks/sessions data) | `src/core/` | skill `walnut-core-internals` + [src/core/AGENTS.md](./src/core/AGENTS.md) |
| Sessions (local + SSH) | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Session daemon (twins) | `src/providers/daemon-standalone.ts` + `daemon-source.ts` | "Remote Session Daemon" section above |
| Web GUI | `src/web/`, `web/src/` | skill `walnut-web-frontend` + [web/src/AGENTS.md](./web/src/AGENTS.md) |
| iOS app | `ios-native/` (xcodegen; `project.yml`) | frozen contract [API v1](./docs/reference/api-v1.md) |
| Cloud companion | `src/web/ws/bridge-registry.ts`, `scripts/cloud/setup.sh` | infra: `infra/` (CDK); deploy = bundle→S3→SSM |
| Voice input (STT) | `src/core/stt/`, `src/web/routes/stt-v1.ts` | routes primary/bridge/openai by reachability |
| Memory & search | `src/core/memory-*.ts`, `src/core/qmd-*.ts` | [QMD search and indexing](./docs/investigation/qmd-search-performance/README.md) |
| Event bus | `src/core/event-bus.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Subagents | `src/providers/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Cron | `src/core/cron/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Plugins | `src/core/integration-*.ts` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Chat history | `src/core/chat-history.ts` | skill `walnut-core-internals` |
| Usage tracking | `src/core/usage/` | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Git sync (data hub) | `src/integrations/git-sync.ts` | Mac ⇄ EC2 data plane; secrets NEVER ride it |
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

**The suite has a 118-failure baseline on `main`** (stale imports of exports deleted 2026-05, tests needing a real CLI/daemon, some load flakes). So judge your change with `npm run test:baseline` — it fails ONLY on failures absent from `tests/setup/known-failures.json`. Never judge from the raw aggregate count. When you fix some, `npm run test:baseline:record`.

**CI failed?** `scripts/ci-status.sh brief` distils the run into the few real error lines; fix locally (free) rather than running an AI inside CI (paid).

⚠️ **Never raise the local worker budget** (`tests/setup/worker-budget.ts`, **1 worker**). Test fan-out hard-crashed this Mac twice in July 2026 AND again 2026-08-05 at 2 workers (concurrent agent sessions + real spawned servers/daemons live outside the V8 heap cap). Want faster? Use L1 or L2.

## E2E-First Development

**Before writing ANY code, design E2E verification first.**

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
scripts/walnut-logs.sh req <id> | task <id> | errors [n] | tail [n]
```

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
