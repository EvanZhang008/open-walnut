/**
 * A host replica answering alone (the Mac away and no companion standing in:
 * the dispatcher's route is `alone`): the reads of a session's own data
 * (docs/plan/walnut-replica-servers-impl.md, WP7 and section 8). The session
 * row comes from the sessions copy and passes through; what is behind it is
 * not in any copy:
 *
 *   a session on the Mac (or another host): its transcript, files and changes
 *     are there, so the answer is the away refusal every other away route gives,
 *     `503 {error:{code:'needs_leader', why:'session_on_mac'}}` (the console
 *     shows "Your Mac is away" instead of the composer)
 *   a session on THIS host, the daemon with owner-scoped reads (self-host.ts
 *     isSelfHost, `replica-reads-v1`, the link up): WP6's routes answer every
 *     read here as they do while the Mac answers (the CLI's own transcript, its
 *     files, its changes, through the follower link): passed through untouched
 *   a session on THIS host, an older daemon without those reads: the console's
 *     history and the phone's history and transcript come from the stream file
 *     through `read-history` (host-history.ts), with `x-walnut-offline`; its
 *     other reads (files, changes, plan) need the Mac:
 *     `503 needs_leader session_files_need_mac`
 *
 * Paths are matched as express matches them (case-insensitive, a trailing
 * slash allowed), so no spelling of a route slips past this to the route.
 * Concurrent reads of one session's stream file share one daemon read and one
 * parse; the parse yields to the event loop between its two steps.
 *
 * Mounted after the auth middleware, on a host replica only.
 */
import type { NextFunction, Request, Response } from 'express'
import type { SessionHistoryMessage } from '../core/session-history.js'

type HostAnswer = 'history' | 'v1-history' | 'v1-transcript'

/** The session reads that need the session's own host: GET, relative to /api (express's matching: any case, a trailing slash). */
const HOST_READS: ReadonlyArray<{ re: RegExp; answer?: HostAnswer }> = [
  { re: /^\/sessions\/([^/]+)\/history\/?$/i, answer: 'history' },
  { re: /^\/sessions\/([^/]+)\/subagent\/[^/]+\/history\/?$/i },
  { re: /^\/sessions\/([^/]+)\/changes(\/(file|summary|triage))?\/?$/i },
  { re: /^\/sessions\/([^/]+)\/plan\/?$/i },
  { re: /^\/sessions\/([^/]+)\/workflow\/?$/i },
  { re: /^\/sessions\/([^/]+)\/slash-commands\/?$/i },
  { re: /^\/sessions\/([^/]+)\/vscode-uri\/?$/i },
  { re: /^\/v1\/sessions\/([^/]+)\/history\/?$/i, answer: 'v1-history' },
  { re: /^\/v1\/sessions\/([^/]+)\/transcript\/?$/i, answer: 'v1-transcript' },
]

export const SESSION_ON_MAC = 'session_on_mac'
/** This host's session, an older daemon: a read the replica cannot answer from the stream file. */
export const SESSION_FILES_NEED_MAC = 'session_files_need_mac'
/** An older page of a conversation: pages are built on the Mac. */
export const HISTORY_PAGES_NEED_MAC = 'history_pages_need_mac'

export interface AwaySessionReadsDeps {
  /** The dispatcher's route is `alone`: the Mac away AND no companion standing in. */
  alone(): boolean
  /** The headers an answer from here carries (x-walnut-offline and its why), as the dispatcher sets them. */
  offlineHeaders(): Record<string, string>
  /** The Mac's name for this host (WALNUT_HOST_KEY), or null when not told. */
  hostKey(): string | null
  /** The session's host from the sessions copy; undefined when it has none (the Mac's own); null when there is no such session. */
  hostOf(sid: string): Promise<string | undefined | null>
  /** `host` is this host and its daemon answers owner-scoped reads now (self-host.ts isSelfHost, the link up): WP6's routes answer. */
  selfHost(host: string): boolean
  /**
   * This host's daemon through the follower link: `read-history {sid, tailBytes}`
   * (owner scoped). Absent: this host's session reads pass to their routes.
   */
  readHostHistory?(sid: string, tailBytes: number): Promise<Record<string, unknown>>
  log?(level: 'info' | 'warn', msg: string, data: Record<string, unknown>): void
}

/** The session a GET (relative to /api) reads host data of, and whether it is answered from the stream file. */
export function hostReadOf(method: string, p: string): { sid: string; answer?: HostAnswer } | null {
  if (method !== 'GET' && method !== 'HEAD') return null
  for (const { re, answer } of HOST_READS) {
    const m = re.exec(p)
    if (!m) continue
    let sid = m[1]!
    try { sid = decodeURIComponent(sid) } catch { /* as sent */ }
    return { sid, ...(answer ? { answer } : {}) }
  }
  return null
}

/** The session id a GET (relative to /api) reads host data of, or null. */
export function hostReadSession(method: string, p: string): string | null {
  return hostReadOf(method, p)?.sid ?? null
}

function awayHeaders(res: Response, deps: AwaySessionReadsDeps): void {
  for (const [k, v] of Object.entries(deps.offlineHeaders())) res.setHeader(k, v)
  res.setHeader('x-walnut-answered-via', 'replica')
}

