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
import { clipText, tailText } from './doc-page.js'
import { awayAnswer, withOutcome } from './outcome.js'
import { triggerRunState } from '../core/cron/trigger-run-state.js'
import { TIME_LIMIT_DEFAULT_S, TIME_LIMIT_MAX_S, testCallTimeoutMs } from '../core/cron/trigger-time-limit.js'
import { buildTriggerUpdatePatch, type TriggerUpdateField } from '../core/routines/trigger-update-patch.js'
import { ownJobWatchWarning } from '../core/routines/own-job-watch.js'
import { OWN_WAIT_TURN_END } from '../lib/turn-end-marker.js'
import { OwnRefusalError, badInput } from './own-refusal.js'
import {
  byActivity, compactRow, everyLabel, filterWords, fullRow, matchesFilter, pageLimit, MAX_LIMIT,
  isSessionRoutine, type ListedJob, type ListFilter,
} from './trigger-list-rows.js'

const CHECK_CONTRACT =
  'The check reads ONE JSON object on stdin ({state, lastFireAt, now}) and prints ONE JSON object as the LAST line of '
  + 'stdout: {"fire":true|false, "items":[{"id":"..."}]?, "input":"text for the AI this run"?, "state":{cursor}?}; log '
  + 'freely above it. `items[].id` is the DEDUP key: ids already delivered are dropped, so fire:true with only known ids '
  + 'is quiet, and fire:true with NO items fires every time (the script judged). `input` goes to the AI this run; `state` '
  + 'comes back verbatim on the next run\'s stdin. A non-zero exit, a timeout, no JSON last line or over 64KB of stdout is a '
  + 'check error: the first is reported into this session, five in a row stop the trigger and tell this session (or its '
  + 'lead); trigger_update fixes it in place. An id over 200 chars is shortened (the original kept as fullId) and an item '
  + 'with no string id dropped, each with a warning.'

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
): Promise<{ job: NonNullable<RoutineJobBody['job']>; changed: boolean; away?: Record<string, unknown> }> {
  const path = `/routines/${encodeURIComponent(id)}`
  const current = (await call('GET', path) as RoutineJobBody | undefined)?.job
  if (!current) throw new OwnRefusalError('not_found', `no trigger ${id}; trigger_list shows the ids`, { status: 404 })
  if (!current.check) throw badInput(`${id} ("${current.name ?? ''}") is a scheduled routine, not a trigger`)
  if (current.enabled === enabled) return { job: current, changed: false }
  const answer = await call('PATCH', path, { enabled })
  // Saved on this host while the server is away (a host's follower): its own words.
  const away = awayAnswer(answer)
  if (away) return { job: current, changed: true, away }
  const updated = (answer as RoutineJobBody | undefined)?.job ?? current
  return { job: updated, changed: true }
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/**
 * trigger_create's answer for an agent: the trigger in a few facts, what happened to the task,
 * its time limit (the last test of the same script included), the outcome and next. 2026-11-21: a
 * create answered 2,800 characters (median), most of it the job echoing the caller's own script,
 * prompt and description back.
 */
function createdTrigger(result: unknown): unknown {
  const r = rec(result)
  const job = rec(r.job)
  if (r.offline === true || !r.job) return result
  const { job: _job, ...rest } = r
  const schedule = rec(job.schedule)
  const check = rec(job.check)
  const target = rec(rec(job.executor).config).target
  return {
    ...rest,
    every: everyLabel(schedule.everyMs),
    enabled: job.enabled !== false,
    state: triggerRunState(job as ListedJob),
    ...(typeof target === 'string' && target ? { task: target } : {}),
    ...(rec(check.template).id ? { template: rec(check.template).id } : {}),
  }
}

defineOp({
  name: 'trigger_create',
  title: 'Create a Walnut trigger',
  description:
    'Arm a check script the daemon on a host runs on an interval; when it fires, its prompt is delivered into a session. '
    + 'For "tell me when X happens", "watch this and act". Look at trigger_templates FIRST: when a plugin offers the watch '
    + '(a Slack channel, new mail), pass `template` + `params` instead of a script. '
    + `${CHECK_CONTRACT} `
    + 'Write the script to a file (~/.open-walnut/triggers/<slug>/check.sh) and run trigger_test until it parses. `every`: '
    + '"30s", "5m", "1h" or ms, never under 10s; 5m is the sensible default. `session` defaults to "this" (your task): a fire '
    + 'lands in this conversation even after it went quiet; a task id points it elsewhere (a completed one is an error). Keep '
    + 'credentials in the script file: `run` shows on its card. `description` is required: the card shows it to the user. '
    + 'It does NOT park the task unless you pass wait:true. Your own build, test run, CI run, deploy or land is your work going '
    + 'on, never a wait: watch it with watches:"own", which never parks (it reads Working). Pass wait:true only when the rest of '
    + 'the work truly waits on something outside your task and the user (a review, another team\'s pipeline, a reply, a date) '
    + 'and nothing of this turn is for the user to read (never in the turn that answers the user\'s message): the task goes to '
    + 'Waiting (off the user\'s list, no letter is sent) until the fire or its clock; one that watches the user\'s ask never parks. '
    + 'Set wait_until yourself to when you expect the event, kept short (4 hours when left out): the clock running out is how you '
    + 'find out the trigger is wrong. While work remains, leave wait out and park later with task_update phase=WAITING; the main '
    + 'agent\'s task never parks. Arm one on your own whenever the work waits on something outside this session: do not ask the '
    + 'user to watch it. Never for this session\'s own background command (run_in_background) or subagent: Claude Code wakes the '
    + 'session when it ends. With the Walnut server away, your host arms it at once (the answer says queued).',
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
    name: z.string().optional().describe('A short label, a few plain words naming what it watches (e.g. "PR 123 review comments", '
      + '"Session cookie watch"). It is what Walnut calls the trigger everywhere: the task\'s waiting line, its trigger card, '
      + 'trigger_list, Routines, notices. Never the prompt\'s opening: those words are an instruction and read as news. '
      + 'When left out, Walnut makes one from the description'),
    session: z.string().optional().describe('"this" (default) = the calling session\'s task; or an explicit task id'),
    cwd: z.string().optional().describe('Working directory for the check (defaults to the calling session\'s cwd)'),
    host: z.string().optional().describe('Host whose daemon runs the check (defaults to the calling session\'s host). '
      + 'A session on another host may arm checks only on its own host'),
    timeoutSeconds: z.number().int().positive().optional().describe('The check\'s time limit: the daemon kills it after this long '
      + '(default 30, max 300). Every call in the script needs a shorter timeout of its own, and its timeouts times its retries '
      + 'must fit inside this limit, or the check is killed before its retry runs'),
    maxFiresPerDay: z.number().int().min(0).optional().describe('Fire budget: up to this many fires in a burst, refilling at this many per 24h (default 24, so once an hour once spent; a held fire comes later, never lost). For a busy source checked often (chat, mail) set it to the checks per day, e.g. 288 for every 5m. 0 = unlimited'),
    wait: z.boolean().optional().describe('Park the task the fire lands in (Waiting) until it fires. Default false. Pass true only when '
      + 'the rest of the work waits on that outside thing and nothing of this turn is for the user to read (never in the turn that answers '
      + 'the user\'s message)'),
    watches: z.string().optional().describe('What this trigger watches for you: "ask" = your status\'s ask of the user (each run of its check '
      + 'counts as that ask\'s check, so Walnut\'s 4-hour re-check stays quiet while it keeps running), or a letter id (lt-...) you sent them '
      + '(that letter\'s re-check stays quiet while the trigger is armed): such a trigger waits on the user, so it stays Needs you. '
      + '"own" = your own work: the results of a build, test run, CI run, deploy or land of your change. That is your work going on, '
      + 'so the task reads Working and the trigger never parks it, nor keeps it parked. None of these parks the task'),
    wait_until: z.string().optional().describe('When the parked task comes back by itself if nothing fired: an ISO datetime or a duration '
      + 'from now ("2h", "1d"). Set it to when you expect the event, kept short: it is the check that the trigger works. '
      + 'Default 4 hours; "" = no clock (only when the user asked for no time limit)'),
    id: z.string().optional().describe('Never pass it: Walnut names the trigger. Set only by a host that armed this trigger '
      + 'while the Walnut server was away, so the server keeps the id the host gave it'),
  },
  // The old park receipt's text (removed 2026-10-05), still sent by older sessions.
  retiredInput: ['wait_report'],
  bind: { method: 'POST', path: '/routines/trigger' },
  mapResult: ({ body, args }) => {
    // Armed on this host while the server is away (a host's follower): its own words.
    const away = awayAnswer(body)
    if (away) return away
    const b = (body ?? {}) as {
      job?: { id?: string; name?: string; schedule?: { everyMs?: number } }; host?: string
      wait?: { parked?: boolean; reason?: string; wait_until?: string | null; error?: string }
      timeLimit?: { seconds?: number; warning?: string }
    }
    const id = b.job?.id ?? ''
    const every = everyLabel(b.job?.schedule?.everyMs)
    const limit = typeof b.timeLimit?.seconds === 'number' ? ` and kills a check still running after ${b.timeLimit.seconds} s` : ''
    const armed = `Trigger armed on ${b.host ?? 'its host'}: the daemon there runs the check every ${every}${limit}, and `
      + 'delivers the prompt when it fires. It keeps polling while Walnut restarts.'
    const timeWarning = b.timeLimit?.warning ? ` WARNING: ${b.timeLimit.warning}` : ''
    // A check on this session's own background job: Claude Code already wakes it when that ends.
    // Its script is read only in a session's own process; through a host's gateway only the run line (core/routines/own-job-watch.ts).
    const a = (args ?? {}) as { run?: unknown; cwd?: unknown; template?: unknown }
    const ownJob = a.template ? null : ownJobWatchWarning({ run: a.run, cwd: a.cwd, sid: process.env.WALNUT_SESSION_ID })
    const ownJobWarning = ownJob ? ` WARNING: ${ownJob}` : ''
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
      : w?.reason === 'watches_user' ? ' The task was not parked: this trigger watches the user\'s ask, and a wait on the user stays Needs you.'
      : w?.reason === 'own_work' ? ' The task was not parked: this trigger watches your own work (watches:"own"), which is work going on, so the task reads Working, never Waiting.'
      : w?.reason === 'wait_false' ? ' The task was left as it is (no wait:true); park it with task_update phase=WAITING once only the wait is left and the user has nothing of yours to read.'
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
      { ...(id ? { id } : {}), ...(b.job?.name ? { name: b.job.name } : {}), ...b, ...(ownJob ? { ownJobWarning: ownJob } : {}) },
      `${armed}${parked}${timeWarning}${ownJobWarning}`,
      ownJob
        ? `Unless it also watches something outside this session, delete it now: walnut tools call trigger_delete '{"id":"${id}"}'${w?.parked ? ', then take the task out of Waiting (task_update phase=IN_PROGRESS): your own job is your work' : ''}, and ${OWN_WAIT_TURN_END}; this session's own background job wakes it when it finishes.`
        : `${timeWarning ? `Fix the time limit first: trigger_test, then trigger_update '{"id":"${id}","timeoutSeconds":<seconds>}' (same id, nothing it saw is lost). ` : ''}${next} See its last check with trigger_list.`,
    )
  },
  // Content, not a receipt: what it armed and what it did to the task are the answer. The stored
  // job (the script, the prompt and the description the caller just sent) is left out.
  answer: {
    kind: 'content',
    max: 4_000,
    whole: 'trigger_list {"name":"<id>","full":true}',
    shape: ({ result }) => createdTrigger(result),
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
  // A check script reads this answer as the check's own output ({fire, items, state}): a cut item would never fire.
  answer: { kind: 'content', whole_for: () => true },
  tags: { readonly: true, remote: 'allow' },
})

