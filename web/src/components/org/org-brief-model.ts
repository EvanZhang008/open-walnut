/**
 * Pure helpers of the Brief (OrgBrief.tsx). Kept free of React and the markdown pipeline so a node
 * test loads them.
 */
import { BRIEF_SECTIONS, type UserState } from '@open-walnut/user-status';

/** The part of a DOM element applyBriefDecorations touches (a node test passes a stand-in). */
export interface BriefPill {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  textContent?: string | null;
}

/**
 * Every task pill in the rendered Brief carries its task's live status (CSS draws the dot), so a
 * line the session wrote an hour ago still shows where each task stands now, and each of the three
 * section headings (BRIEF_SECTIONS) carries its section, for the same dot. Set in place: a status
 * change moves one attribute on one pill, instead of a new innerHTML that rebuilt the whole letter
 * every time any task it names changed state (2026-10-28, the user: the Org page "is flashing").
 * Returns how many attributes changed.
 */
export function applyBriefDecorations(
  root: { querySelectorAll(selector: string): Iterable<BriefPill> | ArrayLike<BriefPill> },
  states: ReadonlyMap<string, UserState>,
): number {
  let changed = 0;
  const put = (el: BriefPill, name: string, value: string | null) => {
    if (el.getAttribute(name) === value) return;
    if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
    changed += 1;
  };
  for (const el of Array.from(root.querySelectorAll('a[data-task-id]'))) {
    put(el, 'data-user-state', states.get(el.getAttribute('data-task-id') ?? '') ?? null);
  }
  for (const el of Array.from(root.querySelectorAll('h1, h2, h3, h4'))) {
    const text = (el.textContent ?? '').trim().toLowerCase();
    put(el, 'data-brief-section', BRIEF_SECTIONS.find((s) => s.heading.toLowerCase() === text)?.state ?? null);
  }
  return changed;
}

/** Above an Org node's chat: Task (Latest and its tasks by status, the Needs you cards first,
 *  the view a node first opens on; then the one it was left on), the Brief, or Threads (the user's own requests, OrgThreads). */
export const ORG_TOP_VIEWS = ['task', 'brief', 'threads'] as const;
export type OrgTopView = typeof ORG_TOP_VIEWS[number];
const FOLDED_KEY = 'walnut.org.briefFolded';
const SEEN_KEY = 'walnut.org.briefSeen';
const THREADS_SEEN_KEY = 'walnut.org.threadsSeen';

export function readBriefFolded(): boolean {
  try { return localStorage.getItem(FOLDED_KEY) === '1'; } catch { return false; }
}
export function writeBriefFolded(folded: boolean): void {
  try { localStorage.setItem(FOLDED_KEY, folded ? '1' : '0'); } catch { /* private mode: the pick lasts this page */ }
}

function seenMap(key = SEEN_KEY): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>; } catch { return {}; }
}
function unreadSince(key: string, taskId: string, at: string | null | undefined): boolean {
  if (!at) return false;
  const seen = seenMap(key)[taskId];
  return !seen || Date.parse(at) > Date.parse(seen);
}
function markSeen(key: string, taskId: string, at: string): void {
  try {
    const map = seenMap(key);
    if (map[taskId] && Date.parse(map[taskId]) >= Date.parse(at)) return;
    map[taskId] = at;
    // The newest 50 owners: there are a handful of leads, never thousands.
    const kept = Object.fromEntries(Object.entries(map).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, 50));
    localStorage.setItem(key, JSON.stringify(kept));
  } catch { /* as above */ }
}
/** Whether this Brief was rewritten since the user last read it here. */
export function briefUnread(taskId: string, at: string | undefined): boolean { return unreadSince(SEEN_KEY, taskId, at); }
export function markBriefSeen(taskId: string, at: string): void { markSeen(SEEN_KEY, taskId, at); }
/** Whether the threads he would see had news (thread-view.ts newsAt) since he last looked at Threads here. */
export function threadsUnread(taskId: string, at: string | null): boolean { return unreadSince(THREADS_SEEN_KEY, taskId, at); }
export function markThreadsSeen(taskId: string, at: string): void { markSeen(THREADS_SEEN_KEY, taskId, at); }

/** A line's task whose status moved since the letter was written (brief-fresh.ts BriefLineMove). */
export interface BriefMoveView { id: string; state: UserState; words: string }

const NOW_CLASS = 'org-brief-now';

/**
 * Each line whose task moved since the letter was written is marked as changed and carries its
 * task's live words under the writer's (2026-10-31, the user: a VP's Brief read 3.5 hours old), and
 * each line Walnut added for an ask the letter missed says so (`added`: id -> its note). A line is
 * a list item; its task is its first pill. Set in place like applyBriefDecorations, and undone on a
 * line whose task no longer reads so. Returns how many lines are marked.
 */
export function applyBriefMoves(root: HTMLElement, moves: ReadonlyMap<string, BriefMoveView>, added: ReadonlyMap<string, string> = new Map()): number {
  let marked = 0;
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const id = li.querySelector('a[data-task-id]')?.getAttribute('data-task-id') ?? '';
    const move = id ? moves.get(id) : undefined;
    const note = id && !move ? added.get(id) : undefined;
    let now = Array.from(li.children).find((c) => c.classList.contains(NOW_CLASS)) as HTMLElement | undefined;
    if (!move && !note) {
      li.removeAttribute('data-brief-moved');
      li.removeAttribute('data-brief-added');
      now?.remove();
      continue;
    }
    marked += 1;
    if (move) { li.setAttribute('data-brief-moved', move.state); li.removeAttribute('data-brief-added'); }
    else { li.setAttribute('data-brief-added', '1'); li.removeAttribute('data-brief-moved'); }
    if (!now) {
      now = li.ownerDocument.createElement('span');
      now.className = NOW_CLASS;
      now.setAttribute('data-testid', 'org-brief-now');
      li.appendChild(now);
    }
    const text = move ? `Now: ${move.words}` : note!;
    if (now.textContent !== text) now.textContent = text;
    now.setAttribute('data-user-state', move ? move.state : 'needs');
  }
  return marked;
}
