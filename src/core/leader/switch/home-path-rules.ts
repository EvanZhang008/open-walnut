/**
 * What a promoted home does with each absolute path of the old machine it holds
 * (home-paths.ts finds them; docs/reference/leader-switch.md, "Paths"). Two sets:
 *
 *   - rewrite: the promotion moves it (the old home to the new home; in config.yaml also the old
 *     account home to the new one), or sets a value of its own (standby.dir);
 *   - keep: it must not change, for one of three reasons:
 *       HOST_PLACE  a place on the machine that ran the work (a repo, a task folder, a session's
 *                   folder, a transcript): the work and its files stay on that machine;
 *       RECORD      text a person or an agent wrote, or a log of what happened: nothing
 *                   follows it as a setting;
 *       on purpose  leader_switch, which names both machines.
 *
 * The rules are in order, specific first: the first rule that covers a place decides it.
 * Every leader-data store of the home manifest is in a rule's `stores` or in NO_PATH_STORES,
 * and every rule is met by the synthetic home (tests/core/leader/switch/home-path-ratchet.test.ts):
 * a new store is red there until someone decides. A path no rule decides fails the trial
 * (self-check.ts), which rolls back.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import Database from '../../../lib/sqlite.js'
import { writeAtomic, type PathRule, type RewriteContext } from './home-paths.js'

const HOST_PLACE = 'a place on the machine that ran the work (a repo, a task or session folder, a transcript): the work and its files stay on that machine, so the path is kept as it is'
const RECORD = 'text a person or an agent wrote, or a log of what happened: nothing follows it as a setting'
const IN_HOME = 'names a file or folder in the home, which moved: the same place in the new home'

export const LEDGER_RULE = 'applied-ops-ledger'

/** Rewrite the ledger's home column; rows already under the new home win. */
export function rewriteLedgerHome(home: string, from: string, to: string): number {
  const file = path.join(home, 'cache', 'applied-ops.sqlite')
  if (!fs.existsSync(file) || from === to) return 0
  const db = new Database(file)
  try {
    let n = 0
    db.exec('BEGIN IMMEDIATE')
    for (const table of ['applied_ops', 'create_remap']) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (!exists) continue
      n += Number(db.prepare(`UPDATE OR IGNORE ${table} SET home = ? WHERE home = ?`).run(to, from).changes ?? 0)
      db.prepare(`DELETE FROM ${table} WHERE home = ?`).run(from)
    }
    db.exec('COMMIT')
    return n
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* none open */ }
    throw err
  } finally {
    db.close()
  }
}

/**
 * Point config.yaml's standby at the old machine, keeping the rest of the file as it is: `dir` there,
 * on the host `host` when the copy came over a daemon link (none: a folder this machine reaches).
 */
export function rewriteStandbyTarget(home: string, to: { dir: string; host?: string }): void {
  const file = path.join(home, 'config.yaml')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const doc = YAML.parseDocument(text)
  doc.setIn(['standby', 'dir'], to.dir)
  if (to.host) doc.setIn(['standby', 'host'], to.host)
  else doc.deleteIn(['standby', 'host'])
  writeAtomic(file, String(doc))
}

// Every spelling of the old home (its real path too): the ledger keys rows by the one its server used.
const ledgerMove = (home: string, ctx: RewriteContext): number =>
  ctx.roots.filter((r) => r.kind === 'home').reduce((n, r) => n + rewriteLedgerHome(home, r.from, r.to), 0)

/** Files by their kind: an image, audio, video, font, archive or compiled code. */
const BLOB_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'ico', 'tif', 'tiff', 'pdf',
  'mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac', 'caf', 'webm', 'mp4', 'mov', 'mkv',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'tar', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm', 'node', 'so', 'dylib', 'dll', 'exe', 'pack', 'idx']
const BLOB_GLOBS = BLOB_EXTS.flatMap((e) => [e, e.toUpperCase()]).flatMap((e) => [`*.${e}`, `**/*.${e}`])

