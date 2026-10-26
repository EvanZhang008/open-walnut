/**
 * The companion hands a take's live pieces to the Mac while the Mac answers, so
 * the Mac transcribes while the user speaks instead of the whole file after the
 * stop (2026-10-26: a 60 s take while the Mac was up waited 16.5 s, a 4 s copy
 * and then 12.3 s for the whole file).
 *
 * Each piece the phone sends goes on to the Mac in order, one hop at a time;
 * the companion still holds its own copy (live-transcript.ts), in case the Mac
 * leaves mid-take. When the take is transcribed, the rest of the finished file's
 * samples is sent the same way, and the Mac answers the whole text from the
 * samples it holds, checked against the finished file's hash (`live-finish`),
 * before the recording is copied: the copy follows. A Mac that refuses a piece
 * (an older Walnut, a hosted engine, a gap), a hop that fails, a hand-over that
 * falls behind, or a hash that does not match ends it for that take, and the
 * take goes the ordinary way (copy, then the Mac transcribes the file).
 */

import { createHash } from 'node:crypto'
import { log } from '../../logging/index.js'
import { voicePrimaryAction } from './voice-archive-replication.js'
import { VOICE_CHUNK_BYTES } from './voice-archive.js'

interface Forward {
  /** Hops in order; each waits for the one before. */
  chain: Promise<void>
  /** Bytes waiting in `chain`, not yet answered. */
  queuedBytes: number
  /** File bytes the Mac has, by its own last answer. */
  macBytes: number
  broken: string | null
  /** The take is being finished: later pieces are not passed on. */
  finishing: boolean
  touched: number
  language?: string
}

const forwards = new Map<string, Forward>()
const MAX_FORWARDS = 16
const IDLE_MS = 30 * 60_000
const HOP_MS = 10_000
/** A hand-over this far behind the phone (about a minute of audio) has lost the race. */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024
/** A hand-over still busy this long when the take ends is not waited for. */
const DRAIN_MS = 5_000
/** More than this left to send at the stop is the copy's job, not the hand-over's. */
const MAX_REST_BYTES = 4 * VOICE_CHUNK_BYTES
/** The Mac's answer: the pieces it has queued plus the end. Under the daemon's 45 s relay limit. */
export const LIVE_FINISH_TIMEOUT_MS = 40_000

function forwardFor(id: string, language?: string): Forward {
  let f = forwards.get(id)
  if (f) return f
  const now = Date.now()
  for (const [key, old] of forwards) if (now - old.touched > IDLE_MS) forwards.delete(key)
  if (forwards.size >= MAX_FORWARDS) forwards.delete(forwards.keys().next().value!)
  f = { chain: Promise.resolve(), queuedBytes: 0, macBytes: 0, broken: null, finishing: false, touched: now, language }
  forwards.set(id, f)
  return f
}

function breakForward(id: string, f: Forward, why: string): void {
  if (f.broken) return
  f.broken = why
  log.stt.info(`live hand-over ${id} to the Mac stops: ${why}`)
}

/** The Mac forgets what it was handed for `id` (best effort). */
function tellMacDrop(id: string): void {
  void voicePrimaryAction('live-drop', id, undefined, HOP_MS).catch(() => {})
}

