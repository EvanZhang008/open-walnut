/**
 * The stream line a host fact is stamped with (ClaudeCodeSession.readOffset, read by host-emitter.ts
 * for the fact log's told line): a host-judged session's attach after a restart reads on from the
 * furthest stamped line, so a stamp past the line a fact came from loses what that line still owed.
 *
 *   - a fact emitted after an await of a line's handling carries that line, not a later one
 *   - while a result is withheld (background agents still running), the stamp stays below the
 *     result's line, whose outcome lives in memory only: a restart reads the result again
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'
import { removeTempTree } from '../helpers/temp-home.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const init = (sid: string) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, cwd: '/tmp', model: 'm', tools: [], mcp_servers: [], permissionMode: 'default' })
const text = (sid: string, t: string) => JSON.stringify({ type: 'assistant', session_id: sid, message: { id: `msg-${t}`, role: 'assistant', content: [{ type: 'text', text: t }], usage: { input_tokens: 1, output_tokens: 1 } } })
const result = (sid: string, t: string, isError = false) => JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, duration_ms: 5, num_turns: 1, result: t, session_id: sid, total_cost_usd: 0.01 })
const started = (sid: string, id: string) => JSON.stringify({ type: 'system', subtype: 'task_started', session_id: sid, task_id: id, task_type: 'local_agent', description: id })
const done = (sid: string, id: string) => JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: id, status: 'completed' })
const idle = (sid: string) => JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' })

function running(taskId: string): ClaudeCodeSession {
  const session = new ClaudeCodeSession(taskId, 'test-project')
  const transport = {
    isRemote: true, hasPipe: true, processName: 'claude', pid: null, outputFile: null, host: null, fileSize: 0,
    imageCache: new Map(), lastEventAt: 0, tailOffset: 0, writeMessage: async () => true,
    processInbound: (t: string) => t, renameForSession: () => {},
  }
  Object.assign(session as unknown as Record<string, unknown>, { _transport: transport, _active: true, _processStatus: 'running' })
  return session
}

/** Feed `lines` with their end offsets 100, 200, ... after `from`. */
function feed(session: ClaudeCodeSession, lines: string[], from = 0): number {
  const s = session as unknown as { handleStreamLine(line: string, v: number): void }
  let v = from
  for (const l of lines) { v += 100; s.handleStreamLine(l, v) }
  return v
}

beforeEach(async () => {
  bus.clear()
  await removeTempTree(WALNUT_HOME)
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})
afterEach(async () => {
  bus.clear()
  await new Promise((r) => setImmediate(r))
  await removeTempTree(WALNUT_HOME).catch(() => {})
})

describe('the line a host fact is stamped with', () => {
  it('a fact emitted after an await of a line\'s handling carries that line, though later lines were read meanwhile', async () => {
    const sid = 'stamp-async'
    const session = running('task-stamp-async')
    const stamps: Array<{ name: string; at: number }> = []
    bus.subscribe('stamp-async', (e) => {
      if (e.name !== EventNames.SESSION_RESULT) return
      // A listener that answers later (as an await in the handling would): the line it came from still holds.
      void Promise.resolve().then(() => stamps.push({ name: 'later', at: session.readOffset }))
      stamps.push({ name: 'now', at: session.readOffset })
    }, { global: true })
    feed(session, [init(sid), text(sid, 'a'), result(sid, 'done'), idle(sid), text(sid, 'next')])
    await new Promise((r) => setImmediate(r))
    expect(session.readOffset, 'outside any line: the furthest line read').toBe(500)
    expect(stamps).toEqual([{ name: 'now', at: 300 }, { name: 'later', at: 300 }])
  })

  it('stays below a withheld result\'s line until its turn ends, then moves on', () => {
    const sid = 'stamp-held'
    const session = running('task-stamp-held')
    const results: Array<Record<string, unknown>> = []
    bus.subscribe('stamp-held', (e) => { if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>) }, { global: true })
    // 100 init, 200 agent started, 300 the turn's own result (an error), withheld while the agent runs.
    feed(session, [init(sid), started(sid, 'agent-a'), result(sid, 'rate limit', true)])
    expect(results).toEqual([])
    expect(session.readOffset, 'the result line starts at 200').toBe(200)
    // The agent's lines are read and say facts; the stamp still does not pass the held result.
    feed(session, [text(sid, 'agent works')], 300)
    expect(session.readOffset).toBe(200)
    // The agent ends and the drain idle completes the turn with the held outcome: the stamp moves on.
    feed(session, [done(sid, 'agent-a'), idle(sid)], 400)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(session.readOffset).toBe(600)
  })
})
