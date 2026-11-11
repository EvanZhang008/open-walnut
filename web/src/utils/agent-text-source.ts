/**
 * Where agent text came from, so a path in it opens on the machine that wrote it.
 *
 * A card, row or letter that shows a task's or a session's words knows whose words
 * they are. An absolute path with no host opens on this machine first
 * (useClickedPathOpener), so a remote session's `/home/me/a.ts` opened a same-named
 * file here instead. The source's host decides: a host the surface already knows
 * wins; else the session's record is read once, on the click (never on mount, no
 * cache of our own); a surface with no source opens as before. A session whose
 * record cannot be read never falls back to this machine: the caller says so.
 */
import type { Task } from '@open-walnut/core';
import type { OpenFileRequest } from './open-anywhere';
import { resolveTaskSessionId } from './session-status';

export interface AgentTextSource {
  /** The task the words belong to (its session names the host). */
  task?: Task | null;
  /** The host the words came from, when the surface knows it ('', 'local' and '__local__' are this
   *  machine: an empty host is the primary, never "unknown"; leave it undefined for unknown). */
  host?: string;
  /** The session the words came from; wins over the task's own session. */
  sessionId?: string;
  /** Its working directory, used to draw relative paths only when the host is known too. */
  cwd?: string;
  /** Walnut did not record who wrote the words: they open nowhere and draw no picture, rather than
   *  on a machine guessed from the task's current session (which may not be the writer). */
  unknownSource?: boolean;
}

const LOCAL_HOSTS = new Set(['', '__local__', 'local']);

export type SourceHost =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'host'; host?: string }
  | { kind: 'session'; sessionId: string };

export function sourceHostOf(src: AgentTextSource | undefined): SourceHost {
  if (!src) return { kind: 'none' };
  if (src.host !== undefined) return LOCAL_HOSTS.has(src.host) ? { kind: 'host' } : { kind: 'host', host: src.host };
  if (src.sessionId && src.sessionId !== 'external') return { kind: 'session', sessionId: src.sessionId };
  // A recorded writer above wins; an unrecorded one must not fall through to the task's session.
  if (src.unknownSource) return { kind: 'unknown' };
  const sid = src.sessionId || (src.task ? resolveTaskSessionId(src.task) : null);
  // A plugin's letter is stamped `external`: no session to ask.
  if (sid && sid !== 'external') return { kind: 'session', sessionId: sid };
  return src.task || sid === 'external' ? { kind: 'unknown' } : { kind: 'none' };
}

/** The session the source names, for relative-path resolution. */
export function sourceSessionId(src: AgentTextSource | undefined): string | undefined {
  const s = sourceHostOf(src);
  if (s.kind === 'session') return s.sessionId;
  if (s.kind === 'unknown' && src?.unknownSource) return undefined;
  const sid = src?.sessionId || (src?.task ? resolveTaskSessionId(src.task) : null);
  return sid && sid !== 'external' ? sid : undefined;
}

/** The cwd relative paths render against: only with a host known now, so the click resolves them there. */
export function renderCwdOf(src: AgentTextSource | undefined): string | undefined {
  if (sourceHostOf(src).kind !== 'host') return undefined;
  return src?.cwd || src?.task?.cwd || undefined;
}

export interface RenderContext {
  cwd?: string;
  /** The host image paths load from (absent = this machine). */
  host?: string;
  /** Whether a bare image path may become a picture: not while its host is still unknown. */
  images: boolean;
}

/**
 * What the renderer may know now, with no request: a known host (the surface's own, or a
 * session record this page already holds), else pictures stay links so none loads from the
 * wrong machine. A session's cwd is not taken from the record: relative paths still render
 * only with a host the surface named.
 */
