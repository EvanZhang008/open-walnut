/**
 * Places below the top level of WALNUT_HOME whose class differs from their parent's,
 * and every child of the mixed dirs (cache/, local/, sync/, tmp/), whose children each
 * need an entry of their own. Plus the few families of files that can sit at any depth.
 */
import { DAEMON, lead, mach, rebuild } from './build.js'
import type { HomeEntry } from './types.js'

/** cache/: rebuildable unless listed otherwise here. */
const CACHE_ENTRIES: readonly HomeEntry[] = [
  // Ledgers and queue state that sit in cache/ only so git sync leaves them out: no other copy exists.
  lead('cache.applied-ops', 'cache/applied-ops.sqlite', 'sqlite', 'Offline-merge ledger of ops already applied, so none applies twice'),
  lead('cache.leader-op-outcomes', 'cache/leader-op-outcomes.json', 'file', 'Outcomes of outward ops the leader permit\'s witnesses reported, so none goes out twice'),
  lead('cache.leader-permit-number', 'cache/leader-permit-number.json', 'file', 'The highest write-permission number this Walnut told its hosts, so a permit turned off after it was on never tells them 0'),
  lead('cache.leader-deferred-work', 'cache/leader-deferred-work.json', 'file', 'Outward work a closed door held back (a list rename, a moved copy, a remote delete, an unsubscribe answer), done once the doors open'),
  lead('cache.status-riding', 'cache/status-riding.json', 'file', 'Status lines and turn notices waiting to ride a session\'s next message'),
  lead('cache.held-notices', 'cache/held-notices.json', 'file', 'Notes and notices waiting to ride a session\'s next message, and what became of each note'),
  lead('cache.status-reconcile', 'cache/status-reconcile.json', 'file', 'Status asks already made per session and turn, so none is asked again'),
  lead('cache.task-dir-size-notices', 'cache/task-dir-size-notices.json', 'file', 'Oversized task folder notices already given'),
  lead('cache.suggest-accuracy', 'cache/suggest-accuracy.jsonl', 'file', 'Ledger of what the launch suggestions proposed against what was launched', { appendOnly: true }),
  lead('cache.engine-split', 'cache/engine-split.json', 'file', 'Recent engine split picks, which the shares are counted from'),
  lead('cache.work-card', 'cache/work-card.json', 'file', 'When the phone\'s work card stretch began'),
  lead('cache.host-fix-failures', 'cache/host-fix-failures.json', 'file', 'Host fixes that failed recently, so a restart does not run them again'),
  lead('cache.agent-actions', 'cache/agent-actions.json', 'file', 'What agents did in the browser, to tell an agent\'s sign-in from a stranger\'s'),
  lead('cache.agent-action-salt', 'cache/agent-action-salt.json', 'file', 'Salt of the account keys in the browser agent actions (moves with them)', { sensitive: true }),
  // A follower's pending work: it belongs to the box that took it, and copying it would replay it.
  mach('cache.task-queue', 'cache/task-queue', 'dir', 'A follower\'s task ops waiting for the leader'),
  mach('cache.control-queue', 'cache/control-queue', 'dir', 'A follower\'s session metadata patches waiting for the leader'),
  mach('cache.send-queue', 'cache/send-queue', 'dir', 'A follower\'s session messages waiting for their host'),
  mach('cache.human-inbox-queue', 'cache/human-inbox-queue', 'dir', 'A follower\'s letter changes waiting for the leader'),
  mach('cache.cloud-chat-outbox', 'cache/cloud-chat-outbox', 'dir', 'A follower\'s chat turns waiting for the leader'),
  mach('cache.journal', 'cache/journal', 'dir', 'A follower\'s offline journal waiting to drain'),
  mach('cache.revoke-queue', 'cache/revoke-queue', 'dir', 'Device revocations waiting for the leader', { sensitive: true }),
  mach('cache.replica-overlay', 'cache/replica-overlay.json', 'file', 'A follower\'s changes made while the leader was away'),
  mach('cache.companion-conversation-edits', 'cache/companion-conversation-edits.json', 'file', 'A follower\'s conversation edits waiting for the leader'),
  mach('cache.companion-notification-outbox', 'cache/companion-notification-outbox.json', 'file', 'A follower\'s notification cards waiting to send'),
  mach('cache.companion-notifications', 'cache/companion-notifications.json', 'file', 'A follower\'s own notification list'),
  mach('cache.leader', 'cache/leader', 'dir', 'Who leads this box while the primary is away'),
  mach('cache.host-link-ledger', 'cache/host-link-ledger.json', 'file', 'When each host\'s link was down, as this box saw it'),
  mach('cache.sleep-ledger', 'cache/sleep-ledger.json', 'file', 'When this machine slept and when no server ran on it'),
  mach('cache.delivery-ledger', 'cache/delivery-ledger', 'dir', 'Where each message to a session got to (sent, held, queued, written, read), one line per step, 14 days'),
  mach('cache.server-alive', 'cache/server-alive.json', 'file', 'Last alive stamp of the server running on this machine'),
  mach('cache.cloud-chat-lanes', 'cache/cloud-chat-lanes.json', 'file', 'Catch-up marks of this box\'s chat lanes'),
  mach('cache.acp-upgrade-hold', 'cache/acp-upgrade-hold.json', 'file', 'A hold on upgrading this machine\'s engine adapter'),
  mach('cache.plugin-boot-state', 'cache/plugin-boot-state.json', 'file', 'Plugin boot sentinel of this server'),
  mach('cache.companion-bases', 'cache/companion-bases.sqlite', 'sqlite', 'A follower\'s merge bases of its queued task writes (they go with that queue)'),
  mach('cache.companion-build', 'cache/companion-build.json', 'file', 'Companion builds this machine gave up on, until its own build changes'),
  mach('cache.decision-owner-lock', 'cache/decision-owner.json', 'file', 'Only a lock name: its .lock serializes status and report writes'),
  // src/core/helper-build.ts: a native helper built and signed here, with its plist and source hash.
  mach('cache.native-helpers', 'cache/walnut-activity-v5', 'file', 'Native helpers built and signed on this machine', { match: /^cache\/walnut-[a-z]+-v\d+(\.(plist|srchash))?$/ }),
  // src/core/protected-reader.ts: a macOS permission worked here once.
  mach('cache.fda-ok', 'cache/walnut-app-fda-ok', 'file', 'That the app\'s disk access permission worked on this machine'),
  mach('cache.screentime-ok', 'cache/screentime-grant-ok', 'file', 'That the screen time permission worked on this machine'),
  // Follower copies of the leader's data and plain caches.
  rebuild('cache.replica', 'cache/replica', 'dir', 'A follower\'s copies of the leader\'s stores'),
  rebuild('cache.search-replica-db', 'cache/search-replica.sqlite', 'sqlite', 'A follower\'s copy of the search index'),
  rebuild('cache.search-replica', 'cache/search-replica.json', 'file', 'A follower\'s search copy state'),
  rebuild('cache.task-replica', 'cache/task-replica.json', 'file', 'A follower\'s task copy state'),
  rebuild('cache.task-replica-leader', 'cache/task-replica-leader.json', 'file', 'Which leader a follower\'s task copy came from'),
  rebuild('cache.host-replica', 'cache/host-replica', 'dir', 'Manifests hosts took of their copies'),
  rebuild('cache.history', 'cache/history', 'dir', 'Session history cache, rebuilt from transcripts'),
  rebuild('cache.history-archive-due', 'cache/history-archive-due.json', 'file', 'When the transcript archive sweep is next due'),
  rebuild('cache.change-watch-due', 'cache/change-watch-due.json', 'file', 'When the change watcher reads each change next; lost, it reads them all once'),
  rebuild('cache.slash-palette', 'cache/slash-palette.json', 'file', 'The slash palette\'s last host scans and stream looks; lost, the first palette after a restart scans the host again'),
  rebuild('cache.session-costs', 'cache/session-costs.json', 'file', 'Each session\'s last cost report; lost, the first cost read after a restart reads the transcript again'),
  rebuild('cache.history-dead-sets', 'cache/history-dead-sets.json', 'file', 'Which lines of rewound transcripts too big to read whole are abandoned; lost, the first read after a restart asks the host again'),
  rebuild('cache.history-tail-windows', 'cache/history-tail-windows', 'dir', 'Tail windows of remote sessions\' transcripts; lost, the first read after a restart moves the whole window again'),
  rebuild('cache.attachment-hashes', 'cache/attachment-hashes.json', 'file', 'File hashes of the notes\' pictures and files the attachments copy sends; lost, it hashes them all once'),
  rebuild('cache.projections', 'cache/projections', 'dir', 'Session and task list snapshots'),
  rebuild('cache.transcripts', 'cache/transcripts', 'dir', 'Transcript tails'),
  rebuild('cache.session-changes', 'cache/session-changes', 'dir', 'File change snapshots per session'),
  rebuild('cache.diff-summaries', 'cache/diff-summaries', 'dir', 'Diff summaries per session'),
  rebuild('cache.models', 'cache/models', 'dir', 'Search embedding model download'),
  rebuild('cache.browser-pages', 'cache/browser-pages', 'dir', 'Browser page captures'),
  rebuild('cache.pricing', 'cache/pricing', 'dir', 'Model price book'),
  rebuild('cache.daemon-binaries', 'cache/daemon-binaries', 'dir', 'Compressed daemon binaries for upload to hosts'),
  rebuild('cache.host-server', 'cache/host-server', 'dir', 'Host server build packages'),
  rebuild('cache.web-static', 'cache/web-static', 'dir', 'Web app assets of earlier builds'),
  rebuild('cache.cloud-infra', 'cache/cloud-infra', 'dir', 'Cloud setup working copy'),
  rebuild('cache.plugin-bundles', 'cache/plugin-bundles', 'dir', 'Plugin bundles'),
  rebuild('cache.plugin-generations', 'cache/plugin-generations', 'dir', 'Plugin module snapshots'),
  rebuild('cache.plugin-jobs', 'cache/plugin-jobs', 'dir', 'Plugin job bundles'),
  rebuild('cache.plugin-web-modules', 'cache/plugin-web-modules', 'dir', 'Plugin web modules'),
  rebuild('cache.companion-build-seen', 'cache/companion-build-seen.json', 'file', 'Companion builds last seen'),
  rebuild('cache.host-model-catalogs', 'cache/host-model-catalogs.json', 'file', 'Last known model list per host'),
  rebuild('cache.model-windows', 'cache/model-windows.json', 'file', 'Context window sizes per model'),
  rebuild('cache.subscription-limits', 'cache/subscription-limits.json', 'file', 'Last read subscription limits'),
  rebuild('cache.devices-last-known', 'cache/devices-last-known.json', 'file', 'Devices last seen'),
]

