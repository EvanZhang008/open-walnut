/**
 * ElevenLabs Scribe as a comparison engine (sends audio to the cloud, so it
 * runs only with the user's `allow_upload` tick, checked by the registry).
 *
 * Nothing it does may cost money. Before every take it reads
 * GET /v1/user/subscription and uploads only when:
 *  - the workspace has usage-based billing off (`max_credit_limit_extension`
 *    is 0, and the older `allowed_to_extend_character_limit` is not true):
 *    with it on, a take past the included credits would be billed, so it never
 *    uploads, whatever is left;
 *  - this take's estimated cost (its length times SCRIBE_CREDITS_PER_MINUTE)
 *    fits in what is left of the included credits minus QUOTA_FLOOR of them.
 * A take whose length cannot be read is not uploaded. A key that cannot read
 * its subscription cannot prove any of this, so it does not upload either.
 * Nothing here ever changes the plan.
 */
import { createHash } from 'node:crypto'
import type { Config } from '../../types.js'
import { compareSection, elevenLabsKey } from './settings.js'
import { EngineStateError, type EngineInput, type EngineOutput, type EngineStatus } from './types.js'

export const ELEVENLABS_DEFAULT_BASE = 'https://api.elevenlabs.io'
export const ELEVENLABS_DEFAULT_MODEL = 'scribe_v3'
/** This share of the included credits is never used. */
export const QUOTA_FLOOR = 0.1
/**
 * Credits a minute of audio costs on a subscription (elevenlabs.io/pricing,
 * read 2026-11-21: "Speech to Text 330 credits per minute"). Each take is
 * charged here by the started second, so the estimate errs high.
 */
export const SCRIBE_CREDITS_PER_MINUTE = 330
/** A refusal of speech-to-text is believed this long, then the key is tried again. */
export const DENIED_TTL_MS = 10 * 60_000
/** The quota read, its tries again included. */
const SUBSCRIPTION_DEADLINE_MS = 45_000
const STATUS_CACHE_MS = 60_000
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

export interface Quota {
  tier: string
  used: number
  limit: number
  left: number
  /** Usage-based billing is on: past the included credits a take would be billed. */
  overage: boolean
}

const baseUrl = (config: Config) => (compareSection(config).elevenlabs_base_url || ELEVENLABS_DEFAULT_BASE).replace(/\/+$/, '')
export const elevenLabsModel = (config: Config) => compareSection(config).elevenlabs_model || ELEVENLABS_DEFAULT_MODEL
const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16)

/** The last refusal of speech-to-text for a key, until `until`. */
const denied = new Map<string, { detail: string; until: number }>()
let cached: { key: string; at: number; status: EngineStatus; quota?: Quota } | null = null

/** The credits a take of `seconds` costs, rounded up. */
export function takeCredits(seconds: number): number {
  return Math.ceil(Math.ceil(Math.max(0, seconds)) * SCRIBE_CREDITS_PER_MINUTE / 60)
}

/** The credits that may still be spent: what is left of the included ones, less the floor. */
export function spendable(quota: Quota): number {
  return Math.max(0, quota.left - QUOTA_FLOOR * quota.limit)
}

function readQuota(body: unknown): Quota | null {
  const b = body as Record<string, unknown> | null
  const used = Number(b?.character_count)
  const limit = Number(b?.character_limit)
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null
  const extension = b?.max_credit_limit_extension
  // Any extension but a plain 0 is usage-based billing (`"unlimited"`, a number, or a field we cannot read).
  const overage = (extension !== undefined && extension !== 0) || b?.allowed_to_extend_character_limit === true
  return { tier: typeof b?.tier === 'string' ? b.tier : 'unknown', used, limit, left: Math.max(0, limit - used), overage }
}

