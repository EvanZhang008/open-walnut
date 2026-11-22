/**
 * The comparison engines: one registry entry each, so adding an engine is
 * adding an entry. `defineEngine` puts the switch and the consent check inside
 * every entry's own `run`: an engine switched off never runs, and one that
 * sends audio or text anywhere refuses to run until the user ticked its
 * `allow_upload` (tests/core/stt-compare-consent.test.ts enumerates the
 * registry and the judge). Where an engine runs is read from the config each
 * time (`place`): the in-use engine is a cloud engine when dictation uses one.
 *
 * The judge is defined here too, as a consent row: it sends every engine's text
 * and the user's terms to the AI model Walnut uses.
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../../types.js'
import { STT_ENGINE_SENDS } from '../sends-by-engine.js'
import { elevenLabsModel, elevenLabsStatus, runElevenLabs } from './elevenlabs.js'
import { callTextModel, cleanupModel, judgeModel } from './model-call.js'
import { fixPrompt, judgePrompt, termContext } from './prompts.js'
import { termsSpoken } from './score.js'
import { engineEnabled, uploadAllowed } from './settings.js'
import { ConsentRequiredError, EngineOffError, type CompareEngine, type EnginePlace, type EngineStatus } from './types.js'

type EngineSpec = Omit<CompareEngine, 'status'> & { status(config: Config): Promise<EngineStatus> }

const fixed = (runsOn: EnginePlace['runsOn'], sends: EnginePlace['sends']) => (): EnginePlace => ({ runsOn, sends })

/**
 * The STT module, loaded on first use (it is heavy, and it imports this registry's neighbours).
 * One promise for every caller: statuses run side by side (the clean-up's reads the in-use one's),
 * and they all see the one module.
 */
let sttModule: Promise<typeof import('../index.js')> | null = null
const stt = () => (sttModule ??= import('../index.js'))

/** True when this engine may run under `config` now: switched on, and consented if it sends anything. */
export function engineMayRun(engine: Pick<CompareEngine, 'id' | 'place'>, config: Config): boolean {
  return engineEnabled(config, engine.id) && (engine.place(config).sends === 'nothing' || uploadAllowed(config, engine.id))
}

/** An entry whose `run` and `status` honour the switch and the consent of its row. */
export function defineEngine(spec: EngineSpec): CompareEngine {
  return {
    ...spec,
    async status(config) {
      if (!engineEnabled(config, spec.id)) return { state: 'off' }
      const { sends } = spec.place(config)
      if (sends !== 'nothing' && !uploadAllowed(config, spec.id)) {
        return { state: 'needs-consent', detail: sends === 'audio' ? 'Sends your recordings to a cloud service' : 'Sends the texts and your terms to a cloud model' }
      }
      return spec.status(config)
    },
    async run(input, ctx) {
      if (!engineEnabled(ctx.config, spec.id)) throw new EngineOffError(spec.id)
      if (spec.place(ctx.config).sends !== 'nothing' && !uploadAllowed(ctx.config, spec.id)) throw new ConsentRequiredError(spec.id)
      return spec.run(input, ctx)
    },
  }
}

const WHISPER_FILES = ['ggml-large-v2-q5_0.bin', 'ggml-large-v2.bin']

/** The Voice pane's download of this name writes WHISPER_FILES[1] (src/core/stt/setup.ts MODEL_CATALOG). */
export const WHISPER_DOWNLOAD = 'ggml-large-v2'

async function whisperModelDir(): Promise<string> {
  const { getModelDir } = await import('../setup.js')
  return getModelDir()
}

async function whisperModelPath(): Promise<string | null> {
  const dir = await whisperModelDir()
  for (const file of WHISPER_FILES) {
    const path = join(dir, file)
    if (await access(path).then(() => true, () => false)) return path
  }
  return null
}

/** Where an STT engine of the config runs; a name Walnut does not know is treated as one that uploads. */
export function placeOfSttEngine(name: string | undefined): EnginePlace {
  if (!name) return { runsOn: 'local', sends: 'nothing' }
  return (STT_ENGINE_SENDS as Readonly<Record<string, string>>)[name] === 'nothing'
    ? { runsOn: 'local', sends: 'nothing' }
    : { runsOn: 'cloud', sends: 'audio' }
}

const inUse = defineEngine({
  id: 'in-use', label: 'In use', kind: 'engine',
  // The engine dictation uses: a cloud engine (openai) uploads the take, so it needs consent.
  place: (config) => placeOfSttEngine(config.stt?.engine),
  labelFor(config) {
    const stt = config.stt
    const model = stt?.engine === 'mlx' ? stt.mlx_model : stt?.engine === 'qwen' ? `Qwen3-ASR ${stt.qwen_size ?? ''}`.trim() : stt?.engine === 'openai' ? (stt.openai_model ?? 'whisper-1') : undefined
    return stt?.engine ? `In use: ${stt.engine}${model ? ` (${model})` : ''}` : 'In use'
  },
  async status(config) {
    // The engine dictation uses (one per server): its availability checks are shared.
    const { getOrCreateEngine } = await stt()
    const engine = getOrCreateEngine(config)
    if (!engine) return { state: 'not-installed', detail: 'No voice engine is set up', fix: 'set-up-dictation' }
    const { available, error } = await engine.isAvailable().catch((err: unknown) => ({ available: false, error: String(err) }))
    return available ? { state: 'ready' } : { state: 'not-installed', ...(error ? { detail: error } : {}), fix: 'set-up-dictation' }
  },
  async run(input, { config, signal }) {
    if (!input.audio || !input.format) throw new Error('no audio for this take')
    const { transcribeAudio } = await stt()
    const t0 = Date.now()
    // A comparison hearing: dictation's live language memory is left alone.
    const result = await transcribeAudio(config, { audio: input.audio, format: input.format, language: config.stt?.language, signal }, { comparison: true })
    return { text: result.text, ms: Date.now() - t0, model: [result.engine, result.model].filter(Boolean).join(' ') || undefined }
  },
})

