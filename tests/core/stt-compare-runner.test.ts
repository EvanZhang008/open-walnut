/**
 * The Voice Accuracy runner over real recording stores in a test home: the
 * engines that are ready hear each take once, the judge writes a reference only
 * with its consent, scores follow, a failure is tried again on the next run,
 * `force` reruns, a dictation in progress pauses it, and the recordings
 * themselves are never written. Engines and models are fakes; nothing leaves
 * the machine and nothing plays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const constants = vi.hoisted(() => ({ home: '' }))
vi.mock('../../src/constants.js', async () => {
  const c = (await import('../helpers/mock-constants.js')).createMockConstants('stt-compare-runner')
  constants.home = c.WALNUT_HOME as string
  return c
})

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown> }))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => structuredClone(state.config),
  updateConfig: async () => {},
}))
vi.mock('../../src/core/task-manager.js', () => ({ listTaskTitles: async () => ['A neutral task title'] }))
vi.mock('../../src/core/stt/setup.js', () => ({ getModelDir: () => join(constants.home, 'whisper-models') }))

const transcribeAudio = vi.fn()
const whisperTranscribe = vi.fn()
vi.mock('../../src/core/stt/index.js', () => ({
  transcribeAudio: (...a: unknown[]) => transcribeAudio(...a),
  getOrCreateEngine: () => ({ name: 'mlx', isAvailable: async () => ({ available: true }) }),
  createEngineByName: () => ({ name: 'whisper-cpp', isAvailable: async () => ({ available: true }), transcribe: (...a: unknown[]) => whisperTranscribe(...a) }),
  loadVocabPrompt: async () => '',
}))
const sendMessage = vi.fn()
vi.mock('../../src/model/model.js', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }))

const { runComparison, runIdle, runProgress, runStatesOf, judgeAgain, settingsChanged, _resetRunnerForTest } = await import('../../src/core/stt/compare/runner.js')
const { compareStore } = await import('../../src/core/stt/compare/store.js')
const { voiceRequestStarted, mediaHold, _setMediaControllerForTest, _resetVoiceActivityForTest } = await import('../../src/core/stt/media-hold-runtime.js')
const { voiceArchive } = await import('../../src/core/stt/voice-archive.js')
const { msUntilNight } = await import('../../src/core/stt/compare/nightly.js')

const REC = '2026-11-21T10-00-00-000Z'
const recDir = () => join(constants.home, 'tmp', 'stt-recordings')
let phoneId = ''

async function seed(): Promise<void> {
  await mkdir(recDir(), { recursive: true })
  await writeFile(join(recDir(), `${REC}.webm`), Buffer.from('web audio'))
  await writeFile(join(recDir(), `${REC}.json`), JSON.stringify({ timestamp: '2026-11-21T10:00:01.000Z', format: 'webm', language: 'auto', audioSizeBytes: 9, engine: 'mlx', result: { text: 'deploy the pot', durationMs: 10 } }))
  const record = await voiceArchive.ingestAudio({ audio: Buffer.from('phone audio'), format: 'wav', createdAt: '2026-11-21T09:00:00.000Z', durationSeconds: 4 })
  phoneId = record.id
  await mkdir(join(constants.home, 'whisper-models'), { recursive: true })
  await writeFile(join(constants.home, 'whisper-models', 'ggml-large-v2-q5_0.bin'), 'model')
}

const answer = (text: string) => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, model: 'test-model' } })

beforeEach(async () => {
  _resetRunnerForTest()
  _resetVoiceActivityForTest()
  _setMediaControllerForTest(null)
  compareStore._forget()
  transcribeAudio.mockReset().mockResolvedValue({ text: 'deploy the pot', durationMs: 10, engine: 'mlx', model: 'qwen-test' })
  whisperTranscribe.mockReset().mockResolvedValue({ text: 'deploy the pod', durationMs: 20 })
  sendMessage.mockReset().mockImplementation(async (opts: { usage: { agentId: string } }) =>
    answer('deploy the pod'))
  state.config = { experimental: { stt_compare: true }, stt: { engine: 'mlx', compare: { engines: {} } } }
  if (!phoneId) await seed()
})
afterEach(async () => { await runIdle() })

const consent = (...ids: string[]) => {
  (state.config.stt as { compare: { engines: Record<string, unknown> } }).compare.engines = Object.fromEntries(ids.map((id) => [id, { allow_upload: true }]))
}

describe('Voice Accuracy runner', () => {
  it('runs nothing while the experiment is off', async () => {
    state.config.experimental = {}
    runComparison({ last: 5 })
    await runIdle()
    expect(await compareStore.count()).toBe(0)
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('hears each take with the local engines, and judges nothing without the judge\'s consent', async () => {
    const before = await readFile(join(recDir(), `${REC}.json`), 'utf8')
    runComparison({ last: 5 })
    await runIdle()
    const web = (await compareStore.get(`rec-${REC}`))!
    const phone = (await compareStore.get(`phone-${phoneId}`))!
    expect(web.results['in-use']).toMatchObject({ text: 'deploy the pot', model: 'mlx qwen-test' })
    expect(web.results['whisper-large-v2']!.text).toBe('deploy the pod')
    expect(web.inUseText).toBe('deploy the pot')
    expect(phone.source).toBe('phone')
    expect(phone.durationSec).toBe(4)
    expect(phone.results['in-use']!.text).toBe('deploy the pot')
    // Cloud engines and the judge wait for consent.
    expect(web.results['elevenlabs-scribe']).toBeUndefined()
    expect(web.results['haiku-cleanup']).toBeUndefined()
    expect(web.reference).toBeUndefined()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(runStatesOf(web.id)).toMatchObject({ 'in-use': { state: 'done' }, 'whisper-large-v2': { state: 'done' } })
    // The recording itself is read only.
    expect(await readFile(join(recDir(), `${REC}.json`), 'utf8')).toBe(before)
    expect(runProgress()).toMatchObject({ running: false, done: 4, total: 4 })
  })

  it('a run of the newest takes skips the complete ones', async () => {
    runComparison({ last: 5 })
    await runIdle()
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(runProgress()).toMatchObject({ done: 0, total: 0 })
  })

  it('the nightly run is due at the next 03:00 local', () => {
    const at = new Date(2026, 10, 21, 2, 30, 0)
    expect(msUntilNight(at)).toBe(30 * 60_000)
    expect(msUntilNight(new Date(2026, 10, 21, 3, 0, 0))).toBe(24 * 60 * 60_000)
  })

  it('with consent: the clean-up, then the judge\'s reference and the scores; stored results are not heard again', async () => {
    consent('judge', 'haiku-cleanup')
    runComparison({ takeIds: [`rec-${REC}`] })
    await runIdle()
    const take = (await compareStore.get(`rec-${REC}`))!
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(take.results['haiku-cleanup']).toMatchObject({ text: 'deploy the pod', model: 'test-model' })
    expect(take.reference).toMatchObject({ text: 'deploy the pod', judge: 'test-model', engines: ['in-use', 'whisper-large-v2'] })
    expect(take.scores!['in-use']).toMatchObject({ edits: 1, n: 3 })
    expect(take.scores!['whisper-large-v2']).toMatchObject({ edits: 0, n: 3 })
    // The judge read the hearing engines only, never the clean-up's text.
    const judgeCall = sendMessage.mock.calls.find((c) => (c[0] as { usage: { agentId: string } }).usage.agentId.endsWith('judge'))!
    const prompt = (judgeCall[0] as { messages: Array<{ content: string }> }).messages[0]!.content
    expect(prompt).toContain('Hypothesis 2 (Whisper large-v2)')
    expect(prompt).not.toContain('Hypothesis 3')
  })

  it('a failed result is tried again on the next run; force reruns a stored one and asks the judge again', async () => {
    consent('judge')
    transcribeAudio.mockRejectedValueOnce(new Error('engine busy'))
    runComparison({ takeIds: [`phone-${phoneId}`], engines: ['in-use'], force: true })
    await runIdle()
    let take = (await compareStore.get(`phone-${phoneId}`))!
    expect(take.results['in-use']).toMatchObject({ error: 'engine busy' })
    expect(runStatesOf(take.id)!['in-use']).toEqual({ state: 'failed', error: 'engine busy' })
    const judgedAt = take.reference?.at
    runComparison({ takeIds: [`phone-${phoneId}`], engines: ['in-use'] })
    await runIdle()
    take = (await compareStore.get(`phone-${phoneId}`))!
    expect(take.results['in-use']!.text).toBe('deploy the pot')
    expect(take.results['in-use']!.error).toBeUndefined()
    expect(take.reference!.at >= (judgedAt ?? '')).toBe(true)
    const calls = sendMessage.mock.calls.length
    runComparison({ takeIds: [`phone-${phoneId}`], engines: ['in-use'] })
    await runIdle()
    expect(sendMessage.mock.calls.length).toBe(calls) // complete: nothing to do
    runComparison({ takeIds: [`phone-${phoneId}`], engines: ['in-use'], force: true })
    await runIdle()
    expect(sendMessage.mock.calls.length).toBe(calls + 1) // reheard, so judged again
  })

  it('waits while a voice request is answered (a long final), and goes on after it', async () => {
    const end = voiceRequestStarted()
    runComparison({ takeIds: [`rec-${REC}`], engines: ['in-use'], force: true })
    await vi.waitFor(() => expect(runProgress()).toMatchObject({ running: true, engine: 'paused while you dictate' }))
    expect(transcribeAudio).not.toHaveBeenCalled()
    end()
    _resetVoiceActivityForTest() // the quiet time after it, skipped
    await runIdle()
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
    // A comparison hearing: dictation's live language memory is left alone.
    expect(transcribeAudio.mock.calls[0]![2]).toEqual({ comparison: true })
  })

  it('waits while a microphone holds (a local dictation), even with pause_media off', async () => {
    (state.config.stt as Record<string, unknown>).pause_media = false
    await mediaHold().hold('va-test-hold-1', 'server-mic')
    runComparison({ takeIds: [`rec-${REC}`], engines: ['in-use'], force: true })
    await vi.waitFor(() => expect(runProgress()).toMatchObject({ running: true, engine: 'paused while you dictate' }))
    expect(transcribeAudio).not.toHaveBeenCalled()
    await mediaHold().release('va-test-hold-1')
    _resetVoiceActivityForTest()
    await runIdle()
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
  })

  it('reads the config before every step: consent taken back mid-job uploads nothing more', async () => {
    consent('haiku-cleanup')
    transcribeAudio.mockImplementation(async () => {
      // The user unticks the clean-up's consent while the first take is heard.
      consent()
      return { text: 'deploy the pot', durationMs: 10, engine: 'mlx' }
    })
    runComparison({ takeIds: [`rec-${REC}`, `phone-${phoneId}`], engines: ['in-use', 'haiku-cleanup'], force: true })
    await runIdle()
    expect(transcribeAudio).toHaveBeenCalledTimes(2)
    expect(sendMessage).not.toHaveBeenCalled()
    // Nothing queued or running is left behind for the skipped steps.
    for (const id of [`rec-${REC}`, `phone-${phoneId}`]) {
      expect(['queued', 'running']).not.toContain(runStatesOf(id)?.['haiku-cleanup']?.state)
    }
  })

  it('a settings save aborts the upload in flight; a step no longer allowed stores nothing', async () => {
    consent('haiku-cleanup')
    const take = (await compareStore.get(`rec-${REC}`))!
    const before = take.results['haiku-cleanup']
    let aborted = false
    sendMessage.mockImplementation((opts: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    }))
    runComparison({ takeIds: [`rec-${REC}`], engines: ['haiku-cleanup'], force: true })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    consent()
    settingsChanged()
    await runIdle()
    expect(aborted).toBe(true)
    expect((await compareStore.get(`rec-${REC}`))!.results['haiku-cleanup']).toEqual(before)
    expect(runStatesOf(`rec-${REC}`)?.['haiku-cleanup']).toBeUndefined()
  })

  it('turned off mid-job: the job stops and its queued units do not stay queued', async () => {
    transcribeAudio.mockImplementation(async () => {
      state.config.experimental = {}
      return { text: 'deploy the pot', durationMs: 10, engine: 'mlx' }
    })
    runComparison({ takeIds: [`rec-${REC}`, `phone-${phoneId}`], engines: ['in-use', 'whisper-large-v2'], force: true })
    await runIdle()
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
    expect(whisperTranscribe).not.toHaveBeenCalled()
    // It planned two recordings and really compared one: the pane's "compared" is the real count.
    expect(runProgress()).toMatchObject({ takes: 2, compared: 1 })
    for (const id of [`rec-${REC}`, `phone-${phoneId}`]) {
      for (const unit of Object.values(runStatesOf(id) ?? {})) expect(['queued', 'running']).not.toContain(unit.state)
    }
  })

  it('Judge again is a queued job that honours the judge\'s switch', async () => {
    consent('judge')
    const p = await judgeAgain(`rec-${REC}`)
    expect(p.queued + (p.running ? 1 : 0)).toBeGreaterThanOrEqual(0)
    await runIdle()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(runStatesOf(`rec-${REC}`)?.judge).toEqual({ state: 'done' })
    // Switched off: the job runs nothing.
    ;(state.config.stt as { compare: { engines: Record<string, unknown> } }).compare.engines = { judge: { enabled: false, allow_upload: true } }
    await judgeAgain(`rec-${REC}`)
    await runIdle()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(['queued', 'running']).not.toContain(runStatesOf(`rec-${REC}`)?.judge?.state)
  })

  it('one take whose store write fails does not stop the job', async () => {
    const real = compareStore.upsert.bind(compareStore)
    const spy = vi.spyOn(compareStore, 'upsert').mockImplementation(async (id, patch) => {
      if (id === `rec-${REC}`) throw new Error('disk full')
      return real(id, patch)
    })
    try {
      runComparison({ takeIds: [`rec-${REC}`, `phone-${phoneId}`], engines: ['in-use'], force: true })
      await runIdle()
    } finally { spy.mockRestore() }
    expect(transcribeAudio).toHaveBeenCalledTimes(2)
    expect((await compareStore.get(`phone-${phoneId}`))!.results['in-use']!.text).toBe('deploy the pot')
  })
})
