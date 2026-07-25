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
 * LOCAL SESSIONS ONLY: remote sessions are skipped here because reading their
 * JSONL means pulling the full (up to ~14MB) file over the SSH tunnel, which
 * some corporate proxies kill past ~5MB. Indexing remote conversation content requires
 * a daemon-side filter RPC (filter on the remote host, ship back ~50KB) — that
 * is a separate, larger change. Until then remote sessions stay metadata-only.
 */
async function readConversationBody(
  session: SessionRecord,
): Promise<ConversationBodyRead> {
  if (session.engine === 'codex') {
    try {
      const { readAcpSessionHistoryState } =
        await import('../providers/acp-session-history.js');
      const state = await readAcpSessionHistoryState(session);
      if (!state.journalExists) return { body: null, failed: true };
      if (state.messages.length === 0) return { body: null, failed: false };
      const { body } = buildIndexedContent(state.messages);
      return { body: body || null, failed: false };
    } catch (err) {
      log.agent.debug('ACP session content read failed during indexing', {
        sessionId: session.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { body: null, failed: true };
    }
  }

  if (session.host) return { body: null, failed: false }; // remote Claude session
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Tail-bounded read: indexing keeps ≤50 KB of cleaned text, so pulling a
    // whole whale JSONL to index its tail was pure waste (167 GB/day of full
    // re-reads pre-fix). The tail window (4 MB) exceeds the index budget by
    // orders of magnitude even after cleaning.
    const messages = await Promise.race([
      readSessionHistoryTail(session.claudeSessionId, session.cwd, session.host, session.outputFile),
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
    const { body } = buildIndexedContent(messages);
    return { body: body || null, failed: false };
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
    if (body) sections.push(body);
  }

  return {
    text: sections.length ? sections.join('\n\n') : null,
    contentReadFailed,
  };
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
