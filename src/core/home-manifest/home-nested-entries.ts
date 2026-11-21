/**
 * Places below the top level of WALNUT_HOME whose class differs from their parent's,
 * and every child of the mixed dirs (cache/, local/, sync/, tmp/), whose children each
 * need an entry of their own. Plus the few families of files that can sit at any depth.
 */
import { lead, mach, rebuild } from './build.js'
import type { HomeEntry } from './types.js'

/** cache/: rebuildable unless listed otherwise here. */
const CACHE_ENTRIES: readonly HomeEntry[] = [
  // Ledgers and queue state that sit in cache/ only so git sync leaves them out: no other copy exists.
  lead('cache.applied-ops', 'cache/applied-ops.sqlite', 'sqlite', 'Offline-merge ledger of ops already applied, so none applies twice'),
  lead('cache.status-riding', 'cache/status-riding.json', 'file', 'Status lines and turn notices waiting to ride a session\'s next message'),
  lead('cache.status-reconcile', 'cache/status-reconcile.json', 'file', 'Status asks already made per session and turn, so none is asked again'),
  lead('cache.task-dir-size-notices', 'cache/task-dir-size-notices.json', 'file', 'Oversized task folder notices already given'),
  lead('cache.suggest-accuracy', 'cache/suggest-accuracy.jsonl', 'file', 'Ledger of what the launch suggestions proposed against what was launched'),
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
  lead('local.stt-learned', 'local/stt-learned-corrections.json', 'file', 'Voice input corrections learned from sends'),
  lead('local.page-visits', 'local/page-visits.json', 'file', 'When the user last opened each page'),
  lead('local.preview-storage', 'local/preview-storage', 'dir', 'Saved state of rich previews'),
  lead('local.quiet-held-push', 'local/quiet-held-push.json', 'file', 'Phone pushes held during quiet hours'),
  mach('local.machine-id', 'local/machine-id', 'file', 'This machine\'s id for daemon updates'),
  mach('local.restore-drill', 'local/restore-drill.json', 'file', 'The last restore drill of this machine\'s backups: when, which backup, each check'),
  mach('local.health-monitor', 'local/health-monitor', 'dir', 'Walnut Health records of this machine'),
  mach('local.feature-nodes', 'local/feature-nodes', 'dir', 'Connection journal of feature nodes'),
  mach('local.runtime', 'local/runtime', 'dir', 'The runtime tree of this install'),
  mach('local.running-switches', 'local/running-switches', 'dir', 'Engine switches this server is running'),
  mach('local.planned-restart', 'local/planned-restart.json', 'file', 'A restart this server planned'),
  mach('local.last-planned-stop', 'local/last-planned-stop.json', 'file', 'Why the last server stopped, for the next boot'),
  mach('local.spawn-journal', 'local/spawn-journal.jsonl', 'file', 'Sessions this host\'s daemon started'),
  mach('local.host-mcp', 'local/host-mcp.json', 'file', 'MCP servers this host offers'),
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
  mach('tmp.streams', 'tmp/streams', 'dir', 'Live session output streams of this machine\'s daemon'),
  mach('tmp.spawned-sessions', 'tmp/spawned-sessions', 'dir', 'Sessions this machine\'s daemon started (older ledger)'),
  mach('tmp.resume-records', 'tmp/resume-records', 'dir', 'Resume records of this machine\'s daemon'),
  mach('tmp.trigger-state', 'tmp/trigger-state', 'dir', 'What each trigger on this machine\'s daemon already saw and reported'),
  mach('tmp.host-exec', 'tmp/host-exec', 'dir', 'Commands run on this machine and their output'),
  mach('tmp.host-vitals', 'tmp/host-vitals', 'dir', 'This machine\'s load and memory samples'),
  mach('tmp.ephemeral-slots', 'tmp/ephemeral-slots', 'dir', 'Slots of the throwaway servers running here'),
  mach('tmp.ephemeral-registry', 'tmp/ephemeral-registry.json', 'file', 'The throwaway servers running here'),
  // Rebuilt or fetched again.
  rebuild('tmp.host-replica', 'tmp/host-replica', 'dir', 'This host\'s copies of the leader\'s stores'),
  rebuild('tmp.host-server', 'tmp/host-server', 'dir', 'Host server build packages'),
  rebuild('tmp.plugin-jobs', 'tmp/plugin-jobs', 'dir', 'Plugin job bundles'),
  rebuild('tmp.plugins', 'tmp/plugins', 'dir', 'Each plugin\'s scratch area'),
  rebuild('tmp.plugin-updates-cache', 'tmp/plugin-updates-cache.json', 'file', 'Last plugin update check'),
  rebuild('tmp.bin', 'tmp/bin', 'dir', 'Prebuilt helper binaries'),
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
