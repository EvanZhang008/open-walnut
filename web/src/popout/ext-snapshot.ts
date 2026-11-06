/**
 * What a side panel view shows, in words only, for the extension's panel page to draw the next
 * time the panel opens while this view loads again (sidepanel.ts `panel-snap`): the whole
 * Walnut page takes about a second to start in its frame, the panel page's own drawing is there
 * at once. The view says `shown` once its own content is on screen and the drawing goes.
 *
 *   view → panel page   { walnut: 'ext-panel', type: 'snapshot', view: 'ask', key, snap: AskSnap }
 *   view → panel page   { walnut: 'ext-panel', type: 'snapshot', view: 'tasks', snap: TasksSnap }
 *   view → panel page   { walnut: 'ext-panel', type: 'shown' }
 *
 * Text only, cut short: the panel page draws it with textContent, never as markup.
 */
import { pageKey } from './ext-panel-model';

/** An ask in the Continue list, as the row draws it (`time` its words: "3h ago"). */
export interface ContinueSnap { title: string; line: string; time: string; needs: boolean }
/**
 * The page's conversation, and the view around it so the panel page draws the same thing while the
 * view loads (the header's title and agent, the composer's placeholder, the Continue rows, the
 * suggestion chips, whether the page chip is on). The view's fields are left out when not shown.
 */
export interface AskSnap {
  title: string; host: string; messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  askTitle?: string; agent?: string; placeholder?: string; continue?: ContinueSnap[]; suggestions?: string[]; pageOn?: boolean;
}
export interface TasksSnap { sections: Array<{ title: string; rows: Array<{ title: string; line: string; state: string }> }> }

export const SNAP_MESSAGES = 4;
export const SNAP_TEXT_MAX = 600;
export const SNAP_ROWS = 14;
export const SNAP_CONTINUE = 6;
/** The key of a tab that shows no web page (a new tab, the browser's own pages). */
export const NO_PAGE_SNAP_KEY = 'web:none';
export const SNAP_SUGGESTIONS = 3;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The conversation's last few messages as the chat draws them (its rows' own text). */
export function askSnapOf(root: ParentNode, page: { url: string; title?: string }, host: string): AskSnap {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.session-msg.session-msg-user, .session-msg.session-msg-assistant'));
  const messages: AskSnap['messages'] = [];
  for (const row of rows) {
    const body = row.querySelector<HTMLElement>('.session-msg-content .markdown-body');
    const text = (body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    messages.push({ role: row.classList.contains('session-msg-user') ? 'user' : 'assistant', text: cut(text, SNAP_TEXT_MAX) });
  }
  return { title: cut(page.title ?? host, 200), host, messages: messages.slice(-SNAP_MESSAGES) };
}

export function snapKeyOf(url: string): string {
  return pageKey(url);
}

const textOf = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The view around the conversation as it is drawn now (the fields of AskSnap past `messages`). */
export function askViewSnapOf(root: ParentNode): Omit<AskSnap, 'title' | 'host' | 'messages'> {
  const askTitle = cut(textOf(root.querySelector('[data-testid="ext-ask-title"]')), 200);
  const agent = cut(textOf(root.querySelector('.ext-ask-head .ext-ask-agent')), 60);
  const input = root.querySelector('.chat-input-box textarea') ?? root.querySelector('textarea');
  const placeholder = cut(input?.getAttribute('placeholder') ?? '', 120);
  const cont = Array.from(root.querySelectorAll('[data-testid="ext-continue-row"]')).slice(0, SNAP_CONTINUE).map((row) => ({
    title: cut(textOf(row.querySelector('.ask-walnut-drawer-item-title')), 200),
    line: cut(textOf(row.querySelector('.ask-walnut-drawer-item-line')), 200),
    time: cut(textOf(row.querySelector('.ask-walnut-drawer-item-time')), 30),
    needs: row.getAttribute('data-needs') === 'true',
  })).filter((r) => r.title);
  // A stem chip names its blank in its label ("Which task is …"): the words the person reads.
  const suggestions = Array.from(root.querySelectorAll('.draft-walnut-suggests .session-action-chip')).slice(0, SNAP_SUGGESTIONS)
    .map((c) => cut(c.getAttribute('aria-label') ?? textOf(c), 60)).filter(Boolean);
  const chip = root.querySelector('[data-testid="ext-panel-include"]');
  return {
    ...(askTitle ? { askTitle } : {}),
    ...(agent ? { agent } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(cont.length ? { continue: cont } : {}),
    ...(suggestions.length ? { suggestions } : {}),
    ...(chip ? { pageOn: chip.getAttribute('aria-checked') === 'true' } : {}),
  };
}

/**
 * The popup's key. The popup shows no conversation (its question goes to the side panel), so what
 * it sends is only the shell (the Continue rows, the agent) every placeholder draws; under the
 * page's own key its empty chat replaced the side panel's conversation of that page, and the next
 * panel open drew "New chat" until the real conversation loaded (review 2026-11-06). The extension
 * keeps the shell from any key, and no page's key is this one.
 */
export const POPUP_SNAP_KEY = 'popup:shell';

/** Where a snapshot of the Ask view is kept: the page's conversation in the side panel, the shell alone for the popup. */
export function askSnapKey(surface: 'panel' | 'popup', pageUrl: string): string {
  if (surface === 'popup') return POPUP_SNAP_KEY;
  return pageUrl ? snapKeyOf(pageUrl) : NO_PAGE_SNAP_KEY;
}

/** Quiet time after the last change before the view's words are sent again. */
export const SNAP_QUIET_MS = 400;
/** A view that keeps changing (a reply streaming in) is still sent at least this often. */
export const SNAP_MAX_WAIT_MS = 1500;

interface SnapTimers { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void; now: () => number }
const realTimers: SnapTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * When to send the view's words again: a change waits for SNAP_QUIET_MS of quiet, but never longer
 * than SNAP_MAX_WAIT_MS after the first change not sent yet, so a conversation that keeps moving
 * (a reply streaming, a ticking line) still reaches the extension's drawing. Sending only what
 * differs from the last send is the caller's.
 */
export function snapSchedule(send: () => void, timers: SnapTimers = realTimers, quietMs = SNAP_QUIET_MS, maxWaitMs = SNAP_MAX_WAIT_MS) {
  let timer: unknown = null;
  let firstChange = 0;
  const fire = () => { timer = null; firstChange = 0; send(); };
  return {
    /** Something on screen changed. */
    poke(): void {
      const now = timers.now();
      if (!firstChange) firstChange = now;
      if (timer !== null) timers.clear(timer);
      timer = timers.set(fire, Math.max(0, Math.min(quietMs, firstChange + maxWaitMs - now)));
    },
    /** Send now (the page is going away). */
    flush(): void { if (timer !== null) timers.clear(timer); fire(); },
    cancel(): void { if (timer !== null) timers.clear(timer); timer = null; firstChange = 0; },
  };
}
