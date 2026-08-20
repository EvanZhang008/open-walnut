/**
 * Session -> QMD sync module.
 *
 * Reads Claude Code sessions from sessions.json, joins with task data
 * for richer content, and inserts into the QMD session store for semantic search.
 * Uses content-hash comparison to skip unchanged sessions.
 *
 * Design notes:
 * - Same programmatic-only / hash-skip / virtual-path conventions as qmd-task-sync.ts.
 * - Session joins task data: serializeSession() enriches session text with linked
 *   task summary/description so semantic search finds sessions by task content too.
 * - embed() is called by the server's debounced event handler (not here)
 *   for incremental syncs. syncAllSessions() calls embed() directly for bulk init.
 */
import { createHash } from 'node:crypto';
import {
  embedQmdStore,
  getSessionStore,
  DEFAULT_QMD_MODEL,
} from './qmd-store.js';
import { listSessions } from './session-tracker.js';
import { listTasks } from './task-manager.js';
import { readSessionHistoryTail } from './session-history.js';
import { buildIndexedContent } from './session-content-indexer.js';
import { log } from '../logging/index.js';
import { pruneStaleQmdDocuments } from './qmd-sync-utils.js';
import type { SessionRecord, Task } from './types.js';

const COLLECTION = 'sessions';

/** Timeout for reading JSONL conversation content during indexing. Remote reads
 *  go through the daemon (already 30s-capped); this is the outer guard so a slow
 *  host can't stall the debounced flush. */
const CONTENT_READ_TIMEOUT_MS = 20_000;

export interface SerializeOptions {
  /** Read + filter JSONL conversation body and append it. Default true. */
  includeContent?: boolean;
}

interface ConversationBodyRead {
  body: string | null;
  failed: boolean;
  /** Commit SHAs extracted from the full history (see extractCommitShas). */
  commitShas?: string[];
}

interface SerializedSession {
  text: string | null;
  contentReadFailed: boolean;
}

/** Metadata + linked-task header (always cheap, no I/O). */
function serializeMetadata(session: SessionRecord, task?: Task): string {
  const parts: string[] = [];
  if (session.title) parts.push(session.title);
  if (session.description) parts.push(session.description);
  if (session.planContent) parts.push(session.planContent);
  if (task) {
    if (task.summary) parts.push(task.summary);
    if (task.description) parts.push(task.description);
  }
  const meta: string[] = [];
  if (session.project) meta.push(`Project: ${session.project}`);
  if (session.cwd) meta.push(`CWD: ${session.cwd}`);
  if (session.host) meta.push(`Host: ${session.host}`);
  if (meta.length) parts.push(meta.join(' | '));
  return parts.join('\n\n');
}

/**
 * Read and filter the provider-native conversation history. Failure is
 * explicit so an existing content-rich document is never replaced by a
 * metadata-only transient read.
 *
 * Remote sessions are read through the SAME tail-bounded path as local ones —
 * readSessionHistoryTail's window path stats first and pulls a bounded RANGE
 * via DaemonFileReader.readFileRange, so a whale JSONL never crosses the
 * tunnel whole (the old blanket skip predated ranged reads and left every
 * clouddev session unsearchable — half the user's work). Remote uses a
 * smaller window than local: 1 MB is still 20× the 50 KB index budget, and
 * keeps the per-session transfer well under proxy kill thresholds. A dead
 * daemon/tunnel surfaces as a null read → failed:true → the existing doc
 * (or metadata-only) stays, same as a local read error.
 */
