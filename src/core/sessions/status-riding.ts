/**
 * What rides a session's next message about the tasks it follows (2026-10-31, the user: a VP and
 * Main track their tasks the way a leader tracks its workers, and an idle node keeps its updates
 * for its next turn). Two writers fill it: status-push.ts (a task's settled status moved: one line
 * of Walnut's record) and org-follow.ts (a task's turn ended, it completed or it erred: the
 * subtask-notice envelope with its last message). Nothing here wakes a session: the items ride the
 * next message into it (session-message-queue.ts sendMessageToSession), in front of it.
 *
 * One item per task per session, so no node hears the same change twice: the newest turn notice
 * (a stop, a block, a park replace one another), a completion or an error, and the newest status
 * line, told together as one envelope (the status line inside the notice). A status line or a team
 * note that comes after a notice already told says that move again, so each session remembers the
 * notices it was told (noticeToldSince) and those skip it. A session's items are kept on disk
 * (cache/status-riding.json, never synced: it is queue state) so a restart, a deploy say, keeps what
 * an idle VP has not read; an item unread for RIDE_MAX_MS is dropped (the live lists have moved on).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../logging/index.js';
import { buildWalnutMessage as buildMessage } from '../peers/walnut-message-tag.js';

/** A ride-along item older than this is dropped unread: the live list has moved on. */
export const RIDE_MAX_MS = 3 * 24 * 60 * 60_000;
/** At most this many tasks ride one session: the oldest status lines go first, a completion or an
 *  error last (task_get and the Brief have the rest). */
const MAX_ITEMS = 20;
/** How long a told notice keeps a later line or team note about the same task quiet. */
const TOLD_KEEP_MS = 24 * 60 * 60_000;

export type RideNoticeKind = 'stopped' | 'blocked' | 'waiting' | 'completed' | 'error';
interface Part { text: string; at: number }
interface Item {
  at: number;
  line?: Part;
  /** The newest stop, block or park. */
  turn?: Part & { kind: RideNoticeKind };
  /** A completion or an error: kept when a later turn notice comes (a reopen). */
  end?: Part & { kind: RideNoticeKind };
}

const riding = new Map<string, Map<string, Item>>();
/** Session id → task id → when a notice about it (its edge) was last told to that session. */
const toldNotices = new Map<string, Map<string, number>>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let filePath: string | null = null;

async function storePath(): Promise<string> {
  if (filePath) return filePath;
  const { WALNUT_HOME } = await import('../../constants.js');
  filePath = path.join(WALNUT_HOME, 'cache', 'status-riding.json');
  return filePath;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; void save(); }, 1_000);
  saveTimer.unref?.();
}

async function save(): Promise<void> {
  try {
    const out: Record<string, Record<string, Item>> = {};
    for (const [sid, items] of riding) if (items.size) out[sid] = Object.fromEntries(items);
    const file = await storePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const { writeFileAtomic } = await import('../config-store.js');
    await writeFileAtomic(file, JSON.stringify({ version: 1, sessions: out }));
  } catch (err) {
    log.session.warn('status riding: not saved', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Boot: what was riding before the restart. */
export async function loadRiding(now = Date.now()): Promise<number> {
  try {
    const raw = JSON.parse(await fs.readFile(await storePath(), 'utf8')) as { sessions?: Record<string, Record<string, Item>> };
    let n = 0;
    for (const [sid, items] of Object.entries(raw.sessions ?? {})) {
      const held = riding.get(sid) ?? new Map<string, Item>();
      for (const [key, item] of Object.entries(items)) {
        if (!item || typeof item.at !== 'number' || now - item.at > RIDE_MAX_MS || held.has(key)) continue;
        held.set(key, item);
        n++;
      }
      if (held.size) riding.set(sid, held);
    }
    return n;
  } catch {
    return 0;
  }
}

function slot(sid: string, key: string, now: number): Item {
  const held = riding.get(sid) ?? new Map<string, Item>();
  riding.set(sid, held);
  const item = held.get(key) ?? { at: now };
  held.delete(key);
  held.set(key, item);
  item.at = now;
  // Past the cap the oldest go first: a status line before a notice, a completion or an error last.
  while (held.size > MAX_ITEMS) {
    const rank = (v: Item) => (v.end ? 2 : v.turn ? 1 : 0);
    let drop: string | undefined;
    for (const want of [0, 1, 2]) {
      for (const [id, v] of held) if (id !== key && rank(v) === want) { drop = id; break; }
      if (drop) break;
    }
    if (!drop) break;
    log.session.info('status riding: an item dropped past the cap', { sessionId: sid, taskId: drop, kind: held.get(drop)?.end?.kind ?? held.get(drop)?.turn?.kind ?? 'line' });
    held.delete(drop);
  }
  return item;
}

/** Whether a notice about `taskId` was told to the session at or after `sinceMs` (or still rides). */
export function noticeToldSince(sid: string, taskId: string, sinceMs: number): boolean {
  const item = riding.get(sid)?.get(taskId);
  if (item?.turn || item?.end) return true;
  const at = toldNotices.get(sid)?.get(taskId);
  return at !== undefined && at >= sinceMs;
}

/** The tasks whose notice rides the session's next message or was told to it at or after `sinceMs`. */
export function noticeKeysSince(sid: string, sinceMs: number): Set<string> {
  const out = new Set<string>();
  for (const [id, v] of riding.get(sid) ?? []) if (v.turn || v.end) out.add(id);
  for (const [id, at] of toldNotices.get(sid) ?? []) if (at >= sinceMs) out.add(id);
  return out;
}

function noteTold(sid: string, taskId: string, at: number): void {
  const told = toldNotices.get(sid) ?? new Map<string, number>();
  told.set(taskId, Math.max(at, told.get(taskId) ?? 0));
  toldNotices.set(sid, told);
}

/**
 * A status line about `key` (a task, or a subject such as a handed-on request). `movedAt`: when the
 * move it tells happened; a notice about the task told since (about then) said it already.
 */
export function rideLine(sid: string, key: string, line: string, now = Date.now(), movedAt?: number): boolean {
  if (movedAt !== undefined && !riding.get(sid)?.get(key)?.turn && !riding.get(sid)?.get(key)?.end
    && noticeToldSince(sid, key, movedAt - NOTICE_COVERS_MS)) return false;
  slot(sid, key, now).line = { text: line, at: now };
  scheduleSave();
  return true;
}

/** A notice told this long before a status move already said it (the move follows its edge). */
const NOTICE_COVERS_MS = 2 * 60_000;

/** A notice envelope about a task (org-follow.ts). */
export function rideNotice(sid: string, taskId: string, kind: RideNoticeKind, text: string, now = Date.now()): void {
  const item = slot(sid, taskId, now);
  if (kind === 'completed' || kind === 'error') {
    item.end = { kind, text, at: now };
    // A stop before the completion is no longer news.
    if (item.turn && item.turn.at <= now) delete item.turn;
  } else {
    item.turn = { kind, text, at: now };
  }
  scheduleSave();
}

export function pushBody(lines: readonly string[]): string {
  return [
    lines.length === 1 ? 'A task you follow changed its status (Walnut\'s record, not a report):' : `${lines.length} tasks you follow changed their status (Walnut's record, not a report):`,
    ...lines,
    'Read it as the live state: what the user was asked and has since done is no longer theirs to do. Nothing here asks you to act; task_get shows more.',
  ].join('\n');
}

/** The note that carries status lines. */
export function statusText(lines: readonly string[]): string {
  return buildMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: 'status', note: 'status changes of tasks you follow, not a work request' },
    body: pushBody(lines),
  });
}

