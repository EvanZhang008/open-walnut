/**
 * What a triage run is TOLD about its letters and about its mode.
 *
 * Two rules live here, both of them one-source-of-truth problems:
 *
 *  - The letter budget's NUMBERS come from the enforcement
 *    (core/human-inbox/triage-quota.ts). The run must never be told "three" while
 *    the server counts something else, so the sentence interpolates the constants
 *    rather than spelling them.
 *
 *  - `mode` is the ONLY difference between `ask` and `assist`, and it is a
 *    difference in what the run may do WITHOUT ASKING — never in what may leave
 *    the machine. Sending mail, posting to Slack and marking Slack read go through
 *    their approval ops in both modes. `auto_mark_read` (off by default) is a
 *    separate switch that works in BOTH modes: with it a run may mark mail that asks
 *    nothing of the user read, which is the one mailbox change a run makes on its
 *    own. Nothing in either mode deletes, archives or moves mail. Anything that
 *    would let `assist` send something outward is a bug in this file, which is why
 *    the wording is pinned by a test.
 *
 * Pure text. `bootstrap.ts` appends it to the run instructions, so a mode change in
 * Settings re-patches the routine through the existing config watcher.
 */

import {
  TRIAGE_DECISION_LETTERS_PER_RUN,
  TRIAGE_SUMMARY_LETTERS_PER_RUN,
} from '../human-inbox/triage-quota.js';
import type { TriageMode } from './types.js';

/** The ops that always gate an outward action, in both modes. */
export const TRIAGE_APPROVAL_OPS = [
  'mail_request_send',
  'slack_request_post',
  'mail_unsubscribe_request',
] as const;

/** The letter budget, in the words the run reads. Identical in both modes. */
export function triageLetterBudgetText(): string {
  return [
    `Letters, per run: at most ${TRIAGE_SUMMARY_LETTERS_PER_RUN} summary letter`,
    '(type=review or info, with task_refs for every task you touched)',
    'For every email listed, include an independent items entry bound to its exact account/message.',
    'Keep safe cached display metadata and summary; never guess a source or a task target.',
    'Use fixed op actions mark_read, find_task and create_task only where the human should act.',
    'The human reviews task work in that item. Whole-letter actions only ask the AI a question.',
    'An agent reply may append new items with human_inbox_reply, using new unique item/action IDs.',
    'Label mailbox counts as a dated snapshot; groups and omitted-email counts have no actions.',
    'Send the summary only when this run has something for the user: a decision, or an item',
    'they need to know about. A run that only handed items to their tasks, updated notes or',
    'marked mail read sends no letter; State.md and the run journal record it.',
    `and at most ${TRIAGE_DECISION_LETTERS_PER_RUN} decision letters`,
    '(type=action_required, each with buttons the human can tap).',
    'The server refuses a fourth decision letter and tells you to fold the rest',
    'into the summary; do that instead of retrying.',
    'Withdraw a decision letter an earlier run left behind once its item is handled.',
  ].join('\n');
}

/**
 * When a run may mark mail read on its own, in the words it reads. The test is "asks nothing of the
 * user and no task needs it", not a sender list: a receipt for a purchase the user is tracking is
 * not noise, and a newsletter from a colleague's team usually is.
 */
export const TRIAGE_MARK_READ_RULE =
  'mark mail read with mail_mark_read when it is purely promotional or low importance (a newsletter, '
  + 'an ad, a receipt or notice that asks nothing of the user and that no task needs); when unsure, '
  + 'leave it unread';

/** True in both modes, and enforced by there being no tool for it. */
export const TRIAGE_NO_REMOVAL =
  'Nothing deletes, archives or moves mail, and you never ask to: no tool does it.';

/** What this mode lets the run do on its own. */
export function triageModeText(mode: TriageMode, autoMarkRead: boolean): string {
  if (mode === 'assist') {
    return [
      'Mode: assist. On your own you may create and update tasks, update the tracking notes,',
      `and run a one-click unsubscribe${autoMarkRead
        ? `, and ${TRIAGE_MARK_READ_RULE}.`
        : '. You may NOT mark mail as read (auto_mark_read is off).'}`,
      'Still ask, every time: sending mail, posting to Slack, and marking Slack read',
      `(${TRIAGE_APPROVAL_OPS.join(', ')}). assist changes what you may do without asking,`,
      'never what may leave this machine. The letter budget is the same as in ask mode.',
      TRIAGE_NO_REMOVAL,
    ].join('\n');
  }
  return [
    'Mode: ask. On your own you may only read, update the triage and tracking notes, and hand an',
    `item to the task that already owns it (task_send)${autoMarkRead ? `. You may also ${TRIAGE_MARK_READ_RULE}` : ''}.`,
    'Email work that needs confirmation goes in the summary as independent typed items:',
    'use create_task or find_task for task work, and mark_read for a single email.',
    'Other requests go to the user as a decision letter: editing a task or unsubscribing.',
    'Sending mail, posting to Slack and marking Slack read',
    `always go through their approval ops (${TRIAGE_APPROVAL_OPS.join(', ')}).`,
    TRIAGE_NO_REMOVAL,
  ].join('\n');
}

/** The whole block appended to a run's instructions. */
export function triageRunRules(mode: TriageMode, autoMarkRead: boolean): string {
  return `${triageLetterBudgetText()}\n\n${triageModeText(mode, autoMarkRead)}`;
}
