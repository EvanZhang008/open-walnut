/**
 * A host replica's reader, while the Mac is away, gets the user status derived now for the tasks
 * whose sessions this host runs (replica/away-status.ts), never the copy's stored one, which the
 * Mac wrote before those sessions went on; every other task reads as its copy says.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { Overlay } from '../../src/replica/overlay.js'
import { awayReads } from '../../src/replica/away-reads.js'
import { createAwayStatus, withShownStatus } from '../../src/replica/away-status.js'
import type { UserStatus } from '../../src/core/user-status.js'

const OURS = 'mtask-runs-here'
const MAC = 'mtask-mac-only'
const NOW: UserStatus = { state: 'read', source: 'turn' } as UserStatus

/** An overlay with nothing on its way to the Mac. */
const overlay = {
  refresh: async () => {},
  taskForReaders: (_id: string, row: unknown) => row,
  createdTaskIds: () => [],
} as unknown as Overlay

async function read(path: string, body: unknown, shownStatus?: () => Promise<ReadonlyMap<string, UserStatus>>): Promise<any> {
  const handler = awayReads({ overlay, answeredAway: () => true, refreshWaitMs: 1_000, ...(shownStatus ? { shownStatus } : {}) })
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(s: number) { this.statusCode = s; return this },
      json(b: unknown) { resolve(b); return this },
    } as unknown as Response
    handler({ method: 'GET', path, query: {} } as unknown as Request, res, () => {
      try { (res as unknown as { json(b: unknown): unknown }).json(body) } catch (e) { reject(e) }
    })
  })
}

describe('the status a host replica shows while the Mac is away', () => {
  const copyStatus = { state: 'working' }
  const shown = async () => new Map([[OURS, NOW]])

  it('a list and a task read carry the derived status of a task whose session runs here; others as the copy says', async () => {
    const rows = [{ id: OURS, phase: 'NEED_ACTION', user_status: copyStatus }, { id: MAC, phase: 'IN_PROGRESS', user_status: copyStatus }]
    for (const path of ['/v1/tasks', '/tasks']) {
      const list = await read(path, { tasks: rows }, shown)
      expect(list.tasks.map((r: { id: string; user_status: unknown }) => [r.id, r.user_status]), path).toEqual([[OURS, NOW], [MAC, copyStatus]])
    }
    const one = await read(`/v1/tasks/${OURS}`, { task: rows[0] }, shown)
    expect(one.task.user_status).toEqual(NOW)
    // No derivation wired (the Mac, or a host without a host key): the copy's answer.
    expect((await read(`/v1/tasks/${OURS}`, { task: rows[0] })).task.user_status).toEqual(copyStatus)
  })

  it('a finished task reads Done, whatever was derived', () => {
    expect(withShownStatus({ id: OURS, phase: 'COMPLETE', user_status: { state: 'done' } }, new Map([[OURS, NOW]])).user_status).toEqual({ state: 'done' })
  })

  it('one derivation serves a burst of reads, and only for the tasks of this host\'s own sessions', async () => {
    let t = 1_000
    const derive = vi.fn(async (ids: ReadonlySet<string>) => new Map([...ids].map((id) => [id, NOW] as const)))
    const s = createAwayStatus({ ownTaskIds: async () => new Set([OURS]), derive, now: () => t })
    const [a, b] = await Promise.all([s.current(), s.current()])
    expect(a).toBe(b)
    expect(derive).toHaveBeenCalledTimes(1)
    expect([...derive.mock.calls[0][0]]).toEqual([OURS])
    t += 1_000
    await s.current()
    expect(derive).toHaveBeenCalledTimes(1)
    t += 5_000
    await s.current()
    expect(derive).toHaveBeenCalledTimes(2)
    // No session of its own: nothing to derive.
    const none = createAwayStatus({ ownTaskIds: async () => new Set(), derive })
    expect((await none.current()).size).toBe(0)
    expect(derive).toHaveBeenCalledTimes(2)
  })
})
