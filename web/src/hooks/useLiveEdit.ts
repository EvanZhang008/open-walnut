/**
 * useLiveEdit — the Files panel's LIVE EDIT state machine.
 *
 * Live mode turns the explicit Save into an automatic one: 600 ms after the last
 * keystroke the buffer is written to disk. It does NOT relax the optimistic lock
 * — every auto-write still sends `expectedHash`, because the whole reason the
 * lock exists is that an agent may be writing the same file in the same second.
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
import { saveFileContent, fetchFileContent, FileSaveConflictError } from '@/api/files';
import { deleteFileDraft } from '@/utils/file-drafts';
import { threeWayMerge, type MergeResult } from '@/utils/three-way-merge';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

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
/** Tool calls that mean "the agent wrote a file". */
export const AGENT_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
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

// ── Newest lock token per file, from OUR writes ───────────────────────────────
// A write for a file the panel has already LEFT (unmount / file-switch flush)
// cannot read the parent's lock ref — that belongs to the incoming file now — so
// its record carries the token captured at keystroke time. If another of our
// writes landed AFTER that keystroke, the token is stale and the flush would 409
// against our own bytes and be dropped. This map remembers the newest token and
// WHEN it was learned, so a record captured before it can be corrected.
const lastWritten = new Map<string, { hash: string; at: number }>();

export function noteWritten(host: string | undefined, path: string, hash: string): void {
  lastWritten.set(liveSuspensionKey(host, path), { hash, at: Date.now() });
}
/** The token a record captured at `capturedAt` should send: a newer write's, if any. */
export function freshestHash(
  host: string | undefined, path: string, captured: string | undefined, capturedAt: number,
): string | undefined {
  const w = lastWritten.get(liveSuspensionKey(host, path));
  return w && w.at > capturedAt ? w.hash : captured;
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
  expectedHash: string | undefined;
  /** When the record was armed — see freshestHash. */
  capturedAt: number;
}

export interface UseLiveEditOptions {
  path: string;
  host?: string;
  /** Session whose agent's writes to this file should be pulled in (item 6).
   *  Absent (pop-out, mention preview) → only the 409 path detects other writers. */
  sessionId?: string;
  /** The viewer's own editability gate. Live mode never writes a truncated,
   *  binary or errored read — there are no complete bytes to write back. */
  canEdit: boolean;
  /** Current editor buffer. */
  getText: () => string | null;
  /** Put text in the live editor WITHOUT a remount, and without arming a write
   *  (a programmatic apply must not look like typing, or the pull below would
   *  immediately write back what it just read). */
  applyText: (text: string) => void;
  /** The optimistic-lock token. The hook advances it on every write and read. */
  lockHashRef: MutableRefObject<string | undefined>;
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
  // Last tool call seen for this session (any tool) — receipt wording only.
  const agentSeenAtRef = useRef(0);
  // Write tool calls aimed at THIS file, awaiting their result.
  const agentWriteIdsRef = useRef(new Set<string>());
  const pullInFlightRef = useRef(false);

  // Suspension is keyed per file, so switching files re-reads it. The watched
  // tool ids go too: a result that arrives after the switch would otherwise pull
  // the NEW file because of a write aimed at the old one.
  useEffect(() => {
    setSuspended(isLiveSuspended(host, path));
    agentWriteIdsRef.current.clear();
  }, [host, path]);

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
    (rec: { path: string; host: string | undefined }) => rec.path === pathRef.current && rec.host === hostRef.current,
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
      // lock token, which would 409 by construction. On unmount there is nobody
      // left to re-check for, and the draft store still holds the text.
      if (allowMerge) scheduleRef.current?.(BUSY_RECHECK_MS);
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

