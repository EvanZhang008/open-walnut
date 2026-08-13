/**
 * /api/keep-awake routes — real startServer({ port: 0, dev: true }) with an
 * isolated temp home. The feature is OFF by default, so the forced poll goes
 * down the 'disabled' path and never touches the machine's real pmset.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-keepawake-routes'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'

let server: HttpServer
let port: number

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('/api/keep-awake', () => {
  it('GET returns the monitor state and the sudo setup command', async () => {
    const res = await fetch(`http://localhost:${port}/api/keep-awake`)
    expect(res.status).toBe(200)
    const body = await res.json() as { state: Record<string, unknown>; sudoSetupCommand: string }
    expect(body.state.enabled).toBe(false)
    expect(body.state.holding).toBe(false)
    expect(body.sudoSetupCommand).toContain('pmset disablesleep')
  })

  it('POST /poll evaluates immediately and reports disabled by default', async () => {
    const res = await fetch(`http://localhost:${port}/api/keep-awake/poll`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { state: { enabled: boolean; holding: boolean; reason: string } }
    expect(body.state.enabled).toBe(false)
    expect(body.state.holding).toBe(false)
    expect(['disabled', 'unsupported']).toContain(body.state.reason)
  })
})
