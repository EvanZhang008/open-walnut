/**
 * Voice input's media hold through a REAL server: the route, the setting in config.yaml,
 * and the `stt:media-hold` broadcast a page playing Walnut's own music listens to.
 * The player is a stub (no sound, no osascript): _setMediaControllerForTest.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'
import { WebSocket } from 'ws'

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { _setMediaControllerForTest, fakeMediaController } from '../../src/core/stt/media-hold-runtime.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'

let server: HttpServer
let port: number
let ws: WebSocket
const frames: Array<{ name?: string; data?: unknown }> = []
let fake = fakeMediaController()

async function post(body: unknown) {
  const r = await fetch(`http://localhost:${port}/api/stt/media-hold`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, data: await r.json() as Record<string, unknown> }
}

async function waitFor<T>(probe: () => T | undefined, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const hit = probe()
    if (hit !== undefined) return hit
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  ws = new WebSocket(`ws://localhost:${port}/ws`)
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
}, 60_000)

beforeEach(async () => {
  fake = fakeMediaController()
  _setMediaControllerForTest(fake.controller)
  frames.length = 0
  await updateConfig({ stt: { ...(await getConfig()).stt, pause_media: undefined } })
})

afterAll(async () => {
  _setMediaControllerForTest(undefined)
  ws?.close()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('POST /api/stt/media-hold', () => {
  it('default on: hold pauses, the page hears it, release plays the same player again', async () => {
    const held = await post({ id: 'web-e2e00001', action: 'hold', source: 'mic' })
    expect(held.data).toMatchObject({ enabled: true, active: true, paused: ['Fake Player'] })
    expect(fake.state.playing).toBe(false)
    await waitFor(() => frames.find((f) => f.name === 'stt:media-hold' && (f.data as { active?: boolean }).active === true))

    const released = await post({ id: 'web-e2e00001', action: 'release' })
    expect(released.data).toMatchObject({ active: false, paused: [] })
    expect(fake.calls).toEqual(['pause', 'resume'])
    expect(fake.state.playing).toBe(true)
    await waitFor(() => frames.find((f) => f.name === 'stt:media-hold' && (f.data as { active?: boolean }).active === false))
  })

  it('turned off in config: neither a pause nor a resume, and no broadcast', async () => {
    await updateConfig({ stt: { ...(await getConfig()).stt, pause_media: false } })
    const held = await post({ id: 'web-e2e00002', action: 'hold', source: 'mic' })
    expect(held.data).toMatchObject({ enabled: false, active: false })
    await post({ id: 'web-e2e00002', action: 'release' })
    expect(fake.calls).toEqual([])
    expect(fake.state.playing).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(frames.some((f) => f.name === 'stt:media-hold')).toBe(false)
  })

  it('a page closing sends its release as text/plain (sendBeacon) and it still lands', async () => {
    await post({ id: 'web-e2e00003', action: 'hold', source: 'mic' })
    const r = await fetch(`http://localhost:${port}/api/stt/media-hold`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: 'web-e2e00003', action: 'release' }),
    })
    expect(r.status).toBe(200)
    expect(fake.state.playing).toBe(true)
  })

  it('a request from another device holds nothing', async () => {
    const r = await fetch(`http://localhost:${port}/api/stt/media-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ id: 'web-e2e00004', action: 'hold' }),
    })
    // A proxied request is not this machine: refused by auth, or answered as another device.
    if (r.status === 200) expect(await r.json()).toMatchObject({ otherDevice: true, active: false })
    else expect([401, 403]).toContain(r.status)
    expect(fake.calls).toEqual([])
  })

  it('refuses a bad id or action', async () => {
    expect((await post({ id: 'x', action: 'hold' })).status).toBe(400)
    expect((await post({ id: 'web-e2e00005', action: 'toggle' })).status).toBe(400)
  })

  it('the Settings switch round trip: PUT /api/config stt.pause_media false turns the hold off', async () => {
    const put = await fetch(`http://localhost:${port}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` },
      body: JSON.stringify({ stt: { pause_media: false } }),
    })
    expect(put.status).toBe(200)
    const read = await (await fetch(`http://localhost:${port}/api/config`)).json() as { config: { stt?: { pause_media?: boolean } } }
    expect(read.config.stt?.pause_media).toBe(false)
    expect((await post({ id: 'web-e2e00006', action: 'hold' })).data).toMatchObject({ enabled: false, active: false })
    expect(fake.calls).toEqual([])
  })
})
