# Where Walnut keeps its data

Every place the server keeps state, with its class. The list is code:
`src/core/home-manifest/`; the tables below are written from it, and a test
(`tests/core/home-manifest/data-locations-doc.test.ts`) fails when they differ.

**The classes.** `leader-data` belongs to this Walnut and moves with the leader:
a standby copy of the leader must hold all of it. `machine` belongs to this machine
and is never copied to another one (a lock, a writer id, a key bound to this machine,
a pid or a port), and `rebuildable` is derived, cached or disposable, so the other
side rebuilds it or does without.

**Names nobody listed.** The data home is also the notes vault, so the user's own
folders and files sit beside Walnut's. A top-level name no entry knows counts as
`leader-data`: losing a note is worse than copying something extra. Walnut's own
paths never rely on that default: a source ratchet and a test against a real server
(`tests/core/home-manifest/`, `tests/e2e/home-manifest-real-server.test.ts`) fail on
any path the code writes that no entry names.

**Matching.** The longest path wins, and a file under a listed folder takes the
folder's class. A pattern entry (lock files, write temps) wins over the folder it
sits in. A sqlite entry owns its `-wal`, `-shm` and `-journal` files, and a copy
beside a file (`.bak`, `.backup-<time>`, `.tmp-<pid>`) takes the class of the file
it copies. `cache/`, `local/`, `sync/` and `tmp/` mix classes, so each child the code
writes has its own row. Lock files count as `machine` only by Walnut's own lock names, so
a lockfile of a project or a plugin (`bun.lock`, `Cargo.lock`) stays with its folder.
**Sensitive** marks credentials, tokens, keys and the password vault.

**Older places.** The places only older releases wrote stay in the manifest with a class,
so data an upgrade left there is still copied or skipped right, but they have no row here.

<!-- data-locations:start (generated from src/core/home-manifest; do not edit by hand) -->

### In the data home (`~/.open-walnut`, or `OPEN_WALNUT_HOME`)

