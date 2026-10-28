/**
 * Task Board store: one HTML document per task, plus the small side state the
 * web UI and the task's sessions share: chat threads, the user's marks, the
 * board projects (one area of this board each, not Walnut projects) and their
 * status, the user's read ticks on points, the user's answers to choices,
 * reminders, and the sections the user has seen (writers for these in
 * board-items.ts; the html readers in board-html.ts).
 *
 * One JSON file per task at `WALNUT_HOME/boards/<taskId>.json`. Every write goes
 * through `updateJsonFile` (cross-process lock, atomic rename), because a board
 * has several writers at once: the leader's session, its workers' sessions and
 * the human in the browser. A write that fails validation throws inside the
 * locked mutate, so nothing reaches disk.
 *
 * `version` counts html changes only (set / edit); thread posts, marks and the
 * other side state never bump it, so a writer's `expectVersion` is not broken by chat.
 *
 * Every change emits BOARD_CHANGED (envelope only) to the web UI.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { bootPolicy } from '../boot-policy.js';
import { isCompanion } from '../server-role.js';
import { NeedsLeaderError } from '../replication/needs-leader.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import type { BoardChangedEvent } from '../event-types.js';
import { BOARD_ITEM_ID_RE, own } from './board-html.js';
import {
  isLaneTemplateId, normalizeCards, normalizeKanbanSeen, normalizeLanes,
  type BoardCard, type BoardKanbanSeen, type BoardLane, type LaneTemplateId,
} from './board-lanes.js';

export {
  BOARD_ITEM_ID_RE,
  checkHashes,
  choiceSpecs,
  extractTaskRefs,
  threadMeta,
  type BoardChoiceSpec,
  type BoardThreadMeta,
} from './board-html.js';

export const BOARD_HTML_MAX_BYTES = 1024 * 1024;
export const BOARD_MESSAGE_MAX_BYTES = 8 * 1024;
export const BOARD_NOTE_MAX_BYTES = 4 * 1024;
/** A choice answered in the user's own words: the same room as a thread message. */
export const BOARD_CHOICE_TEXT_MAX_BYTES = BOARD_MESSAGE_MAX_BYTES;
export const BOARD_STATE_MAX_CHARS = 64;
/** A task id is a file name here: no separators, no leading dot. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Thread message ids, as postBoardMessage makes them (`bm-` + 12 hex). */
const MESSAGE_ID_RE = /^bm-[a-f0-9]{6,32}$/;

/**
 * Who wrote: the user ('human'), a session's task (`task:<id>`), or an agent Walnut
 * could not place ('agent': a session with no task, an env-less `walnut`). Every
 * action the user takes on a Board an agent may take too (2026-10-27, the user:
 * "all human action can be done by agent also"); the record says who did.
 */
export type BoardWriter = 'human' | 'agent' | `task:${string}`;
/** A thread post's author: the user, a session's task, or an agent with no task ('agent'). */
export type BoardAuthor = 'user' | 'agent' | `task:${string}`;

/**
 * Who wrote a record the user also writes (a read tick, a choice answer, a section
 * seen), and their name as the user reads it ("the CEO", "the Growth VP",
 * `the task "..."`). On the record a human's write leaves neither field: a record
 * with no `by` is the user's, as every record an older Walnut wrote is.
 */
export interface BoardWriterStamp {
  by: BoardWriter;
  by_name?: string;
}

/** True for the user's own record: no writer stamped, or 'human'. */
export function isUsers(by: BoardWriter | undefined): boolean {
  return !by || by === 'human';
}

/**
 * The refusal for an agent changing what the user wrote (a post, an answer, a
 * mark, a reminder) without saying the user asked for it: 409 user_wrote. The
 * user's own words and marks stay theirs until then.
 */
export function userWrote(what: string, details: Record<string, unknown>): BoardError {
  return new BoardError('user_wrote', 409, { ...details, author: 'user' },
    `This is the user's own ${what}: pass override_user: true to change it, only when the user asked for that`);
}

/** The fields `writer` leaves on such a record: none for the user, `by` (and `by_name`) for an agent. */
export function agentStamp(writer: BoardWriterStamp | undefined): Partial<BoardWriterStamp> {
  if (!writer || writer.by === 'human') return {};
  return { by: writer.by, ...(writer.by_name ? { by_name: writer.by_name } : {}) };
}

