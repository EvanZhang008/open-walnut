/**
 * Stores whose records merge when both sides of a pull changed them, by repo
 * path. Every other conflicted path keeps the per-file LWW (git-sync-merge.ts
 * chooseLww): one side's whole file.
 *
 * For a store of records the whole-file answer loses something that matters: a
 * leader switch can leave two machines that each wrote host-exec-grants.json,
 * and the newer file whole drops the other's revoke (2026-11-24 review). Here
 * both versions become one: every grant either side has, revoked when either
 * side revoked it (src/core/hosts/exec-grants-file.ts mergeStores).
 *
 * To add a store: its path and a function from the two texts to the merged
 * text, null when a side cannot be read (that path then falls back to LWW).
 */

import { mergeStores, storeOf, storeText } from '../core/hosts/exec-grants-file.js';
import { addTimeoutFor } from './git-sync-large-files.js';
import type { GitStatusRunner } from './git-sync-rewrite-carry.js';

type RecordMerge = (mine: string, theirs: string) => string | null;

function objectOf(text: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(text) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const RECORD_MERGES: Record<string, RecordMerge> = {
  'host-exec-grants.json': (mine, theirs) => {
    const a = objectOf(mine);
    const b = objectOf(theirs);
    if (!a || !b) return null;
    const rest = { ...a };
    // A fresh clock (storeText sets it): the merge holds both sides, the newest write of the file.
    delete rest.lastUpdated;
    return storeText({ ...rest, ...mergeStores([storeOf(a), storeOf(b)]) });
  },
};

/** Blobs larger than this are not read for a merge (LWW decides them). */
const MERGE_BLOB_MAX = 8 * 1024 * 1024;

/**
 * Both sides of a conflicted path merged record by record and written to the
 * object store, as `"<mode> <oid>"` (`mine` and `theirs` are in that form); null
 * when the path has no record merge, a side deleted it, or a side does not parse.
 */
export async function mergeRecords(
  run: GitStatusRunner, file: string, mine: string | undefined, theirs: string | undefined,
): Promise<string | null> {
  const merge = RECORD_MERGES[file];
  if (!merge || !mine || !theirs) return null;
  const [mode, mineOid] = mine.split(' ');
  const theirsOid = theirs.split(' ')[1];
  if (mode !== '100644' && mode !== '100755') return null;
  const read = async (oid: string): Promise<string | null> => {
    const size = Number((await run(['cat-file', '-s', oid])).stdout.trim());
    if (!Number.isFinite(size) || size > MERGE_BLOB_MAX) return null;
    const r = await run(['cat-file', 'blob', oid]);
    return r.code === 0 ? r.stdout : null;
  };
  const [a, b] = await Promise.all([read(mineOid), read(theirsOid)]);
  if (a === null || b === null) return null;
  const text = merge(a, b);
  if (text === null) return null;
  const written = await run(['hash-object', '-w', '--stdin'], { input: text, timeout: addTimeoutFor(Buffer.byteLength(text)) });
  if (written.code !== 0) throw new Error(`git hash-object failed (${written.code}): ${written.stderr.trim().slice(0, 300)}`);
  return `${mode} ${written.stdout.trim()}`;
}
