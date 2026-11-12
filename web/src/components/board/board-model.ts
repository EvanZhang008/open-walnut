/**
 * Pure helpers of the task Board pane (TaskBoardPane.tsx): the payload types of
 * `GET /api/v1/tasks/:id/board`, the frame document wrapper, the live task refs
 * the frame renders its `<walnut-task>` chips from, and the per-browser "seen"
 * record. No React, no DOM: unit-pinned in tests/web/task-board-model.test.ts.
 */

import type {
  BoardCard, BoardKanbanSeen, BoardLane, BoardTeamEntry, LaneTemplateId,
} from '../../../../src/core/boards/board-lanes';

export type {
  BoardCard, BoardCardWriter, BoardKanbanSeen, BoardKanbanSeenCard, BoardLane, BoardLaneKind, BoardTeamEntry,
  LaneTemplateId,
} from '../../../../src/core/boards/board-lanes';

import { htmlSourceAt, validHtmlSources, type BoardHtmlSource } from '../../../../src/core/boards/board-html-source';
import { taskTokensIn } from '../../utils/task-id-shape';
import { AUTOMATION_SILENCE_JS } from '../../utils/automation-silence';
import { boardSummaryTexts } from '../../../../src/lib/board-summary-text';

export type { BoardHtmlSource } from '../../../../src/core/boards/board-html-source';

export type BoardAuthor = 'user' | 'agent' | `task:${string}`;

export interface BoardMessage {
  id: string;
  author: BoardAuthor;
  sessionId?: string;
  text: string;
  ts: string;
  /** Pictures sent with it, as names under /api/images/. */
  images?: string[];
}

export interface BoardMark {
  state?: string;
  note?: string;
  updated_at: string;
  /** An agent wrote it (absent = the user). */
  by?: string;
  by_name?: string;
}

export interface BoardDoc {
  html: string;
  version: number;
  updated_at: string;
  /** 'human' or `task:<id>`. */
  updated_by: string;
  /** The session that wrote this version, set by the server from the caller (absent: a person, or an older write). */
  updated_session_id?: string;
  /** Who wrote each part of `html` (UTF-16 spans covering it; absent from an older server). */
  html_sources?: BoardHtmlSource[];
}

/** One task the html names, as the server resolved it. `ref` is the id as written (may be a prefix). */
export interface BoardRef {
  ref?: string;
  id: string;
  title: string;
  phase: string;
  status: string;
  /** The one user status (src/core/user-status.ts), when the server derived it. */
  user?: string;
}

export type BoardProjectStatus = 'decide' | 'wip' | 'wait' | 'done';

/** A section of the board: its status lives in Walnut (`board_project_set`, or the user's pick), not in the html. */
export interface BoardProject {
  title?: string;
  status?: BoardProjectStatus;
  tasks?: string[];
  updated_at: string;
  updated_by: string;
  /** Who last changed the status ('human' = the user's pick on the page), and when. */
  status_by?: string;
  status_at?: string;
  /** The Overview card's text, written by the leader (`board_project_set`); light markdown. */
  summary?: string;
  latest?: string;
  /** When `latest` last changed (the server stamps it). */
  latest_at?: string;
  next?: string;
  /** A short "waiting on" tag ("3 CRs to deploy"). */
  waiting?: string;
  /** A short count line ("6 tickets"). */
  meta?: string;
}

/** A point on the page as GET reports it: `hash` is the CURRENT one, `read` = read in this version. */
export interface BoardCheck {
  hash: string;
  read: boolean;
  read_at?: string;
  /** Read once, and the point's text changed since. */
  changed?: boolean;
  /** An agent ticked it (`task:<id>` or 'agent') and its name as the user reads it; absent = the user. */
  by?: string;
  by_name?: string;
}

/** The answer to a `<walnut-choice>`, the user's or an agent's. */
export interface BoardChoice {
  /** The option picked; '' when the answer is words alone. */
  option: string;
  label?: string;
  at: string;
  /** An agent picked it (absent = the user). */
  by?: string;
  by_name?: string;
  /** Words beside a pick or instead of one. */
  text?: string;
  text_at?: string;
  /** An agent wrote the words (absent = the user). */
  text_by?: string;
  text_by_name?: string;
  text_session_id?: string;
}

/** A "remind me" on a choice or a thread; `fired_at` once Walnut told the leader. */
export interface BoardReminder {
  at: string;
  set_at: string;
  set_by: string;
  note?: string;
  fired_at?: string;
  delivered_at?: string;
  attempts?: number;
}