| Where | Class | Sensitive | What |
| --- | --- | --- | --- |
| `~/.open-walnut/tasks/` | leader-data | no | Tasks: the task database, its JSON form and the archive |
| `~/.open-walnut/sessions.sqlite` | leader-data | no | Sessions: every session record and its history index |
| `~/.open-walnut/sessions/` | rebuildable | no | Older session projection and transcript-tail copies, rebuilt from the session store |
| `~/.open-walnut/session-message-queue.json` | leader-data | no | Messages queued for sessions that were not ready to take them |
| `~/.open-walnut/session-requests.json` | leader-data | no | Reply requests between sessions and their deadlines |
| `~/.open-walnut/hint-registry-since.json` | leader-data | no | When this home first ran the hint registry (older session rows predate it) |
| `~/.open-walnut/session-audit.jsonl` | leader-data | no | Audit log of session actions |
| `~/.open-walnut/user-asks/` | leader-data | no | The user's unanswered messages, one file per task |
| `~/.open-walnut/side-questions/` | leader-data | no | Side questions asked beside a session |
| `~/.open-walnut/subagent-runs.json` | leader-data | no | Subagent runs a restart left behind, to tell their callers |
| `~/.open-walnut/subagents-open.json` | leader-data | no | Subagent runs still open |
| `~/.open-walnut/subtask-notices-held.json` | leader-data | no | Subtask completion notices held for a batch |
| `~/.open-walnut/source-task-claims.json` | leader-data | no | Which task claimed which external source item |
| `~/.open-walnut/status-check-told.json` | leader-data | no | Status mismatches already told, so each is told once |
| `~/.open-walnut/private-tasks/` | leader-data | no | Private task approvals and the kept-task digest |
| `~/.open-walnut/op-calls/` | leader-data | no | Op call ledger: call ids and their results, so a resend runs once |
| `~/.open-walnut/kept-asks/` | machine | yes | Asks a person answers (sign-ins, uploads, confirmations, password requests) kept across a restart; never synced |
| `~/.open-walnut/offline-conflicts/` | leader-data | no | Logs of offline edits merged with a conflict |
| `~/.open-walnut/usage.sqlite` | leader-data | no | Model usage and cost records |
| `~/.open-walnut/org/` | leader-data | no | Org tree, threads database, team notes and asks, report schedule |
| `~/.open-walnut/org-reflection/` | leader-data | no | Reflection duty state per org node |
| `~/.open-walnut/human-inbox/` | leader-data | no | The user's inbox: letters, their ledger and staged bodies |
| `~/.open-walnut/boards/` | leader-data | no | Team boards |
| `~/.open-walnut/topics/` | leader-data | no | Topics and their posts |
| `~/.open-walnut/topic-mail/` | leader-data | no | Topic mail delivery state |
| `~/.open-walnut/notifications.json` | leader-data | no | The notification list (the bell) |
| `~/.open-walnut/quiet.json` | leader-data | no | Quiet mode holds |
| `~/.open-walnut/focus-spaces.json` | leader-data | no | Saved focus spaces: the projects and tasks each one shows |
| `~/.open-walnut/drawings/` | leader-data | no | Drawing library |
| `~/.open-walnut/memory/` | leader-data | no | Memory: MEMORY.md, USER.md, daily logs, project and agent memory |
| `~/.open-walnut/artifacts/` | leader-data | no | The artifacts folder: notes, skills and memory folders of tasks |
| `~/.open-walnut/notes/` | leader-data | no | The notes vault at its place before the artifacts folder |
| `~/.open-walnut/skills/` | leader-data | no | Skills, including repository knowledge |
| `~/.open-walnut/CLAUDE.md` | leader-data | no | Instructions for sessions that run in the home (a retired managed copy is removed) |
| `~/.open-walnut/commands/` | leader-data | no | The user's slash commands |
| `~/.open-walnut/actions/` | leader-data | no | The user's own actions |
| `~/.open-walnut/repositories/` | leader-data | no | Repository descriptions the user keeps |
| `~/.open-walnut/.obsidian/` | leader-data | yes | The notes app's own settings for this vault (its plugins may keep credentials) |
| `~/.open-walnut/voice-archive/` | leader-data | no | Original voice recordings and their transcripts |
| `~/.open-walnut/conversations/` | leader-data | no | Personal AI conversations, one folder per agent |
| `~/.open-walnut/chat-history.json` (and names matching `^chat-history-[^/]+\.json$`) | leader-data | no | The Personal AI's main chat history |
| `~/.open-walnut/conversation-bodies/` | rebuildable | no | A follower's copy of conversation bodies |
| `~/.open-walnut/ask-walnut-launch.json` | leader-data | no | Model and effort last picked for an Ask Walnut session |
| `~/.open-walnut/cron-jobs.json` | leader-data | no | Schedules and triggers: their definitions |
| `~/.open-walnut/cron-state.json` | leader-data | no | Schedules and triggers: next run times and last results |
| `~/.open-walnut/routine-state/` | leader-data | no | What each watcher already saw and acted on |
| `~/.open-walnut/triage-state.json` | leader-data | no | Inbox Triage's pending buffer and claim |
| `~/.open-walnut/triggers/` | leader-data | no | Check scripts agents write for their triggers |
| `~/.open-walnut/hooks/` | leader-data | no | Daemon hook rules |
| `~/.open-walnut/config.yaml` | leader-data | yes | Settings, including provider keys and host settings |
| `~/.open-walnut/config.yaml.history/` | leader-data | yes | Older copies of config.yaml |
| `~/.open-walnut/config/` | leader-data | no | Settings shared across devices (config/share) |
| `~/.open-walnut/auth.json` | leader-data | yes | Paired device token hashes, and this Walnut's instance id: it moves with the leader on purpose, and a standby keeps the copy but never serves from it before it is promoted |
| `~/.open-walnut/secrets/` | leader-data | yes | Credentials: plugin secrets, provider keys, sign-in tokens |
| `~/.open-walnut/vault/` | leader-data | yes | Password vault of a throwaway or fake-HOME server (the real one is outside the home) |
| `~/.open-walnut/router/` | leader-data | yes | Router areas, routing ledgers, approval tokens and frozen incoming content |
| `~/.open-walnut/approvals/` | leader-data | yes | Approval requests and the approvals switch (a `keys.json` an older Walnut left is no longer read) |
| `~/.open-walnut/host-exec-grants.json` | leader-data | no | The user's grants for running commands on hosts |
| `~/.open-walnut/browser-control.json` | leader-data | no | Sites the user approved for agents in the browser |
| `~/.open-walnut/workspaces/` | leader-data | no | Which workspace scripts the user trusts |
| `~/.open-walnut/sync/` | leader-data | yes | Sync state (children with another class are listed) |
| `~/.open-walnut/triage/` | leader-data | no | Inbox Triage's standing routing rules |
| `~/.open-walnut/plugins/` | leader-data | no | Installed plugins |
| `~/.open-walnut/plugin-data/` | leader-data | yes | Each plugin's private state |
| `~/.open-walnut/plugin-registry.json` | leader-data | no | A plugin catalog the user added |
| `~/.open-walnut/plugin-files/` | leader-data | no | Files plugins keep in their synced file area |
| `~/.open-walnut/plugin-stores/` | rebuildable | no | Git clones of plugin source repositories, cloned again on demand |
| `~/.open-walnut/hosts/` | leader-data | no | Host profiles |
| `~/.open-walnut/frequent-directories.json` | leader-data | no | Folders sessions ran in, for the folder picker |
| `~/.open-walnut/mention-directories.json` | leader-data | no | Folders browsed in the @ file picker |
| `~/.open-walnut/host-servers.json` | machine | no | Host servers this server started, with their ports |
| `~/.open-walnut/host-expose.json` | machine | no | A host server's own public port state |
| `~/.open-walnut/distributed-skills/` | rebuildable | no | Skills the leader sends to this host's daemon, sent again on connect |
| `~/.open-walnut/cloud-setup-job.json` | machine | yes | An in-flight cloud setup run, with its pairing code |
| `~/.open-walnut/code-server/` | machine | no | The in-app editor: its data and the instance running here |
| `~/.open-walnut/time-tracking/` | leader-data | no | Time records: work hours, calls, app and site samples |
| `~/.open-walnut/health/` | machine | no | Health data: it follows the existing rule that this data stays on the machine that collected it (git sync and backups leave it out) |
| `~/.open-walnut/places/` | machine | no | Place visits from the phone: they follow the existing rule that this data stays on the machine that collected it |
| `~/.open-walnut/browser/` | leader-data | no | Replays of what agents did in the browser, per task |
| `~/.open-walnut/local/` | machine | no | Per-machine records (children with another class are listed) |
| `~/.open-walnut/server.lock.json` | machine | no | The running server's singleton lock: pid and port |
| `~/.open-walnut/locks/` | machine | no | Lock files for paths outside the home |
| `~/.open-walnut/browser-extension/` | machine | no | Browser extension install of a throwaway server |
| `~/.open-walnut/demo-terminal-stop.json` | machine | no | Terminal processes a demo server is still stopping |
| `~/.open-walnut/replica/` | rebuildable | yes | A host server's copy of the signed-in devices |
| `~/.open-walnut/cache/` | rebuildable | no | Caches, follower copies and queues (children with another class are listed) |
| `~/.open-walnut/tmp/` | rebuildable | no | Scratch: daemon streams, build output (children with another class are listed) |
| `~/.open-walnut/search.sqlite` | rebuildable | no | The hybrid search index, rebuilt from the stores |
| `~/.open-walnut/notes-index.sqlite` | rebuildable | no | The notes structure index, rebuilt from the notes |
| `~/.open-walnut/models/` | rebuildable | no | Search embedding model at its older place, downloaded again |
| `~/.open-walnut/components/` | rebuildable | no | Downloaded platform components, fetched again on demand |
| `~/.open-walnut/.walnut-obsidian-search/` | rebuildable | no | Semantic index of the notes, rebuilt from the notes |
| `~/.open-walnut/.smart-env/` | rebuildable | no | A notes app plugin's embeddings, rebuilt by it |
| `~/.open-walnut/.git/` | leader-data | no | Git sync's history of the synced files: the only history when no data remote is configured |
| `~/.open-walnut/.gitignore` | rebuildable | no | Git sync's ignore list, written again from its template |
| `~/.open-walnut/logs/` | rebuildable | no | Log files left in the home |
| `~/.open-walnut/hook-errors.log` | rebuildable | no | Hook error log |
| `~/.open-walnut/cache/applied-ops.sqlite` | leader-data | no | Offline-merge ledger of ops already applied, so none applies twice |
| `~/.open-walnut/cache/leader-op-outcomes.json` | leader-data | no | Outcomes of outward ops the leader permit's witnesses reported, so none goes out twice |
| `~/.open-walnut/cache/status-riding.json` | leader-data | no | Status lines and turn notices waiting to ride a session's next message |
| `~/.open-walnut/cache/status-reconcile.json` | leader-data | no | Status asks already made per session and turn, so none is asked again |
| `~/.open-walnut/cache/task-dir-size-notices.json` | leader-data | no | Oversized task folder notices already given |
| `~/.open-walnut/cache/suggest-accuracy.jsonl` | leader-data | no | Ledger of what the launch suggestions proposed against what was launched |
| `~/.open-walnut/cache/engine-split.json` | leader-data | no | Recent engine split picks, which the shares are counted from |
| `~/.open-walnut/cache/work-card.json` | leader-data | no | When the phone's work card stretch began |
| `~/.open-walnut/cache/host-fix-failures.json` | leader-data | no | Host fixes that failed recently, so a restart does not run them again |
| `~/.open-walnut/cache/agent-actions.json` | leader-data | no | What agents did in the browser, to tell an agent's sign-in from a stranger's |
| `~/.open-walnut/cache/agent-action-salt.json` | leader-data | yes | Salt of the account keys in the browser agent actions (moves with them) |
| `~/.open-walnut/cache/task-queue/` | machine | no | A follower's task ops waiting for the leader |
| `~/.open-walnut/cache/control-queue/` | machine | no | A follower's session metadata patches waiting for the leader |
| `~/.open-walnut/cache/send-queue/` | machine | no | A follower's session messages waiting for their host |
| `~/.open-walnut/cache/human-inbox-queue/` | machine | no | A follower's letter changes waiting for the leader |
| `~/.open-walnut/cache/cloud-chat-outbox/` | machine | no | A follower's chat turns waiting for the leader |
| `~/.open-walnut/cache/journal/` | machine | no | A follower's offline journal waiting to drain |
| `~/.open-walnut/cache/revoke-queue/` | machine | yes | Device revocations waiting for the leader |
| `~/.open-walnut/cache/replica-overlay.json` | machine | no | A follower's changes made while the leader was away |
| `~/.open-walnut/cache/companion-conversation-edits.json` | machine | no | A follower's conversation edits waiting for the leader |
| `~/.open-walnut/cache/companion-notification-outbox.json` | machine | no | A follower's notification cards waiting to send |
| `~/.open-walnut/cache/companion-notifications.json` | machine | no | A follower's own notification list |
| `~/.open-walnut/cache/leader/` | machine | no | Who leads this box while the primary is away |
| `~/.open-walnut/cache/host-link-ledger.json` | machine | no | When each host's link was down, as this box saw it |
| `~/.open-walnut/cache/sleep-ledger.json` | machine | no | When this machine slept and when no server ran on it |
| `~/.open-walnut/cache/server-alive.json` | machine | no | Last alive stamp of the server running on this machine |
| `~/.open-walnut/cache/cloud-chat-lanes.json` | machine | no | Catch-up marks of this box's chat lanes |
| `~/.open-walnut/cache/acp-upgrade-hold.json` | machine | no | A hold on upgrading this machine's engine adapter |
| `~/.open-walnut/cache/plugin-boot-state.json` | machine | no | Plugin boot sentinel of this server |
| `~/.open-walnut/cache/companion-bases.sqlite` | machine | no | A follower's merge bases of its queued task writes (they go with that queue) |
| `~/.open-walnut/cache/companion-build.json` | machine | no | Companion builds this machine gave up on, until its own build changes |
| `~/.open-walnut/cache/decision-owner.json` | machine | no | Only a lock name: its .lock serializes status and report writes |
| `~/.open-walnut/cache/walnut-activity-v5` (and names matching `^cache\/walnut-[a-z]+-v\d+(\.(plist\|srchash))?$`) | machine | no | Native helpers built and signed on this machine |
| `~/.open-walnut/cache/walnut-app-fda-ok` | machine | no | That the app's disk access permission worked on this machine |
| `~/.open-walnut/cache/screentime-grant-ok` | machine | no | That the screen time permission worked on this machine |
| `~/.open-walnut/cache/replica/` | rebuildable | no | A follower's copies of the leader's stores |
| `~/.open-walnut/cache/search-replica.sqlite` | rebuildable | no | A follower's copy of the search index |
| `~/.open-walnut/cache/search-replica.json` | rebuildable | no | A follower's search copy state |
| `~/.open-walnut/cache/task-replica.json` | rebuildable | no | A follower's task copy state |
| `~/.open-walnut/cache/task-replica-leader.json` | rebuildable | no | Which leader a follower's task copy came from |
| `~/.open-walnut/cache/host-replica/` | rebuildable | no | Manifests hosts took of their copies |
| `~/.open-walnut/cache/history/` | rebuildable | no | Session history cache, rebuilt from transcripts |
| `~/.open-walnut/cache/history-archive-due.json` | rebuildable | no | When the transcript archive sweep is next due |
| `~/.open-walnut/cache/projections/` | rebuildable | no | Session and task list snapshots |
| `~/.open-walnut/cache/transcripts/` | rebuildable | no | Transcript tails |
| `~/.open-walnut/cache/session-changes/` | rebuildable | no | File change snapshots per session |
| `~/.open-walnut/cache/diff-summaries/` | rebuildable | no | Diff summaries per session |
| `~/.open-walnut/cache/models/` | rebuildable | no | Search embedding model download |
| `~/.open-walnut/cache/browser-pages/` | rebuildable | no | Browser page captures |
| `~/.open-walnut/cache/pricing/` | rebuildable | no | Model price book |
| `~/.open-walnut/cache/daemon-binaries/` | rebuildable | no | Compressed daemon binaries for upload to hosts |
| `~/.open-walnut/cache/host-server/` | rebuildable | no | Host server build packages |
| `~/.open-walnut/cache/web-static/` | rebuildable | no | Web app assets of earlier builds |
| `~/.open-walnut/cache/cloud-infra/` | rebuildable | no | Cloud setup working copy |
| `~/.open-walnut/cache/plugin-bundles/` | rebuildable | no | Plugin bundles |
| `~/.open-walnut/cache/plugin-generations/` | rebuildable | no | Plugin module snapshots |
| `~/.open-walnut/cache/plugin-jobs/` | rebuildable | no | Plugin job bundles |
| `~/.open-walnut/cache/plugin-web-modules/` | rebuildable | no | Plugin web modules |
| `~/.open-walnut/cache/companion-build-seen.json` | rebuildable | no | Companion builds last seen |
| `~/.open-walnut/cache/host-model-catalogs.json` | rebuildable | no | Last known model list per host |
| `~/.open-walnut/cache/model-windows.json` | rebuildable | no | Context window sizes per model |
| `~/.open-walnut/cache/subscription-limits.json` | rebuildable | no | Last read subscription limits |
| `~/.open-walnut/cache/devices-last-known.json` | rebuildable | no | Devices last seen |
| `~/.open-walnut/local/backup/` | leader-data | yes | Backup settings: recovery key and storage sign-in |
| `~/.open-walnut/local/backup/machine-id` | machine | no | This machine's backup writer id |
| `~/.open-walnut/local/backup/run.lock` | machine | no | This machine's backup run lock |
| `~/.open-walnut/local/ai/` | leader-data | no | In-app AI conversations and spend |
| `~/.open-walnut/local/drafts.json` | leader-data | no | Unsent message drafts |
| `~/.open-walnut/local/focus-active.json` | machine | no | The focus space the person is in now, and until when |
| `~/.open-walnut/local/stt-learned-corrections.json` | leader-data | no | Voice input corrections learned from sends |
| `~/.open-walnut/local/page-visits.json` | leader-data | no | When the user last opened each page |
| `~/.open-walnut/local/usage-watch.sqlite` | leader-data | no | Real use on this server: hourly counts of tool calls, requests and page errors, the watches of shipped changes and the notes sent (names, sizes, times and codes only) |
| `~/.open-walnut/local/preview-storage/` | leader-data | no | Saved state of rich previews |
| `~/.open-walnut/local/quiet-held-push.json` | leader-data | no | Phone pushes held during quiet hours |
| `~/.open-walnut/local/machine-id` | machine | no | This machine's id for daemon updates |
| `~/.open-walnut/local/leader-switch/` | machine | no | The leader switch of this home: its steps and lock, the handed-over marker, the promotion record, permission log |
| `~/.open-walnut/local/restore-drill.json` | machine | no | The last restore drill of this machine's backups: when, which backup, each check |
| `~/.open-walnut/local/health-monitor/` | machine | no | Walnut Health records of this machine |
| `~/.open-walnut/local/feature-nodes/` | machine | no | Connection journal of feature nodes |
| `~/.open-walnut/local/runtime/` | machine | no | The runtime tree of this install |
| `~/.open-walnut/local/running-switches/` | machine | no | Engine switches this server is running |
| `~/.open-walnut/local/planned-restart.json` | machine | no | A restart this server planned |
| `~/.open-walnut/local/last-planned-stop.json` | machine | no | Why the last server stopped, for the next boot |
| `~/.open-walnut/local/spawn-journal.jsonl` | machine | no | Sessions this host's daemon started |
| `~/.open-walnut/local/host-mcp.json` | machine | no | MCP servers this host offers |
| `~/.open-walnut/local/expose-handover.json` | machine | no | Port handover between server generations |
| `~/.open-walnut/local/fleet-cache.json` | machine | no | Last known host fleet facts |
| `~/.open-walnut/local/hub-port-grants.json` | machine | no | Ports granted on this machine's hub |
| `~/.open-walnut/local/host-server-tunnel-retries.json` | machine | no | Host server tunnel retry counts |
| `~/.open-walnut/local/sign-in-state.json` | machine | no | Who owns the open sign-in ask |
| `~/.open-walnut/local/host-auth-alert.json` | machine | no | Host sign-in alert episodes |
| `~/.open-walnut/local/ssh-cert-expiry-alert.json` | machine | no | SSH certificate expiry alert episode |
| `~/.open-walnut/local/local-network-alert.json` | machine | no | Local network permission alert |
| `~/.open-walnut/local/session-request-clock.json` | machine | no | This machine's clock for reply request deadlines |
| `~/.open-walnut/local/stt-media-hold.json` | machine | no | Media paused for voice input |
| `~/.open-walnut/local/update-install.log` (and names matching `^local\/update-[^/]+(\/\|$)`) | machine | no | Self-update install state and log |
| `~/.open-walnut/local/daemon-update-pending.json` (and names matching `^local\/daemon-update-[^/]+\.json$`) | machine | no | Daemon update records |
| `~/.open-walnut/local/demo-session-ownership.json` | machine | no | Session ownership of a demo server |
| `~/.open-walnut/local/demo-ssh/` | machine | no | SSH settings and helper of a demo server's fake hosts |
| `~/.open-walnut/local/demo-sign-ins/` | machine | no | Sign-in asks of a demo server |
| `~/.open-walnut/local/demo-sign-in.sh` | machine | no | The sign-in helper of a demo server |
| `~/.open-walnut/sync/bridge-tokens.json` | leader-data | yes | Tokens of the cloud companion bridge |
| `~/.open-walnut/sync/cloud-unpaired.json` | machine | no | That this machine unpaired from the cloud companion, and which token |
| `~/.open-walnut/sync/reconcile-plugin.json` (and names matching `^sync\/reconcile-[^/]+\.json$`) | leader-data | no | Each sync plugin's reconcile cursor |
| `~/.open-walnut/sync/ms-todo-delta.json` | leader-data | no | The to-do sync's delta cursor |
| `~/.open-walnut/sync/ms-todo-tokens.json` | leader-data | yes | The to-do sync's sign-in tokens at their older place |
| `~/.open-walnut/sync/jira-sync.json` | leader-data | no | The issue tracker sync's cursor |
| `~/.open-walnut/tmp/file-history/` | leader-data | no | Snapshots of the files the user opened or saved, for their history |
| `~/.open-walnut/tmp/stt-recordings/` | leader-data | no | Voice input audio and its text, so a lost answer can be put back |
| `~/.open-walnut/tmp/recordings/` | leader-data | no | Audio capture chunks and their transcripts |
| `~/.open-walnut/tmp/recording-state.json` | machine | no | What this machine is recording, to resume after a restart |
| `~/.open-walnut/tmp/streams/` | machine | no | Live session output streams of this machine's daemon |
| `~/.open-walnut/tmp/spawned-sessions/` | machine | no | Sessions this machine's daemon started (older ledger) |
| `~/.open-walnut/tmp/resume-records/` | machine | no | Resume records of this machine's daemon |
| `~/.open-walnut/tmp/trigger-state/` | machine | no | What each trigger on this machine's daemon already saw and reported |
| `~/.open-walnut/tmp/offline-host/` | machine | no | This machine's daemon's offline journal: what it took while the leader was away |
| `~/.open-walnut/tmp/leader/` | machine | no | This machine's daemon's leader book |
| `~/.open-walnut/tmp/usage-budgets/` | machine | no | Usage budgets as this machine's daemon holds them |
| `~/.open-walnut/tmp/host-exec/` | machine | no | Commands run on this machine and their output |
| `~/.open-walnut/tmp/host-vitals/` | machine | no | This machine's load and memory samples |
| `~/.open-walnut/tmp/standby-staging/` | machine | no | A standby batch being staged on this machine, emptied after each batch; one a killed process left is removed by the next batch |
| `~/.open-walnut/tmp/ephemeral-slots/` | machine | no | Slots of the throwaway servers running here |
| `~/.open-walnut/tmp/ephemeral-registry.json` | machine | no | The throwaway servers running here |
| `~/.open-walnut/tmp/standby-spool/` | rebuildable | no | Chunks of a standby batch waiting to go to the standby host; a folder whose process is gone is removed by the next batch |
| `~/.open-walnut/tmp/host-replica/` | rebuildable | no | This host's copies of the leader's stores |
| `~/.open-walnut/tmp/host-server/` | rebuildable | no | Host server build packages |
| `~/.open-walnut/tmp/plugin-jobs/` | rebuildable | no | Plugin job bundles |
| `~/.open-walnut/tmp/plugins/` | rebuildable | no | Each plugin's scratch area |
| `~/.open-walnut/tmp/plugin-updates-cache.json` | rebuildable | no | Last plugin update check |
| `~/.open-walnut/tmp/bin/` | rebuildable | no | Prebuilt helper binaries |
| `~/.open-walnut/tmp/stt-takes/` | rebuildable | no | Voice takes as they upload while recording, heard ahead and removed at their stop |
| `~/.open-walnut/tmp/backup-staging/` (and names matching `^tmp\/backup-staging-repo(\/\|$)`) | rebuildable | no | A backup run's staging copy |
| `~/.open-walnut/tasks/tasks.sqlite` | leader-data | no | The task database |
| `~/.open-walnut/org/threads.sqlite` | leader-data | no | The threads database |
| `~/.open-walnut/org/threads-backup/` | rebuildable | no | Rollback copies of threads taken before a move or merge |
| `~/.open-walnut/artifacts/.backup/` | rebuildable | no | Rollback copies of the notes taken before a move |
| `~/.open-walnut/artifacts/.unify-stage/` | rebuildable | no | Half-built shadow of the artifacts folder during a move |
| `~/.open-walnut/code-server/instance.json` | machine | no | The in-app editor running here: port, pid, instance id |
| `~/.open-walnut/time-tracking/outside/` | leader-data | no | App and site samples (git sync keeps them out) |
| `~/.open-walnut/time-tracking/2026-01-01.jsonl` (and names matching `^time-tracking\/\d{4}-\d{2}-\d{2}\.jsonl$`) | leader-data | no | A day of time samples |
| `~/.open-walnut/time-tracking/outside/2026-01-01.jsonl` (and names matching `^time-tracking\/outside\/\d{4}-\d{2}-\d{2}\.jsonl$`) | leader-data | no | A day of app and site samples |
| `~/.open-walnut/time-tracking/outside/detail/2026-01-01.jsonl` (and names matching `^time-tracking\/outside\/detail\/[^/]+\.jsonl$`) | leader-data | no | A day of app and site sample details |
| `~/.open-walnut/time-tracking/outside/calls/2026-01-01.jsonl` (and names matching `^time-tracking\/outside\/calls\/[^/]+\.jsonl$`) | leader-data | no | A day of calls |
| `~/.open-walnut/browser/replays/task/index.jsonl` (and names matching `^browser\/replays\/[^/]+\/index\.jsonl$`) | leader-data | no | The steps of a task's browser replays |
| `~/.open-walnut/offline-conflicts/drain.ndjson` (and names matching `^offline-conflicts\/[^/]+\.ndjson$`) | leader-data | no | One offline drain's merge conflicts (a failed append is cut back to where it began) |
| `~/.open-walnut/config/share/stt-vocab.txt` | leader-data | no | Voice input vocabulary, one word added at a time |
| `~/.open-walnut/vault/vault.json` | leader-data | yes | The encrypted vault |
| `~/.open-walnut/vault/machine.json` (and names matching `^vault\/machine-[^/]+\.json$`) | machine | yes | This machine's key that opens the vault, and the retired keys of earlier vaults |
| `~/.open-walnut/vault/sessions.json` | machine | yes | Vault unlock sessions |
| `~/.open-walnut/vault/browsers.json` | machine | yes | Keys of the browsers paired with this machine's vault |
| `~/.open-walnut/` (and names matching `(^\|\/)(?:[^/]+\.(?:json\|jsonl\|sqlite\|ya?ml\|md\|txt\|notes)\|skills\|route\|run\|journal-blobs\|\.locks\/[^/]+)\.lock(?:\.[^/]+\.lock)?(\/\|$)`) | machine | no | Walnut's lock dirs and lock files |
| `~/.open-walnut/` (and names matching `(^\|\/)\.open-walnut-[^/]*\.tmp$`) | rebuildable | yes | Atomic write temps a crash left behind (may hold what the target holds) |
| `~/.open-walnut/` (and names matching `(^\|\/)\.DS_Store$`) | rebuildable | no | Operating system litter |

