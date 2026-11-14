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
 *    the machine. Posting to Slack and marking Slack read go through their
 *    approval op in both modes. Anything that would let `assist` send something
 *    outward is a bug in this file, which is why the wording is pinned by a test.
 *
 * No mail rules: since 2026-11-14 the mail router owns every new mail, so a run
 * never reads, marks, answers or unsubscribes from mail (the old `auto_mark_read`
 * switch is ignored when read).
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
  'slack_request_post',
] as const;

/** The letter budget, in the words the run reads. Identical in both modes. */
export function triageLetterBudgetText(): string {
  return [
    `Letters, per run: at most ${TRIAGE_SUMMARY_LETTERS_PER_RUN} summary letter`,
    '(type=review or info, with task_refs for every task you touched).',
    'Walnut adds Talk to CEO and New task to every item itself: never make a task from a message,',
    'and add no task actions. Whole-letter actions only ask the AI a question.',
    'An agent reply may append new items with human_inbox_reply, using new unique item/action IDs.',
    'Send the summary only when this run has something for the user: a decision, or an item',
    'they need to know about. A run that only handed items to their tasks or updated notes',
    'sends no letter; State.md and the run journal record it.',
    `and at most ${TRIAGE_DECISION_LETTERS_PER_RUN} decision letters`,
    '(type=action_required, each with buttons the human can tap).',
    'The server refuses a fourth decision letter and tells you to fold the rest',
    'into the summary; do that instead of retrying.',
    'Withdraw a decision letter an earlier run left behind once its item is handled.',
  ].join('\n');
}

/** What this mode lets the run do on its own. */
export function triageModeText(mode: TriageMode): string {
  if (mode === 'assist') {
    return [
      'Mode: assist. On your own you may update existing tasks, hand an item to the task that owns it',
      '(task_send), and update the tracking notes.',
      'You never make a task from a message: its item offers the user New task and Talk to CEO.',
      'Still ask, every time: posting to Slack and marking Slack read',
      `(${TRIAGE_APPROVAL_OPS.join(', ')}). assist changes what you may do without asking,`,
      'never what may leave this machine. The letter budget is the same as in ask mode.',
    ].join('\n');
  }
  return [
    'Mode: ask. On your own you may only read, update the triage and tracking notes, and hand an',
    'item to the task that already owns it (task_send).',
    'Other requests go to the user as a decision letter: editing a task, for one.',
    'Posting to Slack and marking Slack read',
    `always go through their approval op (${TRIAGE_APPROVAL_OPS.join(', ')}).`,
  ].join('\n');
}

/** The whole block appended to a run's instructions. */
export function triageRunRules(mode: TriageMode): string {
  return `${triageLetterBudgetText()}\n\n${triageModeText(mode)}`;
}
