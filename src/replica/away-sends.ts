/**
 * A message from this host's own `walnut` calls (task_send / session_send, POST /v1/messages),
 * answered by this host's Walnut server (the `host-local-calls` capability; local-calls.ts runs
 * the calls), with the same rules the host daemon's own away answer applies
 * (offline-host-core.ts opTaskSend / opReply, and handleLocal while the Mac answers):
 *
 *   away (no leader answers)
 *     a send      the target resolved from this server's copies (an exact task id or a unique
 *                 prefix, a session id or one of 8 or more): its live session on this host gets
 *                 it, framed as a peer note; the server's refusals first (a complete parent, a
 *                 lead that handed over, the caller itself, a COMPLETE task without force and a
 *                 reason). A reply is asked for unless expect_reply is false, or omitted on a note
 *                 up the org (reply-direction.ts goesUpIn, over the copy with this host's journal
 *                 folded in, so a task made here reports up too), or wake is false and not forced
 *                 (delivered now, it asks nothing). Its row is the daemon's, as its own offline
 *                 answer opens one (the "target ended without replying" watch there takes it). A target not running here is held for the
 *                 Mac (the daemon's held op), for a Mac that drains `held-op`, and so is one the
 *                 Mac keeps local (kept-local-calls.ts), named by id: this host holds none of it.
 *     a reply     in_reply_to (one id or up to 20): the request from this host's journal or the
 *                 copy, the asker running here, written into its session and settled here
 *                 (away-replies.ts)
 *   online (the Mac answers, `host_call_entry` on): only what the daemon's handleLocal takes,
 *     judged the same way; anything else (a quiet wake:false note the Mac holds, too) answers
 *     `needs_leader {why: 'server_delivers'}` and the daemon relays it to the Mac, carrying the
 *     message id it set. Any failure of this server's is the Mac's too (local-calls.ts onlineReply).
 *
 * The rules shared with the Mac (the reply default, wake, the deadline and its kind, the refusals'
 * words) are its own, from core/sessions/send-rules.ts, which the daemon runs too: one copy.
 *
 * The daemon writes it (`follower.peer`, 'follower-peer-v1'): the row's turn and stream facts,
 * the reply line, the live CLI's FIFO and the journal records, the same records its own answer
 * writes, so the Mac's drain is unchanged. A retry of the same call (its op id) is written once.
 * A plugin job's message keeps its path: a plain note to a session here (follower.send), no reply.
 */

import crypto from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ReplicaWrite } from './dispatch.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer, type TaskRow, type WriteActor, type WritePort } from './write-port.js'
import { escapeSenderWords } from '../providers/offline-host-core.js'
import { messageIdOfCall, writeOpId } from '../lib/op-call-id.js'
import { refNamesId } from '../lib/id-ref.js'
import { kit, replyTo, serverDelivers, type ReplyContext } from './away-replies.js'
import { frameAsCaller, taskSessions } from './away-starts.js'
import { leaderAnswers } from '../core/server-role.js'
import { admitRetiredLeadRule, directionDecides, holdsQuietly, opensRequest, parentCompleteRefusal, replyKindOf, ruleInputOf, wakeFalseConflict, type RetiredLeadFacts } from '../core/sessions/send-rules.js'
import { clampReplyTimeoutSecs } from '../core/session-requests.js'
import type { Overlay } from './overlay.js'
import { log } from '../logging/index.js'

/** The daemon capability `follower.peer` rides on. */
export const PEER_CAP = 'follower-peer-v1'
const SESSIONS_TIMEOUT_MS = 3_000
/**
 * Each try of a delivery waits this long, as follower.send's: a try whose answer is late is asked
 * again under the same op id, and the daemon answers it from the first (handleFollowerPeer).
 */
const PEER_TIMEOUT_MS = 5_000
/** A plugin job's message takes only these inputs (anything else needs the Mac). */
const JOB_SEND_KEYS = new Set(['to', 'text', 'title', 'wake', 'expect_reply'])

/** A session of this Walnut on this host, as the daemon lists it (follower.sessions: no aside ones). */
export interface HostSession { sid: string; title?: string; taskId?: string; taskTitle?: string; state?: string }