/** whisper-cli on a take gets ten minutes plus four times its length (no length known: two hours). */
export function whisperTimeoutMs(durationSec?: number): number {
  return 10 * 60_000 + 4_000 * Math.max(0, durationSec ?? 1800)
}

const whisper = defineEngine({
  id: 'whisper-large-v2', label: 'Whisper large-v2', kind: 'engine', place: fixed('local', 'nothing'),
  async status() {
    if (await whisperModelPath()) return { state: 'ready' }
    const dir = await whisperModelDir()
    return { state: 'not-installed', detail: `It needs ${join(dir, WHISPER_FILES[1]!)} (or ${WHISPER_FILES[0]} in the same folder)`, fix: 'download-whisper' }
  },
  async run(input, { config, signal }) {
    if (!input.audio || !input.format) throw new Error('no audio for this take')
    const modelPath = await whisperModelPath()
    if (!modelPath) throw new Error('the Whisper large-v2 model is not downloaded')
    const { createEngineByName } = await stt()
    // One-shot whisper-cli of its own, never the shared engine singleton: always
    // whisper-cpp (a local process), whatever engine dictation uses. It has a
    // deadline and stops when the job is stopped, so a hung whisper-cli never blocks the runner.
    const engine = createEngineByName('whisper-cpp', { ...(config.stt ?? {}), whisper_cpp_model: modelPath }, { timeoutMs: whisperTimeoutMs(input.durationSec), abortOnSignal: true })
    if (!engine) throw new Error('whisper.cpp is not available')
    const { available, error } = await engine.isAvailable()
    if (!available) throw new Error(`whisper.cpp is not available: ${error}`)
    const result = await engine.transcribe({ audio: input.audio, format: input.format, language: config.stt?.language, signal })
    return { text: result.text, ms: result.durationMs, model: modelPath.split('/').pop() }
  },
})

const elevenLabs = defineEngine({
  id: 'elevenlabs-scribe', label: 'ElevenLabs Scribe', kind: 'engine', place: fixed('cloud', 'audio'),
  modelFor: (config) => elevenLabsModel(config),
  async status(config) {
    const { state, detail } = await elevenLabsStatus(config)
    return { state, ...(detail ? { detail } : {}) }
  },
  run: (input, { config, signal }) => runElevenLabs(input, config, signal),
})

const haikuCleanup = defineEngine({
  id: 'haiku-cleanup', label: 'In use + Haiku clean-up', kind: 'engine', place: fixed('cloud', 'text'), after: 'in-use',
  modelFor: (config) => cleanupModel(config),
  // It cleans up the in-use engine's text, so it is ready only when that engine is.
  async status(config) {
    const base = await inUse.status(config)
    if (base.state === 'ready') return { state: 'ready' }
    return { state: 'not-installed', detail: "It cleans up the In use engine's text, and that engine isn't ready", ...(base.fix ? { fix: base.fix } : {}) }
  },
  async run(input, { config, signal }) {
    if (!input.text) throw new Error('no text to clean up yet')
    const answer = await callTextModel({
      config, model: cleanupModel(config), prompt: fixPrompt(await termContext(config), input.text),
      helper: 'cleanup', maxTokens: 4096, directMs: 60_000, signal,
    })
    return { text: answer.text, ms: answer.ms, model: answer.model }
  },
})

/** The columns, in display order. */
export const COMPARE_ENGINES: readonly CompareEngine[] = [inUse, whisper, elevenLabs, haikuCleanup]

/** The AI judge: writes the reference from every engine's text. */
export const JUDGE: CompareEngine = defineEngine({
  id: 'judge', label: 'AI judge', kind: 'judge', place: fixed('cloud', 'text'),
  modelFor: (config) => judgeModel(config),
  async status() { return { state: 'ready' } },
  async run(input, { config, signal }) {
    const texts = input.texts ?? []
    if (!texts.length) throw new Error('no engine text to judge yet')
    const ctx = await termContext(config)
    const answer = await callTextModel({
      config, model: judgeModel(config), prompt: judgePrompt(ctx, texts),
      helper: 'judge', maxTokens: 8192, directMs: 180_000, signal,
    })
    return { text: answer.text, ms: answer.ms, model: answer.model, terms: termsSpoken(answer.text, ctx.terms) }
  },
})

/** Every consent row: the engines and the judge. */
export const CONSENT_ROWS: readonly CompareEngine[] = [...COMPARE_ENGINES, JUDGE]

export function engineById(id: string): CompareEngine | undefined {
  return CONSENT_ROWS.find((e) => e.id === id)
}
