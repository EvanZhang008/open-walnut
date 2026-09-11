/**
 * useLiveEdit — the Files panel's LIVE EDIT state machine.
 *
 * Live mode turns the explicit Save into an automatic one: 600 ms after the last
 * keystroke the buffer is written to disk. It does NOT relax the optimistic lock:
 * every auto-write still sends `expectedHash`, hashed from the very bytes it is
 * replacing (see PendingWrite.baseText), because the whole reason the lock exists
 * is that an agent may be writing the same file in the same second.
 * What live mode adds is an ANSWER to that collision instead of a banner: on 409
 * it re-reads disk and three-way-merges (base = the bytes our lock refers to,
 * ours = the buffer, theirs = disk). A clean merge is applied to the live editor
 * and written; a conflicting one hands the situation back to the explicit-Save
 * path and pauses live mode for that one file.
 *
 * Everything the hook touches per keystroke arrives as a REF, never as a render
 * value: a write, a re-read and a merge can all land after the panel has moved on
 * to another file, and a stale closure there does not fail loudly — it writes one
 * file's bytes under another file's path.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { saveFileContent, fetchFileContent, fetchFileContentConditional, FileSaveConflictError } from '@/api/files';
import { READ_ONLY_TOOLS } from '@/utils/embedded-image-freshness';
import { deleteFileDraft } from '@/utils/file-drafts';
import { threeWayMerge, type MergeResult } from '@/utils/three-way-merge';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { computeContentHashClient } from '@/utils/content-hash';

/** Global on/off preference ('1'/'0'); absent = off. */
export const LIVE_EDIT_PREF_KEY = 'open-walnut-live-edit';
/** Keystroke → disk settle window. Long enough that a typing burst is one write,
 *  short enough that "it saved itself" is believable. */
export const LIVE_WRITE_DEBOUNCE_MS = 600;
/** A write that finds the file busy re-checks this soon (not the full debounce —
 *  the user already waited it out once). */
const BUSY_RECHECK_MS = 150;
/** Pull + merge + write cycles allowed for ONE conflict before giving up. */
export const MAX_MERGE_ATTEMPTS = 3;
/** Toolbar receipt lifetime. */
export const LIVE_RECEIPT_MS = 4000;
const FILE_TARGET_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const FILE_CHECK_INTERVAL_MS = 30_000;
const FILE_CHECK_SETTLE_MS = 300;

export function agentToolMayChangeFile(path: string, tool?: string, input?: Record<string, unknown>): boolean {
  if (tool && READ_ONLY_TOOLS.has(tool)) return false;
  const target = input?.file_path ?? input?.notebook_path;
  if (tool && FILE_TARGET_TOOLS.has(tool) && typeof target === 'string'
    && target.startsWith('/') && !target.split('/').includes('..')) {
    return agentPathMatches(path, target);
  }
  return true;
}
/** How long after a tool call the session still counts as mid-turn, for the
 *  RECEIPT WORDING only ("from the agent" vs "from disk"). */
export const AGENT_ACTIVE_WINDOW_MS = 30_000;

// ── Per-file suspension ──────────────────────────────────────────────────────
// A conflict live mode could not merge pauses live writes for THAT FILE ONLY —
// never the global preference, which the user set deliberately and which still
// applies to every other file. In-memory on purpose: the pause is about the
// current collision, not a lasting property of the file.
const suspendedFiles = new Map<string, 'conflict'>();

export function liveSuspensionKey(host: string | undefined, path: string): string {
  return `${host ?? 'local'} ${path}`;
}
export function isLiveSuspended(host: string | undefined, path: string): boolean {
  return suspendedFiles.has(liveSuspensionKey(host, path));
}
export function suspendLiveEdit(host: string | undefined, path: string): void {
  suspendedFiles.set(liveSuspensionKey(host, path), 'conflict');
}
export function resumeLiveEdit(host: string | undefined, path: string): void {
  suspendedFiles.delete(liveSuspensionKey(host, path));
}
/** Test seam — the maps are module state, so a test must be able to reset them. */
export function clearLiveSuspensions(): void {
  suspendedFiles.clear();
  deletedPaths.clear();
  lastWritten.clear();
}

// ── Paths the tree just deleted ───────────────────────────────────────────────
// The server's PUT creates a missing file (that is how "new file" works), so a
// live write armed for a file the user then deleted from the tree — or flushed on
// unmount after the delete — would quietly RESURRECT it. Same shape as the draft
// store's path rules: remember the delete for a while and refuse writes under it.
const DELETED_TTL_MS = 60_000;
const deletedPaths = new Map<string, number>();

/** Called by the tree after a delete: no live write may land under `path` for a minute. */
export function noteFileDeleted(host: string | undefined, path: string): void {
  deletedPaths.set(liveSuspensionKey(host, path), Date.now() + DELETED_TTL_MS);
}
export function isRecentlyDeleted(host: string | undefined, path: string): boolean {
  const now = Date.now();
  for (const [key, until] of deletedPaths) {
    if (until <= now) { deletedPaths.delete(key); continue; }
    const sep = key.indexOf(' ');
    if (key.slice(0, sep) !== (host ?? 'local')) continue;
    const deleted = key.slice(sep + 1);
    if (path === deleted || path.startsWith(deleted.endsWith('/') ? deleted : deleted + '/')) return true;
  }
  return false;
}

