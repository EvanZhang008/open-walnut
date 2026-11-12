import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchNoteContent, saveNoteContent } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';
import {
  noteDocKey, subscribeDocSaved, wasSavedHere, beginDocSave, endDocSave, isDocSaveInFlight,
  type DocSavedSignal,
} from '@/stores/file-save-signal';
import type { Editor } from '@tiptap/core';
import { log } from '@/utils/log';
import { splitFrontmatter, joinFrontmatter } from '@/components/notes/frontmatter';
import { threeWayMerge } from '@open-walnut/three-way-merge';
import { leaderErrorMessage } from '@/api/leader-presence';
import { entityRefsToMarkdownLinks } from '@/utils/markdown';
import { normalizeForEditor } from '@/components/notes/notes-content-preprocess';
import { markdownKeepingSource, loadsAs } from '@/components/notes/editor-keep-source';
import {
  dropCachedNote, getCachedNote, loadNoteIntoCache, peekCachedNote, putCachedNote, wireNoteContentCacheEvents, type CachedNote,
} from '@/stores/note-content-cache';
import { forgetAutoName } from '@/components/notes/note-auto-name';
import type { OwnSave } from '@/hooks/useNoteAutoName';

const DEBOUNCE_MS = 500;
/** Three-way merges after 409s in a row before the conflict is surfaced instead. */
const MAX_MERGES = 3;
/** Reads of the old path, a second apart, after a rename's move answered unclearly. */
const MOVE_PROBES = 3;

/** A move answer that does not say what happened: no HTTP status (a timeout, a dropped connection) or a 5xx. */
function moveOutcomeUnclear(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status >= 500;
}

/** Is the note at `path` on the server? null when the read did not say. */
async function noteExists(path: string): Promise<boolean | null> {
  try {
    await fetchNoteContent(path);
    return true;
  } catch (err) {
    return (err as { status?: unknown } | null)?.status === 404 ? false : null;
  }
}

/**
 * A pending external/AI write that arrived while the user was mid-edit.
 * Surfaced as a non-destructive "note changed on disk — reload" affordance
 * instead of silently blowing the live doc away (§6.2 dirty-guard).
 */
export interface PendingExternalChange {
  /**
   * Source: a WS notes:updated event, a true write-write 409 conflict (one the
   * three-way merge could not resolve), or a save the host refused while the Mac
   * is away (`needs-leader`, WP11: `message` says why in plain words).
   */
  kind: 'external' | 'conflict' | 'needs-leader';
  /** The note path the change applies to (guards against stale applies after switch). */
  path: string;
  /** needs-leader: the reason (NEEDS_LEADER_REASONS words). */
  message?: string;
}