/** The state an ElevenLabs refusal stands for, from its status and body. */
function refusalOf(status: number, body: string): { state: 'key-lacks-permission' | 'quota-used'; detail: string } | null {
  if (/quota_exceeded|insufficient|credits?_|limit_exceeded/i.test(body) || status === 402 || (status === 429 && /quota/i.test(body))) {
    return { state: 'quota-used', detail: 'ElevenLabs says the quota is used up' }
  }
  if (status === 401 || status === 403) {
    return { state: 'key-lacks-permission', detail: /missing_permissions|permission/i.test(body) ? 'The key is not allowed to use speech-to-text' : 'ElevenLabs refused the key' }
  }
  return null
}

/**
 * Waits before each try again. ElevenLabs often answers a busy 429 ("system_busy",
 * about 4 calls in 10 on 2026-11-23, the subscription read included) and sometimes
 * drops the TLS handshake; tried once, a busy answer to the quota read left the
 * engine out of a whole job, and one to an upload failed the take.
 */
let retryDelaysMs = [1_000, 3_000, 7_000]
const RETRY_AFTER_MAX_MS = 15_000

/** A busy or failing server: 429 that is not about the quota, or 5xx. */
const busy = (status: number, body: string) => (status === 429 && !/quota/i.test(body)) || status >= 500

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason)
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason) }
  signal?.addEventListener('abort', onAbort, { once: true })
})

/**
 * One call to ElevenLabs, tried again after a busy answer or a dropped
 * connection (the request is built again for each try). A stop or a timeout of
 * the caller's own is never tried again. The last answer is returned with its body read.
 */
async function callElevenLabs(url: string, init: () => RequestInit, signal: AbortSignal): Promise<{ res: Response; body: string }> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= retryDelaysMs.length
    let wait = retryDelaysMs[attempt] ?? 0
    try {
      const res = await fetch(url, { ...init(), signal })
      const body = await res.text()
      if (last || !busy(res.status, body)) return { res, body }
      const after = Number(res.headers.get('retry-after'))
      if (Number.isFinite(after) && after > 0) wait = Math.min(RETRY_AFTER_MAX_MS, after * 1000)
    } catch (err) {
      if (last || signal.aborted) throw err
    }
    await pause(wait, signal)
  }
}

/** The quota now, or the state that stops an upload. */
export async function checkQuota(config: Config, key: string): Promise<{ status: EngineStatus; quota?: Quota }> {
  let res: Response
  let text: string
  try {
    ({ res, body: text } = await callElevenLabs(`${baseUrl(config)}/v1/user/subscription`, () => ({ headers: { 'xi-api-key': key } }), AbortSignal.timeout(SUBSCRIPTION_DEADLINE_MS)))
  } catch (err) {
    return { status: { state: 'not-installed', detail: `ElevenLabs could not be reached: ${err instanceof Error ? err.message : String(err)}` } }
  }
  if (res.status === 401 || res.status === 403) {
    return { status: { state: 'key-lacks-permission', detail: 'The key cannot read its subscription, so its free quota cannot be checked (give it the user read permission).' } }
  }
  if (!res.ok) return { status: { state: 'not-installed', detail: `ElevenLabs answered ${res.status} for the subscription` } }
  const quota = readQuota(parseJson(text))
  if (!quota) return { status: { state: 'not-installed', detail: 'The subscription answer has no quota in it' } }
  if (quota.overage) {
    return { status: { state: 'may-cost', detail: 'Usage-based billing is on for this key, so a take could cost money: Walnut uploads nothing (turn it off, or use a free-plan key)' }, quota }
  }
  if (quota.limit <= 0 || quota.left <= QUOTA_FLOOR * quota.limit) {
    return { status: { state: 'quota-used', detail: quota.tier === 'free' ? 'free quota used up' : 'included quota used up' }, quota }
  }
  return { status: { state: 'ready' }, quota }
}

/** The engine's state without consent (the registry adds that): key, permission, quota. */
export async function elevenLabsStatus(config: Config, fresh = false): Promise<EngineStatus & { quota?: Quota }> {
  const key = elevenLabsKey(config)
  if (!key) return { state: 'needs-key', detail: 'Add an ElevenLabs API key' }
  const fp = fingerprint(key)
  const refusal = denied.get(fp)
  if (refusal && refusal.until > Date.now()) return { state: 'key-lacks-permission', detail: refusal.detail }
  if (refusal) denied.delete(fp)
  if (!fresh && cached && cached.key === fp && Date.now() - cached.at < STATUS_CACHE_MS) return { ...cached.status, ...(cached.quota ? { quota: cached.quota } : {}) }
  const checked = await checkQuota(config, key)
  cached = { key: fp, at: Date.now(), ...checked }
  return { ...checked.status, ...(checked.quota ? { quota: checked.quota } : {}) }
}

