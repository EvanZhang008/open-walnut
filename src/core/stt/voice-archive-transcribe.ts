import { isCompanion } from '../server-role.js'
import { voiceArchive, VoiceArchiveError, voiceAsr, type VoiceAsr, type VoiceRecord } from './voice-archive.js'
import { deferVoiceReplication, replicateUnlessSilent, replicateVoiceRecording, voicePrimaryAction, VOICE_TRANSCRIBE_TIMEOUT_MS } from './voice-archive-replication.js'
import { dropLive, finishLive, hasLiveTake, takeLiveStats, type LiveTranscribe } from './live-transcript.js'
import { dropLiveForward, finishOnMac, hasLiveForward } from './live-forward.js'
import { cafToWav, cafDataLayout } from './caf-to-wav.js'
import { isConformingWav } from './audio-convert.js'
import { wavPcm } from './wav-segment.js'

export interface VoiceTranscript { text: string; via?: string; recordingId: string; primarySaved?: boolean; storage: 'companion' | 'primary'; asr?: VoiceAsr }
const reply = (record: VoiceRecord): VoiceTranscript => ({ text: record.text ?? '', via: record.via, recordingId: record.id, primarySaved: record.primarySaved, storage: record.storage, ...(record.asr ? { asr: record.asr } : {}) })
const pending = new Map<string, Promise<VoiceTranscript>>()
/** The companion: the Mac transcribes while it answers, this box's engine when it does not. */
const FOLLOWER = isCompanion()
/** A copy hop the Mac leaves unanswered this long means it is gone, when this box can do the work. */
export const MAC_SILENCE_MS = 2_500
/** The pause between two checks that the Mac transcribing a take is still there. */
const AWAY_POLL_MS = 1_000

/**
 * When voice calls to the Mac last went unanswered. Until the Mac is heard after
 * it (its next beat, an answered call, its bridge connecting again, or 20 s at
 * most), voice work stays on this box: a Mac asleep behind a live bridge counts
 * as silent only after 45 s, which is most of a take (2026-10-24: every take in
 * that window paid the 2.5 s copy wait and got no head start).
 */
let macQuietAt = 0
let unhookQuiet: (() => void) | null = null
/** A quiet mark nothing renews is dropped after this long (a Mac that sends no beats). */
const QUIET_TTL_MS = 20_000
/** Probes of a held take left unanswered in a row; two make the Mac quiet. */
let probesQuiet = 0
let probing = false

export function _resetMacQuietForTest(): void { macQuietAt = 0; probesQuiet = 0; probing = false }

/** Voice calls went unanswered at `at`. A bridge that connects again means the Mac is back. */
function noteMacQuiet(at: number): void {
  macQuietAt = Math.max(macQuietAt, at)
  // A new mark starts a new count: after it clears, two probes in a row are needed again.
  probesQuiet = 0
  if (unhookQuiet) return
  unhookQuiet = () => {}
  void import('../../web/ws/bridge-registry.js').then(({ addPrimaryBridgeConnectedHandler }) => {
    unhookQuiet = addPrimaryBridgeConnectedHandler(() => { macQuietAt = 0 })
  }).catch(() => { unhookQuiet = null })
}

/** Whether the Mac is there by the companion's own view: bridge up, heard lately, no forward left unanswered. */
async function macReachable(): Promise<boolean> {
  if (!FOLLOWER) return false
  try {
    if (!(await import('../../web/ws/bridge-registry.js')).bridgeForHost('__local__').connected) return false
    const { getV1Forward } = await import('../../web/v1-forward/proxy.js')
    return !(await getV1Forward().primaryAway())
  } catch {
    return true
  }
}

/** Whether the Mac answers voice work: reachable, and not quiet to voice calls since it was last heard. */
async function macAnswers(): Promise<boolean> {
  if (!(await macReachable())) return false
  if (!macQuietAt) return true
  try {
    const { getBackupLeader } = await import('../leader/backup-leader.js')
    const seen = (await getBackupLeader())?.status().primaryLastSeenAt ?? 0
    if (seen <= macQuietAt && Date.now() - macQuietAt < QUIET_TTL_MS) return false
  } catch { /* no view of its beats: the mark stands until it expires */
    if (Date.now() - macQuietAt < QUIET_TTL_MS) return false
  }
  macQuietAt = 0
  return true
}

