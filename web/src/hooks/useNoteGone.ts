import { useState, useRef } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { createNote } from '@/api/notes-v2';
import { log } from '@/utils/log';
import type { PendingExternalChange } from '@/hooks/useNoteContent';

/**
 * A note that is not there, in the two ways the editor meets one (2026-11-16, CI: a deleted
 * note came back with the words typed after it, written into an empty editor for it):
 *
 *  - missing: opened and not found (Back, a deep link, a restored tab), and the person did not
 *    set out to make it. Shown as "not here", never as an empty editor; "Write it" makes it
 *    create-only, so a note someone wrote meanwhile is opened, never overwritten.
 *  - deleted under its text: a save the server refused (410) because the note was deleted
 *    since it was read. The text is held, never sent: while the page lives it is kept here per
 *    note, so leaving the note (another tab, closing it, leaving Notes) and coming back shows
 *    the text and the banner again. "Save as a new note" writes it create-only; when someone
 *    made the note meanwhile it merges into theirs, or else lands beside it under a new name.
 *
 * The hold is the `deleted` banner itself: whatever replaces the banner (the note reloaded,
 * another view's save adopted, a change on disk) ends it, so saves never stay stuck.
 */

/**
 * A deleted note's held text: the editor's full bytes, the bytes its last read had, and that
 * read's hash. The hash goes out with the next save once the hold ends (the note made again
 * meanwhile): a save without one would write over whoever made it.
 */
export interface HeldDraft { md: string; base: string | null; hash: string | null }

/**
 * Held text of deleted notes, by path: kept for the life of the tab. A module, not a mount, and
 * mirrored into sessionStorage (never synced to other browsers), so a full reload (a deploy's
 * auto-reload, the person's own) brings it back instead of dropping it.
 */
const HELD_KEY = 'walnut.notes.held-drafts';

function heldStore(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

function readHeld(): Map<string, HeldDraft> {
  const out = new Map<string, HeldDraft>();
  let raw: unknown;
  try { raw = JSON.parse(heldStore()?.getItem(HELD_KEY) ?? '{}'); } catch { return out; }
  if (!raw || typeof raw !== 'object') return out;
  for (const [path, d] of Object.entries(raw as Record<string, unknown>)) {
    const v = d as Partial<HeldDraft> | null;
    if (!v || typeof v.md !== 'string') continue;
    out.set(path, { md: v.md, base: typeof v.base === 'string' ? v.base : null, hash: typeof v.hash === 'string' ? v.hash : null });
  }
  return out;
}

const heldDrafts = readHeld();

function writeHeld(): void {
  const s = heldStore();
  if (!s) return;
  try {
    if (heldDrafts.size) s.setItem(HELD_KEY, JSON.stringify(Object.fromEntries(heldDrafts)));
    else s.removeItem(HELD_KEY);
  } catch { /* a full or blocked storage keeps the text in memory only */ }
}

function setHeld(path: string, draft: HeldDraft): void { heldDrafts.set(path, draft); writeHeld(); }
function dropHeld(path: string): void { if (heldDrafts.delete(path)) writeHeld(); }

/** Saves of each note still out: one refused (410) holds its text, so until it answers the tab stays. */
const outgoing = new Map<string, number>();

/** Count a save of `path` as out until it settles. */
export function trackSave<T>(path: string, save: Promise<T>): Promise<T> {
  outgoing.set(path, (outgoing.get(path) ?? 0) + 1);
  const done = () => { const n = (outgoing.get(path) ?? 1) - 1; if (n > 0) outgoing.set(path, n); else outgoing.delete(path); };
  save.then(done, done);
  return save;
}

/**
 * This page holds text for the note (deleted under it), or has a save of it still out that may
 * come back refused: its tab stays open, whatever the tree says.
 */
export function hasHeldText(path: string): boolean { return heldDrafts.has(path) || outgoing.has(path); }

/** Create-only: true when it made the note, false when a note was already at the path. */
async function createOnce(path: string, content: string): Promise<{ contentHash: string; updatedAt: string } | null> {
  try {
    return await createNote(path, content);
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 409) return null;
    throw err;
  }
}

