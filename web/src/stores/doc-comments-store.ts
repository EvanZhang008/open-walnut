/**
 * One document's comments file (utils/doc-comments.ts), kept per sidecar for the
 * whole page, not per view: a change the user made is written even after the doc
 * is closed or another file is opened, and two views of one doc show the same list.
 *
 * The file is the truth: the AI replies and resolves by editing it with its own
 * tools, so it is re-read whenever it may have changed (useDocComments says when),
 * conditionally, which costs a 304 when nothing moved.
 *
 * The user's changes are edits (functions of the list on disk), shown at once on
 * top of the last read and written one batch at a time under the file's hash lock.
 * A write that lost a race (the AI wrote in between) is a 409: the file is read
 * again and the same edits replayed on what it holds, so a reply written meanwhile
 * is never lost and nothing is merged by guesswork. A read that started before a
 * write landed is dropped (it holds older bytes than the write).
 */
import {
  createFile, fetchFileContentConditional, FileOpError, FileSaveConflictError, saveFileContent,
} from '@/api/files';
import {
  parseDocCommentsFile, serializeDocComments, type DocComment, type DocCommentEdit,
} from '@/utils/doc-comments';
import { log } from '@/utils/log';

const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Lost races in a row before the write waits for the next retry. */
const MAX_REPLAYS = 4;
/** With nobody looking, a failing write gives up after this many tries (and says so in the log). */
const MAX_UNWATCHED_ATTEMPTS = 8;

interface Disk {
  list: DocComment[];
  preface: string[];
  /** null = the sidecar does not exist yet. */
  hash: string | null;
  /** Set when the file must not be written (not a comments file, too large to read whole). */
  readOnly?: string;
}

export interface DocCommentsSnapshot {
  /** The comments as shown: the last read with the edits not written yet on top. */
  comments: DocComment[];
  /** Read once (absent counts, with no comments). */
  loaded: boolean;
  /** A write failed and is retried, or the file cannot be written; the edits are kept. */
  saveError: string | null;
  /** The last read failed (host reconnecting...): the list shown is the one before. */
  readError: string | null;
}

interface Entry {
  sidecar: string;
  host?: string;
  docName: string;
  disk: Disk | null;
  /** Bumped by every write that landed: a read started before it is older. */
  writes: number;
  /** Bumped by every read: only the newest one may set what is shown. */
  reads: number;
  edits: DocCommentEdit[];
  writing: boolean;
  reading: Promise<Disk | null> | null;
  attempt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  saveError: string | null;
  readError: string | null;
  listeners: Set<() => void>;
  snapshot: DocCommentsSnapshot;
}

const entries = new Map<string, Entry>();
const EMPTY: DocCommentsSnapshot = { comments: [], loaded: false, saveError: null, readError: null };

function keyOf(sidecar: string, host?: string): string {
  return `${host ?? ''}\u0000${sidecar}`;
}

export function docCommentsEntry(sidecar: string, host: string | undefined, docName: string): Entry {
  const key = keyOf(sidecar, host);
  let e = entries.get(key);
  if (!e) {
    e = {
      sidecar, host, docName, disk: null, writes: 0, reads: 0, edits: [], writing: false, reading: null, attempt: 0,
      saveError: null, readError: null, listeners: new Set(), snapshot: EMPTY,
    };
    entries.set(key, e);
  }
  return e;
}

function notify(e: Entry): void {
  e.snapshot = {
    comments: e.edits.reduce<DocComment[]>((list, ed) => ed(list), e.disk?.list ?? []),
    loaded: !!e.disk,
    saveError: e.saveError ?? (e.edits.length && e.disk?.readOnly ? e.disk.readOnly : null),
    readError: e.readError,
  };
  for (const l of e.listeners) l();
}

export function subscribeDocComments(e: Entry, listener: () => void): () => void {
  e.listeners.add(listener);
  return () => { e.listeners.delete(listener); };
}

function diskOf(content: string, hash: string | null, truncated: boolean, sidecar: string): Disk {
  const file = parseDocCommentsFile(content);
  const name = sidecar.slice(sidecar.lastIndexOf('/') + 1);
  // A file of the same name the user keeps for something else: shown as nothing, never written over.
  const foreign = !!content.trim() && !file.isWalnutFile && file.comments.length === 0;
  const readOnly = foreign ? `${name} is not a comments file, so new comments are not saved into it`
    : truncated || !hash ? `${name} is too large to edit here` : undefined;
  return { list: foreign ? [] : file.comments, preface: file.preface, hash, ...(readOnly ? { readOnly } : {}) };
}

