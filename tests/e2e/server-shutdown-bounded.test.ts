/**
 * The real server's stop finishes well inside the shutdown bail
 * (commands/web.ts SHUTDOWN_BAIL_MS) with connections still open on it, and
 * dials no daemon link once it began (2026-11-10: 26 deploys in a day were cut
 * off at the bail by a long poll still open, and the outgoing server re-dialled
 * a host and resumed a session meanwhile).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { SHUTDOWN_BAIL_MS } from '../../src/commands/web.js'
import { daemonDialsClosed } from '../../src/providers/daemon-dial-gate.js'
import { getDaemonConnection } from '../../src/providers/daemon-connection.js'

const sockets: net.Socket[] = []
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  for (const s of sockets) s.destroy()
  await stopServer().catch(() => {})
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch
})

async function raw(port: number, text: string): Promise<net.Socket> {
  const s = net.connect(port, '127.0.0.1')
  sockets.push(s)
  s.on('error', () => {})
  await new Promise<void>((r) => s.once('connect', () => r()))
  s.write(text)
  return s
}

function portOf(server: HttpServer): number {
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

describe('server stop with connections open', () => {
  it('finishes inside the bail and refuses daemon dials from its start', async () => {
    const server = await startServer({ port: 0, dev: true })
    expect(daemonDialsClosed()).toBe(false)
    const port = portOf(server)
    // An idle keep-alive socket after one answer, and a request still arriving.
    const idle = await raw(port, 'GET /api/config HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n')
    await new Promise<void>((r) => idle.once('data', () => r()))
    await raw(port, 'POST /api/v1/tasks HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"ti')
    await new Promise((r) => setTimeout(r, 100))

    const t0 = Date.now()
    const stopping = stopServer({ reason: 'SIGTERM' })
    // From the stop's first step: no link is dialled.
    expect(daemonDialsClosed()).toBe(true)
    await expect(getDaemonConnection('stop-host', { hostname: 'stop-host.invalid' })).rejects.toThrow(/shutting down/)
    await stopping
    const ms = Date.now() - t0
    // A stop held by an open connection never ends (60 s here before the fix); a margin for load.
    expect(ms).toBeLessThan(SHUTDOWN_BAIL_MS - 1_000)

    // The next server in this process dials again.
    const next = await startServer({ port: 0, dev: true })
    expect(daemonDialsClosed()).toBe(false)
    expect(portOf(next)).toBeGreaterThan(0)
    await stopServer()
  }, 60_000)
})