/** trigger_list's cap: about 20 compact rows, or a few whole ones; an agent's shell keeps about 10,000 characters. */
const LIST_ANSWER_MAX = 10_000
/** What a list answer keeps for its other fields (the task, its clocks, the hint). */
const LIST_HEAD_ROOM = 2_500

/**
 * The rows of a trigger_list answer that fit its cap, newest activity first (2026-11-21: a list
 * answered up to 91,700 characters). A row left out is counted in `more`, and the hint names the
 * calls that read it: a narrower list, or one trigger whole. At least one row stays.
 */
function fittedList(result: unknown, max = LIST_ANSWER_MAX): unknown {
  const r = rec(result)
  if (!Array.isArray(r.triggers)) return result
  const budget = Math.max(1_000, max - LIST_HEAD_ROOM - JSON.stringify(r.clocks ?? []).length)
  const kept: unknown[] = []
  let used = 0
  for (const row of r.triggers) {
    const n = JSON.stringify(row).length + 1
    if (kept.length && used + n > budget) break
    kept.push(row)
    used += n
  }
  const left = r.triggers.length - kept.length
  if (!left) return result
  const more = (typeof r.more === 'number' ? r.more : 0) + left
  // The route's own "N more not shown" sentence counts only the limit; this one counts both.
  const rest = typeof r.hint === 'string' ? r.hint.replace(/^\d+ more not shown:[^.]*\.\s*/, '') : ''
  return {
    ...r,
    shown: kept.length,
    more,
    triggers: kept,
    hint: `${more} more not shown (this answer holds ${kept.length}): narrow with name, task or state, `
      + 'or read one trigger whole with trigger_list {"name":"<its id>","full":true}.'
      + (rest ? ` ${rest}` : ''),
  }
}

