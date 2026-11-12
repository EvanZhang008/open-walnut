# Production server: deploys and live verification

How a change reaches the server on :3456, how that deploy protects production, and how to verify a change on a throwaway server instead of production. The short rules are in the root `AGENTS.md` under "Production Server Safety".

_Moved from the root `AGENTS.md` on 2026-11-11; the root file keeps a one-line summary of each rule._

## Done means live on prod: how a deploy goes out

**Done means live on prod, and you saw it there.** A change is finished only when it is
committed, deployed to the live server on :3456, and you opened live prod yourself and
watched it work (the real UI for a UI change, a read-only check for the rest). After the
review, commit and deploy on your own; don't stop and wait to be asked. The shared tree
almost always holds other agents' uncommitted work, so deploy the commit, not the tree:
`bash scripts/deploy-committed.sh` builds the committed HEAD in a clean clone and serves
it as this checkout: the compiled walnut file for this Mac (plus the Linux files host servers
take, from the same build), run directly with no node. Once it serves, the dist of that build is
copied into this checkout's `dist/`, because the local `walnut` CLI runs the op registry
(descriptions, schemas, outcomes) from there (`scripts/publish-serve-root-dist.mjs`; 2026-10-05:
sessions read op text two deploys old). It skips the deploy (exit 0, no restart) when production
already serves that commit or a later one containing it from a clean build, because every restart
costs open windows seconds of timeouts (2026-10-28: up to 76 a day); `WALNUT_DEVPROD_FORCE=1`
deploys anyway. Deploys are queued (`scripts/lib/deploy-queue.sh`, 2026-11-03: 31 restarts in a
day): production restarts at most once per 10 minutes (`WALNUT_DEPLOY_MIN_GAP_SECS`), and on a Mac whose load is over 4 per CPU it waits for the load to ease, up to 20 minutes after the last restart (`WALNUT_DEPLOY_BUSY_GAP_SECS`, 2026-11-09: four deploys an hour with an iOS build took the load to 400), a call
inside the gap waits and goes out with the newest commit of then, and it exits 0 only once
production serves a build containing its commit (it says which); a host's daemon is replaced at
most once per 20 minutes (`src/providers/daemon-update-gap.ts`). Never wait for the tree to be clean, and never stash, revert or commit
their files to get there. If a deploy guard refuses (type-check, smoke boot, cooldown), fix
what it names or report it as the blocker. Never end with "committed, not deployed, say
deploy". Scope the commit to your own changes only (never sweep up other agents'
uncommitted files), and run the usual pre-commit sensitive-content scan. Push still only
happens on request.

## Deploy commands, dry run and rehearsal

```bash
bash scripts/deploy-committed.sh  # Deploy the committed HEAD (clean clone) → restart 3456
bun run dev:prod        # Build the working tree as it is → restart 3456
bun run dev:ephemeral   # Ephemeral server (random port, temp data, auto-cleans)
bun run dev:ephemeral -- --file [<walnut file>]   # the same, running a compiled file

# Verify the deploy script itself WITHOUT deploying: runs every guard, then stops
# before build / server kill / launch. WALNUT_DEVPROD_PORT is honoured only here
# and in a rehearsal.
WALNUT_DEVPROD_DRY_RUN=1 WALNUT_DEVPROD_PORT=35999 TMPDIR=/tmp/dry bash scripts/dev-prod.sh

# Rehearse the WHOLE real deploy (build, smoke, kill and launch, LKG, rollback) away
# from production: its own port, data dir, daemon dir and launchd label, and a state
# dir it makes, <dir>/rehearsal-state (lock, stamps, stages, LKG, log, the CLI publish
# stand-in), with the build clone beside it in <dir>. It writes only into those dirs
# (and the daemon's <daemon dir>-streams), except that its servers, like every Walnut
# server, append their exit line to /tmp/open-walnut-exit.log, and on a Mac with
# Walnut.app it adds its server's command to the session host's approvals (the others
# kept) and runs it under the app, as the real deploy does (WALNUT_SESSION_HOST=0: not). Refuses :3456, :3457,
# a port served by anything it did not start, ~/.open-walnut, /tmp/open-walnut,
# ~/.cache/open-walnut, the production log and any WALNUT_DEVPROD_LKG_DIR.
# Clean up after: bootout com.open-walnut.dev-prod-rehearsal.<port>, then remove the dirs.
WALNUT_DEVPROD_REHEARSAL=1 WALNUT_DEVPROD_PORT=35871 WALNUT_DEVPROD_REHEARSAL_DIR=/tmp/rh \
  OPEN_WALNUT_HOME=/tmp/rh/home WALNUT_DAEMON_DIR=/tmp/rh/daemon bash scripts/deploy-committed.sh
```