/** The text hash of a `[data-project]` section last seen (the frame hashes it). */
export interface BoardSectionSeen {
  hash: string;
  at?: string;
  /** An agent marked it seen (absent = the user). */
  by?: string;
}

export interface BoardPayload {
  board: BoardDoc | null;
  threads: Record<string, BoardMessage[]>;
  marks: Record<string, BoardMark>;
  refs: BoardRef[];
  projects: Record<string, BoardProject>;
  checks: Record<string, BoardCheck>;
  choices: Record<string, BoardChoice>;
  reminders: Record<string, BoardReminder>;
  section_seen: Record<string, BoardSectionSeen>;
  /** The team board's owner (`?team=1`): the task itself, the nearest ancestor with a board, or the root. */
  board_task_id?: string;
  board_task_title?: string;
  /** A host replica's mark while a write to this Board waits for the Mac (src/replica/away-reads.ts); the Mac never sends it. */
  replica_sync?: 'pending' | 'awaiting';
  /** Kanban (always present after normalizeBoardPayload, board null too). The stored lanes; null = on the template. */
  lanes: BoardLane[] | null;
  /** The lanes to draw: stored, or the template the server picked. The web never guesses a template. */
  lanes_effective: BoardLane[];
  lanes_template: LaneTemplateId;
  /** Key = full task id. */
  cards: Record<string, BoardCard>;
  /** The owner's direct subtasks (server side walk, so done ones older than the store's window count too). */
  team: BoardTeamEntry[];
  /** The user's "Changed" baseline; null = never looked. */
  kanban_seen: BoardKanbanSeen | null;
  /** html version, also on a `fields=kanban` answer. */
  board_version?: number;
}

/** The kanban part of a payload: what `GET ...board?team=1&fields=kanban` answers. */
export type BoardKanbanFields = Pick<BoardPayload,
  'lanes' | 'lanes_effective' | 'lanes_template' | 'cards' | 'team' | 'kanban_seen' | 'board_task_id' | 'board_task_title' | 'board_version'>;

/** What the frame reads for a task chip or a message author. */
export interface FrameTask {
  id: string;
  title: string;
  phase: string;
  status: string;
  /** needs | working | waiting | done: the chip's word and dot (src/core/user-status.ts); To read is sent as needs. */
  user?: string;
}

/** thread id → the newest message ts this browser has read. */
export type BoardSeen = Record<string, string>;

/** The minimum of a store task the board reads. */
export interface StoreTaskLike {
  id: string;
  title: string;
  phase?: string;
  status?: string;
  parent_task_id?: string;
  user_status?: { state: string; toRead?: string; snoozed?: unknown };
}

// ── The frame document ──

export const BOARD_FRAME_CSP = '<meta http-equiv="Content-Security-Policy" content="'
  + "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'unsafe-inline'"
  + '">';

/** Base look for a bare fragment only: a full document chose its own styling. */
const FRAGMENT_BASE_CSS = 'body{margin:0;padding:16px 20px;'
  + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5}';

/** `<head>` or `<head attr…>`, never `<header>`. */
const HEAD_OPEN = /^\s*<head(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>/i;
const HTML_OPEN = /^\s*<html(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>/i;
const DOCTYPE = /^\s*<!doctype\s+html>\s*/i;

/**
 * The board html as the frame's document: CSP first, then the runtime's css,
 * then the runtime itself, all at the very top of `<head>` so the custom
 * elements are defined before the body parses (they upgrade as they appear).
 *
 * A document that has a `<head>` gets the block right after it; one with only
 * `<html>` gets a `<head>` there; a bare fragment is wrapped in a minimal
 * standards-mode document. `</script` / `</style` inside the injected sources
 * are escaped so they cannot end their own element early.
 */
/**
 * A fresh nonce per rendered document. The runtime keeps it in a closure and
 * stamps every message it sends; the host drops frame messages without it, so a
 * script the board's author wrote cannot post to a thread or set a mark as the
 * user (board-runtime.frame.js explains the rest of that boundary).
 */
export function newBoardNonce(): string {
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: (b: Uint8Array) => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); return b; } })
    .getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function wrapBoardHtml(html: string, runtimeSrc: string, runtimeCss: string, nonce = newBoardNonce()): string {
  const css = runtimeCss.replace(/<\/style/gi, '<\\/style');
  // The silencer first: the board's own scripts must not reach a test machine's speakers.
  const js = (AUTOMATION_SILENCE_JS + runtimeSrc.replace('__WN_BOARD_NONCE__', () => nonce)).replace(/<\/script/gi, '<\\/script');
  const block = `${BOARD_FRAME_CSP}<style id="wn-board-runtime-css">${css}</style><script>${js}</script>`;
  const doctype = DOCTYPE.exec(html);
  const prefix = doctype?.[0] ?? '';
  const rest = html.slice(prefix.length);
  const root = HTML_OPEN.exec(rest);
  const start = prefix.length + (root?.[0].length ?? 0);
  const head = HEAD_OPEN.exec(html.slice(start));
  if (head) {
    const at = start + head[0].length;
    return html.slice(0, at) + block + html.slice(at);
  }
  if (root) return html.slice(0, start) + `<head>${block}</head>` + html.slice(start);
  if (doctype) return prefix + `<head>${block}</head>` + rest;
  return `<!doctype html><html><head>${block}<style>${FRAGMENT_BASE_CSS}</style></head><body>${html}</body></html>`;
}

