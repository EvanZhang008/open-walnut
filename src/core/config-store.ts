/**
 * config.yaml as a file Walnut shares with the user's editor: how it is read
 * (an editor's save in flight answers from the sidecar in memory, never on disk),
 * how a read-modify-write lands (waits for the file to settle, commits only over
 * the file it read, merges an edit that landed meanwhile, refuses a file that does
 * not parse), when a lost file is restored from the sidecar, and how the sidecar
 * follows edits made outside Walnut. The file mechanics are config-file-io.ts;
 * the config's meaning (defaults, migrations, the writers' merges) is
 * config-manager.ts, which re-exports what callers use from here.
 */
import crypto from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import yaml from 'js-yaml';
import { log } from '../logging/index.js';
import { CONFIG_FILE } from '../constants.js';
import { isHostReplicaProgram } from './server-role.js';
import { NeedsLeaderError } from './replication/needs-leader.js';
import {
  commitConfigFile,
  isSettled,
  watchReplacedFile,
  parseConfigMapping,
  readConfigSnapshot,
  sameFileId,
  waitForQuietFile,
  type ConfigFileId,
  type ConfigFileState,
  type ConfigSnapshot,
} from './config-file-io.js';

/**
 * Sidecar copy of the last successfully written config.
 *
 * config.yaml holds settings that exist NOWHERE else — the STT engine + model
 * paths, SSH hosts, provider credentials. When the file vanished (a git-sync
 * merge carried a remote deletion of a still-tracked path, 2026-07-25) every
 * reader silently fell back to DEFAULT_CONFIG and the next writer persisted
 * that skeleton, so voice input died with "No STT engine configured" and no
 * error anywhere. The sidecar makes that loss recoverable instead of terminal.
 *
 * Gitignored + untracked by git-sync's CRITICAL_IGNORES — it must never sync.
 */
const CONFIG_BACKUP_FILE = `${CONFIG_FILE}.bak`;

/**
 * How long a bad config.yaml must keep still before Walnut believes it (see
 * config-file-io.ts for the windows an editor's save opens). Tests shorten them.
 *  - readRetryMs: a reader that finds the file bad looks again for this long
 *    before it answers from the backup, so a save in flight usually reads fresh.
 *  - settleMs: a writer bases a merge only on a file this old, or one that
 *    stayed the same across this long, or Walnut's own last write.
 *  - quietMs: a missing, empty or unparseable file counts as real (restore it,
 *    or refuse to write) only after it kept still this long.
 *  - deadlineMs: a writer gives up on a file that keeps changing after this.
 *  - lateWriteWatchMs: after replacing a file that was written in the last
 *    FRESH_FILE_MS, watch the replaced file this long for an editor still writing
 *    into it (remergeLateWrite).
 */
const DEFAULT_TIMINGS = { readRetryMs: 100, settleMs: 300, quietMs: 1_500, deadlineMs: 10_000, lateWriteWatchMs: 2_000 };
const FRESH_FILE_MS = 10_000;
let timings = { ...DEFAULT_TIMINGS };

export function _setConfigTimingsForTest(t: Partial<typeof DEFAULT_TIMINGS> | null): void {
  timings = { ...DEFAULT_TIMINGS, ...(t ?? {}) };
}

/** A write refused because config.yaml does not parse: the file is the user's newest text, so it is never replaced. */
export class ConfigUnreadableError extends Error {
  /** The HTTP answer (web/middleware/error-handler.ts): the file's state, not a server fault. */
  readonly status = 409;
  constructor(detail: string) {
    super(`config.yaml cannot be read (${detail}). Walnut did not write it: fix the file, or restore it from config.yaml.bak, then try again.`);
    this.name = 'ConfigUnreadableError';
  }
}

/** A write given up because config.yaml kept changing under it. */
export class ConfigBusyError extends Error {
  readonly status = 503;
  constructor() {
    super('config.yaml kept changing while Walnut tried to write it. Nothing was written; try again.');
    this.name = 'ConfigBusyError';
  }
}

// Not unref'd: a short-lived process (the CLI) waiting here must not exit mid-await.
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

interface BackupDoc { content: string; doc: Record<string, unknown> }

/** The sidecar when it holds a YAML mapping; anything else is no backup. */
async function readBackup(): Promise<BackupDoc | null> {
  let content: string;
  try { content = await fs.readFile(CONFIG_BACKUP_FILE, 'utf-8'); } catch { return null; }
  if (!content.trim()) return null;
  const { doc } = parseConfigMapping(content);
  return doc ? { content, doc } : null;
}

