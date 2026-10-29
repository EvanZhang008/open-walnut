/**
 * A request its target handed on is never settled by a plain turn end (2026-10-28, Main's
 * reflection: a lead's turn end after its worker answered settled Main's request with a notice,
 * and the worker's own answer to Main met a closed request). Only a real reply or its deadline
 * settles it; a target that is blocked, errs or closes its task still speaks at once.
 */
import { describe, it, expect } from 'vitest'
import { holdHandedOn } from '../../src/core/sessions/request-handoff.js'
import type { SessionRequest } from '../../src/core/session-requests.js'

const row = (id: string, carried: boolean): SessionRequest => ({
  id, fromSessionId: 's-main', toSessionId: 's-lead', toTaskId: 't-lead', preview: 'x', status: 'pending',
  createdAt: '2026-10-28T19:00:00Z', deadlineAt: Date.parse('2026-10-28T20:00:00Z'),
  ...(carried ? { carriedBy: [{ id: 'rq-worker', taskId: 't-worker', at: Date.parse('2026-10-28T19:01:00Z') }] } : {}),
}) as SessionRequest

describe('a handed-on request at its target\'s turn end', () => {
  it('a plain turn end holds it, whether or not the work came back; others speak as before', async () => {
    const speak = await holdHandedOn([row('rq-a', true), row('rq-b', false)], { outcome: 'completed', phase: 'NEED_ACTION' })
    expect(speak.map((r) => r.id)).toEqual(['rq-b'])
  })

  it('blocked, failed or closed: it speaks at once', async () => {
    for (const edge of [{ outcome: 'awaiting_human' as const }, { outcome: 'error' as const }, { outcome: 'completed' as const, phase: 'COMPLETE' }]) {
      expect((await holdHandedOn([row('rq-a', true)], edge)).map((r) => r.id)).toEqual(['rq-a'])
    }
  })
})
