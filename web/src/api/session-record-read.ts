import type { SessionCronMetadata, SessionRecord } from '@open-walnut/core';
import { apiGet, fetchLaneRaised, type FetchLane } from './client';

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

export interface SessionRecordReadOptions {
  /** The caller's claim to the connection kept for what the person waits on (api/client.ts).
   *  The shared read is interactive while any caller's claim is, and a claim raised while the
   *  read waits counts at once (`fetchLaneRaised`). */
  lane?: FetchLane;
  /** This caller stops waiting: its promise rejects with an AbortError and its claim leaves the
   *  read. The read itself is cancelled once no caller waits on it any more. */
  signal?: AbortSignal;
  /** The answer must come from a request sent after this call (a read that follows the stream's
   *  subscribe, or a resync whose "already pending" set is taken now). Without it, a read that
   *  already went out is joined. */
  fresh?: boolean;
}

interface Read {
  promise: Promise<SessionRecordAnswer>;
  controller: AbortController;
  lanes: FetchLane[];
  sent: boolean;
  waiting: number;
}

const reads = new Map<string, Read>();

/**
 * One request per session id for its record, shared by every reader of it at the time: the panel
 * (header, mode and model, the note band) and the stream (its pending prompts). They used to read
 * the same URL twice per open and per reconnect, the stream with a bare fetch outside the
 * connection gate, one more connection beside the kept one for every column (2026-11-17).
 */
export function readSessionRecord(sessionId: string, opts: SessionRecordReadOptions = {}): Promise<SessionRecordAnswer> {
  let read = reads.get(sessionId);
  if (!read || (opts.fresh && read.sent)) {
    const created: Read = { promise: undefined as unknown as Promise<SessionRecordAnswer>, controller: new AbortController(), lanes: [], sent: false, waiting: 0 };
    // Interactive while any caller claims it, behind the first screens waiting for the kept slot.
    const lane: FetchLane = { get interactive() { return created.lanes.some((l) => l.interactive); }, yields: true };
    created.promise = apiGet<SessionRecordAnswer>(`/api/sessions/${sessionId}`, undefined, {
      signal: created.controller.signal,
      lane,
      // Both callers expect it: a session launched a moment ago is not saved yet, and one that
      // is gone answers 404 (the panel retries, the stream retires its prompts).
      quietStatuses: [404],
      onDispatch: () => { created.sent = true; },
    }).finally(() => { if (reads.get(sessionId) === created) reads.delete(sessionId); });
    // Settled by its callers; an unwatched rejection (every caller left) is not an error.
    created.promise.catch(() => {});
    reads.set(sessionId, created);
    read = created;
  }
  const live = read;
  live.waiting++;
  if (opts.lane) {
    live.lanes.push(opts.lane);
    if (opts.lane.interactive && !live.sent) fetchLaneRaised();
  }
  const signal = opts.signal;
  if (!signal) return live.promise;
  return new Promise<SessionRecordAnswer>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      live.waiting--;
      if (opts.lane) live.lanes = live.lanes.filter((l) => l !== opts.lane);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      // An effect that re-runs (cleanup, then the same read) takes it back in the same commit:
      // cancel only once that is over, as the history coalescer does.
      queueMicrotask(() => {
        if (live.waiting > 0) return;
        if (reads.get(sessionId) === live) reads.delete(sessionId);
        live.controller.abort();
      });
    };
    if (signal.aborted) { leave(); return; }
    signal.addEventListener('abort', leave, { once: true });
    live.promise.then(
      (answer) => { signal.removeEventListener('abort', leave); if (!left) resolve(answer); },
      (err: unknown) => { signal.removeEventListener('abort', leave); if (!left) reject(err); },
    );
  });
}
