/**
 * The plugin op route refuses a notice button whose moment passed (its `expiresAt`, sent by the
 * console in ACTION_EXPIRES_HEADER): a break's "End break" pressed after the break ended runs
 * nothing, whether the click raced the moment or came from a page that missed its redraw
 * (2026-11-22 review). The refusal comes before the op is looked up, so it holds for a relayed
 * call too; a call without the header (not a notice button, an older console) is unchanged.
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'
import { ACTION_EXPIRES_HEADER } from '../../../src/core/plugins/notice-action-expiry.js'

function app() {
  const callPrimaryOp = vi.fn(async () => ({ ok: true }))
  const deps = {
    registry: new IntegrationRegistry(),
    list: () => [],
    discover: vi.fn(),
    reload: vi.fn(),
    disable: vi.fn(),
    forgetBundled: vi.fn(async () => true),
    clearQuarantine: vi.fn(),
    walnutHome: '/nonexistent',
    bundledStoreDir: null,
    cloudMode: false,
    callPrimaryOp,
  }
  const server = express()
  server.use(express.json())
  server.use('/api/plugin-runtime', createPluginRuntimeRouter(deps as never))
  return { server, callPrimaryOp }
}

const OP_ROUTE = '/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_break_skip'

describe('a notice button past its moment', () => {
  it('is refused with 410 and a reason the button shows', async () => {
    const { server } = app()
    const res = await request(server).post(OP_ROUTE).set(ACTION_EXPIRES_HEADER, String(Date.now() - 1_000)).send({}).expect(410)
    expect(res.body.error).toBe('This button is no longer available: the moment it was for has passed')
  })

  it('one still ahead, or a call with no expiry, goes on to the op (here: no such plugin)', async () => {
    const { server } = app()
    await request(server).post(OP_ROUTE).set(ACTION_EXPIRES_HEADER, String(Date.now() + 60_000)).send({}).expect(404)
    await request(server).post(OP_ROUTE).send({}).expect(404)
  })

  it('a relayed call (a companion) is refused before it reaches the Mac', async () => {
    const callPrimaryOp = vi.fn(async () => ({ ok: true }))
    const server = express()
    server.use(express.json())
    server.use('/api/plugin-runtime', createPluginRuntimeRouter({
      registry: new IntegrationRegistry(), list: () => [], walnutHome: '/nonexistent', bundledStoreDir: null,
      cloudMode: true, callPrimaryOp,
    } as never))
    await request(server).post(OP_ROUTE).set(ACTION_EXPIRES_HEADER, String(Date.now() - 1)).send({}).expect(410)
    expect(callPrimaryOp).not.toHaveBeenCalled()
    await request(server).post(OP_ROUTE).send({}).expect(200)
    expect(callPrimaryOp).toHaveBeenCalledTimes(1)
  })
})
