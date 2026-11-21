/**
 * An answer to a reply request (task_send in_reply_to: one id, or up to 20 that one answer
 * covers) from this host's own `walnut` calls, as the host daemon's own away answer gives it
 * (offline-host-core.ts opReply / opReplies), and while the Mac answers as its handleLocal does
 * (localReply). The request comes from this host's journal (a row the daemon opened, read with
 * `follower.pending`) or this server's copy of the Mac's pending requests; the asker must run
 * here. The words are the server's (structured-reply.ts composeReplyText) in the reply envelope;
 * the daemon writes them into the asker's session and settles the request (`follower.peer`
 * kind `reply`: its own row turns `replied`, a copy's gets a `settle` record, the score rides).
 * Away, a request this host does not hold or an asker running elsewhere is held for the Mac,
 * as the daemon holds it; online, it is left to the Mac.
 */

import type { ReplicaWrite } from './dispatch.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer } from './write-port.js'
import { composeReplyText, readStructuredReply, scoreProblem } from '../core/peers/structured-reply.js'
import { createEnvelopeKit } from '../core/peers/envelope-kit.js'
import { escapeSenderWords } from '../providers/offline-host-core.js'
import type { AwaySendsDeps, HostSession } from './away-sends.js'

export const kit = createEnvelopeKit()

/** Refused before anything ran: the daemon relays it to the Mac (online), or answers it itself. */
export const serverDelivers = (message: string): PortAnswer => needsLeaderAnswer('server_delivers', message)

const RQ_RE = /^rq-[a-f0-9]{6,}$/
const PENDING_TIMEOUT_MS = 3_000

interface FoundRequest { id: string; fromSessionId: string; toSessionId?: string; toTaskId?: string; preview: string; carries?: unknown }

export interface ReplyContext {
  deps: AwaySendsDeps
  w: ReplicaWrite
  sid: string
  me: { title: string; taskId?: string }
  view: { host: string; sessions: HostSession[] }
  online: boolean
  mid: string
  b: Record<string, unknown>
  timeoutMs: number
  admitComplete(taskId: string | undefined, b: Record<string, unknown>, text: string, mode: 'send' | 'reply'): Promise<{ text: string } | { error: PortAnswer }>
  parentComplete(ownTaskId: string | undefined, targetTaskId: string | undefined): Promise<PortAnswer | null>
  peerAnswer(r: Awaited<ReturnType<ReplicaWrite['call']>>): { ok: true; reply: Record<string, unknown> } | { ok: false; answer: PortAnswer }
  /** Held for the Mac, as the daemon holds a call nothing here can answer (away only). */
  hold(why: string): Promise<PortAnswer>
}

/**
 * Not this host's to answer: held for the Mac away (only while nothing of the call went yet: a
 * later asker's answer is told as not settled, never held, or the replay would answer the first
 * again), the Mac's online.
 */
const notHere = (ctx: ReplyContext, why: string, mayHold: boolean) => (ctx.online || !mayHold
  ? Promise.resolve(serverDelivers(`${why}; your Mac routes the answer.`))
  : ctx.hold(why))

