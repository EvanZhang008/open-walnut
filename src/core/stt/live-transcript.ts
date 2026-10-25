/**
 * Transcribe a take WHILE it is being recorded, so stopping leaves only the last
 * few seconds to do.
 *
 * The phone sends the growing recording file in pieces (POST
 * /api/v1/stt/recordings/:id/live, { from, audio }) while the take runs. This
 * keeps the samples since the last cut, and once 12 s have gathered it cuts at
 * the quietest moment past 6 s, if that moment is a pause (a word is never cut;
 * without one it waits, up to 24 s), and hands that piece to the local engine,
 * one at a time. While another machine is expected to transcribe the take (the
 * companion while the Mac answers) the pieces are only held: the engine starts
 * on them the moment that machine is gone, so a Mac that sleeps mid-take still
 * leaves only the end to do, and a Mac that answers costs this box no CPU.
 * When the finished recording is transcribed (voice-archive-transcribe.ts), the
 * pieces already done are reused if the finished file holds exactly the samples
 * they were made from (checked by hash), and only the rest is transcribed. Anything that does not line up (a gap, a
 * different format, an engine error, a restart that lost this memory) just falls
 * back to transcribing the whole file: live is a head start, never the record.
 *
 * Held in memory only, bounded per take (the samples since the last cut, and at
 * most 5 min of audio held or waiting for the engine: a take past that, an engine
 * falling that far behind or another machine holding it that long, gives no head
 * start and stops) and in the number of takes, and dropped when the phone
 * cancels the take, when another machine answered it, or 30 min after its last
 * piece.
 */

import { createHash, type Hash } from 'node:crypto'
import { log } from '../../logging/index.js'
import { cafDataLayout } from './caf-to-wav.js'
import { SAMPLE_RATE, pcmToWav, segmentBoundaries, joinSegmentTexts } from './wav-segment.js'

/** A cut is made once this much is waiting... */
export const LIVE_CUT_AT_SEC = 12
/** ...at the quietest moment at least this far in. */
export const LIVE_CUT_MIN_SEC = 6
/** Without a pause, a cut is made anyway at this length. */
export const LIVE_CUT_MAX_SEC = 24
/** Pieces held for an engine that has not started on them yet, at most. */
export const LIVE_MAX_HELD_SEC = 5 * 60
/** A pause: a window under a tenth of the pending audio's mean loudness. */
const PAUSE_RATIO = 0.1
const WINDOW = SAMPLE_RATE / 10
const MAX_TAKES = 8
const IDLE_DROP_MS = 30 * 60_000
/** The header is in the first few KB; a take that never shows one is not PCM. */
const MAX_HEADER_BYTES = 64 * 1024
/** Takes finished or cancelled lately: a late piece must not start one again. */
const DONE_TTL_MS = 10 * 60_000

export type LiveTranscribe = (wav: Buffer, language?: string) => Promise<string>

interface Segment { from: number; to: number; text: string }

interface Take {
  /** File bytes received so far, contiguous from 0. */
  fileBytes: number
  head: Buffer
  dataStart: number | null
  /** One odd byte left over between pieces. */
  carry: Buffer | null
  /** Samples since the last cut. */
  pending: Int16Array[]
  pendingSamples: number
  /** Sample index where `pending` begins. */
  cutAt: number
  /** Hash of every sample received, in order, and how many bytes it covers. */
  hash: Hash
  pcmBytes: number
  segments: Segment[]
  /** Cut pieces the engine has not been asked for yet (`eager` is still false). */
  held: Array<{ from: number; pcm: Int16Array }>
  heldSamples: number
  /** This server transcribes the take now; set once, never cleared. */
  eager: boolean
  queue: Promise<void>
  failed: string | null
  /** Samples handed to the engine and not done yet. */
  queuedSamples: number
  touched: number
  language?: string
}

const takes = new Map<string, Take>()
const done = new Map<string, number>()
let sweeper: NodeJS.Timeout | null = null

function sweep(): void {
  const now = Date.now()
  for (const [id, take] of takes) if (now - take.touched > IDLE_DROP_MS) drop(id, take, 'idle')
  for (const [id, at] of done) if (now - at > DONE_TTL_MS) done.delete(id)
  if (takes.size === 0 && done.size === 0 && sweeper) { clearInterval(sweeper); sweeper = null }
}

function markDone(id: string): void {
  done.set(id, Date.now())
  if (done.size > 64) done.delete(done.keys().next().value!)
}

/** Forget a take; anything still queued for it is skipped. */
function drop(id: string, take: Take, why: string): void {
  fail(id, take, why)
  takes.delete(id)
  markDone(id)
}

