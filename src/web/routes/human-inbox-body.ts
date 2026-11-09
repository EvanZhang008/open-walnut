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
import { StringDecoder } from 'node:string_decoder'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { isHostReplicaProgram } from '../../core/server-role.js'
import { HUMAN_INBOX_CHUNK_BYTES } from '../../core/human-inbox/types.js'
import type { LetterBodyStat } from '../../core/human-inbox/store.js'
import { LETTER_FRAME_CSP_VALUE, LETTER_IFRAME_SANDBOX } from '../../core/human-inbox/letter-frame.js'
import { createAgentHtmlLinker } from '../../lib/agent-html-refs.js'
import { createAgentHtmlSecurity } from '../../lib/agent-html-security.js'
import { isRefToken, type RefLinkOptions } from '../../lib/agent-text-refs.js'
import { callPrimaryControl, sendV1Error as sendError } from './v1-control-relay.js'

const SERVER_RELAY_SID = '__server__'

/**
 * Same floor as the readers' inline frame (letter-html-frame.ts / the iOS
 * reader): no network origins at all, media only from `data:`/`blob:`. A body
 * served as its own document needs this as a header — there is no wrapper
 * document to put a `<meta>` in. The sandbox is the inline frame's, so a link
 * the reader opens gets a working window there as it does from the inline frame.
 */
export const BODY_CSP = `${LETTER_FRAME_CSP_VALUE}; sandbox ${LETTER_IFRAME_SANDBOX}`

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

// ── Local disk: stream the file ──────────────────────────────────────────────

/**
 * The body on this box's disk: the companion reads its copy of the Mac's bodies once it
 * holds one, never the folder git sync wrote (replica-state.ts bodySourceDir); a body
 * the copy lacks (over the copy's cap, or newer than its last round) is relayed.
 */
async function statLocalBody(id: string, turn: number | undefined): Promise<LetterBodyStat | null> {
  const [{ statLetterBody }, { bodySourceDir }] = await Promise.all([
    import('../../core/human-inbox/store.js'), import('../../core/human-inbox/replica-state.js'),
  ])
  return statLetterBody(id, turn, await bodySourceDir())
}

/**
 * The body document a REPLICA can serve itself, or null.
 *
 * The companion holds the Mac's letter bodies as a copy (the `inbox-bodies` kind,
 * before it the files git sync wrote), so it normally holds a byte-identical copy of
 * every letter body — reading it locally is one file stream instead of an N-chunk
 * round trip per Range over the bridge, and it keeps working while the bridge is
 * down. Two cases still have to relay, and the second is the subtle one: the
 * letter (or its blob) hasn't synced yet, or the local file's size does not MATCH
 * the size the sender recorded (either direction — see bodyStatIsComplete). A
 * document that isn't byte-for-byte what was sent must never be served: it reads
 * as a corrupt letter, which is worse than a slow one.
 */
async function localBodyIfComplete(
  id: string,
  turn: number | undefined,
): Promise<LetterBodyStat | null> {
  const stat = await statLocalBody(id, turn)
  if (!stat) return null
  const { bodyStatIsComplete } = await import('../../core/human-inbox/store.js')
  if (bodyStatIsComplete(stat)) return stat
  log.notif.info('human-inbox: local body copy is not the sent size — relaying from the primary', {
    letterId: id, localBytes: stat.bytes, recordedBytes: stat.recordedBytes,
  })
  return null
}

async function servePrimary(req: Request, res: Response, id: string, turn: number | undefined): Promise<void> {
  const stat = await statLocalBody(id, turn)
  if (!stat) {
    sendError(res, 404, 'not_found', `Letter body not found: ${id}`)
    return
  }
  await serveLocalStat(req, res, stat)
}

