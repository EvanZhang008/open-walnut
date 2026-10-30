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
import { triggerRunState } from '../core/cron/trigger-run-state.js'

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
  + 'merged. Non-zero exit, a timeout, no JSON on the last line, or over 64KB of stdout is a check error: '
  + 'the first one is reported into this session, and five in a row stop the trigger and tell the user. '
  + 'One bad item does not fail the run: an id over 200 chars is shortened to a stable id (its head plus a '
  + 'hash, the original kept as fullId) and an item with no string id is dropped, each with a warning in the '
  + 'fire and on the History row; only output with no usable item left is an error.'

const TRIGGER_LIST_BINDING: HttpBinding = { method: 'GET', path: '/routines' }

/** What resuming does, in one place for both ops and the skill. */
const RESUME_SEMANTICS =
  'Resuming picks up where it left off: the daemon kept the trigger\'s seen ids and the script\'s cursor, so '
  + 'whatever appeared while it was paused arrives as ONE fire on the first check (a few seconds after resume; '
  + 'up to 200 items, the rest on the next check), ids it delivered in the last 30 days are not delivered again, '
  + 'and the fire budget still applies (a spent budget holds the backlog for a later check, it never drops it). After about 30 '
  + 'days paused it may have forgotten what it saw and start over like a new trigger.'

type RoutineJobBody = {
  job?: {
    id?: string; name?: string; enabled?: boolean; check?: unknown; schedule?: { everyMs?: number }
    state?: { pausedAtMs?: number; consecutiveErrors?: number }
  }
}

/** Switch a trigger on or off by id; refuses a routine that is not a trigger. */
async function setTriggerEnabled(
  id: string,
  enabled: boolean,
  call: (method: HttpBinding['method'], path: string, body?: unknown) => Promise<unknown>,
): Promise<{ job: NonNullable<RoutineJobBody['job']>; changed: boolean }> {
  const path = `/routines/${encodeURIComponent(id)}`
  const current = (await call('GET', path) as RoutineJobBody | undefined)?.job
  if (!current) throw new Error(`no trigger ${id}; trigger_list shows the ids`)
  if (!current.check) throw new Error(`${id} ("${current.name ?? ''}") is a scheduled routine, not a trigger`)
  if (current.enabled === enabled) return { job: current, changed: false }
  const updated = (await call('PATCH', path, { enabled }) as RoutineJobBody | undefined)?.job ?? current
  return { job: updated, changed: true }
}

