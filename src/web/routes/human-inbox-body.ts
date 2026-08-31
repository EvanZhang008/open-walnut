/**
 * `GET /api/v1/human-inbox/:id/body` — the letter document as a STREAM.
 *
 * Why this route exists at all: a letter body can be 100MB (a digest with its
 * podcast inline, a screen recording), and the letter-detail JSON used to carry
 * it as a string. That made the size of a letter's media decide the size of a
 * JSON response, which then had to fit every framing hop on the way to the
 * phone — and `ws` enforces its 32MB maxPayload by CLOSING the socket with 1009
 * before any handler runs, taking every other in-flight request with it. So the
 * document left the envelope: the detail carries `bodyUrl`, and the bytes come
 * from here.
 *
 * Both halves are bounded:
 *
 *   primary  — a plain file stream with `Accept-Ranges: bytes`. Nothing is ever
 *              buffered; a media element can seek.
 *   replica  — the same Range, served by LOOPING the bounded
 *              `server.human-inbox.body` control action in
 *              HUMAN_INBOX_CHUNK_BYTES slices and writing each one out as it
 *              lands. That is the "分批" that removes the ceiling: the largest
 *              thing on one bridge frame is a chunk, whatever the total is.
 *
 * The response carries the reader's CSP as a HEADER, so pointing an iframe or a
 * WKWebView straight at this URL keeps the same security floor the inline
 * `srcdoc` path has (no network origins; `data:`/`blob:` media only).
 */

import type { Request, Response } from 'express'
import { createReadStream } from 'node:fs'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { HUMAN_INBOX_CHUNK_BYTES } from '../../core/human-inbox/types.js'
import { callPrimaryControl, sendV1Error as sendError } from './v1-control-relay.js'

const SERVER_RELAY_SID = '__server__'

/**
 * Same floor as the readers' inline frame (letter-html-frame.ts / the iOS
 * reader): no network origins at all, media only from `data:`/`blob:`. A body
 * served as its own document needs this as a header — there is no wrapper
 * document to put a `<meta>` in.
 */
const BODY_CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; "
  + "style-src 'unsafe-inline'; font-src data:; form-action 'none'; sandbox allow-popups"

/** A whole-document relay must not outlive the browser's patience per chunk. */
const CHUNK_RELAY_TIMEOUT_MS = 20_000

interface ParsedRange { start: number; end: number }

/**
 * Parse a single-range `bytes=` header against a known size. Multi-range is
 * deliberately unsupported (no media element needs it) and is answered as a
 * whole-document 200 rather than an error, which is what RFC 9110 allows.
 * Returns `'unsatisfiable'` for a syntactically fine range outside the file, the
 * one case that must be a 416 — a player that asks past the end and gets a 200
 * silently corrupts its buffer.
 */
export function parseByteRange(header: string | undefined, size: number): ParsedRange | 'unsatisfiable' | null {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix form `bytes=-N`: the LAST N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (start > end) return 'unsatisfiable'
    if (start >= size) return 'unsatisfiable'
    end = Math.min(end, size - 1)
  }
  if (size === 0) return 'unsatisfiable'
  return { start, end }
}

function contentTypeFor(format: 'html' | 'markdown'): string {
  return format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8'
}

function setBodyHeaders(res: Response, format: 'html' | 'markdown', size: number): void {
  res.setHeader('Content-Type', contentTypeFor(format))
  res.setHeader('Content-Security-Policy', BODY_CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
  res.setHeader('X-Walnut-Body-Bytes', String(size))
}

/**
 * Enough leading bytes to tell whether the document brings its own
 * `<head>`/`<html>`, so the frame head can be spliced without reading the body.
 */
const FRAME_PEEK_BYTES = 8 * 1024

/**
 * Trim a byte window back to the last COMPLETE UTF-8 sequence.
 *
 * The peek is a fixed byte count, so it can land inside a multi-byte character.
 * Decoding that produces a replacement char — the exact way the daemon's old
 * gateway listener corrupted large payloads — so the incomplete lead is handed
 * to the stream instead, where it rejoins its continuation bytes.
 */
export function utf8SafeLength(buf: Buffer): number {
  for (let back = 0; back < 4 && buf.length - back > 0; back++) {
    const i = buf.length - 1 - back
    const b = buf[i]
    if ((b & 0xC0) === 0x80) continue // continuation byte, keep walking back
    const need = b < 0x80 ? 1 : (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4
    return buf.length - i >= need ? buf.length : i
  }
  return buf.length
}

/** `?turn=N` selects a thread turn's rich body instead of the letter's own. */
export function parseTurn(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

// ── Primary: stream the file ─────────────────────────────────────────────────

async function servePrimary(req: Request, res: Response, id: string, turn: number | undefined): Promise<void> {
  const { statLetterBody } = await import('../../core/human-inbox/store.js')
  const stat = await statLetterBody(id, turn)
  if (!stat) {
    sendError(res, 404, 'not_found', `Letter body not found: ${id}`)
    return
  }
  const range = parseByteRange(req.headers.range, stat.bytes)
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${stat.bytes}`)
    sendError(res, 416, 'bad_request', `range outside the ${stat.bytes}-byte body`)
    return
  }
  setBodyHeaders(res, stat.format, stat.bytes)
  if (!range) {
    res.setHeader('Content-Length', String(stat.bytes))
    res.status(200)
    await pipeToResponse(createReadStream(stat.path), res)
    return
  }
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.bytes}`)
  res.setHeader('Content-Length', String(range.end - range.start + 1))
  res.status(206)
  await pipeToResponse(createReadStream(stat.path, { start: range.start, end: range.end }), res)
}

function pipeToResponse(stream: ReturnType<typeof createReadStream>, res: Response): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.on('error', (err) => {
      log.notif.warn('human-inbox: body stream failed', { error: err.message })
      if (!res.headersSent) res.status(500)
      res.end()
      resolve()
    })
    stream.on('close', () => resolve())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  })
}