function fail(id: string, take: Take, why: string): void {
  if (take.failed) return
  take.failed = why
  take.pending = []
  take.pendingSamples = 0
  take.held = []
  take.heldSamples = 0
  log.stt.info(`live transcript ${id} stops: ${why}`)
}

function concat(parts: Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** Quietest 100 ms from `fromSec` to the end of `pcm`, and whether it is a pause. */
function quietCut(pcm: Int16Array, fromSec = LIVE_CUT_MIN_SEC): { at: number; pause: boolean } {
  let best = pcm.length
  let bestEnergy = Number.POSITIVE_INFINITY
  let total = 0
  for (let i = 0; i < pcm.length; i++) total += pcm[i] * pcm[i]
  for (let w = Math.round(fromSec * SAMPLE_RATE); w + WINDOW <= pcm.length; w += WINDOW) {
    let e = 0
    for (let i = w; i < w + WINDOW; i++) e += pcm[i] * pcm[i]
    if (e < bestEnergy) { bestEnergy = e; best = w + WINDOW / 2 }
  }
  const mean = (total / pcm.length) * WINDOW
  return { at: best, pause: bestEnergy <= mean * PAUSE_RATIO }
}

/** Hand the held pieces to the engine, in order. */
function release(id: string, take: Take, transcribe: LiveTranscribe): void {
  while (take.held.length && !take.failed) {
    const piece = take.held.shift()!
    take.heldSamples -= piece.pcm.length
    schedule(id, take, piece.from, piece.pcm, transcribe)
  }
}

function hold(id: string, take: Take, from: number, pcm: Int16Array, transcribe: LiveTranscribe): void {
  take.held.push({ from, pcm })
  take.heldSamples += pcm.length
  // Audio not transcribed yet, held or queued, is what this take holds in memory.
  if (take.heldSamples + take.queuedSamples > LIVE_MAX_HELD_SEC * SAMPLE_RATE) {
    fail(id, take, take.eager ? 'the engine falls behind the recording' : 'held too long for another machine')
    return
  }
  if (take.eager) release(id, take, transcribe)
}

function schedule(id: string, take: Take, from: number, pcm: Int16Array, transcribe: LiveTranscribe): void {
  // Only the WAV is kept while the piece waits: the closure below must not hold the samples too.
  const wav = pcmToWav(pcm)
  const samples = pcm.length
  take.queuedSamples += samples
  take.queue = take.queue.then(async () => {
    try {
      // One retry: a busy engine should not cost the whole head start.
      for (let attempt = 0; !take.failed; attempt++) {
        try {
          const text = await transcribe(wav, take.language)
          take.segments.push({ from, to: from + samples, text })
          return
        } catch (err) {
          if (attempt >= 1) fail(id, take, `segment failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      take.queuedSamples -= samples
    }
  })
}

function addSamples(id: string, take: Take, bytes: Buffer, transcribe: LiveTranscribe): void {
  let data = take.carry ? Buffer.concat([take.carry, bytes]) : bytes
  take.carry = data.length % 2 ? data.subarray(data.length - 1) : null
  if (take.carry) data = data.subarray(0, data.length - 1)
  if (!data.length) return
  take.hash.update(data)
  take.pcmBytes += data.length
  const copy = Buffer.from(data)
  const samples = new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2)
  take.pending.push(samples)
  take.pendingSamples += samples.length
  while (!take.failed && take.pendingSamples >= LIVE_CUT_AT_SEC * SAMPLE_RATE) {
    const all = concat(take.pending, take.pendingSamples)
    let { at: cut, pause } = quietCut(all)
    if (!pause) {
      // No pause yet: wait for one; a piece already long is cut in its later half.
      if (all.length < LIVE_CUT_MAX_SEC * SAMPLE_RATE) {
        take.pending = [all]
        break
      }
      cut = quietCut(all, all.length / SAMPLE_RATE - LIVE_CUT_AT_SEC).at
    }
    hold(id, take, take.cutAt, all.slice(0, cut), transcribe)
    const rest = all.slice(cut)
    take.cutAt += cut
    take.pending = [rest]
    take.pendingSamples = rest.length
  }
}

export interface LiveAck { accepted: boolean; receivedBytes: number; segments: number; reason?: string }

export interface LiveOptions {
  language?: string
  /** This server transcribes the take now (default true). False only holds the pieces. */
  eager?: boolean
  /** Called once per take, when the engine is first needed: load the model while the user speaks. */
  wake?: () => void
}

/**
 * Take one piece of the growing file. Pieces already seen are skipped; a piece
 * past the bytes received is refused with the offset to resend from.
 */
export function appendLive(
  id: string, from: number, bytes: Buffer, transcribe: LiveTranscribe, opts: LiveOptions = {},
): LiveAck | { gap: true; receivedBytes: number } {
  const language = opts.language
  let take = takes.get(id)
  if (!take) {
    if (done.has(id)) return { accepted: false, receivedBytes: 0, segments: 0, reason: 'finished' }
    if (from !== 0) return { gap: true, receivedBytes: 0 }
    if (takes.size >= MAX_TAKES) {
      const oldest = [...takes.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]
      drop(oldest[0], oldest[1], 'too many takes at once')
    }
    take = {
      fileBytes: 0, head: Buffer.alloc(0), dataStart: null, carry: null, pending: [], pendingSamples: 0,
      cutAt: 0, hash: createHash('sha256'), pcmBytes: 0, segments: [], held: [], heldSamples: 0, eager: false,
      queue: Promise.resolve(),
      failed: null, queuedSamples: 0, touched: Date.now(), language,
    }
    takes.set(id, take)
    sweeper ??= setInterval(sweep, 5 * 60_000)
    sweeper.unref()
  }
  take.touched = Date.now()
  if ((opts.eager ?? true) && !take.eager && !take.failed) {
    take.eager = true
    opts.wake?.()
    release(id, take, transcribe)
  }
  if (from > take.fileBytes) return { gap: true, receivedBytes: take.fileBytes }
  const fresh = bytes.subarray(Math.min(bytes.length, take.fileBytes - from))
  if (fresh.length && !take.failed) {
    let samples = fresh
    if (take.dataStart === null) {
      // Header first: the samples start after it.
      take.head = Buffer.concat([take.head, fresh])
      const layout = cafDataLayout(take.head)
      if (!layout) {
        if (take.head.length > MAX_HEADER_BYTES) fail(id, take, 'no PCM header')
        samples = Buffer.alloc(0)
      } else if (!layout.native) {
        fail(id, take, 'not 16 kHz mono 16-bit PCM')
        samples = Buffer.alloc(0)
      } else {
        take.dataStart = layout.dataStart
        samples = take.head.subarray(layout.dataStart)
        take.head = Buffer.alloc(0)
      }
    }
    if (samples.length && !take.failed) addSamples(id, take, samples, transcribe)
  }
  take.fileBytes = Math.max(take.fileBytes, from + bytes.length)
  return { accepted: !take.failed, receivedBytes: take.fileBytes, segments: take.segments.length, ...(take.failed ? { reason: take.failed } : {}) }
}

/** The phone cancelled the take: stop its pieces and forget it. */
export function dropLive(id: string): void {
  const take = takes.get(id)
  // Marked even with nothing received yet: a piece still on its way must not start it.
  if (take) drop(id, take, 'cancelled')
  else markDone(id)
}

/** True while this server holds a live take for `id` that can still be used. */
export function hasLiveTake(id: string): boolean {
  const take = takes.get(id)
  return !!take && !take.failed
}

/**
 * The whole take's text from the pieces done live plus the rest of the finished
 * file, or null when the live pieces cannot be trusted for this file.
 * `finalPcm` is the finished recording's samples (16 kHz mono s16le).
 */
export async function finishLive(
  id: string, finalPcm: Int16Array, transcribe: LiveTranscribe, language?: string,
): Promise<string | null> {
  const take = takes.get(id)
  if (!take) return null
  takes.delete(id)
  markDone(id)
  release(id, take, transcribe)
  await take.queue
  if (take.failed) return null
  // Pieces heard in one language are not joined to an end heard in another.
  if ((take.language ?? '') !== (language ?? '')) return null
  const finalBytes = Buffer.from(finalPcm.buffer, finalPcm.byteOffset, finalPcm.byteLength)
  if (finalBytes.length < take.pcmBytes) {
    log.stt.info(`live transcript ${id} unused: the finished file is shorter than what arrived live`)
    return null
  }
  const prefix = createHash('sha256').update(finalBytes.subarray(0, take.pcmBytes)).digest('hex')
  if (prefix !== take.hash.digest('hex')) {
    log.stt.info(`live transcript ${id} unused: the finished file differs from what arrived live`)
    return null
  }
  const rest = finalPcm.subarray(take.cutAt)
  const texts = take.segments.map((s) => s.text)
  let from = 0
  for (const to of segmentBoundaries(rest)) {
    const piece = rest.subarray(from, to)
    from = to
    if (piece.length < SAMPLE_RATE / 5) continue
    texts.push(await transcribe(pcmToWav(piece), language))
  }
  log.stt.info(`live transcript ${id}: ${take.segments.length} piece(s) done live, ${(rest.length / SAMPLE_RATE).toFixed(1)}s left at the end`)
  return joinSegmentTexts(texts)
}

/** Test hook. */
export function _resetLiveTakesForTest(): void {
  takes.clear()
  done.clear()
  if (sweeper) { clearInterval(sweeper); sweeper = null }
}