const badKey = (snap: ConfigSnapshot): string =>
  `${snap.state}:${snap.id ? `${snap.id.dev}:${snap.id.ino}:${snap.id.size}:${snap.id.mtimeMs}` : ''}`;

/** Log a bad primary once per state of the file, not on every read. */
let lastBadPrimary = '';
function noteBadPrimary(snap: ConfigSnapshot, usedBackup: boolean): void {
  const key = `${badKey(snap)}:${usedBackup}`;
  if (key === lastBadPrimary) return;
  lastBadPrimary = key;
  const detail = { state: snap.state, error: snap.error, backup: CONFIG_BACKUP_FILE };
  if (usedBackup) log.session.warn('config-manager: config.yaml is not readable as a config right now; answering from config.yaml.bak in memory (the file is not touched until it stays this way)', detail);
  else log.session.error('config-manager: config.yaml is not readable as a config and there is no usable backup', detail);
}

let lastRetriedBad = '';

export type ReadResult =
  | { source: 'primary'; doc: Record<string, unknown> }
  | { source: 'backup'; doc: Record<string, unknown>; state: ConfigFileState }
  | { source: 'none' }
  | { source: 'broken'; state: ConfigFileState; error?: string };

/**
 * config.yaml as a mapping for a reader. A bad file (missing, empty, a prefix
 * that does not parse) is looked at again for a moment, then answered from the
 * backup IN MEMORY. A reader never writes the file: a missing or empty file is
 * handed to the restore, which waits until it has kept still (repairWhenQuiet).
 * 'none' is a genuine first run: no file and no backup.
 */
export async function readConfigDoc(): Promise<ReadResult> {
  let snap = await readConfigSnapshot(CONFIG_FILE);
  if (snap.state === 'ok') return { source: 'primary', doc: snap.doc! };
  let backup = await readBackup();
  if (snap.state === 'missing' && !backup) return { source: 'none' };
  // A bad file already looked at again (the same file, unchanged: a typo the user
  // left) answers at once; only a new bad state is worth the short wait.
  const seenBefore = snap.id !== null && badKey(snap) === lastRetriedBad;
  const until = Date.now() + (seenBefore ? 0 : timings.readRetryMs);
  while (snap.state !== 'ok' && Date.now() < until) {
    await sleep(Math.min(25, timings.readRetryMs));
    snap = await readConfigSnapshot(CONFIG_FILE);
  }
  if (snap.state === 'ok') return { source: 'primary', doc: snap.doc! };
  lastRetriedBad = badKey(snap);
  backup = await readBackup();
  noteBadPrimary(snap, !!backup);
  // Only a backup can restore anything; without one the restore would hold the
  // write lock through its quiet wait for nothing.
  if (backup && (snap.state === 'missing' || snap.state === 'empty')) repairWhenQuiet(badKey(snap));
  if (backup) return { source: 'backup', doc: backup.doc, state: snap.state };
  if (snap.state === 'missing') return { source: 'none' };
  return { source: 'broken', state: snap.state, error: snap.error };
}

/** The unparseable file a write was last refused for. */
let refusedId: ConfigFileId | null = null;

interface WriteBase {
  doc: Record<string, unknown>;
  /** What the commit must still find: null = the file must still be missing. */
  expected: ConfigFileId | null;
  /** The file stayed missing or empty and the backup filled in: the commit restores it. */
  recovered: BackupDoc | null;
  /** The base is Walnut's own last write (no editor is in the middle of it). */
  own?: boolean;
}

/**
 * The config a read-modify-write may build on. A file still being written is
 * waited for; a missing or empty one that keeps still is restored from the
 * backup; one that keeps failing to parse is refused (ConfigUnreadableError).
 */