export function renderContextOf(src: AgentTextSource | undefined, peek: SessionHostLookup['peek']): RenderContext {
  const s = sourceHostOf(src);
  const cwd = renderCwdOf(src);
  if (s.kind === 'none') return { images: true };
  if (s.kind === 'unknown') return { images: false };
  if (s.kind === 'host') return { ...(cwd ? { cwd } : {}), ...(s.host ? { host: s.host } : {}), images: true };
  const record = peek(s.sessionId);
  if (!record) return { images: false };
  const host = record.host && !LOCAL_HOSTS.has(record.host) ? record.host : undefined;
  return { ...(host ? { host } : {}), images: true };
}

/** A session timeline's own words: its passed host, else the record this page holds (no request), else unknown. */
export function sessionTextSource(
  p: { sessionId?: string; sessionHost?: string; sessionCwd?: string },
  peek: SessionHostLookup['peek'],
): AgentTextSource {
  const cwd = p.sessionCwd ? { cwd: p.sessionCwd } : {};
  const sid = p.sessionId && p.sessionId !== 'external' ? p.sessionId : undefined;
  if (p.sessionHost !== undefined) return { host: p.sessionHost, ...(sid ? { sessionId: sid } : {}), ...cwd };
  if (!sid) return { unknownSource: true };
  const record = peek(sid);
  if (record) return { host: record.host ?? '', sessionId: sid, ...cwd };
  return { sessionId: sid, ...cwd };
}

/** The local-image URL on the render context's machine, or null while it is unknown (show a link). */
export function localImageSrc(absPath: string, render: RenderContext): string | null {
  if (!render.images) return null;
  return `/api/local-image?path=${encodeURIComponent(absPath)}${render.host ? `&host=${encodeURIComponent(render.host)}` : ''}`;
}

export interface SessionHostLookup {
  /** The record this page already holds, never a request. */
  peek: (sessionId: string) => { host?: string } | null;
  /** One request; null when the session is gone. */
  fetch: (sessionId: string) => Promise<{ host?: string } | null>;
}

/** Why a path was not opened: the writer was never recorded, the task has no session, the
 *  session is gone, or reading it failed this time (the only one a retry may fix). */
export type SourceFailReason = 'unrecorded' | 'no-session' | 'gone' | 'lookup';

export function sourceFailReasonOfUnknown(src: AgentTextSource | undefined): SourceFailReason {
  return src?.unknownSource || src?.sessionId === 'external' ? 'unrecorded' : 'no-session';
}

/** Every reason but a failed lookup is answered by naming a machine; only a failed lookup is retried. */
export function sourceFailureNeedsPick(reason: SourceFailReason): boolean {
  return reason !== 'lookup';
}

/** The preview's words for a path that was not opened. A reason answered by naming a machine reads
 *  as the question it is, not as a fault; only a failed lookup is an error, and it offers a retry. */
export function sourceFailureText(reason: SourceFailReason): string {
  switch (reason) {
    case 'unrecorded':
      return 'Walnut did not record which session wrote these words, so it will not guess which machine has this file. No file was read yet.';
    case 'no-session':
      return 'The task that wrote these words has no session that tells Walnut its machine, so it will not guess which machine has this file. No file was read yet.';
    case 'gone':
      return 'The session that wrote these words is no longer known to Walnut, so it will not guess which machine has this file. No file was read yet.';
    case 'lookup':
      return "Couldn't open the path: its source session could not be read just now, so Walnut cannot tell which machine it is on. No file was read. You can try again.";
  }
}

export interface SourceOpenDeps {
  lookup: SessionHostLookup;
  open: (req: OpenFileRequest) => void;
  /** The host could not be told: nothing was opened. */
  fail: (info: { sessionId: string; path: string; error: string; reason: SourceFailReason }) => void;
}

