/**
 * Defensive normalization of the letter index.
 *
 * The index is a JSON file several processes write (routes, ops, the cloud
 * replica), so the store must treat whatever it reads as untrusted: a corrupt or
 * half-written record can never throw at a caller and can never take the whole
 * inbox down with it. Rule applied here: a record survives if it has a usable
 * id, and every OTHER field is repaired to a sane default; a record without an
 * id-shaped id is dropped, because its id is what names its body file.
 */

import {
  LETTER_TYPES,
  type LetterAction,
  type LetterRecord,
  type LetterSender,
  type LetterType,
  type ThreadEntry,
} from './types.js';
import { truncatePreview } from './preview.js';

/** `lt-<timestamp36>-<rand>` — the only id shape that can name a body file. */
export const LETTER_ID_RE = /^lt-[0-9a-z]{1,12}-[0-9a-z]{4,12}$/;
/** Body file names we will open: `<id>.html|.md` or `<id>.r<n>.html|.md`. */
export const BODY_FILE_RE = /^lt-[0-9a-z]{1,12}-[0-9a-z]{4,12}(?:\.r\d{1,4})?\.(?:html|md)$/;

export interface LetterStoreFile {
  version: 1;
  letters: LetterRecord[];
}

export function emptyStore(): LetterStoreFile {
  return { version: 1, letters: [] };
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeActions(raw: unknown): LetterAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter(a => typeof a.id === 'string' && a.id.length > 0 && typeof a.label === 'string')
    .map(a => ({
      id: a.id as string,
      label: a.label as string,
      ...(typeof a.description === 'string' ? { description: a.description } : {}),
    }));
  return actions.length > 0 ? actions : undefined;
}

function normalizeThread(raw: unknown): ThreadEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ThreadEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const from = e.from === 'human' ? 'human' : e.from === 'agent' ? 'agent' : null;
    if (!from) continue;
    out.push({
      from,
      text: str(e.text),
      at: typeof e.at === 'number' ? e.at : 0,
      ...(e.bodyFormat === 'html' || e.bodyFormat === 'markdown' ? { bodyFormat: e.bodyFormat } : {}),
      ...(typeof e.bodyFile === 'string' ? { bodyFile: e.bodyFile } : {}),
    });
  }
  return out;
}

/** Also used at send time, so a route can never stamp a sender-less letter. */
export function normalizeSender(raw: unknown): LetterSender {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    sessionId: str(s.sessionId, 'external'),
    host: str(s.host, 'local'),
    ...(typeof s.sessionTitle === 'string' ? { sessionTitle: s.sessionTitle } : {}),
    ...(typeof s.taskId === 'string' ? { taskId: s.taskId } : {}),
    ...(typeof s.taskTitle === 'string' ? { taskTitle: s.taskTitle } : {}),
    ...(typeof s.project === 'string' ? { project: s.project } : {}),
  };
}

function normalizeRecord(raw: unknown): LetterRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !LETTER_ID_RE.test(r.id)) return null;
  const type = LETTER_TYPES.includes(r.type as LetterType) ? (r.type as LetterType) : 'info';
  const answered = r.answered && typeof r.answered === 'object'
    ? (r.answered as Record<string, unknown>)
    : null;
  const actions = normalizeActions(r.actions);
  return {
    id: r.id,
    subject: str(r.subject, '(no subject)'),
    type,
    bodyFormat: r.bodyFormat === 'html' ? 'html' : 'markdown',
    textPreview: truncatePreview(str(r.textPreview)),
    sender: normalizeSender(r.sender),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    read: r.read === true,
    pinned: r.pinned === true,
    archived: r.archived === true,
    thread: normalizeThread(r.thread),
    ...(actions ? { actions } : {}),
    ...(answered && typeof answered.actionId === 'string'
      ? {
        answered: {
          actionId: answered.actionId,
          label: str(answered.label, answered.actionId),
          at: typeof answered.at === 'number' ? answered.at : 0,
          ...(typeof answered.freeText === 'string' ? { freeText: answered.freeText } : {}),
        },
      }
      : {}),
    ...(Array.isArray(r.taskRefs)
      ? { taskRefs: r.taskRefs.filter((t): t is string => typeof t === 'string') }
      : {}),
  };
}

/** Wrong version / non-array letters → fresh store, same as the notif store. */
export function normalizeStore(raw: unknown): LetterStoreFile {
  const parsed = raw as LetterStoreFile | null;
  if (parsed?.version !== 1 || !Array.isArray(parsed?.letters)) return emptyStore();
  const letters: LetterRecord[] = [];
  for (const entry of parsed.letters) {
    const record = normalizeRecord(entry);
    if (record) letters.push(record);
  }
  return { version: 1, letters };
}
