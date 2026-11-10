import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants())
import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { bus } from '../../src/core/event-bus.js'

describe('Auto permission refusals survive a reload', () => {
  afterEach(() => bus.clear())
  it('shows an actual classifier refusal immediately, without treating ordinary tool errors as refusals', async () => {
    const sid = 'auto-live-denial-session'
    await createSessionRecord(sid, 'auto-task', 'Test', '/work/repo', { mode: 'auto' })
    const session = new ClaudeCodeSession('auto-task', 'Test')
    const internal = session as unknown as { claudeSessionId: string; _mode: string; handleStreamLine: (line: string) => void }
    internal.claudeSessionId = sid; internal._mode = 'auto'
    const feed = (content: string) => internal.handleStreamLine(JSON.stringify({ type: 'user', session_id: sid,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content, is_error: true }] } }))
    feed('Command exited with code 1')
    feed('User denied permission')
    expect((await getSessionByClaudeId(sid))?.autoPermissionDenial).toBeUndefined()
    feed('Permission for this action was denied by the dangerous action safety classifier.')
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.autoPermissionDenial?.tools).toEqual(['a tool call']))
    session.detach()
  })
  it('does not blame generic denials on Auto, persists classifier evidence, then clears on a clean turn', async () => {
    const sid = 'auto-denial-session'
    await createSessionRecord(sid, 'auto-clear-task', 'Test', '/work/repo', { mode: 'auto' })
    const session = new ClaudeCodeSession('auto-clear-task', 'Test')
    const internal = session as unknown as { claudeSessionId: string; _mode: string; _isReplayedByOffset: () => boolean; handleStreamLine: (line: string) => void }
    internal.claudeSessionId = sid
    internal._mode = 'auto'
    internal._isReplayedByOffset = () => false
    const result = (denials: string[]) => internal.handleStreamLine(JSON.stringify({
      type: 'result', session_id: sid, subtype: 'success', result: 'Done', is_error: false,
      permission_denials: denials.map(tool_name => ({ tool_name, tool_use_id: tool_name, tool_input: {} })),
    }))
    result(['Bash'])
    expect((await getSessionByClaudeId(sid))?.autoPermissionDenial).toBeUndefined()
    internal.handleStreamLine(JSON.stringify({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 'd1', content: 'This action was blocked by the dangerous action safety classifier.', is_error: true }] } }))
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.autoPermissionDenial?.tools).toEqual(['a tool call']))
    result([])
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.autoPermissionDenial).toBeNull())
    session.detach()
  })
})
