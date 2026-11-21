/**
 * A worker's AskUserQuestion reaches its leader, never the user's screen
 * (src/core/sessions/worker-question.ts, hooked in ClaudeCodeSession's
 * can_use_tool branch). 2026-10-05: a worker asked the user "which of these
 * should I do?" right after its leader relayed the user's go, and sat waiting
 * for an hour.
 *
 * What's real: ClaudeCodeSession's stream handling and its control_response.
 * What's stubbed: the routing decision (its own tests live in
 * session-send-core.test.ts) and the transport write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const routeWorkerQuestion = vi.fn()
vi.mock('../../src/core/sessions/worker-question.js', () => ({
  routeWorkerQuestion: (...args: unknown[]) => routeWorkerQuestion(...args),
}))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj))

const QUESTION = {
  type: 'control_request',
  request_id: 'req-ask-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] },
  },
}

function collect(name: string): BusEvent[] {
  const events: BusEvent[] = []
  bus.subscribe(`worker-question-${name}`, (e) => { if (e.name === name) events.push(e) }, { global: true })
  return events
}

describe('ClaudeCodeSession: a worker question goes to its leader', () => {
  let session: ClaudeCodeSession
  let responses: Array<{ requestId: string; allow: boolean; message?: string }>

  beforeEach(() => {
    bus.clear()
    routeWorkerQuestion.mockReset()
    session = new ClaudeCodeSession('task-worker', 'proj', 'true')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any
    s.claudeSessionId = 'sid-worker'
    responses = []
    s.respondToControlRequest = (requestId: string, _req: unknown, allow: boolean, message?: string) => {
      responses.push({ requestId, allow, message })
      return true
    }
  })

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._clearAllPermissionReEmitTimers()
    bus.clear()
  })

  it('answers the CLI with where the question went, and never shows the user a prompt', async () => {
    const asked = collect(EventNames.SESSION_PERMISSION_REQUEST)
    routeWorkerQuestion.mockResolvedValue({ message: 'Your question went to your leader.', requestId: 'rq-abc123', leaderTaskId: 'task-lead' })

    feed(session, QUESTION)
    // Held while Walnut decides: a send in that window takes the pending-prompt path.
    expect(session.hasPendingPermission).toBe(true)
    await vi.waitFor(() => expect(responses).toHaveLength(1))

    expect(routeWorkerQuestion).toHaveBeenCalledWith({
      sessionId: 'sid-worker', taskId: 'task-worker', requestId: 'req-ask-1', input: QUESTION.request.input,
    })
    expect(responses[0]).toEqual({ requestId: 'req-ask-1', allow: false, message: 'Your question went to your leader.' })
    expect(session.hasPendingPermission).toBe(false)
    expect(asked).toHaveLength(0)
  })

  it('a question that is not a worker\'s goes to the user exactly as before', async () => {
    const asked = collect(EventNames.SESSION_PERMISSION_REQUEST)
    routeWorkerQuestion.mockResolvedValue(null)

    feed(session, QUESTION)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect((asked[0].data as { toolName: string; requestId: string })).toMatchObject({ toolName: 'AskUserQuestion', requestId: 'req-ask-1' })
    expect(session.hasPendingPermission).toBe(true)
    expect(responses).toHaveLength(0)
  })

  // The card the user could not read (2026-11-21), as test data, escaped: "Put it in this position, ok?".
  const UNCLEAR = {
    ...QUESTION, request_id: 'req-ask-2',
    request: { ...QUESTION.request, input: { questions: [{ question: '\u653e\u8fd9\u4e2a\u4f4d\u7f6e\u884c\u5417\uff1f', options: [{ label: 'OK' }, { label: 'Keep it in Settings' }] }] } },
  }

  it('a question for the user that does not read on its own goes back once with the reason, then to the user', async () => {
    const asked = collect(EventNames.SESSION_PERMISSION_REQUEST)
    routeWorkerQuestion.mockResolvedValue(null)
    feed(session, UNCLEAR)
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({ requestId: 'req-ask-2', allow: false })
    expect(responses[0].message).toMatch(/only you can see.*Ask it again rewritten/)
    expect(asked).toHaveLength(0)
    expect(session.hasPendingPermission).toBe(false)
    // Asked again unchanged: it reaches the user as written.
    feed(session, { ...UNCLEAR, request_id: 'req-ask-3' })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(responses).toHaveLength(1)
  })

  it('a worker\'s unclear question still goes to its leader: the check is only for the user', async () => {
    routeWorkerQuestion.mockResolvedValue({ message: 'Your question went to your leader.', requestId: 'rq-abc124', leaderTaskId: 'task-lead' })
    feed(session, { ...UNCLEAR, request_id: 'req-ask-4' })
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toEqual({ requestId: 'req-ask-4', allow: false, message: 'Your question went to your leader.' })
  })

  it('a routing failure falls back to the user, never to a silent hang', async () => {
    const asked = collect(EventNames.SESSION_PERMISSION_REQUEST)
    routeWorkerQuestion.mockRejectedValue(new Error('boom'))

    feed(session, QUESTION)
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(responses).toHaveLength(0)
  })

  it('a request the CLI withdraws during the decision is left alone', async () => {
    const asked = collect(EventNames.SESSION_PERMISSION_REQUEST)
    let release!: (v: unknown) => void
    routeWorkerQuestion.mockReturnValue(new Promise((r) => { release = r }))

    feed(session, QUESTION)
    await vi.waitFor(() => expect(routeWorkerQuestion).toHaveBeenCalled())
    feed(session, { type: 'control_cancel_request', request_id: 'req-ask-1' })
    release({ message: 'routed', leaderTaskId: 'task-lead' })
    await new Promise((r) => setTimeout(r, 20))

    expect(responses).toHaveLength(0)
    expect(asked).toHaveLength(0)
    expect(session.hasPendingPermission).toBe(false)
  })

  it('other tools and a session with no task never consult the router', async () => {
    feed(session, { ...QUESTION, request_id: 'req-bash', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })
    const solo = new ClaudeCodeSession('', 'proj', 'true')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(solo as any).claudeSessionId = 'sid-solo'
    feed(solo, { ...QUESTION, request_id: 'req-solo' })
    await new Promise((r) => setTimeout(r, 20))
    expect(routeWorkerQuestion).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(solo as any)._clearAllPermissionReEmitTimers()
  })
})
