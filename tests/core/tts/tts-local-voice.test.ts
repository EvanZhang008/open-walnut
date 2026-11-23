/**
 * The local Chinese voice (src/core/tts/local-voice.ts): a zh* piece goes to
 * Qwen3-TTS only with the experiment on, on an Apple Silicon Mac, once the model
 * is set up; every other piece, and every piece with the experiment off, is read
 * exactly as before. A piece the local voice cannot read goes to the usual engine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../../src/core/types.js'
import { clearTtsCache, enginesFor, speakWithFallback, ttsStatus } from '../../../src/core/tts/index.js'
import { _resetLocalVoiceForTest, qwenEngineFor, qwenModel, qwenPort, zhEngineChoice, type LocalVoiceFacts } from '../../../src/core/tts/local-voice.js'
import { QWEN_TTS_DEFAULT_MODEL, QWEN_TTS_DEFAULT_PORT, QWEN_TTS_DEFAULT_VOICE, type QwenTtsEngine } from '../../../src/core/tts/engine-qwen.js'
import { TtsError, type TtsEngine, type TtsRequest } from '../../../src/core/tts/types.js'

const cfg = (tts: Config['tts'] = {}, experimental: Record<string, boolean> = {}): Config => ({ tts, experimental } as Config)
const ON = { local_chinese_voice: true }
const KEY = { elevenlabs_api_key: 'k' }

const readyFacts = (over: Partial<LocalVoiceFacts> = {}): LocalVoiceFacts => ({
  appleSilicon: true,
  setup: { state: 'ready', model: QWEN_TTS_DEFAULT_MODEL },
  voiceOff: null,
  ...over,
})

afterEach(() => {
  clearTtsCache()
  _resetLocalVoiceForTest()
})

describe('which engine reads a Chinese piece', () => {
  it('the experiment off: nothing changes, whatever tts.zh_engine says', () => {
    for (const zh of [undefined, 'qwen', 'device', 'elevenlabs'] as const) {
      expect(zhEngineChoice(cfg({ zh_engine: zh }), true)).toBeNull()
      const pick = enginesFor(cfg({ ...KEY, zh_engine: zh }), 'zh-CN', { facts: readyFacts() })
      expect(pick.engine?.id).toBe('elevenlabs')
      expect(pick.fallback).toBeNull()
    }
    const status = ttsStatus(cfg(KEY), readyFacts())
    expect(status.byLanguage).toBeUndefined()
    expect(status.engines.find((e) => e.id === 'qwen')).toMatchObject({ available: false, state: 'off' })
  })

  it('on: an Apple Silicon Mac picks qwen for an unset zh_engine; elsewhere it is today\'s engine', () => {
    expect(zhEngineChoice(cfg({}, ON), true)).toBe('qwen')
    expect(zhEngineChoice(cfg({ zh_engine: 'qwen' }, ON), false)).toBeNull()
    expect(zhEngineChoice(cfg({ zh_engine: 'device' }, ON), true)).toBe('device')
    expect(zhEngineChoice(cfg({ zh_engine: 'elevenlabs' }, ON), false)).toBe('elevenlabs')
    const linux = ttsStatus(cfg(KEY, ON), readyFacts({ appleSilicon: false }))
    expect(linux.engines.find((e) => e.id === 'qwen')).toMatchObject({ available: false, state: 'unsupported', reason: expect.stringMatching(/Apple Silicon/) })
    expect(linux.byLanguage).toBeUndefined()
    expect(enginesFor(cfg(KEY, ON), 'zh-CN', { facts: readyFacts({ appleSilicon: false }) }).engine?.id).toBe('elevenlabs')
  })

  it('on and set up: zh pieces go to qwen with the usual engine behind it; other pieces stay', () => {
    const facts = readyFacts()
    const zh = enginesFor(cfg(KEY, ON), 'zh-CN', { facts })
    expect(zh.engine?.id).toBe('qwen')
    expect(zh.engine).toMatchObject({ model: QWEN_TTS_DEFAULT_MODEL, voice: QWEN_TTS_DEFAULT_VOICE })
    expect(zh.fallback?.id).toBe('elevenlabs')
    expect(enginesFor(cfg(KEY, ON), 'zh', { facts }).engine?.id).toBe('qwen')
    for (const lang of ['en-US', undefined, 'ja-JP']) {
      const other = enginesFor(cfg(KEY, ON), lang, { facts })
      expect(other.engine?.id).toBe('elevenlabs')
      expect(other.fallback).toBeNull()
    }
    // No ElevenLabs key: qwen still reads Chinese, and nothing stands behind it (the device does).
    expect(enginesFor(cfg({}, ON), 'zh-CN', { facts })).toMatchObject({ engine: { id: 'qwen' }, fallback: null })
  })

  it('byLanguage names the local voice only once its model answers, never while it loads', () => {
    const facts = readyFacts()
    // Loading: the status says so, and a client is not told to send it Chinese pieces.
    const loading = ttsStatus(cfg(KEY, ON), facts)
    expect(loading.engine).toBe('elevenlabs')
    expect(loading.byLanguage).toBeUndefined()
    expect(loading.engines.find((e) => e.id === 'qwen')).toMatchObject({ id: 'qwen', available: true, state: 'loading', languages: ['zh'], model: QWEN_TTS_DEFAULT_MODEL, voice: 'Uncle_Fu' })
    expect(ttsStatus(cfg({}, ON), facts).byLanguage).toBeUndefined()
    // Ready: named, for the device-voice client too.
    _resetLocalVoiceForTest()
    qwenEngineFor(cfg({}, ON), (() => ({ id: 'qwen', model: QWEN_TTS_DEFAULT_MODEL, voice: 'Uncle_Fu', ready: true, startError: null })) as never)
    expect(ttsStatus(cfg(KEY, ON), facts)).toMatchObject({ engine: 'elevenlabs', byLanguage: { zh: 'qwen' } })
    expect(ttsStatus(cfg({}, ON), facts)).toMatchObject({ engine: 'device', byLanguage: { zh: 'qwen' } })
    expect(ttsStatus(cfg(KEY, ON), facts).engines.find((e) => e.id === 'qwen')).toMatchObject({ state: 'ready' })
  })

  it('on but not ready (setting up, failed, another model, voice off here): today\'s engine reads it', () => {
    const cases: Array<[Partial<LocalVoiceFacts>, string]> = [
      [{ setup: { state: 'installing', model: QWEN_TTS_DEFAULT_MODEL, percent: 40 } }, 'setting-up'],
      [{ setup: { state: 'failed', model: QWEN_TTS_DEFAULT_MODEL, error: 'no network' } }, 'failed'],
      [{ setup: { state: 'ready', model: 'mlx-community/other' } }, 'setting-up'],
      [{ voiceOff: 'Voice is off on this isolated server' }, 'unsupported'],
    ]
    for (const [over, state] of cases) {
      const facts = readyFacts(over)
      expect(enginesFor(cfg(KEY, ON), 'zh-CN', { facts })).toMatchObject({ engine: { id: 'elevenlabs' }, fallback: null })
      const status = ttsStatus(cfg(KEY, ON), facts)
      expect(status.engines.find((e) => e.id === 'qwen')).toMatchObject({ available: false, state })
      expect(status.byLanguage).toBeUndefined()
    }
    expect(ttsStatus(cfg(KEY, ON), readyFacts(cases[0][0])).engines.find((e) => e.id === 'qwen')).toMatchObject({ percent: 40, reason: 'Setting up the local voice (40%)' })
  })

  it('zh_engine device or elevenlabs: Chinese is read by that one', () => {
    expect(enginesFor(cfg({ ...KEY, zh_engine: 'device' }, ON), 'zh-CN', { facts: readyFacts() })).toEqual({ engine: null, fallback: null })
    expect(ttsStatus(cfg({ ...KEY, zh_engine: 'device' }, ON), readyFacts()).byLanguage).toEqual({ zh: 'device' })
    expect(enginesFor(cfg({ ...KEY, engine: 'device', zh_engine: 'elevenlabs' }, ON), 'zh-CN', { facts: readyFacts() }).engine?.id).toBe('elevenlabs')
    expect(ttsStatus(cfg({ ...KEY, zh_engine: 'elevenlabs' }, ON), readyFacts()).engines.find((e) => e.id === 'qwen')).toMatchObject({ state: 'not-chosen' })
  })
})

/** A stand-in engine maker that records what it was made with. */
type Made = { model?: string; voice?: string; port?: number; shutdown: ReturnType<typeof vi.fn>; setVoice: (v: string) => void }
const maker = (made: Made[]) => ((c: { model?: string; voice?: string; port?: number }) => {
  const e: Made & { id: 'qwen' } = { id: 'qwen', model: c.model, voice: c.voice, port: c.port, shutdown: vi.fn(), setVoice(v) { e.voice = v } }
  made.push(e)
  return e as unknown as QwenTtsEngine
}) as never

