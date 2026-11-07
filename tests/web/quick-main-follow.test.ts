import { describe, expect, it, vi } from 'vitest'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { followMainReply, MID_TURN_NEXT_MS, type FollowLine } from '../../src/web/routes/quick-main-follow.js'

const SID = '11111111-2222-3333-4444-555555555555'
const tick = () => new Promise((r) => setTimeout(r, 5))
const emit = (name: string, data: Record<string, unknown>) => bus.emit(name, { sessionId: SID, ...data }, [])

function follow() {
  const lines: FollowLine[] = []
  let ended = false
  const follower = followMainReply((l) => lines.push(l), () => { ended = true })
  return { lines, follower, ended: () => ended }
}

describe('quick input: Main reply follow', () => {
  it('reads only the turn that took the message, not the one running before it', async () => {
    const f = follow()
    f.follower.bind(SID, { messageId: 'qm-mine' })
    // The turn already running when the message was queued: not the reply.
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'brief refresh words' })
    emit(EventNames.SESSION_RESULT, { result: 'brief refresh words', turnGen: 4 })
    // Another message's delivery is not ours.
    emit(EventNames.SESSION_MESSAGES_DELIVERED, { count: 1, messageIds: ['qm-other'], turnGen: 5 })
    emit(EventNames.SESSION_MESSAGES_DELIVERED, { count: 1, messageIds: ['qm-mine'], turnGen: 5 })
    emit(EventNames.SESSION_TOOL_USE, { toolName: 'Bash', toolUseId: 't1', input: { command: 'ls', description: 'List files' } })
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'subagent words', parentToolUseId: 't1' })
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'MAN' })
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'GO' })
    // A late result of the earlier turn arriving after the delivery is still not ours.
    emit(EventNames.SESSION_RESULT, { result: 'late', turnGen: 4 })
    expect(f.ended()).toBe(false)
    emit(EventNames.SESSION_RESULT, { result: 'MANGO', turnGen: 5 })
    await tick()
    expect(f.ended()).toBe(true)
    expect(f.lines).toEqual([
      { type: 'activity', detail: expect.stringContaining('List files') },
      { type: 'text', delta: 'MAN' },
      { type: 'text', delta: 'GO' },
      { type: 'result', text: 'MANGO' },
    ])
  })

  it('keeps what happened between subscribing and the send answering (a hot CLI)', async () => {
    const f = follow()
    emit(EventNames.SESSION_MESSAGES_DELIVERED, { count: 1, messageIds: ['qm-fast'], turnGen: 2 })
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'quick' })
    emit(EventNames.SESSION_RESULT, { result: 'quick', turnGen: 2 })
    f.follower.bind(SID, { messageId: 'qm-fast' })
    await tick()
    expect(f.lines).toEqual([{ type: 'text', delta: 'quick' }, { type: 'result', text: 'quick' }])
    expect(f.ended()).toBe(true)
  })

  it('a fresh session: its first turn is the reply; another session is ignored', async () => {
    const f = follow()
    bus.emit(EventNames.SESSION_TEXT_DELTA, { sessionId: 'other', delta: 'not mine' }, [])
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'hello' })
    f.follower.bind(SID, { fresh: true })
    emit(EventNames.SESSION_RESULT, { result: 'hello there' })
    await tick()
    expect(f.lines).toEqual([{ type: 'text', delta: 'hello' }, { type: 'result', text: 'hello' }])
  })

  it('a turn with no streamed words returns the result text; errors end it', async () => {
    const a = follow()
    a.follower.bind(SID, { fresh: true })
    emit(EventNames.SESSION_RESULT, { result: 'done quietly' })
    const b = follow()
    b.follower.bind(SID, { fresh: true })
    emit(EventNames.SESSION_ERROR, { error: 'CLI exited' })
    await tick()
    expect(a.lines).toEqual([{ type: 'result', text: 'done quietly' }])
    expect(b.lines).toEqual([{ type: 'error', code: 'session_error', message: 'CLI exited' }])
    expect(b.ended()).toBe(true)
  })

  it('a message sent mid-turn that the CLI answers with the next turn: that turn is the reply', async () => {
    const f = follow()
    f.follower.bind(SID, { messageId: 'qm-mid', midTurn: true })
    emit(EventNames.SESSION_MESSAGES_DELIVERED, { count: 1, messageIds: ['qm-mid'], turnGen: 3 })
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'thirty-nine forty' })
    emit(EventNames.SESSION_RESULT, { result: 'forty', turnGen: 3 })
    await tick()
    expect(f.ended()).toBe(false)
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: SID, process_status: 'running' }, [], { source: 'session-runner' })
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'KIWI' })
    emit(EventNames.SESSION_RESULT, { result: 'KIWI', turnGen: 4 })
    await tick()
    expect(f.lines).toEqual([
      { type: 'text', delta: 'thirty-nine forty' },
      { type: 'reset' },
      { type: 'text', delta: 'KIWI' },
      { type: 'result', text: 'KIWI' },
    ])
    expect(f.ended()).toBe(true)
  })

  it('a message sent mid-turn that joined the turn: its end stands once no next turn starts', async () => {
    const f = follow()
    f.follower.bind(SID, { messageId: 'qm-join', midTurn: true })
    emit(EventNames.SESSION_MESSAGES_DELIVERED, { count: 1, messageIds: ['qm-join'], turnGen: 6 })
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'both answered' })
    emit(EventNames.SESSION_RESULT, { result: 'both answered', turnGen: 6 })
    // It ends only once the MID_TURN_NEXT_MS window passed with no next turn.
    await vi.waitFor(() => { expect(f.ended()).toBe(true) }, { timeout: MID_TURN_NEXT_MS + 10_000, interval: 20 })
    expect(f.lines).toEqual([{ type: 'text', delta: 'both answered' }, { type: 'result', text: 'both answered' }])
  })

  it('stop() ends it quietly and later events are ignored', async () => {
    const f = follow()
    f.follower.bind(SID, { fresh: true })
    f.follower.stop()
    emit(EventNames.SESSION_TEXT_DELTA, { delta: 'after' })
    await tick()
    expect(f.lines).toEqual([])
    expect(f.ended()).toBe(true)
  })
})