/** This server's own engine can transcribe right now (set, not hosted, installed). */
async function localReady(): Promise<boolean> {
  try {
    const [{ getConfig }, { getOrCreateEngine }] = await Promise.all([import('../config-manager.js'), import('./index.js')])
    const config = await getConfig()
    const name = config.stt?.engine
    if (!name || name === 'openai') return false
    return (await getOrCreateEngine(config)?.isAvailable())?.available === true
  } catch {
    return false
  }
}

/** Ask the Mac something small: 'quiet' when no answer comes within the copy's silence budget. */
function askMac(id: string): Promise<'answered' | 'quiet'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const quiet = new Promise<'quiet'>((resolve) => { timer = setTimeout(() => resolve('quiet'), MAC_SILENCE_MS); timer.unref?.() })
  const answer = voicePrimaryAction('get', id, undefined, MAC_SILENCE_MS).then(
    () => 'answered' as const,
    // A refusal (the Mac has no such recording yet) is an answer.
    (err: unknown) => typeof (err as { status?: unknown })?.status === 'number' ? 'answered' as const : 'quiet' as const,
  ).then((heard) => {
    // An answer, even a late one, is the Mac being there.
    if (heard === 'answered') { macQuietAt = 0; probesQuiet = 0 }
    return heard
  })
  return Promise.race([answer, quiet]).finally(() => clearTimeout(timer))
}

/**
 * A take is being recorded while the Mac looks there: find out whether it still
 * answers, at most one call at a time (the phone sends a piece every few
 * seconds). Two left unanswered in a row (one can queue behind a large copy on
 * a slow link) and the take's pieces are this box's to transcribe from the next
 * one on, so a Mac that falls asleep mid-take still leaves only the end.
 */
export function probeMacForTake(id: string): void {
  if (!FOLLOWER || probing) return
  probing = true
  const asked = Date.now()
  void askMac(id).then((heard) => {
    probing = false
    if (heard === 'quiet' && ++probesQuiet >= 2) noteMacQuiet(asked)
  })
}

/**
 * Resolves once the Mac is away while it transcribes a take: by the companion's
 * own view, or because it left two small calls in a row unanswered. Its engine
 * runs beside its server, which still answers while it works; a Mac that falls
 * asleep only counts as silent after 45 s (2026-10-24: a Mac stopped
 * mid-transcription held the take for 39 s). Two, not one: a busy Mac that is
 * slow to answer once still has the take done long before this box would.
 * `stop()` ends the watch.
 */
function whenMacAway(id: string): { away: Promise<'away'>; stop: () => void } {
  let stopped = false
  let quietInRow = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const away = new Promise<'away'>((resolve) => {
    const tick = async (): Promise<void> => {
      const asked = Date.now()
      // Reachable, not the voice quiet mark: a probe of another take that went
      // unanswered while this Mac works must not take this take away from it.
      const [up, heard] = await Promise.all([macReachable(), askMac(id)])
      if (stopped) return
      quietInRow = heard === 'quiet' ? quietInRow + 1 : 0
      if (quietInRow >= 2) noteMacQuiet(asked)
      if (!up || quietInRow >= 2) { resolve('away'); return }
      timer = setTimeout(() => { void tick() }, AWAY_POLL_MS)
      timer.unref?.()
    }
    timer = setTimeout(() => { void tick() }, AWAY_POLL_MS)
    timer.unref?.()
  })
  return { away, stop: () => { stopped = true; clearTimeout(timer) } }
}

function languageValue(body: unknown): string | undefined {
  const language = (body as { language?: unknown } | null)?.language
  if (language !== undefined && (typeof language !== 'string' || language.length > 100)) throw new VoiceArchiveError(400, 'bad_request', 'language must be a string of at most 100 characters')
  return language as string | undefined
}
/**
 * Whether this server takes live pieces of a take: it has its own engine (a
 * hosted one is paid per call and gets the whole file once). `now`: it should
 * transcribe them at once, because no Mac is there to do the take; otherwise it
 * only holds them, in case the Mac leaves before the take is done.
 */
export async function liveRole(): Promise<{ takes: boolean; now: boolean }> {
  if (FOLLOWER) {
    // Pieces held for an engine that is not installed would never be used.
    if (!(await localReady())) return { takes: false, now: false }
    return { takes: true, now: !(await macAnswers()) }
  }
  const { getConfig } = await import('../config-manager.js')
  const engine = (await getConfig()).stt?.engine
  return { takes: !!engine && engine !== 'openai', now: true }
}

/** Load the model while the user is still speaking (llama-server unloads it when idle). */
export function wakeLocalEngine(): void {
  void (async () => {
    const [{ getConfig }, { getOrCreateEngine }] = await Promise.all([import('../config-manager.js'), import('./index.js')])
    const engine = getOrCreateEngine(await getConfig())
    if ((await engine?.isAvailable())?.available !== true) return
    await engine?.warmup?.()
  })().catch(() => {})
}

