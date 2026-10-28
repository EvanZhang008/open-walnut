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
import { conflictLetterMark, conflictLogFrom, removeConflictLog, unsentConflictLogs, type ConflictEntry, type ConflictLog, type ConflictLogFile } from './conflict-log.js';
import { LEDGER_TTL_MS } from './ledger.js';
import { TEXT_TASK_FIELDS } from './task-fields.js';

/** Largest letter body; the full values stay in the conflict log the letter links to. */
export const LETTER_BODY_MAX = 16 * 1024;
const VALUE_PREVIEW = 160;

export interface ConflictLetter {
  subject: string;
  markdown: string;
  taskRefs: string[];
  /** Every link the body holds, for tests and the log line. */
  links: string[];
  /** Entries that need the user, the ones the body lists (the cap may cut it short), and those settled by their own rule (in the log only). */
  needed: number;
  listed: number;
  settled: number;
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
    case 'memory': return `${e.why === 'conflict' ? 'both sides changed the same lines; the newer change is in the document' : 'it could not be merged line by line; the newer version is the document'}, the other version is in the full entry.`;
    case 'conversation': return `both sides renamed it; kept ${e.kept === 'replica' ? 'the name given while away' : 'the Mac\'s name'}. Mac: "${preview(e.mac)}"; while away: "${preview(e.replica)}".`;
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
    case 'move-kept': case 'move-taken': return `a move or rename made while away was not made: ${e.reason ?? 'the note stays where it is'}.`;
    case 'attachment-kept': return `a different picture or file is at this path on the Mac, so it stays; the one saved while away is${e.copyPath ? ` [${e.copyPath}](${noteLink(e.copyPath)})` : ' beside it'}.`;
    default: return `${preview(e.reason)}.${copy}`;
  }
}

/** MEMORY.md or USER.md, for an entry about a memory record (its conflict, or its refusal). */
function memoryDocName(e: ConflictEntry): string | undefined {
  if (e.kind === 'memory' && e.field) return e.field;
  if (e.recordKind !== 'memory') return undefined;
  const doc = (e.record as { doc?: unknown } | undefined)?.doc;
  return doc === 'user' ? 'USER.md' : 'MEMORY.md';
}

/** A note in the console (the Notes page opens it by its vault path, `/notes?path=`). */
export function noteLink(rel: string): string {
  return `/notes?path=${encodeURIComponent(rel)}`;
}

/** Task fields that hold words someone wrote: the merged texts, the title, the tags. */
const WORD_TASK_FIELDS = new Set([...TEXT_TASK_FIELDS, 'title', 'tags']);

/**
 * Does this conflict need the user? A setting both sides changed (a phase, a priority, a
 * date, a pin) is settled by the merge's own rule, the newer change wins, and stays in the
 * log with no letter (2026-10-28: two letters for phase conflicts the merge had already
 * settled). Words one side wrote that were not kept, a move the Mac would not take, and
 * every other kind (a refusal, a drop, a delete that beat an edit, a note, a memory, a
 * chat name) still need the user.
 */
export function conflictNeedsUser(e: ConflictEntry): boolean {
  if (e.kind !== 'task-field') return true;
  if (e.why === 'invalid-pair') return true;
  return e.field === undefined || WORD_TASK_FIELDS.has(e.field);
}

/** The letter for a log, or null when the log holds nothing that needs the user. */
export function buildConflictLetter(file: ConflictLogFile): ConflictLetter | null {
  // The index in the log, for the entry links: settled entries stay in the log, unlisted.
  const needed = file.entries.flatMap((e, i) => (conflictNeedsUser(e) ? [i] : []));
  if (needed.length === 0) return null;
  const n = needed.length;
  const settled = file.entries.length - n;
  const subject = `${n} change${n === 1 ? '' : 's'} made while your Mac was away did not merge cleanly`;
  const who = file.hostKey === 'companion' ? 'your cloud companion' : `host ${file.hostKey}`;
  const head = `While your Mac was away, ${who} saved changes. When they were applied, these needed a choice. Each item says what was kept; the other side is kept in full in the linked entry.\n\n`;
  const all = `/api/v1/offline-conflicts/${encodeURIComponent(file.drainId)}`;
  const links: string[] = [];
  const taskRefs: string[] = [];
  const one = settled === 1;
  const settledLine = settled > 0
    ? `\n${settled} other change${one ? '' : 's'} to task settings (a phase, a priority, a date, a place, a link) ${one ? 'was' : 'were'} settled automatically: the newer change was kept (on a tie, the Mac's). ${one ? 'It needs' : 'They need'} nothing from you and ${one ? 'is' : 'are'} in [the full list](${all}).\n`
    : '';
  const moreLine = (more: number): string => `\n${more} more are in [the full list](${all}).\n`;
  // Room for the tail: the settled line and the longest "more" line it may need.
  const budget = LETTER_BODY_MAX - Buffer.byteLength(settledLine) - Buffer.byteLength(moreLine(n));
  let body = head;
  let shown = 0;
  for (const i of needed) {
    const e = file.entries[i];
    const entryLink = conflictEntryLink(file.drainId, i);
    const target = e.taskId ? `[task ${e.taskId}](${taskLink(e.taskId)})` : e.boardTaskId ? `[Board of ${e.boardTaskId}](${taskLink(e.boardTaskId)})`
      : e.notePath ? `[note ${e.notePath}](${noteLink(e.notePath)})` : memoryDocName(e) ?? (e.recordKind === 'conversation-edit' ? 'a chat' : e.recordKind === 'letter' ? 'a letter to you' : 'a change');
    const line = `- ${target}: ${itemLine(e)} [Full entry](${entryLink})\n`;
    if (Buffer.byteLength(body) + Buffer.byteLength(line) > budget) break;
    body += line;
    links.push(entryLink);
    if (e.taskId) { links.push(taskLink(e.taskId)); if (!taskRefs.includes(e.taskId)) taskRefs.push(e.taskId); }
    shown++;
  }
  if (shown < n) body += moreLine(n - shown);
  body += settledLine;
  if (shown < n || settled > 0) links.push(all);
  return { subject, markdown: body, taskRefs: taskRefs.slice(0, 20), links, needed: n, listed: shown, settled };
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
