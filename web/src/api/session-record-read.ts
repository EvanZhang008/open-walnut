import type { SessionCronMetadata, SessionRecord } from '@open-walnut/core';
import { apiGet } from './client';
import { SharedReads, type SharedReadCaller } from './shared-read';

/** A prompt the session waits on, as `GET /api/sessions/:id` lists it. */
export interface PendingPermissionRow {
  requestId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  reason?: string;
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string; detail?: string; takesNote?: boolean; savedTo?: string }>;
  toolUseId?: string;
}

/** The whole answer of `GET /api/sessions/:id`. */
export interface SessionRecordAnswer {
  session: SessionRecord;
  cron?: SessionCronMetadata | null;
  pendingPermissions?: PendingPermissionRow[];
}

/** A caller of the shared record read: its claim to the kept connection and its signal
 *  (shared-read.ts). */
export type SessionRecordReadOptions = SharedReadCaller;

// Joins only a read not sent yet, for every caller: one already on the wire may predate what the
// caller reacts to (a status change, a turn's end, a reconnect, the stream's subscribe) or what it
// is about to write back (the thread anchors). A read still queued answers the same as a new one.
const reads = new SharedReads<SessionRecordAnswer>({ joinSent: false, yields: true });

/**
 * One request per session id for its record, shared by every reader of it at the time: the panel
 * (header, mode and model, the note band) and the stream (its pending prompts). They used to read
 * the same URL twice per open and per reconnect, the stream with a bare fetch outside the
 * connection gate, one more connection beside the kept one for every column (2026-11-17). It
 * yields the kept slot to first screens queued with it.
 */
export function readSessionRecord(sessionId: string, opts: SessionRecordReadOptions = {}): Promise<SessionRecordAnswer> {
  return reads.read(sessionId, (signal, lane, markSent) => apiGet<SessionRecordAnswer>(`/api/sessions/${sessionId}`, undefined, {
    signal,
    lane,
    // Both callers expect it: a session launched a moment ago is not saved yet, and one that
    // is gone answers 404 (the panel retries, the stream retires its prompts).
    quietStatuses: [404],
    onDispatch: markSent,
  }), opts);
}