/** local/: machine unless listed otherwise here. */
const LOCAL_ENTRIES: readonly HomeEntry[] = [
  lead('local.backup', 'local/backup', 'dir', 'Backup settings: recovery key and storage sign-in', { sensitive: true }),
  mach('local.backup.machine-id', 'local/backup/machine-id', 'file', 'This machine\'s backup writer id'),
  mach('local.backup.run-lock', 'local/backup/run.lock', 'file', 'This machine\'s backup run lock'),
  lead('local.ai', 'local/ai', 'dir', 'In-app AI conversations and spend'),
  lead('local.drafts', 'local/drafts.json', 'file', 'Unsent message drafts'),
  mach('local.focus-active', 'local/focus-active.json', 'file', 'The focus space the person is in now, and until when'),
  lead('local.stt-learned', 'local/stt-learned-corrections.json', 'file', 'Voice input corrections learned from sends'),
  lead('local.page-visits', 'local/page-visits.json', 'file', 'When the user last opened each page'),
  lead('local.usage-watch', 'local/usage-watch.sqlite', 'sqlite', 'Real use on this server: hourly counts of tool calls, requests and page errors, the watches of shipped changes and the notes sent (names, sizes, times and codes only)'),
  lead('local.preview-storage', 'local/preview-storage', 'dir', 'Saved state of rich previews'),
  lead('local.quiet-held-push', 'local/quiet-held-push.json', 'file', 'Phone pushes held during quiet hours'),
  mach('local.home', 'local/home.json', 'file', 'Where this data dir was on this machine, and the move it declared to its hosts'),
  mach('local.machine-id', 'local/machine-id', 'file', 'The id an older build made for daemon updates, read only to seed this machine\'s stable id'),
  mach('local.leader-switch', 'local/leader-switch', 'dir', 'The leader switch of this home: its steps and lock, the handed-over marker, the promotion record, permission log'),
  mach('local.restore-drill', 'local/restore-drill.json', 'file', 'The last restore drill of this machine\'s backups: when, which backup, each check'),
  mach('local.health-monitor', 'local/health-monitor', 'dir', 'Walnut Health records of this machine'),
  mach('local.feature-nodes', 'local/feature-nodes', 'dir', 'Connection journal of feature nodes'),
  mach('local.runtime', 'local/runtime', 'dir', 'The runtime tree of this install'),
  mach('local.running-switches', 'local/running-switches', 'dir', 'Engine switches this server is running'),
  mach('local.held-session-marks', 'local/held-session-marks.json', 'file', 'Engine switch marks waiting for their new session\'s row to arrive from its host'),
  mach('local.planned-restart', 'local/planned-restart.json', 'file', 'A restart this server planned'),
  mach('local.last-planned-stop', 'local/last-planned-stop.json', 'file', 'Why the last server stopped, for the next boot'),
  mach('local.spawn-journal', 'local/spawn-journal.jsonl', 'file', 'Sessions this host\'s daemon started', DAEMON),
  mach('local.cli-owners', 'local/cli-owners', 'dir', 'Which daemon owns each running CLI of this host, beside the spawn journal', DAEMON),
  mach('local.acp-runtimes', 'local/acp-runtimes.jsonl', 'file', 'Which Walnut started each ACP worker of this host, beside the spawn journal', DAEMON),
  mach('local.host-mcp', 'local/host-mcp.json', 'file', 'MCP servers this host offers'),
  mach('local.connect', 'local/connect', 'dir', 'Walnut Connect: the socket this server opens for walnut-net to pass paired phones\' requests in'),
  mach('local.expose-handover', 'local/expose-handover.json', 'file', 'Port handover between server generations'),
  mach('local.fleet-cache', 'local/fleet-cache.json', 'file', 'Last known host fleet facts'),
  mach('local.hub-port-grants', 'local/hub-port-grants.json', 'file', 'Ports granted on this machine\'s hub'),
  mach('local.host-server-tunnel-retries', 'local/host-server-tunnel-retries.json', 'file', 'Host server tunnel retry counts'),
  mach('local.sign-in-state', 'local/sign-in-state.json', 'file', 'Who owns the open sign-in ask'),
  mach('local.host-auth-alert', 'local/host-auth-alert.json', 'file', 'Host sign-in alert episodes'),
  mach('local.ssh-cert-expiry-alert', 'local/ssh-cert-expiry-alert.json', 'file', 'SSH certificate expiry alert episode'),
  mach('local.local-network-alert', 'local/local-network-alert.json', 'file', 'Local network permission alert'),
  mach('local.session-request-clock', 'local/session-request-clock.json', 'file', 'This machine\'s clock for reply request deadlines'),
  mach('local.stt-media-hold', 'local/stt-media-hold.json', 'file', 'Media paused for voice input'),
  mach('local.update', 'local/update-install.log', 'file', 'Self-update install state and log', { match: /^local\/update-[^/]+(\/|$)/ }),
  mach('local.daemon-update', 'local/daemon-update-pending.json', 'file', 'Daemon update records', { match: /^local\/daemon-update-[^/]+\.json$/ }),
  mach('local.demo-session-ownership', 'local/demo-session-ownership.json', 'file', 'Session ownership of a demo server'),
  mach('local.demo-ssh', 'local/demo-ssh', 'dir', 'SSH settings and helper of a demo server\'s fake hosts'),
  mach('local.demo-sign-ins', 'local/demo-sign-ins', 'dir', 'Sign-in asks of a demo server'),
  mach('local.demo-sign-in-script', 'local/demo-sign-in.sh', 'file', 'The sign-in helper of a demo server'),
]