// ── What OUR last write put on disk, per file ─────────────────────────────────
// A write for a file the panel has already LEFT (unmount / file-switch flush)
// cannot read the parent's refs — those belong to the incoming file now — so its
// record carries the base captured at keystroke time. If another of our writes
// landed AFTER that keystroke, that base is no longer what is on disk and the
// flush would 409 against our own bytes and be dropped.
//
// So this remembers the TEXT we last wrote, not just its hash. Storing the hash
// was enough while the token was quoted; now the token is derived from bytes, and
// a rebase has to supply the BYTES it claims are on disk. That is the point: the
// correction is still provable, and a wrong one refuses itself.
const LAST_WRITTEN_MAX = 8;
const lastWritten = new Map<string, { hash: string; text: string; at: number }>();

// `text` is REQUIRED, and deliberately not optional-with-a-default: an empty
// string has to mean "we wrote an empty file" and nothing else. While it doubled
// as "no text recorded", a write that emptied a file could not move the base, so
// the next flush 409'd against our own bytes and was dropped.
export function noteWritten(host: string | undefined, path: string, hash: string, text: string): void {
  const key = liveSuspensionKey(host, path);
  // Map iteration is insertion-ordered, so deleting the first key evicts the
  // oldest. Re-inserting an existing key keeps its original position, which is
  // fine: what matters is bounding a store that holds whole file texts.
  if (!lastWritten.has(key) && lastWritten.size >= LAST_WRITTEN_MAX) {
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  lastWritten.set(key, { hash, text, at: Date.now() });
}

/**
 * The bytes a record captured at `capturedAt` should treat as its base: the text
 * OUR own newer write put on disk, if there was one, else the base it captured.
 *
 * Only ever moves the base FORWARD to bytes we actually wrote ourselves, and only
 * for a record armed before that write. Anything else keeps the captured base and
 * takes its 409.
 */
export function freshestBase(
  host: string | undefined, path: string, captured: string | null, capturedAt: number,
): string | null {
  const w = lastWritten.get(liveSuspensionKey(host, path));
  return w && w.at > capturedAt ? w.text : captured;
}

export function loadLiveEditPref(): boolean {
  try {
    return localStorage.getItem(LIVE_EDIT_PREF_KEY) === '1';
  } catch {
    return false; // storage blocked (private mode) — off is the safe default
  }
}
function saveLiveEditPref(on: boolean): void {
  try {
    localStorage.setItem(LIVE_EDIT_PREF_KEY, on ? '1' : '0');
  } catch { /* storage blocked — the toggle still works for this page */ }
}

/**
 * Who the bytes we just pulled came from. Receipt WORDING only — the merge and
 * the lock bookkeeping are identical either way.
 */
export type PullReason = 'agent' | 'other-view' | 'disk';

export type ConflictDecision =
  | { action: 'write-merged'; merged: string }
  | { action: 'give-up' };

/**
 * What to do about a 409. `attempt` counts the pull/merge/write cycles ALREADY
 * performed for this collision, so the first 409 arrives as 0 and at most
 * MAX_MERGE_ATTEMPTS cycles ever run. The bound matters: without it a file two
 * writers are both hammering turns into an endless cycle, and every cycle costs
 * a read AND a write.
 */
export function decideAfterConflict(merge: MergeResult, attempt: number): ConflictDecision {
  if (!merge.ok) return { action: 'give-up' };
  if (attempt >= MAX_MERGE_ATTEMPTS) return { action: 'give-up' };
  return { action: 'write-merged', merged: merge.merged };
}

/**
 * What an armed auto-write may actually send, once the buffer it was captured
 * from may no longer be the buffer on screen.
 *
 * The rule, and the reason it is a named function rather than an `if` inside the
 * write: an optimistic lock only protects the file while the token and the bytes
 * describe the SAME state. `armedText` was captured at `armedGen`; the lock token
 * the write is about to send belongs to `currentGen`. When those differ, sending
 * the pair is a write the server cannot refuse — it re-reads and re-hashes the
 * real file, sees the token match, and accepts bytes from before whatever replaced
 * the buffer. That is the 2026-09-05 incident: a stale copy of a remote design doc
 * landed on top of a newer file four times, each write about a second after the
 * pane had read the newer bytes and moved the lock to them.
 *
 * So when the generations diverge the armed text is abandoned and the BUFFER is
 * used instead: it is what the user is looking at, and it is what the current lock
 * describes. `null`/unchanged buffer means there is nothing to save at all.
 *
 * ⚠️ A generation match is NOT a proof, and 2026-09-08 showed why: the pane bumps
 * its generation when it installs a lock, but the editor is reseeded by a REMOUNT,
 * which happens a render later. In that window the generation and the lock describe
 * the freshly read bytes while the editor still holds the previous ones (that day,
 * a three-day-old copy out of the IndexedDB content cache), so `armedGen ===
 * currentGen` was true for text that was stale by 11 KB. This function narrows the
 * window; only `baseText`, hashed, closes it. Both are kept: the plan avoids
 * pointless 409s, the hash makes a wrong one impossible.
 */
export type LiveWritePlan =
  | { action: 'write'; text: string; baseText: string | null }
  | { action: 'skip'; reason: 'buffer-gone' | 'nothing-to-write' }

export function planLiveWrite(input: {
  armedText: string;
  armedGen: number;
  currentGen: number;
  /** The bytes `armedText` was edited from, captured with it. */
  armedBaseText?: string | null;
  /** The editor's text right now; null = no editor (unmounted, non-editable). */
  bufferText: string | null;
  /** The bytes the current lock refers to. */
  baseContent: string | null;
}): LiveWritePlan {
  if (input.armedGen === input.currentGen) {
    return { action: 'write', text: input.armedText, baseText: input.armedBaseText ?? null };
  }
  if (input.bufferText == null) return { action: 'skip', reason: 'buffer-gone' };
  // The buffer already IS the bytes we believe are on disk: writing it back would
  // be a no-op that only re-stamps mtime, and on a remote host a tunnel round trip.
  if (input.bufferText === input.baseContent) return { action: 'skip', reason: 'nothing-to-write' };
  // Writing the CURRENT buffer, so the base is what the CURRENT lock refers to.
  return { action: 'write', text: input.bufferText, baseText: input.baseContent };
}

/** `//a//b/./c` → `/a/b/c`. Not a `..` resolver: a path with `..` in it is left
 *  alone, so it simply fails to match rather than matching the wrong file. */
function normalizePath(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/|$)/g, '');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/**
 * Does a path an agent's tool call named refer to the file we have open?
 *
 * The open file's path is always absolute (it came from the file tree). The
 * agent's may be absolute, or `~`-relative when it is working on a remote host —
 * and we do not know that host's home directory, so a `~/x/y` reference is
 * matched by its SUFFIX. A false positive here costs one wasted re-read; a false
 * negative means the pull silently never happens.
 */
