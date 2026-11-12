/**
 * One subagent's transcript, read as a ready view built on its own host
 * ('history-ready-subagent-v1', src/providers/history-ready-core.ts).
 *
 * The Background tasks reader used to read the agent's whole JSONL across the daemon link in 1 MB
 * ranges and parse it here. A 10 MB agent on a dev box took longer than the browser's 15 s
 * request, every open and every retry (2026-11-12), so the reader said "Failed to load
 * transcript". Now the host reads the newest part of the file, parses it with the same parser
 * (the same bounds as a session's first paint: at most 8 MB read, READY_MAX_ROWS rows and
 * READY_MAX_JSON_BYTES of JSON), and only those rows cross, gzipped. A view that does not reach
 * the file's start says so (`windowed`), and the reader tells the person.
 *
 * Never another view's rows: the answer must carry this schema and echo the agent asked for. The
 * old whole-file read is kept only for a host that cannot build the view (an older daemon, a
 * schema it does not share) or has no file where it looks; a host that has the view and fails it
 * is `failed`, because the whole-file read is the one that cannot finish in time.
 */

import { log } from '../logging/index.js';
import type { SessionRecord } from './types.js';
import { HISTORY_CACHE_SCHEMA, rewindCutsKey, type SessionHistoryMessage } from './history-parse.js';
import { HISTORY_PARSER_VERSION } from './history-parser-version.js';
import { legacyHintCutoff } from './sessions/legacy-hint-lines.js';
import { decodeReadyRowsCapped, type ReadyViewConnection } from './history-ready-view.js';
import { READY_MAX_ROWS } from '../providers/history-ready-core.js';

export const SUBAGENT_READY_CAPABILITY = 'history-ready-subagent-v1';
/** The host's budget for one ask. Two asks (the second joins the build) and the transfer fit the
 *  browser's 15 s with room for a slow link. */
export const SUBAGENT_VIEW_BUDGET_MS = 4_000;
/** How long the server waits for the host's answer past its budget: then the reader asks again. */
export const SUBAGENT_VIEW_REPLY_SLACK_MS = 2_500;
/** Rows the view may hold: the host's ceiling, so a small agent reads whole and the JSON byte cap
 *  (READY_MAX_JSON_BYTES) is what bounds a big one. */
export const SUBAGENT_VIEW_ROWS = READY_MAX_ROWS;

export interface SubagentView {
  messages: SessionHistoryMessage[];
  /** Rows in the parsed window. */
  total: number;
  /** The view does not reach the transcript's first line: earlier steps are not shown. */
  windowed: boolean;
}

export type SubagentViewOutcome =
  | { kind: 'rows'; view: SubagentView }
  /** The host still builds it: ask again soon (a whole-file read would take longer still). */
  | { kind: 'pending' }
  /** The host cannot build it (an older daemon) or found no file there: the caller's old read. */
  | { kind: 'unavailable'; reason: string }
  /** The host has the view but could not answer it (a row too large, its worker failed, the link
   *  dropped). Never followed by the whole-file read: that is the read which cannot finish. */
  | { kind: 'failed'; reason: string };

export interface SubagentViewDeps {
  connectionFor(hostKey: string): ReadyViewConnection | null;
  rewriteImages(rows: SessionHistoryMessage[], host: string, sessionId: string, cwd?: string): Promise<SessionHistoryMessage[]>;
}

async function defaultDeps(): Promise<SubagentViewDeps> {
  const [{ getConnectedDaemonConnection }, { rewriteHistoryRemoteImages }] = await Promise.all([
    import('../providers/daemon-connection.js'),
    import('./session-history.js'),
  ]);
  return { connectionFor: (hostKey) => getConnectedDaemonConnection(hostKey), rewriteImages: rewriteHistoryRemoteImages };
}

async function askOnce(conn: ReadyViewConnection, record: Pick<SessionRecord, 'claudeSessionId' | 'cwd'>, agentId: string): Promise<Record<string, unknown> | string> {
  try {
    const res = await conn.send('history.readyView', {
      sid: record.claudeSessionId,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      agentId,
      turns: 1,
      rows: SUBAGENT_VIEW_ROWS,
      budgetMs: SUBAGENT_VIEW_BUDGET_MS,
      legacyHintCutoffMs: legacyHintCutoff(),
      interactive: true,
    }, SUBAGENT_VIEW_BUDGET_MS + SUBAGENT_VIEW_REPLY_SLACK_MS);
    if (!res.ok) return typeof res.error === 'string' ? res.error : 'error';
    return res;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The subagent's view from its host, or why there is none. One more ask when the host is still
 * building (it joins that build, so it never parses twice). Never throws.
 */
export async function fetchSubagentView(
  record: Pick<SessionRecord, 'claudeSessionId' | 'cwd' | 'host'>,
  agentId: string,
  deps?: SubagentViewDeps,
): Promise<SubagentViewOutcome> {
  let d: SubagentViewDeps;
  try { d = deps ?? await defaultDeps(); } catch { return { kind: 'unavailable', reason: 'no-provider' }; }
  const hostKey = record.host ?? '__local__';
  const conn = d.connectionFor(hostKey);
  if (!conn || !conn.hasCapability(SUBAGENT_READY_CAPABILITY)) return { kind: 'unavailable', reason: 'no-capability' };
  let res = await askOnce(conn, record, agentId);
  if (typeof res !== 'string' && res.status === 'pending' && res.reason === 'building') res = await askOnce(conn, record, agentId);
  if (typeof res === 'string') return { kind: 'failed', reason: res };
  if (res.status === 'pending' && (res.reason === 'building' || res.reason === 'locating')) return { kind: 'pending' };
  // No file where the host looks: the old read searches the other layouts (nothing big to move).
  if (res.status === 'none' && res.reason === 'not-found') return { kind: 'unavailable', reason: 'not-found' };
  if (res.status !== 'ready') return { kind: 'failed', reason: `${String(res.status)}:${String(res.reason ?? '')}` };
  // Another row shape: the old read (only while a host's daemon is behind a schema bump).
  if (res.schema !== HISTORY_CACHE_SCHEMA) return { kind: 'unavailable', reason: 'schema' };
  // Rows of the same shape from a host one build behind are shown as they are: this view is
  // never kept or merged with the server's own parse, unlike a session's first paint.
  if (res.parser !== HISTORY_PARSER_VERSION) log.session.debug('subagent view from another parser build', { sessionId: record.claudeSessionId, agentId, parser: res.parser });
  // Only this agent's view, never the session's.
  if (res.agentId !== agentId || res.cutsKey !== rewindCutsKey(undefined)) return { kind: 'failed', reason: 'not-this-agent' };
  const decoded = await decodeReadyRowsCapped(res.rowsGz);
  if ('reason' in decoded) return { kind: 'failed', reason: decoded.reason };
  let messages = decoded.rows;
  if (record.host) messages = await d.rewriteImages(messages, record.host, record.claudeSessionId, record.cwd).catch(() => messages);
  log.session.debug('subagent view received', { sessionId: record.claudeSessionId, agentId, host: hostKey, rows: messages.length, windowed: res.windowed === true });
  return {
    kind: 'rows',
    view: {
      messages,
      total: typeof res.total === 'number' ? res.total : messages.length,
      windowed: res.windowed === true,
    },
  };
}
