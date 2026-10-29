/**
 * Manage a task's running session the way a person does from its panel: ⋮ Stop
 * and Restart, and the composer's model / effort / mode / reply style controls,
 * for a lead or Main that manages running work (2026-10-27: moving an old
 * process onto a new daemon took a person's click). Each runs the SAME core as
 * the panel (terminateSession, restartSession, applySessionModelChange,
 * applySessionEffortChange, patchSession) through its /api/v1 mirror; the server
 * refuses only a session stopping or restarting itself
 * (core/sessions/session-control-guard.ts). A stop is the host's graceful stop
 * request, never a kill of the Claude Code process.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'
import { SESSION_EFFORT_IDS, SESSION_MODE_IDS, SESSION_OUTPUT_MODE_IDS, type SessionEffort, type SessionOutputMode } from '../core/types.js'

type Call = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<unknown>

/** The task's one session (a task keeps one conversation), as task_history finds it. */
async function sessionOfTask(id: string, call: Call): Promise<{ taskId: string; title: string; sessionId: string }> {
  const body = await call('GET', `/tasks/${encodeURIComponent(id)}`) as { task?: Record<string, unknown> } | undefined
  const task = body?.task
  if (!task || typeof task.id !== 'string') throw new Error(`Task response has no id for ${id}; read task_get before retrying.`)
  const ids = task.session_ids
  const sid = task.session_id || task.exec_session_id || (Array.isArray(ids) ? ids.at(-1) : undefined)
  if (typeof sid !== 'string' || !sid) {
    throw new Error(`Task ${task.id} has no session (not started). Nothing to stop or restart; task_start runs it.`)
  }
  return { taskId: task.id, title: typeof task.title === 'string' ? task.title : '', sessionId: sid }
}

/**
 * The same refusal the server makes (409 own_session), asked here too so a
 * server older than that check never stops the very session calling it.
 */
async function refuseOwnSession(sessionId: string, call: Call, action: 'stop' | 'restart'): Promise<void> {
  const me = await call('GET', '/me').catch(() => undefined) as { session?: { id?: unknown } } | undefined
  if (me?.session?.id !== sessionId) return
  throw new Error(action === 'stop'
    ? 'Walnut API error (own_session): A session cannot stop itself: complete your task (task_complete) or end your turn instead'
    : 'Walnut API error (own_session): A session cannot restart itself: ask your lead or the user to restart it')
}

