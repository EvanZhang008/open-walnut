/**
 * Drill round 4, R4-2: a session started while a service set move held the host (service-set-hold.ts)
 * was recorded as a restart loss. Its record already read `running`, its `start` waited in the hold,
 * and the flip's reconnect asked the new daemon about it: no CLI there, so the reconnect noted a
 * host_restart loss and queued restart recovery, though no host restarted and the hold's release was
 * about to send the start. A start the hold keeps unsent is no loss.
 *
 * What's real: DaemonConnection.send, its hold and recoverDisconnectedSessions. What's faked: the wire
 * (sendAdmitted answers: the new daemon knows no CLI), the session store, restart recovery's noteLoss.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  noted: [] as string[],
  relabelled: [] as string[],
}))

vi.mock('../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listSessions: async () => state.sessions,
  updateSessionRecord: async (sid: string, patch: Record<string, unknown>) => {
    if (patch.process_status) state.relabelled.push(`${sid}:${String(patch.process_status)}`)
    return { ...state.sessions.find((s) => s.claudeSessionId === sid), ...patch }
  },
  emitSessionStatusChanged: () => {},
}))
vi.mock('../../src/core/sessions/judge-of.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  judgedHereRecords: (records: unknown[]) => records,
}))
vi.mock('../../src/core/sessions/restart-death.js', () => ({
  noteRestartDeath: async (record: { claudeSessionId: string }) => { state.noted.push(record.claudeSessionId); return true },
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import type { SetHold } from '../../src/providers/service-set-hold.js'

type Internals = {
  _setHold: SetHold
  _connected: boolean
  sendAdmitted: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
  recoverDisconnectedSessions: (only?: ReadonlySet<string>) => Promise<void>
  scheduleAutoRecoverIfDead: (sid: string, record?: unknown) => Promise<void>
}

const HELD = '11111111-1111-4111-8111-111111111111'
const LOST = '22222222-2222-4222-8222-222222222222'
const running = (sid: string) => ({
  claudeSessionId: sid, taskId: `task-${sid.slice(0, 4)}`, host: 'devbox', process_status: 'running',
  last_status_change: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
})

afterEach(() => {
  vi.restoreAllMocks()
  state.sessions = []
  state.noted = []
  state.relabelled = []
})

describe('R4-2: a start the move holds is not a restart loss', () => {
  it('the flip reconnect leaves the held start alone; the release sends it; a real loss beside it is still noted', async () => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.invalid' })
    const x = conn as unknown as Internals
    x._connected = true
    vi.spyOn(conn, 'hasCapability').mockReturnValue(false)
    const wire: string[] = []
    vi.spyOn(x, 'sendAdmitted').mockImplementation(async (cmd, params) => {
      wire.push(`${cmd}:${String(params.sid ?? '')}`)
      // The set's new daemon: it knows no CLI of either session.
      if (cmd === 'status') return { ok: true, exists: false, alive: false }
      return { ok: true, pid: 4242 }
    })
    const recovered = vi.spyOn(x, 'scheduleAutoRecoverIfDead').mockResolvedValue(undefined)
    // HELD started during the hold (its record already reads running); LOST ran on the old daemon and is gone.
    state.sessions = [running(HELD), running(LOST)]

    x._setHold.set(true)
    const start = conn.send('start', { sid: HELD, args: [] })
    // Held: the start waits in the hold, and nothing left for the daemon.
    await vi.waitFor(() => expect(x._setHold.holdsStart(HELD)).toBe(true))
    expect(wire).toEqual([])

    // The flip's reconnect, while the hold is still on.
    await x.recoverDisconnectedSessions()
    expect(state.noted).toEqual([LOST])
    expect(state.relabelled).toEqual([`${LOST}:stopped`])
    expect(recovered.mock.calls.map((c) => c[0])).toEqual([LOST])
    expect(wire).not.toContain(`status:${HELD}`)

    // The release: the held start goes out, and only then.
    x._setHold.set(false)
    expect(await start).toMatchObject({ ok: true, pid: 4242 })
    expect(wire).toContain(`start:${HELD}`)
  })

  it('a start that gave up waiting (the hold outlived its bound) is no longer counted as held', async () => {
    const { SetHold } = await import('../../src/providers/service-set-hold.js')
    const hold = new SetHold()
    hold.set(true)
    const late = hold.admit('start', { sid: HELD }, () => new Error('held too long'), 30)
    expect(hold.holdsStart(HELD)).toBe(true)
    await expect(late).rejects.toThrow('held too long')
    expect(hold.holdsStart(HELD)).toBe(false)
    // A send or a one-shot is not a start: never counted.
    void hold.admit('oneshot.run', { sid: LOST }, () => new Error('x'), 30).catch(() => {})
    expect(hold.holdsStart(LOST)).toBe(false)
  })
})
