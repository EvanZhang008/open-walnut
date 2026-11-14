/**
 * Dated copies of config.yaml, so one bad write always leaves an older good copy.
 *
 * config.yaml.bak follows every write, so it is only ever as good as the last one:
 * on 2026-11-14 a single write dropped most of the `session` section, and the same
 * write copied the cut-down file over the sidecar. This history keeps the last
 * CONFIG_HISTORY_RETENTION.recent distinct versions plus the oldest and the newest
 * of each of the last `daily` UTC days that have one (src/lib/retention.ts), in
 * `config.yaml.history/` beside config.yaml. The oldest of a day is the version that
 * day started from, so a bad write followed by many more the same day still leaves
 * the good one.
 *
 * Why there: config.yaml holds secrets and machine-local settings, so its copies
 * must never sync. The data repo's .gitignore already has the root-anchored
 * `/config.yaml.*` (git-sync.ts EXTRA_IGNORE_PATTERNS, appended to an older
 * install's .gitignore on every sync tick), which matches this directory too, so
 * no new ignore rule has to reach an older machine first. An older Walnut never
 * looks inside it.
 *
 * File names sort by time and carry the content's hash:
 * `config-20261114T101112.123Z-<12 hex>.yaml`. A copy is saved only when its hash
 * differs from the newest copy's, and a new copy is always dated after the newest
 * one, so two copies never share a name. The prune deletes only names this module
 * makes (anything else in the folder is left alone) and never the newest copy; it
 * also removes a copy's write temp (`<name>.tmp-<pid>-<t>`, left by a crash between
 * the write and the rename, holding the same keys) once it is an hour old.
 * Nothing here ever fails a config write: errors are logged. A host replica writes
 * no config.yaml (config-store.ts), so it keeps no history either.
 *
 * Restoring is by hand for now: copy a file from the folder over config.yaml.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import { selectKept, type RetentionPolicy } from '../lib/retention.js';
import { CONFIG_FILE_MODE, writeFileAtomic } from './config-file-io.js';
import { isHostReplicaProgram } from './server-role.js';
import { CONFIG_HISTORY_DIR_NAME } from './config-history-name.js';

/** The folder's name beside config.yaml (ephemeral-snapshot.ts and backup/scan.ts leave it out). */
export { CONFIG_HISTORY_DIR_NAME };
const DIR_MODE = 0o700;

/** The last 10 distinct versions, plus the oldest and the newest of each of the last 7 UTC days with one. */
export const CONFIG_HISTORY_RETENTION: RetentionPolicy = { recent: 10, daily: 7, weekly: 0, utc: true, oldestOfDay: true };

const NAME_RE = /^config-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z-([0-9a-f]{12})\.yaml$/;
/** writeFileAtomic's temp for a copy (config-file-io.ts): `<copy name>.tmp-<pid>-<base36 ms>`. */
const TEMP_RE = /^(.+)\.tmp-\d+-[0-9a-z]+$/;
/** A temp this old belongs to no write still in flight. */
const STALE_TEMP_MS = 3_600_000;

export function configHistoryDir(): string {
  return path.join(path.dirname(CONFIG_FILE), CONFIG_HISTORY_DIR_NAME);
}

let clock: () => number = () => Date.now();
/** Date the copies from a fixed clock (retention tests). */
export function _setConfigHistoryClockForTest(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

const contentHash = (content: string): string =>
  crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);

export function configHistoryFileName(at: number, hash: string): string {
  return `config-${new Date(at).toISOString().replace(/[-:]/g, '')}-${hash}.yaml`;
}

export interface ConfigHistoryEntry { name: string; at: number; hash: string }

/** A name this module made, or null for anything else in the folder. */
export function parseConfigHistoryName(name: string): ConfigHistoryEntry | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  if (!Number.isFinite(at) || configHistoryFileName(at, m[8]!) !== name) return null;
  return { name, at, hash: m[8]! };
}