defineOp({
  name: 'trigger_list',
  title: 'List Walnut triggers',
  description:
    'The triggers, newest activity first, one short row each: id, name, description, interval, host, the task it wakes, '
    + '`state` ("armed" = polling; "paused" = switched off by someone, with pausedAt; "stopped" = switched off by Walnut after '
    + '5 failed checks in a row), fires, `last` (the last check in a line: fired with an item count, quiet with a reason, or '
    + 'the error), `lastFire`, the next check, `timeLimit` (seconds a check may run), `lastRun` (how long the last one ran) '
    + 'and `limitWarning` (over half its limit). To find one trigger, narrow it: `name` (a piece of its name, id or description, '
    + 'any case), `task` (what would wake that task), `state:"armed"`; e.g. {"name":"reflection","task":"<task id>"}. '
    + `At most \`limit\` rows (default 25, up to ${MAX_LIMIT}); \`count\` matched, \`more\` were left out. `
    + '`full:true` adds the script, the last check object, recent checks and the prompt the session is told (default limit '
    + '5): for one trigger you debug. With `name`, scheduled routines that start a session turn match too (kind "routine", '
    + 'their time in `at`): change their prompt with trigger_update. One that never fired may be a script that never says '
    + 'fire. With task (team:true adds every open task under it): its triggers, its timed routines and its wake clocks; '
    + 'team_stop with sessions:"keep" pauses all of them.',
  input: {
    task: z.string().optional().describe('Task id or unique prefix: list only the triggers, routines and clocks that would wake it'),
    team: z.boolean().optional().describe('With task: every open task under it too (default false)'),
    name: z.string().optional().describe('Only triggers whose name, id or description contains this text (any case)'),
    state: z.enum(['armed', 'paused', 'stopped']).optional().describe('Only triggers in this state; "armed" = polling now'),
    limit: z.number().int().positive().optional().describe(`At most this many rows, most recent activity first (default 25, or 5 with full; up to ${MAX_LIMIT})`),
    full: z.boolean().optional().describe('Whole rows: the script, the last check object and the recent check history (default false)'),
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
    const full = args.full === true
    const filter: ListFilter = {
      ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name } : {}),
      ...(args.state === 'armed' || args.state === 'paused' || args.state === 'stopped' ? { state: args.state } : {}),
    }
    const limit = pageLimit(args.limit, full)
    // includeDisabled is pinned rather than exposed: a trigger that was
    // auto-disabled for check errors is exactly what a caller needs to see.
    const body = await call('GET', '/routines?includeDisabled=true') as { jobs?: unknown[] } | undefined
    const jobs = (Array.isArray(body?.jobs) ? body.jobs : []) as ListedJob[]
    const matched = byActivity(jobs
      // A task's view lists its plain routines too: they wake it just the same.
      // Named, a scheduled routine that starts a session is found too: its prompt is what trigger_update changes.
      .filter((job) => aimed ? aimed.has(String(job.id)) : (!!job.check && typeof job.check.run === 'string') || (!!filter.name && isSessionRoutine(job)))
      .filter((job) => matchesFilter(job, filter)))
    const triggers = matched.slice(0, limit).map((job) => {
      const extra = aimed ? { kind: aimed.get(String(job.id))?.kind, target: aimed.get(String(job.id))?.target } : {}
      return full ? fullRow(job, extra) : compactRow(job, extra)
    })
    const more = matched.length - triggers.length
    const filtered = filterWords(filter)
    const page = {
      count: matched.length,
      ...(more > 0 ? { shown: triggers.length, more } : {}),
      triggers,
    }
    const moreHint = more > 0
      ? `${more} more not shown: narrow with name, task or state, or raise limit (up to ${MAX_LIMIT}).`
      : undefined
    if (wake) {
      return {
        task: wake.root,
        ...(args.team === true ? { members: wake.members ?? [] } : {}),
        ...page,
        clocks: wake.clocks ?? [],
        ...(wake.stopped ? { teamStop: wake.stopped } : {}),
        hint: [
          moreHint,
          triggers.length || (wake.clocks ?? []).length
            ? `team_stop '{"id":"${wake.root?.id ?? taskRef}","sessions":"keep"}' pauses all of these (team_resume turns them back on).`
            : filtered ? `Nothing aimed at it matches ${filtered}.` : 'Nothing would wake it by itself.',
        ].filter(Boolean).join(' '),
      }
    }
    const emptyHint = matched.length === 0
      ? (filtered ? `No trigger matches ${filtered}.` : 'No triggers armed. trigger_create arms one.')
      : undefined
    const hint = moreHint ?? emptyHint
    return { ...page, ...(hint ? { hint } : {}) }
  },
  // The rows that fit, newest activity first; the rest are counted with the call that reads them.
  answer: { kind: 'content', max: LIST_ANSWER_MAX, shape: ({ result, max }) => fittedList(result, max) },
  tags: { readonly: true, remote: 'allow' },
})