// ── Live refs ──

function frameTask(t: StoreTaskLike): FrameTask {
  const us = t.user_status;
  // A task with only something to read (To read, or an older server's Waiting with `toRead`,
  // storedUserState) is drawn and named under Needs you (shownState, 2026-11-03).
  const user = t.phase === 'COMPLETE' || t.status === 'done' ? 'done'
    : us && (us.state === 'read' || (us.state === 'waiting' && us.toRead && !us.snoozed)) ? 'needs' : us?.state;
  return { id: t.id, title: t.title, phase: t.phase ?? '', status: t.status ?? '', ...(user ? { user } : {}) };
}

/**
 * Every task the frame may need, keyed by the id as the html wrote it AND by
 * the full id: the payload's refs (live from the store when the store has the
 * row), plus `extraIds` (the board's own task, message authors) when the store
 * knows them. The store wins because it is the browser's one truth for a task
 * row; the payload's copy is the fallback for a row the store has not loaded.
 */
export function buildFrameRefs(
  payloadRefs: readonly BoardRef[],
  storeById: ReadonlyMap<string, StoreTaskLike> | null,
  extraIds: readonly string[] = [],
): Record<string, FrameTask> {
  const out: Record<string, FrameTask> = {};
  const resolved = payloadRefs.map((r) => {
    const live = storeById?.get(r.id);
    return { r, t: live ? frameTask(live) : { id: r.id, title: r.title, phase: r.phase, status: r.status, ...(r.user ? { user: r.user } : {}) } };
  });
  for (const { r, t } of resolved) out[r.id] = t;
  // The id exactly as the html wrote it wins over a full id it happens to equal.
  for (const { r, t } of resolved) if (r.ref) out[r.ref] = t;
  for (const id of extraIds) {
    if (!id || out[id]) continue;
    const live = storeById?.get(id);
    if (live) out[id] = frameTask(live);
  }
  return out;
}

/**
 * Every task id token the Board's own text and its messages write outside a
 * `<walnut-task>` chip (a bare id, an id's first segment, a `<task-ref/>`'s id):
 * the frame turns each one the refs know into a live chip (board-elements and
 * board-markdown frames), so a task a message names reads as its name.
 */
export function boardMentionTokens(
  html: string,
  threads: Record<string, BoardMessage[]>,
  choices: Record<string, BoardChoice> = {},
): string[] {
  const out = new Set<string>();
  const add = (text: string) => { for (const t of taskTokensIn(text)) out.add(t); };
  // Tags become spaces, so an id in an attribute (`<walnut-task id>`, a class) is
  // read only where the frame reads it too: in text.
  add(html.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' '));
  for (const list of Object.values(threads)) for (const m of list) add(m.text);
  for (const c of Object.values(choices)) if (c.text) add(c.text);
  for (const summary of boardSummaryTexts(html)) add(summary.text);
  return [...out];
}

/** The refs entries of the mention tokens `resolve` names (the store's row when
 *  it has one), keyed by the token as written; an existing key is kept. */
export function mentionFrameRefs(
  refs: Record<string, FrameTask>,
  tokens: readonly string[],
  resolve: (token: string) => { id: string; label: { title: string } } | undefined,
  storeById: ReadonlyMap<string, StoreTaskLike> | null,
): Record<string, FrameTask> {
  let out = refs;
  for (const token of tokens) {
    if (out[token]) continue;
    const hit = resolve(token);
    if (!hit) continue;
    const live = storeById?.get(hit.id);
    if (out === refs) out = { ...refs };
    out[token] = live ? frameTask(live) : { id: hit.id, title: hit.label.title, phase: '', status: '' };
  }
  return out;
}

