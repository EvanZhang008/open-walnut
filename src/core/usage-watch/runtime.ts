/**
 * The real-use monitor's running parts on the leader: the recorder's minute flush, the watches'
 * check times, and the notes that are due. Started with the server (startRealUse), stopped with
 * it. The Health alarms that read the counters are in usage-alarms.ts.
 */
import { log } from '../../logging/index.js'
import { flushUsage, setWatchedOps, startUsageRecorder, stopUsageRecorder } from './record.js'
import { lastEventLine, routeUsageAlarm, sendDueNotes, type RouteDeps } from './route.js'
import { usageTargetOf } from '../health-monitor/usage-alarms.js'
import type { RouteAlarmInput, RouteAlarmResult } from '../health-monitor/types.js'
import { REJUDGE_UNKNOWN_MS, judgeWatch, listWatches, passedOnNoUse, putWatch, rejudgeEnded, type JudgeInputs, type Watch } from './watches.js'
import { clause } from '../../utils/format.js'

export const NOTE_FROM = 'Walnut: real use'

export async function realUseOn(): Promise<boolean> {
  const { getConfig } = await import('../config-manager.js')
  const { experimentalEnabled } = await import('../experimental.js')
  return experimentalEnabled((await getConfig()).experimental, 'real_use_watch')
}

export const routeDeps: RouteDeps = {
  enabled: realUseOn,
  taskInfo: async (id) => {
    const { listTasksByIds } = await import('../task-manager.js')
    const [t] = await listTasksByIds([id]).catch(() => [])
    return t ? { id: t.id, title: t.title, ...(t.project ? { project: t.project } : {}), complete: t.phase === 'COMPLETE' } : null
  },
  leadOf: async (project) => {
    const { isOrgEnabled } = await import('../org/org-enabled.js')
    if (!(await isOrgEnabled())) return null
    const { orgTasks } = await import('../org/org-store.js')
    const { pickLead } = await import('../org/org-tree.js')
    const lead = pickLead(await orgTasks(), project)
    return lead && lead.phase !== 'COMPLETE' ? { id: lead.id, title: lead.title } : null
  },
  deliver: async (taskId, text, rowId) => {
    const { listTasksByIds } = await import('../task-manager.js')
    const [task] = await listTasksByIds([taskId])
    if (!task) return { ok: false, detail: 'the task is gone' }
    const { getSessionsForTask } = await import('../session-tracker.js')
    const { pickDeliverySession } = await import('../routines/session-target.js')
    const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []))
    if (!target) return { ok: false, detail: `"${task.title}" has no session to tell` }
    const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js')
    const { sendMessageToSession } = await import('../session-message-queue.js')
    const { FIX_SEND_SOURCE } = await import('../health-monitor/fix-task.js')
    await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
      kind: 'notification',
      attrs: { from: NOTE_FROM, note: 'a real-use alarm on a change this task shipped or leads' },
      body: text,
    }), { source: FIX_SEND_SOURCE, taskId: task.id, messageId: `qm-usage-${rowId}` })
    return { ok: true, detail: `told "${task.title}"` }
  },
}

/** The problem event an alarm's numbers come from. */
const PROBLEM_OF: Record<string, string> = {
  'usage.cut': 'cut', 'usage.errors': 'error', 'usage.errors.watched': 'error', 'usage.mount': 'error', 'usage.bad_args': 'bad_args',
  'usage.slow': 'slow', 'usage.server_errors': 'server_error', 'usage.page': 'request_failed',
}

/** An alarm's unit for its count: one "confirmed cut", "error in 6 h"; a share stays as it is. */
export function unitFor(unit: string, value: number | null | undefined): string {
  return value === 1 && !unit.startsWith('%') ? unit.replace(/s(?=$| in )/, '') : unit
}

/** Walnut Health's `route` action for a real-use alarm (health-monitor/index.ts). */
export async function routeHealthAlarm(input: RouteAlarmInput): Promise<RouteAlarmResult> {
  const { def, inst } = input
  const target = usageTargetOf(inst.defId, inst.labels)
  if (!target) return { handled: false, fallback: false, detail: 'not a real-use alarm' }
  const counted = `${inst.value ?? '?'} ${unitFor(def.unit, inst.value)} in the last ${def.periodMin >= 60 ? `${def.periodMin / 60} h` : `${def.periodMin} min`}`
  const detail = lastEventLine(target.kind, target.name, PROBLEM_OF[inst.defId] ?? '')
  return routeUsageAlarm({
    alarmId: inst.id, since: inst.since, title: def.title, kind: target.kind, name: target.name,
    line: detail ? `${counted}; ${clause(detail)}.` : `${counted}.`,
  }, routeDeps)
}

/** Page use's visits by the day (core/page-visits.ts), for a page target's hours before its rows were kept. */
async function judgeInputs(): Promise<JudgeInputs> {
  try {
    const { readVisits } = await import('../page-visits.js')
    const visits = await readVisits()
    return { visitDays: (key) => visits.keys[key]?.days }
  } catch (err) {
    log.obs.warn('usage watch: page visits unreadable', { error: err instanceof Error ? err.message : String(err) })
    return {}
  }
}

/** A watch's check time came: judge it, keep the verdict, tell whoever still owns it. */
async function checkDueWatches(now = Date.now()): Promise<void> {
  const due = listWatches({ states: ['watching'] }).filter((w) => w.checkAt <= now)
  const inputs = due.length ? await judgeInputs() : {}
  for (const w of due) {
    const v = judgeWatch(w, now, inputs)
    if (v.state === 'extended') {
      putWatch({ ...w, extended: true, checkAt: now + (w.checkAt - w.createdAt), result: v.results })
      continue
    }
    const done: Watch = { ...w, state: v.state, checkedAt: now, result: v.results }
    putWatch(done)
    log.obs.info('usage watch: checked', { watch: w.id, taskId: w.taskId, state: v.state })
    if (!(await realUseOn())) continue
    const told = await tellVerdict(done, v.summary).catch((err) => `not told: ${err instanceof Error ? err.message : String(err)}`)
    putWatch({ ...done, told })
  }
}