/** What trigger_test's answer keeps of each tail, from its end, and of the parsed object's items. */
const STDOUT_TAIL = 2_000
const STDERR_TAIL = 1_200
const ITEMS_SHOWN = 20
const INPUT_HEAD = 1_000
const STATE_MAX = 600

const tailOf = (v: unknown, max: number): unknown =>
  typeof v === 'string' ? tailText(v, max) : v

/** trigger_test's answer for an agent: the verdict whole, the tails and the parsed object short. */
function testedRun(result: unknown): unknown {
  const r = rec(result)
  const run = rec(r.result)
  if (!r.result) return result
  const parsed = run.parsed && typeof run.parsed === 'object' ? rec(run.parsed) : null
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : []
  const state = parsed && 'state' in parsed ? JSON.stringify(parsed.state) ?? 'null' : ''
  const cut: string[] = []
  if (typeof run.stdoutTail === 'string' && run.stdoutTail.length > STDOUT_TAIL) cut.push(`stdout to its last ${STDOUT_TAIL} characters`)
  if (typeof run.stderrTail === 'string' && run.stderrTail.length > STDERR_TAIL) cut.push(`stderr to its last ${STDERR_TAIL} characters`)
  if (items.length > ITEMS_SHOWN) cut.push(`items to the first ${ITEMS_SHOWN} of ${items.length}`)
  if (typeof parsed?.input === 'string' && parsed.input.length > INPUT_HEAD) cut.push(`input to its first ${INPUT_HEAD} characters`)
  if (state.length > STATE_MAX) cut.push(`state (${state.length} characters of JSON)`)
  if (!cut.length) return result
  return {
    ...r,
    result: {
      ...run,
      stdoutTail: tailOf(run.stdoutTail, STDOUT_TAIL),
      stderrTail: tailOf(run.stderrTail, STDERR_TAIL),
      ...(parsed ? {
        parsed: {
          ...parsed,
          ...(items.length > ITEMS_SHOWN ? { items: items.slice(0, ITEMS_SHOWN), itemCount: items.length } : {}),
          ...(typeof parsed.input === 'string' && parsed.input.length > INPUT_HEAD ? { input: clipText(parsed.input, INPUT_HEAD) } : {}),
          ...(state.length > STATE_MAX ? { state: `(${state.length} characters of JSON)` } : {}),
        },
      } : {}),
    },
    shortened: `Shortened for this answer, nothing failed: ${cut.join('; ')}. Repeat the same trigger_test with "_full": true for all of it.`,
  }
}

