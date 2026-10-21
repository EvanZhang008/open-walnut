/**
 * The journal v2 kind `memory` on the Mac (docs/plan/walnut-companion-unified-replica.md,
 * stage 4d): MEMORY.md or USER.md saved on the cloud companion while this Mac was away
 * (core/companion-memory.ts), its two texts fetched through the journal door.
 *
 *   the Mac's doc now           result                                         letter
 *   the save's text             nothing                                        no
 *   the base it was made on     the save's text                                no
 *   missing                     the save's text (a memory doc is not deleted)  no
 *   changed, merges clean       the merge                                      no
 *   changed, same lines         the newer side per region; the other version   yes
 *                               in full in the conflict log
 *
 * Written through writeMemoryDoc, the editor's own write (telemetry, the prompt
 * snapshot's thaw, the update event), locked to the text the merge read: a write that
 * landed meanwhile throws, and the record is merged again from the new text. A redrain
 * after a crash finds the save's text, or a merge that holds it, and writes nothing new.
 */

import fsp from 'node:fs/promises';
import type { ConflictEntry } from './conflict-log.js';
import type { V2Context, V2Record } from './apply-v2.js';
import { RefusedWrite } from './patch-check.js';
import { log } from '../../logging/index.js';

const FILES = { global: 'MEMORY.md', user: 'USER.md' } as const;

async function readOrNull(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function applyMemory(ctx: V2Context, record: V2Record): Promise<void> {
  const doc = record.doc;
  if (doc !== 'global' && doc !== 'user') throw new RefusedWrite(`a memory change names no memory document (${String(doc)})`);
  if (typeof record.oursBlob !== 'string' || !record.oursBlob) throw new RefusedWrite('a memory change without its text');
  if (!ctx.conn) throw new Error('a memory record needs its host link for the texts');
  const { fetchOfflineBlob } = await import('./blob.js');
  const ours = (await fetchOfflineBlob(ctx.conn, record.oursBlob)).toString('utf8');
  const base = typeof record.baseBlob === 'string' && record.baseBlob ? (await fetchOfflineBlob(ctx.conn, record.baseBlob)).toString('utf8') : null;
  const constants = await import('../../constants.js');
  const file = doc === 'global' ? constants.MEMORY_FILE : constants.USER_FILE;
  const name = FILES[doc];
  const mac = await readOrNull(file);
  if (mac === ours) { ctx.result.skipped++; return; }
  let text = ours;
  let conflicts = 0;
  if (mac !== null && mac !== base) {
    const macAt = (await fsp.stat(file).catch(() => null))?.mtimeMs ?? 0;
    const { mergeNoteOffLoop } = await import('./note-merge-worker.js');
    // A save made with no doc on the box over a doc the Mac has: nothing to diff from.
    const r = await mergeNoteOffLoop(base ?? '', [
      { key: 'mac', text: mac, at: macAt },
      { key: ctx.hostKey, text: ours, at: ctx.at },
    ], { eolFrom: 'mac', ...(base === null ? { wholeNote: true } : {}) });
    const why = r.timedOut ? 'deadline' : r.overBudget || base === null ? 'over-budget' : 'conflict';
    const entries: ConflictEntry[] = r.losers.map((loser) => ({
      kind: 'memory', seq: record.seq, ...(record.opId ? { opId: record.opId } : {}), recordKind: 'memory',
      ...(record.actor ? { actor: record.actor } : {}),
      field: name, why, kept: loser === 'mac' ? 'replica' : 'mac', lostVersion: loser,
      base: base ?? undefined, mac, replica: ours, macAt, replicaAt: ctx.at,
      reason: why === 'conflict'
        ? `both sides changed the same lines of ${name}; the newer change is in the document, the other version is in the full entry`
        : `${name} could not be merged line by line; the newer version is the document, the other version is in the full entry`,
    }));
    // On disk before the document: a crash in between letters again, never loses a version.
    if (entries.length) ctx.conflicts.addDurable(entries);
    conflicts = entries.length;
    text = r.text;
  }
  if (text === mac) { ctx.result.skipped++; return; }
  const { writeMemoryDoc } = await import('../../web/routes/memory.js');
  const { computeContentHash } = await import('../../utils/file-ops.js');
  // The lock: the text this merge read (writeMemoryDoc compares it); nothing for a doc that did not exist.
  await writeMemoryDoc(doc === 'global' ? 'memory' : 'user', text, mac !== null ? computeContentHash(mac) : undefined);
  ctx.result.replayed++;
  log.memory.info('offline handover: a memory change made while away is here', { host: ctx.hostKey, doc: name, seq: record.seq, opId: record.opId, merged: mac !== null && mac !== base, conflicts });
}