async function writeBase(deadline: number): Promise<WriteBase> {
  for (;;) {
    if (Date.now() >= deadline) throw new ConfigBusyError();
    const snap = await readConfigSnapshot(CONFIG_FILE);
    if (snap.changing) { await sleep(25); continue; }
    if (snap.state === 'ok') {
      const own = isOwnConfigWrite(configContentHash(snap.content!));
      if (own || await isSettled(CONFIG_FILE, snap.id!, timings.settleMs)) {
        return { doc: snap.doc!, expected: snap.id, recovered: null, own };
      }
      continue; // still being written: read it again
    }
    // The same unparseable file a write was already refused for: refuse at once
    // (boot runs three writers in a row; each would wait the quiet period again).
    if ((snap.state === 'unparseable' || snap.state === 'unreadable') && snap.id && sameFileId(snap.id, refusedId)) {
      throw new ConfigUnreadableError(snap.error ?? snap.state);
    }
    // A first run (no file, no backup) has nothing to protect: the create is exclusive.
    if (snap.state === 'missing' && !await readBackup()) return { doc: {}, expected: null, recovered: null };
    const quiet = await waitForQuietFile(CONFIG_FILE, { quietMs: timings.quietMs, deadline, from: snap.id });
    if (!quiet) throw new ConfigBusyError();
    if ('changed' in quiet) continue; // being written: read it again
    const again = await readConfigSnapshot(CONFIG_FILE);
    if (again.state === 'ok' || again.changing || !sameFileId(again.id, quiet.id, { ctime: false })) continue;
    if (again.state === 'missing' || again.state === 'empty') {
      // Read after the wait: another process may have refreshed it meanwhile.
      const backup = await readBackup();
      if (backup) log.session.error(`config-manager: config.yaml stayed ${again.state}: restoring it from config.yaml.bak`, { backup: CONFIG_BACKUP_FILE });
      else log.session.error(`config-manager: config.yaml stayed ${again.state} and there is no usable backup`, { backup: CONFIG_BACKUP_FILE });
      return { doc: backup ? structuredClone(backup.doc) : {}, expected: again.id, recovered: backup };
    }
    refusedId = again.id;
    log.session.error('config-manager: config.yaml does not parse; refusing to write it', { state: again.state, error: again.error });
    throw new ConfigUnreadableError(again.error ?? again.state);
  }
}

/** yaml.dump plus the comment above available_models (js-yaml drops comments). */
export function dumpConfig(doc: Record<string, unknown>): string {
  return yaml.dump(doc, { indent: 2, lineWidth: 120 }).replace(
    /^(\s+)available_models:/m,
    '$1# Available models for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
  );
}

let beforeCommitForTest: (() => Promise<void>) | null = null;
/** Runs between a writer's read and its commit (to change the file there). */
export function _setBeforeConfigCommitForTest(fn: (() => Promise<void>) | null): void { beforeCommitForTest = fn; }

/**
 * Read-modify-write config.yaml under the write lock. `mutate` gets a copy of the
 * stored mapping and returns `write: false` to change nothing. A commit that finds
 * the file changed since the read (an editor saved meanwhile) reads again and
 * re-applies `mutate` to the new content, so the edit is merged, never replaced:
 * `mutate` may run more than once, so whatever it counts starts from zero inside it.
 * A file restored from the backup is written even when `mutate` changes nothing.
 * `abandon` is asked before the commit (a restore whose moment has passed).
 */
export async function modifyConfigDoc<T>(
  mutate: (doc: Record<string, unknown>) => Promise<{ write: boolean; result: T }> | { write: boolean; result: T },
  abandon?: () => boolean,
): Promise<T> {
  return withWriteLock(async () => {
    const deadline = Date.now() + timings.deadlineMs;
    for (;;) {
      const base = await writeBase(deadline);
      const { write, result } = await mutate(base.doc);
      if (!write && !base.recovered) return result;
      if (abandon?.()) return result;
      const content = write ? dumpConfig(base.doc) : base.recovered!.content;
      if (beforeCommitForTest) await beforeCommitForTest();
      // A file written moments ago by someone else may still have its writer
      // inside it: keep the replaced file in view (remergeLateWrite).
      const fresh = base.expected !== null && !base.own
        && Date.now() - Math.max(base.expected.mtimeMs, base.expected.ctimeMs) < FRESH_FILE_MS;
      const { outcome, replaced } = await writeConfigWithBackup(content, base.expected, { holdReplaced: fresh });
      if (outcome === 'written') {
        if (replaced) remergeLateWrite(replaced, base.expected!, content, mutate);
        return result;
      }
      log.session.info('config-manager: config.yaml changed while Walnut was writing it; reading it again so the edit is kept');
    }
  });
}

/** Restores and late-write merges still running (tests wait for them). */
const backgroundWork = new Set<Promise<void>>();
function inBackground(work: Promise<void>): void {
  backgroundWork.add(work);
  void work.finally(() => backgroundWork.delete(work));
}