/** A notice with the task's newest status line inside it, before its closing "Next:" list. */
function withLine(text: string, line: string): string {
  const add = `Its status now (Walnut's record): ${line.replace(/^- /, '')}`;
  const at = text.lastIndexOf('\n\nNext:\n');
  return at === -1 ? `${text}\n\n${add}` : `${text.slice(0, at)}\n\n${add}${text.slice(at)}`;
}

/** One item as it is told: the status lines alone, and the notices with their line inside. */
export function renderItems(items: Iterable<Item>): string {
  const lines: string[] = [];
  const notices: string[] = [];
  for (const item of [...items].sort((a, b) => a.at - b.at)) {
    const parts = [item.end, item.turn].filter((p): p is NonNullable<Item['end']> => !!p).sort((a, b) => a.at - b.at);
    if (parts.length === 0) { if (item.line) lines.push(item.line.text); continue; }
    parts.forEach((p, i) => notices.push(i === parts.length - 1 && item.line ? withLine(p.text, item.line.text) : p.text));
  }
  return [...(lines.length ? [statusText(lines)] : []), ...notices].join('\n\n');
}

/** What waits for a session's next message, or null. `markTold` once the message holding it is queued. */
export function pendingRiding(sessionId: string, now = Date.now()): { text: string; markTold: () => void } | null {
  const held = riding.get(sessionId);
  if (!held) return null;
  for (const [id, v] of held) if (now - v.at > RIDE_MAX_MS) held.delete(id);
  if (held.size === 0) { riding.delete(sessionId); return null; }
  const snapshot = new Map([...held].map(([id, v]) => [id, { item: v, at: v.at }] as const));
  return {
    text: renderItems([...snapshot.values()].map((s) => s.item)),
    markTold: () => {
      const cur = riding.get(sessionId);
      if (!cur) return;
      // Only what this message carried: a part that came meanwhile rides the next one.
      for (const [id, s] of snapshot) {
        const item = cur.get(id);
        if (!item) continue;
        if (item.line && item.line.at <= s.at) delete item.line;
        const toldAt = now;
        if (item.turn && item.turn.at <= s.at) { delete item.turn; noteTold(sessionId, id, toldAt); }
        if (item.end && item.end.at <= s.at) { delete item.end; noteTold(sessionId, id, toldAt); }
        if (!item.line && !item.turn && !item.end) cur.delete(id);
      }
      if (cur.size === 0) riding.delete(sessionId);
      scheduleSave();
    },
  };
}

/** Drop what is too old. */
export function pruneRiding(now = Date.now()): void {
  for (const [sid, held] of riding) {
    for (const [id, v] of held) if (now - v.at > RIDE_MAX_MS) held.delete(id);
    if (held.size === 0) riding.delete(sid);
  }
  for (const [sid, told] of toldNotices) {
    for (const [id, at] of told) if (now - at > TOLD_KEEP_MS) told.delete(id);
    if (told.size === 0) toldNotices.delete(sid);
  }
}

/** Shutdown: a save still waiting is written first (save reads the items before its first await). */
export function stopRiding(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; void save(); }
  clearRiding();
}

/** Test seams. */
export function clearRiding(): void {
  riding.clear();
  toldNotices.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  filePath = null;
}

export async function flushRidingForTest(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await save();
}

export function ridingKeys(sessionId: string): string[] {
  return [...(riding.get(sessionId)?.keys() ?? [])];
}