export function useNoteContent(notePath: string | null) {
  wireNoteContentCacheEvents();
  /**
   * The loaded body, tagged with the path it belongs to. Tagging is what lets the
   * render that follows a click show the right thing at once: the click render
   * happens BEFORE the load effect runs, and an untagged `content` state still
   * held the previous note, so the editor was mounted under the new key with the
   * old note's markdown (a full parse + editor build, thrown away one effect
   * later). Now that render shows the new note from the cache when it has it,
   * and the spinner otherwise, never the wrong note.
   */
  const [doc, setDoc] = useState<{ path: string | null; body: string | null }>({ path: null, body: null });
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'idle'>('idle');
  /**
   * Non-null when an external/AI write (or a true 409 conflict) was deferred
   * because the editor was dirty. Drives the reload banner; cleared on apply
   * or when the editor goes idle+clean.
   */
  const [pendingExternal, setPendingExternal] = useState<PendingExternalChange | null>(null);
  /**
   * The last save THIS editor made, for the note it is on: what lets a new note's name
   * follow its title only after its owner's own write (useNoteAutoName). Null again
   * whenever another note is opened.
   */
  const [ownSave, setOwnSave] = useState<OwnSave | null>(null);

  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  /** Counts the user's edits: a save leaves the note dirty when one came in while it was out. */
  const editSeqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef<string | null>(null);
  /** The path prop as of the latest render (currentPathRef only catches up in the load effect). */
  const propPathRef = useRef<string | null>(notePath);
  propPathRef.current = notePath;
  /** Body for the note the load effect is currently serving (always currentPathRef). */
  const setContent = useCallback((body: string | null) => {
    setDoc({ path: currentPathRef.current, body });
  }, []);
  const editorRef = useRef<Editor | null>(null);
  const contentHashRef = useRef<string | null>(null);
  /**
   * The current note's verbatim YAML frontmatter block (`---\n…\n---\n`), kept
   * out of the editor and re-prepended on every save so the metadata id never
   * leaks into the body / gets re-stamped (see components/notes/frontmatter.ts).
   * '' when the note has no frontmatter.
   */
  const frontmatterRef = useRef<string>('');
  /**
   * The note's full bytes (frontmatter + body) as last loaded from or written to
   * disk. A save whose serialized markdown equals this is a no-op: the editor's
   * own normalization pass on open emits an update for many notes (nested lists,
   * Notion exports), and writing those identical bytes back cost a PUT, an index
   * reconcile, a `notes:updated` broadcast and a backlinks refetch on every open.
   */
  const lastWrittenRef = useRef<string | null>(null);
  /** The editor's body as it is saved: the note's own bytes (lastWrittenRef) on
   *  every line the user did not edit, so one typed sentence does not rewrite the
   *  rest of the note in the serializer's spelling. */
  const savedBody = (editor: Editor): string =>
    markdownKeepingSource(editor, lastWrittenRef.current == null ? null : splitFrontmatter(lastWrittenRef.current).body);
  /**
   * Mirrors `pendingExternal` for use inside the WS callback / idle-flush
   * without re-subscribing. Tracks whether a deferred external change is
   * waiting so the auto-apply (on idle+clean) can fire it.
   */
  const pendingExternalRef = useRef<PendingExternalChange | null>(null);
  /**
   * SELF-ECHO suppression. Every save the server makes emits a notes:updated
   * WS event back to US — and it can arrive BEFORE our PUT response updates
   * contentHashRef (or late, after a newer save changed it). Both windows made
   * the handler misread our own write as an external change and pop the
   * "note changed on disk" banner mid-typing (56×/day; the banner push-down is
   * the "flash while typing").
   *
   * The "was this hash ours?" half now lives in ONE module-level registry keyed
   * by the note itself (stores/file-save-signal.ts), shared with the home Notes
   * panel and the Files-panel editor: global-notes.md is writable from all
   * three, and a private per-hook set meant each one only recognized its own
   * writes. `pendingEcho` stays local — it is an event that arrived while a save
   * was in flight, re-judged once that save lands.
   */
  const pendingEchoRef = useRef<{ hash: string } | null>(null);
  /**
   * Identity of THIS editor instance. It rides every save so the doc-saved
   * signal can tell our own write from another surface's.
   */
  const surfaceIdRef = useRef(`notes-editor-${Math.random().toString(36).slice(2)}`);
  /**
   * A path that was just MOVED/RENAMED away on disk (the file no longer exists
   * there). The path-change effect must NOT flush pending edits to it — the
   * backend already `fs.rename`d it, so a stale `saveNoteContent(oldPath)` would
   * RE-CREATE the file at the old location. This was the drag-to-move
   * duplication bug: one note became multiple divergent copies. Set by
   * `markMovedAway()` right before a move; consumed (and cleared) by the
   * path-change effect when prevPath matches.
   */
  const movedAwayPathRef = useRef<string | null>(null);
  /**
   * The open note being renamed in place (renameOpenNote), while its move is on the
   * server. Edits made meanwhile stay dirty and are written only once the note's
   * path is known again; `departed` holds them when the user left the note (or the
   * page) before the move answered, since by then the editor is gone.
   */
  const renamingRef = useRef<{ from: string; hash: string | null; departed: string | null } | null>(null);
  /** The path renameOpenNote moved the open note to: the load effect for it keeps everything. */
  const followedPathRef = useRef<string | null>(null);
  /**
   * The rendered editor's remount key. A new key per note opened, so switching notes
   * remounts the editor as before; a rename in place keeps it, so the editor (its
   * caret, undo history and unsaved text) carries on under the new path.
   */
  const remountKeyRef = useRef<{ path: string | null; key: string; seq: number }>({ path: notePath, key: `0:${notePath ?? ''}`, seq: 0 });
  const keptRemountKeyRef = useRef<{ to: string; key: string } | null>(null);
  if (remountKeyRef.current.path !== notePath) {
    const kept = keptRemountKeyRef.current;
    const seq = remountKeyRef.current.seq + 1;
    remountKeyRef.current = kept && kept.to === notePath
      ? { path: notePath, key: kept.key, seq }
      : { path: notePath, key: `${seq}:${notePath ?? ''}`, seq };
    keptRemountKeyRef.current = null;
  }
  /**
   * Unsaved bytes of an editor that was destroyed while dirty, keyed by its
   * note. The click render shows the NEXT note (from the cache, or a spinner)
   * before the load effect runs, so React unmounts the departing editor first,
   * and tiptap empties its storage on destroy; a flush that reached into it
   * then read `undefined.getMarkdown()` (render crash → crash-recovery reload →
   * the edit lost). The editor serializes itself on its own 'destroy' event
   * instead (see onEditorUpdate), and every flush takes that snapshot when the
   * live instance is gone.
   */
  const departedEditRef = useRef<{ path: string; md: string } | null>(null);
  /** The editor instance whose 'destroy' event is already subscribed. */
  const watchedEditorRef = useRef<Editor | null>(null);
  /** The bytes to flush for `path`: the live editor's, else its destroy snapshot; null when neither exists. */
  const departingMarkdown = useCallback((path: string): string | null => {
    const editor = editorRef.current;
    if (editor && !editor.isDestroyed) return joinFrontmatter(frontmatterRef.current, savedBody(editor));
    const snap = departedEditRef.current;
    return snap && snap.path === path ? snap.md : null;
  }, []);

  /** 409s merged in a row for one note (a merge whose save 409s again merges again, up to MAX_MERGES). */
  const mergeTriesRef = useRef(0);

  /**
   * A 409 on save: merge three ways like the Files panel (useLiveEdit) instead of
   * dropping the typing. base = the bytes our hash referred to, ours = the editor
   * NOW, theirs = the note as the server holds it (the 409's `serverContent` when it
   * carries one, else a read). Everything after the read runs in one tick, so no
   * keystroke lands between reading the editor and showing the merge. Clean: the
   * editor shows the merge, theirs becomes the base and the next save writes it.
   * Overlap (or MAX_MERGES): false, and the caller surfaces the conflict as before.
   */
  const mergeAfterConflict = useCallback(async (pathToSave: string, err: { body?: unknown }): Promise<boolean> => {
    const base = lastWrittenRef.current;
    const editor = editorRef.current;
    if (base == null || !editor || editor.isDestroyed || mergeTriesRef.current >= MAX_MERGES) return false;
    mergeTriesRef.current++;
    const b = (err.body && typeof err.body === 'object' ? err.body : {}) as { serverContent?: unknown; serverHash?: unknown; currentHash?: unknown };
    const givenHash = typeof b.serverHash === 'string' ? b.serverHash : typeof b.currentHash === 'string' ? b.currentHash : null;
    let theirs: { content: string; contentHash: string } | null = typeof b.serverContent === 'string' && givenHash ? { content: b.serverContent, contentHash: givenHash } : null;
    if (!theirs) {
      try {
        const r = await fetchNoteContent(pathToSave);
        theirs = { content: r.content, contentHash: r.contentHash };
      } catch { return false; }
    }
    if (currentPathRef.current !== pathToSave || editorRef.current !== editor || editor.isDestroyed) return false;
    const ours = joinFrontmatter(frontmatterRef.current, savedBody(editor));
    const merge = threeWayMerge(base, ours, theirs.content, { idFrom: 'theirs' });
    if (!merge.ok) {
      log.warn('notes', 'note save conflict did not merge cleanly', { path: pathToSave, conflicts: merge.conflicts, overBudget: merge.overBudget });
      return false;
    }
    contentHashRef.current = theirs.contentHash;
    lastWrittenRef.current = theirs.content;
    const { frontmatter, body } = splitFrontmatter(merge.merged);
    frontmatterRef.current = frontmatter;
    const shown = editor.storage.markdown.getMarkdown();
    // The merge keeps the note's own bytes, so compare documents, not spellings.
    if (body !== shown && !loadsAs(editor, body, shown)) {
      const { from, to } = editor.state.selection;
      editor.commands.setContent(normalizeForEditor(entityRefsToMarkdownLinks(body)), { emitUpdate: false });
      const max = editor.state.doc.content.size;
      editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
    }
    dirtyRef.current = merge.merged !== theirs.content;
    setContent(body);
    log.info('notes', 'note save conflict merged three ways', { path: pathToSave, attempt: mergeTriesRef.current, resave: dirtyRef.current });
    return true;
  }, [setContent]);

  // ── Reload helper (used by WS handler and 409 recovery) ──
  const reloadContent = useCallback((targetPath: string) => {
    fetchNoteContent(targetPath)
      .then(({ content: c, updatedAt: u, contentHash }) => {
        if (currentPathRef.current !== targetPath) return;
        // Disk unchanged (hash matches what we already loaded): do NOT push the
        // bytes back into the editor. Many notes (Notion exports) don't round-trip
        // byte-clean through tiptap-markdown, so re-setting "identical" content
        // makes NotesEditor's external-sync re-run setContent → full re-render →
        // visible flash. This guard matters for the focus/visibility reload path,
        // which (unlike the WS path) cannot compare hashes before fetching.
        // A non-null contentHashRef means content was loaded; only then skip.
        if (contentHash != null && contentHash === contentHashRef.current) {
          // Disk matches what we have — nothing pending to apply; dismiss the
          // affordance so a user-clicked "reload" doesn't leave the banner stuck.
          pendingExternalRef.current = null;
          setPendingExternal(null);
          return;
        }
        // Another writer's bytes: it holds this path, so the note keeps its name.
        forgetAutoName(targetPath);
        contentHashRef.current = contentHash;
        lastWrittenRef.current = c;
        putCachedNote(targetPath, { content: c, updatedAt: u, contentHash });
        dirtyRef.current = false;
        // Strip frontmatter before the editor sees it; preserve it for re-save.
        const { frontmatter, body } = splitFrontmatter(c);
        frontmatterRef.current = frontmatter;
        setContent(body);
        setUpdatedAt(u);
        setSaveStatus('idle');
        // The on-disk version is now applied — clear any pending affordance.
        pendingExternalRef.current = null;
        setPendingExternal(null);
      })
      .catch(() => {});
  }, []);

  /**
   * User-initiated (or auto-on-idle) apply of a deferred external change:
   * reload the on-disk content and dismiss the banner. Maps to the
   * "reload" affordance + the §6.2 auto-apply once idle+clean.
   */
  const applyExternalChange = useCallback(() => {
    const p = currentPathRef.current;
    if (!p) return;
    reloadContent(p);
  }, [reloadContent]);

  /** Dismiss the reload affordance without applying (user keeps editing). */
  const dismissExternalChange = useCallback(() => {
    pendingExternalRef.current = null;
    setPendingExternal(null);
  }, []);

  /**
   * Call RIGHT BEFORE moving/renaming the note that's open in the editor.
   * Two jobs, both needed to kill the drag-to-move duplication bug:
   *   1. Synchronously flush any pending edit to the OLD path so the latest
   *      content is on disk before the backend `fs.rename`s it (content travels
   *      with the move; nothing is lost).
   *   2. Mark `oldPath` as moved-away so the subsequent path-change effect does
   *      NOT flush to it again. Without this, an editor `onEditorUpdate` firing
   *      between the move and the activePath switch re-arms the debounce timer,
   *      and the effect's flush re-creates the file at its OLD location —
   *      exactly what produced the divergent duplicate copies (proven by logs:
   *      a `PUT …/Projects/Life/Election.md` landing AFTER `Note moved`).
   * Also cancels the timer + clears dirty so no scheduled save targets oldPath.
   */
  const markMovedAway = useCallback(async (oldPath: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    movedAwayPathRef.current = oldPath;
    // Only flush if the open note IS the one being moved and it's dirty.
    const md = currentPathRef.current === oldPath && dirtyRef.current ? departingMarkdown(oldPath) : null;
    if (md != null) {
      try {
        const hash = contentHashRef.current ?? undefined;
        const result = await saveNoteContent(oldPath, md, hash, surfaceIdRef.current);
        if (result.contentHash) contentHashRef.current = result.contentHash;
      } catch { /* best-effort — the move proceeds with last-saved content */ }
    }
    dirtyRef.current = false;
  }, [departingMarkdown]);

  // ── Listen for external notes updates via WebSocket ──
  useEvent('notes:updated', (data: unknown) => {
    if (!data || typeof (data as any).source !== 'string') return;
    const { source, contentHash } = data as { source: string; contentHash: string };
    const path = currentPathRef.current;
    if (!path) return;

    // Map current note path to the canonical source format:
    // `notes/{vault-path-without-.md}`. EVERY emitter uses it — the legacy
    // /api/notes/global route and the agent files tool translate their
    // 'notes/global' alias to 'notes/global-notes' before emitting, so
    // global-notes.md edits from any surface land here with one name.
    // ('notes/global' on the wire would mean a literal vault-root global.md.)
    const normalizedPath = path.replace(/\.md$/, '');
    if (source !== `notes/${normalizedPath}`) return;

    // Self-echo: this event is the WS broadcast of a save made in THIS BROWSER
    // (ours, or another surface's — same note, one registry). Never treat it as
    // an external change: the false "note changed on disk" banner was a major
    // source of the mid-typing flash, and a sibling surface's bytes already
    // reached us through the local doc-saved signal.
    if (wasSavedHere(noteDocKey(path), contentHash)) return;

    // A save is in flight — ours, or another surface's on this same note. The
    // server emits the WS event before the PUT response carries the new hash, so
    // this may still be that save's echo. Park it; doSave re-judges it the
    // moment the save response lands.
    if (savingRef.current || isDocSaveInFlight(noteDocKey(path))) {
      pendingEchoRef.current = { hash: contentHash };
      return;
    }

    if (contentHash !== contentHashRef.current) {
      // §6.2 dirty-guard (the missing WS-path guard): if the user is mid-edit,
      // DO NOT blow the live doc away. Defer the external write, surface a
      // non-destructive "note changed on disk — reload" affordance, and apply
      // it automatically once the editor goes idle+clean (or on user click).
      // The visibility/focus path already has this guard; this aligns the WS path.
      // Written by someone else, who holds this path: the note keeps its name.
      forgetAutoName(path);
      if (dirtyRef.current) {
        log.info('notes', 'External note update deferred (editor dirty)', { path, contentHash });
        const pending: PendingExternalChange = { kind: 'external', path };
        pendingExternalRef.current = pending;
        setPendingExternal(pending);
        return;
      }
      log.info('notes', 'Note updated externally, reloading', { path, contentHash });
      // Clean editor — safe to reload. Cancel any pending save first.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      savingRef.current = false;
      reloadContent(path);
    }
  });

  // ── The same note, saved by another surface of this page ────────────────────
  // global-notes.md is editable from the home Notes panel, this editor, and the
  // Files panel; any vault note is editable from this editor AND the Files panel
  // rooted at the vault. Those surfaces do not share a content store, so the
  // browser-local doc-saved signal is what keeps them from diverging — it is
  // synchronous and carries the bytes, so nothing here waits for the server.
  useEffect(() => {
    if (!notePath) return;
    return subscribeDocSaved(noteDocKey(notePath), (sig: DocSavedSignal) => {
      if (sig.origin === surfaceIdRef.current) return; // our own save
      if (currentPathRef.current !== notePath) return; // switched away meanwhile
      if (sig.contentHash === contentHashRef.current) return; // already these bytes
      // The parked WS echo (if any) belongs to THIS write — this signal is the
      // authoritative version of it, so drop the parked copy either way.
      pendingEchoRef.current = null;
      // Another view wrote it and holds this path: the note keeps its name.
      forgetAutoName(notePath);
      if (dirtyRef.current) {
        // Same §6.2 dirty-guard as the WS path: never blow live typing away.
        log.info('notes', 'Note saved in another view — deferred (editor dirty)', { path: notePath });
        const pending: PendingExternalChange = { kind: 'external', path: notePath };
        pendingExternalRef.current = pending;
        setPendingExternal(pending);
        return;
      }
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (sig.content == null) {
        // The writer could not hand us bytes (the server stamped an id into
        // them). Re-read rather than guess.
        reloadContent(notePath);
        return;
      }
      log.info('notes', 'Adopting a note saved in another view', { path: notePath });
      contentHashRef.current = sig.contentHash;
      lastWrittenRef.current = sig.content;
      putCachedNote(notePath, { content: sig.content, updatedAt: new Date().toISOString(), contentHash: sig.contentHash });
      const { frontmatter, body } = splitFrontmatter(sig.content);
      frontmatterRef.current = frontmatter;
      setContent(body);
      setSaveStatus('idle');
      pendingExternalRef.current = null;
      setPendingExternal(null);
    });
  }, [notePath, reloadContent]);

  // ── Visibility / focus reload — catch external edits when tab regains focus ──
  useEffect(() => {
    let lastCheck = 0;
    const THROTTLE_MS = 2000;

    const check = () => {
      if (dirtyRef.current) return; // don't overwrite unsaved user edits
      const p = currentPathRef.current;
      if (!p) return;
      const now = Date.now();
      if (now - lastCheck < THROTTLE_MS) return;
      lastCheck = now;
      reloadContent(p);
    };

    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', check);
    };
  }, [reloadContent]);

  // Load content when path changes
  useEffect(() => {
    if (followedPathRef.current != null && followedPathRef.current === notePath && currentPathRef.current === notePath) {
      // renameOpenNote moved the open note here: the same note in the same editor,
      // already loaded, hashes and unsaved text included. Nothing to flush or load.
      followedPathRef.current = null;
      return;
    }
    followedPathRef.current = null;
    // Capture the previous path before overwriting the ref so the flush below
    // can save to the correct (old) file.
    const prevPath = currentPathRef.current;
    currentPathRef.current = notePath;
    // Another note: its name waits for this editor's own next save of it.
    setOwnSave(null);

    // Left a note whose rename is still on the server: neither path is sure yet, so
    // its unsaved text waits for the move's answer (renameOpenNote writes it there).
    const renaming = renamingRef.current;
    if (renaming && prevPath === renaming.from && dirtyRef.current) {
      renaming.departed = departingMarkdown(prevPath);
      dirtyRef.current = false;
    }

    // Switching notes invalidates any deferred external change for the old note.
    pendingExternalRef.current = null;
    setPendingExternal(null);
    pendingEchoRef.current = null;

    if (!notePath) {
      setContent(null);
      setUpdatedAt(null);
      setSaveStatus('idle');
      contentHashRef.current = null;
      return;
    }

    // Clear any "Saved" fade timer from the previous note so it can't
    // overwrite the new note's save status (e.g. masking "Saving...").
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }

    // If the previous path was MOVED away (drag-to-move / rename of the open
    // note), the file no longer exists there — flushing to it would re-create a
    // stale copy at the old location (the duplication bug). Skip the flush and
    // just drop the pending timer/dirty state; the move already carried the
    // latest content forward (markMovedAway flushed to the old path first).
    const wasMovedAway = prevPath != null && movedAwayPathRef.current === prevPath;
    movedAwayPathRef.current = null;

    // Flush pending save for previous note before switching.
    // If there is a dirty, unsaved edit and a timer is pending, cancel the timer
    // and fire the save synchronously so the old note's content is not lost.
    // Note: timerRef is nulled by the timer callback on fire, so a non-null
    // value here means the timer hasn't fired yet (safe to flush ourselves).
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!wasMovedAway && dirtyRef.current && prevPath) {
        const md = departingMarkdown(prevPath);
        if (md != null && md !== lastWrittenRef.current) {
          const hash = contentHashRef.current ?? undefined;
          saveNoteContent(prevPath, md, hash, surfaceIdRef.current)
            // The cache must learn the write too, or coming back paints the
            // pre-edit bytes for a moment before the revalidation catches up.
            .then((r) => { putCachedNote(prevPath, { content: md, updatedAt: r.updatedAt, contentHash: r.contentHash }); })
            .catch(() => {});
        }
      }
    }

    departedEditRef.current = null;
    setSaveStatus('idle');
    dirtyRef.current = false;
    contentHashRef.current = null;
    frontmatterRef.current = '';
    lastWrittenRef.current = null;
    let cancelled = false;

    const adopt = (c: string, u: string, contentHash: string) => {
      // Split frontmatter out of the editing surface; keep it for re-save so
      // the stamped id never renders as a heading or gets duplicated.
      const { frontmatter, body } = splitFrontmatter(c);
      frontmatterRef.current = frontmatter;
      lastWrittenRef.current = c;
      contentHashRef.current = contentHash;
      setContent(body);
      setUpdatedAt(u);
    };

    // 404 = new file (or one moved/deleted since we last saw it): start empty.
    const startEmpty = () => {
      dropCachedNote(notePath);
      frontmatterRef.current = '';
      lastWrittenRef.current = '';
      setContent('');
      setUpdatedAt(null);
      contentHashRef.current = null;
    };

    // Cache hit: the render that followed the click already shows these bytes
    // (see `doc`); adopt them as the baseline, then check the disk quietly. A
    // changed disk is applied only while the editor is still clean; otherwise it
    // becomes the same deferred "changed on disk" affordance the WS path uses.
    const cached: CachedNote | undefined = getCachedNote(notePath);
    if (cached) {
      adopt(cached.content, cached.updatedAt, cached.contentHash);
      loadNoteIntoCache(notePath)
        .then(({ content: c, updatedAt: u, contentHash }) => {
          if (cancelled || currentPathRef.current !== notePath) return;
          if (contentHash === contentHashRef.current) return;
          // Changed on disk while it was closed: another writer holds this path.
          forgetAutoName(notePath);
          if (dirtyRef.current) {
            const pending: PendingExternalChange = { kind: 'external', path: notePath };
            pendingExternalRef.current = pending;
            setPendingExternal(pending);
            return;
          }
          adopt(c, u, contentHash);
        })
        .catch((err) => {
          if (cancelled || currentPathRef.current !== notePath) return;
          // Gone from disk while cached (moved or deleted elsewhere): the cached
          // bytes must not stand in for a note that is not there.
          if (err?.status === 404 && !dirtyRef.current) startEmpty();
          /* any other failure: the cached bytes stand; the next open re-checks */
        });
      return () => { cancelled = true; };
    }

    // Cache miss: `doc` keeps its old tag, so this render and the ones until the
    // bytes land read as loading (spinner), not as an empty or failed note.
    loadNoteIntoCache(notePath)
      .then(({ content: c, updatedAt: u, contentHash }) => {
        if (cancelled) return;
        adopt(c, u, contentHash);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) {
          startEmpty();
        } else {
          setContent(null);
          log.error('notes', 'Failed to load note', { path: notePath, error: err.message });
        }
      })
    return () => { cancelled = true; };
  }, [notePath]);

  // Save function
  const doSave = useCallback(async (editor: Editor) => {
    const pathToSave = currentPathRef.current;
    // A rename in place is on the server: the edit is written once its path is known.
    if (!pathToSave || savingRef.current || renamingRef.current) return;

    // Re-attach the preserved frontmatter so the saved bytes are
    // `frontmatter + editedBody` — keeps the id stable (no re-stamp) and the
    // round-trip byte-clean.
    // A timer can outlive its editor (the panel remounted with the path unchanged):
    // the destroyed instance has no storage, but its destroy snapshot has the bytes.
    let editorMd: string;
    if (editor.isDestroyed) {
      const snap = departedEditRef.current;
      if (!snap || snap.path !== pathToSave) return;
      editorMd = splitFrontmatter(snap.md).body;
    } else {
      editorMd = savedBody(editor);
    }
    const md = joinFrontmatter(frontmatterRef.current, editorMd);
    if (md === lastWrittenRef.current) {
      // The editor re-emitted the bytes already on disk (its normalization pass
      // on open, or an edit that was undone). Nothing to write. The editor is
      // clean now, so a deferred external write (§6.2) can be applied, exactly as
      // after a real save.
      dirtyRef.current = false;
      setSaveStatus('idle');
      if (pendingExternalRef.current?.kind === 'external' && pendingExternalRef.current.path === pathToSave) {
        log.info('notes', 'Applying deferred external update (editor now clean)', { path: pathToSave });
        reloadContent(pathToSave);
      }
      return;
    }

    savingRef.current = true;
    setSaveStatus('saving');
    // Shared "a save is mid-air for this note" flag: another surface holding the
    // same note parks its echo handling on it, exactly as we park on theirs.
    const docKey = noteDocKey(pathToSave);
    beginDocSave(docKey);

    const editSeq = editSeqRef.current;
    try {
      const hash = contentHashRef.current ?? undefined;
      // saveNoteContent announces the write on the shared doc-saved signal (and
      // registers its hash), so every other mounted view of this note converges
      // without waiting for the server's echo.
      const result = await saveNoteContent(pathToSave, md, hash, surfaceIdRef.current);
      // An echo parked while this save was in flight: if it matches what we
      // just wrote — or any other save this browser made meanwhile — it was
      // ours. Otherwise it's a REAL external write that raced our save; surface
      // it via the normal deferred affordance.
      if (pendingEchoRef.current) {
        const echo = pendingEchoRef.current;
        pendingEchoRef.current = null;
        if (echo.hash !== result.contentHash && !wasSavedHere(docKey, echo.hash)
          && currentPathRef.current === pathToSave) {
          forgetAutoName(pathToSave);
          const pending: PendingExternalChange = { kind: 'external', path: pathToSave };
          pendingExternalRef.current = pending;
          setPendingExternal(pending);
        }
      }
      mergeTriesRef.current = 0;
      // Only update if we're still on the same note
      if (currentPathRef.current === pathToSave) {
        // A save that lands lifts a refusal shown for this note (WP11).
        if (pendingExternalRef.current?.kind === 'needs-leader' && pendingExternalRef.current.path === pathToSave) {
          pendingExternalRef.current = null;
          setPendingExternal(null);
        }
        setUpdatedAt(result.updatedAt);
        contentHashRef.current = result.contentHash;
        // First save of a brand-new note: the server just stamped the id into a
        // fresh frontmatter block. Capture it (byte-identical to the server's
        // `stampId('', id)`) so subsequent saves re-send it instead of triggering
        // another stamp + a changed identity.
        if (!frontmatterRef.current && result.id) {
          frontmatterRef.current = `---\nid: ${result.id}\n---\n`;
        }
        lastWrittenRef.current = joinFrontmatter(frontmatterRef.current, editorMd);
        putCachedNote(pathToSave, { content: lastWrittenRef.current, updatedAt: result.updatedAt, contentHash: result.contentHash });
        setSaveStatus('saved');
        // Typed on while this save was out: still dirty, so the finally below saves that too
        // (it was cleared here before, and that text waited for the next keystroke).
        dirtyRef.current = editSeqRef.current !== editSeq;
        setOwnSave((prev) => ({ path: pathToSave, seq: (prev?.seq ?? 0) + 1 }));
        // Adopt what we just wrote as the content STATE (same as the home Notes
        // panel does). Two reasons, and the second one is load-bearing: a remount
        // (pop-out, tab hop) must seed from the saved text rather than the text
        // this note had when it loaded; and NotesEditor skips ONE external
        // `content` change after a local edit (its isSourceRef stays set until a
        // sync effect consumes it), so without a change here the FIRST write from
        // another surface was applied to this hook's state but never reached the
        // editor — leaving stale text that the next save wrote back over the other
        // surface's change.
        setContent(editorMd);
        // Fade "Saved" indicator after 2s
        if (savedFadeTimerRef.current) clearTimeout(savedFadeTimerRef.current);
        savedFadeTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
        // §6.2 auto-apply: a non-conflicting external write that was deferred
        // while we were dirty can now be applied — the editor is idle+clean
        // and our own edits are flushed. Reload to converge on disk truth. Not while an
        // edit made during this save is still to be written: that save applies it.
        if (!dirtyRef.current && pendingExternalRef.current?.kind === 'external' && pendingExternalRef.current.path === pathToSave) {
          log.info('notes', 'Applying deferred external update (editor now clean)', { path: pathToSave });
          reloadContent(pathToSave);
        }
      }
    } catch (err: any) {
      // 409 Conflict — TRUE write-write conflict. Policy (frozen): agent-writes-win,
      // losing at most one debounce window (~500ms) of un-flushed typing. The loss is
      // SURFACED (not a silent reload): show a conflict affordance so the user knows the
      // on-disk version diverged before we converge on it (§6.2 conflict honesty).
      // A change made elsewhere since our base: merged three ways first (WP11); the
      // finally below saves the merge.
      // Another writer changed the note since our base: it holds this path, so the
      // note keeps its name from now on (useNoteAutoName).
      if (err?.status === 409) forgetAutoName(pathToSave);
      if (err?.status === 409 && currentPathRef.current === pathToSave && await mergeAfterConflict(pathToSave, err)) {
        setSaveStatus('idle');
        return;
      }
      if (err?.status === 409 && currentPathRef.current === pathToSave) {
        mergeTriesRef.current = 0;
        log.warn('notes', 'Note save conflict (write-write), surfacing before reload', { path: pathToSave });
        const conflict: PendingExternalChange = { kind: 'conflict', path: pathToSave };
        pendingExternalRef.current = conflict;
        setPendingExternal(conflict);
        setSaveStatus('idle');
        // Stop treating local edits as savable — the agent's write wins; the user
        // applies (reload) from the surfaced affordance. Bound the loss here.
        dirtyRef.current = false;
        return;
      }
      // A host replica that cannot keep this save while the Mac is away says why (WP11).
      const away = err?.status === 503 ? leaderErrorMessage(err?.body) : null;
      if (away && currentPathRef.current === pathToSave) {
        log.warn('notes', 'Note save needs the Mac', { path: pathToSave, message: away });
        const blocked: PendingExternalChange = { kind: 'needs-leader', path: pathToSave, message: away };
        pendingExternalRef.current = blocked;
        setPendingExternal(blocked);
        setSaveStatus('error');
        return;
      }
      log.error('notes', 'Failed to save note', { path: pathToSave, error: err.message });
      if (currentPathRef.current === pathToSave) {
        setSaveStatus('error');
      }
    } finally {
      savingRef.current = false;
      endDocSave(docKey);
      // If new dirty content arrived while we were saving, schedule another save.
      if (dirtyRef.current && editorRef.current && currentPathRef.current === pathToSave) {
        const editor = editorRef.current;
        if (timerRef.current) clearTimeout(timerRef.current);
        // Nulled on fire like every save timer: a stale one reads as a save still to send.
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          doSave(editor);
        }, DEBOUNCE_MS);
      }
    }
  }, [reloadContent, mergeAfterConflict]);

  // Debounced editor update handler.
  //
  // Every call here is a GENUINE user edit, so it always marks dirty + schedules
  // a save. We do NOT gate on an "external reload" flag: the editor applies
  // external/reload content via setContent(..., { emitUpdate: false }) plus its
  // own isExternalUpdate guard (see NotesEditor.tsx), so a reload never emits an
  // update to this handler in the first place. A hook-level sticky flag here was
  // redundant AND harmful — it could swallow the user's first real edit (e.g. a
  // drag-reorder) when that edit landed in the brief window after a save-triggered
  // reload set the flag, silently dropping the change until the next keystroke.
  const onEditorUpdate = useCallback((editor: Editor) => {
    // The click render can mount the NEXT note's editor from the cache before
    // this hook's load effect has switched paths. Its mount-time normalization
    // update is not user input, and marking dirty here would let the flush in
    // that effect write the new note's markdown into the OLD path.
    if (propPathRef.current !== currentPathRef.current) return;
    editorRef.current = editor;
    if (watchedEditorRef.current !== editor) {
      watchedEditorRef.current = editor;
      // tiptap emits 'destroy' before it empties the storage: the last chance to
      // serialize a dirty doc whose editor React already unmounted.
      editor.on('destroy', () => {
        if (editorRef.current !== editor) return;
        const path = currentPathRef.current;
        if (dirtyRef.current && path) {
          const md = joinFrontmatter(frontmatterRef.current, savedBody(editor));
          if (md !== lastWrittenRef.current) departedEditRef.current = { path, md };
        }
        editorRef.current = null;
      });
    }

    // The current path was just moved away on disk but activePath hasn't
    // switched yet. Any save now would target the OLD (renamed-away) path and
    // re-create the stale duplicate — drop this update; the new path will load
    // fresh content momentarily. (Tiptap re-emits an update while the editor is
    // still showing the moved note's doc.)
    if (movedAwayPathRef.current === currentPathRef.current) return;

    dirtyRef.current = true;
    editSeqRef.current++;
    setSaveStatus('idle');
    // Renamed in place right now: renameOpenNote schedules the save once the path is known.
    if (renamingRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // Null the ref BEFORE doSave so the note-switch flush logic can
      // distinguish "timer pending" from "timer already fired (save in-flight)".
      timerRef.current = null;
      doSave(editor);
    }, DEBOUNCE_MS);
  }, [doSave]);

  /**
   * Rename the OPEN note without reopening it: the editor, its caret and its unsaved
   * text stay, only the path changes (a new note's name follows its title this way
   * while the user types). `move` does the server move, which keeps the file's bytes;
   * `onMoved` runs the moment the note has its new path, so the caller points its tab
   * there in the same tick. 'busy' (nothing done) unless `from` is the open note with
   * nothing pending, in flight or deferred: the caller tries again after the next save.
   * A failed move is rethrown and the note keeps its path. A move whose answer says
   * nothing (a timeout, a dropped connection, a 5xx) may have happened on the server, so
   * `from` is read first: gone means it moved, so nothing is written back to `from` (a
   * save there would make the old file again beside the moved one).
   */
  const renameOpenNote = useCallback(async (
    from: string,
    to: string,
    move: () => Promise<void>,
    onMoved: (to: string) => void,
  ): Promise<'moved' | 'busy'> => {
    if (currentPathRef.current !== from || propPathRef.current !== from || renamingRef.current
      || savingRef.current || timerRef.current || dirtyRef.current || pendingExternalRef.current) return 'busy';
    const renaming = { from, hash: contentHashRef.current, departed: null as string | null };
    renamingRef.current = renaming;
    let failure: unknown = null;
    try { await move(); } catch (err) { failure = err ?? new Error('move failed'); }
    if (failure && moveOutcomeUnclear(failure)) {
      let atFrom: boolean | null = null;
      for (let probe = 0; probe < MOVE_PROBES && atFrom == null; probe++) {
        if (probe > 0) await new Promise((r) => setTimeout(r, 1000));
        atFrom = await noteExists(from);
      }
      if (atFrom === false) {
        log.info('notes', 'A rename whose answer was lost did move the note', { from, to });
        failure = null;
      } else if (atFrom == null) {
        // The server answered none of the reads: the note stays at `from`, where its
        // text is saved once the server is back (at worst a second copy, never lost text).
        log.warn('notes', 'A rename\'s outcome is unknown; the note keeps its old path', { from, to });
      }
    }
    renamingRef.current = null;
    const at = failure ? from : to;
    const open = currentPathRef.current === from && renaming.departed == null;
    if (!failure) {
      const cached = peekCachedNote(from);
      dropCachedNote(from);
      if (cached) putCachedNote(to, cached);
      if (open) {
        currentPathRef.current = to;
        propPathRef.current = to;
        followedPathRef.current = to;
        keptRemountKeyRef.current = { to, key: remountKeyRef.current.key };
        setDoc((d) => (d.path === from ? { path: to, body: d.body } : d));
        // A change from elsewhere that came in during the move belongs to the note, now at `to`.
        // (Read afresh: the busy check above saw none, but the move awaited since.)
        const pend = pendingExternalRef.current as PendingExternalChange | null;
        if (pend && pend.path === from) {
          const moved = { ...pend, path: to };
          pendingExternalRef.current = moved;
          setPendingExternal(moved);
        }
      }
      onMoved(to);
    }
    if (renaming.departed != null) {
      const md = renaming.departed;
      saveNoteContent(at, md, renaming.hash ?? undefined, surfaceIdRef.current)
        .then((res) => { putCachedNote(at, { content: md, updatedAt: res.updatedAt, contentHash: res.contentHash }); })
        .catch((e) => {
          log.warn('notes', 'Saving a note left during its rename failed', { path: at, error: e instanceof Error ? e.message : String(e) });
        });
    } else if (open && dirtyRef.current && editorRef.current) {
      // Typed while the move was out: saved now, under the path the note has.
      const editor = editorRef.current;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { timerRef.current = null; doSave(editor); }, DEBOUNCE_MS);
    }
    if (failure) throw failure;
    return 'moved';
  }, [doSave]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (savedFadeTimerRef.current) {
        clearTimeout(savedFadeTimerRef.current);
        savedFadeTimerRef.current = null;
      }
      const pathToSave = currentPathRef.current;
      const renaming = renamingRef.current;
      if (renaming && renaming.from === pathToSave) {
        // Its rename is on the server: renameOpenNote writes the edit where the note ends up.
        if (dirtyRef.current) renaming.departed = departingMarkdown(pathToSave);
        return;
      }
      if (dirtyRef.current && pathToSave) {
        // Fire-and-forget save
        const md = departingMarkdown(pathToSave);
        if (md != null) {
          const hash = contentHashRef.current ?? undefined;
          saveNoteContent(pathToSave, md, hash, surfaceIdRef.current).catch((e) => {
            log.warn('notes', 'Unmount flush failed', { error: e instanceof Error ? e.message : String(e) });
          });
        }
      }
    };
  }, [departingMarkdown]);

  // What this render shows for `notePath`: the loaded body when it is the
  // note's own; otherwise the cached bytes (instant paint, revalidated by the
  // load effect); otherwise nothing yet (spinner). A failed load stores
  // `body: null` under the path, which reads as "not loading, no content".
  let content: string | null = null;
  let loading = false;
  if (notePath) {
    if (doc.path === notePath) {
      content = doc.body;
    } else {
      const hit = peekCachedNote(notePath);
      if (hit) content = splitFrontmatter(hit.content).body;
      else loading = true;
    }
  }

  return {
    content,
    loading,
    updatedAt,
    saveStatus,
    onEditorUpdate,
    /** Non-null when an external/AI write (or true 409) was deferred while dirty. */
    pendingExternal,
    /** Apply the deferred change now (reload on-disk content + dismiss banner). */
    applyExternalChange,
    /** Dismiss the affordance and keep editing (used for the external, non-conflict case). */
    dismissExternalChange,
    /** Call BEFORE moving/renaming the open note: flush to old path + suppress stale re-write. */
    markMovedAway,
    /** Rename the open note in place, keeping its editor (see renameOpenNote above). */
    renameOpenNote,
    /** Remount key for the rendered editor: new per note opened, kept by a rename in place. */
    remountKey: remountKeyRef.current.key,
    /** The last save this editor made of the open note (null until one): starts an auto-name. */
    ownSave,
  };
}
