/**
 * Human Inbox letter store — durable documents an agent sends to the human.
 *
 * Why its own store instead of the notification feed: notifications.json is a
 * bounded most-recent-200 feed that drops its tail, and a letter is a document
 * the human must still be able to open next week. So letters live here (an index
 * JSON plus one body file each) and the notification record is only an envelope
 * pointing at the letter id. Read/pin/archive state is canonical HERE.
 *
 * Locking mirrors src/core/notifications/store.ts exactly: an in-process write
 * lock keeps same-process callers FIFO on top of updateJsonFile's cross-process
 * file lock (routes, ops and the cloud replica can all write this file).
 *
 * Deliberately UNBOUNDED: a letter ages out only when the human archives it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { ensureLetterBridge, mirrorLetterReadState } from '../notifications/letter-bridge.js';
import { derivePreview, truncatePreview } from './preview.js';
import {
  BODY_FILE_RE,
  LETTER_ID_RE,
  emptyStore,
  normalizeSender,
  normalizeStore,
  str,
  type LetterStoreFile,
} from './normalize.js';
import {
  LETTER_BODY_MAX_BYTES,
  LETTER_TYPES,
  type AgentReplyInput,
  type LetterDetail,
  type LetterList,
  type LetterRecord,
  type LetterThreadEntry,
  type NewLetter,
  type ThreadEntry,
} from './types.js';

const INBOX_DIR = path.join(WALNUT_HOME, 'human-inbox');
const INDEX_FILE = path.join(INBOX_DIR, 'index.json');
const BODIES_DIR = path.join(INBOX_DIR, 'bodies');

/** Store failures carry the HTTP status the route should answer with. */
export class LetterError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'not_found' | 'already_answered',
    readonly status: number,
  ) {
    super(message);
    this.name = 'LetterError';
  }
}

const invalid = (msg: string) => new LetterError(msg, 'invalid', 400);
const notFound = (id: string) => new LetterError(`Letter not found: ${id}`, 'not_found', 404);

// ── In-process write lock (same pattern as notifications/store.ts) ──

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release: () => void;
  writeLock = new Promise<void>(r => { release = r; });
  return prev.then(fn).finally(() => release!());
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read-only snapshot. Unparseable / missing file → empty store, never throws. */
async function readStore(): Promise<LetterStoreFile> {
  try {
    return normalizeStore(await readJsonFile<unknown>(INDEX_FILE, null));
  } catch (err) {
    log.notif.warn('human-inbox: failed to read index', { error: errMsg(err) });
    return emptyStore();
  }
}

/** Locked read-modify-write against a FRESH index. */
async function withStore<R>(fn: (store: LetterStoreFile) => R): Promise<R> {
  let out!: R;
  const apply = (raw: unknown): LetterStoreFile => {
    const store = normalizeStore(raw);
    out = fn(store);
    return store;
  };
  try {
    await updateJsonFile<unknown>(INDEX_FILE, null, apply);
  } catch (err) {
    if (!(err instanceof Error) || !/Failed to parse/.test(err.message)) throw err;
    // Corrupt index: move it aside for forensics, then retry against the fresh
    // fallback so the caller's write still lands (same net as the notif store).
    log.notif.warn('human-inbox: corrupt index — resetting', { error: errMsg(err) });
    try { fs.renameSync(INDEX_FILE, `${INDEX_FILE}.corrupt`); } catch { /* already gone */ }
    await updateJsonFile<unknown>(INDEX_FILE, null, apply);
  }
  return out;
}

// ── Ids + body files ──