/** Read the file. `force` skips the 304 (after a lost race the hash is stale anyway). */
function read(e: Entry, force = false): Promise<Disk | null> {
  if (e.reading && !force) return e.reading;
  const writesAtStart = e.writes;
  const seq = ++e.reads;
  const known = e.disk;
  const p = fetchFileContentConditional(e.sidecar, e.host, force || !known?.hash ? {} : { ifNoneMatch: known.hash })
    .then((res) => {
      // A write landed, or a newer read went out, while this one was out: its bytes are older.
      if (e.writes !== writesAtStart || e.reads !== seq) return e.disk;
      if (res.notModified && known) {
        if (e.readError) { e.readError = null; notify(e); }
        return known;
      }
      const payload = res.payload;
      if (!payload || payload.content == null) {
        if (payload?.error && payload.error !== 'File not found') {
          // Not "absent": the host is reconnecting or the read failed. Keep what was shown.
          e.readError = payload.error;
          notify(e);
          return e.disk;
        }
        e.disk = { list: [], preface: [], hash: null };
      } else {
        e.disk = diskOf(payload.content, payload.contentHash ?? null, !!payload.truncated, e.sidecar);
      }
      e.readError = null;
      notify(e);
      return e.disk;
    })
    .catch((err) => {
      e.readError = err instanceof Error ? err.message : String(err);
      log.warn('doc-comments', 'comments read failed', { path: e.sidecar, host: e.host, error: e.readError });
      notify(e);
      return e.disk;
    })
    .finally(() => { if (e.reading === p) e.reading = null; });
  e.reading = p;
  return p;
}

async function flush(e: Entry): Promise<void> {
  if (e.writing || !e.edits.length) return;
  e.writing = true;
  clearTimeout(e.retryTimer);
  try {
    let base = e.disk ?? await read(e, true);
    for (let replay = 0; e.edits.length; ) {
      if (!base) throw new Error(e.readError ?? 'The comments file could not be read');
      if (base.readOnly) { notify(e); return; } // kept, shown as the reason; never written
      if (base.hash === null) {
        // The first comment on this doc: make the file, then write under its (empty) hash.
        try { await createFile(e.sidecar, e.host); } catch (err) {
          if (!(err instanceof FileOpError && err.code === 'exists')) throw err;
        }
        base = await read(e, true);
        if (base && base.hash === null) throw new Error(e.readError ?? 'The comments file could not be made');
        continue;
      }
      const batch = e.edits;
      const next = batch.reduce<DocComment[]>((list, ed) => ed(list), base.list);
      const content = serializeDocComments(e.docName, next, base.preface);
      try {
        const saved = await saveFileContent(e.sidecar, content, { host: e.host, expectedHash: base.hash, writer: 'user' });
        e.writes += 1;
        e.disk = { ...diskOf(content, saved.contentHash, false, e.sidecar), preface: base.preface };
        e.edits = e.edits.slice(batch.length);
        e.attempt = 0;
        e.saveError = null;
        notify(e);
        base = e.disk;
      } catch (err) {
        if (!(err instanceof FileSaveConflictError) || replay >= MAX_REPLAYS) throw err;
        replay += 1;
        log.info('doc-comments', 'comments file changed under the write, replaying', { path: e.sidecar, host: e.host, replay });
        base = await read(e, true);
      }
    }
  } catch (err) {
    e.attempt += 1;
    e.saveError = err instanceof Error ? err.message : String(err);
    const giveUp = !e.listeners.size && e.attempt >= MAX_UNWATCHED_ATTEMPTS;
    const wait = RETRY_MS[Math.min(e.attempt - 1, RETRY_MS.length - 1)]!;
    log.warn('doc-comments', giveUp ? 'comments save failed, giving up (nobody is looking)' : 'comments save failed, retrying', {
      path: e.sidecar, host: e.host, error: e.saveError, attempt: e.attempt, pendingEdits: e.edits.length, ...(giveUp ? {} : { retryInMs: wait }),
    });
    notify(e);
    if (!giveUp) e.retryTimer = setTimeout(() => { void flush(e); }, wait);
  } finally {
    e.writing = false;
  }
}

export function editDocComments(e: Entry, edit: DocCommentEdit, label: string): void {
  log.info('doc-comments', 'comment edit', { path: e.sidecar, host: e.host, label });
  e.edits = [...e.edits, edit];
  notify(e);
  void flush(e);
}

/** Read the file again (a write in flight reads for itself). */
export function refreshDocComments(e: Entry): void {
  if (e.writing) return;
  void read(e).then(() => { if (e.edits.length) void flush(e); });
}

export function docCommentsSnapshot(e: Entry): DocCommentsSnapshot {
  return e.snapshot;
}

/** Tests only. */
export function resetDocCommentsStore(): void {
  for (const e of entries.values()) clearTimeout(e.retryTimer);
  entries.clear();
}
