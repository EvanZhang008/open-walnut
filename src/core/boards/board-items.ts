/**
 * The board's side state beyond threads and marks (board-store.ts holds the
 * file, the lock and the types):
 *
 *   projects    one area of this board (a cause, a ticket; NOT a Walnut project)
 *               and its status (decide / wip / wait / done), owned by Walnut so
 *               the page recolors when the leader or the user changes it (a
 *               status the user picked is theirs until a session overrides it);
 *   checks      the user's read ticks: the hash of the point they read, so an
 *               edit of the point brings it back unread;
 *   choices     the user's answer to a `<walnut-choice>`;
 *   reminders   "remind me later" on a choice or a thread (clock: board-reminders.ts);
 *   section_seen  the sections the user has seen, by the hash the frame computed
 *               (a red dot marks a section the leader changed since).
 *
 * Checks and choices are validated against the html INSIDE the lock, so a
 * concurrent board_edit can never let a stale tick or a removed option through.
 */

import {
  BOARD_PROJECT_STATUSES,
  BOARD_CHOICE_TEXT_MAX_BYTES,
  BOARD_NOTE_MAX_BYTES,
  BoardError,
  bytes,
  checkItemId,
  emitChanged,
  reminderIsDue,
  requireBoard,
  updateBoard,
  withoutKey,
  type BoardProject,
  type BoardProjectStatus,
  type BoardCheck,
  type BoardChoice,
  type BoardFile,
  type BoardReminder,
  type BoardSectionSeen,
  type BoardWriter,
} from './board-store.js';
import { checkHashes, choiceSpecs, own, threadMeta, type BoardChoiceSpec } from './board-html.js';

export const BOARD_MAX_PROJECTS = 200;
export const BOARD_MAX_CHECKS = 2000;
export const BOARD_MAX_CHOICES = 200;
export const BOARD_MAX_REMINDERS = 200;
export const BOARD_PROJECT_MAX_TASKS = 200;
export const BOARD_PROJECT_TITLE_MAX = 200;
/** The card text of a project, in characters: the long fields, then the short tags. */
export const BOARD_PROJECT_TEXT_FIELDS = { summary: 2000, latest: 2000, next: 1000, waiting: 120, meta: 80 } as const;
export type BoardProjectTextField = keyof typeof BOARD_PROJECT_TEXT_FIELDS;
export const BOARD_REMINDER_MAX_DAYS = 90;
export const BOARD_MAX_SECTION_SEEN = 500;
const SEEN_HASH_MAX_CHARS = 128;

const DAY_MS = 86_400_000;

function tooMany(what: string, max: number): BoardError {
  return new BoardError('too_many', 400, { what, max }, `A board holds at most ${max} ${what}`);
}

/**
 * Room for one more record in a capped map: entries whose id is no longer on
 * the page go first (a tick on a removed point is dead weight), then the cap holds.
 */
function makeRoom<T>(m: Record<string, T>, id: string, onPage: Record<string, unknown>, max: number, what: string): Record<string, T> {
  if (Object.hasOwn(m, id) || Object.keys(m).length < max) return m;
  const kept = Object.fromEntries(Object.entries(m).filter(([k]) => Object.hasOwn(onPage, k)));
  if (Object.keys(kept).length >= max) throw tooMany(what, max);
  return kept;
}

// ── Projects ──

export interface ProjectInput {
  /** Absent keeps; "" or null clears. */
  title?: string | null;
  /** Absent keeps; "" or null clears. */
  status?: string | null;
  /** A FULL replacement of full task ids (the route resolves prefixes); null or [] clears. */
  tasks?: string[] | null;
  /** The card's text (BOARD_PROJECT_TEXT_FIELDS): absent keeps, "" or null clears. */
  summary?: string | null;
  latest?: string | null;
  next?: string | null;
  waiting?: string | null;
  meta?: string | null;
  delete?: boolean;
}

const TEXT_FIELDS = Object.keys(BOARD_PROJECT_TEXT_FIELDS) as BoardProjectTextField[];

