/**
 * Keep a sensible history and give back the space of the rest.
 *
 * Retention (selectKept, pure): the newest `recent` snapshots, the newest of
 * each of the last `daily` days that have one, and the newest of each of the
 * last `weekly` ISO weeks. Then garbage collection: a pack none
 * of the kept snapshots needs is deleted, and a pack mostly dead (under half
 * its bytes still needed) is repacked: its live sealed blobs are copied into
 * a new pack as they are (no decryption needed) and the old one is deleted.
 *
 * Crash safety, in this order: new packs, then the new index, then deleting
 * old indexes, then deleting old packs. Dying at any step leaves either
 * duplicate index entries (harmless) or packs no index names, which a later
 * prune deletes once they are ORPHAN_GRACE_MS old (never the packs of a run
 * still going: a pack that young is never deleted or repacked at all).
 *
 * It prunes nothing when that could be wrong: a snapshot it cannot read (its
 * packs would look dead), the run's new snapshot not listed yet, or this
 * machine no longer the writer (checked again right before deleting).
 */
import { createHash } from 'node:crypto';
import { log } from '../../../logging/index.js';
import { loadLiveIndex } from './backup-run.js';
import { packKey, PACK_TARGET_BYTES, type BlobLocation, type PackInfo, type Snapshot } from './format.js';
import { PackCache, PackWriter, type Repository } from './repository.js';
import type { WriterIdentity } from '../local-state.js';

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  /** The newest few, whatever their day: a backup made right after a bad change keeps the good one of that morning. */
  recent?: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, recent: 3 };
const ORPHAN_GRACE_MS = 6 * 3_600_000;
const REPACK_BELOW_LIVE_RATIO = 0.5;
const MAX_INDEX_FILES = 8;

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** ISO 8601 week ("2026-W45"), in local time. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const weekday = t.getUTCDay() || 7; // Monday 1 .. Sunday 7
  t.setUTCDate(t.getUTCDate() + 4 - weekday); // the Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/** Ids of the snapshots the policy keeps. */
export function selectKept(snapshots: Array<Pick<Snapshot, 'id' | 'createdAt'>>, policy: RetentionPolicy): Set<string> {
  const newestFirst = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kept = new Set<string>();
  for (const s of newestFirst.slice(0, Math.max(1, policy.recent ?? 1))) kept.add(s.id);
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const s of newestFirst) {
    const d = new Date(s.createdAt);
    const dk = dayKey(d);
    if (!days.has(dk) && days.size < policy.daily) {
      days.add(dk);
      kept.add(s.id);
    }
    const wk = isoWeekKey(d);
    if (!weeks.has(wk) && weeks.size < policy.weekly) {
      weeks.add(wk);
      kept.add(s.id);
    }
  }
  return kept;
}

export interface PruneResult {
  forgotten: string[];
  deletedPacks: number;
  repackedPacks: number;
  freedBytes: number;
  /** Why nothing was pruned this time, when something made it unsafe. */
  skipped?: string;
}

export interface PruneOptions {
  now?: number;
  /** This machine: prune only while it is still the repository's writer. */
  writer?: WriterIdentity;
  /** The snapshot the run just wrote: no prune unless it is listed (and so kept). */
  mustKeep?: string;
}