const RULES: readonly PathRule[] = [
  // Read first: a blob is never scanned, and an unreadable file it is not fails the trial.
  { id: 'blobs', stores: [], file: BLOB_GLOBS, rule: 'keep', why: 'an image, audio, video, font, archive or compiled file: a blob, and no path Walnut follows is in one' },
  // config.yaml: the leader's own settings.
  { id: 'config-leader-switch', stores: ['config-yaml'], file: 'config.yaml', at: 'leader_switch', rule: 'keep', why: 'names both machines\' places on purpose (each machine\'s home, standby folder, account home and witnesses)' },
  {
    id: 'config-standby-dir', stores: ['config-yaml'], file: 'config.yaml', at: 'standby.dir', rule: 'rewrite', remains: true,
    why: 'becomes the old machine\'s standby folder (on that machine as a host, when the copy came over a daemon link): the new leader\'s batches go there, for the switch back',
    apply: (home, ctx) => { rewriteStandbyTarget(home, { dir: ctx.reverseStandbyDir, ...(ctx.reverseStandbyHost ? { host: ctx.reverseStandbyHost } : {}) }); return 1 },
  },
  { id: 'config-host-keyed', stores: ['config-yaml'], file: 'config.yaml', at: ['hosts', 'standby.walnut', 'usage.proxy_log_dirs', 'external_session_import.excluded_cwds'], rule: 'keep', why: 'a place or a command on a named host (a host\'s definition and its shell_setup, the standby host\'s program, a host\'s log folder or folders): that host did not move' },
  { id: 'config-settings', stores: ['config-yaml', 'config-dir'], file: ['config.yaml', 'config/**'], rule: 'rewrite', why: 'a setting the leader follows on its own machine (a model, a key file, a source checkout, a folder): the same place under the new home or the new account home' },
  { id: 'config-history', stores: ['config-history'], file: 'config.yaml.history/**', rule: 'keep', why: `earlier versions of config.yaml: ${RECORD}` },

  // The applied-ops ledger: keyed by the home's path.
  {
    id: LEDGER_RULE, stores: ['cache.applied-ops'], file: 'cache/applied-ops.sqlite', at: ['applied_ops.home', 'create_remap.home'], root: 'home', rule: 'rewrite',
    why: 'the ledger is keyed by the home\'s path: without the move every op the old leader applied would apply again here',
    apply: ledgerMove,
  },
  { id: 'applied-ops-other', stores: ['cache.applied-ops'], file: 'cache/applied-ops.sqlite', rule: 'keep', why: 'another home\'s ops (a former home, another Walnut) and op outcomes: records' },

  // Tasks: work in the home moves with it; work on a machine stays there.
  { id: 'task-home-places', stores: ['tasks.db'], file: 'tasks/tasks.sqlite', at: ['tasks.payload', 'task_projects.metadata'], root: 'home', rule: 'rewrite', why: `a task or project that works in the home (Main and Ask run there, routines launch there): ${IN_HOME}` },
  { id: 'task-machine-places', stores: ['tasks.db', 'tasks'], file: 'tasks/**', rule: 'keep', why: `${HOST_PLACE}; and the task's own text` },

  // Triggers, scripts and instructions Walnut runs or hands to an agent.
  { id: 'cron-home-places', stores: ['cron-jobs'], file: 'cron-jobs.json', root: 'home', rule: 'rewrite', why: `a trigger's check script or a routine's folder in the home: ${IN_HOME}` },
  {
    id: 'runnable-home-places', stores: ['triggers', 'hooks', 'actions', 'commands', 'skills', 'claude-md', 'ask-walnut-launch', 'plugins', 'plugin-data', 'plugin-files', 'plugin-registry'],
    file: ['triggers/**', 'hooks/**', 'actions/**', 'commands/**', 'skills/**', 'CLAUDE.md', 'ask-walnut-launch.json', 'plugins/**', 'plugin-data/**', 'plugin-files/**', 'plugin-registry.json'],
    root: 'home', rule: 'rewrite', why: `a script, a plugin's data or an agent's instructions: ${IN_HOME}`,
  },
  {
    id: 'runnable-machine-places', stores: ['cron-jobs', 'triggers', 'hooks', 'actions', 'commands', 'skills', 'claude-md', 'ask-walnut-launch', 'plugins', 'plugin-data', 'plugin-files', 'plugin-registry'],
    file: ['cron-jobs.json', 'triggers/**', 'hooks/**', 'actions/**', 'commands/**', 'skills/**', 'CLAUDE.md', 'ask-walnut-launch.json', 'plugins/**', 'plugin-data/**', 'plugin-files/**', 'plugin-registry.json'],
    rule: 'keep', why: HOST_PLACE,
  },

  // Where sessions and subagents ran, and folders on hosts.
  {
    id: 'host-places', stores: ['sessions-db', 'sessions-json', 'subagent-runs', 'subagents-open', 'frequent-dirs', 'mention-dirs', 'hosts', 'workspaces', 'tmp.file-history'],
    file: ['sessions.sqlite', 'sessions.json', 'subagent-runs.json', 'subagents-open.json', 'frequent-directories.json', 'mention-directories.json', 'hosts/**', 'workspaces/**', 'tmp/file-history/**'],
    rule: 'keep', why: `${HOST_PLACE} (a session never moves with the leader: its transcript and its folder are on the machine that ran it; a sweep that removes left folders must find them where they were made)`,
  },

  // Text and logs.
  {
    id: 'records', rule: 'keep', why: RECORD,
    stores: [
      'memory', 'memory-legacy', 'artifacts', 'notes', 'global-notes-legacy', 'knowledge-legacy', 'agent-memory-legacy', 'agent-skills-legacy',
      'conversations', 'chat-history', 'session-queue', 'session-queue-spool', 'session-requests', 'session-audit', 'user-asks', 'side-questions', 'subtask-notices',
      'human-inbox', 'topics', 'topic-mail', 'org', 'org.threads-db', 'org-reflection', 'boards', 'drawings', 'notifications',
      'approvals', 'host-exec-grants', 'usage-db', 'op-calls', 'offline-conflicts', 'offline-conflicts.log', 'private-tasks',
      'time-tracking', 'time-tracking.outside', 'time-tracking.day', 'time-tracking.outside.day', 'time-tracking.outside.detail', 'time-tracking.outside.calls',
      'browser-replays', 'browser-replays.index', 'voice-archive', 'data-repo', 'repositories', 'obsidian-config',
      'cron-state', 'routine-state', 'triage-state', 'triage', 'cache.leader-op-outcomes', 'cache.suggest-accuracy', 'cache.agent-actions', 'cache.held-notices',
      'local.ai', 'local.drafts', 'local.page-visits', 'local.usage-watch', 'local.preview-storage', 'local.stt-learned',
      'config.stt-vocab', 'stt-vocab-legacy', 'tmp.stt-recordings', 'tmp.recordings', 'stt-debug-legacy', 'recordings-legacy',
    ],
    file: [
      'memory/**', 'MEMORY.md', 'artifacts/**', 'notes/**', 'global-notes.md', 'knowledge/**', 'agent-memory/**', 'agent-skills/**',
      'conversations/**', 'chat-history.json', 'chat-history-*.json', 'session-message-queue.json', 'session-message-queue.json.spool/**', 'session-requests.json', 'session-audit.jsonl',
      'user-asks/**', 'side-questions/**', 'subtask-notices-held.json', 'human-inbox/**', 'topics/**', 'topic-mail/**', 'org/**', 'org-reflection/**',
      'boards/**', 'drawings/**', 'notifications.json', 'approvals/**', 'host-exec-grants.json', 'usage.sqlite', 'op-calls/**', 'offline-conflicts/**',
      'private-tasks/**', 'time-tracking/**', 'browser/**', 'voice-archive/**', '.git/**', 'repositories/**', '.obsidian/**',
      'cron-state.json', 'routine-state/**', 'triage-state.json', 'triage/**', 'cache/leader-op-outcomes.json', 'cache/suggest-accuracy.jsonl', 'cache/agent-actions.json', 'cache/held-notices.json',
      'local/ai/**', 'local/drafts.json', 'local/page-visits.json', 'local/usage-watch.sqlite', 'local/preview-storage/**', 'local/stt-learned-corrections.json',
      'config/share/stt-vocab.txt', 'stt-vocab.txt', 'tmp/stt-recordings/**', 'tmp/recordings/**', 'stt-debug/**', 'recordings/**',
    ],
  },
]

