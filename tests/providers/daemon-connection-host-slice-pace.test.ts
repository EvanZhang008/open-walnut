/**
 * A remote host's read copy (`host.slice`) is paced by its size
 * (src/providers/host-slice-pace.ts, wired in DaemonConnection.pushHostSlice).
 *
 * 2026-10-29: the copy for a busy host is about 1.5 MB and was re-pushed whole
 * after every 3 s debounce of task churn. Through an SSH path behind a WebSocket
 * relay, an upload burst gets the whole connection dropped, and the copy rides
 * the ControlMaster every session link to that host shares: 330 of 492 drops in
 * three days had a copy in flight. Pinned here: after a large copy the next
 * changed one waits (at most a minute), a small one keeps the debounce's pace,
 * a copy naming a new session goes at once, the first copy of a link goes at
 * once, and this machine's own copy never waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const slices = vi.hoisted(() => ({ next: null as null | (() => Record<string, unknown>) }))
vi.mock('../../src/core/host-slice.js', () => ({
  ensureHostSliceSync: () => {},
  buildHostSlice: async () => slices.next!(),
}))
vi.mock('../../src/core/offline-handover.js', () => ({ runOfflineHandover: async () => {} }))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { HOST_SLICE_MAX_GAP_MS, hostSliceWaitMs } from '../../src/providers/host-slice-pace.js'

let version = 0
/** A copy of about `bytes` naming `sids`; every call is a changed copy (new hash). */
function copyOf(bytes: number, sids: string[] = ['sid-a']): Record<string, unknown> {
  version++
  return {
    v: 1, home: '/home', host: 'devbox',
    sessions: sids.map((sid) => ({ sid })),
    tasks: [{ id: 't', description: 'x'.repeat(bytes) }],
    requests: [], boards: [], boardOf: {},
    hash: `h${version}`, asOf: version,
  }
}

function connected(host: string): { conn: DaemonConnection; send: ReturnType<typeof vi.fn> } {
  const conn = new DaemonConnection(host, { hostname: host })
  const c = conn as unknown as Record<string, unknown>
  c._capabilities = ['offline-host-v1']
  c._connected = true
  const send = vi.fn(async () => ({ ok: true, changed: true }))
  ;(conn as unknown as { send: unknown }).send = send
  return { conn, send }
}

/** Let the push's async chain run without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

const slicePushes = (send: ReturnType<typeof vi.fn>) => send.mock.calls.filter((c) => c[0] === 'host.slice').length

describe('host copy pacing', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('after a 1.5 MB copy, the next changed copy waits instead of going 3 s later', async () => {
    const { conn, send } = connected('devbox')
    slices.next = () => copyOf(1_500_000)
    conn.pushHostSlice()
    await settle()
    expect(slicePushes(send)).toBe(1)

    // The debounce fires again 3 s later with a changed copy: it is held.
    await vi.advanceTimersByTimeAsync(3_000)
    conn.pushHostSlice()
    await settle()
    expect(slicePushes(send)).toBe(1)
    // More churn meanwhile neither sends nor stacks timers.
    await vi.advanceTimersByTimeAsync(10_000)
    conn.pushHostSlice()
    await settle()
    expect(slicePushes(send)).toBe(1)

    // It goes once the gap (capped at a minute) has passed, by itself.
    await vi.advanceTimersByTimeAsync(HOST_SLICE_MAX_GAP_MS - 13_000 + 50)
    await settle()
    expect(slicePushes(send)).toBe(2)
  })

  it('a small copy keeps the debounce pace', async () => {
    const { conn, send } = connected('devbox')
    slices.next = () => copyOf(20_000)
    conn.pushHostSlice()
    await settle()
    await vi.advanceTimersByTimeAsync(3_000)
    conn.pushHostSlice()
    await settle()
    expect(slicePushes(send)).toBe(2)
  })

  it('a copy naming a session the last one did not goes at once', async () => {
    const { conn, send } = connected('devbox')
    slices.next = () => copyOf(1_500_000, ['sid-a'])
    conn.pushHostSlice()
    await settle()
    slices.next = () => copyOf(1_500_000, ['sid-a', 'sid-new'])
    await vi.advanceTimersByTimeAsync(1_000)
    conn.pushHostSlice()
    await settle()
    expect(slicePushes(send)).toBe(2)
    expect(conn.hostSliceNames('sid-new')).toBe(true)
  })

  it("this machine's own copy never waits", async () => {
    const { conn, send } = connected('__local__')
    slices.next = () => copyOf(1_500_000)
    conn.pushHostSlice()
    await settle()
    await vi.advanceTimersByTimeAsync(3_000)
    conn.pushHostSlice()
    await settle()
    expect(slicePushes(send)).toBe(2)
  })

  it('the wait: none for a first copy, in proportion to size, capped at a minute', () => {
    expect(hostSliceWaitMs({ lastSentAt: 0, lastBytes: 2_000_000, now: 10, namesNewSession: false })).toBe(0)
    expect(hostSliceWaitMs({ lastSentAt: 1_000, lastBytes: 250_000, now: 4_000, namesNewSession: false })).toBe(7_000)
    expect(hostSliceWaitMs({ lastSentAt: 1_000, lastBytes: 50_000, now: 4_000, namesNewSession: false })).toBe(0)
    expect(hostSliceWaitMs({ lastSentAt: 1_000, lastBytes: 9_000_000, now: 1_000, namesNewSession: false })).toBe(HOST_SLICE_MAX_GAP_MS)
    expect(hostSliceWaitMs({ lastSentAt: 1_000, lastBytes: 9_000_000, now: 1_000, namesNewSession: true })).toBe(0)
  })
})
