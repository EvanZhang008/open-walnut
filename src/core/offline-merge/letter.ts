/**
 * The conflict letter of one host drain (docs/plan/walnut-replica-servers-impl.md
 * section 7, "The letter"): at most ONE inbox letter per drain of one host, sent only
 * when the drain has a conflict that needs the user (conflictNeedsUser: words one side
 * wrote that were not kept, a delete that beat an edit, a refused or failed write, a
 * dropped device). Clean merges, fast-forwards, replays and settings both sides changed
 * (settled by the newer change) send nothing (the inbox is for what needs the user).
 *
 * Built from the conflict log (conflict-log.ts), never from memory, so the letter a boot
 * resends is the same one. The body is capped at 16 KB; every item links to its task
 * (`/tasks/<id>`) and to the full entry (`/api/v1/offline-conflicts/<drainId>#<n>`).
 */

import { log } from '../../logging/index.js';
import { conflictLetterIn, type ConflictLetter } from '../human-inbox/walnut-letters/offline-conflict.js';
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js';
import { conflictLetterMark, conflictLogFrom, removeConflictLog, unsentConflictLogs, type ConflictLog, type ConflictLogFile } from './conflict-log.js';
import { LEDGER_TTL_MS } from './ledger.js';

export type { ConflictLetter };
export {
  LETTER_BODY_MAX, conflictEntryLink, conflictNeedsUser, noteLink, refusedBySession, taskLink, writerSessionId,
} from './letter-rules.js';

/**
 * The letter for a log, in the user's letter language (English by default), or null when
 * the log holds nothing that needs the user. The words are the `offline-conflict` kind's.
 */
export function buildConflictLetter(file: ConflictLogFile, lang: LetterLang = 'en'): ConflictLetter | null {
  return conflictLetterIn(lang, file);
}

/** Letters being sent now, by drain id: a second send of the same log joins the first. */
const sending = new Map<string, Promise<boolean>>();
/** Logs of drains still running: their own drain letters them when it ends. */
const openDrains = new Set<string>();
/** Logs this process knows were lettered: every drain's resend skips them without a read. */
const knownSent = new Set<string>();

/** A drain's log is live until its drain ends (and letters it); no resend takes it meanwhile. */
export function openDrainLog(drainId: string): void { openDrains.add(drainId); }
export function closeDrainLog(drainId: string): void { openDrains.delete(drainId); }

/** Send the drain's letter once (none for a clean drain). Never throws; false = not sent. */
export function sendConflictLetter(logRef: ConflictLog): Promise<boolean> {
  const id = logRef.drainId;
  const cur = sending.get(id);
  if (cur) return cur;
  const p = sendOnce(logRef).finally(() => { if (sending.get(id) === p) sending.delete(id); });
  sending.set(id, p);
  return p;
}

async function sendOnce(logRef: ConflictLog): Promise<boolean> {
  if (logRef.data.letter) { knownSent.add(logRef.drainId); return true; }
  // Another copy of this log (a resend, the drain itself) may have sent it already.
  const onDisk = conflictLetterMark(logRef.drainId);
  if (onDisk) { logRef.data.letter = onDisk; knownSent.add(logRef.drainId); return true; }
  // The user's letter language, read fresh (English when it cannot be read).
  const lang = await import('../human-inbox/walnut-letters/languages.js').then((m) => m.walnutLetterLanguage(), (): LetterLang => 'en');
  const letter = buildConflictLetter(logRef.data, lang);
  if (!letter) {
    // Every entry was settled by its own rule: the log keeps them, and the mark keeps a later
    // drain (or an older Walnut, which letters every entry) from lettering them.
    if (logRef.data.entries.length > 0) {
      logRef.markSent(undefined, { none: true });
      knownSent.add(logRef.drainId);
      log.session.info('offline drain: conflicts settled by their own rules, no letter', { drainId: logRef.drainId, host: logRef.data.hostKey, settled: logRef.data.entries.length });
    }
    return true;
  }
  try {
    const { sendLetter } = await import('../human-inbox/store.js');
    const sent = await sendLetter({
      subject: letter.subject,
      type: 'review',
      markdown: letter.markdown,
      ...(letter.taskRefs.length ? { taskRefs: letter.taskRefs } : {}),
      sender: { sessionId: 'external', host: logRef.data.hostKey },
    });
    logRef.markSent((sent as { id?: string }).id);
    knownSent.add(logRef.drainId);
    log.session.info('offline drain: conflict letter sent', { drainId: logRef.drainId, host: logRef.data.hostKey, needed: letter.needed, listed: letter.listed, settled: letter.settled });
    return true;
  } catch (err) {
    log.session.warn('offline drain: conflict letter not sent; the next drain sends it', { drainId: logRef.drainId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * At the start of every drain: a log whose letter was never marked sent (a drain that
 * threw after a conflict was durable, a letter that failed, a crash) is lettered now,
 * once, or marked none when nothing in it needs the user. A log whose drain still runs is
 * left to that drain. Returns how many logs it settled either way.
 */
export async function resendUnsentConflictLetters(now = Date.now()): Promise<number> {
  let sent = 0;
  // A lettered log is read once per process: later scans skip it (this runs at the start of
  // every drain, on the server's one loop). One lettered longer ago than the ledger keeps an
  // op id is removed: its letter is in the inbox, and nothing redrains its records.
  const old: string[] = [];
  const unsent = unsentConflictLogs((id) => openDrains.has(id) || knownSent.has(id), (id, sentAtMs) => {
    knownSent.add(id);
    if (now - sentAtMs > LEDGER_TTL_MS) old.push(id);
  });
  for (const id of old) removeConflictLog(id);
  for (const file of unsent) {
    if (openDrains.has(file.drainId)) continue;
    if (await sendConflictLetter(conflictLogFrom(file))) sent++;
  }
  return sent;
}
