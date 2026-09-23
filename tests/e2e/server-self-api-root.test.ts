/**
 * A listening server's own op executor targets THAT server.
 *
 * The in-server executor (the path a session's `walnut` call takes after the
 * daemon gateway relays it: capability-router → executeOp) resolved its target
 * from OPEN_WALNUT_API_URL / :3456. A test server launched from a session of the
 * real Walnut inherits that session's URL, so its ops wrote into the real
 * Walnut. Here the inherited URL points at a DEAD port on purpose: a regression
 * fails loudly instead of writing into whatever listens on :3456.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-self-api-root'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getSelfApiRoot } from '../../src/lib/self-api-root.js'
import { executeOp, resolveApiBase } from '../../src/ops/index.js'
import { addTask } from '../../src/core/task-manager.js'

let server: HttpServer
let port: number
let inherited: string
let stopped = false
const saved = process.env.OPEN_WALNUT_API_URL

async function closedPort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const addr = probe.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return addr.port
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  inherited = `http://127.0.0.1:${await closedPort()}`
  process.env.OPEN_WALNUT_API_URL = inherited
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 60_000)

afterAll(async () => {
  // A `-t` filtered run skips the stop case below; never leak the server.
  if (!stopped) await stopServer().catch(() => {})
  if (saved === undefined) delete process.env.OPEN_WALNUT_API_URL
  else process.env.OPEN_WALNUT_API_URL = saved
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('server self API root', () => {
  it('claims its own root at listen, over an inherited OPEN_WALNUT_API_URL', () => {
    expect(getSelfApiRoot()).toBe(`http://127.0.0.1:${port}`)
    expect(process.env.OPEN_WALNUT_API_URL).toBe(`http://127.0.0.1:${port}`)
    expect(resolveApiBase()).toBe(`http://127.0.0.1:${port}/api/v1`)
  })

  it('an in-server op with no explicit base lands on this server', async () => {
    // The task exists only in THIS server's store, and the inherited URL is a
    // dead port: the read can only succeed by reaching this server. A read op
    // keeps the probe free of any start-work side effect.
    const title = `self-root probe ${Date.now()}`
    const { task } = await addTask({ title })
    const outcome = await executeOp('task_get', { id: task.id })
    expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
    expect(JSON.stringify(outcome.ok ? outcome.result : null)).toContain(title)
  })

  it('keeps its root while shutdown drains, then hands the env back exactly as it found it', async () => {
    const self = `http://127.0.0.1:${port}`
    const stopping = stopServer()
    stopped = true
    // Work still in flight during shutdown must not fall back to the inherited
    // URL (in real life, :3456): the root is released only after the HTTP close.
    expect(getSelfApiRoot()).toBe(self)
    expect(resolveApiBase()).toBe(`${self}/api/v1`)
    await stopping
    expect(getSelfApiRoot()).toBeNull()
    expect(process.env.OPEN_WALNUT_API_URL).toBe(inherited)
  })
})
