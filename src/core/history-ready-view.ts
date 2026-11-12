/**
 * The server's half of a session's ready view ('history-ready-v1', src/providers/history-ready-core.ts).
 *
 * The session's daemon parses the newest part of the transcript on its own host and answers the
 * rows of a first paint, gzipped. Here the answer is checked (the parse's schema and version,
 * rewind cuts), given
 * what only the server knows (echo-claim bindings, local copies of remote images, unsettled
 * marks) and kept as the session's first-paint view (history-view-snapshot.ts), so the next open
 * paints with no host round trip at all.
 *
 * Who asks:
 *   - the history route's first paint, when no view is kept yet: it waits at most
 *     READY_VIEW_DEADLINE_MS, and not at all once its own preview is readable. Its smaller
 *     screen is served only on this request; the full refresh or background read keeps the
 *     fuller view, never replaced by a late interactive screen;
 *   - the background refresher after every turn and when a host comes back
 *     (history-ready-refresh.ts), with the key of the view kept, so an unchanged session costs a
 *     stat on its host and a few bytes on the link.
 *
 * Which sessions: native Claude Code transcripts that are not forks. A fork's first paint joins
 * its ancestors' transcripts (the route's fork block); an ACP engine has a journal, not a
 * transcript. Both keep their existing first paint (a kept view, else the preview).
 */

import zlib from 'node:zlib';
import { log } from '../logging/index.js';
import type { SessionRecord } from './types.js';
import { HISTORY_CACHE_SCHEMA, rewindCutsKey, type SessionHistoryMessage } from './history-parse.js';
import { legacyHintCutoff } from './sessions/legacy-hint-lines.js';
import { beginHistoryViewRead, historyViewGeneration, olderThanKept, readHistoryViewMeta, saveHistoryView, type HistoryViewRead } from './history-view-snapshot.js';
import { HISTORY_PARSER_VERSION } from './history-parser-version.js';
import { HISTORY_OPEN_SCREEN_ROWS } from './history-open-preview.js';
import { isUnsettledRow } from './history-delta.js';
import { READY_MAX_JSON_BYTES, READY_MAX_ROWS } from '../providers/history-ready-core.js';
import { questionTurnIds } from '../lib/history-turn-window.js';

/** How long the history route's first paint waits for a host's ready view. */
export const READY_VIEW_DEADLINE_MS = 900;
/** The daemon's own budget for a first paint (inside the deadline, with the link's time). */
export const READY_VIEW_INTERACTIVE_BUDGET_MS = 600;
/** The daemon's budget for a background refresh: it may build the whole view. */
export const READY_VIEW_BACKGROUND_BUDGET_MS = 10_000;
/** Turns and rows a ready view aims for: what the web asks of its first paint (400 rows, ten turns). */
export const READY_VIEW_TURNS = 10;
export const READY_VIEW_ROWS = 400;

/**
 * The turns a session's ready view asks its host for: the main conversation's ten, plus one
 * per Ask here follow-up. The host parses without the question anchors and counts every user
 * turn, so a session whose last turns were sent in cards still gets ten main turns back, which
 * the route then re-slices by the main line (sessions.ts sliceHistory). Capped at the host's
 * own limit (history-ready-core.ts turnsOf).
 */
export function readyViewTurns(record: Pick<SessionRecord, 'threadAnchors'>): number {
  return Math.min(100, READY_VIEW_TURNS + questionTurnIds(record.threadAnchors).size);
}

export const HISTORY_READY_CAPABILITY = 'history-ready-v1';
/** The most base64 a ready answer's rows may be (gzip of READY_MAX_JSON_BYTES, never larger in practice). */
export const READY_MAX_ROWS_GZ_B64 = Math.ceil((READY_MAX_JSON_BYTES + 64 * 1024) / 3) * 4;

/** What a kept or fresh ready view carries into the route's answer. */
export interface ReadyViewRows {
  messages: SessionHistoryMessage[];
  total: number;
  windowed: boolean;
  complete: boolean;
  readable: boolean;
  finishedAgentIds?: string[];
  key: string;
}

/** The connection a fetch talks to (DaemonConnection; a fake in tests). */
export interface ReadyViewConnection {
  hasCapability(cap: string): boolean;
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; [key: string]: unknown }>;
}

