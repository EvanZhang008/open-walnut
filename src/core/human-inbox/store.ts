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
import { statStagedBody, takeStagedBody } from './staged-body.js';
import {
  LETTER_INLINE_BODY_MAX_BYTES,
  LETTER_TYPES,
  letterFieldMaxBytes,
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

/**
 * Locked read-modify-write against a FRESH index.
 *
 * Every mutation in this file goes through here, which is why the content clock
 * is stamped HERE and nowhere else: one place to update means no writer can ever
 * forget it. git-sync's LWW merge reads this exact field to decide which copy of
 * index.json is newer, so a store save without a fresh stamp is a save that can
 * lose to a stale copy (2026-08-30: a replica's older index.json won the merge
 * and flipped a read letter back to unread).
 */
async function withStore<R>(fn: (store: LetterStoreFile) => R): Promise<R> {
  let out!: R;
  const apply = (raw: unknown): LetterStoreFile => {
    const store = normalizeStore(raw);
    out = fn(store);
    store.lastUpdated = new Date().toISOString();
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

function assertBodyBytes(bytes: number, field: string): void {
  const max = letterFieldMaxBytes(field);
  if (bytes > max) {
    throw invalid(
      `${field} is ${bytes} bytes, over the ${max}-byte letter cap — `
      + 'link a file instead of inlining a big artifact',
    );
  }
}

function assertBodySize(body: string, field: string): void {
  assertBodyBytes(Buffer.byteLength(body, 'utf-8'), field);
}

async function writeBodyFile(fileName: string, content: string): Promise<void> {
  await fsp.mkdir(BODIES_DIR, { recursive: true });
  await fsp.writeFile(path.join(BODIES_DIR, fileName), content, 'utf-8');
}

/**
 * A body to store, from either lane: a string the caller inlined, or a ref to
 * bytes already streamed to staging. `bytes` is known for both, so the cap is
 * checked the same way whichever lane produced it.
 */
type BodySource =
  | { kind: 'inline'; text: string; bytes: number }
  | { kind: 'staged'; ref: string; bytes: number };

/** Resolve + size-check one body field pair (`html` or `htmlRef`, `markdown`). */
async function resolveBodySource(
  value: string | undefined,
  ref: string | undefined,
  field: string,
): Promise<BodySource> {
  if (typeof ref === 'string' && ref.length > 0) {
    // Staging failures are LETTER failures from every caller's point of view, so
    // they get translated rather than escaping as a 500: an expired ref is a 404
    // that says "upload it again", a path-shaped ref is a 400.
    let bytes: number;
    try {
      ({ bytes } = await statStagedBody(ref));
    } catch (err) {
      const e = err as { name?: string; code?: string; status?: number; message?: string };
      if (e?.name === 'StagedBodyError') {
        throw new LetterError(
          String(e.message),
          e.code === 'not_found' ? 'not_found' : 'invalid',
          typeof e.status === 'number' ? e.status : 400,
        );
      }
      throw err;
    }
    assertBodyBytes(bytes, field);
    return { kind: 'staged', ref, bytes };
  }
  const text = value as string;
  const bytes = Buffer.byteLength(text, 'utf-8');
  assertBodyBytes(bytes, field);
  return { kind: 'inline', text, bytes };
}

/** Enough of a staged body for derivePreview, which stops at 8000 chars anyway. */
const PREVIEW_PEEK_BYTES = 64 * 1024;

async function peekStagedBody(ref: string): Promise<string> {
  const { path: p } = await statStagedBody(ref);
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(PREVIEW_PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PREVIEW_PEEK_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Put a resolved body at its final name. Staged bodies MOVE (never copied up). */
async function commitBodySource(fileName: string, source: BodySource): Promise<void> {
  if (source.kind === 'inline') {
    await writeBodyFile(fileName, source.text);
    return;
  }
  await fsp.mkdir(BODIES_DIR, { recursive: true });
  await takeStagedBody(source.ref, path.join(BODIES_DIR, fileName));
}

/** What statLetterBody knows about one body document. */
export interface LetterBodyStat {
  path: string;
  /** Size on THIS box's disk, right now. */
  bytes: number;
  mtimeMs: number;
  format: 'html' | 'markdown';
  /**
   * Size the sender recorded in the index, or null for a letter written before
   * that was stamped. A box holding only a copy of the body (a cloud replica,
   * whose blob arrives over git-sync) compares `bytes` against this to tell a
   * complete copy from a half-synced one — see serveLetterBody.
   */
  recordedBytes: number | null;
}

/**
 * Stat a letter's body document without reading it — what the streaming route
 * needs to answer a Range, and what getLetter needs to decide whether to inline.
 * `turn` selects a thread entry's rich body instead of the letter's own.
 */
export async function statLetterBody(
  id: string,
  turn?: number,
): Promise<LetterBodyStat | null> {
  if (typeof id !== 'string' || !LETTER_ID_RE.test(id)) return null;
  const { letters } = await readStore();
  const record = letters.find(l => l.id === id);
  if (!record) return null;

  let fileName: string;
  let format: 'html' | 'markdown';
  let recordedBytes: number | null;
  if (turn === undefined) {
    format = record.bodyFormat;
    fileName = `${record.id}.${bodyExt(format)}`;
    recordedBytes = typeof record.bodyBytes === 'number' ? record.bodyBytes : null;
  } else {
    const entry = record.thread[turn];
    if (!entry?.bodyFile || !entry.bodyFormat) return null;
    format = entry.bodyFormat;
    fileName = entry.bodyFile;
    recordedBytes = typeof entry.bodyBytes === 'number' ? entry.bodyBytes : null;
  }
  // Same traversal guard as readBodyFile: the name came off a JSON index another
  // process wrote, so it is untrusted input even though we produced it.
  if (!BODY_FILE_RE.test(fileName)) {
    log.notif.warn('human-inbox: refusing suspicious body file name', { fileName });
    return null;
  }
  const full = path.join(BODIES_DIR, fileName);
  try {
    const st = await fsp.stat(full);
    if (!st.isFile()) return null;
    return { path: full, bytes: st.size, mtimeMs: st.mtimeMs, format, recordedBytes };
  } catch {
    return null;
  }
}

/**
 * Is the body document on THIS box's disk EXACTLY the document that was sent?
 *
 * Only interesting where the file is a COPY: on a cloud replica the blob arrives
 * over git-sync, so it can be absent (not pulled yet), short, or LONGER than what
 * was sent. Both wrong sizes have to fail, which is why this is `===` and not
 * `>=`: short is a half-synced file (a cut-off page, a truncated `<audio>`), and
 * long is a file something appended to — most plausibly git conflict markers,
 * which the sync's marker self-heal only repairs for JSON, so a markdown body
 * would keep them. Serving either as the document reads as a corrupt letter,
 * while relaying costs nothing but a round trip and returns the primary's clean
 * copy. Exact equality is safe because a body is WRITE-ONCE and `recordedBytes`
 * is the byte length of the source it was written from.
 *
 * Unknown recorded size (a letter written before the stamp existed) counts as
 * complete: there is nothing to compare against, and a present file is the only
 * evidence available.
 */
export function bodyStatIsComplete(stat: LetterBodyStat): boolean {
  return stat.recordedBytes === null || stat.bytes === stat.recordedBytes;
}

/**
 * Read one slice of a body document. The bounded primitive both chunked lanes
 * sit on (the replica's bridge relay, and any future incremental reader), so
 * nothing anywhere has to hold a 100MB body to serve part of it.
 */
export async function readLetterBodyRange(
  id: string,
  opts: { turn?: number; start?: number; length: number },
): Promise<{ data: Buffer; bytesRead: number; fileSize: number; eof: boolean; format: 'html' | 'markdown' } | null> {
  const stat = await statLetterBody(id, opts.turn);
  if (!stat) return null;
  const start = Math.max(0, Math.trunc(opts.start ?? 0));
  if (start >= stat.bytes) {
    return { data: Buffer.alloc(0), bytesRead: 0, fileSize: stat.bytes, eof: true, format: stat.format };
  }
  const toRead = Math.min(Math.max(1, Math.trunc(opts.length)), stat.bytes - start);
  const fh = await fsp.open(stat.path, 'r');
  try {
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, start);
    return {
      data: buf.subarray(0, bytesRead),
      bytesRead,
      fileSize: stat.bytes,
      eof: start + bytesRead >= stat.bytes,
      format: stat.format,
    };
  } finally {
    await fh.close().catch(() => {});
  }
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
  const htmlRef = str(input.htmlRef ?? input.html_ref ?? '');
  const hasHtml = typeof input.html === 'string' && input.html.length > 0;
  const hasHtmlRef = htmlRef.length > 0;
  const hasMarkdown = typeof input.markdown === 'string' && input.markdown.length > 0;
  const bodyLanes = [hasHtml, hasHtmlRef, hasMarkdown].filter(Boolean).length;
  if (bodyLanes !== 1) {
    throw invalid('exactly one of html | html_ref | markdown is required');
  }
  const actions = input.actions;
  // An action_required letter with no buttons is a dead end: the reader shows a
  // subject and a decision badge with nothing to decide with, and the human is
  // left guessing what the options even were (2026-08-30, a real letter). The
  // type is the PROMISE of an affordance, so it is required here rather than
  // patched over in each reader.
  if (input.type === 'action_required') {
    if (!Array.isArray(actions) || actions.length === 0) {
      throw invalid(
        'action_required needs at least one action in `actions` — that is what the human taps; '
        + 'use type=review or info if the human only needs to read this',
      );
    }
  } else if (actions !== undefined) {
    throw invalid('actions are only allowed when type is action_required');
  }
  if (actions !== undefined) {
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

  const bodyFormat = hasMarkdown ? 'markdown' : 'html';
  const bodySource = await resolveBodySource(
    hasMarkdown ? input.markdown : input.html,
    hasHtmlRef ? htmlRef : undefined,
    bodyFormat,
  );
  // The preview only ever reads the first few thousand chars (derivePreview), so
  // a staged body is peeked at rather than loaded — the whole point of the lane.
  const previewSource = bodySource.kind === 'inline'
    ? bodySource.text
    : await peekStagedBody(bodySource.ref);

  const id = generateId();
  const record: LetterRecord = {
    id,
    subject: truncatePreview(subject, 200),
    type: input.type,
    bodyFormat,
    textPreview: derivePreview({
      text: input.text,
      ...(bodyFormat === 'html' ? { html: previewSource } : { markdown: previewSource }),
    }),
    sender: normalizeSender(input.sender),
    createdAt: Date.now(),
    read: false,
    pinned: input.pin === true,
    archived: false,
    // Recorded from the source, not from a later stat: this is the number a box
    // that only holds a COPY of the body compares its own file against.
    bodyBytes: bodySource.bytes,
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
  await commitBodySource(`${id}.${bodyExt(bodyFormat)}`, bodySource);
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
/**
 * One letter, with its documents.
 *
 * A body over `inlineMaxBytes` is DEFERRED rather than embedded: the reply
 * carries `bodyBytes` + `bodyUrl` and the reader streams the document from
 * `GET /api/v1/human-inbox/:id/body`. That is what lets the html cap be 100MB —
 * the size of a letter's media stops deciding the size of this JSON, so no hop
 * on the way to the phone ever has to frame the whole thing.
 *
 * Pass `inlineMaxBytes: Infinity` for a caller that genuinely wants the bytes in
 * process (the store's own tests, an export).
 */
export async function getLetter(
  id: string,
  opts: { inlineMaxBytes?: number } = {},
): Promise<LetterDetail | null> {
  if (typeof id !== 'string' || !LETTER_ID_RE.test(id)) return null;
  const { letters } = await readStore();
  const record = letters.find(l => l.id === id);
  if (!record) return null;
  const inlineMax = opts.inlineMaxBytes ?? LETTER_INLINE_BODY_MAX_BYTES;

  const ownStat = await statLetterBody(id);
  const deferOwn = ownStat !== null && ownStat.bytes > inlineMax;
  const body = deferOwn ? null : await readBodyFile(`${record.id}.${bodyExt(record.bodyFormat)}`);

  const thread: LetterThreadEntry[] = [];
  for (const [turn, entry] of record.thread.entries()) {
    if (!entry.bodyFile) { thread.push({ ...entry }); continue; }
    const turnStat = await statLetterBody(id, turn);
    if (turnStat !== null && turnStat.bytes > inlineMax) {
      thread.push({
        ...entry,
        bodyBytes: turnStat.bytes,
        bodyDeferred: true,
        bodyUrl: letterBodyUrl(id, turn),
      });
      continue;
    }
    const turnBody = await readBodyFile(entry.bodyFile);
    thread.push(turnBody === null
      ? { ...entry, bodyMissing: true }
      // Recorded size stays when the file is gone: spreading `undefined` over it
      // would erase the one number a reader can check its own copy against.
      : { ...entry, body: turnBody, ...(turnStat ? { bodyBytes: turnStat.bytes } : {}) });
  }

  if (deferOwn) {
    return {
      ...record,
      thread,
      bodyBytes: ownStat.bytes,
      bodyDeferred: true,
      bodyUrl: letterBodyUrl(id),
    };
  }
  return {
    ...record,
    thread,
    body: body ?? missingBodyNote(record.bodyFormat),
    ...(ownStat ? { bodyBytes: ownStat.bytes } : {}),
    ...(body === null ? { bodyMissing: true } : {}),
  };
}

/** The streaming route for one document. Relative — the caller's own origin. */
export function letterBodyUrl(id: string, turn?: number): string {
  const base = `/api/v1/human-inbox/${encodeURIComponent(id)}/body`;
  return turn === undefined ? base : `${base}?turn=${turn}`;
}

/** Find-or-throw helper for the mutators, all of which run under the lock. */
function find(store: LetterStoreFile, id: string): LetterRecord {
  const record = store.letters.find(l => l.id === id);
  if (!record) throw notFound(id);
  return record;
}

/**
 * Move the read flag and stamp WHEN it moved. The ONE place `read` is assigned,
 * so the stamp cannot drift from the flag.
 *
 * `readAt` has NO consumer today — the merge between two copies of this file is
 * decided by the index's top-level `lastUpdated`, not by any per-letter field. It
 * is written because `read` is a bare boolean with no order of its own, and that
 * history cannot be recovered after the fact; the first reader that wants it
 * (per-letter read history in a mobile reader) needs it already on disk. No stamp
 * when the value is unchanged: re-opening an already-read letter is not news.
 */
function setReadFlag(letter: LetterRecord, read: boolean): void {
  if (letter.read === read) return;
  letter.read = read;
  letter.readAt = Date.now();
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
  const htmlRef = str(input.htmlRef ?? input.html_ref ?? '');
  const hasHtml = typeof input.html === 'string' && input.html.length > 0;
  const hasHtmlRef = htmlRef.length > 0;
  const hasMarkdown = typeof input.markdown === 'string' && input.markdown.length > 0;
  if ([hasHtml, hasHtmlRef, hasMarkdown].filter(Boolean).length > 1) {
    throw invalid('pass at most one of html | html_ref | markdown');
  }
  const richFormat = hasMarkdown ? 'markdown' : 'html';
  const richSource = (hasHtml || hasHtmlRef || hasMarkdown)
    ? await resolveBodySource(
      hasMarkdown ? input.markdown : input.html,
      hasHtmlRef ? htmlRef : undefined,
      richFormat,
    )
    : null;

  // The turn index names the body file, so it has to be assigned under the lock.
  let bodyFileToWrite: string | null = null;
  const record = await withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    const entry: ThreadEntry = { from: 'agent', text: boundThreadText(text), at: Date.now() };
    if (richSource !== null) {
      bodyFileToWrite = `${letter.id}.r${letter.thread.length}.${bodyExt(richFormat)}`;
      entry.bodyFormat = richFormat;
      entry.bodyFile = bodyFileToWrite;
      entry.bodyBytes = richSource.bytes;
    }
    letter.thread.push(entry);
    setReadFlag(letter, false);
    letter.archived = false;
    return { ...letter };
  }));
  if (bodyFileToWrite && richSource !== null) await commitBodySource(bodyFileToWrite, richSource);

  log.notif.info('human-inbox: agent replied', { letterId: id, turns: record.thread.length });
  emitLetterEvent(record, 'reply', truncatePreview(text));
  return record;
}

export async function setRead(id: string, read: boolean): Promise<LetterRecord> {
  requireValidId(id);
  const record = await withWriteLock(() => withStore((store) => {
    const letter = find(store, id);
    setReadFlag(letter, read === true);
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
    setReadFlag(letter, true);
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
    setReadFlag(letter, true);
    letter.archived = false;
    return { ...letter };
  }));
  void mirrorLetterReadState(record.id, true);
  return record;
}

/** Paths, for tests and for anything that needs to point at the store on disk. */
export const humanInboxPaths = { dir: INBOX_DIR, indexFile: INDEX_FILE, bodiesDir: BODIES_DIR };
