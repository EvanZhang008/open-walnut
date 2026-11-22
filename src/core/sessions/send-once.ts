/**
 * One send, however often a client asks for it.
 *
 * A client that lost its connection with a send in flight cannot tell whether the server took it,
 * so it sends it again by itself once the server answers (the chat: web/src/hooks/send-auto-retry.ts;
 * the quick bar: web/src/components/quickbar/useQuickReceipts.ts). The send carries the same user
 * line uuid every time, and that uuid is how the server knows it is the same send:
 *
 *  - oneSendAtATime: the same send twice at once runs one after the other, so the later finds what
 *    the earlier did instead of racing it to the queue;
 *  - sendOnce: an answer this process already gave for the uuid is given again (kept a little past
 *    the clients' 10 minute limit on sending by themselves), so a start or a send runs once;
 *  - sameSendSettled: after a restart that memory is gone, so the durable record answers: a queued
 *    row with that uuid is that send (drained, never copied), and a line the CLI already ran under
 *    it is delivered.
 *
 * Shared by the chat's `session:send` (src/web/routes/session-chat.ts) and the quick bar's
 * `/api/v1/quick/send` (src/web/routes/quick-input-v1.ts). A send without a uuid runs as always.
 */
import { queuedRowOfUserLine } from '../session-message-queue.js'
import { log } from '../../logging/index.js'

const sendsInFlight = new Map<string, Promise<unknown>>()

/** The same `key` (a send's session and user line) runs one at a time; no key runs at once. */
export function oneSendAtATime<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!key) return run()
  const earlier = sendsInFlight.get(key)
  // The later one runs after the earlier settles, so it finds the row the earlier queued.
  const next = (earlier ? earlier.catch(() => undefined) : Promise.resolve()).then(run)
  sendsInFlight.set(key, next)
  const clear = () => { if (sendsInFlight.get(key) === next) sendsInFlight.delete(key) }
  next.then(clear, clear)
  return next
}

/** How long an answer is kept for its uuid: past the clients' 10 minute limit on sending by themselves. */
export const SEND_ANSWER_KEPT_MS = 11 * 60_000
const MAX_KEPT_ANSWERS = 2_000
const keptAnswers = new Map<string, { at: number; answer: unknown }>()

function keptAnswer(key: string, now: number): { answer: unknown } | undefined {
  const hit = keptAnswers.get(key)
  if (!hit) return undefined
  if (now - hit.at >= SEND_ANSWER_KEPT_MS) { keptAnswers.delete(key); return undefined }
  return hit
}

function keepAnswer(key: string, answer: unknown, now: number): void {
  for (const [k, v] of keptAnswers) {
    if (keptAnswers.size < MAX_KEPT_ANSWERS && now - v.at < SEND_ANSWER_KEPT_MS) break
    keptAnswers.delete(k)
  }
  keptAnswers.set(key, { at: now, answer })
}

/**
 * Run the send `key` names once: the same key again (at once or later) gets the first answer,
 * through `again` when given (what became of it since: a queued row that went in is delivered).
 * Only an answer is kept; a send that threw runs again next time. No key runs every time.
 */
export function sendOnce<T>(
  key: string | undefined, run: () => Promise<T>,
  opts: { now?: () => number; again?: (answer: T) => Promise<T> } = {},
): Promise<T> {
  if (!key) return run()
  const now = opts.now ?? Date.now
  return oneSendAtATime(key, async () => {
    const hit = keptAnswer(key, now())
    if (hit) {
      log.web.info('send: the same send again, answered as the first', { key })
      return opts.again ? opts.again(hit.answer as T) : hit.answer as T
    }
    const answer = await run()
    keepAnswer(key, answer, now())
    return answer
  })
}

/** Forget every kept answer (tests). */
export function resetSendOnce(): void {
  keptAnswers.clear()
  sendsInFlight.clear()
}

export type SameSend =
  /** Still queued under its user line: drained now, never copied. */
  | { state: 'queued'; messageId: string; enqueuedAt?: string }
  /** The CLI already ran the line: delivered. */
  | { state: 'ran' }
  | { state: 'none' }

/**
 * What became of an earlier send of this user line, from the durable record (the queue, the
 * daemon's line fate), for a resend whose first answer was lost. `lineUuid`: the uuid the line
 * went out under when the server knows another (a row's settled line), else the user line.
 */
export async function sameSendSettled(input: {
  sessionId: string
  host?: string | null
  taskId?: string
  userUuid?: string
  lineUuid?: string
  message: string
  source: string
  /** Sent again by the client itself: a row the person (or the server) parked stays parked. */
  autoResend: boolean
}): Promise<SameSend> {
  const { sessionId, userUuid } = input
  const twin = userUuid ? await queuedRowOfUserLine(sessionId, userUuid) : undefined
  if (twin) {
    log.web.info('send: the send is already queued under its user line', { sessionId, messageId: twin.id, source: input.source })
    const { sendQueuedNow } = await import('./send-now.js')
    // A resend still means "send it": the drain is asked for; a person's resend un-parks it too.
    await sendQueuedNow({
      sessionId, messageId: twin.id, taskId: input.taskId, message: input.message, source: input.source, unpark: !input.autoResend,
    })
    return { state: 'queued', messageId: twin.id, ...(twin.enqueuedAt ? { enqueuedAt: twin.enqueuedAt } : {}) }
  }
  // The first send's acknowledgement was lost, not the send: its line may have run. Then a fresh
  // enqueue would only spawn a CLI for a turn that never comes (resend-already-ran.ts).
  const { resendAlreadyRan } = await import('./resend-already-ran.js')
  if (await resendAlreadyRan({ sessionId, host: input.host, lineUuid: input.lineUuid ?? userUuid })) return { state: 'ran' }
  return { state: 'none' }
}
