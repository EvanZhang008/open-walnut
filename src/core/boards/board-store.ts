/**
 * Task Board store: one HTML document per task, plus the small side state the
 * web UI and the task's sessions share (chat threads and a human's marks).
 *
 * One JSON file per task at `WALNUT_HOME/boards/<taskId>.json`. Every write goes
 * through `updateJsonFile` (cross-process lock, atomic rename), because a board
 * has several writers at once: the leader's session, its workers' sessions and
 * the human in the browser. A write that fails validation throws inside the
 * locked mutate, so nothing reaches disk.
 *
 * `version` counts html changes only (set / edit); thread posts and marks never
 * bump it, so a writer's optimistic `expectVersion` is not broken by chat.
 *
 * Every change emits BOARD_CHANGED (envelope only) to the web UI.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import type { BoardChangedEvent } from '../event-types.js';

export const BOARD_HTML_MAX_BYTES = 1024 * 1024;
export const BOARD_MESSAGE_MAX_BYTES = 8 * 1024;
export const BOARD_NOTE_MAX_BYTES = 4 * 1024;
export const BOARD_STATE_MAX_CHARS = 64;
/** Thread and mark ids (they are attribute values the board's author picks). */
export const BOARD_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A task id is a file name here: no separators, no leading dot. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type BoardWriter = 'human' | `task:${string}`;
export type BoardAuthor = 'user' | `task:${string}`;

export interface BoardMessage {
  id: string;
  author: BoardAuthor;
  text: string;
  ts: string;
}

export interface BoardMark {
  state?: string;
  note?: string;
  updated_at: string;
}

export interface BoardFile {
  task_id: string;
  html: string;
  version: number;
  updated_at: string;
  updated_by: BoardWriter;
  threads: Record<string, BoardMessage[]>;
  marks: Record<string, BoardMark>;
}

export interface BoardEdit {
  old: string;
  new: string;
}

const DEFAULT_MESSAGES: Record<string, string> = {
  no_board: 'This task has no board yet',
  bad_id: 'Invalid id',
  bad_request: 'Invalid request',
  board_too_large: `Board html is larger than ${BOARD_HTML_MAX_BYTES} bytes`,
  message_too_long: `Message text is longer than ${BOARD_MESSAGE_MAX_BYTES} bytes`,
  note_too_long: `Mark note is longer than ${BOARD_NOTE_MAX_BYTES} bytes`,
  board_version_conflict: 'The board changed since that version: re-read it and retry',
  board_edit_not_found: 'An edit\'s `old` text does not occur in the board',
  board_edit_not_unique: 'An edit\'s `old` text occurs more than once in the board',
  not_in_team: 'Only the board task\'s own session or its subtasks\' sessions may write this board',
  human_only: 'Only a human may do this',
};

/** A store failure that carries the HTTP status and details the route answers with. */
export class BoardError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details?: Record<string, unknown>,
    message?: string,
  ) {
    super(message ?? DEFAULT_MESSAGES[code] ?? code);
    this.name = 'BoardError';
  }
}

function boardsDir(): string {
  return path.join(WALNUT_HOME, 'boards');
}

function boardFile(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new BoardError('bad_id', 400, { id: taskId }, `Invalid task id: ${taskId}`);
  return path.join(boardsDir(), `${taskId}.json`);
}

function checkItemId(id: string, what: 'thread' | 'mark'): void {
  if (typeof id !== 'string' || !BOARD_ITEM_ID_RE.test(id)) {
    throw new BoardError('bad_id', 400, { [what]: id },
      `Invalid ${what} id (letters, digits and . _ : -, at most 128, starting with a letter or digit)`);
  }
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

function checkHtml(html: unknown): asserts html is string {
  if (typeof html !== 'string') throw new BoardError('bad_request', 400, undefined, '`html` must be a string');
  if (bytes(html) > BOARD_HTML_MAX_BYTES) {
    throw new BoardError('board_too_large', 413, { max: BOARD_HTML_MAX_BYTES, bytes: bytes(html) });
  }
}

function checkVersion(current: BoardFile | null, expectVersion: number | undefined): void {
  if (expectVersion === undefined) return;
  const version = current?.version ?? 0;
  if (version !== expectVersion) throw new BoardError('board_version_conflict', 409, { version });
}

/** A file written by hand or by an older build: missing maps become empty. */
function normalize(raw: BoardFile | null, taskId: string): BoardFile | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    task_id: raw.task_id || taskId,
    html: typeof raw.html === 'string' ? raw.html : '',
    version: Number.isInteger(raw.version) ? raw.version : 1,
    updated_at: raw.updated_at || new Date(0).toISOString(),
    updated_by: raw.updated_by || 'human',
    threads: raw.threads && typeof raw.threads === 'object' ? raw.threads : {},
    marks: raw.marks && typeof raw.marks === 'object' ? raw.marks : {},
  };
}

