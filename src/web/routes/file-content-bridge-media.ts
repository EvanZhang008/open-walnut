import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { attachmentDisposition, parseRangeHeader } from './file-content.js'
import { parseIfNoneMatch } from './file-content-validator.js'
import {
  classifyBridgeReadFailure, FILE_RELAY_TIMEOUT_MS, MAX_BRIDGE_FILE_BYTES, type BridgeReadResult,
} from './file-content-bridge.js'

/** Only raw audio/video uses the chunk lane; documents retain their whole-read cap. */
export const BRIDGE_MEDIA_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'ogg'])
export const BRIDGE_MEDIA_CHUNK_BYTES = 1024 * 1024

type Failure = Exclude<BridgeReadResult, { status: 'ok' }>
type Part = { size: number; offset: number; mtimeMs: number; version: string; buf: Buffer }
type ReadResult = { status: 'ok'; part: Part } | { status: 'whole'; buf: Buffer } | Failure | { status: 'closed' }

/** A deadline on every RPC, and a close race even while a bridge request is pending. */
async function readPart(
  host: string, filePath: string, offset: number, length: number,
  signal: AbortSignal, expected?: Part,
): Promise<ReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const { bridgeRequest } = await import('../ws/bridge-registry.js')
    if (signal.aborted) return { status: 'closed' }
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const reply = await Promise.race([
      bridgeRequest(host, 'fs.readBounded', {
        path: filePath, range: true, offset, length,
        ...(expected ? { expectedVersion: expected.version } : {}),
      }, FILE_RELAY_TIMEOUT_MS),
      cancelled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Media bridge read timed out')), FILE_RELAY_TIMEOUT_MS)
      }),
    ])
    if (reply === null) return { status: 'closed' }
    if (reply.ok !== true) {
      const failure = classifyBridgeReadFailure(String(reply.error ?? 'unknown daemon error'))
      // An old whole-read handler ignores range:true and can refuse its 2 MB cap.
      return { status: 'failed', failure: failure.kind === 'too_large' ? { kind: 'needs_upgrade' } : failure }
    }
    if (reply.offset === undefined || reply.version === undefined) {
      // An old daemon ignored range:true and sent the whole file. Never read it
      // as a chunk; at the probe, a file within the old cap is served whole.
      if (offset !== 0 || expected || typeof reply.data !== 'string') {
        return { status: 'failed', failure: { kind: 'needs_upgrade' } }
      }
      const whole = Buffer.from(reply.data, 'base64')
      return whole.length <= MAX_BRIDGE_FILE_BYTES
        ? { status: 'whole', buf: whole }
        : { status: 'failed', failure: { kind: 'needs_upgrade' } }
    }
    if (reply.offset !== offset || !Number.isSafeInteger(reply.size) || (reply.size as number) < 0
      || typeof reply.version !== 'string' || reply.version.length === 0
      || typeof reply.mtimeMs !== 'number' || !Number.isFinite(reply.mtimeMs)
      || reply.encoding !== 'base64' || typeof reply.data !== 'string'
      || reply.data.length > 4 * Math.ceil(BRIDGE_MEDIA_CHUNK_BYTES / 3)
      || (expected && (reply.version !== expected.version || reply.size !== expected.size
        || reply.mtimeMs !== expected.mtimeMs))) {
      return { status: 'failed', failure: { kind: 'error', message: 'Invalid or changed media range reply' } }
    }
    const buf = Buffer.from(reply.data, 'base64')
    const size = reply.size as number
    if (buf.length !== Math.min(length, Math.max(0, size - offset))) {
      return { status: 'failed', failure: { kind: 'error', message: 'Truncated media range reply' } }
    }
    return { status: 'ok', part: { size, offset, mtimeMs: reply.mtimeMs, version: reply.version, buf } }
  } catch (err) {
    return { status: 'offline', message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Returns a probe failure for the existing failure/copy ladder, or an old daemon's whole
 *  file (2 MB at most) for the whole-file answer; a started stream owns its errors. */
export async function serveBridgeMedia(
  req: Request, res: Response, host: string, filePath: string, ctype: string, download: boolean,
): Promise<BridgeReadResult | null> {
  let isClosed = res.destroyed || res.writableEnded
  const controller = new AbortController()
  const onClose = () => { isClosed = true; controller.abort() }
  res.once('close', onClose)
  if (isClosed) controller.abort()
  try {
    if (isClosed) return null
    const probe = await readPart(host, filePath, 0, 0, controller.signal)
    if (isClosed || probe.status === 'closed') return null
    if (probe.status === 'whole') return { status: 'ok', buf: probe.buf }
    if (probe.status !== 'ok') return probe
    const meta = probe.part
    const etag = `"${createHash('sha256').update(meta.version).digest('hex')}"`
    res.set('ETag', etag)
    const condition = parseIfNoneMatch(req.headers['if-none-match'])
    if (condition && (condition.wildcard || condition.tags.includes(etag.slice(1, -1)))) {
      res.status(304).end()
      return null
    }
    // Only an exact strong validator can resume this version. Date validators
    // conservatively get a full response, so seconds precision cannot mix bytes.
    const ifRange = req.headers['if-range']
    const range = parseRangeHeader(req.method === 'GET' && (ifRange === undefined || ifRange === etag) ? req.headers.range : undefined, meta.size)
    if (range === 'unsatisfiable') {
      res.status(416).set({ 'Content-Range': `bytes */${meta.size}`, 'Accept-Ranges': 'bytes' }).end()
      return null
    }
    const start = range ? range.start : 0
    const end = range ? range.end : meta.size - 1
    res.status(range ? 206 : 200).set({
      'Content-Type': ctype,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${meta.size}` } : {}),
      ...(download ? { 'Content-Disposition': attachmentDisposition(filePath) } : {}),
    })
    if (req.method === 'HEAD' || end < start) { res.end(); return null }
    res.flushHeaders()
    for (let offset = start; offset <= end;) {
      if (isClosed || res.writableEnded) return null
      const length = Math.min(BRIDGE_MEDIA_CHUNK_BYTES, end - offset + 1)
      const chunk = await readPart(host, filePath, offset, length, controller.signal, meta)
      if (isClosed || chunk.status === 'closed') return null
      if (chunk.status !== 'ok') { res.destroy(); return null }
      const ready = res.write(chunk.part.buf)
      offset += length
      if (!ready) {
        const drained = await new Promise<boolean>((resolve) => {
          const done = (ready: boolean) => {
            clearTimeout(timer)
            res.off('drain', onDrain)
            res.off('close', onClosed)
            resolve(ready)
          }
          const onDrain = () => done(true)
          const onClosed = () => done(false)
          const timer = setTimeout(() => { done(false); res.destroy() }, FILE_RELAY_TIMEOUT_MS)
          res.once('drain', onDrain)
          res.once('close', onClosed)
          if (res.destroyed) onClosed()
        })
        if (!drained) return null
      }
    }
    if (!isClosed) res.end()
    return null
  } finally {
    res.off('close', onClose)
    controller.abort()
  }
}
