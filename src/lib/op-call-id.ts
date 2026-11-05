/**
 * One id per op call, chosen by the CALLER before the call leaves its process, so an
 * answer that never comes back still leaves a way to learn what happened, and a retry
 * of the same call runs it at most once.
 *
 * 2026-11-04: `task_send` answered `hub_timeout: primary server timed out` while its
 * message had been delivered and answered. The caller could only resend (two copies)
 * or believe a delivered message was lost; in the same window other writes came back
 * with nothing to read them by. Every client (the `walnut` CLI on any host, its MCP
 * stdio server, the source daemon's small CLI, the Mac's own CLI) now mints a call id
 * for each `tools.call` and sends it beside the op's name (`callId`, outside `args`, so
 * an older server simply ignores it). The server keeps what each call did under it
 * (src/ops/op-calls.ts: in flight, its answer) and every write the call makes to the
 * server's own API carries an op id derived from it, which the applied-ops ledger
 * dedups across restarts (src/web/middleware/op-id.ts). `op_result` reads a call by
 * its id. A caller re-running a call whose answer was lost adds `"_call_id": "<id>"`
 * to the same arguments; clients and the server take that key out before the op's
 * arguments are checked.
 *
 * No Walnut imports: the CLI bundle and the daemon carry this file.
 */
import { randomUUID } from 'node:crypto'

/** The argument key a caller re-running a call puts its id in. Never an op's own argument. */
export const CALL_ID_ARG = '_call_id'

/**
 * `oc-` and 8 to 48 id characters: what every client mints and what the server accepts. Short
 * enough that a write's op id (writeOpId) carries the whole call id within the ledger's 80.
 */
export const CALL_ID_RE = /^oc-[A-Za-z0-9_-]{8,48}$/

export function newCallId(newId: () => string = randomUUID): string {
  return `oc-${newId().replace(/-/g, '')}`
}

export function isCallId(v: unknown): v is string {
  return typeof v === 'string' && CALL_ID_RE.test(v)
}

/**
 * Take a caller-given `_call_id` out of `args` (in place). Returns the id when it is
 * one, `bad` when the key held something else (the call is refused, nothing runs).
 */
export function takeCallIdArg(args: Record<string, unknown>): { callId: string | null; bad?: string } {
  if (!Object.hasOwn(args, CALL_ID_ARG)) return { callId: null }
  const given = args[CALL_ID_ARG]
  delete args[CALL_ID_ARG]
  if (isCallId(given)) return { callId: given }
  return { callId: null, bad: `${CALL_ID_ARG} must be a call id a Walnut client printed ("oc-" and 8 to 48 letters, digits, "-" or "_")` }
}

/**
 * The `_call_id` a JSON text names, found without parsing it (arguments too large to inline
 * travel as a file the server pulls, and take their `_call_id` from it): the client must name
 * the same call. Null when there is none; the raw string otherwise (check it with isCallId).
 * The source daemon's CLI has the same scan (daemon-source.ts wnCallIdInText).
 */
export function callIdInJsonText(text: string): string | null {
  const at = text.indexOf('"_call_id"')
  if (at === -1) return null
  let i = at + '"_call_id"'.length
  while (i < text.length && (text[i] === ' ' || text[i] === ':' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
  if (text[i] !== '"') return ''
  const end = text.indexOf('"', i + 1)
  return end === -1 ? '' : text.slice(i + 1, end)
}

/** The call's id: the caller's own `_call_id` (taken out of `args`), else a new one. */
export function callIdFor(args: Record<string, unknown>, newId?: () => string): { callId: string; bad?: string } {
  const taken = takeCallIdArg(args)
  if (taken.bad) return { callId: '', bad: taken.bad }
  return { callId: taken.callId ?? newCallId(newId) }
}

/**
 * The queued-message id a send made under `callId` goes as (`qm-host-…`, the form a host
 * daemon picks; offline-host-core.ts derives the same), so a retry of the same call is
 * written once by every queue that dedups by message id.
 */
export function messageIdOfCall(callId: string): string {
  return `qm-host-${callId.slice(3).split('_').join('-')}`
}

/** FNV-1a, 32 bits, hex: a short stable tag for a route. */
function routeTag(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The call id a host journal's record is replayed under (the offline handover's drains):
 * one per host, record and rev, so a drain that tries a record again after a lost answer
 * meets the first try's writes instead of applying them twice.
 */
export function journalCallId(hostKey: string, opId: string, rev = 1): string {
  const safe = opId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36)
  return `oc-j${routeTag(`${hostKey}\u0000${opId}\u0000${rev}`)}${safe}`
}

/**
 * The op id (`x-walnut-op-id`) of the `seq`-th write a call makes to `METHOD path`
 * (query left out). Keyed by route, so a retry whose handler reads changed state and
 * takes another branch never meets an id used for another route. The whole call id is in
 * it (writesOfCall finds the call's writes by it): at most 51 + 1 + 8 + 1 + digits.
 */
export function writeOpId(callId: string, method: string, pathWithQuery: string, seq: number): string {
  const route = `${method.toUpperCase()} ${pathWithQuery.split('?')[0]}`
  return `${callId}-${routeTag(route)}-${seq}`
}

/** Single-quoted for a POSIX shell. */
function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Arguments short enough to print again whole in the retry line. */
const RETRY_LINE_MAX = 600

/**
 * What a caller is told when a call's answer did not come back (`hub_timeout`, its own
 * timeout, a socket that broke after the call went): never silence, never a bare
 * timeout. The call may have run; how to read it, and how to run it again safely.
 */
export function lostCallLines(name: string, args: Record<string, unknown> | undefined, callId: string): string[] {
  const read = `walnut tools call op_result ${shellWord(JSON.stringify({ call_id: callId }))}`
  const again = args ? JSON.stringify({ ...args, [CALL_ID_ARG]: callId }) : ''
  return [
    `walnut: no answer came back for ${name} (call ${callId}). If it changes something, it may have run: do not run it again as a new call. Read what happened:`,
    `  ${read}`,
    again && again.length <= RETRY_LINE_MAX
      ? `walnut: to run it again safely, send the same call with its id; it runs at most once: walnut tools call ${name} ${shellWord(again)}`
      : `walnut: to run it again safely, add "${CALL_ID_ARG}":"${callId}" to the same arguments; it runs at most once.`,
  ]
}

/**
 * The same, as the JSON a caller reading only stdout gets (2026-11-04: a lost answer
 * printed nothing there, so `... | jq` saw an empty result).
 */
export function lostCallDetail(name: string, callId: string): Record<string, unknown> {
  return {
    call_id: callId,
    state: 'unknown',
    outcome: `No answer came back for ${name}. If it changes something, it may have run.`,
    next: `Read it: walnut tools call op_result '{"call_id":"${callId}"}'. Run it again only with "${CALL_ID_ARG}":"${callId}" in the same arguments, which runs it at most once.`,
  }
}