/** Answer from a stat we already have — the Range half, shared by both boxes. */
async function serveLocalStat(req: Request, res: Response, stat: LetterBodyStat): Promise<void> {
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
/** A downloaded phone document has no network base; its paired address survives a tunnel or path prefix. */
export function refLinkOptionsFor(req: Request): RefLinkOptions {
  const opts: RefLinkOptions = {}
  if (isRefToken(req.query.ref_token)) opts.token = req.query.ref_token
  if (req.query.refs !== '1') return opts.token ? opts : { kinds: [] }
  const base = req.query.ref_base
  if (!opts.token && typeof base === 'string' && base.length <= 8192 && !/[\u0000- \u007f]/.test(base)) {
    try {
      const parsed = new URL(base)
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
        && !parsed.search && !parsed.hash && parsed.pathname.endsWith('/open-ref')) {
        opts.refBase = parsed.href
        return opts
      }
    } catch {}
  }
  const host = req.get('host')
  if (host && /^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    opts.refBase = `${req.protocol === 'https' ? 'https' : 'http'}://${host}/open-ref`
  }
  return opts
}

function framedLinkStream(opts: RefLinkOptions, trustedPrefix: string): {
  text(s: string): string
  bytes(b: Buffer): string
  finish(tail: string): string
} {
  const parts: string[] = []
  const security = createAgentHtmlSecurity({ scriptingEnabled: false, trustedPrefix, onOutput: (s) => parts.push(s) })
  const linker = createAgentHtmlLinker({ ...opts, scriptingEnabled: false, onOutput: (s) => security.write(s) })
  const decoder = new StringDecoder('utf8')
  const take = (): string => {
    const s = parts.join('')
    parts.length = 0
    return s
  }
  return {
    text(s) { linker.write(s); return take() },
    bytes(b) { linker.write(decoder.write(b)); return take() },
    finish(tail) {
      const rest = decoder.end()
      if (rest) linker.write(rest)
      if (tail) linker.write(tail)
      linker.end()
      security.end()
      return take()
    },
  }
}

/** Backpressure; a client that went away ends the wait too (else it never drains). */
async function writeOut(res: Response, data: string | Buffer): Promise<void> {
  if (data.length === 0 || res.destroyed) return
  if (res.write(data)) return
  await new Promise<void>((resolve) => {
    const done = (): void => { res.off('drain', done); res.off('close', done); resolve() }
    res.once('drain', done)
    res.once('close', done)
  })
}

/** Linking runs on the event loop, so a 2MB slice is linked in parts with a loop turn between. */
const LINK_SLICE_BYTES = 256 * 1024

