import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('voice-archive-routes'))
const engine = vi.hoisted(() => vi.fn())
vi.mock('../../../src/core/stt/index.js', () => ({ transcribeAudio: engine }))
import { voiceArchive } from '../../../src/core/stt/voice-archive.js'
import { voiceArchiveV1Router } from '../../../src/web/routes/voice-archive-v1.js'
const app = express().use(express.json({ limit: '1mb' })).use('/api/v1', voiceArchiveV1Router)
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
beforeEach(async () => { await rm(voiceArchive.root, { recursive: true, force: true }); engine.mockReset() })

describe('voice archive HTTP contract', () => {
  it('commits before transcription, stores full text before answering and reads original bytes', async () => {
    const id = randomUUID(), audio = Buffer.from('original audio')
    const base = `/api/v1/stt/recordings/${id}`
    const chunk = { index: 0, audio: audio.toString('base64'), format: 'm4a', createdAt: '2026-10-11T07:00:00Z', durationSeconds: 420 }
    expect((await request(app).post(base + '/chunks').send(chunk)).status).toBe(200)
    expect((await request(app).post(base + '/transcribe').send({})).status).toBe(409)
    expect((await request(app).post(base + '/commit').send({ chunkCount: 1, audioSizeBytes: audio.length, audioSha256: sha(audio) })).status).toBe(200)
    const text = String.fromCodePoint(0x4f60, 0x597d).concat(' voice ').repeat(400).trim()
    engine.mockResolvedValue({ text, durationMs: 1 })
    const res = await request(app).post(base + '/transcribe').send({})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ text, recordingId: id, primarySaved: true })
    expect((await voiceArchive.get(id)).text).toBe(text)
    expect((await request(app).get(base)).body.text).toBe(text)
    const binary = await request(app).get(base + '/audio').buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => callback(null, Buffer.concat(chunks)))
    })
    expect(binary.body.equals(audio)).toBe(true)
    expect((await request(app).post(base + '/transcribe').send({})).body.text).toBe(text)
    expect(engine).toHaveBeenCalledTimes(1)
  })
  it('retries an empty result instead of caching a permanent empty transcript', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    engine.mockResolvedValueOnce({ text: ' ', durationMs: 1 }).mockResolvedValueOnce({ text: 'heard on retry', durationMs: 1 })
    const base = `/api/v1/stt/recordings/${record.id}/transcribe`
    expect((await request(app).post(base).send({})).body.text).toBe('')
    expect((await voiceArchive.get(record.id)).text).toBeUndefined()
    expect((await request(app).post(base).send({})).body.text).toBe('heard on retry')
    expect(engine).toHaveBeenCalledTimes(2)
  })
  it('refuses conflicting chunks and text without losing the saved original', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const base = `/api/v1/stt/recordings/${record.id}`
    expect((await request(app).post(base + '/text').send({ text: 'kept' })).status).toBe(200)
    expect((await request(app).post(base + '/text').send({ text: 'other' })).status).toBe(409)
    expect((await voiceArchive.get(record.id)).text).toBe('kept')
    expect((await request(app).get('/api/v1/stt/recordings')).body.recordings).toHaveLength(1)
  })
})
