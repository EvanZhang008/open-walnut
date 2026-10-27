/**
 * POST /api/v1/tasks/:id/start — the expect_reply TRANSPORT mapping only.
 *
 * Why its own file: expect_reply became tri-state on 2026-09-01 (undefined =
 * "apply the session-caller default", which is ON), and the route is where that
 * can silently die. The old mapping was `b.expect_reply === true`, which
 * flattens an omitted flag into a hard `false` — the default reverts to opt-in
 * and NOTHING in the core test suite notices, because those tests call
 * startSessionForTask directly and never cross this boundary. So this pins the
 * boundary itself: what the body said → what the core was handed.
 *
 * Semantics (who may get a reply, when it errors) are pinned in
 * tests/core/task-start-expect-reply.test.ts. Here the core is mocked at its
 * module seam and only the argument object is inspected.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-taskv1-start-er'))

const startSessionForTaskMock = vi.fn()
vi.mock('../../../src/core/sessions/task-start.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/task-start.js')>()
  // importOriginal keeps the REAL SessionExistsError so the route's instanceof
  // branch stays the production one.
  return { ...orig, startSessionForTask: (...args: unknown[]) => startSessionForTaskMock(...args) }
})

import express from 'express'
import request from 'supertest'
import { taskV1Router } from '../../../src/web/routes/task-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', taskV1Router)
  app.use(errorHandler)
  return app
}

/** The single params object the route handed the core. */
function coreParams(): Record<string, unknown> {
  return startSessionForTaskMock.mock.calls[0][0] as Record<string, unknown>
}

async function postStart(body: Record<string, unknown>, callerSid?: string) {
  const req = request(createApp()).post('/api/v1/tasks/task-1/start')
  if (callerSid) req.set('x-walnut-caller-sid', callerSid)
  return req.send(body)
}

beforeEach(() => {
  startSessionForTaskMock.mockReset()
  startSessionForTaskMock.mockResolvedValue({
    taskId: 'task-1', title: 'Fix the flake', sessionId: 'sess-new-1', requestId: 'rq-0123456789ab',
  })
})

describe('POST /api/v1/tasks/:id/start — expect_reply tri-state mapping', () => {
  it('hands the core UNDEFINED when the body omits expect_reply', async () => {
    const res = await postStart({ message: 'no flag' }, 'sess-caller-1')

    expect(res.status).toBe(202)
    expect(coreParams().expectReply).toBeUndefined()
    // Provenance must ride along, or the core cannot tell a session caller from
    // the human and the default has nothing to key on.
    expect(coreParams().callerSid).toBe('sess-caller-1')
  })

  it('hands the core FALSE for an explicit expect_reply:false', async () => {
    const res = await postStart({ message: 'fire and forget', expect_reply: false }, 'sess-caller-1')

    expect(res.status).toBe(202)
    expect(coreParams().expectReply).toBe(false)
  })

  it('hands the core TRUE for an explicit expect_reply:true', async () => {
    const res = await postStart({ message: 'answer me', expect_reply: true }, 'sess-caller-1')

    expect(res.status).toBe(202)
    expect(coreParams().expectReply).toBe(true)
  })

  it('ignores a non-boolean expect_reply rather than coercing it', async () => {
    const res = await postStart({ message: 'junk flag', expect_reply: 'false' }, 'sess-caller-1')

    expect(res.status).toBe(202)
    expect(coreParams().expectReply).toBeUndefined()
  })

  it('still forwards reply_timeout untouched', async () => {
    const res = await postStart({ message: 'slow job', reply_timeout: 7200 }, 'sess-caller-1')

    expect(res.status).toBe(202)
    expect(coreParams().replyTimeoutSecs).toBe(7200)
  })

  it('echoes the requestId the core registered back to the caller', async () => {
    // Without this the asker never learns the rq- id and cannot `walnut wait`.
    const res = await postStart({ message: 'go' }, 'sess-caller-1')

    expect(res.status).toBe(202)
    expect(res.body.requestId).toBe('rq-0123456789ab')
  })
})

// 2026-10-27: the draft column's launch choices, from an agent (src/ops/launch-parity.ts).
describe('POST /api/v1/tasks/:id/start — the draft\'s launch choices reach the core', () => {
  it('hands effort, user_request, create_cwd and workspace through', async () => {
    const res = await postStart({
      message: 'go', effort: 'max', user_request: 'start this now please', create_cwd: true,
      workspace: { provider: 'git-worktree', inputs: { branch: 'b' } },
    }, 'sess-caller-1')
    expect(res.status).toBe(202)
    expect(coreParams()).toMatchObject({
      effort: 'max', userRequest: 'start this now please', createCwd: true,
      workspace: { provider: 'git-worktree', inputs: { branch: 'b' } },
    })
  })

  it('omitted choices stay absent (an older body is byte-for-byte what it was)', async () => {
    await postStart({ message: 'go' })
    const p = coreParams()
    expect(p.effort).toBeUndefined()
    expect(p.userRequest).toBeUndefined()
    expect('createCwd' in p).toBe(false)
    expect('workspace' in p).toBe(false)
  })

  it('refuses a workspace without a provider before the core', async () => {
    const res = await postStart({ message: 'go', workspace: { inputs: {} } })
    expect(res.status).toBe(400)
    expect(startSessionForTaskMock).not.toHaveBeenCalled()
  })

  it('passes the core\'s applied list back to the op', async () => {
    startSessionForTaskMock.mockResolvedValue({ taskId: 'task-1', title: 'x', sessionId: 's', started: true, applied: ['effort'] })
    const res = await postStart({ message: 'go', effort: 'low' })
    expect(res.body.applied).toEqual(['effort'])
  })
})