/** The words the page shows for each status (the frame's DEFAULT_LABELS). */
export const BOARD_PROJECT_STATUS_LABELS: Record<BoardProjectStatus, string> = {
  decide: 'Needs you', wip: 'In progress', wait: 'Waiting on others', done: 'Done',
};

function isStatus(s: string): s is BoardProjectStatus {
  return (BOARD_PROJECT_STATUSES as readonly string[]).includes(s);
}

export interface ProjectWrite {
  project: BoardProject | null;
  /** The project before this write (null: it did not exist). */
  previous: BoardProject | null;
  /** The status itself changed (set, replaced or cleared). */
  statusChanged: boolean;
}

/**
 * Partial update of one project. A project left with no title, status, tasks
 * and card text (or `delete: true`) is removed and the result is null.
 */
export async function setBoardProject(
  taskId: string,
  id: string,
  input: ProjectInput,
  opts: { by: BoardWriter; overrideUser?: boolean },
): Promise<BoardProject | null> {
  return (await writeBoardProject(taskId, id, input, opts)).project;
}

/**
 * A status the USER picked stays theirs: a session's write that would change or
 * remove it is refused (409 status_set_by_user) unless it says so
 * (`overrideUser`). Title and task changes never touch the status.
 */
export async function writeBoardProject(
  taskId: string,
  id: string,
  input: ProjectInput,
  opts: { by: BoardWriter; overrideUser?: boolean },
): Promise<ProjectWrite> {
  checkItemId(id, 'project');
  const title = typeof input.title === 'string' ? input.title.trim() : input.title;
  if (typeof title === 'string' && title.length > BOARD_PROJECT_TITLE_MAX) {
    throw new BoardError('bad_request', 400, { max: BOARD_PROJECT_TITLE_MAX },
      `A project title is at most ${BOARD_PROJECT_TITLE_MAX} characters`);
  }
  const status = typeof input.status === 'string' ? input.status.trim() : input.status;
  if (typeof status === 'string' && status !== '' && !isStatus(status)) {
    throw new BoardError('bad_status', 400, { status });
  }
  const text: Partial<Record<BoardProjectTextField, string | null>> = {};
  for (const field of TEXT_FIELDS) {
    const v = input[field];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') throw new BoardError('bad_request', 400, { field }, `\`${field}\` must be a string`);
    const trimmed = typeof v === 'string' ? v.trim() : '';
    const max = BOARD_PROJECT_TEXT_FIELDS[field];
    if (trimmed.length > max) {
      throw new BoardError('bad_request', 400, { field, max }, `A project's \`${field}\` is at most ${max} characters`);
    }
    text[field] = trimmed;
  }
  let tasks: string[] | null | undefined = input.tasks;
  if (Array.isArray(tasks)) {
    if (tasks.some((t) => typeof t !== 'string' || !t)) {
      throw new BoardError('bad_request', 400, undefined, '`tasks` must be an array of task ids');
    }
    tasks = [...new Set(tasks)];
    if (tasks.length > BOARD_PROJECT_MAX_TASKS) throw tooMany('tasks in a project', BOARD_PROJECT_MAX_TASKS);
  }

  let out: ProjectWrite = { project: null, previous: null, statusChanged: false };
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const prev = own(current.projects, id) ?? null;
    const at = new Date().toISOString();
    const project: BoardProject = { ...prev, updated_at: at, updated_by: opts.by };
    if (title !== undefined) { if (title) project.title = title; else delete project.title; }
    if (status !== undefined) { if (status) project.status = status as BoardProjectStatus; else delete project.status; }
    if (tasks !== undefined) { if (tasks?.length) project.tasks = tasks; else delete project.tasks; }
    for (const field of TEXT_FIELDS) {
      const v = text[field];
      if (v === undefined) continue;
      if (v) project[field] = v; else delete project[field];
    }
    if (text.latest !== undefined) {
      if (!project.latest) delete project.latest_at;
      else if (project.latest !== prev?.latest) project.latest_at = at;
    }
    const removed = !!input.delete
      || (!project.title && !project.status && !project.tasks?.length && !TEXT_FIELDS.some((f) => project[f]));
    const statusChanged = (removed ? undefined : project.status) !== prev?.status;
    if (statusChanged && prev?.status && prev.status_by === 'human' && opts.by !== 'human' && !opts.overrideUser) {
      throw new BoardError('status_set_by_user', 409, { project: id, status: prev.status, status_at: prev.status_at },
        `The user set project "${id}" to ${prev.status} (${BOARD_PROJECT_STATUS_LABELS[prev.status]})`
        + `${prev.status_at ? ` at ${prev.status_at}` : ''}. Leave status out to keep their pick, or pass `
        + 'override_user: true to replace it.');
    }
    out = { project: null, previous: prev, statusChanged };
    if (removed) return { ...current, projects: withoutKey(current.projects, id) };
    if (statusChanged) {
      if (project.status) { project.status_by = opts.by; project.status_at = at; }
      else { delete project.status_by; delete project.status_at; }
    }
    if (!prev && Object.keys(current.projects).length >= BOARD_MAX_PROJECTS) {
      throw tooMany('projects', BOARD_MAX_PROJECTS);
    }
    out.project = project;
    return { ...current, projects: { ...current.projects, [id]: project } };
  });
  emitChanged({ taskId, kind: 'project', project: id, version: next.version });
  return out;
}

