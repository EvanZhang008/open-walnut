import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchGlobalNotes, saveGlobalNotes } from '@/api/notes';
import type { Editor } from '@tiptap/core';

export interface UseGlobalNotesReturn {
  content: string;
  onEditorUpdate: (editor: Editor) => void;
  saving: boolean;
  saveError: string | null;
  collapsed: boolean;
  toggleCollapse: () => void;
  popupOpen: boolean;
  openPopup: () => void;
  closePopup: () => void;
}

const COLLAPSE_KEY = 'walnut-global-notes-collapsed';

export function useGlobalNotes(): UseGlobalNotesReturn {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    return stored === null ? true : stored === 'true';
  });
  const [popupOpen, setPopupOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const dirty = useRef(false);

  // Load on mount with cancellation guard
  useEffect(() => {
    let mounted = true;
    fetchGlobalNotes()
      .then(c => { if (mounted) setContent(c); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Lightweight dirty signal — no serialization, no React state update per keystroke
  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;
    dirty.current = true;
    setSaveError(null);

    if (saveTimer.current) clearTimeout(saveTimer.current);

    // Show saving indicator (single state update)
    setSaving(true);

    saveTimer.current = setTimeout(() => {
      // Serialize markdown ONCE when debounce fires
      const md = editorRef.current?.storage.markdown.getMarkdown() ?? '';
      saveGlobalNotes(md)
        .then(() => {
          dirty.current = false;
          // Sync React state so popup/sidebar stay in sync
          setContent(md);
        })
        .catch((err) => { setSaveError(err instanceof Error ? err.message : 'Save failed'); })
        .finally(() => setSaving(false));
    }, 500);
  }, []);

  // Cleanup timer on unmount — only flush if content was actually modified
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (dirty.current && editorRef.current) {
          const md = editorRef.current.storage.markdown.getMarkdown();
          saveGlobalNotes(md).catch(() => {});
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

  return { content, onEditorUpdate, saving, saveError, collapsed, toggleCollapse, popupOpen, openPopup, closePopup };
}
