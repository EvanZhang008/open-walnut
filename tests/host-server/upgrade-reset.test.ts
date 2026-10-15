/**
 * The plain host server (src/host-server/main.ts) while it answers alone: a
 * WebSocket upgrade is refused 503 on the spot, with no forward to add an error
 * listener to the socket. Node drops its own listener before it emits
 * 'upgrade', so a client that resets after that 503 used to raise an uncaught
 * ECONNRESET and end the program. This program is the daemon's fallback while
 * the Mac is away, which is exactly when it answers alone, and anyone who can
 * reach the tunnel could end it with no token.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { startHostServer, type HostServer } from '../../src/host-server/main.js'

let dir = ''
let hs: HostServer

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-upgrade-reset-'))
  // A daemon dir with no daemon in it: the server answers alone ('no-daemon').
  hs = await startHostServer({
    env: { publicPort: 0, daemonDir: path.join(dir, 'd'), leaderHome: '/fixture/marina-home', walnutId: 'wresetupg01', followerToken: 'tok-marina', label: 'marina' },
  })
}, 60_000)

afterAll(async () => {
  await hs?.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

const UPGRADE = 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'

/** An upgrade, then a reset (RST) a moment later: unread bytes make the close an RST. */
function upgradeThenReset(port: number, afterMs: number): Promise<void> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(UPGRADE)
      setTimeout(() => { c.write('more bytes the server never reads'); c.resetAndDestroy(); resolve() }, afterMs)
    })
    c.on('error', () => {})
  })
}

/** The status line the server answers an upgrade with. */
function upgradeStatus(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(UPGRADE))
    let text = ''
    c.on('data', (b) => { text += String(b) })
    c.on('close', () => resolve(text.split('\r\n')[0] ?? ''))
    c.on('error', reject)
  })
}

describe('the host server answering alone', () => {
  it('a client that resets its upgrade after the 503 raises nothing, and the server keeps answering', async () => {
    expect(hs.route().kind).toBe('alone')
    const uncaught: string[] = []
    const onErr = (err: Error) => { uncaught.push(`${(err as Error & { code?: string }).code ?? ''} ${err.message}`) }
    process.on('uncaughtException', onErr)
    try {
      for (let i = 0; i < 20; i++) await upgradeThenReset(hs.port, i % 2 ? 5 : 30)
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      process.off('uncaughtException', onErr)
    }
    expect(uncaught).toEqual([])
    expect(await upgradeStatus(hs.port)).toBe('HTTP/1.1 503 Service Unavailable')
  })
})
