/**
 * His phone buzzes only for what needs him (experiment `inbox_needs_threads`; 2026-11-20, the user's
 * "Only Threads" design: the phone rings only for a thread that needs him).
 *
 * With the experiment on:
 *  - a decision letter that waits on him as a thread (letters_as_threads, letter-threads.ts
 *    letterWaitsOnThread) buzzes once, as that thread: the thread's notification (thread-push.ts
 *    threadPushContent: type `org_thread`, its node and thread, collapsed by the thread's id), under
 *    a decision letter's device rules and quiet hold. The letter itself sends no `human_inbox_letter`
 *    push, and the thread's move into needs buzzes nothing (threads-store.ts mutateThreads leaves a
 *    thread holding a letter out of thread-push.ts, with the experiment on or off);
 *  - any other thread buzzes only when it moves into needs, as before (thread-push.ts), so a
 *    thread that only has news (an update, an answer) never buzzes;
 *  - a letter that is no thread buzzes as before (letter-push.ts).
 * Off: nothing here runs, and every push is as before.
 */
import { log } from '../../logging/index.js'

export interface LetterEventFacts {
  letterId: string
  subject: string
  type: string
  textPreview: string
  kind: 'new' | 'reply'
  originKind?: string
  originName?: string
}

/**
 * A new decision letter that waits on him as a thread: buzz for the thread instead, and log the
 * letter's one `letter push` line (letter-push.ts promises one per letter). True when it was
 * handled here (the caller sends no letter push); false when it is an ordinary letter push.
 * The banner reads as the letter's would (who it is from first, its subject, its preview); only
 * what a tap opens and what it replaces is the thread's.
 */
export async function pushedAsThread(data: LetterEventFacts, now = Date.now()): Promise<boolean> {
  if (data.kind !== 'new' || data.type !== 'action_required') return false
  const { inboxNeedsThreadsOn } = await import('../human-inbox/needs-threads.js')
  if (!(await inboxNeedsThreadsOn())) return false
  const { getLetter } = await import('../human-inbox/store.js')
  const letter = await getLetter(data.letterId, { deferBodies: true }).catch(() => null)
  if (!letter) return false
  const { letterWaitsOnThread } = await import('../human-inbox/letter-threads.js')
  const held = await letterWaitsOnThread(letter).catch(() => null)
  if (!held) return false
  const fields = { letterId: letter.id, letterType: letter.type, kind: data.kind, outcome: 'as_thread', taskId: held.task.id, threadId: held.threadId }
  try {
    const [{ deliverThreadPush, threadPushContent }, { letterPushContent }] = await Promise.all([import('./thread-push.js'), import('./letter-push.js')])
    const thread = { id: held.threadId, title: data.subject, ask: data.subject }
    const asThread = threadPushContent(thread, held.task)
    const content = {
      ...letterPushContent({
        letterId: letter.id, subject: data.subject, type: data.type, textPreview: data.textPreview, kind: data.kind,
        ...(data.originKind && data.originName ? { origin: { kind: data.originKind, name: data.originName } } : {}),
      }),
      data: asThread.data, collapseId: asThread.collapseId,
    }
    const d = await deliverThreadPush(thread, held.task, now, content)
    const line = { ...fields, attempted: d.attempted, sent: d.sent, ...d.fields, ...(d.reason ? { reason: d.reason } : {}) }
    if (d.sent > 0) log.notif.info('letter push', line)
    else log.notif.warn('letter push', line)
  } catch (err) {
    log.notif.error('letter push', { ...fields, attempted: false, sent: 0, reason: `push threw: ${err instanceof Error ? err.message : String(err)}` })
  }
  return true
}