function emitChanged(event: BoardChangedEvent): void {
  bus.emit(EventNames.BOARD_CHANGED, event, ['web-ui'], { source: 'board-store' });
}

/** Locked read-modify-write of one board; `mutate` throwing writes nothing. */
async function updateBoard(
  taskId: string,
  mutate: (current: BoardFile | null) => BoardFile,
): Promise<BoardFile> {
  const file = boardFile(taskId);
  const next = await updateJsonFile<BoardFile | null>(file, null, (raw) => mutate(normalize(raw, taskId)));
  return next as BoardFile;
}

function requireBoard(current: BoardFile | null): BoardFile {
  if (!current) throw new BoardError('no_board', 404);
  return current;
}

export async function getBoard(taskId: string): Promise<BoardFile | null> {
  return normalize(await readJsonFile<BoardFile | null>(boardFile(taskId), null), taskId);
}

/** Replace the whole document (creates the board when it has none). */
export async function setBoardHtml(
  taskId: string,
  html: string,
  opts: { by: BoardWriter; expectVersion?: number },
): Promise<BoardFile> {
  checkHtml(html);
  const next = await updateBoard(taskId, (current) => {
    checkVersion(current, opts.expectVersion);
    return {
      task_id: taskId,
      html,
      version: (current?.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
      updated_by: opts.by,
      threads: current?.threads ?? {},
      marks: current?.marks ?? {},
    };
  });
  emitChanged({ taskId, kind: 'html', version: next.version });
  return next;
}

/** Occurrences of `needle` in `hay`, overlapping ones included (any of them makes the anchor ambiguous). */
function countOccurrences(hay: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (first === -1) first = at;
    count += 1;
  }
  return { count, first };
}

/**
 * Apply exact-string edits in order, each against the result of the previous
 * one. Every `old` must occur exactly once at its turn; the first that does not
 * throws, so a caller that discards the throw keeps the original html.
 */
export function applyBoardEdits(html: string, edits: BoardEdit[]): string {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new BoardError('bad_request', 400, undefined, '`edits` must be a non-empty array of { old, new }');
  }
  let out = html;
  edits.forEach((edit, index) => {
    if (!edit || typeof edit !== 'object' || typeof edit.old !== 'string' || typeof edit.new !== 'string') {
      throw new BoardError('bad_request', 400, { index }, `edits[${index}] must be { old: string, new: string }`);
    }
    if (edit.old === '') {
      throw new BoardError('bad_request', 400, { index }, `edits[${index}].old must not be empty`);
    }
    const { count, first } = countOccurrences(out, edit.old);
    if (count === 0) throw new BoardError('board_edit_not_found', 409, { index });
    if (count > 1) throw new BoardError('board_edit_not_unique', 409, { index, count });
    // Slice, never String.replace: `$&` / `$1` in the new text must stay literal.
    out = out.slice(0, first) + edit.new + out.slice(first + edit.old.length);
  });
  return out;
}

export async function editBoardHtml(
  taskId: string,
  edits: BoardEdit[],
  opts: { by: BoardWriter; expectVersion?: number },
): Promise<BoardFile> {
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    checkVersion(current, opts.expectVersion);
    const html = applyBoardEdits(current.html, edits);
    checkHtml(html);
    return {
      ...current,
      html,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
      updated_by: opts.by,
    };
  });
  emitChanged({ taskId, kind: 'html', version: next.version });
  return next;
}

export async function postBoardMessage(
  taskId: string,
  thread: string,
  input: { author: BoardAuthor; text: string },
): Promise<BoardMessage> {
  checkItemId(thread, 'thread');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new BoardError('bad_request', 400, undefined, '`text` must be a non-empty string');
  if (bytes(text) > BOARD_MESSAGE_MAX_BYTES) {
    throw new BoardError('message_too_long', 413, { max: BOARD_MESSAGE_MAX_BYTES });
  }
  let message: BoardMessage | undefined;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const list = current.threads[thread] ?? [];
    // Never earlier than the message before it, so ts order is append order.
    const now = new Date().toISOString();
    const last = list[list.length - 1]?.ts;
    message = {
      id: `bm-${crypto.randomBytes(6).toString('hex')}`,
      author: input.author,
      text,
      ts: last && last > now ? last : now,
    };
    return { ...current, threads: { ...current.threads, [thread]: [...list, message] } };
  });
  emitChanged({ taskId, kind: 'thread', thread, version: next.version });
  return message!;
}