export async function pruneRepo(
  repo: Repository,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const result: PruneResult = { forgotten: [], deletedPacks: 0, repackedPacks: 0, freedBytes: 0 };
  const skip = (why: string): PruneResult => {
    log.session.warn('backup: prune skipped', { why });
    return { ...result, skipped: why };
  };
  const stillWriter = async (): Promise<boolean> => {
    if (!opts.writer) return true;
    await repo.refreshConfig();
    return repo.isWriter(opts.writer);
  };

  if (!(await stillWriter())) return skip('another machine writes these backups now');
  const { snapshots, unreadable } = await repo.listSnapshots();
  // A snapshot we cannot read (a passing store error) may be one to keep: its
  // packs would look dead. Prune again next time, when it reads.
  if (unreadable.length > 0) return skip(`${unreadable.length} backup(s) could not be read`);
  if (snapshots.length === 0) return result;
  if (opts.mustKeep && !snapshots.some((s) => s.id === opts.mustKeep)) return skip('the new backup is not listed yet');
  const kept = selectKept(snapshots, policy);
  const forgotten = snapshots.filter((s) => !kept.has(s.id));

  const { index, storedPacks } = await loadLiveIndex(repo);
  const young = (id: string): boolean => {
    const at = storedPacks.get(id);
    return at !== undefined && now - at <= ORPHAN_GRACE_MS;
  };
  const orphans = [...storedPacks.keys()].filter((id) => !index.packs.has(id) && storedPacks.get(id) !== undefined && !young(id));
  const deadNowOld = [...index.packs.values()].some((p) => p.dead && !young(p.id));
  if (forgotten.length === 0 && orphans.length === 0 && !deadNowOld && index.indexKeys.length <= MAX_INDEX_FILES) {
    return result;
  }

  // Every blob a kept snapshot needs: its tree's blobs and its files' blobs.
  const cache = new PackCache(repo.store);
  const live = new Set<string>();
  for (const s of snapshots) {
    if (!kept.has(s.id)) continue;
    for (const id of s.tree) live.add(id);
    for (const e of await repo.readTree(s, index, cache)) for (const id of e.b) live.add(id);
  }

  // A kept backup names a part no index lists (a pack the store did not list
  // this time, say): deleting the old indexes now could lose it for good.
  for (const id of live) if (!index.blobs.has(id)) return skip('a kept backup names parts no index lists');

  const survivors: PackInfo[] = [];
  const doomed: PackInfo[] = [];
  const repackers = { data: new PackWriter(repo, 'data'), tree: new PackWriter(repo, 'tree') };
  for (const pack of index.packs.values()) {
    const liveBlobs = pack.blobs.filter(([id]) => live.has(id) && index.blobs.get(id)?.pack === pack.id);
    // A pack written in the last hours may belong to a run still going: keep it
    // as it is, marked when it looks dead so the next prune looks again.
    if (young(pack.id)) {
      const { dead: _dead, ...rest } = pack;
      survivors.push(liveBlobs.length === 0 ? { ...rest, dead: true } : rest);
      continue;
    }
    if (liveBlobs.length === 0) {
      doomed.push(pack);
      continue;
    }
    const liveBytes = liveBlobs.reduce((n, b) => n + b[2], 0);
    // A small pack is fine to keep even when mostly dead; repacking it saves little.
    if (liveBytes / pack.size >= REPACK_BELOW_LIVE_RATIO || pack.size < PACK_TARGET_BYTES / 4) {
      const { dead: _dead, ...rest } = pack;
      survivors.push(rest);
      continue;
    }
    const body = await repo.store.get(packKey(pack.id));
    // A damaged download must not be copied into a new pack with a valid hash.
    if (createHash('sha256').update(body).digest('hex') !== pack.id) {
      throw new Error(`pack ${pack.id.slice(0, 12)} did not match its hash; nothing was deleted`);
    }
    for (const [id, offset, length, rawLength] of liveBlobs as BlobLocation[]) {
      await repackers[pack.type].add(id, body.subarray(offset, offset + length), rawLength);
    }
    doomed.push(pack);
    result.repackedPacks++;
  }
  const repacked = [...(await repackers.data.finish()), ...(await repackers.tree.finish())];

  // Nothing a kept snapshot could read before may go missing now.
  const nextIndex = [...survivors, ...repacked];
  const resolvable = new Set<string>();
  for (const pack of nextIndex) for (const [id] of pack.blobs) resolvable.add(id);
  for (const id of live) {
    if (index.blobs.has(id) && !resolvable.has(id)) {
      throw new Error(`prune would lose blob ${id.slice(0, 12)}; nothing was deleted`);
    }
  }
  if (!(await stillWriter())) return skip('another machine writes these backups now');

  for (const s of forgotten) {
    await repo.deleteSnapshot(s.id);
    result.forgotten.push(s.id);
  }
  // One index for what survives, then the old indexes go, then the packs.
  await repo.writeIndex(nextIndex);
  for (const key of index.indexKeys) await repo.store.delete(key);
  for (const pack of doomed) {
    await repo.store.delete(packKey(pack.id));
    result.deletedPacks++;
    result.freedBytes += pack.size;
  }
  for (const id of orphans) {
    await repo.store.delete(packKey(id));
    result.deletedPacks++;
  }
  log.session.info('backup: pruned', {
    forgotten: result.forgotten.length, deletedPacks: result.deletedPacks,
    repackedPacks: result.repackedPacks, freedBytes: result.freedBytes,
  });
  return result;
}
