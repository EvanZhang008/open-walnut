/**
 * Session record audit trail — append-only JSONL of every destructive
 * operation on sessions.sqlite rows (delete / rename).
 *
 * WHY (inc-2026-08-10 "Untitled session"): a session record vanished sometime
 * in a 5-day window and the investigation had to be done archaeologically —
 * server logs were long rotated, so the actual deleting/renaming call could
 * never be identified with certainty. Runtime logs rotate; this file does not.
 * It is tiny (one line per destructive op, which are rare) and lives in
 * WALNUT_HOME so the data-hub git sync snapshots it every 30s.
 *
 * Best-effort by design: auditing must never break the operation it records.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'

const AUDIT_FILE = path.join(WALNUT_HOME, 'session-audit.jsonl')

export interface SessionAuditEvent {
  /** What happened to the row. */
  op: 'delete' | 'rename'
  sessionId: string
  /** rename only: the new claude_session_id the row now lives under. */
  renamedTo?: string
  /** Why / which code path (e.g. 'reaper', 'acp-identity-migration', 'resume-id-changed'). */
  reason: string
  /** Snapshot of the row's key fields at the moment of the op. */
  record?: {
    taskId?: string
    title?: string
    host?: string
    process_status?: string
    startedAt?: string
  }
}

/** Append one audit line. Fire-and-forget safe — never throws. */
export function auditSessionRecord(event: SessionAuditEvent): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
  fsp.appendFile(AUDIT_FILE, line, 'utf-8').catch((err) => {
    log.session.warn('session audit append failed', {
      op: event.op, sessionId: event.sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}
