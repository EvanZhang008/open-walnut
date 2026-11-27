/**
 * A trigger check's `walnut tools call` that Walnut refused as written, told to the daemon that runs
 * the check, which relays it as the check's own (`triggerCaller`), so the task that wrote the check
 * hears it (core/routines/check-call-refused.ts).
 *
 * The daemon vouches which trigger a call came from only for what reaches it. A call it relays is
 * judged where it is answered (core/peers/capability-router.ts). Two kinds never reach it:
 *   - a call the client itself refused before sending anything (bad JSON, a usage error), in the
 *     gateway shim (wn-cli.ts) and in the full CLI (commands/tools.ts);
 *   - the full CLI's own call (the Mac's `walnut`, an npm install), which runs the op in its own
 *     process and reaches the API over HTTP, where the call is nobody's (2026-11-27: only the
 *     task-only host ops went through the daemon, so a check's refused task_list was heard by no one).
 * For those the client sends this one line. Shared by both clients, so it imports nothing of core.
 */
import net from 'node:net'
import { newCallId } from '../lib/op-call-id.js'
import { PROGRAM_CLIENT } from '../lib/tool-answer-size.js'
import { toolsCallLine } from './gateway-request.js'

/**
 * The op a check's own `walnut` sends its daemon when Walnut refused one of its calls as written:
 * `{op, message}`. The daemon relays it like any call of the check (with its triggerCaller), and the
 * server answers it itself (capability-router.ts), never as an op. An older server refuses an op it
 * does not know, which the client ignores.
 */
export const CHECK_CALL_REFUSED_OP = 'trigger_check_call_refused'

/**
 * A `tools call` client's own refusals of a call as written: nothing was sent, and the same call
 * is refused again on every run. Every other code a client prints is no refusal of the script
 * (no daemon, a lost answer, an empty body) or was answered by a server that already judged it.
 * Pinned against both clients' sources (tests/core/routines/check-call-refused-clients.test.ts).
 */
export const CLIENT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'usage_error', 'unknown_op', 'args_file', 'invalid_json', 'shell_cut_text', 'invalid_call_id',
])

/**
 * The API's 403 codes that refuse a caller for what it is, the same at every run: only a person, or
 * only the user at that computer, may do it (a script never is one), or only on its own host.
 */
export const PERMANENT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'local_only', 'human_only', 'person_at_this_machine', 'owner_only', 'mode_above_caller',
])

/**
 * An op's answer (ops/executor.ts OpOutcome) that refused the call as written, so it never ran and
 * never will as it is: arguments the op refused (an unknown op, an unknown key, a wrong type, words
 * its send gate holds back), the API's 400, 413 or 422, or a 403 that refuses what the caller is
 * (PERMANENT_REFUSAL_CODES). A designed answer (404, 409, a grant still asked) and a machine fault
 * are not: a check may wait through those.
 */
export function refusedAsWritten(r: { ok: boolean; invalidArgs?: boolean; status?: number; code?: string }): boolean {
  if (r.ok) return false
  if (r.invalidArgs === true || r.status === 400 || r.status === 413 || r.status === 422) return true
  return r.status === 403 && typeof r.code === 'string' && PERMANENT_REFUSAL_CODES.has(r.code)
}

/** How long a check's `walnut` waits for its daemon to take a report. */
export const CHECK_REPORT_WAIT_MS = 2_000

/** The refusal as sent: its head (a refusal names its fix first). The server clips it again. */
const MESSAGE_MAX = 1_000
const OP_MAX = 80

/**
 * One line to the daemon that runs this check (WALNUT_CHECK_TOKEN, WALNUT_CHECK_SOCKET), waiting
 * at most CHECK_REPORT_WAIT_MS for its answer. Outside a check, and inside a session (its own id
 * always wins), nothing. Never throws.
 */
export async function tellCheckDaemon(name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const sid = (env.WALNUT_CHECK_TOKEN ?? '').trim()
  const socket = (env.WALNUT_CHECK_SOCKET ?? '').trim()
  if (!sid || !socket || (env.WALNUT_SESSION_ID ?? '').trim()) return
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { conn.destroy() } catch { /* gone */ } resolve() }
    const timer = setTimeout(finish, CHECK_REPORT_WAIT_MS)
    timer.unref?.()
    const conn = net.connect(socket)
    // Waits for no server: a report is never queued for one that is away.
    conn.on('connect', () => conn.write(JSON.stringify(toolsCallLine(sid, { name, args, callId: newCallId(), client: PROGRAM_CLIENT }, 'none').req) + '\n'))
    conn.on('data', finish)
    conn.on('error', finish)
    conn.on('close', finish)
  })
}

/** Tell the check's daemon that Walnut refused this call of `op` as written, with Walnut's words. */
export function reportRefusedCheckCall(op: string, message: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const name = op.trim().substring(0, OP_MAX) || '(no op named)'
  return tellCheckDaemon(CHECK_CALL_REFUSED_OP, { op: name, message: message.trim().substring(0, MESSAGE_MAX) }, env)
}