function generateId(): string {
  // randomBytes, not Math.random().toString(36): the latter can yield a 1-char
  // suffix ("0.5" → "5"), and the id shape is load-bearing (it names a file).
  return `lt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Thread text lives in the index, so bound it — the rich body is a file. */
const THREAD_TEXT_MAX_CHARS = 4_000;

/**
 * Index-resident field caps. Bodies are files, but actions, task refs and thread
 * text live IN index.json — which every letter operation (and every panel
 * refresh) reads, parses and rewrites on the server's single event loop. Without
 * these, one send under the express body limit could leave a multi-MB index
 * behind that only hand-editing could undo (archive is not a delete).
 */
const MAX_ACTIONS = 12;
const ACTION_ID_MAX_CHARS = 64;
const ACTION_LABEL_MAX_CHARS = 200;
const ACTION_DESCRIPTION_MAX_CHARS = 500;
const MAX_TASK_REFS = 50;
const TASK_REF_MAX_CHARS = 200;

/** Keep newlines (a reply is prose); truncatePreview would flatten them. */
function boundThreadText(text: string): string {
  return text.length > THREAD_TEXT_MAX_CHARS ? text.slice(0, THREAD_TEXT_MAX_CHARS) : text;
}

function requireValidId(id: string): string {
  if (typeof id !== 'string' || !LETTER_ID_RE.test(id)) throw invalid(`Invalid letter id: ${id}`);
  return id;
}

function bodyExt(format: 'html' | 'markdown'): 'html' | 'md' {
  return format === 'html' ? 'html' : 'md';
}

function assertBodySize(body: string, field: string): void {
  const bytes = Buffer.byteLength(body, 'utf-8');
  if (bytes > LETTER_BODY_MAX_BYTES) {
    throw invalid(
      `${field} is ${bytes} bytes, over the ${LETTER_BODY_MAX_BYTES}-byte letter cap — `
      + 'link a file instead of inlining a big artifact',
    );
  }
}

async function writeBodyFile(fileName: string, content: string): Promise<void> {
  await fsp.mkdir(BODIES_DIR, { recursive: true });
  await fsp.writeFile(path.join(BODIES_DIR, fileName), content, 'utf-8');
}

/**
 * Read a body file by NAME. The name is matched against BODY_FILE_RE first: it
 * comes off a JSON index that another process wrote, so treating it as a path
 * would be a traversal hole (`../../config.yaml`).
 */
async function readBodyFile(fileName: string): Promise<string | null> {
  if (!BODY_FILE_RE.test(fileName)) {
    log.notif.warn('human-inbox: refusing suspicious body file name', { fileName });
    return null;
  }
  try {
    return await fsp.readFile(path.join(BODIES_DIR, fileName), 'utf-8');
  } catch {
    return null;
  }
}

function missingBodyNote(format: 'html' | 'markdown'): string {
  return format === 'html'
    ? '<p><em>This letter\'s body file is missing.</em></p>'
    : '_This letter\'s body file is missing._';
}

// ── Events ──

function emitLetterEvent(
  record: LetterRecord,
  kind: 'new' | 'reply',
  textPreview: string,
): void {
  // The notification bridge is installed HERE, not in server.ts: this store is
  // the only producer of letter events, so "the store is in use" is exactly when
  // the envelope bridge has to exist. Idempotent, and it must run before the emit
  // below or the first letter would never get an envelope.
  ensureLetterBridge();
  bus.emit(
    EventNames.HUMAN_INBOX_LETTER,
    {
      letterId: record.id,
      subject: record.subject,
      type: record.type,
      textPreview,
      senderSessionId: record.sender.sessionId,
      senderTitle: record.sender.sessionTitle,
      host: record.sender.host,
      kind,
    },
    ['*'],
    { source: 'human-inbox' },
  );
}

// ── Public API ──

/**
 * Persist a new letter: body to its own file, envelope to the index.
 *
 * Validation is deliberately strict (a letter is a document a human will read
 * blind on a phone): non-empty subject, a known type, EXACTLY one body format,
 * and buttons only on the one type that means "I need a decision".
 */
export async function sendLetter(input: NewLetter): Promise<LetterRecord> {
  const subject = str(input.subject).trim();
  if (!subject) throw invalid('subject is required');
  if (!LETTER_TYPES.includes(input.type)) {
    throw invalid(`type must be one of ${LETTER_TYPES.join(', ')}`);
  }
  const hasHtml = typeof input.html === 'string' && input.html.length > 0;
  const hasMarkdown = typeof input.markdown === 'string' && input.markdown.length > 0;
  if (hasHtml === hasMarkdown) {
    throw invalid('exactly one of html | markdown is required');
  }
  const actions = input.actions;
  if (actions !== undefined) {
    if (input.type !== 'action_required') {
      throw invalid('actions are only allowed when type is action_required');
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw invalid('actions must be a non-empty array');
    }
    if (actions.length > MAX_ACTIONS) {
      throw invalid(`at most ${MAX_ACTIONS} actions — a letter asks ONE question the human can answer with one tap`);
    }
    for (const action of actions) {
      if (!action || typeof action !== 'object' || !str(action.id).trim() || !str(action.label).trim()) {
        throw invalid('each action needs a non-empty id and label');
      }
      if (str(action.id).length > ACTION_ID_MAX_CHARS) {
        throw invalid(`action id is over ${ACTION_ID_MAX_CHARS} chars`);
      }
      if (str(action.label).length > ACTION_LABEL_MAX_CHARS) {
        throw invalid(`action label is over ${ACTION_LABEL_MAX_CHARS} chars — a button label, not a paragraph`);
      }
      if (action.description !== undefined && str(action.description).length > ACTION_DESCRIPTION_MAX_CHARS) {
        throw invalid(`action description is over ${ACTION_DESCRIPTION_MAX_CHARS} chars — put the detail in the body`);
      }
    }
    const ids = new Set(actions.map(a => a.id));
    if (ids.size !== actions.length) throw invalid('action ids must be unique');
  }

  const bodyFormat = hasHtml ? 'html' : 'markdown';
  const body = (hasHtml ? input.html : input.markdown) as string;
  assertBodySize(body, bodyFormat);

  const id = generateId();
  const record: LetterRecord = {
    id,
    subject: truncatePreview(subject, 200),
    type: input.type,
    bodyFormat,
    textPreview: derivePreview({ text: input.text, html: input.html, markdown: input.markdown }),
    sender: normalizeSender(input.sender),
    createdAt: Date.now(),
    read: false,
    pinned: input.pin === true,
    archived: false,
    thread: [],
    ...(actions ? { actions: actions.map(a => ({ ...a })) } : {}),
    ...(() => {
      // Bounded, not rejected: task refs are a courtesy (pills under the body),
      // so a chatty caller loses the tail instead of losing the whole letter.
      const refs = (input.taskRefs ?? input.task_refs ?? [])
        .filter(t => typeof t === 'string' && t && t.length <= TASK_REF_MAX_CHARS)
        .slice(0, MAX_TASK_REFS);
      return refs.length > 0 ? { taskRefs: refs } : {};
    })(),
  };

  // Body first: an index entry pointing at a file that was never written would
  // read as a corrupt letter. A body file with no index entry is invisible junk.
  await writeBodyFile(`${id}.${bodyExt(bodyFormat)}`, body);
  try {
    await withWriteLock(() => withStore((store) => { store.letters.push(record); }));
  } catch (err) {
    await fsp.rm(path.join(BODIES_DIR, `${id}.${bodyExt(bodyFormat)}`), { force: true }).catch(() => {});
    throw err;
  }

  log.notif.info('human-inbox: letter sent', {
    letterId: id, type: record.type, senderSessionId: record.sender.sessionId, host: record.sender.host,
  });
  emitLetterEvent(record, 'new', record.textPreview);
  return record;
}

/** Pinned first, then newest — what both the rail and the phone list want. */
function sortLetters(letters: LetterRecord[]): LetterRecord[] {
  return [...letters].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return b.id.localeCompare(a.id);
  });
}

/**
 * Envelopes only (the index carries no body content). `archived: true` returns
 * the archive instead of the feed; `unreadCount` always counts the LIVE feed, so
 * archiving an unread letter clears its badge.
 */
export async function listLetters(opts: { archived?: boolean } = {}): Promise<LetterList> {
  const wantArchived = opts.archived === true;
  return withWriteLock(async () => {
    const { letters } = await readStore();
    return {
      letters: sortLetters(letters.filter(l => l.archived === wantArchived)),
      unreadCount: letters.filter(l => !l.archived && !l.read).length,
    };
  });
}

/** The record plus every body read off disk. Unknown id → null (route 404s). */
export async function getLetter(id: string): Promise<LetterDetail | null> {
  if (typeof id !== 'string' || !LETTER_ID_RE.test(id)) return null;
  const { letters } = await readStore();
  const record = letters.find(l => l.id === id);
  if (!record) return null;

  const body = await readBodyFile(`${record.id}.${bodyExt(record.bodyFormat)}`);
  const thread: LetterThreadEntry[] = [];
  for (const entry of record.thread) {
    if (!entry.bodyFile) { thread.push({ ...entry }); continue; }
    const turnBody = await readBodyFile(entry.bodyFile);
    thread.push(turnBody === null
      ? { ...entry, bodyMissing: true }
      : { ...entry, body: turnBody });
  }
  return {
    ...record,
    thread,
    body: body ?? missingBodyNote(record.bodyFormat),
    ...(body === null ? { bodyMissing: true } : {}),
  };
}

/** Find-or-throw helper for the mutators, all of which run under the lock. */
function find(store: LetterStoreFile, id: string): LetterRecord {
  const record = store.letters.find(l => l.id === id);
  if (!record) throw notFound(id);
  return record;
}

/**
 * Append an agent turn to the thread.
 *
 * Flips the letter unread (the agent answered — that is news) and pulls it back
 * out of the archive, the way a new mail in a thread returns it to an inbox.
 */
export async function agentReply(id: string, input: AgentReplyInput): Promise<LetterRecord> {
  requireValidId(id);
  const text = str(input?.text).trim();
  if (!text) throw invalid('text is required');
  assertBodySize(text, 'text');
  const hasHtml = typeof input.html === 'string' && input.html.length > 0;
  const hasMarkdown = typeof input.markdown === 'string' && input.markdown.length > 0;
  if (hasHtml && hasMarkdown) throw invalid('pass at most one of html | markdown');
  const richBody = hasHtml ? input.html! : hasMarkdown ? input.markdown! : null;
  const richFormat = hasHtml ? 'html' : 'markdown';
  if (richBody !== null) assertBodySize(richBody, richFormat);

  // The turn index names the body file, so it has to be assigned under the lock.
  let bodyFileToWrite: string | null = null;
  const record = await withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    const entry: ThreadEntry = { from: 'agent', text: boundThreadText(text), at: Date.now() };
    if (richBody !== null) {
      bodyFileToWrite = `${letter.id}.r${letter.thread.length}.${bodyExt(richFormat)}`;
      entry.bodyFormat = richFormat;
      entry.bodyFile = bodyFileToWrite;
    }
    letter.thread.push(entry);
    letter.read = false;
    letter.archived = false;
    return { ...letter };
  }));
  if (bodyFileToWrite && richBody !== null) await writeBodyFile(bodyFileToWrite, richBody);

  log.notif.info('human-inbox: agent replied', { letterId: id, turns: record.thread.length });
  emitLetterEvent(record, 'reply', truncatePreview(text));
  return record;
}

export async function setRead(id: string, read: boolean): Promise<LetterRecord> {
  requireValidId(id);
  const record = await withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    letter.read = read === true;
    return { ...letter };
  }));
  // Read state is canonical here; the envelope notification only mirrors it.
  // Fire-and-forget on purpose: the mirror must never make the read itself wait
  // on (or fail with) the notification file lock.
  void mirrorLetterReadState(record.id, record.read);
  return record;
}

export async function setPinned(id: string, pinned: boolean): Promise<LetterRecord> {
  requireValidId(id);
  return withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    letter.pinned = pinned === true;
    return { ...letter };
  }));
}

export async function setArchived(id: string, archived: boolean): Promise<LetterRecord> {
  requireValidId(id);
  const record = await withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    letter.archived = archived === true;
    return { ...letter };
  }));
  // The letter's own `read` flag is untouched (archiving is not reading), but the
  // BELL counts the envelope notification, and letters are exempt from
  // mark-all-read — so archiving an unread letter used to leave a badge nothing
  // in the Inbox rail could clear. The envelope mirrors "not in the live feed" as
  // read; un-archiving restores the letter's real read state.
  void mirrorLetterReadState(record.id, record.archived ? true : record.read);
  return record;
}

/**
 * Record the human's choice on an `action_required` letter.
 *
 * One answer only (409 on a second): the choice was already delivered to the
 * origin session and is now a record, not a setting. Answering un-archives so
 * the decision is visible where the thread is, and marks the letter read (the
 * human was clearly looking at it).
 */
export async function answerLetter(
  id: string,
  input: { actionId: string; freeText?: string },
): Promise<LetterRecord> {
  requireValidId(id);
  const actionId = str(input?.actionId).trim();
  if (!actionId) throw invalid('actionId is required');
  const freeText = str(input?.freeText).trim();
  if (freeText) assertBodySize(freeText, 'freeText');

  const record = await withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    if (letter.answered) {
      throw new LetterError(
        `Letter ${id} was already answered (${letter.answered.actionId})`,
        'already_answered',
        409,
      );
    }
    const action = letter.actions?.find(a => a.id === actionId);
    if (!action) throw invalid(`Unknown actionId: ${actionId}`);
    const at = Date.now();
    // Both spellings of the note live in the index, so both are bounded (the
    // human's full text, if it was ever that long, is what they typed — the cap
    // matches every other thread turn).
    const note = boundThreadText(freeText);
    letter.answered = { actionId: action.id, label: action.label, at, ...(note ? { freeText: note } : {}) };
    letter.thread.push({
      from: 'human',
      text: note ? `${action.label} — ${note}` : action.label,
      at,
    });
    letter.read = true;
    letter.archived = false;
    return { ...letter };
  }));
  void mirrorLetterReadState(record.id, true);
  return record;
}

/** Append the human's free-text reply. Same un-archive + mark-read reasoning. */
export async function humanReply(id: string, input: { text: string }): Promise<LetterRecord> {
  requireValidId(id);
  const text = str(input?.text).trim();
  if (!text) throw invalid('text is required');
  assertBodySize(text, 'text');
  const record = await withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    letter.thread.push({ from: 'human', text: boundThreadText(text), at: Date.now() });
    letter.read = true;
    letter.archived = false;
    return { ...letter };
  }));
  void mirrorLetterReadState(record.id, true);
  return record;
}

/** Paths, for tests and for anything that needs to point at the store on disk. */
export const humanInboxPaths = { dir: INBOX_DIR, indexFile: INDEX_FILE, bodiesDir: BODIES_DIR };