export interface ReadyViewFetchDeps {
  connectionFor(hostKey: string): ReadyViewConnection | null;
  /** Remote image paths to local copies (session-history.ts rewriteHistoryRemoteImages). */
  rewriteImages(rows: SessionHistoryMessage[], host: string, sessionId: string, cwd?: string): Promise<SessionHistoryMessage[]>;
  /** Echo-claim binding (echo-claims.ts bindEchoClaims). */
  bindEchoClaims(sessionId: string, rows: SessionHistoryMessage[]): void;
  /** The session's recorded rewind cuts NOW (session-tracker.ts), read after the host answered. */
  readCuts(sessionId: string): Promise<NonNullable<SessionRecord['inPlaceRewinds']> | null>;
}

async function defaultDeps(): Promise<ReadyViewFetchDeps> {
  const [{ getConnectedDaemonConnection }, { rewriteHistoryRemoteImages }, { bindEchoClaims }, { getSessionByClaudeId }] = await Promise.all([
    import('../providers/daemon-connection.js'),
    import('./session-history.js'),
    import('./echo-claims.js'),
    import('./session-tracker.js'),
  ]);
  return {
    connectionFor: (hostKey) => getConnectedDaemonConnection(hostKey),
    rewriteImages: rewriteHistoryRemoteImages,
    bindEchoClaims: (sid, rows) => bindEchoClaims(sid, rows),
    readCuts: async (sid) => { const r = await getSessionByClaudeId(sid); return r ? (r.inPlaceRewinds ?? []) : null; },
  };
}

/** A recorded cut as the daemon takes it (readyRequestFromWire): every field the probe replays. */
export function wireCut(c: NonNullable<SessionRecord['inPlaceRewinds']>[number]): { uuid: string; lastUuidAtCommit: string; trailingQueueKeys?: string[] } {
  return { uuid: c.uuid, lastUuidAtCommit: c.lastUuidAtCommit, ...(c.trailingQueueKeys?.length ? { trailingQueueKeys: [...c.trailingQueueKeys] } : {}) };
}

/** Can this session have a ready view at all (before asking any host)? */
export function readyViewEligible(record: Pick<SessionRecord, 'forkedFromSessionId' | 'engine'> | null | undefined, isAcpJournal: boolean): boolean {
  return !!record && !record.forkedFromSessionId && !isAcpJournal;
}

/** Gunzip with a hard cap on what comes out: a broken or hostile answer never decodes past it. */
const gunzipCapped = (buf: Buffer, maxBytes: number): Promise<Buffer> => new Promise((resolve, reject) => {
  zlib.gunzip(buf, { maxOutputLength: maxBytes }, (err, out) => {
    if (err) reject(err);
    else if (out.length > maxBytes) reject(new Error('ready view rows over the byte cap'));
    else resolve(out);
  });
});

const ROLES = new Set(['user', 'assistant', 'system']);
/** Rows as the parser makes them, at least in the fields every reader relies on. */
function validRows(value: unknown): value is SessionHistoryMessage[] {
  if (!Array.isArray(value) || value.length > READY_MAX_ROWS) return false;
  for (const row of value) {
    if (!row || typeof row !== 'object') return false;
    const r = row as { role?: unknown; text?: unknown; timestamp?: unknown };
    if (typeof r.role !== 'string' || !ROLES.has(r.role) || typeof r.text !== 'string') return false;
    if (r.timestamp !== undefined && typeof r.timestamp !== 'string') return false;
  }
  return true;
}

export type ReadyFetchOutcome =
  | { kind: 'rows'; rows: ReadyViewRows }
  | { kind: 'unchanged'; key: string }
  | { kind: 'unavailable'; reason: string };

/**
 * Ask the session's host for its ready view and, when one comes, keep it as the session's
 * first-paint view. Resolves when the host answered (or failed); the caller races it against
 * its own deadline. Never throws.
 */