// ── Replica: the same Range, in bounded batches over the bridge ──────────────

interface RelayChunk { data: Buffer; fileSize: number; eof: boolean; format: 'html' | 'markdown' }

/**
 * One bounded pull. Returns null after answering (or, once the body has started
 * streaming, after truncating) — a mid-stream failure can no longer become an
 * HTTP status, so the honest move is to end the response and log it.
 */
async function pullChunk(
  res: Response,
  id: string,
  turn: number | undefined,
  start: number,
  length: number,
): Promise<RelayChunk | null> {
  const outcome = await callPrimaryControl('server.human-inbox.body', SERVER_RELAY_SID, {
    id,
    ...(turn !== undefined ? { turn } : {}),
    start,
    length,
  }, CHUNK_RELAY_TIMEOUT_MS)
  if (!outcome.ok) {
    const { failure } = outcome
    log.notif.warn('human-inbox: body chunk relay failed', {
      letterId: id, start, kind: failure.kind, message: failure.message,
    })
    if (res.headersSent) { res.end(); return null }
    if (failure.kind === 'bridge_offline') {
      sendError(res, 503, 'bridge_offline', failure.message)
    } else if (failure.kind === 'needs_upgrade') {
      sendError(res, 501, 'not_supported_cloud',
        'Your primary box predates streamed letter bodies — it upgrades on the next deploy/reconnect')
    } else {
      sendError(res, failure.status, failure.code, failure.message)
    }
    return null
  }
  const r = outcome.result
  return {
    data: Buffer.from(typeof r.data === 'string' ? r.data : '', 'base64'),
    fileSize: typeof r.fileSize === 'number' ? r.fileSize : 0,
    eof: r.eof === true,
    format: r.format === 'markdown' ? 'markdown' : 'html',
  }
}

async function serveReplica(req: Request, res: Response, id: string, turn: number | undefined): Promise<void> {
  // The first pull doubles as the stat: its reply carries fileSize, which is
  // what a Range needs before any header can be written. Start it at byte 0 of
  // whatever the client asked for so nothing is fetched twice.
  const probeStart = (() => {
    const m = /^bytes=(\d+)-/.exec(String(req.headers.range ?? '').trim())
    return m ? Number(m[1]) : 0
  })()
  const first = await pullChunk(res, id, turn, probeStart, HUMAN_INBOX_CHUNK_BYTES)
  if (!first) return

  const range = parseByteRange(req.headers.range, first.fileSize)
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${first.fileSize}`)
    sendError(res, 416, 'bad_request', `range outside the ${first.fileSize}-byte body`)
    return
  }
  const start = range ? range.start : 0
  const end = range ? range.end : Math.max(0, first.fileSize - 1)
  setBodyHeaders(res, first.format, first.fileSize)
  if (range) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${first.fileSize}`)
    res.status(206)
  } else {
    res.status(200)
  }
  res.setHeader('Content-Length', String(first.fileSize === 0 ? 0 : end - start + 1))

  // The probe already fetched [probeStart, …]; reuse it when it lines up, which
  // it does for every request a media element actually makes.
  let cursor = start
  let pending: RelayChunk | null = probeStart === start ? first : null
  while (cursor <= end) {
    const want = Math.min(HUMAN_INBOX_CHUNK_BYTES, end - cursor + 1)
    const chunk = pending ?? await pullChunk(res, id, turn, cursor, want)
    pending = null
    if (!chunk) return
    if (chunk.data.length === 0) break
    const slice = chunk.data.subarray(0, want)
    if (!res.write(slice)) {
      // Respect backpressure: a phone on a slow link must not make the replica
      // buffer a 100MB body in memory.
      await new Promise<void>(resolve => res.once('drain', resolve))
    }
    cursor += slice.length
    if (chunk.eof && cursor >= chunk.fileSize) break
  }
  res.end()
}

