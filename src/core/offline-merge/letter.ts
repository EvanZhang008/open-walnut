/**
 * The conflict letter of one host drain (docs/plan/walnut-replica-servers-impl.md
 * section 7, "The letter"): at most ONE inbox letter per drain of one host, sent only
 * when the drain has a real conflict (a field both sides changed differently, a delete
 * that beat an edit, a refused or failed write, a dropped device). Clean merges,
 * fast-forwards and replays send nothing (the inbox is for what needs the user).
 *
 * Built from the conflict log (conflict-log.ts), never from memory, so the letter a boot
 * resends is the same one. The body is capped at 16 KB; every item links to its task
 * (`/tasks/<id>`) and to the full entry (`/api/v1/offline-conflicts/<drainId>#<n>`).
 */

import { log } from '../../logging/index.js';
import { conflictLetterMark, conflictLogFrom, removeConflictLog, unsentConflictLogs, type ConflictEntry, type ConflictLog, type ConflictLogFile } from './conflict-log.js';
import { LEDGER_TTL_MS } from './ledger.js';

/** Largest letter body; the full values stay in the conflict log the letter links to. */
export const LETTER_BODY_MAX = 16 * 1024;
const VALUE_PREVIEW = 160;

export interface ConflictLetter {
  subject: string;
  markdown: string;
  taskRefs: string[];
  /** Every link the body holds, for tests and the log line. */
  links: string[];
}

/** Where the full entry `n` of a drain's log is served. */
export function conflictEntryLink(drainId: string, n: number): string {
  return `/api/v1/offline-conflicts/${encodeURIComponent(drainId)}#${n}`;
}

export function taskLink(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

function preview(v: unknown): string {
  let s = typeof v === 'string' ? v : v === undefined ? '(none)' : JSON.stringify(v);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = '(empty)';
  return s.length > VALUE_PREVIEW ? `${s.slice(0, VALUE_PREVIEW)}...` : s;
}

/** A note change lettered after the host had freed its text (offline-handover.ts noteBodies). */
const LOST = ' Its text was no longer on the host, so it could not be attached.';

const fieldName = (f: string | undefined): string => (f === 'project+group_id' ? 'project and folder' : f ?? 'change');

function itemLine(e: ConflictEntry): string {
  switch (e.kind) {
    case 'task-field': {
      const kept = e.kept === 'replica' ? 'the change made while away' : 'the Mac\'s value';
      return `${fieldName(e.field)}: kept ${kept}. Mac: "${preview(e.mac)}"; while away: "${preview(e.replica)}".`;
    }
    case 'task-deleted': return `the task was deleted on the Mac; a change made while away was dropped (${fieldName(e.field)}: "${preview(e.replica)}").`;
    case 'refused': return `the Mac refused a change made while away: ${preview(e.reason)}.${e.bodiesLost ? LOST : ''}`;
    case 'given-up': return `could not apply: ${preview(e.reason)}.${e.bodiesLost ? LOST : ' The change is attached.'}`;
    case 'actor-dropped': return `a change from a device that is no longer paired was not applied${e.reason ? ` (${preview(e.reason)})` : ''}.`;
    case 'parent-refused': return `the parent link was not applied: ${preview(e.reason)}.`;
    case 'create-collision': return `a task created while away got a new id (${preview(e.reason)}).`;
    case 'board': return `a Board edit conflicted; the Mac's page was kept: ${preview(e.reason)}.`;
    case 'note': return noteLine(e);
  }
}

function noteLine(e: ConflictEntry): string {
  const copy = e.copyPath ? ` The other version is the note [${e.copyPath}](${noteLink(e.copyPath)}).` : '';
  switch (e.why) {
    case 'conflict': return `both sides changed the same lines; the newer change is in the note.${copy}`;
    case 'over-budget': case 'deadline': return `the note was too large to merge line by line; the newer version is the note.${copy}`;
    case 'mac-deleted': return `the note was deleted on the Mac, so the change made while away was kept as a copy.${copy}`;
    case 'create-exists': return `a note made while away has the path of a note on the Mac; the Mac's note stays.${copy}`;
    case 'create-both': return `two notes were made at this path while away; the newer one is the note.${copy}`;
    case 'delete-kept': return 'the note was deleted while away but edited since; it was kept.';
    case 'restored': return 'the note was deleted while away and also edited; the edit won and the note is back.';
    default: return `${preview(e.reason)}.${copy}`;
  }
}

/** A note in the console (the Notes page opens it by its vault path, `/notes?path=`). */
export function noteLink(rel: string): string {
  return `/notes?path=${encodeURIComponent(rel)}`;
}

/** The letter for a log, or null when the log holds nothing that needs the user. */
export function buildConflictLetter(file: ConflictLogFile): ConflictLetter | null {
  if (file.entries.length === 0) return null;
  const n = file.entries.length;
  const subject = `${n} change${n === 1 ? '' : 's'} made while your Mac was away did not merge cleanly`;
  const who = file.hostKey === 'companion' ? 'your cloud companion' : `host ${file.hostKey}`;
  const head = `While your Mac was away, ${who} saved changes. When they were applied, these needed a choice. Each item says what was kept; the other side is kept in full in the linked entry.\n\n`;
  const links: string[] = [];
  const taskRefs: string[] = [];
  let body = head;
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const e = file.entries[i];
    const entryLink = conflictEntryLink(file.drainId, i);
    const target = e.taskId ? `[task ${e.taskId}](${taskLink(e.taskId)})` : e.boardTaskId ? `[Board of ${e.boardTaskId}](${taskLink(e.boardTaskId)})`
      : e.notePath ? `[note ${e.notePath}](${noteLink(e.notePath)})` : 'a change';
    const line = `- ${target}: ${itemLine(e)} [Full entry](${entryLink})\n`;
    if (Buffer.byteLength(body) + Buffer.byteLength(line) > LETTER_BODY_MAX - 200) break;
    body += line;
    links.push(entryLink);
    if (e.taskId) { links.push(taskLink(e.taskId)); if (!taskRefs.includes(e.taskId)) taskRefs.push(e.taskId); }
    shown++;
  }
  if (shown < n) {
    const all = `/api/v1/offline-conflicts/${encodeURIComponent(file.drainId)}`;
    body += `\n${n - shown} more are in [the full list](${all}).\n`;
    links.push(all);
  }
  return { subject, markdown: body, taskRefs: taskRefs.slice(0, 20), links };
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
  const letter = buildConflictLetter(logRef.data);
  if (!letter) return true;
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
    log.session.info('offline drain: conflict letter sent', { drainId: logRef.drainId, host: logRef.data.hostKey, items: logRef.data.entries.length });
    return true;
  } catch (err) {
    log.session.warn('offline drain: conflict letter not sent; the next drain sends it', { drainId: logRef.drainId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * At the start of every drain: a log whose letter was never marked sent (a drain that
 * threw after a conflict was durable, a letter that failed, a crash) is lettered now,
 * once. A log whose drain still runs is left to that drain.
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