/** Same keys, same four fields: the frame does not need a re-post. */
export function frameRefsEqual(a: Record<string, FrameTask>, b: Record<string, FrameTask>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    const x = a[k], y = b[k];
    if (!y || x.id !== y.id || x.title !== y.title || x.phase !== y.phase || x.status !== y.status || x.user !== y.user) return false;
  }
  return true;
}

/** Task ids that wrote in any thread (`task:<id>` authors). */
export function threadAuthorIds(threads: Record<string, BoardMessage[]>): string[] {
  const ids = new Set<string>();
  for (const list of Object.values(threads)) {
    for (const m of list) if (m.author.startsWith('task:')) ids.add(m.author.slice(5));
  }
  return [...ids];
}

export interface BoardFileSource {
  taskId: string;
  primary?: boolean;
  sessionId?: string;
  sourceFailure?: boolean;
}

const SOURCE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// Only the session saved with the text names its machine. A task author with no saved session
// keeps its id (for the row's name) but is unknown: the task's session now may run elsewhere.
function writerSource(ownerId: string, by: unknown, sid: unknown): BoardFileSource {
  if (by === 'human' || by === 'user') return { taskId: ownerId, primary: true };
  const authorId = typeof by === 'string' && by.startsWith('task:') ? by.slice(5) : '';
  const taskId = SOURCE_TASK_ID.test(authorId) ? authorId : ownerId;
  const sessionId = typeof sid === 'string' && sid !== 'external' && SOURCE_SESSION_ID.test(sid) ? sid : undefined;
  return sessionId ? { taskId, sessionId } : { taskId, sourceFailure: true };
}

export type BoardPageSource = Pick<BoardDoc, 'updated_by' | 'updated_session_id'> & Partial<Pick<BoardDoc, 'html' | 'html_sources'>>;

/** One key per writer: a person's (primary) copy never merges with the owner's agent copy that has no session. */
function sourceKeyOf(source: BoardFileSource): string {
  return source.primary ? 'primary' : `${source.taskId}|${source.sessionId ?? ''}`;
}

/**
 * Every writer of the page text from `start` to `end` (one reference the parser found in the
 * stored html), once each, in page order. A reference typed in parts by several writers (A, then
 * B, then A again) names each of them, so the click can ask which machine. Null when the range is
 * not inside the page, the stored spans are not an exact cover, or any writer cannot name a machine.
 * An older server sends no spans: the page's last writer.
 */
export function boardReferenceSources(
  ownerId: string,
  page: BoardPageSource | null | undefined,
  start: number,
  end: number,
): BoardFileSource[] | null {
  if (!page || typeof page.html !== 'string') return null;
  const length = page.html.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > length) return null;
  if (page.html_sources === undefined) {
    const only = writerSource(ownerId, page.updated_by, page.updated_session_id);
    return only.sourceFailure ? null : [only];
  }
  const spans = validHtmlSources(page.html_sources, length);
  if (!spans) return null;
  const out = new Map<string, BoardFileSource>();
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    const source = writerSource(ownerId, span.by, span.sessionId);
    if (source.sourceFailure) return null;
    if (!out.has(sourceKeyOf(source))) out.set(sourceKeyOf(source), source);
  }
  return out.size ? [...out.values()] : null;
}

// Author scripts can copy or move anchors, so DOM offsets cannot choose a writer.
// The one writer of every stored reference to `path`, else unknown.
export function boardPathSource(
  ownerId: string,
  paths: Iterable<[number, { path: string; end: number }]>,
  path: string,
  page: BoardPageSource | null | undefined,
): BoardFileSource {
  const unknown: BoardFileSource = { taskId: ownerId, sourceFailure: true };
  let source: BoardFileSource | undefined;
  for (const [offset, reference] of paths) {
    if (reference.path !== path) continue;
    const found = boardReferenceSources(ownerId, page, offset, reference.end);
    if (!found || found.length !== 1 || (source && sourceKeyOf(found[0]!) !== sourceKeyOf(source))) return unknown;
    source = found[0];
  }
  return source ?? unknown;
}

/** A path's copy once the click read its machine: `host` as the session record has it, '' for this machine. */
export interface BoardResolvedSource {
  host?: string;
  /** Where the copy is: "Board page", "Reply by … in …", "Answer in …". */
  label: string;
  /** The writing session's title, else its task's (never a session id). */
  title?: string;
}

