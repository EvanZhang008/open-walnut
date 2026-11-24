/**
 * An engine switch whose new session a setting refuses (a Codex provider that reaches nothing on
 * the task's host, codex-engine-config.ts) answers what a start answers (task-start.ts): 422
 * `engine_config` with the setting's words, never a 500 an agent would retry as it is.
 *
 * The real route over a stubbed switch.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { QuickStartError } from '../../src/core/sessions/quick-start.js'

const refusal = 'Task t1 could not start: engines.codex: provider "local-proxy" is at http://127.0.0.1:8402/v1, a loopback address of the machine whose config it is, so it reaches nothing on host "devbox".'
let next: () => Promise<unknown> = async () => { throw new QuickStartError(refusal, 422, { code: 'engine_config' }) }

vi.mock('../../src/core/sessions/engine-switch.js', () => ({
  requestEngineSwitch: () => next(),
}))

const { engineSwitchV1Router } = await import('../../src/web/routes/engine-switch-v1.js')

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', engineSwitchV1Router)
  app.use((err: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'internal' })
  })
  server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)) })
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { await new Promise((r) => server.close(r)) })

const post = (body: unknown) => fetch(`${base}/api/v1/tasks/t1/switch-engine`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describe('the launch routes read a setting\'s refusal as engine_config', () => {
  it('launchErrorCodeOf keeps engine_config, and reads every other refusal by its status', async () => {
    const { launchErrorCodeOf } = await import('../../src/core/sessions/mobile-launch.js')
    expect(launchErrorCodeOf(new QuickStartError(refusal, 422, { code: 'engine_config' }))).toBe('engine_config')
    expect(launchErrorCodeOf(new QuickStartError('busy', 409, { code: 'something_else' }))).toBe('conflict')
    expect(launchErrorCodeOf(new QuickStartError('broke', 502))).toBe('internal')
  })
})

describe('an engine switch refused by a setting', () => {
  it('answers 422 engine_config with the setting\'s words', async () => {
    const res = await post({ engine: 'codex', text: 'go on' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: refusal, code: 'engine_config' })
  })

  it('a start error with no code of its own still goes to the server\'s error answer', async () => {
    next = async () => { throw new QuickStartError('Task t1 could not start: the worker exited', 502) }
    const res = await post({ engine: 'codex', text: 'go on' })
    expect(res.status).toBe(500)
  })
})
