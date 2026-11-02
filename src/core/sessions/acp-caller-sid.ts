/**
 * The session a caller sid names, when the caller is an ACP engine's session.
 *
 * A native Claude Code session's CLI carries its own session id in WALNUT_SESSION_ID. An ACP
 * session (Codex, pi, OpenCode, Goose) carries its worker's runtime id (`acp-...`): the daemon
 * keys its worker by it and vouches for it at the agent gateway (daemon-standalone.ts
 * handleGatewayLine), but the session record is keyed by the provider's session id once the
 * engine names one (acp-session.ts `trackingId`). Every lookup of the caller by record id then
 * missed, so each `walnut` call from such a session read as an unidentified process: a
 * task_send arrived anonymous, a task it filed was no subtask, a reply could not settle its
 * request (2026-11-02, a pi session's task_send). `canonicalCallerSid` maps the runtime id to
 * the record's id once, at the edges a caller sid enters the server (the API middleware below
 * and the gateway relay), so no route has to know.
 */

import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../session-db.js'

const RUNTIME_PREFIX = 'acp-'
const CALLER_HEADER = 'x-walnut-caller-sid'
/**
 * runtime id -> what it named. Every answer is re-checked with one indexed read on use, so a
 * busy caller never repeats the payload scan below on the event loop: a mapped one against its
 * row, a pending one (the record still keyed by the runtime id) against that row's existence,
 * so the moment the engine names its session the next call finds the new row; no session at
 * all is trusted for UNMAPPED_TTL_MS.
 */
const cache = new Map<string, { sid: string; kind: 'mapped' | 'pending' | 'none'; at: number }>()
const CACHE_MAX = 512
const UNMAPPED_TTL_MS = 10_000

/** The record id for an ACP runtime id, else the sid unchanged. Never throws. */
export function canonicalCallerSid(sid: string): string
export function canonicalCallerSid(sid: string | undefined): string | undefined
export function canonicalCallerSid(sid: string | undefined): string | undefined {
  if (!sid || !sid.startsWith(RUNTIME_PREFIX)) return sid
  try {
    const db = getDb()
    if (!db) return sid
    const cached = cache.get(sid)
    if (cached?.kind === 'mapped') {
      // A record's runtime id never changes, but the record may be gone or archived since.
      const row = db.prepare(
        `SELECT 1 FROM sessions WHERE claude_session_id = ? AND (archived IS NULL OR archived = 0)
           AND json_valid(payload) AND json_extract(payload, '$.acpRuntimeId') = ?`,
      ).get(cached.sid, sid)
      if (row) return cached.sid
    } else if (cached?.kind === 'pending') {
      if (db.prepare('SELECT 1 FROM sessions WHERE claude_session_id = ?').get(sid)) return sid
    } else if (cached && Date.now() - cached.at < UNMAPPED_TTL_MS) {
      return sid
    }
    cache.delete(sid)
    // The live record wearing this runtime id. A pending session is keyed by the runtime id
    // itself; once the engine names its session, the new row keeps the runtime id and the old
    // one is removed (archived for a moment first), so an open row wins over an archived one.
    const found = db.prepare(
      `SELECT claude_session_id FROM sessions
        WHERE instr(payload, ?) > 0 AND json_valid(payload) AND json_extract(payload, '$.acpRuntimeId') = ?
        ORDER BY CASE WHEN archived IS NULL OR archived = 0 THEN 0 ELSE 1 END
        LIMIT 1`,
    ).pluck().get(sid, sid) as string | undefined
    if (cache.size >= CACHE_MAX) cache.clear()
    const answer = found ?? sid
    cache.set(sid, { sid: answer, kind: found === undefined ? 'none' : found === sid ? 'pending' : 'mapped', at: Date.now() })
    return answer
  } catch {
    return sid
  }
}

/** API middleware: an ACP runtime id in the caller header becomes the session's record id. */
export function acpCallerSidMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers[CALLER_HEADER]
  if (typeof raw === 'string' && raw.startsWith(RUNTIME_PREFIX)) {
    const sid = canonicalCallerSid(raw.trim())
    if (sid !== raw) req.headers[CALLER_HEADER] = sid
  }
  next()
}

/** Test seam. */
export function clearAcpCallerSidCache(): void { cache.clear() }