// ── ?frame=1 — the reader's document, streamed ───────────────────────────────

/**
 * Serve the body already wrapped in the reader's frame (CSP meta,
 * `<base target="_blank">`, the readable-defaults stylesheet), so an iframe or a
 * WKWebView can point `src` straight here and get exactly what the inline
 * `srcDoc` path produces. The frame is built from the SAME module the console
 * uses (core/human-inbox/letter-frame.ts) — a second copy would let a big letter
 * render under a weaker policy than a small one.
 *
 * No Range and no Content-Length here: the response is the body plus a rewritten
 * head, so byte offsets no longer line up with the file. Range stays available on
 * the raw form (no `frame` param), which is what a resumable download wants.
 */
async function serveFramed(res: Response, id: string, turn: number | undefined): Promise<void> {
  const { planLetterFrame } = await import('../../core/human-inbox/letter-frame.js')
  const readSlice = CLOUD_MODE
    ? async (start: number, length: number) => {
      const chunk = await pullChunk(res, id, turn, start, length)
      return chunk === null ? null : { data: chunk.data, fileSize: chunk.fileSize, format: chunk.format }
    }
    : async (start: number, length: number) => {
      const { readLetterBodyRange } = await import('../../core/human-inbox/store.js')
      const slice = await readLetterBodyRange(id, { ...(turn !== undefined ? { turn } : {}), start, length })
      if (!slice) {
        sendError(res, 404, 'not_found', `Letter body not found: ${id}`)
        return null
      }
      return { data: slice.data, fileSize: slice.fileSize, format: slice.format }
    }

  const first = await readSlice(0, FRAME_PEEK_BYTES)
  if (!first) return
  if (first.format !== 'html') {
    // Markdown has no frame — the reader renders it itself. Serve it raw.
    setBodyHeaders(res, first.format, first.fileSize)
    res.setHeader('Content-Length', String(first.fileSize))
    res.status(200)
    await streamRest(res, readSlice, 0, first.fileSize, first.data)
    return
  }
  const peekBytes = utf8SafeLength(first.data.subarray(0, Math.min(first.data.length, FRAME_PEEK_BYTES)))
  const peek = first.data.subarray(0, peekBytes).toString('utf-8')
  const plan = planLetterFrame(peek)

  setBodyHeaders(res, 'html', first.fileSize)
  // The wrapped document is longer than the file, and the tail is written after
  // an unknown number of chunks — so this response is chunked, not measured.
  res.removeHeader('Accept-Ranges')
  res.status(200)
  res.write(plan.head)
  // `consumed` counts CHARACTERS of the peek the head already contains; when the
  // head spliced into the document's own <head> that is the whole peek, so the
  // stream resumes at peekBytes. Otherwise nothing was consumed and the peek's
  // own bytes still have to go out.
  const resumeAt = plan.consumed > 0 ? peekBytes : 0
  const carry = plan.consumed > 0 ? Buffer.alloc(0) : first.data.subarray(0, peekBytes)
  await streamRest(res, readSlice, resumeAt, first.fileSize, carry)
  if (plan.tail) res.write(plan.tail)
  res.end()
}

/** Write `carry`, then pull+write the rest of the file in bounded slices. */
async function streamRest(
  res: Response,
  readSlice: (start: number, length: number) => Promise<{ data: Buffer; fileSize: number } | null>,
  start: number,
  fileSize: number,
  carry: Buffer,
): Promise<void> {
  if (carry.length > 0 && !res.write(carry)) {
    await new Promise<void>(resolve => res.once('drain', resolve))
  }
  let cursor = start + carry.length
  while (cursor < fileSize) {
    const slice = await readSlice(cursor, Math.min(HUMAN_INBOX_CHUNK_BYTES, fileSize - cursor))
    if (!slice || slice.data.length === 0) break
    if (!res.write(slice.data)) {
      await new Promise<void>(resolve => res.once('drain', resolve))
    }
    cursor += slice.data.length
  }
}

/** Route handler — mounted as `GET /human-inbox/:id/body`. */
export async function serveLetterBody(req: Request, res: Response, id: string): Promise<void> {
  const turn = parseTurn(req.query.turn)
  if (req.query.frame === '1') {
    await serveFramed(res, id, turn)
    return
  }
  if (CLOUD_MODE) {
    await serveReplica(req, res, id, turn)
    return
  }
  await servePrimary(req, res, id, turn)
}