/** One hop: the Mac takes `bytes` at `from`, or the hand-over ends. */
async function hop(id: string, f: Forward, from: number, bytes: Buffer): Promise<void> {
  if (f.broken) return
  try {
    const result = await voicePrimaryAction('live', id, { from, audio: bytes.toString('base64'), language: f.language }, HOP_MS)
    const ack = result.body as { accepted?: unknown; receivedBytes?: unknown; gap?: unknown; reason?: unknown } | undefined
    if (ack?.accepted !== true || typeof ack.receivedBytes !== 'number') {
      breakForward(id, f, `the Mac does not take it (${typeof ack?.reason === 'string' ? ack.reason : 'no reason'})`)
    } else if (ack.gap) {
      breakForward(id, f, `the Mac is missing bytes before ${from}`)
    } else {
      f.macBytes = Math.max(f.macBytes, ack.receivedBytes)
    }
  } catch (err) {
    breakForward(id, f, `hop failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A piece the phone sent while the Mac answers: on to the Mac after the ones before it. */
export function forwardLivePiece(id: string, from: number, bytes: Buffer, language?: string): void {
  const f = forwardFor(id, language)
  if (f.broken || f.finishing) return
  f.touched = Date.now()
  if ((f.language ?? '') !== (language ?? '')) { breakForward(id, f, 'the language changed mid-take'); return }
  if (f.queuedBytes + bytes.length > MAX_QUEUED_BYTES) { breakForward(id, f, 'the link falls behind the recording'); return }
  f.queuedBytes += bytes.length
  f.chain = f.chain.then(() => hop(id, f, from, bytes)).finally(() => { f.queuedBytes -= bytes.length })
}

/** True while pieces of `id` went to the Mac and nothing ended the hand-over. */
export function hasLiveForward(id: string): boolean {
  const f = forwards.get(id)
  return !!f && !f.broken && !f.finishing
}

/** The phone cancelled the take: hops still queued are skipped, and the Mac forgets its pieces. */
export function dropLiveForward(id: string): void {
  const f = forwards.get(id)
  if (!f) return
  forwards.delete(id)
  breakForward(id, f, 'cancelled')
  tellMacDrop(id)
}

/** SHA-256 of `bytes` a megabyte at a time, so a long take does not hold the event loop. */
async function sha256(bytes: Buffer): Promise<string> {
  const hash = createHash('sha256')
  for (let at = 0; at < bytes.length; at += 1024 * 1024) {
    hash.update(bytes.subarray(at, at + 1024 * 1024))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return hash.digest('hex')
}

/**
 * The take's text from the Mac's live pieces. `file` is the finished recording
 * and `pcm` its samples, which start at `dataStart` in it: the rest of them goes
 * to the Mac first (never what follows them in the file, which the live pieces
 * never had), then it answers from the samples it holds, checked against `pcm`.
 * Null whenever that cannot be trusted; the take then goes the ordinary way.
 * The caller races it against the Mac leaving.
 */
export async function finishOnMac(id: string, file: Buffer, dataStart: number, pcm: Int16Array, language: string | undefined): Promise<string | null> {
  const f = forwards.get(id)
  if (!f || f.broken || f.finishing) return null
  f.finishing = true
  try {
    return await finish(id, f, file, dataStart, pcm, language)
  } finally {
    if (forwards.get(id) === f) forwards.delete(id)
  }
}

async function finish(id: string, f: Forward, file: Buffer, dataStart: number, pcm: Int16Array, language: string | undefined): Promise<string | null> {
  // The Mac keeps what it holds: when it is asked to transcribe the file next,
  // the samples it already did are reused if they match the file's start.
  const giveUp = (why: string): null => { breakForward(id, f, why); return null }
  if ((f.language ?? '') !== (language ?? '')) { tellMacDrop(id); return giveUp('asked in another language') }
  let timer: ReturnType<typeof setTimeout> | undefined
  const drained = await Promise.race([
    f.chain.then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), DRAIN_MS); timer.unref?.() }),
  ]).finally(() => clearTimeout(timer))
  if (!drained) return giveUp('earlier pieces still on their way')
  const end = dataStart + pcm.byteLength
  if (f.macBytes < dataStart || end > file.length) return giveUp('the finished file does not line up')
  if (end - f.macBytes > MAX_REST_BYTES) return giveUp(`${end - f.macBytes} bytes left to send`)
  while (!f.broken && f.macBytes < end) {
    const from = f.macBytes
    await hop(id, f, from, file.subarray(from, Math.min(end, from + VOICE_CHUNK_BYTES)))
    if (f.macBytes <= from) break
  }
  if (f.broken) return null
  if (f.macBytes !== end) return giveUp('the Mac holds more than the finished samples')
  const samples = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  try {
    const result = await voicePrimaryAction('live-finish', id, { pcmBytes: samples.length, pcmSha256: await sha256(samples), language }, LIVE_FINISH_TIMEOUT_MS)
    const text = (result.body as { text?: unknown } | undefined)?.text
    return typeof text === 'string' ? text : null
  } catch (err) {
    log.stt.info(`live hand-over ${id}: the Mac did not finish it (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

/** Test hook. */
export function _resetLiveForwardsForTest(): void { forwards.clear() }