/** One piece through this server's own engine. */
export const localTranscribe: LiveTranscribe = async (wav, language) => {
  const [{ getConfig }, { transcribeAudio }] = await Promise.all([import('../config-manager.js'), import('./index.js')])
  return (await transcribeAudio(await getConfig(), { audio: wav.toString('base64'), format: 'wav', language })).text
}

/** This server's own engine, the language asked, the time since `since`, and the live counts of `id`. */
export async function localAsr(id: string, language: string | undefined, since: number): Promise<VoiceAsr> {
  let engine: { name: string; model?: string } | null = null
  try {
    const [{ getConfig }, { getOrCreateEngine }] = await Promise.all([import('../config-manager.js'), import('./index.js')])
    engine = getOrCreateEngine(await getConfig())
  } catch { /* the detail only */ }
  return {
    ...(engine ? { engine: engine.name } : {}), ...(engine?.model ? { model: engine.model } : {}),
    ...(language ? { language } : {}), ms: Date.now() - since, ...takeLiveStats(id),
  }
}

async function finishLiveTake(id: string, language?: string): Promise<string | null> {
  if (!hasLiveTake(id)) return null
  try {
    const { audio, record } = await voiceArchive.readAudio(id)
    const wav = record.format === 'caf' ? cafToWav(audio) : record.format === 'wav' && isConformingWav(audio) ? audio : null
    if (!wav) return null
    return await finishLive(id, wavPcm(wav), localTranscribe, language)
  } catch {
    // The whole file still goes through the ordinary path.
    return null
  }
}

/**
 * The take's text from the pieces the Mac transcribed while it was recorded
 * (live-forward.ts), or null. Asked before the recording is copied, which then
 * follows in the background: the copy alone cost 4 s of a 60 s take.
 */
async function finishLiveOnMac(id: string, language?: string): Promise<{ text: string; asr?: VoiceAsr } | null> {
  const watch = whenMacAway(id)
  try {
    const { audio, record } = await voiceArchive.readAudio(id)
    const layout = record.format === 'caf' ? cafDataLayout(audio) : null
    const wav = layout ? cafToWav(audio) : null
    if (!layout || !wav) { dropLiveForward(id); return null }
    // A Mac that leaves meanwhile hands the take back to this box at once.
    const done = await Promise.race([finishOnMac(id, audio, layout.dataStart, wavPcm(wav), language), watch.away])
    return done === 'away' ? null : done
  } catch {
    dropLiveForward(id)
    return null
  } finally {
    watch.stop()
  }
}

