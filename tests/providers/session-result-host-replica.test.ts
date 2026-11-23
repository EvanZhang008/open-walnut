/**
 * A turn's end on a host replica (the host's one Walnut service), where the pid probe is refused
 * (core/sessions/replica-process-guard.ts): the result handler of ClaudeCodeSession reads whether
 * the CLI still runs from its daemon's pipe, as for a remote daemon. Before 04f5a03ac1 every
 * turn's end there read as the process's end: the session went inactive and its pending prompts
 * were cleared, so a prompt answered right before the turn ended came back "not confirmed".
 * Review round 1 of land 5b, L5.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())
const k = vi.hoisted(() => ({ hostReplica: true }))
vi.mock('../../src/core/server-role.js', async (orig) => ({ ...(await orig<object>()), isHostReplica: () => k.hostReplica }))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const SID = 'host-replica-turn-end'
const line = (o: Record<string, unknown>) => JSON.stringify({ session_id: SID, ...o })

beforeEach(async () => {
  bus.clear()
  k.hostReplica = true
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})
afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

/** A session on its local daemon (not remote), its pipe up, mid-turn, with a prompt pending. */
function sessionMidTurn(): ClaudeCodeSession {
  const s = new ClaudeCodeSession('task-h', 'test-project')
  const inner = s as unknown as Record<string, unknown> & { _pendingPermissionRequests: Map<string, unknown> }
  inner._transport = { isRemote: false, hasPipe: true, processName: 'daemon', pid: null, outputFile: null, host: null, fileSize: 0, imageCache: new Map(), lastEventAt: 0, tailOffset: 0 }
  inner._active = true
  inner._processStatus = 'running'
  inner.pid = process.pid
  inner._pendingPermissionRequests.set('req-1', { request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })
  return s
}

function endTurn(s: ClaudeCodeSession): void {
  const h = s as unknown as { handleStreamLine(l: string): void }
  h.handleStreamLine(line({ type: 'system', subtype: 'init', cwd: '/tmp', model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default' }))
  h.handleStreamLine(line({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1, result: 'done', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }))
}

describe('a turn\'s end on a host replica', () => {
  it('keeps the session active and its pending prompt while the daemon says the pipe is up', () => {
    const s = sessionMidTurn()
    endTurn(s)
    expect(s.active).toBe(true)
    expect(s.processStatus).toBe('idle')
    expect((s as unknown as { _pendingPermissionRequests: Map<string, unknown> })._pendingPermissionRequests.has('req-1')).toBe(true)
  })

  it('reads a pipe the daemon closed as the process\'s end, as before', () => {
    const s = sessionMidTurn()
    ;((s as unknown as { _transport: { hasPipe: boolean } })._transport).hasPipe = false
    endTurn(s)
    expect(s.active).toBe(false)
  })
})
