/**
 * One browser, one document.
 *
 * The same file can be open in several views of one page at the same time: two
 * session Files panes, a Files pane plus the "@" mention preview, the /notes
 * editor plus the Files pane rooted at the vault. Each of those views holds its
 * OWN copy of the bytes and has its OWN write path, so a save in one used to be
 * invisible in the others until they happened to re-read — or, worse, until the
 * other one's next save 409'd against the user's own change.
 *
 * This module is the browser-local answer: whoever writes a document announces
 * it HERE, synchronously, and every other mounted view of that same document
 * hears it in the same tick. It carries the new bytes and the new lock token, so
 * a clean sibling can adopt them without a request at all — and it does not
 * depend on the server's WebSocket event, which may be seconds behind (or, for
 * `PUT /api/file-content`, may not exist for the path at all).
 *
 * It deliberately is NOT a shared content store. Each view keeps owning its
 * buffer, its dirty state and its optimistic lock; this only tells it that the
 * document underneath moved, and who moved it.
 *
 * Two more things live here because they answer the same question ("did THIS
 * browser write these bytes?") for every surface at once:
 *  - `wasSavedHere` — the hash registry. Both notes hooks used to keep a private
 *    "hashes my own saves produced" set purely to stop the server's own echo
 *    from being read as someone else's write. One registry means a save made on
 *    ANY surface is recognized by ALL of them.
 *  - `isDocSaveInFlight` — a save is mid-air. The server emits its bus event
 *    BEFORE the PUT response is sent, so the echo of our own write always races
 *    ahead of the hash that would identify it. A view that sees an event while a
 *    save (anyone's, in this browser) is in flight parks the decision until the
 *    save settles.
 */
import { log } from '@/utils/log';

/** Opaque identity of a document. Build one with `fileDocKey` / `noteDocKey` / `memoryDocKey`. */
export type DocKey = string;

/** A file addressed by absolute path on a host (`undefined` host = this machine). */
export function fileDocKey(host: string | undefined, path: string): DocKey {
  return `file\u0000${host ?? 'local'}\u0000${path}`;
}

/**
 * A vault note addressed by its vault-relative path. The `.md` suffix is
 * dropped so this matches the canonical `notes/{vault-path-without-.md}` name
 * the server's `notes:updated` event uses — one name per note, whichever
 * surface saved it.
 */
export function noteDocKey(vaultPath: string): DocKey {
  return `note\u0000${vaultPath.replace(/^\/+/, '').replace(/\.md$/, '')}`;
}

/**
 * A memory document addressed by its memory-dir-relative path — the same name the
 * server's `memory:updated` event carries, whichever route wrote it (the /memory
 * editor's own PUT, or `PUT /api/file-content` on a path under the memory dir).
 * The `.md` stays: on that page the relative path IS the key the UI selects by.
 */
export function memoryDocKey(memoryPath: string): DocKey {
  return `memory\u0000${memoryPath.replace(/^\/+/, '')}`;
}

export interface DocSavedSignal {
  key: DocKey;
  /** Lock token of the bytes now on disk. */
  contentHash: string;
  /** The bytes themselves, when the writer had them (it always does today). */
  content?: string;
  /** Byte size the server reported, for the receiving view's own bookkeeping. */
  size?: number;
  /**
   * Who wrote it. A view passes its own mount id so it can ignore the echo of
   * its own save — never compare on hash alone for that: two views can hold
   * byte-identical buffers, and then the writer would ignore itself and the
   * sibling would too.
   */
  origin: string;
}

type Listener = (signal: DocSavedSignal) => void;

const listeners = new Map<DocKey, Set<Listener>>();

/** Hashes THIS browser produced, newest last, per document. */
const savedHashes = new Map<DocKey, string[]>();
/** In-flight save count per document (a view can only have one, but two can). */
const inFlight = new Map<DocKey, number>();

/** Per document. Enough to cover a burst of live-edit writes plus their echoes. */
const MAX_HASHES_PER_DOC = 8;
/** Documents remembered at all. Bounds a long session that opened many files. */
const MAX_DOCS = 64;

function trimDocs(): void {
  while (savedHashes.size > MAX_DOCS) {
    const oldest = savedHashes.keys().next();
    if (oldest.done) return;
    savedHashes.delete(oldest.value);
  }
}

/** Record that a save WE made produced `contentHash` for this document. */
export function rememberDocSave(key: DocKey, contentHash: string): void {
  const list = savedHashes.get(key) ?? [];
  if (!list.includes(contentHash)) list.push(contentHash);
  while (list.length > MAX_HASHES_PER_DOC) list.shift();
  // Re-set so the key moves to the end of the insertion order (LRU for trimDocs).
  savedHashes.delete(key);
  savedHashes.set(key, list);
  trimDocs();
}

/**
 * Did a save made in THIS browser produce these bytes? True ⇒ a server event
 * carrying this hash is an echo, and whatever it would have told us has already
 * been delivered locally by `publishDocSaved`.
 */
export function wasSavedHere(key: DocKey, contentHash: string): boolean {
  return savedHashes.get(key)?.includes(contentHash) ?? false;
}

/** Call around a save so other views can tell "mid-air" from "landed". */
export function beginDocSave(key: DocKey): void {
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
}

export function endDocSave(key: DocKey): void {
  const n = (inFlight.get(key) ?? 0) - 1;
  if (n > 0) inFlight.set(key, n);
  else inFlight.delete(key);
}

export function isDocSaveInFlight(key: DocKey): boolean {
  return (inFlight.get(key) ?? 0) > 0;
}

/**
 * Announce a save. Registers the hash first (so a server echo arriving in the
 * same tick is already recognizable) and then fans out to every other mounted
 * view of the document.
 */
export function publishDocSaved(signal: DocSavedSignal): void {
  rememberDocSave(signal.key, signal.contentHash);
  const subs = listeners.get(signal.key);
  if (!subs || subs.size === 0) return;
  for (const fn of [...subs]) {
    try {
      fn(signal);
    } catch (err) {
      // One view throwing must not stop the others from converging.
      log.warn('file-save-signal', 'a doc-saved listener threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Listen for saves to ONE document. Returns the unsubscribe. */
export function subscribeDocSaved(key: DocKey, fn: Listener): () => void {
  let subs = listeners.get(key);
  if (!subs) { subs = new Set(); listeners.set(key, subs); }
  subs.add(fn);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) listeners.delete(key);
  };
}

/** Test seam — module state, so a test must be able to start from empty. */
export function resetDocSaveSignals(): void {
  listeners.clear();
  savedHashes.clear();
  inFlight.clear();
}
