/**
 * What the watchers of a task's links share (pull-requests/pr-watch.ts, changes/watch.ts):
 *
 *   wake     news goes to the task's session the way a trigger's fire does: the live session,
 *            else the stopped one (a cold resume); a task with no session is not given one.
 *   follow   a task update whose links a watcher has not seen (a new link, a removed one) asks that
 *            watcher for a read of the task a few seconds later, many updates folded into one read.
 */

import type { Task } from './types.js'

/** The session that should hear a task's news, or null. `running` is a turn in progress. */
export async function taskNewsTarget(taskId: string): Promise<{ sessionId: string; running: boolean } | null> {
  const { getSessionsForTask } = await import('./session-tracker.js')
  const { pickDeliverySession } = await import('./routines/session-target.js')
  const target = pickDeliverySession(await getSessionsForTask(taskId).catch(() => []))
  return target ? { sessionId: target.claudeSessionId, running: target.process_status === 'running' } : null
}

/** Send a watcher's news. `endsWait`: a task parked on what the watcher follows waited for exactly
 *  this. `messageId` is stable for the same news, so a retold wake still queued is not queued twice. */
export async function sendTaskNews(source: string, sessionId: string, text: string, taskId: string, messageId: string): Promise<void> {
  const { sendMessageToSession } = await import('./session-message-queue.js')
  await sendMessageToSession(sessionId, text, { source, taskId, endsWait: true, messageId })
}

const FOLLOW_DELAY_MS = 3_000

/**
 * Watch task updates for links a watcher should read. `pick` answers null for an update that needs
 * no read, else the URLs to read now (possibly none: the task's pass alone). Updates the watcher
 * wrote itself (`source`) are skipped. Returns the stop.
 */
export async function followTaskLinks(
  source: string,
  pick: (task: Task, eventSource: string | undefined) => readonly string[] | null,
  read: (taskIds: string[], urls: Set<string>) => void,
): Promise<() => void> {
  const { bus, EventNames } = await import('./event-bus.js')
  const tasks = new Set<string>()
  const urls = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const ids = [...tasks]
    const now = new Set(urls)
    tasks.clear()
    urls.clear()
    read(ids, now)
  }
  bus.subscribe(source, (event) => {
    if (event.source === source) return
    const task = (event.data as { task?: Task } | undefined)?.task
    if (!task || task.phase === 'COMPLETE') return
    const wanted = pick(task, event.source)
    if (!wanted) return
    tasks.add(task.id)
    for (const url of wanted) urls.add(url)
    if (!timer) { timer = setTimeout(flush, FOLLOW_DELAY_MS); timer.unref?.() }
  }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_CREATED] })
  return () => { bus.unsubscribe(source); if (timer) clearTimeout(timer); timer = null }
}
