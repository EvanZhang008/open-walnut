/**
 * The journal v2 kind `note-move` on the Mac (docs/plan/walnut-companion-unified-replica.md,
 * stage 4d): a note moved or renamed on the cloud companion while this Mac was away
 * (core/companion-note-paths.ts). The note is found by its id first (the notes index),
 * its old path second, as a `note` record is (notes.ts).
 *
 *   the Mac now                                    result                          letter
 *   the note at the new path already               nothing                         no
 *   at the old path, the new path free             moved (its id and links kept)   no
 *   gone (deleted here)                            nothing                         no
 *   moved elsewhere here                           the Mac's place stays           yes
 *   another note at the new path                   the note stays where it is      yes
 *
 * Moved through the notes route's own move (notes-v2.ts moveNote: the index keeps the
 * id, a bookmark follows it). A redrain after a crash finds the note at the new path
 * and does nothing. Records apply in order, so a note made on the companion and then
 * moved there is here (made by its `note` record) when its move applies.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ConflictEntry } from './conflict-log.js';
import type { V2Context, V2Record } from './apply-v2.js';
import { noteRel } from './notes.js';
import { RefusedWrite } from './patch-check.js';
import { log } from '../../logging/index.js';

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

function idIn(text: string): string | undefined {
  const m = FRONTMATTER.exec(text);
  const line = m ? /(?:^|\n)id:[ \t]*([^\r\n]*)/.exec(m[0]) : null;
  const v = line ? line[1].trim().replace(/^["']|["']$/g, '') : '';
  return v || undefined;
}

async function textAt(root: string, rel: string): Promise<string | null> {
  try { return await fsp.readFile(path.join(root, rel), 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function applyNoteMove(ctx: V2Context, record: V2Record): Promise<void> {
  const from = typeof record.from === 'string' ? noteRel(record.from) : null;
  const to = typeof record.to === 'string' ? noteRel(record.to) : null;
  if (!from || !to || from === to) throw new RefusedWrite('a note move names no two note paths');
  const noteId = typeof record.noteId === 'string' && record.noteId ? record.noteId : undefined;
  const constants = await import('../../constants.js');
  const root = path.resolve(constants.NOTES_DIR);

  // Where the note is now: by its id, else at the old path (when that file is not another note).
  let at: string | null = null;
  if (noteId) {
    const { getNotePathById } = await import('../notes-index.js');
    let byId: string | undefined;
    try { byId = getNotePathById(noteId); } catch { byId = undefined; }
    const rel = byId ? noteRel(byId) : null;
    if (rel && (await textAt(root, rel)) !== null) at = rel;
  }
  if (!at) {
    const text = await textAt(root, from);
    if (text !== null && (!noteId || !idIn(text) || idIn(text) === noteId)) at = from;
  }
  const done = (why: string) => {
    ctx.result.skipped++;
    log.session.info('offline handover: a note move made while away needed nothing', { host: ctx.hostKey, seq: record.seq, opId: record.opId, from, to, why });
  };
  if (at === to) return done('already there');
  if (!at) return done('not here (moved there already, or deleted)');

  const letter = (why: string, reason: string, notePath: string) => {
    const entry: ConflictEntry = {
      kind: 'note', seq: record.seq, ...(record.opId ? { opId: record.opId } : {}), recordKind: 'note-move',
      ...(record.actor ? { actor: record.actor } : {}), why, kept: 'mac', notePath, reason, record,
    };
    ctx.conflicts.addDurable([entry]);
    ctx.result.skipped++;
    log.session.info('offline handover: a note move made while away was not made', { host: ctx.hostKey, seq: record.seq, opId: record.opId, from, to, at, why });
  };
  if (at !== from) return letter('move-kept', `it was moved to ${to} while away, and to ${at} on the Mac; it stays at ${at}`, at);

  const notes = await import('../../web/routes/notes-v2.js');
  try {
    await notes.moveNote(from, to);
  } catch (err) {
    if (!(err instanceof notes.NotesOpError)) throw err;
    if (err.statusCode === 409) return letter('move-taken', `it was moved to ${to} while away, but another note is at that path on the Mac; it stays at ${from}`, from);
    if (err.statusCode === 404) return done('the note is gone here');
    throw new RefusedWrite(`the note move was refused: ${err.message}`);
  }
  const events = await import('../event-bus.js');
  events.bus.emit(events.EventNames.NOTES_TREE_CHANGED, { path: to }, ['web-ui']);
  ctx.result.replayed++;
  log.session.info('offline handover: a note moved while away is moved here', { host: ctx.hostKey, seq: record.seq, opId: record.opId, from, to });
}