defineOp({
  name: 'trigger_test',
  title: 'Test a trigger check script',
  description:
    'Run a check ONCE on its host and report what the daemon saw: exit code, stdout/stderr tails, the parsed object, '
    + 'whether it WOULD fire, how many items are new, and how long it ran against its time limit (`timeLimit`; over half of '
    + 'it is a warning: the daemon kills a check at its limit, so call timeouts times retries must fit inside it). Reads and '
    + 'writes no state, so run it as often as needed: always before trigger_create, until `parsed` is non-null (`error` names '
    + 'the contract violation). wouldFire:false with parsed set is a WORKING script with nothing to report now, except when '
    + 'newItemCount > 0 for an existing trigger id: its fire budget holds the fire (trigger_list shows reason "rate-limited"). '
    + 'A run longer than this call can wait answers "still running" with a testId: trigger_test {testId} reads it. '
    + '"transport failure" is the link to the host dropping twice, not the script. '
    + CHECK_CONTRACT,
  input: {
    run: z.string().min(1).optional().describe('The shell command to run once. Required unless testId is given'),
    testId: z.string().optional().describe('The id a "still running" answer gave (tt_...): wait for that same run\'s result '
      + 'instead of starting a new one. Pass nothing else with it'),
    cwd: z.string().optional().describe('Working directory for the run (defaults to the calling session\'s cwd, as trigger_create)'),
    host: z.string().optional().describe('Host whose daemon runs it (default: the calling session\'s host, else this machine). '
      + 'A session on another host may run checks only on its own host'),
    timeoutSeconds: z.number().int().positive().optional().describe('Kill it after this long (default 30, max 300). '
      + 'Test with the timeoutSeconds you will arm it with'),
    id: z.string().optional().describe('Existing trigger id — measures newItemCount against ITS seen set'),
  },
  bind: { method: 'POST', path: '/routines/check-test' },
  // As long as the check may run (its limit, twice for the one retry after a dropped link), never
  // the 10 s default: a check with a 280 s limit could not be tested at all (2026-11-08).
  // A wait on an earlier run (testId) may wait for the longest one.
  timeoutMs: (args) => testCallTimeoutMs(args.testId ? TIME_LIMIT_MAX_S : args.timeoutSeconds),
  // A handler, not a plain binding: the route takes a nested { check } object,
  // while an agent should type the four fields flat.
  handler: async (args, call) => {
    const { id, testId, ...check } = args
    const waitingOn = typeof testId === 'string' && testId.trim() ? testId.trim() : ''
    if (!waitingOn && typeof check.run !== 'string') throw badInput('run is required (or testId, to read a run still going)')
    const body = await call('POST', '/routines/check-test', waitingOn ? { testId: waitingOn } : {
      check,
      ...(typeof id === 'string' && id ? { id } : {}),
    }) as {
      result?: Record<string, unknown>; timeLimit?: { seconds?: number; line?: string; warning?: string }
      pending?: { testId: string; host?: string; limitSeconds?: number; runningForMs?: number }
    } | undefined
    // Run on this host while the server is away (a host's follower): its own words.
    const away = awayAnswer(body)
    if (away) return away
    // A run longer than the call may wait (a session on another host gets about 20 s) goes on there.
    if (body?.pending) {
      const p = body.pending
      const left = Math.max(1, Math.round((p.limitSeconds ?? 30) - (p.runningForMs ?? 0) / 1000))
      return withOutcome(
        { ...body },
        `The check is still running on ${p.host === '__local__' || !p.host ? 'this machine' : p.host} `
          + `(${Math.round((p.runningForMs ?? 0) / 1000)} s so far; its limit is ${p.limitSeconds ?? '?'} s, so it ends within about ${left} s).`,
        `Read its result with walnut tools call trigger_test '${JSON.stringify({ testId: p.testId })}' (it waits for the same run; `
          + 'do not start a new one).',
      )
    }
    const result = (body?.result ?? {}) as {
      parsed?: { warnings?: unknown } | null; wouldFire?: boolean; newItemCount?: number; error?: string | null
    }
    // A test of an armed trigger (id) is fixed on that trigger, never armed a second time.
    const armed = typeof id === 'string' && id.trim() ? id.trim() : ''
    const warnings = Array.isArray(result.parsed?.warnings) ? result.parsed.warnings.map(String) : []
    const repaired = warnings.length
      ? ` The daemon had to repair its output, so it still counts, but fix the script: ${warnings.join('; ')}.`
      : ''
    const outcome = result.parsed
      ? result.wouldFire
        ? `The script parsed and WOULD fire now (${result.newItemCount ?? 0} new item(s)).${repaired}`
        : `The script parsed and would NOT fire right now — that is a working check with nothing to report.${repaired}`
      : `The script did not produce a usable answer: ${result.error ?? 'no JSON on the last line of stdout'}`
    // The run's time against its limit, always said: a check near its limit is killed on a slower day.
    const limit = body?.timeLimit
    const time = limit?.line ? ` It ${limit.line}.` : ''
    const timeWarning = limit?.warning ? ` WARNING: ${limit.warning}` : ''
    return withOutcome(
      { ...(body ?? {}) },
      `${outcome}${time}${timeWarning}`,
      !result.parsed
        ? 'Fix the script so its LAST stdout line is one JSON object with a boolean "fire", then test again.'
        : limit?.warning
          ? `Make it finish well inside its time limit (or pass a larger timeoutSeconds), test again, then ${armed
            ? `give trigger ${armed} the same timeoutSeconds with trigger_update (same id, nothing it saw is lost).`
            : 'arm it with the same timeoutSeconds.'}`
        : warnings.length
          ? 'Fix what the daemon repaired (keep each item id under 200 chars, every item an object with a string "id"), then test again.'
          : armed
            ? `Put this run and its settings on trigger ${armed} with trigger_update if they changed (same id, nothing it saw is lost); never arm a second one for it.`
            : 'Arm it with trigger_create (same run/cwd/host), then tell the user what is watched and how often.',
    )
  },
  // Content, not a receipt: the answer is the run it made. Long tails keep their END (the last
  // stdout line is the JSON the daemon parsed); a long item list keeps its head and its count.
  answer: { kind: 'content', max: 8_000, shape: ({ result }) => testedRun(result) },
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
    const { job, changed, away } = await setTriggerEnabled(String(args.id), false, call)
    if (away) return away
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
    const { job, changed, away } = await setTriggerEnabled(String(args.id), true, call)
    if (away) return away
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

// What trigger_update may change, and how its arguments become a patch: trigger-update-patch.ts.
export { TRIGGER_UPDATE_FIELDS } from '../core/routines/trigger-update-patch.js'

/** trigger_create fields trigger_update leaves alone, each with why. */
export const TRIGGER_UPDATE_NOT_EDITABLE: Record<string, string> = {
  template: 'a template trigger is built from its params; arm a new one for other params',
  params: 'a template trigger is built from its params; arm a new one for other params',
  session: 'the task it wakes is the trigger\'s owner; arm one on the other task',
  host: 'the host runs the check and keeps its seen items; a trigger on another host is a new trigger',
  wait: 'parking is the task\'s, not the trigger\'s: task_update phase=WAITING',
  wait_until: 'the clock is the task\'s: task_update wait_until',
  id: 'the id is what an update keeps',
}

type TriggerJob = NonNullable<RoutineJobBody['job']> & {
  description?: string
  check?: { run?: string; cwd?: string; host?: string; timeoutSeconds?: number; maxFiresPerDay?: number; template?: unknown }
  executor?: { type?: string; config?: Record<string, unknown> }
}

const UPDATE_LABELS: Record<TriggerUpdateField, string> = {
  every: 'interval', timeoutSeconds: 'time limit', maxFiresPerDay: 'fire budget', prompt: 'prompt',
  description: 'description', name: 'name', run: 'command', cwd: 'directory', watches: 'what it watches',
}

defineOp({
  name: 'trigger_update',
  title: 'Change a Walnut trigger in place',
  description:
    'Change a trigger without deleting it: its interval, time limit, fire budget, prompt, description, name, '
    + 'command or directory. It keeps its id, the items it has seen and the script\'s cursor, so nothing it '
    + 'already delivered fires again, and the daemon runs the new settings from its next check. Pass the id and '
    + 'only the fields to change. Use it whenever a trigger needs a fix: a check killed at its time limit '
    + '(raise timeoutSeconds), a source that needs a slower or faster poll, a fire budget that holds fires back, '
    + 'a prompt that asks the wrong thing. A new trigger in its place would start with nothing seen, so change '
    + 'this one. A new command or time limit is tried first with trigger_test. A paused or stopped '
    + 'trigger stays off; trigger_resume starts it again. A scheduled routine that starts a session turn (a '
    + 'VP\'s nightly reflection, kind "routine" in trigger_list) takes prompt, description and name here; its '
    + 'schedule stays as it is.',
  input: {
    id: z.string().min(1).describe('Trigger (routine) id, as returned by trigger_create / trigger_list'),
    every: z.union([z.number().int().positive(), z.string().min(1)]).optional()
      .describe('New poll interval: "30s" | "5m" | "1h", or milliseconds. Minimum 10s'),
    timeoutSeconds: z.number().int().positive().max(TIME_LIMIT_MAX_S).optional()
      .describe(`New time limit for one check, in seconds (default 30, max ${TIME_LIMIT_MAX_S})`),
    maxFiresPerDay: z.number().int().min(0).optional().describe('New fire budget: fires per 24h. 0 = unlimited'),
    prompt: z.string().min(1).optional().describe('New message the session receives when it fires'),
    description: z.string().min(1).optional().describe('New one or two plain sentences for the user: what it watches, when it fires, what the session does'),
    name: z.string().min(1).optional().describe('New short label'),
    run: z.string().min(1).optional().describe('New shell command for the check (try it with trigger_test first)'),
    cwd: z.string().optional().describe('New working directory for the check; "" = none'),
    watches: z.enum(['own', 'outside']).optional().describe('"own" = it watches your own work (a build, test run, CI run, deploy '
      + 'or land of your change): it never parks the task nor keeps it parked. "outside" = it watches something outside '
      + 'the task again. A watch of the user\'s ask or a letter is set once, at trigger_create'),
  },
  handler: async (args, call) => {
    const id = String(args.id)
    const path = `/routines/${encodeURIComponent(id)}`
    const current = (await call('GET', path) as { job?: TriggerJob } | undefined)?.job
    if (!current) throw new OwnRefusalError('not_found', `no trigger ${id}; trigger_list shows the ids`, { status: 404 })
    const { patch, given } = buildTriggerUpdatePatch(current, args as Record<string, unknown>)
    const answer = await call('PATCH', path, patch)
    // Changed on this host while the server is away (a host's follower): its own words.
    const away = awayAnswer(answer)
    if (away) return away
    const updated = (answer as { job?: TriggerJob } | undefined)?.job ?? current
    const state = triggerRunState(updated)
    const name = updated.name ?? current.name ?? id
    const changed = given.map((f) => UPDATE_LABELS[f]).join(', ')
    const off = state === 'armed' ? '' : ` It is still ${state}: trigger_resume '{"id":"${id}"}' starts it again.`
    const testIt = args.run !== undefined || args.timeoutSeconds !== undefined || args.cwd !== undefined
      ? `Try the check under its new settings: walnut tools call trigger_test '${JSON.stringify({
        run: updated.check?.run ?? '', id, timeoutSeconds: updated.check?.timeoutSeconds ?? TIME_LIMIT_DEFAULT_S,
        // Its own host and directory: left out, trigger_test runs in the caller's.
        ...(updated.check?.host ? { host: updated.check.host } : {}),
        ...(updated.check?.cwd ? { cwd: updated.check.cwd } : {}),
      }).replace(/'/g, "'\\''")}'. `
      : ''
    return withOutcome(
      {
        id: updated.id ?? id, name, state, changed: given,
        ...(updated.schedule?.everyMs ? { every: everyLabel(updated.schedule.everyMs) } : {}),
        timeLimit: updated.check?.timeoutSeconds ?? TIME_LIMIT_DEFAULT_S,
      },
      `Updated "${name}" in place (${changed}). Same id; it keeps the items it has seen and the script's cursor, `
        + `so nothing it already delivered fires again.${state === 'armed' ? ' The daemon uses the new settings from its next check.' : ''}${off}`,
      `${testIt}Tell the user in one line what changed. See its next check with trigger_list.`,
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
  // Deleted on this host while the server is away (a host's follower): its own words.
  mapResult: ({ body, args }) => awayAnswer(body) ?? withOutcome(
    { deleted: true, id: args.id },
    'Trigger deleted. Nothing polls for it any more, and its check script file is untouched.',
    'Nothing else is required.',
  ),
  tags: { readonly: false, remote: 'allow', destructive: false },
})