### Outside the data home

| Where | Class | Sensitive | What |
| --- | --- | --- | --- |
| `$XDG_STATE_HOME/open-walnut/secrets-master/` | leader-data | yes | Fleet secrets: the leader's master copy of every secret it shares with hosts |
| `$XDG_STATE_HOME/open-walnut/vault/` | leader-data | yes | The password vault (vault.json and its side files) |
| `$XDG_STATE_HOME/open-walnut/vault/machine.json` (and names matching `^open-walnut\/vault\/machine-[^/]+\.json$`) | machine | yes | This machine's key that opens the vault, and the retired keys of earlier vaults |
| `$XDG_STATE_HOME/open-walnut/vault/sessions.json` | machine | yes | Vault unlock sessions on this machine |
| `$XDG_STATE_HOME/open-walnut/vault/browsers.json` | machine | yes | Keys of the browsers paired with this machine's vault |
| `$XDG_STATE_HOME/open-walnut/secrets/` | machine | yes | This host's copy of the fleet secrets shared with it |
| `$XDG_STATE_HOME/open-walnut/tasks/` | machine | no | Task working folders of sessions that ran on this machine: on purpose, they belong to the host a session runs on, and a leader switch does not move sessions |
| `$XDG_STATE_HOME/open-walnut/machine-id` | machine | no | This machine's stable id: the holder id of a switchable leader's write permission (read only, made by the machine-id task) |
| `$XDG_STATE_HOME/open-walnut/leader-instance/` | machine | no | The instance lock of a switchable leader: one leader server per machine id holds the write permission |
| `$XDG_STATE_HOME/open-walnut/approvals/` | machine | yes | Wait tokens of approval asks made from this machine's shell |
| `$XDG_STATE_HOME/open-walnut/net/` | machine | yes | This machine's host network identity (always under ~/.local/state) |
| `$XDG_STATE_HOME/open-walnut/net-members.json` | machine | no | The companion's list of machines allowed on the host network |
| `$XDG_STATE_HOME/open-walnut/clone-identity/` | machine | no | Pending clone identity marks of this machine's sessions |
| `$XDG_STATE_HOME/open-walnut/daemon-previous/` | machine | no | The previous daemon build, kept for a rollback |
| `$XDG_STATE_HOME/open-walnut/primary-daemon/` | machine | no | The tunnel daemon of this machine |
| `~/.local/share/open-walnut/daemon/` | machine | no | The login service's daemon state and boot script |
| `~/.local/share/open-walnut/bin/` | rebuildable | no | Voice input helper binaries, installed again on demand |
| `~/.local/share/open-walnut/stt-llama/` | rebuildable | no | Local voice model runtime, installed again on demand |
| `~/.local/share/open-walnut/stt-mlx/` | rebuildable | no | Local voice model runtime, installed again on demand |
| `~/.claude/` | machine | no | The engine's own home on this machine |
| `~/.claude/projects/` | machine | no | Engine transcripts (JSONL) of sessions that ran on this machine: on purpose, they belong to the host a session runs on, and a leader switch does not move sessions |
| `~/.claude/settings.json` | machine | no | The engine's settings and enabled plugins |
| `~/.claude/skills/` | machine | no | The engine's user skills |
| `~/.claude/plugins/` | machine | no | The engine's plugins and marketplaces |
| `~/.claude/.credentials.json` | machine | yes | The engine's subscription sign-in (Walnut only checks it exists) |
| `~/.claude/debug/` | machine | no | The engine's debug logs |
| `<runtime dir>/` | machine | no | Runtime files: the local daemon's port, pid and registry |
| `<runtime dir>/` (and names matching `^open-walnut-[^/]+\.log$`) | rebuildable | no | Server and browser logs |
| `<runtime dir>/streams/` | machine | no | Live session output streams |
| `<runtime dir>/term/` | machine | no | Terminal sockets |
| `<runtime dir>/images/` | machine | no | Images pasted or attached in sessions on this machine |
| `<runtime dir>/pastes/` | machine | no | Oversized pastes spilled to disk |
| `<runtime dir>/net/` | machine | no | Host network identity of a throwaway daemon |
| `~/.config/walnut/` | machine | no | Machine holds that stop test runs here |
| `~/Library/Application Support/Open Walnut/` | machine | no | How the Mac app launches the session host |
| `~/.config/systemd/user/` | machine | no | The daemon's login service unit on Linux |
| `~/Library/LaunchAgents/` | machine | no | The daemon's login service on macOS |

<!-- data-locations:end -->