// ── Checks (the user's read ticks) ──

/**
 * Tick a point read or unread. `read: true` must quote the point's CURRENT hash
 * (the one Walnut gave the frame); a point that changed since is 409
 * `check_changed` with the new hash, so the user sees the new text first.
 */
export async function setBoardCheck(
  taskId: string,
  id: string,
  input: { read: boolean; hash?: string },
): Promise<{ check: BoardCheck | null; hash: string }> {
  checkItemId(id, 'check');
  if (typeof input.read !== 'boolean') throw new BoardError('bad_request', 400, undefined, '`read` must be a boolean');
  if (input.read && (typeof input.hash !== 'string' || !input.hash)) {
    throw new BoardError('bad_request', 400, undefined, '`hash` (the point\'s hash from GET) is required to mark it read');
  }
  let out: { check: BoardCheck | null; hash: string } | undefined;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const hashes = checkHashes(current.html);
    const hash = own(hashes, id);
    if (hash === undefined) throw new BoardError('check_not_found', 404, { check: id });
    if (!input.read) {
      out = { check: null, hash };
      return { ...current, checks: withoutKey(current.checks, id) };
    }
    if (input.hash !== hash) throw new BoardError('check_changed', 409, { check: id, hash });
    const prev = own(current.checks, id);
    const check = prev?.hash === hash ? prev : { hash, read_at: new Date().toISOString() };
    const checks = makeRoom(current.checks, id, hashes, BOARD_MAX_CHECKS, 'read ticks');
    out = { check, hash };
    return { ...current, checks: { ...checks, [id]: check } };
  });
  emitChanged({ taskId, kind: 'check', check: id, version: next.version });
  return out!;
}

/** Every check on the page now: its current hash, and whether the user read THIS version. */
export interface BoardCheckState {
  hash: string;
  read: boolean;
  read_at?: string;
  changed?: boolean;
}

export function boardCheckStates(board: Pick<BoardFile, 'html' | 'checks'>): Record<string, BoardCheckState> {
  const out: Record<string, BoardCheckState> = {};
  for (const [id, hash] of Object.entries(checkHashes(board.html))) {
    const stored = own(board.checks, id);
    out[id] = {
      hash,
      read: stored?.hash === hash,
      ...(stored ? { read_at: stored.read_at } : {}),
      ...(stored && stored.hash !== hash ? { changed: true } : {}),
    };
  }
  return out;
}

// ── Choices (the user's answers) ──

export interface ChoiceResult {
  choice: BoardChoice | null;
  /** False for the same answer again or clearing nothing: no delivery is due. */
  changed: boolean;
  spec: BoardChoiceSpec;
}

/**
 * The user's answer to a `<walnut-choice>`: an option, their own words, or both.
 * Each field given replaces that part and keeps the other (`option: ""` takes the
 * pick back, `text: ""` the words); an answer with neither is cleared. Text alone
 * is an answer. Answering clears a due reminder on the choice.
 */
