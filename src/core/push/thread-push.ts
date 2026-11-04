/**
 * A thread that waits on the user buzzes his phone.
 *
 * 2026-11-04: a thread's news goes to the thread only, never also a letter (human-inbox/
 * thread-instead.ts), and only letters buzzed the phone; so a decision on a thread while he was away
 * buzzed nothing. Walnut VP, for the user: "Evan wants no duplicates, not no reminders: a thread that
 * waits on his decision and does not buzz while he is away hides the decision." So when Main or a
 * lead moves one of its threads into needs (threads-store.ts mutateThreads, the one write of a
 * threads file, hands every such move here), his phone gets a notification through the letters'
 * delivery (deliver.ts, the device modes of letter-push-policy.ts), with no letter made:
 *  - only needs; answered, working and pending never buzz. A thread that stays in needs buzzes once;
 *    one that leaves it and comes back buzzes again (threads-model.ts enteredNeeds);
 *  - never while he is in the node's chat (org/user-away.ts: not away);
 *  - one buzz per absence, shared with the away letters (human-inbox/away-thread.ts): quiet while an
 *    unread letter of the absence, or another thread's buzz, is younger than DECISION_QUIET_MS, the
 *    same clock a decision letter of the absence uses. Each buzz is recorded on its thread
 *    (`needsBuzzedAt`), and away-thread.ts counts it as the absence's buzz too.
 * The title is the thread's title, the body its ask; a tap carries the node and the thread.
 * Every move into needs logs exactly one `thread push` line saying what happened.
 */
import { log } from '../../logging/index.js'
import { getConfig } from '../config-manager.js'
import { getQuiet, logQuietSkipOnce, quietSuppresses } from '../quiet/quiet-state.js'
import { truncatePreview } from '../human-inbox/preview.js'
import { DECISION_QUIET_MS } from '../human-inbox/away-thread.js'
import type { LetterRecord } from '../human-inbox/types.js'
import type { OrgThread } from '../org/threads-model.js'
import type { AwayState } from '../org/user-away.js'
import type { PushTokenEntry, Task } from '../types.js'
import { deliverPush } from './deliver.js'
import { ACTIVE_LEASE_MS, parseMode, selectDevices } from './letter-push-policy.js'
import type { PushContent } from './send.js'

/** `data.type` of a thread push (the phone routes on it; an unknown type just opens the app). */
export const THREAD_PUSH_TYPE = 'org_thread'
const TITLE_MAX = 100

/** The notification for a thread that waits on him. Pure. */
export function threadPushContent(thread: Pick<OrgThread, 'id' | 'title' | 'ask' | 'reply'>, node: Pick<Task, 'id' | 'org_role' | 'project'>): PushContent {
  const nodeKey = node.org_role === 'main' ? 'main' : (node.project || node.id)
  return {
    title: thread.title.slice(0, TITLE_MAX),
    body: truncatePreview(thread.ask?.trim() || thread.reply?.trim() || '') || 'Waiting on your answer',
    data: {
      type: THREAD_PUSH_TYPE,
      taskId: node.id,
      threadId: thread.id,
      url: `/org?node=${encodeURIComponent(nodeKey)}`,
    },
    // A decision someone is blocked on, like an action_required letter.
    priority: 10,
    // One thread, one banner: a move back into needs replaces the earlier one.
    collapseId: thread.id,
  }
}

export type ThreadBuzzPlan = { buzz: true } | { buzz: false; reason: string }

/**
 * Pure: whether this move into needs buzzes. `away` is the node's (null: not an org node, or the
 * org is off); `threads` its threads as they are now; `letters` its open away letters.
 */
export function planThreadBuzz(input: {
  threadId: string
  away: AwayState | null
  threads: readonly Pick<OrgThread, 'id' | 'needsBuzzedAt'>[]
  letters: readonly Pick<LetterRecord, 'createdAt' | 'read' | 'archived'>[]
  now: number
}): ThreadBuzzPlan {
  if (!input.away) return { buzz: false, reason: 'not an org node, or the org is off' }
  if (!input.away.away) return { buzz: false, reason: 'the user is in the node\'s chat' }
  const since = input.away.lastSeenAt ?? 0
  const recent = (at: number) => Number.isFinite(at) && at > since && input.now - at < DECISION_QUIET_MS
  if (input.letters.some((l) => !l.read && !l.archived && recent(l.createdAt))) {
    return { buzz: false, reason: 'an unread letter of this absence buzzed lately' }
  }
  if (input.threads.some((t) => t.id !== input.threadId && !!t.needsBuzzedAt && recent(Date.parse(t.needsBuzzedAt)))) {
    return { buzz: false, reason: 'another thread of this absence buzzed lately' }
  }
  return { buzz: true }
}

