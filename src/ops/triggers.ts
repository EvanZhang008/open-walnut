/**
 * Trigger ops — the agent-facing surface of walnut-trigger.
 *
 * The shape an agent has to understand is small on purpose: write a script that
 * prints one JSON line, test it until it parses, then arm it. Everything the
 * descriptions here spend words on is a mistake that has to be prevented BEFORE
 * the first run, because a wrong check is a routine that either never fires or
 * fires every minute forever.
 */

import { z } from 'zod'
import { defineOp, type HttpBinding } from './registry.js'
import { withOutcome } from './outcome.js'

/** Human interval out of a stored `every` schedule. */
function everyLabel(everyMs: unknown): string {
  const ms = typeof everyMs === 'number' && Number.isFinite(everyMs) ? everyMs : 0
  if (ms <= 0) return 'unknown'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

const CHECK_CONTRACT =
  'The check reads ONE JSON object on stdin ({state, lastFireAt, now}) and must print ONE JSON object as '
  + 'the LAST line of stdout: {"fire":true|false, "items":[{"id":"..."}]?, "input":"free text for the AI '
  + 'this run"?, "state":{cursor}?}. Log freely above that line. `items[].id` is the DEDUP key: ids the '
  + 'daemon already delivered are dropped, so fire:true with only known ids is quiet, and fire:true with '
  + 'NO items fires every single time (the script did its own judging). `input` goes to the AI THIS run; '
  + '`state` is the script talking to its NEXT run (stored verbatim, handed back on stdin). They are never '
  + 'merged. Non-zero exit, a timeout, no JSON on the last line, or over 64KB of stdout is a check error; '
  + 'five in a row disable the trigger.'

const TRIGGER_LIST_BINDING: HttpBinding = { method: 'GET', path: '/routines' }

defineOp({
  name: 'trigger_create',
  title: 'Create a Walnut trigger',
  description:
    'Arm a check script the daemon on a host runs on an interval, delivering a prompt into a session '
    + 'when it fires. Use it for "tell me when X happens", "watch this and act", "keep an eye on Y". '
    + `${CHECK_CONTRACT} `
    + 'Write the script to a file first (~/.open-walnut/triggers/<slug>/check.sh) and run trigger_test '
    + 'until it parses — a trigger armed on an unparseable script only reports errors. `every` accepts '
    + '"30s" / "5m" / "1h" or a number of ms; never poll faster than 10s, and 5m is the sensible default. '
    + 'session defaults to "this" (the calling session\'s task), so a fire lands in this conversation even '
    + 'if it has gone quiet meanwhile (it is resumed; a new session on the same task only if none can be '
    + 'resumed). Pass a task id to point it elsewhere; a completed task is an error, never a resurrected one. '
    + 'Keep credentials inside the script file: `run` is stored with the routine and shown on its card. '
    + '`description` is required: the card otherwise shows only a name and a script path, which does not '
    + 'tell the user what fires it. '
    + 'To snooze the task until something happens ("snooze this until CR 1234 is approved"), pass '
    + '`wait_until` with the condition: the same call parks the task on the new trigger before its first '
    + 'check runs, so the task stays a quiet To Do (no Need Action, no red dot) until the trigger fires. '
    + 'Every snooze has a backstop, `wait_ttl` (default 7 days): if the trigger has not fired by then, the '
    + 'task comes back to the user anyway, in case the check never works. Size it to when the user would '
    + 'want to hear that it has not happened yet (a build: hours; a review or a reply: a few days).',
  input: {
    run: z.string().min(1).describe('Shell command that decides whether to fire (e.g. "bash ~/.open-walnut/triggers/pr-comments/check.sh")'),
    every: z.union([z.number().int().positive(), z.string().min(1)])
      .describe('Poll interval: "30s" | "5m" | "1h", or milliseconds. Minimum 10s'),
    prompt: z.string().min(1).describe('What the session should DO when it fires — the message it receives'),
    description: z.string().min(1)
      .describe('One or two plain sentences for the user: what this watches, when it fires, and what the session '
        + 'does then (e.g. "Checks PR 123 for new review comments every 5 minutes; when one arrives, the session '
        + 'addresses it and replies on the PR."). Shown on the task\'s trigger card, so name the real source'),
    name: z.string().optional().describe('Routine name shown on the Routines page (defaults to the prompt\'s opening words)'),
    session: z.string().optional().describe('"this" (default) = the calling session\'s task; or an explicit task id'),
    cwd: z.string().optional().describe('Working directory for the check (defaults to the calling session\'s cwd)'),
    host: z.string().optional().describe('Host whose daemon runs the check (defaults to the calling session\'s host)'),
    timeoutSeconds: z.number().int().positive().optional().describe('Kill the check after this long (default 30, max 300)'),
    maxFiresPerDay: z.number().int().min(0).optional().describe('Daily fire cap (default 24). 0 = unlimited'),
    wait_until: z.string().min(1).optional()
      .describe('Snooze the target task until this happens, one line in the user\'s words (e.g. "CR 1234 is '
        + 'approved"); shown on the task. The fire ends the snooze'),
    wait_ttl: z.union([z.number().int().positive(), z.string().min(1)]).optional()
      .describe('With wait_until: the backstop, "90m" | "12h" | "3d" (1 minute to 30 days, default 7 days). '
        + 'If the trigger has not fired by then, the task comes back to the user as Need Action'),
  },
  bind: { method: 'POST', path: '/routines/trigger' },
  mapResult: ({ body }) => {
    const b = (body ?? {}) as {
      job?: { id?: string; name?: string; schedule?: { everyMs?: number } }; host?: string
      task?: { id?: string; waiting?: { condition?: string; until?: string } }
    }
    const id = b.job?.id ?? ''
    const every = everyLabel(b.job?.schedule?.everyMs)
    const snoozed = b.task?.waiting?.condition
    if (snoozed) {
      return withOutcome(
        { ...b },
        `Trigger armed on ${b.host ?? 'its host'} (checks every ${every}), and the task is snoozed until: ${snoozed}. `
        + 'It stays To Do with no red dot, messages included; the fire lands in this session and ends the snooze'
        + `${b.task?.waiting?.until ? `, and if it has not fired by ${b.task.waiting.until} the task comes back anyway` : ''}.`,
        'Tell the user in one line what the task waits for and how often it is checked, then end your turn. '
        + `Unsnooze with walnut tools call task_stop_waiting '{"task":"${b.task?.id ?? 'this'}"}'.`,
      )
    }
    return withOutcome(
      { ...b },
      `Trigger armed on ${b.host ?? 'its host'}: the daemon there runs the check every ${every} and `
      + 'delivers the prompt when it fires. It keeps polling while Walnut restarts.',
      `Tell the user in one line what is watched and how often. Turn it off with `
      + `walnut tools call trigger_delete '{"id":"${id}"}'; see its last check with trigger_list.`,
    )
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'trigger_list',
  title: 'List Walnut triggers',
  description:
    'Every armed and disabled trigger: id, name, description, interval, host, whether it is enabled, how many times '
    + 'it has fired, the last check the daemon reported (fired with an item count / quiet with a reason / '
    + 'the error text) and the recent check history. Use it to answer "what are you watching?" and to '
    + 'check whether a trigger you created is healthy — a trigger disabled with an error is one whose '
    + 'script kept failing, and one that has never fired may be a script that never says fire.',
  input: {},
  bind: TRIGGER_LIST_BINDING,
  handler: async (_args, call) => {
    // includeDisabled is pinned rather than exposed: a trigger that was
    // auto-disabled for check errors is exactly what a caller needs to see.
    const body = await call('GET', '/routines?includeDisabled=true') as { jobs?: unknown[] } | undefined
    const jobs = Array.isArray(body?.jobs) ? body.jobs : []
    const triggers = jobs
      .map((raw) => raw as {
        id?: string; name?: string; description?: string; enabled?: boolean
        schedule?: { everyMs?: number }
        check?: { run?: string; host?: string; cwd?: string }
        state?: {
          lastCheck?: unknown; nextRunAtMs?: number; fireCount?: number
          checkLog?: Array<Record<string, unknown>>
        }
      })
      .filter((job) => job.check && typeof job.check.run === 'string')
      .map((job) => ({
        id: job.id,
        name: job.name,
        ...(job.description ? { description: job.description } : {}),
        every: everyLabel(job.schedule?.everyMs),
        host: job.check?.host ?? '__local__',
        enabled: job.enabled === true,
        run: job.check?.run,
        ...(job.check?.cwd ? { cwd: job.check.cwd } : {}),
        fires: job.state?.fireCount ?? 0,
        ...(job.state?.lastCheck ? { lastCheck: job.state.lastCheck } : {}),
        ...(typeof job.state?.nextRunAtMs === 'number'
          ? { nextCheckAt: new Date(job.state.nextRunAtMs).toISOString() } : {}),
        // The audit trail, trimmed for a tool answer: the verdicts and where each
        // fire went, without the injected-text previews (those are for the UI —
        // a caller that wants the message reads the session).
        ...(Array.isArray(job.state?.checkLog) && job.state.checkLog.length > 0
          ? {
            recentChecks: job.state.checkLog.slice(0, 6).map((entry) => {
              const { injected: _injected, epoch: _epoch, ...rest } = entry as Record<string, unknown>
              const atMs = typeof rest.atMs === 'number' ? rest.atMs : undefined
              return { ...rest, ...(atMs ? { at: new Date(atMs).toISOString() } : {}), atMs: undefined }
            }),
          }
          : {}),
      }))
    return {
      count: triggers.length,
      triggers,
      ...(triggers.length === 0 ? { hint: 'No triggers armed. trigger_create arms one.' } : {}),
    }
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'trigger_test',
  title: 'Test a trigger check script',
  description:
    'Run a check ONCE on its host and report exactly what the daemon saw: exit code, stdout/stderr tails, '
    + 'the parsed object, whether it WOULD fire, and how many items are new. Reads and writes no state, so '
    + 'it is safe to run repeatedly. Always do this before trigger_create and keep fixing until '
    + '`parsed` is non-null: `error` names the contract violation (not JSON on the last line, "fire" '
    + 'missing, an item with no id). wouldFire:false with parsed set is a WORKING script that simply has '
    + 'nothing to report right now. '
    + CHECK_CONTRACT,
  input: {
    run: z.string().min(1).describe('The shell command to run once'),
    cwd: z.string().optional().describe('Working directory for the run'),
    host: z.string().optional().describe('Host whose daemon runs it (default: this machine)'),
    timeoutSeconds: z.number().int().positive().optional().describe('Kill it after this long (default 30, max 300)'),
    id: z.string().optional().describe('Existing trigger id — measures newItemCount against ITS seen set'),
  },
  bind: { method: 'POST', path: '/routines/check-test' },
  // A handler, not a plain binding: the route takes a nested { check } object,
  // while an agent should type the four fields flat.
  handler: async (args, call) => {
    const { id, ...check } = args
    const body = await call('POST', '/routines/check-test', {
      check,
      ...(typeof id === 'string' && id ? { id } : {}),
    }) as { result?: Record<string, unknown> } | undefined
    const result = (body?.result ?? {}) as {
      parsed?: unknown; wouldFire?: boolean; newItemCount?: number; error?: string | null
    }
    const outcome = result.parsed
      ? result.wouldFire
        ? `The script parsed and WOULD fire now (${result.newItemCount ?? 0} new item(s)).`
        : 'The script parsed and would NOT fire right now — that is a working check with nothing to report.'
      : `The script did not produce a usable answer: ${result.error ?? 'no JSON on the last line of stdout'}`
    return withOutcome(
      { ...(body ?? {}) },
      outcome,
      result.parsed
        ? 'Arm it with trigger_create (same run/cwd/host), then tell the user what is watched and how often.'
        : 'Fix the script so its LAST stdout line is one JSON object with a boolean "fire", then test again.',
    )
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'trigger_delete',
  title: 'Delete a Walnut trigger',
  description:
    'Remove a trigger: the daemon drops its timer, its seen set and any queued fire on the next push. '
    + 'The check script FILE is left on disk, so this is reversible by arming it again — which is why it '
    + 'is not marked destructive. Deleting a routine that is not a trigger works the same way.',
  input: {
    id: z.string().min(1).describe('Trigger (routine) id, as returned by trigger_create / trigger_list'),
  },
  bind: { method: 'DELETE', path: '/routines/:id' },
  mapResult: ({ args }) => withOutcome(
    { deleted: true, id: args.id },
    'Trigger deleted. Nothing polls for it any more, and its check script file is untouched.',
    'Nothing else is required.',
  ),
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'task_wait',
  title: 'Make a Walnut task wait until a trigger fires',
  description:
    'Park a task on an existing trigger until it fires ("wait until CR 1234 is approved"). A NEW snooze is '
    + 'one call instead: trigger_create with `wait_until`. Use this to keep waiting after a fire that does '
    + 'not need the user yet (same routine_id), or to park on a trigger that already exists. The task stays '
    + 'To Do and in every list, but a finished turn no longer hands it back: no Need Action, no red dot, '
    + 'until the trigger fires, and a message from the user does not end it either. The fire is delivered '
    + 'into this session with a note; when that turn ends the task goes back to the user as Need Action, '
    + 'unless you call task_wait again with the same routine_id. Do not set the task to Need Action '
    + 'yourself afterwards: that ends the wait.',
  input: {
    condition: z.string().min(1)
      .describe('What the task waits for, in the user\'s words, one line (e.g. "CR 1234 is approved")'),
    routine_id: z.string().min(1).describe('The trigger id trigger_create returned; it must deliver to this task'),
    ttl: z.union([z.number().int().positive(), z.string().min(1)]).optional()
      .describe('The backstop, "90m" | "12h" | "3d": if the trigger has not fired by then, the task comes back. '
        + 'Omitted: a re-arm keeps the backstop it had, a new wait gets 7 days'),
    task: z.string().optional().describe('"this" (default) = the calling session\'s task, or a task id'),
  },
  bind: { method: 'POST', path: '/tasks/:id/wait' },
  handler: async (args, call) => {
    const id = typeof args.task === 'string' && args.task.trim() ? args.task.trim() : 'this'
    const body = await call('POST', `/tasks/${encodeURIComponent(id)}/wait`, {
      condition: args.condition, routine_id: args.routine_id, ...(args.ttl !== undefined ? { ttl: args.ttl } : {}),
    }) as { task?: { id?: string; phase?: string; waiting?: { since?: string; until?: string; woke_at?: string; woke_reason?: string } } } | undefined
    const w = body?.task?.waiting
    if (w?.woke_reason === 'fired' && w.woke_at && w.since && w.since >= w.woke_at) {
      // setTaskWaiting found the trigger had fired before this call (its first
      // check runs seconds after trigger_create): nothing was parked.
      return withOutcome(
        { ...(body ?? {}) },
        `The trigger already fired (${w.woke_at}) before the wait was set, so the task is NOT waiting: `
        + 'the condition may already be met, and that fire is in this session (now or right after this turn).',
        'Read that fire and tell the user what it means; the task goes back to them when this turn ends. If it '
        + 'does not need them yet, call task_wait again with the same routine_id to keep waiting.',
      )
    }
    return withOutcome(
      { ...(body ?? {}) },
      `The task is waiting until: ${String(args.condition)}. It stays To Do with no red dot; the trigger's fire `
      + 'lands in this session and ends the wait'
      + `${w?.until ? `, and if it has not fired by ${w.until} the task comes back anyway` : ''}.`,
      'Tell the user in one line what the task waits for, then end your turn. Stop it with '
      + `walnut tools call task_stop_waiting '{"task":"${body?.task?.id ?? id}"}'.`,
    )
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'task_stop_waiting',
  title: 'Stop a Walnut task waiting',
  description:
    'End a wait set with task_wait: the task stays To Do, and the trigger behind the wait is deleted '
    + '(its check script file stays on disk). Nothing happens when the task is not waiting.',
  input: {
    task: z.string().optional().describe('"this" (default) = the calling session\'s task, or a task id'),
  },
  bind: { method: 'DELETE', path: '/tasks/:id/wait' },
  handler: async (args, call) => {
    const id = typeof args.task === 'string' && args.task.trim() ? args.task.trim() : 'this'
    const body = await call('DELETE', `/tasks/${encodeURIComponent(id)}/wait`) as Record<string, unknown> | undefined
    return withOutcome(
      { ...(body ?? {}) },
      'The task is no longer waiting, and its trigger was deleted.',
      'Nothing else is required.',
    )
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})
