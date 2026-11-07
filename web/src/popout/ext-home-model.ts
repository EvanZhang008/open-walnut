/**
 * The extension's first page (ExtHome, design option A of 2026-11-07, the user: "the first page
 * should be create new task, it should also be able to show tasks like in the All, Focus etc, and
 * can search"): a new task composer over Home's task panel, with the browser relay in the header.
 * These are its rules, kept apart from React so they are tested on their own.
 *
 *   view → panel page   { walnut: 'ext-panel', type: 'mode', mode }        which page the view shows
 *   view → panel page   { walnut: 'ext-panel', type: 'snapshot', view: 'home', snap: HomeSnap }
 *
 * Both are for the extension's drawing of the next open (panel-look.ts): it draws the page the
 * view will show, in the same places. The relay's rules are ext-relay-model.ts.
 */
import type { CreateTaskInput } from '@/api/tasks';
import type { DraftColumn } from '@/components/sessions/draft-column';
import type { ImageAttachment } from '@/api/chat';
import type { EngineCatalog } from '@/utils/engines';
import { askLaunchBody, askTaskForLater, type TierKnown } from '@/components/chat/ask-object-draft';
import type { AskSessionLaunch } from '@/components/chat/ask-object-session';
import type { PanelPage } from './ext-panel-model';

/** Which page the panel shows: the first page, an ask's conversation, or a task opened from the list. */
export type PanelMode = 'home' | 'ask' | 'task';
export const isPanelMode = (v: unknown): v is PanelMode => v === 'home' || v === 'ask' || v === 'task';

/**
 * The first message's launch from the first page: Home's New task draft (Start Task), with the
 * page as a hint beside the words. A draft that names no folder starts in the task's own
 * directory (`ownTaskDir`): the extension has no folder picker.
 */
export function homeLaunchBody(input: {
  draft: DraftColumn;
  message: string;
  images?: ImageAttachment[];
  tierKnown: TierKnown;
  catalog: EngineCatalog;
  hints?: Record<string, { arg: string }>;
}): AskSessionLaunch {
  const body = askLaunchBody({ draft: { ...input.draft, walnut: false }, agentId: '', message: input.message, ...(input.images?.length ? { images: input.images } : {}), tierKnown: input.tierKnown, catalog: input.catalog });
  return { ...body, ...(input.hints ? { hints: input.hints } : {}), ...(!body.cwd && !body.host ? { ownTaskDir: true } : {}) };
}

/** "Save as todo" from the first page: the text's first line is the title, and the page it was on rides the description. */
export function homeTodoInput(input: { draft: DraftColumn; text: string; page: PanelPage | null; withPage: boolean; tierKnown: TierKnown }): CreateTaskInput | null {
  const p = input.withPage ? input.page : null;
  const block = p ? `From the browser: ${p.title ? `${p.title} (${p.url})` : p.url}` : '';
  return askTaskForLater({ draft: { ...input.draft, walnut: false }, text: input.text, contextBlock: block, tierKnown: input.tierKnown });
}

/**
 * A task's name on its page in the panel: its title, except Walnut's placeholder ("Session: <its
 * folder>") while its session has not titled it yet, where the first question names it.
 */
export function taskPageTitle(title: string | undefined, asked: string): string {
  if (title && !(asked && /^Session: /.test(title))) return title;
  return asked || title || 'Task';
}

/** The first page's composer placeholder. */
export const HOME_PLACEHOLDER = 'New task: what should Walnut do?';

/** What the drawing of the first page shows of the task panel (the tab strip, the first rows). */
export interface HomeSnap {
  tabs: Array<{ label: string; count?: string; on?: boolean }>;
  /** The first section's heading ("Needs you (5)"), when the list opens on one. */
  heading?: string;
  rows: Array<{ title: string; meta: string; line: string; time: string; needs: boolean }>;
}
export const HOME_SNAP_TABS = 6;
export const HOME_SNAP_ROWS = 10;

const textOf = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The task panel as it is drawn now, in words: its tab strip and its first rows (TodoPanel's own markup). */
export function homeSnapOf(root: ParentNode): HomeSnap | null {
  const list = root.querySelector('.todo-panel');
  if (!list) return null;
  const tabs = Array.from(list.querySelectorAll('.todo-section-tab')).slice(0, HOME_SNAP_TABS).map((t) => {
    const count = textOf(t.querySelector('.todo-section-tab-count'));
    const label = textOf(t.querySelector('.todo-section-tab-label'));
    return { label: cut(label, 30), ...(count ? { count: cut(count, 8) } : {}), ...(t.classList.contains('is-active') ? { on: true } : {}) };
  }).filter((t) => t.label);
  // The rows as the panel draws them: its sections' two-line cards and its project rows.
  const rows = Array.from(list.querySelectorAll('.todo-pinned-card, .todo-panel-item')).slice(0, HOME_SNAP_ROWS).map((r) => ({
    title: cut(textOf(r.querySelector('.todo-pinned-title, .todo-item-title')), 160),
    meta: cut(textOf(r.querySelector('.status-card-project, .todo-item-project')), 60),
    line: cut(textOf(r.querySelector('.status-card-needs-line, .status-card-reason, .todo-item-status-line')), 160),
    time: cut(textOf(r.querySelector('.todo-recent-ago')), 20),
    needs: r.classList.contains('todo-pinned-card-needs-action') || r.classList.contains('todo-panel-item-needs-action'),
  })).filter((r) => r.title);
  // The first section's heading as the panel draws it: "Needs you (5)".
  const head = list.querySelector('.status-section-heading');
  const headLabel = textOf(head?.querySelector('.navigation-label'));
  const headCount = textOf(head?.querySelector('.status-section-count'));
  const heading = cut(headLabel ? `${headLabel}${headCount ? ` (${headCount})` : ''}` : '', 40);
  return { tabs, ...(heading ? { heading } : {}), rows };
}

/** The task page's line when the tab Send was pressed in is no longer the one on show. */
export const ACT_TAB_MOVED = 'You moved to another tab while the task started, so it was given no tab. Turn on Act in this tab to give it this one.';

/**
 * Whether a task the first page started takes the tab on show: only when Act in this tab was on for
 * the tab Send was pressed in (`actTab`) and that tab is still the one on show (`tabNow`). A switch
 * in between hands over nothing (`moved`): the person allowed that tab, not this one, and the
 * task's context names that one (review round 5, #1).
 */
export function actCarriesTo(started: { act: boolean; actTab?: number } | undefined, tabNow: number | undefined): 'carry' | 'moved' | 'none' {
  if (!started?.act || started.actTab === undefined) return 'none';
  return started.actTab === tabNow ? 'carry' : 'moved';
}
