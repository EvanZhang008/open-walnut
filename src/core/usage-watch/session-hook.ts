/**
 * What a session's own tool results tell the real-use monitor:
 *  - a Walnut tool's answer Claude Code saved to a file instead of passing on (its own note,
 *    `exceeds maximum allowed tokens` or `Output too large`): a confirmed cut of that op;
 *  - a Walnut tool call that failed (is_error): its session, task, host, op and error code, on
 *    every host, whether Walnut, its client or Claude Code refused it (tool-errors.ts reads them);
 *  - a command that lands, deploys or publishes (ships.ts): the task shipped, unless the result
 *    shows the command failed.
 * Matched by the tool call's id, so a result is judged with the call that made it.
 */
import { log } from '../../logging/index.js'
import type { OnToolResultPayload, OnToolUsePayload, SessionHookDefinition } from '../session-hooks/types.js'
import { agentCutChars, cliFailureCode, toolErrorCode, walnutToolCall } from './normalize.js'
import { recordConfirmedCut, recordToolError } from './record.js'
import { recordShip, setShipState, shipFailed, shipOfCommand } from './ships.js'

const PENDING_MS = 3 * 60 * 60_000
const MAX_PENDING = 500

interface Pending { at: number; op?: string; client?: 'mcp' | 'cli'; answered?: boolean; ship?: string }
const pending = new Map<string, Pending>()

function remember(id: string, p: Pending): void {
  for (const [key, entry] of pending) if (p.at - entry.at > PENDING_MS) pending.delete(key)
  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
  pending.set(id, p)
}

export const realUseHook: SessionHookDefinition = {
  id: 'real-use-watch',
  name: 'Count real use of the session\'s tools',
  description: 'Counts a Walnut tool answer Claude Code had to save to a file and every failed Walnut tool call by session and error code, and notes when the task ships a change (a land, deploy or publish), for Settings › Diagnostics › Real Use.',
  hooks: ['onToolUse', 'onToolResult'],
  priority: 61,
  source: 'builtin',
  enabled: true,
  timeoutMs: 5_000,
  handler: async (payload) => {
    if ('toolName' in payload) {
      const use = payload as OnToolUsePayload
      if (!use.toolUseId) return
      const call = walnutToolCall(use.toolName, use.input)
      const op = call?.op
      const command = use.toolName === 'Bash' && typeof use.input?.command === 'string' ? use.input.command : ''
      const ship = command ? shipOfCommand(command) : null
      if (!op && !ship) return
      const now = Date.now()
      remember(use.toolUseId, { at: now, ...(op ? { op, client: use.toolName === 'Bash' ? 'cli' : 'mcp', answered: call!.answered } : {}), ...(ship ? { ship } : {}) })
      if (ship && use.taskId) {
        recordShip({ taskId: use.taskId, key: use.toolUseId, at: now, how: ship, state: 'started' })
        log.task.info('real use: the task ships', { taskId: use.taskId, how: ship })
      }
      return
    }
    const res = payload as OnToolResultPayload
    const run = res.toolUseId ? pending.get(res.toolUseId) : undefined
    if (!run) return
    pending.delete(res.toolUseId!)
    const text = typeof res.result === 'string' ? res.result : ''
    if (run.op) {
      // A cut counts for the op only when what was cut was its answer as the op sized it: not a
      // whole answer the caller asked for (`_full`), nor output of the program it was piped or
      // written into (normalize.ts walnutToolCall).
      const cut = agentCutChars(text)
      if (cut !== null) { if (run.answered !== false) recordConfirmedCut(run.op, cut, run.client ?? 'unknown') }
      // Every failed Walnut call the agent read, by session, host, op and code (never its words).
      else if (!res.replayed && (res.isError || (run.client === 'cli' && cliFailureCode(text) !== null))) {
        const code = res.isError ? toolErrorCode(text) : cliFailureCode(text)!
        // A shell line that failed after the walnut call in it (a pipe into python, a grep) says
        // nothing of Walnut's: only a failure Walnut or the CLI wrote counts for a command.
        if (run.client !== 'cli' || code !== 'other') {
          recordToolError({
            sid: res.sessionId, ...(res.taskId ? { taskId: res.taskId } : {}), host: res.session?.host || 'local',
            op: run.op, client: run.client ?? 'unknown', code,
          })
        }
      }
    }
    if (run.ship && res.taskId) setShipState(res.taskId, res.toolUseId!, shipFailed(text) ? 'failed' : 'done')
  },
}

export function _resetRealUseHookForTesting(): void {
  pending.clear()
}
