/**
 * Keep a sensible history and give back the space of the rest.
 *
 * Retention (selectKept, pure): the newest snapshot of each of the last
 * `daily` days that have one, the newest of each of the last `weekly` ISO
 * weeks, and always the newest of all. Then garbage collection: a pack none
 * of the kept snapshots needs is deleted, and a pack mostly dead (under half
 * its bytes still needed) is repacked: its live sealed blobs are copied into
 * a new pack as they are (no decryption needed) and the old one is deleted.
 *
 * Crash safety, in this order: new packs, then the new index, then deleting
 * old indexes, then deleting old packs. Dying at any step leaves either
 * duplicate index entries (harmless) or packs no index names, which a later
 * prune deletes once they are ORPHAN_GRACE_MS old (never the packs of a run
 * still going).
 */
import { log } from '../../../logging/index.js';
import { loadLiveIndex } from './backup-run.js';
import { packKey, PACK_TARGET_BYTES, type BlobLocation, type PackInfo, type Snapshot } from './format.js';
import { PackCache, PackWriter, type Repository } from './repository.js';

export interface RetentionPolicy {
  daily: number;
  weekly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4 };
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
  if (newestFirst.length > 0) kept.add(newestFirst[0].id);
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
}

export async function pruneRepo(
  repo: Repository,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
): Promise<PruneResult> {
  const result: PruneResult = { forgotten: [], deletedPacks: 0, repackedPacks: 0, freedBytes: 0 };
  const { snapshots } = await repo.listSnapshots();
  if (snapshots.length === 0) return result;
  const kept = selectKept(snapshots, policy);
  for (const s of snapshots) {
    if (kept.has(s.id)) continue;
    await repo.deleteSnapshot(s.id);
    result.forgotten.push(s.id);
  }

  const { index, storedPacks } = await loadLiveIndex(repo);
  const orphans = [...storedPacks.entries()].filter(
    ([id, at]) => !index.packs.has(id) && at !== undefined && now - at > ORPHAN_GRACE_MS,
  );
  if (result.forgotten.length === 0 && orphans.length === 0 && index.indexKeys.length <= MAX_INDEX_FILES) {
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

  const survivors: PackInfo[] = [];
  const doomed: PackInfo[] = [];
  const repackers = { data: new PackWriter(repo, 'data'), tree: new PackWriter(repo, 'tree') };
  for (const pack of index.packs.values()) {
    const liveBlobs = pack.blobs.filter(([id]) => live.has(id) && index.blobs.get(id)?.pack === pack.id);
    if (liveBlobs.length === 0) {
      doomed.push(pack);
      continue;
    }
    const liveBytes = liveBlobs.reduce((n, b) => n + b[2], 0);
    // A small pack is fine to keep even when mostly dead; repacking it saves little.
    if (liveBytes / pack.size >= REPACK_BELOW_LIVE_RATIO || pack.size < PACK_TARGET_BYTES / 4) {
      survivors.push(pack);
      continue;
    }
    const body = await repo.store.get(packKey(pack.id));
    for (const [id, offset, length, rawLength] of liveBlobs as BlobLocation[]) {
      await repackers[pack.type].add(id, body.subarray(offset, offset + length), rawLength);
    }
    doomed.push(pack);
    result.repackedPacks++;
  }
  const repacked = [...(await repackers.data.finish()), ...(await repackers.tree.finish())];

  // One index for what survives, then the old indexes go, then the packs.
  await repo.writeIndex([...survivors, ...repacked]);
  for (const key of index.indexKeys) await repo.store.delete(key);
  for (const pack of doomed) {
    await repo.store.delete(packKey(pack.id));
    result.deletedPacks++;
    result.freedBytes += pack.size;
  }
  for (const [id] of orphans) {
    await repo.store.delete(packKey(id));
    result.deletedPacks++;
  }
  log.session.info('backup: pruned', {
    forgotten: result.forgotten.length, deletedPacks: result.deletedPacks,
    repackedPacks: result.repackedPacks, freedBytes: result.freedBytes,
  });
  return result;
}
