/**
 * "Snooze until something happens" entry points (the task menu's Start / Snooze
 * until row, the composer "+" menu). Neither sets the wait itself: the row starts
 * a message to the task's own session, whose AI has the context (which CR, which
 * channel, which host) to write the trigger and park the task (walnut-trigger
 * skill, `task_wait`). The user finishes the sentence and sends it.
 *
 * The message names the skill: `/walnut-trigger …` makes Claude Code load it
 * before the first word is read, instead of hoping the model matches "snooze
 * until" against the skill's description. The skill is distributed to every
 * host (src/core/skill-sync.ts). An ACP engine gets the plain sentence: its
 * slash commands are its own, and the words alone still point at the skill.
 *
 * A task with a session gets the words at the front of that session's composer;
 * a task without one gets a draft column bound to it (MainPage handles
 * WAIT_UNTIL_EVENT), so the first message starts its session.
 */
import type { Task } from '@open-walnut/core';
import { resolveTaskSessionId } from './session-status';
import { COMPOSER_INSERT_EVENT, insertIntoSessionComposer, type ComposerInsertDetail } from './composer-insert';

/** The words the message starts with; the user types the condition after them. */
export const WAIT_UNTIL_TEXT = 'Snooze this task until: ';
export const WAIT_UNTIL_SKILL = '/walnut-trigger';
/** The composer "+" menu's row. */
export const WAIT_UNTIL_LABEL = 'Snooze until something happens…';
/** The row under the times in the task menu's Start / Snooze until. */
export const WAIT_UNTIL_MENU_LABEL = 'Something happens…';
export const WAIT_UNTIL_TITLE =
  'Tell the AI what to wait for. It sets up a trigger (walnut-trigger skill); the task stays To Do with no red dot until it fires';
/** Detail: `{ task }`. Heard by MainPage, which opens the bound draft. */
export const WAIT_UNTIL_EVENT = 'task:wait-until';

/** The message start: the skill command for Claude Code, the plain sentence for an ACP engine. */
export function waitUntilPrefix(opts?: { acp?: boolean }): string {
  return opts?.acp ? WAIT_UNTIL_TEXT : `${WAIT_UNTIL_SKILL} ${WAIT_UNTIL_TEXT}`;
}

/** True when `text` already starts with either form (a second click only refocuses). */
export function startsWithWaitUntil(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(waitUntilPrefix().trimEnd()) || t.startsWith(WAIT_UNTIL_TEXT.trimEnd());
}

export function requestWaitUntil(task: Task, navigate: (to: string) => void): 'session' | 'draft' {
  const sessionId = resolveTaskSessionId(task);
  if (sessionId) {
    // The session panel picks the form for its engine (SessionPanel's insert handler).
    insertIntoSessionComposer(sessionId, waitUntilPrefix(), navigate, 'lead');
    return 'session';
  }
  window.dispatchEvent(new CustomEvent(WAIT_UNTIL_EVENT, { detail: { task } }));
  if (window.location.pathname !== '/') navigate('/');
  return 'draft';
}

/**
 * Put text at the start of a draft column's composer. A draft already on screen
 * hears the event; one that is about to mount reads its persisted draft instead.
 */
export function seedDraftComposer(draftId: string, text: string, storageKey: string): void {
  const detail: ComposerInsertDetail = { sessionId: draftId, text, mode: 'lead', handled: false };
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail }));
  if (detail.handled) return;
  try { localStorage.setItem(storageKey, text); } catch { /* storage unavailable */ }
}
