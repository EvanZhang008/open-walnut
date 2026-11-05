/**
 * The side panel's Tasks view (PopoutExtTasks): which of the person's tasks it lists and what
 * each row says, kept apart from React so it is tested on its own. The lists are Home's: what
 * is in their Focus (the board's Focus tier, whatever it needs), then what else needs them (To
 * read drawn with it, as everywhere); each task once.
 */
import type { Task } from '@open-walnut/core';
import { MARKED_ASK, NEEDS_CATEGORY_LABELS, needsLineOf, shownState, stateWord, storedUserState } from '@open-walnut/user-status';
import { taskUserState } from '@/utils/session-status';

export const EXT_TASKS_MAX = 30;

export interface ExtTaskRow { task: Task; state: ReturnType<typeof shownState>; label: string; line: string }

const oneLine = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

/**
 * A Needs you row's line: its category, then what tells it apart from the rows around it. That is
 * the task's own ask; else the words its last turn ended with (task.last_words); else the category
 * alone. Walnut's stock sentences ("Its turn ended without asking you anything", "It was set to
 * need you by hand") say the same on every row, so they are never the words here.
 */
export function needsRowLine(task: Task): string {
  const s = task.user_status;
  if (!s) return '';
  const line = needsLineOf(s);
  if (!line) return '';
  const own = storedUserState(s) === 'needs' && s.ask !== MARKED_ASK ? oneLine(s.ask) : '';
  const words = own || oneLine(task.last_words?.text);
  return [NEEDS_CATEGORY_LABELS[line.category], words].filter(Boolean).join(': ');
}

function rowOf(task: Task): ExtTaskRow {
  const state = shownState(taskUserState(task));
  const s = task.user_status;
  const line = s ? (state === 'needs' ? needsRowLine(task) : (s.waitingOn ?? s.ask ?? '')) : '';
  return { task, state, label: stateWord(state, !!s?.snoozed), line: oneLine(line) };
}

const newest = (a: Task, b: Task) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));

/**
 * `kept`: tasks the person answered from this panel. Once answered a task usually needs them no
 * more, yet the row stays where they left it (with its new state) until the panel closes, so the
 * answer does not make it vanish from under them.
 */
export function extTaskLists(tasks: readonly Task[], kept: ReadonlySet<string> = new Set()): { needs: ExtTaskRow[]; focus: ExtTaskRow[] } {
  // Open, and not parked out of sight: Home hides a WAITING task unless its own work goes on or it
  // has something to read (TodoPanel's hiddenAsWaiting), so the panel does too.
  const open = tasks.filter((t) => {
    const state = taskUserState(t);
    const parked = t.phase === 'WAITING' && state !== 'working' && state !== 'read' && !kept.has(t.id);
    return state !== 'done' && !t.plugin_only && !parked;
  });
  // Focus is the board's Focus tier, as Home counts it: every open task in it, whatever it needs
  // (its row says so). Needs you is the rest that needs the person, so each task shows once.
  const focus = open.filter(inFocus).sort(newest);
  const needs = open.filter((t) => !inFocus(t) && (shownState(taskUserState(t)) === 'needs' || kept.has(t.id))).sort(newest);
  return { needs: needs.slice(0, EXT_TASKS_MAX).map(rowOf), focus: focus.slice(0, EXT_TASKS_MAX).map(rowOf) };
}

/**
 * The row's status line under a section. "Needs you" is left out under Needs you (the section says
 * it) and wherever the line leads with what to do (Take a look, Decide...), which says it already.
 */
export function rowLine(row: Pick<ExtTaskRow, 'label' | 'line'>, section: 'focus' | 'needs'): string {
  const label = row.label === 'Needs you' && (section === 'needs' || !!row.line) ? '' : row.label;
  return [label, row.line].filter(Boolean).join(' · ');
}

/** In the person's Focus already (the board's Focus tier). */
export function inFocus(t: Task): boolean { return !!t.pinned && t.focus_tier === 'focus'; }

/** A task for later, made from the page the person is on: its title, and the address to come back to. */
export function pageTaskInput(page: { url: string; title?: string }): { title: string; description: string } {
  let host = page.url;
  try { host = new URL(page.url).host; } catch { /* the address as it is */ }
  const title = (page.title?.trim() || host).slice(0, 200);
  return { title, description: `From the browser: ${page.url}` };
}

/**
 * The lists as the panel last showed them, kept in this browser so the next open shows them at
 * once while the tasks load (a row's words and its conversation, nothing else). A list newer than
 * the person's last look is always fetched; this is only what shows before it lands.
 */
export interface KeptTaskLists { at: number; needs: ExtTaskRow[]; focus: ExtTaskRow[] }
const KEPT_KEY = 'walnut.ext-tasks.lists';
/** Older than this, the kept lists say too little of now to show (the loading line shows instead). */
export const KEPT_MAX_AGE_MS = 7 * 24 * 3600_000;

type KeptStore = Pick<Storage, 'getItem' | 'setItem'>;
const keptStore = (): KeptStore | null => { try { return window.localStorage; } catch { return null; } };

/** A row cut to what the list draws and the reply needs. */
function keptRow(r: ExtTaskRow): ExtTaskRow {
  const t = r.task;
  const session = t.session_id || t.exec_session_id || t.plan_session_id || (t.session_ids?.length ? t.session_ids[t.session_ids.length - 1] : undefined);
  return { state: r.state, label: r.label, line: r.line, task: { id: t.id, title: t.title, ...(session ? { session_id: session } : {}) } as Task };
}

export function keepTaskLists(lists: { needs: ExtTaskRow[]; focus: ExtTaskRow[] }, s: KeptStore | null = keptStore(), now = Date.now()): void {
  const kept: KeptTaskLists = { at: now, needs: lists.needs.map(keptRow), focus: lists.focus.map(keptRow) };
  try { s?.setItem(KEPT_KEY, JSON.stringify(kept)); } catch { /* full or blocked: the next open waits for the list */ }
}

export function keptTaskLists(s: KeptStore | null = keptStore(), now = Date.now()): KeptTaskLists | null {
  try {
    const v = JSON.parse(s?.getItem(KEPT_KEY) ?? 'null') as KeptTaskLists | null;
    if (!v || typeof v.at !== 'number' || now - v.at > KEPT_MAX_AGE_MS || !Array.isArray(v.needs) || !Array.isArray(v.focus)) return null;
    const ok = (r: unknown): r is ExtTaskRow => !!r && typeof r === 'object' && typeof (r as ExtTaskRow).task?.id === 'string' && typeof (r as ExtTaskRow).task?.title === 'string';
    return { at: v.at, needs: v.needs.filter(ok), focus: v.focus.filter(ok) };
  } catch { return null; }
}

/** What the open row says the task asked: its status line in full, then its last words when they add to it. */
export function askedOf(task: Task, line: string): string[] {
  const out: string[] = [];
  const full = line.trim();
  if (full) out.push(full);
  const last = task.last_words?.text?.replace(/\s+/g, ' ').trim();
  if (last && !full.includes(last.slice(0, 60))) out.push(last);
  return out;
}
