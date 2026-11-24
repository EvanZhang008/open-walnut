/**
 * What a batch does with each kind of leader data that changes while the batch reads the home
 * (docs/reference/standby-copy.md, "Changes while a batch reads"). A batch is the home as of one
 * moment; a first batch of a large home reads for minutes while the leader keeps writing, so
 * every kind needs an answer to "this changed after the moment, or while it was read":
 *
 *   snapshot             a SQLite database: pinned at the moment in a read transaction
 *                        (sqlite-pin.ts); commits after the moment never reach the copy.
 *   prefix               a file that only grows (the manifest's appendOnly): its first bytes up to
 *                        its size at the moment, while it only grew (append-only.ts).
 *   content-addressed    a git object or pack: its name is the hash of its content and git writes
 *                        it once (a temp file renamed into place), so a change of its times only
 *                        (git freshens an object it writes again) is no change, and a whole copy of
 *                        that name read at any time is its content at the moment.
 *   not-copied           a git command's own scratch (a lock, a temp object or pack, an incoming
 *                        quarantine): there only while the command runs. The command of the moment
 *                        does not run on the standby, so its lock would block git there and its
 *                        temp files are garbage git removes itself.
 *   quiet-through-moment any other file: a copy counts when the file's stat stayed the same from
 *                        before it was read (its ctime older than a filesystem clock read before
 *                        the read) until after the moment; a file that changed after its copy is
 *                        read again after the moment, and one that also changed after the moment
 *                        waits for the batch's next round (batch-round.ts).
 *
 * Every leader-data entry of the manifest has its answer here (manifestEntryRules), and
 * tests/core/standby/change-rules.test.ts fails for an entry or a dir that has none.
 */
import type { DataKind, HomeEntry } from '../home-manifest/types.js'

export type ChangeRule = 'snapshot' | 'prefix' | 'content-addressed' | 'not-copied' | 'quiet-through-moment'

export const CHANGE_RULES: Readonly<Record<ChangeRule, string>> = {
  snapshot: 'pinned at the moment in a read transaction; later commits never reach the copy',
  prefix: 'its bytes up to its size at the moment, while it only grew',
  'content-addressed': 'named by the hash of its content and written once: a whole copy of that name is its content, whatever its times say',
  'not-copied': 'a git command\'s scratch, there only while the command runs: never copied',
  'quiet-through-moment': 'a copy counts while the file\'s stat held from before its read until after the moment; else it is read again, in a later round if need be',
}

/** git's object store: loose objects (sha1 or sha256) and the files of a pack. */
const CONTENT_ADDRESSED = [
  /^\.git\/objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/,
  /^\.git\/objects\/pack\/pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.(?:pack|idx|rev|bitmap|mtimes)$/,
]

/**
 * A git command's scratch files: locks anywhere in the repo (a copied index.lock would stop
 * every git command on the standby), temp objects, packs and commit graphs, and the running
 * gc's pid file (a copied one holds the standby's gc off for 12 hours).
 */
const NOT_COPIED_FILE = [
  /^\.git\/(?:.*\/)?[^/]+\.lock$/,
  /^\.git\/objects\/(?:[0-9a-f]{2}|pack|info\/commit-graphs)\/tmp_[^/]*$/,
  /^\.git\/objects\/pack\/\.tmp-[^/]*$/,
  /^\.git\/gc\.pid$/,
]
/** A quarantine dir a git receive writes objects into before it moves them (git's incoming-*). */
const NOT_COPIED_DIR = /^\.git\/objects\/(?:incoming-|tmp_objdir-)[^/]*$/

export function isContentAddressed(rel: string): boolean {
  return CONTENT_ADDRESSED.some((re) => re.test(rel))
}

/** A path the batch never copies: a git command's scratch (`not-copied`). */
export function isNotCopiedPath(rel: string): boolean {
  return NOT_COPIED_FILE.some((re) => re.test(rel))
}

/** A dir the scan never enters: everything in it is a git command's scratch. */
export function isNotCopiedDir(rel: string): boolean {
  return NOT_COPIED_DIR.test(rel)
}

