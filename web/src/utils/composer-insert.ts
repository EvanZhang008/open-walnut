/**
 * Push text into a session panel's composer from OUTSIDE that panel — the
 * bridge behind "Quote in session" on a task row.
 *
 * Same window-event pattern as `main:open-session` (open-session.ts): MainPage
 * and its session columns stay mounted behind every route, so a live panel for
 * the target session hears the event wherever the user is, appends the text to
 * its draft and focuses the box. The panel marks the event handled; when nobody
 * does (the session has no open column), the text goes straight into the
 * persisted draft that ChatInput restores on mount and the session is opened on
 * Home, so the quote is waiting when the panel appears. Either way the user
 * lands on Home looking at the composer that received it.
 */
import { openSessionOnHome } from './open-session';

export const COMPOSER_INSERT_EVENT = 'session:composer-insert';

export interface ComposerInsertDetail {
  sessionId: string;
  /** Appended after the current draft, one space apart ('lead': put in front of it). */
  text: string;
  /** 'lead' = the text starts the message and what was typed follows it ("Snooze this task until: "). */
  mode?: 'append' | 'lead';
  /** Set by the panel that consumed the event. */
  handled: boolean;
}

/** Draft key a session composer persists under (ChatInput `draftKey`). */
export function sessionDraftKey(sessionId: string): string {
  return `draft:session:${sessionId}`;
}

export type ComposerInsertOutcome = 'inserted' | 'queued';

/** Put `text` in front of a persisted draft; one it already leads is left as it is. */
export function leadStoredDraft(key: string, text: string): void {
  const raw = localStorage.getItem(key) ?? '';
  if (raw.trimStart().startsWith(text.trimEnd())) return;
  localStorage.setItem(key, `${text}${raw.trimStart()}`);
}

export function insertIntoSessionComposer(
  sessionId: string,
  text: string,
  navigate: (to: string) => void,
  mode: 'append' | 'lead' = 'append',
): ComposerInsertOutcome {
  const detail: ComposerInsertDetail = { sessionId, text, mode, handled: false };
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail }));
  if (detail.handled) {
    if (window.location.pathname !== '/') navigate('/');
    return 'inserted';
  }
  try {
    const key = sessionDraftKey(sessionId);
    if (mode === 'lead') {
      leadStoredDraft(key, text);
    } else {
      const current = (localStorage.getItem(key) ?? '').replace(/\s+$/, '');
      localStorage.setItem(key, current ? `${current} ${text}` : text);
    }
  } catch { /* storage unavailable: the open below still shows the session */ }
  openSessionOnHome(sessionId, navigate);
  return 'queued';
}
