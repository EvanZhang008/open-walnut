/**
 * The server twin of the taken-line marker (web/src/stream/chat-order.ts): where
 * Claude Code took a user line, kept in the live stream so a reload mid-turn
 * places each sent message where the model got it (2026-10-31).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js'

const SID = 'user-line-test-session'

describe('sessionStreamBuffer.appendUserLine', () => {
  beforeEach(() => { sessionStreamBuffer.clear(SID) })

  it('keeps the marker where the line was taken, once per uuid, and splits the text around it', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'written before the model saw it')
    sessionStreamBuffer.appendUserLine(SID, 'u1', ['qm-1'])
    sessionStreamBuffer.appendUserLine(SID, 'u1', ['qm-1'])
    sessionStreamBuffer.appendTextDelta(SID, 'its answer')
    const blocks = sessionStreamBuffer.getSnapshot(SID)!.blocks
    expect(blocks.map((b) => b.type)).toEqual(['text', 'user_line', 'text'])
    expect(blocks[1]).toEqual({ type: 'user_line', uuid: 'u1', rowIds: ['qm-1'] })
    expect((blocks[0] as { content: string }).content).toBe('written before the model saw it')
    expect((blocks[2] as { content: string }).content).toBe('its answer')
  })

  it('a line taken as a new turn opens that turn: the finished turn\'s blocks go first', () => {
    sessionStreamBuffer.markStreaming(SID)
    sessionStreamBuffer.appendTextDelta(SID, 'turn one')
    sessionStreamBuffer.markDone(SID)
    sessionStreamBuffer.appendUserLine(SID, 'u2')
    const blocks = sessionStreamBuffer.getSnapshot(SID)!.blocks
    expect(blocks).toEqual([{ type: 'user_line', uuid: 'u2' }])
  })
})