/** sync/: leader-data unless listed otherwise here. */
const SYNC_ENTRIES: readonly HomeEntry[] = [
  lead('sync.bridge-tokens', 'sync/bridge-tokens.json', 'file', 'Tokens of the cloud companion bridge', { sensitive: true }),
  mach('sync.cloud-unpaired', 'sync/cloud-unpaired.json', 'file', 'That this machine unpaired from the cloud companion, and which token'),
  lead('sync.reconcile', 'sync/reconcile-plugin.json', 'file', 'Each sync plugin\'s reconcile cursor', { match: /^sync\/reconcile-[^/]+\.json$/ }),
  lead('sync.ms-todo-delta', 'sync/ms-todo-delta.json', 'file', 'The to-do sync\'s delta cursor'),
  lead('sync.ms-todo-tokens', 'sync/ms-todo-tokens.json', 'file', 'The to-do sync\'s sign-in tokens at their older place', { sensitive: true }),
  lead('sync.jira', 'sync/jira-sync.json', 'file', 'The issue tracker sync\'s cursor'),
]

/** tmp/: rebuildable unless listed otherwise here. */
const TMP_ENTRIES: readonly HomeEntry[] = [
  // The only copies of what they hold.
  lead('tmp.file-history', 'tmp/file-history', 'dir', 'Snapshots of the files the user opened or saved, for their history'),
  lead('tmp.stt-recordings', 'tmp/stt-recordings', 'dir', 'Voice input audio and its text, so a lost answer can be put back'),
  lead('tmp.recordings', 'tmp/recordings', 'dir', 'Audio capture chunks and their transcripts'),
  // What this machine runs.
  mach('tmp.recording-state', 'tmp/recording-state.json', 'file', 'What this machine is recording, to resume after a restart'),
  mach('tmp.streams', 'tmp/streams', 'dir', 'Live session output streams of this machine\'s daemon', DAEMON),
  mach('tmp.spawned-sessions', 'tmp/spawned-sessions', 'dir', 'Sessions this machine\'s daemon started (older ledger)', DAEMON),
  mach('tmp.resume-records', 'tmp/resume-records', 'dir', 'Resume records of this machine\'s daemon', DAEMON),
  mach('tmp.trigger-state', 'tmp/trigger-state', 'dir', 'What each trigger on this machine\'s daemon already saw and reported', DAEMON),
  mach('tmp.offline-host', 'tmp/offline-host', 'dir', 'This machine\'s daemon\'s offline journal: what it took while the leader was away', DAEMON),
  mach('tmp.leader-book', 'tmp/leader', 'dir', 'This machine\'s daemon\'s leader book', DAEMON),
  mach('tmp.usage-budgets', 'tmp/usage-budgets', 'dir', 'Usage budgets as this machine\'s daemon holds them', DAEMON),
  mach('tmp.host-exec', 'tmp/host-exec', 'dir', 'Commands run on this machine and their output', DAEMON),
  mach('tmp.host-vitals', 'tmp/host-vitals', 'dir', 'This machine\'s load and memory samples', DAEMON),
  mach('tmp.standby-staging', 'tmp/standby-staging', 'dir', 'A standby batch being staged on this machine, emptied after each batch; one a killed process left is removed by the next batch'),
  mach('tmp.ephemeral-slots', 'tmp/ephemeral-slots', 'dir', 'Slots of the throwaway servers running here'),
  mach('tmp.ephemeral-registry', 'tmp/ephemeral-registry.json', 'file', 'The throwaway servers running here'),
  // Rebuilt or fetched again.
  rebuild('tmp.standby-spool', 'tmp/standby-spool', 'dir', 'Chunks of a standby batch waiting to go to the standby host; a folder whose process is gone is removed by the next batch'),
  rebuild('tmp.host-replica', 'tmp/host-replica', 'dir', 'This host\'s copies of the leader\'s stores', DAEMON),
  rebuild('tmp.host-server', 'tmp/host-server', 'dir', 'Host server build packages', DAEMON),
  rebuild('tmp.plugin-jobs', 'tmp/plugin-jobs', 'dir', 'Plugin job bundles', DAEMON),
  rebuild('tmp.plugins', 'tmp/plugins', 'dir', 'Each plugin\'s scratch area'),
  rebuild('tmp.plugin-updates-cache', 'tmp/plugin-updates-cache.json', 'file', 'Last plugin update check'),
  rebuild('tmp.bin', 'tmp/bin', 'dir', 'Prebuilt helper binaries'),
  rebuild('tmp.stt-takes', 'tmp/stt-takes', 'dir', 'Voice takes as they upload while recording, heard ahead and removed at their stop'),
  rebuild('tmp.backup-staging', 'tmp/backup-staging', 'dir', 'A backup run\'s staging copy', { match: /^tmp\/backup-staging-repo(\/|$)/ }),
]

