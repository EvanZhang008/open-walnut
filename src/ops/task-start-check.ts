/**
 * task_start_check: may this caller start a task in a mode right now? The start-mode ceiling a
 * start applies (core/sessions/delegated-mode.ts), read through the same chain as task_start's
 * (the daemon's vouch, the relay's held job token: plugin-jobs/job-caller.ts JOB_OPS), with no
 * task, no session and no write. Made for a plugin job's health check (2026-11-23: a ticket worker
 * looked healthy for 30 hours while its starts were capped at default and bypass refused).
 */
import { z } from 'zod'
import { SESSION_MODE_IDS } from '../core/types.js'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'

defineOp({
  name: 'task_start_check',
  title: 'Check whether you may start a task in a mode now',
  description:
    'Read-only: whether YOU (this caller: a session, a plugin job, the person) may start a task in `mode` right now, '
    + 'under the same start-mode ceiling task_create and task_start apply, read the way they read you. It creates no '
    + 'task, starts no session and writes nothing. Both answers are a success: {allowed: true, mode, caller} or '
    + '{allowed: false, mode, caller, reason} (reason: the refusal a start would get, word for word). `caller` is how '
    + 'Walnut read you: person, plugin, plugin-job, session or external (an outside caller, capped at default). It '
    + 'answers only the mode ceiling, never whether one given task can start (its host, its slots, while the Mac is '
    + 'away a task made on the Mac). A Walnut older than this op answers an error instead, code bad_request with a '
    + 'message starting "unknown op: task_start_check" in any case (a plugin job\'s walnut.ops.call throws an Error '
    + 'with that code and message): read that as "no such check here", never as not allowed.',
  input: {
    mode: z.enum(SESSION_MODE_IDS).describe('The permission mode you would start the task in'),
  },
  bind: { method: 'POST', path: '/tasks/start-check' },
  mapResult: ({ body }) => {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    return b.allowed === true
      ? withOutcome(b, `Starting a task in ${String(b.mode)} is allowed for this caller now.`, 'Start it with task_create or task_start in that mode.')
      : withOutcome(b, String(b.reason ?? `Starting a task in ${String(b.mode)} is not allowed for this caller now.`),
        'Do not start work in that mode: start it in a mode the reason allows, or ask the user to change the caller\'s mode.')
  },
  tags: { readonly: true, remote: 'allow' },
})
