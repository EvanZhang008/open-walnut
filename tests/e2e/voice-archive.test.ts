import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('voice-archive-e2e', { IS_EPHEMERAL: true }))
const engine = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/stt/index.js', () => ({ transcribeAudio: engine, prewarmSttEngines: vi.fn() }))
import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createDevice } from '../../src/core/device-auth.js'
import { VoiceArchiveStore } from '../../src/core/stt/voice-archive.js'
let server: Server
let root: string
let token: string
beforeAll(async () => {
  await mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = (await createDevice('voice-test-phone')).token
}, 120_000)
afterAll(async () => { await stopServer(); await rm(WALNUT_HOME, { recursive: true, force: true }) })
const call = async (method: string, path: string, body?: unknown, auth = true) => {
  const response = await fetch(root + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.25', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}
describe('phone voice archive through the real server', () => {
  it('requires authentication for history, then preserves audio and text across a fresh store', async () => {
    expect((await call('GET', '/api/v1/stt/recordings', undefined, false)).status).toBe(401)
    const id = randomUUID(), audio = Buffer.alloc(300_000, 0x42)
    const base = `/api/v1/stt/recordings/${id}`
    for (const [index, bytes] of [audio.subarray(0, 200_000), audio.subarray(200_000)].entries()) {
      expect((await call('POST', base + '/chunks', { index, audio: bytes.toString('base64'), format: 'm4a', createdAt: '2026-10-11T07:00:00Z', durationSeconds: 420 })).status).toBe(200)
    }
    const committed = await call('POST', base + '/commit', { chunkCount: 2, audioSizeBytes: audio.length, audioSha256: createHash('sha256').update(audio).digest('hex') })
    expect(committed.status).toBe(200)
    const text = 'A complete voice message with Unicode ' + String.fromCodePoint(0x4f60, 0x597d).repeat(1500)
    engine.mockResolvedValue({ text, durationMs: 1 })
    expect((await call('POST', base + '/transcribe', {})).body).toMatchObject({ text, recordingId: id })
    const reloaded = new VoiceArchiveStore(WALNUT_HOME)
    expect((await reloaded.get(id)).text).toBe(text)
    expect((await reloaded.readAudio(id)).audio.equals(audio)).toBe(true)
    const response = await fetch(root + base + '/audio', { headers: { 'X-Forwarded-For': '192.0.2.25', Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(audio)).toBe(true)
    expect((await call('POST', base + '/transcribe', {})).body.text).toBe(text)
    expect(engine).toHaveBeenCalledTimes(1)
  })
})
