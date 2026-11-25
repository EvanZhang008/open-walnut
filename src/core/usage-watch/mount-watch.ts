/**
 * A session whose Walnut MCP server went away has none of its Walnut tools: counted for the
 * real-use monitor as a failed `tools/list` of that session with code `tools_gone`.
 *
 * 2026-11-25 audit: a session (Main) resumed with "119 deferred tools are no longer available (MCP
 * server disconnected)" and no row said so; it had dropped to none twice before. The MCP server
 * cannot tell of its own end, and the short-list report (gateway-record.ts recordShortToolList) comes
 * only from a server that is still there to see its whole list. So the session runner asks Claude
 * Code at a turn end (`mcp_status`, claude-code-session.ts checkWalnutMountHere: a new process at its
 * first, then at most every TURN_END_MOUNT_GAP_MS) and this judges the answer: the mount is gone
 * when Claude Code lists it failed, absent, or connected with no tool, or still pending at the next
 * ask of the same process (turns ran without it). One row per drop: the
 * mount must be seen connected again (or a new process start) before another counts, and a runner
 * that knows nothing yet (a server restart re-attached it) takes a row of the last few hours for the
 * drop it sees.
 *
 * A role's own shorter list (experiment mcp_tools_by_role, about 84 tools for a worker) is no drop:
 * it is that session's whole list.
 */
import { log } from '../../logging/index.js'
import { SHORT_LIST_OP } from './gateway-record.js'
import { recordToolError } from './record.js'
import { readToolErrors } from './store.js'

export const TOOLS_GONE_CODE = 'tools_gone'

/** What one session runner last saw of its process's Walnut mount. */
export interface MountSeen {
  pid: number
  /** Seen pending at a turn end, with no connected answer since. */
  pending?: boolean
  /** A drop is counted, and no other counts until the mount is seen connected again. */
  told?: boolean
}

/** A drop already in the store for this long stands for the same one after a server restart. */
const TOLD_KEEP_MS = 6 * 3_600_000

/**
 * The status Claude Code's `mcp_status` answer gives the walnut server: `{ mcpServers: [{ name,
 * status, tools? }] }`. Null when the answer names no list (an older CLI, a timeout): nothing judged.
 */
export function walnutMountStatus(reply: unknown): { status: string; tools?: number } | null {
  const list = (reply as { mcpServers?: unknown } | null)?.mcpServers
  if (!Array.isArray(list)) return null
  const row = list.find((s) => (s as { name?: unknown } | null)?.name === 'walnut') as { status?: unknown; tools?: unknown } | undefined
  if (!row) return { status: 'absent' }
  const status = typeof row.status === 'string' ? row.status : 'unknown'
  return Array.isArray(row.tools) ? { status, tools: row.tools.length } : { status }
}

/** Judge one turn end's answer: what to remember, and the reason to count a drop (only once per drop). */
export function judgeWalnutMount(prev: MountSeen | undefined, pid: number, reply: unknown): { seen: MountSeen; gone?: string } {
  const was: MountSeen = prev && prev.pid === pid ? prev : { pid }
  const m = walnutMountStatus(reply)
  if (!m) return { seen: was }
  // Turned off on purpose: no fault and no tool missing.
  if (m.status === 'disabled') return { seen: { pid } }
  if (m.status === 'connected' && m.tools !== 0) return { seen: { pid } }
  if (m.status === 'pending' && !was.pending) return { seen: { ...was, pending: true } }
  const why = m.status === 'connected' ? 'no_tools' : m.status
  if (was.told) return { seen: was }
  return { seen: { pid, told: true }, gone: why }
}

/**
 * Count a drop. `fresh`: the runner had seen nothing of this process before (a server restart
 * re-attached it), so a row of the last hours already stands for it: false then.
 */
export function recordToolsGone(input: { sid: string; taskId?: string | null; host?: string | null; why: string; fresh?: boolean }, now = Date.now()): boolean {
  const where = !input.host || input.host === '__local__' ? 'local' : input.host
  try {
    const before = input.fresh === true && readToolErrors({ since: now - TOLD_KEEP_MS, session: input.sid })
      .some((r) => r.sid === input.sid && r.code === TOOLS_GONE_CODE)
    if (before) return false
    recordToolError({ at: now, sid: input.sid, ...(input.taskId ? { taskId: input.taskId } : {}), host: where, op: SHORT_LIST_OP, client: 'mcp', code: TOOLS_GONE_CODE })
    log.session.warn('real use: a session has none of its Walnut MCP tools', { sessionId: input.sid, ...(input.taskId ? { taskId: input.taskId } : {}), host: where, why: input.why })
    return true
  } catch { return false }
}
