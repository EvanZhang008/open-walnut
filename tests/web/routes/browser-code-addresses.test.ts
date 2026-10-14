/**
 * POST /api/devices/browser-code names every address a phone can open Walnut at
 * (src/web/routes/browser-pair.ts): this computer's tunnel, and the tunnel of each
 * server on its hosts that is running and connected, which stays up while this
 * computer sleeps. A code minted here works there (the host server forwards
 * sign-in to this Mac), so each address carries the same code after `#pair=`.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  own: null as null | { state: string; url?: string },
  hosts: {} as Record<string, { label?: string; cloud_box?: boolean }>,
  views: {} as Record<string, unknown>,
  person: true,
}))

vi.mock('../../../src/web/expose-runtime.js', () => ({ getExposeRuntime: () => (state.own ? { status: () => state.own } : null) }))
vi.mock('../../../src/web/routes/expose.js', () => ({ isPersonAtThisMachine: () => state.person }))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: state.hosts }) }))
vi.mock('../../../src/core/host-server/index.js', () => ({
  getHostServerManager: () => ({ view: (key: string) => state.views[key] ?? { hostKey: key, enabled: false, phase: 'off', since: 0 } }),
}))

import { browserCodeRouter } from '../../../src/web/routes/browser-pair.js'

const app = () => express().use(express.json()).use('/api/devices', browserCodeRouter)
const running = (url: string, connected = true) => ({
  hostKey: 'x', enabled: true, phase: 'running', since: 0,
  server: { expose: { enabled: true, state: connected ? 'connected' : 'starting', url } },
})

beforeEach(() => {
  state.own = null
  state.hosts = {}
  state.views = {}
  state.person = true
})

describe('browser sign-in addresses', () => {
  it('names this computer and every connected host server, each with the code', async () => {
    state.own = { state: 'connected', url: 'https://mac.example.test/' }
    state.hosts = { devbox: { label: 'Dev box' }, spare: {}, idle: {}, cloud: { cloud_box: true } }
    state.views = {
      devbox: running('https://devbox.example.test'),
      spare: running('https://spare.example.test', false),
      cloud: running('https://cloud.example.test'),
    }
    const res = await request(app()).post('/api/devices/browser-code').expect(200)
    const code = res.body.code as string
    expect(res.body.addresses).toEqual([
      { where: 'this-computer', label: 'This computer', url: 'https://mac.example.test/', link: `https://mac.example.test/#pair=${code}`, alwaysOn: false },
      { where: 'devbox', label: 'Dev box', url: 'https://devbox.example.test', link: `https://devbox.example.test/#pair=${code}`, alwaysOn: true },
    ])
    // The fields an older page reads stay this computer's.
    expect(res.body.link).toBe(`https://mac.example.test/#pair=${code}`)
  })

  it('with this computer\'s tunnel off, the host is the link', async () => {
    state.hosts = { devbox: {} }
    state.views = { devbox: running('https://devbox.example.test') }
    const res = await request(app()).post('/api/devices/browser-code').expect(200)
    expect(res.body.link).toBe(`https://devbox.example.test/#pair=${res.body.code}`)
    expect(res.body.addresses).toHaveLength(1)
  })

  it('no tunnel anywhere: a code with no address, as before', async () => {
    const res = await request(app()).post('/api/devices/browser-code').expect(200)
    expect(res.body.code).toEqual(expect.any(String))
    expect(res.body.link).toBeUndefined()
    expect(res.body.addresses).toEqual([])
  })

  it('only the person at this computer mints one', async () => {
    state.person = false
    await request(app()).post('/api/devices/browser-code').expect(403)
  })
})