/**
 * An in-place save that paused longer than the settle window, read as finished,
 * and then went on writing: the commit renamed a new file over it, so the rest of
 * the save went into the replaced file, which only `fh` can still read. Watch it
 * for a moment; when it was written to, apply the same change to that save and
 * commit it, as long as config.yaml is still exactly what Walnut wrote. When it is
 * not (or the late save does not parse), nothing is guessed: the save is kept
 * beside the file as config.yaml.late-<time> and logged.
 */
function remergeLateWrite(
  fh: FileHandle,
  replacedId: ConfigFileId,
  committed: string,
  mutate: (doc: Record<string, unknown>) => Promise<{ write: boolean }> | { write: boolean },
): void {
  const generation = repairGeneration;
  const cancelled = () => generation !== repairGeneration;
  inBackground((async () => {
    try {
      const late = await watchReplacedFile(fh, replacedId, {
        watchMs: timings.lateWriteWatchMs, settleMs: timings.settleMs, isCancelled: cancelled,
      });
      if (late === null || cancelled() || !late.trim()) return;
      const { doc } = parseConfigMapping(late);
      log.session.error('config-manager: config.yaml was still being written when Walnut replaced it; merging that save back', { bytes: late.length, parses: !!doc });
      if (!doc) { await keepLateWrite(late); return; }
      // A late save without a section Walnut's commit has may itself be cut off:
      // it goes beside the file, never over it (and never into the backup).
      const committedDoc = parseConfigMapping(committed).doc ?? {};
      if (Object.keys(committedDoc).some((k) => !(k in doc))) { await keepLateWrite(late); return; }
      await withWriteLock(async () => {
        if (cancelled()) return;
        const snap = await readConfigSnapshot(CONFIG_FILE);
        if (snap.state !== 'ok' || snap.changing || snap.content !== committed) { await keepLateWrite(late); return; }
        const { write } = await mutate(doc);
        const { outcome } = await writeConfigWithBackup(write ? dumpConfig(doc) : late, snap.id);
        if (outcome === 'conflict') await keepLateWrite(late);
      });
    } catch (err) {
      log.session.warn('config-manager: could not check config.yaml for a late write', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      await fh.close().catch(() => {});
    }
  })());
}

/** A late save Walnut could not merge safely: kept, never dropped. */
async function keepLateWrite(content: string): Promise<void> {
  if (isHostReplicaProgram()) return;
  const file = `${CONFIG_FILE}.late-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await writeFileAtomic(file, content);
  log.session.error('config-manager: a save of config.yaml that could not be merged was kept beside it', { file });
}

/**
 * The restore a reader asks for when it found config.yaml missing or empty: one
 * at a time, through the writers' path, so it happens only after the file kept
 * still and only if it is still the file that was found.
 */
let repairing: Promise<void> | null = null;
let repairGeneration = 0;
/** A restore that failed (a read-only folder, a full disk) is not retried for the same state of the file for a minute. */
let lastFailedRepair = { key: '', at: 0 };
const REPAIR_BACKOFF_MS = 60_000;
function repairWhenQuiet(key: string): void {
  if (repairing || isHostReplicaProgram()) return;
  if (lastFailedRepair.key === key && Date.now() - lastFailedRepair.at < REPAIR_BACKOFF_MS) return;
  const generation = repairGeneration;
  repairing = modifyConfigDoc(() => ({ write: false, result: undefined }), () => generation !== repairGeneration)
    .catch((err) => {
      lastFailedRepair = { key, at: Date.now() };
      log.session.warn('config-manager: config.yaml restore skipped', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => { repairing = null; });
  inBackground(repairing);
}

/** Settles when the restores and late-write merges running now (and any they start) are over. */
export async function _configRepairIdleForTest(): Promise<void> {
  while (backgroundWork.size > 0) await Promise.allSettled([...backgroundWork]);
}

/**
 * Replace a file's whole content atomically: write a sibling temp, then rename.
 *
 * `fs.writeFile` truncates first and writes after, so a concurrent reader can
 * observe a HALF file — and half a config.yaml is worse than none, because it
 * still parses. The `agent:` section sits near the top of a ~280-line file, so a
 * reader landing in that window got valid YAML with the whole section missing and
 * silently ran on defaults, with no unreadable-config error logged because nothing
 * ever threw (observed 2026-08-28 06:03, where the missing section sent one turn
 * to a provider whose credentials this box does not keep).
 *
 * Temp lives in the SAME directory so the rename is a same-filesystem atomic
 * swap (an EXDEV across /tmp would fall back to copy, reopening the window).
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Called after every write of config.yaml (the config and prefs copy kinds start a round). */
const configWriteListeners = new Set<() => void>();

export function onConfigWritten(cb: () => void): () => void {
  configWriteListeners.add(cb);
  return () => { configWriteListeners.delete(cb); };
}

/** Tell the listeners config.yaml changed: after this server's writes, and after an edit made outside it (config-file-watch.ts). */
export function announceConfigWritten(): void {
  for (const cb of configWriteListeners) { try { cb(); } catch { /* a listener never fails a write */ } }
}

/** The hash of the config.yaml content this server wrote last, so the file watch skips its own writes. */
let ownWriteHash: string | null = null;

export function configContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function isOwnConfigWrite(hash: string): boolean {
  return hash === ownWriteHash;
}

/**
 * Commit config.yaml (only over the file `expected` names, see commitConfigFile;
 * `undefined` replaces whatever is there) and mirror it to the sidecar. The
 * sidecar write never throws.
 */
export async function writeConfigWithBackup(
  content: string,
  expected?: ConfigFileId | null,
  opts: { holdReplaced?: boolean } = {},
): Promise<{ outcome: 'written' | 'conflict'; replaced?: FileHandle }> {
  refuseConfigWriteOnReplica();
  const prevHash = ownWriteHash;
  ownWriteHash = configContentHash(content);
  let replaced: FileHandle | undefined;
  if (expected === undefined) await writeFileAtomic(CONFIG_FILE, content);
  else {
    const commit = await commitConfigFile(CONFIG_FILE, content, expected, opts);
    if (commit.outcome === 'conflict') {
      ownWriteHash = prevHash;
      return { outcome: 'conflict' };
    }
    replaced = commit.replaced;
  }
  announceConfigWritten();
  try {
    await writeFileAtomic(CONFIG_BACKUP_FILE, content);
  } catch (err) {
    log.session.warn('config-manager: failed to update config backup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { outcome: 'written', replaced };
}

/**
 * Bring the sidecar up to an edit made outside Walnut, so a later restore gives
 * back that edit and not the older content Walnut wrote last. Only a file that
 * parses as a mapping and has finished being written (and, with `expectedHash`,
 * is still the content the caller saw) is copied; never on a host replica.
 */
export async function refreshConfigBackup(expectedHash?: string): Promise<boolean> {
  if (isHostReplicaProgram()) return false;
  return withWriteLock(async () => {
    const snap = await readConfigSnapshot(CONFIG_FILE);
    if (snap.state !== 'ok' || snap.changing) return false;
    const hash = configContentHash(snap.content!);
    if (expectedHash && hash !== expectedHash) return false;
    if (!isOwnConfigWrite(hash) && !await isSettled(CONFIG_FILE, snap.id!, timings.settleMs)) return false;
    const backup = await fs.readFile(CONFIG_BACKUP_FILE, 'utf-8').catch(() => null);
    if (backup === snap.content) return false;
    // The backup is the copy a lost file comes back from. An edit that drops a
    // whole top-level section the backup has may be a cut-off file that happens to
    // parse, so it does not replace that copy; Walnut's next write mirrors the
    // file anyway, and the user's own edit stays in config.yaml either way.
    const prev = backup === null ? null : parseConfigMapping(backup).doc;
    const dropped = prev ? Object.keys(prev).filter((k) => !(k in snap.doc!)) : [];
    if (dropped.length > 0) {
      log.session.info('config.yaml changed outside Walnut without some sections the backup has: the backup keeps them', { dropped });
      return false;
    }
    await writeFileAtomic(CONFIG_BACKUP_FILE, snap.content!);
    return true;
  });
}


// ── Write lock: serializes config read-modify-write operations ──
let writeLock: Promise<void> = Promise.resolve();

/** Reset write lock for testing. Prevents cross-test lock chain stalls. */
export function _resetWriteLockForTest(): void {
  writeLock = Promise.resolve();
  // A restore a previous test started must not commit into the next test's home.
  repairGeneration++;
  repairing = null;
  lastFailedRepair = { key: '', at: 0 };
  refusedId = null;
}

/**
 * A host replica holds a COPY of the Mac's config (core/replication/kinds/config.ts):
 * every config write there waits for the Mac (503 needs_leader), and nothing writes
 * the replica's own config.yaml either.
 */
function refuseConfigWriteOnReplica(): void {
  if (isHostReplicaProgram()) throw new NeedsLeaderError('config_writes_need_mac');
}

export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  refuseConfigWriteOnReplica();
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}