/** The latest buzz of the node's threads after `since` (epoch ms), or null: away-thread.ts counts it as the absence's. */
export function lastThreadBuzz(threads: readonly Pick<OrgThread, 'needsBuzzedAt'>[], since: number | null): number | null {
  let last: number | null = null
  for (const t of threads) {
    const at = t.needsBuzzedAt ? Date.parse(t.needsBuzzedAt) : NaN
    if (Number.isFinite(at) && at > (since ?? 0) && (last === null || at > last)) last = at
  }
  return last
}

/** One node's moves at a time: two threads entering needs together buzz once. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return next
}

export interface ThreadPushOutcome { threadId: string; sent: number; reason?: string }

/** Called by threads-store.ts for each write that moved threads into needs. Never throws. */
export async function onThreadsEnteredNeeds(taskId: string, threads: readonly OrgThread[], now = Date.now()): Promise<ThreadPushOutcome[]> {
  return serial(taskId, async () => {
    const out: ThreadPushOutcome[] = []
    for (const thread of threads) {
      try {
        out.push(await buzzOne(taskId, thread, now))
      } catch (err) {
        const reason = `push threw: ${err instanceof Error ? err.message : String(err)}`
        log.notif.error('thread push', { taskId, threadId: thread.id, sent: 0, reason })
        out.push({ threadId: thread.id, sent: 0, reason })
      }
    }
    return out
  })
}

async function buzzOne(taskId: string, thread: OrgThread, now: number): Promise<ThreadPushOutcome> {
  const done = (sent: number, reason?: string, extra: Record<string, unknown> = {}): ThreadPushOutcome => {
    const fields = { taskId, threadId: thread.id, sent, ...extra, ...(reason ? { reason } : {}) }
    if (sent > 0) log.notif.info('thread push', fields)
    else log.notif.warn('thread push', fields)
    return { threadId: thread.id, sent, ...(reason ? { reason } : {}) }
  }
  const { listTasksByIds } = await import('../task-manager.js')
  const [node] = await listTasksByIds([taskId]).catch(() => [])
  if (!node) return done(0, 'no such node task')
  const { userAwayFrom } = await import('../org/user-away.js')
  const away = await userAwayFrom(node, now)
  const { readThreads, markNeedsBuzzed } = await import('../org/threads-store.js')
  const { awayLettersOf } = await import('../human-inbox/store.js')
  const plan = planThreadBuzz({
    threadId: thread.id, away, threads: (await readThreads(taskId)).threads, letters: await awayLettersOf(taskId), now,
  })
  if (!plan.buzz) return done(0, plan.reason, { outcome: 'quiet' })

  const quiet = await getQuiet()
  if (quietSuppresses(quiet, { permission: true })) {
    logQuietSkipOnce('thread-push', quiet)
    return done(0, 'quiet mode is on')
  }
  const tokens: PushTokenEntry[] = (await getConfig()).push_tokens ?? []
  if (!tokens.length) return done(0, 'no device registered for push', { devices: 0 })
  const chosen = selectDevices(
    tokens.map((t) => ({
      entry: t, mode: parseMode(t.mode),
      ...(t.key_name ? { name: t.key_name } : {}),
      ...(typeof t.active_at === 'number' ? { activeAt: t.active_at } : {}),
      ...(t.letter_types ? { types: t.letter_types } : {}),
    })),
    // His device settings for a decision letter decide a decision thread too.
    'action_required', now, ACTIVE_LEASE_MS,
  )
  if (!chosen.length) return done(0, 'all devices are foreground-active or muted decisions', { devices: tokens.length, targeted: 0 })
  const res = await deliverPush(chosen.map(({ device }) => device.entry), threadPushContent(thread, node))
  // Recorded once it was handed to a device service: the absence's buzz, whatever the service said.
  if (res.attempted) await markNeedsBuzzed(taskId, thread.id, new Date(now).toISOString()).catch(() => {})
  return done(res.sent, res.reason, { devices: tokens.length, targeted: chosen.length, failed: res.failed })
}