export interface AwaySendsDeps {
  port: WritePort
  actorOf(req: Request): WriteActor | null
  /** A task as this replica shows it (copy plus overlay), by its exact id, or null. */
  task(id: string): Promise<TaskRow | null>
  /** A task by an id or a unique prefix (4 or more), as the Mac resolves one; `ambiguous`: a prefix of several. */
  findTask(ref: string): Promise<{ task?: TaskRow; ambiguous?: boolean }>
  /** A session as the copy holds it (title, task, whether an ACP engine runs it), or null. */
  session(sid: string): Promise<{ title?: string; taskId?: string; acp?: boolean } | null>
  /** A reply request as the copy holds it, or null. */
  requestCopy(id: string): Promise<Record<string, unknown> | null>
  /** `to` is above `from` in the org (core/sessions/reply-direction.ts goesUpIn, over the tasks as this replica shows them). */
  goesUp(fromTaskId: string | undefined, toTaskId: string | undefined): Promise<boolean>
  /** A lead that handed its project over, as the Mac refuses a message to it (org/retired-lead.ts retiredLeadRefusal), or null. */
  retiredLead(callerTaskId: string | undefined, targetTaskId: string): Promise<RetiredLeadFacts | null>
  hostKey: string | null
  capabilities(): readonly string[] | null
  /** A follower link request (`follower.sessions`, `follower.pending`). */
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /** Whether the Mac answers now: only a same-host send is taken then, as the daemon's handleLocal takes it. */
  leaderAnswers(): boolean
  /** A plugin job's words, framed as its automation's (send-frame.ts). */
  frame(text: string, actor: WriteActor): Promise<string>
  /** The task's sessions on this host (a plugin job's plain note goes to its latest). */
  sessionsOfTask(taskId: string): Promise<Array<{ sid: string; host?: string | null; startedAt?: string }>>
  /** A message delivered to a session here started a turn: it is watched again (ask-launch.ts watch). */
  continued?(sid: string): void
  /** `to` names a task the Mac keeps local, or one of its sessions (kinds/local-tasks.ts): held for the Mac. */
  keptLocal?(to: string): Promise<boolean>
  randomHex?(bytes: number): string
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Every task as this replica shows it: the copy's rows with this host's journal folded in, and the tasks made here. */
export function tasksWithOverlay<T extends { id: string }>(rows: readonly T[], overlay: Pick<Overlay, 'task' | 'createdTaskIds'>): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') continue
    seen.add(r.id)
    const folded = overlay.task(r.id, r as unknown as Record<string, unknown>) as T | null
    if (folded) out.push(folded)
  }
  for (const id of overlay.createdTaskIds()) {
    if (seen.has(id)) continue
    const made = overlay.task(id, null) as T | null
    if (made) { out.push(made); seen.add(id) }
  }
  return out
}

/** The call id a self-call's op id was made from (op-call-id.ts writeOpId of POST /messages), or null. */
export function callIdOfOpId(opId: string): string | null {
  const m = /^(oc-[A-Za-z0-9_-]{8,48})-[0-9a-f]{8}-(\d+)$/.exec(opId)
  return m && writeOpId(m[1]!, 'POST', '/messages', Number(m[2])) === opId ? m[1]! : null
}