/** The folder's names; a missing folder has none, any other error throws. */
async function readNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** The copies, oldest first. A missing folder is an empty history; any other error throws. */
export async function listConfigHistory(dir = configHistoryDir()): Promise<ConfigHistoryEntry[]> {
  return (await readNames(dir))
    .map(parseConfigHistoryName)
    .filter((e): e is ConfigHistoryEntry => e !== null)
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/** The names the retention rule deletes (pure). The newest copy is always kept. */
export function configHistoryToDelete(entries: ReadonlyArray<ConfigHistoryEntry>, policy = CONFIG_HISTORY_RETENTION): string[] {
  const kept = selectKept(entries.map((e) => ({ id: e.name, createdAt: new Date(e.at).toISOString() })), policy);
  return entries.filter((e) => !kept.has(e.name)).map((e) => e.name);
}

export interface ConfigHistorySeed { content: string; mtimeMs: number }

/**
 * What `file` holds now, when the history has no copy yet: read BEFORE a write
 * replaces it, so the first write after an upgrade still leaves the version it
 * replaced behind. Null when the history already has copies, or on any error.
 */
export async function configHistorySeed(file: string): Promise<ConfigHistorySeed | null> {
  if (isHostReplicaProgram()) return null;
  try {
    if ((await listConfigHistory()).length > 0) return null;
    const [content, st] = await Promise.all([fs.readFile(file, 'utf-8'), fs.stat(file)]);
    return content.trim() ? { content, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Save `content` as the newest copy unless the newest copy already holds it (and
 * first `seed`, when the history is empty). Returns whether anything was saved.
 * Never throws: a failure is logged and the config write it follows stands.
 */
export async function recordConfigVersion(content: string, seed: ConfigHistorySeed | null = null): Promise<boolean> {
  if (isHostReplicaProgram()) return false;
  const dir = configHistoryDir();
  try {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(dir, DIR_MODE);
    const entries = await listConfigHistory(dir);
    let newest = entries.at(-1) ?? null;
    const now = clock();
    let saved = false;
    if (!newest && seed && contentHash(seed.content) !== contentHash(content)) {
      newest = await saveCopy(dir, seed.content, Math.min(Math.floor(seed.mtimeMs), now - 1));
      saved = true;
    }
    const hash = contentHash(content);
    if (newest?.hash === hash) return saved;
    // Always after the newest copy: names sort by time and never collide.
    await saveCopy(dir, content, Math.max(now, newest ? newest.at + 1 : now), hash);
    // A config that flips between a few states (2026-11-14: a host's address list rewritten every
    // few minutes) would fill the newest copies with repeats and push the last really different
    // version out. A state already among the newest copies moves to the front instead: its older
    // copy goes, so the count stays and the newest copies are distinct versions.
    const repeats = entries.slice(-(CONFIG_HISTORY_RETENTION.recent ?? 0)).filter((e) => e.hash === hash);
    for (const e of repeats) await fs.rm(path.join(dir, e.name), { force: true });
    return true;
  } catch (err) {
    log.session.warn('config-manager: could not save a dated copy of config.yaml', {
      dir, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function saveCopy(dir: string, content: string, at: number, hash = contentHash(content)): Promise<ConfigHistoryEntry> {
  if (isHostReplicaProgram()) throw new Error('a host replica keeps no config history');
  const name = configHistoryFileName(at, hash);
  await writeFileAtomic(path.join(dir, name), content, CONFIG_FILE_MODE);
  return { name, at, hash };
}

/** One prune at a time; a prune asked for while one runs runs after it. */
let pruneChain: Promise<void> = Promise.resolve();

/** A copy's write temp, by name (its base is a name this module makes). */
export function isConfigHistoryTemp(name: string): boolean {
  const m = TEMP_RE.exec(name);
  return !!m && parseConfigHistoryName(m[1]!) !== null;
}

/** Delete the copies the retention rule no longer keeps, and stale write temps. Never throws. */
export function pruneConfigHistory(): Promise<void> {
  pruneChain = pruneChain.then(async () => {
    const dir = configHistoryDir();
    try {
      const names = await readNames(dir);
      const entries = names.map(parseConfigHistoryName).filter((e): e is ConfigHistoryEntry => e !== null);
      for (const name of configHistoryToDelete(entries)) await fs.rm(path.join(dir, name), { force: true });
      for (const name of names.filter(isConfigHistoryTemp)) {
        const st = await fs.stat(path.join(dir, name)).catch(() => null);
        if (st?.isFile() && Date.now() - st.mtimeMs > STALE_TEMP_MS) await fs.rm(path.join(dir, name), { force: true });
      }
    } catch (err) {
      log.session.warn('config-manager: could not prune the dated copies of config.yaml', {
        dir, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return pruneChain;
}

/** Where a person restores config.yaml from, for error text. */
export const CONFIG_RESTORE_HINT = `config.yaml.bak or a dated copy in ${CONFIG_HISTORY_DIR_NAME}/`;