/** Open `req` (no host of its own) on the source's host, reading the session on this click only. */
export async function openFromSource(src: AgentTextSource | undefined, req: OpenFileRequest, deps: SourceOpenDeps): Promise<void> {
  const s = sourceHostOf(src);
  if (s.kind === 'none') { deps.open(req); return; }
  if (s.kind === 'unknown') {
    const reason = sourceFailReasonOfUnknown(src);
    deps.fail({ sessionId: '', path: req.path, error: reason === 'unrecorded' ? 'The writer of these words was not recorded.' : 'The source task has no writing session.', reason });
    return;
  }
  if (s.kind === 'host') { deps.open({ ...req, host: s.host, sourceOnly: true }); return; }
  let record = deps.lookup.peek(s.sessionId);
  if (!record) {
    try {
      record = await deps.lookup.fetch(s.sessionId);
    } catch (err) {
      deps.fail({ sessionId: s.sessionId, path: req.path, error: err instanceof Error ? err.message : String(err), reason: 'lookup' });
      return;
    }
  }
  if (!record) { deps.fail({ sessionId: s.sessionId, path: req.path, error: 'session not found', reason: 'gone' }); return; }
  const host = record.host && !LOCAL_HOSTS.has(record.host) ? record.host : undefined;
  deps.open({ ...req, host, sourceOnly: true });
}

/** Which stored words of a task a surface shows: each has its own recorded writer. */
export type TaskTextField = 'report' | 'waiting' | 'needs' | 'line' | 'summary' | 'lastWords' | 'result' | 'partial';

const UNKNOWN: AgentTextSource = { unknownSource: true };
const PRIMARY: AgentTextSource = { host: '__local__' };
const bySession = (sid: string | undefined): AgentTextSource => (sid ? { sessionId: sid } : UNKNOWN);
const lineSource = (l: { by: string; sessionId?: string }): AgentTextSource => (l.by === 'human' ? PRIMARY : bySession(l.sessionId));

/**
 * Where a task's stored words came from, read only from the writer Walnut recorded with them
 * (2026-11-07: a status line written by an old session opened its path in the task's newer
 * session, on another machine). Never the task's current session: that is who runs now, not
 * who wrote these words. No record of the writer reads `unknownSource`, never a guess.
 */
export function taskTextSource(task: Task | null | undefined, field: TaskTextField): AgentTextSource {
  if (!task) return UNKNOWN;
  // An older server's payload lacks the writer fields: those words read unknown.
  const t = task;
  const us = t.user_status;
  const report = (): AgentTextSource => {
    if (!us) return UNKNOWN;
    if (us.reportBy === 'human') return PRIMARY;
    return bySession(us.reportSessionId);
  };
  switch (field) {
    case 'report':
      return report();
    case 'waiting': {
      const a = us?.answeredFor;
      if (a) return a.by === 'human' ? PRIMARY : bySession(a.sessionId);
      // Only the writer stored with waitingOn itself: a waiting Walnut generated (stuck, a set time,
      // a same-ask fold) is no report's words, so neither the report's writer nor the line stands in.
      if (us?.waitingBy === 'human') return PRIMARY;
      return bySession(us?.waitingSessionId);
    }
    case 'needs':
      if (us?.toRead === 'turn') return bySession(t.last_words?.session_id);
      if (us?.toRead === 'answer') return us.waitingBy === 'human' ? PRIMARY : bySession(us.waitingSessionId);
      if (us?.source === 'session') return us.askBy === 'human' ? PRIMARY : bySession(us.askSessionId);
      // A letter's, a choice's, a prompt's words: their writer is not on the task.
      return UNKNOWN;
    case 'line':
      return us?.line ? lineSource(us.line) : UNKNOWN;
    case 'summary':
      return bySession(t.summary_session_id);
    case 'lastWords':
      return bySession(t.last_words?.session_id);
    case 'partial':
    case 'result': {
      const r = t.result_report;
      if (!r || (field === 'partial' && r.not_done_by === 'unknown')) return UNKNOWN;
      // A person's result is on the primary only when recorded so (`host: local`): an older
      // `by: human` may be a session caller Walnut could not resolve.
      if (r.by === 'human') return r.host === 'local' ? PRIMARY : UNKNOWN;
      return bySession(r.sessionId);
    }
  }
}