/** The request `id` as this host holds it: its journal's own row first (the latest record of it), else the copy's pending one. */
function requestLookup(ctx: ReplyContext): (id: string) => Promise<{ row: FoundRequest; own: boolean } | null> {
  let own: Map<string, FoundRequest> | null = null
  return async (id) => {
    if (!own) {
      own = new Map()
      try {
        const r = await ctx.deps.request('follower.pending', { sinceSeq: 0 }, PENDING_TIMEOUT_MS)
        const records = (Array.isArray(r.records) ? r.records as Array<Record<string, unknown>> : [])
          .filter((x) => x && x.kind === 'row').sort((a, b) => Number(a.seq) - Number(b.seq))
        for (const x of records) {
          const row = x.row as FoundRequest | undefined
          if (row && typeof row.id === 'string') own.set(row.id, row)
        }
      } catch (err) {
        ctx.deps.log('warn', 'replica: this host\'s request rows could not be read for an answer', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    const mine = own.get(id)
    if (mine) return { row: mine, own: true }
    const copy = await ctx.deps.requestCopy(id)
    // Only a request still pending in the Mac's copy (the daemon's copy holds only those): a settled one is the Mac's to call late.
    if (copy && copy.status === 'pending' && typeof copy.fromSessionId === 'string') return { row: copy as unknown as FoundRequest, own: false }
    return null
  }
}

const isLive = (s: HostSession | undefined) => !!s && (s.state === 'working' || s.state === 'idle')

/** One answer written into its asker's session; `rest`: the same asker's other ids it settles. */
async function replyOne(ctx: ReplyContext, find: ReturnType<typeof requestLookup>, id: string, words: string, mid: string, part: number, rest: string[]): Promise<PortAnswer> {
  const { b, me, sid, online, deps } = ctx
  const mayHold = part === 0
  const hit = await find(id)
  if (!hit) return notHere(ctx, `Request ${id} is not held by this host`, mayHold)
  const row = hit.row
  if (!(row.toSessionId === sid || (!!row.toTaskId && row.toTaskId === me.taskId))) {
    return online ? serverDelivers('that request was not addressed to this session') : refusalAnswer('bad_request', `request ${id} was not addressed to this session`)
  }
  // Its answer may go to the asker of the request it carries (sessions/reply-handoff.ts): the Mac's to route.
  if (online && !hit.own && (row.carries === true || (Array.isArray(row.carries) && row.carries.length > 0))) return serverDelivers('that request carries another')
  const asker = row.fromSessionId
  const askerHere = ctx.view.sessions.find((s) => s.sid === asker)
  if (online && asker === sid) return serverDelivers('the asker is the calling session')
  const askerTask = askerHere?.taskId ?? (await deps.session(asker))?.taskId
  const closed = await ctx.parentComplete(me.taskId, askerTask)
  if (closed) return online ? serverDelivers('a complete parent is the Mac\'s to refuse') : closed
  if (online && askerTask && (await deps.task(askerTask))?.phase === 'COMPLETE') return serverDelivers('Your Mac decides an answer to a complete task.')
  const admitted = await ctx.admitComplete(askerTask, b, words, 'reply')
  if ('error' in admitted) return admitted.error
  if (!isLive(askerHere)) return notHere(ctx, `The asking session (${asker.slice(0, 8)}) is not running on this host`, mayHold)
  const text = kit.buildReplyDeliveryText({ id, preview: row.preview }, {
    title: me.title, shortId: sid.slice(0, 8), host: ctx.view.host, sessionId: sid, ...(me.taskId ? { taskId: me.taskId } : {}),
  }, escapeSenderWords(admitted.text), { title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : undefined })
  const r = ctx.peerAnswer(await ctx.w.call('follower.peer', {
    kind: 'reply', online, ...(part ? { part } : {}), fromSessionId: sid, toSessionId: asker, requestId: id, text, messageId: mid,
    ...(me.taskId ? { replierTaskId: me.taskId } : {}), ...(b.score !== undefined ? { score: b.score } : {}), ...(rest.length ? { alsoSettle: rest } : {}),
  }, { timeoutMs: ctx.timeoutMs }))
  if (!r.ok) return r.answer
  deps.continued?.(asker)
  deps.log('info', 'replica: an answer to a request was delivered on this host', { requestId: id, from: sid, to: asker, online, opId: ctx.w.opId })
  const messageId = typeof r.reply.messageId === 'string' ? r.reply.messageId : mid
  const title = askerHere?.title ?? null
  return {
    answered: false, status: 202, body: {
      delivery: 'queued', via: 'host', host: ctx.view.host, ...(online ? {} : { offline: true }),
      targetSessionId: asker, targetTitle: title, ...(askerTask ? { targetTaskId: askerTask } : {}),
      target: { handle: kit.sessionHandle(title, asker), sessionId: asker, ...(askerTask ? { taskId: askerTask } : {}) },
      repliedTo: id, messageId, ...(r.reply.duplicate === true ? { duplicate: true } : {}),
    },
  }
}

/** in_reply_to as the daemon answers it: every id checked before anything is sent, then one answer per asker. */
export async function replyTo(ctx: ReplyContext, text: string): Promise<PortAnswer> {
  const { b, online } = ctx
  const raw = b.in_reply_to
  // handleLocal takes one id only: a list is the Mac's (performReplies) while it answers.
  if (online && typeof raw !== 'string') return serverDelivers('An answer to several requests is routed by your Mac.')
  const ids = Array.isArray(raw) ? [...new Set(raw)] : [raw]
  if (!ids.length || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !RQ_RE.test(id))) {
    return refusalAnswer('bad_request', 'in_reply_to must be an rq-… id, or a list of up to 20 of them')
  }
  const problem = scoreProblem(b.score)
  if (problem) return refusalAnswer('bad_request', problem)
  // The structured fields as sections of the words (the server's composeReplyText): nothing of them is lost.
  const words = composeReplyText(text, readStructuredReply(b))
  if (!words) return refusalAnswer('bad_request', 'text must be a non-empty string')
  const find = requestLookup(ctx)
  if (ids.length === 1) return replyOne(ctx, find, ids[0] as string, words, ctx.mid, 0, [])
  const byAsker = new Map<string, string[]>()
  for (const id of ids as string[]) {
    const hit = await find(id)
    if (!hit) return notHere(ctx, `Request ${id} is not held by this host`, true)
    if (!(hit.row.toSessionId === ctx.sid || (!!hit.row.toTaskId && hit.row.toTaskId === ctx.me.taskId))) {
      return refusalAnswer('bad_request', `request ${id} was not addressed to this session`)
    }
    byAsker.set(hit.row.fromSessionId, [...(byAsker.get(hit.row.fromSessionId) ?? []), id])
  }
  let first: Record<string, unknown> | undefined
  let firstFailure: string | undefined
  const answered: string[] = []
  const notAnswered: string[] = []
  let n = 0
  for (const group of byAsker.values()) {
    const [lead, ...rest] = group as [string, ...string[]]
    const named = rest.length ? `${words}\n\n(This one answer also settles ${rest.join(', ')}: nothing more comes for ${rest.length === 1 ? 'it' : 'them'}.)` : words
    // One message id per asker's delivery (the daemon's rule): a queue that dedups by id never takes the second for a retry of the first.
    const part = n
    const mid = n++ ? `qm-${ctx.mid.slice(3, 63)}-${n}` : ctx.mid
    const sent = await replyOne(ctx, find, lead, named, mid, part, rest)
    const ok = !sent.answered && sent.status < 300
    // Nothing sent yet: the whole call goes on as it is (held, or to the Mac).
    if (!ok && !first) return sent
    if (!ok) {
      const err = sent.answered ? undefined : (sent.body.error as { message?: unknown } | undefined)?.message
      firstFailure ??= typeof err === 'string' ? err : 'it could not be delivered'
      notAnswered.push(...group)
      continue
    }
    first ??= (sent as { body: Record<string, unknown> }).body
    answered.push(...group)
  }
  if (!first) return refusalAnswer('internal', 'nothing answered')
  if (!notAnswered.length) return { answered: false, status: 202, body: { ...first, answered } }
  const why = (firstFailure ?? '').slice(0, 300)
  return { answered: false, status: 202, body: { ...first, answered, notAnswered, notAnsweredWhy: why } }
}