/** Nested places elsewhere whose class differs from their parent's. */
const OTHER_NESTED: readonly HomeEntry[] = [
  lead('tasks.db', 'tasks/tasks.sqlite', 'sqlite', 'The task database'),
  lead('org.threads-db', 'org/threads.sqlite', 'sqlite', 'The threads database'),
  rebuild('org.threads-backup', 'org/threads-backup', 'dir', 'Rollback copies of threads taken before a move or merge'),
  rebuild('artifacts.backup', 'artifacts/.backup', 'dir', 'Rollback copies of the notes taken before a move'),
  rebuild('artifacts.unify-stage', 'artifacts/.unify-stage', 'dir', 'Half-built shadow of the artifacts folder during a move'),
  mach('code-server.instance', 'code-server/instance.json', 'file', 'The in-app editor running here: port, pid, instance id'),
  lead('time-tracking.outside', 'time-tracking/outside', 'dir', 'App and site samples (git sync keeps them out)'),
  // Logs that only grow: appended, or replaced whole by a compacted copy (a new inode), never
  // rewritten in place (src/core/standby/append-only.ts relies on it).
  lead('time-tracking.day', 'time-tracking/2026-01-01.jsonl', 'file', 'A day of time samples', { match: /^time-tracking\/\d{4}-\d{2}-\d{2}\.jsonl$/, appendOnly: true }),
  lead('time-tracking.outside.day', 'time-tracking/outside/2026-01-01.jsonl', 'file', 'A day of app and site samples', { match: /^time-tracking\/outside\/\d{4}-\d{2}-\d{2}\.jsonl$/, appendOnly: true }),
  lead('time-tracking.outside.detail', 'time-tracking/outside/detail/2026-01-01.jsonl', 'file', 'A day of app and site sample details', { match: /^time-tracking\/outside\/detail\/[^/]+\.jsonl$/, appendOnly: true }),
  lead('time-tracking.outside.calls', 'time-tracking/outside/calls/2026-01-01.jsonl', 'file', 'A day of calls', { match: /^time-tracking\/outside\/calls\/[^/]+\.jsonl$/, appendOnly: true }),
  lead('browser-replays.index', 'browser/replays/task/index.jsonl', 'file', 'The steps of a task\'s browser replays', { match: /^browser\/replays\/[^/]+\/index\.jsonl$/, appendOnly: true }),
  lead('offline-conflicts.log', 'offline-conflicts/drain.ndjson', 'file', 'One offline drain\'s merge conflicts (a failed append is cut back to where it began)', { match: /^offline-conflicts\/[^/]+\.ndjson$/, appendOnly: true }),
  lead('config.stt-vocab', 'config/share/stt-vocab.txt', 'file', 'Voice input vocabulary, one word added at a time', { appendOnly: true }),
  lead('vault-in-home.vault', 'vault/vault.json', 'file', 'The encrypted vault', { sensitive: true }),
  mach('vault-in-home.machine', 'vault/machine.json', 'file', 'This machine\'s key that opens the vault, and the retired keys of earlier vaults', { sensitive: true, match: /^vault\/machine-[^/]+\.json$/ }),
  mach('vault-in-home.sessions', 'vault/sessions.json', 'file', 'Vault unlock sessions', { sensitive: true }),
  mach('vault-in-home.browsers', 'vault/browsers.json', 'file', 'Keys of the browsers paired with this machine\'s vault', { sensitive: true }),
]

