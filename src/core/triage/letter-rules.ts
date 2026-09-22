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
 *    their approval ops in both modes; `auto_mark_read` (off by default) is the one
 *    extra permission `assist` can be given, and it is an existing config key, not
 *    a new one. Anything that would let `assist` send something outward is a bug in
 *    this file, which is why the wording is pinned by a test.
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
    `and at most ${TRIAGE_DECISION_LETTERS_PER_RUN} decision letters`,
    '(type=action_required, each with buttons the human can tap).',
    'The server refuses a fourth decision letter and tells you to fold the rest',
    'into the summary; do that instead of retrying.',
    'Withdraw a decision letter an earlier run left behind once its item is handled.',
  ].join('\n');
}

/** What this mode lets the run do on its own. */
export function triageModeText(mode: TriageMode, autoMarkRead: boolean): string {
  if (mode === 'assist') {
    return [
      'Mode: assist. On your own you may create and update tasks, update the tracking notes,',
      `and run a one-click unsubscribe${autoMarkRead
        ? ', and mark the mail you triaged as read.'
        : '. You may NOT mark mail as read (auto_mark_read is off).'}`,
      'Still ask, every time: sending mail, posting to Slack, and marking Slack read',
      `(${TRIAGE_APPROVAL_OPS.join(', ')}). assist changes what you may do without asking,`,
      'never what may leave this machine. The letter budget is the same as in ask mode.',
    ].join('\n');
  }
  return [
    'Mode: ask. On your own you may only read, update the triage and tracking notes, and ask a',
    'task (task_send). Everything else goes to the user as a decision letter: creating or',
    'editing a task, marking mail read, unsubscribing. Sending mail, posting to Slack and',
    `marking Slack read always go through their approval ops (${TRIAGE_APPROVAL_OPS.join(', ')}).`,
  ].join('\n');
}

/** The whole block appended to a run's instructions. */
export function triageRunRules(mode: TriageMode, autoMarkRead: boolean): string {
  return `${triageLetterBudgetText()}\n\n${triageModeText(mode, autoMarkRead)}`;
}
