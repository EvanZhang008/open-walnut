/**
 * Pure helpers of the Brief (OrgBrief.tsx). Kept free of React and the markdown pipeline so a node
 * test loads them.
 */
import type { UserState } from '@open-walnut/user-status';

const TASK_ANCHOR_RE = /<a ([^>]*?)data-task-id="([^"]+)"/g;

/** Every task pill in the rendered Brief carries its task's live status (CSS draws the dot), so a
 *  line the session wrote an hour ago still shows where each task stands now. */
export function decorateBriefHtml(
  html: string, states: ReadonlyMap<string, UserState>, partial?: ReadonlySet<string>,
  unverified?: ReadonlySet<string>,
): string {
  return html.replace(TASK_ANCHOR_RE, (m, pre: string, id: string) => {
    const state = states.get(id);
    // A task whose latest result left things not done says so on its pill (structured-reply.ts).
    const part = partial?.has(id) ? 'data-partial="1" ' : '';
    // A "needs you" its session confirmed long ago says it may be done already (user-status.ts checkedLine).
    const check = unverified?.has(id) ? 'data-unverified="1" ' : '';
    return state || part || check ? `<a ${pre}${state ? `data-user-state="${state}" ` : ''}${part}${check}data-task-id="${id}"` : m;
  });
}

/** The part of a DOM element applyBriefDecorations touches (a node test passes a stand-in). */
export interface BriefPill {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * The same marks decorateBriefHtml writes, set on the rendered letter in place. A status change
 * then moves one attribute on one pill, instead of a new innerHTML that rebuilt the whole letter
 * every time any task it names changed state (2026-10-28, the user: the Org page "is flashing").
 * Returns how many attributes changed.
 */
export function applyBriefDecorations(
  root: { querySelectorAll(selector: string): Iterable<BriefPill> | ArrayLike<BriefPill> },
  states: ReadonlyMap<string, UserState>, partial?: ReadonlySet<string>, unverified?: ReadonlySet<string>,
): number {
  let changed = 0;
  const put = (el: BriefPill, name: string, value: string | null) => {
    if (el.getAttribute(name) === value) return;
    if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
    changed += 1;
  };
  for (const el of Array.from(root.querySelectorAll('a[data-task-id]'))) {
    const id = el.getAttribute('data-task-id') ?? '';
    put(el, 'data-user-state', states.get(id) ?? null);
    put(el, 'data-partial', partial?.has(id) ? '1' : null);
    put(el, 'data-unverified', unverified?.has(id) ? '1' : null);
  }
  return changed;
}

export type OrgTopView = 'status' | 'brief';
const VIEW_KEY = 'walnut.org.topView';
const FOLDED_KEY = 'walnut.org.briefFolded';
const SEEN_KEY = 'walnut.org.briefSeen';

/** The view the user last picked above the chat: Status (the counts' line and Needs you) unless
 *  they picked the Brief. */
export function readTopView(): OrgTopView {
  try { return localStorage.getItem(VIEW_KEY) === 'brief' ? 'brief' : 'status'; } catch { return 'status'; }
}
export function writeTopView(view: OrgTopView): void {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode: the pick lasts this page */ }
}
export function readBriefFolded(): boolean {
  try { return localStorage.getItem(FOLDED_KEY) === '1'; } catch { return false; }
}
export function writeBriefFolded(folded: boolean): void {
  try { localStorage.setItem(FOLDED_KEY, folded ? '1' : '0'); } catch { /* as above */ }
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