/** The settings wrote the key (or its permissions may have changed): everything known about it is forgotten. */
export function forgetElevenLabsKeyState(): void {
  denied.clear()
  cached = null
}

async function uploadable(input: EngineInput): Promise<{ audio: Buffer; format: string; durationSec?: number }> {
  if (!input.audio || !input.format) throw new Error('no audio for this take')
  if (input.format === 'caf') {
    const { cafToWav } = await import('../caf-to-wav.js')
    const wav = cafToWav(Buffer.from(input.audio, 'base64'))
    // 16 kHz mono 16-bit, the header counted: errs long.
    if (wav) return { audio: wav, format: 'wav', durationSec: Math.ceil(wav.length / 32_000) }
  }
  const { audioForUpload } = await import('../audio-convert.js')
  return audioForUpload(input.audio, input.format, MAX_UPLOAD_BYTES)
}

/** Generous for a slow upload: a minute plus twice the take's length, at most 15 minutes. */
const uploadTimeoutMs = (seconds?: number) => Math.min(15 * 60_000, 60_000 + 2_000 * Math.max(0, seconds ?? 120))

export async function runElevenLabs(input: EngineInput, config: Config, signal?: AbortSignal): Promise<EngineOutput> {
  const key = elevenLabsKey(config)
  if (!key) throw new EngineStateError('needs-key', 'Add an ElevenLabs API key')
  // Checked before every take: the quota moves with each one.
  const { status, quota } = await checkQuota(config, key)
  if (status.state !== 'ready' || !quota) throw new EngineStateError(status.state, status.detail ?? status.state)
  const { audio, format, durationSec: decoded } = await uploadable(input)
  // The length of what is uploaded; else what the recording says it is.
  const seconds = decoded ?? input.durationSec
  if (seconds === undefined || !Number.isFinite(seconds)) throw new Error('the take\'s length could not be read here, so its cost cannot be checked: not uploaded')
  const cost = takeCredits(seconds)
  if (cost > spendable(quota)) {
    throw new EngineStateError('quota-used', `this take needs about ${cost} credits and only ${Math.floor(spendable(quota))} may be used before the 10% kept back`)
  }
  signal?.throwIfAborted()
  const model = elevenLabsModel(config)
  const upload = (): RequestInit => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)]), `take.${format}`)
    form.append('model_id', model)
    form.append('tag_audio_events', 'false')
    return { method: 'POST', headers: { 'xi-api-key': key }, body: form }
  }
  const t0 = Date.now()
  const timeout = AbortSignal.timeout(uploadTimeoutMs(seconds))
  const { res, body } = await callElevenLabs(`${baseUrl(config)}/v1/speech-to-text`, upload, signal ? AbortSignal.any([signal, timeout]) : timeout)
  if (!res.ok) {
    const refusal = refusalOf(res.status, body)
    if (refusal?.state === 'key-lacks-permission') denied.set(fingerprint(key), { detail: refusal.detail, until: Date.now() + DENIED_TTL_MS })
    if (refusal) { cached = null; throw new EngineStateError(refusal.state, refusal.detail) }
    throw new Error(`ElevenLabs answered ${res.status}: ${body.slice(0, 200)}`)
  }
  const heard = parseJson(body) as { text?: unknown } | null
  if (typeof heard?.text !== 'string') throw new Error('ElevenLabs answered with no text')
  return { text: heard.text.trim(), ms: Date.now() - t0, model }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

/** Test hook. */
export function _resetElevenLabsForTest(delaysMs: number[] = [0, 0, 0]): void {
  forgetElevenLabsKeyState()
  retryDelaysMs = delaysMs
}
