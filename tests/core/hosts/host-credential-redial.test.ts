/**
 * The 2026-09-29 report, end to end below the ssh layer: "SSH is already fixed,
 * why is it still not connected?" The certificate expired, the host's reconnect
 * loop reached its hourly credential wait, the user renewed the certificate, and
 *   1. nothing noticed the renewal (next attempt 32 minutes away), and
 *   2. the session banner's Reconnect failed fast on the standing cause without
 *      dialling, then crashed the session runner (SESSION_SEND without `message`).
 *
 * REAL: the connection pool and its reconnect loop, the reconnect-cause rules,
 * connectHostNow, redialAfterWake, the credential signal, the HostWarmup, the
 * session tracker and message queue (isolated WALNUT_HOME), retrySession.
 * STUBBED: DaemonConnection.reconnect()/connect() (they would ssh), the
 * conversation probe on the host, and the signal's file/agent reads.
 *
 * The same holds for an SSH proxy whose own login expired (2026-09-27: it read
 * as a transient proxy failure, retried every 3 seconds for 3 hours, and nothing
 * watched the proxy's login file).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-credential-redial'))
vi.mock('../../../src/providers/ssh-credential-evidence.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/providers/ssh-credential-evidence.js')>()),
  annotateCredentialFailure: async (err: unknown) => err,
}))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => ({ hosts: {
    devbox: { hostname: 'devbox.example.com', user: 'alice', label: 'Dev box' },
    coldbox: { hostname: 'coldbox.example.com', user: 'alice', label: 'Cold box' },
  } }),
}))
// A retry waits for its host at most this long (20s in production).
vi.mock('../../../src/core/sessions/host-start-gate.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  GATE_CONNECT_DEADLINE_MS: 400,
}))
// The conversation file exists on the host (the --resume-eligible shape).
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class { async findSessionPath() { return '/home/alice/.claude/projects/x/conv.jsonl' } },
}))
vi.mock('../../../src/core/session-file-reader.js', () => ({
  findLocalJsonlPath: async () => '/fake/projects/x/conv.jsonl',
}))

const dc = await import('../../../src/providers/daemon-connection.js')
const { credentialWaiters, redialAfterWake } = await import('../../../src/core/hosts/host-connect-action.js')
const { startHostCredentialSignal } = await import('../../../src/core/hosts/host-credential-signal.js')
const { clearReconnectCause } = await import('../../../src/providers/daemon-reconnect-cause.js')
const { HostWarmup } = await import('../../../src/core/hosts/host-warmup.js')
const { setHostWarmup } = await import('../../../src/core/hosts/host-warmup-registry.js')
const { WALNUT_HOME } = await import('../../../src/constants.js')
const { bus, EventNames } = await import('../../../src/core/event-bus.js')
const tracker = await import('../../../src/core/session-tracker.js')
const { closeDb } = await import('../../../src/core/session-db.js')
const { sendMessageToSession, getQueue } = await import('../../../src/core/session-message-queue.js')
const { retrySession } = await import('../../../src/core/sessions/session-lifecycle.js')
const { SessionControlError } = await import('../../../src/core/sessions/session-controls.js')

const CERT_EXPIRED = 'alice@devbox.example.com: Permission denied (publickey).\n'
  + 'walnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-09-29 06:10)'
/** A ProxyCommand's refusal in the shape one printed (names neutralized): colour codes, its sentence, ssh's line. */
const PROXY_LOGIN = [
  'Command failed: ssh alice@devbox.example.com sh -s',
  '\u001b[31m Error: Acme SSH Client returned an error when reaching to Acme SSH Proxy: \u001b[31m An error occured during the Acme authentication process. This is likely because your Acme cookie is invalid or expired. Please run "acme-login" to re-authenticate, then retry.',
  ' \u001b[0m',
  'Connection closed by UNKNOWN port 65535',
].join('\n')
type Internals = { _disconnectedSince: number | null; _connected: boolean; scheduleReconnect: (d: number) => void }
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

let conn: InstanceType<typeof dc.DaemonConnection>
let reconnect: ReturnType<typeof vi.spyOn>
/** What the next reconnect() does: 'expired' | 'ok' | 'hang'. */
let dial: 'expired' | 'ok' | 'hang'

