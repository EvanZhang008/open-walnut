/**
 * Built-in TASK-domain hooks (unified hook system).
 *
 * Ported from the retired src/core/task-phase-hooks/ registry — now driven by
 * the real task:phase-changed bus event, which fires from EVERY mutation path
 * (REST PATCH, agent task_update, session state machine, bulk, sync), not just
 * the REST handler the old executor was wired to.
 */

import type { SessionHookDefinition } from './types.js';

/** Auto-push on human verification.
 *
 *  sources is deliberately ['api', 'user'] — NOT 'agent'. The message tells the
 *  session "the user verified this work, commit it"; if an agent could set
 *  HUMAN_VERIFIED on its own task and thereby receive synthetic user approval,
 *  that is the same self-authorization failure as an automated cron-correction
 *  message claiming user authority (which a live CLI rightly refused,
 *  2026-08-11). Broaden via hooks.overrides only with eyes open. */
const humanVerifiedAutoPushHook: SessionHookDefinition = {
  id: 'human-verified-auto-push',
  name: 'Auto-push session on verify',
  description: 'When a task is marked HUMAN_VERIFIED by a human (REST/UI), sends a message to the active session instructing it to run code review and commit.',
  hooks: ['onTaskPhaseChanged'],
  action: {
    type: 'send_message_to_session',
    message: 'User has verified this work and approved it. Please proceed:\n1. Run /code-review to review all changes\n2. After review, run /close-session-with-commit to commit and close',
  },
  filter: {
    phases: ['HUMAN_VERIFIED'],
    sources: ['api', 'user'],
    requiresSession: true,
  },
  priority: 100,
  source: 'builtin',
};

/** All built-in task-domain hook definitions. */
export const builtinTaskHooks: SessionHookDefinition[] = [
  humanVerifiedAutoPushHook,
];
