import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchGlobalNotes, saveGlobalNotes } from '@/api/notes';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { splitFrontmatter, joinFrontmatter } from '@/components/notes/frontmatter';
import type { Editor } from '@tiptap/core';

export interface UseGlobalNotesReturn {
  content: string;
  onEditorUpdate: (editor: Editor) => void;
  /** True while a save is in-flight. Backed by a ref — reads are snapshot-only. */
  saving: boolean;
  saveError: string | null;
  collapsed: boolean;
  toggleCollapse: () => void;
  /** In-app fullscreen overlay state (GlobalNotesPopup) — NOT the new-tab pop-out. */
  popupOpen: boolean;
  openPopup: () => void;
  closePopup: () => void;
}

const COLLAPSE_KEY = 'open-walnut-global-notes-collapsed';
const DEBOUNCE_MS = 500;

export function useGlobalNotes(): UseGlobalNotesReturn {
  const [content, setContent] = useState('');
  // saving is a ref — no re-renders during typing. We expose a snapshot via return.
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    return stored === null ? true : stored === 'true';
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const dirty = useRef(false);
  /** True only while a PUT is actually in flight (savingRef also covers "debounce pending"). */
  const inFlightRef = useRef(false);
  /** Bumped on every keystroke — lets a settling save detect newer edits it didn't include. */
  const editSeqRef = useRef(0);
  const contentHashRef = useRef<string | null>(null);
  /** Set when reloading from external update — prevents reload from triggering a save */
  const externalUpdateRef = useRef(false);
  /**
   * Hash from a notes:updated WS event that arrived while OUR save was in
   * flight. The server emits the bus event BEFORE the PUT response is sent, so
   * the echo of our own save always races ahead of the response — comparing it
   * against the stale contentHashRef made EVERY save look like an external
   * write and reloaded the doc mid-typing (cursor vanished + last ~500ms of
   * keystrokes rolled back). Defer the comparison until the save settles.
   */
  const deferredWsHashRef = useRef<string | null>(null);
  /**
   * global-notes.md now appears in the vault tree, so the notes-v2 editor/indexer
   * may stamp a frontmatter id into it. Keep that block out of the editing
   * surface (same contract as useNoteContent) and re-attach it on save so the
   * id never renders as text and never gets duplicated.
   */
  const frontmatterRef = useRef('');

  // Load on mount with cancellation guard
  useEffect(() => {
    let mounted = true;
    fetchGlobalNotes()
      .then(({ content: c, contentHash }) => {
        if (mounted) {
          const { frontmatter, body } = splitFrontmatter(c);
          frontmatterRef.current = frontmatter;
          setContent(body);
          contentHashRef.current = contentHash;
        }
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // ── Reload helper (used by WS handler and 409 recovery) ──
  const reloadContent = useCallback(() => {
    fetchGlobalNotes()
      .then(({ content: c, contentHash }) => {
        contentHashRef.current = contentHash;
        deferredWsHashRef.current = null; // we now hold the latest — nothing deferred
        dirty.current = false;
        externalUpdateRef.current = true;
        const { frontmatter, body } = splitFrontmatter(c);
        frontmatterRef.current = frontmatter;
        setContent(body);
      })
      .catch(() => {});
  }, []);

  // ── Listen for external notes updates via WebSocket ──
  // The SAME file (global-notes.md) is editable from TWO surfaces speaking
  // different APIs: this hook (legacy /api/notes/global) and the /notes page's
  // vault editor (/api/notes-v2). Every emitter — including the legacy route
  // and the agent files tool — now emits the canonical 'notes/global-notes'
  // source, so one match covers all surfaces. Only matching our own surface
  // made /notes-page edits invisible here until a lucky window-focus reload,
  // and typing into that stale panel then 409-rolled the user back.
  useEvent('notes:updated', (data: unknown) => {
    if (!data || typeof (data as any).source !== 'string') return;
    const { source, contentHash } = data as { source: string; contentHash: string };
    if (source !== 'notes/global-notes') return;
    if (contentHash === contentHashRef.current) return;

    // A save of OUR edit is pending or in flight — this event is almost
    // certainly its echo racing ahead of the PUT response. Defer the check:
    // the save's .then() compares against the settled hash. (If a REAL
    // external write raced our save, the PUT 409s and the catch reloads.)
    if (savingRef.current || dirty.current) {
      deferredWsHashRef.current = contentHash;
      return;
    }

    log.info('notes', 'Global notes updated externally, reloading', { contentHash });
    reloadContent();
  });

  // ── Visibility / focus reload — catch external edits when tab regains focus ──
  useEffect(() => {
    let lastCheck = 0;
    const THROTTLE_MS = 2000;

    const check = () => {
      if (dirty.current) return; // don't overwrite unsaved user edits
      const now = Date.now();
      if (now - lastCheck < THROTTLE_MS) return;
      lastCheck = now;
      reloadContent();
    };

    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', check);
    };
  }, [reloadContent]);

  // ── Save pipeline ──
  // performSave is the SINGLE path that issues the PUT (used by the debounce
  // timer, the editor destroy-flush, and the post-settle reschedule). It never
  // overlaps requests: a second PUT while one is in flight would carry the
  // pre-save expectedHash, self-409, and roll back the user's newest typing.
  const scheduleSaveRef = useRef<(delayMs?: number) => void>(() => {});
  const lastSaveFailedRef = useRef(false);

  const performSave = useCallback((md: string) => {
    if (inFlightRef.current) return; // in-flight settle path reschedules if newer edits arrived
    inFlightRef.current = true;
    savingRef.current = true;
    const seqAtSerialize = editSeqRef.current;
    const hash = contentHashRef.current ?? undefined;
    saveGlobalNotes(joinFrontmatter(frontmatterRef.current, md), hash)
      .then(({ contentHash: newHash }) => {
        contentHashRef.current = newHash;
        lastSaveFailedRef.current = false;
        // Only mark clean if no keystrokes landed while the PUT was in flight —
        // those aren't in `md` and still need their own save (rescheduled below).
        if (editSeqRef.current === seqAtSerialize) dirty.current = false;
        // Settle any WS event deferred during the save: if it was just our own
        // echo the hashes now match (no-op); a different hash means a real
        // external write landed meanwhile — reload it (unless we're dirty again,
        // in which case the next save either wins or 409s into a reload).
        if (!dirty.current && deferredWsHashRef.current) {
          const deferred = deferredWsHashRef.current;
          deferredWsHashRef.current = null;
          if (deferred !== newHash) {
            log.info('notes', 'Global notes updated externally (deferred), reloading', { contentHash: deferred });
            reloadContent();
            return;
          }
        }
        // Keep content state in sync — needed when editor remounts
        // (collapse/expand, popup). The external sync useEffect will
        // short-circuit because editor already has this content.
        setContent(md);
      })
      .catch((err) => {
        // 409 Conflict — agent/external writes take priority over unsaved user
        // edits; the un-flushed typing since the last successful save is lost.
        // (The home panel has no conflict banner — unlike useNoteContent's
        // surfaced affordance — so this hook converges silently on disk truth.)
        if (err?.status === 409) {
          log.info('notes', 'Global notes save conflict, reloading');
          reloadContent();
          return;
        }
        lastSaveFailedRef.current = true;
        setSaveError(err instanceof Error ? err.message : 'Save failed');
      })
      .finally(() => {
        inFlightRef.current = false;
        savingRef.current = false;
        // Keystrokes (or a failed save) left us dirty — schedule the next
        // attempt. Back off to 5s after a failure so a persistent 5xx doesn't
        // become a 2-req/s retry storm.
        if (dirty.current) scheduleSaveRef.current(lastSaveFailedRef.current ? 5000 : DEBOUNCE_MS);
      });
  }, [reloadContent]);

  const scheduleSave = useCallback((delayMs: number = DEBOUNCE_MS) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    savingRef.current = true;
    saveTimer.current = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) {
        // Editor unmounted before the timer fired and the destroy-flush didn't
        // run (nothing recoverable). Reset the flags — leaving dirty=true here
        // permanently blocked WS + focus reloads, freezing the panel stale.
        savingRef.current = false;
        dirty.current = false;
        const deferred = deferredWsHashRef.current;
        deferredWsHashRef.current = null;
        if (deferred && deferred !== contentHashRef.current) reloadContent();
        return;
      }
      try {
        performSave(ed.storage.markdown.getMarkdown());
      } catch {
        savingRef.current = false;
      }
    }, delayMs);
  }, [performSave, reloadContent]);
  scheduleSaveRef.current = scheduleSave;

  // Lightweight dirty signal — no serialization, no React state update per keystroke
  const onEditorUpdate = useCallback((editor: Editor) => {
    if (editorRef.current !== editor) {
      editorRef.current = editor;
      // Flush on editor teardown (panel collapse / popup close). The debounce
      // timer usually fires AFTER the editor is destroyed, which used to drop
      // the last ≤500ms of typing AND leave dirty=true forever (panel then
      // rejected every external update until a full page reload). Serialize
      // during the destroy event while the editor state is still readable.
      editor.on('destroy', () => {
        if (editorRef.current !== editor) return; // superseded by a newer editor
        if (!dirty.current) return;
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        try {
          performSave(editor.storage.markdown.getMarkdown());
        } catch {
          // State already torn down — nothing recoverable; reset so the panel
          // keeps accepting external updates.
          dirty.current = false;
          savingRef.current = false;
        }
      });
    }

    // TipTap fires onUpdate when content is set programmatically via
    // reloadContent -> setContent; without this guard, that would trigger a
    // debounced save, potentially racing with the next agent write.
    if (externalUpdateRef.current) {
      externalUpdateRef.current = false;
      return;
    }

    editSeqRef.current++;
    dirty.current = true;
    if (saveError) setSaveError(null);
    scheduleSave();
  }, [saveError, scheduleSave, performSave]);

  // Cleanup timer on unmount — only flush if content was actually modified.
  // Fire-and-forget: the component is gone, so skip the overlap guard only if
  // no PUT is in flight (an in-flight save already carries the latest-at-send
  // content; anything newer is unrecoverable once the editor unmounts anyway).
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        const ed = editorRef.current;
        if (dirty.current && !inFlightRef.current && ed && !ed.isDestroyed) {
          try {
            const md = ed.storage.markdown.getMarkdown();
            const hash = contentHashRef.current ?? undefined;
            saveGlobalNotes(joinFrontmatter(frontmatterRef.current, md), hash).catch((e) => {
              log.warn('notes', 'Unmount flush failed', { error: e instanceof Error ? e.message : String(e) });
            });
          } catch { /* editor already gone */ }
        }
      }
    };
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, String(next));
      return next;
    });
  }, []);

  const openPopup = useCallback(() => setPopupOpen(true), []);
  const closePopup = useCallback(() => setPopupOpen(false), []);

  return { content, onEditorUpdate, saving: savingRef.current, saveError, collapsed, toggleCollapse, popupOpen, openPopup, closePopup };
}