/** devbox dropped and its loop met an expired login: failed on screen, a credential re-dial armed. */
async function devboxWaitingOnCredential(failure = CERT_EXPIRED, kind = 'cert_expired'): Promise<void> {
  conn = new dc.DaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'alice' })
  dc.setPooledConnectionForTest('devbox', conn)
  ;(conn as unknown as Internals)._disconnectedSince = Date.now()
  conn.setPhaseForTest('reconnecting')
  dial = 'expired'
  reconnect = vi.spyOn(conn as never, 'reconnect' as never).mockImplementation((async () => {
    if (dial === 'expired') throw new Error(failure)
    if (dial === 'hang') { await new Promise((r) => setTimeout(r, 2_000)); throw new Error(failure) }
    ;(conn as unknown as Internals)._connected = true
  }) as never)
  vi.spyOn(conn, 'connect').mockImplementation(async () => { throw new Error('connect() must not run: it would ssh for real') })
  ;(conn as unknown as Internals).scheduleReconnect(1)
  await settle()
  expect(conn.reconnectPending).toBe(true)
  const st = dc.getDaemonConnectState('devbox')
  expect(st.phase).toBe('failed')
  expect(st.kind).toBe(kind)
}

beforeEach(async () => {
  closeDb()
  tracker._resetSessionTrackerForTesting()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  for (const host of ['devbox', 'coldbox']) {
    dc.cancelReconnectBackoff(host)
    dc.clearDaemonFailureCache(host)
    dc.setPooledConnectionForTest(host, null)
    clearReconnectCause(host)
  }
  setHostWarmup(null)
  vi.restoreAllMocks()
  closeDb()
  tracker._resetSessionTrackerForTesting()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a renewed credential redials the waiting host', () => {
  it('reconnect loop: a certificate written after the failure reconnects at the next poll', async () => {
    await devboxWaitingOnCredential()
    const waiting = credentialWaiters(() => true)
    expect(waiting.map((w) => w.host)).toEqual(['devbox'])
    let newest = waiting[0].failedAt - 60_000     // the old certificate
    const sig = startHostCredentialSignal({
      waiting: () => credentialWaiters(() => true), redial: redialAfterWake,
      newestFileMtime: async () => newest, agentListing: async () => null,
      setInterval: () => ({}), clearInterval: () => {},
    })
    expect(await sig.poll()).toEqual([])
    expect(reconnect).toHaveBeenCalledTimes(1)

    dial = 'ok'
    newest = Date.now()                            // the login command wrote the new certificate
    expect(await sig.poll()).toEqual(['devbox'])
    await settle()
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(dc.isDaemonConnected('devbox')).toBe(true)
    // Connected: it waits on nothing any more.
    expect(credentialWaiters(() => true)).toEqual([])
  })

  it("proxy login expired: automatic callers fail fast instead of redialling, and the proxy's new login reconnects", async () => {
    await devboxWaitingOnCredential(PROXY_LOGIN, 'proxy_login')
    const st = dc.getDaemonConnectState('devbox')
    // The next try is on the credential clock (the first wait is a minute), not 3 seconds away.
    expect(st.retryAt! - Date.now()).toBeGreaterThan(50_000)
    expect(st.retryAt! - Date.now()).toBeLessThanOrEqual(60_000)
    expect(st.error ?? st.lastError ?? '').not.toContain('\u001b')
    // Every automatic caller (a JSONL read, a status probe) used to redial right away.
    for (let i = 0; i < 5; i++) {
      await expect(dc.getDaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'alice' })).rejects.toThrow()
    }
    expect(reconnect).toHaveBeenCalledTimes(1)

    const [w] = credentialWaiters(() => true)
    expect(w?.host).toBe('devbox')
    let newest = w.failedAt - 60_000
    const sig = startHostCredentialSignal({
      waiting: () => credentialWaiters(() => true), redial: redialAfterWake,
      newestFileMtime: async () => newest, agentListing: async () => null,
      setInterval: () => ({}), clearInterval: () => {},
    })
    expect(await sig.poll()).toEqual([])
    dial = 'ok'
    newest = Date.now()                            // the proxy's login command rewrote its cookie file
    expect(await sig.poll()).toEqual(['devbox'])
    await settle()
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(dc.isDaemonConnected('devbox')).toBe(true)
  })

  it('a disabled host is never redialled by the signal', async () => {
    await devboxWaitingOnCredential()
    expect(credentialWaiters((h) => h !== 'devbox')).toEqual([])
  })

  it('warmup: a host whose FIRST connect met the expired certificate is dialled again at the next poll', async () => {
    let fail = true
    const connect = vi.fn(async () => {
      if (fail) throw new Error(CERT_EXPIRED)
      return { connected: true }
    })
    const warmup = new HostWarmup({
      listHosts: async () => [{ key: 'coldbox', sshTarget: { hostname: 'coldbox.example.com', user: 'alice' } }],
      connect, isConnected: () => false, startupDelayMs: 0, paceMs: 0, resweepIntervalMs: 0,
      log: { info: () => {}, warn: () => {} },
    })
    setHostWarmup(warmup)
    warmup.start()
    try {
      await vi.waitFor(() => expect(warmup.credentialRetryAt('coldbox')).toBeGreaterThan(Date.now()))
      const [w] = credentialWaiters(() => true)
      expect(w?.host).toBe('coldbox')
      const sig = startHostCredentialSignal({
        waiting: () => credentialWaiters(() => true), redial: redialAfterWake,
        newestFileMtime: async () => w.failedAt + 1, agentListing: async () => null,
        setInterval: () => ({}), clearInterval: () => {},
      })
      fail = false
      expect(await sig.poll()).toEqual(['coldbox'])
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(warmup.stateOf('coldbox')).toBe('done'))
    } finally {
      warmup.stop()
    }
  })
})

