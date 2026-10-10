/**
 * Time tracking — which context does an interaction signal belong to? PURE.
 *
 * One document-level listener feeds this with the event target; the resolver
 * walks up with closest() on attributes that already exist in the DOM, so no
 * session/task component needs to know time tracking exists.
 *
 * THE TRAP this file exists to avoid: `data-task-id` is also emitted on
 * markdown ANCHORS (`<a class="task-link" data-task-id=…>`) for a task the
 * transcript merely MENTIONS. A naive closest('[data-task-id]') inside a
 * session transcript therefore bills the mentioned task instead of the session.
 * Two defenses, both applied: the session panel is resolved FIRST (it is the
 * more specific container), and the task rule matches `div[data-task-id]` only,
 * which excludes anchors by construction.
 *
 * An element that matches nothing returns null — unattributable time is not
 * counted at all, so every recorded second belongs to a real context.
 *
 * Detail markers, read the same way (closest, inside the owning container):
 *   - `data-time-view` on a session panel's columns (chat, files, changed, board,
 *     terminal…): which part of the panel had the input;
 *   - `data-time-file` on the file viewer: the file open in it;
 *   - `data-time-item` on a plugin's own view (a channel, a thread, a letter),
 *     with `data-time-kind` (the plugin), `data-time-label` (what to call it)
 *     and `data-time-mode="reply"` on its reply box. It earns kind 'app'.
 * A change of any of them is a new context, so the old one is banked at the switch.
 */

export type TimeKind = 'session' | 'triage' | 'chat' | 'app';

export interface TimeContext {
  kind: TimeKind;
  taskId?: string;
  sessionId?: string;
  view?: string;
  file?: string;
  /** kind 'app': the plugin, its item, the item's label, and 'reply' while writing. */
  app?: string;
  item?: string;
  label?: string;
  mode?: string;
}

/** `/tasks/:id` → the id. Anything else → undefined. */
export function taskIdFromPath(pathname: string): string | undefined {
  const m = /^\/tasks\/([^/?#]+)/.exec(pathname);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]!);
  return id.length > 0 ? id : undefined;
}

function attr(el: Element | null, name: string): string | undefined {
  const v = el?.getAttribute(name);
  return v && v.length > 0 ? v : undefined;
}

/** The nearest `name` attribute at or above `el`, but only inside `owner`. */
function within(el: Element, owner: Element, name: string): string | undefined {
  const hit = el.closest(`[${name}]`);
  return hit && owner.contains(hit) ? attr(hit, name) : undefined;
}

/**
 * Resolve the context that owns a signal. `el` is the event target (or the
 * focused element); `pathname` is the current route.
 */
export function resolveAttribution(el: Element | null, pathname: string): TimeContext | null {
  if (el && typeof el.closest === 'function') {
    // 1. A session panel. Pending/draft panels carry no data-session-id (there
    //    is no real session yet), so they are excluded for free.
    const panel = el.closest('div.session-panel[data-session-id]');
    const sessionId = attr(panel, 'data-session-id');
    if (panel && sessionId) {
      const view = within(el, panel, 'data-time-view');
      const file = within(el, panel, 'data-time-file');
      return { kind: 'session', sessionId, ...(view ? { view } : {}), ...(file ? { file } : {}) };
    }

    // 1b. A plugin's own item. Only the reader's input reaches here: a message
    //     arriving in the view is not a DOM event, so it never extends a lease.
    const itemEl = el.closest('[data-time-item]');
    const item = attr(itemEl, 'data-time-item');
    if (itemEl && item) {
      const app = attr(el.closest('[data-time-kind]'), 'data-time-kind');
      const label = within(el, itemEl, 'data-time-label');
      const reply = within(el, itemEl, 'data-time-mode') === 'reply';
      return { kind: 'app', item, ...(app ? { app } : {}), ...(label ? { label } : {}), ...(reply ? { mode: 'reply' } : {}) };
    }

    // 2. Any task row/card/panel. div only — never a markdown anchor.
    const row = el.closest('div[data-task-id]');
    const taskId = attr(row, 'data-task-id');
    if (taskId) return { kind: 'triage', taskId };

    // 3. The home chat.
    if (el.closest('.main-page-chat, .chat-panel')) return { kind: 'chat' };
  }

  // 4. The task detail route, for a click that landed on page chrome.
  const routeTaskId = taskIdFromPath(pathname);
  if (routeTaskId) return { kind: 'triage', taskId: routeTaskId };

  return null;
}

/** Two contexts are the same earner when every field matches (a new view, file or item is a switch). */
export function sameContext(a: TimeContext | null, b: TimeContext | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.taskId === b.taskId && a.sessionId === b.sessionId
    && a.view === b.view && a.file === b.file && a.app === b.app && a.item === b.item
    && a.label === b.label && a.mode === b.mode;
}
