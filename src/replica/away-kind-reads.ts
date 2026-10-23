/**
 * A replica answering without the Mac (a host replica alone, or the companion while the Mac
 * is away), with the sessions copy turned off for it (Settings): the reads of the Mac's
 * sessions answer needs-the-Mac (`not_kept_here`), never this replica's emptied store as "no
 * sessions", nor the companion's pushed projection, which it keeps only to route a phone's
 * message to the session's host (docs/plan/walnut-companion-unified-replica.md, 4f). The
 * other kinds say so in their own readers (kinds/gate.ts assertCopyKept); the sessions'
 * reads are many routes, so they say so here, before any of them runs.
 *
 * A replica's own sessions are its own work, always kept: a read of one passes, and a list
 * passes too and answers the replica's own sessions only, marked `partial` (a host replica's
 * purge keeps the rows of the sessions that run on it, kinds/sessions.ts; the companion's
 * phone list drops the Mac's rows, routes/api-v1.ts). A replica that keeps its sessions copy
 * (the default) passes by untouched.
 *
 * Mounted on /api, after the auth middleware: on a host replica, and on the companion
 * before the phone's forward (so a call the box would answer from the push never runs).
 */
import type { NextFunction, Request, Response } from 'express'
import { NEEDS_LEADER_HEADERS, needsLeaderBody } from '../core/replication/needs-leader.js'

const SESSION_READS = /^\/(v1\/)?sessions(\/|$)/i
const V1_SESSION_READS = /^\/v1\/sessions(\/|$)/i
/** Reads under /sessions that read no session: other kinds (routes/sessions.ts), a host's folders, the launch picker. */
const NOT_SESSIONS = /^\/(v1\/)?sessions\/(ask-walnut-launch|host-model-catalogs|list-dirs|working-dirs|launch-options)\/?$/i
/** The session one path reads, when it names one (`/sessions/<id>/...`); collection paths (`recent`, `status`) name none. */
const ONE_SESSION = /^\/(?:v1\/)?sessions\/([^/]+)(?:\/|$)/i
const COLLECTION = new Set(['recent', 'status', 'summaries', 'mention-index', 'task'])
export const SESSIONS_NOT_KEPT = 'Your sessions are kept only on your Mac.'
/** A list that holds only the replica's own sessions. */
export const SESSIONS_PARTIAL = Object.freeze({
  why: 'not_kept_here',
  message: 'Only the sessions that run here are listed: the rest are kept only on your Mac.',
})

export interface AwayKindReadsDeps {
  /** No Mac to answer: a host replica's route is `alone`; on the companion, the Mac is away. */
  alone(): boolean
  /** The user turned `kind` off for this replica (kinds/gate.ts copyKindOff). */
  off(kind: string): Promise<boolean>
  /** The session is this replica's own (a host's session that runs on it, the companion's cloud sessions): its reads pass. */
  own?(sid: string): Promise<boolean>
  /**
   * Which reads read the Mac's sessions here: every /sessions path (a host replica, whose store
   * holds both), or the phone's /v1 ones only (the companion: its console's session routes
   * read its own registry). Default: every one.
   */
  scope?: 'all' | 'v1'
  /**
   * The lists that answer the replica's own sessions only while the Mac's are held back (every
   * list, or the paths matched): they pass, marked partial. Any other list needs the Mac.
   */
  ownLists?: boolean | RegExp
}

/** A 2xx object body gets the partial mark; anything else goes as it is. */
function markPartial(res: Response): void {
  const json = res.json.bind(res)
  res.json = ((body: unknown) => {
    const ok = res.statusCode >= 200 && res.statusCode < 300
    if (ok && body && typeof body === 'object' && !Array.isArray(body)) return json({ ...(body as Record<string, unknown>), partial: { ...SESSIONS_PARTIAL } })
    return json(body)
  }) as Response['json']
}

export function awayKindReads(deps: AwayKindReadsDeps) {
  const scoped = deps.scope === 'v1' ? V1_SESSION_READS : SESSION_READS
  return (req: Request, res: Response, next: NextFunction): void => {
    const m = req.method.toUpperCase()
    if ((m !== 'GET' && m !== 'HEAD') || !deps.alone()) return next()
    if (!scoped.test(req.path) || NOT_SESSIONS.test(req.path)) return next()
    void (async () => {
      if (!(await deps.off('sessions'))) return next()
      const one = ONE_SESSION.exec(req.path)?.[1]
      const collection = !one || COLLECTION.has(one.toLowerCase())
      const ownList = deps.ownLists instanceof RegExp ? deps.ownLists.test(req.path) : deps.ownLists === true
      if (collection && ownList) { markPartial(res); return next() }
      if (!collection && deps.own) {
        let sid = one!
        try { sid = decodeURIComponent(sid) } catch { /* as sent */ }
        if (await deps.own(sid)) return next()
      }
      res.status(503).set(NEEDS_LEADER_HEADERS).json(needsLeaderBody('not_kept_here', SESSIONS_NOT_KEPT))
    })().catch(() => { if (!res.headersSent) next() })
  }
}

/**
 * The companion holds the Mac's sessions back from what it shows: sessions turned off for
 * it, and the Mac away. The phone's event snapshot and its session list then carry none of
 * the Mac's sessions (routes/events-v1.ts, routes/api-v1.ts); a read of one answers
 * not_kept_here (awayKindReads).
 */
export async function companionHoldsSessionsBack(): Promise<boolean> {
  const { followerKind, leaderAnswers } = await import('../core/server-role.js')
  if (followerKind() !== 'companion' || leaderAnswers()) return false
  return (await import('../core/replication/kinds/gate.js')).copyKindOff('sessions')
}