    const base = o.baseContentRef.current;
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
    if (o.baseContentRef.current !== base) {
      const text = o.getText() ?? rec.text;
      log.info('file-editor', 'live edit base moved mid-conflict; rewriting the merged buffer', {
        path: rec.path, host: rec.host, attempt,
      });
      await writeOnceRef.current?.(
        { ...rec, text, expectedHash: o.lockHashRef.current, capturedAt: Date.now() },
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
    o.applyText(decision.merged);
    o.baseContentRef.current = disk.content;
    showReceipt(agentActive() ? 'Merged agent changes' : 'Merged disk changes');
    log.info('file-editor', 'live edit merged a conflict', { path: rec.path, host: rec.host, attempt });
    await writeOnceRef.current?.(
      { ...rec, text: decision.merged, expectedHash: disk.contentHash, capturedAt: Date.now() },
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
    try {
      // For the file on screen the ref is authoritative (a merge or an agent
      // pull may have advanced it since the keystroke that captured the record).
      // For a file we have LEFT, the record's token may predate our own last
      // write to it — freshestHash swaps in that write's token so the flush does
      // not 409 against our own bytes.
      const expectedHash = live
        ? (optsRef.current.lockHashRef.current ?? rec.expectedHash)
        : freshestHash(rec.host, rec.path, rec.expectedHash, rec.capturedAt);
      const res = await saveFileContent(rec.path, rec.text, { host: rec.host, expectedHash, writer });
      noteWritten(rec.host, rec.path, res.contentHash);
      // The bytes are on disk, so the unsaved-draft side record is obsolete —
      // even for a file we have already navigated away from, whose parent
      // callbacks we must not touch (it would delete the NEW file's draft).
      void deleteFileDraft(rec.host, rec.path);
      if (!isCurrent(rec)) return;
      const o = optsRef.current;
      o.lockHashRef.current = res.contentHash;
      o.baseContentRef.current = rec.text;
      o.onWrote(rec.text, res);
    } catch (err) {
      if (err instanceof FileSaveConflictError) {
        if (!allowMerge || !isCurrent(rec)) return; // no live editor to merge into
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
      if (live) setWriting(false);
    }
  }, [isCurrent, resolveConflict, suspendHere]);
  writeOnceRef.current = writeOnce;

  const noteUserEdit = useCallback(() => {
    if (!onRef.current) return;
    const text = optsRef.current.getText();
    if (text == null) return;
    pendingRef.current = {
      path: pathRef.current,
      host: hostRef.current,
      text,
      expectedHash: optsRef.current.lockHashRef.current,
      capturedAt: Date.now(),
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

  // ── The other writer, announced ─────────────────────────────────────────────
  // A tool-use for this session naming this file, then its tool-result (the
  // write has landed), is a far better signal than waiting for our own next
  // write to 409 — it also covers a file the user is only READING. It arrives
  // only while the browser is subscribed to that session's stream; the 409 path
  // covers everything else.
  const pullFromDisk = useCallback(async () => {
    const o = optsRef.current;
    if (!o.canEdit || pullInFlightRef.current) return;
    // Our own write is mid-air. Its 409 handler is about to read disk itself
    // (with the base it captured); a pull racing it would move the base under
    // that merge and hand the same hunks to both. The write's own conflict path
    // sees whatever the agent wrote, so nothing is missed by yielding here.
    if (inFlightRef.current) return;
    const rec = { path: pathRef.current, host: hostRef.current };
    pullInFlightRef.current = true;
    try {
      const disk = await fetchFileContent(rec.path, rec.host, { noCache: true, track: 'agent' });
      if (!isCurrent(rec)) return;
      if (disk.content == null || disk.contentHash == null) return;
      // Our own write, echoed back through the agent's read/write of the file.
      if (disk.contentHash === optsRef.current.lockHashRef.current) return;
      const cur = optsRef.current;

      if (!cur.isDirtyRef.current) {
        cur.applyText(disk.content);
        cur.baseContentRef.current = disk.content;
        cur.lockHashRef.current = disk.contentHash;
        cur.onAdopted(disk.content, disk.contentHash, disk.size);
        showReceipt('Updated from agent');
        return;
      }

      const base = cur.baseContentRef.current;
      const ours = cur.getText();
      const merge = base != null && ours != null
        ? threeWayMerge(base, ours, disk.content)
        : ({ ok: false, conflicts: 1 } as MergeResult);
      cur.onDiskContent(disk.content, disk.contentHash, disk.size);
      if (!merge.ok) {
        // Both the agent's bytes and the user's typing are real work. Deliberately
        // NO overwrite hash: no write was attempted, so the next explicit Save
        // must still hit the warn-once conflict gate.
        if (onRef.current) suspendHere({ ...rec, text: ours ?? '', expectedHash: undefined, capturedAt: Date.now() });
        cur.onConflict(
          'The agent in this session changed this file, and its changes overlap yours. Your unsaved '
          + 'version is still in the editor — Save will warn you before it replaces the agent\'s version, '
          + 'or Discard and reopen the file to get it.',
        );
        return;
      }
      cur.lockHashRef.current = disk.contentHash;
      cur.applyText(merge.merged);
      cur.baseContentRef.current = disk.content;
      showReceipt('Merged agent changes');
      // With live OFF the merge just lands in the editor and stays dirty — the
      // pull is about not losing either side, not about writing.
      if (onRef.current) {
        pendingRef.current = {
          path: rec.path, host: rec.host, text: merge.merged, expectedHash: disk.contentHash, capturedAt: Date.now(),
        };
        await flush(true);
      }
    } catch (err) {
      log.info('file-editor', 'agent pull failed (non-fatal)', {
        path: rec.path, host: rec.host, error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pullInFlightRef.current = false;
    }
  }, [flush, isCurrent, showReceipt, suspendHere]);

  useEvent('session:tool-use', (data) => {
    const d = data as {
      sessionId?: string; toolName?: string; toolUseId?: string; input?: Record<string, unknown>; replayed?: boolean;
    };
    if (!sessionId || d.sessionId !== sessionId) return;
    // History replay on (re)connect re-emits old tool calls; those writes landed
    // long before this read, so a pull would only re-fetch what we already hold.
    if (d.replayed) return;
    agentSeenAtRef.current = Date.now();
    if (!d.toolUseId || !d.toolName || !AGENT_WRITE_TOOLS.has(d.toolName)) return;
    const target = d.input?.file_path ?? d.input?.notebook_path;
    if (typeof target !== 'string' || !agentPathMatches(pathRef.current, target)) return;
    agentWriteIdsRef.current.add(d.toolUseId);
  });

  useEvent('session:tool-result', (data) => {
    const d = data as { sessionId?: string; toolUseId?: string };
    if (!sessionId || d.sessionId !== sessionId || !d.toolUseId) return;
    // The result is the "it landed" signal — reading on tool-use would race the
    // write itself and pull the PRE-write bytes.
    if (!agentWriteIdsRef.current.delete(d.toolUseId)) return;
    void pullFromDisk();
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
  };
}
