/**
 * A pooled direct connection that was disconnected and then dialled again must
 * notice its next loss like any other connection.
 *
 * disconnect() marks an instance destroyed. connect() clears that mark when it
 * dials again, connectDirect() did not, so a direct connection dialled after a
 * disconnect was connected AND destroyed. Its next socket close was then ignored
 * (handleConnectionLost returns early on a destroyed instance), `connected` stayed
 * true over a dead socket, every command waited out its 30 s timer, and
 * getDirectDaemonConnection kept handing out the dead link instead of dialling.
 * 2026-10-17: the replica browser fixture's Mac never reached its host again after
 * the second lid close (the first close had replaced the pooled link through the
 * "ssh target changed" path, which disconnects it).
 *
 * Real DaemonConnection and pool, mock daemon over real WebSockets.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DaemonConnection, getDirectDaemonConnection } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) return false
    await sleep(10)
  }
  return true
}

describe('DaemonConnection: a direct connection dialled again after disconnect()', () => {
  let daemon: MockDaemon
  let url = ''
  const opened: DaemonConnection[] = []

  beforeEach(async () => {
    daemon = await createMockDaemon()
    url = `ws://127.0.0.1:${daemon.port}`
  })

  afterEach(async () => {
    for (const c of opened.splice(0)) { try { c.disconnect() } catch { /* best effort */ } }
    await daemon.stop()
  })

  /** The daemon closes every socket this connection holds (a host closing a silent client). */
  async function hostClosesAll(): Promise<void> {
    for (let i = 0; i < 16; i++) daemon.killClient(i)
    await until(() => daemon.clientCount === 0)
  }

  it('sees the next loss: not connected once the host closes it, and the pool dials a live link', async () => {
    const first = await getDirectDaemonConnection('redial-host', url)
    opened.push(first)
    expect(first.connected).toBe(true)
    // What the pool's "ssh target changed" replacement does to the instance.
    first.disconnect()
    expect(first.connected).toBe(false)

    // Dialled again through the pool: the same instance, connected.
    const again = await getDirectDaemonConnection('redial-host', url)
    opened.push(again)
    expect(again.connected).toBe(true)
    await expect(again.send('ping', {}, 2_000)).resolves.toMatchObject({ ok: true })

    // The host closes it: the loss is seen.
    await hostClosesAll()
    expect(await until(() => !again.connected), 'connected stayed true over a closed socket').toBe(true)

    // The next lookup dials, and the link it hands out answers.
    const live = await getDirectDaemonConnection('redial-host', url)
    opened.push(live)
    expect(live.connected).toBe(true)
    await expect(live.send('ping', {}, 2_000)).resolves.toMatchObject({ ok: true })
  })

  it('a disconnect() that stays a disconnect: no dial, so no reconnect of its own', async () => {
    const conn = await getDirectDaemonConnection('redial-host-2', url)
    opened.push(conn)
    conn.disconnect()
    const before = daemon.clientCount
    await sleep(2_500)
    expect(conn.connected).toBe(false)
    expect(daemon.clientCount).toBeLessThanOrEqual(before)
  })
})
