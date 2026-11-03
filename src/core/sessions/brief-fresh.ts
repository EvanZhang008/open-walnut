/**
 * Is a Brief still current? (2026-10-31, the user on a VP's Brief written 3.5 hours earlier while
 * its team moved on: "明显的感觉现在已经不是 up to date了 ... 我们还是没有一个方法能够去让这个 VP
 * 能够有 latest status".) Its node writes it when it has news (brief-write.ts), and an idle or
 * parked node runs no turn, so between writes its letter keeps the words it last wrote.
 *
 * Two answers share this file, pure so the web (OrgBrief.tsx) and the server read one rule:
 *  - between rewrites the page says how old the letter is and which of its lines moved since, each
 *    with its task's live words (briefFreshness); a task that newly asks the user and that the
 *    letter does not name is counted too;
 *  - when the user opens a node whose letter is stale, the server asks that node for one refresh
 *    turn (sessions/brief-refresh.ts), so its chat and its Brief are rewritten from the live state.
 *
 * "Moved" compares each named task's Brief mark (briefMark: whether it asks the user and what, or
 * finished) with the mark Walnut stored beside the letter when it was written (briefSnapshot). A
 * move between Working and Waiting is no news for the letter: every turn of a worker flips it
 * (Working is a turn running now), and the page puts each line under its live section anyway. A
 * letter stored before marks existed is read by its sections the same way: a line that left or
 * joined Needs you, or finished, moved.
 */
import { fallbackUserState, needsLineText, type BriefSectionTask, type TaskBrief, type UserState } from '../user-status.js';
import { briefAskScope, briefSectionOf, headingSection, type BriefSectionKey } from './brief-structure.js';

const WORDS_MAX = 160;
const REF_RE = /<task-ref\b[^>]*\bid="([^"]+)"/;

function clip(s: string | undefined): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > WORDS_MAX ? `${chars.slice(0, WORDS_MAX - 1).join('')}…` : flat;
}

type MarkTask = Pick<BriefSectionTask, 'phase' | 'status' | 'user_status'>;

function stateOf(task: MarkTask): UserState {
  if (task.phase === 'COMPLETE' || task.status === 'done') return 'done';
  return task.user_status?.state ?? fallbackUserState(task.phase, task.status);
}

/**
 * What of a status is news: its state, what it asks the user, on whom it waits. The one key a
 * status move is told by (status-push.ts seenOf) and a Brief line is judged moved by.
 */
export function statusMark(task: MarkTask): string {
  const state = stateOf(task);
  const s = state === 'done' ? undefined : task.user_status;
  const words = state === 'needs' ? clip(s?.ask) : state === 'waiting' || state === 'read' ? clip(s?.waitingOn) : '';
  return `${state}|${state === 'waiting' ? s?.kind ?? '' : ''}|${words}`;
}

/** What of a status the Brief is judged by: whether it asks the user and what, or finished. */
export function briefMark(task: MarkTask): string {
  const state = stateOf(task);
  // A node's Thread waiting on the user is his own request, no move of the letter (2026-11-03).
  if (state === 'needs' && task.user_status?.source === 'thread') return 'open';
  return state === 'needs' ? `needs|${clip(task.user_status?.ask)}` : state === 'done' ? 'done' : 'open';
}

/** A short stable hash of a mark, so a letter stores a few bytes per task (FNV-1a, 32 bit). */
export function markHash(mark: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < mark.length; i++) {
    h ^= mark.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The task each line of the letter is about (its first <task-ref/>), with the section it sits in. */
export function briefLineTasks(text: string, ownerId?: string): Array<{ id: string; section: BriefSectionKey | null }> {
  const out: Array<{ id: string; section: BriefSectionKey | null }> = [];
  const seen = new Set<string>();
  let current: BriefSectionKey | null = null;
  for (const line of text.split('\n')) {
    const heading = headingSection(line);
    if (heading) { current = heading; continue; }
    const id = line.match(REF_RE)?.[1];
    if (!id || id === ownerId || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, section: current });
  }
  return out;
}

/** A status between a turn's end and its report, or not derived yet, is no mark: the line is
 *  judged by its section until the next write (brief-write.ts derives the team's first). */
function settled(t: BriefSectionTask): boolean {
  return !!t.user_status && !t.user_status.transient;
}

/** What Walnut stores beside a letter when it is written: each named task's mark, and every task
 *  that asked the user then (a lead's team, Main's org), so a later ask the letter lacks is new. */
export function briefSnapshot(
  text: string, owner: BriefSectionTask, tasks: readonly BriefSectionTask[],
): Pick<TaskBrief, 'marks' | 'asks'> {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const marks: Record<string, string> = {};
  for (const { id } of briefLineTasks(text, owner.id)) {
    const t = byId.get(id);
    if (t && settled(t)) marks[id] = markHash(briefMark(t));
  }
  const asks = briefAskScope(owner, tasks).filter((t) => briefSectionOf(t) === 'needs').map((t) => t.id);
  return { marks, asks };
}