export async function fetchReadyView(
  record: SessionRecord,
  opts: { interactive: boolean; have?: string; read?: HistoryViewRead; deps?: ReadyViewFetchDeps },
): Promise<ReadyFetchOutcome> {
  const sessionId = record.claudeSessionId;
  const hostKey = record.host ?? '__local__';
  // Captured before the ask: a rewind meanwhile bumps its generation and the answer is not kept;
  // a view saved from a read that began later is newer than anything this answer holds.
  const read = opts.read ?? beginHistoryViewRead(sessionId);
  const generation = read.generation;
  let deps: ReadyViewFetchDeps;
  try { deps = opts.deps ?? await defaultDeps(); } catch { return { kind: 'unavailable', reason: 'no-provider' }; }
  const conn = deps.connectionFor(hostKey);
  if (!conn || !conn.hasCapability(HISTORY_READY_CAPABILITY)) return { kind: 'unavailable', reason: 'no-capability' };
  const cuts = record.inPlaceRewinds?.length ? record.inPlaceRewinds : undefined;
  const budgetMs = opts.interactive ? READY_VIEW_INTERACTIVE_BUDGET_MS : READY_VIEW_BACKGROUND_BUDGET_MS;
  let res: { ok: boolean; [key: string]: unknown };
  try {
    res = await conn.send('history.readyView', {
      sid: sessionId,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(cuts ? { cuts: cuts.map(wireCut) } : {}),
      turns: opts.interactive ? 1 : readyViewTurns(record),
      rows: opts.interactive ? HISTORY_OPEN_SCREEN_ROWS : READY_VIEW_ROWS,
      budgetMs,
      legacyHintCutoffMs: legacyHintCutoff(),
      ...(opts.have ? { have: opts.have } : {}),
      ...(opts.interactive ? { interactive: true } : {}),
    }, budgetMs + 20_000);
  } catch (err) {
    return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { kind: 'unavailable', reason: typeof res.error === 'string' ? res.error : 'error' };
  if (res.status === 'unchanged' && typeof res.key === 'string') return { kind: 'unchanged', key: res.key };
  if (res.status !== 'ready') return { kind: 'unavailable', reason: `${String(res.status)}:${String(res.reason ?? '')}` };
  // Another parse (a host on an older or newer daemon: shape or behaviour) or other cuts: never a
  // view of this server's.
  if (res.schema !== HISTORY_CACHE_SCHEMA) return { kind: 'unavailable', reason: 'schema' };
  if (res.parser !== HISTORY_PARSER_VERSION) return { kind: 'unavailable', reason: 'parser' };
  if (res.cutsKey !== rewindCutsKey(cuts)) return { kind: 'unavailable', reason: 'cuts' };
  if (typeof res.rowsGz !== 'string' || typeof res.key !== 'string') return { kind: 'unavailable', reason: 'malformed' };
  // Bounded before any decode: a host on another version, or a broken one, cannot make this
  // server inflate or parse more than a view is allowed to be.
  if (res.rowsGz.length > READY_MAX_ROWS_GZ_B64) return { kind: 'unavailable', reason: 'too-large' };
  let messages: SessionHistoryMessage[];
  try {
    const parsed = JSON.parse((await gunzipCapped(Buffer.from(res.rowsGz, 'base64'), READY_MAX_JSON_BYTES)).toString('utf8')) as unknown;
    if (!validRows(parsed)) return { kind: 'unavailable', reason: 'malformed' };
    messages = parsed;
  } catch {
    return { kind: 'unavailable', reason: 'malformed' };
  }
  try { deps.bindEchoClaims(sessionId, messages); } catch { /* text dedup stays the fallback */ }
  if (record.host) messages = await deps.rewriteImages(messages, record.host, sessionId, record.cwd).catch(() => messages);
  messages = messages.map((m) => (isUnsettledRow(m) ? { ...m, unsettled: true } : m));
  // A rewind while the host worked: the rows may hold the branch it cut. The generation moves
  // with every rewind's invalidation, and the cuts the session holds NOW must be the ones the
  // host filtered by (a record read before the cut was recorded asked with none).
  if (historyViewGeneration(sessionId) !== generation) return { kind: 'unavailable', reason: 'rewound' };
  const cutsNow = await deps.readCuts(sessionId).catch(() => null);
  if (cutsNow === null || rewindCutsKey(cutsNow.length ? cutsNow : undefined) !== res.cutsKey) return { kind: 'unavailable', reason: 'rewound' };
  if (historyViewGeneration(sessionId) !== generation) return { kind: 'unavailable', reason: 'rewound' };
  const rows: ReadyViewRows = {
    messages,
    total: typeof res.total === 'number' ? res.total : messages.length,
    windowed: res.windowed === true,
    complete: res.complete === true,
    readable: res.readable === true,
    ...(Array.isArray(res.finishedAgentIds) && res.finishedAgentIds.length ? { finishedAgentIds: res.finishedAgentIds.filter((id): id is string => typeof id === 'string') } : {}),
    key: res.key,
  };
  // A view of nothing to read is not kept: the next open asks again (the file may have grown).
  // Nor one older than the view kept: this answer can come long after its ask, so the kept
  // view's own read time is looked up first (on disk too, when memory has let it go), and
  // saveHistoryView compares again, in step with any save since.
  if (!opts.interactive && rows.readable && messages.length > 0 && !olderThanKept((await readHistoryViewMeta(sessionId))?.contentAt, read.at)) {
    saveHistoryView(sessionId, {
      messages,
      total: rows.total,
      windowed: rows.windowed,
      ...(rows.finishedAgentIds ? { finishedAgentIds: rows.finishedAgentIds } : {}),
      readyKey: res.key,
      origin: 'ready',
    }, read);
  }
  log.session.debug('history ready view received', {
    sessionId, host: hostKey, rows: messages.length, complete: rows.complete, readable: rows.readable, interactive: opts.interactive,
  });
  return { kind: 'rows', rows };
}

/**
 * The route's first paint from the host: the ready screen if it comes within `deadlineMs`, else
 * null. A later interactive answer is neither shown nor saved; the full refresh owns the kept view.
 */
export async function readyViewWithin(
  record: SessionRecord,
  deadlineMs = READY_VIEW_DEADLINE_MS,
  deps?: ReadyViewFetchDeps,
): Promise<ReadyViewRows | null> {
  const read = beginHistoryViewRead(record.claudeSessionId);
  const fetch = fetchReadyView(record, { interactive: true, read, deps });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
  try {
    const outcome = await Promise.race([fetch, late]);
    return outcome && outcome.kind === 'rows' && outcome.rows.readable ? outcome.rows : null;
  } finally {
    clearTimeout(timer);
  }
}

export type FirstPaintPick<P> = { kind: 'ready'; ready: ReadyViewRows } | { kind: 'preview'; preview: P };

/**
 * The first paint's rows: the host's ready view or the route's own preview, whichever is
 * readable first. A readable preview never waits for the ready view (a host still building, or
 * still looking for the file, answers within READY_VIEW_DEADLINE_MS, which is far longer than a
 * preview takes); a preview with nothing to read waits for the ready view, bounded by that
 * deadline. A preview that fails waits for the ready view too, and fails only when it has none.
 */
export function firstPaintRace<P>(
  readyP: Promise<ReadyViewRows | null> | null,
  previewP: Promise<P>,
  previewReadable: (preview: P) => boolean,
): Promise<FirstPaintPick<P>> {
  if (!readyP) return previewP.then((preview) => ({ kind: 'preview', preview }));
  return new Promise<FirstPaintPick<P>>((resolve, reject) => {
    let settled = false;
    let readyDone = false;
    let preview: { ok: true; value: P } | { ok: false; error: unknown } | null = null;
    const pick = (value: FirstPaintPick<P>): void => { if (!settled) { settled = true; resolve(value); } };
    const fallBack = (): void => {
      if (settled || !preview) return;
      if (preview.ok) pick({ kind: 'preview', preview: preview.value });
      else { settled = true; reject(preview.error); }
    };
    readyP.then(
      (ready) => { readyDone = true; if (ready) pick({ kind: 'ready', ready }); else fallBack(); },
      () => { readyDone = true; fallBack(); },
    );
    previewP.then(
      (value) => { preview = { ok: true, value }; if (readyDone || previewReadable(value)) fallBack(); },
      (error: unknown) => { preview = { ok: false, error }; if (readyDone) fallBack(); },
    );
  });
}
