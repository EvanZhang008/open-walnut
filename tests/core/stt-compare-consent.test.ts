/**
 * Guard: every Voice Accuracy engine (and the AI judge) that sends audio or
 * text anywhere refuses to run until the user ticked its `allow_upload`, and
 * calls nothing on the way to refusing. The test enumerates the registry, so a
 * new cloud engine without the check fails here. An engine that declares it
 * sends nothing is checked too: the in-use engine reads where dictation's own
 * engine runs (a cloud dictation engine needs consent), every dictation engine
 * name says what it sends, and the Whisper engine always runs whisper-cpp. An
 * engine switched off never runs, consent or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('stt-compare-consent'))

const sendMessage = vi.fn(async () => ({ content: [{ type: 'text', text: 'reference' }], stopReason: 'end_turn' }))
vi.mock('../../src/model/model.js', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...(a as [])) }))
const transcribeAudio = vi.fn(async () => ({ text: 'heard', durationMs: 5 }))
const createEngineByName = vi.fn((..._a: unknown[]) => null)
vi.mock('../../src/core/stt/index.js', () => ({
  transcribeAudio: (...a: unknown[]) => transcribeAudio(...(a as [])),
  getOrCreateEngine: () => null,
  createEngineByName: (...a: unknown[]) => createEngineByName(...a),
  loadVocabPrompt: async () => '',
}))

// The Whisper model folder (a model file is written by the Whisper test).
vi.mock('../../src/core/stt/setup.js', async () => {
  const [{ WALNUT_HOME }, { join: joinPath }] = await Promise.all([import('../../src/constants.js'), import('node:path')])
  return { getModelDir: () => joinPath(WALNUT_HOME, 'whisper-models') }
})

vi.mock('../../src/core/task-manager.js', () => ({ listTaskTitles: async () => ['A neutral task title'] }))

const { CONSENT_ROWS, COMPARE_ENGINES, JUDGE } = await import('../../src/core/stt/compare/engines.js')
const { ConsentRequiredError, EngineOffError } = await import('../../src/core/stt/compare/types.js')
const { STT_ENGINE_SENDS } = await import('../../src/core/stt/sends-by-engine.js')
import type { Config } from '../../src/core/types.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))
beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy)
  fetchSpy.mockClear(); sendMessage.mockClear(); transcribeAudio.mockClear(); createEngineByName.mockClear()
})
afterEach(() => { vi.unstubAllGlobals() })

const input = { audio: Buffer.from('audio').toString('base64'), format: 'wav', text: 'some text', texts: [{ engine: 'in-use', label: 'In use', text: 'some text' }] }
const noConsent: Config = { stt: { compare: { elevenlabs_api_key: 'test-key-not-real-0000', engines: Object.fromEntries(CONSENT_ROWS.map((e) => [e.id, { enabled: true, allow_upload: false }])) } } } as Config
/** The same, with dictation on a cloud engine. */
const cloudPrimary: Config = { stt: { ...noConsent.stt, engine: 'openai' } } as Config
const nothingSent = () => {
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(sendMessage).not.toHaveBeenCalled()
  expect(transcribeAudio).not.toHaveBeenCalled()
}