/**
 * Leader-data stores known to hold no absolute path (the source inventory of 2026-11-22). The
 * trial's scan still reads them: a path in one fails the trial until someone decides.
 */
export const NO_PATH_STORES: Readonly<Record<string, string>> = {
  'hint-registry-since': 'a time',
  'source-task-claims': 'task ids per external item',
  'status-check-told': 'ids of mismatches told',
  quiet: 'quiet-mode holds',
  'focus-spaces': 'names and ids',
  'host-history-readers': 'host names',
  auth: 'token hashes and an instance id',
  secrets: 'credentials',
  'vault-in-home': 'the password vault',
  'vault-in-home.vault': 'the password vault',
  router: 'routing areas, ledgers and frozen content',
  'browser-control': 'pairing state',
  sync: 'sync state',
  'sync.bridge-tokens': 'tokens',
  'sync.reconcile': 'item ids',
  'sync.ms-todo-delta': 'delta links',
  'sync.ms-todo-tokens': 'tokens',
  'sync.jira': 'issue ids',
  'cache.leader-deferred-work': 'host and pid claims',
  'cache.leader-permit-number': 'a number',
  'cache.status-riding': 'status fields',
  'cache.status-reconcile': 'status fields',
  'cache.task-dir-size-notices': 'task ids and sizes',
  'cache.engine-split': 'counts',
  'cache.work-card': 'task fields',
  'cache.host-fix-failures': 'host ids and reasons',
  'cache.agent-action-salt': 'a salt',
  'local.backup': 'backup sign-in and the recovery key',
  'local.quiet-held-push': 'held pushes',
  'ui-prefs-legacy': 'display settings',
}

/** The rule table the promotion and the trial use (tests only: the ledger left as the old home wrote it). */
export function homePathRules(o: { skipLedgerRewrite?: boolean } = {}): readonly PathRule[] {
  if (!o.skipLedgerRewrite) return RULES
  return RULES.map((r) => (r.id === LEDGER_RULE ? { id: r.id, stores: r.stores, file: r.file, at: r.at, root: r.root, rule: 'keep' as const, why: 'tests only: left as the old home wrote it' } : r))
}