export async function setBoardChoice(
  taskId: string,
  id: string,
  input: { option?: string; text?: string },
): Promise<ChoiceResult> {
  checkItemId(id, 'choice');
  if (input.option !== undefined && typeof input.option !== 'string') {
    throw new BoardError('bad_request', 400, undefined, '`option` must be a string');
  }
  if (input.text !== undefined && typeof input.text !== 'string') {
    throw new BoardError('bad_request', 400, undefined, '`text` must be a string');
  }
  if (input.option === undefined && input.text === undefined) {
    throw new BoardError('bad_request', 400, undefined, 'Give `option`, `text` or both');
  }
  const option = input.option?.trim();
  const text = input.text?.trim();
  if (text !== undefined && bytes(text) > BOARD_CHOICE_TEXT_MAX_BYTES) {
    throw new BoardError('answer_too_long', 413, { max: BOARD_CHOICE_TEXT_MAX_BYTES });
  }
  let out: ChoiceResult | undefined;
  let clearedReminder = false;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const specs = choiceSpecs(current.html);
    const spec = own(specs, id);
    if (!spec) throw new BoardError('choice_not_found', 404, { choice: id });
    const prev = own(current.choices, id);
    const picked = option ? spec.options.find((o) => o.value === option) : undefined;
    if (option && !picked) {
      throw new BoardError('bad_option', 400, { choice: id, option, options: spec.options.map((o) => o.value) });
    }
    const now = new Date().toISOString();
    const nextOption = option ?? prev?.option ?? '';
    const nextText = text ?? prev?.text ?? '';
    if (!nextOption && !nextText) {
      out = { choice: null, changed: !!prev, spec };
      return { ...current, choices: withoutKey(current.choices, id) };
    }
    const due = own(current.reminders, id);
    clearedReminder = !!due && reminderIsDue(due);
    const reminders = clearedReminder ? withoutKey(current.reminders, id) : current.reminders;
    if (prev && (prev.option ?? '') === nextOption && (prev.text ?? '') === nextText) {
      out = { choice: prev, changed: false, spec };
      return { ...current, reminders };
    }
    const choice: BoardChoice = nextOption === (prev?.option ?? '') && prev
      ? { option: prev.option, ...(prev.label ? { label: prev.label } : {}), at: prev.at }
      : { option: nextOption, ...(picked ? { label: picked.label } : {}), at: now };
    if (nextText) {
      choice.text = nextText;
      choice.text_at = nextText === prev?.text && prev.text_at ? prev.text_at : now;
    }
    const choices = makeRoom(current.choices, id, specs, BOARD_MAX_CHOICES, 'answered choices');
    out = { choice, changed: true, spec };
    return { ...current, choices: { ...choices, [id]: choice }, reminders };
  });
  if (out!.changed || clearedReminder) emitChanged({ taskId, kind: 'choice', choice: id, version: next.version });
  return out!;
}

// ── Reminders ──

/** True when `target` is a `<walnut-choice>` or `<walnut-thread>` id on the page. */
export function isReminderTarget(html: string, target: string): boolean {
  return !!own(choiceSpecs(html), target) || threadMeta(html, target) !== null;
}

/**
 * Set (replace) or clear the reminder on one choice or thread. `at` must be in
 * the future and at most 90 days out. Clearing works for a target the page no
 * longer has, so a stale reminder can always be removed.
 */