describe('the local voice engine is kept across requests', () => {
  it('the same config: the same engine; another voice: the same engine and daemon, even one still loading; another model: the old daemon retires', () => {
    const made: Made[] = []
    const make = maker(made)
    const a = qwenEngineFor(cfg({}, ON), make)
    expect(qwenEngineFor(cfg({}, ON), make)).toBe(a)
    const b = qwenEngineFor(cfg({ qwen_voice: 'Dylan' }, ON), make)
    expect(b).toBe(a)
    expect(b.voice).toBe('Dylan')
    expect(made).toHaveLength(1)
    expect(made[0].shutdown).not.toHaveBeenCalled()
    qwenEngineFor(cfg({ qwen_voice: 'Dylan', qwen_model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit' }, ON), make)
    expect(made[0].shutdown).toHaveBeenCalledTimes(1)
    expect(made).toHaveLength(2)
    expect(made.map((e) => e.voice)).toEqual(['Dylan', 'Dylan'])
  })

  it('turning the experiment off (or picking another engine) retires the running daemon on the next read', () => {
    const made: Made[] = []
    qwenEngineFor(cfg({}, ON), maker(made))
    enginesFor(cfg(KEY, ON), 'zh-CN', { facts: readyFacts() })
    expect(made[0].shutdown).not.toHaveBeenCalled()
    enginesFor(cfg(KEY, {}), 'en-US', { facts: readyFacts() })
    expect(made[0].shutdown).toHaveBeenCalledTimes(1)
    // Retired once: the next read starts nothing and retires nothing again.
    enginesFor(cfg(KEY, {}), 'zh-CN', { facts: readyFacts() })
    expect(made[0].shutdown).toHaveBeenCalledTimes(1)
    qwenEngineFor(cfg({}, ON), maker(made))
    enginesFor(cfg({ ...KEY, zh_engine: 'device' }, ON), 'zh-CN', { facts: readyFacts() })
    expect(made[1].shutdown).toHaveBeenCalledTimes(1)
  })
})

describe('the local voice config is checked before it reaches a child process', () => {
  it('a model that is not an mlx-community repo falls back to the default', () => {
    for (const bad of ['evil/model', 'mlx-community/../../etc', 'mlx-community/a b', '--help', 'mlx-community/x;rm']) {
      expect(qwenModel(cfg({ qwen_model: bad }, ON))).toBe(QWEN_TTS_DEFAULT_MODEL)
    }
    expect(qwenModel(cfg({ qwen_model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit' }, ON))).toBe('mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit')
    expect(qwenModel(cfg({}, ON))).toBe(QWEN_TTS_DEFAULT_MODEL)
  })

  it('a port outside 1024-65535, or one a speech daemon uses, falls back to the default', () => {
    for (const bad of [7893, 7894, 80, 0, 70_000, 7990.5, -1]) {
      expect(qwenPort(cfg({ qwen_port: bad }, ON))).toBe(QWEN_TTS_DEFAULT_PORT)
    }
    expect(qwenPort({ tts: { qwen_port: 7990 }, stt: { mlx_port: 7990 } } as Config)).toBe(QWEN_TTS_DEFAULT_PORT)
    expect(qwenPort({ tts: { qwen_port: 7991 }, stt: { cleanup_port: 7991 } } as Config)).toBe(QWEN_TTS_DEFAULT_PORT)
    expect(qwenPort(cfg({ qwen_port: '7990' as unknown as number }, ON))).toBe(QWEN_TTS_DEFAULT_PORT)
    expect(qwenPort(cfg({ qwen_port: 7990 }, ON))).toBe(7990)
    expect(qwenPort(cfg({}, ON))).toBe(QWEN_TTS_DEFAULT_PORT)
    // The engine is made with the checked values.
    const made: Made[] = []
    qwenEngineFor(cfg({ qwen_port: 7893, qwen_model: 'evil/model' }, ON), maker(made))
    expect(made[0]).toMatchObject({ port: QWEN_TTS_DEFAULT_PORT, model: QWEN_TTS_DEFAULT_MODEL })
  })
})

function fakeEngine(id: 'qwen' | 'elevenlabs', answer: (req: TtsRequest) => Promise<Uint8Array>, extra: Partial<TtsEngine> = {}): TtsEngine & { calls: string[]; reqs: TtsRequest[] } {
  const calls: string[] = []
  const reqs: TtsRequest[] = []
  return {
    id, model: `${id}-model`, voice: `${id}-voice`, calls, reqs, ...extra,
    async synthesize(req) {
      calls.push(req.text)
      reqs.push(req)
      const bytes = await answer(req)
      return { mime: id === 'qwen' ? 'audio/wav' : 'audio/mpeg', body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }) }
    },
  }
}

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...new Uint8Array(await new Response(body).arrayBuffer())]
}

describe('a piece the local voice cannot read goes to the usual engine', () => {
  it('unreachable, too slow or refused: the fallback reads it, and the answer says which engine did', async () => {
    for (const err of [new TtsError('still loading', 503, 'tts_unavailable'), new TtsError('took too long', 503, 'tts_unavailable'), new TtsError('answered 500', 502, 'tts_failed')]) {
      clearTtsCache()
      const qwen = fakeEngine('qwen', async () => { throw err })
      const eleven = fakeEngine('elevenlabs', async () => new Uint8Array([9, 9]))
      const out = await speakWithFallback({ engine: qwen, fallback: eleven }, { text: '\u4f60\u597d\u3002', language: 'zh-CN' })
      expect(out.engine.id).toBe('elevenlabs')
      expect(out.mime).toBe('audio/mpeg')
      expect(await bytesOf(out.body)).toEqual([9, 9])
      expect(qwen.calls).toHaveLength(1)
    }
  })

  it('a cancelled request is not read again, and with no fallback the error stands', async () => {
    const eleven = fakeEngine('elevenlabs', async () => new Uint8Array([1]))
    const cancelled = fakeEngine('qwen', async () => { throw new TtsError('cancelled', 499, 'tts_failed') })
    await expect(speakWithFallback({ engine: cancelled, fallback: eleven }, { text: 'a', language: 'zh' })).rejects.toMatchObject({ status: 499 })
    const aborted = new AbortController()
    aborted.abort()
    const down = fakeEngine('qwen', async () => { throw new TtsError('down', 503, 'tts_unavailable') })
    await expect(speakWithFallback({ engine: down, fallback: eleven }, { text: 'b', language: 'zh', signal: aborted.signal })).rejects.toMatchObject({ status: 503 })
    expect(eleven.calls).toEqual([])
    await expect(speakWithFallback({ engine: down, fallback: null }, { text: 'c', language: 'zh' })).rejects.toMatchObject({ code: 'tts_unavailable' })
    await expect(speakWithFallback({ engine: null, fallback: null }, { text: 'd' })).rejects.toMatchObject({ status: 503 })
  })

  it('the local voice\'s audio is cached under its own engine and voice, apart from the fallback\'s', async () => {
    let n = 0
    const qwen = fakeEngine('qwen', async () => new Uint8Array([++n]))
    const first = await speakWithFallback({ engine: qwen, fallback: null }, { text: 'x', language: 'zh-CN' })
    expect(first).toMatchObject({ cached: false, mime: 'audio/wav' })
    expect(await bytesOf(first.body)).toEqual([1])
    const again = await speakWithFallback({ engine: qwen, fallback: null }, { text: 'x', language: 'zh-CN' })
    expect(again.cached).toBe(true)
    expect(await bytesOf(again.body)).toEqual([1])
    const eleven = fakeEngine('elevenlabs', async () => new Uint8Array([7]))
    expect((await speakWithFallback({ engine: eleven, fallback: null }, { text: 'x', language: 'zh-CN' })).cached).toBe(false)
  })

  it('the local voice has its own budget, and the fallback keeps a full deadline of its own', async () => {
    // The local voice hangs until its budget runs out.
    const qwen = fakeEngine('qwen', (req) => new Promise((_resolve, reject) => {
      req.signal!.addEventListener('abort', () => reject(new TtsError('The voice request was cancelled', 499, 'tts_failed')))
    }), { fallbackBudgetMs: 150, fitsBudget: () => true })
    // The fallback takes longer than that budget, well within its own deadline.
    const eleven = fakeEngine('elevenlabs', async (req) => {
      await new Promise((r) => setTimeout(r, 300))
      expect(req.signal!.aborted).toBe(false)
      return new Uint8Array([5])
    })
    const t0 = Date.now()
    const out = await speakWithFallback({ engine: qwen, fallback: eleven }, { text: '\u4f60\u597d\u3002', language: 'zh-CN' }, 2_000)
    expect(out.engine.id).toBe('elevenlabs')
    expect(await bytesOf(out.body)).toEqual([5])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(qwen.reqs[0].deadlineMs).toBe(150)
    expect(eleven.reqs[0].deadlineMs).toBe(2_000)
  })

  it('a piece too long for the local voice\'s budget goes to the fallback without asking it', async () => {
    const qwen = fakeEngine('qwen', async () => new Uint8Array([1]), { fallbackBudgetMs: 8_000, fitsBudget: (t) => t.length <= 60 })
    const eleven = fakeEngine('elevenlabs', async () => new Uint8Array([2]))
    const long = '\u4eca'.repeat(61)
    const out = await speakWithFallback({ engine: qwen, fallback: eleven }, { text: long, language: 'zh-CN' })
    expect(out.engine.id).toBe('elevenlabs')
    expect(qwen.calls).toEqual([])
    expect(eleven.reqs[0].deadlineMs).toBe(20_000)
    // Short enough: the local voice reads it. With nothing behind it, even a long one is its own, with the whole deadline.
    expect((await speakWithFallback({ engine: qwen, fallback: eleven }, { text: '\u4eca'.repeat(60), language: 'zh-CN' })).engine.id).toBe('qwen')
    expect((await speakWithFallback({ engine: qwen, fallback: null }, { text: long, language: 'zh-CN' })).engine.id).toBe('qwen')
    expect(qwen.reqs.at(-1)!.deadlineMs).toBe(20_000)
  })

  it('an engine that does not answer within the deadline is tts_unavailable, not a cancel', async () => {
    const slow = fakeEngine('elevenlabs', (req) => new Promise((_r, reject) => {
      req.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    await expect(speakWithFallback({ engine: slow, fallback: null }, { text: 'x' }, 100)).rejects.toMatchObject({ status: 503, code: 'tts_unavailable' })
  })
})
