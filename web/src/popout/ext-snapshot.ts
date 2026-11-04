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

export interface AskSnap { title: string; host: string; messages: Array<{ role: 'user' | 'assistant'; text: string }> }
export interface TasksSnap { sections: Array<{ title: string; rows: Array<{ title: string; line: string; state: string }> }> }

export const SNAP_MESSAGES = 4;
export const SNAP_TEXT_MAX = 600;
export const SNAP_ROWS = 14;

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