/** One button of the source chooser: a machine ('' = this one) and every copy written there. */
export interface BoardHostChoice {
  host: string;
  details: string[];
}

const LOCAL_HOST_NAMES = new Set(['', 'local', '__local__']);

/** Copies on the same machine are one choice; a single result opens at once. */
export function boardHostChoices(resolved: readonly BoardResolvedSource[]): BoardHostChoice[] {
  const byHost = new Map<string, string[]>();
  for (const r of resolved) {
    const host = r.host && !LOCAL_HOST_NAMES.has(r.host) ? r.host : '';
    const detail = r.title ? `${r.label} (${r.title})` : r.label;
    const details = byHost.get(host) ?? [];
    if (!details.includes(detail)) details.push(detail);
    byHost.set(host, details);
  }
  return [...byHost].map(([host, details]) => ({ host, details }));
}

export function boardChoiceFileSource(ownerId: string, choice: BoardChoice): BoardFileSource {
  return writerSource(ownerId, choice.text_by ?? 'human', choice.text_session_id);
}

// A frame's row hint can select a stored source, never supply a machine.
// `sourceOffset` (a link's UTF-16 offset in the page html) picks the writer of the span holding it;
// one that is not inside an exact span is the owner. Without it the page's last writer stands.
export function boardFileSource(
  ownerId: string,
  threads: Record<string, BoardMessage[]> | null | undefined,
  thread: unknown,
  msg: unknown,
  page?: BoardPageSource | null,
  sourceOffset?: unknown,
  sourceEnd?: number,
): BoardFileSource {
  const owner: BoardFileSource = { taskId: ownerId };
  const named = typeof thread === 'string' && typeof msg === 'string' && !!thread && !!msg;
  if (!named) {
    // Anything but two strings (an object, an array) is not a row: the owner, as a forged one.
    if ((thread !== undefined && thread !== '') || (msg !== undefined && msg !== '')) return owner;
    if (!page) return owner;
    if (sourceOffset === undefined) return writerSource(ownerId, page.updated_by, page.updated_session_id);
    const html = typeof page.html === 'string' ? page.html : null;
    if (html === null || !Number.isInteger(sourceOffset) || (sourceOffset as number) < 0 || (sourceOffset as number) >= html.length) return owner;
    // An older server sends no spans: the page's last writer, as before.
    if (page.html_sources === undefined) return writerSource(ownerId, page.updated_by, page.updated_session_id);
    const span = htmlSourceAt(page.html_sources, html.length, sourceOffset);
    if (span && sourceEnd !== undefined && (!Number.isInteger(sourceEnd) || sourceEnd <= (sourceOffset as number) || sourceEnd > span.end)) {
      return { ...owner, sourceFailure: true };
    }
    return span ? writerSource(ownerId, span.by, span.sessionId) : owner;
  }
  if (!threads || !Object.prototype.hasOwnProperty.call(threads, thread)) return owner;
  const list = threads[thread];
  if (!Array.isArray(list)) return owner;
  const message = list.find((m) => m && m.id === msg);
  return message ? writerSource(ownerId, message.author, message.sessionId) : owner;
}

/** A message merged into its thread (deduped by id, kept in ts order). */
export function mergeBoardMessage(
  threads: Record<string, BoardMessage[]>,
  thread: string,
  message: BoardMessage,
): Record<string, BoardMessage[]> {
  const list = threads[thread] ?? [];
  if (list.some((m) => m.id === message.id)) return threads;
  const next = [...list, message].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  return { ...threads, [thread]: next };
}

// ── The top bar ──

/** Who last wrote the html, in the bar's words. */
export function boardWriterLabel(updatedBy: string, boardTaskId: string): string {
  if (updatedBy === 'human') return 'you';
  if (updatedBy === `task:${boardTaskId}`) return 'leader';
  if (updatedBy.startsWith('task:')) return 'worker';
  return updatedBy || 'unknown';
}

// ── Seen state (per browser) ──

export const BOARD_SEEN_PREFIX = 'walnut-board-seen:';

export function parseSeen(raw: string | null): BoardSeen {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: BoardSeen = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The seen record after the frame reports `ts` read in `thread`; null when nothing moves. */
export function advanceSeen(seen: BoardSeen, thread: string, ts: string): BoardSeen | null {
  if (!thread || !ts) return null;
  if ((seen[thread] ?? '') >= ts) return null;
  return { ...seen, [thread]: ts };
}

/** Only an absolute http(s) URL leaves the frame as a new tab. */
export function safeExternalHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
