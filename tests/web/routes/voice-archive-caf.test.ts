import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('voice-archive-caf'))
const hosted = vi.hoisted(() => vi.fn())
vi.mock('../../../src/core/stt/engine-openai.js', () => ({ createOpenAiEngine: () => ({ name: 'openai', isAvailable: async () => ({ available: true }), transcribe: hosted }) }))
const convert = vi.hoisted(() => vi.fn())
const cleanup = vi.hoisted(() => vi.fn())
vi.mock('../../../src/core/stt/audio-convert.js', () => ({ convertToWav: convert, cleanupTempFile: cleanup }))
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { voiceArchive } from '../../../src/core/stt/voice-archive.js'
import { transcribeVoiceRecording } from '../../../src/core/stt/voice-archive-transcribe.js'
import { updateConfig } from '../../../src/core/config-manager.js'
let work: string
beforeEach(async () => {
  if (work) await rm(work, { recursive: true, force: true })
  work = await mkdtemp(tmpdir() + '/voice-caf-convert-')
  await rm(voiceArchive.root, { recursive: true, force: true })
  await updateConfig({ stt: { engine: 'openai', openai_api_key: 'isolated-key' } })
  hosted.mockReset(); convert.mockReset(); cleanup.mockReset()
})
afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }) })
describe('CAF hosted transcription boundary', () => {
  it('sends a converted WAV instead of unsupported CAF and keeps the original', async () => {
    const audio = Buffer.from('original CAF')
    const record = await voiceArchive.ingestAudio({ audio, format: 'caf' })
    const wav = Buffer.from('converted WAV')
    const path = work + '/converted.wav'
    await writeFile(path, wav)
    convert.mockResolvedValue(path)
    hosted.mockResolvedValue({ text: 'full transcript', durationMs: 1 })
    expect((await transcribeVoiceRecording(record.id)).text).toBe('full transcript')
    expect(convert).toHaveBeenCalledWith(audio.toString('base64'), 'caf')
    expect(hosted).toHaveBeenCalledWith(expect.objectContaining({ format: 'wav', audio: wav.toString('base64') }))
    expect(cleanup).toHaveBeenCalledWith(path)
    expect((await voiceArchive.readAudio(record.id)).audio.equals(audio)).toBe(true)
  })
})