/**
 * A dir of git's object store, whose names are content-addressed objects and packs, scratch, or
 * the next dir down. Its names at the moment need not be known exactly: an object or pack that
 * came after the moment is one more object git ignores until a ref names it, and one that went
 * after it is still found where git moved it (git deletes an object file only once its content
 * is in a pack, or once it is unreachable and older than the prune age: an hour in
 * git-maintenance.ts). So the batch takes every object name it sees there now, whether or not it
 * existed at the moment, and one it saw that may have existed then and went with no copy fails
 * the round (batch-place.ts). Two checks close what that leaves: a pack that comes or goes while
 * a round reads the store fails it (the pack an object went into might be missing from the
 * walk), and so does a ref of the batch naming an object the batch lacks (git-tips.ts).
 */
export function isObjectStoreDir(rel: string): boolean {
  return /^\.git\/objects(?:\/(?:[0-9a-f]{2}|pack))?$/.test(rel)
}

/** The rule a batch applies to one plain file it found (`db`: a SQLite database by name and header). */
export function changeRuleOf(rel: string, o: { db: boolean; appendOnly: boolean }): ChangeRule {
  if (isNotCopiedPath(rel)) return 'not-copied'
  if (o.db) return 'snapshot'
  if (o.appendOnly) return 'prefix'
  if (isContentAddressed(rel)) return 'content-addressed'
  return 'quiet-through-moment'
}

/**
 * Every leader-data dir of the manifest, with what the files in it are, read from their writers.
 * `whole`: files Walnut, a session or the person write whole, edit or replace (the default rule;
 * a SQLite database or an append-only log inside has an entry of its own). `git`: the data repo.
 * A new dir entry needs a line here (the test names it).
 */
export const LEADER_DIRS: Readonly<Record<string, 'whole' | 'git'>> = {
  tasks: 'whole', 'session-queue-spool': 'whole', 'user-asks': 'whole', 'side-questions': 'whole',
  'private-tasks': 'whole', 'op-calls': 'whole', 'offline-conflicts': 'whole', org: 'whole',
  'org-reflection': 'whole', 'human-inbox': 'whole', boards: 'whole', topics: 'whole',
  'topic-mail': 'whole', drawings: 'whole', memory: 'whole', artifacts: 'whole', notes: 'whole',
  'knowledge-legacy': 'whole', 'agent-memory-legacy': 'whole', 'agent-skills-legacy': 'whole',
  skills: 'whole', commands: 'whole', actions: 'whole', repositories: 'whole',
  'obsidian-config': 'whole', 'voice-archive': 'whole', conversations: 'whole',
  'routine-state': 'whole', triggers: 'whole', hooks: 'whole', 'config-history': 'whole',
  'config-dir': 'whole', secrets: 'whole', 'vault-in-home': 'whole', router: 'whole',
  approvals: 'whole', workspaces: 'whole', sync: 'whole', triage: 'whole', plugins: 'whole',
  'plugin-data': 'whole', 'plugin-files': 'whole', hosts: 'whole', 'time-tracking': 'whole',
  'browser-replays': 'whole', 'data-repo': 'git', 'stt-debug-legacy': 'whole',
  'recordings-legacy': 'whole', 'local.backup': 'whole', 'local.ai': 'whole',
  'local.preview-storage': 'whole', 'tmp.file-history': 'whole', 'tmp.stt-recordings': 'whole',
  'tmp.recordings': 'whole', 'time-tracking.outside': 'whole',
}

/** The rules that apply to the files of one leader-data entry; null for a dir no line above names. */
export function manifestEntryRules(entry: HomeEntry): ChangeRule[] | null {
  const kind: DataKind = entry.kind
  switch (kind) {
    case 'sqlite': return ['snapshot']
    case 'file': return [entry.appendOnly ? 'prefix' : 'quiet-through-moment']
    case 'dir': {
      const writes = LEADER_DIRS[entry.id]
      if (!writes) return null
      return writes === 'git' ? ['content-addressed', 'not-copied', 'quiet-through-moment'] : ['quiet-through-moment']
    }
    default: {
      const unknown: never = kind
      throw new Error(`no standby rule for a manifest entry of kind ${String(unknown)}`)
    }
  }
}
