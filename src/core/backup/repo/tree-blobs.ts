/**
 * The data blobs a set of snapshots names, read the way prune needs it: each tree blob
 * once, however many snapshots share it.
 *
 * A tree is the JSON lines of its TreeEntry rows, cut into content-defined blobs
 * (treeChunks), so kept backups share most of their tree blobs. Reading every kept
 * snapshot's tree whole (Repository.readTree) parsed the same rows once per snapshot:
 * 2026-11-25 on the Mac, about 80 kept backups of 55k files each made every prune parse
 * about 80 copies of a 12 MB tree within a minute, and the server's footprint rose to
 * 5.8 GB while the collector caught up.
 *
 * Here every unique tree blob is opened once, pack by pack, and the rows wholly inside it
 * are read there. A row cut across two blobs is joined per snapshot from the end of one
 * blob and the start of the next, which is all a blob keeps after it is read. The ids
 * found are exactly those of readTree over each snapshot.
 */
import type { LoadedIndex, PackCache, Repository } from './repository.js';
import type { Snapshot, TreeEntry } from './format.js';

const NL = 0x0a;

/** What one tree blob leaves for the rows that cross its edges. */
type Edges =
  /** No newline in it: the blob is the middle of one long row. */
  | { whole: Buffer }
  /** The start of its first row's tail end (before the first newline) and its last row's head (after the last). */
  | { head: Buffer; tail: Buffer };

export async function treeDataBlobIds(
  repo: Pick<Repository, 'readBlob'>,
  snaps: readonly Snapshot[],
  index: LoadedIndex,
  cache: PackCache,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const addRow = (bytes: Buffer): void => {
    if (bytes.length === 0) return;
    for (const id of (JSON.parse(bytes.toString('utf8')) as TreeEntry).b) ids.add(id);
  };

  // Each unique tree blob, grouped by pack so a pack is fetched once.
  const unique = [...new Set(snaps.flatMap((s) => s.tree))];
  const packOf = (id: string): string => index.blobs.get(id)?.pack ?? '';
  unique.sort((a, b) => (packOf(a) < packOf(b) ? -1 : packOf(a) > packOf(b) ? 1 : 0));

  const edges = new Map<string, Edges>();
  for (const id of unique) {
    const blob = await repo.readBlob(id, index, cache);
    const first = blob.indexOf(NL);
    if (first < 0) {
      edges.set(id, { whole: Buffer.from(blob) });
      continue;
    }
    const last = blob.lastIndexOf(NL);
    if (last > first) {
      for (const row of blob.subarray(first + 1, last).toString('utf8').split('\n')) {
        if (row) for (const blobId of (JSON.parse(row) as TreeEntry).b) ids.add(blobId);
      }
    }
    edges.set(id, { head: Buffer.from(blob.subarray(0, first)), tail: Buffer.from(blob.subarray(last + 1)) });
  }

  // The rows that cross blob edges, per snapshot, in its own blob order.
  for (const s of snaps) {
    let carry: Buffer[] = [];
    for (const id of s.tree) {
      const e = edges.get(id)!;
      if ('whole' in e) {
        carry.push(e.whole);
        continue;
      }
      carry.push(e.head);
      addRow(carry.length === 1 ? carry[0]! : Buffer.concat(carry));
      carry = [e.tail];
    }
    addRow(Buffer.concat(carry));
  }
  return ids;
}