export interface BoardMessage {
  id: string;
  author: BoardAuthor;
  text: string;
  ts: string;
}

/** A note on the page. No `by`: the user wrote it (every mark before 2026-10-27 is the user's). */
export interface BoardMark {
  state?: string;
  note?: string;
  updated_at: string;
  /** An agent wrote it (agentStamp). */
  by?: BoardWriter;
  by_name?: string;
}

export const BOARD_PROJECT_STATUSES = ['decide', 'wip', 'wait', 'done'] as const;
export type BoardProjectStatus = typeof BOARD_PROJECT_STATUSES[number];

/**
 * A board project: one area of THIS board (one cause, one ticket), not a Walnut
 * project (a task's `project` field). Owned by Walnut, so its status recolors
 * every `data-project` element on the page.
 */
export interface BoardProject {
  title?: string;
  status?: BoardProjectStatus;
  /** Full task ids, in the order given. */
  tasks?: string[];
  /** What this area is, in a sentence or three (the Overview card's first paragraph). */
  summary?: string;
  /** The latest update; `latest_at` is when it last changed (stamped by Walnut). */
  latest?: string;
  latest_at?: string;
  /** The next step. */
  next?: string;
  /** What it waits on (a short tag beside the title). */
  waiting?: string;
  /** A short note at the end of the title row ("6 tickets"). */
  meta?: string;
  updated_at: string;
  updated_by: BoardWriter;
  /** Who last changed the status (the user picks one on the page too), and when. */
  status_by?: BoardWriter;
  status_at?: string;
}

/** A read tick on a `<walnut-check>` point: the hash of the version read. No `by`: the user ticked it. */
export interface BoardCheck {
  hash: string;
  read_at: string;
  /** An agent ticked it (agentStamp). */
  by?: BoardWriter;
  by_name?: string;
}

/** The answer to a `<walnut-choice>`, the user's or an agent's. */
export interface BoardChoice {
  /** The option picked; '' when the answer is words alone. */
  option: string;
  label?: string;
  at: string;
  /** Who picked the option (agentStamp; absent = the user). */
  by?: BoardWriter;
  by_name?: string;
  /** Words beside a pick or instead of one. */
  text?: string;
  text_at?: string;
  /** Who wrote the words (absent = the user). */
  text_by?: BoardWriter;
  text_by_name?: string;
  /**
   * The last delivery of this answer to the board task's session did not go out
   * (a failed send, a COMPLETE task): the same answer given again is delivered
   * again instead of answering `unchanged`. Cleared once one goes out.
   */
  undelivered?: true;
}

/** "Remind me later" on a choice or a thread (one per target). The clock is board-reminders.ts. */
export interface BoardReminder {
  at: string;
  set_at: string;
  set_by: BoardWriter;
  note?: string;
  /** When it came due and Walnut acted on it. */
  fired_at?: string;
  /** When the message reached the board task's session. */
  delivered_at?: string;
  /** Failed deliveries so far (bounded; see board-reminders.ts). */
  attempts?: number;
}

/** A section seen in this version (the frame hashes the section's text; the server only keeps it). */
export interface BoardSectionSeen {
  hash: string;
  at: string;
  /** An agent marked it seen (only in `section_seen_agent`; absent = the user). */
  by?: BoardWriter;
}

export interface BoardFile {
  task_id: string;
  html: string;
  version: number;
  updated_at: string;
  updated_by: BoardWriter;
  threads: Record<string, BoardMessage[]>;
  marks: Record<string, BoardMark>;
  projects: Record<string, BoardProject>;
  checks: Record<string, BoardCheck>;
  choices: Record<string, BoardChoice>;
  reminders: Record<string, BoardReminder>;
  /** The user's: what "Changed since you last looked" counts from. Only the user moves it. */
  section_seen: Record<string, BoardSectionSeen>;
  /** Sections an agent marked seen (each with `by`), kept apart so the user's baseline stays theirs. */
  section_seen_agent?: Record<string, BoardSectionSeen>;
  /** Kanban (board-kanban.ts; never bumps `version`): stored lanes, null = still on the template. */
  lanes: BoardLane[] | null;
  lanes_template?: LaneTemplateId;
  lanes_at?: string;
  lanes_by?: BoardWriter;
  /** Key = full task id of a card's (sub)task. */
  cards: Record<string, BoardCard>;
  /** The user's "Changed" baseline (board-kanban-seen.ts); null = never looked. Only the user moves it. */
  kanban_seen: BoardKanbanSeen | null;
  /** The last agent's baseline (with `by`), kept apart from the user's. */
  kanban_seen_agent?: BoardKanbanSeen | null;
}