const WALNUT_LOCK = /(^|\/)(?:[^/]+\.(?:json|jsonl|sqlite|ya?ml|md|txt|notes)|skills|route|run|journal-blobs|\.locks\/[^/]+)\.lock(?:\.[^/]+\.lock)?(\/|$)/

/** Families of files that can sit at any depth: these win over the dir they sit in. */
export const ANY_DEPTH_ENTRIES: readonly HomeEntry[] = [
  // Walnut's own lock names only (src/utils/file-lock.ts `<store>.lock` and its released
  // `<lock>.<token>.lock`, the skills, route, backup run and journal blob locks, the
  // components' .locks/): a user's or a plugin's lockfile (bun.lock, Cargo.lock) is data.
  mach('lock-files', '', 'file', 'Walnut\'s lock dirs and lock files', { match: WALNUT_LOCK }),
  rebuild('write-temps', '', 'file', 'Atomic write temps a crash left behind (may hold what the target holds)', { sensitive: true, match: /(^|\/)\.open-walnut-[^/]*\.tmp$/ }),
  rebuild('os-litter', '', 'file', 'Operating system litter', { match: /(^|\/)\.DS_Store$/ }),
]

export const NESTED_ENTRIES: readonly HomeEntry[] = [...CACHE_ENTRIES, ...LOCAL_ENTRIES, ...SYNC_ENTRIES, ...TMP_ENTRIES, ...OTHER_NESTED]