/** Replace one mark; a mark with neither a state nor a note is removed (returns null). */
export async function setBoardMark(
  taskId: string,
  markId: string,
  input: { state?: string | null; note?: string | null },
): Promise<BoardMark | null> {
  checkItemId(markId, 'mark');
  const state = typeof input.state === 'string' ? input.state.trim() : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (state.length > BOARD_STATE_MAX_CHARS) {
    throw new BoardError('bad_request', 400, { max: BOARD_STATE_MAX_CHARS },
      `Mark state is longer than ${BOARD_STATE_MAX_CHARS} characters`);
  }
  if (bytes(note) > BOARD_NOTE_MAX_BYTES) throw new BoardError('note_too_long', 413, { max: BOARD_NOTE_MAX_BYTES });
  const mark: BoardMark | null = state || note
    ? { ...(state ? { state } : {}), ...(note ? { note } : {}), updated_at: new Date().toISOString() }
    : null;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const marks = { ...current.marks };
    if (mark) marks[markId] = mark;
    else delete marks[markId];
    return { ...current, marks };
  });
  emitChanged({ taskId, kind: 'mark', mark: markId, version: next.version });
  return mark;
}

/** Remove a task's board. Idempotent: false when there was none. */
export async function deleteBoard(taskId: string): Promise<boolean> {
  const file = boardFile(taskId);
  const existed = await withFileLock(file, async () => {
    try {
      await fsp.rm(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  });
  if (existed) emitChanged({ taskId, kind: 'deleted', version: 0 });
  return existed;
}

// ── Task deletion takes its board with it ──

const BOARD_SUBSCRIBER = 'board-store';

function onTaskDeleted(event: BusEvent): void {
  const data = event.data as { id?: string; task?: { id?: string } } | undefined;
  const taskId = data?.task?.id ?? data?.id;
  if (!taskId || !TASK_ID_RE.test(taskId)) return;
  void deleteBoard(taskId).catch((err) => {
    log.task.warn('could not delete the board of a deleted task', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Subscribe board cleanup to task deletion (server boot, primary only: a
 * replica's boards arrive by data sync, and its deletes would sync back).
 * Global, because sync pulls and plugins announce deletions with no destination.
 */
export function initBoardStore(): void {
  if (CLOUD_MODE) return;
  bus.subscribe(BOARD_SUBSCRIBER, onTaskDeleted, { global: true, interest: [EventNames.TASK_DELETED] });
}

export function stopBoardStore(): void {
  bus.unsubscribe(BOARD_SUBSCRIBER);
}

/** Test seam: where a task's board lives. */
export function _boardFilePath(taskId: string): string {
  return boardFile(taskId);
}

// ── Reading the html: the Walnut components a board names ──

/** One start tag's attribute text; quoted values may contain `>`. */
function startTags(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'gi');
  const out: string[] = [];
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1]);
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#39|#34);/g, (_, e: string) => (
    { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"' } as Record<string, string>
  )[e]);
}

/**
 * A start tag's attributes, tokenized left to right the way a browser reads
 * them: a quoted value is consumed whole, so `title="see id='x'"` never answers
 * for `id`, and `data-id` is its own name. The first of a duplicate wins.
 */
function parseAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(attrs); m; m = re.exec(attrs)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim());
  }
  return out;
}

/** Task ids named by `<walnut-task id="…">`, in document order, each once. */
export function extractTaskRefs(html: string): string[] {
  const seen = new Set<string>();
  for (const attrs of startTags(html, 'walnut-task')) {
    const id = parseAttrs(attrs).get('id');
    if (id) seen.add(id);
  }
  return [...seen];
}

export interface BoardThreadMeta {
  title?: string;
  task?: string;
}

/** The `title` / `task` of the `<walnut-thread id="threadId">` tag, or null when the html has none. */
export function threadMeta(html: string, threadId: string): BoardThreadMeta | null {
  for (const attrs of startTags(html, 'walnut-thread')) {
    const parsed = parseAttrs(attrs);
    if (parsed.get('id') !== threadId) continue;
    const title = parsed.get('title');
    const task = parsed.get('task');
    return { ...(title ? { title } : {}), ...(task ? { task } : {}) };
  }
  return null;
}