/** A task's words now, as a moved line shows them. */
export function liveWords(task: BriefSectionTask): string {
  const state = stateOf(task);
  const s = task.user_status;
  const snoozed = (s as { snoozed?: { until?: string } } | undefined)?.snoozed;
  if (state === 'done') return 'Completed';
  if (state === 'needs') return clip(s?.ask) || 'Needs you';
  if (state === 'read') return clip(s ? needsLineText(s) : '') || 'Take a look';
  if (state === 'waiting') {
    if (snoozed?.until) return `Snoozed until ${snoozed.until.slice(0, 10)}`;
    const on = clip(s?.waitingOn ?? s?.now);
    return on ? `Waiting on ${on}` : 'Waiting';
  }
  return clip(s?.now) || 'Working';
}

export interface BriefLineMove {
  id: string;
  state: UserState;
  words: string;
}

export interface BriefFreshness {
  /** When the letter was written (ISO). */
  writtenAt: string;
  /** The named tasks whose status moved since the letter was written (finished ones aside), in
   *  letter order. */
  moved: BriefLineMove[];
  /** Named tasks that finished since: their lines leave the letter (brief-structure.ts `live`). */
  finished: string[];
  /** Tasks that ask the user now, did not when the letter was written, and are not in it: Walnut
   *  adds each to Needs you in its own words (brief-structure.ts `live`). */
  newAsks: string[];
  /** Something moved: the letter no longer tells where the work stands. */
  stale: boolean;
}

/**
 * How current a node's Brief is, from the live tasks. Null when it keeps no Brief or has none.
 * A task between a turn's end and its report (a transient status) is not judged until the report.
 */
export function briefFreshness(owner: BriefSectionTask & { brief?: TaskBrief }, tasks: readonly BriefSectionTask[]): BriefFreshness | null {
  const brief = owner.brief;
  if (!brief?.text || (owner.org_role !== 'main' && owner.org_role !== 'lead')) return null;
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const writtenMs = Date.parse(brief.at);
  const legacy = !brief.marks;
  const moved: BriefLineMove[] = [];
  const finished: string[] = [];
  const named = new Set<string>();
  for (const { id, section } of briefLineTasks(brief.text, owner.id)) {
    named.add(id);
    const t = byId.get(id);
    if (!t || t.user_status?.transient) continue;
    const was = brief.marks?.[id];
    const now = briefSectionOf(t);
    const hasMoved = legacy || was === undefined
      ? section !== null && (now === null || (now === 'needs') !== (section === 'needs'))
      : markHash(briefMark(t)) !== was;
    if (!hasMoved) continue;
    if (now === null) finished.push(id);
    else moved.push({ id, state: stateOf(t), words: liveWords(t) });
  }
  const asked = new Set(brief.asks ?? []);
  const newAsks = briefAskScope(owner, tasks).filter((t) => {
    // A VP's Thread waiting on the user is his own request to it: no new ask for the letter's owner.
    if (named.has(t.id) || briefSectionOf(t) !== 'needs' || t.user_status?.transient || t.user_status?.source === 'thread') return false;
    if (!legacy && brief.asks) return !asked.has(t.id);
    // A letter stored before Walnut kept its asks: an ask set after the letter is new.
    const at = Date.parse(t.user_status?.at ?? t.phase_changed_at ?? '');
    return Number.isFinite(at) && Number.isFinite(writtenMs) && at > writtenMs;
  }).map((t) => t.id);
  return { writtenAt: brief.at, moved, finished, newAsks, stale: moved.length + finished.length + newAsks.length > 0 };
}

/** The header's words: "3 lines moved since · 1 finished · 1 ask added by Walnut". Empty when nothing moved. */
export function freshnessWords(f: Pick<BriefFreshness, 'moved' | 'finished' | 'newAsks'> | null): string {
  if (!f) return '';
  const parts: string[] = [];
  if (f.moved.length) parts.push(`${f.moved.length} ${f.moved.length === 1 ? 'line' : 'lines'} moved since`);
  if (f.finished.length) parts.push(`${f.finished.length} finished`);
  if (f.newAsks.length) parts.push(`${f.newAsks.length} ${f.newAsks.length === 1 ? 'ask' : 'asks'} added by Walnut`);
  return parts.join(' · ');
}

/** A refresh asked this recently is still on its way: the page says the Brief is updating. */
export const BRIEF_UPDATING_SHOW_MS = 10 * 60_000;

/** The last refresh turn Walnut asked of a node for its Brief (Task.brief_refresh). */
export interface BriefRefreshRecord {
  at: string;
  /** Who was looking: the web console (the Mac app included), the phone, or an agent's call. */
  by: 'web' | 'phone' | 'agent';
  /** Lines moved and new asks when it was asked. */
  moved: number;
  /** The note could not be delivered: nothing is on its way. */
  failed?: boolean;
  /** The asks of the user this note handed the node (task id -> the ask's words): the next
   *  refresh restates only what changed since (brief-refresh.ts needsChanges). */
  told?: Record<string, string>;
}

/** Whether the page shows the Brief as updating: a refresh asked after the letter, not long ago. */
export function briefUpdating(
  owner: { brief?: TaskBrief; brief_refresh?: BriefRefreshRecord | null }, now: number,
): boolean {
  if (owner.brief_refresh?.failed) return false;
  const asked = Date.parse(owner.brief_refresh?.at ?? '');
  if (!Number.isFinite(asked) || now - asked > BRIEF_UPDATING_SHOW_MS) return false;
  const written = Date.parse(owner.brief?.at ?? '');
  return !Number.isFinite(written) || written < asked;
}
