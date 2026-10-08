/**
 * "Regenerate summary" is a person waiting: the project pane spins until the
 * route answers. Both regenerate routes ask for an INTERACTIVE model call, so
 * a claude-cli turn keeps the server's band instead of the utility band the
 * task-count maintainer's background refresh runs in (measured in deploy mode:
 * every claude call of a regenerate ran at priority 20 while it said
 * `background`). And the turn ends with the request: a client that closes it
 * (the tab closed, the client gave up) stops the model turn instead of leaving
 * it to hold a `claude` slot until its budget ran out.
 *
 * Real: routes, project-summary, task-manager on a temp home. Fake: sendMessage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-summary-regenerate-purpose'))

const sendMessageMock = vi.fn()
vi.mock('../../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}))

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import request from 'supertest'
import { projectsRouter } from '../../../src/web/routes/projects.js'
import { projectsV1Router } from '../../../src/web/routes/projects-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, _resetForTesting } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectsRouter)
  app.use('/api/v1', projectsV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetForTesting()
  sendMessageMock.mockReset()
  sendMessageMock.mockResolvedValue({ content: [{ type: 'text', text: '{"summary":"Marina work."}' }], stopReason: 'end_turn' })
})

afterEach(async () => {
  closeDb()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST .../summary/regenerate', () => {
  it.each([
    ['/api/projects/marina/summary/regenerate'],
    ['/api/v1/projects/marina/summary/regenerate'],
  ])('%s asks for an interactive model call', async (url) => {
    await addTask({ title: 'Tidy the dock schedule', project: 'marina' })
    const res = await request(createApp()).post(url)
    expect(res.status).toBe(200)
    expect(res.body.summary).toBe('Marina work.')
    expect(sendMessageMock).toHaveBeenCalled()
    for (const [opts] of sendMessageMock.mock.calls as Array<[{ purpose?: string }]>) expect(opts.purpose).toBe('interactive')
  })
})

describe('POST .../summary/regenerate when the client goes away', () => {
  it.each([
    ['/api/projects/marina/summary/regenerate'],
    ['/api/v1/projects/marina/summary/regenerate'],
  ])('%s stops the model turn once the request closes', async (url) => {
    await addTask({ title: 'Tidy the dock schedule', project: 'marina' })
    const signals: AbortSignal[] = []
    sendMessageMock.mockImplementation((opts: { signal: AbortSignal }) => new Promise((resolve) => {
      signals.push(opts.signal)
      opts.signal.addEventListener('abort', () => resolve({ content: [], stopReason: null, aborted: true }), { once: true })
    }))
    const server = createApp().listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    const { port } = server.address() as AddressInfo
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: url })
    req.on('error', () => { /* destroyed on purpose */ })
    req.end()
    try {
      const until = async (ok: () => boolean, what: string): Promise<void> => {
        const end = Date.now() + 10_000
        while (!ok()) {
          if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
          await new Promise((r) => setTimeout(r, 10))
        }
      }
      await until(() => signals.length === 1, 'the model call')
      await new Promise((r) => setTimeout(r, 50))
      expect(signals[0].aborted).toBe(false)
      req.destroy()
      await until(() => signals[0].aborted, 'the model call stopped')
    } finally {
      req.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    }
    expect(sendMessageMock).toHaveBeenCalledOnce()
  })
})