let rejudged = false

/**
 * Once a server start: watches that ended Unknown in the last week, or passed with a target of no use,
 * judged again (watches.ts rejudgeEnded). A new verdict on an Unknown is kept and told as a fresh one
 * is. One that had passed is kept quietly: its owner was told Nothing to do, and a lead hearing of
 * every page watch at once would be noise; the Real Use page shows it. One reading as before is left.
 */
export async function rejudgeEndedWatches(now = Date.now()): Promise<void> {
  if (rejudged) return
  rejudged = true
  const recent = listWatches({ states: ['unknown', 'passed'], limit: 2_000 })
    .filter((w) => (w.checkedAt ?? 0) >= now - REJUDGE_UNKNOWN_MS && (w.state === 'unknown' || passedOnNoUse(w)))
  const inputs = recent.length ? await judgeInputs() : {}
  for (const w of recent) {
    const v = rejudgeEnded(w, inputs)
    if (!v) continue
    const done: Watch = { ...w, state: v.state, result: v.results }
    putWatch(done)
    log.obs.info('usage watch: judged again', { watch: w.id, taskId: w.taskId, was: w.state, state: v.state })
    if (w.state === 'passed') continue
    if (!(await routeDeps.enabled())) continue
    const summary = `Judged again (it had read Unknown, the machine's sleep counted as time not recorded): ${v.summary}`
    // Its own row id: the Unknown one may still wait in a queue, and a queue keeps one line per id.
    const told = await tellVerdict(done, summary, { rowId: `${w.id}-rejudged`, toldBefore: w.told }).catch((err) => `not told: ${err instanceof Error ? err.message : String(err)}`)
    putWatch({ ...done, told })
  }
}

/**
 * The verdict to its task while open, else (unless it passed) to its project's lead. A verdict judged
 * again that passed (`toldBefore`: who heard the first) still reaches the lead the Unknown went to: it
 * may be acting on an Unknown that was not one.
 */
async function tellVerdict(w: Watch, summary: string, again: { rowId: string; toldBefore?: string } | null = null): Promise<string> {
  const task = await routeDeps.taskInfo(w.taskId)
  const rowId = again?.rowId ?? `${w.id}-verdict`
  const text = [
    `Real use: your watch ${w.id} on ${w.targets.join(', ')} ended. ${summary}.`,
    w.state === 'passed' ? 'Nothing to do.' : 'Next: look at Settings › Diagnostics › Real Use (or usage_watch {"action":"report","target":"<target>"}), fix what it names, ship, and arm a new watch.',
  ].join('\n')
  if (task && !task.complete) {
    const r = await routeDeps.deliver(task.id, text, rowId)
    return r.ok ? task.id : `not told: ${r.detail}`
  }
  const earlier = again?.toldBefore
  if (w.state === 'passed' && earlier && earlier !== w.taskId && !/\s/.test(earlier)) {
    const r = await routeDeps.deliver(earlier, `${text}\n"${task?.title ?? w.taskId}" (${w.taskId}) set it and is complete: its earlier Unknown needs nothing.`, rowId)
    return r.ok ? earlier : `not told: ${r.detail}`
  }
  if (w.state === 'passed') return 'passed; its task is complete'
  const lead = await routeDeps.leadOf(task?.project ?? 'Walnut')
  if (!lead) return 'not told: its task is complete and no lead'
  const r = await routeDeps.deliver(lead.id, `${text}\n"${task?.title ?? w.taskId}" (${w.taskId}) set it and is complete: reopen it with task_send force:true and a reason, or hand it on.`, rowId)
  return r.ok ? lead.id : `not told: ${r.detail}`
}

let timer: ReturnType<typeof setInterval> | null = null
let busy = false

const CLOSE_SUBSCRIBER = 'usage-watch-close'

export function startRealUse(): void {
  startUsageRecorder()
  if (timer) return
  // A shipped task closed with no watch (by its lead or a person): the gap is recorded.
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.subscribe(CLOSE_SUBSCRIBER, (event) => {
      const task = (event.data as { task?: { id?: string; phase?: string } } | undefined)?.task
      if (!task?.id || task.phase !== 'COMPLETE') return
      const id = task.id
      void (async () => {
        if (!(await realUseOn())) return
        const { noteClosedUnwatched } = await import('./gate.js')
        const w = noteClosedUnwatched(id)
        if (w) log.task.info('real use: a shipped task closed with no watch', { taskId: id, watch: w.id })
      })().catch(() => { /* a record, never a failure */ })
    }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED] })
  }).catch(() => { /* no bus in this process */ })
  timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        setWatchedOps(listWatches({ states: ['watching'] }).flatMap((w) => w.targets.filter((t) => t.startsWith('op:')).map((t) => t.slice(3))))
        await rejudgeEndedWatches()
        await checkDueWatches()
        await sendDueNotes(routeDeps)
      } catch (err) {
        log.obs.warn('usage watch: tick failed', { error: err instanceof Error ? err.message : String(err) })
      } finally { busy = false }
    })()
  }, 60_000)
  timer.unref?.()
}

export function stopRealUse(): void {
  if (timer) clearInterval(timer)
  timer = null
  rejudged = false
  void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(CLOSE_SUBSCRIBER)).catch(() => { /* never subscribed */ })
  stopUsageRecorder()
}

export { flushUsage }