defineOp({
  name: 'trigger_create',
  title: 'Create a Walnut trigger',
  description:
    'Arm a check script the daemon on a host runs on an interval, delivering a prompt into a session '
    + 'when it fires. Use it for "tell me when X happens", "watch this and act", "keep an eye on Y". '
    + 'Look at trigger_templates FIRST: when a plugin offers the watch (a Slack channel, new mail), pass '
    + '`template` + `params` instead of writing a script. '
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
    + 'It PARKS your own task by default: the task goes to Waiting (off the user\'s list, no letter is sent), '
    + 'and the fire (or its clock, wait_until) brings it back. Set wait_until yourself to when you expect the '
    + 'event, kept short (hours, a day at most unless the user named a later time; 1 day when left out): a new '
    + 'trigger may be wrong or miss the event, and the clock running out is how you find out. On each fire and '
    + 'each clock wake, look at the thing itself and at whether the trigger is still right and enough, fix it, '
    + 'and only then park again with a fresh wait_until. '
    + 'Pass wait:false while you or the user still have '
    + 'work on this task, and park it later with task_update phase=WAITING once only the wait is left. '
    + 'The main agent\'s task is never parked: it stays active, so it passes wait:false. '
    + 'Use it on your own whenever the rest of the work is waiting on something outside this session '
    + '(a review, a merge, a deploy, a build, someone\'s reply): do not ask the user to watch it.',
  input: {
    run: z.string().min(1).optional().describe('Shell command that decides whether to fire (e.g. "bash ~/.open-walnut/triggers/pr-comments/check.sh"). '
      + 'Required unless `template` is given'),
    template: z.string().optional().describe('A plugin trigger template id from trigger_templates (e.g. "slack:channel-message"). '
      + 'With it, Walnut builds the check itself: no script, no trigger_test; run/host/cwd are not used, and every/prompt/description '
      + 'default to the template\'s'),
    params: z.record(z.string(), z.string()).optional().describe('The template\'s params, e.g. {"channel":"#eng-oncall"}'),
    every: z.union([z.number().int().positive(), z.string().min(1)]).optional()
      .describe('Poll interval: "30s" | "5m" | "1h", or milliseconds. Minimum 10s. Required unless `template` is given'),
    prompt: z.string().min(1).optional().describe('What the session should DO when it fires — the message it receives. '
      + 'When the user asked to be told ("tell me when X"), say so here: "send the user a letter saying X happened"; '
      + 'without that ask a fire sends no letter. Required unless `template` is given (then it replaces the template\'s default)'),
    description: z.string().min(1).optional()
      .describe('One or two plain sentences for the user: what this watches, when it fires, and what the session '
        + 'does then (e.g. "Checks PR 123 for new review comments every 5 minutes; when one arrives, the session '
        + 'addresses it and replies on the PR."). Shown on the task\'s trigger card, so name the real source. '
        + 'Required unless `template` is given'),
    name: z.string().optional().describe('Routine name shown on the Routines page (defaults to the prompt\'s opening words)'),
    session: z.string().optional().describe('"this" (default) = the calling session\'s task; or an explicit task id'),
    cwd: z.string().optional().describe('Working directory for the check (defaults to the calling session\'s cwd)'),
    host: z.string().optional().describe('Host whose daemon runs the check (defaults to the calling session\'s host). '
      + 'A session on another host may arm checks only on its own host'),
    timeoutSeconds: z.number().int().positive().optional().describe('Kill the check after this long (default 30, max 300)'),
    maxFiresPerDay: z.number().int().min(0).optional().describe('Fire budget: up to this many fires in a burst, refilling at this many per 24h (default 24, so once an hour once spent; a held fire comes later, never lost). For a busy source checked often (chat, mail) set it to the checks per day, e.g. 288 for every 5m. 0 = unlimited'),
    wait: z.boolean().optional().describe('Park the task the fire lands in (Waiting) until it fires. Default true for your own task, '
      + 'false for another task. Pass false while you or the user still have work on this task'),
    watches: z.string().optional().describe('What this trigger watches for you, so Walnut\'s 4-hour re-check of it stays quiet while '
      + 'the trigger is armed: "ask" = your status\'s ask of the user, or a letter id (lt-...) you sent them'),
    wait_until: z.string().optional().describe('When the parked task comes back by itself if nothing fired: an ISO datetime or a duration '
      + 'from now ("2h", "1d"). Set it to when you expect the event, kept short: it is the check that the trigger works. '
      + 'Default 1 day; "" = no clock (only when the user asked for no time limit)'),
  },
  // The old park receipt's text (removed 2026-10-05), still sent by older sessions.
  retiredInput: ['wait_report'],
  bind: { method: 'POST', path: '/routines/trigger' },
  mapResult: ({ body, args }) => {
    const b = (body ?? {}) as {
      job?: { id?: string; name?: string; schedule?: { everyMs?: number } }; host?: string
      wait?: { parked?: boolean; reason?: string; wait_until?: string | null; error?: string }
    }
    const id = b.job?.id ?? ''
    const every = everyLabel(b.job?.schedule?.everyMs)
    const armed = `Trigger armed on ${b.host ?? 'its host'}: the daemon there runs the check every ${every} and `
      + 'delivers the prompt when it fires. It keeps polling while Walnut restarts.'
    const off = `Turn it off with walnut tools call trigger_delete '{"id":"${id}"}' once it has done its job.`
    const w = b.wait
    // What the call did to the task is said in the outcome, so the model never
    // tells the user "it is waiting" when it is not, or the reverse.
    // A park on the default clock is a guess at when to look again; the model
    // usually knows better (a CI run takes minutes, a review a day).
    const unnamed = w?.parked && (args as { wait_until?: unknown } | undefined)?.wait_until === undefined
      ? ' You named no wait_until: when you can tell when it should happen, set one (task_update wait_until), kept short.'
      : ''
    const parked = w?.parked
      ? ` The task is now Waiting, off the user's list, until it fires${w.wait_until ? ` or ${w.wait_until}` : ''}.${unnamed}`
      : w?.reason === 'main_stays_active' ? ' The task it delivers into is the main agent\'s, which never parks: it stays active and on the user\'s list, and the fire wakes it like any message.'
      : w?.reason === 'wait_false' ? ' The task was left as it is (wait:false); park it with task_update phase=WAITING once only the wait is left.'
      : w?.reason === 'other_task' ? ' The task it delivers into was left as it is (not your task; pass wait:true to park it).'
      : w?.reason === 'complete' ? ' The task it delivers into is complete, so it was not parked and the fire cannot land there.'
      : w ? ` The task could not be parked${w.error ? ` (${w.error})` : ''}.`
      : ''
    const next = w?.parked
      ? 'End your turn now with one line saying what you wait on; the fire starts a new one here. When a fire does not '
        + 'need the user, handle it and park again (task_update phase=WAITING) as your last call, with no letter: '
        + 'a fire is not news for the user\'s inbox. Before each re-park (after a fire or the clock), check that the '
        + 'trigger fired for the right reason and still covers what comes next, and fix it if not. '
        + off
      : `Tell the user in one line what is watched and how often. ${off}`
    // The id at the top level too: trigger_pause/resume/delete take it, and a
    // caller reading `.id` should not have to know the job sits under `.job`.
    return withOutcome(
      { ...(id ? { id } : {}), ...(b.job?.name ? { name: b.job.name } : {}), ...b },
      `${armed}${parked}`,
      `${next} See its last check with trigger_list.`,
    )
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'trigger_templates',
  title: 'List ready-made trigger templates',
  description:
    'The ready-made triggers the user\'s plugins offer (e.g. "New message in a Slack channel", "New mail"): id, '
    + 'title, the params each needs, and the default interval. Check this BEFORE writing a check script: a '
    + 'template works without a script and is armed with trigger_create {template, params, prompt?}. '
    + 'Pass `template` + `param` (+ `query`) to list the choices for one param (the channels matching "oncall"). '
    + 'When nothing fits, write a check script as the walnut-trigger skill describes.',
  input: {
    template: z.string().optional().describe('With `param`: the template whose choices to list'),
    param: z.string().optional().describe('The param key to list choices for (e.g. "channel")'),
    query: z.string().optional().describe('Filter the choices by this text'),
  },
  handler: async (args, call) => {
    const template = typeof args.template === 'string' ? args.template.trim() : ''
    const param = typeof args.param === 'string' ? args.param.trim() : ''
    if (template && param) {
      const q = typeof args.query === 'string' ? args.query : ''
      const body = await call('GET', `/trigger-templates/${encodeURIComponent(template)}/options?param=${encodeURIComponent(param)}&q=${encodeURIComponent(q)}`) as { options?: unknown[] } | undefined
      const options = Array.isArray(body?.options) ? body.options : []
      return withOutcome(
        { template, param, count: options.length, options },
        options.length ? `${options.length} choice(s) for ${param}.` : `No choices for ${param}${q ? ` matching "${q}"` : ''}.`,
        `Pass the chosen value as params.${param} to trigger_create {template:"${template}"}.`,
      )
    }
    const body = await call('GET', '/trigger-templates') as { templates?: unknown[] } | undefined
    const templates = Array.isArray(body?.templates) ? body.templates : []
    return withOutcome(
      { count: templates.length, templates },
      templates.length
        ? `${templates.length} template(s) from the user's plugins.`
        : 'No plugin offers a trigger template here.',
      templates.length
        ? 'If one fits, arm it with trigger_create {template, params, prompt?}; otherwise write a check script (walnut-trigger skill).'
        : 'Write a check script as the walnut-trigger skill describes (an MCP server, a CLI, or a Walnut route can be the source).',
    )
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'trigger_template_check',
  title: 'Run a trigger template check once',
  description:
    'What the stored command of a template trigger (`walnut trigger-check <template> <params>`) runs on each '
    + 'check: the plugin answers in the trigger check contract ({fire, items, state}). You never need to call it; '
    + 'trigger_create {template, params} arms a template trigger.',
  input: {
    template: z.string().min(1).describe('Template id, e.g. "mail:new-mail"'),
    params: z.record(z.string(), z.string()).optional().describe('The params stored with the trigger'),
    input: z.record(z.string(), z.unknown()).optional().describe('The trigger input: {state, lastFireAt, now}'),
  },
  handler: async (args, call) => call('POST', `/trigger-templates/${encodeURIComponent(String(args.template))}/check`, {
    params: args.params ?? {}, input: args.input ?? {},
  }),
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'trigger_list',
  title: 'List Walnut triggers',
  description:
    'Every trigger, polling or not: id, name, description, interval, host, its state ("armed" = polling, '
    + '"paused" = switched off by someone, with pausedAt; "stopped" = switched off by Walnut after its check '
    + 'failed 5 times in a row), how many times it has fired, the last check the daemon reported (fired with '
    + 'an item count / quiet with a reason / the error text) and the recent check history. Use it to answer '
    + '"what are you watching?" and to check whether a trigger you created is healthy; one that has never '
    + 'fired may be a script that never says fire. With task: only what would wake that task (and with team:true every '
    + 'open task under it): its triggers, its plain timed routines (cron, kind "routine"), and its wake clocks; '
    + 'team_stop with sessions:"keep" pauses all of them at once.',
  input: {
    task: z.string().optional().describe('Task id or unique prefix: list only the triggers, routines and clocks that would wake it'),
    team: z.boolean().optional().describe('With task: every open task under it too (default false)'),
  },
  bind: TRIGGER_LIST_BINDING,
  handler: async (args, call) => {
    const taskRef = typeof args.task === 'string' ? args.task.trim() : ''
    const wake = taskRef
      ? await call('GET', `/tasks/${encodeURIComponent(taskRef)}/wake-sources?team=${args.team === true ? '1' : '0'}`) as {
        root?: { id: string; title: string }; members?: { id: string; title: string }[]
        routines?: { id: string; target: string; kind: string }[]; clocks?: unknown[]; stopped?: unknown
      } | undefined
      : undefined
    const aimed = wake ? new Map((wake.routines ?? []).map((r) => [r.id, r] as const)) : undefined
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
          lastCheck?: unknown; nextRunAtMs?: number; fireCount?: number; pausedAtMs?: number
          consecutiveErrors?: number; checkLog?: Array<Record<string, unknown>>
        }
      })
      // A task's view lists its plain routines too: they wake it just the same.
      .filter((job) => aimed ? aimed.has(String(job.id)) : !!job.check && typeof job.check.run === 'string')
      .map((job) => ({
        id: job.id,
        name: job.name,
        ...(aimed ? { kind: aimed.get(String(job.id))?.kind, target: aimed.get(String(job.id))?.target } : {}),
        ...(job.description ? { description: job.description } : {}),
        every: everyLabel(job.schedule?.everyMs),
        host: job.check?.host ?? '__local__',
        enabled: job.enabled === true,
        state: triggerRunState(job),
        ...(!job.enabled && typeof job.state?.pausedAtMs === 'number'
          ? { pausedAt: new Date(job.state.pausedAtMs).toISOString() } : {}),
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
    if (wake) {
      return {
        task: wake.root,
        ...(args.team === true ? { members: wake.members ?? [] } : {}),
        count: triggers.length,
        triggers,
        clocks: wake.clocks ?? [],
        ...(wake.stopped ? { teamStop: wake.stopped } : {}),
        hint: triggers.length || (wake.clocks ?? []).length
          ? `team_stop '{"id":"${wake.root?.id ?? taskRef}","sessions":"keep"}' pauses all of these (team_resume turns them back on).`
          : 'Nothing would wake it by itself.',
      }
    }
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
    + 'nothing to report right now, except when newItemCount > 0 for an existing trigger id: then its fire '
    + 'budget is holding the fire (trigger_list shows reason "rate-limited") and it fires on a later check. '
    + CHECK_CONTRACT,
  input: {
    run: z.string().min(1).describe('The shell command to run once'),
    cwd: z.string().optional().describe('Working directory for the run'),
    host: z.string().optional().describe('Host whose daemon runs it (default: the calling session\'s host, else this machine). '
      + 'A session on another host may run checks only on its own host'),
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
      parsed?: { warnings?: unknown } | null; wouldFire?: boolean; newItemCount?: number; error?: string | null
    }
    const warnings = Array.isArray(result.parsed?.warnings) ? result.parsed.warnings.map(String) : []
    const repaired = warnings.length
      ? ` The daemon had to repair its output, so it still counts, but fix the script: ${warnings.join('; ')}.`
      : ''
    const outcome = result.parsed
      ? result.wouldFire
        ? `The script parsed and WOULD fire now (${result.newItemCount ?? 0} new item(s)).${repaired}`
        : `The script parsed and would NOT fire right now — that is a working check with nothing to report.${repaired}`
      : `The script did not produce a usable answer: ${result.error ?? 'no JSON on the last line of stdout'}`
    return withOutcome(
      { ...(body ?? {}) },
      outcome,
      !result.parsed
        ? 'Fix the script so its LAST stdout line is one JSON object with a boolean "fire", then test again.'
        : warnings.length
          ? 'Fix what the daemon repaired (keep each item id under 200 chars, every item an object with a string "id"), then test again.'
          : 'Arm it with trigger_create (same run/cwd/host), then tell the user what is watched and how often.',
    )
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'trigger_pause',
  title: 'Pause a Walnut trigger',
  description:
    'Stop a trigger from polling without deleting it: the daemon disarms it but keeps its memory, the task card '
    + 'keeps showing it as Paused, and trigger_resume turns it back on. Use it for "pause that for now", '
    + '"stop watching for a while", or before a change that would make the check noisy. Already paused is not '
    + 'an error. Prefer this over trigger_delete unless the user wants the trigger gone. '
    + RESUME_SEMANTICS,
  input: {
    id: z.string().min(1).describe('Trigger (routine) id, as returned by trigger_create / trigger_list'),
  },
  handler: async (args, call) => {
    const { job, changed } = await setTriggerEnabled(String(args.id), false, call)
    const state = triggerRunState(job)
    return withOutcome(
      { id: job.id ?? args.id, name: job.name, state, changed },
      changed
        ? `Paused "${job.name ?? args.id}": the daemon stops checking it within seconds; it stays on the task as Paused.`
        : state === 'stopped'
          ? `"${job.name ?? args.id}" was already off: Walnut stopped it after its check kept failing. Nothing changed.`
          : `"${job.name ?? args.id}" was already paused; nothing changed.`,
      'Tell the user it is paused and that trigger_resume turns it back on.',
    )
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'trigger_resume',
  title: 'Resume a paused Walnut trigger',
  description:
    'Turn a paused (or stopped) trigger back on. ' + RESUME_SEMANTICS + ' A trigger Walnut stopped because its '
    + 'check kept failing starts its error count over: fix the script first (trigger_test), or five more failures stop it again. '
    + 'Already running is not an error.',
  input: {
    id: z.string().min(1).describe('Trigger (routine) id, as returned by trigger_create / trigger_list'),
  },
  handler: async (args, call) => {
    const { job, changed } = await setTriggerEnabled(String(args.id), true, call)
    return withOutcome(
      { id: job.id ?? args.id, name: job.name, state: 'armed', changed },
      changed
        ? `Resumed "${job.name ?? args.id}": the first check runs within seconds, every ${everyLabel(job.schedule?.everyMs)} after that.`
        : `"${job.name ?? args.id}" was already running; nothing changed.`,
      'Tell the user it is running again. If the script kept failing before, check trigger_list for its next check.',
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