/** Fired, or its time has passed: the user sees it as due until they act on that item. */
export function reminderIsDue(reminder: Pick<BoardReminder, 'at' | 'fired_at'>, nowMs = Date.now()): boolean {
  if (reminder.fired_at) return true;
  const at = Date.parse(reminder.at);
  return Number.isFinite(at) && at <= nowMs;
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
  answer_too_long: `A choice's written answer is longer than ${BOARD_CHOICE_TEXT_MAX_BYTES} bytes`,
  board_version_conflict: 'The board changed since that version: re-read it and retry',
  board_edit_not_found: 'An edit\'s `old` text does not occur in the board',
  board_edit_not_unique: 'An edit\'s `old` text occurs more than once in the board',
  message_not_found: 'No such message in that thread',
  bad_status: 'A project status is one of decide, wip, wait, done (or "" to clear)',
  bad_task: 'Unknown task',
  check_not_found: 'No <walnut-check> with that id on the board',
  check_changed: 'That point changed since it was shown: read it again',
  choice_not_found: 'No <walnut-choice> with that id on the board',
  bad_option: 'That option is not one of the choice\'s options',
  target_not_found: 'No <walnut-choice> or <walnut-thread> with that id on the board',
  bad_time: '`at` must be an ISO-8601 time in the future, at most 90 days out',
  too_many: 'This board has too many of these',
  user_wrote: 'This is the user\'s own post: pass override_user: true to delete it, only when the user asked for that',
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

/**
 * Where a READ of boards looks: on the companion, its copy of the Mac's boards
 * (docs/plan/walnut-companion-unified-replica.md, stage 2b); elsewhere this
 * server's own dir. Writes always name boardFile: nothing on the companion writes
 * a board (its board writes answer 501, no board job runs there).
 *
 * Boards the user turned off for a replica (a host's or the companion's) answer
 * needs_leader {why:'not_kept_here'} (gate.ts assertCopyKept): its dir holds none.
 * The companion holding no copy (before the first round, an older Mac) answers
 * needs_leader {why:'kind_not_copied'}, never the files git sync wrote into its data
 * dir: those stop being written (stage 4d), and a board read from them would show
 * the Mac's board as it once was.
 */
async function readBoardsDir(): Promise<string> {
  const gate = await import('../replication/kinds/gate.js');
  if (!gate.keepsCopies('boards')) return boardsDir();
  await gate.assertCopyKept('boards');
  if (!isCompanion()) return boardsDir();
  if (!(await gate.copyKindHeld('boards'))) throw new NeedsLeaderError(gate.KIND_NOT_COPIED);
  return gate.copyPath(boardsDir());
}

async function readBoardFile(taskId: string): Promise<string> {
  return path.join(await readBoardsDir(), path.basename(boardFile(taskId)));
}

/** The names of every board on disk (the reminder clock's boot scan). */
export async function listBoardTaskIds(): Promise<string[]> {
  // No boards kept here (turned off, or no copy yet): none to scan.
  const dir = await readBoardsDir().catch(() => null);
  if (!dir) return [];
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter((id) => TASK_ID_RE.test(id));
}

/** True when the task has a board file (no parse: the team-owner walk asks this per ancestor). */
export async function hasBoard(taskId: string): Promise<boolean> {
  const file = await readBoardFile(taskId);
  return fsp.stat(file).then((s) => s.isFile(), () => false);
}

/**
 * Whether a board holds anything a person or an agent wrote: a page, a thread,
 * a mark, a project, a check, a choice, a reminder, lanes someone edited, or a
 * card someone placed, summarized or set waiting. The server's own kanban
 * bookkeeping does not count (a materialized lane template, a card's
 * `lane_auto` / `handed_back_at` / `output_at` stamps), and neither does only
 * looking (`kanban_seen`, `section_seen`): 2026-10-26, a plain task whose Board
 * tab was once opened owned an otherwise empty board file, and a lead's board
 * file fills with automatic card stamps as its workers report.
 */
export function boardHasContent(board: BoardFile | null): boolean {
  if (!board) return false;
  if (board.html.trim()) return true;
  if (board.lanes && board.lanes_by) return true;
  if ([board.threads, board.marks, board.projects, board.checks, board.choices, board.reminders]
    .some((m) => Object.keys(m ?? {}).length > 0)) return true;
  return Object.values(board.cards ?? {}).some((c) => !!(c.lane_by || c.rank != null || c.summary_by || c.waiting_on_by || c.lane_suggested));
}

export type BoardItemKind = 'thread' | 'mark' | 'project' | 'check' | 'choice' | 'target' | 'section';

/** For the writers in this directory: an item id must follow BOARD_ITEM_ID_RE. */
export function checkItemId(id: string, what: BoardItemKind): void {
  if (typeof id !== 'string' || !BOARD_ITEM_ID_RE.test(id)) {
    throw new BoardError('bad_id', 400, { [what]: id },
      `Invalid ${what} id (letters, digits and . _ : -, at most 128, starting with a letter or digit)`);
  }
}

export function bytes(s: string): number {
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

function map<T>(v: unknown): Record<string, T> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, T> : {};
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
    threads: map(raw.threads),
    marks: map(raw.marks),
    projects: map(raw.projects),
    checks: map(raw.checks),
    choices: map(raw.choices),
    reminders: map(raw.reminders),
    section_seen: map(raw.section_seen),
    ...(Object.keys(map(raw.section_seen_agent)).length ? { section_seen_agent: map<BoardSectionSeen>(raw.section_seen_agent) } : {}),
    lanes: normalizeLanes(raw.lanes),
    ...(isLaneTemplateId(raw.lanes_template) ? { lanes_template: raw.lanes_template } : {}),
    ...(typeof raw.lanes_at === 'string' && raw.lanes_at ? { lanes_at: raw.lanes_at } : {}),
    ...(raw.lanes_by ? { lanes_by: raw.lanes_by } : {}),
    cards: normalizeCards(raw.cards),
    kanban_seen: normalizeKanbanSeen(raw.kanban_seen),
    ...(raw.kanban_seen_agent ? { kanban_seen_agent: normalizeKanbanSeen(raw.kanban_seen_agent) } : {}),
  };
}