export function agentPathMatches(openPath: string, agentPath: string): boolean {
  if (!openPath || !agentPath) return false;
  if (!openPath.startsWith('/')) return false; // nothing reliable to compare against
  const open = normalizePath(openPath);
  const other = normalizePath(agentPath);
  if (open === other) return true;
  if (other.startsWith('~/')) return open.endsWith(other.slice(1));
  return false;
}

/** Identity + text captured together, exactly like the draft writer's pending
 *  record: this is written after the component may already have re-rendered for
 *  the NEXT file, when the editor ref no longer holds these bytes. */
interface PendingWrite {
  path: string;
  host: string | undefined;
  text: string;
  /** When the record was armed — see freshestBase. */
  capturedAt: number;
  /**
   * The buffer generation this text came from. The pane bumps its generation
   * whenever it installs a different buffer (a read applying disk bytes, a merge,
   * an adopted write, a restored draft), so a record whose generation is behind
   * describes text that is NO LONGER what the user is looking at, and must never
   * be written under the lock the newer buffer established. See writeOnce.
   */
  bufferGen: number;
  /**
   * The bytes `text` was edited FROM: what the pane believed was on disk at the
   * instant the text was captured. The write's optimistic-lock token is the HASH OF
   * THIS STRING, computed here rather than quoted from a ref.
   *
   * This is the fix for the whole bug class. A token read out of a mutable ref at
   * SEND time can describe different bytes than the text being sent, and the server
   * then has no way to refuse it: that is how a stale copy replaced a newer file
   * four times on 2026-09-05, and a fifth time on 2026-09-08 through a different
   * drift the generation counter could not see (the pane's generation advanced with
   * the lock while the editor still held bytes from its IndexedDB cache, so armed
   * and current generations matched while the text was three days old). A token
   * DERIVED FROM the base bytes cannot drift: stale bytes hash to a stale token and
   * the server refuses.
   *
   * `null` = the pane cannot say what these bytes were based on, so there is
   * nothing to prove and an automatic write must not go out at all.
   */
  baseText: string | null;
}

export interface UseLiveEditOptions {
  path: string;
  host?: string;
  /** Mount id of the owning view — rides every write so the browser-local
   *  doc-saved signal can tell our own save from a sibling view's. */
  origin?: string;
  /** Session whose agent's writes to this file should be pulled in (item 6).
   *  Absent (pop-out, mention preview) → only the 409 path detects other writers. */
  sessionId?: string;
  /** The viewer's own editability gate. Live mode never writes a truncated,
   *  binary or errored read — there are no complete bytes to write back. */
  canEdit: boolean;
  isVisible: () => boolean;
  /** Current editor buffer. */
  getText: () => string | null;
  /** Put text in the live editor WITHOUT a remount, and without arming a write
   *  (a programmatic apply must not look like typing, or the pull below would
   *  immediately write back what it just read). `base` = the disk bytes that text
   *  is a modification of; omitted means the text IS the disk bytes. */
  applyText: (text: string, base?: string) => void;
  /** The bytes the EDITOR reports its current text is a modification of. This, not
   *  a ref the pane keeps, is what an automatic write's token is derived from —
   *  see PendingWrite.baseText. */
  getBaseText: () => string | null;
  /** The optimistic-lock token. The hook advances it on every write and read.
   *
   *  INVARIANT (2026-09-05 data-loss incident): this token describes the bytes
   *  the EDITOR BUFFER was derived from, so it may only ever move together with
   *  the buffer. It is not "the newest hash we have seen" — pairing a fresh token
   *  with older text is a lock the server cannot refuse, which is how a stale
   *  copy got written over a newer file four times. `bufferGenRef` is what makes
   *  a violation detectable rather than silent. */
  lockHashRef: MutableRefObject<string | undefined>;
  /** Bumped by the pane every time it installs a DIFFERENT buffer (see
   *  PendingWrite.bufferGen). Reads it, never writes it. */
  bufferGenRef: MutableRefObject<number>;
  /** The bytes the buffer is based on: the last read, or the last successful
   *  write. `null` = unknown (a restored stale draft), which makes a merge
   *  impossible and sends any conflict straight to the explicit-Save path. */
  baseContentRef: MutableRefObject<string | null>;
  isDirtyRef: MutableRefObject<boolean>;
  /** Our bytes reached disk: the parent's post-save bookkeeping. */
  onWrote: (text: string, res: { size: number; contentHash: string }) => void;
  /** Someone else's bytes are now in the editor and the buffer is clean. */
  onAdopted: (content: string, contentHash: string, size: number) => void;
  /** New disk bytes were read while the buffer stays dirty. */
  onDiskContent: (content: string, contentHash: string, size: number) => void;
  /** Hand the collision to the explicit-Save UI. The hook never passes
   *  `overwriteHash`: that PRE-ARMS the next Save as a deliberate overwrite
   *  (skipping the warn-once gate), which only a Save the user pressed may do.
   *  Kept in the signature because the parent's explicit-save path uses it. */
  onConflict: (message: string, overwriteHash?: string) => void;
  onError: (message: string) => void;
}

