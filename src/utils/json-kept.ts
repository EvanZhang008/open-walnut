/**
 * readJsonFile for a reader that only looks: the parsed file is kept while the file on disk is
 * unchanged (its inode, size, mtime and ctime), and every caller gets the same deep-frozen value.
 *
 * Why (2026-11-21): the live server read session-requests.json (0.6 MB) about 1,000 times in 10
 * minutes, 600 MB of JSON text turned into objects that were garbage a moment later, for a file
 * that changed a dozen times. A stat is a few microseconds; the parse is milliseconds and
 * megabytes. Frozen, because a caller that changed a shared value would change it for every
 * other reader and never for the file: such a caller throws (strict mode) instead.
 *
 * Writers need nothing: any write changes the stamp (an atomic write's rename, a new inode), so
 * the next read parses the new text. A writer in this process may call forgetKeptJson to drop
 * the old value early.
 */
import fs from 'node:fs/promises';
import { readJsonFile } from './fs.js';
import { registerMemoryHolder } from '../core/observability/memory-ledger.js';

interface Kept { stamp: string; value: unknown; chars: number }
const kept = new Map<string, Kept>();

/**
 * A file changed this recently may change again within the same clock tick of the file system
 * (a few ms on Linux) with the same size and inode, an in-place rewrite the stamp cannot tell
 * apart: such a file is read, never kept (git's rule for a racy index entry).
 */
const RACY_MS = 100;

async function stampOf(filePath: string): Promise<string | null> {
  try {
    const s = await fs.stat(filePath);
    if (Date.now() - Math.max(s.mtimeMs, s.ctimeMs) < RACY_MS) return null;
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    return null; // cannot tell: read it
  }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/**
 * The file's parsed JSON (or `fallback` when it is missing), shared and frozen. Same errors as
 * readJsonFile: a corrupt file throws and is never kept. Every caller of one file passes the same
 * fallback: a missing file keeps the first one.
 */
export async function readJsonFileKept<T>(filePath: string, fallback: T, options: { readErrors?: 'fallback' | 'throw' } = {}): Promise<Readonly<T>> {
  const stamp = await stampOf(filePath);
  const hit = kept.get(filePath);
  if (hit && stamp !== null && hit.stamp === stamp) return hit.value as T;
  let read: T;
  try {
    // Throw on a failed read whatever the caller asked: a fallback for a file that exists and
    // could not be read is never kept (a missing file is still the fallback, kept as 'none').
    read = await readJsonFile<T>(filePath, fallback, { readErrors: 'throw' });
  } catch (err) {
    kept.delete(filePath);
    if (options.readErrors === 'throw' || (err instanceof Error && err.message.startsWith('Failed to parse'))) throw err;
    return await readJsonFile<T>(filePath, fallback, options); // logs it and answers the fallback, as before
  }
  const value = deepFreeze(read);
  // Stamped before the read: a write during it changes the stamp, so the next read parses again.
  if (stamp !== null) kept.set(filePath, { stamp, value, chars: stamp === 'none' ? 0 : Number(stamp.split(':')[1]) || 0 });
  else kept.delete(filePath);
  return value;
}

/** Drop the kept value of a file this process just wrote (optional: the stamp catches it too). */
export function forgetKeptJson(filePath: string): void {
  kept.delete(filePath);
}

registerMemoryHolder({
  name: 'json-kept.files',
  budgetBytes: 64 * 1048576,
  // An estimate: the parsed objects of a JSON file take about four times its bytes.
  read: () => {
    let bytes = 0;
    for (const k of kept.values()) bytes += k.chars * 4;
    return { entries: kept.size, bytes };
  },
});

/** Tests only. */
export function _resetJsonKeptForTesting(): void { kept.clear(); }
