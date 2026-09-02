/**
 * useFileTreeMutations — every file MUTATION the session file explorer can run
 * (create / rename / duplicate / delete), plus the tree-state repair each one
 * implies. It lives here so SessionFileExplorer.tsx keeps owning only what it
 * renders; the explorer hands over its setters/refs and wires `editing` into the
 * row list.
 *
 * The repairs are the non-obvious half. A rename that only re-listed the parent
 * would leave the open file pointing at a path that no longer exists, every
 * expanded child collapsed, and the cached listings keyed under the old name —
 * so the rename is FOLLOWED THROUGH into `selectedFile`, `expanded`,
 * `openRoots`, `childrenMap`, the back/forward history and the unsaved-draft
 * store (all segment-wise, descendants included), and a delete drops the same
 * keys, every history stop under the removed path, and its drafts.
 *
 * Everything keyed by PATH has to move or die with the path; the three that used
 * to be forgotten were all silent DATA LOSS or worse. The unsaved draft: the
 * outgoing editor unmounts and flushes its buffer under the OLD path, so a rename
 * orphaned the typed text and a delete re-created a record for a dead file (see
 * file-drafts.ts). The history: Back after renaming `a` → `b` mounted a dead
 * `a/one.ts` and showed an error pane where a file used to be. The per-file view
 * state (scroll offset + Preview/Source): left at the old path it resurfaced on
 * the next file created with that name, opening a new file at a stranger's
 * reading position (see file-view-state.ts).
 *
 * A mutation the server answers 202 for is STILL RUNNING, not failed: those arm a
 * watch (planPendingPolls) that re-lists until the rows themselves show the end
 * state, and only then runs the repair.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createFile, createFolder, renamePath, duplicatePath, deletePath,
  FileOpError, FileOpPending,
  type DirEntry,
} from '@/api/files';
import { useConfirm, useAlert } from '@/hooks/useConfirm';
import {
  saveFileHistory, moveFileViewState, deleteFileViewStateUnder,
  type FileHistory, type FileHistoryEntry,
} from '@/utils/file-view-state';
import { moveFileDraftsUnder, deleteFileDraftsUnder } from '@/utils/file-drafts';
import { noteFileDeleted } from '@/hooks/useLiveEdit';
import { log } from '@/utils/log';
import { parentPath } from './reveal-ancestors';
import { validateEntryName, nextCopyName, remapPathPrefix } from './file-tree-edit';

export type FileTreeEditing =
  | { kind: 'create-file' | 'create-dir'; parentDir: string }
  | { kind: 'rename'; path: string; type: 'dir' | 'file' }
  | null;

type Ref<T> = { current: T };

interface Args {
  host?: string;
  loadDir: (
    dirPath: string,
    opts?: { isRoot?: boolean; restoreExpanded?: boolean; noCache?: boolean },
  ) => Promise<void>;
  childrenMapRef: Ref<Map<string, DirEntry[]>>;
  /** Paths rendered as ROOT SECTION headers — they open via `openRoots`, not `expanded`. */
  rootPathsRef: Ref<Set<string>>;
  selectedFileRef: Ref<string | null>;
  scopeRef: Ref<string>;
  historyRef: Ref<FileHistory>;
  /** localStorage keys the explorer persists `expanded` / `openRoots` under. */
  lsExpandedKeyRef: Ref<string>;
  lsOpenRootsKeyRef: Ref<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  setChildrenMap: React.Dispatch<React.SetStateAction<Map<string, DirEntry[]>>>;
  setOpenRoots: React.Dispatch<React.SetStateAction<Set<string>>>;
  setHistory: React.Dispatch<React.SetStateAction<FileHistory>>;
  commitSelection: (filePath: string | null, opts?: { push?: boolean; line?: number }) => void;
  selectFile: (filePath: string) => void;
  /** DIRECTORY paths a mutation moved or removed — the explorer drops its persisted listing cache for those subtrees. */
  onDirPathsChanged?: (paths: string[]) => void;
}

