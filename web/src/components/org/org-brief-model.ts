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
 *  always the view a node opens on) or the Brief. */
export type OrgTopView = 'task' | 'brief';
const FOLDED_KEY = 'walnut.org.briefFolded';
const SEEN_KEY = 'walnut.org.briefSeen';

export function readBriefFolded(): boolean {
  try { return localStorage.getItem(FOLDED_KEY) === '1'; } catch { return false; }
}
export function writeBriefFolded(folded: boolean): void {
  try { localStorage.setItem(FOLDED_KEY, folded ? '1' : '0'); } catch { /* private mode: the pick lasts this page */ }
}

function seenMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>; } catch { return {}; }
}
/** Whether this Brief was rewritten since the user last read it here. */
export function briefUnread(taskId: string, at: string | undefined): boolean {
  if (!at) return false;
  const seen = seenMap()[taskId];
  return !seen || Date.parse(at) > Date.parse(seen);
}
export function markBriefSeen(taskId: string, at: string): void {
  try {
    const map = seenMap();
    map[taskId] = at;
    // The newest 50 owners: there are a handful of leads, never thousands.
    const kept = Object.fromEntries(Object.entries(map).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, 50));
    localStorage.setItem(SEEN_KEY, JSON.stringify(kept));
  } catch { /* as above */ }
}