/** `dir/Name (restored).md`, `dir/Name (restored 2).md`, ...: where held text goes when its name is taken. */
export function restoredPathFor(path: string, attempt: number): string {
  const base = path.replace(/\.md$/i, '');
  return `${base} (restored${attempt > 1 ? ` ${attempt}` : ''}).md`;
}

export interface NoteGoneActions {
  /** Read the note into the editor (the hook's reloadContent). */
  reload: (path: string) => void;
  /** Merge the editor's text into the note as the server now holds it; false when it cannot. */
  mergeWithServer: (path: string) => Promise<boolean>;
  /** Save the editor now (the hook's doSave on the live editor). */
  saveNow: () => void;
  /** The editor's full bytes now (frontmatter + body), or null with no editor. */
  editorMarkdown: () => string | null;
  /** The held text was written under another name: the page opens that note instead. */
  onSavedAs?: (from: string, to: string) => void;
}

export interface NoteGoneDeps {
  currentPathRef: { current: string | null };
  pendingExternalRef: { current: PendingExternalChange | null };
  showPending: (next: PendingExternalChange | null) => void;
  /** Put bytes in the editor as the note's own: hash, base and the shown body. */
  adoptBytes: (path: string, md: string, contentHash: string, updatedAt: string | null) => void;
  /** Show held text in the editor: unsaved, with `base` as the bytes it was edited from. */
  showHeld: (path: string, draft: HeldDraft) => void;
}

/**
 * The missing / deleted state of the open note. Its callbacks are lean (useLeanCallback): each
 * runs the latest committed render's body, so they read the current `deps` without listing them.
 */