function lastSegment(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Segment-wise: `/a/b` covers `/a/b` and `/a/b/c`, NEVER `/a/bc`. */
function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Carry every back/forward stop across a rename (descendants included).
 *
 * Remapping can leave two NEIGHBOURING stops identical (the stack already held a
 * file at the destination name), so those collapse — otherwise Back would look
 * like a dead button. The cursor stays on the same file either way.
 */
export function remapFileHistory(history: FileHistory, from: string, to: string): FileHistory {
  let touched = false;
  const mapped = history.entries.map((e) => {
    const path = remapPathPrefix(e.path, from, to);
    if (path === e.path) return e;
    touched = true;
    return e.line ? { path, line: e.line } : { path };
  });
  if (!touched) return history;
  const entries: FileHistoryEntry[] = [];
  let index = history.index;
  for (let i = 0; i < mapped.length; i++) {
    const entry = mapped[i]!;
    const prev = entries[entries.length - 1];
    if (prev && prev.path === entry.path && prev.line === entry.line) {
      if (i <= history.index) index--;
      continue;
    }
    entries.push(entry);
  }
  return { entries, index: Math.min(Math.max(index, 0), entries.length - 1) };
}

/**
 * Drop every stop under a removed path and re-clamp the cursor, the same way
 * removeFromFileHistory does for a single file: losing the CURRENT stop lands on
 * its predecessor, losing earlier ones just shifts the cursor left.
 */
export function pruneFileHistoryUnder(history: FileHistory, gone: string): FileHistory {
  const dead = (e: FileHistoryEntry) => isUnder(e.path, gone);
  if (!history.entries.some(dead)) return history;
  const removedBefore = history.entries.slice(0, history.index).filter(dead).length;
  const cur = history.entries[history.index];
  const wasCurrent = cur ? dead(cur) : false;
  const entries = history.entries.filter((e) => !dead(e));
  if (entries.length === 0) return { entries: [], index: -1 };
  const index = Math.min(
    Math.max(history.index - removedBefore - (wasCurrent ? 1 : 0), 0),
    entries.length - 1,
  );
  return { entries, index };
}

export type RestoredSelectionVerdict = 'wait' | 'keep' | 'prune';

/**
 * Is a restored selection dead (its file gone since the last visit) and safe to
 * drop? Used by SessionFileExplorer's stale-selection effect; it lives beside the
 * delete repair because both answer the same question about a path.
 *
 * The listing has to be FRESH, i.e. answered by a network fetch. A cached listing
 * is a paintable guess, however old — one written before the file existed says
 * "not there" — while the pruner's answer is destructive AND persisted (it clears
 * the remembered file and drops the history stop), so a guess must never decide
 * it. 'wait' keeps the question open until real rows land.
 */
export function judgeRestoredSelection(args: {
  path: string;
  entries: DirEntry[] | undefined;
  parentIsFresh: boolean;
}): RestoredSelectionVerdict {
  const { path, entries, parentIsFresh } = args;
  if (!entries || !parentIsFresh) return 'wait';
  const name = lastSegment(path);
  return entries.some((e) => e.name === name && e.type === 'file') ? 'keep' : 'prune';
}

// ── A mutation the server answered 202 for (still running past its deadline) ──
/**
 * A recursive delete of a huge tree, or a copy over a slow tunnel, outlives the
 * server's deadline. That is NOT a failure — the host keeps going — so the old
 * behaviour was doubly wrong: it showed "Delete failed" and repaired nothing,
 * while the daemon went on and deleted the folder anyway. The user was told it
 * failed and the folder was gone.
 *
 * So a 202 arms a WATCH instead: re-list the affected directory a few times and
 * let the FILESYSTEM answer. Only rows that actually show the end state trigger
 * the normal post-op repair — never a timer, and never an optimistic guess.
 */

/** When to re-check, as offsets from the 202. The last one is the give-up point:
 *  three probes over half a minute cover a slow tunnel without leaving timers
 *  running behind a panel nobody is looking at any more. */
export const PENDING_POLL_DELAYS_MS = [3_000, 10_000, 30_000];

export type PendingFileOp = 'delete' | 'duplicate' | 'rename' | 'create';

export interface PendingPollPlan {
  op: PendingFileOp;
  /** The path the user acted on — the key the watch is cancelled by. */
  target: string;
  /** Directories to re-list on every probe. */
  dirs: string[];
  /** The directory whose FRESH rows decide (a duplicate is judged at its
   *  DESTINATION, which may not be where the source lives). */
  watchDir: string;
  /** Entry name to look for in `watchDir`. */
  watchName: string;
  /** What "it landed" looks like: the row is gone, or the copy is there. */
  expect: 'absent' | 'present';
  /** Offsets from the 202, in order. */
  delays: number[];
  /** The server's own prose, shown as a neutral notice (never as an error). */
  message: string;
}

/**
 * What to re-list, what to look for, and when — the whole decision, kept pure so
 * the schedule and the end-state rule are testable without a filesystem.
 */
export function planPendingPolls(
  // A duplicate MUST name its destination: that is the only place its end state
  // can be seen, and falling back to the source's parent would read "the source is
  // gone" as "the copy arrived".
  args:
    | { op: 'delete'; path: string; message: string }
    | { op: 'duplicate' | 'rename' | 'create'; path: string; destination: string; message: string },
): PendingPollPlan {
  const { op, path, message } = args;
  const sourceParent = parentPath(path);
  // Every op that PRODUCES a path is judged by that path showing up: a copy, the
  // renamed entry, the new file/folder. A rename that outran the deadline on a
  // remote host is the same shape as a slow duplicate — the row is not a failure,
  // it just isn't visible yet.
  if (args.op !== 'delete') {
    const { destination } = args;
    const destParent = parentPath(destination);
    return {
      op,
      target: path,
      // Same directory in the common case (VS Code names the copy beside the
      // original), so de-duplicate rather than list it twice.
      dirs: destParent === sourceParent ? [destParent] : [sourceParent, destParent],
      watchDir: destParent,
      watchName: lastSegment(destination),
      expect: 'present',
      delays: [...PENDING_POLL_DELAYS_MS],
      message,
    };
  }
  return {
    op: 'delete',
    target: path,
    dirs: [sourceParent],
    watchDir: sourceParent,
    watchName: lastSegment(path),
    expect: 'absent',
    delays: [...PENDING_POLL_DELAYS_MS],
    message,
  };
}

/**
 * Did the pending op land? Judged ONLY on rows that actually arrived: a missing
 * listing (the re-list failed, or hasn't been committed yet) is "don't know", and
 * "don't know" must never trigger the repair — that is the confident-wrong-answer
 * failure this whole watch exists to avoid.
 */
export function pendingOpLanded(
  plan: Pick<PendingPollPlan, 'expect' | 'watchName'>,
  entries: DirEntry[] | undefined,
): boolean {
  if (!entries) return false;
  const present = entries.some((e) => e.name === plan.watchName);
  return plan.expect === 'present' ? present : !present;
}

/** Left in the notice when the last probe still can't see the end state. The op
 *  may yet finish; Refresh is how the user asks again. */
const STILL_WORKING = 'Still working… use Refresh to check.';

/**
 * The message for a REFUSED mutation. Everything the server says is shown
 * VERBATIM — for `daemon_needs_upgrade` and `unsupported` the prose IS the
 * instruction ("run this to upgrade", "this filesystem can't do that"), and
 * paraphrasing it costs the user the only actionable part. `no_space` is the one
 * code whose raw errno prose ("ENOSPC: no space left on device, copyfile …")
 * says less than one plain sentence.
 */
function fileOpMessage(e: unknown): string {
  if (e instanceof FileOpError) {
    switch (e.code) {
      case 'no_space': return 'Not enough disk space';
      case 'unsupported':
      case 'daemon_needs_upgrade':
      default: return e.message;
    }
  }
  return errMessage(e);
}

export function useFileTreeMutations({
  host, loadDir, childrenMapRef, rootPathsRef, selectedFileRef, scopeRef, historyRef,
  lsExpandedKeyRef, lsOpenRootsKeyRef,
  setExpanded, setChildrenMap, setOpenRoots, setHistory, commitSelection, selectFile,
  onDirPathsChanged,
}: Args) {
  const confirm = useConfirm();
  const alert = useAlert();
  const [editing, setEditing] = useState<FileTreeEditing>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** Neutral "still running" notice for a 202'd mutation. Deliberately NOT
   *  `editError`: nothing failed, and the red error row would say it did. */
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);
  const editingRef = useRef<FileTreeEditing>(null);
  editingRef.current = editing;
  /** Live poll timers per watched path, so a second mutation on that path (or an
   *  unmount) can cancel the first one's probes instead of letting them re-list a
   *  directory into a panel that has moved on. */
  const pendingTimersRef = useRef(new Map<string, Array<ReturnType<typeof setTimeout>>>());

  const clearPendingPolls = useCallback((path: string) => {
    const timers = pendingTimersRef.current.get(path);
    if (timers) {
      for (const t of timers) clearTimeout(t);
      pendingTimersRef.current.delete(path);
    }
    // Unconditional, not only when timers were live: a watch that gave up keeps
    // its "Still working…" notice with no timers left, and the next mutation on
    // that path is exactly when that notice stops being true.
    if (pendingTimersRef.current.size === 0) setPendingNotice(null);
  }, []);

  useEffect(() => {
    const live = pendingTimersRef.current;
    return () => {
      for (const timers of live.values()) for (const t of timers) clearTimeout(t);
      live.clear();
    };
  }, []);

  const siblingNames = useCallback((dir: string): string[] => {
    return (childrenMapRef.current.get(dir) ?? []).map((e) => e.name);
  }, [childrenMapRef]);

  const persistExpanded = useCallback((next: Set<string>) => {
    try { localStorage.setItem(lsExpandedKeyRef.current, JSON.stringify([...next])); } catch { /* quota/denied */ }
  }, [lsExpandedKeyRef]);

  /** Mark `dir` open (root section or nested dir) and make sure its children are loaded. */
  const openDir = useCallback((dir: string) => {
    setExpanded((prev) => {
      if (prev.has(dir)) return prev;
      const next = new Set(prev).add(dir);
      persistExpanded(next);
      return next;
    });
    if (rootPathsRef.current.has(dir)) {
      setOpenRoots((prev) => {
        if (prev.has(dir)) return prev;
        const next = new Set(prev).add(dir);
        try { localStorage.setItem(lsOpenRootsKeyRef.current, JSON.stringify([...next])); } catch { /* quota/denied */ }
        return next;
      });
    }
    if (!childrenMapRef.current.has(dir)) void loadDir(dir);
  }, [setExpanded, setOpenRoots, persistExpanded, rootPathsRef, childrenMapRef, lsOpenRootsKeyRef, loadDir]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setEditError(null);
  }, []);

  const startCreate = useCallback((parentDir: string, kind: 'create-file' | 'create-dir') => {
    setEditError(null);
    openDir(parentDir);
    setEditing({ kind, parentDir });
  }, [openDir]);

  const startRename = useCallback((path: string, type: 'dir' | 'file') => {
    setEditError(null);
    setEditing({ kind: 'rename', path, type });
  }, []);

  /** Carry the open file, the expanded set, the cached listings, the history and
   *  the unsaved drafts across a rename. */
  const applyRename = useCallback((from: string, to: string) => {
    // FIRST, before the selection remap below changes the preview's key: that
    // unmounts the outgoing editor, whose cleanup flushes the pending buffer
    // under the OLD path. moveFileDraftsUnder moves the stored record AND
    // redirects that late write, so the typed text arrives with the file instead
    // of being orphaned at a path that no longer exists.
    void moveFileDraftsUnder(host, from, to);
    // Same reason, other store: the scroll offset + Preview/Source choice are
    // keyed by path too. Left behind they don't just vanish — they resurface on
    // whatever file is later created at the old name, which opens a brand-new file
    // at a stranger's reading position.
    moveFileViewState(host, from, to);
    const sel = selectedFileRef.current;
    if (sel && isUnder(sel, from)) {
      // push:false — a rename is not a navigation; it must not truncate the
      // forward tail of the back/forward stack.
      commitSelection(remapPathPrefix(sel, from, to), { push: false });
    }
    // Back/Forward stops are paths too: unrepaired, Back mounted the dead old
    // path and showed an error pane.
    const remapped = remapFileHistory(historyRef.current, from, to);
    if (remapped !== historyRef.current) {
      historyRef.current = remapped;
      setHistory(remapped);
      saveFileHistory(host, scopeRef.current, remapped);
    }
    setOpenRoots((prev) => {
      let touched = false;
      const next = new Set<string>();
      for (const p of prev) {
        const mapped = remapPathPrefix(p, from, to);
        if (mapped !== p) touched = true;
        next.add(mapped);
      }
      if (!touched) return prev;
      try { localStorage.setItem(lsOpenRootsKeyRef.current, JSON.stringify([...next])); } catch { /* quota/denied */ }
      return next;
    });
    setExpanded((prev) => {
      let touched = false;
      const next = new Set<string>();
      for (const p of prev) {
        const mapped = remapPathPrefix(p, from, to);
        if (mapped !== p) touched = true;
        next.add(mapped);
      }
      if (!touched) return prev;
      persistExpanded(next);
      return next;
    });
    setChildrenMap((prev) => {
      let touched = false;
      const next = new Map<string, DirEntry[]>();
      for (const [k, v] of prev) {
        const mapped = remapPathPrefix(k, from, to);
        if (mapped !== k) touched = true;
        next.set(mapped, v);
      }
      return touched ? next : prev;
    });
  }, [
    host, selectedFileRef, commitSelection, setExpanded, setChildrenMap, setOpenRoots,
    persistExpanded, lsOpenRootsKeyRef, scopeRef, historyRef, setHistory,
  ]);

  /** Forget everything the tree remembered about a path that no longer exists. */
  const forgetPath = useCallback((gone: string) => {
    const under = (p: string) => isUnder(p, gone);
    // Drafts go first AND stay gone: the view for the deleted file is about to
    // unmount and flush its buffer, so deleteFileDraftsUnder also refuses that
    // late write — otherwise the record returns for a path that no longer exists,
    // and recreating the name offers the deleted file's body under a baseHash
    // that matches nothing.
    void deleteFileDraftsUnder(host, gone);
    // Same for LIVE mode's armed write: the server's PUT creates a missing file,
    // so the unmount flush would resurrect what was just deleted.
    noteFileDeleted(host, gone);
    deleteFileViewStateUnder(host, gone);
    setExpanded((prev) => {
      const next = new Set([...prev].filter((p) => !under(p)));
      if (next.size === prev.size) return prev;
      persistExpanded(next);
      return next;
    });
    setOpenRoots((prev) => {
      const next = new Set([...prev].filter((p) => !under(p)));
      if (next.size === prev.size) return prev;
      try { localStorage.setItem(lsOpenRootsKeyRef.current, JSON.stringify([...next])); } catch { /* quota/denied */ }
      return next;
    });
    setChildrenMap((prev) => {
      const keys = [...prev.keys()].filter(under);
      if (keys.length === 0) return prev;
      const next = new Map(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
    const sel = selectedFileRef.current;
    if (sel && under(sel)) commitSelection(null); // clears state AND the remembered-file key
    // Pruned whether or not the OPEN file was the deleted one: a Back button that
    // lands on a dead path is the same bug one step later.
    const pruned = pruneFileHistoryUnder(historyRef.current, gone);
    if (pruned !== historyRef.current) {
      historyRef.current = pruned;
      setHistory(pruned);
      saveFileHistory(host, scopeRef.current, pruned);
    }
  }, [
    setExpanded, setOpenRoots, setChildrenMap, persistExpanded, lsOpenRootsKeyRef,
    selectedFileRef, commitSelection, host, scopeRef, historyRef, setHistory,
  ]);

  /**
   * Follow a 202'd mutation to its end state. Re-lists on the planned schedule and
   * runs `onLanded` — the mutation's NORMAL post-op repair — only once fresh rows
   * show the result. Nothing is repaired on a timer: a delete whose rows still
   * show the folder has not happened yet, and pretending otherwise is how the old
   * path told the user "failed" about a folder that was about to disappear.
   */
  const watchPendingOp = useCallback((plan: PendingPollPlan, onLanded: () => void) => {
    clearPendingPolls(plan.target);
    setPendingNotice(plan.message);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    pendingTimersRef.current.set(plan.target, timers);
    // Identity check, not a boolean: `timers` is this watch's own array, so a
    // newer mutation on the same path (or an unmount) is detected even mid-probe.
    const stillOurs = () => pendingTimersRef.current.get(plan.target) === timers;

    const probe = async (isLast: boolean) => {
      if (!stillOurs()) return;
      try {
        for (const dir of plan.dirs) await loadDir(dir, { noCache: true });
      } catch (err) {
        // A failed re-list is "don't know", never "it landed" — and it must not
        // reject out of a timer callback either. The next probe asks again.
        log.warn('file-explorer', 're-list for a pending file op failed', {
          op: plan.op, path: plan.target, host, error: String(err),
        });
      }
      // childrenMapRef is re-pointed during RENDER, not by the setter loadDir
      // called — one macrotask lets React commit before we ask what it says.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      if (!stillOurs()) return;
      if (pendingOpLanded(plan, childrenMapRef.current.get(plan.watchDir))) {
        clearPendingPolls(plan.target);
        onLanded();
        log.info('file-explorer', 'pending file op landed', { op: plan.op, path: plan.target, host });
        return;
      }
      if (isLast) {
        // Stop probing, keep the notice: the op may still finish, and Refresh is
        // how the user asks again. Timers left armed against a panel nobody is
        // watching are their own bug.
        pendingTimersRef.current.delete(plan.target);
        setPendingNotice(STILL_WORKING);
        log.warn('file-explorer', 'pending file op not visible after the last probe', {
          op: plan.op, path: plan.target, host,
        });
      }
    };

    plan.delays.forEach((delay, i) => {
      timers.push(setTimeout(() => { void probe(i === plan.delays.length - 1); }, delay));
    });
  }, [clearPendingPolls, loadDir, childrenMapRef, host]);

  /** Enter (or a blur with text) on the inline row. Rejections KEEP the row. */
  const commitEdit = useCallback(async (raw: string) => {
    const ed = editingRef.current;
    if (!ed) return;
    const name = raw.trim();

    if (ed.kind === 'rename') {
      const current = lastSegment(ed.path);
      // Unchanged name is a no-op, not a request — never round-trip it.
      if (!name || name === current) { cancelEdit(); return; }
      const parent = parentPath(ed.path);
      const invalid = validateEntryName(name, siblingNames(parent), { current });
      if (invalid) { setEditError(invalid); return; }
      const target = joinPath(parent, name);
      // A rename in flight replaces any watch on this path: whatever the older
      // op was waiting for, these rows are about to be re-listed anyway.
      clearPendingPolls(ed.path);
      try {
        await renamePath(ed.path, target, host);
      } catch (e) {
        if (e instanceof FileOpPending) {
          // The host is still on it. Close the row (typing is done), say so
          // neutrally, and run the normal post-rename repair once the new name
          // is actually listed — never on a timer.
          setEditing(null);
          setEditError(null);
          const from = ed.path;
          const isDir = ed.type === 'dir';
          watchPendingOp(
            planPendingPolls({ op: 'rename', path: from, destination: target, message: e.message }),
            () => {
              applyRename(from, target);
              if (isDir) onDirPathsChanged?.([from, target]);
            },
          );
          return;
        }
        setEditError(fileOpMessage(e));
        return;
      }
      setEditing(null);
      setEditError(null);
      await loadDir(parent, { noCache: true });
      applyRename(ed.path, target);
      if (ed.type === 'dir') onDirPathsChanged?.([ed.path, target]);
      log.info('file-explorer', 'renamed entry', { from: ed.path, to: target, host, type: ed.type });
      return;
    }

    const parent = ed.parentDir;
    if (!name) { cancelEdit(); return; }
    const invalid = validateEntryName(name, siblingNames(parent));
    if (invalid) { setEditError(invalid); return; }
    const target = joinPath(parent, name);
    try {
      if (ed.kind === 'create-file') await createFile(target, host);
      else await createFolder(target, host);
    } catch (e) {
      if (e instanceof FileOpPending) {
        // Same as a slow rename: the entry will be listed when the host is done.
        // Deliberately no auto-open — hijacking focus seconds later is worse than
        // asking the user to click the row when it appears.
        setEditing(null);
        setEditError(null);
        watchPendingOp(
          planPendingPolls({ op: 'create', path: target, destination: target, message: e.message }),
          () => {},
        );
        return;
      }
      setEditError(fileOpMessage(e));
      return;
    }
    setEditing(null);
    setEditError(null);
    await loadDir(parent, { noCache: true });
    // A new file OPENS (an empty editor is the point of creating it); a new
    // folder just unfolds, ready to be created into.
    if (ed.kind === 'create-file') selectFile(target);
    else openDir(target);
    log.info('file-explorer', 'created entry', { path: target, host, kind: ed.kind });
  }, [
    cancelEdit, siblingNames, host, loadDir, applyRename, selectFile, openDir,
    onDirPathsChanged, clearPendingPolls, watchPendingOp,
  ]);

  /** No dialog: name it like VS Code does, then drop straight into rename mode. */
  const duplicate = useCallback(async (path: string, type: 'dir' | 'file') => {
    clearPendingPolls(path);
    const parent = parentPath(path);
    const target = joinPath(parent, nextCopyName(lastSegment(path), siblingNames(parent)));
    try {
      await duplicatePath(path, target, host);
    } catch (e) {
      if (e instanceof FileOpPending) {
        // The copy is still being written host-side. No rename row: the
        // destination may not exist yet, and an inline rename of a path that
        // isn't there fails with a confusing "not found".
        watchPendingOp(
          planPendingPolls({ op: 'duplicate', path, destination: target, message: e.message }),
          () => {
            // The probe already re-listed the parent, which IS the repair for a
            // duplicate. Deliberately NOT dropping into rename mode this late —
            // stealing focus 30 seconds after the click is worse than leaving the
            // copy named "… copy".
            log.info('file-explorer', 'duplicated entry (completed after 202)', {
              from: path, to: target, host, type,
            });
          },
        );
        return;
      }
      await alert({ title: 'Duplicate failed', message: fileOpMessage(e) });
      return;
    }
    await loadDir(parent, { noCache: true });
    setEditError(null);
    setEditing({ kind: 'rename', path: target, type });
    log.info('file-explorer', 'duplicated entry', { from: path, to: target, host, type });
  }, [siblingNames, host, alert, loadDir, clearPendingPolls, watchPendingOp]);

  const remove = useCallback(async (path: string, type: 'dir' | 'file') => {
    const name = lastSegment(path);
    const ok = await confirm(type === 'dir'
      ? {
        title: `Delete folder “${name}”?`,
        message: 'This permanently deletes the folder and everything inside it. This cannot be undone.',
        confirmLabel: 'Delete folder',
        danger: true,
      }
      : {
        title: `Delete “${name}”?`,
        message: 'This permanently deletes the file. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      });
    if (!ok) return;
    clearPendingPolls(path);
    try {
      await deletePath(path, host, type === 'dir' ? { recursive: true } : {});
    } catch (e) {
      if (e instanceof FileOpPending) {
        // Still deleting on the host. The tree state must NOT be forgotten yet:
        // if the delete ends up failing, forgetting here would have closed the
        // file and dropped its history stops for a file that still exists.
        watchPendingOp(planPendingPolls({ op: 'delete', path, message: e.message }), () => {
          forgetPath(path);
          if (type === 'dir') onDirPathsChanged?.([path]);
          log.info('file-explorer', 'deleted entry (completed after 202)', { path, host, type });
        });
        return;
      }
      await alert({ title: 'Delete failed', message: fileOpMessage(e) });
      return;
    }
    await loadDir(parentPath(path), { noCache: true });
    forgetPath(path);
    if (type === 'dir') onDirPathsChanged?.([path]);
    log.info('file-explorer', 'deleted entry', { path, host, type });
  }, [
    confirm, alert, host, loadDir, forgetPath, onDirPathsChanged,
    clearPendingPolls, watchPendingOp,
  ]);

  return {
    editing, editError,
    /**
     * A 202'd mutation's neutral progress notice (null when nothing is pending).
     * Render it in the SAME slot as `editError` but muted — it is information,
     * not a failure (the `.sfe-notice` / `.sfe-edit-pending` styling, never
     * `.sfe-edit-error`).
     */
    pendingNotice,
    startCreate, startRename, cancelEdit, commitEdit, duplicate, remove,
  };
}