/** The message id a send goes as: the caller's own, else its call's (as the daemon and the Mac pick), else its op id's. */
export function sendMessageIdOf(given: unknown, opId: string): string {
  if (typeof given === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(given)) return given
  const callId = callIdOfOpId(opId)
  return callId ? messageIdOfCall(callId) : `qm-${opId.replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 67)
}

export function awaySends(deps: AwaySendsDeps): RequestHandler {
  const hex = deps.randomHex ?? ((n: number) => crypto.randomBytes(n).toString('hex'))

  /** This Walnut's sessions here and how each runs now, by the daemon's own list (null: unread). */
  async function hostView(): Promise<{ host: string; sessions: HostSession[] } | null> {
    try {
      const r = await deps.request('follower.sessions', {}, SESSIONS_TIMEOUT_MS)
      const sessions = Array.isArray(r.sessions) ? (r.sessions as HostSession[]).filter((s) => s && typeof s.sid === 'string') : []
      return { host: str(r.host), sessions }
    } catch (err) {
      deps.log('warn', 'replica: this host\'s sessions could not be read for a message', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  /** The caller by its task's title (the session's own without one), as the daemon names a sender. */
  async function callerOf(sid: string, view: { sessions: HostSession[] }): Promise<{ title: string; taskId?: string } | null> {
    const here = view.sessions.find((s) => s.sid === sid)
    if (here) return { title: str(here.taskTitle) || str(here.title), ...(here.taskId ? { taskId: here.taskId } : {}) }
    const rec = await deps.session(sid)
    if (!rec) return null
    const task = rec.taskId ? await deps.task(rec.taskId) : null
    return { title: str(task?.title) || str(rec.title), ...(rec.taskId ? { taskId: rec.taskId } : {}) }
  }

  /** The server's rule: a subtask never messages its COMPLETE parent (a legacy parent ref may be a prefix). */
  async function parentComplete(ownTaskId: string | undefined, targetTaskId: string | undefined): Promise<PortAnswer | null> {
    if (!ownTaskId || !targetTaskId) return null
    const parentRef = str((await deps.task(ownTaskId))?.parent_task_id)
    if (!parentRef || !refNamesId(parentRef, targetTaskId, (await deps.task(parentRef)) != null, ownTaskId)) return null
    const parent = await deps.task(targetTaskId)
    if (parent?.phase !== 'COMPLETE') return null
    const r = parentCompleteRefusal({ id: parent.id, title: str(parent.title) })
    return refusalAnswer(r.code, r.message)
  }

  /** The server's rule for a COMPLETE target (envelope-kit.ts checkCompleteTarget): the text to deliver, or the refusal. */
  async function admitComplete(taskId: string | undefined, b: Record<string, unknown>, text: string, mode: 'send' | 'reply'): Promise<{ text: string } | { error: PortAnswer }> {
    const task = taskId ? await deps.task(taskId) : null
    if (!task || task.phase !== 'COMPLETE') return { text }
    const check = kit.checkCompleteTarget({ id: task.id, title: str(task.title) }, b, mode)
    return check.ok ? { text: check.text(text) } : { error: refusalAnswer(check.code, check.message) }
  }

  /** A lead that handed over: refused with the lead that took it, unless forced with a reason (which then leads the text). */
  async function retired(callerTaskId: string | undefined, targetTaskId: string | undefined, b: Record<string, unknown>, text: string): Promise<{ text: string } | { error: PortAnswer }> {
    const r = targetTaskId ? await deps.retiredLead(callerTaskId, targetTaskId) : null
    if (!r) return { text }
    const admitted = admitRetiredLeadRule(r, ruleInputOf(b), text)
    return 'error' in admitted ? { error: refusalAnswer(admitted.error.code, admitted.error.message) } : admitted
  }

  const liveIn = (view: { sessions: HostSession[] }, taskId: string) => view.sessions.filter((s) => s.taskId === taskId && (s.state === 'working' || s.state === 'idle'))
  const isLive = (s: HostSession | undefined) => !!s && (s.state === 'working' || s.state === 'idle')

  /**
   * `to` as this host resolves it. Away: an exact task id or a unique prefix (its current session if
   * live here, else the first live one), a session id or one of 8 or more. Online: only what this host
   * names without doubt (handleLocal's localTarget): an exact task id with one live session here, a
   * session id of 8 or more (or a printed `Title [8hex]` handle) whose task runs only it. `elsewhere`:
   * not running here (held for the Mac away; the Mac's online).
   */
  async function resolveTarget(to: string, view: { sessions: HostSession[] }, online: boolean): Promise<{ sid: string; taskId?: string; title?: string } | { elsewhere: string } | { error: PortAnswer }> {
    const ref = to.trim()
    const found = online ? { task: (await deps.task(ref)) ?? undefined } : await deps.findTask(ref)
    if ('ambiguous' in found && found.ambiguous) return { error: refusalAnswer('ambiguous_peer', `"${ref}" matches several tasks`) }
    const task = found.task
    if (task) {
      const current = str(task.session_id)
      if (current && (await deps.session(current))?.acp) return { elsewhere: `Task ${task.id} runs on an ACP engine` }
      const live = liveIn(view, task.id)
      if (online && live.length !== 1) return { elsewhere: `Task ${task.id} does not run exactly one session here` }
      if (!live.length) return { elsewhere: `Task ${task.id} has no session running on this host` }
      const s = live.find((x) => x.sid === current) ?? live[0]!
      return { sid: s.sid, taskId: task.id, title: str(s.title) || str(task.title) }
    }
    const printed = online ? /\[([0-9a-f][0-9a-f-]{7,})\]\s*$/i.exec(ref)?.[1] : undefined
    const key = online ? (printed ?? ref).toLowerCase() : ref
    if (online && (key.length < 8 || !/^[0-9a-f-]+$/.test(key))) return { elsewhere: `"${ref}" is the server's to resolve` }
    const exact = view.sessions.filter((s) => (online ? s.sid.toLowerCase() : s.sid) === key)
    const hits = exact.length ? exact : key.length >= 8 ? view.sessions.filter((s) => (online ? s.sid.toLowerCase() : s.sid).startsWith(key)) : []
    if (hits.length !== 1 || !isLive(hits[0])) return { elsewhere: `"${ref}" is not a session running on this host` }
    const s = hits[0]!
    if ((await deps.session(s.sid))?.acp) return { elsewhere: `Session ${s.sid} runs on an ACP engine` }
    if (online && s.taskId && liveIn(view, s.taskId).length !== 1) return { elsewhere: 'another session of that task runs here too' }
    return { sid: s.sid, ...(s.taskId ? { taskId: s.taskId } : {}), ...(s.title ? { title: s.title } : {}) }
  }

  /** The daemon's answer to a `follower.peer` as the route's. */
  function peerAnswer(r: Awaited<ReturnType<ReplicaWrite['call']>>): { ok: true; reply: Record<string, unknown> } | { ok: false; answer: PortAnswer } {
    if (r.kind === 'answered') return { ok: false, answer: { answered: true } }
    if (r.kind === 'refused') return { ok: false, answer: refusalAnswer(r.code, r.message, r.detail, r.retryAfterMs) }
    return { ok: true, reply: r.reply }
  }

  /** Not running here, while away: held for the Mac (the daemon's held op), replayed once by it. */
  async function hold(w: ReplicaWrite, sid: string, b: Record<string, unknown>, mid: string, why: string): Promise<PortAnswer> {
    const callId = callIdOfOpId(w.opId)
    const r = peerAnswer(await w.call('follower.peer', { kind: 'hold', fromSessionId: sid, args: { ...b, messageId: mid }, ...(callId ? { callId } : {}) }, { timeoutMs: PEER_TIMEOUT_MS }))
    if (!r.ok) return r.answer
    deps.log('info', 'replica: a message was held for the Mac, its target does not run here', { sessionId: sid, why, seq: r.reply.seq, opId: w.opId })
    return { answered: false, status: 202, body: { ...r.reply, delivery: 'queued', targetSessionId: null } }
  }

  async function send(req: Request, w: ReplicaWrite, sid: string): Promise<PortAnswer> {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}
    const online = deps.leaderAnswers()
    if (deps.capabilities()?.includes(PEER_CAP) !== true) return needsLeaderAnswer('daemon_needs_upgrade', 'This host\'s Walnut daemon cannot deliver a message for this server yet; it updates on your Mac\'s next connect.')
    const text = str(b.text)
    // What the Mac alone decides: an answer for the user, and online a hand-off, a structured reply, or no words.
    if (b.withdraw_ask === true && b.answers_ask !== true) return refusalAnswer('bad_request', 'withdraw_ask requires answers_ask: true')
    // Away, an answer for the user is held whole for the Mac, as the daemon's own away answer holds it (holdWrite).
    if (b.answers_ask === true && !online) return hold(w, sid, b, sendMessageIdOf(b.messageId, w.opId), 'answering a task\'s ask of the user is recorded by your Mac')
    if (b.answers_ask === true || (online && (b.answers_ask !== undefined || b.withdraw_ask !== undefined))) return serverDelivers('Answering a task\'s ask of the user in their place needs your Mac.')
    if (online && (b.hands_on !== undefined || b.result !== undefined || b.evidence !== undefined || b.not_done !== undefined || b.score !== undefined || !text)) {
      return serverDelivers('Your Mac delivers this one.')
    }
    const rules = ruleInputOf(b)
    const conflict = wakeFalseConflict(rules)
    if (conflict) return refusalAnswer(conflict.code, conflict.message)
    // The Mac holds a quiet note for the target's next message (quiet-notes.ts): this host cannot, so it is the Mac's.
    if (online && holdsQuietly(rules)) return serverDelivers('A note that asks nothing waits for its target\'s next message on your Mac.')
    const view = await hostView()
    if (!view?.host) return needsLeaderAnswer('sessions_unread', 'This host could not read its sessions just now; nothing was sent.')
    const me = await callerOf(sid, view)
    if (!me) return serverDelivers('This session is not one this host knows; your Mac delivers its message.')
    const mid = sendMessageIdOf(b.messageId, w.opId)
    const ctx: ReplyContext = { deps, w, sid, me, view, online, mid, b, admitComplete, parentComplete, peerAnswer, timeoutMs: PEER_TIMEOUT_MS, hold: (why) => hold(w, sid, b, mid, why) }
    if (b.in_reply_to !== undefined) return replyTo(ctx, text)
    if (!text) return refusalAnswer('bad_request', 'text must be a non-empty string')
    const to = str(b.to)
    if (!to) return refusalAnswer('bad_request', '`to` is required (or pass in_reply_to)')
    // This host holds nothing of a task the Mac keeps local (kept-local-calls.ts): its message waits for the Mac, by id.
    if (!online && await deps.keptLocal?.(to).catch(() => false)) return hold(w, sid, b, mid, 'its target is kept local on your Mac')
    // Before the session lookup: a completed parent usually has nothing running.
    const named = online ? undefined : (await deps.findTask(to)).task?.id
    const early = await parentComplete(me.taskId, named)
    if (early) return early
    const earlyLead = named ? await retired(me.taskId, named, b, text) : { text }
    if ('error' in earlyLead) return earlyLead.error
    const target = await resolveTarget(to, view, online)
    if ('error' in target) return target.error
    if ('elsewhere' in target) return online ? serverDelivers(`${target.elsewhere}; your Mac delivers it.`) : hold(w, sid, b, mid, target.elsewhere)
    if (online && target.sid === sid) return serverDelivers('the target is the calling session')
    const closed = await parentComplete(me.taskId, target.taskId)
    if (closed) return online ? serverDelivers('a complete parent is the Mac\'s to refuse') : closed
    // A COMPLETE target (and a forced reopen of one), and a lead that handed over, are the Mac's to decide online.
    if (online && target.taskId && ((await deps.task(target.taskId))?.phase === 'COMPLETE' || await deps.retiredLead(undefined, target.taskId))) {
      return serverDelivers('Your Mac decides a message to that task.')
    }
    const lead = await retired(me.taskId, target.taskId, b, text)
    if ('error' in lead) return lead.error
    if (target.sid === sid) return refusalAnswer('self_send', 'target resolves to the calling session itself')
    const admitted = await admitComplete(target.taskId, b, lead.text, 'send')
    if ('error' in admitted) return admitted.error
    // The server's default (send-rules.ts opensRequest): a session asking another wants the answer,
    // except a note up to its own leaders (a report); a note that asks nothing (wake false, not forced)
    // is delivered now, since this host cannot hold it quietly, and opens none (online such a note went
    // to the Mac above). The daemon's own away answer runs the same rule (offline-host-core.ts).
    const reportsUp = directionDecides(rules) && await deps.goesUp(me.taskId, target.taskId).catch(() => false)
    const asks = opensRequest(rules, reportsUp)
    // The Mac's deadline: by kind (a lead or Main answers for its teams), longer when the default asked.
    const kind = replyKindOf(target.taskId ? (await deps.task(target.taskId))?.org_role : undefined)
    const secs = clampReplyTimeoutSecs(typeof b.reply_timeout === 'number' ? b.reply_timeout : undefined, b.expect_reply === undefined, kind)
    const ask = asks ? { id: `rq-${hex(6)}`, preview: kit.requestPreview(text), secs } : undefined
    const envelope = kit.buildPeerWrapper(escapeSenderWords(admitted.text), {
      title: me.title, shortId: sid.slice(0, 8), sessionId: sid, ...(me.taskId ? { taskId: me.taskId } : {}),
      host: view.host, ...(ask ? { requestId: ask.id } : {}),
    }, { title: str(b.title) || undefined })
    const r = peerAnswer(await w.call('follower.peer', {
      kind: 'send', online, fromSessionId: sid, toSessionId: target.sid, ...(target.taskId ? { toTaskId: target.taskId } : {}),
      text: envelope, dupText: text, messageId: mid, ...(ask ? { ask } : {}),
    }, { timeoutMs: PEER_TIMEOUT_MS }))
    if (!r.ok) return r.answer
    deps.continued?.(target.sid)
    const requestId = typeof r.reply.requestId === 'string' ? r.reply.requestId : undefined
    const messageId = typeof r.reply.messageId === 'string' ? r.reply.messageId : mid
    deps.log('info', 'replica: a message to a session on this host was delivered', { from: sid, to: target.sid, requestId, messageId, online, opId: w.opId })
    return {
      answered: false, status: 202, body: {
        delivery: 'queued', via: 'host', host: view.host, ...(online ? {} : { offline: true }),
        targetSessionId: target.sid, targetTitle: target.title ?? null, ...(target.taskId ? { targetTaskId: target.taskId } : {}),
        target: { handle: kit.sessionHandle(target.title, target.sid), sessionId: target.sid, ...(target.taskId ? { taskId: target.taskId } : {}) },
        ...(requestId ? { requestId } : {}), messageId, ...(r.reply.duplicate === true ? { duplicate: true } : {}),
      },
    }
  }

  /** A plugin job's message (no session to answer it): a plain note to the task's session here, as before. */
  async function jobSend(req: Request, w: ReplicaWrite, actor: WriteActor): Promise<PortAnswer> {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}
    if (deps.leaderAnswers()) return needsLeaderAnswer('needs_mac', 'Your Mac answers again; the message goes to it.')
    const extra = Object.keys(b).filter((k) => !JOB_SEND_KEYS.has(k) && b[k] !== undefined)
    if (extra.length) return needsLeaderAnswer('message_needs_mac', `${extra.join(', ')} can only be used while your Mac answers; nothing was sent.`, { fields: extra })
    if (b.expect_reply === true) return needsLeaderAnswer('reply_needs_mac', 'Asking for a reply needs your Mac; nothing was sent.')
    const to = str(b.to)
    const text = [str(b.title), str(b.text)].filter(Boolean).join('\n\n')
    if (!to || !text) return refusalAnswer('bad_request', 'to and text must be non-empty strings')
    if (!(await deps.task(to))) return needsLeaderAnswer('target_needs_mac', 'This host does not know that task; sending to it needs your Mac.')
    const own = (await deps.sessionsOfTask(to)).filter((s) => !!deps.hostKey && str(s.host) === deps.hostKey)
    const s = [...own].sort((x, y) => str(y.startedAt).localeCompare(str(x.startedAt)))[0]
    if (!s) return needsLeaderAnswer('session_on_mac', 'That task has no session on this host; sending to it needs your Mac.')
    const a = await deps.port.send(w, s.sid, await deps.frame(text, actor), undefined, { framed: true })
    if (a.answered || a.status >= 300) return a
    deps.continued?.(s.sid)
    return { answered: false, status: 200, body: { ...a.body, taskId: to, targetTaskId: to, targetSessionId: s.sid } }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const w = req.replicaWrite
    if (!w || req.method.toUpperCase() !== 'POST' || req.path.replace(/\/+$/, '') !== '/v1/messages') { next(); return }
    const actor = deps.actorOf(req)
    const answer = (a: PortAnswer) => {
      if (a.answered || res.headersSent) return
      if (a.status === 503 || a.status === 429) {
        const retry = (a.body.error as { retryAfter?: unknown } | undefined)?.retryAfter
        if (typeof retry === 'number') res.setHeader('retry-after', String(retry))
      }
      res.status(a.status).json(a.body)
    }
    if (!actor || actor.kind === 'device') { answer(needsLeaderAnswer('needs_mac', 'This needs your Mac, which is not answering right now.')); return }
    const run = actor.kind === 'session' ? send(req, w, actor.sid) : jobSend(req, w, actor)
    run.then(answer, (err: unknown) => {
      deps.log('warn', 'replica: a message from this host failed here', { opId: w.opId, error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) answer(refusalAnswer('internal', 'This host could not do it.'))
    })
  }
}