describe('retrySession on a remote session dials its host like Connect now', () => {
  async function erroredRemoteSession(sid: string, host = 'devbox'): Promise<void> {
    await tracker.createSessionRecord(sid, `task-${sid}`, 'proj', '/home/alice/repo', { initialProcessStatus: 'error', host })
    await tracker.updateSessionRecord(sid, { errorMessage: 'Connection lost — unable to reach remote host' } as never)
    await sendMessageToSession(sid, 'the message I typed while it was down', { taskId: `task-${sid}` })
  }
  function captureSends() {
    const events: Array<{ name: string; data: unknown }> = []
    bus.subscribe('session-runner', (e) => { if (e.name === EventNames.SESSION_SEND) events.push({ name: e.name, data: e.data }) })
    return events
  }

  it('certificate renewed: the retry reconnects the host, then re-sends the queued message with a string payload', async () => {
    await devboxWaitingOnCredential()
    await erroredRemoteSession('retry-renewed')
    const sends = captureSends()
    dial = 'ok'
    const res = await retrySession('retry-renewed')
    expect(res).toMatchObject({ status: 'resuming', restoredMessages: 1 })
    expect(reconnect).toHaveBeenCalledTimes(2)     // the retry's dial, not a fail-fast
    expect(dc.isDaemonConnected('devbox')).toBe(true)
    expect(sends).toHaveLength(1)
    // The runner logs message.length: an absent message crashed the whole handler.
    expect(sends[0].data).toMatchObject({ sessionId: 'retry-renewed', message: '' })
  })

  it('certificate still expired: the click is answered with the host and its fix, nothing is sent, the queue is kept', async () => {
    await devboxWaitingOnCredential()
    await erroredRemoteSession('retry-expired')
    const sends = captureSends()
    const err = await retrySession('retry-expired').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(SessionControlError)
    expect((err as InstanceType<typeof SessionControlError>).statusCode).toBe(503)
    expect((err as Error).message).toMatch(/^Could not reach Dev box: .*certificate expired/i)
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(sends).toEqual([])
    expect((await getQueue('retry-expired')).map((m) => m.message)).toEqual(['the message I typed while it was down'])
    // The loop survives the failed click on its credential schedule.
    expect(conn.reconnectPending).toBe(true)
  })

  it('a dial still running at the deadline does not block the retry', async () => {
    await devboxWaitingOnCredential()
    await erroredRemoteSession('retry-slow')
    const sends = captureSends()
    dial = 'hang'
    const started = Date.now()
    const res = await retrySession('retry-slow')
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(res).toMatchObject({ status: 'resuming' })
    expect(sends).toHaveLength(1)
    await settle(2_100)                              // let the hanging dial finish before teardown
  })

  it('a connected host is not dialled again', async () => {
    await devboxWaitingOnCredential()
    ;(conn as unknown as Internals)._connected = true
    dc.cancelReconnectBackoff('devbox')
    await erroredRemoteSession('retry-connected')
    await retrySession('retry-connected')
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('a local session never touches a host', async () => {
    await tracker.createSessionRecord('retry-local', 'task-local', 'proj', '/tmp/rc', { initialProcessStatus: 'error' })
    const spy = vi.spyOn(dc, 'reconnectHostNow')
    const res = await retrySession('retry-local')
    expect(res.status).toBe('resumable')
    expect(spy).not.toHaveBeenCalled()
  })

  it('a host no longer in config keeps the old behaviour (the steps below decide)', async () => {
    await erroredRemoteSession('retry-unknown', 'gonebox')
    const sends = captureSends()
    const res = await retrySession('retry-unknown')
    expect(res).toMatchObject({ status: 'resuming' })
    expect(sends).toHaveLength(1)
  })
})
