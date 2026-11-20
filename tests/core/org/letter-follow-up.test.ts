/**
 * Which way his words on a letter's thread go (src/core/org/letter-follow-up.ts), with the stores
 * and the relay mocked: a browser under automation never answers, a thread that no longer waits
 * answers only a send already on record by its id, and on a replica the turn goes to the leader
 * (the letter is the leader's), never into the replica's own inbox store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  thread: null as null | Record<string, unknown>,
  follower: false,
  local: vi.fn(),
  leader: vi.fn(),
}))

vi.mock('../../../src/core/org/threads-store.js', () => ({ threadHolder: async () => (h.thread ? { node: 'task-1', thread: h.thread } : null) }))
vi.mock('../../../src/core/server-role.js', () => ({ isFollower: () => h.follower }))
vi.mock('../../../src/core/human-inbox/letter-ops.js', () => ({ humanReplyAndDeliver: h.local }))
vi.mock('../../../src/web/routes/v1-control-relay.js', () => ({ callPrimaryControl: h.leader }))

import { answerLetterOnThread } from '../../../src/core/org/letter-follow-up.js'
import { withAutomatedClient } from '../../../src/core/sessions/automated-client.js'

const waiting = () => ({ id: 'th-aaaaaaaaaaaa', state: 'needs', letter: { id: 'lt-1', task: 'task-1', options: [] }, messages: [] })
const input = { taskId: 'task-1', threadId: 'th-aaaaaaaaaaaa', text: 'K', clientId: 'qm-one' }

beforeEach(() => {
  h.thread = waiting()
  h.follower = false
  h.local.mockReset().mockResolvedValue({ delivery: { status: 'queued' } })
  h.leader.mockReset().mockResolvedValue({ ok: true, result: { delivery: { status: 'queued' } } })
})

describe('his words on a letter thread', () => {
  it('answer the letter on the leader while it waits, checked again under its lock', async () => {
    expect(await answerLetterOnThread(input)).toMatchObject({ letterId: 'lt-1', delivery: { status: 'queued' } })
    expect(h.local).toHaveBeenCalledWith('lt-1', expect.objectContaining({ text: 'K', clientId: 'qm-one', whileWaiting: true }), expect.objectContaining({ answerBy: expect.any(Number) }))
  })

  it('never from a browser under automation', async () => {
    expect(await withAutomatedClient('webdriver', () => answerLetterOnThread(input))).toBeNull()
    expect(h.local).not.toHaveBeenCalled()
  })

  it('a thread that no longer waits answers only the send already on record by its id', async () => {
    h.thread = { ...waiting(), state: 'answered' }
    await answerLetterOnThread(input)
    expect(h.local).toHaveBeenCalledWith('lt-1', expect.objectContaining({ repeatOnly: true }), expect.anything())
    h.local.mockReset()
    expect(await answerLetterOnThread({ ...input, clientId: undefined })).toBeNull()
    expect(h.local).not.toHaveBeenCalled()
  })

  it('a lost receipt asks by its id and never records a new answer', async () => {
    await answerLetterOnThread({ ...input, confirmOnly: true })
    expect(h.local).toHaveBeenCalledWith('lt-1', expect.objectContaining({ repeatOnly: true }), expect.anything())
    expect(h.local.mock.calls[0][1]).not.toHaveProperty('whileWaiting')
  })

  it('a refusal (answered meanwhile, no such send) leaves it a follow-up', async () => {
    h.local.mockRejectedValue(Object.assign(new Error('answered a moment ago'), { code: 'already_answered' }))
    expect(await answerLetterOnThread(input)).toBeNull()
  })

  it('a failed delivery comes back, so the box keeps his words', async () => {
    h.local.mockResolvedValue({ delivery: { status: 'failed', reason: 'timeout' } })
    expect((await answerLetterOnThread(input))?.delivery).toEqual({ status: 'failed', reason: 'timeout' })
  })

  it('on a replica the turn goes to the leader, never into its own store', async () => {
    h.follower = true
    expect(await answerLetterOnThread(input)).toMatchObject({ letterId: 'lt-1', delivery: { status: 'queued' } })
    expect(h.local).not.toHaveBeenCalled()
    expect(h.leader).toHaveBeenCalledWith('server.human-inbox.human-reply', '__server__', expect.objectContaining({ id: 'lt-1', text: 'K', clientId: 'qm-one', whileWaiting: true }), expect.any(Number))
    // The leader out of reach: it stays a follow-up, which the replica carries the usual way.
    h.leader.mockResolvedValue({ ok: false, failure: { kind: 'bridge_offline', message: 'down', notSent: true } })
    expect(await answerLetterOnThread(input)).toBeNull()
  })
})
