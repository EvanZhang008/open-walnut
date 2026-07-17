import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchNoteContent, saveNoteContent } from '@/api/notes-v2';
import { useEvent } from '@/hooks/useWebSocket';
import type { Editor } from '@tiptap/core';
import { log } from '@/utils/log';
import { splitFrontmatter, joinFrontmatter } from '@/components/notes/frontmatter';

const DEBOUNCE_MS = 500;

/**
 * A pending external/AI write that arrived while the user was mid-edit.
 * Surfaced as a non-destructive "note changed on disk — reload" affordance
 * instead of silently blowing the live doc away (§6.2 dirty-guard).
 */
export interface PendingExternalChange {
  /** Source: a WS notes:updated event, or a true write-write 409 conflict. */
  kind: 'external' | 'conflict';
  /** The note path the change applies to (guards against stale applies after switch). */
  path: string;
}

export function useNoteContent(notePath: string | null) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'idle'>('idle');
  /**
   * Non-null when an external/AI write (or a true 409 conflict) was deferred
   * because the editor was dirty. Drives the reload banner; cleared on apply
   * or when the editor goes idle+clean.
   */
  const [pendingExternal, setPendingExternal] = useState<PendingExternalChange | null>(null);

  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef<string | null>(null);
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
   * the "flash while typing"). `recentSaveHashes` = hashes OUR saves produced
   * (drop matching events outright); `pendingEcho` = an event that arrived
   * while a save was in flight (re-judged once the save lands).
   */
  const recentSaveHashesRef = useRef<Set<string>>(new Set());
  const pendingEchoRef = useRef<{ hash: string } | null>(null);
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
        contentHashRef.current = contentHash;
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
    const editor = editorRef.current;
    // Only flush if the open note IS the one being moved and it's dirty.
    if (editor && currentPathRef.current === oldPath && dirtyRef.current) {
      try {
        const md = joinFrontmatter(frontmatterRef.current, editor.storage.markdown.getMarkdown());
        const hash = contentHashRef.current ?? undefined;
        const result = await saveNoteContent(oldPath, md, hash);
        if (result.contentHash) contentHashRef.current = result.contentHash;
      } catch { /* best-effort — the move proceeds with last-saved content */ }
    }
    dirtyRef.current = false;
  }, []);

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

    // Self-echo: this event is the WS broadcast of OUR OWN save. Never treat
    // it as an external change (the false "note changed on disk" banner was a
    // major source of the mid-typing flash).
    if (recentSaveHashesRef.current.has(contentHash)) return;

    // A save of ours is in flight: this event might still be our echo (the
    // server emits the WS event before our PUT response carries the new hash).
    // Park it; doSave re-judges it the moment the save response lands.
    if (savingRef.current) {
      pendingEchoRef.current = { hash: contentHash };
      return;
    }

    if (contentHash !== contentHashRef.current) {
      // §6.2 dirty-guard (the missing WS-path guard): if the user is mid-edit,
      // DO NOT blow the live doc away. Defer the external write, surface a
      // non-destructive "note changed on disk — reload" affordance, and apply
      // it automatically once the editor goes idle+clean (or on user click).
      // The visibility/focus path already has this guard; this aligns the WS path.
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
    // Capture the previous path before overwriting the ref so the flush below
    // can save to the correct (old) file.
    const prevPath = currentPathRef.current;
    currentPathRef.current = notePath;

    // Switching notes invalidates any deferred external change for the old note.
    pendingExternalRef.current = null;
    setPendingExternal(null);
    pendingEchoRef.current = null;
    recentSaveHashesRef.current.clear();

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
      if (!wasMovedAway && dirtyRef.current && editorRef.current && prevPath) {
        const editor = editorRef.current;
        const md = joinFrontmatter(frontmatterRef.current, editor.storage.markdown.getMarkdown());
        const hash = contentHashRef.current ?? undefined;
        saveNoteContent(prevPath, md, hash).catch(() => {});
      }
    }

    setLoading(true);
    setContent(null);
    setSaveStatus('idle');
    dirtyRef.current = false;
    contentHashRef.current = null;

    frontmatterRef.current = '';
    let cancelled = false;
    fetchNoteContent(notePath)
      .then(({ content: c, updatedAt: u, contentHash }) => {
        if (cancelled) return;
        // Split frontmatter out of the editing surface; keep it for re-save so
        // the stamped id never renders as a heading or gets duplicated.
        const { frontmatter, body } = splitFrontmatter(c);
        frontmatterRef.current = frontmatter;
        setContent(body);
        setUpdatedAt(u);
        contentHashRef.current = contentHash;
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 = new file, start empty
        if (err.status === 404) {
          frontmatterRef.current = '';
          setContent('');
          setUpdatedAt(null);
          contentHashRef.current = null;
        } else {
          setContent(null);
          log.error('notes', 'Failed to load note', { path: notePath, error: err.message });
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [notePath]);

  // Save function
  const doSave = useCallback(async (editor: Editor) => {
    const pathToSave = currentPathRef.current;
    if (!pathToSave || savingRef.current) return;

    savingRef.current = true;
    setSaveStatus('saving');

    try {
      // Re-attach the preserved frontmatter so the saved bytes are
      // `frontmatter + editedBody` — keeps the id stable (no re-stamp) and the
      // round-trip byte-clean.
      const md = joinFrontmatter(frontmatterRef.current, editor.storage.markdown.getMarkdown());
      const hash = contentHashRef.current ?? undefined;
      const result = await saveNoteContent(pathToSave, md, hash);
      // Remember the hash OUR save produced so its WS echo is never mistaken
      // for an external change (bounded: keep the last few).
      if (result.contentHash) {
        recentSaveHashesRef.current.add(result.contentHash);
        if (recentSaveHashesRef.current.size > 8) {
          const first = recentSaveHashesRef.current.values().next().value;
          if (first !== undefined) recentSaveHashesRef.current.delete(first);
        }
      }
      // An echo parked while this save was in flight: if it matches what we
      // just wrote it was ours — drop it. Otherwise it's a REAL external write
      // that raced our save; surface it via the normal deferred affordance.
      if (pendingEchoRef.current) {
        const echo = pendingEchoRef.current;
        pendingEchoRef.current = null;
        if (echo.hash !== result.contentHash && currentPathRef.current === pathToSave) {
          const pending: PendingExternalChange = { kind: 'external', path: pathToSave };
          pendingExternalRef.current = pending;
          setPendingExternal(pending);
        }
      }
      // Only update if we're still on the same note
      if (currentPathRef.current === pathToSave) {
        setUpdatedAt(result.updatedAt);
        contentHashRef.current = result.contentHash;
        // First save of a brand-new note: the server just stamped the id into a
        // fresh frontmatter block. Capture it (byte-identical to the server's
        // `stampId('', id)`) so subsequent saves re-send it instead of triggering
        // another stamp + a changed identity.
        if (!frontmatterRef.current && result.id) {
          frontmatterRef.current = `---\nid: ${result.id}\n---\n`;
        }
        setSaveStatus('saved');
        dirtyRef.current = false;
        // Fade "Saved" indicator after 2s
        if (savedFadeTimerRef.current) clearTimeout(savedFadeTimerRef.current);
        savedFadeTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
        // §6.2 auto-apply: a non-conflicting external write that was deferred
        // while we were dirty can now be applied — the editor is idle+clean
        // and our own edits are flushed. Reload to converge on disk truth.
        if (pendingExternalRef.current?.kind === 'external' && pendingExternalRef.current.path === pathToSave) {
          log.info('notes', 'Applying deferred external update (editor now clean)', { path: pathToSave });
          reloadContent(pathToSave);
        }
      }
    } catch (err: any) {
      // 409 Conflict — TRUE write-write conflict. Policy (frozen): agent-writes-win,
      // losing at most one debounce window (~500ms) of un-flushed typing. The loss is
      // SURFACED (not a silent reload): show a conflict affordance so the user knows the
      // on-disk version diverged before we converge on it (§6.2 conflict honesty).
      if (err?.status === 409 && currentPathRef.current === pathToSave) {
        log.warn('notes', 'Note save conflict (write-write) — surfacing before reload', { path: pathToSave });
        const conflict: PendingExternalChange = { kind: 'conflict', path: pathToSave };
        pendingExternalRef.current = conflict;
        setPendingExternal(conflict);
        setSaveStatus('idle');
        // Stop treating local edits as savable — the agent's write wins; the user
        // applies (reload) from the surfaced affordance. Bound the loss here.
        dirtyRef.current = false;
        return;
      }
      log.error('notes', 'Failed to save note', { path: pathToSave, error: err.message });
      if (currentPathRef.current === pathToSave) {
        setSaveStatus('error');
      }
    } finally {
      savingRef.current = false;
      // If new dirty content arrived while we were saving, schedule another save.
      if (dirtyRef.current && editorRef.current && currentPathRef.current === pathToSave) {
        const editor = editorRef.current;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          doSave(editor);
        }, DEBOUNCE_MS);
      }
    }
  }, [reloadContent]);

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
    editorRef.current = editor;

    // The current path was just moved away on disk but activePath hasn't
    // switched yet. Any save now would target the OLD (renamed-away) path and
    // re-create the stale duplicate — drop this update; the new path will load
    // fresh content momentarily. (Tiptap re-emits an update while the editor is
    // still showing the moved note's doc.)
    if (movedAwayPathRef.current === currentPathRef.current) return;

    dirtyRef.current = true;
    setSaveStatus('idle');

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // Null the ref BEFORE doSave so the note-switch flush logic can
      // distinguish "timer pending" from "timer already fired (save in-flight)".
      timerRef.current = null;
      doSave(editor);
    }, DEBOUNCE_MS);
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
      if (dirtyRef.current && editorRef.current) {
        // Fire-and-forget save
        const editor = editorRef.current;
        const pathToSave = currentPathRef.current;
        if (pathToSave) {
          const md = joinFrontmatter(frontmatterRef.current, editor.storage.markdown.getMarkdown());
          const hash = contentHashRef.current ?? undefined;
          saveNoteContent(pathToSave, md, hash).catch((e) => {
            log.warn('notes', 'Unmount flush failed', { error: e instanceof Error ? e.message : String(e) });
          });
        }
      }
    };
  }, []);

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
  };
}