export interface LiveEdit {
  /** Armed for this file: preference on, not suspended, file editable. */
  on: boolean;
  /** This file was paused by a conflict (the toggle title explains it). */
  suspended: boolean;
  /** An auto-write (or its merge cycle) is in flight. */
  writing: boolean;
  /** Transient toolbar note, or null. */
  receipt: string | null;
  toggle: () => void;
  /** Call from the editor's per-keystroke change callback. */
  noteUserEdit: () => void;
  /**
   * Re-read disk NOW and fold the result in (adopt when the buffer is clean,
   * three-way-merge when it is dirty, hand an overlap to the explicit-Save
   * conflict UI). The hook calls this itself when the session's agent writes the
   * file; the owning view calls it when it learns some OTHER writer did — a
   * sibling view of the same path, or the server's own notes/memory event.
   * `reason` only chooses the receipt wording.
   */
  pullNow: (reason?: PullReason) => void;
  /** Write the pending buffer now (editor blur). */
  flushNow: () => void;
  /** Drop the pending auto-write — an explicit Save IS the flush. */
  cancelPending: () => void;
}

export function useLiveEdit(opts: UseLiveEditOptions): LiveEdit {
  const { path, host, sessionId, canEdit } = opts;

  // ONE latest-options ref. Every async continuation below reads through it, so
  // none of them can be holding a previous render's path/callbacks.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const pathRef = useRef(path);
  pathRef.current = path;
  const hostRef = useRef(host);
  hostRef.current = host;

  // Is this hook still alive? `isCurrent` compares a record against pathRef, and on
  // UNMOUNT that ref keeps pointing at the file this instance was showing — so
  // without this flag `isCurrent` answers TRUE forever for a dead instance, and the
  // final flush then treats itself as "live": it asks a torn-down editor for its
  // buffer, gets null, and drops the user's last keystrokes as `buffer-gone`
  // (measured 2026-09-08: switching files during an in-flight write lost the burst).
  // Declared HERE, above the flush effect, because React runs an unmounting
  // component's cleanups in the order the effects were declared and the flush has to
  // see `false`.
  //
  // The body RE-ARMS the flag, which is not decoration: StrictMode mounts, runs the
  // cleanup, and mounts again, so a cleanup-only version leaves every instance
  // permanently "unmounted" in dev. That is not a dev-only cosmetic either — it
  // makes `isCurrent` always false, so a live write skips all of the pane's
  // post-save bookkeeping (dirty dot, receipt, draft delete) while still writing the
  // file. Caught by reading the `live: false` field on a write that clearly was live.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [prefOn, setPrefOn] = useState(loadLiveEditPref);
  const prefOnRef = useRef(prefOn);
  prefOnRef.current = prefOn;
  const [suspended, setSuspended] = useState(() => isLiveSuspended(host, path));
  const [writing, setWriting] = useState(false);
  // Nonce so the same wording twice in a row still restarts the 4s timer.
  const [receipt, setReceipt] = useState<{ text: string; n: number } | null>(null);
  const receiptNRef = useRef(0);

  const on = prefOn && !suspended && canEdit;
  const onRef = useRef(on);
  onRef.current = on;

  const pendingRef = useRef<PendingWrite | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  /** Resolves when the write in flight settles; null when nothing is writing. Only
   *  the final flush uses it (see flush) — everything else re-checks on a timer. */
  const inFlightDoneRef = useRef<Promise<void> | null>(null);
  // Last tool call seen for this session (any tool) — receipt wording only.
  const agentSeenAtRef = useRef(0);
  // Write tool calls aimed at THIS file, awaiting their result.
  const agentWriteIdsRef = useRef(new Set<string>());
  const pullInFlightRef = useRef(false);
  const pullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullPendingRef = useRef<PullReason | null>(null);
  const pullRef = useRef<(reason: PullReason) => Promise<void>>(async () => {});
  const schedulePull = useCallback((reason: PullReason, ms = FILE_CHECK_SETTLE_MS) => {
    if (!mountedRef.current) return;
    pullPendingRef.current = reason;
    if (pullTimerRef.current) return;
    pullTimerRef.current = setTimeout(() => {
      pullTimerRef.current = null;
      const pending = pullPendingRef.current;
      pullPendingRef.current = null;
      if (pending) void pullRef.current(pending);
    }, ms);
  }, []);

  // Suspension is keyed per file, so switching files re-reads it. The watched
  // tool ids go too: a result that arrives after the switch would otherwise pull
  // the NEW file because of a write aimed at the old one.
  useEffect(() => {
    setSuspended(isLiveSuspended(host, path));
    agentWriteIdsRef.current.clear();
    return () => {
      if (pullTimerRef.current) clearTimeout(pullTimerRef.current);
      pullTimerRef.current = null;
      pullPendingRef.current = null;
    };
  }, [host, path, sessionId]);

  useEffect(() => {
    if (!receipt) return;
    const t = setTimeout(() => setReceipt(null), LIVE_RECEIPT_MS);
    return () => clearTimeout(t);
  }, [receipt]);

  const showReceipt = useCallback((text: string) => {
    receiptNRef.current += 1;
    setReceipt({ text, n: receiptNRef.current });
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  /** Is this record still about the file on screen? Everything that touches
   *  parent state is gated on it — a late continuation for the outgoing file
   *  must not write into the incoming file's state. */
  const isCurrent = useCallback(
    (rec: { path: string; host: string | undefined }) =>
      mountedRef.current && rec.path === pathRef.current && rec.host === hostRef.current,
    [],
  );

  const agentActive = useCallback(
    () => Date.now() - agentSeenAtRef.current < AGENT_ACTIVE_WINDOW_MS,
    [],
  );

  const suspendHere = useCallback((rec: PendingWrite) => {
    suspendLiveEdit(rec.host, rec.path);
    clearTimer();
    pendingRef.current = null;
    if (isCurrent(rec)) setSuspended(true);
  }, [clearTimer, isCurrent]);

  // Declared as refs because write → conflict → merge → write is mutually
  // recursive, and a useCallback cannot reference its own later sibling.
  const writeOnceRef = useRef<
    ((rec: PendingWrite, writer: 'live' | 'merge', attempt: number, allowMerge: boolean) => Promise<void>) | null
  >(null);
  const scheduleRef = useRef<((ms: number) => void) | null>(null);

  const flush = useCallback(async (allowMerge: boolean) => {
    clearTimer();
    const rec = pendingRef.current;
    if (!rec) return;
    // Toggled off (or suspended) during the debounce — the user's last word wins.
    // Only for the file on screen: `on` now describes the INCOMING file, and a
    // record for the outgoing one was armed while live was on for it. Dropping it
    // because the next file happens to be an image would lose the last burst.
    if (isCurrent(rec) && !onRef.current) { pendingRef.current = null; return; }
    if (inFlightRef.current) {
      // Re-check shortly rather than queueing a second write against the same
      // base, which would 409 by construction.
      if (allowMerge) { scheduleRef.current?.(BUSY_RECHECK_MS); return; }
      // Unmount / file switch: there is no timer left to fire and no editor to
      // re-read, so this is the record's last chance. It used to be dropped here
      // ("the draft store still holds the text"), which is true but means the last
      // characters someone typed before clicking another file are silently not on
      // disk — they only reappear as a stale-draft banner the next time that file
      // is opened. Wait for the write in flight instead: `freshestBase` then rebases
      // this record onto the bytes THAT write left behind, which is exactly what it
      // exists for. Bounded by construction — one await, and if something is still
      // writing afterwards we give up rather than loop.
      pendingRef.current = null;
      const settled = inFlightDoneRef.current;
      if (!settled) return;
      await settled;
      if (inFlightRef.current) {
        log.info('file-editor', 'final flush dropped: still writing after the previous write settled', {
          path: rec.path, host: rec.host,
        });
        return;
      }
      await writeOnceRef.current?.(rec, 'live', 0, false);
      return;
    }
    // Nothing new to write: the buffer is exactly the bytes we last read or
    // wrote. This is what keeps a programmatic apply (merge / agent pull) from
    // bouncing straight back to disk.
    if (isCurrent(rec) && optsRef.current.baseContentRef.current === rec.text) {
      pendingRef.current = null;
      return;
    }
    pendingRef.current = null;
    // 0 = no merge cycle has run for this write yet.
    await writeOnceRef.current?.(rec, 'live', 0, allowMerge);
  }, [clearTimer, isCurrent]);

  const schedule = useCallback((ms: number) => {
    clearTimer();
    timerRef.current = setTimeout(() => { timerRef.current = null; void flush(true); }, ms);
  }, [clearTimer, flush]);
  scheduleRef.current = schedule;

  /**
   * 409 → pull disk, merge, apply, write the merge. Bounded by
   * MAX_MERGE_ATTEMPTS; anything it can't resolve becomes the explicit-Save
   * conflict UI with live mode paused for this file.
   */
  const resolveConflict = useCallback(async (rec: PendingWrite, _currentHash: string, attempt: number) => {
    const o = optsRef.current;
    // Deliberately NO overwrite hash handed to the parent: the write that 409'd
    // was the MACHINE's, not a Save the user pressed. Pre-arming the next Save as
    // an overwrite would let one click replace the other writer's version with
    // no warning — the explicit-save path asks twice on purpose, and live mode
    // must not spend that first ask on the user's behalf.
    const giveUp = () => {
      suspendHere(rec);
      if (!isCurrent(rec)) return;
      const who = agentActive()
        ? 'The agent in this session changed this file'
        : 'This file changed on disk';
      o.onConflict(
        `${who} since you opened it, and the changes overlap yours — Live edit is paused for this file. `
        + 'Your version is still in the editor: Save will warn you before it replaces the other one, '
        + 'or Discard and reopen the file to get it.',
      );
      log.warn('file-editor', 'live edit gave up on a conflict', { path: rec.path, host: rec.host, attempt });
    };

    // THE EDITOR's base, not the pane's.
    //
    // `ours` below comes from the editor, so the base it is diffed against must
    // come from the same place or the merge is comparing two different states.
    // This is the one path left where the two could be mixed, and mixing them is
    // not a small error: threeWayMerge returns `ours` VERBATIM when theirs ===
    // base, and the result is then written under a token taken from the disk bytes
    // we just read, which matches by construction. A stale buffer would be
    // laundered into a write the server cannot refuse — the incident, one layer
    // deeper. Reading the editor's base instead makes the same interleaving
    // harmless: base and ours are both stale, theirs is fresh, so the merge
    // produces the FRESH text and there is nothing to lose.
    const base = o.getBaseText();
    // No known base ⇒ our lock refers to bytes we never held (a restored stale
    // draft). A merge would be a guess, and a guessed merge is data loss.
    if (base == null || attempt >= MAX_MERGE_ATTEMPTS) { giveUp(); return; }

    let disk;
    try {
      disk = await fetchFileContent(rec.path, rec.host, { noCache: true, track: 'agent' });
    } catch {
      giveUp();
      return;
    }
    if (!isCurrent(rec)) return;
    if (disk.content == null || disk.contentHash == null) { giveUp(); return; }

    // The base moved while we were reading: an agent pull landed in between and
    // already folded disk into the editor (and advanced the lock). Merging
    // against the base we captured would apply that pull's hunks a second time.
    // Nothing is lost — the buffer is the merged text — so just write it again
    // under the lock the pull established.
    if (o.getBaseText() !== base) {
      const text = o.getText() ?? rec.text;
      log.info('file-editor', 'live edit base moved mid-conflict; rewriting the merged buffer', {
        path: rec.path, host: rec.host, attempt,
      });
      await writeOnceRef.current?.(
        {
          ...rec, text, capturedAt: Date.now(), bufferGen: o.bufferGenRef.current,
          // The pull that moved the base is what this text now sits on top of.
          baseText: o.getBaseText(),
        },
        'merge', attempt + 1, true,
      );
      return;
    }

    const ours = o.getText() ?? rec.text;
    const decision = decideAfterConflict(threeWayMerge(base, ours, disk.content), attempt);
    // The disk bytes are real information either way — the pane's notion of
    // "what is on disk" should not stay wrong just because we can't fold it in.
    o.onDiskContent(disk.content, disk.contentHash, disk.size);
    if (decision.action === 'give-up') { giveUp(); return; }

    // The user has now SEEN their bytes, so the lock may advance. base stays the
    // bytes the lock refers to (disk), NOT the merged text: if this write 409s
    // too, the next merge has to see the user's edits as our side again.
    o.lockHashRef.current = disk.contentHash;
    o.applyText(decision.merged, disk.content);
    o.baseContentRef.current = disk.content;
    showReceipt(agentActive() ? 'Merged agent changes' : 'Merged disk changes');
    log.info('file-editor', 'live edit merged a conflict', { path: rec.path, host: rec.host, attempt });
    await writeOnceRef.current?.(
      {
        ...rec, text: decision.merged, capturedAt: Date.now(), bufferGen: o.bufferGenRef.current,
        // Merged ON TOP OF the disk bytes just read, so those are the base.
        baseText: disk.content,
      },
      'merge',
      attempt + 1,
      true,
    );
  }, [agentActive, isCurrent, showReceipt, suspendHere]);

  const writeOnce = useCallback(async (
    rec: PendingWrite,
    writer: 'live' | 'merge',
    attempt: number,
    allowMerge: boolean,
  ) => {
    const live = isCurrent(rec);
    // The tree deleted this file (or its folder) after the record was armed. The
    // server's PUT would create it again, and a file that comes back a second
    // after you deleted it is the worst kind of surprise. The draft store keeps
    // the text; nothing is lost, just not written.
    if (isRecentlyDeleted(rec.host, rec.path)) {
      log.info('file-editor', 'live write skipped: path was just deleted', { path: rec.path, host: rec.host });
      return;
    }
    if (live) setWriting(true);
    inFlightRef.current = true;
    let settle: () => void = () => {};
    inFlightDoneRef.current = new Promise<void>((resolve) => { settle = resolve; });
    try {
      // Which text goes out, and which bytes it is based on. For the file on
      // screen the plan may abandon the armed text for the current buffer; for a
      // file we have LEFT there is no buffer to consult, so the record stands.
      let text = rec.text;
      // A file we have LEFT may have been written by US since this record was
      // armed; then the base on disk is that write's text, not the captured one.
      let baseText = live
        ? rec.baseText
        : freshestBase(rec.host, rec.path, rec.baseText, rec.capturedAt);
      if (live) {
        const currentGen = optsRef.current.bufferGenRef.current;
        const plan = planLiveWrite({
          armedText: rec.text,
          armedGen: rec.bufferGen,
          currentGen,
          armedBaseText: rec.baseText,
          bufferText: optsRef.current.getText(),
          // The editor's own base, for the same reason the arm uses it.
          baseContent: optsRef.current.getBaseText(),
        });
        if (plan.action === 'skip') {
          log.info('file-editor', 'live write dropped: the buffer moved on', {
            path: rec.path, host: rec.host, armedGen: rec.bufferGen, currentGen, reason: plan.reason,
          });
          return;
        }
        if (plan.text !== rec.text) {
          log.info('file-editor', 'live write re-read the buffer: it moved on since the keystroke', {
            path: rec.path, host: rec.host, armedGen: rec.bufferGen, currentGen,
          });
        }
        text = plan.text;
        baseText = plan.baseText;
      }
      // THE TOKEN COMES FROM THE BYTES, never from a ref.
      //
      // `expectedHash` is the hash of the bytes this write believes it is
      // replacing, computed here from `baseText`. The server re-reads the real file
      // and compares; if our base is stale the hashes differ and the write is
      // refused, whatever any counter or ref believed. Reading the token out of
      // `lockHashRef` instead is what let a stale copy replace a newer file five
      // times (2026-09-05 x4, 2026-09-08 x1): the ref had moved on to bytes the
      // editor was not showing.
      //
      // No base ⇒ nothing to prove ⇒ an automatic write must not go out. The text
      // is still in the draft store, and the next open offers it with the
      // stale-draft banner, which is a human deciding instead of us guessing.
      if (baseText == null) {
        log.warn('file-editor', 'live write dropped: no provable base for these bytes', {
          path: rec.path, host: rec.host, armedGen: rec.bufferGen,
          currentGen: optsRef.current.bufferGenRef.current, live,
        });
        return;
      }
      const expectedHash = computeContentHashClient(baseText);
      // One line per automatic write, immediately before it goes out. The server's
      // own `file write` line has the hashes and the sizes; what only the client
      // knows is HOW OLD the text is (`armedMs`) and whether the buffer moved
      // between the keystroke and the send (`armedGen` vs `currentGen`). Those
      // three numbers are what the 2026-09-05 incident had to be reconstructed
      // from, and a write with a big `armedMs` and a gen gap is the shape to look
      // for if it ever comes back.
      log.info('file-editor', 'live write sending', {
        path: rec.path, host: rec.host, writer, live,
        armedMs: Date.now() - rec.capturedAt,
        armedGen: rec.bufferGen,
        currentGen: optsRef.current.bufferGenRef.current,
        expectedHash,
        textLen: text.length,
        armedTextLen: rec.text.length,
      });
      const res = await saveFileContent(rec.path, text, {
        host: rec.host, expectedHash, writer, origin: optsRef.current.origin,
        // The token above was computed from `baseText`, so say so: the server
        // refuses an automatic write that cannot make this claim.
        baseFrom: 'content',
      });
      noteWritten(rec.host, rec.path, res.contentHash, text);
      // The bytes are on disk, so the unsaved-draft side record is obsolete —
      // even for a file we have already navigated away from, whose parent
      // callbacks we must not touch (it would delete the NEW file's draft).
      void deleteFileDraft(rec.host, rec.path);
      if (!isCurrent(rec)) return;
      const o = optsRef.current;
      o.lockHashRef.current = res.contentHash;
      o.baseContentRef.current = text;
      o.onWrote(text, res);
    } catch (err) {
      if (err instanceof FileSaveConflictError) {
        if (!allowMerge || !isCurrent(rec)) return; // no live editor to merge into
        // Only a real collision is worth merging. The other two reasons mean the
        // REQUEST was rejected, not that the file moved: merging would re-read
        // disk, find it unchanged, produce our own text back, and send the same
        // rejected shape again — MAX_MERGE_ATTEMPTS times, ending in a conflict
        // banner blaming an agent that never touched the file. Say the true thing
        // once instead.
        if (err.reason !== 'stale-lock') {
          suspendHere(rec);
          log.error('file-editor', 'live write rejected by the server, not by a collision', {
            path: rec.path, host: rec.host, reason: err.reason,
          });
          if (isCurrent(rec)) {
            optsRef.current.onError(
              err.reason === 'unverified-base'
                ? 'This tab is running an older version of Walnut, so it can no longer save automatically. '
                  + 'Reload the page to resume Live edit — your text is kept.'
                : 'Live edit could not save this file (the server refused the request). '
                  + 'Your text is still in the editor: press Save, or reload the page.',
            );
          }
          return;
        }
        await resolveConflict(rec, err.currentHash, attempt);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error('file-editor', 'live write failed', { path: rec.path, host: rec.host, error: msg });
      // Never retry a network/5xx failure: at one write per typing pause it
      // would hammer the server and bury the message the user needs to read.
      suspendHere(rec);
      if (isCurrent(rec)) optsRef.current.onError(msg);
    } finally {
      inFlightRef.current = false;
      inFlightDoneRef.current = null;
      // AFTER clearing the flag, so a final flush awaiting this sees `false` and
      // proceeds rather than reading a stale `true` and giving up.
      settle();
      if (live) setWriting(false);
      if (pullPendingRef.current) schedulePull(pullPendingRef.current);
    }
  }, [isCurrent, resolveConflict, suspendHere, schedulePull]);
  writeOnceRef.current = writeOnce;

  const noteUserEdit = useCallback(() => {
    if (!onRef.current) return;
    const text = optsRef.current.getText();
    if (text == null) return;
    pendingRef.current = {
      path: pathRef.current,
      host: hostRef.current,
      text,
      capturedAt: Date.now(),
      bufferGen: optsRef.current.bufferGenRef.current,
      // Captured WITH the text, in the same tick: this is the pair the write's
      // token is derived from, and the only reason the token cannot drift.
      baseText: optsRef.current.getBaseText(),
    };
    schedule(LIVE_WRITE_DEBOUNCE_MS);
  }, [schedule]);

  const flushNow = useCallback(() => { void flush(true); }, [flush]);

  const cancelPending = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
  }, [clearTimer]);

  const toggle = useCallback(() => {
    const p = pathRef.current;
    const h = hostRef.current;
    // Clicking the toggle on a paused file means "resume it", not "flip the
    // global preference" — the preference was never what turned it off.
    if (isLiveSuspended(h, p)) {
      resumeLiveEdit(h, p);
      setSuspended(false);
      if (!prefOnRef.current) { setPrefOn(true); saveLiveEditPref(true); }
      return;
    }
    const next = !prefOnRef.current;
    setPrefOn(next);
    saveLiveEditPref(next);
    if (!next) cancelPending();
  }, [cancelPending]);

  const pullFromDisk = useCallback(async (reason: PullReason = 'agent') => {
    const adopted = reason === 'agent' ? 'Updated from agent'
      : reason === 'disk' ? 'Updated from disk' : 'Updated from another view';
    const merged = reason === 'agent' ? 'Merged agent changes'
      : reason === 'disk' ? 'Merged disk changes' : 'Merged changes from another view';
    const o = optsRef.current;
    if (!mountedRef.current || !o.canEdit || !o.isVisible()) return;
    if (pullInFlightRef.current || inFlightRef.current) {
      pullPendingRef.current = reason;
      return;
    }
    const rec = { path: pathRef.current, host: hostRef.current };
    const readGen = o.bufferGenRef.current;
    pullInFlightRef.current = true;
    try {
      const res = await fetchFileContentConditional(rec.path, rec.host, {
        ifNoneMatch: o.lockHashRef.current,
        track: reason === 'agent' ? 'agent' : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (!isCurrent(rec)) return;
      // 等待网络期间可能已保存或手动刷新，旧响应不能覆盖新基线。
      if (optsRef.current.bufferGenRef.current !== readGen || inFlightRef.current) {
        pullPendingRef.current = reason;
        return;
      }
      const disk = res.payload;
      if (res.notModified || !disk || disk.content == null || disk.contentHash == null) return;
      // Our own write, echoed back through the agent's read/write of the file.
      if (disk.contentHash === optsRef.current.lockHashRef.current) return;
      const cur = optsRef.current;

      if (!cur.isDirtyRef.current) {
        cur.applyText(disk.content, disk.content);
        cur.baseContentRef.current = disk.content;
        cur.lockHashRef.current = disk.contentHash;
        cur.onAdopted(disk.content, disk.contentHash, disk.size);
        showReceipt(adopted);
        return;
      }

      // The editor's base, for the same reason resolveConflict uses it: `ours`
      // comes from the editor, so the base must too.
      const base = cur.getBaseText();
      const ours = cur.getText();
      const merge = base != null && ours != null
        ? threeWayMerge(base, ours, disk.content)
        : ({ ok: false, conflicts: 1 } as MergeResult);
      cur.onDiskContent(disk.content, disk.contentHash, disk.size);
      if (!merge.ok) {
        // Both the agent's bytes and the user's typing are real work. Deliberately
        // NO overwrite hash: no write was attempted, so the next explicit Save
        // must still hit the warn-once conflict gate.
        if (onRef.current) {
          suspendHere({
            ...rec, text: ours ?? '', capturedAt: Date.now(),
            bufferGen: optsRef.current.bufferGenRef.current,
            baseText: optsRef.current.getBaseText(),
          });
        }
        cur.onConflict(
          `${reason === 'agent' ? 'The agent in this session' : reason === 'disk' ? 'Another writer' : 'Another view of this file'} changed this `
          + 'file, and those changes overlap yours. Your unsaved version is still in the editor — Save will '
          + 'warn you before it replaces the other one, or Discard and reopen the file to get it.',
        );
        return;
      }
      cur.lockHashRef.current = disk.contentHash;
      cur.applyText(merge.merged, disk.content);
      cur.baseContentRef.current = disk.content;
      showReceipt(merged);
      // With live OFF the merge just lands in the editor and stays dirty — the
      // pull is about not losing either side, not about writing.
      if (onRef.current) {
        pendingRef.current = {
          path: rec.path, host: rec.host, text: merge.merged, capturedAt: Date.now(),
          bufferGen: optsRef.current.bufferGenRef.current,
          baseText: disk.content,
        };
        await flush(true);
      }
    } catch (err) {
      log.info('file-editor', 'agent pull failed (non-fatal)', {
        path: rec.path, host: rec.host, error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pullInFlightRef.current = false;
      if (pullPendingRef.current) schedulePull(pullPendingRef.current);
    }
  }, [flush, isCurrent, showReceipt, suspendHere, schedulePull]);
  pullRef.current = pullFromDisk;

  useEffect(() => {
    if (!canEdit) return;
    const check = () => schedulePull('disk');
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const timer = setInterval(check, FILE_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [canEdit, schedulePull]);

  useEvent('_ws:reconnected', () => schedulePull('disk'));
  useEvent('session:result', (data) => {
    if (sessionId && (data as { sessionId?: string }).sessionId === sessionId) schedulePull('disk');
  });

  useEvent('session:tool-use', (data) => {
    const d = data as {
      sessionId?: string; toolName?: string; toolUseId?: string; input?: Record<string, unknown>; replayed?: boolean;
    };
    if (!sessionId || d.sessionId !== sessionId) return;
    // History replay on (re)connect re-emits old tool calls; those writes landed
    // long before this read, so a pull would only re-fetch what we already hold.
    if (d.replayed) return;
    agentSeenAtRef.current = Date.now();
    if (!d.toolUseId || !agentToolMayChangeFile(pathRef.current, d.toolName, d.input)) return;
    agentWriteIdsRef.current.add(d.toolUseId);
  });

  useEvent('session:tool-result', (data) => {
    const d = data as { sessionId?: string; toolUseId?: string };
    if (!sessionId || d.sessionId !== sessionId || !d.toolUseId) return;
    // The result is the "it landed" signal — reading on tool-use would race the
    // write itself and pull the PRE-write bytes.
    if (!agentWriteIdsRef.current.delete(d.toolUseId)) return;
    schedulePull('agent');
  });

  // File switch / unmount: land the buffer under the OUTGOING identity. The
  // record carries its own path, so this can never write it to the next file.
  useEffect(() => () => { void flush(false); }, [path, host, flush]);

  return {
    on,
    suspended,
    writing,
    receipt: receipt?.text ?? null,
    toggle,
    noteUserEdit,
    flushNow,
    cancelPending,
    pullNow: (reason?: PullReason) => { void pullFromDisk(reason); },
  };
}