async function transcribe(id: string, language?: string): Promise<VoiceTranscript> {
  const since = Date.now()
  const record = await voiceArchive.get(id)
  if (record.text !== undefined) return reply(record)
  if (FOLLOWER && hasLiveForward(id) && await macAnswers()) {
    const done = await finishLiveOnMac(id, language)
    if (done !== null && done.text.trim()) {
      dropLive(id)
      // The Mac's engine and live counts; the time is the whole wait here.
      const saved = await voiceArchive.saveText(id, done.text, 'primary', { ...done.asr, ms: Date.now() - since })
      deferVoiceReplication(id)
      return reply(saved)
    }
  }
  // A Mac that is away, or connected but not answering the copy (asleep behind a
  // live bridge), leaves this box's own engines: it holds the whole recording.
  // Waiting for the Mac turned every recording made while it slept into a failure,
  // and waiting out a full hop timeout first cost 10 s of every such take
  // (2026-10-23): with an engine of its own here, a Mac quiet for 2.5 s is gone.
  const up = await macAnswers()
  const fallback = up && await localReady()
  const copied = !up ? false : fallback ? await replicateUnlessSilent(id, MAC_SILENCE_MS) : await replicateVoiceRecording(id)
  if (copied === 'silent') noteMacQuiet(Date.now())
  if (copied === true) {
    // The copy check pulls back text the Mac already saved.
    const fromMac = await voiceArchive.get(id)
    if (fromMac.text !== undefined) { dropLive(id); return reply(fromMac) }
    const watch = fallback ? whenMacAway(id) : undefined
    let primary: VoiceTranscript | 'away'
    try {
      const asked = voicePrimaryAction('transcribe', id, { language }, VOICE_TRANSCRIBE_TIMEOUT_MS).then((result) => {
        const body = result.body as VoiceTranscript
        if (typeof body?.text !== 'string' || body.recordingId !== id) throw new Error('Voice transcription reply does not match the recording')
        return body
      })
      // A Mac that leaves while transcribing hands the take back to this box. Its
      // answer, if it ever comes, stays on the Mac and is never written here; when
      // this box's text reaches the Mac first, the Mac keeps that one instead.
      primary = await (watch ? Promise.race([asked, watch.away]) : asked)
      if (primary === 'away') asked.catch(() => {})
    } catch {
      throw new VoiceArchiveError(503, 'stt_pending', 'The Mac may still be transcribing; your recording remains saved. Retry to recover its result')
    } finally {
      watch?.stop()
    }
    if (primary !== 'away') {
      dropLive(id)
      const saved = await voiceArchive.saveText(id, primary.text, primary.via, { ...voiceAsr(primary.asr), ms: Date.now() - since })
      await voiceArchive.markPrimarySaved(id, saved.text)
      return reply(await voiceArchive.get(id))
    }
  }
  // Pieces transcribed while the take was recorded leave only its end to do.
  const live = await finishLiveTake(id, language)
  // Nothing heard goes the ordinary way, which never stores an empty transcript.
  if (live !== null && live.trim()) {
    const saved = await voiceArchive.saveText(id, live, FOLLOWER ? 'local' : 'primary', await localAsr(id, language, since))
    deferVoiceReplication(id)
    return reply(saved)
  }
  const [{ getConfig }, { routeFeature }, { sttEngines, sttEngineFailure }] = await Promise.all([
    import('../config-manager.js'), import('../feature-route.js'), import('../../web/routes/stt-v1.js'),
  ])
  const config = await getConfig()
  const format = record.format
  const engines = sttEngines(config, FOLLOWER).filter((engine) => engine.id !== 'bridge').map((engine) => {
    if (format !== 'caf' || (engine.id !== 'openai' && !(engine.id === 'primary' && config.stt?.engine === 'openai'))) return engine
    return {
      ...engine,
      async run(input: { audio: string; format: string; language?: string }) {
        const { convertToWav, cleanupTempFile } = await import('./audio-convert.js')
        const { readFile } = await import('node:fs/promises')
        const wav = await convertToWav(input.audio, 'caf')
        try { return await engine.run({ ...input, audio: (await readFile(wav)).toString('base64'), format: 'wav' }) }
        finally { await cleanupTempFile(wav) }
      },
    }
  })
  const { audio } = await voiceArchive.readAudio(id)
  const result = await routeFeature(engines, { audio: audio.toString('base64'), format, language },
    (err) => /moov atom not found|Invalid data found when processing input|Error opening input/i.test(err instanceof Error ? err.message : String(err)))
  if (!result.ok) {
    if (result.verdict) {
      const failure = sttEngineFailure(result.verdict.reason)
      throw new VoiceArchiveError(failure.status, failure.code, failure.message)
    }
    if (result.attempts.some((a) => a.id === 'local' && a.reason === 'installing')) {
      const { installingNotice } = await import('../../web/routes/stt-v1.js')
      throw new VoiceArchiveError(503, 'stt_unavailable', installingNotice())
    }
    throw new VoiceArchiveError(503, 'stt_unavailable', 'Transcription is unavailable; your recording remains saved')
  }
  const output = result.output as { text: string; engine?: string; model?: string; asr?: unknown }
  const saved = await voiceArchive.saveText(id, output.text, result.via, {
    ...voiceAsr(output.asr), ...(output.engine ? { engine: output.engine } : {}), ...(output.model ? { model: output.model } : {}),
    ...(language ? { language } : {}), ms: Date.now() - since,
  })
  deferVoiceReplication(id)
  return reply(saved)
}

/** A transcribe of `id` is running here (its copy is started by it, not by a retry pass). */
export function isTranscribing(id: string): boolean { return pending.has(id) }

/** Time out the caller, not the durable result write if an engine finishes later. */
export async function transcribeVoiceRecording(raw: string, body?: unknown): Promise<VoiceTranscript> {
  const language = languageValue(body)
  const record = await voiceArchive.get(raw)
  const id = record.id
  let work = pending.get(id)
  if (!work) {
    work = transcribe(id, language).finally(() => { pending.delete(id) })
    pending.set(id, work)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new VoiceArchiveError(504, 'gateway_timeout', 'Transcription timed out; your recording remains saved')), VOICE_TRANSCRIBE_TIMEOUT_MS)
      timer.unref?.()
    })])
  } finally { if (timer) clearTimeout(timer) }
}