describe('Voice Accuracy consent guard', () => {
  it('the registry has the judge as a consent row and at least one cloud engine', () => {
    expect(CONSENT_ROWS).toContain(JUDGE)
    expect(COMPARE_ENGINES.some((e) => e.place(noConsent).sends !== 'nothing')).toBe(true)
    expect(new Set(CONSENT_ROWS.map((e) => e.id)).size).toBe(CONSENT_ROWS.length)
  })

  // Every row that sends something under the config of either kind of dictation engine.
  const sending = [noConsent, cloudPrimary].flatMap((config) => CONSENT_ROWS
    .filter((e) => e.place(config).sends !== 'nothing')
    .map((engine) => ({ engine, config, name: `${engine.id} (sends ${engine.place(config).sends}, dictation on ${config.stt?.engine ?? 'none'})` })))
  for (const { engine, config, name } of sending) {
    it(`${name} refuses to run without allow_upload, calling nothing`, async () => {
      await expect(engine.run(input, { config })).rejects.toBeInstanceOf(ConsentRequiredError)
      nothingSent()
      expect((await engine.status(config)).state).toBe('needs-consent')
      // Unset is no consent either.
      await expect(engine.run(input, { config: { stt: { engine: config.stt?.engine } } as Config })).rejects.toBeInstanceOf(ConsentRequiredError)
      nothingSent()
    })

    it(`${name} gets past the guard once its allow_upload is ticked`, async () => {
      const ticked = { stt: { ...config.stt, compare: { ...config.stt!.compare, engines: { [engine.id]: { allow_upload: true } } } } } as Config
      const err = await engine.run(input, { config: ticked }).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(ConsentRequiredError)
    })
  }

  it('the in-use engine with a cloud dictation engine needs consent; on a local one it needs none', () => {
    const inUse = COMPARE_ENGINES.find((e) => e.id === 'in-use')!
    expect(inUse.place(cloudPrimary)).toEqual({ runsOn: 'cloud', sends: 'audio' })
    expect(inUse.place({ stt: { engine: 'mlx' } } as Config)).toEqual({ runsOn: 'local', sends: 'nothing' })
    // A name Walnut does not know is treated as one that uploads.
    expect(inUse.place({ stt: { engine: 'future-engine' } } as unknown as Config).sends).toBe('audio')
    expect(sending.some((s) => s.engine === inUse && s.config === cloudPrimary)).toBe(true)
  })

  it('every dictation engine the code can make says what it sends, and only openai uploads', () => {
    // The engine names createEngineByName builds, read from its switch.
    const source = readFileSync(join(import.meta.dirname, '../../src/core/stt/index.ts'), 'utf8')
    const body = source.slice(source.indexOf('export function createEngineByName'), source.indexOf('// ── Engine singleton cache'))
    const names = [...body.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThan(4)
    expect(Object.keys(STT_ENGINE_SENDS).sort()).toEqual([...names].sort())
    expect(Object.entries(STT_ENGINE_SENDS).filter(([, v]) => v === 'audio').map(([k]) => k)).toEqual(['openai'])
  })

  it('the Whisper engine, which declares it sends nothing, always runs whisper-cpp, whatever dictation uses', async () => {
    const whisper = COMPARE_ENGINES.find((e) => e.id === 'whisper-large-v2')!
    expect(whisper.place(cloudPrimary).sends).toBe('nothing')
    const { WALNUT_HOME } = await import('../../src/constants.js')
    mkdirSync(join(WALNUT_HOME, 'whisper-models'), { recursive: true })
    writeFileSync(join(WALNUT_HOME, 'whisper-models', 'ggml-large-v2-q5_0.bin'), 'model')
    await whisper.run(input, { config: cloudPrimary }).catch(() => {})
    expect(createEngineByName).toHaveBeenCalledTimes(1)
    expect(createEngineByName.mock.calls[0]![0]).toBe('whisper-cpp')
    // It has a deadline and stops with the job.
    expect(createEngineByName.mock.calls[0]![2]).toMatchObject({ abortOnSignal: true, timeoutMs: expect.any(Number) })
    expect(STT_ENGINE_SENDS['whisper-cpp']).toBe('nothing')
    nothingSent()
  })

  for (const engine of CONSENT_ROWS) {
    it(`${engine.id} switched off never runs, even with its consent ticked`, async () => {
      const off = { stt: { engine: 'mlx', compare: { engines: { [engine.id]: { enabled: false, allow_upload: true } } } } } as Config
      await expect(engine.run(input, { config: off })).rejects.toBeInstanceOf(EngineOffError)
      nothingSent()
    })
  }

  it('an engine switched off reads off, before its consent', async () => {
    const config = { stt: { compare: { engines: { 'elevenlabs-scribe': { enabled: false } } } } } as Config
    expect((await COMPARE_ENGINES.find((e) => e.id === 'elevenlabs-scribe')!.status(config)).state).toBe('off')
  })
})
