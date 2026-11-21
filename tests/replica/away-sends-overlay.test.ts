/**
 * The org walk of a send's reply default reads the tasks as this replica shows them
 * (replica/away-sends.ts wireAwaySends -> reply-direction.ts goesUpIn over tasksWithOverlay):
 * a child task made on this host, which only this host's journal holds, reporting to its parent
 * opens no request row, as the leader and the daemon's own away answer decide it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'

const P = 'mtaskppp-0001'
const C = 'mtaskccc-0002'
const SID_P = 'aaaaaaaa-1111-4111-8111-111111111111'
const SID_C = 'cccccccc-3333-4333-8333-333333333333'
const parentRow = { id: P, title: 'Parent', phase: 'IN_PROGRESS' }
const childRow = { id: C, title: 'Child made here', phase: 'IN_PROGRESS', parent_task_id: P }

vi.mock('../../src/core/task-manager.js', () => ({
  // The copy: the Mac's tasks only, never the one this host's journal made.
  listTasks: async () => [parentRow],
  getTask: async (id: string) => { if (id === P) return parentRow; throw new Error(`Task not found: ${id}`) },
}))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../src/core/org/retired-lead.js', () => ({ retiredLeadRefusal: async () => null }))
vi.mock('../../src/core/server-role.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), leaderAnswers: () => false }))

import { goesUpIn } from '../../src/core/sessions/reply-direction.js'
import { tasksWithOverlay, wireAwaySends } from '../../src/replica/away-sends.js'
import type { ReplicaWrite } from '../../src/replica/dispatch.js'
import type { Overlay } from '../../src/replica/overlay.js'
import type { WritePort } from '../../src/replica/write-port.js'
import { writeOpId } from '../../src/lib/op-call-id.js'

const overlay = {
  refresh: async () => {},
  task: (id: string, row: Record<string, unknown> | null) => (id === C ? childRow : row),
  createdTaskIds: () => [C],
} as unknown as Pick<Overlay, 'refresh' | 'task' | 'createdTaskIds'>

describe('a send\'s org walk sees the tasks made on this host', () => {
  it('tasksWithOverlay folds the journal over the copy and adds the tasks made here', async () => {
    const tasks = tasksWithOverlay([parentRow], overlay)
    expect(tasks.map((t) => t.id)).toEqual([P, C])
    expect(await goesUpIn(tasks as never, C, P)).toBe(true)
    // Over the copy alone (the old wiring) the child is unknown: it would have asked for a reply.
    expect(await goesUpIn([parentRow] as never, C, P)).toBe(false)
  })

  it('a child made here reporting to its parent opens no request row; a note down to it still asks one', async () => {
    const calls: Array<Record<string, unknown>> = []
    const handler = wireAwaySends({
      away: {
        port: {} as WritePort, overlay,
        actorOf: (req) => ({ kind: 'session', sid: String((req as unknown as { sid: string }).sid) }),
        task: async (id) => (id === C ? childRow : id === P ? parentRow : null) as never,
      },
      hostKey: 'devbox',
      capabilities: () => ['journal-v2', 'follower-peer-v1'],
      request: async () => ({ host: 'devbox', sessions: [{ sid: SID_P, taskId: P, taskTitle: 'Parent', state: 'idle' }, { sid: SID_C, taskId: C, taskTitle: 'Child made here', state: 'working' }] }),
    })
    const post = (sid: string, body: Record<string, unknown>, n: number) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const w: ReplicaWrite = {
        opId: writeOpId('oc-feedfacefeedface', 'POST', '/messages', n), away: 'host-write', raw: Buffer.from(''), submit: vi.fn(),
        call: async (cmd, params) => { calls.push({ cmd, ...params }); return { kind: 'applied', reply: { delivered: true, messageId: params.messageId } } },
      }
      let status = 0
      const res = { headersSent: false, setHeader: () => {}, status(s: number) { status = s; return this }, json(b: unknown) { resolve({ status, body: b }); return this } } as unknown as Response
      handler({ method: 'POST', path: '/v1/messages', body, replicaWrite: w, headers: {}, sid } as unknown as Request, res, () => reject(new Error('passed on')))
    })
    expect((await post(SID_C, { to: P, text: 'done, see the notes' }, 0)).status).toBe(202)
    expect((await post(SID_P, { to: C, text: 'one more thing' }, 1)).status).toBe(202)
    expect(calls.map((c) => [c.toSessionId, !!c.ask])).toEqual([[SID_P, false], [SID_C, true]])
  })
})