/** A board with no page yet: what the first lane, card or seen write creates (html '', version 0). */
export function emptyBoard(taskId: string, by: BoardWriter): BoardFile {
  return {
    task_id: taskId, html: '', version: 0, updated_at: new Date().toISOString(), updated_by: by,
    threads: {}, marks: {}, projects: {}, checks: {}, choices: {}, reminders: {}, section_seen: {},
    lanes: null, cards: {}, kanban_seen: null,
  };
}

/** For the writers in this directory. */
export function emitChanged(event: BoardChangedEvent): void {
  bus.emit(EventNames.BOARD_CHANGED, event, ['web-ui'], { source: 'board-store' });
}

/** Locked read-modify-write of one board; `mutate` throwing writes nothing. For the writers in this directory. */
export async function updateBoard(
  taskId: string,
  mutate: (current: BoardFile | null) => BoardFile,
): Promise<BoardFile> {
  const file = boardFile(taskId);
  const next = await updateJsonFile<BoardFile | null>(file, null, (raw) => mutate(normalize(raw, taskId)));
  return next as BoardFile;
}

/** A copy of `m` without `key`. */
export function withoutKey<T>(m: Record<string, T>, key: string): Record<string, T> {
  const out = { ...m };
  delete out[key];
  return out;
}

export function requireBoard(current: BoardFile | null): BoardFile {
  if (!current) throw new BoardError('no_board', 404);
  return current;
}