async function serveFramed(req: Request, res: Response, id: string, turn: number | undefined): Promise<void> {
  const { planLetterFrame } = await import('../../core/human-inbox/letter-frame.js')
  // Same local-first rule as the raw form: a replica reads its own copy of the
  // blob when it has all of it, and only falls back to the chunked relay.
  const relayOnly = CLOUD_MODE && (await localBodyIfComplete(id, turn)) === null
  const readSlice = relayOnly
    ? async (start: number, length: number) => {
      const chunk = await pullChunk(res, id, turn, start, length)
      return chunk === null ? null : { data: chunk.data, fileSize: chunk.fileSize, format: chunk.format }
    }
    : async (start: number, length: number) => {
      const [{ readLetterBodyRange }, { bodySourceDir }] = await Promise.all([
        import('../../core/human-inbox/store.js'), import('../../core/human-inbox/replica-state.js'),
      ])
      const slice = await readLetterBodyRange(id, { ...(turn !== undefined ? { turn } : {}), start, length, dir: await bodySourceDir() })
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
    // Ended here too: the client stops at Content-Length, but an open response holds
    // its keep-alive socket, and every later request on it waited behind this one.
    res.end()
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
  // The head goes through the linker too: one document, one tokenizer state.
  const linked = framedLinkStream(refLinkOptionsFor(req), plan.head)
  await writeOut(res, linked.text(plan.head))
  // The frame plan consumes UTF-16 characters; the disk stream resumes at their UTF-8 byte offset.
  const resumeAt = Buffer.byteLength(peek.slice(0, plan.consumed), 'utf8')
  const carry = first.data.subarray(resumeAt, peekBytes)
  await streamRest(res, readSlice, resumeAt, first.fileSize, carry, linked.bytes)
  await writeOut(res, linked.finish(plan.tail))
  res.end()
}

/**
 * A host replica holds the letter index but not this body (letter bodies are
 * copied only when the host chose them, and never over the copy cap:
 * core/replication/kinds/inbox.ts): the body needs the Mac. Answers the same
 * 503 the dispatcher gives a write while away (replica/dispatch.ts). False when
 * the inbox is copied here and the letter is not in its index (the 404 below says so).
 */
async function bodyNotCopied(res: Response, id: string): Promise<boolean> {
  const { readLetterIndexForReplica } = await import('../../core/human-inbox/store.js')
  // The host's choice turned the inbox off: its index is gone, so any letter needs the Mac.
  const { copyKindOff } = await import('../../core/replication/kinds/gate.js')
  const inboxOff = await copyKindOff('inbox')
  if (!inboxOff && !(await readLetterIndexForReplica()).some((l) => l.id === id)) return false
  log.notif.info('human-inbox: letter body not kept on this host replica, it needs the Mac', { letterId: id })
  // The user's choice (the inbox or its bodies turned off) says so; else the body is over the copy's cap.
  if (inboxOff || (await copyKindOff('inbox-bodies'))) {
    res.status(503).set('retry-after', '5').json({
      error: { code: 'needs_leader', why: 'not_kept_here', retryAfter: 5, message: 'Letter bodies are kept only on your Mac.' },
    })
    return true
  }
  res.status(503).set('retry-after', '5').json({
    error: { code: 'needs_leader', why: 'kind_not_copied', retryAfter: 5, message: 'This needs your Mac, which is not answering right now.' },
  })
  return true
}

/** Write `carry`, then pull+write the rest of the file in bounded slices, through `transform` when given. */
async function streamRest(
  res: Response,
  readSlice: (start: number, length: number) => Promise<{ data: Buffer; fileSize: number } | null>,
  start: number,
  fileSize: number,
  carry: Buffer,
  transform?: (data: Buffer) => string,
): Promise<void> {
  const emit = async (data: Buffer): Promise<void> => {
    if (!transform) { await writeOut(res, data); return }
    for (let at = 0; at < data.length; at += LINK_SLICE_BYTES) {
      if (at > 0) await new Promise<void>((resolve) => setImmediate(resolve))
      await writeOut(res, transform(data.subarray(at, at + LINK_SLICE_BYTES)))
    }
  }
  if (carry.length > 0) await emit(carry)
  let cursor = start + carry.length
  while (cursor < fileSize) {
    if (res.destroyed) return
    const slice = await readSlice(cursor, Math.min(HUMAN_INBOX_CHUNK_BYTES, fileSize - cursor))
    if (!slice || slice.data.length === 0) break
    await emit(slice.data)
    cursor += slice.data.length
  }
}

/**
 * Route handler — mounted as `GET /human-inbox/:id/body`.
 *
 * A replica serves the document off its OWN disk whenever it holds a complete
 * copy (the blob rides git-sync), and relays only when it doesn't. The relay is
 * the fallback, not the default: it costs a bridge round trip per chunk per
 * Range, and it is the only half that can fail when the bridge is down — a body
 * the box already has on disk should not depend on the tunnel being up.
 */
export async function serveLetterBody(req: Request, res: Response, id: string): Promise<void> {
  const turn = parseTurn(req.query.turn)
  // A host replica answers here only while the Mac is away (it forwards otherwise).
  if (isHostReplicaProgram() && (await localBodyIfComplete(id, turn)) === null && (await bodyNotCopied(res, id))) return
  if (req.query.frame === '1') {
    await serveFramed(req, res, id, turn)
    return
  }
  if (CLOUD_MODE) {
    const local = await localBodyIfComplete(id, turn)
    if (local) {
      await serveLocalStat(req, res, local)
      return
    }
    await serveReplica(req, res, id, turn)
    return
  }
  await servePrimary(req, res, id, turn)
}
