/**
 * A link failure is told apart from the work's own error by a tag the pool puts
 * on it where it raises it (providers/link-failure.ts), never by its words. The
 * request path reads the tag: a read that began disconnected and whose dial
 * failed at once answered the dial's raw text as a 500 (gate review,
 * 2026-10-05), because the words matched no pattern and the pool had moved on.
 *
 * No ssh: connect() is stubbed and the socket is a fake object.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  DaemonConnection, clearDaemonFailureCache, getDaemonConnection, setPooledConnectionForTest,
} from '../../src/providers/daemon-connection.js'
import { linkFailureKind, markLinkFailure } from '../../src/providers/link-failure.js'

const TARGET = { hostname: 'devbox.example.com', user: 'alice' }

describe('the tag', () => {
  it('rides the error invisibly: same message, same class, same JSON', () => {
    const err = new TypeError('fetch failed')
    expect(markLinkFailure(err, 'lost')).toBe(err)
    expect(linkFailureKind(err)).toBe('lost')
    expect(err.message).toBe('fetch failed')
    expect(err).toBeInstanceOf(TypeError)
    expect(Object.keys(err)).toEqual([])
    expect(JSON.stringify({ e: { ...err } })).toBe('{"e":{}}')
  })

  it('the first tag wins; untagged, frozen and non-object errors are the work\'s own', () => {
    const err = markLinkFailure(new Error('x'), 'no-link')
    markLinkFailure(err, 'no-answer')
    expect(linkFailureKind(err)).toBe('no-link')
    expect(linkFailureKind(new Error('DaemonConnection not connected to devbox'))).toBeNull()
    const frozen = Object.freeze(new Error('frozen'))
    expect(markLinkFailure(frozen, 'lost')).toBe(frozen)
    expect(linkFailureKind(frozen)).toBeNull()
    for (const v of [null, undefined, 'text', 42]) {
      expect(markLinkFailure(v, 'lost')).toBe(v)
      expect(linkFailureKind(v)).toBeNull()
    }
  })
})

describe('the pool tags every link failure where it raises it', () => {
  let conn: DaemonConnection | null = null
  afterEach(() => {
    vi.useRealTimers()
    clearDaemonFailureCache('devbox')
    setPooledConnectionForTest('devbox', null)
    conn = null
  })

  /** A connection that believes it is up, over a socket that takes every frame and answers none. */
  function upWithSilentSocket(): DaemonConnection {
    const c = new DaemonConnection('devbox', TARGET)
    const ws = { readyState: WebSocket.OPEN, send: () => {}, close: () => {}, terminate: () => {}, removeAllListeners: () => {}, on: () => {} }
    Object.assign(c as unknown as Record<string, unknown>, { _connected: true, ws })
    return c
  }

  it('a command with nothing connected is no-link', async () => {
    conn = new DaemonConnection('devbox', TARGET)
    const err = await conn.send('fs.ls', { path: '/w' }).catch((e) => e)
    expect(err.message).toBe('DaemonConnection not connected to devbox')
    expect(linkFailureKind(err)).toBe('no-link')
  })

  it('a dial that fails, and the failure the pool then remembers, are no-link', async () => {
    conn = new DaemonConnection('devbox', TARGET)
    setPooledConnectionForTest('devbox', conn)
    vi.spyOn(conn, 'connect').mockRejectedValue(new Error('Command failed: ssh devbox.example.com sh -s\nssh: connect to host devbox.example.com port 22: Connection refused'))
    const dial = await getDaemonConnection('devbox', TARGET).catch((e) => e)
    expect(dial.message).toMatch(/^Command failed: ssh /)
    expect(linkFailureKind(dial)).toBe('no-link')
    const cached = await getDaemonConnection('devbox', TARGET).catch((e) => e)
    expect(cached.message).toMatch(/^Connection to devbox failed \d+s ago: /)
    expect(linkFailureKind(cached)).toBe('no-link')
  })

  it('a command the link never answers is no-answer', async () => {
    vi.useFakeTimers()
    conn = upWithSilentSocket()
    const pending = conn.send('fs.ls', { path: '/w' }, 50).catch((e) => e)
    await vi.advanceTimersByTimeAsync(60)
    const err = await pending
    expect(err.message).toMatch(/^daemon command timeout: fs\.ls \(50ms\)/)
    expect(linkFailureKind(err)).toBe('no-answer')
  })

  it('a command whose socket closes before its answer is lost (the daemon answers on that socket only)', async () => {
    conn = upWithSilentSocket()
    const ws = (conn as unknown as { ws: unknown }).ws
    const pending = conn.send('fs.ls', { path: '/w' }).catch((e) => e)
    ;(conn as unknown as { failPendingOn: (s: unknown) => void }).failPendingOn(ws)
    const err = await pending
    expect(err.message).toMatch(/^daemon command lost: fs\.ls: connection closed before devbox answered/)
    expect(linkFailureKind(err)).toBe('lost')
  })

  it('a command waiting when the connection goes away is lost', async () => {
    conn = upWithSilentSocket()
    // Its cleanup would ask ssh to close a ControlMaster this test never opened.
    vi.spyOn(conn as never, 'stopControlMaster' as never).mockImplementation((async () => {}) as never)
    const pending = conn.send('fs.write', { path: '/w/a.ts' }).catch((e) => e)
    conn.disconnect()
    const err = await pending
    expect(err.message).toBe('connection closed')
    expect(linkFailureKind(err)).toBe('lost')
  })

  it('a command waiting when a silent link is dropped is lost: it may have run there (a save says "may not have landed")', async () => {
    conn = upWithSilentSocket()
    // The reconnect that follows belongs to the pool, not to this test.
    const lostLink = vi.spyOn(conn as never, 'handleConnectionLost' as never).mockImplementation((() => {}) as never)
    const ws = (conn as unknown as { ws: unknown }).ws
    const pending = conn.send('fs.write', { path: '/w/a.ts' }).catch((e) => e)
    ;(conn as unknown as { dropSilentLink: (s: unknown) => void }).dropSilentLink(ws)
    const err = await pending
    expect(err.message).toBe('DaemonConnection not connected to devbox: the link stopped answering')
    expect(linkFailureKind(err)).toBe('lost')
    expect(lostLink).toHaveBeenCalledTimes(1)
  })
})
