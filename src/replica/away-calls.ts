/**
 * The rest of this host's own `walnut` calls the follower answers while the Mac is away
 * (the `host-local-calls` capability; local-calls.ts runs the calls; task B). Only those
 * callers reach here: the route table answers a phone or a browser on these routes as before
 * (route-table.ts `localAway`). Each is decided here, with this replica's copies and the Mac's
 * own rules, then journaled by the daemon through `follower.op` as the very record its own away
 * answer writes (offline-host-core.ts followerCall), so the Mac's drain is unchanged:
 *
 *   PUT /v1/tasks/:id/agent-memory        agent_memory_write: an append (`agent-memory`); a
 *                                         replace needs the Mac (this host does not hold the
 *                                         file it would replace)
 *   PUT /v1/tasks/:id/memory-files/:name  agent_memory_write file: held for its op (`op`, held-op),
 *                                         replayed by the Mac under the call's own id
 *   POST /v1/human-inbox                  human_inbox_send: the letter's checks (letter-check.ts),
 *                                         then a `letter` record with its body as a blob
 *
 * The triggers' calls are away-triggers.ts. An answer the daemon gave carries its own `outcome`
 * and `next`, which the op passes through (ops/outcome.ts awayAnswer).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ReplicaWrite } from './dispatch.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer, type TaskRow, type WriteActor } from './write-port.js'
import { isCallId, writeOpId } from '../lib/op-call-id.js'
import { log } from '../logging/index.js'

/** A task id as Walnut mints them: one this replica's copy lacks is checked by the Mac at replay (as the daemon takes it). */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/
/** The largest letter taken here: a bigger one rides in a file the daemon never reads back (its own limit). */
export const AWAY_LETTER_MAX_BYTES = 1024 * 1024

