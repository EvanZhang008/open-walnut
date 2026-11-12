/**
 * Favorites on the cloud companion (a replica): its config.yaml is machine-local (no sync
 * carries it), so the favorites are the Mac's.
 *
 *   - a console write is carried to the Mac's phone twin over the bridge (`server.http`),
 *     never made in the box's own config;
 *   - with the Mac not reached, the write answers 503 needs_leader, still not made here;
 *   - a write a phone call brought to the box's route (the forward chose to answer here)
 *     waits for the Mac too;
 *   - a read answers the Mac's prefs copy once a round landed, the box's config before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-favorites-follower', { CLOUD_MODE: true }))

const relay = vi.hoisted(() => ({
  calls: [] as Array<{ action: string; params: Record<string, unknown> }>,
  reply: null as unknown,
}))
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()),
  callPrimaryControl: async (action: string, _sid: string, params: Record<string, unknown>) => {
    relay.calls.push({ action, params })
    return relay.reply
  },
}))

const copy = vi.hoisted(() => ({ asOf: null as number | null, favorites: { projects: ['Acme'], notes: ['notes/acme.md'] } }))
vi.mock('../../../src/core/replication/kinds/gate.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/replication/kinds/gate.js')>()),
  copyKindAsOf: async () => copy.asOf,
}))
vi.mock('../../../src/core/replication/kinds/prefs.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/replication/kinds/prefs.js')>()),
  readFavoritesCopy: async () => copy.favorites,
}))

import express from 'express'
import request from 'supertest'
import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { editFavorites, favoritesRouter } from '../../../src/web/routes/favorites.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/favorites', favoritesRouter)
  a.use(errorHandler)
  return a
}

const BOX = { projects: ['BoxOnly'], notes: [] as string[] }

async function boxConfig(): Promise<{ favorites?: { projects?: string[] } }> {
  return yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as { favorites?: { projects?: string[] } }
}

beforeEach(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({ version: 1, favorites: BOX }))
  relay.calls = []
  relay.reply = null
  copy.asOf = null
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('favorites on the companion', () => {
  it('a console write goes to the Mac\'s phone twin, and the box\'s config is left alone', async () => {
    const macBody = Buffer.from(JSON.stringify({ projects: ['Acme', 'Home Lab'] })).toString('base64')
    relay.reply = { ok: true, result: { status: 200, headers: {}, data: macBody, size: 10 } }
    const res = await request(app()).post('/api/favorites/projects/Home%20Lab')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ projects: ['Acme', 'Home Lab'] })
    expect(relay.calls).toHaveLength(1)
    expect(relay.calls[0]!.action).toBe('server.http')
    expect(relay.calls[0]!.params).toMatchObject({ method: 'POST', url: '/api/v1/favorites/projects/Home%20Lab' })
    expect((await boxConfig()).favorites?.projects).toEqual(['BoxOnly'])
  })

  it('a note write carries its body to the Mac', async () => {
    relay.reply = { ok: true, result: { status: 200, headers: {}, data: Buffer.from('{"notes":["a.md"]}').toString('base64'), size: 18 } }
    const res = await request(app()).delete('/api/favorites/notes').send({ path: 'a.md' })
    expect(res.status).toBe(200)
    const p = relay.calls[0]!.params
    expect(p).toMatchObject({ method: 'DELETE', url: '/api/v1/favorites/notes' })
    expect(JSON.parse(Buffer.from(String(p.data), 'base64').toString('utf8'))).toEqual({ path: 'a.md' })
  })

  it('with the Mac not reached, the write needs the Mac and is not made here', async () => {
    relay.reply = { ok: false, failure: { kind: 'bridge_offline', message: 'no bridge', notSent: true } }
    const res = await request(app()).post('/api/favorites/projects/Acme')
    expect(res.status).toBe(503)
    expect(res.body.error).toMatchObject({ code: 'needs_leader', why: 'prefs_writes_need_mac' })
    expect((await boxConfig()).favorites?.projects).toEqual(['BoxOnly'])
  })

  it('a write that went out and got no answer says the Mac may hold it', async () => {
    relay.reply = { ok: false, failure: { kind: 'bridge_offline', message: 'timeout' } }
    const res = await request(app()).post('/api/favorites/projects/Acme')
    expect(res.status).toBe(504)
    expect(res.body.error).toMatchObject({ code: 'primary_timeout', sent: true })
  })

  it('an error the relay answered with is passed on as it is', async () => {
    relay.reply = { ok: false, failure: { kind: 'error', status: 409, code: 'conflict', message: 'busy' } }
    const res = await request(app()).post('/api/favorites/projects/Acme')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'conflict', message: 'busy' })
    expect((await boxConfig()).favorites?.projects).toEqual(['BoxOnly'])
  })

  it('a 504 the relay answered (the Mac\'s route ran past its time) says the Mac may hold it', async () => {
    relay.reply = { ok: false, failure: { kind: 'error', status: 504, code: 'forward_failed', message: 'slow' } }
    const res = await request(app()).post('/api/favorites/projects/Acme')
    expect(res.status).toBe(504)
    expect(res.body.error).toMatchObject({ code: 'primary_timeout', sent: true })
  })

  it('a phone write that reached the box waits for the Mac', async () => {
    await expect(editFavorites((f) => { f.projects.push('Acme') })).rejects.toMatchObject({ code: 'needs_leader', why: 'prefs_writes_need_mac' })
    expect((await boxConfig()).favorites?.projects).toEqual(['BoxOnly'])
  })

  it('a read answers the Mac\'s copy once a round landed, the box\'s config before', async () => {
    const before = await request(app()).get('/api/favorites')
    expect(before.body).toEqual(BOX)
    copy.asOf = 1_700_000_000_000
    const after = await request(app()).get('/api/favorites')
    expect(after.status).toBe(200)
    expect(after.body).toEqual(copy.favorites)
    expect(after.headers['x-walnut-copy-as-of']).toBe(String(copy.asOf))
  })
})