function needsLeader(res: Response, deps: AwaySessionReadsDeps, why: string): void {
  awayHeaders(res, deps)
  res.setHeader('retry-after', '5')
  res.status(503).json({ error: { code: 'needs_leader', why, retryAfter: 5, message: 'This needs your Mac, which is not answering right now.' } })
}

const positiveInt = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}

type StreamRead =
  | { ok: true; messages: SessionHistoryMessage[] }
  | { ok: true; transcript: Record<string, unknown> }
  | { ok: false; errorKind: string | null; error: string }

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** One read and parse of a stream file in flight per (answer kind, session, window): concurrent reads share it. */
function createStreamReads(deps: AwaySessionReadsDeps) {
  const inFlight = new Map<string, Promise<StreamRead>>()
  return (sid: string, kind: 'history' | 'transcript', tailBytes: number): Promise<StreamRead> => {
    const key = `${kind}\u0000${sid}\u0000${tailBytes}`
    const held = inFlight.get(key)
    if (held) return held
    const run = (async (): Promise<StreamRead> => {
      let r: Record<string, unknown>
      try {
        r = await deps.readHostHistory!(sid, tailBytes)
      } catch (err) {
        // The link is down or the read timed out.
        return { ok: false, errorKind: null, error: err instanceof Error ? err.message : String(err) }
      }
      // The daemon's answer: {ok:true, main} or {ok:false, error, errorKind}.
      if (r.ok !== true) return { ok: false, errorKind: typeof r.errorKind === 'string' ? r.errorKind : null, error: String(r.error ?? '') }
      const main = typeof r.main === 'string' ? r.main : ''
      const hh = await import('./host-history.js')
      // Each step is a few ms over the window; the loop runs between them.
      await yieldToLoop()
      if (kind === 'transcript') return { ok: true, transcript: hh.hostTranscriptAnswer(sid, main) }
      const prepared = hh.streamFileForParse(main)
      await yieldToLoop()
      return { ok: true, messages: hh.hostHistoryMessages(prepared) }
    })()
    inFlight.set(key, run)
    const clear = () => { if (inFlight.get(key) === run) inFlight.delete(key) }
    run.then(clear, clear)
    return run
  }
}

export function awaySessionReads(deps: AwaySessionReadsDeps) {
  const streamRead = createStreamReads(deps)

  /** A session on this host, an older daemon: read from its stream file through the follower link. */
  async function answerFromHost(req: Request, res: Response, sid: string, answer: HostAnswer): Promise<void> {
    // Older pages are built on the Mac only: the tail of a stream file is the newest rows.
    if (typeof req.query.before === 'string') {
      if (answer === 'history') {
        awayHeaders(res, deps)
        res.json({ messages: [], reachedStart: false, unavailable: HISTORY_PAGES_NEED_MAC })
        return
      }
      return needsLeader(res, deps, HISTORY_PAGES_NEED_MAC)
    }
    const hh = await import('./host-history.js')
    const transcript = answer === 'v1-transcript'
    const r = await streamRead(sid, transcript ? 'transcript' : 'history', transcript ? hh.TRANSCRIPT_TAIL_BYTES : hh.HOST_HISTORY_TAIL_BYTES)
    if (res.headersSent || res.destroyed) return
    if (!r.ok) {
      deps.log?.('warn', 'replica: a host session read failed', { sessionId: sid, path: req.path, errorKind: r.errorKind, error: r.error })
      if (r.errorKind === 'not_found') {
        awayHeaders(res, deps)
        res.status(404).json({ error: { code: 'not_found', message: 'This host keeps no conversation for this session.' } })
        return
      }
      return needsLeader(res, deps, 'daemon_unreachable')
    }
    awayHeaders(res, deps)
    if ('transcript' in r) { res.json(r.transcript); return }
    deps.log?.('info', 'replica: a host session read answered from its stream file', { sessionId: sid, path: req.path, rows: r.messages.length })
    const tail = positiveInt(req.query.tail)
    const turns = answer === 'history' ? positiveInt(req.query.turns) : undefined
    res.json(hh.hostHistoryAnswer(r.messages, { ...(tail ? { tail } : {}), ...(turns ? { turns } : {}) }))
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.alone()) return next()
    const read = hostReadOf(req.method, req.path)
    if (!read) return next()
    const { sid } = read
    void (async () => {
      const host = await deps.hostOf(sid)
      // Not in the copy: the route's own 404.
      if (host === null) return next()
      const here = deps.hostKey()
      const h = (host ?? '').trim()
      if (h && h !== '__local__' && (here === null || h === here)) {
        // This host's (or, with no host key told, maybe this host's): host data.
        // A daemon with owner-scoped reads: WP6's routes answer it, as while the Mac answers.
        if (deps.selfHost(h)) return next()
        if (!deps.readHostHistory || here === null) return next()
        if (!read.answer) {
          deps.log?.('info', 'replica: a host session read needs the Mac', { sessionId: sid, host: h, path: req.path })
          return needsLeader(res, deps, SESSION_FILES_NEED_MAC)
        }
        return answerFromHost(req, res, sid, read.answer)
      }
      deps.log?.('info', 'replica: a session read needs the Mac', { sessionId: sid, host: h || '__local__', path: req.path })
      needsLeader(res, deps, SESSION_ON_MAC)
    })().catch(next)
  }
}
