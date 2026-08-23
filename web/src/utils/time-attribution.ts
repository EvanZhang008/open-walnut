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
 */

export type TimeKind = 'session' | 'triage' | 'chat';

export interface TimeContext {
  kind: TimeKind;
  taskId?: string;
  sessionId?: string;
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
    if (sessionId) return { kind: 'session', sessionId };

    // 2. Any task row/card/panel. div only — never a markdown anchor.
    const row = el.closest('div[data-task-id]');
    const taskId = attr(row, 'data-task-id');
    if (taskId) return { kind: 'triage', taskId };

    // 3. The main-agent chat.
    if (el.closest('.main-page-chat, .chat-panel')) return { kind: 'chat' };
  }

  // 4. The task detail route, for a click that landed on page chrome.
  const routeTaskId = taskIdFromPath(pathname);
  if (routeTaskId) return { kind: 'triage', taskId: routeTaskId };

  return null;
}

/** Two contexts are the same earner when kind + task + session all match. */
export function sameContext(a: TimeContext | null, b: TimeContext | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.taskId === b.taskId && a.sessionId === b.sessionId;
}