## Live verification runs on an ephemeral server, never on :3456

Anything that creates tasks, sessions, notes or cron jobs to prove a change works (a real-CLI
turn, a Playwright click path, a `curl` or `walnut tools call` against the API) runs on
`bun run dev:ephemeral`. Reading :3456 is fine; writing to it for a test is not: every probe
task an agent made there stayed on the user's board (a 2026-09-23 audit found dozens).
`bun run dev:ephemeral -- --file <path>` runs a compiled walnut file instead of the source build
(`--file` alone builds this tree's file first, about a minute): the same launcher code, so the
same isolation below, and the file's runtime tree goes to `$TMPDIR/walnut-ephemeral-runtime`,
never into the real data home (`scripts/dev-ephemeral.sh`).

**When a check must write on :3456, it runs as a test run** (`src/core/test-run.ts`; 2026-10-27:
an Org chart acceptance run made 9 tasks and 6 projects there, which showed on the user's board
and Org page, and its cleanup left 3 session records with no task). A request carrying
`x-walnut-test-run: <label>` makes test objects: every task it creates (and every subtask of
one, whoever files it later) is kept off the board, task lists, Org and its counts, search, the
Brief and the phone the way a plugin's own task is (`plugin_only` = `@test-run`, local, unpinned);
every project it creates carries `metadata.test_run` and is in no project list while only test
work lives in it. The test run's own requests still see them, unmarked, so a UI check finds what
it made. Who sends the header: the web app whenever a browser is under automation
(`navigator.webdriver`, so every Playwright run, MCP included, without asking) or was opened with
`?walnut-test-run=<label>` (for the tab; `=0` ends it), the `walnut` CLI with
`WALNUT_TEST_RUN=<label>` in its env, and `curl -H 'x-walnut-test-run: <label>'`. A plain `curl`
or `walnut` call without it is a real write. Main and the lead of a real project are never test
objects. Deleting a test task removes its session records too, and the primary's sweep
(`src/core/test-run-sweep.ts`, every 30 min) deletes test tasks idle for
`WALNUT_TEST_RUN_TTL_HOURS` (6) with their sessions, then their empty projects, with no tombstone.
Still delete what you made when you are done, and never touch the user's own objects from a test
run: the marker covers what you create, not what you edit. Its preference writes (the synced
layout in ui-prefs, favorites, project order, the mail Grouped switch, a push choice) are kept
apart (`src/core/test-run-prefs.ts`, 2026-10-31: a hidden task panel in the user's synced prefs
left every fresh browser on an empty Home): only its own changes, in memory under its label, laid
over the user's live values in its reads, gone 30 minutes after its last write; an automated
browser's label names its browser context (`webdriver-<id>`), so a fresh browser opens on the
user's layout. `tests/core/test-run-prefs-gate.test.ts` lists every preference write route and
fails on one that does not go through it. What a plugin does outside Walnut (the person's Mac,
an outside account, its own timers) no copy holds, so a plugin op reads `walnut.testRun?.()`, the
request's label, carried through the companion's op relay too, and refuses such a change (2026-11-02:
a test browser's Rhythm focus block quieted the user's Walnut and phone and turned the Mac's Do Not
Disturb on; Rhythm now refuses every write op in a test run); the same gate test fails on a plugin
that takes the person's quiet hold or runs Shortcuts, AppleScript or `open` without reading it.
Throwaway servers (ephemeral, the test
runner, a data home in a temp or task dir) ignore the header; `WALNUT_TEST_RUN_MARK=1` turns it on
there, as `tests/e2e/test-run-objects.test.ts` does.

The launcher prints `{pid, port, tmpDir, daemonDir, pausedCronJobs, removedPushTokens}`. The
server is isolated by construction, so nothing it does reaches the real Walnut:

- its own data copy and its own local daemon in `daemonDir` (its logs are there too); the copy is
  copy-on-write where the volume clones (APFS: notes and plugin data cost nothing until changed),
  else a real copy that leaves the largest folders a test does not need empty to stay under
  `WALNUT_EPHEMERAL_COPY_CAP_MB` (2048, `0` = all) and says which (`snapshot` in the printed
  JSON; `src/commands/ephemeral-snapshot-copy.ts`; 2026-11-04: a 6.15 GB full copy filled the
  Mac's disk). The server ends with the process it works for (`owner`: the first ancestor that
  is not a shell or script runner, the agent CLI as a rule; `WALNUT_EPHEMERAL_OWNER_PID`, `0` =
  none) as well as on its idle timer, and the reaper takes a snapshot whose server stopped
  heartbeating (`src/commands/ephemeral-owner.ts`);
- its own op executor and every local session it launches talk to it, never the :3456 default
  (`OPEN_WALNUT_API_URL`, see `src/lib/self-api-root.ts`);
- the copied cron jobs are paused (jobs created there still run) and Inbox Triage is off in the
  copied config (its bootstrap would re-enable its paused routine), the copied Board reminders
  never fire (ones set there do), the copied phone push tokens
  are removed, no plugin syncs tasks (installed ones included), and there is no cloud bridge
  push and no heartbeat;
- remote hosts stay off unless it is started with `WALNUT_EPHEMERAL_REMOTE_HOSTS=1`, and then
  each ssh host gets an isolated daemon of the test server's own, never the host's production
  daemon (which hands relayed work to whichever server it sees first)
  (`src/providers/remote-isolation.ts`): everything it writes there is under
  `/tmp/open-walnut-test-<key>` (else `~/.cache/open-walnut-test/<key>`): its daemon dir,
  streams, task dirs, installs (bun, host fixes, dtach run with HOME in its `home/`, bun's transpiler cache too) and terminal
  sockets. Both daemon twins say their dir and the test server's key in their hello; a test
  server refuses any other daemon, a real server refuses a test server's, and the daemon refuses
  to start in a production dir. The test server stops it and removes the root when it exits, and
  a daemon left with no server for 30 minutes ends itself the same way. Exceptions that stay in
  the real home on purpose: what a session's CLI writes (`~/.claude`) and the shared spawn
  journal and CLI owner records. Ratchet: `tests/providers/remote-write-paths-ratchet.test.ts`
  lists every remote-exec site in `src/` and why it stays in the root;
- search is keyword only and voice is not set up: no isolated server (an ephemeral child, the
  test runner, a data home in a temp dir or a task dir, a HOME that is not the account's own)
  loads the embedding model, about 2.2 GB per worker lane plus a full re-embed of the copied
  data, or downloads the Qwen3-ASR voice model (2.3 to 3.2 GB) into its HOME
  (`src/core/search/semantic-default.ts`). Nor does it start, adopt or call a speech process, load
  a speech model or record the microphone or system audio, even on a Mac that has the model
  (`src/core/stt/voice-here.ts`, ratchet `tests/core/stt-voice-here-ratchet.test.ts`). Opt in with
  `WALNUT_SEARCH_V2_SEMANTIC=1` and `WALNUT_STT_AUTO_SETUP=1`.

Plugins still load with the copied settings, so a test that sends mail or a chat message
through one sends it for real.

**Testing a task sync plugin.** No plugin syncs tasks on a test server, so tasks made there stay
local, which is what almost every test wants. To test a sync plugin against its real service
(Microsoft To Do, or one the user installed), start the server with
`WALNUT_ALLOW_REMOTE_SYNC_IN_TEST=1 bun run dev:ephemeral`. It then writes to the user's real
account, and the real Walnut pulls those items back onto the user's board. Change only tasks you
created there: the copied tasks are linked to real items, so editing, completing or deleting one
changes the real item. Before you finish, clean up: delete each item you created from the test
server while sync is still on (that removes it from the real service too), then check the real
board and delete any copy it already pulled in. Removing your own leftovers is the one write to
:3456 a test may make. Report what you removed.

## dev-prod.sh must stay portable

**dev-prod.sh must stay portable.** Issue #11: the server log was pinned to `/private/tmp`,
a macOS-only path, so a Linux deploy killed the live server and then failed to start its
replacement. Two rules it now encodes: prove every external prerequisite (a writable log)
BEFORE the first destructive step, and never assume a macOS-only tool (listener detection
probes `lsof` → `ss` → `fuser`, and refuses to run when none exists rather than failing
open and starting a second server against the same data dir; a BusyBox applet under one of
those names, or a BusyBox `ps`, does not count: they take none of the options used). Ratchets:
`tests/scripts/dev-prod-portability.test.ts` (the dry run executes the whole script, on
Linux too, in CI's quick tier) and `tests/scripts/cross-platform-ratchet.test.ts`.

## Deploys smoke-test before killing prod, and roll back on failure

**Deploys smoke-test before killing prod, and roll back on failure.** dev-prod.sh boots the
freshly built dist ONCE in full isolation (temp data dir + temp daemon dir + probe port) and
requires it to serve `/api/config` BEFORE touching the running server: a dist that hangs in
module init (2026-08-22/23 outages) now fails the deploy while prod keeps serving. After a
successful readiness check the dist is snapshotted as last-known-good; a post-kill readiness
failure re-launches that snapshot instead of leaving :3456 dark. Knobs:
`WALNUT_DEVPROD_SMOKE_SECS` (default 120), `WALNUT_DEVPROD_SKIP_SMOKE=1`,
`WALNUT_DEVPROD_LKG_DIR`. Ratchets: `tests/scripts/dev-prod-smoke-rollback.test.ts`.

## Deploys also load the installed plugins before the kill

**Deploys also load the installed plugins before the kill.** The smoke boot's data home is
empty, so it never loads an external plugin (2026-10-25: every one failed to bundle for almost
two hours after a deploy). After it, `<new file> __plugin-check` (`src/core/plugins/plugin-load-check.ts`)
loads each plugin in the server's `plugins/` dir that `:$PORT/api/plugin-runtime` reports
`active`, with a temp data home, and never activates it, so nothing syncs, sends or posts. One
that loads there and fails here aborts the deploy; one broken there too, no answer from the
running server, or a check that runs out of time only warns. Knobs:
`WALNUT_DEVPROD_SKIP_PLUGIN_CHECK=1`, `WALNUT_DEVPROD_PLUGIN_CHECK_SECS` (120),
`WALNUT_DEVPROD_PLUGIN_STRICT=1`. Ratchet: `tests/scripts/dev-prod-plugin-check.test.ts`.

## What a deploy runs: the compiled file, and nothing else

**What a deploy runs: the compiled file, and nothing else.** After `bun run web:build` (the dist: the
CLI publish above needs it, and the file reuses its web assets, so the asset mirror sees one
build either way), `bun scripts/build-binary.mjs --reuse-web` builds this machine's file and the
Linux ones (`linux-x64`, `linux-arm64`, their musl twins) in ONE run, so every file names the same
commit; a failed sibling only warns, a failed file for this machine aborts before the kill. The
files are staged as `<stage>/dist-bin/walnut-<target>`, where host servers pick the siblings up
(`path.dirname(process.execPath)`). `walnut __selftest` runs first (it also unpacks the runtime
tree into `<stage>/runtime/<build>`, on the temp volume, never the data home), then the smoke
boot runs `<file> web` with its own data, daemon and runtime dirs. Every run of the file (the
self-test, the smoke boot, the plugin check, the launchd job, a rollback) goes under Walnut.app's
session host on a Mac that has the app (`host_prefix_for`; the file approves each argv with
`__session-host-approve`), because macOS keys an unbundled program's Local Network choice on its
path and Mach-O UUID, and each stage path asked again (2026-11-04; 2026-11-12 from the land queue,
whose smoke boot and rollback still ran the file on its own); only the host's refusal (exit 125)
runs it directly, `tests/scripts/dev-prod-file-runs-under-host.test.ts` fails on a run that skips
the host, and every darwin file carries a fixed UUID and identifier, checked before the kill (`scripts/lib/macho-identity.mjs`,
`docs/reference/macos-session-identity.md`); the LKG holds `dist-bin/` and `runtime/`, and a rollback starts the last good build's
file, from a fresh stage cloned from the LKG (`open-walnut-stage.rollback.*`), never from
the LKG itself, and a snapshot never replaces an LKG a process still runs from: the next good
deploy replaces the LKG whole, and would delete a rollback server's file and tree (or those of
the daemon it respawned from its own path) from under it. A stage kept only for a daemon or a
session's child loses the Linux files (most of its size; only a serving server reads them), and a
build clone an interrupted `deploy-committed.sh` left in TMPDIR is removed once nothing runs from
it. With TMPDIR unset (over ssh) the deploy uses the per-user temp dir on macOS, `/tmp` elsewhere.
`WALNUT_RUNTIME_DIR` names the parent of the per-build trees, so a child of the server that runs
another build unpacks beside it, never over it (`src/binary/runtime-tree.ts`); sessions and
terminals never inherit it, and `dev:ephemeral --file` keeps the newest 3 trees (and any from the
last day) in `$TMPDIR/walnut-ephemeral-runtime` (`WALNUT_EPHEMERAL_KEEP_TREES`). A file runs
nested copies of a package from their own nested path in the tree, so a nested copy of another
version reads its own files (`scripts/binary-build-checks.mjs`).
The way back from a bad file is that rollback to the last good one; there is no other runtime
to deploy (`WALNUT_DEVPROD_RUNTIME` other than `file` is refused). An LKG an older deploy left as a
Node build is never started; a deploy with no file to roll back to says so before the kill. Knobs: `WALNUT_DEVPROD_FILE_TARGETS` (default the four Linux targets, `""` for none),
`WALNUT_DEVPROD_SKIP_SELFTEST=1`, `WALNUT_BUN` (the build needs bun at least the
`packageManager` pin; an older one is refused before any step). `WALNUT_DEVPROD_REHEARSAL=1` runs
the whole deploy on a private port and data dir (block above); its
`WALNUT_DEVPROD_REHEARSAL_FAIL_LAUNCH=1` / `_FAIL_SMOKE=1` drive the rollback and the pre-kill abort.

## A deploy must not pull the floor out from under an open window

**A deploy must not pull the floor out from under an open window.** Every deploy re-hashes and
WIPES `dist/web/static/assets`, so a window that was open before it still runs the old entry
bundle and 404s the first time it reaches for a chunk it had not loaded yet. That fetch happens
inside a click (opening a `.go` file asks for its CodeMirror grammar), `vite:preloadError` fires,
and `stale-assets.ts` reloads the page ON TOP of the click: the 2026-09-03 Mac app report,
"I click a path, the page flashes, nothing opens; the second click works". The Mac app is the
only surface that hits this, because its window is the one that lives across every deploy (its own
page-process recycle deliberately waits for the user to go idle). Two answers, in
`src/web/static-mirror.ts` + `web/src/utils/stale-assets.ts`: the durable asset mirror now keeps
ONE DIRECTORY PER BUILD (`<mirror>/gens/<entryHash>/`, newest served first, all of them mounted as
fallthrough static roots), so a replaced build's chunks stay fetchable; and a window whose bundle no
longer matches the server's reloads itself only while HIDDEN for 20s, never with unsaved text, never
on an unknown. A name no build ever had still 404s: the client's reload recovery needs that to stay
loud. Two traps the mirror's shape encodes: eviction counts BUILDS (keep the newest 6, floor 2, then
72h / 512MB), never file mtimes, because `cpSync` stamps copy time and an mtime clock deletes a
build's chunks in the very refresh that makes them previous; and eviction NEVER consults the primary,
because the failure this mirror exists for (a deploy stage swept from under a live server) removes
FILES while the directory still lists, and a pruner diffing against that would delete almost
everything including the mirror's own `index.html`. Ratchets:
`tests/web/static-mirror-{retention,previous-build}.test.ts`,
`tests/web/stale-build-upgrade.test.ts`, `tests/e2e/browser/stale-build-no-flash.spec.ts`.
Note when testing: the Playwright fixture serves the SPA through Vite in DEV mode, so it has NO
hashed chunks: the hashed half can only be pinned against a real `startServer({dev:false})`.

## Launch dev:prod from a non-niced shell

**⚠️ Launch dev:prod from a non-niced shell.** A server started from a niced parent (e.g. a
background agent session) inherits the positive nice and gets scheduler-starved under machine
load: HTTP latency spikes that look like app bugs. The server logs an error at startup and
exposes `processNice` in `GET /api/config` when this happens; fix = restart from a normal shell.

## The deploy runs the server at app priority, the agents stay below it

**The deploy runs the server at app priority, the agents stay below it.** dev-prod.sh loads the
server as a launchd job from a plist with `ProcessType` Interactive (base priority 31), because a
bare `launchctl submit` job is launchd's Standard type, which macOS schedules in the utility band
(priority 20) together with every agent build and test on the Mac. The same plist sets
`WALNUT_DAEMON_QOS_CLAMP=1`, and only then does the server start its background children under
`taskpolicy -c utility` (`src/lib/background-qos.ts`): the local daemon and so every agent
session, the embedding model workers, the git backups and the history compaction keep the band
they had, and so do the model adapter's `claude -p` turns for helpers nobody waits on (titles,
summaries, placement: `purpose: 'background'` on the call). Those turns hold at most two of the
adapter's three `claude` slots, and a turn a person waits on goes ahead of every queued one,
except that one queued 10 s or longer may take a freed slot while no other background turn runs
(never with a single slot: `withSlot` in `src/model/providers/adapter-claude-cli.ts`): with one queue for both, a turn
queued behind three utility-band ones took 5.7 s instead of 2.9 s (load ~375). Every `claude -p`
Walnut starts outside a session is the local daemon's child (capability `oneshot-v1`,
`src/providers/oneshot-core.ts` + `oneshot-client.ts`; user rule 2026-10-26): micro-Claude and its
warm pool (AI search, the direct route of `ai.run`), inline subagents, and those adapter turns.
So with the clamp on they all run in the daemon's band, the turns a person waits on included (a
clamped daemon cannot start a child above it); the slot gate above still lets those go first, and
a daemon older than `oneshot-v1` runs them in the server as before. Still in the server's band:
one-shot setup at boot. The server reads
the request once at startup and removes it from `process.env`, so the in-app terminal and every
other child built from that env never carry it. A server started any other way (a terminal, the Mac app, the submit fallback) clamps
nothing, so its children inherit its band. `WALNUT_DEVPROD_PROCESS_TYPE=Standard` restores the
plain submit. The job lives in one launchd domain (gui/<uid> from a GUI login, user/<uid> over
ssh), and every look at it goes through `launchctl print <domain>/<label>`. A removal boots the
label out of both per-user domains and waits (bounded) until launchd lets go; when it will not,
the deploy starts the new server with nohup instead of failing. Check with
`ps -o pri= -p <pid>` (31 server, 20 daemon; the compiled file's daemon is the same file run as
`walnut-<target> __daemon --start`).

