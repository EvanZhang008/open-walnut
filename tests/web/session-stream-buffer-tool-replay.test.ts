/**
 * One block per tool call in the server's stream buffer: the same toolUseId again (a host that
 * read its CLI's output again after a re-attach, a reconnect replay; 2026-11-25: 119 at once) is
 * the call the buffer holds. Its status and result stay, it fills only what the first event
 * lacked, and it is no new turn data (a finished turn's blocks are not dropped for it).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'

const SID = 'tool-replay-session'

describe('sessionStreamBuffer tool call replay', () => {
  beforeEach(() => sessionStreamBuffer.clear(SID))

  it('keeps one block, its status and result, for a tool call said again', () => {
    sessionStreamBuffer.appendTextDelta(SID, 'Looking')
    sessionStreamBuffer.appendToolUse(SID, 'tu-1', 'Bash', { command: 'ls' })
    sessionStreamBuffer.appendToolResult(SID, 'tu-1', 'a.txt')
    sessionStreamBuffer.appendToolUse(SID, 'tu-1', 'Bash', { command: 'ls' }, undefined, undefined, undefined, undefined, 'msg_1')
    sessionStreamBuffer.appendToolResult(SID, 'tu-1', 'a.txt')
    const blocks = sessionStreamBuffer.getSnapshot(SID).blocks
    expect(blocks.filter((b) => b.type === 'tool_call')).toHaveLength(1)
    expect(blocks[1]).toMatchObject({ type: 'tool_call', toolUseId: 'tu-1', status: 'done', result: 'a.txt', msgId: 'msg_1' })
    expect(blocks).toHaveLength(2)
  })

  it('a replayed call of a finished turn does not drop that turn for a new one', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendToolUse(SID, 'tu-1', 'Read', { file: 'x.ts' })
    sessionStreamBuffer.appendToolResult(SID, 'tu-1', 'ok')
    sessionStreamBuffer.markDone(SID)
    sessionStreamBuffer.appendToolUse(SID, 'tu-1', 'Read', { file: 'x.ts' })
    const snap = sessionStreamBuffer.getSnapshot(SID)
    expect(snap.blocks).toHaveLength(1)
    expect(snap.blocks[0]).toMatchObject({ status: 'done', result: 'ok' })
    expect(snap.completedLen).toBe(1)
  })
})
