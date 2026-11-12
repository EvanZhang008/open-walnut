/**
 * A board goes read-only on a write the server will not take: 501 (a replica
 * without the route) and, since host replicas, 503 needs_leader (the Mac is away).
 * Before, only 501 counted, so a host replica's board kept every control live
 * and each write failed with a toast.
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../web/src/api/client'
import { refusesWrites } from '../../web/src/components/board/kanban/useKanbanWrites'

const err = (status: number, code?: string) =>
  new ApiError(status, 'refused', code ? { error: { code, why: 'board_writes_need_mac', retryAfter: 5 } } : undefined)

describe('refusesWrites', () => {
  it('501 and 503 needs_leader turn the board read-only', () => {
    expect(refusesWrites(err(501))).toBe(true)
    expect(refusesWrites(err(503, 'needs_leader'))).toBe(true)
  })
  it('any other failure leaves the controls live', () => {
    expect(refusesWrites(err(503))).toBe(false)
    expect(refusesWrites(err(503, 'bridge_offline'))).toBe(false)
    expect(refusesWrites(err(409, 'needs_leader'))).toBe(false)
    expect(refusesWrites(err(500))).toBe(false)
    expect(refusesWrites(new Error('Walnut did not answer in time'))).toBe(false)
  })
})
