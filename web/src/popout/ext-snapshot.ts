/**
 * What a side panel view shows, in words only, for the extension's panel page to draw the next
 * time the panel opens while this view loads again (sidepanel.ts `panel-snap`): the whole
 * Walnut page takes about a second to start in its frame, the panel page's own drawing is there
 * at once. The view says `shown` once its own content is on screen and the drawing goes.
 *
 *   view → panel page   { walnut: 'ext-panel', type: 'snapshot', view: 'ask', key, agentId, snap: AskSnap }
 *   view → panel page   { walnut: 'ext-panel', type: 'agent', agentId }   the agent the Ask view is on
 *   view → panel page   { walnut: 'ext-panel', type: 'snapshot', view: 'tasks', snap: TasksSnap }
 *   view → panel page   { walnut: 'ext-panel', type: 'shown' }
 *
 * Text only, cut short: the panel page draws it with textContent, never as markup. `agent` names the
 * agent the view shows (it opens on the agent picked last, in any window), so the next open draws
 * that agent's words and no other's.
 */
import { pageKey } from './ext-panel-model';

/** An ask in the Continue list, as the row draws it (`time` its words: "3h ago"). */
export interface ContinueSnap { title: string; line: string; time: string; needs: boolean }
/**
 * The open conversation, and the view around it so the panel page draws the same thing while the
 * view loads (the header's title and agent, the composer's placeholder, the Continue rows, the
 * suggestion chips, whether the page chip is on). The view's fields are left out when not shown.
 */
export interface AskSnap {
  /**
   * `page` and `quote`: what a person's message took from the page, drawn in their bubble ("Release
   * notes 4.2 · example.test", and the text quoted from it), so the bubble does not grow when the
   * real view replaces the drawing (review R2-6).
   */
  title: string; host: string; messages: Array<{ role: 'user' | 'assistant'; text: string; page?: string; quote?: string }>;
  /**
   * `suggestionIcons[i]` names the icon of `suggestions[i]` ('search', 'calendar', 'clock'; '' for
   * none): the drawing draws the chips as the view does, icon and label (review R2-6).
   */
  askTitle?: string; agent?: string; placeholder?: string; continue?: ContinueSnap[]; suggestions?: string[]; suggestionIcons?: string[]; pageOn?: boolean;
  /**
   * The page the words were taken on (`snapKeyOf`), absent with no page: `pageOn` is that page's
   * chip. The conversation stays as the person moves on, so the next open may be on another page,
   * whose chip the drawing cannot know from these words.
   */
  pageKey?: string;
}
export interface TasksSnap { sections: Array<{ title: string; rows: Array<{ title: string; line: string; state: string }> }> }

export const SNAP_MESSAGES = 4;
export const SNAP_TEXT_MAX = 600;
export const SNAP_ROWS = 14;
export const SNAP_CONTINUE = 6;
export const SNAP_SUGGESTIONS = 3;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const textOf = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The conversation's last few messages as the chat draws them (its rows' own text). */
export function askSnapOf(root: ParentNode, page: { url: string; title?: string }, host: string): AskSnap {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.session-msg.session-msg-user, .session-msg.session-msg-assistant'));
  const messages: AskSnap['messages'] = [];
  for (const row of rows) {
    const body = row.querySelector<HTMLElement>('.session-msg-content .markdown-body');
    const text = (body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    const user = row.classList.contains('session-msg-user');
    const page = user ? textOf(row.querySelector('[data-testid="ext-panel-attached-page"] .ext-panel-attached-page-text')) : '';
    const quote = user ? textOf(row.querySelector('[data-testid="ext-panel-attached"] blockquote')) : '';
    messages.push({ role: user ? 'user' : 'assistant', text: cut(text, SNAP_TEXT_MAX), ...(page ? { page: cut(page, 200) } : {}), ...(quote ? { quote: cut(quote, 300) } : {}) });
  }
  return { title: cut(page.title ?? host, 200), host, messages: messages.slice(-SNAP_MESSAGES), ...(page.url ? { pageKey: snapKeyOf(page.url) } : {}) };
}

export function snapKeyOf(url: string): string {
  return pageKey(url);
}


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
  const chips = Array.from(root.querySelectorAll('.draft-walnut-suggests .session-action-chip')).slice(0, SNAP_SUGGESTIONS)
    .map((c) => ({ label: cut(c.getAttribute('aria-label') ?? textOf(c), 60), icon: c.getAttribute('data-icon') ?? '' })).filter((c) => c.label);
  const suggestions = chips.map((c) => c.label);
  const suggestionIcons = chips.map((c) => c.icon);
  const chip = root.querySelector('[data-testid="ext-panel-include"]');
  return {
    ...(askTitle ? { askTitle } : {}),
    ...(agent ? { agent } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(cont.length ? { continue: cont } : {}),
    ...(suggestions.length ? { suggestions, ...(suggestionIcons.some(Boolean) ? { suggestionIcons } : {}) } : {}),
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

/**
 * The side panel's key: the open conversation of one agent, whatever the page (PopoutExtPanel keeps
 * one conversation per agent as the person moves from page to page, review 2026-11-06 round 3), so
 * the next open draws it on any page, or on none. One key per agent: a switch to another agent in
 * the popup or another window must not leave this agent's question for that agent's next open
 * (round 3 code review, item 3). No page's key starts this way.
 */
export const PANEL_SNAP_PREFIX = 'panel:agent:';

/** Where a snapshot of the Ask view is kept: the agent's open conversation in the side panel, the shell alone for the popup. */
export function askSnapKey(surface: 'panel' | 'popup', agentId: string): string {
  return surface === 'popup' ? POPUP_SNAP_KEY : `${PANEL_SNAP_PREFIX}${agentId}`;
}

/** `shown` waits for the view's paint (two animation frames), at most this long. */
export const SHOWN_AFTER_PAINT_MAX_MS = 100;

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
