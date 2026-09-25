/**
 * The reconnect loop of a host that WAS connected: an expired certificate must
 * read as cert_expired (the local evidence is gathered here too, not only on a
 * first connect), so it follows the credential schedule (1 minute first); and a
 * bare "permission denied" from a daemon start log is not an ssh key problem,
 * so it keeps the normal doubling backoff instead of the 10-minute standing one.
 *
 * reconnect() and the evidence gatherer are stubbed: no ssh, agent or socket.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('../../src/providers/ssh-credential-evidence.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/providers/ssh-credential-evidence.js')>()
  return {
    ...real,
    annotateCredentialFailure: vi.fn(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!real.looksLikeCredentialFailure(message)) return err
      return new Error(`${message}\nwalnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-09-25 08:00)`)
    }),
  }
})

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { annotateCredentialFailure } from '../../src/providers/ssh-credential-evidence.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'

type Priv = Record<string, (...args: unknown[]) => unknown>
const priv = (conn: DaemonConnection) => conn as unknown as Priv

let conn: DaemonConnection | null = null
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  conn?.disconnect()
  conn = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function failingReconnect(message: string) {
  conn = new DaemonConnection('devbox', { hostname: 'devbox.example.test', user: 'me' })
  vi.spyOn(priv(conn), 'reconnect').mockRejectedValue(new Error(message))
  const schedule = vi.spyOn(priv(conn), 'scheduleReconnect')
  return { conn, schedule }
}

describe('reconnect failures are classified like a first connect', () => {
  it('an expired certificate on a host that was connected waits 1 minute (credential schedule), not 10', async () => {
    const { conn: c, schedule } = failingReconnect('Command failed: ssh me@devbox.example.test sh -s\nme@devbox.example.test: Permission denied (publickey).')
    priv(c).scheduleReconnect(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(annotateCredentialFailure).toHaveBeenCalled()
    expect(schedule).toHaveBeenLastCalledWith(60_000)
    // The next failure moves up the schedule: 2 minutes.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(schedule).toHaveBeenLastCalledWith(120_000)
  })

  it('"permission denied" inside a daemon start log is not an ssh key problem: normal doubling backoff', async () => {
    const startLog = "daemon failed to start (port='', status=''). Startup log: Error: EACCES: permission denied, open '/tmp/open-walnut/daemon.pid'"
    expect(classifyHostConnectError(startLog, 'me@devbox.example.test', ['devbox']).kind).not.toBe('auth')
    const { conn: c, schedule } = failingReconnect(startLog)
    priv(c).scheduleReconnect(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(schedule).toHaveBeenLastCalledWith(2_000)
  })

  it("ssh's own refusal shapes still read as auth", () => {
    for (const m of [
      'me@devbox: Permission denied (publickey).',
      'me@devbox: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).',
      'Received disconnect from 10.0.0.9 port 22:2: Too many authentication failures',
      'me@devbox: No supported authentication methods available (server sent: publickey)',
    ]) expect(classifyHostConnectError(m, 'me@devbox').kind).toBe('auth')
  })
})