## NEVER wrap bun run dev:prod in a bare launchctl submit

**⚠️ NEVER wrap `bun run dev:prod` in a bare `launchctl submit`.** `launchctl submit` jobs are
KeepAlive: the script exits, launchd re-runs it, forever. dev-prod.sh is a one-shot deploy, so
this becomes a kill-server-every-10s loop (2026-07-25 incident: 7 back-to-back restarts, one of
which killed a healthy mid-compaction CLI session). If you must deploy from a niced shell, use a
one-shot wrapper with a done-marker (`[ -f /tmp/<marker> ] && exit 0; …; touch /tmp/<marker>`)
so re-runs are no-ops. dev-prod.sh also has its own storm breaker now: a <120s cooldown after a
successful deploy (exit 0 no-op) and a refusal to kill a listener younger than 120s
(`WALNUT_DEVPROD_FORCE=1` overrides both for intentional rapid redeploys).

## Isolated sandbox for onboarding, provider testing and demos

`scripts/walnut-sandbox.sh` spins up a fully isolated Walnut on **:3457** (`env -i` + throwaway
HOME + isolated data/daemon dir) to test any credential or record onboarding: **never touches
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
  `~/.claude`); `profile` uses the **real HOME** + the user's own PATH so a `credential_process`
  helper can resolve. Token would otherwise win over a profile, so token isn't injected in profile mode.
- `chat`/`record` use `scripts/walnut-sandbox-chat.mjs` / `onboarding-chain.mjs` (WS RPC + CDP recorder).
- **Rebuild gotcha:** the sandbox runs `dist/cli.js`; `web:build`/`build` DO recompile the server
  via `tsup`, but if you edit server code and forget to rebuild, the sandbox runs STALE server logic.
  A `400 invalid beta flag` on `chat` while `test` passes is the classic symptom of a stale `dist`
  (an old build that still sent the removed `extended-cache-ttl` beta). Rebuild (`bun run build`) and re-run.
- **Verified-good provider behavior (do NOT "fix"):** Walnut does NOT send `extended-cache-ttl`
  to Bedrock: sending it answers `400 invalid beta flag`, and the 1h cache is GA anyway
  (`cache_control.ttl:'1h'` rides through verbatim; see `EXTENDED_CACHE_TTL_BETA` in
  `src/model/providers/defaults.ts`). opus-4-8 uses `thinking:{type:'adaptive'}` + the
  `interleaved-thinking` beta. This combo + a `~/.aws` profile is confirmed working end-to-end.