const REMOTE_TAIL_BYTES = 1 * 1024 * 1024;
async function readConversationBody(
  session: SessionRecord,
): Promise<ConversationBodyRead> {
  if (session.engine === 'codex') {
    let acpTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const { readAcpSessionHistoryState } =
        await import('../providers/acp-session-history.js');
      // Same deadline as the native branch below: indexing keeps ≤50KB of
      // cleaned text; bound the cold read to a tail window and never let a
      // wedged fold stall the debounced flush.
      const state = await Promise.race([
        readAcpSessionHistoryState(session, { maxColdReadBytes: REMOTE_TAIL_BYTES }),
        new Promise<never>((_, reject) => {
          acpTimeout = setTimeout(
            () => reject(new Error('content read timeout')),
            CONTENT_READ_TIMEOUT_MS,
          );
        }),
      ]);
      if (!state.journalExists) return { body: null, failed: true };
      if (state.messages.length === 0) return { body: null, failed: false };
      const { body, commitShas } = buildIndexedContent(state.messages);
      return { body: body || null, failed: false, commitShas };
    } catch (err) {
      log.agent.debug('ACP session content read failed during indexing', {
        sessionId: session.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { body: null, failed: true };
    } finally {
      if (acpTimeout) clearTimeout(acpTimeout);
    }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Tail-bounded read: indexing keeps ≤50 KB of cleaned text, so pulling a
    // whole whale JSONL to index its tail was pure waste (167 GB/day of full
    // re-reads pre-fix). The tail window (4 MB local / 1 MB remote) exceeds
    // the index budget by orders of magnitude even after cleaning.
    const messages = await Promise.race([
      readSessionHistoryTail(
        session.claudeSessionId,
        session.cwd,
        session.host,
        session.outputFile,
        session.host ? REMOTE_TAIL_BYTES : undefined,
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('content read timeout')),
          CONTENT_READ_TIMEOUT_MS,
        );
      }),
    ]);
    // null = tail read FAILED (vs []: file exists but no messages). Propagate
    // as failed so an existing content-rich doc isn't replaced by metadata-only.
    if (messages === null) return { body: null, failed: true };
    if (messages.length === 0) {
      return { body: null, failed: false };
    }
    const { body, commitShas } = buildIndexedContent(messages);
    return { body: body || null, failed: false, commitShas };
  } catch (err) {
    log.agent.debug('session content read failed during indexing', {
      sessionId: session.claudeSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { body: null, failed: true };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Serialize a session into searchable text for embedding (v2).
 * Layout (QMD chunks on `## ` headings):
 *   # Session Gist        (LLM summary, when available — highest-signal)
 *   # Session Metadata    (title/desc/plan/task/project/cwd/host)
 *   ## Turn N ...         (filtered conversation body)
 *
 * Returns null when includeContent is requested but the JSONL read failed AND
 * there's no summary/metadata worth indexing on its own — signals the caller
 * to leave any existing doc untouched.
 */
async function serializeSession(
  session: SessionRecord,
  task?: Task,
  opts?: SerializeOptions,
): Promise<SerializedSession> {
  const includeContent = opts?.includeContent !== false;
  const sections: string[] = [];
  let contentReadFailed = false;

  if (session.summary) sections.push(`# Session Gist\n${session.summary}`);

  const meta = serializeMetadata(session, task);
  if (meta) sections.push(`# Session Metadata\n${meta}`);

  if (includeContent) {
    const content = await readConversationBody(session);
    contentReadFailed = content.failed;
    const body = content.body;
    // Commits FIRST (their own heading → own QMD chunk): extracted from the
    // full history, so a SHA search finds this session even when the commit's
    // turn fell out of the tail-capped body. Also backfilled onto the session
    // record (structured field) — best-effort, index write must not depend on it.
    if (content.commitShas?.length) {
      sections.push(`# Commits\n${content.commitShas.join('\n')}`);
      void backfillCommitShas(session, content.commitShas);
    }
    if (body) sections.push(body);
  }

  return {
    text: sections.length ? sections.join('\n\n') : null,
    contentReadFailed,
  };
}

/**
 * Persist extracted commit SHAs onto the SessionRecord (payload field), making
 * commit→session→task a structured one-hop lookup instead of a transcript
 * archaeology exercise. Skips the write when nothing changed.
 */
async function backfillCommitShas(session: SessionRecord, shas: string[]): Promise<void> {
  try {
    const existing = session.commitShas ?? [];
    if (existing.length === shas.length && existing.every((s, i) => s === shas[i])) return;
    const { updateSessionRecord } = await import('./session-tracker.js');
    await updateSessionRecord(session.claudeSessionId, { commitShas: shas });
  } catch (err) {
    log.agent.debug('commit sha backfill skipped', {
      sessionId: session.claudeSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** SHA256 hash of serialized content. */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Virtual document path for a session. */
function sessionDocPath(sessionId: string): string {
  return `sess-${sessionId}`;
}

export interface SyncAllOptions {
  /** Max concurrent JSONL reads (content embedding I/O). Default 4. */
  concurrency?: number;
  force?: boolean;
  onProgress?: (progress: {
    chunksEmbedded: number;
    totalChunks: number;
    bytesProcessed: number;
    totalBytes: number;
  }) => void;
}

/**
 * Full sync: read all sessions, join with tasks, insert/update in QMD, then embed.
 * Skips sessions whose content hash hasn't changed. Reads JSONL content with
 * bounded concurrency so a few-hundred-session backfill doesn't starve the
 * event loop or thrash remote daemons.
 */
export async function syncAllSessions(opts?: SyncAllOptions): Promise<void> {
  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const store = await getSessionStore();
  const [sessions, tasks] = await Promise.all([listSessions(), listTasks()]);
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // Worker pool over the session list — each worker serializes (may read JSONL)
  // then writes to the store. SQLite writes are synchronous so they don't race.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < sessions.length) {
      const session = sessions[cursor++];
      const task = session.taskId ? taskMap.get(session.taskId) : undefined;
      const docPath = sessionDocPath(session.claudeSessionId);
      const title = session.title || session.claudeSessionId.slice(0, 12);
      const existing = store.internal.findActiveDocument(COLLECTION, docPath);
      const serialized = await serializeSession(session, task);
      const text = serialized.text;
      const now = new Date().toISOString();

      if (serialized.contentReadFailed && existing) {
        skipped++;
        continue;
      }
      if (!text || !text.trim()) { skipped++; continue; }

      const hash = contentHash(text);

      if (existing && existing.hash === hash) { skipped++; continue; }

      store.internal.insertContent(hash, text, now);
      if (existing) {
        store.internal.updateDocument(existing.id, title, hash, now);
        updated++;
      } else {
        store.internal.insertDocument(COLLECTION, docPath, title, hash, now, now);
        inserted++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Re-read at prune time so sessions created while workers were indexing are
  // retained even if their incremental sync won the race with this bulk pass.
  const currentSessions = await listSessions();
  const expectedPaths = new Set(
    currentSessions.map((session) => sessionDocPath(session.claudeSessionId)),
  );
  const pruned = pruneStaleQmdDocuments(store, COLLECTION, expectedPaths);

  const model = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;
  await embedQmdStore(store, 'session', {
    ...(opts?.force ? { force: true } : {}),
    model,
    onProgress: opts?.onProgress,
  });

  log.agent.info(`QMD session sync: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${pruned.deactivated} stale removed (${sessions.length} total)`, {
    pruned,
  });
}

/**
 * Incremental sync: upsert a single session (insert/update only, no embed).
 * Call flushSessionEmbeddings() after batching multiple syncs.
 * Optionally accepts a pre-loaded task to avoid re-reading tasks.json.
 *
 * When the JSONL read fails, serializeSession may return content without the
 * conversation body. We never DELETE an existing doc here — if serialization
 * yields nothing, we leave the prior (good) doc in place.
 */
export async function syncSession(
  session: SessionRecord,
  task?: Task,
  opts?: SerializeOptions,
): Promise<boolean> {
  const store = await getSessionStore();

  // If task not provided, try to load it
  let linkedTask = task;
  if (!linkedTask && session.taskId) {
    try {
      const tasks = await listTasks();
      linkedTask = tasks.find(t => t.id === session.taskId);
    } catch { /* task may have been deleted */ }
  }

  const docPath = sessionDocPath(session.claudeSessionId);
  const title = session.title || session.claudeSessionId.slice(0, 12);
  const now = new Date().toISOString();

  const existing = store.internal.findActiveDocument(COLLECTION, docPath);
  const serialized = await serializeSession(session, linkedTask, opts);
  const text = serialized.text;
  if (serialized.contentReadFailed && existing) return false;
  if (!text || !text.trim()) return false;

  const hash = contentHash(text);
  if (existing && existing.hash === hash) {
    return store.internal.getHashesNeedingEmbedding() > 0;
  }

  store.internal.insertContent(hash, text, now);

  if (existing) {
    store.internal.updateDocument(existing.id, title, hash, now);
  } else {
    store.internal.insertDocument(COLLECTION, docPath, title, hash, now, now);
  }
  return true;
}

/**
 * Flush pending session embeddings. Called once after batching multiple syncSession() calls.
 */
export async function flushSessionEmbeddings(): Promise<void> {
  const store = await getSessionStore();
  const model = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;
  await embedQmdStore(store, 'session', { model });
}

/** Remove a deleted session from the QMD store. */
export async function removeSession(sessionId: string): Promise<void> {
  const store = await getSessionStore();
  store.internal.deactivateDocument(COLLECTION, sessionDocPath(sessionId));
}