defineOp({
  name: 'task_stop',
  title: 'Stop a task\'s session',
  description:
    'Stop the session running a task, the same as Stop in its session panel menu: the host stops the Claude Code process ' +
    'gracefully (never a kill) and the task keeps its conversation, so a later task_send or task_start resumes it. ' +
    'Only when the user asked, or when the work needs it (a runaway or stuck worker, a session to move onto a new daemon). ' +
    'Any task\'s session a person may stop, your lead\'s and Main\'s included; never your own (409 own_session: complete your task or end your turn instead). ' +
    'A session that owns scheduled jobs is refused (409 cron_owner) unless force is true.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    force: z.boolean().optional().describe('Stop even though the session owns scheduled jobs (cron). Default false'),
  },
  handler: async ({ id, force }, call) => {
    const target = await sessionOfTask(String(id), call)
    await refuseOwnSession(target.sessionId, call, 'stop')
    const path = `/sessions/${encodeURIComponent(target.sessionId)}/terminate`
    try {
      const out = await call('POST', path, { force: force === true }) as Record<string, unknown> | undefined
      return withOutcome(
        { ...target, ...(out ?? {}), status: out?.status ?? 'terminated' },
        `Task ${target.taskId}'s session stopped. Its conversation is kept.`,
        `task_send to ${target.taskId} resumes it; task_get shows its state.`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('(stop_pending)')) {
        return withOutcome(
          { ...target, status: 'pending' },
          `Stop requested for task ${target.taskId}, but its host has not confirmed it yet; the session may still be running.`,
          `Call task_stop again to check, or read task_get for ${target.taskId}.`,
        )
      }
      throw err
    }
  },
  routes: [{ method: 'GET', path: '/tasks/:id' }, { method: 'GET', path: '/me' }, { method: 'POST', path: '/sessions/:id/terminate' }],
  timeoutMs: 40_000,
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'team_stop',
  title: 'Stop a task and everything it handed out',
  description:
    'Stop a task\'s whole team in one step, the same as "Stop the team" on the board: every open task under it (every level, ' +
    'and the task itself unless include_self is false) has its live sessions stopped (the host\'s graceful stop, never a kill; ' +
    'never your own session), its armed triggers paused and its wake clocks (wait_until, a follow-up) taken off, so nothing ' +
    'starts it again by itself. when:"turn_end" lets a turn that is running finish first. team_resume turns those triggers and ' +
    'clocks back on; a stopped session resumes on its next message. Only when the user asked, or the work needs it (a team ' +
    'going the wrong way, work that must not go on).',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix: the top of the team'),
    when: z.enum(['now', 'turn_end']).optional().describe('now (default): stop at once; turn_end: a running turn finishes first'),
    include_self: z.boolean().optional().describe('Stop the task itself too (default true); false stops only what it handed out'),
  },
  handler: async ({ id, when, include_self: includeSelf }, call) => {
    const out = await call('POST', `/tasks/${encodeURIComponent(String(id))}/team-stop`, {
      ...(when ? { when } : {}), ...(includeSelf === false ? { include_self: false } : {}),
    }) as { root?: { id: string; title: string }; stopped?: unknown[]; atTurnEnd?: unknown[]; kept?: { taskId: string; why: string }[]; pausedTriggers?: number; clocksOff?: number; tasks?: number } | undefined
    const kept = out?.kept ?? []
    return withOutcome(
      out ?? {},
      `Team of ${out?.root?.id ?? id} stopped: ${out?.stopped?.length ?? 0} session(s) stopped now`
        + `${out?.atTurnEnd?.length ? `, ${out.atTurnEnd.length} at the end of their running turn` : ''}, `
        + `${out?.pausedTriggers ?? 0} trigger(s) paused, ${out?.clocksOff ?? 0} clock(s) off, across ${out?.tasks ?? 0} open task(s).`
        + (kept.length ? ` Kept running: ${kept.map((k) => `${k.taskId} (${k.why})`).join('; ')}.` : ''),
      `team_resume ${out?.root?.id ?? id} turns the triggers and clocks back on; task_send resumes a session.`,
    )
  },
  routes: [{ method: 'POST', path: '/tasks/:id/team-stop' }],
  timeoutMs: 120_000,
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'team_resume',
  title: 'Resume a team that was stopped',
  description:
    'Undo team_stop on a task: the triggers it paused and the clocks it took off are turned back on (a closed task is left ' +
    'alone). Sessions are not started: each resumes on its next message, so tell the team what to do next with task_send.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix: the task team_stop was called on'),
  },
  handler: async ({ id }, call) => {
    const out = await call('POST', `/tasks/${encodeURIComponent(String(id))}/team-resume`, {}) as { root?: { id: string }; resumedTriggers?: number; clocksOn?: number; skipped?: number } | undefined
    return withOutcome(
      out ?? {},
      `Team of ${out?.root?.id ?? id} resumed: ${out?.resumedTriggers ?? 0} trigger(s) back on, ${out?.clocksOn ?? 0} clock(s) back`
        + `${out?.skipped ? `; ${out.skipped} closed task(s) left alone` : ''}. No session was started.`,
      'task_send to a task gives it its next step.',
    )
  },
  routes: [{ method: 'POST', path: '/tasks/:id/team-resume' }],
  timeoutMs: 60_000,
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'task_restart',
  title: 'Restart a task\'s session',
  description:
    'Restart the session running a task, the same as Restart in its session panel menu: Walnut starts a fresh Claude Code ' +
    'process on the same conversation (for example to move it onto an upgraded daemon, or to wake a dead one); messages ' +
    'waiting for it are delivered after. It runs no new turn by itself. Only when the user asked, or when the work needs it. ' +
    'Any task\'s session a person may restart, your lead\'s and Main\'s included; never your own (409 own_session).',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
  },
  handler: async ({ id }, call) => {
    const target = await sessionOfTask(String(id), call)
    await refuseOwnSession(target.sessionId, call, 'restart')
    const out = await call('POST', `/sessions/${encodeURIComponent(target.sessionId)}/restart`, {}) as Record<string, unknown> | undefined
    const pending = typeof out?.pendingMessages === 'number' ? out.pendingMessages : 0
    return withOutcome(
      { ...target, ...(out ?? {}) },
      `Task ${target.taskId}'s session restarted on a fresh process${pending ? `; ${pending} waiting message(s) are being delivered` : ''}.`,
      `task_send to ${target.taskId} gives it work; task_get shows its state.`,
    )
  },
  routes: [{ method: 'GET', path: '/tasks/:id' }, { method: 'GET', path: '/me' }, { method: 'POST', path: '/sessions/:id/restart' }],
  timeoutMs: 60_000,
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'task_session_set',
  title: 'Change a task session\'s settings',
  description:
    'Change the settings of the session running a task, the same controls as its composer: model, reasoning effort, ' +
    'permission mode and reply style. They apply from its next turn; nothing is sent to it. ' +
    'task_start and task_create take model, effort and mode for a NEW session; a task that already has its conversation ' +
    'keeps its own until you change them here. Only when the user asked, or as a lead managing your own team\'s work. ' +
    'Your own permission mode is the user\'s to change: mode on your own task is refused.',
  input: {
    id: z.string().min(1).describe('Task id or unique prefix'),
    model: z.string().min(1).optional().describe('Model id or alias, as task_start takes it ("default" = Auto)'),
    effort: z.enum(SESSION_EFFORT_IDS as [SessionEffort, ...SessionEffort[]]).optional().describe('Reasoning effort (claude engine; xhigh and max only on models that offer them)'),
    mode: z.enum(SESSION_MODE_IDS).optional().describe('Permission mode'),
    reply_style: z.enum(SESSION_OUTPUT_MODE_IDS as [SessionOutputMode, ...SessionOutputMode[]]).optional().describe('How the session writes its replies: markdown, or rich (the composer\'s reply style pill)'),
  },
  handler: async ({ id, model, effort, mode, reply_style: replyStyle }, call) => {
    if (model === undefined && effort === undefined && mode === undefined && replyStyle === undefined) {
      throw new Error('Name at least one of model, effort, mode, reply_style.')
    }
    const target = await sessionOfTask(String(id), call)
    if (mode !== undefined) {
      // A session raising its own permission mode would grant itself what the user did not.
      const me = await call('GET', '/me').catch(() => undefined) as { session?: { id?: unknown } } | undefined
      if (me?.session?.id === target.sessionId) {
        throw new Error('Walnut API error (own_session): your own permission mode is the user\'s to change; ask them')
      }
    }
    const base = `/sessions/${encodeURIComponent(target.sessionId)}`
    const applied: Record<string, unknown> = {}
    try {
      // Model first: which efforts a session can take depends on its model.
      if (model !== undefined) {
        const out = await call('POST', `${base}/model`, { model }) as Record<string, unknown> | undefined
        applied.model = out?.model ?? model
      }
      if (effort !== undefined) {
        const out = await call('POST', `${base}/effort`, { effort }) as Record<string, unknown> | undefined
        applied.effort = out?.effectiveEffort ?? out?.effort ?? effort
      }
      if (mode !== undefined || replyStyle !== undefined) {
        await call('PATCH', base, { ...(mode !== undefined ? { mode } : {}), ...(replyStyle !== undefined ? { output_mode: replyStyle } : {}) })
        if (mode !== undefined) applied.mode = mode
        if (replyStyle !== undefined) applied.reply_style = replyStyle
      }
    } catch (err) {
      const done = Object.keys(applied)
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(done.length ? `${message} (already applied: ${done.join(', ')})` : message)
    }
    const summary = Object.entries(applied).map(([k, v]) => `${k} ${String(v)}`).join(', ')
    return withOutcome(
      { ...target, applied },
      `Task ${target.taskId}'s session now runs with ${summary}, from its next turn.`,
      `task_send to ${target.taskId} gives it work under the new settings.`,
    )
  },
  routes: [
    { method: 'GET', path: '/tasks/:id' }, { method: 'GET', path: '/me' }, { method: 'POST', path: '/sessions/:id/model' },
    { method: 'POST', path: '/sessions/:id/effort' }, { method: 'PATCH', path: '/sessions/:id' },
  ],
  timeoutMs: 40_000,
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'workspace_providers',
  title: 'Isolated workspace kinds for a folder',
  description:
    'The isolated workspace providers that can make a separate copy of a folder (a git worktree, a fresh clone, ...), ' +
    'with the inputs each one takes: the choices of the draft\'s "Isolated workspace" row. ' +
    'Pass one as task_start or task_create workspace {provider, inputs}.',
  input: {
    cwd: z.string().startsWith('/').describe('Absolute folder the workspace would copy'),
    host: z.string().optional().describe('Host alias of that folder; omit for this machine'),
  },
  bind: { method: 'GET', path: '/api/workspaces/providers' },
  timeoutMs: 30_000,
  tags: { readonly: true, remote: 'allow' },
})
