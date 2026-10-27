/**
 * Pure helpers of the Brief (OrgBrief.tsx). Kept free of React and the markdown pipeline so a node
 * test loads them.
 */
import type { UserState } from '@open-walnut/user-status';

const TASK_ANCHOR_RE = /<a ([^>]*?)data-task-id="([^"]+)"/g;

/** Every task pill in the rendered Brief carries its task's live status (CSS draws the dot), so a
 *  line the session wrote an hour ago still shows where each task stands now. */
export function decorateBriefHtml(html: string, states: ReadonlyMap<string, UserState>): string {
  return html.replace(TASK_ANCHOR_RE, (m, pre: string, id: string) => {
    const state = states.get(id);
    return state ? `<a ${pre}data-user-state="${state}" data-task-id="${id}"` : m;
  });
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