export function useNoteGone(notePath: string | null, deps: NoteGoneDeps) {
  const [missingPath, setMissingPath] = useState<string | null>(null);
  const actionsRef = useRef<NoteGoneActions | null>(null);
  const { currentPathRef, pendingExternalRef, showPending } = deps;

  const isHeld = (path: string | null): boolean =>
    !!path && pendingExternalRef.current?.kind === 'deleted' && pendingExternalRef.current.path === path;

  /** Another note opens: whatever was missing was another note's. */
  const resetMissing = useLeanCallback(() => { setMissingPath(null); }, []);

  /** A 404 for a note the person did not set out to make. */
  const markMissing = useLeanCallback((path: string) => {
    setMissingPath(path);
    log.info('notes', 'note not found, shown as not here', { path });
  }, []);

  /** The note is there after all (read, or saved by another view): neither missing nor held. */
  const clearGone = useLeanCallback((path: string) => {
    setMissingPath((cur) => (cur === path ? null : cur));
    dropHeld(path);
  }, []);

  /** A save answered 410: hold the text and show the banner. */
  const holdDeleted = useLeanCallback((path: string, md: string, base: string | null, hash: string | null) => {
    setHeld(path, { md, base, hash });
    log.warn('notes', 'note deleted while open, its text is held', { path });
    showPending({ kind: 'deleted', path });
  }, []);

  /** While held, a save only refreshes the held text. True when the save must not be sent. */
  const keepIfHeld = useLeanCallback((path: string | null, md: string | null): boolean => {
    if (!path || !isHeld(path)) return false;
    const held = heldDrafts.get(path);
    if (md != null) setHeld(path, { md, base: held?.base ?? null, hash: held?.hash ?? null });
    return true;
  }, []);

  /**
   * A save of a note the person left met a 410: keep its text for when they come back. A save
   * that was already out when they left (`inFlight`) sent the oldest bytes of that visit, so it
   * never replaces text a later flush of the same visit kept.
   */
  const keepDeparted = useLeanCallback((path: string, md: string, base: string | null, hash: string | null, inFlight = false) => {
    if (inFlight && heldDrafts.has(path)) return;
    setHeld(path, { md, base, hash });
    log.warn('notes', 'note deleted while its text was being written, the text is held', { path });
  }, []);

  /** Opening a note: its held text, shown with the banner again, instead of a read. */
  const restoreHeld = useLeanCallback((path: string): boolean => {
    const draft = heldDrafts.get(path);
    if (!draft) return false;
    deps.showHeld(path, draft);
    showPending({ kind: 'deleted', path });
    return true;
  }, []);

  /** The banner changed for the open note: a hold it replaced is over. */
  const pendingChanged = useLeanCallback((prev: PendingExternalChange | null, next: PendingExternalChange | null) => {
    if (prev?.kind === 'deleted' && next?.kind !== 'deleted' && prev.path === currentPathRef.current) dropHeld(prev.path);
  }, []);

  /** "Write it": make the missing note create-only, then read it (theirs, if someone made it meanwhile). */
  const writeMissing = useLeanCallback(async () => {
    const path = currentPathRef.current;
    const actions = actionsRef.current;
    if (!path || missingPath !== path || !actions) return;
    try {
      const made = await createOnce(path, '');
      log.info('notes', made ? 'missing note written' : 'missing note already written by someone else, opened', { path });
    } catch (err) {
      log.warn('notes', 'Could not write the missing note', { path, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (currentPathRef.current === path) actions.reload(path);
  }, [missingPath]);

  /** "Save as a new note": create-only; a note made meanwhile is merged into, or else kept beside. */
  const saveHeldAsNew = useLeanCallback(async () => {
    const path = currentPathRef.current;
    const actions = actionsRef.current;
    if (!path || !isHeld(path) || !actions) return;
    const md = actions.editorMarkdown() ?? heldDrafts.get(path)?.md;
    if (md == null) return;
    try {
      const made = await createOnce(path, md);
      if (made) {
        // Written: nothing is held any more, whichever note is open now.
        log.info('notes', 'deleted note saved as a new note', { path });
        dropHeld(path);
        if (currentPathRef.current !== path) return;
        deps.adoptBytes(path, md, made.contentHash, made.updatedAt);
        showPending(null);
        return;
      }
      if (currentPathRef.current !== path) return;
      // Someone made the note again meanwhile: never over theirs. The hold stays until the merge
      // is in the editor (with their hash), so no save goes out in between.
      if (await actions.mergeWithServer(path)) {
        dropHeld(path);
        showPending(null);
        log.info('notes', 'held text merged into the note made meanwhile', { path });
        actions.saveNow();
        return;
      }
      for (let attempt = 1; attempt <= 5; attempt++) {
        const to = restoredPathFor(path, attempt);
        if (await createOnce(to, md)) {
          dropHeld(path);
          log.info('notes', 'held text saved beside the note made meanwhile', { path, to });
          actions.onSavedAs?.(path, to);
          return;
        }
      }
      log.warn('notes', 'Could not save the held text: every restored name is taken', { path });
      if (currentPathRef.current === path) showPending({ kind: 'deleted', path, message: `${restoredPathFor(path, 1).split('/').pop()} and the next names are taken.` });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      log.warn('notes', 'Could not save the held text', { path, error: why });
      // The banner says why, so the button is not a press that does nothing.
      if (currentPathRef.current === path) showPending({ kind: 'deleted', path, message: why || 'The server did not answer.' });
    }
  }, []);

  return {
    missing: !!notePath && missingPath === notePath,
    /** The editor's own functions: set by useNoteContent in a layout effect, once per commit. */
    actionsRef,
    isHeld, resetMissing, markMissing, clearGone, holdDeleted, keepIfHeld, keepDeparted, restoreHeld, pendingChanged,
    writeMissing, saveHeldAsNew,
  };
}