export async function getBoard(taskId: string): Promise<BoardFile | null> {
  return normalize(await readJsonFile<BoardFile | null>(await readBoardFile(taskId), null), taskId);
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
      threads: {},
      marks: {},
      projects: {},
      checks: {},
      choices: {},
      reminders: {},
      section_seen: {},
      lanes: null,
      cards: {},
      kanban_seen: null,
      ...current,
      task_id: taskId,
      html,
      version: (current?.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
      updated_by: opts.by,
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
    const list = own(current.threads, thread) ?? [];
    // Never earlier than the message before it, so ts order is append order.
    const now = new Date().toISOString();
    const last = list[list.length - 1]?.ts;
    message = {
      id: `bm-${crypto.randomBytes(6).toString('hex')}`,
      author: input.author,
      text,
      ts: last && last > now ? last : now,
    };
    // The user posting in a thread answers a reminder that came due on it.
    const due = input.author === 'user' && own(current.reminders, thread);
    const reminders = due && reminderIsDue(due) ? withoutKey(current.reminders, thread) : current.reminders;
    return { ...current, threads: { ...current.threads, [thread]: [...list, message] }, reminders };
  });
  emitChanged({ taskId, kind: 'thread', thread, version: next.version });
  return message!;
}

/**
 * Remove one thread message and return it. Any writer may delete any message, the
 * user and every session alike (`by` is who deletes; the route logs it beside the
 * message's author), with one guard: a post the user wrote is deleted by an agent
 * only with `overrideUser` (409 user_wrote otherwise), as a status the user
 * picked is, and then the board file is copied to boards/.deleted/ first (as a
 * deleted board is), so the post can be put back. A thread left empty is dropped.
 */
export async function deleteBoardMessage(
  taskId: string,
  thread: string,
  messageId: string,
  opts: { by: BoardWriter; overrideUser?: boolean },
): Promise<BoardMessage> {
  checkItemId(thread, 'thread');
  if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
    throw new BoardError('bad_id', 400, { message: messageId }, 'Invalid message id (bm- and hex digits, as board_get lists them)');
  }
  const agent = !isUsers(opts.by);
  if (agent && opts.overrideUser === true) {
    const before = await getBoard(taskId);
    if ((before?.threads[thread] ?? []).some((m) => m.id === messageId && m.author === 'user')) {
      const copy = await keepBoardCopy(taskId);
      if (copy) log.task.info('board copy kept before an agent deletes the user\'s post', { taskId, thread, messageId, by: opts.by, copy });
    }
  }
  let removed: BoardMessage | undefined;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const list = current.threads[thread] ?? [];
    const index = list.findIndex((m) => m.id === messageId);
    if (index === -1) throw new BoardError('message_not_found', 404, { thread, id: messageId });
    if (list[index].author === 'user' && agent && opts.overrideUser !== true) {
      throw new BoardError('user_wrote', 409, { thread, id: messageId, author: 'user' });
    }
    removed = list[index];
    const threads = { ...current.threads };
    const rest = list.filter((_, i) => i !== index);
    if (rest.length) threads[thread] = rest;
    else delete threads[thread];
    return { ...current, threads };
  });
  emitChanged({ taskId, kind: 'thread', thread, version: next.version });
  return removed!;
}

/**
 * Replace one mark; a mark with neither a state nor a note is removed (returns
 * null). `writer` (default the user) is stamped on it. An agent changing or
 * clearing the user's mark (one with no `by`) is 409 user_wrote unless it passes
 * `overrideUser`; the same text again changes nothing and keeps the user's.
 */
export async function setBoardMark(
  taskId: string,
  markId: string,
  input: { state?: string | null; note?: string | null },
  opts: { writer?: BoardWriterStamp; overrideUser?: boolean } = {},
): Promise<BoardMark | null> {
  checkItemId(markId, 'mark');
  const state = typeof input.state === 'string' ? input.state.trim() : '';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (state.length > BOARD_STATE_MAX_CHARS) {
    throw new BoardError('bad_request', 400, { max: BOARD_STATE_MAX_CHARS },
      `Mark state is longer than ${BOARD_STATE_MAX_CHARS} characters`);
  }
  if (bytes(note) > BOARD_NOTE_MAX_BYTES) throw new BoardError('note_too_long', 413, { max: BOARD_NOTE_MAX_BYTES });
  const stamp = agentStamp(opts.writer);
  let mark: BoardMark | null = state || note
    ? { ...(state ? { state } : {}), ...(note ? { note } : {}), updated_at: new Date().toISOString(), ...stamp }
    : null;
  let kept = false;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const prev = own(current.marks, markId);
    if (prev && stamp.by && isUsers(prev.by)) {
      // The user's note stays theirs: the same text again is no change.
      if (mark && (prev.state ?? '') === state && (prev.note ?? '') === note) {
        mark = prev;
        kept = true;
        return current;
      }
      if (opts.overrideUser !== true) throw userWrote('note', { mark: markId });
    }
    const marks = { ...current.marks };
    if (mark) marks[markId] = mark;
    else delete marks[markId];
    return { ...current, marks };
  });
  if (!kept) emitChanged({ taskId, kind: 'mark', mark: markId, version: next.version });
  return mark;
}

