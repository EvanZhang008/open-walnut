/**
 * The close of a socket that some other dial replaced (DaemonConnection's close
 * handler, `this.ws === ws`). That socket speaks only for itself:
 * - the live link stays up and keeps answering (a close that tore it down
 *   dropped a healthy connection whenever the dial race left a second socket);
 * - what was written on the old socket fails at once, with an error that reads
 *   "may have landed", so the sender's confirmSend asks again instead of waiting
 *   out its 30 s timer.
 * Real DaemonConnection, mock daemon over real WebSockets. The second socket is
 * the connection's own dial (connectWebSocket), so it is wired like any other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { WebSocket } from 'ws'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { sendMayHaveLanded } from '../../src/providers/delivery-failure.js'

type Priv = { ws: WebSocket | null; connectWebSocket(url: string): Promise<void> }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await sleep(5)
}

describe('DaemonConnection: a socket some other dial replaced closes', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection
  let url = ''

  beforeEach(async () => {
    daemon = await createMockDaemon()
    url = `ws://127.0.0.1:${daemon.port}`
    conn = new DaemonConnection('replaced-host', { hostname: '127.0.0.1', user: undefined, port: undefined })
    await conn.connectDirect(url)
  })

  afterEach(async () => {
    try { conn.disconnect() } catch { /* best effort */ }
    await daemon.stop()
  })

  /** A second socket of this connection takes over, then the first one closes. */
  async function replaceThenCloseOld(): Promise<WebSocket> {
    const priv = conn as unknown as Priv
    const old = priv.ws!
    await priv.connectWebSocket(url)
    expect(priv.ws).not.toBe(old)
    // Registered after the connection's own close listener, so it runs after it.
    const closed = new Promise<void>((r) => old.once('close', () => r()))
    old.terminate()
    await closed
    return priv.ws!
  }

  it('leaves the live link up: still connected, on the replacement, and it answers', async () => {
    const live = await replaceThenCloseOld()
    expect(conn.connected).toBe(true)
    expect((conn as unknown as Priv).ws).toBe(live)
    await expect(conn.send('ping', {}, 2_000)).resolves.toMatchObject({ ok: true })
  })

  it('fails a send written on the old socket at once, as one that may have landed', async () => {
    daemon.swallowNextCommand('send')
    const outcome = conn.send('send', { sid: 's-1', message: 'hello', uuid: 'u-1' }, 30_000)
      .then(() => null, (e: Error) => e)
    await until(() => daemon.getCommandHistoryFor('send').length > 0)
    const t0 = Date.now()
    await replaceThenCloseOld()
    const err = await Promise.race([outcome, sleep(3_000).then(() => 'still pending after 3 s' as const)])
    expect(err).toBeInstanceOf(Error)
    expect(sendMayHaveLanded(err)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(conn.connected).toBe(true)
  })
})