export interface AwayCallsDeps {
  actorOf(req: Request): WriteActor | null
  /** A task by id or unique prefix as this replica shows it (copy plus overlay); null: none. Throws on an ambiguous prefix. */
  findTask(ref: string): Promise<TaskRow | null>
  /** The letter checks the op and the store run (core/human-inbox/letter-check.ts). */
  letters: { opArgs(args: Record<string, unknown>): string | null; shape(args: Record<string, unknown>): { ok: true } | { ok: false; message: string } }
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

/**
 * The call id a self-call's write carries in its op id (ops/executor.ts: `writeOpId(callId,
 * method, path, seq)`), when this write is its call's first to that route; '' when it has none.
 */
export function callIdOfWrite(opId: string, method: string, opPath: string): string {
  const m = /^(oc-[A-Za-z0-9_-]+)-[0-9a-f]{8}-0$/.exec(opId)
  if (!m || !isCallId(m[1])) return ''
  return writeOpId(m[1]!, method, opPath, 0) === opId ? m[1]! : ''
}

/** The daemon's answer as the route's: its body for the op to pass on, its refusal in the route's shape. */
export function settleCall(r: Awaited<ReturnType<ReplicaWrite['submit']>>, status: number): PortAnswer {
  if (r.kind === 'answered') return { answered: true }
  if (r.kind === 'refused') return refusalAnswer(r.code, r.message, r.detail, r.retryAfterMs)
  const { appendMs: _ms, appendCpuMs: _cpu, ...body } = r.reply
  return { answered: false, status, body }
}

/** A task the call names: the row, or the refusal. `null` row: not in this copy (`ref` kept as given). */
async function taskNamed(deps: AwayCallsDeps, ref: string): Promise<{ row: TaskRow | null } | { error: PortAnswer }> {
  try {
    return { row: await deps.findTask(ref) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/ambiguous/i.test(msg)) return { error: refusalAnswer('bad_request', msg) }
    return { row: null }
  }
}

function pathId(raw: string): string {
  try { return decodeURIComponent(raw) } catch { return raw }
}

/** The answer written as the route's (a 503 or 429 says when to come back). */
export function writeAnswer(res: Response, a: PortAnswer): void {
  if (a.answered || res.headersSent) return
  if (a.status === 503 || a.status === 429) {
    const retry = (a.body.error as { retryAfter?: unknown } | undefined)?.retryAfter
    if (typeof retry === 'number') res.setHeader('retry-after', String(retry))
  }
  res.status(a.status).json(a.body)
}

export function awayCalls(deps: AwayCallsDeps): RequestHandler {
  async function memory(req: Request, w: ReplicaWrite, actor: WriteActor, ref: string, file: string | null): Promise<PortAnswer> {
    const b = bodyOf(req)
    if (typeof b.content !== 'string') return refusalAnswer('bad_request', 'content (string) is required')
    if (!file && b.mode === 'replace') {
      return needsLeaderAnswer('agent-memory-replace', 'A replace of MEMORY.md can only be made while your Mac answers (this host does not hold the file it would replace); nothing was saved. An append is saved here.')
    }
    // A memory folder note is held for its op, which only a session's call can be (holdWrite).
    if (file && actor.kind !== 'session') return needsLeaderAnswer('memory_file_changes_need_mac', 'A memory folder note from a plugin job needs your Mac; nothing was saved.')
    // The leader's own checks of the note first (memory-folder.ts checkOwnNote): a note it would
    // refuse is never held. Its count of notes needs the folder, which only the Mac has.
    if (file) {
      const { checkOwnNote, MemoryFolderError, SHARED_FOLDER } = await import('../core/sessions/memory-folder.js')
      try {
        checkOwnNote(ref === SHARED_FOLDER ? null : ref, file, b.content)
      } catch (err) {
        if (err instanceof MemoryFolderError) return { ...refusalAnswer(err.code, err.message), status: err.status } as PortAnswer
        throw err
      }
    }
    const named = await taskNamed(deps, ref)
    if ('error' in named) return named.error
    const task = named.row
    // MEMORY.md of a complete task is kept as it was (agent-memory-v1.ts); its folder notes are not (the leader writes them).
    if (!file && task && task.phase === 'COMPLETE') {
      return refusalAnswer('task_complete', `"${String(task.title ?? task.id)}" is complete: its MEMORY.md is kept as it was. Reopen the task to change it.`)
    }
    // Not in this copy: an id is taken as it is (the Mac checks it at replay); any other name is
    // held for the op, which resolves it at the Mac, as the daemon holds it.
    const taskId = task ? task.id : TASK_ID_RE.test(ref) ? ref : ''
    const opPath = file
      ? `/tasks/${encodeURIComponent(ref)}/memory-files/${encodeURIComponent(file)}`
      : `/tasks/${encodeURIComponent(ref)}/agent-memory`
    const callId = callIdOfWrite(w.opId, 'PUT', opPath)
    const args: Record<string, unknown> = {
      task: taskId || ref, content: b.content, ...(file ? { file } : {}), ...(!taskId ? { held: true } : {}), ...(callId ? { callId } : {}),
    }
    const r = await w.submit('agent_memory_write', args, undefined, actor)
    const a = settleCall(r, 200)
    if (!a.answered && a.status === 200) deps.log('info', 'replica: a MEMORY.md write was saved on this host while the Mac is away', { taskId: taskId || ref, file: file ?? undefined, opId: w.opId })
    return a
  }

  async function letter(req: Request, w: ReplicaWrite, actor: WriteActor): Promise<PortAnswer> {
    const b = bodyOf(req)
    if (w.raw.length > AWAY_LETTER_MAX_BYTES) {
      return needsLeaderAnswer('needs_mac', `A letter over ${AWAY_LETTER_MAX_BYTES} bytes needs your Mac; a smaller one is saved on this host. Nothing was sent.`)
    }
    // The op's and the store's own checks (letter-check.ts): a letter the Mac would refuse is never kept.
    const badArgs = deps.letters.opArgs(b)
    if (badArgs) return refusalAnswer('bad_request', badArgs)
    const shaped = deps.letters.shape(b)
    if (!shaped.ok) return refusalAnswer('bad_request', shaped.message)
    const r = await w.submit('human_inbox_send', b, undefined, actor)
    const a = settleCall(r, 201)
    if (!a.answered && a.status === 201) deps.log('info', 'replica: a letter was saved on this host while the Mac is away', { letterId: a.body.letterId, opId: w.opId })
    return a
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const w = req.replicaWrite
    if (!w) { next(); return }
    const method = req.method.toUpperCase()
    const path = req.path.replace(/\/+$/, '')
    const mem = method === 'PUT' ? /^\/v1\/tasks\/([^/]+)\/(?:agent-memory|memory-files\/([^/]+))$/.exec(path) : null
    const isLetter = method === 'POST' && path === '/v1/human-inbox'
    if (!mem && !isLetter) { next(); return }
    const actor = deps.actorOf(req)
    if (!actor || actor.kind === 'device') { writeAnswer(res, needsLeaderAnswer('needs_mac', 'This needs your Mac, which is not answering right now.')); return }
    const run = mem ? memory(req, w, actor, pathId(mem[1]!), mem[2] !== undefined ? pathId(mem[2]) : null) : letter(req, w, actor)
    run.then((a) => writeAnswer(res, a), (err: unknown) => {
      deps.log('warn', 'replica: a local call failed here', { path, opId: w.opId, error: err instanceof Error ? err.message : String(err) })
      writeAnswer(res, refusalAnswer('internal', 'This host could not do it.'))
    })
  }
}

/** The real dependencies on a host replica (server.ts mounts it beside away-starts.ts). */
export async function wireAwayCalls(o: { away: { actorOf(req: Request): WriteActor | null; task(id: string): Promise<TaskRow | null> } }): Promise<RequestHandler> {
  const { createLetterCheck } = await import('../core/human-inbox/letter-check.js')
  const check = createLetterCheck()
  return awayCalls({
    actorOf: (req) => o.away.actorOf(req),
    findTask: (ref) => findAwayTask(o.away, ref),
    letters: { opArgs: (args) => check.opArgs(args), shape: (args) => check.shape(args) },
    log: (level, msg, data) => log.web[level](msg, data),
  })
}

/** A task by exact id (copy plus overlay: one made here too), else by a unique prefix of the copy. */
export async function findAwayTask(away: { task(id: string): Promise<TaskRow | null> }, ref: string): Promise<TaskRow | null> {
  const exact = await away.task(ref)
  if (exact) return exact
  const { getTask } = await import('../core/task-manager.js')
  let found: { id: string } | null = null
  try {
    found = await getTask(ref) as unknown as { id: string }
  } catch (err) {
    if (/ambiguous/i.test(err instanceof Error ? err.message : String(err))) throw err
    return null
  }
  return found ? await away.task(found.id) ?? (found as unknown as TaskRow) : null
}
