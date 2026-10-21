/**
 * The journal v2 kind `note-attachment` on the Mac (docs/plan/walnut-companion-unified-replica.md,
 * stage 4d): a picture pasted into a note on the cloud companion while this Mac was away
 * (core/companion-note-attachments.ts), its bytes fetched through the journal door.
 *
 *   the Mac now                          result                                    letter
 *   nothing at the path                  written there                             no
 *   the same bytes at the path           nothing (git sync brought it first)       no
 *   other bytes at the path              the Mac's stays; the companion's is       yes
 *                                        written beside it under a new name
 *
 * Never overwrites: a file is linked into place only where no file is (a hard link of a
 * finished temp file, so a file that appears meanwhile is never replaced, and a crash
 * never leaves half a picture at the path). The new name carries the bytes' own hash,
 * so a redrain finds the file it wrote and writes nothing more; it letters again, as a
 * note's conflict copy does, so a crash before the ack never leaves one untold.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConflictEntry } from './conflict-log.js';
import type { V2Context, V2Record } from './apply-v2.js';
import { RefusedWrite } from './patch-check.js';
import { log } from '../../logging/index.js';

async function bytesAt(abs: string): Promise<Buffer | null> {
  try { return await fsp.readFile(abs); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Link `bytes` into `abs` only if no file is there. False: a file is (EEXIST). */
async function placeNew(abs: string, bytes: Buffer): Promise<boolean> {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, bytes, { flag: 'wx' });
  try {
    try {
      await fsp.link(tmp, abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A volume without hard links: a copy that still never replaces a file.
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw err;
      await fsp.copyFile(tmp, abs, fs.constants.COPYFILE_EXCL);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/** Where the bytes are now: the path itself, or a name beside it; `copy` when not the path. */
async function place(abs: string, bytes: Buffer): Promise<{ at: string; copy: boolean; wrote: boolean }> {
  const ext = path.extname(abs);
  const stem = abs.slice(0, abs.length - ext.length);
  const tag = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  for (let n = 0; n < 100; n++) {
    const target = n === 0 ? abs : `${stem}-${tag}${n === 1 ? '' : `-${n}`}${ext}`;
    // Twice per name: a file that appears between the read and the link is read again.
    for (let tries = 0; tries < 2; tries++) {
      const there = await bytesAt(target);
      if (there) {
        if (there.equals(bytes)) return { at: target, copy: n > 0, wrote: false };
        break;
      }
      if (await placeNew(target, bytes)) return { at: target, copy: n > 0, wrote: true };
    }
  }
  throw new Error('no free name for a picture saved while away');
}

export async function applyNoteAttachment(ctx: V2Context, record: V2Record): Promise<void> {
  const rel = typeof record.path === 'string' ? record.path.split('\\').join('/').replace(/^\/+/, '') : '';
  if (!rel || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new RefusedWrite('a picture saved while away names no vault path');
  const { isAttachmentFile } = await import('../notes-tree.js');
  if (!isAttachmentFile(path.posix.basename(rel))) throw new RefusedWrite(`a picture saved while away is not a picture or file (${rel})`);
  if (typeof record.oursBlob !== 'string' || !record.oursBlob) throw new RefusedWrite('a picture saved while away without its bytes');
  if (!ctx.conn) throw new Error('a picture record needs its host link for the bytes');
  const notes = await import('../../web/routes/notes-v2.js');
  const abs = notes.resolveSafePath(rel);
  if (!abs || abs.endsWith('.md')) throw new RefusedWrite(`a picture saved while away has an invalid path (${rel})`);
  const { fetchOfflineBlob } = await import('./blob.js');
  const bytes = await fetchOfflineBlob(ctx.conn, record.oursBlob);
  const placed = await place(abs, bytes);
  const at = notes.toRelPath(placed.at);
  if (placed.copy) {
    const entry: ConflictEntry = {
      kind: 'note', seq: record.seq, ...(record.opId ? { opId: record.opId } : {}), recordKind: 'note-attachment',
      ...(record.actor ? { actor: record.actor } : {}), why: 'attachment-kept', kept: 'mac', notePath: rel, copyPath: at,
      reason: `a different picture or file is at ${rel} on the Mac; the one saved while away is ${at}`,
    };
    // On disk before the ack: a crash in between letters again, never loses the bytes (they are at `at`).
    ctx.conflicts.addDurable([entry]);
  }
  if (placed.wrote) {
    const [{ invalidateAttachmentIndex }, { invalidateNotesTree }, events] = await Promise.all([
      import('../../web/routes/notes-attachment.js'), import('../notes-tree.js'), import('../event-bus.js'),
    ]);
    invalidateAttachmentIndex();
    invalidateNotesTree();
    events.bus.emit(events.EventNames.NOTES_TREE_CHANGED, { path: at }, ['web-ui']);
    ctx.result.replayed++;
  } else {
    ctx.result.skipped++;
  }
  log.memory.info('offline handover: a picture saved while away is here', { host: ctx.hostKey, seq: record.seq, opId: record.opId, path: rel, at, wrote: placed.wrote, copy: placed.copy, bytes: bytes.length });
}