/** Copies of deleted boards kept per task (boards/.deleted/, newest first). */
export const DELETED_BOARD_COPIES = 5;

function deletedBoardsDir(): string {
  return path.join(boardsDir(), '.deleted');
}

/** `<taskId>-<ISO time with : and . as ->.json`: names sort by time within one task. */
function deletedCopyName(taskId: string, at: Date): string {
  return `${taskId}-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

const COPY_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

/** A copy path no earlier copy of this task holds (two in one millisecond take the next one). */
async function freshCopyPath(taskId: string): Promise<string> {
  await fsp.mkdir(deletedBoardsDir(), { recursive: true });
  for (let ms = Date.now(); ; ms += 1) {
    const copy = path.join(deletedBoardsDir(), deletedCopyName(taskId, new Date(ms)));
    if (!(await fsp.stat(copy).then(() => true, () => false))) return copy;
  }
}

/** Copy a task's board file to boards/.deleted/ as it stands (kept like a deleted board's). Undefined when it has none. */
async function keepBoardCopy(taskId: string): Promise<string | undefined> {
  const file = boardFile(taskId);
  const copy = await freshCopyPath(taskId);
  try {
    await fsp.copyFile(file, copy);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  await pruneDeletedCopies(taskId);
  return copy;
}

/** Drop all but the newest DELETED_BOARD_COPIES copies of one task's board. Best effort. */
async function pruneDeletedCopies(taskId: string): Promise<void> {
  const names = await fsp.readdir(deletedBoardsDir()).catch(() => [] as string[]);
  const prefix = `${taskId}-`;
  const mine = names.filter((n) => n.startsWith(prefix) && COPY_STAMP_RE.test(n.slice(prefix.length))).sort();
  for (const name of mine.slice(0, Math.max(0, mine.length - DELETED_BOARD_COPIES))) {
    await fsp.rm(path.join(deletedBoardsDir(), name), { force: true }).catch(() => undefined);
  }
}

/**
 * Remove a task's board. Idempotent: `existed` false when there was none. With
 * `keepCopy` (the Board's own delete, the user's or a session's) the file is
 * moved to boards/.deleted/ instead of removed, and the newest
 * DELETED_BOARD_COPIES per task are kept: an agent may delete any board, so one
 * deleted by mistake can be put back by hand. Readers list `*.json` names only,
 * so the copies are never read as boards.
 */
export async function removeBoard(taskId: string, opts: { keepCopy?: boolean } = {}): Promise<{ existed: boolean; copy?: string }> {
  const file = boardFile(taskId);
  const out = await withFileLock(file, async () => {
    try {
      if (opts.keepCopy) {
        await fsp.stat(file);
        const copy = await freshCopyPath(taskId);
        await fsp.rename(file, copy);
        return { existed: true, copy };
      }
      await fsp.rm(file);
      return { existed: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
      throw err;
    }
  });
  if (out.copy) await pruneDeletedCopies(taskId);
  if (out.existed) emitChanged({ taskId, kind: 'deleted', version: 0 });
  return out;
}

/** Remove a task's board with no copy (its task was deleted). Idempotent: false when there was none. */
export async function deleteBoard(taskId: string): Promise<boolean> {
  return (await removeBoard(taskId)).existed;
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
  if (!bootPolicy('board-store-watch')) return;
  bus.subscribe(BOARD_SUBSCRIBER, onTaskDeleted, { global: true, interest: [EventNames.TASK_DELETED] });
}

export function stopBoardStore(): void {
  bus.unsubscribe(BOARD_SUBSCRIBER);
}

/** Test seam: where a task's board lives. */
export function _boardFilePath(taskId: string): string {
  return boardFile(taskId);
}

/** Test seam: where copies of deleted boards go. */
export function _deletedBoardsDir(): string {
  return deletedBoardsDir();
}