/** The real dependencies on a host replica (server.ts mounts the handler before away.writes). */
export function wireAwaySends(o: {
  away: { port: WritePort; actorOf(req: Request): WriteActor | null; task(id: string): Promise<TaskRow | null>; overlay: Pick<Overlay, 'refresh' | 'task' | 'createdTaskIds'> }
  hostKey: string | null
  continued?: AwaySendsDeps['continued']
  capabilities(): readonly string[] | null
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
}): RequestHandler {
  const task = (id: string) => o.away.task(id)
  return awaySends({
    port: o.away.port,
    actorOf: (req) => o.away.actorOf(req),
    task,
    findTask: async (ref) => {
      const exact = await task(ref)
      if (exact) return { task: exact }
      if (ref.length < 4) return {}
      try {
        const found = await (await import('../core/task-manager.js')).getTask(ref)
        return { task: (await task(found.id)) ?? (found as unknown as TaskRow) }
      } catch (err) {
        return /Ambiguous ID prefix/.test(err instanceof Error ? err.message : String(err)) ? { ambiguous: true } : {}
      }
    },
    session: async (sid) => {
      const [{ getSessionByClaudeId }, { engineCaps }] = await Promise.all([import('../core/session-tracker.js'), import('../core/agents/engine-registry.js')])
      const rec = await getSessionByClaudeId(sid).catch(() => null)
      if (!rec) return null
      return { ...(rec.title ? { title: rec.title } : {}), ...(rec.taskId ? { taskId: rec.taskId } : {}), ...(engineCaps(rec.engine).runtimeKind === 'native' ? {} : { acp: true }) }
    },
    requestCopy: async (id) => ((await (await import('../core/session-requests.js')).getSessionRequest(id).catch(() => undefined)) ?? null) as Record<string, unknown> | null,
    // Over the tasks as this replica shows them: a task made on this host (only in its journal) is in the walk.
    goesUp: async (from, to) => {
      if (!from || !to || from === to) return false
      await o.away.overlay.refresh(500)
      const [{ goesUpIn }, { listTasks }] = await Promise.all([import('../core/sessions/reply-direction.js'), import('../core/task-manager.js')])
      return goesUpIn(tasksWithOverlay(await listTasks(), o.away.overlay), from, to)
    },
    retiredLead: async (callerTaskId, targetTaskId) => (await import('../core/org/retired-lead.js')).retiredLeadRefusal(callerTaskId, targetTaskId),
    hostKey: o.hostKey,
    capabilities: o.capabilities,
    request: o.request,
    leaderAnswers: () => leaderAnswers(),
    frame: (text, actor) => frameAsCaller(text, actor, task),
    sessionsOfTask: taskSessions,
    continued: (sid) => o.continued?.(sid),
    keptLocal: async (to) => {
      const { refreshLocalTasksHere, namesKeptLocal } = await import('../core/replication/kinds/local-tasks.js')
      return namesKeptLocal(to, await refreshLocalTasksHere())
    },
    log: (level, msg, data) => log.web[level](msg, data),
  })
}
