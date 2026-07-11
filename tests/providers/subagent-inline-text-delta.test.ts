/**
 * Inline-subagent text threading (inc-1783547185298 — "output completely broken").
 *
 * New CLI builds interleave the subagent's whole conversation into the MAIN
 * session's stream-json output, tagged with parent_tool_use_id. The assistant
 * branch must:
 *   1. stamp SESSION_TEXT_DELTA with parentToolUseId for those lines
 *   2. keep subagent text OUT of fullText (the turn's result fallback)
 *   3. keep main-conversation lines untagged (parentToolUseId absent)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const SID = 'subagent-inline-session'
const PARENT = 'toolu_parent_agent'

function makeInit(sessionId: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'init', session_id: sessionId,
    cwd: '/tmp', model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default',
  })
}

function makeAssistant(sessionId: string, msgId: string, text: string, parentToolUseId?: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: msgId, type: 'message', role: 'assistant', model: 'mock-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
    },
    session_id: sessionId,
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId, subagent_type: 'explore', task_description: 'dig' } : {}),
  })
}

function feedLines(session: ClaudeCodeSession, lines: string[]): void {
  const handle = session as unknown as { handleStreamLine(line: string): void }
  for (const line of lines) handle.handleStreamLine(line)
}

beforeEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await new Promise(r => setTimeout(r, 100))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('inline-subagent text-delta threading', () => {
  it('stamps parentToolUseId on subagent text and leaves main text untagged', async () => {
    const session = new ClaudeCodeSession('task-sub', 'proj', 'claude')
    const deltas: Array<{ delta: string; parentToolUseId?: string; msgId?: string }> = []
    // Deltas are emitted with destination ['main-ai'] — subscribe under that name.
    bus.subscribe('main-ai', (event: BusEvent) => {
      if (event.name === EventNames.SESSION_TEXT_DELTA) {
        deltas.push(event.data as { delta: string; parentToolUseId?: string; msgId?: string })
      }
    })

    feedLines(session, [
      makeInit(SID),
      makeAssistant(SID, 'msg_main', '主对话中文回答'),
      makeAssistant(SID, 'msg_sub', 'Now I have the two distinct enums.', PARENT),
      makeAssistant(SID, 'msg_main2', '主对话继续'),
    ])
    await new Promise(r => setTimeout(r, 50))

    expect(deltas).toHaveLength(3)
    expect(deltas[0]).toMatchObject({ delta: '主对话中文回答' })
    expect(deltas[0].parentToolUseId).toBeUndefined()
    expect(deltas[1]).toMatchObject({ delta: 'Now I have the two distinct enums.', parentToolUseId: PARENT })
    expect(deltas[2]).toMatchObject({ delta: '主对话继续' })
    expect(deltas[2].parentToolUseId).toBeUndefined()
  })

  it('keeps subagent text out of fullText (result fallback)', async () => {
    const session = new ClaudeCodeSession('task-sub2', 'proj', 'claude')
    feedLines(session, [
      makeInit(SID + '-2'),
      makeAssistant(SID + '-2', 'msg_main', 'main only'),
      makeAssistant(SID + '-2', 'msg_sub', 'SUBAGENT LEAK', PARENT),
    ])
    await new Promise(r => setTimeout(r, 50))
    const fullText = (session as unknown as { fullText: string }).fullText
    expect(fullText).toContain('main only')
    expect(fullText).not.toContain('SUBAGENT LEAK')
  })
})
