/**
 * DaemonFileReader.readSessionCost and the day split (session-cost-day-v1).
 *
 * `byDay` rides the RPC only to a daemon that advertises it. An older daemon
 * (session-cost-v1 only) is asked the old way and answers undivided buckets, with
 * no `byDay` on the scan, which is how a caller tells the two answers apart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, connState } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  connState: { caps: [] as string[] },
}))

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => ({
    send: sendMock,
    connect: async () => {},
    capabilitiesKnown: true,
    hasCapability: (c: string) => connState.caps.includes(c),
  }),
}))

const { DaemonFileReader } = await import('../../src/core/daemon-file-reader.js')

const params = { sessionId: 's1', engine: 'codex', cwd: '/w', thresholds: [100] }
const LA = { timeZone: 'America/Los_Angeles' }

beforeEach(() => { sendMock.mockReset() })

describe('readSessionCost day split', () => {
  it('sends byDay to a daemon with session-cost-day-v1 and returns its day-split scan', async () => {
    connState.caps = ['session-cost-v1', 'session-cost-day-v1']
    const scan = { buckets: [{ day: '2026-10-26' }], byDay: LA }
    sendMock.mockResolvedValue({ ok: true, result: scan })
    expect(await new DaemonFileReader('__local__').readSessionCost({ ...params, byDay: LA }, 5_000)).toEqual(scan)
    expect(sendMock).toHaveBeenCalledWith('usage.sessionCost', { sid: 's1', engine: 'codex', cwd: '/w', thresholds: [100], byDay: LA }, 5_000)
  })

  it('asks an older daemon the old way; its answer carries no byDay', async () => {
    connState.caps = ['session-cost-v1']
    sendMock.mockResolvedValue({ ok: true, result: { buckets: [{ responses: 1 }] } })
    const scan = await new DaemonFileReader('__local__').readSessionCost({ ...params, byDay: LA }) as Record<string, unknown>
    expect(sendMock).toHaveBeenCalledWith('usage.sessionCost', { sid: 's1', engine: 'codex', cwd: '/w', thresholds: [100] }, 25_000)
    expect(scan.byDay).toBeUndefined()
  })

  it('a caller that asks no day split sends what it always sent', async () => {
    connState.caps = ['session-cost-v1', 'session-cost-day-v1']
    sendMock.mockResolvedValue({ ok: true, result: { buckets: [] } })
    await new DaemonFileReader('__local__').readSessionCost(params)
    expect(sendMock).toHaveBeenCalledWith('usage.sessionCost', { sid: 's1', engine: 'codex', cwd: '/w', thresholds: [100] }, 25_000)
  })

  it('still answers null on a daemon without session-cost-v1', async () => {
    connState.caps = []
    expect(await new DaemonFileReader('__local__').readSessionCost({ ...params, byDay: LA })).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })
})
