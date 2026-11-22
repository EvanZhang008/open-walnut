/**
 * Voice Accuracy through a REAL server: /api/stt/compare is mounted beside the
 * voice routes and inert (409) until the experiment is switched on in
 * config.yaml; a dictation on any voice route marks the user as dictating
 * (the runner's pause), and the other voice routes answer as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'
import { lastVoiceActivityAt, voiceInputLive } from '../../src/core/stt/media-hold-runtime.js'

let server: HttpServer
let base = ''

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`
}, 60_000)

afterAll(async () => {
  await stopServer()
})

describe('/api/stt/compare on a real server', () => {
  it('is inert while the experiment is off, and answers once it is on', async () => {
    const off = await fetch(`${base}/api/stt/compare/summary`)
    expect(off.status).toBe(409)
    expect(await off.json()).toEqual({ error: 'experimental_off' })
    await updateConfig({ experimental: { ...((await getConfig()).experimental ?? {}), stt_compare: true } })
    const on = await fetch(`${base}/api/stt/compare/summary`)
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ takes: 0, sharedTakes: 0, judge: { state: 'needs-consent' } })
    const engines = await (await fetch(`${base}/api/stt/compare/engines`)).json() as { engines: Array<{ id: string; state: string }> }
    expect(engines.engines.find((e) => e.id === 'elevenlabs-scribe')!.state).toBe('needs-consent')
  })

  it('a dictation request marks the user as dictating until after it is answered; the voice routes still answer', async () => {
    const before = lastVoiceActivityAt()
    const draft = await fetch(`${base}/api/stt/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(draft.status).toBe(400)
    // Marked when it ended too, so a long final pauses the runner after its answer.
    expect(lastVoiceActivityAt()).toBeGreaterThan(before)
    expect(voiceInputLive(60_000)).toBe(true)
    expect((await fetch(`${base}/api/stt/vocab`)).status).toBe(200)
  })

  it('Delete comparison data works with the experiment off', async () => {
    await updateConfig({ experimental: { ...((await getConfig()).experimental ?? {}), stt_compare: false } })
    const res = await fetch(`${base}/api/stt/compare/delete-data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    await expect(fs.access(`${WALNUT_HOME}/stt-compare`)).rejects.toThrow()
    expect((await fetch(`${base}/api/stt/compare/summary`)).status).toBe(409)
  })
})
