/**
 * A host that started a stopped session again for a trigger fire (a `resume`
 * record in its journal, trigger-host-resume-v1): the Mac's handover has the
 * connection look at that session again as a reconnect does, after the drain is
 * acked, because the Mac's record still says stopped while the CLI runs there.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-resume'))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null, updateSessionRecord: vi.fn() }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { runOfflineHandover } from '../../src/core/offline-handover.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const resume = (seq: number, sid: string): OfflineRecord =>
  ({ seq, at: Date.parse('2026-10-10T09:00:00.000Z'), kind: 'resume', sid, taskId: 'mtask-1', messageId: `qm-trigger-${seq}` }) as OfflineRecord

function conn(rounds: OfflineRecord[][], rescue?: (sids: string[]) => Promise<void>) {
  const log: string[] = []
  let round = 0
  return {
    log,
    conn: {
      hostKey: 'devbox',
      send: async (cmd: string, params?: Record<string, unknown>) => {
        log.push(cmd === 'offline.ack' ? `ack:${params?.upTo}` : cmd)
        if (cmd === 'offline.ack') return { ok: true }
        return { ok: true, records: rounds[round++] ?? [] }
      },
      ...(rescue ? { rescue: async (sids: string[]) => { log.push(`rescue:${sids.join(',')}`); await rescue(sids) } } : {}),
    },
  }
}

describe('offline handover: sessions the host resumed', () => {
  it('looks at each resumed session once, after the records are acked, across rounds', async () => {
    const rescued: string[][] = []
    const c = conn([[resume(1, A), resume(2, B)], [resume(3, A)]], async (sids) => { rescued.push(sids) })
    const result = await runOfflineHandover(c.conn)
    expect(result).toMatchObject({ records: 3, replayed: 3, failed: 0 })
    expect(rescued).toEqual([[A, B]])
    expect(c.log).toEqual(['offline.drain', 'ack:2', 'offline.drain', 'ack:3', 'offline.drain', `rescue:${A},${B}`])
  })

  it('a connection without rescue (or one that throws) still acks and fails nothing', async () => {
    const plain = conn([[resume(1, A)]])
    expect(await runOfflineHandover(plain.conn)).toMatchObject({ replayed: 1, failed: 0 })
    expect(plain.log).toContain('ack:1')
    const broken = conn([[resume(1, A)]], async () => { throw new Error('daemon went away') })
    expect(await runOfflineHandover(broken.conn)).toMatchObject({ replayed: 1, failed: 0 })
    // A later handover of the same host does not look at it again.
    const later = conn([[]], async () => { throw new Error('must not be called') })
    expect(await runOfflineHandover(later.conn)).toMatchObject({ records: 0 })
    expect(later.log).not.toContain(`rescue:${A}`)
  })
})
