/**
 * Voice Accuracy (experimental `stt_compare`): the user's own voice takes heard
 * again by several speech-to-text engines, an AI judge's guess of what was said,
 * and each engine's error rate against that guess. Types shared by the store,
 * the engines, the runner and the routes.
 */
import type { Config } from '../../types.js'

/** Where a take's audio lives; read only, never changed by Voice Accuracy. */
export interface AudioRef {
  /** `recording`: web/Mac dictation in tmp/stt-recordings; `archive`: a phone take in voice-archive. */
  kind: 'recording' | 'archive'
  id: string
}

export interface EngineResult {
  text?: string
  error?: string
  ms: number
  at: string
  model?: string
}

export interface TakeScore {
  edits: number
  n: number
  cjkEdits: number
  cjkN: number
  latEdits: number
  latN: number
  termsHit: number
  termsNeed: number
}

export interface CompareReference {
  text: string
  /** The model id that wrote it (or the benchmark it came from). */
  judge: string
  at: string
  /** The user's terms spoken in the reference, one entry per time spoken. */
  terms?: string[]
  /** The engines whose texts the judge read: a new one arriving asks for a new reference. */
  engines?: string[]
}

export interface CompareTake {
  id: string
  source: 'web' | 'phone'
  at: string
  durationSec?: number
  format: string
  audioRef: AudioRef
  /** What the user sent after this take, kept as sent, only Walnut's hint blocks removed (sent-text.ts). */
  sentText?: string
  sentAt?: string
  /**
   * How sentText was paired with this take: `recording-id`, the send named this recording (the
   * composer it was dictated into remembered it); `text-similarity`, a guess by how alike the texts
   * are, within 15 minutes, for a send that named none.
   */
  sentMatch?: 'text-similarity' | 'recording-id'
  /**
   * How alike the sent text and the engine's are, 0 to 1 (1: the very same text): a similarity
   * pairing's, or a recording-id pairing's of one take (learn-from-sends sentAgainstDictation).
   */
  sentSimilarity?: number
  /** A recording-id pairing of one take whose sent text has words typed before or after the dictation's (never exported). */
  sentExtra?: boolean
  /**
   * A recording-id pairing whose engine text is no longer in the sent text word for word (spaces
   * aside): the user edited the dictation. A training pair kept for later (pairs.ts), unless shared
   * or taken from the message; such entries are the last the store's cap drops.
   */
  edited?: boolean
  /** The send named several takes: sentText is the whole box, not this take's alone (never exported). */
  sentShared?: boolean
  /**
   * `message`: no composer text came with the send (an older client), so sentText is the message
   * without Walnut's hint blocks, which may hold Walnut's other additions (never exported).
   */
  sentFrom?: 'message'
  /** The text Walnut produced for this take at the time. */
  inUseText?: string
  results: Record<string, EngineResult>
  reference?: CompareReference
  scores?: Record<string, TakeScore>
  imported?: string
}

/** One state per engine, shown on its row. */
export type EngineState =
  | 'off' | 'needs-consent' | 'needs-key' | 'key-lacks-permission' | 'quota-used' | 'may-cost' | 'not-installed' | 'ready'

/**
 * What the pane offers to make a not-ready engine ready: the Voice pane's dictation setup, or the
 * download of the Whisper model it needs.
 */
export type EngineFix = 'set-up-dictation' | 'download-whisper'

export interface EngineStatus { state: EngineState; detail?: string; fix?: EngineFix }

export interface EngineInput {
  /** Base64 audio, when the engine hears audio. */
  audio?: string
  format?: string
  durationSec?: number
  /** The text of the engine this one post-processes (`after`). */
  text?: string
  /** The judge reads every engine's text. */
  texts?: Array<{ engine: string; label: string; text: string }>
}

export interface EngineContext {
  config: Config
  signal?: AbortSignal
}

export interface EngineOutput { text: string; ms: number; model?: string; terms?: string[] }

/** Where an engine runs and what leaves this computer when it does. */
export interface EnginePlace {
  runsOn: 'local' | 'cloud'
  /** Anything but `nothing` needs the row's `allow_upload`. */
  sends: 'nothing' | 'audio' | 'text'
}

export interface CompareEngine {
  id: string
  label: string
  /** Read from the config each time: the in-use engine may be a cloud engine. */
  place(config: Config): EnginePlace
  /** Post-processes the text of another engine instead of hearing the audio. */
  after?: string
  /** The judge is a consent row, not a column. */
  kind: 'engine' | 'judge'
  /** The label that names what actually runs (the configured engine and model). */
  labelFor?(config: Config): string
  /** The model id it would use now, shown as secondary detail on its row. */
  modelFor?(config: Config): string | undefined
  status(config: Config): Promise<EngineStatus>
  run(input: EngineInput, ctx: EngineContext): Promise<EngineOutput>
}

/** An engine that refused to run because the user switched it (or the experiment) off. */
export class EngineOffError extends Error {
  constructor(readonly engineId: string) {
    super(`${engineId} is switched off`)
    this.name = 'EngineOffError'
  }
}

/** An engine that refused to run for want of consent. */
export class ConsentRequiredError extends Error {
  constructor(readonly engineId: string) {
    super(`${engineId} needs your consent to upload before it runs`)
    this.name = 'ConsentRequiredError'
  }
}

/** An engine failure that says which state the engine is in now (a bad key, used-up quota). */
export class EngineStateError extends Error {
  constructor(readonly state: EngineState, message: string) {
    super(message)
    this.name = 'EngineStateError'
  }
}