export async function setBoardReminder(
  taskId: string,
  target: string,
  input: { at: string | null; note?: string | null },
  opts: { by: BoardWriter; nowMs?: number },
): Promise<BoardReminder | null> {
  checkItemId(target, 'target');
  const nowMs = opts.nowMs ?? Date.now();
  let at: string | null = null;
  if (input.at !== null) {
    const ms = typeof input.at === 'string' ? Date.parse(input.at) : Number.NaN;
    if (!Number.isFinite(ms)) throw new BoardError('bad_time', 400, { at: input.at }, '`at` must be an ISO-8601 time (or null to clear)');
    if (ms <= nowMs) throw new BoardError('bad_time', 400, { at: input.at }, '`at` must be in the future');
    if (ms > nowMs + BOARD_REMINDER_MAX_DAYS * DAY_MS) {
      throw new BoardError('bad_time', 400, { at: input.at }, `\`at\` must be at most ${BOARD_REMINDER_MAX_DAYS} days out`);
    }
    at = new Date(ms).toISOString();
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (bytes(note) > BOARD_NOTE_MAX_BYTES) throw new BoardError('note_too_long', 413, { max: BOARD_NOTE_MAX_BYTES });

  let result: BoardReminder | null = null;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    const onPage = isReminderTarget(current.html, target);
    if (at === null) {
      if (!onPage && !Object.hasOwn(current.reminders, target)) throw new BoardError('target_not_found', 404, { target });
      return { ...current, reminders: withoutKey(current.reminders, target) };
    }
    if (!onPage) throw new BoardError('target_not_found', 404, { target });
    if (!Object.hasOwn(current.reminders, target) && Object.keys(current.reminders).length >= BOARD_MAX_REMINDERS) {
      throw tooMany('reminders', BOARD_MAX_REMINDERS);
    }
    result = { at, set_at: new Date(nowMs).toISOString(), set_by: opts.by, ...(note ? { note } : {}) };
    return { ...current, reminders: { ...current.reminders, [target]: result } };
  });
  emitChanged({ taskId, kind: 'reminder', reminder: target, version: next.version });
  return result;
}

/**
 * The clock's bookkeeping on one reminder (fired, delivered, a failed attempt),
 * applied only while the reminder is still the one the clock read (`set_at`):
 * a reminder the user replaced or cleared meanwhile is left alone (null).
 */
export async function patchBoardReminder(
  taskId: string,
  target: string,
  setAt: string,
  patch: Pick<BoardReminder, 'fired_at' | 'delivered_at' | 'attempts'>,
): Promise<BoardReminder | null> {
  let result: BoardReminder | null = null;
  try {
    const next = await updateBoard(taskId, (raw) => {
      const current = requireBoard(raw);
      const rem = own(current.reminders, target);
      if (!rem || rem.set_at !== setAt) throw new BoardError('reminder_gone', 409, { target });
      result = { ...rem, ...patch };
      return { ...current, reminders: { ...current.reminders, [target]: result } };
    });
    emitChanged({ taskId, kind: 'reminder', reminder: target, version: next.version });
  } catch (err) {
    if (err instanceof BoardError && (err.code === 'reminder_gone' || err.code === 'no_board')) return null;
    throw err;
  }
  return result;
}

// ── Sections the user has seen ──

/**
 * The user saw `section` as the frame hashed it (`hash: ""` forgets it). The
 * server never computes this hash: the frame hashes the section's text and
 * compares on its side. At most BOARD_MAX_SECTION_SEEN entries; the oldest
 * goes first when a new one would pass the cap.
 */
export async function setBoardSectionSeen(
  taskId: string,
  section: string,
  input: { hash: string },
): Promise<BoardSectionSeen | null> {
  checkItemId(section, 'section');
  if (typeof input.hash !== 'string') throw new BoardError('bad_request', 400, undefined, '`hash` must be a string ("" forgets)');
  const hash = input.hash.trim();
  if (hash.length > SEEN_HASH_MAX_CHARS) {
    throw new BoardError('bad_request', 400, { max: SEEN_HASH_MAX_CHARS }, `\`hash\` is at most ${SEEN_HASH_MAX_CHARS} characters`);
  }
  const seen: BoardSectionSeen | null = hash ? { hash, at: new Date().toISOString() } : null;
  const next = await updateBoard(taskId, (raw) => {
    const current = requireBoard(raw);
    if (!seen) return { ...current, section_seen: withoutKey(current.section_seen, section) };
    let rest = current.section_seen;
    if (!Object.hasOwn(rest, section) && Object.keys(rest).length >= BOARD_MAX_SECTION_SEEN) {
      const oldest = Object.entries(rest).sort(([, a], [, b]) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0][0];
      rest = withoutKey(rest, oldest);
    }
    return { ...current, section_seen: { ...rest, [section]: seen } };
  });
  emitChanged({ taskId, kind: 'seen', section, version: next.version });
  return seen;
}
